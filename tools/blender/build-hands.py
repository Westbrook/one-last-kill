"""Export editable Blender hands and their sculpt-baked semantic finish.

Geometry export, preserving manual GAME / shape-key / UV edits:
  Blender --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --export-only
Rebake the saved SCULPT_Atlas_Master and export (preserves manual master edits):
  Blender --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --bake
Rebake only painted color/roughness while retaining the saved sculpt normal:
  Blender --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --bake-color
One-time explicit migration of a v1 accepted source: add --upgrade.

Only eight right GAME hand variants and two arm meshes ship. Runtime mirrors
hands once; three shared 512px maps replace the existing hand atlas atomically.
"""
import argparse
from array import array
import importlib.util
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/blender/hands.blend'
OUTPUT = ROOT / 'public/assets/models/hands'
RADII = [None, .015, .022, .030, .034, .036, .038, .040]


def gauss(value, center, width):
    return math.exp(-((value - center) / width) ** 2)


def refine_hand(point):
    """Sculpt dorsal pads/thenar heel while protecting every grip contact face.

    The palm's last ring and digit roots are locked; the glove/skin border and
    entire digit curl stay in their established contact envelope. Smooth fields
    move every coincident UV-island vertex identically in both shape keys.
    """
    x, y, z = point
    if -.031 < z < .065:
        edge = min(1, (z + .031) / .009) * min(1, (.065 - z) / .012)
        dorsal = max(0, min(1, (y - .010) / .012)) ** 2
        # Wider, flatter metacarpal pads interrupt the seed's regular ridges.
        spread = .42 + min(1, max(0, (.05 - z) / .082)) * .58
        tendons = sum(gauss(x, center * spread, .0065) for center in [-.027, -.009, .010, .028])
        narrow = -.00055 * tendons * gauss(z, .009, .038)
        broad = .00070 * gauss(x, -.006, .029) * gauss(z, .005, .040)
        # Four asymmetric broad knuckles and the thumb-side glove cushion.
        knuckles = sum(height * gauss(x, center, .009) for center, height in
                       [(-.027, .00075), (-.009, .00100), (.010, .00085), (.028, .00045)])
        knuckles *= gauss(z, -.021, .014)
        thenar = .0010 * gauss(x, -.026, .014) * gauss(z, .025, .026)
        y += edge * dorsal * (narrow + broad + knuckles + thenar)
        # The heel lies behind the gripped cylinder and gains a softer contour.
        palmar = max(0, min(1, (-y - .009) / .009)) ** 2
        y -= edge * palmar * .00065 * gauss(x, -.020, .018) * gauss(z, .025, .025)
    return (x, y, z)


def refine_arm(point, cuff):
    x, y, z = point
    t = y + .5
    angle = math.atan2(z / .94, x)
    # Rig endpoints stay exact; additional folds are sculpted into existing rings.
    if 0 < t < 1:
        if cuff:
            delta = .009 * math.sin(t * math.pi) ** 2 * math.cos(angle * 3 + .7)
        else:
            delta = (.00075 * math.sin(angle * 3 + t * 10)
                     + .00030 * math.sin(angle * 7 - t * 14)) * gauss(t, .81, .14) * math.sin(t * math.pi)
        radius = math.hypot(x, z / .94)
        if radius > 1e-8:
            x *= 1 + delta / radius
            z *= 1 + delta / radius
    return (x, y, z)


def normals(positions, faces):
    groups = {}
    keys = [tuple(round(axis * 1e8) for axis in point) for point in positions]
    for key in keys:
        groups.setdefault(key, Vector((0, 0, 0)))
    for triangle in faces:
        a, b, c = [Vector(positions[index]) for index in triangle]
        contribution = (b - a).cross(c - a)
        for index in triangle:
            groups[keys[index]] += contribution
    for normal in groups.values():
        if normal.length < 1e-12:
            raise ValueError('Collapsed hand surface normal')
        normal.normalize()
    return [tuple(groups[key]) for key in keys]


def material(name, color, roughness):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    return result


