import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCivilianVehicle } from '../../src/render/civilian-vehicles.js';

const near = (a, b, message, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${message}: ${a} vs ${b}`);
const doubleSided = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

function part(vehicle, name) {
  for (const mesh of vehicle.group.children) {
    const range = mesh.geometry.userData.civilianParts.find(range => range.name === name);
    if (!range) continue;
    const geometry = new THREE.BufferGeometry();
    for (const key of ['position', 'normal', 'uv']) {
      const source = mesh.geometry.attributes[key];
      geometry.setAttribute(key, new THREE.BufferAttribute(source.array.subarray(range.vertexStart * source.itemSize,
        (range.vertexStart + range.vertexCount) * source.itemSize), source.itemSize));
    }
    geometry.computeBoundingBox();
    const result = new THREE.Mesh(geometry, doubleSided); result.name = name; result.updateMatrixWorld();
    return result;
  }
  throw new Error('Missing vehicle part: ' + name);
}

function ray(mesh, x, y, z, dx, dy, dz, distance = 3) {
  return new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz), 0, distance)
    .intersectObject(mesh, false)[0];
}

for (const variant of ['sedan', 'hatchback', 'wagon']) {
  const vehicle = createCivilianVehicle({ variant }), c = vehicle.profile.cabin;

  test(`${variant} glass is seated in its actual shoulder and covered by the complete roof`, () => {
    const body = part(vehicle, 'body-shell'), roof = part(vehicle, 'crowned-roof');
    for (const x of [c.baseRearX, (c.baseRearX + c.baseFrontX) / 2, c.baseFrontX]) for (const side of [-1, 1]) {
      const hit = ray(body, x, c.beltY + 0.10, side * c.baseHalfWidth, 0, -1, 0, 0.15);
      assert.ok(hit, 'actual shoulder exists beneath each glazing base sample');
      assert.ok(hit.point.y >= c.beltY - 1e-5 && hit.point.y <= c.beltY + 0.02, 'glass embeds within the body shoulder');
    }
    for (const x of [c.topRearX, (c.topRearX + c.topFrontX) / 2, c.topFrontX]) for (const side of [-1, 1]) {
      const hit = ray(roof, x, c.glassTopY - 0.02, side * c.topHalfWidth, 0, 1, 0, 0.12);
      assert.ok(hit, 'actual roof underside covers the glass top including the corners');
      assert.ok(hit.point.y <= c.glassTopY, 'roof underside intersects the glass cap instead of floating');
      near(hit.face.normal.length(), 1, 'finite roof face normal');
    }
    near(roof.geometry.boundingBox.max.y, c.roofTopY, 'metadata records the actual crown height');
  });

  test(`${variant} front/rear pillars and mirrors contact the sloped side glazing`, () => {
    const glass = part(vehicle, 'cabin-glass');
    for (const side of [-1, 1]) {
      const suffix = side > 0 ? 'left' : 'right';
      for (const [name, low, high, inset] of [
        ['a-pillar-', c.baseFrontX, c.topFrontX, -0.022],
        ['rear-pillar-', c.baseRearX, c.topRearX, 0.023],
      ]) for (const fraction of [0.06, 0.5, 0.94]) {
        const x = THREE.MathUtils.lerp(low, high, fraction) + inset;
        const y = THREE.MathUtils.lerp(c.beltY, c.glassTopY, fraction);
        const z = THREE.MathUtils.lerp(c.baseHalfWidth, c.topHalfWidth, fraction);
        const hit = ray(part(vehicle, name + suffix), x, y, side * (z + 0.15), 0, 0, -side, 0.3);
        assert.ok(hit, 'pillar continuously covers the glazing edge through its slope');
        assert.ok(Math.abs(hit.point.z - side * z) < 0.029, 'pillar remains fitted to the side surface');
      }
      const arm = part(vehicle, 'mirror-arm-' + suffix).geometry.boundingBox;
      const housing = part(vehicle, 'mirror-housing-' + suffix).geometry.boundingBox;
      const center = arm.getCenter(new THREE.Vector3());
      const hit = ray(glass, center.x, center.y, side * 1.4, 0, 0, -side, 0.8);
      assert.ok(hit, 'the mirror arm meets actual glazing at this position');
      assert.ok(hit.point.z >= arm.min.z && hit.point.z <= arm.max.z, 'arm embeds into the real window plane');
      assert.ok(arm.intersectsBox(housing), 'arm reaches its mirror housing');
    }
  });

  test(`${variant} nose and tail support the full lamp panels instead of leaving their upper corners floating`, () => {
    const body = part(vehicle, 'body-shell');
    for (const [name, end] of [['front-lamp-panel', 1], ['rear-lamp-panel', -1]]) {
      const bounds = part(vehicle, name).geometry.boundingBox;
      const panelBack = end > 0 ? bounds.min.x : bounds.max.x;
      for (const y of [bounds.min.y + 0.002, bounds.max.y - 0.002]) for (const z of [bounds.min.z + 0.002, 0, bounds.max.z - 0.002]) {
        const hit = ray(body, end * (vehicle.profile.length / 2 + 0.15), y, z, -end, 0, 0, 0.5);
        assert.ok(hit, 'actual closed body surface exists behind each panel corner and center');
        assert.ok(end * (hit.point.x - panelBack) >= 0, 'the lamp-panel back embeds in the real stamped body');
      }
    }
  });

  test(`${variant} shell, glazing, roof and bumpers have closed triangle surfaces`, () => {
    for (const name of ['body-shell', 'cabin-glass', 'crowned-roof', 'front-bumper', 'rear-bumper']) {
      const p = part(vehicle, name).geometry.attributes.position, edges = new Map();
      const key = index => [p.getX(index), p.getY(index), p.getZ(index)].map(n => Math.round(n * 100000)).join(',');
      for (let i = 0; i < p.count; i += 3) {
        const triangle = [key(i), key(i + 1), key(i + 2)];
        assert.equal(new Set(triangle).size, 3, name + ' has no zero-length triangle edge');
        for (let j = 0; j < 3; j++) {
          const edge = [triangle[j], triangle[(j + 1) % 3]].sort().join('|');
          edges.set(edge, (edges.get(edge) ?? 0) + 1);
        }
      }
      for (const count of edges.values()) assert.equal(count, 2, name + ' has two faces at each welded edge');
    }
  });
}

for (const variant of ['panel-van', 'passenger-van']) {
  const vehicle = createCivilianVehicle({ variant }), c = vehicle.profile.cabin;
  const sideGlass = vehicle.profile.glazingRegions.filter(region => region.partName !== 'van-cab-glass-front'
    && !region.partName.startsWith('passenger-rear-glass-'));

  test(`${variant} tall cargo/cab panels bear on the body and fit beneath one continuous roof`, () => {
    const body = part(vehicle, 'body-shell'), roof = part(vehicle, 'crowned-roof');
    for (const x of [c.baseRearX + 0.025, -1.0, 0, c.baseFrontX - 0.025]) for (const side of [-1, 1]) {
      const hit = ray(body, x, c.beltY + 0.10, side * c.baseHalfWidth, 0, -1, 0, 0.15);
      assert.ok(hit && hit.point.y > c.beltY - 0.012, 'lower body supports the real upper panels');
    }
    for (const x of [c.topRearX, -1.0, 0, c.topFrontX]) for (const side of [-1, 1]) {
      const hit = ray(roof, x, c.glassTopY - 0.020, side * c.topHalfWidth, 0, 1, 0, 0.10);
      assert.ok(hit && hit.point.y < c.glassTopY, 'roof spans the cab and cargo side headers');
    }
    near(roof.geometry.boundingBox.max.y, c.roofTopY, 'actual complete roof height');
  });

  test(`${variant} every side window perimeter overlaps real opaque posts, waist and header`, () => {
    const painted = vehicle.group.children.find(mesh => mesh.name.endsWith('-paint'));
    const opaque = new THREE.Mesh(painted.geometry, doubleSided); opaque.updateMatrixWorld();
    for (const region of sideGlass) {
      const pane = part(vehicle, region.partName), p = pane.geometry.attributes.position, b = pane.geometry.boundingBox;
      const side = Math.sign(region.probe[2]);
      function rangeAt(y) {
        const xs = [];
        for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - y) < 1e-5) xs.push(p.getX(i));
        return [Math.min(...xs), Math.max(...xs)];
      }
      const lower = rangeAt(b.min.y), upper = rangeAt(b.max.y);
      for (const fraction of [0.07, 0.5, 0.93]) {
        const y = THREE.MathUtils.lerp(b.min.y, b.max.y, fraction);
        const left = THREE.MathUtils.lerp(lower[0], upper[0], fraction), right = THREE.MathUtils.lerp(lower[1], upper[1], fraction);
        for (const x of [left + 0.003, right - 0.003]) assert.ok(ray(opaque, x, y,
          side * (vehicle.profile.width / 2 + 0.4), 0, 0, -side, 0.8), `${region.partName}: fitted vertical jamb`);
      }
      for (const [y, xs] of [[b.min.y + 0.003, lower], [b.max.y - 0.003, upper]]) {
        for (const f of [0.2, 0.5, 0.8]) assert.ok(ray(opaque, THREE.MathUtils.lerp(xs[0], xs[1], f), y,
          side * (vehicle.profile.width / 2 + 0.4), 0, 0, -side, 0.8), `${region.partName}: fitted horizontal header/sill`);
      }
    }
  });

  test(`${variant} mirror arms and rear hardware are attached to actual cab/cargo surfaces`, () => {
    const painted = vehicle.group.children.find(mesh => mesh.name.endsWith('-paint'));
    const opaque = new THREE.Mesh(painted.geometry, doubleSided); opaque.updateMatrixWorld();
    for (const side of [-1, 1]) {
      const suffix = side > 0 ? 'left' : 'right';
      const glass = part(vehicle, 'van-cab-glass-' + suffix), arm = part(vehicle, 'mirror-arm-' + suffix).geometry.boundingBox;
      const housing = part(vehicle, 'mirror-housing-' + suffix).geometry.boundingBox, center = arm.getCenter(new THREE.Vector3());
      const hit = ray(glass, center.x, center.y, side * 1.5, 0, 0, -side, 0.8);
      assert.ok(hit && hit.point.z >= arm.min.z && hit.point.z <= arm.max.z, 'arm meets the sloped cab glazing');
      assert.ok(arm.intersectsBox(housing), 'arm reaches the mirror shell');
    }
    if (vehicle.profile.cargo.opaque) for (const name of vehicle.profile.parts.filter(name => name.startsWith('cargo-rear-hinge-'))) {
      const bounds = part(vehicle, name).geometry.boundingBox, center = bounds.getCenter(new THREE.Vector3());
      const hit = ray(opaque, center.x - 0.2, center.y, center.z, 1, 0, 0, 0.4);
      assert.ok(hit && hit.point.x <= bounds.max.x, 'rear hinge embeds in the opaque door');
    }
  });

  test(`${variant} cargo, door panels and every glass pane are closed solids`, () => {
    const names = vehicle.profile.parts.filter(name => name === 'cargo-body' || name === 'cargo-waist'
      || name === 'cargo-roof-header' || name.startsWith('van-cab-') || name.includes('-glass-'));
    for (const name of names) {
      const p = part(vehicle, name).geometry.attributes.position, edges = new Map();
      const key = index => [p.getX(index), p.getY(index), p.getZ(index)].map(n => Math.round(n * 100000)).join(',');
      for (let i = 0; i < p.count; i += 3) {
        const triangle = [key(i), key(i + 1), key(i + 2)];
        assert.equal(new Set(triangle).size, 3, name + ' has no zero-length triangle edge');
        for (let j = 0; j < 3; j++) {
          const edge = [triangle[j], triangle[(j + 1) % 3]].sort().join('|');
          edges.set(edge, (edges.get(edge) ?? 0) + 1);
        }
      }
      for (const count of edges.values()) assert.equal(count, 2, name + ' has no open triangle edge');
    }
  });
}
