"""Prepare the original project's six vehicle models in Blender.

Rebuild from repo root:
  node tools/blender/export-vehicle-source.mjs
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-vehicles.py

Source reconstruction overwrites vehicles.blend. Save hand-edited sources under
a new name before rebuilding. Runtime geometry has zero textures; the game owns
paint, wear, glass and idling lamp materials. Original tire/contact geometry,
glazing and part names remain intact. Mesh refinements stay inside the original
placement envelopes. Game axes +X forward/+Y up/+Z right use metres.
"""
import hashlib
import json
import math
from pathlib import Path
import struct

import bpy
import bmesh

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'assets/blender/vehicles-source.json'
SOURCE = ROOT / 'assets/blender/vehicles.blend'
OUT = ROOT / 'public/assets/models/vehicles'
OUT.mkdir(parents=True, exist_ok=True)
records = json.loads(INPUT.read_text())['variants']
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for material in list(bpy.data.materials):
    bpy.data.materials.remove(material)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
bpy.context.preferences.filepaths.save_version = 0


def g(p):
    return (p[0], -p[2], p[1])


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


PALETTE = {
    'paint': (.30, .34, .27, 1), 'trim': (.030, .041, .034, 1),
    'metal': (.47, .51, .46, 1), 'glass': (.055, .093, .080, 1),
    'tires': (.007, .010, .008, 1), 'lamps': (1, 1, 1, 1),
    'headlamps': (.92, .84, .62, 1), 'rearlamps': (.28, .023, .021, 1),
}
materials = {}
for category, color in PALETTE.items():
    material = bpy.data.materials.new('vehicle-' + category)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = .26 if category == 'glass' else .57 if category in ['paint', 'metal'] else .86
    bsdf.inputs['Metallic'].default_value = .6 if category == 'metal' else .25 if category == 'paint' else 0
    attr = material.node_tree.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'FinishTint'
    multiply = material.node_tree.nodes.new('ShaderNodeMixRGB')
    multiply.blend_type = 'MULTIPLY'
    multiply.inputs[0].default_value = 1
    multiply.inputs[2].default_value = color
    material.node_tree.links.new(attr.outputs['Color'], multiply.inputs[1])
    material.node_tree.links.new(multiply.outputs['Color'], bsdf.inputs['Base Color'])
    materials[category] = material


def prepare_surface(obj, bevel_width=0):
    """Weld real panel topology and keep broad panels flat beside edge rolls."""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    bmesh.ops.dissolve_limit(bm, angle_limit=0.0001, verts=list(bm.verts),
                           edges=list(bm.edges), use_dissolve_boundaries=False)
    bm.to_mesh(mesh)
    bm.free()
    if bevel_width:
        activate(obj)
        bevel = obj.modifiers.new('Pressed edge radius', 'BEVEL')
        bevel.width = bevel_width
        bevel.segments = 1
        bevel.limit_method = 'ANGLE'
        bevel.angle_limit = math.radians(36)
        bevel.use_clamp_overlap = True
        bpy.ops.object.modifier_apply(modifier=bevel.name)
    mesh = obj.data
    for poly in mesh.polygons:
        poly.use_smooth = True
    # Preserve intentional hard creases (openings, inner sill and roof lip)
    # while a weighted normal field rounds the narrow external edge bands.
    mesh.set_sharp_from_angle(angle=math.radians(65))
    activate(obj)
    modifier = obj.modifiers.new('Area weighted panel normals', 'WEIGHTED_NORMAL')
    modifier.keep_sharp = True
    modifier.weight = 40
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def project_panel_uvs(mesh):
    # Original roof caps use top projection even on the vertical drip lip.
    # Separate physical face charts also give those side bands real UV area.
    layer = mesh.uv_layers.active
    for polygon in mesh.polygons:
        dominant = max(range(3), key=lambda axis: abs(polygon.normal[axis]))
        axes = [axis for axis in range(3) if axis != dominant]
        for index in polygon.loop_indices:
            point = mesh.vertices[mesh.loops[index].vertex_index].co
            layer.data[index].uv = (point[axes[0]], point[axes[1]])


