import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Box3, BoxGeometry, BufferGeometry, DirectionalLight, Float32BufferAttribute, Frustum, Group, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { fitWorldShadow } from '../../src/render/shadow-frustum.js';
import { createFocusedShadowBudget } from '../../src/render/shadow-budget.js';
import { CHECKPOINTS } from '../../src/game/mission-data.js';
import { DISTRICT } from '../../src/world/district-layout.js';

const WORLD = new Box3(new Vector3(-38, -0.2, -24), new Vector3(38, 19.2, 43));
const FLOOR = -2.2;

function viewAt(position, target = null, fov = 82, aspect = 16 / 9) {
  const camera = new PerspectiveCamera(fov, aspect, 0.05, 300);
  camera.position.copy(position);
  if (target) camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

function roofView(fov = 82) { return viewAt(new Vector3(15, 15.67, -7), new Vector3(20, 15.02, -12), fov); }
function balconyView() { return viewAt(new Vector3(7, 5.67, 0.95), new Vector3(5.3, 5.02, 0.95)); }

function smallSkinnedRig() {
  const rig = new Group(), bone = new Bone(), geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 1, 0, 0, 1, 1], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.castShadow = true;
  rig.userData.rig = {};
  rig.add(bone, mesh); rig.updateMatrixWorld(true);
  mesh.bind(new Skeleton([bone]), new Matrix4());
  return { rig, bone, mesh };
}

function fixture(options) {
  const light = new DirectionalLight(0xc3d5e0, 1.6); light.castShadow = true;
  fitWorldShadow(light, WORLD);
  const camera = light.shadow.camera;
  const original = { left: camera.left, right: camera.right, bottom: camera.bottom, top: camera.top,
    near: camera.near, far: camera.far, matrix: camera.projectionMatrix.toArray() };
  const budget = createFocusedShadowBudget(light, WORLD, options);
  return { light, camera, original, budget };
}

function frustum(camera) {
  camera.updateWorldMatrix(true, false);
  return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}

function assertReference(f) {
  for (const name of ['left', 'right', 'bottom', 'top', 'near', 'far']) assert.equal(f.camera[name], f.original[name], name);
  assert.deepEqual(f.camera.projectionMatrix.toArray(), f.original.matrix);
}

function assertInsideShadow(point, light, label) {
  const clip = point.clone().project(light.shadow.camera);
  assert.ok(Math.abs(clip.x) <= 1 + 1e-6 && Math.abs(clip.y) <= 1 + 1e-6 && Math.abs(clip.z) <= 1 + 1e-6,
    `${label}: ${clip.toArray()}`);
}

test('a focused roof view improves world texels while preserving the key light, shadow depth and dynamic updates', () => {
  const f = fixture(), position = f.light.position.clone(), target = f.light.target.position.clone();
  const originalMapSize = f.light.shadow.mapSize.clone();
  const bias = f.light.shadow.bias, normalBias = f.light.shadow.normalBias;
  assert.equal(f.budget.update(roofView()), true);
  const result = f.budget.snapshot();
  assert.equal(result.mode, 'focused');
  assert.equal(result.fraction, 0.5);
  assert.equal(result.areaFraction, 0.25);
  assert.equal(result.linearResolutionGain, 2);
  assert.equal(result.texelSize.x, result.referenceTexelSize.x / 2);
  assert.equal(result.texelSize.y, result.referenceTexelSize.y / 2);
  assert.equal(f.camera.near, f.original.near);
  assert.equal(f.camera.far, f.original.far);
  assert.ok(f.light.position.equals(position));
  assert.ok(f.light.target.position.equals(target));
  assert.ok(f.light.shadow.mapSize.equals(originalMapSize));
  assert.equal(f.light.shadow.bias, bias);
  assert.equal(f.light.shadow.normalBias, normalBias);
  assert.equal(f.light.shadow.autoUpdate, true, 'Moving NPCs still update the shadow every frame');
  assert.equal(f.light.castShadow, true);
  assert.equal(f.light.intensity, 1.6);
  assert.ok(result.clipEdges <= 140, 'Coverage work is bounded independently of scene size');
});

