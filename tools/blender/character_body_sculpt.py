"""Deterministic low and high sculpt passes for the gunman fidelity master.

The low mesh stays in the accepted character's +Y-up A-pose bind space. The
pass edits positions and proximal shoulder binding only. Topology, hand
contacts, collar opening, sole height, and material groups remain owned by the
game/exporter. Garment
panels follow the same broad deformation as their underlying cloth instead of
being left floating above a remodeled shirt. Small normal-direction relief is
reserved for the offline high master and its baked normal map.

This module deliberately has no bpy dependency. The builder can validate the
low mesh before modifying the Blender source, and can call the high pass after
subdividing its sculpt copy. All distances returned here are metres.
"""

import numpy as np


BIND_ARM_ANGLE = 0.45


def smooth(value):
    t = np.clip(value, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def bell(value, width):
    return np.exp(-np.square(np.asarray(value) / width))


def window(value, start, fade_in, end, fade_out):
    return smooth((value - start) / fade_in) * (1.0 - smooth((value - end) / fade_out))


def _gunman(entry):
    return entry.get('id', entry.get('config', {}).get('role')) == 'gunman'


def _body_vertices(index, entry, vertex_count):
    count = int(entry['body']['surfaceTriangles'])
    result = np.zeros(vertex_count, dtype=bool)
    result[np.unique(np.asarray(index, dtype=np.int32).reshape(-1, 3)[:count])] = True
    return result


def _arm_frame(position, dimensions):
    h = dimensions['height']
    x, y, z = position.T
    side = np.where(x < 0.0, -1.0, 1.0)
    dx = x - side * dimensions['shoulderSpacing']
    dy = y - dimensions['shoulderY']
    sine, cosine = np.sin(BIND_ARM_ANGLE), np.cos(BIND_ARM_ANGLE)
    length = dimensions['upperArmLength'] + dimensions['forearmLength']
    along = (dx * side * sine - dy * cosine) / length
    across = (dx * cosine + dy * side * sine) / h
    radial = np.hypot(across, z / h)
    angle = np.arctan2(across, z / h)
    # The medial part of the shoulder is a chest transition, not a sleeve.
    sleeve = window(along, -0.08, 0.14, 0.86, 0.08)
    sleeve *= smooth((np.abs(x) / h - 0.105 * dimensions['width']) / 0.045)
    return side, along, across, radial, angle, sleeve


def _garment_warp(position, dimensions):
    """Coherent tailoring field, shared by cloth and sewn-on parts."""
    h, width = dimensions['height'], dimensions['width']
    x, y, z = position.T
    px, py, pz = x / h, y / h, z / h
    ax = np.abs(px) / width
    side, along, across, radial, angle, sleeve = _arm_frame(position, dimensions)
    out = np.zeros_like(position, dtype=np.float64)

    # Keep the entire collar contact band and the body-to-boot overlap fixed.
    shirt = window(py, 0.578, 0.036, 0.792, 0.032)
    shirt *= 1.0 - smooth((ax - 0.103) / 0.042)
    waist = bell(py - 0.645, 0.071) * shirt
    out[:, 0] -= x * 0.058 * waist
    out[:, 2] -= z * 0.055 * waist

    # A clothed pectoral plane and a flatter back replace a barrel-shaped
    # cross section. This is broad silhouette work, not a painted highlight.
    front = smooth((pz - 0.012) / 0.040)
    back = smooth((-pz - 0.013) / 0.040)
    chest = bell(py - 0.750, 0.047) * bell(ax - 0.053, 0.048) * shirt
    sternum = bell(px, 0.018) * bell(py - 0.748, 0.043) * shirt
    out[:, 2] += h * (0.0026 * chest - 0.0013 * sternum) * front
    out[:, 2] += h * 0.0016 * bell(py - 0.735, 0.070) * shirt * back

    # Remove the pointed shoulder peak that becomes conspicuous when the
    # upper arm pitches forward to aim. The collar itself lies well medial
    # to this mask. A modest upper-sleeve taper leaves a rounded deltoid cap.
    shoulder = bell(ax - 0.127, 0.032) * smooth((py - 0.787) / 0.039)
    shoulder *= smooth((ax - 0.075) / 0.027)
    out[:, 1] -= h * 0.0084 * shoulder
    upper_sleeve = bell(along - 0.22, 0.18) * sleeve
    out[:, 0] -= h * across * np.cos(BIND_ARM_ANGLE) * 0.085 * upper_sleeve
    out[:, 1] -= h * across * side * np.sin(BIND_ARM_ANGLE) * 0.085 * upper_sleeve
    out[:, 2] -= z * 0.085 * upper_sleeve

    # Two long diagonal folds run from each axilla toward the tucked waist.
    # They are deliberately asymmetric in height and do not form horizontal
    # rings. Positive and negative lobes retain the overall garment volume.
    diagonal_a = py - (0.647 + 0.77 * ax + 0.004 * np.sign(px))
    diagonal_b = py - (0.608 + 0.63 * ax - 0.003 * np.sign(px))
    drape = (0.0031 * bell(diagonal_a, 0.011)
             - 0.0015 * bell(diagonal_a - 0.018, 0.013)
             + 0.0021 * bell(diagonal_b, 0.010)
             - 0.0010 * bell(diagonal_b + 0.015, 0.011))
    drape *= shirt * smooth((ax - 0.014) / 0.035)
    out[:, 2] += h * drape * (front - 0.70 * back)

    # Broad compression at the elbow, not sinusoidal ribbing down the arm.
    elbow = dimensions['upperArmLength'] / (dimensions['upperArmLength'] + dimensions['forearmLength'])
    arc = along - elbow + 0.36 * across
    crease = (0.0024 * bell(arc + 0.060, 0.048)
              - 0.0025 * bell(arc - 0.003, 0.037)
              + 0.0018 * bell(arc - 0.071, 0.051))
    angular = 0.28 + 0.72 * np.square(np.cos(angle - 0.22 * side))
    fold = crease * angular * sleeve
    radial_safe = np.maximum(radial, 1e-8)
    across_delta = h * fold * across / radial_safe
    out[:, 0] += across_delta * np.cos(BIND_ARM_ANGLE)
    out[:, 1] += across_delta * side * np.sin(BIND_ARM_ANGLE)
    out[:, 2] += h * fold * pz / radial_safe

    # Fitted trousers: a restrained thigh taper, a knee plane, and a single
    # soft compression fold below it. The cuffs and boot-contact rows stay
    # fixed, and the pleat fades out before the pelvis blends into the shirt.
    leg_side = np.where(x < 0.0, -1.0, 1.0)
    leg_x = px - leg_side * dimensions['hipSpacing'] / h
    leg = window(py, 0.106, 0.065, 0.465, 0.073)
    leg *= 1.0 - smooth((np.abs(leg_x) - 0.055) / 0.022)
    thigh = bell(py - 0.413, 0.071) * leg
    out[:, 0] -= h * leg_x * 0.036 * thigh
    out[:, 2] -= z * 0.024 * thigh
    knee_y = dimensions['kneeY'] / h
    knee_front = smooth((pz - 0.005) / 0.030)
    knee = bell(py - knee_y - 0.013, 0.039) * bell(leg_x, 0.029)
    below_knee = bell(py - knee_y + 0.046 + leg_x * 0.20, 0.014)
    crease_front = bell(leg_x, 0.010) - 0.26 * bell(np.abs(leg_x) - 0.019, 0.011)
    out[:, 2] += h * leg * knee_front * (0.0021 * knee + 0.0017 * below_knee
                                        + 0.0014 * crease_front)
    return out


def _relax_surface(position, index, selected, mask):
    """Reduce the old extracted field's small ripples without shrinking it."""
    triangles = np.asarray(index, dtype=np.int32).reshape(-1, 3)
    edges = np.vstack((triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]))
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    count = np.zeros(len(position), dtype=np.float64)
    for end in (0, 1):
        np.add.at(count, edges[:, end], 1.0)
    current = position.copy()
    weights = mask * selected
    # A paired Taubin pass removes extraction noise, not intentional tailoring.
    for _ in range(3):
        for amount in (0.43, -0.455):
            neighbors = np.zeros_like(current)
            np.add.at(neighbors, edges[:, 0], current[edges[:, 1]])
            np.add.at(neighbors, edges[:, 1], current[edges[:, 0]])
            delta = neighbors / np.maximum(count[:, None], 1.0) - current
            current += delta * (weights * amount)[:, None]
    return current


