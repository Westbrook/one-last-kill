import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bakeryBreadGeometry, bakeryPackageGeometry, bakeryProvisionGeometryBudget } from '../../src/render/bakery-provisions.js';
import { getBakeryProvisionMaterials, BAKERY_PROVISION_ATLAS } from '../../src/render/bakery-provision-materials.js';
import { buildBakeryStoryDetail } from '../../src/render/bakery-story-detail.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { HEALTH_SUPPLIES } from '../../src/game/health-supply-data.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
const provisions = fixture.entries.filter(entry => entry.mesh.geometry.userData.bakeryProvision);
const bread = provisions.filter(entry => entry.mesh.geometry.userData.bakeryProvision.kind === 'bread');
const packages = provisions.filter(entry => entry.mesh.geometry.userData.bakeryProvision.kind !== 'bread');
const near = (a, b, label = '') => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} != ${b}`);
const inCell = (u, v, cell) => u >= cell.uMin - 1e-6 && u <= cell.uMax + 1e-6 && v >= cell.vMin - 1e-6 && v <= cell.vMax + 1e-6;

test('bread and paper geometry have finite outward surfaces, no collapsed score tips and bounded caches', () => {
  const geometries = new Set(provisions.map(entry => entry.mesh.geometry));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const geometry of geometries) {
    const { position, normal, uv } = geometry.attributes, index = geometry.index;
    assert.ok([...position.array, ...normal.array, ...uv.array].every(Number.isFinite));
    for (let i = 0; i < normal.count; i++) near(n.fromBufferAttribute(normal, i).length(), 1, 'unit surface normal');
    for (let i = 0; i < (index?.count ?? position.count); i += 3) {
      const ids = [0, 1, 2].map(offset => index ? index.getX(i + offset) : i + offset);
      a.fromBufferAttribute(position, ids[0]); b.fromBufferAttribute(position, ids[1]); c.fromBufferAttribute(position, ids[2]);
      const face = b.sub(a).cross(c.sub(a));
      assert.ok(face.length() > 1e-12, 'each visible triangle has area');
      n.set(0, 0, 0);
      for (const id of ids) n.add(c.fromBufferAttribute(normal, id));
      assert.ok(face.dot(n) > 0, 'triangle winding follows its visible normals');
    }
    near(geometry.boundingBox.min.y, 0, 'bearing surface');
  }
  assert.equal(bakeryBreadGeometry(0.30, 0.10, 0.20), bakeryBreadGeometry(0.30, 0.10, 0.20));
  assert.equal(bakeryPackageGeometry(0.28, 0.23, 0.17), bakeryPackageGeometry(0.28, 0.23, 0.17));
  const budget = bakeryProvisionGeometryBudget();
  assert.ok(budget.geometries <= 15 && budget.bytes < 110_000, JSON.stringify(budget));
});

test('retail bread retains the exact old ten-sided horizontal footprint with a flat supported base', () => {
  const retail = bread.filter(entry => entry.mesh.geometry.userData.bakeryProvision.retail);
  assert.equal(retail.length, 12);
  const counter = fixture.records.get('bakery-counter-top').bounds;
  for (const { mesh, bounds } of retail) {
    near(bounds.min.y, counter.max.y);
    assert.ok(bounds.max.y <= counter.max.y + 0.17 + 1e-6);
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i) / 0.24, z = position.getZ(i) / 0.13;
      for (let side = 0; side < 10; side++) {
        const angle = (side + 0.5) * Math.PI / 5;
        assert.ok(x * Math.cos(angle) + z * Math.sin(angle) <= Math.cos(Math.PI / 10) + 1e-6,
          'flattening never grows the old horizontal collision silhouette');
      }
    }
  }
});

test('six prep loaves rest on unchanged boards and clear the supported recipe vignette', () => {
  const prep = bread.filter(entry => !entry.mesh.geometry.userData.bakeryProvision.retail);
  assert.equal(prep.length, 6);
  const materials = new Proxy({}, { get: (_, key) => fixture.materials.get(key) });
  const vignette = buildBakeryStoryDetail(fixture.World, materials);
  const vignetteBounds = new THREE.Box3().setFromObject(vignette);
  for (const { mesh, bounds } of prep) {
    const board = fixture.entries.find(entry => entry.zone === 'bakery'
      && Math.abs(entry.mesh.position.y - 1.279) < 1e-6
      && bounds.min.x >= entry.bounds.min.x - 1e-6 && bounds.max.x <= entry.bounds.max.x + 1e-6);
    assert.ok(board, 'the full loaf footprint fits an authored board');
    near(bounds.min.y, board.bounds.max.y, 'bread bears on board');
    assert.ok(bounds.min.z >= board.bounds.min.z && bounds.max.z <= board.bounds.max.z);
    assert.ok(bounds.max.y < 1.39 + 1e-6 && bounds.min.y >= 1.2865 - 1e-6);
    assert.ok(!bounds.intersectsBox(vignetteBounds));
    assert.equal(mesh.material, getBakeryProvisionMaterials().bread);
  }
});

test('shelf sacks and cartons vary within the original slots and their labels stay inside atlas islands', () => {
  assert.equal(packages.length, 78);
  const kinds = new Set(packages.map(entry => entry.mesh.geometry.userData.bakeryProvision.kind));
  assert.deepEqual([...kinds].sort(), ['flour-sack', 'paper-box']);
  for (const { mesh, bounds } of packages) {
    const shelf = fixture.entries.find(entry => entry.zone === 'bakery'
      && entry.mesh.geometry.type === 'BoxGeometry' && Math.abs(entry.bounds.max.y - bounds.min.y) < 1e-6
      && Math.abs(entry.bounds.max.y - entry.bounds.min.y - 0.065) < 1e-6
      && bounds.min.z < entry.bounds.max.z && bounds.max.z > entry.bounds.min.z
      && bounds.min.x >= entry.bounds.min.x && bounds.max.x <= entry.bounds.max.x);
    assert.ok(shelf, 'paper provisions have a real shelf bearing surface');
    assert.ok(bounds.min.z < shelf.bounds.max.z && bounds.max.z > shelf.bounds.min.z);
    assert.ok(bounds.max.x - bounds.min.x <= 0.39 + 1e-6);
    assert.ok(bounds.max.z - bounds.min.z <= 0.18 + 1e-6);
    assert.ok(bounds.max.y - bounds.min.y <= 0.23 + 1e-6);
    const uv = mesh.geometry.attributes.uv;
    const position = mesh.geometry.attributes.position;
    const cells = Object.values(BAKERY_PROVISION_ATLAS.packages).filter(value => typeof value === 'object');
    for (let i = 0; i < uv.count; i += 3) assert.ok(cells.some(cell => [0, 1, 2].every(offset => inCell(uv.getX(i + offset), uv.getY(i + offset), cell))),
      'a triangle cannot interpolate between unrelated package atlas cells');
    const frontCell = BAKERY_PROVISION_ATLAS.packages[mesh.geometry.userData.bakeryProvision.variant % 2 ? 'kraft' : 'flour'];
    const frontVertices = Array.from({ length: uv.count }, (_, i) => i).filter(i => inCell(uv.getX(i), uv.getY(i), frontCell));
    assert.ok(frontVertices.length > 0);
    for (const i of frontVertices) {
      const expected = THREE.MathUtils.lerp(frontCell.uMin, frontCell.uMax,
        (mesh.geometry.boundingBox.max.x - position.getX(i)) / (mesh.geometry.boundingBox.max.x - mesh.geometry.boundingBox.min.x));
      near(uv.getX(i), expected, 'labels read left to right from the -Z shelf approach');
    }
  }
});

test('new surface ownership is limited to three shared opaque batches and the existing prep countertop', () => {
  const materials = getBakeryProvisionMaterials();
  const top = fixture.records.get('bakery-prep-island-top');
  assert.equal(top.mesh.material, materials.steel);
  assert.deepEqual(top.supports, ['bakery-prep-island-base']);
  assert.equal(top.collider, null);
  near(top.bounds.min.x, -30.04); near(top.bounds.max.x, -25.46);
  near(top.bounds.min.z, 38.15); near(top.bounds.max.z, 39.45);
  near(top.bounds.min.y, 1.20); near(top.bounds.max.y, 1.27);
  const batchMaterials = new Set(fixture.decorations.filter(entry => entry.mesh.material.userData.bakeryProvision).map(entry => entry.mesh.material));
  assert.equal(batchMaterials.size, 3);
  assert.ok([...batchMaterials].every(material => !material.transparent && material.depthWrite && !material.vertexColors));
  assert.ok(provisions.every(entry => entry.options.batched && !entry.options.collide && !entry.mesh.userData.collider));
});

test('replacements leave supply approaches and authored eye-height route segments unobstructed', () => {
  const root = new THREE.Group();
  for (const entry of provisions) root.add(entry.mesh.clone());
  const index = createBallisticWorld({ colliders: null }); index.rebuild(root);
  for (const pack of HEALTH_SUPPLIES.filter(item => item.zone === 'bakery')) {
    const target = new THREE.Vector3(pack.x, pack.y + 0.12, pack.z);
    for (const [dx, dz] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
      const origin = new THREE.Vector3(pack.x + dx, pack.y + 1.65, pack.z + dz);
      assert.equal(index.segmentOccluded(origin, target), false, pack.id);
    }
  }
  for (let i = 1; i < DISTRICT.bakery.accessRoute.length; i++) {
    const previous = DISTRICT.bakery.accessRoute[i - 1], next = DISTRICT.bakery.accessRoute[i];
    assert.equal(index.segmentOccluded(new THREE.Vector3(previous.x, previous.y + 1.5, previous.z),
      new THREE.Vector3(next.x, next.y + 1.5, next.z)), false);
  }
  index.clear();
});
