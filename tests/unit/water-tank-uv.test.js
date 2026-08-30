import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyWaterTankStaveUV, WATER_TANK_STAVE_UV } from '../../src/render/water-tank-uv.js';
import { bakeSurfaceData } from '../../src/render/surface-detail.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const cylinder = () => new THREE.CylinderGeometry(1.4, 1.4, 2.2, 48);
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);

function sample(data, size, channels, u, v, channel = 0) {
  const wrap = value => (value % size + size) % size;
  const x = u * size - 0.5, y = v * size - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const pixel = (px, py) => data[(wrap(py) * size + wrap(px)) * channels + channel];
  return (pixel(ix, iy) * (1 - fx) + pixel(ix + 1, iy) * fx) * (1 - fy)
    + (pixel(ix, iy + 1) * (1 - fx) + pixel(ix + 1, iy + 1) * fx) * fy;
}

test('tank correction changes only the 98 torso UV pairs and preserves geometry allocation, normals, indices and caps', () => {
  const geometry = cylinder(), original = geometry.clone();
  const attributes = { ...geometry.attributes }, index = geometry.index;
  const arrays = Object.fromEntries(Object.entries(attributes).map(([key, attribute]) => [key, attribute.array]));
  assert.equal(applyWaterTankStaveUV(geometry), geometry);
  for (const [key, attribute] of Object.entries(attributes)) {
    assert.equal(geometry.attributes[key], attribute);
    assert.equal(geometry.attributes[key].array, arrays[key]);
    if (key !== 'uv') assert.deepEqual(attribute.array, original.attributes[key].array);
  }
  assert.equal(geometry.index, index); assert.deepEqual(index.array, original.index.array);
  assert.deepEqual(geometry.groups, original.groups);
  const { normal, uv } = geometry.attributes;
  let changed = 0;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(normal.getY(i)) < 1e-6) changed++;
    else {
      assert.equal(uv.getX(i), original.attributes.uv.getX(i));
      assert.equal(uv.getY(i), original.attributes.uv.getY(i));
    }
  }
  assert.equal(changed, 98);
  geometry.computeBoundingBox(); original.computeBoundingBox();
  assert.ok(geometry.boundingBox.equals(original.boundingBox));
});

test('mapped grain follows cylinder height while two closed atlas repeats form 32 evenly spaced staves', () => {
  const geometry = applyWaterTankStaveUV(cylinder());
  const { position, uv } = geometry.attributes;
  // Cylinder torso rows have 49 vertices, including a duplicate at the seam.
  for (let around = 0; around <= 48; around++) {
    const top = around, bottom = around + 49;
    near(position.getX(top), position.getX(bottom)); near(position.getZ(top), position.getZ(bottom));
    near(uv.getY(top), uv.getY(bottom));
    near(uv.getX(top) - uv.getX(bottom), WATER_TANK_STAVE_UV.grainUMax - WATER_TANK_STAVE_UV.grainUMin);
    near(uv.getY(top), around / 48 * 2);
  }
  near(uv.getX(0), uv.getX(48)); near(uv.getY(48) - uv.getY(0), 2);
  near(uv.getX(49), uv.getX(97)); near(uv.getY(97) - uv.getY(49), 2);
  near(2 * 16, WATER_TANK_STAVE_UV.staves);
  near(2 * Math.PI * 1.4 / WATER_TANK_STAVE_UV.staves, 0.2748893571891069);
});

test('real shared wood channels sample continuously around the seam and do not paint end joints along the staves', () => {
  const wood = bakeSurfaceData('wood');
  for (const height of [0, 0.23, 0.5, 0.81, 1]) {
    const u = WATER_TANK_STAVE_UV.grainUMin + height * (WATER_TANK_STAVE_UV.grainUMax - WATER_TANK_STAVE_UV.grainUMin);
    for (const data of [wood.albedo, wood.normal, wood.orm]) {
      for (const offset of [-0.003, 0, 0.001]) for (let channel = 0; channel < 4; channel++) {
        near(sample(data, wood.width, 4, u, offset, channel), sample(data, wood.width, 4, u, 2 + offset, channel), 1e-8);
      }
    }
    // Interior stave centres exclude the intended vertical side joints. A
    // horizontal end seam would be about -0.95 mm in this same source field.
    for (let stave = 0; stave < 32; stave++) {
      const v = (stave + 0.5) / 16;
      assert.ok(sample(wood.heights, wood.width, 1, u, v) > -0.0005, 'full-height grain avoids atlas board-end grooves');
    }
  }
});

test('real authored tank retains its shared wood material, collider, supports, dimensions and shadow flags', () => {
  const fixture = buildWorldSurfaceFixture();
  const tank = fixture.records.get('water-tank'), reference = cylinder();
  assert.equal(tank.mesh.material, fixture.materials.get('wood'));
  assert.deepEqual(tank.mesh.geometry.attributes.position.array, reference.attributes.position.array);
  assert.deepEqual(tank.mesh.geometry.attributes.normal.array, reference.attributes.normal.array);
  assert.deepEqual(tank.mesh.geometry.index.array, reference.index.array);
  assert.ok(tank.collider.equals(tank.bounds));
  assert.deepEqual(tank.supports, ['tank-cradle-0', 'tank-cradle-1']);
  assert.deepEqual(tank.mesh.position.toArray(), [-8, 17.3, -2]);
  assert.equal(tank.mesh.castShadow, true); assert.equal(tank.mesh.receiveShadow, true);
  assert.equal(tank.mesh.geometry.userData.waterTankStaves.sideVertices, 98);
});

test('repeated application is inert and does not remap the already corrected UVs again', () => {
  const geometry = applyWaterTankStaveUV(cylinder());
  const uv = geometry.attributes.uv, before = uv.array.slice(), version = uv.version;
  assert.equal(applyWaterTankStaveUV(geometry), geometry);
  assert.deepEqual(uv.array, before); assert.equal(uv.version, version);
  assert.throws(() => applyWaterTankStaveUV(new THREE.BoxGeometry()), TypeError);
  assert.throws(() => applyWaterTankStaveUV(null), TypeError);
});
