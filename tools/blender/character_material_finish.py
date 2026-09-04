"""Author editable material zones on the accepted gunman sculpt masters.

This changes neither sculpt/low geometry nor normals, UVs, binding or palette.
Generated images are inappropriate for these semantic roughness masks: they
are authored from the character's actual material labels and anatomical space.

Create a staged candidate (never writes delivery by default):
  Blender --background --python tools/blender/character_material_finish.py

Subsequent artist edits are preserved by build-characters.py --bake-only
--roughness-only. Only running this initializer again resets the named masks
and material controls. Finish_* grayscale color attributes can be vertex
painted on the dense masters; labeled Value nodes tune each region's response.
All values are artistic estimates, not measured physical material properties.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy
import numpy as np

from character_fidelity import positions, rebake_saved, values
from character_body_sculpt import _arm_frame

ROOT = Path(__file__).resolve().parents[2]
REVISION = 'gunman-material-zones-v1'


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def bell(x, width):
    return np.exp(-np.square(x / width))


def author_masks(part, high, entry):
    p = positions(high.data)
    x, y, z = p.T
    if part == 'head':
        # The head master uses normalized head coordinates, not body metres.
        front = smooth((z - 0.10) / 0.28)
        t_zone = front * np.maximum(bell(x, 0.16) * bell(y - 0.68, 0.085),
                                   bell(x, 0.075) * bell(y - 0.47, 0.095))
        nose = front * bell(x, 0.063) * bell(y - 0.412, 0.070)
        cheek = front * bell(np.abs(x) - 0.26, 0.13) * bell(y - 0.39, 0.12)
        lips = front * bell(x, 0.112) * bell(y - 0.273, 0.022)
        ear = bell(np.abs(x) - 0.49, 0.085) * bell(y - 0.48, 0.16) * bell(z + 0.01, 0.14)
        variation = (np.sin(x * 47 + np.sin(y * 13)) * np.sin(y * 59 + z * 17)) * 0.5 + 0.5
        masks = {'TZone': t_zone, 'Nose': nose, 'Cheeks': cheek, 'Lips': lips, 'Ears': ear,
                 'Variation': variation}
        controls = {'Base roughness': 0.68, 'T-zone smoothing': -0.095,
                    'Nose smoothing': -0.075, 'Dry cheek contrast': 0.035,
                    'Lip smoothing': -0.09, 'Ear contrast': 0.012,
                    'Surface variation': 0.012}
        terms = [('TZone', 'T-zone smoothing'), ('Nose', 'Nose smoothing'),
                 ('Cheeks', 'Dry cheek contrast'), ('Lips', 'Lip smoothing'),
                 ('Ears', 'Ear contrast'), ('Variation', 'Surface variation')]
    else:
        h = entry['dimensions']['height']
        original = values(high.data, 'game_heroSurface_0') / 255
        detail = values(high.data, 'game_heroSurface_1') / 255
        # The saved complete finish tuple distinguishes cloth, belt, boot,
        # rubber and buttons. Subdivision blends only actual shared boundaries.
        low_detail = 1 - smooth((detail - 0.15) / 0.45)
        buttons = low_detail * (y > 0.61 * h) * (np.abs(x) < 0.05 * h)
        leather = (1 - smooth((original - 0.72) / 0.08)) * low_detail * (1 - buttons)
        soles = smooth((original - 0.89) / 0.06) * low_detail * (y < 0.11 * h)
        boot = leather * (y < 0.11 * h)
        belt = leather * (1 - (y < 0.11 * h))
        cloth = np.clip(1 - leather - soles - buttons, 0, 1)
        trousers = cloth * (1 - smooth((y / h - 0.548) / 0.027)) * (np.abs(x) < 0.18 * h)
        _, along, _, _, _, sleeve = _arm_frame(p, entry['dimensions'])
        cuff = bell(along - 0.91, 0.075) * sleeve
        knee = bell(y - entry['dimensions']['kneeY'], h * 0.045) * smooth(z / (h * 0.035)) * trousers
        pocket_edge = bell(x + 0.060, 0.070) * bell(y / h - 0.723, 0.018) * smooth(z / (h * 0.04))
        wear = np.clip(np.maximum.reduce([cuff, knee, pocket_edge]), 0, 1) * cloth
        toe = boot * smooth((z - 0.035) / 0.08) * bell(y / h - 0.040, 0.028)
        # Quiet aggregate yarn/grain variation, below 1% roughness amplitude;
        # existing sculpt normals carry fine relief. No fabricated illumination.
        variation = (np.sin(x * 65 + y * 17) * np.sin(y * 73 + z * 41)) * 0.5 + 0.5
        masks = {'Trousers': trousers, 'BootLeather': boot, 'BeltLeather': belt,
                 'RubberSoles': soles, 'Buttons': buttons, 'ContactWear': wear,
                 'PolishedToe': toe, 'Variation': variation}
        controls = {'Base roughness': 0.89, 'Trouser contrast': -0.05,
                    'Boot leather contrast': -0.255, 'Belt leather contrast': -0.215,
                    'Rubber sole contrast': 0.06, 'Button contrast': -0.27,
                    'Cloth contact polish': -0.022, 'Toe contact polish': -0.035,
                    'Surface variation': 0.008}
        terms = [('Trousers', 'Trouser contrast'), ('BootLeather', 'Boot leather contrast'),
                 ('BeltLeather', 'Belt leather contrast'), ('RubberSoles', 'Rubber sole contrast'),
                 ('Buttons', 'Button contrast'), ('ContactWear', 'Cloth contact polish'),
                 ('PolishedToe', 'Toe contact polish'), ('Variation', 'Surface variation')]
    for name, mask in masks.items():
        name = 'Finish_' + name
        previous = high.data.color_attributes.get(name)
        if previous:
            high.data.color_attributes.remove(previous)
        attribute = high.data.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
        rgba = np.ones((len(p), 4), dtype=np.float32)
        rgba[:, :3] = np.asarray(mask)[:, None]
        attribute.data.foreach_set('color', rgba.ravel())

    material = bpy.data.materials.new(f'Gunman {part} region roughness {REVISION}')
    material.use_nodes = True
    high.data.materials.clear()
    high.data.materials.append(material)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get('Principled BSDF')
    shader.location = (700, 0)
    values_nodes = {}
    for i, (name, value) in enumerate(controls.items()):
        node = nodes.new('ShaderNodeValue')
        node.name = node.label = name
        node.outputs[0].default_value = value
        node.location = (-800, -i * 160)
        values_nodes[name] = node
    current = values_nodes['Base roughness'].outputs[0]
    for i, (mask, control) in enumerate(terms):
        attribute = nodes.new('ShaderNodeAttribute')
        attribute.attribute_name = 'Finish_' + mask
        attribute.name = attribute.label = f'Paint: {mask}'
        attribute.location = (-1100, -i * 160 - 180)
        multiply = nodes.new('ShaderNodeMath')
        multiply.operation = 'MULTIPLY'
        multiply.location = (-540, -i * 160 - 180)
        links.new(attribute.outputs['Fac'], multiply.inputs[0])
        links.new(values_nodes[control].outputs[0], multiply.inputs[1])
        add = nodes.new('ShaderNodeMath')
        add.operation = 'ADD'
        add.location = (-280 + i * 75, -i * 160)
        links.new(current, add.inputs[0])
        links.new(multiply.outputs[0], add.inputs[1])
        current = add.outputs[0]
    clamp = nodes.new('ShaderNodeClamp')
    clamp.inputs['Min'].default_value = 0.35
    clamp.inputs['Max'].default_value = 0.98
    clamp.location = (500, -200)
    links.new(current, clamp.inputs['Value'])
    links.new(clamp.outputs[0], shader.inputs['Roughness'])
    high['material_finish_revision'] = REVISION
    high['material_finish_controls'] = json.dumps(controls, separators=(',', ':'))
    predicted = np.full(len(p), controls['Base roughness'])
    for mask, control in terms:
        predicted += masks[mask] * controls[control]
    return {'master': high.name, 'controls': controls,
            'masks': {name: {'mean': float(np.mean(mask)), 'maximum': float(np.max(mask))} for name, mask in masks.items()},
            'predictedRoughness': {'minimum': float(np.min(predicted)), 'maximum': float(np.max(predicted)),
                                   'mean': float(np.mean(predicted))}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'assets/blender/characters.blend')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/blender-material-realism-2026-09-04/character-candidate')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    source, output = args.source.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    collection = bpy.data.collections['gunman']
    entry = json.loads(collection['game_entry'])
    objects = {obj['game_surface']: obj for obj in collection.objects if 'game_surface' in obj}
    reports = {}
    for part in ('garments', 'head'):
        high = next(obj for obj in bpy.data.collections['GUNMAN_SCULPT_MASTERS'].objects if obj.get('master_for') == objects[part].name)
        reports[part] = author_masks(part, high, entry)
    entry['materialFinish'] = {'revision': REVISION, 'source': 'tools/blender/character_material_finish.py',
                               'provenance': 'Original artist-authored material regions and anatomical roughness; no generated image, lighting, geometry or normal change',
                               'editable': 'Dense-master Finish_* grayscale point color attributes and labeled material Value controls; roughness-only rebake preserves edits'}
    collection['game_entry'] = json.dumps(entry, separators=(',', ':'))
    notes = bpy.data.texts.get('GUNMAN_MATERIAL_FINISH_README') or bpy.data.texts.new('GUNMAN_MATERIAL_FINISH_README')
    notes.clear()
    notes.write(__doc__ + '\n\n' + json.dumps(reports, indent=2))
    candidate = output / 'characters.blend'
    rebake_saved(candidate, output, roughness_only=True)
    spec = importlib.util.spec_from_file_location('character_builder', Path(__file__).with_name('build-characters.py'))
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    builder.SOURCE, builder.OUTPUT = candidate, output
    builder.export()
    report = {'revision': REVISION, 'sourceSha256': source_hash, 'parts': reports,
              'files': {path.name: {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                        for path in output.iterdir() if path.suffix in ('.blend', '.png', '.bin', '.json')}}
    (output / 'material-authoring.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
