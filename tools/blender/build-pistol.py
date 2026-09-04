"""Rebuild the original H9 pistol pilot in Blender, with no downloaded assets.

Run from the repository root:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-pistol.py
Append ``-- --skip-render`` to rebuild the source/GLB without studio images.

Game coordinates are metres: +X muzzle, +Y up, +Z right. ``g`` converts into
Blender Z-up coordinates; glTF's normal Y-up conversion restores game axes.
The source retains named editable mesh parts; the GLB exports three finish
groups using shared, packed, original 256 px finish maps. Studio is not exported.
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
OUT = ROOT / 'public/assets/models/pistol'
SOURCE = ROOT / 'assets/blender/pistol.blend'
SOURCE_TEXTURES = ROOT / 'assets/blender/pistol-textures'
REVIEW = ROOT / 'artifacts/blender-pistol-2026-09-04'
arguments = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--skip-render', action='store_true', help='Export without rendering studio review images')
options = parser.parse_args(arguments)
for directory in (OUT, SOURCE.parent, SOURCE_TEXTURES, REVIEW):
    directory.mkdir(parents=True, exist_ok=True)

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
asset_collection = bpy.data.collections.new('H9 • original game asset')
scene.collection.children.link(asset_collection)
studio_collection = bpy.data.collections.new('STUDIO • excluded from export')
scene.collection.children.link(studio_collection)


def g(point):
    x, y, z = point
    return (x, -z, y)


def game(point):
    return (point[0], point[2], -point[1])


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def mesh_obj(name, vertices, faces, material=None, recalc=True):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([g(p) for p in vertices], [], faces)
    mesh.update()
    # The helpers prioritize legible profile order. Recalculate outward winding
    # once, including tubes/holes; this also catches negative game-to-Blender Y.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    asset_collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
    return obj


def bevel(obj, width=.0007, segments=1):
    activate(obj)
    mod = obj.modifiers.new('Machined edge breaks', 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(24)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def weighted_normals(obj):
    # Smooth curved transitions while the normal modifier preserves broad flats.
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    activate(obj)
    mod = obj.modifiers.new('Area-weighted machined normals', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.weight = 50
    bpy.ops.object.modifier_apply(modifier=mod.name)


def prism(name, outline, width, material=None, z=0, edge=.0007):
    n = len(outline)
    vertices = [(x, y, z - width / 2) for x, y in outline]
    vertices += [(x, y, z + width / 2) for x, y in outline]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    obj = mesh_obj(name, vertices, faces, material)
    if edge:
        bevel(obj, edge)
    return obj


def box(name, center, dimensions, material=None, edge=.0005):
    x, y, z = center
    a, b, c = [dimension / 2 for dimension in dimensions]
    return prism(name, [(x-a, y-b), (x+a, y-b), (x+a, y+b), (x-a, y+b)], c*2,
                 material, z=z, edge=edge)


def difference(obj, cutter):
    activate(obj)
    modifier = obj.modifiers.new('Authored cut: ' + cutter.name, 'BOOLEAN')
    modifier.operation = 'DIFFERENCE'
    modifier.solver = 'EXACT'
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def loft_x(name, sections, material, cap=True):
    # Each tuple contains X and the Y/Z cross section. Its intentional chamfer
    # topology spends polygons on crown planes, not uniform subdivision.
    rings = [section[1] for section in sections]
    n = len(rings[0])
    vertices = [(x, y, z) for x, ring in sections for y, z in ring]
    faces = []
    for j in range(len(rings)-1):
        for i in range(n):
            a, b = j*n+i, j*n+(i+1)%n
            faces.append((a,b,b+n,a+n))
    if cap:
        faces.extend([tuple(range(n-1,-1,-1)), tuple((len(rings)-1)*n+i for i in range(n))])
    return mesh_obj(name, vertices, faces, material)


def tube(name, x1, x2, y, radius, bore, material, segments=24):
    # Crown, bevel, exterior and interior form one closed annular surface.
    profile = [(x1, radius*.985), (x2-.0012, radius), (x2, radius-.0008),
               (x2, bore+.00065), (x2-.0012, bore), (x1, bore)]
    vertices = []
    for x, r in profile:
        vertices += [(x, y+math.cos(i*math.tau/segments)*r,
                      math.sin(i*math.tau/segments)*r) for i in range(segments)]
    faces = []
    for j in range(len(profile)):
        for i in range(segments):
            faces.append((j*segments+i, j*segments+(i+1)%segments,
                          ((j+1)%len(profile))*segments+(i+1)%segments,
                          ((j+1)%len(profile))*segments+i))
    return mesh_obj(name, vertices, faces, material)


def ring_profile(name, outer, inner, width, material):
    n = len(outer)
    assert n == len(inner)
    verts = [(x,y,z) for z in [-width/2,width/2] for loop in [outer,inner] for x,y in loop]
    faces=[]
    for i in range(n):
        j=(i+1)%n
        faces.extend([(i,j,j+n,i+n), (i+2*n,i+3*n,j+3*n,j+2*n),
                      (i,i+2*n,j+2*n,j), (i+n,j+n,j+3*n,i+3*n)])
    return bevel(mesh_obj(name,verts,faces,material), .00065)


def finish_image(name, pixels, colorspace):
    height, width = pixels.shape[:2]
    image = bpy.data.images.new(name,width=width,height=height,alpha=True)
    image.colorspace_settings.name = colorspace
    image.pixels.foreach_set(pixels.astype(np.float32).ravel())
    image.filepath_raw = str(SOURCE_TEXTURES / (name+'.png'))
    image.file_format = 'PNG'
    image.save()
    image.pack()
    return image


def finish_maps(kind, seed):
    # This is original authored finish data, not photo sourcing or AI imagery.
    # A 256 px repeat covers 8 cm on metal and 6 cm on polymer. The maps encode
    # only finish/microrelief, with no painted highlights or directional light.
    n=256
    rng=np.random.default_rng(seed)
    yy,xx=np.mgrid[0:n,0:n]
    u,v=xx/n,yy/n
    random=rng.random((n,n))-.5
    broad=(np.sin(u*math.tau*3+np.sin(v*math.tau*2))+
           np.cos(v*math.tau*5+np.sin(u*math.tau)))/2
    if kind=='steel':
        grain=np.sin(v*math.tau*103+np.sin(u*math.tau*2)*.7)
        scratches=np.maximum(0,np.cos(v*math.tau*19+np.sin(u*math.tau)*1.3))**52
        scratches*=np.maximum(0,np.sin(u*math.tau*7+v*8)-.58)*1.6
        tone=random*.009+broad*.006+grain*.003+scratches*.036
        base=np.array([.78,.82,.85])
        rough=.43+random*.045+broad*.035-scratches*.13
        metal=np.full((n,n),.88)
        height=random*.045+grain*.014-scratches*.07
    else:
        cells=np.sin(u*math.tau*69+np.sin(v*math.tau*17))*np.sin(v*math.tau*73)
        stipple=np.maximum(0,cells)*.5+random*.2
        tone=random*.007+broad*.004+stipple*.016
        base=np.array([.78,.80,.80])
        rough=.82+stipple*.09+random*.035
        metal=np.zeros((n,n))
        height=stipple*.19
    rgba=np.ones((n,n,4))
    rgba[:,:,:3]=np.clip(base+tone[:,:,None],0,1)
    mr=np.ones((n,n,4));mr[:,:,1]=np.clip(rough,.25,.97);mr[:,:,2]=metal
    dx=(np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))*.4
    dy=(np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))*.4
    normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=2)
    normal/=np.linalg.norm(normal,axis=2)[:,:,None]
    norm=np.ones((n,n,4));norm[:,:,:3]=normal*.5+.5
    return (finish_image('pistol-'+kind+'-basecolor',rgba,'sRGB'),
            finish_image('pistol-'+kind+'-metalrough',mr,'Non-Color'),
            finish_image('pistol-'+kind+'-normal',norm,'Non-Color'))


def material(name, kind, seed):
    mat=bpy.data.materials.new(name)
    mat.use_nodes=True
    mat.use_backface_culling=True
    mat.diffuse_color=(.285,.312,.325,1) if kind=='steel' else (.115,.127,.130,1)
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    bsdf=nodes.get('Principled BSDF')
    maps=finish_maps(kind,seed)
    tex=[]
    for idx,image in enumerate(maps):
        node=nodes.new('ShaderNodeTexImage');node.image=image;node.extension='REPEAT'
        node.location=(-600,200-idx*240);tex.append(node)
    # Corner colors supply coherent large-scale machining/handling zones while
    # microfinish repeats at a documented physical scale on authored face UVs.
    attr=nodes.new('ShaderNodeVertexColor');attr.layer_name='FinishTint';attr.location=(-600,400)
    mix=nodes.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1
    mix.location=(-280,220)
    links.new(tex[0].outputs['Color'],mix.inputs[1]);links.new(attr.outputs['Color'],mix.inputs[2])
    links.new(mix.outputs['Color'],bsdf.inputs['Base Color'])
    separate=nodes.new('ShaderNodeSeparateColor');separate.mode='RGB';separate.location=(-280,-90)
    links.new(tex[1].outputs['Color'],separate.inputs['Color'])
    links.new(separate.outputs['Green'],bsdf.inputs['Roughness'])
    links.new(separate.outputs['Blue'],bsdf.inputs['Metallic'])
    norm=nodes.new('ShaderNodeNormalMap');norm.inputs['Strength'].default_value=.55;norm.location=(-200,-300)
    links.new(tex[2].outputs['Color'],norm.inputs['Color']);links.new(norm.outputs['Normal'],bsdf.inputs['Normal'])
    mat['originalAuthoredFinish']=True
    mat['textureSize']=256
    mat['surfaceMeters']=.08 if kind=='steel' else .06
    return mat


steel=material('pistol-finish:machined-steel','steel',17)
polymer=material('pistol-finish:textured-polymer','polymer',43)
sight=bpy.data.materials.new('pistol-finish:ceramic-sight')
sight.use_nodes=True
sight.use_backface_culling=True
sight.node_tree.nodes.clear()
emission=sight.node_tree.nodes.new('ShaderNodeEmission')
emission.inputs['Color'].default_value=(.43,.52,.45,1)
emission.inputs['Strength'].default_value=1
output=sight.node_tree.nodes.new('ShaderNodeOutputMaterial')
sight.node_tree.links.new(emission.outputs['Emission'],output.inputs['Surface'])
sight['surfaceMeters']=.08
sight['originalAuthoredFinish']=True
parts=[]


def add(obj, tint=1, mapping='project'):
    obj['finishTint']=tint
    obj['uvMapping']=mapping
    parts.append(obj)
    return obj


# Forged slide: an octagonal crown, narrowed nose and tapered rear shoulder.
# Its visible ejection pocket and opposing shallow serrations are true cuts.
def slide_ring(bottom,top,halfwidth):
    return [(bottom,-halfwidth+.002),(bottom+.002,-halfwidth),
            (top-.009,-halfwidth),(top-.001,-halfwidth+.0055),
            (top, -halfwidth+.008),(top, halfwidth-.008),
            (top-.001,halfwidth-.0055),(top-.009,halfwidth),
            (bottom+.002,halfwidth),(bottom,halfwidth-.002)]

slide=loft_x('pistol-slide',[
    (-.073,slide_ring(.026,.061,.014)),
    (-.061,slide_ring(.026,.064,.017)),
    (.148,slide_ring(.026,.064,.017)),
    (.183,slide_ring(.027,.059,.0158)),
    (.192,slide_ring(.029,.056,.0138))],steel)
bevel(slide,.00065)
port=prism('CUT-ejection-window',[(.022,.036),(.074,.036),(.084,.043),(.083,.058),(.023,.058)],
           .03,z=-.016,edge=0)
difference(slide,port)
for side in (-1,1):
    for i in range(7):
        x=-.060+i*.0064
        cut=prism('CUT-rear-serration',[(x,.029),(x+.0025,.029),(x+.008,.061),(x+.0055,.061)],
                  .004,z=side*.0174,edge=0)
        difference(slide,cut)
    for i in range(3):
        x=.129+i*.008
        cut=prism('CUT-forward-serration',[(x,.030),(x+.0028,.030),(x+.0066,.051),(x+.0038,.051)],
                  .004,z=side*.0177,edge=0)
        difference(slide,cut)
# A precise front bore allows the barrel to pass through the slide nose.
bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=.0121,depth=.062,location=g((.174,.04,0)))
cutter=bpy.context.object;cutter.name='CUT-slide-bore';cutter.rotation_euler[1]=math.pi/2
activate(cutter);bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
difference(slide,cutter)
add(slide)

# Inset, closed chamber: the far wall and lock shoulder remain clearly below
# the port lip, so the opening never becomes a see-through hole in the pistol.
add(prism('02-chamber-inset-block',[(.021,.034),(.077,.034),(.084,.043),(.082,.058),(.021,.058)],
          .022,steel,z=-.0033,edge=.0006),1.60)
add(prism('03-extractor-claw',[(.076,.047),(.115,.047),(.119,.050),(.119,.054),(.081,.054)],
          .002,steel,z=-.0154,edge=.00035),.68)
add(box('04-chamber-locking-shoulder',(.029,.058,.001),(.018,.003,.020),steel,.0005),1.11)

# One compact ergonomic frame with a undercut beavertail and tapered dust cover.
frame_outline=[(-.080,.018),(-.075,.024),(.127,.024),(.152,.017),(.147,.002),
               (.119,-.006),(.051,-.007),(.031,-.014),(-.018,-.017),
               (-.029,-.027),(-.059,-.022),(-.067,-.007),(-.079,.001)]
add(prism('pistol-frame',frame_outline,.031,polymer,edge=.0017))
add(prism('06-frame-slide-rail-reveal',[(-.067,.020),(.133,.020),(.143,.024),(-.067,.024)],
          .030,steel,edge=.0004),.58)

# Canted palm swell: Y stations define a hand-fitting ellipse, a narrow neck,
# widening belly, and restrained heel flare. Current primary hand stays at
# [-.052,-.060,.012], so its fingers wrap this same volume without repositioning.
grip_stations=[(-.009,-.048,.022,.014),(-.025,-.050,.0235,.0165),
               (-.052,-.052,.025,.018),(-.084,-.056,.025,.019),
               (-.111,-.059,.024,.0175),(-.117,-.060,.024,.017)]
verts=[];n=16
for y,x,rx,rz in grip_stations:
    for i in range(n):
        angle=i*math.tau/n
        # Modest superellipse makes broad, tactile side panels without an
        # awkward rectangular extrusion or a round broom-handle cross section.
        cx=math.copysign(abs(math.cos(angle))**.75,math.cos(angle))
        cz=math.copysign(abs(math.sin(angle))**.85,math.sin(angle))
        verts.append((x+rx*cx,y,rz*cz))
faces=[]
for j in range(len(grip_stations)-1):
    for i in range(n):faces.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
faces += [tuple(range(n-1,-1,-1)),tuple((len(grip_stations)-1)*n+i for i in range(n))]
grip=add(mesh_obj('pistol-canted-grip',verts,faces,polymer),.95,'grip')

# Inlaid textured grip panels are thin, contoured skins, not plates floating
# outside the palm swell. Their authored UVs use a denser molded stipple scale.
for side in (-1,1):
    vertices=[]
    panel_rows=[(-.031,-.0505,.0238,.017,.68),(-.052,-.052,.025,.018,1),
                (-.084,-.056,.025,.019,1),(-.107,-.0587,.0242,.0177,.75)]
    for y,x,rx,rz,span in panel_rows:
        for i in range(5):
            angle=math.pi/2+(i-2)*.235*span
            cx=math.copysign(abs(math.cos(angle))**.75,math.cos(angle))
            cz=abs(math.sin(angle))**.85
            vertices.append((x+rx*cx,y,side*(rz*cz+.0004)))
    faces=[(j*5+i,j*5+i+1,(j+1)*5+i+1,(j+1)*5+i) for j in range(3) for i in range(4)]
    if side==1:faces=[tuple(reversed(face)) for face in faces]
    panel=mesh_obj('08-grip-inset-panel-'+str(side),vertices,faces,polymer)
    add(panel,.81,'panel')

guard_outer=[(-.026,-.014),(-.012,-.012),(.025,-.011),(.046,-.017),
             (.052,-.028),(.046,-.044),(.036,-.051),(-.017,-.052),(-.025,-.043)]
guard_inner=[(-.016,-.022),(-.008,-.021),(.022,-.019),(.036,-.023),
             (.041,-.029),(.036,-.038),(.029,-.042),(-.014,-.043),(-.017,-.037)]
guard=ring_profile('09-open-trigger-guard',guard_outer,guard_inner,.014,polymer)
add(guard,.92)
add(prism('10-curved-trigger',[(-.001,-.016),(.006,-.016),(.008,-.025),(.004,-.033),
          (-.003,-.038),(-.006,-.036),(-.001,-.029),(.001,-.024)],.007,steel,edge=0),.92)
add(prism('11-magazine-heel',[(-.085,-.115),(-.034,-.114),(-.031,-.118),
          (-.033,-.123),(-.085,-.123),(-.088,-.120)],.039,polymer,edge=.0006),.8)

# The crown ends at the immutable muzzle point. Hollow geometry continues back
# to a dark recess; no opaque disk covers the visible mouth of the barrel.
barrel=add(tube('12-hollow-barrel-crown',.158,.201,.04,.0118,.0078,steel,segments=20),1.34,'barrel')
verts=[(.159,.04,0)]+[(.159,.04+math.cos(i*math.tau/24)*.0078,math.sin(i*math.tau/24)*.0078) for i in range(24)]
faces=[(0,i+1,(i+1)%24+1) for i in range(24)]
add(mesh_obj('13-bore-depth-shadow',verts,faces,polymer),.14,'project')

# Closed removable rear plate, nested in its molded slide rim. Small grooves
# and a retainer make the end visible in gameplay read as assembled metal.
plate=prism('14-closed-striker-backplate',[(-.010,.029),(.010,.029),(.010,.046),
            (.006,.054),(-.006,.054),(-.010,.046)],.0015,steel,edge=.0006)
for v in plate.data.vertices:
    gx,gy,gz=game(v.co);v.co=g((-.0738+gz,gy,-gx))
add(plate,.57)
for i in range(3):
    add(box('15-backplate-milled-line-'+str(i),(-.07465,.034+i*.004,0),(.00035,.0007,.0105),polymer,edge=0),.40)

# Low-profile controls and ambidextrous frame pins; all merge into the same
# two finishes, with no extra materials or transparent decal draw calls.
add(prism('16-slide-stop-lever',[(-.047,.004),(-.017,.004),(-.014,.007),(-.018,.010),(-.046,.009)],
          .0038,steel,z=-.0174,edge=.0005),.76)
for i in range(4):
    add(box('17-slide-stop-knurl-'+str(i),(-.040+i*.0055,.0096,-.0193),(.0015,.0005,.0006),polymer,edge=0),.65)
add(prism('18-magazine-release',[(-.036,-.023),(-.029,-.023),(-.027,-.028),(-.036,-.029)],
          .0018,steel,z=-.0180,edge=.0004),.66)
for side in (-1,1):
    for i,(x,y) in enumerate([(-.057,.004),(-.021,.005)]):
        pinverts=[(x,y,side*.0161)]+[(x+math.cos(j*math.tau/12)*.0023,
                  y+math.sin(j*math.tau/12)*.0023,side*.0161) for j in range(12)]
        pinfaces=[(0,j+1,(j+1)%12+1) for j in range(12)]
        if side<0:pinfaces=[tuple(reversed(face)) for face in pinfaces]
        add(mesh_obj('19-frame-pin-'+str(side)+'-'+str(i),pinverts,pinfaces,steel),1.03)

# Existing iron sight dimensions remain the alignment source of truth.
REAR={'x':-.05,'length':.02,'width':.032,'bottom':.069,'floor':.074,'top':.087,'gap':.012}
FRONT={'x':.13,'length':.012,'width':.006,'bottom':.070,'top':.079}
add(prism('20-rear-dovetail-base',[(-.064,.062),(-.036,.062),(-.039,.071),(-.061,.071)],
          .026,steel,edge=.0006),.65)
add(box('21-rear-notch-floor',(-.050,.072,0),(.020,.004,.032),steel,edge=.0004),.25)
for side in (-1,1):
    add(prism('22-rear-sight-ear-'+str(side),[(-.060,.074),(-.040,.074),(-.0434,.085),
              (-.046,.0865),(-.0558,.0865),(-.060,.084)],.010,steel,z=side*.011,edge=0),.21)
add(prism('23-front-dovetail-base',[(.117,.061),(.142,.061),(.139,.070),(.121,.070)],
          .013,steel,edge=.0005),.61)
add(box('24-front-sight-post',(.130,.0745,0),(.012,.009,.006),steel,edge=0),.22)

# The pale ceramic sight gets one tiny emissive material, matching the existing
# game's sight cue even in deep shade. It adds no texture or shader work to
# the other surfaces and keeps the complete weapon+hand below prior draws.
verts=[(.12375,.0772,0)]+[(.12375,.0772+math.cos(i*math.tau/12)*.0015,math.sin(i*math.tau/12)*.0015) for i in range(12)]
# An open disk has no automatic "outside". Preserve its explicit -X facing;
# a generic outward-normal pass can flip it toward the muzzle and hide the dot.
front_dot=add(mesh_obj('25-front-ceramic-dot',verts,[(0,(i+1)%12+1,i+1) for i in range(12)],
                      sight,recalc=False),1.0,'sight')

# Original fictional maker mark: shallow inset strokes H9 on the slide flank.
# These are silhouette-independent surface features, not a licensed logo.
for side in (-1,1):
    x=.108 if side<0 else .095;y=.037;z=side*.01705
    strokes=[(0,0,.0007,.006),(.0037,0,.0007,.006),(.00185,0,.0037,.00065),
             (.0084,.0028,.0034,.00065),(.0067,.0014,.00065,.003),(.0101,0,.00065,.006),
             (.0084,0,.0034,.00065),(.0084,-.0028,.0034,.00065)]
    for i,(dx,dy,w,h) in enumerate(strokes):
        px=x+dx*side;py=y+dy
        add(mesh_obj('26-H9-stamp-'+str(side)+'-'+str(i),
                     [(px-w/2,py-h/2,z),(px+w/2,py-h/2,z),(px+w/2,py+h/2,z),(px-w/2,py+h/2,z)],
                     [(0,1,2,3)] if side==1 else [(3,2,1,0)],steel),.35)


def author_uv_and_tint(obj):
    mesh=obj.data
    # World-metred projections preserve contiguous machining strokes between
    # slide sections; each hard face owns its seams. Curved barrel and grip
    # instead use continuous cylindrical chart coordinates and an explicit seam.
    for existing in list(mesh.uv_layers):mesh.uv_layers.remove(existing)
    for existing in list(mesh.color_attributes):mesh.color_attributes.remove(existing)
    uv=mesh.uv_layers.new(name='UVMap')
    tint=mesh.color_attributes.new(name='FinishTint',type='FLOAT_COLOR',domain='CORNER')
    material=obj.data.materials[0]
    meters=material['surfaceMeters']
    mode=obj['uvMapping']
    for face in mesh.polygons:
        coords=[game(mesh.vertices[mesh.loops[li].vertex_index].co) for li in face.loop_indices]
        # Compute Newell normals from final geometry. Blender boolean evaluation
        # may leave polygon normal caches stale until the next dependency graph
        # update; UV chart choice must not depend on that cached state.
        fn=Vector((0,0,0))
        for i,point in enumerate(coords):fn+=Vector(point).cross(Vector(coords[(i+1)%len(coords)]))
        fn.normalize()
        dominant=max(range(3),key=lambda i:abs(fn[i]))
        angular=[]
        if mode in ('barrel','grip'):
            for x,y,z in coords:
                if mode=='barrel':angular.append(math.atan2(z,y-.04)/math.tau)
                else:
                    center=-.048+min(0,y+.009)*.111
                    angular.append(math.atan2(z/.018,(x-center)/.024)/math.tau)
            if max(angular)-min(angular)>.5:angular=[a+1 if a<0 else a for a in angular]
        for corner,li in enumerate(face.loop_indices):
            x,y,z=coords[corner]
            if mode=='barrel' and dominant!=0:u,v=angular[corner]*math.tau*.0118/meters,x/meters
            elif mode=='grip' and dominant!=1:u,v=angular[corner]*.135/meters,-y/meters
            elif mode=='panel' and dominant==2:u,v=x/.042,y/.042
            elif mode=='sight':u,v=.5+z*10,.5+(y-.0772)*10
            elif dominant==0:u,v=z/meters,y/meters
            elif dominant==1:u,v=x/meters,z/meters
            else:u,v=x/meters,y/meters
            uv.data[li].uv=(u,v)
            # Small brighter edge breaks are mechanically plausible finish
            # variation. Reflections are still produced by normals and lights.
            amount=obj['finishTint']
            if mode!='sight' and material==steel:
                angle=max(abs(c) for c in fn)
                edge=min(1,max(0,(.994-angle)*8))
                amount*=1+edge*.09
                if obj.name=='pistol-slide' and dominant==2:
                    # Dark phosphate remains in the protected machined groove
                    # floors; broad handled slide faces keep the worn finish.
                    # This true surface assignment preserves readable milling
                    # in the viewmodel pass, which has no self-shadow map.
                    face_z=sum(abs(point[2]) for point in coords)/len(coords)
                    rear_floor=abs(face_z-.0154)<.00004
                    forward_floor=abs(face_z-.0157)<.00004
                    if rear_floor or forward_floor:amount*=.20
            if mode!='sight':amount*=.35 if material==steel else .022
            tint.data[li].color=(amount,amount,amount,1)
    mesh.color_attributes.active_color=tint
    weighted_normals(obj)


for obj in parts:
    author_uv_and_tint(obj)

root=bpy.data.objects.new('vm_pistol',None)
asset_collection.objects.link(root)
root['heroWeapon']={
    'type':'pistol','source':'original-blender-authored','name':'H9 compact service pistol',
    'muzzle':[.201,.04,0],'triggerOpening':[.028,-.031,0],
    'recess':{'point':[.055,.044,-.017],'depth':.0027},
    'gripCenter':[-.052,-.060,.012],
    'features':['forged-crown','open-ejection-pocket','milled-serrations','continuous-palm-swell',
                'open-trigger-guard','hollow-barrel','closed-backplate','authored-uvs'],
}
root['ironSights']={'rear':REAR,'front':FRONT}
root['assetSource']='assets/blender/pistol.blend'
for obj in parts:
    obj.parent=root
    obj['assetPart']=obj.name


def aim(obj,point):
    obj.rotation_euler=(Vector(g(point))-obj.location).to_track_quat('-Z','Y').to_euler()


def area(name,position,power,size,color):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
    obj=bpy.data.objects.new(name,data);studio_collection.objects.link(obj);obj.location=g(position);aim(obj,(.05,-.02,0))


# Metre-scale neutral studio, saved for source review but excluded from GLB.
area('Key softbox',(.05,.43,-.38),18,.4,(.90,.94,1))
area('Rim softbox',(-.16,.15,.32),24,.3,(1,.87,.70))
area('Broad fill',(.30,.02,.14),9,.3,(.85,.92,1))
scene.world.color=(.11,.11,.11)
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.075,.09,.115,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.35
camera_data=bpy.data.cameras.new('Asset beauty camera');camera=bpy.data.objects.new('Asset beauty camera',camera_data)
studio_collection.objects.link(camera);scene.camera=camera
camera.location=g((-.32,.19,-.58));aim(camera,(.058,-.017,0));camera_data.type='ORTHO';camera_data.ortho_scale=.365
scene.render.engine='CYCLES'
scene.cycles.samples=48
scene.cycles.use_denoising=True
scene.render.resolution_x=1440;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.film_transparent=False
scene.view_settings.view_transform='AgX'

bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))

# Only the source model is selected. glTF contains no camera, lights or studio.
bpy.ops.object.select_all(action='DESELECT')
root.select_set(True)
for obj in parts:obj.select_set(True)
bpy.context.view_layer.objects.active=root
glb=OUT/'pistol.glb'
bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',use_selection=True,
    export_yup=True,export_extras=True,export_animations=False,export_cameras=False,
    export_lights=False,export_materials='EXPORT',export_texcoords=True,
    export_normals=True,export_tangents=False,export_all_vertex_colors=False,
    export_vertex_color='NAME',export_vertex_color_name='FinishTint',
    export_image_format='AUTO',export_apply=True)

# Derive truthful delivery statistics from the actual glTF JSON/binary, not
# Blender's pre-export vertex count (UV seams/normals split exported vertices).
blob=glb.read_bytes();json_len=struct.unpack_from('<I',blob,12)[0]
document=json.loads(blob[20:20+json_len])
triangles=0;vertices=0;geometry_bytes=0;accessor_ids=set();bounds=[]
for mesh in document.get('meshes',[]):
    for primitive in mesh['primitives']:
        p=document['accessors'][primitive['attributes']['POSITION']]
        vertices+=p['count'];bounds.append((p['min'],p['max']))
        triangles+=document['accessors'][primitive['indices']]['count']//3
        accessor_ids.update(primitive['attributes'].values());accessor_ids.add(primitive['indices'])
for index in accessor_ids:
    accessor=document['accessors'][index]
    sizes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}
    counts={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
    geometry_bytes+=accessor['count']*sizes[accessor['componentType']]*counts[accessor['type']]
texture_records=[]
for path in sorted(SOURCE_TEXTURES.glob('pistol-*.png')):
    texture_records.append({'path':str(path.relative_to(ROOT)),'width':256,'height':256,'bytes':path.stat().st_size,
                            'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
manifest={
    'schemaVersion':1,'name':'H9 compact service pistol','source':'original-blender-authored',
    'authoringTool':bpy.app.version_string,'rebuild':'tools/blender/build-pistol.py',
    'sourceFile':'assets/blender/pistol.blend','runtimeFile':'public/assets/models/pistol/pistol.glb',
    'license':'Original project asset; no third-party geometry, trademarks, or photographs.',
    'coordinateSystem':{'units':'meters','forward':'+X','up':'+Y','right':'+Z'},
    'muzzle':[.201,.04,0],'gripCenter':[-.052,-.060,.012],'ironSights':{'rear':REAR,'front':FRONT},
    'bounds':{'min':[min(b[0][i] for b in bounds) for i in range(3)],
              'max':[max(b[1][i] for b in bounds) for i in range(3)]},
    'geometry':{'triangles':triangles,'exportedVertices':vertices,'meshParts':len(document.get('meshes',[])),
                'materialGroups':len(document.get('materials',[])),'accessorBytes':geometry_bytes,
                'budgetTriangles':4000,'budgetMaterialGroups':3},
    'delivery':{'glbBytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest(),
                'embeddedImages':len(document.get('images',[])),
                'textureRgba8BytesWithMipmapsEstimate':len(document.get('images',[]))*256*256*4*4//3,
                'runtimeExternalDependencies':[]},
    'textures':texture_records,
    'notes':[
        'Geometry is a new original fictional pistol, authored with profile lofts, boolean milling, edge bevels, and weighted normals.',
        'The editable Blender source retains named mesh parts and a separate non-exported review studio.',
        'UVs are seam-separated physical-scale face charts, with cylindrical charts on the barrel and grip.',
        'All PBR finish maps are original deterministic 256 px authored data; GLB embeds delivery maps.',
        'Runtime batcher may merge named static parts by their three shared materials, including the emissive ceramic sight.',
        'Memory totals are accessor and RGBA8+mip estimates, not measured driver residency.',
    ],
}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
assert triangles<=4000, f'Weapon triangle budget exceeded: {triangles}'
assert len(document.get('materials',[]))<=3, 'Material budget exceeded'
print('PISTOL_ASSET_MANIFEST '+json.dumps(manifest))

if not options.skip_render:
    scene.render.filepath=str(REVIEW/'asset-beauty.png')
    bpy.ops.render.render(write_still=True)
    camera.location=g((.048,.018,-.65));aim(camera,(.055,-.019,0));camera_data.ortho_scale=.345
    scene.render.filepath=str(REVIEW/'asset-side.png')
    bpy.ops.render.render(write_still=True)
print('PISTOL_ASSET_DONE '+str(glb))
