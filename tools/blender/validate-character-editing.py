"""Exercise the saved gunman artist workflow without modifying delivery/source files.

Blender --background assets/blender/characters.blend --python tools/blender/validate-character-editing.py
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy
import numpy as np

import character_fidelity as fidelity

builder_path = Path(__file__).with_name('build-characters.py')
spec = importlib.util.spec_from_file_location('character_builder', builder_path)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
source = builder.SOURCE
before_hash = hashlib.sha256(source.read_bytes()).hexdigest()
if bpy.context.scene.get('game_character_fidelity_revision') != fidelity.REVISION:
    bpy.ops.wm.open_mainfile(filepath=str(source))
objects = {obj['game_surface']: obj for obj in bpy.data.collections['gunman'].objects if 'game_surface' in obj}
checks = []


def packed(values, layout):
    return {**layout, 'values': np.asarray(values).tolist()}


# Point-domain colour painted through the visible GameColor surface is exported.
head = objects['head'].copy()
head.data = objects['head'].data.copy()
head.data.color_attributes['GameColor'].data[0].color = (0.12, 0.34, 0.56, 1)
result = fidelity.export_surface(head, packed, builder.normals_for)
colors = np.asarray(result['attributes']['color']['values']).reshape(-1, 3)
assert np.min(np.linalg.norm(colors - [0.12, 0.34, 0.56], axis=1)) < 1e-6
checks.append('visible point-domain GameColor paint survives export')

# A painted corner can differ from adjacent corners of the same position;
# export splits it rather than silently averaging away the painted boundary.
head.data.color_attributes.remove(head.data.color_attributes['GameColor'])
paint = head.data.color_attributes.new(name='GameColor', type='FLOAT_COLOR', domain='CORNER')
for loop in paint.data:
    loop.color = (0.31, 0.32, 0.33, 1)
paint.data[0].color = (0.11, 0.52, 0.27, 1)
result = fidelity.export_surface(head, packed, builder.normals_for)
first = result['index']['values'][0]
colors = np.asarray(result['attributes']['color']['values']).reshape(-1, 3)
assert np.max(np.abs(colors[first] - [0.11, 0.52, 0.27])) < 1e-6
checks.append('visible corner-domain GameColor paint splits discontinuities')

# Active artist-edited bake UVs, not the old game_uv mirror, drive the atlas.
head.data.uv_layers.active.data[0].uv = (0.234, 0.567)
result = fidelity.export_surface(head, packed, builder.normals_for)
uv = np.asarray(result['attributes']['uv']['values']).reshape(-1, 2)
assert np.max(np.abs(uv[result['index']['values'][0]] - [0.234, 0.567])) < 1e-6
checks.append('active baked-surface UV edits survive export')

# New quads never fall through as an invalid triangle index stream.
quad = bpy.data.meshes.new('validation untriangulated low mesh')
quad.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
try:
    fidelity.triangles(quad)
except RuntimeError as error:
    assert 'triangulate' in str(error)
else:
    raise AssertionError('Untriangulated low topology was silently accepted')
checks.append('nontriangular low meshes fail with explicit triangulation guidance')

# Weight painting uses the named groups that Blender artists manipulate.
garment = objects['garments'].copy()
garment.data = objects['garments'].data.copy()
for group in garment.vertex_groups:
    group.remove([0])
garment.vertex_groups['joint:chest'].add([0], 0.7, 'REPLACE')
garment.vertex_groups['joint:shoulderL'].add([0], 0.3, 'REPLACE')
result = fidelity.export_surface(garment, packed, builder.normals_for)
position = np.asarray(result['attributes']['position']['values']).reshape(-1, 3)
vertex = int(np.argmin(np.linalg.norm(position - garment.data.vertices[0].co[:], axis=1)))
indices = np.asarray(result['attributes']['skinIndex']['values']).reshape(-1, 4)[vertex]
weights = np.asarray(result['attributes']['skinWeight']['values']).reshape(-1, 4)[vertex]
actual = dict(zip(indices, weights))
assert abs(actual[2] - 0.7) < 1e-6 and abs(actual[5] - 0.3) < 1e-6
checks.append('named bone-group paint exports normalized game weights')

# Simulate an artist material edit, then perform the same preserving bake path
# as --bake-only. The actual exported roughness must reflect the saved edit.
low = objects['head']
master = next(obj for obj in bpy.data.collections['GUNMAN_SCULPT_MASTERS'].objects if obj.get('master_for') == low.name)
artist = bpy.data.materials.new('Validation artist-owned roughness')
artist.use_nodes = True
artist.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.37
master.data.materials.clear()
master.data.materials.append(artist)
master.hide_render = False
bpy.data.collections['GUNMAN_SCULPT_MASTERS'].hide_render = False
with tempfile.TemporaryDirectory(prefix='character-edit-validation-') as temporary:
    fidelity.bake(low, master, Path(temporary), 'head', initialize_roughness=False)
    assert master.data.materials[0] == artist
    assert artist.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value > 0.369
    texture = bpy.data.images['gunman-head-roughness']
    pixels = np.asarray(texture.pixels[:]).reshape(512, 512, 4)
    layer = low.data.uv_layers.active
    areas = []
    for polygon in low.data.polygons:
        uv = np.asarray([layer.data[loop].uv[:] for loop in polygon.loop_indices])
        first, second = uv[1] - uv[0], uv[2] - uv[0]
        area = abs(first[0] * second[1] - first[1] * second[0])
        areas.append((float(area), uv.mean(axis=0)))
    samples = []
    for _, uv in sorted(areas, key=lambda item: item[0], reverse=True)[:32]:
        x, y = np.clip((uv * 512).astype(int), 0, 511)
        samples.append(float(pixels[y, x, 1]))
    assert abs(float(np.median(samples)) - 0.37) < 0.015, samples
checks.append('saved master roughness material survives rebake and appears in actual pixels')
assert hashlib.sha256(source.read_bytes()).hexdigest() == before_hash
checks.append('validation leaves the production Blender source unchanged')
print(json.dumps({'checks': checks, 'sourceSha256': before_hash}, indent=2))
