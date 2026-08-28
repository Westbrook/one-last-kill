import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { BUILDING, ROOF } from '../../src/world/layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { mulberry32, TAU } from '../../src/core/math.js';

// Real instance transforms, with no renderer, browser, canvas drawing or audio.
// The environment builder's browser-facing imports are replaced explicitly.
function buildFixture(surfaceOverrides = {}) {
  const source = readFileSync(new URL('../../src/render/environment.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export (?=function )/gm, '');
  assert.doesNotMatch(source, /^import\s/m);
  const scene = new THREE.Scene(), World = new THREE.Group();
  scene.add(World);
  const surfaces = {
    'neighbor-dining-top': { x: 3, y: BUILDING.apartmentY + 0.74, z: -5, width: 1.8, height: 0.16, depth: 1.1 },
    'apartment-coffee-table': { x: -10, y: BUILDING.apartmentY + 0.48, z: -5, width: 1.4, height: 0.06, depth: 0.9 },
    'apartment-kitchen-top': { x: -14.4, y: BUILDING.apartmentY + 0.945, z: -2.5, width: 1, height: 0.05, depth: 2.4 },
    'apartment-mattress': { x: -13.8, y: BUILDING.apartmentY + 0.8, z: -8, width: 2, height: 0.3, depth: 1.1 },
  };
  for (const [name, original] of Object.entries(surfaces)) {
    const surface = { ...original, ...surfaceOverrides[name] };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(surface.width, surface.height, surface.depth), new THREE.MeshStandardMaterial());
    mesh.name = name; mesh.position.set(surface.x, surface.y - surface.height / 2, surface.z);
    World.add(mesh);
  }
  const materials = new Map();
  const MATS = new Proxy({}, {
    get(_, key) {
      if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
      return materials.get(key);
    },
  });
  const bindings = {
    THREE, BUILDING, ROOF, DISTRICT, mulberry32, TAU, scene, World, MATS,
    camera: new THREE.PerspectiveCamera(),
    WorldState: { fires: [], flickerLights: [] },
    document: {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return { width: 0, height: 0, getContext: () => ({ fillRect() {} }) };
      },
    },
  };
  const api = runInNewContext(`${source}\n;({ buildEnvironment, updateEnvironment, planCityBuildings, cityBuildingFootprint, getAtmosphere: () => atmosphere });`, bindings);
  const environment = api.buildEnvironment();
  World.updateMatrixWorld(true);
  return { ...api, World, environment };
}

const fixture = buildFixture();
const epsilon = 0.0001;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < epsilon, `${label}: ${actual} != ${expected}`);
const playable = {
  x1: Math.min(DISTRICT.bounds.x1, BUILDING.tower.x1, ROOF.x1),
  x2: Math.max(DISTRICT.bounds.x2, ROOF.x2),
  z1: Math.min(DISTRICT.bounds.z1, ROOF.z1),
  z2: Math.max(DISTRICT.bounds.z2, ROOF.z2),
};
const overlaps = (a, b, clearance = 0) => a.x1 < b.x2 + clearance && a.x2 > b.x1 - clearance
  && a.z1 < b.z2 + clearance && a.z2 > b.z1 - clearance;
const footprint = box => ({ x1: box.min.x, x2: box.max.x, z1: box.min.z, z2: box.max.z });

function instances(name, world = fixture.World) {
  const mesh = world.getObjectByName(name);
  assert.ok(mesh?.isInstancedMesh, `${name} is batched`);
  mesh.geometry.computeBoundingBox();
  return Array.from({ length: mesh.count }, (_, index) => {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
    const bounds = mesh.geometry.boundingBox.clone().applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
    return { bounds, position, scale, normal };
  });
}

test('city lots clear the expanded district, including their dressed edges, for every seed', () => {
  for (let seed = 0; seed < 24; seed++) {
    const buildings = fixture.planCityBuildings(mulberry32(seed));
    assert.equal(buildings.length, 56, 'keep both complete surrounding blocks');
    const lots = buildings.map(fixture.cityBuildingFootprint);
    for (let i = 0; i < lots.length; i++) {
      assert.ok(!overlaps(lots[i], playable, 3), `seed ${seed}, lot ${i} clears playable envelope`);
      for (let j = 0; j < i; j++) assert.ok(!overlaps(lots[i], lots[j], 0.6), `seed ${seed}, lots ${i}/${j} remain separate`);
    }
  }
});

test('all rendered city masses, facades, cornices and rooftop details stay outside the playable block', () => {
  const buildings = fixture.planCityBuildings(mulberry32(27082026));
  const lots = buildings.map(fixture.cityBuildingFootprint);
  for (const mesh of fixture.environment.children.filter(child => child.isInstancedMesh && child.name.startsWith('city-'))) {
    for (const item of instances(mesh.name)) {
      const actual = footprint(item.bounds);
      assert.ok(!overlaps(actual, playable, 3), `${mesh.name} clears district and bakery`);
      assert.ok(lots.some(lot => actual.x1 >= lot.x1 - epsilon && actual.x2 <= lot.x2 + epsilon
        && actual.z1 >= lot.z1 - epsilon && actual.z2 <= lot.z2 + epsilon), `${mesh.name} remains in its reserved lot`);
    }
  }
});

