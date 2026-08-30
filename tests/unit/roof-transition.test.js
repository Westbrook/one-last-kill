import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDING, ROOF, OPENINGS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { Architecture, boxBounds } from '../../src/world/architecture.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { applyWaterTankStaveUV } from '../../src/render/water-tank-uv.js';

function buildTransition() {
  Architecture.clear(); Colliders.clear();
  const World = new THREE.Group(), materials = new Map();
  const MATS = new Proxy({}, { get(_, key) {
    if (!materials.has(key)) {
      const material = new THREE.MeshStandardMaterial(); material.name = key;
      materials.set(key, material);
    }
    return materials.get(key);
  } });
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
    World.add(mesh);
  }
  function addBeam(id, from, to, width, supports) {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, start.distanceTo(end), width), MATS.metal);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    World.add(mesh); mesh.updateMatrixWorld(true);
    Architecture.register(mesh, null, new THREE.Box3().setFromObject(mesh), { id, kind: 'beam', supports, supportKind: 'anchored' });
  }
  const bindings = {
    THREE, mergeGeometries, BUILDING, ROOF, OPENINGS, STAIRS, World, MATS, Colliders, Architecture, boxBounds, applyWaterTankStaveUV,
    _BG: { unitBox: new THREE.BoxGeometry(1, 1, 1), pipe: new THREE.CylinderGeometry(1, 1, 1, 8) },
    addBox, pushDecor, addBeam, addSign() {}, Triggers: { add() {} },
    addDecor: (x, y, z, sx, sy, sz, material) => addBox(x, y, z, sx, sy, sz, material, { collide: false }),
  };
  for (const [file, name] of [['stairwell', 'buildStairwell'], ['roof', 'buildRoof']]) {
    const source = readFileSync(new URL(`../../src/world/zones/${file}.js`, import.meta.url), 'utf8')
      .replace(/^import .*;\s*$/gm, '').replace(/^export (?=function )/gm, '');
    assert.doesNotMatch(source, /^import\s/m);
    runInNewContext(`${source}\n;${name}();`, bindings);
  }
  World.updateMatrixWorld(true);
  return { World, records: new Map(Architecture.elements), colliders: [...Colliders.list] };
}

const fixture = buildTransition();
const floorIds = ['stair-north-landing-4', 'stair-roof-threshold', 'stair-east-wall', 'roof-deck'];

// Read only vertices referenced by actual upward triangles. Bounds alone can
// miss a deliberately omitted face or mistake hidden masonry for a floor.
function upwardSurface(record) {
  const mesh = record.mesh, geometry = mesh.geometry;
  const positions = geometry.attributes.position, normals = geometry.attributes.normal;
  const vertices = [], normal = new THREE.Vector3();
  const count = geometry.index?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    const indices = [0, 1, 2].map(offset => geometry.index ? geometry.index.getX(i + offset) : i + offset);
    if (!indices.every(index => normal.fromBufferAttribute(normals, index).transformDirection(mesh.matrixWorld).y > 0.999)) continue;
    for (const index of indices) vertices.push(new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
  }
  if (!vertices.length) return null;
  const bounds = new THREE.Box3().setFromPoints(vertices);
  assert.ok(bounds.max.y - bounds.min.y < 1e-6, `${record.id} upward surface must be planar`);
  return { id: record.id, material: mesh.material.name, bounds, y: vertices[0].y };
}

test('actual doorway floor triangles have no overlapping coplanar surfaces', () => {
  const surfaces = floorIds.map(id => upwardSurface(fixture.records.get(id))).filter(Boolean);
  const overlaps = [];
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      const a = surfaces[i], b = surfaces[j];
      const x = Math.min(a.bounds.max.x, b.bounds.max.x) - Math.max(a.bounds.min.x, b.bounds.min.x);
      const z = Math.min(a.bounds.max.z, b.bounds.max.z, OPENINGS.stairRoof.max[2])
        - Math.max(a.bounds.min.z, b.bounds.min.z, OPENINGS.stairRoof.min[2]);
      if (Math.abs(a.y - b.y) < 1e-6 && x > 1e-6 && z > 1e-6) {
        overlaps.push({ surfaces: [a.id, b.id], materials: [a.material, b.material], width: x, area: x * z, heightDifference: Math.abs(a.y - b.y) });
      }
    }
  }
  assert.deepEqual(overlaps, [], `coplanar rendered triangles: ${JSON.stringify(overlaps)}`);
});

