"""Author the original game's supplies/CRT in Blender and export static geometry.

From the repository: node tools/blender/export-supplies-source.mjs
Then: /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-supplies-props.py
Optional ``-- --render`` writes studio images; the source always includes a studio.
Only geometry is exported: game materials, labels, stock indicators and animation
remain owned by the game. The original input remains available for comparison.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/blender/supplies-props.blend'
INPUT = ROOT / 'assets/blender/supplies-props-source.json'
OUT = ROOT / 'public/assets/models/supplies-props'
REVIEW = ROOT / 'artifacts/blender-model-rollout-2026-09-04'
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--render', action='store_true')
options = parser.parse_args(args)
OUT.mkdir(parents=True, exist_ok=True)
REVIEW.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
source = json.loads(INPUT.read_text())
collections = {}
originals = bpy.data.collections.new('ORIGINAL INPUT • hidden reference')
scene.collection.children.link(originals)
originals.hide_render = True
originals.hide_viewport = True
materials = {}
parts = {name: {} for name in source['models']}

def g(point):
    x, y, z = point
    return (x, -z, y)

def game(point):
    return (point[0], point[2], -point[1])

def material(name, properties):
    if name in materials:
        return materials[name]
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*properties['color'], 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*properties['color'], 1)
    bsdf.inputs['Roughness'].default_value = properties['roughness']
    bsdf.inputs['Metallic'].default_value = properties['metalness']
    bsdf.inputs['Emission Color'].default_value = (*properties['emissive'], 1)
    bsdf.inputs['Emission Strength'].default_value = properties['emissiveIntensity']
    materials[name] = mat
    return mat

def mesh_object(model, name, vertices, faces, normals=None, label=None):
    mesh = bpy.data.meshes.new(label or name)
    mesh.from_pydata([g(p) for p in vertices], [], faces)
    mesh.update()
    if normals:
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        mesh.normals_split_custom_set([g(normals[loop.vertex_index]) for loop in mesh.loops])
    obj = bpy.data.objects.new(label or name, mesh)
    collections[model].objects.link(obj)
    mesh.materials.append(materials[name])
    obj['runtime_part'] = name
    obj['game_model'] = model
    parts[model].setdefault(name, []).append(obj)
    return obj

def source_data(part, omit=None, move=None):
    vertices = [part['positions'][i:i + 3] for i in range(0, len(part['positions']), 3)]
    normals = [part['normals'][i:i + 3] for i in range(0, len(part['normals']), 3)]
    indices = part.get('indices') or list(range(len(vertices)))
    faces = [indices[i:i + 3] for i in range(0, len(indices), 3)]
    if omit:
        faces = [face for face in faces if not omit([vertices[i] for i in face])]
    if move:
        vertices = [move(list(p)) for p in vertices]
    return vertices, faces, normals

for model, data in source['models'].items():
    collection = bpy.data.collections.new(model.upper() + ' • authored game geometry')
    scene.collection.children.link(collection)
    collections[model] = collection
    for part in data['parts']:
        material(part['name'], part['material'])
        v, f, n = source_data(part)
        reference = mesh_object(model, part['name'], v, f, n, 'ORIGINAL ' + model + ' ' + part['name'])
        parts[model][part['name']].remove(reference)
        collection.objects.unlink(reference)
        originals.objects.link(reference)

def box(model, name, center, size, label):
    x, y, z = center
    a, b, c = [v / 2 for v in size]
    vertices = [(x + sx * a, y + sy * b, z + sz * c)
                for sx, sy, sz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),
                                  (-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    return mesh_object(model, name, vertices, faces, label=label)

def outline(width, height, radius, segments=1):
    result = []
    for cx, cy, start in [(width/2-radius, -height/2+radius, -math.pi/2),
                          (width/2-radius, height/2-radius, 0),
                          (-width/2+radius, height/2-radius, math.pi/2),
                          (-width/2+radius, -height/2+radius, math.pi)]:
        for step in range(segments + 1):
            a = start + step / segments * math.pi/2
            result.append((cx + math.cos(a)*radius, cy + math.sin(a)*radius))
    return result

def loft_xy(model, name, layers, center, label, back=True, front=True):
    # Every XY ring is CCW when seen from the +Z side.
    vertices = [(x + center[0], y + center[1], z) for z,w,h,r in layers for x,y in outline(w,h,r)]
    count = 8
    faces = []
    for layer in range(len(layers)-1):
        for i in range(count):
            a = layer*count+i; b = layer*count+(i+1)%count
            faces.append((a,b,b+count,a+count))
    if back:
        faces.append(tuple(reversed(range(count))))
    if front:
        faces.append(tuple(range((len(layers)-1)*count, len(layers)*count)))
    return mesh_object(model, name, vertices, faces, label=label)

def loft_xz(model, name, layers, label):
    vertices = [(x,y,z) for y,w,d,r in layers for x,z in outline(w,d,r,2)]
    count = 12; faces = []
    for layer in range(len(layers)-1):
        for i in range(count):
            a=layer*count+i; b=layer*count+(i+1)%count
            faces.append((a,a+count,b+count,b))
    faces.append(tuple(range(count)))
    faces.append(tuple(reversed(range((len(layers)-1)*count, len(layers)*count))))
    obj = mesh_object(model, name, vertices, faces, label=label)
    # Preserve planar lids while blending the corner arcs and small molded
    # edge rolls. This is authored once; runtime needs no normal calculation.
    corner=[]
    for polygon in obj.data.polygons:
        polygon.use_smooth=True
        for vertex in polygon.vertices:
            if polygon.index >= (len(layers)-1)*count:
                corner.append(tuple(polygon.normal))
                continue
            level,index=divmod(vertex,count)
            corner_id,step=divmod(index,3)
            angle=-math.pi/2+corner_id*math.pi/2+step*math.pi/4
            vertical=-1 if level==0 else 1 if level==len(layers)-1 else 0
            normal=Vector((math.cos(angle),vertical,math.sin(angle))).normalized()
            corner.append(g(normal))
    obj.data.normals_split_custom_set(corner)
    return obj

# Health: retain rounded shell/handle, mold a shallow recessed lid and add
# inset ivory latch faces with actual dark release tabs. Badge roots enter the
# new cap while keeping the red mark's exact old height and approach visibility.
for part in source['models']['health']['parts']:
    def move(point):
        x,y,z=point
        if part['name']=='medical-case-shell' and abs(y-.047)<1e-6 and abs(x)<1e-6 and abs(z)<1e-6:
            point[1]=.045
        if part['name']=='medical-case-trim' and abs(abs(x)-.08)<.010 and y>-.002 and z>.085:
            point[2]-=.0015
        if part['name']=='medical-case-crosses' and abs(y-.0475)<1e-6:
            point[1]=.0448
        return point
    v,f,n=source_data(part,move=move)
    obj=mesh_object('health',part['name'],v,f,n)
    if part['name']=='medical-case-shell':
        # The newly recessed cap needs its actual sloping normals; retain the
        # original soft silhouette normals on every other surface.
        adjusted=[tuple(normal.vector) for normal in obj.data.corner_normals]
        for polygon in obj.data.polygons:
            if all(game(obj.data.vertices[i].co)[1] >= .0449 for i in polygon.vertices):
                for loop in polygon.loop_indices: adjusted[loop]=tuple(polygon.normal)
        obj.data.normals_split_custom_set(adjusted)
    obj['authored_change']='Molded recessed lid / seated badge / inset latch release'
for x in [-.08,.08]:
    box('health','medical-case-shell',(x,.009,.08935),(.011,.012,.0011),'Ivory latch inset')
    box('health','medical-case-trim',(x,.009,.08965),(.005,.003,.00065),'Dark recessed latch release')

# Armor: replace square front pouches with clipped corners and a 4 mm molded
# front chamfer. Omit only the pouch back faces buried inside the opaque fabric.
for part in source['models']['armor']['parts']:
    def pocket(face):
        return any(all(abs(p[0]-x)<=.066001 and -.272001<=p[1]<=-.167999 and .095999<=p[2]<=.138001 for p in face)
                   for x in [-.098,.098])
    v,f,n=source_data(part, omit=pocket if part['name']=='armor-vest-plates' else None)
    mesh_object('armor',part['name'],v,f,n)
for x in [-.098,.098]:
    loft_xy('armor','armor-vest-plates',[(.096,.132,.104,.009),(.134,.132,.104,.009),(.138,.124,.096,.007)],
            (x,-.220),'Chamfered plate carrier pouch',back=False)

# CRT: the closed shell/screen opening stays exact; tapered real vent rims
# provide a readable molded shoulder around the pre-existing recessed grilles.
for part in source['models']['crt']['parts']:
    v,f,n=source_data(part)
    mesh_object('crt',part['name'],v,f,n)
for x in [-.145,.145]:
    outer=outline(.262,.212,.008)
    inner=outline(.246,.196,.004)
    vertices=[(a+x,b-.025,z) for ring,z in [(outer,.242),(outer,.245),(inner,.248),(inner,.241)] for a,b in ring]
    faces=[]
    for layer in range(3):
        for i in range(8):
            a=layer*8+i; b=layer*8+(i+1)%8
            faces.append((a,b,b+8,a+8))
    # The ribbon turns toward its open center, giving correct front-facing normals.
    mesh_object('crt','crt-molded-housing',vertices,faces,label='Molded vent rim')

# Ammo: replace the tessellated scaled cube pair with purpose-made case/lid
# profiles. A rounded carry bar, recessed latch wells and rear pressed ribs all
# share the original three static materials. Labels and stock bar stay in game.
for part in source['models']['ammo']['parts']:
    if part['name']=='ammo-case-body-and-lid':
        continue
    if part['name']=='ammo-case-handle-and-latches':
        def removed(face):
            return all(p[2]>.139 for p in face) or all(p[1]>.3239 for p in face)
        v,f,n=source_data(part,omit=removed)
    else:
        v,f,n=source_data(part)
    mesh_object('ammo',part['name'],v,f,n)
loft_xz('ammo','ammo-case-body-and-lid',[(.024,.628,.268,.016),(.030,.640,.280,.022),(.264,.640,.280,.022),(.270,.628,.268,.016)],'Molded lower field case')
loft_xz('ammo','ammo-case-body-and-lid',[(.270,.650,.290,.013),(.274,.658,.298,.017),(.296,.658,.298,.017),(.300,.650,.290,.013)],'Molded lid chamfer')
for x in [-.22,-.08,.08,.22]:
    box('ammo','ammo-case-body-and-lid',(x,.150,-.1405),(.024,.156,.005),'Pressed rear reinforcing rib')
loft_xy('ammo','ammo-case-handle-and-latches',[(.064,.220,.016,.004),(.096,.220,.016,.004)],(0,.332),'Rounded carry grip')
for x in [-.2496,.2496]:
    # Outer/back shell plus a recessed dark well. The exact original extent
    # (+.168 front) remains on the rim; well floor is 3 mm below the rim.
    loft_xy('ammo','ammo-case-handle-and-latches',[(.140,.032,.085,.005),(.168,.032,.085,.005)],
            (x,.220),'Clipped latch rim',front=False)
    outer=outline(.032,.085,.005); inner=outline(.020,.060,.003)
    vertices=[(a+x,b+.220,z) for ring,z in [(outer,.168),(inner,.168),(inner,.165)] for a,b in ring]
    faces=[]
    for layer in range(2):
        for i in range(8):
            a=layer*8+i; b=layer*8+(i+1)%8
            faces.append((a,b,b+8,a+8))
    mesh_object('ammo','ammo-case-handle-and-latches',vertices,faces,label='Recessed latch shoulder')
    mesh_object('ammo','ammo-case-feet-and-seal',[(a+x,b+.220,.165) for a,b in inner],[tuple(range(8))],label='Dark latch well')

document={'version':1,'source':'blender-authored-original','models':{}}
metrics={}
for model, groups in parts.items():
    records=[]; triangle_count=0; byte_count=0
    for name, objects in groups.items():
        positions=[]; normals=[]; indices=[]; lookup={}
        for obj in objects:
            mesh=obj.data; mesh.calc_loop_triangles()
            corner_normals=mesh.corner_normals
            for triangle in mesh.loop_triangles:
                for loop in triangle.loops:
                    point=game(mesh.vertices[mesh.loops[loop].vertex_index].co)
                    normal=game(corner_normals[loop].vector)
                    p=tuple(round(v,8) for v in point); n=tuple(round(v,8) for v in normal)
                    if model in ['health','armor']:
                        positions.extend(p); normals.extend(n)
                    else:
                        key=p+n
                        if key not in lookup:
                            lookup[key]=len(positions)//3; positions.extend(p); normals.extend(n)
                        indices.append(lookup[key])
        record={'name':name,'positions':positions,'normals':normals}
        count=(len(indices) if indices else len(positions)//3)//3
        if indices:
            record['indices']=indices
        records.append(record); triangle_count+=count
        byte_count+=len(positions)*8+len(indices)*2
        if model=='crt': byte_count+=len(positions)//3*8
    document['models'][model]={'parts':records}
    metrics[model]={'triangles':triangle_count,'draws':len(records),'geometryBytes':byte_count,
                    'originalTriangles':sum(p['triangles'] for p in source['models'][model]['parts'])}
    if model=='ammo':
        metrics[model]['runtimeLabelAndIndicatorTriangles']=16
        metrics[model]['runtimeDraws']=5
budgets={'health':800,'armor':750,'crt':799,'ammo':708}
for model,maximum in budgets.items():
    if metrics[model]['triangles']>maximum: raise RuntimeError(f'{model} over budget: {metrics[model]}')
catalog_path=OUT/'catalog.json'
catalog_path.write_text(json.dumps(document,separators=(',',':'))+'\n')

# Source-only studio uses the same solid finishes; nothing from it is exported.
studio=bpy.data.collections.new('STUDIO • excluded from runtime')
scene.collection.children.link(studio)
world=bpy.data.worlds.new('Neutral studio')
scene.world=world; world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.12,.15,.18,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.45
def aim(obj,point):
    obj.rotation_euler=(Vector(g(point))-obj.location).to_track_quat('-Z','Y').to_euler()
for name,location,power,size in [('Key',(-2,3,-4),700,3),('Fill',(3,1,-2),350,3),('Rim',(0,3,3),850,2)]:
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
    light=bpy.data.objects.new(name,data);studio.objects.link(light);light.location=g(location);aim(light,(0,0,0))
data=bpy.data.cameras.new('Supply review camera');camera=bpy.data.objects.new('Supply review camera',data)
studio.objects.link(camera);scene.camera=camera;data.type='ORTHO'
camera.location=g((.9,.65,1.5));aim(camera,(0,0,0));data.ortho_scale=.8
scene.render.engine='CYCLES';scene.cycles.samples=32
scene.render.resolution_x=1000;scene.render.resolution_y=800;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
for model,collection in collections.items():
    collection.hide_viewport=model!='health'
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
manifest={'version':1,'source':'original project meshes refined in Blender','blenderVersion':bpy.app.version_string,
          'sourceFile':'assets/blender/supplies-props.blend','sourceInput':'assets/blender/supplies-props-source.json',
          'catalog':'catalog.json','bytes':catalog_path.stat().st_size,'sha256':hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
          'textures':0,'metrics':metrics,'authoredChanges':{
              'health':['Shallow molded lid recess; badge seats below cap','Inset ivory latch faces and dark release tabs'],
              'armor':['Clipped corners and front chamfer on both carrier pouches; hidden pouch backs omitted'],
              'crt':['Two tapered molded vent rims; original opaque shell and glass aperture retained'],
              'ammo':['Purpose-made rounded body/lid profiles replace subdivided boxes','Pressed rear ribs, rounded carry grip, recessed latch wells']},
          'runtimeOwnership':'Original game materials, labels, stock indicator, shadows and transforms are retained.'}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
if options.render:
    for model in collections:
        for name,collection in collections.items():
            collection.hide_render=name!=model
            collection.hide_viewport=name!=model
        scale={'health':.36,'armor':1.03,'crt':1.38,'ammo':.88}[model]
        center=(0,.14,0) if model=='ammo' else (0,0,0)
        camera.location=g((scale*.9,scale*.7,scale*1.5 if model!='crt' else -scale*1.5))
        aim(camera,center);data.ortho_scale=scale
        scene.render.filepath=str(REVIEW/(model+'-studio.png'))
        bpy.ops.render.render(write_still=True)
        if model=='crt':
            camera.location=g((scale*.9,scale*.55,scale*1.5));aim(camera,center)
            scene.render.filepath=str(REVIEW/'crt-rear-studio.png')
            bpy.ops.render.render(write_still=True)
