"""Prepare the project's reduced world weapons in Blender without new textures.

From the repository root:
  node tools/blender/export-world-weapons.mjs /tmp/world-weapons-source.json
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-world-weapons.py -- --source /tmp/world-weapons-source.json

The editable source retains individual mechanical parts. The export is geometry
only: runtime factories reuse their existing steel/wood/polymer/cloth materials.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import bpy

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/models/world-weapons'
SOURCE = ROOT / 'assets/blender/world-weapons.blend'
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True)
options = parser.parse_args(args)
seed = json.loads(Path(options.source).read_text())
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 1

def g(point):
    return (point[0], -point[2], point[1])

def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

materials = []
for name, color in [('steel-reference', (.20, .23, .25, 1)), ('furniture-reference', (.16, .11, .07, 1))]:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get('Principled BSDF')
    principled.inputs['Base Color'].default_value = color
    principled.inputs['Roughness'].default_value = .65
    materials.append(mat)

collections = {}
for kind in ['pistol', 'shotgun', 'smg', 'machinegun', 'bat']:
    col = bpy.data.collections.new(kind + ' • shared world geometry')
    bpy.context.scene.collection.children.link(col)
    collections[kind] = col

def make(part, positions=None, uv=None, colors=None, faces=None, normals=None):
    attributes = part['attributes']
    if positions is None:
        positions = [attributes['position'][i:i+3] for i in range(0, len(attributes['position']), 3)]
        uv = [attributes['uv'][i:i+2] for i in range(0, len(attributes['uv']), 2)]
        raw = attributes.get('color', [1.] * (len(positions) * 3))
        colors = [raw[i:i+3] for i in range(0, len(raw), 3)]
        normals = [attributes['normal'][i:i+3] for i in range(0, len(attributes['normal']), 3)]
    if faces is None:
        faces = [list(range(i, i+3)) for i in range(0, len(positions), 3)]
    # Weld positions while retaining independent UV/tint/normal corners. This
    # lets Blender's weighted normals improve real bevel transitions reliably.
    vertices, lookup, remap = [], {}, []
    for point in positions:
        key = tuple(round(value, 7) for value in point)
        if key not in lookup:
            lookup[key] = len(vertices)
            vertices.append(g(point))
        remap.append(lookup[key])
    faces = [face for face in faces if len(set(remap[index] for index in face)) == len(face)]
    mesh = bpy.data.meshes.new(part['type'] + ':' + part['name'])
    mesh.from_pydata(vertices, [], [[remap[index] for index in face] for face in faces])
    mesh.update()
    layer = mesh.uv_layers.new(name='SurfaceUV')
    color = mesh.color_attributes.new(name='FinishTint', type='FLOAT_COLOR', domain='CORNER')
    source_normals = []
    for polygon, face in zip(mesh.polygons, faces):
        for loop, index in zip(polygon.loop_indices, face):
            layer.data[loop].uv = (uv[index][0], 1 - uv[index][1])
            color.data[loop].color = (*colors[index], 1)
            source_normals.append(g(normals[index]) if normals else tuple(polygon.normal))
    mesh.color_attributes.active_color = color
    mesh.color_attributes.render_color_index = 0
    mesh.normals_split_custom_set(source_normals)
    obj = bpy.data.objects.new(part['type'] + '__' + part['name'], mesh)
    collections[part['type']].objects.link(obj)
    mesh.materials.append(materials[part['group']])
    obj['weaponType'] = part['type']
    obj['weaponPart'] = part['name']
    obj['materialGroup'] = part['group']
    return obj

def weighted(obj):
    # Broad receiver faces retain their planes while narrow bevels catch a
    # coherent highlight. Sharp corners stay split; the geometry count is fixed.
    mesh = obj.data
    edge_faces = {edge.key: [] for edge in mesh.edges}
    for polygon in mesh.polygons:
        for edge in polygon.edge_keys:
            edge_faces[tuple(sorted(edge))].append(polygon)
        polygon.use_smooth = True
    for edge in mesh.edges:
        faces = edge_faces[edge.key]
        edge.use_edge_sharp = len(faces) != 2 or faces[0].normal.dot(faces[1].normal) < math.cos(math.radians(55))
    activate(obj)
    mod = obj.modifiers.new('Area-weighted bevel finish', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.weight = 50
    bpy.ops.object.modifier_apply(modifier=mod.name)

def planar_cleanup(obj):
    # The procedural crown deformation leaves redundant coplanar triangles.
    # Dissolve those interior edges, preserving the actual hole boundaries and
    # UV seams, to spend the same budget on a rounder chamfered muzzle instead.
    activate(obj)
    modifier = obj.modifiers.new('Preserve outline and dissolve planar interiors', 'DECIMATE')
    modifier.decimate_type = 'DISSOLVE'
    modifier.angle_limit = math.radians(.025)
    modifier.use_dissolve_boundaries = False
    modifier.delimit = {'UV', 'MATERIAL'}
    bpy.ops.object.modifier_apply(modifier=modifier.name)

def tube(part):
    """Use saved planar-interior triangles for a rounder chamfered muzzle."""
    a = part['attributes']['position']
    points = [a[i:i+3] for i in range(0, len(a), 3)]
    low = [min(p[axis] for p in points) for axis in range(3)]
    high = [max(p[axis] for p in points) for axis in range(3)]
    cy = (low[1] + high[1]) / 2
    radii = [math.hypot(p[0], p[1] - cy) for p in points]
    outer, inner = max(radii), min(radii)
    back, front = low[2], high[2]
    edge = min(.0008, (outer - inner) * .25, (front - back) * .12)
    rings = [(inner, back), (outer, back), (outer, front-edge), (outer-edge, front), (inner, front), (inner, back)]
    positions, uv, colors, faces = [], [], [], []
    tint = sum(part['attributes']['color']) / len(part['attributes']['color'])
    segments = 16
    angles = [2 * math.pi * i / segments for i in range(segments + 1)]
    for ring, (radius, z) in enumerate(rings):
        for angle in angles:
            positions.append((math.sin(angle) * radius, cy + math.cos(angle) * radius, z))
            uv.append((z / .18, angle * outer / .18))
            value = min(1, tint * (1.14 if ring == 3 else 1))
            colors.append((value, value, value))
    n = len(angles)
    for ring in range(len(rings)-1):
        for side in range(segments):
            a, b = ring*n+side, ring*n+side+1
            faces.append([a, a+n, b+n, b])
    obj = make(part, positions, uv, colors, faces)
    weighted(obj)
    return obj

def bat_wood(part):
    # 28 instead of 24 radial segments, funded by removing two redundant
    # nearly linear axial rings. Grip, tapered profile and tip stay canonical.
    profile = [(0,-.140),(.015,-.139),(.022,-.135),(.024,-.130),(.024,-.125),(.021,-.120),
               (.014,-.114),(.0128,-.105),(.0131,0),(.0140,.12),(.0158,.20),(.0190,.29),
               (.0235,.38),(.0283,.47),(.0316,.55),(.033,.62),(.0323,.678),(.030,.691),(.023,.698),(0,.700)]
    n = 28
    positions, uv, faces = [], [], []
    for radius, z in profile:
        for i in range(n+1):
            angle = i * math.pi*2/n
            positions.append((math.sin(angle)*radius, math.cos(angle)*radius, z))
            uv.append((i/n, (z+.14)/.84))
    for ring in range(len(profile)-1):
        for i in range(n):
            a, b = ring*(n+1)+i, ring*(n+1)+i+1
            faces.extend([[a,a+n+1,b+n+1], [a,b+n+1,b]])
    obj = make(part, positions, uv, [(1,1,1)]*len(positions), faces)
    weighted(obj)
    return obj

tubes = {'pistol-hollow-muzzle','shotgun-barrel','shotgun-magazine-tube','smg-barrel',
         'smg-muzzle-collar','machinegun-barrel','machinegun-muzzle-collar'}
objects = []
for part in seed['parts']:
    name = part['name']
    if part['type'] == 'bat' and name == 'bat-wood':
        obj = bat_wood(part)
    elif name in tubes:
        obj = tube(part)
    else:
        obj = make(part)
        if name in ['pistol-slide', 'shotgun-action', 'smg-receiver', 'machinegun-receiver']:
            planar_cleanup(obj)
        if any(term in name for term in ['receiver', 'slide', 'action', 'stock', 'grip', 'top-cover']):
            weighted(obj)
    objects.append(obj)

for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
glb = OUT / 'world-weapons.glb'
bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_selection=True,
    export_animations=False, export_cameras=False, export_lights=False, export_extras=True,
    export_yup=True, export_apply=True, export_texcoords=True, export_normals=True,
    export_tangents=False, export_all_vertex_colors=False, export_vertex_color='NAME',
    export_vertex_color_name='FinishTint', export_materials='EXPORT')
data = glb.read_bytes()
length = struct.unpack_from('<I', data, 12)[0]
document = json.loads(data[20:20+length])
counts = {kind: 0 for kind in collections}
for node in document['nodes']:
    if 'mesh' not in node:
        continue
    kind = node['extras']['weaponType']
    for primitive in document['meshes'][node['mesh']]['primitives']:
        counts[kind] += document['accessors'][primitive['indices']]['count']//3
caps = {'pistol':856,'shotgun':1172,'smg':1280,'machinegun':1320,'bat':1300}
for kind, triangles in counts.items():
    if triangles > caps[kind]:
        raise RuntimeError(f'{kind}: {triangles} exceeds {caps[kind]}')
manifest = {
    'schemaVersion':1, 'source':'original-project-blender-refined',
    'sourceFile':'assets/blender/world-weapons.blend', 'rebuild':'tools/blender/build-world-weapons.py',
    'sourceExport':'tools/blender/export-world-weapons.mjs',
    'runtimeFile':'public/assets/models/world-weapons/world-weapons.glb',
    'geometry':{'triangles':counts, 'maximumTriangles':caps, 'drawsPerWeapon':2},
    'delivery':{'glbBytes':len(data), 'sha256':hashlib.sha256(data).hexdigest(), 'embeddedImages':0},
    'refinements':['16-segment chamfered firearm muzzle edges replace 12-segment square edges, retaining canonical bore anchors.',
                   'Area-weighted receiver, furniture and barrel normals on shared immutable buffers.',
                   '28-segment bat body using fewer redundant axial rings, preserving canonical profile anchors.',
                   'Planar receiver cleanup funds rounder muzzle chamfers within existing world-gun triangle caps.'],
    'materials':'Existing runtime finishes are reused; no new texture or shader draws.',
}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('WORLD_WEAPONS_MANIFEST ' + json.dumps(manifest))