test('background buildings enter the ground and rooftop tanks have continuous support', () => {
  const ground = new THREE.Box3().setFromObject(fixture.World.getObjectByName('city-ground'));
  for (const { bounds } of instances('city-brick-buildings')) {
    assert.ok(bounds.min.y < ground.max.y && bounds.max.y > ground.max.y, 'body meets ground');
    assert.ok(bounds.min.x > ground.min.x && bounds.max.x < ground.max.x
      && bounds.min.z > ground.min.z && bounds.max.z < ground.max.z, 'ground extends under every building');
  }
  const hardware = instances('city-roof-hardware'), cornices = instances('city-cornices');
  const supports = (base, top) => Math.abs(base.min.y - top.max.y) < epsilon
    && overlaps(footprint(base), footprint(top));
  for (const { bounds } of hardware) {
    assert.ok(cornices.some(item => supports(bounds, item.bounds)) || hardware.some(item => supports(bounds, item.bounds)),
      'roof hardware rests on coping or a cradle support');
  }
  const tanks = instances('city-water-tanks');
  for (const { bounds } of tanks) assert.ok(hardware.some(item => supports(bounds, item.bounds)), 'tank rests on its cradle');
  for (const { bounds } of instances('city-water-tank-caps')) {
    assert.ok(tanks.some(item => supports(bounds, item.bounds)), 'cap rests on tank');
  }
});

test('annex glazing belongs to outer walls while the apartment window faces the open lightwell', () => {
  const panes = instances('environment-window-panes');
  const east = panes.filter(item => item.normal.x > 0.99);
  assert.equal(east.length, 24);
  for (const { position, bounds } of east) {
    near(position.x, ROOF.x2 + 0.015, 'east pane on annex facade');
    assert.ok(bounds.min.z > ROOF.z1 && bounds.max.z < ROOF.z2);
  }
  assert.ok(!panes.some(item => Math.abs(item.position.x - BUILDING.main.x2) < 0.2 && item.normal.x > 0.99),
    'no old east windows buried in the new wing');
  const north = panes.filter(item => item.position.z < ROOF.z1);
  assert.equal(north.length, 40);
  for (const { position, normal, bounds } of north) {
    near(position.z, ROOF.z1 - 0.015, 'north pane on annex facade');
    assert.ok(normal.z < -0.99 && bounds.min.x > ROOF.x1 && bounds.max.x < ROOF.x2);
  }
  const court = panes.filter(item => item.normal.z < -0.99 && item.position.z > ROOF.lightwell.z1);
  assert.equal(court.length, 1, 'retain the real apartment lightwell window');
  assert.ok(court[0].bounds.min.x > ROOF.lightwell.x1 && court[0].bounds.max.x < ROOF.lightwell.x2);
  assert.ok(court[0].position.z < ROOF.lightwell.z2);
  const south = panes.filter(item => item.normal.z > 0.99 && item.position.x > BUILDING.main.x2);
  assert.equal(south.length, 12);
  for (const { position } of south) near(position.z, ROOF.z2 + 0.015, 'south pane on annex facade');
  const frames = instances('environment-wood-details').filter(item => Math.abs(item.scale.z - 0.1) < epsilon);
  for (const { position, bounds } of frames) {
    if (position.x > ROOF.x2) assert.ok(bounds.min.x < ROOF.x2 && bounds.max.x > ROOF.x2, 'east frame embeds in wall');
    else if (position.z < ROOF.z1) assert.ok(bounds.min.z < ROOF.z1 && bounds.max.z > ROOF.z1, 'north frame embeds in wall');
    else if (position.z > ROOF.z2) {
      const face = position.x > BUILDING.main.x2 ? ROOF.z2 : BUILDING.main.z2 + BUILDING.wallThickness / 2;
      assert.ok(bounds.min.z < face && bounds.max.z > face, 'south frame embeds in wall');
    }
  }
});

test('street grates and paper follow the new curb positions and their real surface height', () => {
  const { road, nearApron, farWalk } = DISTRICT.street;
  const grates = instances('environment-metal-details').filter(item => item.bounds.max.y < 0.2 && item.scale.x > 0.6);
  assert.equal(grates.length, 3);
  for (const { bounds, position } of grates) {
    near(bounds.min.y, road.floorY, 'grate rests on road');
    near(position.z, road.z1 + 0.28, 'grate follows near curb');
    assert.ok(bounds.min.z > road.z1 && bounds.max.z < road.z2);
  }
  const papers = instances('environment-papers').filter(item => item.position.y < 1);
  assert.equal(papers.length, 30);
  const counts = new Map([[road, 0], [nearApron, 0], [farWalk, 0]]);
  for (const { bounds, position } of papers) {
    const surface = [road, nearApron, farWalk].find(area => position.z > area.z1 && position.z < area.z2);
    assert.ok(surface, 'paper has an authored pavement surface');
    assert.ok(position.y > surface.floorY && position.y <= surface.floorY + 0.008, 'paper lies just above pavement');
    assert.ok(bounds.min.x > surface.x1 && bounds.max.x < surface.x2
      && bounds.min.z > surface.z1 && bounds.max.z < surface.z2, 'paper stays on one surface');
    counts.set(surface, counts.get(surface) + 1);
  }
  for (const count of counts.values()) assert.equal(count, 10);
});

