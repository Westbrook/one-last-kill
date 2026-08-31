import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { BUILDING, BALCONY, ROOF, APARTMENT_DOORS } from '../../src/world/layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { createInteriorProps } from '../../src/world/interior-props.js';
import { createDoorAssemblies } from '../../src/world/door-assemblies.js';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { CHECKPOINTS } from '../../src/game/mission-data.js';
import { mulberry32, TAU } from '../../src/core/math.js';
import { createStaticSurfaceBatch } from '../../src/render/static-surface-batch.js';
import { buildExteriorDetail, finishExteriorMaterials } from '../../src/render/exterior-detail.js';
import { buildBakeryStoryDetail } from '../../src/render/bakery-story-detail.js';
import { addBakeryBread, addBakeryPackage } from '../../src/render/bakery-provisions.js';
import { getBakeryProvisionMaterials } from '../../src/render/bakery-provision-materials.js';
import { addCrtHousing } from '../../src/render/crt-housing.js';
import { refineConcreteBarrier } from '../../src/render/street-barrier.js';
import { createSedanCabin } from '../../src/render/sedan-cabin.js';
import { createSedanBumper, createSedanHood } from '../../src/render/sedan-panels.js';
import { createCivilianVehicle } from '../../src/render/civilian-vehicles.js';
import { buildClosedStorefront, getStorefrontMaterials, STOREFRONT_STYLES } from '../../src/render/storefront-kit.js';

// Execute the authored builders with real Three.js math/geometry and injected
// scene services. Their browser-facing imports are deliberately not evaluated:
// this harness creates no renderer, AudioContext, window, or browser session.
// It checks placement contracts, not pixels, material quality, or draw calls.
function loadBuilder(path, bindings, names) {
  const original = readFileSync(new URL(path, import.meta.url), 'utf8');
  const source = original
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m, 'Update the explicit harness if builder imports become multiline');
  return runInNewContext(`${source}\n;({ ${names.join(', ')} });`, bindings, { filename: path });
}

function buildFixture() {
  Architecture.clear(); Colliders.clear();
  const scene = new THREE.Scene(), World = new THREE.Group();
  scene.add(World);
  const materials = new Map();
  const MATS = new Proxy({}, {
    get(_, key) {
      if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
      return materials.get(key);
    },
  });
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const _BG = { unitBox, pipe: new THREE.CylinderGeometry(1, 1, 1, 8) };
  const _CG = new Proxy({}, { get: () => unitBox });
  const decorations = [];
  function addBox(x, y, z, sx, sy, sz, material, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(x, y, z); World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, sx, sy, sz);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, sx, sy, sz), options.architecture);
    return mesh;
  }
  function pushDecor(geometry, material, x, y, z, sx, sy, sz, yaw = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw;
    World.add(mesh); decorations.push({ x, y, z, sx, sy, sz });
  }
  function addWallZ(x, floor, z, length, height, thickness, material, opening) {
    if (!opening) return addBox(x, floor + height / 2, z, thickness, height, length, material);
    const low = z - length / 2, high = z + length / 2;
    const { zStart, zEnd, headerH = 0.3, sillH = 0 } = opening;
    if (zStart > low) addBox(x, floor + height / 2, (low + zStart) / 2, thickness, height, zStart - low, material);
    if (zEnd < high) addBox(x, floor + height / 2, (zEnd + high) / 2, thickness, height, high - zEnd, material);
    if (headerH > 0) addBox(x, floor + height - headerH / 2, (zStart + zEnd) / 2, thickness, headerH, zEnd - zStart, material);
    if (sillH > 0) addBox(x, floor + sillH / 2, (zStart + zEnd) / 2, thickness, sillH, zEnd - zStart, material);
  }
  function addSign(x, y, z, width, height, normal) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), MATS.metal);
    mesh.position.set(x, y, z); mesh.rotation.y = signYaw(normal); World.add(mesh);
    return mesh;
  }
  const WorldState = { bakeryLights: [], smokeSystems: [], flickerLights: [], fires: [] };
  const bindings = {
    refineConcreteBarrier, buildClosedStorefront, getStorefrontMaterials, STOREFRONT_STYLES, createCivilianVehicle,
    THREE, RoundedBoxGeometry, mergeGeometries, BUILDING, BALCONY, ROOF, APARTMENT_DOORS, DISTRICT, createInteriorProps, createDoorAssemblies,
    World, WorldState, MATS, _CG, _BG, Colliders,
    addBox, addWallZ, addSign, pushDecor, addBakeryBread, addBakeryPackage, getBakeryProvisionMaterials, addCrtHousing, createSedanCabin, createSedanBumper, createSedanHood,
    addDecor: (x, y, z, sx, sy, sz, material) => addBox(x, y, z, sx, sy, sz, material, { collide: false }),
    makeSignTexture: () => new THREE.Texture(),
    makeHumanoid: () => new THREE.Group(), HUMANOID_PRESETS: { shopkeeper: {} },
    Triggers: { add() {} }, setFireActive() {}, addFlickerLight() {},
    spawnFire() { return { group: new THREE.Group(), light: new THREE.PointLight() }; },
    makeSmokeSystem: () => ({ points: new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()) }),
  };
  const apartments = loadBuilder('../../src/world/zones/apartments.js', bindings, ['buildPlayerApartment', 'buildNeighborApartment']);
  const street = loadBuilder('../../src/world/zones/street.js', bindings, ['buildStreet', 'buildBakeryAndCar']);
  apartments.buildPlayerApartment(); apartments.buildNeighborApartment();
  street.buildStreet(); street.buildBakeryAndCar();

  // Canvas drawing is intentionally a no-op; CanvasTexture only needs an image
  // container to build the instance transforms checked below. No GPU is used.
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 0, height: 0,
        getContext(kind) {
          assert.equal(kind, '2d');
          return { fillRect() {}, clearRect() {}, createRadialGradient() { return { addColorStop() {} }; } };
        },
      };
    },
  };
  const environment = loadBuilder('../../src/render/environment.js', {
    ...bindings, scene, camera: new THREE.PerspectiveCamera(), mulberry32, TAU, document, createStaticSurfaceBatch, buildExteriorDetail, finishExteriorMaterials, buildBakeryStoryDetail,
  }, ['buildEnvironment']);
  environment.buildEnvironment();
  World.updateMatrixWorld(true);
  return { World, records: new Map(Architecture.elements), decorations };
}

