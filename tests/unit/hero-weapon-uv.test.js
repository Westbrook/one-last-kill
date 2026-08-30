import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyHeroWeaponUV } from '../../src/render/hero-weapon-uv.js';
import { createHeroWeapon } from '../../src/render/hero-weapons.js';

const near = (actual, expected, message, tolerance = 2e-5) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} versus ${expected}`);
const material = { userData: { weaponFinish: { surfaceMeters: 0.18 } } };

function areaRatios(geometry, meters = 0.18) {
  const { position, uv } = geometry.attributes, ratios = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, i + 1); c.fromBufferAttribute(position, i + 2);
    const physical = b.sub(a).cross(c.sub(a)).length();
    const mapped = Math.abs((uv.getX(i + 1) - uv.getX(i)) * (uv.getY(i + 2) - uv.getY(i))
      - (uv.getX(i + 2) - uv.getX(i)) * (uv.getY(i + 1) - uv.getY(i)));
    if (physical > 1e-14) ratios.push(mapped * meters * meters / physical);
  }
  return ratios;
}

test('smoothly shaded corners cannot switch UV projections within a physical face', () => {
  const geometry = new THREE.PlaneGeometry(0.30, 0.12);
  geometry.rotateY(0.71); geometry.rotateZ(-0.26); geometry.translate(0.42, 0.05, -0.023);
  // Adjacent vertices intentionally favor different normal axes. Geometry and
  // its smooth lighting normals must survive while texture density stays exact.
  geometry.attributes.normal.setXYZ(0, 1, 0, 0);
  geometry.attributes.normal.setXYZ(1, 0, 1, 0);
  const originalUV = geometry.attributes.uv.array.slice();
  const flattened = geometry.toNonIndexed();
  geometry.userData.source = 'authored-profile';
  const result = applyHeroWeaponUV(geometry, material);
  assert.notEqual(result, geometry); assert.equal(result.index, null);
  assert.deepEqual(geometry.attributes.uv.array, originalUV, 'shared indexed input remains unchanged');
  assert.deepEqual(result.attributes.position.array, flattened.attributes.position.array);
  assert.deepEqual(result.attributes.normal.array, flattened.attributes.normal.array);
  assert.equal(result.userData.source, 'authored-profile'); assert.equal(result.userData.weaponSurfaceUV, true);
  for (const ratio of areaRatios(result)) near(ratio, 1, 'actual square metres per UV square');
});

test('adjacent profile faces preserve texture phase on their shared edge', () => {
  const parts = [-0.09, 0.09].map(x => {
    const geometry = new THREE.PlaneGeometry(0.18, 0.10).toNonIndexed();
    geometry.translate(x, 0.03, -0.025);
    assert.equal(applyHeroWeaponUV(geometry, material), geometry, 'owned nonindexed geometry is reused');
    const { position, uv } = geometry.attributes, seam = new Map();
    for (let i = 0; i < position.count; i++) if (Math.abs(position.getX(i)) < 1e-7) {
      seam.set(position.getY(i).toFixed(6), [uv.getX(i), uv.getY(i)]);
    }
    return [...seam].sort(([a], [b]) => a.localeCompare(b));
  });
  assert.equal(parts[0].length, 2);
  for (let i = 0; i < parts[0].length; i++) {
    assert.equal(parts[0][i][0], parts[1][i][0]);
    for (let axis = 0; axis < 2; axis++) near(parts[0][i][1][axis], parts[1][i][1][axis], 'same phase within float geometry precision');
  }
});

test('hollow barrels unwrap both circumferences without UV collapse or wrapping across the seam', () => {
  const x1 = 0.14, x2 = 0.201, y = 0.04, z = -0.012, radius = 0.013, bore = 0.008, half = (x2 - x1) / 2;
  const geometry = new THREE.LatheGeometry([
    new THREE.Vector2(bore, -half), new THREE.Vector2(radius, -half), new THREE.Vector2(radius, half),
    new THREE.Vector2(bore, half), new THREE.Vector2(bore, -half),
  ], 16);
  geometry.rotateZ(-Math.PI / 2).translate((x1 + x2) / 2, y, z);
  const result = applyHeroWeaponUV(geometry, material, { kind: 'tube', y, z });
  assert.equal(result.attributes.position.count, geometry.index.count, 'the exact triangle count is retained');
  for (const ratio of areaRatios(result)) {
    assert.ok(ratio >= 0.9999 && ratio < 1.04, `planar crown or true circular arc/chord ratio: ${ratio}`);
  }
  const { position, uv } = result.attributes;
  let inner = 0, outer = 0;
  for (let i = 0; i < position.count; i += 3) {
    const xs = [0, 1, 2].map(k => position.getX(i + k));
    if (Math.max(...xs) - Math.min(...xs) < 1e-7) continue;
    const vs = [0, 1, 2].map(k => uv.getY(i + k));
    const r = Math.hypot(position.getY(i) - y, position.getZ(i) - z);
    near((Math.max(...vs) - Math.min(...vs)) * 0.18, Math.PI * 2 * r / 16, 'one angular segment uses its true arc');
    if (Math.abs(r - bore) < 1e-7) inner++; else outer++;
  }
  assert.equal(inner, 32); assert.equal(outer, 32);
});

test('the actual hero barrel builders retain a longitudinal wrap for their finish maps', () => {
  for (const [type, name, y] of [['pistol', 'pistol-barrel-crown', 0.04], ['shotgun', 'shotgun-barrel', 0.03],
    ['smg', 'smg-exposed-barrel', 0.02], ['machinegun', 'machinegun-flash-hider', 0.03]]) {
    const mesh = createHeroWeapon(type).getObjectByName(name), geometry = mesh.geometry;
    const { position, uv } = geometry.attributes, meters = mesh.material.userData.weaponFinish.surfaceMeters;
    const index = geometry.index;
    let sideTriangles = 0;
    for (let i = 0; i < (index?.count ?? position.count); i += 3) {
      const ids = [0, 1, 2].map(corner => index ? index.getX(i + corner) : i + corner);
      const xs = ids.map(vertex => position.getX(vertex));
      if (Math.max(...xs) - Math.min(...xs) < 1e-7) continue;
      const vs = ids.map(vertex => uv.getY(vertex));
      const radius = Math.hypot(position.getY(ids[0]) - y, position.getZ(ids[0]));
      near((Math.max(...vs) - Math.min(...vs)) * meters, Math.PI * 2 * radius / 16, `${name}: physical circular wrap`);
      for (const vertex of ids) near(uv.getX(vertex) * meters, position.getX(vertex), `${name}: longitudinal phase`);
      sideTriangles++;
    }
    assert.equal(sideTriangles, 64, `${name}: both inner and outer walls carry the wrap`);
  }
});

test('current authored knife bevels and pump lofts retain physical texture scale at narrow tips and grooves', () => {
  for (const [type, name] of [['knife', 'knife-ground-blade'], ['knife', 'knife-contoured-handle'], ['shotgun', 'shotgun-ribbed-pump']]) {
    const mesh = createHeroWeapon(type).getObjectByName(name), before = mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count;
    const geometry = applyHeroWeaponUV(mesh.geometry, mesh.material);
    assert.equal(geometry.attributes.position.count, before, 'no subdivision is needed to fix mapping');
    for (const ratio of areaRatios(geometry, mesh.material.userData.weaponFinish.surfaceMeters)) {
      near(ratio, 1, `${name}: no collapsed or stretched texture triangles`, 3e-4);
    }
  }
});