def build_seed_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    with tempfile.TemporaryDirectory(prefix='blender-hand-seed-') as temporary:
        seed = Path(temporary) / 'input.json'
        subprocess.run([shutil.which('node') or 'node', str(ROOT / 'tools/blender/export-hands-input.mjs'), str(seed)], check=True, cwd=ROOT)
        meshes = json.loads(seed.read_text())['meshes']
    skin = material('Preview skin (game atlas retained at runtime)', (.45, .24, .14), .74)
    glove = material('Preview glove (game atlas retained at runtime)', (.075, .085, .069), .82)
    cloth = material('Preview sleeve (game fabric retained at runtime)', (.060, .068, .054), .88)
    changes = []
    for slot, seed in enumerate(meshes):
        name = seed['key']
        is_hand = name not in ['sleeve', 'cuff']
        base = list(zip(*[iter(seed['attributes']['position'])] * 3))
        refine = refine_hand if is_hand else lambda point: refine_arm(point, name == 'cuff')
        vertices = [refine(point) for point in base]
        faces = list(zip(*[iter(seed['index'])] * 3))
        mesh = bpy.data.meshes.new(name + '-surface')
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj['hand_pack_key'] = name
        obj['source'] = 'Original Blender sculpt refinement of the game hand topology'
        obj['coordinate_system'] = 'metres; dorsal +Y, fingertips -Z; right thumb -X'
        obj['topology_contract'] = 'Keep mesh vertex order, triangular faces, UV/color atlas islands, Basis and Clench shape keys'
        obj.location = ((slot % 4) * .15, (slot // 4) * .22, 0)
        if not is_hand:
            obj.location = ((slot - 8) * .15, .53, 0)
            obj.scale = (.035, .10, .035) if name == 'cuff' else (1, .15, 1)
        uv = mesh.uv_layers.new(name='HandAtlas' if is_hand else 'SleeveUV')
        for loop in mesh.loops:
            index = loop.vertex_index
            uv.data[loop.index].uv = seed['attributes']['uv'][index * 2:index * 2 + 2]
        if is_hand:
            colors = mesh.color_attributes.new(name='HandTint', type='FLOAT_COLOR', domain='POINT')
            for index, color in enumerate(colors.data):
                color.color = (*seed['attributes']['color'][index * 3:index * 3 + 3], 1)
            mesh.materials.append(skin)
            mesh.materials.append(glove)
            for face in mesh.polygons:
                face.material_index = 1 if seed['attributes']['uv'][face.vertices[0] * 2 + 1] > .5 else 0
            obj.shape_key_add(name='Basis')
            key = obj.shape_key_add(name='Clench')
            delta = list(zip(*[iter(seed['morph']['position'])] * 3))
            for index, point in enumerate(base):
                key.data[index].co = refine(tuple(axis + offset for axis, offset in zip(point, delta[index])))
            key.value = 0
            obj['grip_radius_m'] = -1 if seed['radius'] is None else seed['radius']
        else:
            mesh.materials.append(cloth)
        for face in mesh.polygons:
            face.use_smooth = True
        mesh.normals_split_custom_set_from_vertices(normals(vertices, faces))
        movement = [(Vector(a) - Vector(b)).length for a, b in zip(vertices, base)]
        changes.append({'key': name, 'vertices': len(base), 'triangles': len(faces),
                        'movedVertices': sum(distance > 1e-7 for distance in movement),
                        'maximumRefinementM': max(movement)})
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1
    bpy.context.scene['hand_pack_refinements'] = json.dumps(changes)
    bpy.context.scene['hand_pack_readme'] = 'Edit local mesh vertices and Clench key. Object transforms arrange a review sheet only and are excluded from export. Runtime retains existing hand/glove/sleeve material atlas.'
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
    return changes


def export_pack(changes):
    payload = bytearray()
    buffers = []
    dedupe = {}

    def append(values, kind='f32', scale=None):
        if kind == 'f32':
            encoded = struct.pack('<' + 'f' * len(values), *values)
        else:
            maximum = 32767 if kind == 'i16' else 65535 if kind == 'u16' else 255
            minimum = -32767 if kind == 'i16' else 0
            integers = [max(minimum, min(maximum, round(value / scale))) if scale else int(value) for value in values]
            encoded = struct.pack('<' + {'i16': 'h', 'u16': 'H', 'u8': 'B'}[kind] * len(values), *integers)
        digest = (kind, scale, encoded)
        if digest in dedupe:
            return dedupe[digest]
        payload.extend(b'\0' * (-len(payload) % 4))
        item = {'type': kind, 'offset': len(payload), 'count': len(values)}
        if scale:
            item['scale'] = scale
        buffers.append(item)
        index = len(buffers) - 1
        dedupe[digest] = index
        payload.extend(encoded)
        return index

    meshes = []; runtime_meshes = []
    for obj in bpy.context.scene.objects:
        if not obj.get('hand_pack_key') or obj.get('sculpt_master'):
            continue
        mesh = obj.data
        key = obj['hand_pack_key']
        faces = [list(face.vertices) for face in mesh.polygons]
        if any(len(face) != 3 for face in faces):
            raise ValueError('Hand pack must preserve the triangular production topology')
        points = [tuple(vertex.co) for vertex in mesh.vertices]
        if mesh.shape_keys:
            points = [tuple(point.co) for point in mesh.shape_keys.key_blocks['Basis'].data]
        source_points = points
        source_faces = faces
        source_normals = normals(points, faces)
        mapping = {}; points = []; faces = []; uv_values = []; source_ids = []
        for polygon in mesh.polygons:
            triangle = []
            for loop_index in polygon.loop_indices:
                loop = mesh.loops[loop_index]
                uv = tuple(mesh.uv_layers.active.data[loop_index].uv)
                identity = (loop.vertex_index, round(uv[0], 8), round(uv[1], 8))
                if identity not in mapping:
                    mapping[identity] = len(points)
                    points.append(source_points[loop.vertex_index]); source_ids.append(loop.vertex_index); uv_values.append(uv)
                triangle.append(mapping[identity])
            faces.append(triangle)
        base_normals = [source_normals[index] for index in source_ids]
        flatten = lambda vectors: [axis for vector in vectors for axis in vector]
        attributes = {
            'position': append(flatten(points)),
            'normal': append(flatten(base_normals), 'i16', 1 / 32767),
            'uv': append(flatten(uv_values)),
        }
        result = {'key': key, 'attributes': attributes, 'index': append(flatten(faces), 'u16')}
        if mesh.shape_keys:
            colors = [tuple(mesh.color_attributes['HandTint'].data[index].color[:3]) for index in source_ids]
            # Keep float color values: they are already compact, shared and must
            # not alter the established hand material finish.
            attributes['color'] = append(flatten(colors))
            source_target = [tuple(point.co) for point in mesh.shape_keys.key_blocks['Clench'].data]
            source_target_normals = normals(source_target, source_faces)
            target = [source_target[index] for index in source_ids]
            target_normals = [source_target_normals[index] for index in source_ids]
            result['morph'] = {
                'position': append(flatten([Vector(b) - Vector(a) for a, b in zip(points, target)]), 'i16', 1e-7),
                'normal': append(flatten([Vector(b) - Vector(a) for a, b in zip(base_normals, target_normals)]), 'i16', 2 / 32767),
            }
        limit = 3200 if mesh.shape_keys else 750 if key == 'sleeve' else 350
        if len(points) > 3000 or len(faces) > limit: raise ValueError('Edited GAME mesh exceeds the existing runtime topology budget: '+key)
        runtime_meshes.append({'key':key,'vertices':len(points),'triangles':len(faces),'shapeKeys':['Basis','Clench'] if mesh.shape_keys else []})
        meshes.append(result)
    meshes.sort(key=lambda mesh: mesh['key'])
    header = json.dumps({'version': 2 if bpy.context.scene.get('hand_fidelity_version') == 2 else 1, 'meshes': meshes, 'buffers': buffers}, separators=(',', ':')).encode()
    header += b' ' * (-len(header) % 4)
    binary = b'HND1' + struct.pack('<I', len(header)) + header + payload
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'hands.bin').write_bytes(binary)
    manifest = {'version': 2 if bpy.context.scene.get('hand_fidelity_version') == 2 else 1, 'source': 'assets/blender/hands.blend', 'generator': 'tools/blender/build-hands.py',
                'format': 'HND1 geometry pack with atomic Blender-baked finish', 'blender': bpy.app.version_string,
                'bytes': len(binary), 'sha256': hashlib.sha256(binary).hexdigest(),
                'rightHandVariants': RADII, 'sharedArmMeshes': ['sleeve', 'cuff'],
                'textures': 3 if bpy.context.scene.get('hand_fidelity_version') == 2 else 0, 'materials': 0, 'extraDrawCalls': 0,
                'refinements': changes, 'runtimeMeshes': sorted(runtime_meshes,key=lambda item:item['key']), 'uniqueBuffers': len(buffers),
                'quantization': {'positions': 'float32 metres', 'normals': 'signed16 renormalized at load',
                                 'clenchPositions': 'signed16, 0.1 micrometre step', 'clenchNormals': 'signed16, 2/32767 step',
                                 'uv': 'float32; anatomical finger/thumb/wrist/palm/glove islands with padded material bands'}}
    if bpy.context.scene.get('hand_fidelity_version') == 2:
        manifest['revision'] = 'hands-sculpt-v2'
        manifest['bake'] = json.loads(bpy.context.scene.get('hand_bake_manifest', '{}'))
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2),flush=True)