test('the intermediate tier can retain either original map edge on an integer texel lattice', () => {
  const f = fixture();
  f.budget.update(balconyView());
  const result = f.budget.snapshot();
  assert.equal(result.fraction, 0.75, 'A safe balcony crop must not fail because 2048/.75 is fractional');
  assert.ok(result.linearResolutionGain >= 4 / 3);
  assert.ok(result.areaFraction <= 0.5625);
  assert.ok(Math.abs(result.region.right - f.original.right) < 1e-10);
  assert.ok(Math.abs(result.region.bottom - f.original.bottom) < 1e-10);
  for (const [edge, origin, size] of [[result.region.left, f.original.left, result.texelSize.x],
    [result.region.bottom, f.original.bottom, result.texelSize.y]]) {
    const index = (edge - origin) / size;
    assert.ok(Math.abs(index - Math.round(index)) < 1e-8);
  }
  const receiver = result.receiverBounds;
  assert.ok(result.region.left <= Math.max(f.original.left, receiver.minX - result.coverageMargin) + 1e-8);
  assert.ok(result.region.right >= Math.min(f.original.right, receiver.maxX + result.coverageMargin) - 1e-8);
});

test('all sampled visible receivers and downstream outside-district ground shadows retain reference coverage', () => {
  const f = fixture(), originalFrustum = frustum(f.camera);
  const ray = f.light.target.position.clone().sub(f.light.position).normalize();
  const receivers = [];
  for (let x = 0; x <= 4; x++) for (let y = 0; y <= 2; y++) for (let z = 0; z <= 4; z++) {
    const caster = new Vector3(-38 + x * 19, -0.2 + y * 9.7, -24 + z * 16.75);
    const travel = (caster.y - FLOOR) / -ray.y;
    for (const part of [0, 0.25, 0.5, 0.75, 1]) receivers.push(caster.clone().addScaledVector(ray, travel * part));
  }
  const stations = [roofView(), balconyView()];
  for (const zone of ['apartment', 'street', 'roof', 'balcony']) {
    const point = CHECKPOINTS[zone];
    const camera = viewAt(new Vector3(point.x, point.y + 1.67, point.z));
    camera.rotation.set(0, point.yaw, 0, 'YXZ');
    stations.push(camera);
  }
  let checked = 0, checkedOutside = 0, focused = 0;
  for (const camera of stations) for (const fov of [62, 82, 100]) for (const aspect of [4 / 3, 16 / 9]) {
    camera.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix();
    const visible = frustum(camera);
    f.budget.update(camera);
    f.light.shadow.updateMatrices(f.light);
    if (f.budget.snapshot().mode === 'focused') focused++;
    for (const point of receivers) {
      if (!visible.containsPoint(point) || !originalFrustum.containsPoint(point)) continue;
      assertInsideShadow(point, f.light, 'Visible receiver lost when the crop changed');
      checked++;
      if (!WORLD.containsPoint(point)) checkedOutside++;
    }
  }
  assert.ok(checked > 1000, `Covered ${checked} visible receiver samples`);
  assert.ok(checkedOutside > 100, `Covered ${checkedOutside} downstream samples outside the district AABB`);
  assert.ok(focused > 5, 'The conservative receiver guarantee still permits useful focused views');
});

test('off-camera upstream casters remain in the full-depth shadow column of a visible receiver', () => {
  const f = fixture(), view = roofView(), visible = frustum(view), reference = frustum(f.camera);
  const receiver = new Vector3(20, 14, -12);
  const ray = f.light.target.position.clone().sub(f.light.position).normalize();
  let caster = null;
  for (let distance = 1; distance < 30; distance++) {
    const point = receiver.clone().addScaledVector(ray, -distance);
    if (reference.containsPoint(point) && !visible.containsPoint(point)) { caster = point; break; }
  }
  assert.ok(visible.containsPoint(receiver));
  assert.ok(caster, 'Fixture includes a caster outside the player view');
  f.budget.update(view); f.light.shadow.updateMatrices(f.light);
  assert.equal(f.budget.snapshot().fraction, 0.5);
  assertInsideShadow(receiver, f.light, 'Receiver');
  assertInsideShadow(caster, f.light, 'Off-camera caster');
  const a = receiver.clone().project(f.camera), b = caster.clone().project(f.camera);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, 'The caster and receiver share the same shadow ray');
});

test('a stationary view reuses coverage calculations and sub-texel motion does not slide the sampling grid', () => {
  const f = fixture(), view = roofView();
  f.budget.update(view);
  const before = f.budget.snapshot(), projection = f.camera.projectionMatrix.toArray();
  for (let frame = 0; frame < 120; frame++) assert.equal(f.budget.update(view), false);
  assert.equal(f.budget.snapshot().coverageEvaluations, before.coverageEvaluations);
  assert.deepEqual(f.camera.projectionMatrix.toArray(), projection);
  view.position.x += before.texelSize.x / 1000;
  f.budget.update(view);
  assert.deepEqual(f.camera.projectionMatrix.toArray(), projection, 'Tiny player movement cannot continuously rescale/recenter the shadow');
});

