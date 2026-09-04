"""Refine original project meshes in Blender and export geometry-only templates.

  node tools/blender/export-world-dressing-source.mjs
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-world-dressing.py

The editable source retains a hidden SOURCE collection and an AUTHORED collection.
The custom catalog deliberately carries no materials/textures: game placements,
shared materials, batching, colliders and surface ownership remain in JavaScript.
Coordinates are metres, converted between Blender Z-up and game Y-up on export.
"""
import hashlib
import json
import math
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/blender/world-dressing-source.json'
OUTPUT = ROOT / 'public/assets/models/world-dressing'
OUTPUT.mkdir(parents=True, exist_ok=True)
document = json.loads(SOURCE.read_text())
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
source_collection = bpy.data.collections.new('SOURCE — original project meshes')
authored_collection = bpy.data.collections.new('AUTHORED — refined game templates')
scene.collection.children.link(source_collection)
scene.collection.children.link(authored_collection)
source_collection.hide_render = True
source_collection.hide_viewport = True


def blender(point):
    return (point[0], -point[2], point[1])


def game(point):
    return (point[0], point[2], -point[1])


def object_mesh(name, vertices, faces, collection):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([blender(point) for point in vertices], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def import_source(entry):
    points = [entry['positions'][i:i + 3] for i in range(0, len(entry['positions']), 3)]
    faces = [entry['index'][i:i + 3] for i in range(0, len(entry['index']), 3)]
    obj = object_mesh(entry['id'] + ' — original', points, faces, source_collection)
    layer = obj.data.uv_layers.new(name='Original project UV')
    for loop in obj.data.loops:
        layer.data[loop.index].uv = entry['uv'][loop.vertex_index * 2:loop.vertex_index * 2 + 2]
    return obj


def clean_mesh(obj):
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.0000001)
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    bmesh.ops.dissolve_limit(mesh, angle_limit=0.00001, verts=list(mesh.verts), edges=list(mesh.edges))
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()


def bevel(obj, width, selector=None):
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.normal_update()
    # The transferred source is triangulated; never bevel its coplanar face
    # diagonals, which would create raised mitres and exceed collider bounds.
    edges = [edge for edge in mesh.edges if edge.is_manifold and edge.calc_face_angle(0) > .01
             and (selector is None or selector(edge))]
    bmesh.ops.bevel(mesh, geom=edges, offset=width, segments=1, affect='EDGES', clamp_overlap=True)
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()


def lathe_y(name, profile, segments=48):
    vertices, faces = [], []
    # One vertex at each pole avoids degenerate triangles.
    rings = []
    for radius, y in profile:
        ring = []
        for i in range(segments if radius else 1):
            angle = i * 2 * math.pi / segments
            ring.append(len(vertices))
            vertices.append((radius * math.sin(angle), y, radius * math.cos(angle)))
        rings.append(ring)
    for lower, upper in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            if len(lower) == 1:
                faces.append((lower[0], upper[j], upper[i]))
            elif len(upper) == 1:
                faces.append((lower[i], lower[j], upper[0]))
            else:
                faces.append((lower[i], lower[j], upper[j], upper[i]))
    obj = object_mesh(name, vertices, faces, authored_collection)
    clean_mesh(obj)
    # Smooth circumferential facets but retain deliberate formed edge changes.
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.set_sharp_from_angle(angle=0.4)
    return obj


def guard_torus(name, radius, tube):
    vertices, faces = [], []
    for i in range(24):
        angle = i * math.tau / 24
        for j in range(4):
            cross = j * math.tau / 4
            r = radius + tube * math.cos(cross)
            vertices.append((r * math.cos(angle), r * math.sin(angle), tube * math.sin(cross)))
    for i in range(24):
        for j in range(4):
            faces.append((i * 4 + j, ((i + 1) % 24) * 4 + j,
                          ((i + 1) % 24) * 4 + (j + 1) % 4, i * 4 + (j + 1) % 4))
    obj = object_mesh(name, vertices, faces, authored_collection)
    clean_mesh(obj)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def bridge_handle(name):
    section = [(-.11, -.025), (-.11, .025), (.11, .025), (.11, -.025),
               (.075, -.025), (.075, .009), (-.075, .009), (-.075, -.025)]
    vertices = [(x, y, z) for z in [-.035, .035] for x, y in section]
    count = len(section)
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, j + count, i + count))
    obj = object_mesh(name, vertices, faces, authored_collection)
    clean_mesh(obj)
    return obj


def refine(entry, original):
    kind, dimensions = entry['refinement'], entry['dimensions']
    if kind == 'guard-retopology':
        return guard_torus(entry['id'], *dimensions)
    if kind == 'stave-end-bevel':
        return lathe_y(entry['id'], [(0, -1.1), (1.382, -1.1), (1.4, -1.082),
                                     (1.4, 1.082), (1.382, 1.1), (0, 1.1)])
    if kind == 'folded-eave-crown':
        return lathe_y(entry['id'], [(0, -.35), (1.55, -.35), (1.55, -.315),
                                     (1.52, -.29), (.04, .335), (0, .35)])
    if kind == 'open-bridge-handle':
        return bridge_handle(entry['id'])
    obj = original.copy()
    obj.data = original.data.copy()
    obj.name = entry['id']
    authored_collection.objects.link(obj)
    clean_mesh(obj)
    if kind == 'body-edge-break':
        bevel(obj, .022)
    elif kind == 'case-edge-break':
        bevel(obj, .009)
    elif kind == 'board-edge-break':
        bevel(obj, .003)
    elif kind == 'case-vertical-corners':
        bevel(obj, .018, lambda edge: abs(edge.verts[0].co.z - edge.verts[1].co.z) > dimensions[1] * .99
              and abs(edge.verts[0].co.x - edge.verts[1].co.x) < .00001
              and abs(edge.verts[0].co.y - edge.verts[1].co.y) < .00001)
    elif kind == 'cast-end-bevel':
        bevel(obj, .016, lambda edge: abs(edge.verts[0].co.x - edge.verts[1].co.x) < .00001)
    elif kind == 'folded-blade':
        for vertex in obj.data.vertices:
            x, y, z = game(vertex.co)
            vertex.co = blender((x, y * .5 + z * .36, z))
        obj.data.update()
    return obj