def fidelity_module():
    path = ROOT / 'tools/blender/hand-fidelity-sculpt.py'
    spec = importlib.util.spec_from_file_location('hand_fidelity_sculpt', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def upgrade_scene():
    if bpy.context.scene.get('hand_fidelity_version') == 2:
        raise ValueError('This source is already sculpt v2; export it or edit its GAME/SCULPT meshes directly')
    design = fidelity_module()
    with tempfile.TemporaryDirectory(prefix='blender-hand-semantics-') as temporary:
        path = Path(temporary) / 'semantics.json'
        subprocess.run([shutil.which('node') or 'node', str(ROOT / 'tools/blender/export-hands-semantics.mjs'), str(path)], check=True, cwd=ROOT)
        semantics = {item['key']: item['vertices'] for item in json.loads(path.read_text())}
    changes = []
    for obj in list(bpy.context.scene.objects):
        key = obj.get('hand_pack_key')
        if not key: continue
        obj.name = 'GAME_' + key; mesh = obj.data
        previous = [tuple(point.co) for point in mesh.vertices]
        if key in ['sleeve', 'cuff']:
            vertices = [design.sculpt_sleeve(point, key == 'cuff') for point in previous]
            for vertex, point in zip(mesh.vertices, vertices): vertex.co = point
        else:
            info = semantics[key]
            if len(info) != len(previous): raise ValueError('Accepted source topology no longer matches semantic migration')
            radius = None if key == 'fist' else int(key[-3:]) / 1000
            basis = mesh.shape_keys.key_blocks['Basis']; clench = mesh.shape_keys.key_blocks['Clench']
            previous = [tuple(point.co) for point in basis.data]
            vertices = design.sculpt_hand(previous, info, radius)
            # The morph displacement is transferred unchanged to the remodeled
            # outer shell, so tightening can never alter grip endpoints or seams.
            target = [tuple(Vector(point.co) + Vector(new) - Vector(old)) for point,new,old in zip(clench.data,vertices,previous)]
            for point, vertex in zip(basis.data, vertices): point.co = vertex
            for point, vertex in zip(clench.data, target): point.co = vertex
            for point, vertex in zip(mesh.vertices, vertices): point.co = vertex
            old_uv = [tuple(loop.uv) for loop in mesh.uv_layers.active.data]
            region = mesh.attributes.new('bake_region', 'INT', 'FACE')
            for polygon in mesh.polygons:
                ids = list(polygon.vertices)
                web = all(info[i]['part']=='palm' and abs(previous[i][2]+.032)<1e-6 for i in ids)
                uv = [design.semantic_uv(info[mesh.loops[l].vertex_index], previous[mesh.loops[l].vertex_index], old_uv[l], web) for l in polygon.loop_indices]
                area=(uv[1][0]-uv[0][0])*(uv[2][1]-uv[0][1])-(uv[1][1]-uv[0][1])*(uv[2][0]-uv[0][0])
                if abs(area)<1e-10:
                    # Small triangulation caps have their own plain skin/web
                    # island; no unrelated nail or panel crosses the cap.
                    a,b,c=[Vector(previous[i]) for i in ids]; n=(b-a).cross(c-a)
                    axis=max(range(3),key=lambda i:abs(n[i])); axes=[i for i in range(3) if i!=axis]
                    skin=old_uv[polygon.loop_start][1]<.5
                    uv=[((.683 if skin else .738)+.023*(.5+p[axes[0]]/.25),(.20 if skin else .554)+(.22 if skin else .037)*(.5+p[axes[1]]/.25)) for p in [a,b,c]]
                for loop_index, coord in zip(polygon.loop_indices, uv): mesh.uv_layers.active.data[loop_index].uv=coord
                region.data[polygon.index].value = int(all(info[i]['part'] in ['palm','index','thumb'] for i in ids))
            obj['semantic_uv'] = 'skin: index/digit strip, thumb strip, wrist; glove: palm, digit binding, plain webs'
            obj['finish'] = 'blender-baked-v2'
        for polygon in mesh.polygons: polygon.use_smooth=True
        mesh.normals_split_custom_set_from_vertices(normals(vertices,[list(p.vertices) for p in mesh.polygons]))
        obj['source']='Authored anatomy sculpt from the accepted Blender hand, with transferred grip/clench correspondence'
        obj['topology_contract']='Edit GAME Basis and Clench together; loop UVs may split at export; wrist/contact envelope and triangle budget stay fixed'
        distance=[(Vector(a)-Vector(b)).length for a,b in zip(vertices,previous)]
        changes.append({'key':key,'vertices':len(vertices),'triangles':len(mesh.polygons),'movedVertices':sum(d>1e-7 for d in distance),'maximumRefinementM':max(distance)})
    bpy.context.scene['hand_fidelity_version']=2
    bpy.context.scene['hand_pack_refinements']=json.dumps(changes)
    bpy.context.scene['hand_pack_readme']='GAME meshes are final production silhouettes and editable Basis/Clench keys. SCULPT meshes are dense anatomical/material masters for actual selected-to-active baking. --export-only preserves manual geometry and packed image edits; --bake rebakes the saved masters. --upgrade is a one-time explicit v1 migration, never part of export.'
    create_sculpt_masters()
    return changes


def dense_sculpt(source, name, canonical=False):
    import bmesh
    design = fidelity_module()
    obj=bpy.data.objects.new(name,source.data.copy()); bpy.context.collection.objects.link(obj)
    # Remove shape keys on copies, leaving source morph correspondence intact.
    obj.shape_key_clear(); obj['sculpt_master']=True
    if obj.get('hand_pack_key'): del obj['hand_pack_key']
    bm=bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-8)
    bm.to_mesh(obj.data); bm.free(); obj.data.update()
    bpy.context.view_layer.objects.active=obj; obj.select_set(True)
    modifier=obj.modifiers.new('Dense sculpt sampling','SUBSURF'); modifier.subdivision_type='CATMULL_CLARK'; modifier.levels=3
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    mesh=obj.data
    uv_by_vertex={}
    for loop in mesh.loops: uv_by_vertex.setdefault(loop.vertex_index,tuple(mesh.uv_layers.active.data[loop.index].uv))
    color=mesh.color_attributes.new(name='SculptAlbedo',type='FLOAT_COLOR',domain='POINT')
    rough=mesh.color_attributes.new(name='SculptRoughness',type='FLOAT_COLOR',domain='POINT')
    displacements=[]
    cached_normals=array('f',[0])*(len(mesh.vertices)*3)
    mesh.vertices.foreach_get('normal',cached_normals)
    print('Sculpting',name,len(mesh.vertices),'vertices',flush=True)
    for vertex in mesh.vertices:
        uv=uv_by_vertex.get(vertex.index,(.80,.08)); height,tint,roughness=design.surface_details(*uv)
        if source.get('hand_pack_key') in ['sleeve','cuff']:
            height=0; tint=(.027,.035,.029); roughness=.91
        displacements.append(Vector(cached_normals[vertex.index*3:vertex.index*3+3])*height)
        color.data[vertex.index].color=(*tint,1)
        rough.data[vertex.index].color=(roughness,roughness,roughness,1)
    for vertex,displacement in zip(mesh.vertices,displacements): vertex.co+=displacement
    for face in mesh.polygons: face.use_smooth=True
    obj.data.update()
    mesh.normals_split_custom_set_from_vertices([(0,0,0)] * len(mesh.vertices))
    obj.select_set(False)
    obj['sculpt_features']='Keratin nail plates, cuticle rims, finger pad creases, knuckle folds, glove leather panel, seam channels and stitch relief'
    return obj


