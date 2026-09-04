"""Saved-source held-catalog export and offline finish updates.

The production mesh, material identities, UVs and tint paint are authoritative in
weapons.blend. This module never regenerates them. Studio visibility is restored
before saving, and accepted image bytes are explicitly packed before GLB export.
"""
from pathlib import Path
import hashlib
import json
import struct

import bpy

ROOT = Path(__file__).resolve().parents[2]
TYPES = ('knife', 'shotgun', 'smg', 'machinegun')
BUDGETS = {'knife': 1142, 'shotgun': 5484, 'smg': 4784, 'machinegun': 5484}
IMAGE_NAMES = tuple('weapons-' + family + '-' + channel for family in ('nonmetal', 'steel')
                    for channel in ('basecolor', 'metalrough', 'normal'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def project_path(path):
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(Path(path).resolve())


def unpack_glb(blob):
    document = json.loads(blob[20:20 + struct.unpack_from('<I', blob, 12)[0]])
    offset = 20 + struct.unpack_from('<I', blob, 12)[0]
    assert struct.unpack_from('<I', blob, offset + 4)[0] == 0x004e4942
    return document, blob[offset + 8:]


def save_images(directory):
    """Use each saved image as authority; dirty paint wins over old packed data."""
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for name in IMAGE_NAMES:
        image = bpy.data.images.get(name)
        assert image is not None, 'Missing source image ' + name
        assert tuple(image.size) == (256, 256), (name, tuple(image.size))
        expected_space = 'sRGB' if name.endswith('basecolor') else 'Non-Color'
        assert image.colorspace_settings.name == expected_space, (name, image.colorspace_settings.name)
        target = directory / (name + '.png')
        if image.is_dirty:
            image.filepath_raw = str(target)
            image.file_format = 'PNG'
            image.save()
            payload = target.read_bytes()
        elif image.packed_file:
            payload = bytes(image.packed_file.data)
            target.write_bytes(payload)
        else:
            original = Path(bpy.path.abspath(image.filepath_raw))
            payload = original.read_bytes()
            target.write_bytes(payload)
        assert payload[:8] == b'\x89PNG\r\n\x1a\n', name
        image.filepath_raw = str(target)
        image.pack(data=payload, data_len=len(payload))
        records.append({'path': project_path(target), 'width': 256, 'height': 256,
                        'bytes': len(payload), 'sha256': digest(payload)})
    return records


def export_existing(options):
    source_file = options.source_file.resolve()
    bpy.ops.wm.open_mainfile(filepath=str(source_file))
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    roots = {kind: bpy.data.objects.get('vm_' + kind) for kind in TYPES}
    assert all(roots.values()), 'Source must contain all four named vm_* roots'
    parts = {kind: [obj for obj in root.children_recursive if obj.type == 'MESH'] for kind, root in roots.items()}
    for kind, group in parts.items():
        assert group, kind
        for obj in group:
            assert len(obj.data.materials) == 1, obj.name
            assert obj.data.uv_layers.active is not None, obj.name
            assert 'FinishTint' in obj.data.color_attributes, obj.name
    profile = None
    if options.refresh_materials:
        from weapon_material_profiles import apply_profile
        profile = json.loads(options.refresh_materials.read_text())
        apply_profile(profile, options.texture_dir.resolve())
        scene['weaponFinishAuthoring'] = json.dumps(profile, sort_keys=True)
    textures = save_images(options.texture_dir.resolve())
    remembered = [(obj, obj.hide_get(), obj.hide_viewport, obj.hide_render, obj.select_get())
                  for obj in list(roots.values()) + [part for group in parts.values() for part in group]]
    bpy.ops.object.select_all(action='DESELECT')
    for obj, *_ in remembered:
        obj.hide_set(False); obj.hide_viewport = False; obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = roots['smg']
    options.output_dir.mkdir(parents=True, exist_ok=True)
    output = options.output_dir.resolve() / 'weapons.glb'
    authoring_metadata = {key: scene[key] for key in ('catalogEditing', 'weaponFinishAuthoring') if key in scene}
    for key in authoring_metadata:
        del scene[key]
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True,
        export_yup=True, export_extras=True, export_animations=False, export_cameras=False,
        export_lights=False, export_materials='EXPORT', export_texcoords=True,
        export_normals=True, export_tangents=False, export_all_vertex_colors=False,
        export_vertex_color='NAME', export_vertex_color_name='FinishTint',
        export_image_format='AUTO', export_apply=True)
    for key, value in authoring_metadata.items():
        scene[key] = value
    for obj, hidden, viewport, render, selected in remembered:
        obj.hide_set(hidden); obj.hide_viewport = viewport; obj.hide_render = render
        obj.select_set(selected)
    if options.source_output:
        options.source_output.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(options.source_output.resolve()))
    elif options.refresh_materials:
        bpy.ops.wm.save_as_mainfile(filepath=str(source_file))
    blob = output.read_bytes()
    document, binary = unpack_glb(blob)
    assert len(document['images']) == 6 and len(document['materials']) == 3
    embedded = []
    for image in document['images']:
        view = document['bufferViews'][image['bufferView']]
        data = binary[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        dimensions = struct.unpack_from('>II', data, 16)
        assert dimensions == (256, 256), (image['name'], dimensions)
        embedded.append({'name': image['name'], 'width': dimensions[0], 'height': dimensions[1],
                         'bytes': len(data), 'sha256': digest(data)})
        saved = next(item for item in textures if Path(item['path']).stem == image['name'])
        assert saved['sha256'] == digest(data), 'Packed source and embedded output disagree: ' + image['name']
    manifest = json.loads((ROOT / 'public/assets/models/weapons/manifest.json').read_text())
    for kind in TYPES:
        node = next(node for node in document['nodes'] if node.get('name') == 'vm_' + kind)
        children = [document['nodes'][i] for i in node['children']]
        primitives = [primitive for child in children for primitive in document['meshes'][child['mesh']]['primitives']]
        triangles = sum(document['accessors'][primitive['indices']]['count'] // 3 for primitive in primitives)
        bounds = [document['accessors'][primitive['attributes']['POSITION']] for primitive in primitives]
        assert triangles <= BUDGETS[kind], kind
        manifest['weapons'][kind]['geometry'] = {
            'triangles': triangles,
            'exportedVertices': sum(bound['count'] for bound in bounds),
            'meshParts': len(children), 'materialGroups': len({p['material'] for p in primitives}),
            'budgetTriangles': BUDGETS[kind],
        }
        manifest['weapons'][kind]['bounds'] = {
            'min': [min(bound['min'][axis] for bound in bounds) for axis in range(3)],
            'max': [max(bound['max'][axis] for bound in bounds) for axis in range(3)],
        }
        manifest['weapons'][kind]['heroWeapon'] = node['extras']['heroWeapon']
    manifest['authoringTool'] = bpy.app.version_string
    manifest['exportExisting'] = 'tools/blender/build-weapons.py -- --export-existing'
    manifest['materialAuthoring'] = json.loads(scene['weaponFinishAuthoring']) if 'weaponFinishAuthoring' in scene else None
    if manifest['materialAuthoring']:
        manifest['license'] = ('Original project profiles and authored procedural metal/polymer finishes; '
                               'locally generated walnut diffuse source with recorded prompt and provenance.')
        manifest['notes'] = [note for note in manifest['notes'] if not note.startswith('Saved-source material refinement:')]
        manifest['notes'].append('Saved-source material refinement: generated walnut diffuse pigmentation, authored matched '
                                 'metal/polymer microfinish, and independent subtle sealed-wood pores. Six 256px images, '
                                 'existing UVs, geometry, tint paint, material identities, and shader paths are preserved.')
    manifest['geometry'] = {'triangles': sum(w['geometry']['triangles'] for w in manifest['weapons'].values()),
                            'materialGroups': len(document['materials'])}
    manifest['delivery'] = {'glbBytes': len(blob), 'sha256': digest(blob), 'embeddedImages': len(embedded),
                           'textureRgba8BytesWithMipmapsEstimate': sum(i['width'] * i['height'] for i in embedded) * 4 * 4 // 3,
                           'runtimeExternalDependencies': []}
    manifest['textures'] = textures
    manifest['embeddedImages'] = embedded
    manifest['sourceFileSha256'] = digest((options.source_output or source_file).read_bytes())
    (options.output_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('WEAPONS_SAVED_SOURCE_EXPORT', json.dumps({'delivery': manifest['delivery'], 'geometry': manifest['geometry']}))
