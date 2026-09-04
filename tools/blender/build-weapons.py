"""Prepare the project's four remaining held weapons in Blender.

Saved Blender mesh/UV/paint/image edits can be exported without regeneration:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-weapons.py -- --export-existing
The optional --refresh-materials assets/material-sources/weapon-finish-v1/profile.json
reauthors only the six images before saving/exporting. Omit it to preserve paint.

An intentional original-geometry rebuild uses the seed path below:
  node tools/blender/export-weapon-source.mjs
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-weapons.py -- --skip-render

The fitted source profiles are original project geometry. This is an explicit
Blender refinement, not a claim that an unchanged format conversion improves
quality: receiver/foreend edge breaks, smooth weighted machining normals,
blade microbevels, differentiated finish zones, and ceramic sight inserts are
authored here. Contact geometry and mechanical openings remain source-fitted.
The saved .blend retains every named editable part and a review studio.
Rebuilding regenerates the .blend from the JSON plus this script; preserve
manual source edits in a separate file before running it again.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import bpy
import bmesh
from mathutils import Vector
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SOURCE_JSON = ROOT / 'assets/blender/weapons-source.json'
SOURCE = ROOT / 'assets/blender/weapons.blend'
TEXTURES = ROOT / 'assets/blender/weapons-textures'
OUT = ROOT / 'public/assets/models/weapons'
REVIEW = ROOT / 'artifacts/blender-model-rollout-2026-09-04'
BUDGETS = {'knife': 1142, 'shotgun': 5484, 'smg': 4784, 'machinegun': 5484}
arguments = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--skip-render', action='store_true')
parser.add_argument('--export-existing', action='store_true', help='Export the saved Blender source without regenerating geometry, UVs, or paint')
parser.add_argument('--source-file', type=Path, default=SOURCE)
parser.add_argument('--output-dir', type=Path, default=OUT)
parser.add_argument('--texture-dir', type=Path, default=TEXTURES)
parser.add_argument('--source-output', type=Path, help='Save a material update to this source copy')
parser.add_argument('--refresh-materials', type=Path, metavar='PROFILE', help='Apply an offline authored finish profile before exporting the saved source')
options = parser.parse_args(arguments)
if options.export_existing:
    sys.path.insert(0, str(Path(__file__).parent))
    from weapon_material_pipeline import export_existing
    export_existing(options)
    sys.exit(0)
if options.refresh_materials or options.source_output:
    parser.error('--refresh-materials and --source-output require --export-existing')
for folder in (SOURCE.parent, TEXTURES, OUT, REVIEW):
    folder.mkdir(parents=True, exist_ok=True)
source = json.loads(SOURCE_JSON.read_text())

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for block in list(bpy.data.materials):
    bpy.data.materials.remove(block)
for block in list(bpy.data.images):
    if block.name != 'Render Result':
        bpy.data.images.remove(block)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
collection = bpy.data.collections.new('AUTHORED • held weapon catalog')
scene.collection.children.link(collection)
studio = bpy.data.collections.new('STUDIO • excluded from GLB')
scene.collection.children.link(studio)


def g(point):
    x, y, z = point
    return (x, -z, y)


def game(point):
    return (point[0], point[2], -point[1])


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def finish_image(name, pixels, space):
    height, width = pixels.shape[:2]
    image = bpy.data.images.new(name, width=width, height=height, alpha=True)
    image.colorspace_settings.name = space
    image.pixels.foreach_set(pixels.astype(np.float32).ravel())
    image.filepath_raw = str(TEXTURES / (name + '.png'))
    image.file_format = 'PNG'
    image.save()
    image.pack()
    return image


def finish_maps(kind):
    # Deterministic original finish data, with no photographs or baked light.
    # Nonmetal has two atlas regions separated by a wide padded gutter. Each
    # object's UV chart stays inside one region, with a >=5 px edge margin.
    n = 256
    yy, xx = np.mgrid[0:n, 0:n]
    u, v = xx / n, yy / n
    random = np.random.default_rng(471 if kind == 'steel' else 197).random((n, n)) - .5
    broad = (np.sin(u * math.tau * 3 + np.sin(v * math.tau * 2))
             + np.cos(v * math.tau * 4 + np.sin(u * math.tau))) / 2
    if kind == 'steel':
        brush = np.sin(v * math.tau * 101 + np.sin(u * math.tau * 3) * .4)
        scratches = np.maximum(0, np.cos(v * math.tau * 29 + np.sin(u * math.tau))) ** 60
        scratches *= np.maximum(0, np.sin(u * math.tau * 7) - .5)
        tone = random * .007 + broad * .006 + brush * .003 + scratches * .025
        base = np.array([.78, .82, .85]) + tone[:, :, None]
        rough = .41 + random * .06 + broad * .035 - scratches * .10
        metal = np.full((n, n), .86)
        height = random * .030 + brush * .010 - scratches * .05
    else:
        # Wood fibres follow chart U (stock/pump length). The upper half is
        # neutral molded polymer; all large color differences are corner tint.
        wood_v = np.clip(v / .5, 0, 1)
        fibres = np.maximum(0, np.sin(wood_v * math.tau * 37 + np.sin(u * math.tau) * 1.2)) ** 8
        growth = np.sin(wood_v * math.tau * 5 + np.sin(u * math.tau) * .65)
        wood_tone = broad * .014 + growth * .035 - fibres * .05 + random * .009
        wood_base = np.array([.55, .34, .17]) + wood_tone[:, :, None]
        cells = np.maximum(0, np.sin(u * math.tau * 65 + np.sin(v * math.tau * 17))
                           * np.sin(v * math.tau * 83))
        polymer_tone = random * .009 + broad * .006 + cells * .012
        polymer_base = np.array([.78, .80, .80]) + polymer_tone[:, :, None]
        mask = (v >= .5)
        base = np.where(mask[:, :, None], polymer_base, wood_base)
        rough = np.where(mask, .84 + cells * .07 + random * .04,
                         .63 + fibres * .09 + random * .03)
        metal = np.zeros((n, n))
        height = np.where(mask, cells * .075 + random * .035,
                          -fibres * .045 + growth * .008 + random * .010)
    rgba = np.ones((n, n, 4)); rgba[:, :, :3] = np.clip(base, 0, 1)
    mr = np.ones((n, n, 4)); mr[:, :, 1] = np.clip(rough, .24, .96); mr[:, :, 2] = metal
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * .35
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * .35
    normal = np.stack([-dx, -dy, np.ones_like(dx)], axis=2)
    normal /= np.linalg.norm(normal, axis=2)[:, :, None]
    norm = np.ones((n, n, 4)); norm[:, :, :3] = normal * .5 + .5
    return (finish_image('weapons-' + kind + '-basecolor', rgba, 'sRGB'),
            finish_image('weapons-' + kind + '-metalrough', mr, 'Non-Color'),
            finish_image('weapons-' + kind + '-normal', norm, 'Non-Color'))


def material(name, kind):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    textures = []
    for i, image in enumerate(finish_maps(kind)):
        node = nodes.new('ShaderNodeTexImage'); node.image = image
        node.extension = 'REPEAT' if kind == 'steel' else 'EXTEND'
        node.location = (-650, 200 - 230 * i); textures.append(node)
    attr = nodes.new('ShaderNodeVertexColor'); attr.layer_name = 'FinishTint'
    attr.location = (-650, 420)
    mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs[0].default_value = 1
    links.new(textures[0].outputs['Color'], mix.inputs[1]); links.new(attr.outputs['Color'], mix.inputs[2])
    links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    separate = nodes.new('ShaderNodeSeparateColor'); separate.mode = 'RGB'
    links.new(textures[1].outputs['Color'], separate.inputs['Color'])
    links.new(separate.outputs['Green'], bsdf.inputs['Roughness'])
    links.new(separate.outputs['Blue'], bsdf.inputs['Metallic'])
    normal = nodes.new('ShaderNodeNormalMap'); normal.inputs['Strength'].default_value = .5
    links.new(textures[2].outputs['Color'], normal.inputs['Color'])
    links.new(normal.outputs['Normal'], bsdf.inputs['Normal'])
    mat['originalAuthoredFinish'] = True
    mat['textureSize'] = 256
    mat['authoredUV'] = True
    return mat


steel = material('prepared-finish:steel', 'steel')
nonmetal = material('prepared-finish:wood-and-polymer', 'nonmetal')
ceramic = bpy.data.materials.new('prepared-finish:ceramic-sight')
ceramic.use_nodes = True; ceramic.use_backface_culling = True
ceramic.node_tree.nodes.clear()
emission = ceramic.node_tree.nodes.new('ShaderNodeEmission')
emission.inputs['Color'].default_value = (.43, .52, .45, 1)
output = ceramic.node_tree.nodes.new('ShaderNodeOutputMaterial')
ceramic.node_tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])


def new_mesh(name, vertices, faces, finish, parent, recalc=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([g(p) for p in vertices], [], faces); mesh.update()
    if recalc:
        bm = bmesh.new(); bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh); bm.free()
    obj = bpy.data.objects.new(name, mesh); collection.objects.link(obj); obj.parent = parent
    obj.data.materials.append(ceramic if finish == 'ceramic' else nonmetal if finish in ('wood', 'polymer') else steel)
    obj['sourceFinish'] = finish
    obj['assetPart'] = name
    return obj


def import_part(part, parent):
    attributes = part['attributes']
    flat = attributes['position']['array']
    vertices = [flat[i:i+3] for i in range(0, len(flat), 3)]
    indices = part['index'] if part['index'] is not None else list(range(len(vertices)))
    faces = [indices[i:i+3] for i in range(0, len(indices), 3)]
    obj = new_mesh(part['name'], vertices, faces, part['finish'], parent)
    obj['sourceTriangles'] = part['sourceTriangles']
    if 'normal' in attributes:
        normals = attributes['normal']['array']
        for face in obj.data.polygons:
            face.use_smooth = True
        obj.data.normals_split_custom_set([g(normals[i*3:i*3+3]) for i in indices])
    for key, value in part.get('userData', {}).items():
        if isinstance(value, (str, int, float, list, dict, bool)):
            obj['source_' + key] = value
    return obj


def refine_edges(obj, width, segments=2):
    # Welding plus *planar only* dissolve removes procedural clipping fans;
    # silhouette, panel cut walls and the arched crown are kept as geometry.
    mesh = obj.data
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-8)
    bmesh.ops.dissolve_limit(bm, angle_limit=.0003, use_dissolve_boundaries=False,
                           verts=list(bm.verts), edges=list(bm.edges), delimit=set())
    # Spend the new bevel only along long, readable edges. Source profiles
    # already have small edge breaks around sockets, notches and vent holes;
    # uniformly beveling those would multiply invisible tiny triangles.
    weights = bm.edges.layers.float.new('bevel_weight_edge')
    count = 0
    minimum_length = (.050 if 'vented-' in obj.name else .035
                      if obj.name in ('shotgun-action', 'smg-stamped-upper', 'machinegun-receiver') else .013)
    for edge in bm.edges:
        weight = (edge.is_manifold and edge.calc_length() > minimum_length
                  and edge.calc_face_angle() > math.radians(29))
        edge[weights] = 1 if weight else 0
        count += int(weight)
    bm.to_mesh(mesh); bm.free(); mesh.update()
    activate(obj)
    mod = obj.modifiers.new('Authored rounded machining edge', 'BEVEL')
    mod.width = width; mod.segments = segments; mod.limit_method = 'WEIGHT'
    mod.use_clamp_overlap = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    # Flat walls remain flat, while the two-segment edge band catches light.
    for face in mesh.polygons:
        face.use_smooth = True
    bm = bmesh.new(); bm.from_mesh(mesh)
    for edge in bm.edges:
        edge.smooth = not edge.is_manifold or edge.calc_face_angle() < math.radians(55)
    bm.to_mesh(mesh); bm.free()
    normal = obj.modifiers.new('Weighted broad receiver surfaces', 'WEIGHTED_NORMAL')
    normal.keep_sharp = True; normal.weight = 65
    bpy.ops.object.modifier_apply(modifier=normal.name)
    obj['blenderRefinement'] = {'edgeBreakMeters': width, 'bevelSegments': segments, 'refinedLongEdges': count,
                               'weightedNormals': True, 'planarTopologyCleanup': True}


def blade(parent):
    # A separate narrow cutting microbevel is geometry, not a painted bright
    # stripe. It ends at the source tip and preserves the source blade envelope.
    stations = [(.031, -.012, .013, .003), (.048, -.013, .014, .003),
                (.151, -.013, .014, .0028), (.185, -.011, .010, .0023),
                (.220, -.003, .008, .0014), (.239, .0055, .0060, .0001)]
    vertices = []
    for x, low, high, width in stations:
        band = min(.00085, (high-low)*.18)
        vertices.extend((x, y, z) for y, z in [
            (low, 0), (low+band, -width*.16), (low+(high-low)*.33, -width),
            (high-(high-low)*.18, -width), (high, 0),
            (high-(high-low)*.18, width), (low+(high-low)*.33, width),
            (low+band, width*.16)])
    n = 8
    faces = [(j*n+i, j*n+(i+1)%n, (j+1)*n+(i+1)%n, (j+1)*n+i)
             for j in range(len(stations)-1) for i in range(n)]
    faces += [tuple(range(n-1, -1, -1)), tuple((len(stations)-1)*n+i for i in range(n))]
    obj = new_mesh('knife-ground-blade', vertices, faces, 'blade', parent, recalc=True)
    obj['blenderRefinement'] = {'trueCuttingMicrobevelMeters': .00085, 'sourceTipPreserved': True}
    return obj


def smooth_handle(obj):
    # Original grip vertex positions and silhouette stay fitted to the hand;
    # only the continuous wood contour receives shared, angle-weighted normals.
    mesh = obj.data
    sums = {}
    face_normals = {}
    for face in mesh.polygons:
        vertices = [mesh.vertices[mesh.loops[i].vertex_index].co for i in face.loop_indices]
        normal = Vector((0, 0, 0))
        for i, point in enumerate(vertices):
            normal += point.cross(vertices[(i+1) % len(vertices)])
        normal.normalize(); face_normals[face.index] = normal
        if abs(normal.x) > .9:
            continue
        for i, point in enumerate(vertices):
            a = vertices[(i-1) % len(vertices)]-point
            b = vertices[(i+1) % len(vertices)]-point
            angle = a.angle(b, 0)
            key = tuple(round(value, 7) for value in point)
            sums.setdefault(key, Vector((0, 0, 0)))
            sums[key] += normal * angle
    normals = []
    for face in mesh.polygons:
        face.use_smooth = True
        normal = face_normals[face.index]
        for li in face.loop_indices:
            point = mesh.vertices[mesh.loops[li].vertex_index].co
            key = tuple(round(value, 7) for value in point)
            normals.append(tuple(normal if abs(normal.x) > .9 else sums[key].normalized()))
    mesh.normals_split_custom_set(normals)
    obj['blenderRefinement'] = {'continuousContourNormals': True, 'contactVerticesUnchanged': True}


def ceramic_dot(parent, type_name, sights):
    front = sights['front']
    x = front['x'] - front['length']/2 - .000035
    radius = min(.00135, front['width']*.30, (front['top']-front['bottom'])*.28)
    y = front['top'] - radius*1.5
    vertices = [(x, y, 0)] + [(x, y + math.cos(i*math.tau/12)*radius,
                               math.sin(i*math.tau/12)*radius) for i in range(12)]
    # Open disks have no automatic outside: these loops explicitly face -X.
    faces = [(0, (i+1)%12+1, i+1) for i in range(12)]
    obj = new_mesh(type_name+'-front-ceramic-insert', vertices, faces, 'ceramic', parent)
    obj['blenderRefinement'] = {'sightInsertRadiusMeters': radius, 'normalDirection': '-X'}
    return obj


def uv_and_finish(obj):
    mesh = obj.data
    for layer in list(mesh.uv_layers):
        mesh.uv_layers.remove(layer)
    for layer in list(mesh.color_attributes):
        mesh.color_attributes.remove(layer)
    uv = mesh.uv_layers.new(name='UVMap')
    tint = mesh.color_attributes.new(name='FinishTint', type='FLOAT_COLOR', domain='CORNER')
    finish = obj['sourceFinish']
    points = [game(v.co) for v in mesh.vertices]
    low = [min(p[k] for p in points) for k in range(3)]
    high = [max(p[k] for p in points) for k in range(3)]
    long_axis = 0 if finish == 'wood' else max(range(3), key=lambda k: high[k]-low[k])
    def normalized(value, axis):
        return (value-low[axis])/max(1e-7, high[axis]-low[axis])
    for face in mesh.polygons:
        coords = [game(mesh.vertices[mesh.loops[i].vertex_index].co) for i in face.loop_indices]
        fn = Vector((0, 0, 0))
        for i, point in enumerate(coords):
            fn += Vector(point).cross(Vector(coords[(i+1)%len(coords)]))
        fn.normalize()
        dominant = max(range(3), key=lambda i: abs(fn[i]))
        amount = {'metal': .35, 'metalDark': .065, 'blade': .62, 'polymer': .027, 'wood': .36, 'ceramic': 1}[finish]
        name = obj.name
        if 'floor' in name:
            amount *= .57 if finish == 'metal' else 1.28
        if 'recessed-bolt' in name:
            amount = .17
        if any(term in name for term in ('feed-cover', 'rear-hinge-cap', 'breech-cap', 'rear-takedown-cap')):
            amount = .115
        if 'breech-insert' in name or 'stock-socket-inset' in name:
            amount = .24
        if any(term in name for term in ('-socket', 'bore-depth')):
            amount = .008
        if 'receiver-pin' in name and '-socket' not in name:
            amount = .30
        if 'sight' in name and finish != 'ceramic':
            amount = .036
        if 'knife-ground-blade' == name:
            # Face order on the custom eight-sided grind encodes three real
            # machining planes. Both sides have the same physical treatment.
            side = face.index % 8
            # Uncoated ground steel must remain legible in the game's night
            # lighting. Match the older blade's bright substrate instead of
            # applying the firearm receiver's dark oxide contrast to its flats.
            # The real grind normals still supply the changing highlights;
            # this has no emissive term and changes no shared firearm material.
            amount = .97 if face.index < 40 and side in (0, 7) else .87
            if face.index < 40 and side in (2, 5):
                amount = .80
        if finish in ('metal', 'metalDark'):
            angle = max(abs(c) for c in fn)
            amount *= 1 + min(1, max(0, (.994-angle)*7))*.08
        for li, point in zip(face.loop_indices, coords):
            x, y, z = point
            if finish in ('wood', 'polymer'):
                # Longitudinal face charts stay well within atlas quadrants.
                # No repeat sampler or cross-region UV interpolation is used.
                first = long_axis if dominant != long_axis else next(axis for axis in (0, 1, 2) if axis != dominant)
                second = next(axis for axis in (1, 2, 0) if axis != dominant and axis != first)
                a = min(1, max(0, normalized(point[first], first)))
                b = min(1, max(0, normalized(point[second], second)))
                u = .025 + a*.95
                v = (.025 if finish == 'wood' else .535) + b*.44
            elif dominant == 0:
                u, v = z/.08, y/.08
            elif dominant == 1:
                u, v = x/.08, z/.08
            else:
                u, v = x/.08, y/.08
            uv.data[li].uv = (u, v)
            tint.data[li].color = (amount, amount, amount, 1)
    mesh.color_attributes.active_color = tint
    mesh.update()


roots = {}; parts = {}; refinement_records = []
for type_name in ('knife', 'shotgun', 'smg', 'machinegun'):
    data = source['weapons'][type_name]
    root = bpy.data.objects.new('vm_'+type_name, None); collection.objects.link(root)
    for key, value in data['userData'].items():
        root[key] = value
    hero = dict(data['userData']['heroWeapon'])
    hero['source'] = 'original-blender-authored'
    hero['preparation'] = 'original-project profiles refined in Blender'
    hero['features'] = ['machined-edge-breaks', 'weighted-receiver-normals', 'authored-shared-finish-atlas']
    if type_name == 'knife':
        hero['features'].append('geometric-cutting-microbevel')
    root['heroWeapon'] = hero
    root['assetSource'] = 'assets/blender/weapons.blend'
    roots[type_name] = root; parts[type_name] = []
    for part in data['parts']:
        obj = blade(root) if part['name'] == 'knife-ground-blade' else import_part(part, root)
        name = part['name']
        if name in ('shotgun-action', 'smg-stamped-upper', 'machinegun-receiver'):
            refine_edges(obj, .00023, 2)
        elif any(term in name for term in ('vented-foreend', 'vented-handguard')):
            refine_edges(obj, .00016, 1)
        elif name in ('smg-rear-hinge-cap', 'machinegun-rear-takedown-cap', 'shotgun-stepped-breech-cap'):
            refine_edges(obj, .00022, 2)
        elif name == 'knife-contoured-handle':
            smooth_handle(obj)
        if type_name == 'shotgun' and name == 'shotgun-front-bead':
            obj.data.materials.clear(); obj.data.materials.append(ceramic); obj['sourceFinish'] = 'ceramic'
            obj['blenderRefinement'] = {'selfLitCeramicBead': True}
        uv_and_finish(obj)
        parts[type_name].append(obj)
        if 'blenderRefinement' in obj:
            refinement_records.append({'weapon': type_name, 'part': name, **obj['blenderRefinement'].to_dict()})
    if type_name in ('smg', 'machinegun'):
        obj = ceramic_dot(root, type_name, data['userData']['ironSights'])
        uv_and_finish(obj); parts[type_name].append(obj)
        refinement_records.append({'weapon': type_name, 'part': obj.name, **obj['blenderRefinement'].to_dict()})
    hero['parts'] = [obj.name for obj in parts[type_name]]; root['heroWeapon'] = hero


def aim(obj, point):
    obj.rotation_euler = (Vector(g(point))-obj.location).to_track_quat('-Z', 'Y').to_euler()


def area(name, point, power, size, color):
    data = bpy.data.lights.new(name, 'AREA'); data.energy = power; data.shape = 'DISK'; data.size = size; data.color = color
    obj = bpy.data.objects.new(name, data); studio.objects.link(obj); obj.location = g(point); aim(obj, (.10, -.03, 0))


area('Cool softbox', (.10, .54, -.40), 32, .62, (.9, .95, 1))
area('Warm rim', (-.30, .20, .40), 34, .44, (1, .87, .70))
area('Receiver fill', (.5, .09, .10), 18, .4, (.88, .94, 1))
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.08, .10, .13, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .4
camera_data = bpy.data.cameras.new('Catalog review camera')
camera = bpy.data.objects.new('Catalog review camera', camera_data); studio.objects.link(camera)
scene.camera = camera; camera_data.type = 'ORTHO'; camera_data.ortho_scale = .9
camera.location = g((-.37, .24, -.90)); aim(camera, (.15, -.04, 0))
scene.render.engine = 'CYCLES'; scene.cycles.samples = 32; scene.cycles.use_denoising = True
scene.render.resolution_x = 1440; scene.render.resolution_y = 800; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'; scene.view_settings.view_transform = 'AgX'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))

bpy.ops.object.select_all(action='DESELECT')
for root in roots.values():
    root.select_set(True)
for group in parts.values():
    for obj in group:
        obj.select_set(True)
bpy.context.view_layer.objects.active = roots['smg']
glb = OUT / 'weapons.glb'
bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_selection=True,
    export_yup=True, export_extras=True, export_animations=False, export_cameras=False,
    export_lights=False, export_materials='EXPORT', export_texcoords=True,
    export_normals=True, export_tangents=False, export_all_vertex_colors=False,
    export_vertex_color='NAME', export_vertex_color_name='FinishTint',
    export_image_format='AUTO', export_apply=True)

blob = glb.read_bytes(); length = struct.unpack_from('<I', blob, 12)[0]
document = json.loads(blob[20:20+length]); weapons = {}
for type_name, root in roots.items():
    node = next(node for node in document['nodes'] if node.get('name') == root.name)
    child_nodes = [document['nodes'][i] for i in node['children']]
    primitives = [p for child in child_nodes for p in document['meshes'][child['mesh']]['primitives']]
    triangles = sum(document['accessors'][p['indices']]['count']//3 for p in primitives)
    vertices = sum(document['accessors'][p['attributes']['POSITION']]['count'] for p in primitives)
    materials = set(p['material'] for p in primitives)
    bounds = [document['accessors'][p['attributes']['POSITION']] for p in primitives]
    record = {
        'name': root.name, 'sourceTriangles': source['weapons'][type_name]['sourceCounts']['triangles'],
        'geometry': {'triangles': triangles, 'exportedVertices': vertices, 'meshParts': len(child_nodes),
                     'materialGroups': len(materials), 'budgetTriangles': BUDGETS[type_name]},
        'bounds': {'min': [min(b['min'][i] for b in bounds) for i in range(3)],
                   'max': [max(b['max'][i] for b in bounds) for i in range(3)]},
        'heroWeapon': root['heroWeapon'].to_dict(),
    }
    for key in ('muzzle', 'ironSights'):
        if key in node.get('extras', {}):
            record[key] = node['extras'][key]
    weapons[type_name] = record
    assert triangles <= BUDGETS[type_name], f'{type_name}: {triangles} exceeds {BUDGETS[type_name]}'
    assert len(materials) <= 3, f'{type_name}: too many materials'
    print('WEAPON_STATS', type_name, json.dumps(record['geometry']))
manifest = {
    'schemaVersion': 1, 'source': 'original-blender-authored', 'name': 'Original project held weapon catalog',
    'authoringTool': bpy.app.version_string, 'rebuild': 'tools/blender/build-weapons.py',
    'sourceExport': 'tools/blender/export-weapon-source.mjs', 'sourceFile': str(SOURCE.relative_to(ROOT)),
    'sourceGeometry': str(SOURCE_JSON.relative_to(ROOT)), 'sourceGeometrySha256': hashlib.sha256(SOURCE_JSON.read_bytes()).hexdigest(),
    'runtimeFile': str(glb.relative_to(ROOT)),
    'license': 'Original project profiles and finishes; no downloaded assets, trademarks, or photographs.',
    'coordinateSystem': {'units': 'meters', 'forward': '+X', 'up': '+Y', 'right': '+Z'},
    'weapons': weapons,
    'geometry': {'triangles': sum(w['geometry']['triangles'] for w in weapons.values()),
                 'materialGroups': len(document['materials'])},
    'delivery': {'glbBytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest(),
                 'embeddedImages': len(document.get('images', [])),
                 'textureRgba8BytesWithMipmapsEstimate': len(document.get('images', []))*256*256*4*4//3,
                 'runtimeExternalDependencies': []},
    'textures': [{'path': str(path.relative_to(ROOT)), 'width': 256, 'height': 256, 'bytes': path.stat().st_size,
                  'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(TEXTURES.glob('*.png'))],
    'refinements': refinement_records,
    'notes': [
        'Source fitted profiles are original project meshes, imported through a deterministic world-space geometry export.',
        'Blender changes edge topology, receiver/foreend shading, knife cutting bevels, finish zones, and sight inserts; it is not an unchanged round trip.',
        'Three catalog-wide materials and six shared 256px images serve all four weapons.',
        'Wood and polymer occupy padded atlas regions with separate object charts and clamped sampling.',
        'Source grips, trigger openings, bores, rear notch dimensions and muzzle anchors are retained.',
        'Texture memory is an RGBA8 plus mip estimate, not measured driver residency.',
    ],
}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('WEAPONS_DELIVERY', json.dumps(manifest['delivery']))
if not options.skip_render:
    for type_name in roots:
        for other, group in parts.items():
            for obj in group:
                obj.hide_render = other != type_name
        record = weapons[type_name]['bounds']
        center = [(a+b)/2 for a,b in zip(record['min'], record['max'])]
        length = record['max'][0]-record['min'][0]
        camera_data.ortho_scale = length*1.30
        camera.location = g((center[0]-.42, center[1]+.23, -.85)); aim(camera, center)
        scene.render.filepath = str(REVIEW / (type_name+'-asset-beauty.png'))
        bpy.ops.render.render(write_still=True)
    for group in parts.values():
        for obj in group:
            obj.hide_render = False
# Open the editable source on one uncluttered model, with all other roots
# retained in the Outliner. Alt-H reveals them; GLB was exported before this
# authoring-only visibility choice and still contains all four origin-fitted
# weapons. Set the review camera back to the visible SMG after batch renders.
for type_name, root in roots.items():
    hidden = type_name != 'smg'
    root.hide_set(hidden)
    for obj in parts[type_name]:
        obj.hide_set(hidden)
        obj.hide_render = hidden
scene['catalogEditing'] = ('SMG is initially visible. Other vm_* roots retain their editable parts at the shared fitted origin. '
                           'Use Alt-H to reveal hidden meshes, then isolate the desired vm_* root. All four export to GLB.')
camera_data.ortho_scale = .63
camera.location = g((-.37, .24, -.90)); aim(camera, (.04, -.04, 0))
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
print('WEAPONS_ASSET_DONE', str(glb))