def sculpt_material(name, attribute):
    mat=bpy.data.materials.new(name); mat.use_nodes=True
    tree=mat.node_tree; tree.nodes.clear()
    out=tree.nodes.new('ShaderNodeOutputMaterial'); emit=tree.nodes.new('ShaderNodeEmission'); attr=tree.nodes.new('ShaderNodeVertexColor'); attr.layer_name=attribute
    tree.links.new(attr.outputs['Color'],emit.inputs['Color']); tree.links.new(emit.outputs[0],out.inputs['Surface'])
    return mat


def create_sculpt_masters():
    bpy.ops.object.select_all(action='DESELECT')
    for key in ['fist','grip-030','sleeve']:
        source=next(obj for obj in bpy.context.scene.objects if obj.get('hand_pack_key')==key)
        obj=dense_sculpt(source,'SCULPT_'+key)
        obj.location=source.location+Vector((0,.95,0)); obj.scale=source.scale
        obj.hide_set(True); obj.hide_render=True
    source=next(obj for obj in bpy.context.scene.objects if obj.get('hand_pack_key')=='fist')
    obj=dense_sculpt(source,'SCULPT_Atlas_Master',canonical=True)
    obj['bake_source']=True; obj.hide_set(True); obj.hide_render=True


def isolated_bake_copy(source,name,canonical=False):
    """Separate semantic UV islands in 3D so nearby thumb/palm surfaces cannot
    cross-project during the bake. Normals remain those of the intact sculpt."""
    mesh=source.data; uv_layer=mesh.uv_layers.active
    cached=array('f',[0])*(len(mesh.vertices)*3); mesh.vertices.foreach_get('normal',cached)
    colors={attribute.name:[tuple(item.color) for item in attribute.data] for attribute in mesh.color_attributes if attribute.domain=='POINT'}
    positions=[]; uv=[]; normals_out=[]; ids=[]; faces=[]; mapping={}
    region=mesh.attributes.get('bake_region')
    for face in mesh.polygons:
        if canonical and region and not region.data[face.index].value: continue
        coords=[tuple(uv_layer.data[index].uv) for index in face.loop_indices]
        u=sum(point[0] for point in coords)/len(coords); v=sum(point[1] for point in coords)/len(coords)
        tile=(0 if u<.678 else 1 if u<.72 else 2 if v<.16 else 3) if v<.5 else (4 if u<.70 else 5 if v<.62 else 6 if u<.845 else 7)
        triangle=[]
        for loop_index,coord in zip(face.loop_indices,coords):
            vertex_id=mesh.loops[loop_index].vertex_index
            key=(tile,vertex_id,round(coord[0],8),round(coord[1],8))
            if key not in mapping:
                mapping[key]=len(positions); positions.append(tuple(mesh.vertices[vertex_id].co+Vector((tile*.5,0,0)))); uv.append(coord); ids.append(vertex_id)
                normals_out.append(tuple(cached[vertex_id*3:vertex_id*3+3]))
            triangle.append(mapping[key])
        faces.append(triangle)
    output=bpy.data.meshes.new(name); output.from_pydata(positions,[],faces); output.update()
    layer=output.uv_layers.new(name='HandAtlas')
    for loop in output.loops: layer.data[loop.index].uv=uv[loop.vertex_index]
    for name,values in colors.items():
        attribute=output.color_attributes.new(name=name,type='FLOAT_COLOR',domain='POINT')
        for index,item in enumerate(attribute.data): item.color=values[ids[index]]
    for face in output.polygons: face.use_smooth=True
    output.normals_split_custom_set_from_vertices(normals_out)
    obj=bpy.data.objects.new(name,output); bpy.context.collection.objects.link(obj)
    return obj


