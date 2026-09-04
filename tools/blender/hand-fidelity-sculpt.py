"""Authored silhouette and anatomical detail fields used by the hand Blender asset.

The accepted GAME meshes, shape keys and per-loop UVs remain editable. Running
--export-only does not call these fields or replace artist edits.
"""
import math
from mathutils import Vector
TAU = math.pi * 2

def g(x,c,w): return math.exp(-((x-c)/w)**2)
def clamp(x,a=0,b=1): return max(a,min(b,x))
def smooth(x): x=clamp(x); return x*x*(3-2*x)
def periodic(x,c): return min(abs(x-c),1-abs(x-c))
def plateau(x,c,w,e): return 1-smooth((abs(x-c)-w)/e)


def sculpt_hand(points, semantics, radius):
    # Ring centres are derived from the accepted mesh, rather than replacing
    # its carefully fitted grip spline with a newly generated hand.
    rings={}
    for p,s in zip(points,semantics):
        if s['part']!='palm' and s['v']>0 and s['v']<1:
            rings.setdefault((s['part'],round(s['v'],5)),{})[tuple(round(x,7) for x in p)]=Vector(p)
    centres={key:sum(values.values(),Vector())/len(values) for key,values in rings.items()}
    result=[]
    for p,s in zip(points,semantics):
        original=Vector(p); q=original.copy(); x,y,z=q
        if s['part']=='palm':
            # Deep metacarpal rake and staggered knuckle pads break the old
            # rectangular mitten outline. Both attachment and contact remain.
            end=smooth((z+.033)/.009)*smooth((.068-z)/.014)
            dorsal=smooth((y-.002)/.021)
            pads=sum(h*g(x,c,.0080) for c,h in [(-.027,.0065),(-.009,.0080),(.010,.0060),(.028,.0034)])
            knuckles=pads*g(z,-.026,.022)
            valley=-.0035*g(z,.022,.021)*(0.4+.6*g(x,.001,.028))
            q.y+=end*dorsal*(knuckles+valley+.0015*g(x,-.002,.028)*g(z,.020,.042))
            # Thenar pad and curved ulnar heel; asymmetric anatomical volume.
            palmar=smooth((-y-.005)/.016)
            q.y-=end*palmar*(.0024*g(x,-.022,.018)*g(z,.024,.029)+.0007*g(x,.024,.012)*g(z,.007,.032))
            side=smooth((abs(x)-.022)/.020)
            q.x+=end*side*(-math.copysign(.0028*g(z,.028,.031),x))
        else:
            t=s['v']; centre=centres.get((s['part'],round(t,5)))
            if centre is not None and t>.075:
                radial=original-centre
                thumb=s['part']=='thumb'; dorsal_u=.5 if thumb else .25
                dorsal=math.exp(-(periodic(s['u']%1,dorsal_u)/.165)**4)
                shoulder=math.exp(-(periodic(s['u']%1,dorsal_u)/.26)**4)
                joint=g(t,.43,.09)+.75*g(t,.70,.07)
                # Widen knuckle shoulders, taper distal phalanges, flatten the
                # nail table, preserve softer pads on the opposing surface.
                thickness=(.00130 if thumb else .00105)*joint*shoulder
                thickness-=.00085*g(t,.89,.13)*dorsal
                thickness+=.00045*g(t,.965,.045)*(1-dorsal)
                q+=radial.normalized()*thickness*smooth((t-.075)/.12)
                # Individual phalanx lateral planes distinguish the digits.
                if not thumb:
                    q.x=centre.x+(q.x-centre.x)*(1-.105*g(t,.86,.14)+.055*g(t,.43,.07))
                # Finger opening binding is a folded shell, not paint alone.
                cutoff=.30 if thumb else .22
                q+=radial.normalized()*.00065*g(t,cutoff,.035)
        # A real staggered metacarpal arch continues through the finger roots.
        # The same positional field is applied on both sides of each UV seam.
        dorsal=smooth((original.y-.002)/.020)
        arch=g(original.z,-.032,.011)*dorsal
        lobes=sum(h*g(original.x,c,.0085) for c,h in [(-.027,.0034),(-.009,.0050),(.010,.0034),(.028,.0010)])
        q.y+=arch*lobes
        q.z+=arch*sum(h*g(original.x,c,.010) for c,h in [(-.027,-.002),(-.009,-.004),(.010,-.001),(.028,.003)])
        # Extend the glove's rear opening towards the cuff, replacing the long
        # oval bare-wrist strip with a short anatomically plausible wrist gap.
        if original.z>.055:
            q.z+=.0125*g(original.z,.068,.011)*smooth((.092-original.z)/.010)
        if radius is None:
            q.z+=.006*smooth((.060-original.z)/.040)
        if radius is not None:
            # Lock the existing handle-facing pad and blend smoothly outward.
            distance=math.hypot(original.y+.010,original.z+.060)
            protect=smooth((distance-(radius+.0010))/.006)
            q=original+(q-original)*protect
        result.append(tuple(q))
    # All UV copies of a physical vertex move together, including the palm /
    # digit collar seam where the semantic labels change.
    groups={}
    for i,p in enumerate(points): groups.setdefault(tuple(round(v,7) for v in p),[]).append(i)
    for indices in groups.values():
        moved=[Vector(result[i])-Vector(points[i]) for i in indices]
        # The most protected coincident sample owns a shared opening vertex.
        delta=min(moved,key=lambda d:d.length_squared)
        for i in indices: result[i]=tuple(Vector(points[i])+delta)
    return result


