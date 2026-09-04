"""Build the original, geometry-only furniture template catalog.

Run: /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-furniture.py
Append ``-- --export-existing`` to export edited meshes from furniture.blend
instead of regenerating their original design. Edit mesh vertices/normals;
object placement only arranges the source for inspection and is not exported.

The source contains six editable, named meshes. The game instantiates their
vertex data at exact fixture dimensions before its existing material batching.
No glTF materials, scene nodes, textures, collision or runtime Blender dependency
are added. Game axes are X right, Y up, Z forward; Blender uses Z up.
"""
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/models/furniture'
SOURCE = ROOT / 'assets/blender/furniture.blend'
EXPORT_EXISTING = '--export-existing' in sys.argv
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.parent.mkdir(parents=True, exist_ok=True)
if EXPORT_EXISTING:
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
else:
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = 'METRIC'


def g(p):
    return (p[0], -p[2], p[1])


def game(p):
    return (p[0], p[2], -p[1])


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def mesh_obj(name, vertices, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([g(p) for p in vertices], [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def normals(obj, weighted=False):
    for face in obj.data.polygons:
        face.use_smooth = True
    if weighted:
        activate(obj)
        mod = obj.modifiers.new('Weighted broad-face normals', 'WEIGHTED_NORMAL')
        mod.keep_sharp = True
        mod.weight = 50
        bpy.ops.object.modifier_apply(modifier=mod.name)


def rounded_box(name, segments):
    bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    obj.name = name
    bevel = obj.modifiers.new('Metric corner profile', 'BEVEL')
    bevel.width = 0.25
    bevel.segments = segments
    bevel.affect = 'EDGES'
    bevel.harden_normals = True
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    normals(obj, weighted=True)
    # Give expanding broad faces truly planar normals. A weighted normal baked
    # on this unit cage would otherwise bow the lighting of a long, thin door
    # after parameterization. The rounded cage supplies the corner direction;
    # these split normals remain valid for every metric-width/radius override.
    corner_normals = []
    for loop in obj.data.loops:
        point = obj.data.vertices[loop.vertex_index].co
        inner = Vector(tuple(max(-.75, min(.75, value)) for value in point))
        corner_normals.append(tuple((point - inner).normalized()))
    obj.data.normals_split_custom_set(corner_normals)
    obj['template_half_extent'] = 1.0
    obj['template_radius'] = 0.25
    obj['usage'] = 'Metric radius stays constant while six broad faces expand to exact fixture dimensions.'
    return obj


def leg():
    # A wider, quieter shoulder and rounded eight-sided foot replace the old
    # angular turned bands. The full-width middle collar stays at 47–55%.
    profile = [(0, .64), (.07, .64), (.16, .74), (.43, .82),
               (.47, 1), (.55, 1), (.64, .86), (.90, .96), (.94, 1), (1, 1)]
    cross = [(-.68, -1), (.68, -1), (1, -.68), (1, .68),
             (.68, 1), (-.68, 1), (-1, .68), (-1, -.68)]
    vertices = [(x * s / 2, y - .5, z * s / 2) for y, s in profile for x, z in cross]
    faces = []
    for row in range(len(profile) - 1):
        for i in range(8):
            j = (i + 1) % 8
            faces.append((row * 8 + i, (row + 1) * 8 + i, (row + 1) * 8 + j, row * 8 + j))
    faces.extend([tuple(range(7, -1, -1)), tuple(range((len(profile) - 1) * 8, len(profile) * 8))])
    obj = mesh_obj('profiled-leg', vertices, faces)
    normals(obj, weighted=True)
    return obj


def lathe(name, profile, sides, axis='y', weighted=False):
    vertices, rings, faces = [], [], []
    for radius, height in profile:
        ring = []
        for i in range(sides if radius else 1):
            angle = 2 * math.pi * i / sides
            p = (radius * math.cos(angle), height, radius * math.sin(angle))
            if axis == 'z':
                p = (p[0], p[2], p[1])
            ring.append(len(vertices))
            vertices.append(p)
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            if len(a) == 1:
                faces.append((a[0], b[i], b[j]))
            elif len(b) == 1:
                faces.append((a[i], b[0], a[j]))
            else:
                faces.append((a[i], b[i], b[j], a[j]))
    obj = mesh_obj(name, vertices, faces)
    normals(obj, weighted=weighted)
    return obj


def handle():
    vertices, faces = [], []
    segments, sides = 16, 6
    for ring in range(segments + 1):
        angle = -math.pi / 2 + ring / segments * math.pi
        # Same bowl clearance/attachment endpoints; fuller middle has a softly
        # squared outer grip that reads more like a formed ceramic handle.
        x = .025 * math.cos(angle) + .0022 * math.sin(angle)
        y = .029 * math.sin(angle)
        tangent = Vector((-.025 * math.sin(angle) + .0022 * math.cos(angle),
                          .029 * math.cos(angle), 0)).normalized()
        radial = Vector((tangent.y, -tangent.x, 0))
        for side in range(sides):
            theta = side / sides * math.tau
            offset = radial * (math.cos(theta) * .003)
            vertices.append((x + offset.x, y + offset.y, math.sin(theta) * .003))
    for ring in range(segments):
        for side in range(sides):
            j = (side + 1) % sides
            faces.append((ring * sides + side, (ring + 1) * sides + side,
                          (ring + 1) * sides + j, ring * sides + j))
    obj = mesh_obj('cup-handle', vertices, faces)
    normals(obj)
    return obj


objects = ([bpy.data.objects[name] for name in ['milled-box', 'soft-box', 'profiled-leg', 'knob', 'cup', 'cup-handle']]
           if EXPORT_EXISTING else
           [rounded_box('milled-box', 1), rounded_box('soft-box', 4), leg(),
            lathe('knob', [(0, -.5), (.39, -.5), (.5, .34), (.42, .5), (0, .5)], 8, 'z', True),
            lathe('cup', [(0, 0), (.032, 0), (.044, .097), (.043, .1), (.039, .1), (.034, .015), (0, .015)], 16),
            handle()])


def export_mesh(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    positions, normals_data, indices, lookup = [], [], [], {}
    for triangle in mesh.loop_triangles:
        # The room baker owns planar triangle charts and deliberately excludes
        # vertices shared with curved bevels. Keep those UV2 ownership seams
        # while preserving identical smooth shading normals and UV0. Separate
        # planar triangles also retain the previous minimum-area chart gate.
        planar = obj.name in ('milled-box', 'soft-box') and all(
            mesh.corner_normals[loop_index].vector.dot(triangle.normal) >= .9999
            for loop_index in triangle.loops)
        for loop_index in triangle.loops:
            loop = mesh.loops[loop_index]
            p = [round(value, 8) for value in game(mesh.vertices[loop.vertex_index].co)]
            n = [round(value, 8) for value in game(mesh.corner_normals[loop_index].vector)]
            key = (('lightmap-chart', triangle.index) if planar else ('surface',)) + tuple(p + n)
            if key not in lookup:
                lookup[key] = len(positions) // 3
                positions.extend(p)
                normals_data.extend(n)
            indices.append(lookup[key])
    return {'position': positions, 'normal': normals_data, 'index': indices,
            'triangles': len(indices) // 3}


catalog = {'version': 1, 'source': 'original-blender-authored', 'axes': 'X-right Y-up Z-forward',
           'templates': {obj.name: export_mesh(obj) for obj in objects}}
encoded = (json.dumps(catalog, separators=(',', ':'), allow_nan=False) + '\n').encode()
(OUT / 'catalog.json').write_bytes(encoded)
manifest = {'version': 1, 'source': 'assets/blender/furniture.blend',
            'builder': 'tools/blender/build-furniture.py', 'blender': bpy.app.version_string,
            'runtime': 'geometry templates; existing shared game materials and batched decorations',
            'file': 'catalog.json', 'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(),
            'materials': 0, 'textures': 0,
            'templates': {name: {'triangles': data['triangles'], 'vertices': len(data['position']) // 3}
                          for name, data in catalog['templates'].items()},
            'families': ['refrigerator', 'stove', 'sideboard', 'bookcase', 'bench',
                         'upholsteredSeat', 'bedding', 'chair', 'tableSetting'],
            'parameterization': 'Rounded boxes retain metric radius and exact outer bounds; legs use metric normals and UVs.',
            'lighting': 'Planar triangle vertices are isolated from bevels to retain existing interior lightmap chart ownership.'}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
# Arrange the editable templates for inspection without baking presentation
# placement into exported mesh buffers. Every object remains at unit scale.
for index, obj in enumerate(objects):
    obj.location.x = index * 2.5
    obj['provenance'] = 'Original project design authored with Blender; no external model assets.'
activate(objects[1])
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
print(json.dumps(manifest, indent=2))