test('camera motion changes crop coordinates by whole texels while each tier keeps fixed extents', () => {
  const f = fixture(), view = roofView();
  f.budget.update(view);
  let previous = f.budget.snapshot(), movements = 0;
  for (let frame = 0; frame < 100; frame++) {
    view.position.y -= 0.1;
    f.budget.update(view);
    const next = f.budget.snapshot();
    assert.equal(next.fraction, 0.5);
    assert.ok(Math.abs(next.region.width - previous.region.width) < 1e-10);
    assert.ok(Math.abs(next.region.height - previous.region.height) < 1e-10);
    for (const [difference, size] of [[next.region.left - previous.region.left, next.texelSize.x],
      [next.region.bottom - previous.region.bottom, next.texelSize.y]]) {
      const steps = difference / size;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-7, `Fractional shadow movement: ${steps}`);
      if (Math.abs(steps) > 0.1) movements++;
    }
    previous = next;
  }
  assert.ok(movements > 0, 'The window follows a moving view when necessary');
});

test('small FOV reversals do not oscillate tiers after an immediate coverage expansion', () => {
  const f = fixture(), view = roofView();
  f.budget.update(view);
  let expandedAt = null;
  for (let fov = 83; fov <= 140; fov++) {
    view.fov = fov; view.updateProjectionMatrix(); f.budget.update(view);
    if (f.budget.snapshot().fraction > 0.5) { expandedAt = fov; break; }
  }
  assert.ok(expandedAt, 'A widening camera must eventually require expanded shadow coverage');
  const expanded = f.budget.snapshot().fraction;
  view.fov = expandedAt - 1; view.updateProjectionMatrix(); f.budget.update(view);
  assert.equal(f.budget.snapshot().fraction, expanded, 'The previously fitting FOV needs extra space before shrinking again');
  view.fov = 82; view.updateProjectionMatrix(); f.budget.update(view);
  assert.equal(f.budget.snapshot().fraction, 0.5);
});

test('a wide view expands immediately, and disabling or disposing restores the exact static fit', () => {
  const f = fixture();
  f.budget.update(roofView());
  assert.equal(f.budget.snapshot().fraction, 0.5);
  const point = CHECKPOINTS.street;
  const wide = viewAt(new Vector3(point.x, point.y + 1.67, point.z));
  wide.rotation.y = point.yaw;
  assert.equal(f.budget.update(wide), true);
  assertReference(f);
  assert.equal(f.budget.snapshot().reason, 'full-coverage-required');
  f.budget.update(roofView());
  assert.equal(f.budget.snapshot().fraction, 0.5);
  f.budget.setEnabled(false);
  assertReference(f);
  f.budget.update(roofView());
  assertReference(f);
  f.budget.setEnabled(true); f.budget.update(roofView());
  assert.equal(f.budget.snapshot().fraction, 0.5);
  f.budget.dispose(); f.budget.dispose();
  assertReference(f);
  assert.equal(f.budget.setEnabled(true), false);
  assert.equal(f.budget.update(roofView()), false);
  assert.equal(f.budget.snapshot().disposed, true);
});

test('Performance disables the optimization without enabling shadow rendering or altering the light', () => {
  const f = fixture();
  f.budget.update(roofView());
  f.budget.update(roofView(), false);
  assertReference(f);
  assert.equal(f.budget.snapshot().reason, 'shadows-disabled');
  assert.equal(f.budget.snapshot().shadowsEnabled, false);
  assert.equal(f.light.shadow.autoUpdate, true);
  f.budget.update(roofView(), true);
  assert.equal(f.budget.snapshot().fraction, 0.5);
});

