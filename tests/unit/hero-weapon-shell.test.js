import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { reshapeWeaponShell } from '../../src/render/hero-weapon-shell.js';
import { applyHeroWeaponUV } from '../../src/render/hero-weapon-uv.js';

const WIDTH = 0.047, TOP = 0.061, BASE = 0.041;
const OPTIONS = { width: WIDTH, top: TOP, crownBase: BASE, crownDrop: 0.55,
  rearStart: -0.110, rearEnd: -0.085, rearScale: 0.76 };
const near = (a, b, message, tolerance = 2e-7) => assert.ok(Math.abs(a - b) < tolerance, `${message}: ${a} versus ${b}`);

function receiver() {
  const outline = [[-0.130, -0.024], [0.179, -0.024], [0.200, -0.003], [0.198, 0.045],
    [0.167, TOP], [-0.104, TOP], [-0.130, 0.041]];
  const opening = [[0.012, 0.002], [0.096, 0.002], [0.102, 0.039], [0.012, 0.039]];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  shape.holes.push(new THREE.Path(opening.map(([x, y]) => new THREE.Vector2(x, y))));
  const edge = 0.0018, depth = WIDTH - edge * 2;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, curveSegments: 1,
    bevelEnabled: true, bevelSegments: 1, bevelSize: edge, bevelThickness: edge });
  geometry.translate(0, 0, -depth / 2);
  geometry.setAttribute('sourceX', new THREE.Float32BufferAttribute(Array.from(geometry.attributes.position.array)
    .filter((_, component) => component % 3 === 0), 1));
  geometry.userData.source = 'test-profile';
  return geometry;
}

function triangles(geometry, visit) {
  const { position } = geometry.attributes, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, i + 1); c.fromBufferAttribute(position, i + 2);
    visit(a, b, c, i);
  }
}

test('crown and heel construction keeps closed shell topology, winding, and a bounded triangle budget', () => {
  const source = receiver(), shell = reshapeWeaponShell(source, OPTIONS), edges = new Map();
  const key = point => point.toArray().map(value => Math.round(value * 1e7)).join(',');
  let volume = 0;
  triangles(shell, (a, b, c) => {
    assert.ok(new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() > 1e-14, 'no degenerate emitted triangles');
    volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const ka = key(start), kb = key(end);
      assert.notEqual(ka, kb, 'no collapsed topology edges');
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const records = edges.get(id) ?? []; records.push(ka < kb ? 1 : -1); edges.set(id, records);
    }
  });
  for (const [edge, directions] of edges) assert.deepEqual(directions.sort(), [-1, 1], `closed edge with opposite winding: ${edge}`);
  assert.ok(volume > 0, 'the outward winding encloses a positive volume');
  const added = shell.attributes.position.count / 3 - source.attributes.position.count / 3;
  assert.ok(added > 0 && added < 500, `${added} added triangles stays inside the per-receiver allowance`);
  assert.equal(shell.userData.weaponShell.triangles, shell.attributes.position.count / 3);
});

test('the lower ejection opening and walls remain unchanged while the upper crown and rear heel gain real shape', () => {
  const shell = reshapeWeaponShell(receiver(), OPTIONS), { position } = shell.attributes;
  let crownCenter = 0, loweredShoulder = 0, rearHeel = 0, planarLowerWall = 0;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    assert.ok(y <= TOP + 0.001801 && Math.abs(z) <= WIDTH / 2 + 1e-7, 'reshaping stays inside the original framing envelope');
    if (x > -0.080 && x < 0.160 && Math.abs(z) < 1e-7 && y >= TOP - 1e-7) crownCenter++;
    if (x > -0.080 && x < 0.160 && Math.abs(Math.abs(z) - WIDTH * 0.4) < 1e-7 && y > BASE && y < TOP - 0.003) loweredShoulder++;
    if (x < OPTIONS.rearStart && Math.abs(Math.abs(z) - WIDTH / 2 * OPTIONS.rearScale) < 1e-7) rearHeel++;
  }
  assert.ok(crownCenter && loweredShoulder && rearHeel, 'explicit center, crown bands, and narrow rear heel are present');
  triangles(shell, (a, b, c) => {
    if (![a, b, c].every(point => point.x > OPTIONS.rearEnd && point.y < BASE + 1e-7 && Math.abs(point.z + WIDTH / 2) < 1e-7)) return;
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    near(normal.x, 0, 'lower wall has no diagonal X facet'); near(normal.y, 0, 'lower wall has no diagonal Y facet');
    near(normal.z, -1, 'lower wall retains its hard flat normal'); planarLowerWall++;
  });
  assert.ok(planarLowerWall > 5);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const original = new THREE.Mesh(receiver(), material), shaped = new THREE.Mesh(shell, material);
  original.updateMatrixWorld(true); shaped.updateMatrixWorld(true);
  for (const [x, y, open] of [[0.050, 0.020, true], [-0.030, 0.020, false], [0.050, -0.010, false]]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, y, -0.100), new THREE.Vector3(0, 0, 1));
    const before = ray.intersectObject(original), after = ray.intersectObject(shaped);
    assert.equal(before.length === 0, open); assert.equal(after.length === 0, open, 'the mechanical opening is preserved');
    if (!open) near(after[0].distance, before[0].distance, 'unchanged lower wall depth');
  }
});

