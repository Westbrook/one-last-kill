"""Gunman master/retopology/UV/baking upgrade of the accepted .blend scene.

The seven other collections and their point attributes are deliberately untouched.
Reference surfaces inside this file retain the accepted binding and enable repeatable
attribute transfer when the low mesh topology is edited in Blender.
"""
import hashlib
import json
import math
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from character_head_sculpt import remodel_head, remodel_details, head_high_displacement, smooth_head_features, restore_master_ear
from character_body_sculpt import adjust_low_body, high_detail_displacement, adjust_body_binding

REVISION = 'gunman-sculpt-v2'
FINISH_SIZE = 512


def values(mesh, name, count=None):
    a = mesh.attributes[name]
    result = np.empty(len(mesh.vertices) if count is None else count, dtype=np.int32 if a.data_type == 'INT' else np.float32)
    a.data.foreach_get('value', result)
    return result


def point_attribute(mesh, name, data, integer=False):
    previous = mesh.attributes.get(name)
    if previous:
        mesh.attributes.remove(previous)
    a = mesh.attributes.new(name, 'INT' if integer else 'FLOAT', 'POINT')
    a.data.foreach_set('value', np.asarray(data, dtype=np.int32 if integer else np.float32).tolist())


def positions(mesh):
    data = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get('co', data)
    return data.reshape(-1, 3)


def triangles(mesh):
    if any(len(p.vertices) != 3 for p in mesh.polygons):
        raise RuntimeError(f'{mesh.name}: triangulate the game low mesh before export (Edit Mode, select all, Ctrl-T); sculpt masters may retain quads')
    return np.asarray([tuple(p.vertices) for p in mesh.polygons], dtype=np.int32)


def set_positions(mesh, data):
    mesh.vertices.foreach_set('co', np.asarray(data).ravel())
    mesh.update()


def reference_arrays(obj):
    metadata = json.loads(obj['game_metadata'])
    attributes = {}
    for key, layout in metadata['attributeLayouts'].items():
        attributes[key] = positions(obj.data) if key == 'position' else np.stack([
            values(obj.data, f'game_{key}_{i}') for i in range(layout['itemSize'])], axis=1)
    return metadata, attributes