test('the optional caster audit demonstrates shadow culling and retains moving NPC eligibility', () => {
  const scene = new Scene(), geometry = new BoxGeometry(0.8, 1.8, 0.8), material = new MeshStandardMaterial();
  for (let x = -32; x <= 32; x += 8) for (let y = 1; y <= 17; y += 8) for (let z = -20; z <= 36; z += 8) {
    const mesh = new Mesh(geometry, material); mesh.position.set(x, y, z); mesh.castShadow = true; scene.add(mesh);
  }
  const actor = new Mesh(geometry, material); actor.castShadow = true; actor.position.set(37, 1, 42); scene.add(actor);
  const f = fixture({ casterRoot: scene }), view = roofView();
  f.budget.update(view);
  const before = f.budget.auditCasters(scene, view);
  assert.ok(before.focusedDrawCandidates < before.referenceDrawCandidates / 2,
    `${before.focusedDrawCandidates} focused vs ${before.referenceDrawCandidates} reference caster draws`);
  const oldCount = before.focusedMeshes;
  actor.position.set(20, 14, -12);
  f.budget.update(view);
  const after = f.budget.auditCasters(scene, view);
  assert.equal(after.focusedMeshes, oldCount + 1, 'An NPC moving into view still casts its live shadow');
  assert.equal(actor.castShadow, true);
  assert.equal(actor.visible, true);
  assert.equal(f.light.shadow.autoUpdate, true);
  assert.equal(after.eligibleMeshes, before.eligibleMeshes);
  assert.equal(f.budget.snapshot().casterAudit.focusedMeshes, after.focusedMeshes);
});

test('static caster bounds are included once, caller bounds are unchanged, and updates do not traverse the scene', () => {
  const scene = new Group(), prop = new Mesh(new BoxGeometry(2, 4, 2), new MeshStandardMaterial());
  prop.position.set(43, 20, 0); prop.castShadow = true; scene.add(prop);
  const initialMin = WORLD.min.toArray(), initialMax = WORLD.max.toArray();
  const f = fixture({ casterRoot: scene });
  const result = f.budget.snapshot();
  assert.ok(result.casterBounds.max[0] >= 44 && result.casterBounds.max[1] >= 22);
  assert.deepEqual(WORLD.min.toArray(), initialMin);
  assert.deepEqual(WORLD.max.toArray(), initialMax);
  scene.traverse = () => { throw new Error('Per-frame scene traversal'); };
  scene.traverseVisible = scene.traverse;
  assert.doesNotThrow(() => f.budget.update(roofView()));
});

test('hidden parked rigs and their held weapons cannot expand the caster floor or scan skinned vertices', () => {
  const scene = new Group(), { rig, mesh } = smallSkinnedRig();
  rig.position.y = -200; rig.visible = false; scene.add(rig);
  const hand = new Group(), weapon = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  weapon.castShadow = true; weapon.position.y = -100;
  hand.add(weapon); rig.add(hand);
  mesh.computeBoundingBox = () => { throw new Error('A parked rig must not be scanned'); };
  weapon.geometry.computeBoundingBox = () => { throw new Error('A parked rig descendant must not be scanned'); };
  const before = rig.position.clone();
  const f = fixture({ casterRoot: scene, receiverFloor: FLOOR }), result = f.budget.snapshot();
  assert.equal(result.receiverFloor, FLOOR);
  assert.deepEqual(result.casterBounds.min, [-39.5, -1.7, -25.5]);
  assert.deepEqual(result.casterBounds.max, [39.5, 20.7, 44.5]);
  assert.equal(mesh.boundingBox, null, 'No false cached parked bounds are installed');
  assert.ok(rig.position.equals(before)); assert.equal(rig.visible, false);
  assert.equal(mesh.visible, true); assert.equal(mesh.castShadow, true); assert.equal(weapon.visible, true);
  f.budget.update(balconyView());
  assert.equal(f.budget.snapshot().fraction, 0.75, 'A nonexistent underground receiver volume must not erase the balcony crop');
});

test('hidden legacy bounds proxies under active rigs are excluded without hiding rendered parts', () => {
  const scene = new Group(), rig = new Group(); rig.userData.rig = {}; scene.add(rig);
  const proxy = new Mesh(new BoxGeometry(1000, 1000, 1000), new MeshStandardMaterial());
  proxy.userData.role = 'bounds-proxy'; proxy.visible = false; proxy.castShadow = true; rig.add(proxy);
  const visible = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  visible.position.set(43, 20, 0); visible.castShadow = true; rig.add(visible);
  proxy.geometry.computeBoundingBox = () => { throw new Error('A hidden proxy must not be scanned'); };
  const f = fixture({ casterRoot: scene, receiverFloor: FLOOR }), result = f.budget.snapshot();
  assert.equal(result.receiverFloor, FLOOR);
  assert.equal(result.casterBounds.max[0], 45.5, 'The actual visible caster still expands the envelope');
  assert.equal(result.casterBounds.max[1], 22.5);
  assert.equal(proxy.visible, false); assert.equal(visible.visible, true);
});