def adjust_low_body(surface_name, positions, normals, index, entry):
    """Return remodeled positions at exactly the accepted vertex/triangle count.

    Non-gunman entries and unrelated surfaces return an independent unchanged
    array. The caller recomputes normals and transfers neither UV nor weights:
    all original point attributes remain valid at these original vertices.
    """
    source = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    result = source.copy()
    if not _gunman(entry):
        return result
    d, h = entry['dimensions'], entry['dimensions']['height']
    if surface_name == 'garments':
        body = _body_vertices(index, entry, len(source))
        py = source[:, 1] / h
        _, along, _, _, _, sleeve = _arm_frame(source, d)
        # Existing attachments need their sampled offsets preserved. The
        # relaxation is restricted to the continuous cloth below the collar;
        # the coherent tailoring field then moves cloth and attachments alike.
        front_attachment = (np.abs(source[:, 0]) / h < 0.087) & (source[:, 2] > 0)
        torso = window(py, 0.586, 0.040, 0.775, 0.027)
        torso *= 1.0 - front_attachment.astype(np.float64)
        legs = window(py, 0.115, 0.055, 0.459, 0.062)
        sleeve_relax = sleeve * window(along, 0.16, 0.14, 0.79, 0.07)
        mask = np.maximum.reduce((torso, legs, sleeve_relax))
        result = _relax_surface(source, np.asarray(index).reshape(-1, 3)[:entry['body']['surfaceTriangles']], body, mask)
        result += _garment_warp(source, d)
        # Never alter the separate boots or the reviewed folded contact rims.
        cursor = int(entry['body']['surfaceTriangles'])
        triangles = np.asarray(index, dtype=np.int32).reshape(-1, 3)
        for part in entry['body']['garmentDetails']['parts']:
            end = cursor + int(part['triangles'])
            vertices = np.unique(triangles[cursor:end])
            if part['name'] == 'neck-fold' or part['name'].startswith('sleeve-hem.'):
                result[vertices] = source[vertices]
            elif part['name'].startswith('folded-collar.'):
                # The accepted collar's long planar points read as flat chest
                # triangles. Shorten their tips into an actual spread collar,
                # and give its central fold a clear rolled thickness. Existing
                # attachment rim and torso-facing underside remain seated.
                local = source[vertices] / h
                tip = 1.0 - smooth((local[:, 1] - 0.790) / 0.026)
                result[vertices, 1] += h * 0.0145 * tip
                result[vertices, 0] += np.sign(local[:, 0]) * h * 0.0030 * tip
                fold = bell(local[:, 1] - 0.8195, 0.009) * bell(np.abs(local[:, 0]) - 0.035, 0.017)
                result[vertices, 2] += h * 0.0028 * fold
                # Lift only the outward face a further 1.5 mm. The separate
                # underside stays seated on the shirt; the preserved beveled
                # ring carries the added folded-cloth thickness at grazing
                # angles. No extra polygon or material draw is introduced.
                outward_face = smooth((np.asarray(normals)[vertices, 2] - 0.05) / 0.55)
                result[vertices, 2] += 0.0015 * outward_face
            cursor = end
        result[np.unique(triangles[cursor:])] = source[np.unique(triangles[cursor:])]
        # The continuous cloth adjacent to each unchanged contact rim is pinned
        # as well, avoiding a gap even under the existing shoulder skin blend.
        pin = ((py >= 0.826) & (np.abs(source[:, 0]) < h * 0.074)) | ((sleeve > 0) & (along >= 0.94)) | (py <= 0.106)
        result[pin] = source[pin]
        # Two extracted shirt vertices formed teeth in the small gap between
        # the open collar band's ends. Lower just the continuous front rim to
        # meet those reviewed ends; the actual folded band is still untouched.
        # The flared neck already extends behind this surface, so the local
        # silhouette becomes a smooth shallow curve without opening a gap.
        front_rim = body.astype(np.float64)
        front_rim *= 1.0 - smooth((np.abs(source[:, 0]) / h - 0.014) / 0.013)
        front_rim *= smooth((source[:, 2] / h - 0.020) / 0.011)
        front_rim *= 1.0 - smooth((source[:, 2] / h - 0.043) / 0.009)
        target_y = h * (0.8270 + 0.0020 * smooth(np.abs(source[:, 0]) / (h * 0.027)))
        result[:, 1] -= np.maximum(result[:, 1] - target_y, 0.0) * front_rim
    elif surface_name == 'skin':
        x, y, z = source.T
        py = y / h
        # The skin surface also contains both posed weapon hands. Only the
        # central neck may move; every finger and wrist stays bitwise fixed.
        neck = window(py, 0.837, 0.009, 0.881, 0.012)
        neck *= 1.0 - smooth((np.abs(x) / h - 0.030) / 0.015)
        angle = np.arctan2(x, z + h * 0.010)
        t = np.clip((py - 0.837) / 0.053, 0.0, 1.0)
        # Paired oblique sternocleidomastoid ridges run toward the mastoid;
        # the central larynx is smaller and softer than either tendon.
        scm = bell(np.abs(angle) - (0.49 + t * 0.78), 0.20)
        adjacent = bell(np.abs(angle) - (0.77 + t * 0.72), 0.22)
        throat = bell(angle, 0.34) * bell(py - 0.858, 0.011)
        relief = h * neck * (0.00165 * scm - 0.00055 * adjacent + 0.0008 * throat)
        result[:, 0] += np.sin(angle) * relief
        result[:, 2] += np.cos(angle) * relief
        # Fill the thin nape slightly while keeping its upper head contact and
        # lower collar seam fixed. This catches three-quarter and side light.
        nape = smooth((-z / h - 0.008) / 0.022) * bell(py - 0.857, 0.025) * neck
        result[:, 2] -= h * 0.0010 * nape
        # A larger, tapered neck root connects the fuller jaw to the shoulder
        # girdle. Both buried rims remain fixed. The former narrow cylinder is
        # broadened by up to 20%, greatest just above the collar, then blends
        # into the existing upper head contact rather than scaling the head.
        flare = neck * bell(py - 0.850, 0.030)
        result[:, 0] += x * 0.20 * flare
        result[:, 2] += (z + h * 0.010) * 0.12 * flare
    return result