test('the clothesline is fixed to the north parapet and clears the new roof service house', () => {
  const posts = instances('environment-pipes').filter(item => Math.abs(item.scale.y - 2.18) < epsilon);
  assert.equal(posts.length, 2);
  for (const { position, bounds } of posts) {
    near(position.z, ROOF.z1 + 0.03, 'north parapet mount');
    assert.ok(bounds.min.y < ROOF.floorY + 1.2 && bounds.max.y > ROOF.floorY + 1.2, 'post enters parapet coping');
  }
  const cloths = instances('environment-folded-cloth').filter(item => item.position.y > ROOF.floorY);
  assert.equal(cloths.length, 3);
  for (const { bounds } of cloths) {
    assert.ok(bounds.min.y > ROOF.floorY + 1.84, 'laundry stays above standing head height');
    assert.ok(!overlaps(footprint(bounds), ROOF.serviceHouse), 'laundry misses service house');
    assert.ok(!overlaps(footprint(bounds), ROOF.lightwell), 'laundry does not span lightwell');
  }
});

test('existing apartment props follow moved furniture surfaces and radiator feet reach the floor', () => {
  const moved = buildFixture({
    'apartment-coffee-table': { x: -9.8, y: 4.61, z: -5.2 },
    'apartment-kitchen-top': { x: -14.3, y: 5.03, z: -2.6 },
    'apartment-mattress': { x: -13.7, y: 4.86, z: -8.1 },
  });
  const book = instances('environment-wood-details', moved.World).find(item => Math.abs(item.scale.y - 0.075) < epsilon);
  assert.ok(book);
  near(book.position.x, -9.8 - 0.42, 'book follows coffee table x');
  near(book.position.z, -5.2 + 0.18, 'book follows coffee table z');
  near(book.bounds.min.y, 4.61, 'book rests on coffee table');
  const vessels = instances('environment-pipes', moved.World)
    .filter(item => Math.abs(item.scale.y - 0.1) < epsilon || Math.abs(item.scale.y - 0.28) < epsilon);
  assert.equal(vessels.length, 2);
  for (const { position, bounds } of vessels) {
    near(position.x, -14.3, 'vessel follows kitchen worktop');
    near(bounds.min.y, 5.03, 'vessel rests on kitchen worktop');
  }
  const dish = instances('environment-plaster-details', moved.World).find(item => Math.abs(item.scale.y - 0.06) < epsilon);
  near(dish.bounds.min.y, 5.03, 'dish rests on kitchen worktop');
  const blanket = instances('environment-folded-cloth', moved.World).find(item => Math.abs(item.scale.x - 1.6) < epsilon);
  near(blanket.position.x, -13.72, 'blanket follows mattress x');
  near(blanket.position.z, -7.8, 'blanket follows mattress z');
  assert.ok(blanket.bounds.min.y >= 4.86 && blanket.bounds.min.y < 4.875, 'blanket folds meet mattress surface');
  const feet = instances('environment-metal-details').filter(item => Math.abs(item.scale.y - 0.16) < epsilon);
  assert.equal(feet.length, 2);
  for (const { bounds } of feet) near(bounds.min.y, BUILDING.apartmentY, 'radiator foot rests on floor');
});

test('expanded decoration keeps the fixed batch, light and particle budget', () => {
  assert.equal(fixture.environment.userData.cityBuildings, 56);
  assert.equal(fixture.environment.children.filter(child => child.isInstancedMesh).length, 14);
  assert.equal(fixture.environment.children.filter(child => child.isPointLight).length, 2);
  assert.equal(fixture.environment.userData.particleCount, 144);
  const atmosphere = fixture.getAtmosphere();
  const sphere = atmosphere.points.geometry.boundingSphere;
  for (let i = 0; i < atmosphere.count; i++) {
    const offset = i * 6;
    for (const x of [atmosphere.bounds[offset], atmosphere.bounds[offset + 1]]) {
      for (const y of [atmosphere.bounds[offset + 2], atmosphere.bounds[offset + 3]]) {
        for (const z of [atmosphere.bounds[offset + 4], atmosphere.bounds[offset + 5]]) {
          assert.ok(sphere.containsPoint(new THREE.Vector3(x, y, z)), 'culling sphere contains full particle motion');
        }
      }
    }
  }
});
