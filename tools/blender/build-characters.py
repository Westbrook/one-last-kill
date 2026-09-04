"""Prepare the original character catalog and the sculpted/baked gunman pilot.

Upgrade/rebuild from the accepted surfaces stored inside characters.blend:
  Blender --background --python tools/blender/build-characters.py
Export saved low-mesh/topology/UV edits without resetting the sculpt:
  Blender --background assets/blender/characters.blend --python tools/blender/build-characters.py -- --export-only
Bake artist-edited high masters onto the saved low meshes and export:
  Blender --background assets/blender/characters.blend --python tools/blender/build-characters.py -- --bake-only
Rebake only material roughness, keeping the saved normal PNGs exact:
  Blender --background assets/blender/characters.blend --python tools/blender/build-characters.py -- --bake-only --roughness-only
Use --source and --output to stage any workflow away from the delivery files.
Reconstruct the original procedural seed only when deliberately requested:
  Blender --background --python tools/blender/build-characters.py -- --rebuild-base

Game coordinates remain Y-up. The seven non-pilot collections keep their exact
accepted geometry and point attributes. Gunman low meshes can change topology:
source attributes are transferred barycentrically, categorical bone weights are
combined/normalized, and UV seams are split during export. Presentation transforms
and review-rig poses never enter runtime mesh positions or binding data.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'public/assets/models/characters'
SOURCE = ROOT / 'assets/blender/characters.blend'
TYPE_FORMAT = {'Float32Array': '<f4', 'Uint8Array': 'u1', 'Uint16Array': '<u2', 'Uint32Array': '<u4'}


def smoothstep(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def gauss(value, width):
    return np.exp(-((value / width) ** 2))


def normals_for(position, index, original):
    normals = np.zeros_like(position)
    triangles = position[index]
    face = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    for component in range(3):
        np.add.at(normals, index[:, component], face)
    length = np.linalg.norm(normals, axis=1)
    used = length > 1e-10
    normals[used] /= length[used, None]
    normals[~used] = original[~used]
    # Preserve smooth normals at UV seams; topology/UVs are never welded.
    seams = {}
    for i, value in enumerate(position):
        seams.setdefault(tuple(np.round(value, 6)), []).append(i)
    for group in seams.values():
        if len(group) < 2:
            continue
        # Coincident hard edges keep their original discontinuity.
        if np.min(original[group] @ original[group[0]]) < 0.7:
            continue
        mean = normals[group].sum(axis=0)
        length = np.linalg.norm(mean)
        if length > 1e-10:
            normals[group] = mean / length
    return normals


def smooth_positions(position, index, selected, strength, iterations=1):
    """Paired shrink/inflate passes remove extraction ripples without volume loss."""
    links = [[] for _ in position]
    for face in index:
        for a, b in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            links[a].append(b)
            links[b].append(a)
    links = [np.array(sorted(set(values)), dtype=np.int32) for values in links]
    for _ in range(iterations):
        for factor in (strength, -strength * 1.025):
            delta = np.zeros_like(position)
            for vertex in selected:
                if len(links[vertex]):
                    delta[vertex] = np.mean(position[links[vertex]], axis=0) - position[vertex]
            position += delta * factor


def refine(surface, entry):
    attributes = surface['attributes']
    position = np.array(attributes['position']['values'], dtype=np.float64).reshape(-1, 3)
    original = position.copy()
    old_normals = np.array(attributes['normal']['values'], dtype=np.float64).reshape(-1, 3)
    index = np.array(surface['index'], dtype=np.int32).reshape(-1, 3)
    role = entry['id']
    changes = []
    if surface['name'] == 'garments':
        height = entry['dimensions']['height']
        body_triangles = entry['body']['surfaceTriangles']
        selected = np.unique(index[:body_triangles])
        smooth_positions(position, index[:body_triangles], selected, 0.40, iterations=3)
        # Pin garment contacts at cuffs, neck opening and ankle. The source's
        # arm/neck fitting was reviewed against its actual animation surfaces.
        y = original[:, 1] / height
        torso = gauss(y - 0.697, 0.092) * gauss(original[:, 0] / height, 0.11)
        trouser = smoothstep((y - 0.11) / 0.10) * (1 - smoothstep((y - 0.48) / 0.07))
        mask = np.maximum(torso, trouser)
        position = original + (position - original) * mask[:, None]
        # Tailored front creases run down each trouser leg. A broad shallow
        # ridge and a pair of recesses replace the rounded tube appearance.
        hip = entry['dimensions']['hipSpacing']
        lateral = (np.abs(original[:, 0]) - hip) / height
        front = smoothstep((original[:, 2] / height - 0.005) / 0.026)
        crease = (gauss(lateral, 0.013) - 0.24 * gauss(np.abs(lateral) - 0.030, 0.009))
        taper = smoothstep((y - 0.10) / 0.08) * (1 - smoothstep((y - 0.46) / 0.075))
        amplitude = 0.0020 if role == 'hitman' else 0.0013
        position[selected, 2] += (height * amplitude * crease * front * taper)[selected]
        changes.extend(['paired cloth relaxation with contact rims pinned', 'sculpted trouser front creases'])
        # Round the existing sewn panel corners at the same topology budget.
        # Bands stay fixed because their exact skin/neck contacts are already
        # reviewed. Detail shapes are kept independent of the continuous cloth.
        triangle_start = body_triangles
        for part in entry['body']['garmentDetails']['parts']:
            triangle_end = triangle_start + part['triangles']
            if any(token in part['name'] for token in ('pocket', 'collar', 'vest-pouch', 'vest-front-panel', 'vest-back-panel')):
                part_index = index[triangle_start:triangle_end]
                selected_part = np.unique(part_index)
                before = position.copy()
                smooth_positions(position, part_index, selected_part, 0.24, iterations=2)
                displacement = position - before
                lengths = np.linalg.norm(displacement, axis=1)
                displacement *= np.minimum(1, 0.0014 / np.maximum(lengths, 1e-12))[:, None]
                position = before + displacement
            triangle_start = triangle_end
        changes.append('rounded sewn pocket and collar edges')
    elif surface['name'] == 'head':
        x, y, z = original.T
        front = smoothstep((z - 0.06) / 0.26)
        cheek = gauss(np.abs(x) - 0.285, 0.11) * gauss(y - 0.45, 0.085) * front
        hollow = gauss(np.abs(x) - 0.31, 0.09) * gauss(y - 0.32, 0.065) * front
        # Keep the eyes, mouth, projected atlas landmarks and crown fixed.
        # These small planar cheek/jaw transitions catch oblique world light.
        position[:, 0] += np.sign(x) * (cheek * 0.010 - hollow * 0.007)
        position[:, 2] += cheek * 0.009 - hollow * 0.014
        changes.append('planar cheek and lower-jaw transitions, fixed face landmarks')
    changed = np.linalg.norm(position - original, axis=1)
    if np.max(changed) > 0:
        normals = normals_for(position, index, old_normals)
        attributes['position']['values'] = position.astype(np.float32).ravel().tolist()
    else:
        normals = old_normals.copy()
    zero = np.flatnonzero(np.linalg.norm(normals, axis=1) < 0.5)
    valid = np.flatnonzero(np.linalg.norm(normals, axis=1) > 0.5)
    for vertex in zero:
        nearest = valid[np.argmin(np.linalg.norm(position[valid] - position[vertex], axis=1))]
        normals[vertex] = normals[nearest]
    normals /= np.linalg.norm(normals, axis=1)[:, None]
    attributes['normal']['values'] = normals.astype(np.float32).ravel().tolist()
    surface['metrics'] = {'triangles': len(index), 'vertices': len(position), 'changedVertices': int(np.count_nonzero(changed > 1e-7)),
                          'maxDisplacement': float(np.max(changed)), 'repairedDegeneratePoleNormals': len(zero), 'improvements': changes}


def point_attribute(mesh, name, values, integer=False):
    attribute = mesh.attributes.new(name, 'INT' if integer else 'FLOAT', 'POINT')
    attribute.data.foreach_set('value', values)


def make_mesh(surface, collection, offset, entry):
    attributes = surface['attributes']
    positions = np.array(attributes['position']['values']).reshape(-1, 3)
    triangles = np.array(surface['index']).reshape(-1, 3)
    mesh = bpy.data.meshes.new(surface['name'])
    mesh.from_pydata(positions.tolist(), [], triangles.tolist())
    mesh.update()
    obj = bpy.data.objects.new(surface['name'], mesh)
    collection.objects.link(obj)
    obj.matrix_world = Matrix(np.array(surface['presentation']).reshape(4, 4).T.tolist())
    obj.location.x += offset
    obj['game_surface'] = surface['name']
    metadata = {key: value for key, value in surface.items() if key not in ('attributes', 'index')}
    metadata['attributeLayouts'] = {name: {key: value for key, value in attribute.items() if key != 'values'}
                                    for name, attribute in attributes.items()}
    metadata['vertexCount'] = len(positions)
    metadata['index'] = surface['index']
    obj['game_metadata'] = json.dumps(metadata, separators=(',', ':'))
    for component in range(3):
        point_attribute(mesh, f'game_reference_position_{component}', positions[:, component].tolist())
    for name, attribute in attributes.items():
        if name == 'position':
            continue
        values = np.array(attribute['values']).reshape(-1, attribute['itemSize'])
        for component in range(attribute['itemSize']):
            point_attribute(mesh, f'game_{name}_{component}', values[:, component].tolist(), attribute['type'] != 'Float32Array')
    uv = mesh.uv_layers.new(name='UVMap')
    values = np.array(attributes['uv']['values']).reshape(-1, 2)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop_index in polygon.loop_indices:
            uv.data[loop_index].uv = values[mesh.loops[loop_index].vertex_index]
    color = mesh.color_attributes.new(name='GameColor', type='FLOAT_COLOR', domain='POINT')
    values = np.array(attributes['color']['values']).reshape(-1, 3)
    for vertex, value in zip(color.data, values):
        vertex.color = (*value, 1)
    normals = np.array(attributes['normal']['values']).reshape(-1, 3)
    mesh.normals_split_custom_set_from_vertices(normals.tolist())
    skin_surface = surface['name'] in ('head', 'skin')
    material_name = f"{entry['id']} skin preview" if skin_surface else 'Character vertex color'
    mat = bpy.data.materials.get(material_name)
    if mat is None:
        mat = bpy.data.materials.new(material_name)
        mat.use_nodes = True
        shader = mat.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Roughness'].default_value = 0.78
        colors = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        colors.layer_name = 'GameColor'
        if skin_surface:
            tint = mat.node_tree.nodes.new('ShaderNodeMixRGB')
            tint.blend_type = 'MULTIPLY'
            tint.inputs[0].default_value = 1
            channels = [int(entry['config']['skin'].lstrip('#')[i:i + 2], 16) / 255 for i in (0, 2, 4)]
            tint.inputs[2].default_value = tuple(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels) + (1,)
            mat.node_tree.links.new(colors.outputs['Color'], tint.inputs[1])
            mat.node_tree.links.new(tint.outputs[0], shader.inputs['Base Color'])
        else:
            mat.node_tree.links.new(colors.outputs['Color'], shader.inputs['Base Color'])
    mesh.materials.append(mat)
    return obj


def make_armature(entry, collection, objects, offset):
    armature = bpy.data.armatures.new(f"{entry['id']}-17bone-contract")
    obj = bpy.data.objects.new(f"{entry['id']}-review-rig", armature)
    collection.objects.link(obj)
    obj.location.x = offset
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for source in entry['bones']:
        bone = armature.edit_bones.new(source['name'])
        bone.head = source['position']
        children = [child for child in entry['bones'] if child['parent'] == source['name']]
        bone.tail = children[0]['position'] if children else Vector(source['position']) + Vector((0, 0.07, 0))
        if (bone.tail - bone.head).length < 0.005:
            bone.tail.y += 0.04
        if source['parent']:
            bone.parent = armature.edit_bones[source['parent']]
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)
    obj.show_in_front = True
    for mesh in objects[:2]:
        count = len(mesh.data.vertices)
        for bone in entry['bones']:
            mesh.vertex_groups.new(name=bone['name'])
        for component in range(4):
            indices = np.empty(count, dtype=np.int32)
            weights = np.empty(count, dtype=np.float32)
            mesh.data.attributes[f'game_skinIndex_{component}'].data.foreach_get('value', indices)
            mesh.data.attributes[f'game_skinWeight_{component}'].data.foreach_get('value', weights)
            for vertex in np.flatnonzero(weights > 0):
                mesh.vertex_groups[int(indices[vertex])].add([int(vertex)], float(weights[vertex]), 'REPLACE')
        modifier = mesh.modifiers.new('Review existing skin weights', 'ARMATURE')
        modifier.object = obj


def build():
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required to export the original project topology')
    with tempfile.TemporaryDirectory(prefix='blender-characters-') as temporary:
        seed = Path(temporary) / 'seed.json'
        subprocess.run([node, str(ROOT / 'tools/blender/export-character-seed.mjs'), str(seed)], check=True, cwd=ROOT)
        data = json.loads(seed.read_text())
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene['game_character_contract_version'] = 1
    scene['game_source_provenance'] = data['provenance']
    for i, entry in enumerate(data['catalog']):
        collection = bpy.data.collections.new(entry['id'])
        scene.collection.children.link(collection)
        objects = []
        for surface in entry['surfaces']:
            refine(surface, entry)
            objects.append(make_mesh(surface, collection, i * 1.1, entry))
        collection['game_entry'] = json.dumps({key: value for key, value in entry.items() if key != 'surfaces'}, separators=(',', ':'))
        make_armature(entry, collection, objects, i * 1.1)
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1
    notes = bpy.data.texts.new('CHARACTERS_README')
    notes.write(__doc__ + '\n\nAll runtime material textures and game lighting remain supplied by the game.\n'
                'This source scene provides vertex-color previews, not a baked lighting reference.\n'
                'Each collection has four runtime surfaces, including local normalized head coordinates.\n'
                'Mesh object transforms position those surfaces for review; export ignores presentation transforms.\n')
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_distance = 9
                area.spaces.active.region_3d.view_location = (3.8, 0.95, 0)
                area.spaces.active.region_3d.view_rotation = Vector((0, 0, -1)).to_track_quat('-Z', 'Y')
                area.spaces.active.shading.color_type = 'MATERIAL'
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE), compress=True)


def export():
    if bpy.context.scene.get('game_character_contract_version') != 1:
        raise RuntimeError('Open the generated characters.blend before export-only')
    chunks = []
    byte_offset = 0

    def append(values, layout):
        nonlocal byte_offset
        padding = (-byte_offset) % 4
        if padding:
            chunks.append(b'\0' * padding)
            byte_offset += padding
        binary = np.asarray(values, dtype=TYPE_FORMAT[layout['type']]).tobytes()
        descriptor = {**layout, 'byteOffset': byte_offset, 'length': len(values)}
        chunks.append(binary)
        byte_offset += len(binary)
        return descriptor

    catalog = []
    order = ['garments', 'skin', 'head', 'face-hair']
    for collection in bpy.context.scene.collection.children:
        if 'game_entry' not in collection:
            continue
        entry = json.loads(collection['game_entry'])
        entry['surfaces'] = []
        objects = {obj['game_surface']: obj for obj in collection.objects if 'game_surface' in obj}
        for name in order:
            obj = objects[name]
            mesh = obj.data
            metadata = json.loads(obj['game_metadata'])
            if entry['id'] == 'gunman' and obj.get('game_revision'):
                from character_fidelity import export_surface
                entry['surfaces'].append(export_surface(obj, append, normals_for))
                continue
            if len(mesh.vertices) != metadata['vertexCount'] or len(mesh.polygons) * 3 != len(metadata['index']):
                raise RuntimeError(f'{obj.name}: vertex count/topology cannot change without rebinding the contract')
            actual_index = [vertex for polygon in mesh.polygons for vertex in polygon.vertices]
            if actual_index != metadata['index']:
                raise RuntimeError(f'{obj.name}: polygon order/topology changed; preserve the exact bound topology')
            surface = {key: value for key, value in metadata.items() if key not in ('attributeLayouts', 'vertexCount', 'index')}
            surface['attributes'] = {}
            position = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
            mesh.vertices.foreach_get('co', position)
            reference = np.empty((len(mesh.vertices), 3), dtype=np.float32)
            for component in range(3):
                temporary = np.empty(len(mesh.vertices), dtype=np.float32)
                mesh.attributes[f'game_reference_position_{component}'].data.foreach_get('value', temporary)
                reference[:, component] = temporary
            edited = not np.array_equal(position.reshape(-1, 3), reference)
            for attribute, layout in metadata['attributeLayouts'].items():
                if attribute == 'position':
                    values = position
                else:
                    values = np.empty((len(mesh.vertices), layout['itemSize']), dtype=np.dtype(TYPE_FORMAT[layout['type']]))
                    for component in range(layout['itemSize']):
                        temporary = np.empty(len(mesh.vertices), dtype=values.dtype)
                        mesh.attributes[f'game_{attribute}_{component}'].data.foreach_get('value', temporary)
                        values[:, component] = temporary
                    values = values.ravel()
                if attribute == 'normal' and edited:
                    values = normals_for(position.reshape(-1, 3).astype(np.float64),
                                         np.array(metadata['index']).reshape(-1, 3), values.reshape(-1, 3)).astype(np.float32).ravel()
                surface['attributes'][attribute] = append(values, layout)
            index = metadata['index']
            surface['index'] = append(index, {'type': 'Uint16Array' if max(index) < 65536 else 'Uint32Array', 'itemSize': 1, 'normalized': False})
            entry['surfaces'].append(surface)
        if sum(s['metrics']['triangles'] for s in entry['surfaces']) > 15000:
            raise RuntimeError(f"{entry['id']}: exported character exceeds the 15000-triangle contract")
        catalog.append(entry)
    # Export-only is self-contained: every atlas comes from the saved scene's
    # packed PNG rather than a leftover file in the delivery directory.
    finish_images = {}
    for entry in catalog:
        if not entry.get('finish'):
            continue
        entry['finish']['textures'] = []
        for part in ('garments', 'head'):
            for kind in ('normal', 'roughness'):
                filename = entry['finish'][part][kind]
                image = bpy.data.images.get(Path(filename).stem)
                if image is None or image.packed_file is None:
                    raise RuntimeError(f'{filename}: save and pack the baked finish in the Blender source before export')
                encoded = bytes(image.packed_file.data)
                if tuple(image.size) != (512, 512) or image.colorspace_settings.name != 'Non-Color':
                    raise RuntimeError(f'{filename}: expected a 512-square non-color data texture')
                if encoded[:8] != b'\x89PNG\r\n\x1a\n' or tuple(int.from_bytes(encoded[i:i + 4], 'big') for i in (16, 20)) != (512, 512):
                    raise RuntimeError(f'{filename}: packed data is not the expected 512-square PNG')
                finish_images[filename] = encoded
                entry['finish']['textures'].append({'file': filename, 'width': 512, 'height': 512,
                                                    'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(),
                                                    'colorSpace': 'linear'})
    binary = b''.join(chunks)
    manifest = {'version': 1, 'binary': 'characters.bin', 'byteLength': len(binary), 'sha256': hashlib.sha256(binary).hexdigest(),
                'source': 'assets/blender/characters.blend', 'builder': 'tools/blender/build-characters.py',
                'provenance': 'Original project surfaces; gunman remodeled with dense sculpt masters, retopology transfer, and baked normal/roughness in Blender; seven other appearances preserve their accepted preparation; no third-party models or new image sources',
                'blenderVersion': bpy.app.version_string, 'coordinateSystem': 'right handed +Y up +Z forward, metres; mesh-local bind space',
                'runtime': {'drawsPerCharacter': 4, 'bonesPerCharacter': 17, 'additionalTextures': 4 if any(e.get('finish') for e in catalog) else 0, 'maximumTrianglesPerCharacter': 15000},
                'catalog': catalog}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for filename, encoded in finish_images.items():
        (OUTPUT / filename).write_bytes(encoded)
    (OUTPUT / 'characters.bin').write_bytes(binary)
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'characters': len(catalog), 'bytes': len(binary), 'sha256': manifest['sha256'],
                      'triangles': {entry['id']: sum(surface['metrics']['triangles'] for surface in entry['surfaces']) for entry in catalog}}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--export-only', action='store_true')
    parser.add_argument('--bake-only', action='store_true', help='Bake saved sculpt masters onto saved low meshes, then export')
    parser.add_argument('--roughness-only', action='store_true', help='With --bake-only, preserve packed normal maps and rebake only material roughness')
    parser.add_argument('--source', type=Path, default=SOURCE, help='Editable .blend scene to open/save')
    parser.add_argument('--output', type=Path, default=OUTPUT, help='Runtime or staged export directory')
    parser.add_argument('--rebuild-base', action='store_true', help='Reconstruct the pre-fidelity source from original game geometry before upgrading')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    SOURCE, OUTPUT = args.source.resolve(), args.output.resolve()
    if args.roughness_only and not args.bake_only:
        parser.error('--roughness-only requires --bake-only')
    if args.export_only and args.bake_only:
        parser.error('--export-only and --bake-only are mutually exclusive')
    if (args.export_only or args.bake_only) and Path(bpy.data.filepath) != SOURCE:
        bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.bake_only:
        if bpy.context.scene.get('game_character_contract_version') != 1:
            bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
        from character_fidelity import rebake_saved
        rebake_saved(SOURCE, OUTPUT, roughness_only=args.roughness_only)
    elif not args.export_only:
        if args.rebuild_base or not SOURCE.exists():
            build()
        elif bpy.context.scene.get('game_character_contract_version') != 1:
            bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
        from character_fidelity import upgrade
        upgrade(SOURCE, OUTPUT, normals_for)
    export()
