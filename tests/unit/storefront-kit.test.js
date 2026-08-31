import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTRICT } from '../../src/world/district-layout.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { getStorefrontMaterials } from '../../src/render/storefront-kit.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
const storefronts = fixture.entries.filter(entry => entry.source?.some(line => /buildClosedStorefront/.test(line)));
const masses = fixture.entries.filter(entry => entry.id.startsWith('storefront-mass-'));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);

test('the dressed shops retain their original solid building envelopes and stay clear of the bakery entrance', () => {
  assert.equal(masses.length, DISTRICT.shops.length);
  for (const shop of DISTRICT.shops) {
    const mass = masses.find(entry => entry.id === 'storefront-mass-' + shop.id);
    const collider = mass.mesh.userData.collider;
    assert.ok(collider);
    near(collider.min.x, shop.x1, 'west wall'); near(collider.max.x, shop.x2, 'east wall');
    near(collider.min.z, DISTRICT.street.frontageZ, 'closed frontage'); near(collider.max.z, DISTRICT.bakery.z2, 'rear wall');
    near(collider.min.y, DISTRICT.street.farWalk.floorY, 'floor'); near(collider.max.y, shop.height, 'roof');
  }
  for (const { bounds } of storefronts) {
    assert.ok(bounds.min.z >= DISTRICT.street.frontageZ - 0.26, 'shallow joinery stays behind the standing capsule contact plane');
    assert.ok(bounds.max.x <= DISTRICT.bakery.x1 + 0.011 || bounds.min.x >= DISTRICT.bakery.x2 - 0.011,
      'closed-shop treatment does not cross into the open objective');
    if (bounds.min.y < 2.4) assert.ok(bounds.min.y >= DISTRICT.street.farWalk.floorY - 0.021,
      'no inaccessible low trim is placed below the pavement');
  }
});

test('one shared opaque atlas survives batching with inset UVs and no per-sign material clones', () => {
  const signs = storefronts.filter(entry => entry.mesh.geometry.name.startsWith('storefront-atlas-plane-'));
  assert.equal(signs.length, 19);
  assert.equal(new Set(signs.map(entry => entry.mesh.material)).size, 1);
  assert.equal(new Set(signs.map(entry => entry.mesh.material.map)).size, 1);
  assert.equal(signs[0].mesh.material.transparent, false);
  for (const { mesh } of signs) {
    const uv = mesh.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      assert.ok(uv.getX(i) > 0 && uv.getX(i) < 1, 'horizontal gutter remains inside atlas');
      assert.ok(uv.getY(i) > 0 && uv.getY(i) < 1, 'vertical gutter remains inside atlas');
    }
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    near(normal.z, -1, 'all printed faces point toward the street');
  }
});

test('every large printed fascia sits on a backing that reaches both the print and its masonry', () => {
  for (const shop of DISTRICT.shops) {
    const sign = storefronts.find(entry => entry.mesh.geometry.name === `storefront-atlas-plane-${shop.id}:0:1`);
    const backings = storefronts.filter(entry => entry !== sign && entry.bounds.min.z > sign.bounds.min.z
      && entry.bounds.min.x < sign.bounds.min.x && entry.bounds.max.x > sign.bounds.max.x
      && entry.bounds.min.y < sign.bounds.min.y && entry.bounds.max.y > sign.bounds.max.y);
    backings.sort((a, b) => a.bounds.min.z - b.bounds.min.z);
    assert.ok(backings.length, 'a physical board covers the complete printed face');
    near(backings[0].bounds.min.z - sign.bounds.min.z, 0.002, 'printed face stands only 2 mm off its board');
    assert.ok(backings[0].bounds.max.z > DISTRICT.street.frontageZ, 'board embeds into the solid masonry');
  }
});

test('facade material variants reuse source maps without recoloring or disposing shared finishes', () => {
  const materials = Object.fromEntries(['brick', 'plaster', 'wood', 'concrete', 'metal', 'glass', 'tar'].map(name => {
    const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture() });
    material.userData = { surfaceKind: name, surfaceMeters: 1.4 };
    return [name, material];
  }));
  const originalColors = Object.values(materials).map(material => material.color.getHex());
  const a = getStorefrontMaterials(materials), b = getStorefrontMaterials(materials);
  assert.equal(a, b, 'all seven shops retrieve the same cached resources');
  for (const [variant, source] of [['warmBrick', 'brick'], ['plaster', 'plaster'], ['coolPlaster', 'plaster'], ['sage', 'wood'], ['oxblood', 'wood'], ['ivory', 'concrete'], ['iron', 'metal'], ['glass', 'glass']]) {
    assert.notEqual(a[variant], materials[source]);
    for (const key of ['map', 'normalMap', 'roughnessMap']) assert.equal(a[variant][key], materials[source][key], `${variant} shares ${key}`);
    assert.equal(a[variant].userData.surfaceKind, source);
  }
  assert.deepEqual(Object.values(materials).map(material => material.color.getHex()), originalColors);
});

test('bullets meet the nearest rendered shop glazing or joinery while sight remains blocked by the closed mass', () => {
  const index = createBallisticWorld(); index.rebuild(fixture.World);
  const visible = [...storefronts, ...masses].map(entry => entry.mesh);
  const direction = new THREE.Vector3(0, 0, 1);
  // Probe real authored ground-floor glazing centres, including labels,
  // transoms and frames where their visible surfaces are nearest.
  const glass = storefronts.filter(entry => entry.mesh.material.name === 'storefront-quiet-glazing' && entry.mesh.position.y < 3);
  assert.ok(glass.length >= 10);
  for (const { mesh } of glass) {
    const origin = new THREE.Vector3(mesh.position.x, mesh.position.y, DISTRICT.street.frontageZ - 0.65);
    const direct = new THREE.Raycaster(origin, direction, 0, 1).intersectObjects(visible, false)[0];
    const hit = index.raycast(origin, direction, 1, 'bullet');
    assert.ok(direct && hit, 'both visible geometry and projectile index find a surface');
    near(hit.distance, direct.distance, 'projectile stops on actual visible surface');
    assert.ok(index.raycast(origin, direction, 1, 'sight'), 'a display is still a closed background shop');
  }
});