const fixture = buildFixture();
const bounds = id => fixture.records.get(id)?.bounds;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);

test('main shell returns and upper facade share the authored roof envelope', () => {
  for (const id of ['main-ground-south', 'main-ground-north', 'main-upper-south', 'main-upper-north']) {
    near(bounds(id).min.x, BUILDING.main.x1, `${id} west edge`);
    near(bounds(id).max.x, BUILDING.main.x2, `${id} east edge`);
  }
  for (const id of ['main-ground-east', 'main-upper-east']) {
    near(bounds(id).min.z, BUILDING.main.z1, `${id} north return`);
    near(bounds(id).max.z, BUILDING.main.z2, `${id} south return`);
  }
  near(bounds('main-ground-east').max.y, BUILDING.apartmentY, 'terrace floor');
  near(bounds('main-upper-east').min.y, BUILDING.canopyY, 'terrace recess ceiling');
  near(bounds('main-upper-east').max.y, BUILDING.roofY, 'roof support');
});

test('pavement meets facades without covering the bakery floor and visible gates close ground edges', () => {
  near(bounds('near-apron').min.z, 0, 'near apron starts at facade');
  near(bounds('near-apron').max.z, DISTRICT.street.nearApron.z2, 'near apron ends at curb');
  near(bounds('near-apron').max.y, 0.14, 'scaffold footing support');
  near(bounds('far-sidewalk').max.z, bounds('far-frontage-apron').min.z, 'opposite pavement join');
  near(bounds('far-frontage-apron').max.z, DISTRICT.street.frontageZ, 'opposite facade join');
  assert.ok(bounds('far-frontage-apron').min.x >= bounds('bakery-floor').max.x);
  near(bounds('bakery-floor').max.y, 0.08, 'bakery interior remains lower');
  for (const id of ['west-service-gate', 'east-service-gate']) {
    const gate = fixture.records.get(id);
    assert.ok(gate.mesh.visible && gate.collider, `${id} has matching visible geometry`);
    assert.ok(gate.bounds.max.y < BUILDING.apartmentY);
    near(gate.bounds.min.y, bounds('near-apron').max.y, `${id} feet`);
  }
});