def adjust_body_binding(surface_name, positions, skin_indices, skin_weights, index, entry):
    """Blend proximal cloth from chest into shoulder instead of rotating a spike.

    Original front cap vertices at 100% shoulder influence rotated 42 mm above
    medial chest cloth in the production aiming pose. A garment's arm root is
    held by its chest/shoulder yoke, so it should progressively follow the arm
    along the sleeve. This changes only original continuous garment vertices
    with proximal same-side shoulder influence, never any other bone influence.
    It transfers that shoulder weight to chest, retains every elbow/wrist and
    leg influence, and leaves all separate detail parts exactly unchanged.

    Region, in accepted A-pose metres: original shoulder influence >0; body
    vertices only; y > 0.70h; arm-along <0.24. The permitted shoulder fraction
    rises smoothly from 0.20 at along=-0.02 to 1.0 at along=0.20. Transfer is
    strongest on the anterior/medial yoke. The lateral deltoid and rear cap
    progressively retain their shoulder influence, so lowering the arm cannot
    leave the broad A-pose sleeve width fixed to the chest. All farther vertices
    retain byte-identical attributes, including zero-weight slots.
    """
    p = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    ids = np.asarray(skin_indices).copy().reshape(-1, 4)
    weights = np.asarray(skin_weights).copy().reshape(-1, 4)
    if surface_name != 'garments' or not _gunman(entry):
        return ids, weights
    d, h = entry['dimensions'], entry['dimensions']['height']
    side, along, across, _, _, _ = _arm_frame(p, d)
    body = _body_vertices(index, entry, len(p))
    bone_names = [bone['name'] for bone in entry['bones']]
    chest = bone_names.index('joint:chest')
    shoulder_l, shoulder_r = [bone_names.index(f'joint:shoulder{side}') for side in ('L', 'R')]
    shoulder = np.where(p[:, 0] < 0, shoulder_l, shoulder_r)
    permitted = 0.20 + 0.80 * smooth((along + 0.020) / 0.220)
    # Across is signed along the common A-pose plane; multiply by side to
    # obtain the anatomical outboard direction for either shoulder. Both masks
    # are broad ramps, not a hard seam or a pose-specific corrective shape.
    anterior = smooth((p[:, 2] / h + 0.010) / 0.035)
    medial = 1.0 - smooth((side * across - 0.006) / 0.040)
    yoke = anterior * medial
    selected = np.flatnonzero(body & (p[:, 1] > h * 0.70) & (along < 0.24))
    for vertex in selected:
        component = np.flatnonzero(ids[vertex] == shoulder[vertex])
        if not len(component):
            continue
        original = float(np.sum(weights[vertex, component]))
        transfer = max(0.0, original - float(permitted[vertex])) * float(yoke[vertex])
        if transfer <= 1e-8:
            continue
        # Consolidating by semantic bone avoids interpolating categorical IDs.
        influences = {}
        for bone, amount in zip(ids[vertex], weights[vertex]):
            if amount > 0:
                influences[int(bone)] = influences.get(int(bone), 0.0) + float(amount)
        influences[int(shoulder[vertex])] -= transfer
        influences[chest] = influences.get(chest, 0.0) + transfer
        ordered = sorted(influences.items(), key=lambda value: (-value[1], value[0]))
        if len(ordered) > 4:
            raise ValueError('Shoulder tailoring would exceed the four-influence skin contract')
        ids[vertex], weights[vertex] = 0, 0
        for component, (bone, amount) in enumerate(ordered):
            ids[vertex, component], weights[vertex, component] = bone, amount
        weights[vertex] /= weights[vertex].sum()
    return ids, weights