def transfer_attributes(obj, reference, normal_func):
    """Barycentric projection, with categorical bones combined before top-four pruning.

    This handles changed topology rather than assuming point attribute interpolation
    is safe for integer skin indices. It does not change the game skeleton/bind pose.
    """
    old_meta, source = reference_arrays(reference)
    p = positions(obj.data)
    faces = triangles(reference.data)
    tree = BVHTree.FromPolygons(source['position'].tolist(), faces.tolist(), all_triangles=True)
    indices = np.zeros((len(p), 3), dtype=np.int32)
    barycentric = np.zeros((len(p), 3), dtype=np.float64)
    distances = []
    for i, point in enumerate(p):
        closest, _, triangle, distance = tree.find_nearest(Vector(point))
        if closest is None:
            raise RuntimeError('Cannot transfer character attributes to an unbound surface')
        ids = faces[triangle]
        a, b, c = source['position'][ids]
        e0, e1, q = b - a, c - a, np.array(closest) - a
        d00, d01, d11 = np.dot(e0, e0), np.dot(e0, e1), np.dot(e1, e1)
        denominator = d00 * d11 - d01 * d01
        if abs(denominator) < 1e-18:
            weights = np.array([1., 0., 0.])
        else:
            v = (d11 * np.dot(q, e0) - d01 * np.dot(q, e1)) / denominator
            w = (d00 * np.dot(q, e1) - d01 * np.dot(q, e0)) / denominator
            weights = np.maximum([1 - v - w, v, w], 0)
            weights /= np.sum(weights)
        indices[i], barycentric[i] = ids, weights
        distances.append(distance)
    attrs = {}
    for name, layout in old_meta['attributeLayouts'].items():
        if name == 'position':
            continue
        if name in ('skinIndex', 'skinWeight'):
            continue
        data = np.sum(source[name][indices] * barycentric[:, :, None], axis=1)
        if layout['type'] != 'Float32Array':
            data = np.rint(data)
        if name == 'normal':
            data /= np.maximum(np.linalg.norm(data, axis=1), 1e-15)[:, None]
        attrs[name] = data
    if 'skinIndex' in source:
        bone_ids, bone_weights = np.zeros((len(p), 4), dtype=np.int32), np.zeros((len(p), 4), dtype=np.float64)
        for vertex in range(len(p)):
            combined = {}
            for corner, source_vertex in enumerate(indices[vertex]):
                for k in range(4):
                    bone = int(source['skinIndex'][source_vertex, k])
                    weight = source['skinWeight'][source_vertex, k] * barycentric[vertex, corner]
                    combined[bone] = combined.get(bone, 0) + weight
            ordered = sorted(combined.items(), key=lambda item: (-item[1], item[0]))[:4]
            total = sum(weight for _, weight in ordered)
            for k, (bone, weight) in enumerate(ordered):
                bone_ids[vertex, k], bone_weights[vertex, k] = bone, weight / total
        attrs['skinIndex'], attrs['skinWeight'] = bone_ids, bone_weights
    for name, data in attrs.items():
        for component in range(data.shape[1]):
            point_attribute(obj.data, f'game_{name}_{component}', data[:, component], old_meta['attributeLayouts'][name]['type'] != 'Float32Array')
    for component in range(3):
        point_attribute(obj.data, f'game_reference_position_{component}', p[:, component])
    metadata = dict(old_meta)
    metadata['index'] = triangles(obj.data).ravel().tolist()
    metadata['vertexCount'] = len(p)
    metadata['metrics'] = {**old_meta['metrics'], 'triangles': len(obj.data.polygons), 'vertices': len(p),
                           'transfer': {'method': 'closest triangle barycentric; categorical bone aggregation and top four normalization',
                                        'referenceVertices': len(source['position']), 'maximumProjectionDistance': max(distances)}}
    obj['game_metadata'] = json.dumps(metadata, separators=(',', ':'))
    return attrs


def remap_ranges(value, valid):
    if isinstance(value, dict):
        if 'triangleStart' in value and 'triangleCount' in value:
            start, count = value['triangleStart'], value['triangleCount']
            value['triangleStart'] = int(np.count_nonzero(valid[:start]))
            value['triangleCount'] = int(np.count_nonzero(valid[start:start + count]))
        else:
            for child in value.values():
                remap_ranges(child, valid)
    elif isinstance(value, list):
        for child in value:
            remap_ranges(child, valid)