test('only the curved crown receives shared smooth normals; planar sides and rear caps retain sharp boundaries', () => {
  const shell = reshapeWeaponShell(receiver(), OPTIONS), { position, normal } = shell.attributes;
  let curvedNormals = 0, crispEndNormals = 0, crispWallNormals = 0;
  for (let i = 0; i < position.count; i++) {
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    near(Math.hypot(nx, ny, nz), 1, 'finite unit lighting normal', 2e-6);
    if (position.getX(i) > -0.080 && position.getX(i) < 0.150 && ny > 0.6 && Math.abs(nz) > 0.10 && Math.abs(nz) < 0.9) curvedNormals++;
    if (Math.abs(position.getX(i) + 0.1318) < 1e-7 && Math.abs(nx + 1) < 1e-7) crispEndNormals++;
    if (position.getX(i) > OPTIONS.rearEnd && position.getY(i) < BASE && Math.abs(nz + 1) < 1e-7) crispWallNormals++;
  }
  assert.ok(curvedNormals > 20 && crispEndNormals > 0 && crispWallNormals > 20, 'the crown is smooth without smoothing whole-shell silhouette edges');
});

test('reshaping owns its buffers, interpolates source attributes, and supports finite physical UV remapping', () => {
  const source = receiver(), original = source.attributes.position.array.slice();
  const first = reshapeWeaponShell(source, OPTIONS), second = reshapeWeaponShell(source, OPTIONS);
  assert.notEqual(first, source); assert.notEqual(first.attributes.position.array, source.attributes.position.array);
  assert.deepEqual(source.attributes.position.array, original, 'source asset is not mutated');
  assert.deepEqual(first.attributes.position.array, second.attributes.position.array, 'identical source produces deterministic topology');
  assert.equal(first.userData.source, 'test-profile');
  const { position, sourceX } = first.attributes;
  for (let i = 0; i < position.count; i++) near(sourceX.getX(i), position.getX(i), 'interpolated custom attribute follows the original coordinate');
  assert.equal(first.groups.reduce((sum, group) => sum + group.count, 0), position.count, 'all generated triangles retain a material group');
  const mapped = applyHeroWeaponUV(first, { userData: { weaponFinish: { surfaceMeters: 0.18 } } });
  const uv = mapped.attributes.uv;
  triangles(mapped, (a, b, c, i) => {
    const physical = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length();
    const areaUV = Math.abs((uv.getX(i + 1) - uv.getX(i)) * (uv.getY(i + 2) - uv.getY(i))
      - (uv.getX(i + 2) - uv.getX(i)) * (uv.getY(i + 1) - uv.getY(i)));
    near(areaUV * 0.18 ** 2 / physical, 1, 'mapped area follows physical surface area', 2e-3);
  });
  for (const attribute of Object.values(mapped.attributes)) assert.ok(Array.from(attribute.array).every(Number.isFinite));
});

test('indexed geometry is accepted and invalid dimensional deformations fail before source mutation', () => {
  const box = new THREE.BoxGeometry(0.20, 0.06, 0.04);
  const shell = reshapeWeaponShell(box, { width: 0.04, top: 0.03, crownBase: 0.01, crownDrop: 0.4 });
  assert.equal(shell.index, null); assert.ok(box.index);
  assert.throws(() => reshapeWeaponShell(box, { ...OPTIONS, width: 0 }), RangeError);
  assert.throws(() => reshapeWeaponShell(box, { ...OPTIONS, rearEnd: -0.120 }), RangeError);
  assert.throws(() => reshapeWeaponShell(box, { ...OPTIONS, crownDrop: 1.1 }), RangeError);
});