def bake_finish(suffixes=('normal', 'albedo', 'roughness')):
    import bmesh
    if tuple(suffixes) not in [('normal', 'albedo', 'roughness'), ('albedo', 'roughness')]:
        raise ValueError('Hand baking supports the complete finish or color/roughness together')
    previous_manifest=json.loads(bpy.context.scene.get('hand_bake_manifest', '{}'))
    preserved_images={item['file']:item for item in previous_manifest.get('textures', [])}
    if 'normal' not in suffixes:
        normal=bpy.data.images.get('hand-normal')
        if normal is None or tuple(normal.size)!=(512,512) or normal.is_dirty or not normal.packed_file:
            raise ValueError('Color-only baking requires the saved, unmodified packed sculpt normal')
    source=next(obj for obj in bpy.context.scene.objects if obj.get('hand_pack_key')=='fist')
    high=bpy.data.objects.get('SCULPT_Atlas_Master')
    if high is None: raise ValueError('Saved Blender source is missing the editable SCULPT_Atlas_Master')
    low=bpy.data.objects.new('BAKE_TEMP_Game_Atlas',source.data.copy()); bpy.context.collection.objects.link(low); low.shape_key_clear()
    bm=bmesh.new(); bm.from_mesh(low.data); layer=bm.faces.layers.int.get('bake_region')
    bmesh.ops.delete(bm,geom=[face for face in bm.faces if layer and not face[layer]],context='FACES'); bm.to_mesh(low.data); bm.free(); low.data.update()
    for obj in bpy.context.scene.objects: obj.select_set(False); obj.hide_render=True
    low.hide_render=False; high.hide_render=False; high.hide_set(False)
    high.location=(0,0,0); low.location=(0,0,0)
    original_high=high
    depsgraph=bpy.context.evaluated_depsgraph_get()
    evaluated_mesh=bpy.data.meshes.new_from_object(high.evaluated_get(depsgraph),preserve_all_data_layers=True,depsgraph=depsgraph)
    evaluated_source=bpy.data.objects.new('BAKE_TEMP_Evaluated_Master',evaluated_mesh)
    bpy.context.collection.objects.link(evaluated_source)
    high=isolated_bake_copy(evaluated_source,'BAKE_TEMP_Isolated_Sculpt',canonical=True)
    bpy.data.objects.remove(evaluated_source,do_unlink=True)
    bpy.data.meshes.remove(evaluated_mesh)
    original_low=low
    low=isolated_bake_copy(low,'BAKE_TEMP_Isolated_Game')
    bpy.data.objects.remove(original_low,do_unlink=True)
    original_high.hide_render=True; original_high.hide_set(True)
    high.hide_render=False; high.hide_set(False); low.hide_render=False
    high_materials=list(high.data.materials)
    high.data.materials.clear(); high.data.materials.append(sculpt_material('BAKE_Sculpt_Albedo','SculptAlbedo'))
    for face in high.data.polygons: face.material_index=0
    material=bpy.data.materials.new('BAKE_Target'); material.use_nodes=True
    low.data.materials.clear(); low.data.materials.append(material)
    for face in low.data.polygons: face.material_index=0
    print('Baking hand atlas',len(high.data.polygons),'source faces',flush=True)
    scene=bpy.context.scene; scene.render.engine='CYCLES'; scene.cycles.device='CPU'; scene.cycles.samples=16
    scene.render.bake.use_selected_to_active=True; scene.render.bake.cage_extrusion=.004; scene.render.bake.max_ray_distance=.008
    scene.render.bake.margin=8; scene.render.bake.normal_space='TANGENT'; scene.render.bake.use_clear=True
    low.select_set(True); high.select_set(True); bpy.context.view_layer.objects.active=low
    images=[]
    for suffix,bake_type in [('normal','NORMAL'),('albedo','EMIT'),('roughness','EMIT')]:
        if suffix not in suffixes: continue
        image=bpy.data.images.get('hand-'+suffix)
        if image: bpy.data.images.remove(image)
        image=bpy.data.images.new('hand-'+suffix,width=512,height=512,alpha=False)
        image.colorspace_settings.name='sRGB' if suffix=='albedo' else 'Non-Color'
        if suffix=='normal': image.generated_color=(.5,.5,1,1)
        node=material.node_tree.nodes.new('ShaderNodeTexImage'); node.image=image; material.node_tree.nodes.active=node
        if suffix=='roughness':
            high.data.materials.clear(); high.data.materials.append(sculpt_material('BAKE_Sculpt_Roughness','SculptRoughness'))
        bpy.ops.object.bake(type=bake_type)
        image.filepath_raw=str(OUTPUT / ('hand-'+suffix+'.png')); image.file_format='PNG'; image.save()
        encoded=Path(image.filepath_raw).read_bytes()
        image.pack(data=encoded,data_len=len(encoded))
        images.append({'file':Path(image.filepath_raw).name,'width':512,'height':512,'bytes':len(encoded),'sha256':hashlib.sha256(encoded).hexdigest(),'colorSpace':'sRGB' if suffix=='albedo' else 'linear'})
    high.hide_set(True); high.hide_render=True; high.select_set(False)
    bpy.data.objects.remove(low,do_unlink=True)
    for obj in bpy.context.scene.objects:
        if obj.get('hand_pack_key'): obj.hide_render=False
    current_images={item['file']:item for item in images}
    images=[current_images.get('hand-'+suffix+'.png',preserved_images.get('hand-'+suffix+'.png')) for suffix in ['normal','albedo','roughness']]
    if any(item is None for item in images): raise ValueError('The hand bake must retain all three finish maps')
    manifest={**previous_manifest,'method':'Blender Cycles selected-to-active tangent-space NORMAL and EMIT albedo/roughness from editable dense SCULPT_Atlas_Master',
              'sourceObject':'SCULPT_Atlas_Master','sourceTriangles':sum(len(face.vertices)-2 for face in original_high.data.polygons),'bakedTriangles':sum(len(face.vertices)-2 for face in high.data.polygons),'atlasCanonicalGame':'GAME_fist; separate index/thumb/wrist/palm/binding/web islands exploded in 3D during baking to exclude self cross-projection; shared semantic coordinates on all grips',
              'size':512,'textures':images,'normalConvention':'OpenGL +Y; TextureLoader flipY=true','estimatedRuntimeBytesWithMipmaps':4194304,'extraDrawCalls':0,
              'features':['nail plate and cuticle geometry','flexion folds and skin relief','glove panel depth, seams and stitch relief']}
    manifest['lastBakeMaps']=list(suffixes)
    if bpy.context.scene.get('hand_material_provenance'):
        manifest['generatedMaterials']=json.loads(bpy.context.scene['hand_material_provenance'])
    bpy.data.objects.remove(high,do_unlink=True)
    bpy.context.scene['hand_bake_manifest']=json.dumps(manifest)
    return manifest


