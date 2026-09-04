"""Validate saved material controls and roughness-only baking without publication.

Blender --background candidate/characters.blend --python tools/blender/validate-character-material-editing.py
"""
import hashlib
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy
import numpy as np
from character_fidelity import bake

source = Path(bpy.data.filepath)
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
collection = bpy.data.collections['gunman']
head = next(obj for obj in collection.objects if obj.get('game_surface') == 'head')
masters = bpy.data.collections['GUNMAN_SCULPT_MASTERS']
high = next(obj for obj in masters.objects if obj.get('master_for') == head.name)
normal = bpy.data.images['gunman-head-normal']
normal_hash = hashlib.sha256(bytes(normal.packed_file.data)).hexdigest()
material = high.data.materials[0]
controls = [node for node in material.node_tree.nodes if node.type == 'VALUE']
assert len(controls) == 7, 'Expected the saved editable region controls'
for node in controls:
    node.outputs[0].default_value = 0.77 if node.name == 'Base roughness' else 0
masters.hide_render = high.hide_render = False
with tempfile.TemporaryDirectory(prefix='character-material-edit-') as temporary:
    bake(head, high, Path(temporary), 'head', initialize_roughness=False, roughness_only=True)
    assert high.data.materials[0] == material, 'Artist material was replaced'
    assert hashlib.sha256(bytes(normal.packed_file.data)).hexdigest() == normal_hash
    image = bpy.data.images['gunman-head-roughness']
    encoded = (Path(temporary) / 'gunman-head-roughness.png').read_bytes()
    assert bytes(image.packed_file.data) == encoded, 'Saved PNG and packed image disagree'
    pixels = np.asarray(image.pixels[:]).reshape(512, 512, 4)
    layer = head.data.uv_layers.active
    areas = []
    for face in head.data.polygons:
        uv = np.asarray([layer.data[loop].uv[:] for loop in face.loop_indices])
        a, b = uv[1] - uv[0], uv[2] - uv[0]
        areas.append((abs(a[0] * b[1] - a[1] * b[0]), uv.mean(axis=0)))
    samples = []
    for _, uv in sorted(areas, key=lambda pair: pair[0], reverse=True)[:64]:
        x, y = np.clip((uv * 512).astype(int), 0, 511)
        samples.append(float(pixels[y, x, 1]))
    assert abs(float(np.median(samples)) - 0.77) < 0.012, samples
assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
print(json.dumps({'checks': ['Saved region Value controls remain editable and affect actual roughness pixels',
                             'Roughness-only baking preserves the artist material and exact packed normal PNG',
                             'Packed roughness is byte-identical to the encoded PNG',
                             'Validation leaves the candidate source file unchanged'],
                  'sampleMedian': float(np.median(samples)), 'sampleCount': len(samples),
                  'normalSha256': normal_hash, 'sourceSha256': source_hash}, indent=2))
