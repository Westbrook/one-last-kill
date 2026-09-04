"""Original gunman head remodeling and dense master relief, in normalized head space.

Broad forms live on the game mesh. Fine folds/pores are sculpt master geometry
that is projected through Blender's tangent-space normal bake, never albedo light.
"""
import numpy as np


def g(x, width):
    return np.exp(-((x / width) ** 2))


def smooth(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def remodel_head(position):
    p = np.asarray(position, dtype=float).copy()
    x, y, z = p.T.copy()
    front = smooth((z - 0.03) / 0.29)
    # A fuller chin and mandibular body replace the triangular lower mask.
    # The cheek stays broad through its soft tissue, without the sharp lateral
    # corner that previously read like a planar diamond under frontal light.
    lower = g(y - 0.16, 0.18)
    p[:, 0] += np.sign(x) * (0.044 * lower * g(abs(x) - 0.22, 0.21)
                            - 0.025 * g(y - 0.445, 0.08) * g(abs(x) - 0.40, 0.11))
    p[:, 2] += front * (0.022 * g(x, 0.19) * g(y - 0.09, 0.06)
                        + 0.041 * g(abs(x) - 0.23, 0.15) * g(y - 0.27, 0.11)
                        - 0.015 * g(abs(x) - 0.31, 0.08) * g(y - 0.42, 0.055))
    # Eyeballs sit under a continuous orbital ridge, rather than in round holes.
    # Avoid moving the attached opening itself: the adjacent brow/supraorbital
    # plane and lower orbit are remodeled together with the separate eyelids.
    eye = g(abs(x) - 0.175, 0.100)
    p[:, 2] += front * (-0.013 * eye * g(y - 0.554, 0.029)
                        + 0.025 * eye * g(y - 0.602, 0.035)
                        + 0.013 * g(abs(x) - 0.22, 0.11) * g(y - 0.503, 0.03)
                        + 0.014 * g(x, 0.067) * g(y - 0.604, 0.075))
    # Nose wings and bridge are separate planes; retain tip and lip landmarks
    # so the accepted projected colour still registers with these surfaces.
    p[:, 2] += front * (0.011 * g(abs(x) - 0.061, 0.026) * g(y - 0.384, 0.028)
                        - 0.009 * g(abs(x) - 0.096, 0.026) * g(y - 0.36, 0.05)
                        + 0.008 * g(x, 0.032) * g(y - 0.470, 0.085))
    # A shorter, rounder nasal tip replaces the long straight wedge. The
    # paired alae keep the nostril base broad while the supratip break separates
    # the bridge from the bulb; these are actual game-mesh silhouette changes.
    p[:, 2] += front * (-0.041 * g(x, 0.070) * g(y - 0.410, 0.055)
                        - 0.018 * g(x, 0.040) * g(y - 0.500, 0.056)
                        + 0.017 * g(abs(x) - 0.061, 0.031) * g(y - 0.388, 0.030))
    p[:, 1] += 0.011 * g(x, 0.068) * g(y - 0.410, 0.043) * front
    # Less tapered temple and a seated concha avoid a floating ear flap.
    side = 1 - smooth((z - 0.02) / 0.25)
    p[:, 0] += np.sign(x) * (0.008 * g(y - 0.60, 0.075) * g(abs(x) - 0.44, 0.065) * side)
    # The ear has a rolled helix around a recessed concha and a soft lobe,
    # modeled into the continuous head instead of leaving the inherited flap.
    ear_u, ear_v = (z + 0.020) / 0.063, (y - 0.496) / 0.110
    radius = np.sqrt(ear_u * ear_u + ear_v * ear_v)
    ear_mask = g(z + 0.020, 0.077) * g(y - 0.496, 0.145) * smooth((abs(x) - 0.430) / 0.035)
    ear_x = 0.457 + 0.057 * g(radius - 0.81, 0.21) - 0.020 * g(radius, 0.52)
    ear_x += 0.018 * g(radius - 0.43, 0.13) * smooth((z + 0.06) / 0.08)
    ear_x += 0.018 * g(y - 0.397, 0.025) * g(z + 0.010, 0.050)
    p[:, 0] = np.sign(x) * (abs(p[:, 0]) * (1 - ear_mask) + ear_x * ear_mask)
    return p


def smooth_head_features(position, index):
    p = np.asarray(position, dtype=float).copy()
    x, y, z = p.T.copy()
    sides = smooth((abs(x) - 0.30) / 0.12) * g(y - 0.43, 0.22)
    nose = g(x, 0.072) * g(y - 0.405, 0.085) * smooth((z - 0.32) / 0.18)
    ear = g(abs(x) - 0.49, 0.095) * g(y - 0.495, 0.14) * g(z + 0.02, 0.095)
    weight = np.maximum(sides * 0.55, nose * 0.28) * (1 - 0.98 * ear)
    links = [set() for _ in p]
    for a, b, c in index:
        links[a].update((b, c)); links[b].update((a, c)); links[c].update((a, b))
    for _ in range(3):
        q = p.copy()
        for i in np.flatnonzero(weight > 0.002):
            if links[i]:
                q[i] += (p[list(links[i])].mean(axis=0) - p[i]) * weight[i]
        p = q
    return p


def remodel_details(position, index, user_data, colors):
    """Seat existing facial submeshes on remodeled skin; reshape the eye opening."""
    old = np.asarray(position, dtype=float)
    p = remodel_head(old)
    c = np.asarray(colors, dtype=float).copy()
    indices = np.asarray(index).reshape(-1, 3)
    surfaces = user_data['surfaces']
    def vertices(part):
        return np.unique(indices[part['triangleStart']:part['triangleStart'] + part['triangleCount']])
    for eye in surfaces['eyes']:
        cx, cy = eye['center']
        # A weighted upper lid covers more iris; eye aperture has a canthal tilt.
        for name in ('sclera', 'iris', 'pupil', 'upperLid', 'lowerLid'):
            vi = vertices(eye[name])
            dx, dy = old[vi, 0] - cx, old[vi, 1] - cy
            if name == 'sclera':
                p[vi, 1] = cy + dy * 0.74 - 0.003 * (1 - (dx / 0.079) ** 2)
                c[vi] *= 0.91
            elif name in ('iris', 'pupil'):
                if name == 'iris':
                    dx *= 1.24
                    # Olive brown iris has restrained contrast against sclera.
                    c[vi] *= np.array([1.08, 1.10, 1.02])
                p[vi, 0] = cx + dx
                arc = np.maximum(0, 1 - (dx / 0.078) ** 2)
                lower = cy - 0.024 * arc * 0.74 - 0.003 * arc
                upper = cy + 0.0195 * arc * 0.74 - 0.003 * arc
                p[vi, 1] = np.clip(cy + dy * 0.92, lower + 0.0003, upper - 0.0003)
            else:
                # Keep both edges thick enough to catch light at gameplay scale.
                p[vi, 1] = cy + dy * 0.79 - 0.003 * np.maximum(0, 1 - (dx / 0.079) ** 2)
                p[vi, 2] += 0.0025 * np.maximum(0, 1 - (dx / 0.079) ** 2)
                c[vi] *= 1.07 if name == 'upperLid' else 1.025
        # Brow strip follows the orbital plane; lower its arch and lighten the
        # nearly black inherited fill so it reads as short hair, not drawn arcs.
        start = eye['lowerLid']['triangleStart'] + eye['lowerLid']['triangleCount']
        brow = np.unique(indices[start:start + 24])
        center_y = 0.612 + np.sin(np.clip((old[brow, 0] - cx) / 0.164 + 0.5, 0, 1) * np.pi) * 0.016
        p[brow, 1] = center_y - 0.011 + (old[brow, 1] - center_y) * 1.22
        p[brow, 2] += 0.002
        c[brow] *= 0.94
    # Preserve hair crown height, but break the straight helmet-like front into
    # a shallow natural recession and a combed part, using actual outer geometry.
    hair = vertices(surfaces['hair'])
    x, y, z = old[hair].T
    frontal = smooth((z - 0.18) / 0.20)
    rim = g(y - 0.77, 0.058) * frontal
    p[hair, 1] += (0.010 * g(abs(x) - 0.27, 0.09) - 0.005 * g(x + 0.055, 0.12)) * rim
    p[hair, 2] += 0.005 * g(y - 0.85, 0.06) * frontal * np.sin(x * 22 + y * 5)
    return p, c


def head_high_displacement(position, normals):
    x, y, z = np.asarray(position).T
    front = smooth((z - 0.04) / 0.30)
    eye = g(abs(x) - 0.175, 0.09)
    # Sculpted supra-lid folds and under-eye transition, strongest only around
    # the outer corners. These are shallow forms, without baked illumination.
    corner = g(abs(x) - 0.255, 0.045)
    folds = (-0.0037 * eye * g(y - 0.596, 0.005)
             + 0.0020 * eye * g(y - 0.604, 0.009)
             - 0.0020 * eye * g(y - 0.501, 0.006)
             - 0.0016 * corner * g(y - (0.545 + (abs(x) - 0.25) * 0.16), 0.0045)
             - 0.0014 * corner * g(y - (0.566 + (abs(x) - 0.25) * 0.32), 0.0045))
    nasolabial_x = 0.09 + (0.38 - y) * 0.33
    folds -= 0.0023 * g(abs(x) - nasolabial_x, 0.006) * g(y - 0.326, 0.055)
    folds -= 0.0015 * g(abs(x) - 0.032, 0.007) * g(y - 0.307, 0.020)
    # Low amplitude irregular grain is present on cheek/nose only. It is a
    # master geometry detail, projected at the selected 512px texel density.
    pore_zone = g(y - 0.43, 0.19) * (1 - g(abs(x) - 0.175, 0.065) * g(y - 0.554, 0.037))
    pores = (np.sin(x * 611 + np.sin(y * 83)) * np.sin(y * 547 + np.sin(x * 97))) * 0.00042 * pore_zone
    scalp_mask = 1 - smooth((y - 0.73) / 0.055)
    return (folds + pores) * front * scalp_mask


def restore_master_ear(position):
    """Retain the deliberately sculpted inner ear after skull-only smoothing."""
    p = np.asarray(position, dtype=float).copy()
    x, y, z = p.T.copy()
    radius = np.sqrt(((z + 0.020) / 0.063) ** 2 + ((y - 0.496) / 0.110) ** 2)
    mask = g(z + 0.020, 0.077) * g(y - 0.496, 0.145) * smooth((abs(x) - 0.423) / 0.035)
    target = 0.457 + 0.057 * g(radius - 0.81, 0.21) - 0.027 * g(radius, 0.52)
    target += 0.022 * g(radius - 0.43, 0.13) * smooth((z + 0.06) / 0.08)
    target += 0.018 * g(y - 0.397, 0.025) * g(z + 0.010, 0.050)
    # A small tragus shields the front of the concha without becoming a spike.
    target += 0.023 * g(z - 0.031, 0.018) * g(y - 0.483, 0.035)
    p[:, 0] = np.sign(x) * (abs(x) * (1 - mask) + target * mask)
    return p