def export_packed_finish(force_save=False, suffixes=None):
    """Publish saved image edits along with mesh edits, and refresh provenance."""
    OUTPUT.mkdir(parents=True,exist_ok=True)
    manifest=json.loads(bpy.context.scene.get('hand_bake_manifest','{}'))
    textures=[]
    for suffix in ['normal','albedo','roughness']:
        image=bpy.data.images.get('hand-'+suffix)
        if image is None or tuple(image.size)!=(512,512): raise ValueError('Saved hand source is missing its 512px '+suffix+' image')
        destination=OUTPUT/('hand-'+suffix+'.png')
        save_current=force_save and (suffixes is None or suffix in suffixes)
        if image.packed_file and not image.is_dirty and not save_current:
            # Preserve exact source PNG bytes when no painting changed them;
            # a decode/re-encode cycle can alter metadata and color rounding.
            encoded=bytes(image.packed_file.data); destination.write_bytes(encoded)
        else:
            image.filepath_raw=str(destination); image.file_format='PNG'; image.save()
            encoded=destination.read_bytes()
            # Calling pack() without explicit bytes can retain an older packed
            # payload even after image.pixels changed; publish exactly this PNG.
            image.pack(data=encoded,data_len=len(encoded))
            destination.write_bytes(encoded)
        image.filepath_raw=str(destination)
        textures.append({'file':Path(image.filepath_raw).name,'width':512,'height':512,'bytes':len(encoded),
                         'sha256':hashlib.sha256(encoded).hexdigest(),'colorSpace':'sRGB' if suffix=='albedo' else 'linear'})
    manifest['textures']=textures
    bpy.context.scene['hand_bake_manifest']=json.dumps(manifest)