test('inactive static zones still contribute future caster coverage beyond the authored bounds', () => {
  const scene = new Group(), zone = new Group(); zone.visible = false; scene.add(zone);
  const prop = new Mesh(new BoxGeometry(2, 4, 2), new MeshStandardMaterial());
  prop.visible = false; prop.castShadow = true; prop.position.set(43, 20, 0); zone.add(prop);
  const f = fixture({ casterRoot: scene, receiverFloor: FLOOR }), result = f.budget.snapshot();
  assert.equal(result.receiverFloor, FLOOR);
  assert.deepEqual(result.casterBounds.min, [-39.5, -1.7, -25.5]);
  assert.deepEqual(result.casterBounds.max, [45.5, 23.5, 44.5]);
  assert.ok(new Box3(new Vector3(...result.casterBounds.min), new Vector3(...result.casterBounds.max)).containsBox(WORLD),
    'Original authored coverage for every future zone and NPC remains intact');
  zone.visible = true; prop.visible = true;
  scene.traverse = () => { throw new Error('Zone activation must not trigger a scan'); };
  for (const name of ['apartment', 'street', 'roof', 'balcony']) {
    const point = CHECKPOINTS[name], view = viewAt(new Vector3(point.x, point.y + 1.67, point.z));
    view.rotation.set(0, point.yaw, 0, 'YXZ');
    assert.doesNotThrow(() => f.budget.update(view));
    assert.deepEqual(f.budget.snapshot().casterBounds, result.casterBounds);
  }
});

test('visible skinned bounds refresh attached bind transforms and stale parked boxes exactly once', () => {
  const scene = new Group(), { rig, bone, mesh } = smallSkinnedRig(); scene.add(rig);
  rig.position.y = -200;
  scene.updateWorldMatrix(true, true); mesh.computeBoundingBox();
  assert.equal(mesh.boundingBox.min.y, -200, 'Reproduce the stale parked box caused by the old matrix-update path');
  rig.position.set(45, 25, 0); bone.position.y = 2;
  const before = rig.position.clone(), boneBefore = bone.position.clone();
  const f = fixture({ casterRoot: scene, receiverFloor: FLOOR }), result = f.budget.snapshot();
  assert.equal(result.receiverFloor, FLOOR, 'No old parked position survives in the receiver floor');
  assert.deepEqual(mesh.boundingBox.min.toArray(), [0, 2, 0]);
  assert.deepEqual(mesh.boundingBox.max.toArray(), [1, 3, 1]);
  assert.equal(result.casterBounds.max[0], 47.5, 'World translation is applied once');
  assert.equal(result.casterBounds.max[1], 29.5, 'Current bone pose is included before world translation');
  assert.ok(rig.position.equals(before)); assert.ok(bone.position.equals(boneBefore));
  assert.equal(rig.visible, true); assert.equal(mesh.castShadow, true);
  mesh.computeBoundingBox = () => { throw new Error('No per-frame skin scan'); };
  assert.doesNotThrow(() => f.budget.update(roofView()));
});

test('light transform changes use the reference fit without moving the light back', () => {
  const f = fixture();
  f.budget.update(roofView());
  f.light.position.x += 1;
  const changed = f.light.position.clone();
  f.budget.update(roofView());
  assertReference(f);
  assert.equal(f.budget.snapshot().reason, 'light-transform-changed');
  assert.ok(f.light.position.equals(changed));
});

test('invalid construction and unsupported non-downward light directions do not replace the static API', () => {
  assert.throws(() => createFocusedShadowBudget(null, WORLD), /directional light/);
  const f = fixture();
  assert.throws(() => createFocusedShadowBudget(f.light, new Box3()), /finite caster bounds/);
  const light = new DirectionalLight(); fitWorldShadow(light, WORLD);
  light.position.y = light.target.position.y - 20;
  const budget = createFocusedShadowBudget(light, WORLD);
  budget.update(roofView());
  assert.equal(budget.snapshot().mode, 'static');
  assert.equal(budget.snapshot().reason, 'unsupported-receiver-volume');
});

test('street and balcony workloads retain conservative useful crops with their actual aiming directions', () => {
  const f = fixture(), point = CHECKPOINTS.street, aim = DISTRICT.street.qa.benchmark[1];
  const view = viewAt(new Vector3(point.x, point.y + 1.67, point.z), new Vector3(aim.x, aim.y + 1.02, aim.z));
  for (const fov of [82, 62, 82]) {
    view.fov = fov; view.updateProjectionMatrix(); f.budget.update(view);
    assert.equal(f.budget.snapshot().fraction, 0.75);
  }
  f.budget.update(balconyView());
  assert.equal(f.budget.snapshot().fraction, 0.75);
});