def prepare_low(obj, reference, entry, normal_func):
    name = obj['game_surface']
    if name == 'head':
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        # Concentrate the ~900 added triangles around the facial silhouette and
        # feature transitions. Back of skull/crown keep their previous density.
        edges = [e for e in bm.edges if (e.verts[0].co + e.verts[1].co).z / 2 > 0.26
                 and 0.12 < (e.verts[0].co + e.verts[1].co).y / 2 < 0.67
                 and abs((e.verts[0].co + e.verts[1].co).x / 2) < 0.37]
        edges.sort(key=lambda edge: edge.calc_length(), reverse=True)
        ears = [e for e in bm.edges if abs((e.verts[0].co + e.verts[1].co).x / 2) > 0.42
                and 0.33 < (e.verts[0].co + e.verts[1].co).y / 2 < 0.67
                and abs((e.verts[0].co + e.verts[1].co).z / 2) < 0.15]
        ears.sort(key=lambda edge: edge.calc_length(), reverse=True)
        selected = list(dict.fromkeys(edges[:420] + ears[:200]))
        bmesh.ops.subdivide_edges(bm, edges=selected, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        bm.free()
    if name == 'head':
        attrs = transfer_attributes(obj, reference, normal_func)
    else:
        _, attrs = reference_arrays(reference)
    old = positions(obj.data)
    idx = triangles(obj.data)
    metadata = json.loads(obj['game_metadata'])
    if name == 'head':
        new = smooth_head_features(remodel_head(old), idx)
        x, y, z = new.T
        radius = np.sqrt(((z + 0.02) / 0.063) ** 2 + ((y - 0.496) / 0.110) ** 2)
        concha = np.exp(-(radius / 0.52) ** 2) * np.clip((abs(x) - 0.42) / 0.035, 0, 1)
        colors = attrs['color'].copy()
        colors *= (1 - 0.11 * concha[:, None])
        for component in range(3):
            point_attribute(obj.data, f'game_color_{component}', colors[:, component])
        metadata['userData']['surfaces'] = {'retopology': {'triangleCount': len(idx), 'reference': 'gunman accepted head'}}
    elif name == 'face-hair':
        new, colors = remodel_details(old, idx, metadata['userData'], attrs['color'])
        head_obj = next(other for other in bpy.data.collections['gunman'].objects if other.get('game_surface') == 'head')
        head_tree = BVHTree.FromPolygons(positions(head_obj.data).tolist(), triangles(head_obj.data).tolist(), all_triangles=True)
        # Re-seat the brow strips on the final remodeled skull, after lowering
        # the overly arched brow. This removes floating dark eyebrow geometry.
        for eye in metadata['userData']['surfaces']['eyes']:
            first = eye['lowerLid']['triangleStart'] + eye['lowerLid']['triangleCount']
            eye['brow'] = {'triangleStart': first, 'triangleCount': 24}
            brow = np.unique(idx[first:first + 24])
            for vertex in brow:
                hit, _, _, _ = head_tree.ray_cast(Vector((new[vertex, 0], new[vertex, 1], 2)), Vector((0, 0, -1)))
                if hit is not None:
                    new[vertex, 2] = hit.z + 0.007
            # Vertex contact alone can bury the middle of a strip triangle on
            # a convex forehead. Enforce clearance at real triangle interiors.
            for _ in range(2):
                for triangle in idx[first:first + 24]:
                    center = new[triangle].mean(axis=0)
                    hit, _, _, _ = head_tree.ray_cast(Vector((center[0], center[1], 2)), Vector((0, 0, -1)))
                    if hit is not None and center[2] < hit.z + 0.006:
                        new[triangle, 2] += hit.z + 0.006 - center[2]
        for k in range(3):
            point_attribute(obj.data, f'game_color_{k}', colors[:, k])
        valid = np.linalg.norm(np.cross(new[idx[:, 1]] - new[idx[:, 0]], new[idx[:, 2]] - new[idx[:, 0]]), axis=1) > 1e-10
        if not np.all(valid):
            # Remove inherited degenerate eye-strip endpoints, preserving useful
            # semantic eye/hair ranges after the index compaction.
            remap_ranges(metadata['userData'], valid)
            new_mesh = bpy.data.meshes.new('gunman facial details cleaned')
            new_mesh.from_pydata(new.tolist(), [], idx[valid].tolist())
            new_mesh.update()
            for attribute in obj.data.attributes:
                if attribute.name.startswith('game_'):
                    point_attribute(new_mesh, attribute.name, values(obj.data, attribute.name), attribute.data_type == 'INT')
            obj.data = new_mesh
            idx = idx[valid]
    else:
        new = adjust_low_body(name, old, attrs['normal'], idx, entry)
        bone_indices, bone_weights = adjust_body_binding(name, old, attrs['skinIndex'], attrs['skinWeight'], idx, entry)
        for component in range(4):
            point_attribute(obj.data, f'game_skinIndex_{component}', bone_indices[:, component], True)
            point_attribute(obj.data, f'game_skinWeight_{component}', bone_weights[:, component])
    set_positions(obj.data, new)
    normal = normal_func(new, idx, attrs['normal'])
    normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-15)[:, None]
    for k in range(3):
        point_attribute(obj.data, f'game_normal_{k}', normal[:, k])
        point_attribute(obj.data, f'game_reference_position_{k}', new[:, k])
    obj.data.normals_split_custom_set_from_vertices(normal.tolist())
    for poly in obj.data.polygons:
        poly.use_smooth = True
    metadata['vertexCount'], metadata['index'] = len(new), idx.ravel().tolist()
    metadata['metrics']['improvements'] = {
        'garments': ['rounded shoulder caps and upper-arm fit', 'fitted chest and waist with directional cloth drape', 'seated panel and seam structure', 'dense-master garment normal and roughness bake'],
        'skin': ['paired neck tendon forms and shaped nape between pinned collar and head rims'],
        'head': ['feature-focused facial retopology', 'fuller mandibular body and chin', 'seated orbital and brow planes', 'nose wing and cheek transitions', 'dense-master skin fold normal and roughness bake'],
        'face-hair': ['upper-lid overlap and larger clipped iris', 'seated lower brow arcs', 'natural hairline recession and combed crown', 'removed degenerate detail endpoints'],
    }[name]
    metadata['metrics'].update({'triangles': len(idx), 'vertices': len(new),
                                 'changedVertices': int(np.count_nonzero(np.linalg.norm(new - old, axis=1) > 1e-7)),
                                 'maxDisplacement': float(np.max(np.linalg.norm(new - old, axis=1))), 'revision': REVISION})
    obj['game_metadata'] = json.dumps(metadata, separators=(',', ':'))
    obj['game_revision'] = REVISION
    return normal


