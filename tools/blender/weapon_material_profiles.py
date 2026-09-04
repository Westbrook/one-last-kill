"""Offline finish authoring for the saved weapon catalog, never runtime noise.

The generated walnut image supplies diffuse pigmentation only. Independent,
restrained authored pores supply wood microrelief; no image luminance is treated
as geometric height. Steel brushing and polymer grain use matched height and
roughness at the existing 256px delivery size.
"""
from pathlib import Path
import hashlib
import math

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SIZE = 256


def noise(width, height, cells_x, cells_y, seed):
    rng = np.random.default_rng(seed)
    grid = rng.random((cells_y, cells_x)) - .5
    x = np.arange(width) / width * cells_x
    y = np.arange(height) / height * cells_y
    ix, iy = x.astype(int), y.astype(int)
    tx, ty = x - ix, y - iy
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    a, b = grid[iy[:, None] % cells_y, ix[None, :] % cells_x], grid[iy[:, None] % cells_y, (ix[None, :] + 1) % cells_x]
    c, d = grid[(iy[:, None] + 1) % cells_y, ix[None, :] % cells_x], grid[(iy[:, None] + 1) % cells_y, (ix[None, :] + 1) % cells_x]
    return a + (b-a)*tx[None, :] + (c-a)*ty[:, None] + (a-b-c+d)*tx[None, :]*ty[:, None]


def centered(values):
    return values - values.mean(axis=(0, 1), keepdims=True)


def normal_from_height(height, repeat):
    if repeat:
        dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * .35
        dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * .35
    else:
        dy, dx = np.gradient(height)
        dx *= .7; dy *= .7
    normal = np.stack((-dx, -dy, np.ones_like(height)), axis=2)
    normal /= np.linalg.norm(normal, axis=2)[:, :, None]
    return normal*.5 + .5


def padded_regions(wood, polymer):
    """Dilate each existing chart's edge through its gutter, including normals."""
    result = np.empty((SIZE, SIZE) + wood.shape[2:])
    for data, y0, y1, fill0, fill1 in ((wood, 6, 121, 0, 128), (polymer, 137, 250, 128, 256)):
        target_y = np.clip(np.arange(fill0, fill1), y0, y1-1)
        target_x = np.clip(np.arange(SIZE), 6, 249)
        result[fill0:fill1] = data[target_y[:, None], target_x[None, :]]
    return result


def source_pixels(image):
    w, h = image.size
    pixels = np.empty(w*h*4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(h, w, 4)


def walnut_source(profile):
    path = ROOT / profile['woodSource']
    payload = path.read_bytes()
    assert hashlib.sha256(payload).hexdigest() == profile['woodSourceSha256'], 'Walnut source hash mismatch'
    name = 'AUTHORING_Walnut_Diffuse_Source'
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    source = bpy.data.images.load(str(path), check_existing=False)
    source.name = name; source.colorspace_settings.name = 'sRGB'
    source.use_fake_user = True; source.pack(data=payload, data_len=len(payload))
    source['purpose'] = 'Diffuse pigment source only; no source luminance becomes surface height.'
    # Scale a disposable image copy with Blender's image resampler. The full
    # source stays packed for future painting/rebaking without a download.
    copy = source.copy(); copy.scale(244, 115)
    pixels = source_pixels(copy)[:, :, :3]
    bpy.data.images.remove(copy)
    normalized = np.clip(pixels / np.maximum(.01, pixels.mean(axis=(0, 1))), .68, 1.32)
    normalized = 1 + centered(normalized) * profile['woodColorVariation']
    wood = np.empty((SIZE, SIZE, 3))
    wood[6:121, 6:250] = np.array(profile['woodPaletteSrgb']) * normalized
    # The selected chart region is subsequently dilated into all unused texels.
    return wood


def write_image(name, rgb, folder):
    image = bpy.data.images.get(name)
    assert image is not None and tuple(image.size) == (SIZE, SIZE), name
    rgba = np.ones((SIZE, SIZE, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(rgb, 0, 1)
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = str(folder / (name + '.png'))
    image.file_format = 'PNG'
    image.save()
    payload = Path(image.filepath_raw).read_bytes()
    image.pack(data=payload, data_len=len(payload))


def apply_profile(profile, folder):
    assert profile['version'] == 1
    folder.mkdir(parents=True, exist_ok=True)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    u, v = xx/SIZE, yy/SIZE
    broad = noise(SIZE, SIZE, 5, 5, 417)
    fine = noise(SIZE, SIZE, 73, 73, 901)
    # Long, shallow machining tracks at 80mm/tile. An irregular low-amplitude
    # phase avoids obvious regular lines, while roughness carries most detail.
    phase = v*math.tau*67 + noise(SIZE, SIZE, 3, 9, 511)*.7
    brush = np.sin(phase)
    rubbed = noise(SIZE, SIZE, 4, 6, 139)
    steel_tone = centered(broad)*.013 + centered(fine)*.010 + brush*.002
    steel = np.array(profile['steelPaletteSrgb']) + steel_tone[:, :, None]
    steel_rough = profile['steelRoughness'] + centered(broad)*.15 - centered(rubbed)*.13 + centered(fine)*.027 + brush*.008
    steel_height = fine*.022 + brush*.012
    steel_mr = np.ones((SIZE, SIZE, 3)); steel_mr[:, :, 1] = np.clip(steel_rough, .27, .59); steel_mr[:, :, 2] = profile['steelMetallic']
    write_image('weapons-steel-basecolor', steel, folder)
    write_image('weapons-steel-metalrough', steel_mr, folder)
    write_image('weapons-steel-normal', normal_from_height(steel_height, True), folder)
    # Molded grain is irregular; no checkerboard/checkering is painted on top
    # of geometry that already models the large grip features.
    polymer_grain = noise(SIZE, SIZE, 61, 43, 781)
    polymer_wear = noise(SIZE, SIZE, 5, 4, 353)
    polymer = np.array(profile['polymerPaletteSrgb']) + (centered(polymer_grain)*.021 + centered(polymer_wear)*.013)[:, :, None]
    polymer_rough = profile['polymerRoughness'] + centered(polymer_grain)*.075 - centered(polymer_wear)*.10
    polymer_height = polymer_grain*.072 + fine*.020
    wood = walnut_source(profile)
    # Subtle pores independent of the generated pigmentation. This is a sealed
    # walnut finish, so pore relief stays smaller than molded polymer grain.
    pore = noise(SIZE, SIZE, 11, 91, 1289)
    wood_polish = noise(SIZE, SIZE, 6, 5, 1283)
    wood_rough = profile['woodRoughness'] + centered(wood_polish)*.13 + centered(pore)*.045
    wood_height = pore*.022
    nonmetal_mr = np.ones((SIZE, SIZE, 3)); nonmetal_mr[:, :, 2] = 0
    nonmetal_mr[:, :, 1] = np.clip(padded_regions(wood_rough, polymer_rough), .5, .94)
    nonmetal_normal = padded_regions(normal_from_height(wood_height, False), normal_from_height(polymer_height, False))
    write_image('weapons-nonmetal-basecolor', padded_regions(wood, polymer), folder)
    write_image('weapons-nonmetal-metalrough', nonmetal_mr, folder)
    write_image('weapons-nonmetal-normal', nonmetal_normal, folder)