test('each sampled point on the doorway seam has exactly one visible floor surface', () => {
  const surfaces = floorIds.map(id => upwardSurface(fixture.records.get(id))).filter(surface => surface && Math.abs(surface.y - STAIRS.exitY) < 1e-6);
  const z = (OPENINGS.stairRoof.min[2] + OPENINGS.stairRoof.max[2]) / 2;
  for (let sample = 0; sample < 40; sample++) {
    const x = -15.6 + sample * 0.025 + 0.0125;
    const covering = surfaces.filter(surface => x > surface.bounds.min.x + 1e-6 && x < surface.bounds.max.x - 1e-6
      && z > surface.bounds.min.z && z < surface.bounds.max.z);
    assert.equal(covering.length, 1, `x=${x}: ${covering.map(surface => surface.id).join(', ')}`);
    assert.ok(Math.abs(covering[0].y - STAIRS.exitY) < 1e-6);
  }
});

test('threshold, landing, roof and masonry meet as supported solids without changing the opening', () => {
  const threshold = fixture.records.get('stair-roof-threshold');
  const landing = fixture.records.get('stair-north-landing-4');
  const roof = fixture.records.get('roof-deck');
  const wall = fixture.records.get('stair-east-wall');
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
  near(threshold.bounds.min.x, landing.bounds.max.x, 'landing meets threshold');
  near(threshold.bounds.max.x, roof.bounds.min.x, 'threshold meets roof');
  near(wall.bounds.max.y, threshold.bounds.min.y, 'masonry bears directly under threshold');
  near(threshold.bounds.min.z, OPENINGS.stairRoof.min[2], 'north doorway edge');
  near(threshold.bounds.max.z, OPENINGS.stairRoof.max[2], 'south doorway edge');
  for (const record of [threshold, landing, roof]) near(record.bounds.max.y, STAIRS.exitY, `${record.id} floor height`);
  assert.ok(threshold.supports.includes(wall.id));
  for (const side of ['north', 'south']) {
    const sill = fixture.records.get(`stair-east-sill-${side}`);
    const jamb = fixture.records.get(`stair-east-upper-${side}`);
    near(sill.bounds.min.y, wall.bounds.max.y, `${side} sill meets base wall`);
    near(sill.bounds.max.y, jamb.bounds.min.y, `${side} jamb meets sill`);
    assert.ok(jamb.supports.includes(sill.id));
    assert.ok(landing.supports.includes(sill.id));
    const parapet = fixture.records.get(`roof-west-${side}-parapet`);
    near(parapet.bounds.min.x, jamb.bounds.max.x, `${side} parapet butts against stair exterior`);
    for (const record of [sill, jamb, parapet]) {
      const actual = new THREE.Box3().setFromObject(record.mesh);
      assert.ok(actual.min.distanceTo(record.bounds.min) < 1e-6 && actual.max.distanceTo(record.bounds.max) < 1e-6,
        `${record.id} uses the measured solid, not just adjusted metadata`);
    }
  }
});