def unwrap(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.hide_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name='BakeUV')
    obj.data.uv_layers.active.name = 'BakeUV'
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(67), island_margin=0.012, area_weight=0.5, correct_aspect=True, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def master(low, collection, entry, normal_func):
    obj = low.copy()
    obj.data = low.data.copy()
    collection.objects.link(obj)
    obj.name = f"SCULPT_MASTER_{low['game_surface']}_{REVISION}"
    for key in list(obj.keys()):
        del obj[key]
    obj['master_for'] = low.name
    obj['detail_not_exported'] = True
    obj.modifiers.clear()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    # SIMPLE subdivision keeps the remodeled silhouette and feature seating.
    # Smooth normals plus geometry displacement provide the dense sculpt relief.
    subdivision = obj.modifiers.new('Dense sculpt support', 'SUBSURF')
    subdivision.subdivision_type = 'CATMULL_CLARK' if low['game_surface'] == 'head' else 'SIMPLE'
    subdivision.levels = subdivision.render_levels = 3 if low['game_surface'] == 'head' else 2
    bpy.ops.object.modifier_apply(modifier=subdivision.name)
    p = positions(obj.data)
    if low['game_surface'] == 'head':
        p = restore_master_ear(p)
        set_positions(obj.data, p)
    n = np.asarray([v.normal[:] for v in obj.data.vertices], dtype=np.float64)
    d = head_high_displacement(p, n) if low['game_surface'] == 'head' else high_detail_displacement('garments', p, n, entry)
    set_positions(obj.data, p + n * d[:, None])
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj['sculpt_displacement_maximum'] = float(np.max(np.abs(d)))
    obj.data.calc_loop_triangles()
    obj['source_triangles'] = len(obj.data.loop_triangles)
    return obj