def sculpt_sleeve(p,cuff=False):
    x,y,z=p; t=y+.5; angle=math.atan2(z/.94,x)
    if t<=0 or t>=1: return tuple(p)
    radius=math.hypot(x,z/.94)
    if cuff:
        delta=(.016*math.cos(angle*3+t*3)+.008*math.sin(angle*7-t*5))*math.sin(t*math.pi)**2
    else:
        # Two compressed folds fan from the wrist and elbow rather than a
        # repeated corrugation. Existing endpoints and cylindrical rig axis stay.
        delta=(.0027*math.sin(angle*3+t*8)*g(t,.82,.15)+.0014*math.sin(angle*2-t*11)*g(t,.58,.19))*math.sin(t*math.pi)**2
    return (x*(1+delta/radius),y,z*(1+delta/radius))


def semantic_uv(s,p,old_uv,web=False):
    u=(old_uv[0]-.03125)/.9375
    local_v=(old_uv[1]-(.53125 if s['kind']=='glove' else .03125))/.4375
    # Existing angular seam duplicates have U=1 and must stay on that edge.
    u=clamp(u); t=s['v']
    if s['kind']=='skin':
        if s['part']=='palm': return (.725+.235*u,.038+.105*clamp(local_v/.30))
        if s['part']=='thumb': return (.725+.235*u,.18+.275*clamp((t-.30)/.70))
        return (.038+.632*u,.038+.417*clamp((t-.22)/.78))
    if s['part']=='palm':
        if web: return (.740+.205*clamp(.5+p[0]/.095),.552+.045*clamp(.5+p[1]/.070))
        return (.038+.632*u,.555+.408*clamp((local_v-.2857)/.7143))
    cutoff=.30 if s['part']=='thumb' else .22
    return ((.855+.105*u) if s['part']=='thumb' else (.725+.105*u),.645+.31*clamp(t/cutoff))