test('bakery sign, canopy and car placard have physical mounts and face their approach', () => {
  const sign = fixture.World.getObjectByName('bakery-shop-sign');
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(sign.quaternion);
  assert.ok(normal.z < -0.999);
  const fascia = bounds(sign.userData.mountId);
  assert.ok(sign.position.z < fascia.min.z);
  const signBounds = new THREE.Box3().setFromObject(sign);
  assert.ok(signBounds.min.y >= fascia.min.y && signBounds.max.y <= fascia.max.y);
  const awning = fixture.World.getObjectByName('bakery-street-awning');
  const awningBounds = new THREE.Box3().setFromObject(awning);
  assert.ok(awningBounds.max.z < DISTRICT.bakery.z1, 'canopy projects over street, not into shop');
  assert.ok(awningBounds.intersectsBox(fascia), 'canopy inner edge attaches to fascia');
  assert.ok(bounds('car-placard-backing').intersectsBox(bounds('car-placard-post')));
  assert.equal(fixture.World.getObjectByName('car-parking-sign').userData.mountId, 'car-placard-backing');
});

test('table, chair and counter supports reach their surfaces and floor', () => {
  near(bounds('neighbor-dining-top').max.y, BUILDING.apartmentY + 0.74, 'dining surface');
  for (let i = 0; i < 4; i++) {
    const leg = bounds(`neighbor-table-leg-${i}`);
    near(leg.min.y, bounds('neighbor-floor').max.y, `table leg ${i} foot`);
    near(leg.max.y, bounds('neighbor-dining-top').min.y, `table leg ${i} top`);
  }
  // Authored legs carry their real dimensions in the geometry; inspect the
  // rendered bounds instead of assuming every decoration is a scaled cube.
  const chairLegs = [];
  fixture.World.traverse(mesh => {
    if (!mesh.isMesh) return;
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    if (Math.abs(size.x - 0.055) < 1e-5 && Math.abs(size.y - 0.39) < 1e-5
      && Math.abs(size.z - 0.055) < 1e-5) chairLegs.push(mesh);
  });
  assert.equal(chairLegs.length, 8);
  for (const leg of chairLegs) {
    const actual = new THREE.Box3().setFromObject(leg);
    near(actual.min.y, BUILDING.apartmentY, 'chair foot');
    near(actual.max.y, BUILDING.apartmentY + 0.39, 'chair seat connection');
  }
  near(bounds('bakery-counter-base').min.y, bounds('bakery-floor').max.y, 'counter base');
  near(bounds('bakery-counter-base').max.y, bounds('bakery-counter-top').min.y, 'counter top');
});

test('apartment, neighbor and bakery checkpoint capsules remain clear', () => {
  for (const zone of ['apartment', 'neighbor', 'bakery']) {
    const anchor = CHECKPOINTS[zone];
    assert.ok(capsuleHasClearance(new THREE.Vector3(anchor.x, anchor.y + 0.02, anchor.z), 0.32, 1.84, Colliders.list), zone);
  }
  assert.ok(capsuleHasClearance(new THREE.Vector3(9, 4.02, -5), 0.32, 1.84, Colliders.list), 'balcony doorway');
  assert.ok(capsuleHasClearance(new THREE.Vector3(-18.75, 0.16, DISTRICT.bakery.z1), 0.32, 1.84, Colliders.list), 'bakery doorway');
});

test('environment windows respect the envelope and the dining paper follows its actual tabletop', () => {
  const panes = fixture.World.getObjectByName('environment-window-panes');
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  for (let i = 0; i < panes.count; i++) {
    panes.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix);
    if (position.y > BUILDING.canopyY && Math.abs(position.z - 0.13) < 1e-5) {
      assert.ok(position.x + 0.66 <= BUILDING.main.x2, 'front window fits supported facade');
    }
  }
  const papers = fixture.World.getObjectByName('environment-papers');
  let diningPaper = null;
  for (let i = 0; i < papers.count; i++) {
    papers.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix);
    if (Math.abs(position.x - 2.55) < 1e-5 && Math.abs(position.z + 5.12) < 1e-5) diningPaper = position.clone();
  }
  assert.ok(diningPaper, 'dining paper instance exists');
  near(diningPaper.y, bounds('neighbor-dining-top').max.y + 0.006, 'paper rests on table');
});