def bake(low, high, output, part, initialize_roughness=True, roughness_only=False):
    scene = bpy.context.scene
    modifier_flags = [(m, m.show_viewport, m.show_render) for m in low.modifiers]
    for modifier, _, _ in modifier_flags:
        modifier.show_viewport = modifier.show_render = False
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.use_clear = True
    scene.render.bake.margin = 6
    scene.render.bake.cage_extrusion = 0.025 if part == 'head' else 0.006
    scene.render.bake.max_ray_distance = 0.08 if part == 'head' else 0.025
    scene.render.bake.normal_space = 'TANGENT'
    scene.render.bake.normal_r = 'POS_X'
    scene.render.bake.normal_g = 'POS_Y'
    scene.render.bake.normal_b = 'POS_Z'
    material = bpy.data.materials.new(f'Gunman {part} baked surface')
    material.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(material)
    nodes = material.node_tree.nodes
    shader = nodes.get('Principled BSDF')
    colors = nodes.new('ShaderNodeVertexColor')
    colors.layer_name = 'GameColor'
    if part == 'head':
        entry = json.loads(bpy.data.collections['gunman']['game_entry'])
        channels = [int(entry['config']['skin'].lstrip('#')[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        tint = nodes.new('ShaderNodeMixRGB')
        tint.blend_type = 'MULTIPLY'
        tint.inputs[0].default_value = 1
        tint.inputs[2].default_value = tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels) + (1,)
        material.node_tree.links.new(colors.outputs['Color'], tint.inputs[1])
        material.node_tree.links.new(tint.outputs[0], shader.inputs['Base Color'])
    else:
        material.node_tree.links.new(colors.outputs['Color'], shader.inputs['Base Color'])
    if initialize_roughness:
        high_material = bpy.data.materials.new(f'Gunman {part} sculpt roughness')
        high_material.use_nodes = True
        high.data.materials.clear()
        high.data.materials.append(high_material)
        hnodes = high_material.node_tree.nodes
        hshader = hnodes.get('Principled BSDF')
        coordinates = hnodes.new('ShaderNodeTexCoord')
        noise = hnodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 38 if part == 'head' else 75
        noise.inputs['Detail'].default_value = 2.0
        high_material.node_tree.links.new(coordinates.outputs['Generated'], noise.inputs['Vector'])
        ramp = hnodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = 0.12
        ramp.color_ramp.elements[1].position = 0.88
        rough_range = (0.51, 0.76) if part == 'head' else (0.78, 0.96)
        ramp.color_ramp.elements[0].color = (*([rough_range[0]] * 3), 1)
        ramp.color_ramp.elements[1].color = (*([rough_range[1]] * 3), 1)
        high_material.node_tree.links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
        high_material.node_tree.links.new(ramp.outputs['Color'], hshader.inputs['Roughness'])
    elif not high.data.materials:
        raise RuntimeError(f'{high.name}: a saved sculpt material is required for roughness rebaking')
    images = {}
    if roughness_only:
        # Material edits must not regenerate accepted tangent-space relief.
        image = bpy.data.images.get(f'gunman-{part}-normal')
        if image is None or image.packed_file is None:
            raise RuntimeError(f'{part}: roughness-only baking requires the saved packed normal map')
        target = nodes.new('ShaderNodeTexImage')
        target.image = image
        images['normal'] = (image, target)
    bake_passes = [('roughness', 'ROUGHNESS')] if roughness_only else [('normal', 'NORMAL'), ('roughness', 'ROUGHNESS')]
    for name, bake_type in bake_passes:
        image_name = f'gunman-{part}-{name}'
        old = bpy.data.images.get(image_name)
        if old:
            # Keep the previous packed image valid while old review materials
            # still reference it; final cleanup removes only unused generations.
            old.name = image_name + '-previous'
        image = bpy.data.images.new(image_name, width=FINISH_SIZE, height=FINISH_SIZE, alpha=False)
        image.colorspace_settings.name = 'Non-Color'
        target = nodes.new('ShaderNodeTexImage')
        target.image = image
        nodes.active = target
        bpy.ops.object.select_all(action='DESELECT')
        high.hide_set(False)
        low.hide_set(False)
        high.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=bake_type)
        image.filepath_raw = str(output / f'{image_name}.png')
        image.file_format = 'PNG'
        image.save()
        # Pack the exact validated PNG, not a possible stale generated buffer.
        encoded = Path(image.filepath_raw).read_bytes()
        image.pack(data=encoded, data_len=len(encoded))
        images[name] = (image, target)
    normal_node = nodes.new('ShaderNodeNormalMap')
    normal_node.inputs['Strength'].default_value = 1
    material.node_tree.links.new(images['normal'][1].outputs['Color'], normal_node.inputs['Color'])
    material.node_tree.links.new(normal_node.outputs['Normal'], shader.inputs['Normal'])
    material.node_tree.links.new(images['roughness'][1].outputs['Color'], shader.inputs['Roughness'])
    for modifier, viewport, render in modifier_flags:
        modifier.show_viewport, modifier.show_render = viewport, render
    return {'normal': f'gunman-{part}-normal.png', 'roughness': f'gunman-{part}-roughness.png'}


def update_color_preview(obj):
    color = obj.data.color_attributes.get('GameColor')
    if color is None:
        color = obj.data.color_attributes.new(name='GameColor', type='FLOAT_COLOR', domain='POINT')
    rgb = np.stack([values(obj.data, f'game_color_{k}') for k in range(3)], axis=1)
    for target, source in zip(color.data, rgb):
        target.color = (*source, 1)


def upgrade(source, output, normal_func):
    output.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    collection = bpy.data.collections['gunman']
    entry = json.loads(collection['game_entry'])
    refs = bpy.data.collections.get('GUNMAN_ACCEPTED_REFERENCE')
    if refs is None:
        refs = bpy.data.collections.new('GUNMAN_ACCEPTED_REFERENCE')
        scene.collection.children.link(refs)
        for obj in list(collection.objects):
            if 'game_surface' not in obj:
                continue
            ref = obj.copy()
            ref.data = obj.data.copy()
            refs.objects.link(ref)
            ref.name = f"REFERENCE_gunman_{obj['game_surface']}"
            ref['reference_surface'] = ref['game_surface']
            del ref['game_surface']
            ref.modifiers.clear()
    # Remove the previous master, then restore each low mesh from the preserved
    # accepted source. Rebuilds never compound the sculpt displacement.
    sculpt = bpy.data.collections.get('GUNMAN_SCULPT_MASTERS')
    if sculpt:
        for obj in list(sculpt.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    else:
        sculpt = bpy.data.collections.new('GUNMAN_SCULPT_MASTERS')
        scene.collection.children.link(sculpt)
    sculpt.hide_render = False
    objects = {obj['game_surface']: obj for obj in collection.objects if 'game_surface' in obj}
    references = {obj['reference_surface']: obj for obj in refs.objects}
    for name, obj in objects.items():
        ref = references[name]
        obj.data = ref.data.copy()
        obj.matrix_world = ref.matrix_world.copy()
        obj['game_metadata'] = ref['game_metadata']
        obj.hide_set(False)
        # The armature has no keyed deformation in the bind-pose bake.
        for modifier in obj.modifiers:
            modifier.show_render = modifier.show_viewport = False
        prepare_low(obj, ref, entry, normal_func)
        if name in ('garments', 'skin'):
            obj.vertex_groups.clear()
            for bone in entry['bones']:
                obj.vertex_groups.new(name=bone['name'])
            for component in range(4):
                bone_ids = values(obj.data, f'game_skinIndex_{component}')
                bone_weights = values(obj.data, f'game_skinWeight_{component}')
                for vertex in np.flatnonzero(bone_weights > 0):
                    obj.vertex_groups[int(bone_ids[vertex])].add([int(vertex)], float(bone_weights[vertex]), 'REPLACE')
        update_color_preview(obj)
    entry['head']['scale']['x'] = 0.94
    for name in ('head', 'face-hair'):
        obj = objects[name]
        reference = references[name]
        obj.matrix_world = reference.matrix_world.copy()
        obj.matrix_world[0][0] = entry['dimensions']['headWidth'] * 0.94
        metadata = json.loads(obj['game_metadata'])
        metadata['presentation'][0] = entry['dimensions']['headWidth'] * 0.94
        obj['game_metadata'] = json.dumps(metadata, separators=(',', ':'))
    finish = {'version': 1}
    master_counts = {}
    for name in ('garments', 'head'):
        obj = objects[name]
        unwrap(obj)
        high = master(obj, sculpt, entry, normal_func)
        finish[name] = bake(obj, high, output, name)
        master_counts[name] = int(high['source_triangles'])
        high.hide_render = True
        high.hide_set(True)
    for obj in objects.values():
        for modifier in obj.modifiers:
            modifier.show_viewport = modifier.show_render = True
    for obj in refs.objects:
        obj.hide_render = True
        obj.hide_set(True)
    refs.hide_render = True
    sculpt.hide_render = True
    edit_refs = bpy.data.collections.get('GUNMAN_EDIT_TRANSFER_REFERENCE')
    if edit_refs is None:
        edit_refs = bpy.data.collections.new('GUNMAN_EDIT_TRANSFER_REFERENCE')
        scene.collection.children.link(edit_refs)
    for obj in list(edit_refs.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for name, low in objects.items():
        ref = low.copy()
        ref.data = low.data.copy()
        ref.name = f'EDIT_TRANSFER_gunman_{name}'
        ref['reference_surface'] = name
        del ref['game_surface']
        ref.modifiers.clear()
        edit_refs.objects.link(ref)
        ref.hide_render = True
        ref.hide_set(True)
    edit_refs.hide_render = True
    entry['finish'] = finish
    entry['revision'] = REVISION
    entry['sculpt'] = {'masters': master_counts, 'bake': 'Cycles CPU selected-to-active tangent +Y normal and material roughness; 512 square PNG',
                        'topologyTransfer': 'closest source triangle barycentric attributes; categorical bone aggregation, normalized top four'}
    collection['game_entry'] = json.dumps(entry, separators=(',', ':'))
    scene['game_character_fidelity_revision'] = REVISION
    notes = bpy.data.texts.get('GUNMAN_FIDELITY_README') or bpy.data.texts.new('GUNMAN_FIDELITY_README')
    notes.clear()
    notes.write(__doc__ + '\n\nGunman collection: four exported low surfaces. GUNMAN_SCULPT_MASTERS: dense non-exported head/garment masters.\n'
                'GUNMAN_ACCEPTED_REFERENCE: preserved accepted surfaces for topology-aware transfer.\n'
                'Four packed 512px maps contain tangent normals and roughness, never lighting.\n'
                'Rebuild starts from accepted reference. --export-only exports saved low mesh/UV edits.\n')
    bpy.ops.object.select_all(action='DESELECT')
    objects['head'].select_set(True)
    bpy.context.view_layer.objects.active = objects['head']
    # Only stale generated data is discarded; live accepted/reference/master
    # surfaces and their materials remain packed in the editable scene.
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    for material in list(bpy.data.materials):
        if material.users == 0 and material.name.startswith('Gunman '):
            bpy.data.materials.remove(material)
    for image in list(bpy.data.images):
        if image.users == 0 and image.name.startswith('gunman-'):
            bpy.data.images.remove(image)
    bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=True)
    return entry


def export_surface(obj, append, normal_func):
    """Export Blender UV seams as split vertices while transferring each game attribute."""
    mesh = obj.data
    metadata = json.loads(obj['game_metadata'])
    index = triangles(mesh)
    current = positions(mesh)
    # Editing Blender topology is permitted for the pilot. The reference stores
    # binding attributes; projecting to it never invents bones or dynamic weights.
    if len(mesh.vertices) != metadata['vertexCount'] or index.ravel().tolist() != metadata['index']:
        collection = bpy.data.collections.get('GUNMAN_EDIT_TRANSFER_REFERENCE') or bpy.data.collections['GUNMAN_ACCEPTED_REFERENCE']
        reference = next(ref for ref in collection.objects if ref['reference_surface'] == obj['game_surface'])
        transfer_attributes(obj, reference, normal_func)
        metadata = json.loads(obj['game_metadata'])
    arrays = {}
    for name, layout in metadata['attributeLayouts'].items():
        arrays[name] = current if name == 'position' else np.stack([values(mesh, f'game_{name}_{i}') for i in range(layout['itemSize'])], axis=1)
    if obj['game_surface'] in ('garments', 'skin'):
        # Artist weight-paint edits use the named review groups directly. When
        # Blender creates a vertex without groups, barycentric attributes above
        # provide its binding until the artist assigns a group.
        bones = [bone['name'] for bone in json.loads(bpy.data.collections['gunman']['game_entry'])['bones']]
        lookup = {group.index: bones.index(group.name) for group in obj.vertex_groups if group.name in bones}
        for vertex in mesh.vertices:
            weights = [(lookup[group.group], group.weight) for group in vertex.groups if group.group in lookup and group.weight > 0]
            if weights:
                weights = sorted(weights, key=lambda item: (-item[1], item[0]))[:4]
                arrays['skinIndex'][vertex.index] = 0
                arrays['skinWeight'][vertex.index] = 0
                total = sum(weight for _, weight in weights)
                for component, (bone, weight) in enumerate(weights):
                    arrays['skinIndex'][vertex.index, component] = bone
                    arrays['skinWeight'][vertex.index, component] = weight / total
    arrays['normal'] = normal_func(current, index, arrays['normal'])
    arrays['normal'] /= np.maximum(np.linalg.norm(arrays['normal'], axis=1), 1e-15)[:, None]
    paint = mesh.color_attributes.get('GameColor')
    painted_point = painted_corner = None
    if paint is not None:
        painted = np.empty(len(paint.data) * 4, dtype=np.float32)
        paint.data.foreach_get('color', painted)
        painted = painted.reshape(-1, 4)[:, :3]
        if paint.domain == 'POINT':
            painted_point = painted
            arrays['color'] = painted_point
        elif paint.domain == 'CORNER':
            painted_corner = painted
        else:
            raise RuntimeError('GameColor paint must use point or corner domain')
    uv_layer = mesh.uv_layers.active
    split = obj['game_surface'] in ('garments', 'head')
    keys, remapped, vertex_ids, uv_values, color_values = {}, [], [], [], []
    for polygon in mesh.polygons:
        for loop in polygon.loop_indices:
            vertex = mesh.loops[loop].vertex_index
            uv = tuple(uv_layer.data[loop].uv) if split else tuple(arrays['uv'][vertex])
            color = painted_corner[loop] if painted_corner is not None else arrays['color'][vertex]
            key = (vertex, round(uv[0], 7), round(uv[1], 7), *tuple(np.round(color, 7)))
            if key not in keys:
                keys[key] = len(vertex_ids)
                vertex_ids.append(vertex)
                uv_values.append(uv)
                color_values.append(color)
            remapped.append(keys[key])
    vertex_ids = np.asarray(vertex_ids)
    surface = {k: v for k, v in metadata.items() if k not in ('attributeLayouts', 'vertexCount', 'index')}
    surface['attributes'] = {}
    for name, layout in metadata['attributeLayouts'].items():
        data = np.asarray(uv_values) if name == 'uv' else np.asarray(color_values) if name == 'color' else arrays[name][vertex_ids]
        surface['attributes'][name] = append(data.ravel(), layout)
    surface['index'] = append(remapped, {'type': 'Uint16Array' if len(vertex_ids) < 65536 else 'Uint32Array', 'itemSize': 1, 'normalized': False})
    surface['metrics'] = {**surface['metrics'], 'vertices': len(vertex_ids), 'triangles': len(remapped) // 3,
                          'uvSeamDuplicates': max(0, len(vertex_ids) - len(np.unique(index))), 'discardedUnusedVertices': len(current) - len(np.unique(index)), 'revision': REVISION}
    return surface


def rebake_saved(source, output, roughness_only=False):
    """Bake artist-edited masters onto saved low meshes without resetting the sculpt."""
    scene = bpy.context.scene
    collection = bpy.data.collections['gunman']
    sculpt = bpy.data.collections.get('GUNMAN_SCULPT_MASTERS')
    if sculpt is None:
        raise RuntimeError('This source has no sculpt masters; run the fidelity upgrade first')
    sculpt.hide_render = False
    objects = {obj['game_surface']: obj for obj in collection.objects if 'game_surface' in obj}
    entry = json.loads(collection['game_entry'])
    # Fail before replacing any exported image if an artist left a low mesh
    # untriangulated; sculpt masters themselves may keep subdivision quads.
    for low in objects.values():
        triangles(low.data)
    for name in ('garments', 'head'):
        low = objects[name]
        high = next(obj for obj in sculpt.objects if obj.get('master_for') == low.name)
        high.hide_render = False
        entry['finish'][name] = bake(low, high, output, name, initialize_roughness=False, roughness_only=roughness_only)
        high.hide_render = True
        high.hide_set(True)
        high.data.calc_loop_triangles()
        entry['sculpt']['masters'][name] = len(high.data.loop_triangles)
    sculpt.hide_render = True
    collection['game_entry'] = json.dumps(entry, separators=(',', ':'))
    bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=True)