def surface_details(u,v):
    """Return sculpt displacement, linear diffuse color and roughness at atlas UV.
    Features follow named anatomical UV regions. These are applied to dense 3D
    SCULPT meshes before selected-to-active baking, never runtime noise shaders.
    """
    # Skin finger / thumb / wrist atlas regions.
    if v<.5:
        thumb=u>.70 and v>.16; wrist=u>.70 and v<.16
        if thumb: a=(u-.725)/.235; t=.30+(v-.18)/.275*.70; dorsal_u=.5
        elif wrist: a=(u-.725)/.235; t=(v-.038)/.105*.30; dorsal_u=.25
        else: a=(u-.038)/.632; t=.22+(v-.038)/.417*.78; dorsal_u=.25
        dorsal=math.exp(-(periodic(a%1,dorsal_u)/.16)**4)
        palmar=math.exp(-(periodic(a%1,(dorsal_u+.5)%1)/.23)**4)
        pores=(math.sin(a*TAU*49+math.sin(t*37))*math.sin(t*TAU*43+a*23))
        crease=sum(g(t,c+.009*math.cos(a*TAU),w)*h for c,w,h in [(.452,.006,1),(.477,.004,.5),(.718,.005,.8),(.750,.004,.4)])
        knuckle=sum(g(t,c+.007*math.sin(a*TAU),.004) for c in [.411,.432,.450,.682,.701])
        nail=0; edge=0; lunula=0; nail_ridges=0
        if not wrist:
            # Broad flattened rounded nail, distinct cuticle and a restrained
            # free edge, all tied to the actual distal anatomical table.
            du=periodic(a%1,dorsal_u); qx=du-.074; qy=abs(t-.885)-.039
            dist=math.hypot(max(qx,0),max(qy,0))+min(max(qx,qy),0)-.020
            nail=1-smooth((dist+.002)/.006)
            edge=g(dist,.001,.005)
            lunula=g(t,.814,.014)*nail
            nail_ridges=math.sin((a-dorsal_u)*TAU*90)*nail*.000010
        height=pores*.000012*(1-nail)-crease*(.00020*palmar+.000025)-knuckle*dorsal*.000065
        height+=nail*.00032-edge*.00011+nail_ridges
        # Warm knuckle/pad color, pale keratin and red cuticle rim; no lighting.
        warmth=(g(t,.43,.07)+g(t,.70,.065))*dorsal
        skin=(.455+.012*warmth,.278-.010*warmth,.195-.012*warmth)
        nail_color=(.490+.015*lunula,.309+.020*lunula,.235+.018*lunula)
        color=tuple(skin[i]*(1-nail)+nail_color[i]*nail for i in range(3))
        color=tuple(c*(1-edge*.035) for c in color)
        roughness=.64+.07*palmar+.025*pores-.13*nail+.08*edge
        return height,color,roughness
    if u<.70:
        a=(u-.038)/.632; t=(v-.555)/.408
        # Glove dorsal leather panel taper, split metacarpal channels, rounded
        # double needle seam and broad fabric flexion wrinkles.
        width=.102+.034*smooth(t)
        qx=abs(a-.25)-width; qy=abs(t-.56)-.31
        dist=math.hypot(max(qx,0),max(qy,0))+min(max(qx,qy),0)-.019
        panel=1-smooth((dist+.002)/.008)
        seam=g(dist,0,.008)
        stitch=g(dist,-.020,.005)*max(0,math.cos((t*31+a*18)*TAU))**8
        channels=sum(g(a,c,.009) for c in [.192,.25,.307])*g(t,.80,.19)*panel
        fold=math.sin((t*7+a*2)*TAU)*g(t,.17,.13)*(1-panel)
        grain=math.sin(a*TAU*71)*math.sin(t*TAU*49)
        height=panel*.00130-seam*.00045+stitch*.00040-channels*.00050+fold*.00028+grain*.000022
        closure=g(t,.080,.036)
        closure_seam=g(t,.126,.012)
        closure_stitch=closure_seam*max(0,math.cos(a*TAU*32))**6
        height+=closure*.00065-closure_seam*.00025+closure_stitch*.00032
        color=(.030+.038*panel+.075*stitch+.025*closure+.09*closure_stitch-.017*seam,
               .038+.038*panel+.060*stitch+.024*closure+.075*closure_stitch-.017*seam,
               .032+.030*panel+.035*stitch+.016*closure+.05*closure_stitch-.014*seam)
        return height,color,.89-.19*panel+.08*seam-.015*grain-.13*closure
    a=(u-(.855 if u>.845 else .725))/.105; t=(v-.645)/.31
    hem=g(t,.86,.055); stitch=hem*max(0,math.cos(a*TAU*24))**7
    weave=math.sin(a*TAU*40)*math.sin(t*TAU*32)
    height=hem*.00065+stitch*.00035+weave*.000028
    color=(.030+.035*hem+.060*stitch,.038+.035*hem+.050*stitch,.032+.028*hem+.030*stitch)
    return height,color,.9-.055*hem+.02*weave
