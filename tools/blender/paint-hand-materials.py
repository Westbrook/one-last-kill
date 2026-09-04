"""Project generated flat material sources into the saved hand sculpt's paint.

This is an offline source-authoring step. It changes POINT color/roughness
attributes and two baked maps, never production geometry, UVs or tangent normals.
The output is staged by default; review it in the game before publishing.

Blender --background assets/blender/hands.blend --python tools/blender/paint-hand-materials.py -- \
  --skin path/to/skin.png --leather path/to/leather.png --output artifacts/hand-material-candidate
Optional crop arguments are left,bottom,right,top fractions in each source image.
"""
import argparse
from array import array
import hashlib
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
NORMAL_SHA = 'f6a3a5b9274663103a715a3fe2723664bb448498d2055d4d86db14379a2c4bc6'
GEOMETRY_SHA = 'c7b5cf4d53eaf5113589660d05396eb689f2d13942565c7fb5876fb5660e655e'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def smooth(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def band(value, center, width):
    return np.exp(-((value - center) / width) ** 2)


def crop_arg(value):
    result = tuple(float(item) for item in value.split(','))
    if len(result) != 4 or not 0 <= result[0] < result[2] <= 1 or not 0 <= result[1] < result[3] <= 1:
        raise argparse.ArgumentTypeError('Crop must be left,bottom,right,top fractions')
    return result


class MaterialSource:
    def __init__(self, path, name, crop):
        path = Path(path).resolve()
        self.image = bpy.data.images.load(str(path), check_existing=False)
        self.image.name = 'SOURCE_Generated_' + name
        # Explicit raw sRGB read followed by a single linear conversion avoids
        # letting a source preview's display transform enter sculpt paint.
        self.image.colorspace_settings.name = 'Non-Color'
        width, height = self.image.size
        rgba = np.empty(width * height * 4, dtype=np.float32)
        self.image.pixels.foreach_get(rgba)
        rgba = rgba.reshape(height, width, 4)
        left, bottom, right, top = crop
        rgb = rgba[int(bottom * height):int(top * height), int(left * width):int(right * width), :3]
        if min(rgb.shape[:2]) < 64:
            raise ValueError('Generated material crop is too small')
        self.pixels = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
        self.reference = np.median(self.pixels.reshape(-1, 3), axis=0)
        if np.min(self.reference) < .001:
            raise ValueError('Generated material source is too dark to use as diffuse variation')
        self.image.colorspace_settings.name = 'sRGB'
        self.image.pack()
        self.image.use_fake_user = True
        self.metadata = {'file': str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
                         'sha256': sha(path.read_bytes()), 'width': width, 'height': height,
                         'cropLeftBottomRightTop': list(crop), 'packedImage': self.image.name,
                         'linearMedian': self.reference.tolist()}

    def sample(self, u, v):
        height, width = self.pixels.shape[:2]
        x = np.clip(u, 0, 1) * (width - 1)
        y = np.clip(v, 0, 1) * (height - 1)
        xi, yi = x.astype(int), y.astype(int)
        tx, ty = (x - xi)[:, None], (y - yi)[:, None]
        xj, yj = np.minimum(xi + 1, width - 1), np.minimum(yi + 1, height - 1)
        return ((1 - ty) * ((1 - tx) * self.pixels[yi, xi] + tx * self.pixels[yi, xj])
                + ty * ((1 - tx) * self.pixels[yj, xi] + tx * self.pixels[yj, xj]))


def point_colors(mesh, name):
    attr = mesh.color_attributes.get(name)
    if attr is None or attr.domain != 'POINT':
        raise ValueError(name + ' must be a saved POINT color attribute')
    values = np.empty(len(mesh.vertices) * 4, dtype=np.float32)
    attr.data.foreach_get('color', values)
    return attr, values.reshape(-1, 4)


def install_paint(skin_source, leather_source):
    master = bpy.data.objects.get('SCULPT_Atlas_Master')
    if master is None:
        raise ValueError('The accepted SCULPT_Atlas_Master is required')
    mesh = master.data
    albedo_attribute, color = point_colors(mesh, 'SculptAlbedo')
    roughness_attribute, rough = point_colors(mesh, 'SculptRoughness')
    # Keep the saved artist paint as an editable, reversible base layer. Repeat
    # projection starts here rather than compounding previously generated color.
    for name, values in [('MaterialBaseAlbedo', color), ('MaterialBaseRoughness', rough)]:
        if mesh.color_attributes.get(name) is None:
            attr = mesh.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
            attr.data.foreach_set('color', values.reshape(-1))
    _, color = point_colors(mesh, 'MaterialBaseAlbedo')
    _, rough = point_colors(mesh, 'MaterialBaseRoughness')
    before_color, before_rough = color.copy(), rough.copy()
    uv = np.zeros((len(mesh.vertices), 2))
    seen = np.zeros(len(mesh.vertices), dtype=bool)
    for loop in mesh.loops:
        if not seen[loop.vertex_index]:
            uv[loop.vertex_index] = mesh.uv_layers.active.data[loop.index].uv
            seen[loop.vertex_index] = True
    u, v = uv.T
    skin = v < .5
    thumb = skin & (u > .70) & (v > .16)
    wrist = skin & (u > .70) & (v < .16)
    a = (u - .038) / .632
    t = .22 + (v - .038) / .417 * .78
    a[thumb | wrist] = (u[thumb | wrist] - .725) / .235
    t[thumb] = .30 + (v[thumb] - .18) / .275 * .70
    t[wrist] = (v[wrist] - .038) / .105 * .30
    dorsal_u = np.where(thumb, .5, .25)
    distance = np.abs(np.mod(a, 1) - dorsal_u)
    distance = np.minimum(distance, 1 - distance)
    dorsal = np.exp(-(distance / .16) ** 4)
    qx, qy = distance - .074, np.abs(t - .885) - .039
    nail_distance = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - .020
    nail = (1 - smooth((nail_distance + .002) / .006)) * ~wrist
    cuticle = band(nail_distance, .001, .005) * ~wrist

    # Angular-seam and tile-border fades retain compatible POINT values at
    # welded boundaries. The detail remains strongest across visible surfaces.
    skin_uv_v = np.where(thumb, (v - .18) / .275, np.where(wrist, (v - .038) / .105, (v - .038) / .417))
    skin_fade = smooth(a / .065) * smooth((1 - a) / .065)
    skin_fade *= smooth(skin_uv_v / .035) * smooth((1 - skin_uv_v) / .035)
    sampled = skin_source.sample(.04 + .92 * np.clip(a, 0, 1), .04 + .92 * np.clip(skin_uv_v, 0, 1))
    relative = np.clip((sampled / skin_source.reference) ** .72, .72, 1.23)
    weight = skin_fade * (1 - nail * .96) * skin
    color[:, :3] *= 1 + (relative - 1) * weight[:, None]
    # Coherent anatomical pigmentation and contact finish accompany the diffuse
    # sample; these masks follow the retained nail, joint and glove geometry.
    joint = (band(t, .43, .065) + band(t, .70, .06)) * dorsal * skin * (1 - nail)
    color[:, 0] += .010 * joint
    color[:, 1] -= .007 * joint
    color[:, 2] -= .008 * joint
    color[:, 0] += .007 * cuticle * skin
    color[:, 1] -= .005 * cuticle * skin
    luminance = np.sum((relative - 1) * np.array([.2126, .7152, .0722]), axis=1)
    rough[:, :3] += (-.07 * luminance * weight + .012 * joint)[:, None]

    glove = ~skin
    palm = glove & (u < .70)
    glove_a = np.where(palm, (u - .038) / .632, (u - np.where(u > .845, .855, .725)) / .105)
    glove_t = np.where(palm, (v - .555) / .408, (v - .645) / .31)
    glove_fade = smooth(glove_a / .065) * smooth((1 - glove_a) / .065)
    glove_fade *= smooth(glove_t / .06) * smooth((1 - glove_t) / .06)
    sampled = leather_source.sample(.035 + .93 * np.clip(glove_a, 0, 1), .035 + .93 * np.clip(glove_t, 0, 1))
    relative = np.clip((sampled / leather_source.reference) ** .82, .60, 1.52)
    # Preserve the sewn panel and stitches already in base paint. Wear grows
    # around the dorsal panel shoulders and folded opening, not arbitrary noise.
    width = .102 + .034 * smooth(glove_t)
    qx, qy = np.abs(glove_a - .25) - width, np.abs(glove_t - .56) - .31
    panel_distance = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - .019
    panel = (1 - smooth((panel_distance + .002) / .008)) * palm
    edge_wear = band(panel_distance, -.045, .022) * palm
    binding_wear = band(glove_t, .86, .06) * (~palm) * glove
    wear = edge_wear * .70 + binding_wear * .45
    weight = glove * glove_fade * (.55 + .45 * panel)
    color[:, :3] *= 1 + (relative - 1) * weight[:, None]
    color[:, :3] += (wear * glove_fade)[:, None] * np.array([.010, .009, .005])
    grain = np.sum((relative - 1) * np.array([.2126, .7152, .0722]), axis=1)
    rough[:, :3] += (-.11 * grain * weight - .065 * wear * glove_fade)[:, None]
    color[:, :3] = np.clip(color[:, :3], .008, .85)
    rough[:, :3] = np.clip(rough[:, :3], .38, .97)
    albedo_attribute.data.foreach_set('color', color.reshape(-1))
    roughness_attribute.data.foreach_set('color', rough.reshape(-1))
    mesh.update()
    return {'masterVertices': len(mesh.vertices), 'changedAlbedoVertices': int(np.sum(np.max(abs(color - before_color), axis=1) > 1e-5)),
            'changedRoughnessVertices': int(np.sum(np.max(abs(rough - before_rough), axis=1) > 1e-5)),
            'roughnessRange': [float(rough[:, 1].min()), float(rough[:, 1].max())],
            'albedoAttributeSHA256': sha(color.astype('<f4').tobytes()),
            'roughnessAttributeSHA256': sha(rough.astype('<f4').tobytes())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--skin', required=True)
    parser.add_argument('--leather', required=True)
    parser.add_argument('--skin-crop', type=crop_arg, default=(0, 0, 1, 1))
    parser.add_argument('--leather-crop', type=crop_arg, default=(0, 0, 1, 1))
    parser.add_argument('--output', required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    output = Path(args.output).resolve()
    if output == ROOT / 'public/assets/models/hands':
        raise ValueError('Stage the pilot for review before publishing runtime maps')
    output.mkdir(parents=True, exist_ok=True)
    normal = bpy.data.images.get('hand-normal')
    if normal is None or not normal.packed_file or sha(bytes(normal.packed_file.data)) != NORMAL_SHA:
        raise ValueError('Start from the accepted saved normal bake')
    skin = MaterialSource(args.skin, 'Skin', args.skin_crop)
    leather = MaterialSource(args.leather, 'Leather', args.leather_crop)
    metrics = install_paint(skin, leather)
    provenance = {'version': 1, 'id': 'generated-hand-materials-v1', 'method': 'Generated flat diffuse material samples projected offline into saved POINT SculptAlbedo; paired authored regional roughness in SculptRoughness; existing sculpt tangent normal retained',
                  'sources': {'skin': skin.metadata, 'leather': leather.metadata}, 'paint': metrics,
                  'retainedGeometrySHA256': GEOMETRY_SHA, 'retainedNormalSHA256': NORMAL_SHA,
                  'runtime': {'maps': 3, 'size': 512, 'extraDrawCalls': 0, 'extraShaderSamples': 0, 'extraTextureAllocationBytes': 0},
                  'limitations': 'Generated diffuse samples are art sources rather than measured reflectance; color variation is palette-normalized and seam-tapered; four fingers and mirrored grips intentionally share the same atlas.'}
    bpy.context.scene['hand_material_provenance'] = json.dumps(provenance)
    builder = ROOT / 'tools/blender/build-hands.py'
    namespace = {'__file__': str(builder), '__name__': 'hand_builder_api'}
    exec(compile(builder.read_text().split('\narguments = sys.argv')[0], str(builder), 'exec'), namespace)
    namespace['OUTPUT'] = output
    namespace['bake_finish'](('albedo', 'roughness'))
    namespace['neutral_atlas_padding'](('albedo', 'roughness'))
    namespace['export_packed_finish'](force_save=True, suffixes=('albedo', 'roughness'))
    namespace['configure_review_source']()
    namespace['export_pack'](json.loads(bpy.context.scene.get('hand_pack_refinements', '[]')))
    if sha((output / 'hands.bin').read_bytes()) != GEOMETRY_SHA:
        raise ValueError('Material projection changed runtime geometry')
    if sha((output / 'hand-normal.png').read_bytes()) != NORMAL_SHA:
        raise ValueError('Material projection changed the accepted tangent normal')
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'hands.blend'))
    provenance['stagedFiles'] = [{'file': name, 'bytes': len((output / name).read_bytes()), 'sha256': sha((output / name).read_bytes())}
                                  for name in ['hands.blend', 'hands.bin', 'hand-albedo.png', 'hand-roughness.png', 'hand-normal.png', 'manifest.json']]
    (output / 'material-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(provenance, indent=2), flush=True)


if __name__ == '__main__':
    main()
