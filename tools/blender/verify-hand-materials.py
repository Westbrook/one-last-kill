"""Verify saved hand material exports/rebakes in an isolated output directory.

Blender --background path/to/hands.blend --python tools/blender/verify-hand-materials.py -- \
  --mode export --reference path/to/candidate --output path/to/isolated-export
Use --mode bake-color to reproduce albedo and roughness from saved paint. This
does not change the opened .blend or publish runtime assets.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

import bpy

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['export', 'bake-color'], required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    output, reference = Path(args.output).resolve(), Path(args.reference).resolve()
    if output == reference or output == ROOT / 'public/assets/models/hands':
        raise ValueError('Verification must use a separate output directory')
    output.mkdir(parents=True, exist_ok=True)
    builder = ROOT / 'tools/blender/build-hands.py'
    namespace = {'__file__': str(builder), '__name__': 'hand_builder_api'}
    exec(compile(builder.read_text().split('\narguments = sys.argv')[0], str(builder), 'exec'), namespace)
    namespace['OUTPUT'] = output
    if args.mode == 'bake-color':
        namespace['bake_finish'](('albedo', 'roughness'))
        namespace['neutral_atlas_padding'](('albedo', 'roughness'))
        namespace['export_packed_finish'](force_save=True, suffixes=('albedo', 'roughness'))
    else:
        namespace['export_packed_finish']()
    namespace['export_pack'](json.loads(bpy.context.scene.get('hand_pack_refinements', '[]')))
    results = []
    for name in ['hands.bin', 'hand-albedo.png', 'hand-normal.png', 'hand-roughness.png']:
        actual, expected = (output / name).read_bytes(), (reference / name).read_bytes()
        results.append({'file': name, 'byteIdentical': actual == expected,
                        'actualSHA256': hashlib.sha256(actual).hexdigest(),
                        'expectedSHA256': hashlib.sha256(expected).hexdigest()})
    manifest = json.loads((output / 'manifest.json').read_text())
    previous = json.loads((reference / 'manifest.json').read_text())
    retained_source = manifest['bake'].get('generatedMaterials') == previous['bake'].get('generatedMaterials')
    report = {'mode': args.mode, 'savedSource': bpy.data.filepath, 'sourceProvenanceRetained': retained_source,
              'allByteIdentical': all(item['byteIdentical'] for item in results), 'files': results}
    (output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    if not report['allByteIdentical'] or not retained_source:
        raise ValueError('Saved hand material round-trip did not reproduce its accepted output')


if __name__ == '__main__':
    main()