test('roof parapet returns and flashing do not overlap the stair doorway faces', () => {
  const overlaps = [];
  for (const [plane, sign] of [[OPENINGS.stairRoof.min[2], 1], [OPENINGS.stairRoof.max[2], -1]]) {
    const faces = [];
    fixture.World.traverse(mesh => {
      const geometry = mesh.geometry;
      if (!mesh.isMesh || !geometry.attributes.normal) return;
      const positions = geometry.attributes.position, normals = geometry.attributes.normal;
      const vertices = [], normal = new THREE.Vector3();
      const count = geometry.index?.count ?? positions.count;
      for (let i = 0; i < count; i += 3) {
        const indices = [0, 1, 2].map(offset => geometry.index ? geometry.index.getX(i + offset) : i + offset);
        if (!indices.every(index => normal.fromBufferAttribute(normals, index).transformDirection(mesh.matrixWorld).z * sign > 0.999)) continue;
        const triangle = indices.map(index => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
        if (triangle.every(point => Math.abs(point.z - plane) < 1e-6)) vertices.push(...triangle);
      }
      if (!vertices.length) return;
      const bounds = new THREE.Box3().setFromPoints(vertices);
      if (bounds.max.y <= STAIRS.exitY + 1e-6) return;
      faces.push({ id: mesh.name || `${mesh.material.name} detail`, bounds });
    });
    for (let i = 0; i < faces.length; i++) {
      for (let j = i + 1; j < faces.length; j++) {
        const a = faces[i], b = faces[j];
        const x = Math.min(a.bounds.max.x, b.bounds.max.x) - Math.max(a.bounds.min.x, b.bounds.min.x);
        const y = Math.min(a.bounds.max.y, b.bounds.max.y) - Math.max(a.bounds.min.y, b.bounds.min.y, STAIRS.exitY);
        if (x > 1e-6 && y > 1e-6) overlaps.push({ faces: [a.id, b.id], plane, area: x * y });
      }
    }
  }
  assert.deepEqual(overlaps, [], `coplanar jamb triangles: ${JSON.stringify(overlaps)}`);
});

test('west parapet flashing is a thin sheet outside the brick, without coincident outer faces', () => {
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
  for (const side of ['north', 'south']) {
    const parapet = fixture.records.get(`roof-west-${side}-parapet`);
    const brick = new THREE.Box3().setFromObject(parapet.mesh);
    const sheets = [];
    fixture.World.traverse(mesh => {
      if (!mesh.isMesh || mesh.material.name !== 'roofMetal') return;
      const bounds = new THREE.Box3().setFromObject(mesh);
      const correctEnd = side === 'north'
        ? Math.abs(bounds.max.z - (OPENINGS.stairRoof.min[2] - 0.02)) < 1e-6
        : Math.abs(bounds.min.z - (OPENINGS.stairRoof.max[2] + 0.02)) < 1e-6;
      if (correctEnd && Math.abs(bounds.min.y - ROOF.floorY) < 1e-6
        && Math.abs(bounds.max.y - (ROOF.floorY + 0.16)) < 1e-6) sheets.push({ mesh, bounds });
    });
    assert.equal(sheets.length, 1, `${side} parapet has one continuous flashing sheet`);
    const { mesh, bounds } = sheets[0];
    near(bounds.min.x, brick.max.x, `${side} sheet back touches the roof-facing brick surface`);
    near(bounds.max.x - bounds.min.x, 0.02, `${side} sheet thickness`);
    near(bounds.max.x, ROOF.x1 + 0.15, `${side} original clearance is preserved`);
    assert.equal(mesh.userData.collider ?? null, null, 'flashing remains decorative');

    // Inspect the actual indexed west-facing triangles, not only registry
    // bounds: the old full-width sheet duplicated the brick face at x=-15.1.
    const westFacePlanes = solid => {
      const geometry = solid.geometry, positions = geometry.attributes.position, normals = geometry.attributes.normal;
      const planes = [], normal = new THREE.Vector3(), vertex = new THREE.Vector3();
      for (let index = 0; index < geometry.index.count; index++) {
        const i = geometry.index.getX(index);
        if (normal.fromBufferAttribute(normals, i).transformDirection(solid.matrixWorld).x > -0.999) continue;
        planes.push(vertex.fromBufferAttribute(positions, i).applyMatrix4(solid.matrixWorld).x);
      }
      assert.equal(planes.length, 6, 'the box has two west-facing triangles');
      return planes;
    };
    const brickPlanes = westFacePlanes(parapet.mesh), metalPlanes = westFacePlanes(mesh);
    assert.ok(metalPlanes.every(x => brickPlanes.every(brickX => x - brickX > 0.20)),
      `${side} flashing cannot duplicate the exterior brick face`);
  }
});

test('walking, sprinting and stopping across the real roof seam never oscillate vertically', () => {
  const z = (OPENINGS.stairRoof.min[2] + OPENINGS.stairRoof.max[2]) / 2;
  const dt = 1 / 120;
  for (const speed of [1.2, 4.2, 7]) {
    const body = { position: new THREE.Vector3(-16.6, STAIRS.exitY, z), velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
    let maxHeightError = 0, maxStep = 0, maxVerticalVelocity = 0, airborneFrames = 0;
    for (const targetX of [-14.4, -16.6, -15.1, -15.3, -15, -14.4]) {
      const ticks = Math.ceil(Math.abs(targetX - body.position.x) / speed / dt) + 120;
      for (let tick = 0; tick < ticks; tick++) {
        const dx = targetX - body.position.x;
        body.velocity.x = Math.sign(dx) * Math.min(speed, Math.abs(dx) / dt);
        body.velocity.y -= 22 * dt;
        moveCapsule(body, dt, fixture.colliders, Math.abs(dx) > 0.001);
        maxHeightError = Math.max(maxHeightError, Math.abs(body.position.y - STAIRS.exitY));
        maxStep = Math.max(maxStep, body.stepped);
        maxVerticalVelocity = Math.max(maxVerticalVelocity, Math.abs(body.velocity.y));
        if (!body.onGround) airborneFrames++;
      }
      assert.ok(Math.abs(body.position.x - targetX) < 0.001, `seam blocks x=${targetX}`);
      assert.ok(capsuleHasClearance(body.position, body.radius, body.height, fixture.colliders, 1e-6));
    }
    assert.ok(maxHeightError < 1e-7, `height oscillation ${maxHeightError} at speed ${speed}`);
    assert.equal(maxVerticalVelocity, 0, 'internal floor joints must not convert horizontal speed into vertical velocity');
    assert.equal(maxStep, 0, 'flat transition must not inject a camera step offset');
    assert.equal(airborneFrames, 0, 'the seam must retain uninterrupted ground support');
  }
});