def neutral_atlas_padding(suffixes=('normal', 'albedo', 'roughness')):
    """Fill uncovered ray/cap/seam padding with its plain material and a flat
    tangent normal. Detailed covered texels retain the actual sculpt bake."""
    design=fidelity_module(); corrected={}
    for suffix in suffixes:
        image=bpy.data.images['hand-'+suffix]; pixels=array('f',[0])*(512*512*4); image.pixels.foreach_get(pixels); changed=0
        for y in range(512):
            for x in range(512):
                i=(y*512+x)*4; r,g,b=pixels[i:i+3]
                if suffix=='normal':
                    length=(r*2-1)**2+(g*2-1)**2+(b*2-1)**2
                    invalid=length<.90**2 or length>1.10**2 or b<.52
                    if invalid: pixels[i:i+4]=array('f',[.5,.5,1,1]); changed+=1
                elif (suffix=='albedo' and r+g+b<1e-5) or (suffix=='roughness' and g<.35):
                    _,color,roughness=design.surface_details((x+.5)/512,(y+.5)/512)
                    value=(*color,1) if suffix=='albedo' else (max(.35,min(.98,roughness)),)*3+(1,)
                    pixels[i:i+4]=array('f',value); changed+=1
        image.pixels.foreach_set(pixels); image.update(); corrected[suffix]=changed
    manifest=json.loads(bpy.context.scene.get('hand_bake_manifest','{}'))
    manifest['neutralPaddingPixels']={**manifest.get('neutralPaddingPixels',{}),**corrected}
    manifest['padding']='Uncovered cap, seam and ray-miss texels use material-correct neutral color/roughness and flat tangent normals; covered anatomical detail remains the geometric bake'
    bpy.context.scene['hand_bake_manifest']=json.dumps(manifest)