def export_entry(entry, obj):
    mesh = obj.data
    # Canonical metric projection is reapplied at each game placement. The
    # cylinder uses the existing authored 32-stave mapping instead.
    for layer in list(mesh.uv_layers):
        mesh.uv_layers.remove(layer)
    layer = mesh.uv_layers.new(name='Game surface UV')
    mesh.calc_loop_triangles()
    barrel = entry['family'] == 'water-tank-barrel'
    positions, normals, uvs, indices, unique = [], [], [], [], {}
    side_vertices = set()
    for triangle in mesh.loop_triangles:
        triangle_points = [game(mesh.vertices[mesh.loops[index].vertex_index].co) for index in triangle.loops]
        around = [(math.atan2(point[0], point[2]) % math.tau) / math.tau for point in triangle_points]
        # Preserve the duplicate wrap seam, rather than interpolating 2 to 0.
        if max(around) - min(around) > .5:
            around = [value + 1 if value < .5 else value for value in around]
        for corner, loop_index in enumerate(triangle.loops):
            point = triangle_points[corner]
            normal = game(mesh.corner_normals[loop_index].vector)
            x, y, z = point
            nx, ny, nz = map(abs, normal)
            side = barrel and ny < .999
            if side:
                uv = (.525 + ((y + 1.1) / 2.2) * (.559 - .525), around[corner] * 2)
            elif barrel:
                uv = (.5 + x / 2.8, .5 + z / 2.8)
            elif nx >= ny and nx >= nz:
                uv = (z, y)
            elif ny >= nz:
                uv = (x, z)
            else:
                uv = (x, y)
            layer.data[loop_index].uv = uv
            key = tuple(round(value, 7) for value in (*point, *normal, *uv))
            if key not in unique:
                unique[key] = len(positions) // 3
                positions.extend(key[:3]); normals.extend(key[3:6]); uvs.extend(key[6:])
            index = unique[key]
            indices.append(index)
            if side:
                side_vertices.add(index)
    vertices = list(zip(*[iter(positions)] * 3))
    bounds = {'min': [min(point[axis] for point in vertices) for axis in range(3)],
              'max': [max(point[axis] for point in vertices) for axis in range(3)]}
    metadata = {'source': 'original-blender-authored', 'family': entry['family'], 'refinement': entry['refinement']}
    if barrel:
        metadata['waterTankStaves'] = {'staves': 32, 'circumferentialRepeats': 2,
                                      'grainUMin': .525, 'grainUMax': .559, 'sideVertices': len(side_vertices)}
    return {**{key: entry[key] for key in ['id', 'family', 'dimensions', 'instances', 'sourceTriangles']},
            'triangles': len(indices) // 3, 'bounds': bounds, 'metadata': metadata,
            'positions': positions, 'normals': normals, 'uv': uvs, 'index': indices}


entries = []
for entry in document['entries']:
    original = import_source(entry)
    authored = refine(entry, original)
    authored['family'] = entry['family']
    authored['source_triangles'] = entry['sourceTriangles']
    authored['refinement'] = entry['refinement']
    entries.append(export_entry(entry, authored))
    # A readable editing layout; export uses local mesh coordinates above.
    column, row = (len(entries) - 1) % 5, (len(entries) - 1) // 5
    authored.location = blender((column * 4.0, 0, row * 3.6))
    original.location = authored.location
    print(entry['id'], entry['sourceTriangles'], '->', entries[-1]['triangles'])

catalog = {'version': 1, 'authoringTool': bpy.app.version_string, 'coordinateSystem': 'metres; X right, Y up, Z depth',
           'source': 'original-blender-authored', 'materials': 0, 'textures': 0, 'entries': entries}
payload = json.dumps(catalog, separators=(',', ':')).encode()
(OUTPUT / 'catalog.json').write_bytes(payload)
source_triangles = sum(entry['sourceTriangles'] * entry['instances'] for entry in entries)
triangles = sum(entry['triangles'] * entry['instances'] for entry in entries)
manifest = {'version': 1, 'source': 'assets/blender/world-dressing.blend',
            'sourceTransfer': str(SOURCE.relative_to(ROOT)), 'builder': 'tools/blender/build-world-dressing.py',
            'catalogBytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
            'templateCount': len(entries), 'sourcePlacedTriangles': source_triangles,
            'placedTriangles': triangles, 'triangleDelta': triangles - source_triangles,
            'addedDraws': 0, 'addedMaterials': 0, 'addedTextures': 0, 'addedLights': 0,
            'entries': [{key: entry[key] for key in ['id', 'family', 'dimensions', 'instances', 'sourceTriangles', 'triangles', 'bounds']} for entry in entries]}
(OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'assets/blender/world-dressing.blend'))
print('WORLD DRESSING:', json.dumps({key: manifest[key] for key in ['catalogBytes', 'templateCount', 'sourcePlacedTriangles', 'placedTriangles', 'triangleDelta']}))