def high_detail_displacement(surface_name, positions, normals, entry):
    """Return a scalar normal displacement for the offline high-poly master.

    Subdivide the remodeled low copy with SIMPLE subdivision before applying
    this field. That retains all existing contact surfaces and low silhouette;
    the resulting master can then supply tangent-space normals by a selected-
    to-active bake. An optional smoothing modifier must preserve open rims and
    hard seams. This function adds no runtime geometry.
    """
    position = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    displacement = np.zeros(len(position), dtype=np.float64)
    if not _gunman(entry):
        return displacement
    d, h = entry['dimensions'], entry['dimensions']['height']
    x, y, z = position.T / h
    ax = np.abs(x) / d['width']
    if surface_name == 'garments':
        side, along, across, _, angle, sleeve = _arm_frame(position, d)
        shirt = window(y, 0.582, 0.027, 0.788, 0.030)
        shirt *= 1.0 - smooth((ax - 0.105) / 0.037)
        front_back = smooth((np.abs(z) - 0.012) / 0.028)
        # Local compression immediately above the waistband: irregular fans
        # drawn toward two tuck points, with progressively softer creases.
        gather = bell(y - 0.604, 0.021) * shirt * front_back
        phase = x * 125.0 + 0.6 * np.sin(y * 19.0) + side * 0.5
        displacement += h * 0.00085 * np.sin(phase) * gather
        # A shallow seam on each side of the shirt and the trousers, with a
        # rolled edge. Geometry carries the large folds; baking carries these
        # millimetre-scale construction details.
        shirt_seam = bell(ax - 0.102, 0.0021) * window(y, 0.598, 0.032, 0.752, 0.036)
        shirt_seam -= 0.44 * bell(ax - 0.0978, 0.0023) * window(y, 0.598, 0.032, 0.752, 0.036)
        leg_x = x - side * d['hipSpacing'] / h
        leg_window = window(y, 0.13, 0.040, 0.465, 0.063)
        outer_seam = bell(np.abs(leg_x) - 0.035, 0.0020) * leg_window
        outer_seam *= 1.0 - smooth((np.abs(z) - 0.012) / 0.021)
        displacement += h * (0.00042 * shirt_seam + 0.00038 * outer_seam)
        # Elbow folds have finer neighboring creases; there is no regular
        # high-frequency rib pattern along the entire sleeve.
        elbow = d['upperArmLength'] / (d['upperArmLength'] + d['forearmLength'])
        arc = along - elbow + across * 0.36
        compression = (bell(arc + 0.008, 0.012) - 0.55 * bell(arc - 0.013, 0.012)
                       + 0.52 * bell(arc - 0.056, 0.016))
        displacement += h * 0.00075 * compression * sleeve * (0.3 + 0.7 * np.cos(angle) ** 2)
        # Rear knee compression follows the joint rather than a repeated
        # trouser cylinder. Its very low amplitude prevents a noisy normal map.
        knee = y - d['kneeY'] / h + leg_x * 0.23
        back = smooth((-z - 0.009) / 0.021)
        displacement += h * 0.00070 * back * leg_window * (
            bell(knee + 0.019, 0.010) - 0.72 * bell(knee - 0.003, 0.009)
            + 0.45 * bell(knee - 0.023, 0.012))
        cloth = np.maximum.reduce((shirt, sleeve, leg_window))
        # Weave is only 35 microns; macro forms and seam placement supply the
        # readable improvement. This is deterministic authored fiber relief.
        weave = np.sin(position[:, 0] * 3100.0 + position[:, 2] * 410.0)
        weave *= np.sin(position[:, 1] * 2850.0 + position[:, 2] * 290.0)
        displacement += 0.000035 * weave * cloth
        # Pin collar, folded cuff rings, soles, and the buried hand contacts.
        displacement[(y >= 0.824) & (np.abs(x) < 0.078)] = 0.0
        displacement[(along >= 0.92) & (np.abs(x) > 0.13)] = 0.0
        displacement[y <= 0.108] = 0.0
    elif surface_name == 'skin':
        neck = window(y, 0.840, 0.009, 0.879, 0.012)
        neck *= 1.0 - smooth((np.abs(x) - 0.029) / 0.012)
        # Fine neck creases and a restrained skin grain stay below a tenth of
        # a millimetre, avoiding the exaggerated pores of many procedural maps.
        angle = np.arctan2(x, z + 0.010)
        creases = bell(y - 0.855 + 0.003 * np.cos(angle), 0.00075)
        creases += 0.6 * bell(y - 0.869 + 0.003 * np.cos(angle), 0.00085)
        grain = np.sin(position[:, 0] * 1670.0 + np.sin(position[:, 1] * 590.0))
        grain *= np.sin(position[:, 1] * 1840.0 + position[:, 2] * 790.0)
        displacement = neck * (-0.00009 * creases + 0.000024 * grain)
    return displacement


def sculpt_description():
    return {
        'role': 'gunman',
        'lowMesh': [
            'rounded and lowered raised-arm shoulder peaks',
            'continuous chest-to-shoulder yoke skin-weight transition',
            'fitted shirt waist, chest planes, and diagonal axilla drape',
            'broad sleeve elbow compression and fitted trouser knee forms',
            'paired neck tendons and curved nape between fixed contact rims',
        ],
        'highMaster': [
            'waist gather, garment seam rolls, and joint-specific fine creases',
            'restrained textile weave and neck skin grain for normal baking',
        ],
        'preserved': ['topology', 'non-shoulder skin weights', 'collar opening', 'cuff contacts', 'hands', 'boots'],
    }