roots = []
parts = []
changes = {}
for record in records:
    variant = record['variant']
    collection = bpy.data.collections.new(variant + ' • editable original parts')
    scene.collection.children.link(collection)
    root = bpy.data.objects.new(variant, None)
    collection.objects.link(root)
    roots.append(root)
    meta = {key: value for key, value in record.items() if key != 'parts'}
    root['vehicleMetadata'] = json.dumps(meta, separators=(',', ':'))
    changes[variant] = []
    for part in record['parts']:
        name, category, attrs = part['name'], part['category'], part['attributes']
        p, n, uv, color = [attrs[key]['array'] for key in ['position', 'normal', 'uv', 'color']]
        vertices = [g(p[i:i+3]) for i in range(0, len(p), 3)]
        indices = part.get('index') or list(range(len(vertices)))
        faces = [indices[i:i+3] for i in range(0, len(indices), 3)]
        mesh = bpy.data.meshes.new(variant + '::' + name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        texture = mesh.uv_layers.new(name='UVMap')
        tint = mesh.color_attributes.new(name='FinishTint', type='FLOAT_COLOR', domain='CORNER')
        for loop in mesh.loops:
            index = loop.vertex_index
            texture.data[loop.index].uv = uv[index*2:index*2+2]
            tint.data[loop.index].color = (*color[index*3:index*3+3], 1)
        obj = bpy.data.objects.new(variant + '::' + name, mesh)
        obj.parent = root
        collection.objects.link(obj)
        obj.data.materials.append(materials[category])
        obj['vehicleVariant'] = variant
        obj['vehicleCategory'] = category
        obj['vehiclePart'] = name
        parts.append(obj)
        # Refine screen-readable manufactured parts. Tires, glass and seams
        # retain their original vertex positions and split normals exactly.
        radius = 0
        if any(token in name for token in ['mirror-housing', 'door-handle', 'headlamp-', 'tail-lamp-']):
            bounds = [max(p[i::3]) - min(p[i::3]) for i in range(3)]
            radius = min(.006, min(bounds) * .25)
        if variant == 'objective-sedan' and any(token in name for token in ['-mirror-', '-door-handle-']):
            bounds = [max(p[i::3]) - min(p[i::3]) for i in range(3)]
            radius = min(.004, min(bounds) * .20)
        shaped_panel = name in ['body-shell', 'crowned-roof', 'front-bumper', 'rear-bumper']
        shaped_panel |= variant == 'objective-sedan' and any(token in name for token in ['-body-', '-hood-', '-roof-', '-bumper-'])
        if radius or shaped_panel:
            prepare_surface(obj, radius)
            if name == 'crowned-roof' or (variant == 'objective-sedan' and '-roof-' in name):
                project_panel_uvs(obj.data)
            changes[variant].append({'part': name, 'edgeRadiusMetres': radius,
                                     'surface': 'welded topology with area-weighted normals'})
        else:
            for polygon in mesh.polygons:
                polygon.use_smooth = True
            mesh.normals_split_custom_set([g(n[loop.vertex_index*3:loop.vertex_index*3+3]) for loop in mesh.loops])

# The saved source arranges individual variants in a readable workshop grid.
# Delivery restores every root to its own local origin before export.
for index, root in enumerate(roots):
    root.location = ((index % 3) * 6.5, (index // 3) * 4.0, 0)
scene.world.color = (.15, .15, .15)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
for root in roots:
    root.location = (0, 0, 0)
bpy.ops.object.select_all(action='DESELECT')
for obj in roots + parts:
    obj.select_set(True)
bpy.context.view_layer.objects.active = roots[0]
glb = OUT / 'vehicles.glb'
bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_selection=True,
    export_yup=True, export_extras=True, export_animations=False, export_cameras=False,
    export_lights=False, export_materials='EXPORT', export_texcoords=True,
    export_normals=True, export_tangents=False, export_all_vertex_colors=False,
    export_vertex_color='NAME', export_vertex_color_name='FinishTint', export_apply=True)

blob = glb.read_bytes()
length = struct.unpack_from('<I', blob, 12)[0]
document = json.loads(blob[20:20+length])
assert not document.get('images'), 'Vehicles must not add texture downloads'
summaries = []
for record in records:
    variant = record['variant']
    triangles, vertices, accessor_ids, categories, part_names = 0, 0, set(), set(), []
    for node in document['nodes']:
        extras = node.get('extras', {})
        if extras.get('vehicleVariant') != variant:
            continue
        categories.add(extras['vehicleCategory'])
        part_names.append(extras['vehiclePart'])
        for primitive in document['meshes'][node['mesh']]['primitives']:
            triangles += document['accessors'][primitive['indices']]['count'] // 3
            vertices += document['accessors'][primitive['attributes']['POSITION']]['count']
            accessor_ids.update(primitive['attributes'].values())
            accessor_ids.add(primitive['indices'])
    sizes = {5120:1, 5121:1, 5122:2, 5123:2, 5125:4, 5126:4}
    counts = {'SCALAR':1, 'VEC2':2, 'VEC3':3, 'VEC4':4, 'MAT4':16}
    geometry_bytes = sum(document['accessors'][i]['count'] * sizes[document['accessors'][i]['componentType']]
                         * counts[document['accessors'][i]['type']] for i in accessor_ids)
    assert triangles <= (6500 if variant == 'objective-sedan' else 4200), (variant, triangles)
    summaries.append({'variant': variant, 'triangles': triangles, 'originalTriangles': record['resources']['triangles'],
        'parts': len(part_names), 'categories': sorted(categories), 'exportedVertices': vertices,
        'geometryBytes': geometry_bytes, 'changes': changes[variant]})
manifest = {
    'version': 1, 'source': 'original-blender-prepared', 'authoringTool': bpy.app.version_string,
    'generator': 'tools/blender/build-vehicles.py', 'sourceFile': 'assets/blender/vehicles.blend',
    'sourceInput': 'assets/blender/vehicles-source.json',
    'sourceInputSha256': hashlib.sha256(INPUT.read_bytes()).hexdigest(),
    'coordinateSystem': 'metres; +X forward, +Y up, +Z right', 'textures': 0,
    'glb': {'file': 'public/assets/models/vehicles/vehicles.glb', 'bytes': len(blob),
            'sha256': hashlib.sha256(blob).hexdigest()},
    'variants': summaries,
    'notes': [
        'Original project models receive targeted physical edge breaks and welded, weighted panel normals in Blender.',
        'Named tires, glass, window openings and collision metadata retain the established game contract.',
        'Runtime uses existing paint/finish/glass/emissive materials and merges parts into six civilian or seven objective material draws.',
        'Geometry accessor bytes exclude per-part source records, transient decode buffers and driver overhead.',
        'The source workshop grid is presentation only; each delivered variant uses its own local origin.'
    ]
}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('VEHICLE_ASSET_SUMMARY ' + json.dumps([{k:v for k,v in item.items() if k != 'changes'} for item in summaries]))