def configure_review_source():
    """The saved source opens with its actual baked finish and named masters."""
    mat=bpy.data.materials.get('GAME_Baked_Skin_And_Glove') or bpy.data.materials.new('GAME_Baked_Skin_And_Glove')
    mat.use_nodes=True; tree=mat.node_tree; tree.nodes.clear()
    out=tree.nodes.new('ShaderNodeOutputMaterial'); shader=tree.nodes.new('ShaderNodeBsdfPrincipled')
    shader.inputs['Metallic'].default_value=0; shader.inputs['Roughness'].default_value=.75
    for suffix in ['albedo','normal','roughness']:
        image=bpy.data.images.get('hand-'+suffix)
        if not image: continue
        node=tree.nodes.new('ShaderNodeTexImage'); node.image=image
        if suffix=='normal':
            normal=tree.nodes.new('ShaderNodeNormalMap'); normal.space='TANGENT'
            tree.links.new(node.outputs['Color'],normal.inputs['Color']); tree.links.new(normal.outputs['Normal'],shader.inputs['Normal'])
        else: tree.links.new(node.outputs['Color'],shader.inputs['Base Color' if suffix=='albedo' else 'Roughness'])
    tree.links.new(shader.outputs['BSDF'],out.inputs['Surface'])
    for obj in bpy.context.scene.objects:
        key=obj.get('hand_pack_key')
        if key and key not in ['sleeve','cuff']:
            obj.data.materials.clear(); obj.data.materials.append(mat)
            for face in obj.data.polygons: face.material_index=0
        if obj.get('sculpt_master'): obj.hide_set(True); obj.hide_render=True
    readme=bpy.data.texts.get('README_HAND_SOURCE') or bpy.data.texts.new('README_HAND_SOURCE')
    readme.clear(); readme.write(bpy.context.scene['hand_pack_readme']+'\n\nGAME_ meshes retain editable Basis / Clench targets. Their object transforms only arrange the review sheet. SCULPT_Atlas_Master is the editable high-detail bake authority; SCULPT_fist and SCULPT_grip-030 are complete anatomy review masters. Export never recreates the masters. Atlas bake copies are exploded by semantic region so adjacent thumb/palm surfaces cannot cross-project.\n')
    bpy.ops.object.select_all(action='DESELECT')
    fist=bpy.data.objects.get('GAME_fist')
    if fist: fist.hide_set(False); fist.select_set(True); bpy.context.view_layer.objects.active=fist


arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument('--export-only', action='store_true')
parser.add_argument('--upgrade', action='store_true')
bake_options=parser.add_mutually_exclusive_group()
bake_options.add_argument('--bake', action='store_true')
bake_options.add_argument('--bake-color', action='store_true')
parser.add_argument('--seed', action='store_true', help='Explicit destructive rebuild of the procedural v1 seed; never needed for edited source export')
args = parser.parse_args(arguments)
if args.seed:
    changes=build_seed_scene()
else:
    if not any(obj.get('hand_pack_key') for obj in bpy.context.scene.objects):
        bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    changes=upgrade_scene() if args.upgrade else json.loads(bpy.context.scene.get('hand_pack_refinements','[]'))
if args.bake or args.bake_color or args.upgrade:
    suffixes=('albedo','roughness') if args.bake_color else ('normal','albedo','roughness')
    OUTPUT.mkdir(parents=True,exist_ok=True); bake_finish(suffixes); neutral_atlas_padding(suffixes); export_packed_finish(force_save=True,suffixes=suffixes)
if args.upgrade or args.bake or args.bake_color:
    configure_review_source()
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
if bpy.context.scene.get('hand_fidelity_version') == 2: export_packed_finish()
export_pack(changes)
