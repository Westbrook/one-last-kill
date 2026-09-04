import assert from 'node:assert/strict';
import { FrontSide, Raycaster, Vector3 } from 'three';
import { createAuthoredWeapon } from '../../../src/render/authored-weapons.js';
import { addHeroWeaponHands } from '../../../src/render/hero-weapon-grips.js';
import { VIEW_MODEL_LAYER } from '../../../src/render/viewmodel.js';
import { WEAPON_DEFS } from '../../../src/game/weapon-data.js';
import { weaponHarness } from './weapon-harness.js';

const STEP = 1 / 120;
const CAMERA_SHAPES = [45, 62, 90].flatMap(fov => [4 / 3, 16 / 9, 21 / 9].map(aspect => ({ fov, aspect })));

function importedModel(Weapons, type) {
  const raw = createAuthoredWeapon(type), model = Weapons._vm(type);
  assert.ok(raw, `${type}: the actual catalog must be preloaded before motion validation`);
  assert.equal(model.userData.heroWeapon.source, 'original-blender-authored', `${type}: the production factory uses the imported model`);
  const materials = new Set(model.children.map(mesh => mesh.material));
  for (const mesh of raw.children) assert.ok(materials.has(mesh.material), `${type}: the live batches retain the imported finishes`);
  return { raw, model };
}

// Clip projected triangles to the viewport before counting front-facing area.
// This avoids counting a mostly off-screen blade as a readable held silhouette.
function visibleTriangleArea(vertices) {
  let polygon = vertices;
  for (const [axis, sign] of [['x', 1], ['x', -1], ['y', 1], ['y', -1]]) {
    const clipped = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index], b = polygon[(index + 1) % polygon.length];
      const insideA = a[axis] * sign <= 1, insideB = b[axis] * sign <= 1;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) clipped.push(a.clone().lerp(b, (sign - a[axis]) / (b[axis] - a[axis])));
    }
    polygon = clipped;
  }
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    twiceArea += a.x * b.y - a.y * b.x;
  }
  return Math.max(0, twiceArea / 2);
}

function bladeInLiveBatch(raw, model) {
  // Use the same ready-pose assembly as the production factory, without
  // identifying a whole shared steel draw as though it were only the blade.
  addHeroWeaponHands(raw, 'knife');
  const blade = raw.getObjectByName('knife-ground-blade');
  assert.ok(blade?.isMesh, 'The catalog contains the named authored ground blade');
  assert.equal(blade.material.side, FrontSide, 'Blade visibility is tested with production backface culling');
  blade.updateMatrix();
  const geometry = blade.geometry.index ? blade.geometry.toNonIndexed() : blade.geometry.clone();
  geometry.applyMatrix4(blade.matrix);
  const batch = model.children.find(mesh => mesh.material === blade.material);
  assert.ok(batch, 'The actual model contains the imported blade finish');
  const source = geometry.attributes.position.array, target = batch.geometry.attributes.position.array;
  let offset = -1;
  for (let start = 0; start <= target.length - source.length; start += 3) {
    let index = 0;
    while (index < source.length && Math.abs(target[start + index] - source[index]) < 1e-7) index++;
    if (index === source.length) { offset = start / 3; break; }
  }
  assert.ok(offset >= 0, 'Every posed imported blade vertex survives into the actual production batch');
  for (const name of ['normal', 'uv', 'color']) {
    const expected = geometry.attributes[name], actual = batch.geometry.attributes[name];
    assert.ok(expected && actual, `The imported blade retains ${name}`);
    for (let index = 0; index < expected.array.length; index++) {
      assert.ok(Math.abs(actual.array[offset * expected.itemSize + index] - expected.array[index]) < 1e-6,
        `The actual blade batch preserves authored ${name}`);
    }
  }
  assert.equal(offset % 3, 0, 'The imported blade begins on a real triangle boundary');
  return { batch, geometry, firstVertex: offset, vertexCount: geometry.attributes.position.count };
}

/** Call only after the actual shipped catalog has passed its preload checks. */
export function verifyAuthoredKnifeMotion() {
  const { Weapons, camera, settings, calls, GameTime } = weaponHarness();
  Weapons.init(); Weapons._equip('knife', 0);
  const { raw, model } = importedModel(Weapons, 'knife');
  const { batch, geometry, firstVertex, vertexCount } = bladeInLiveBatch(raw, model);
  const positions = batch.geometry.attributes.position, ray = new Raycaster();
  ray.layers.set(VIEW_MODEL_LAYER);
  const framesPerAttack = Math.ceil((Math.max(Weapons.def().attackDuration, Weapons.def().rate) + 0.12) / STEP);
  let minimumBladeArea = Infinity, minimumUnoccludedBladeArea = Infinity, minimumNearClearance = Infinity, frames = 0;
  try {
    for (const { fov, aspect } of CAMERA_SHAPES) {
      settings.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix();
      Weapons.cooldown = 0; Weapons.cancelAttack();
      assert.equal(Weapons._swingMelee(), true, 'The real knife controller starts each attack');
      const damageBefore = calls.damage.length;
      for (let frame = 0; frame < framesPerAttack; frame++) {
        GameTime.elapsed += STEP; Weapons.tick(STEP); Weapons.update(STEP); camera.updateMatrixWorld(true); frames++;
        ray.setFromCamera({ x: 0, y: 0 }, camera); ray.near = camera.near; ray.far = 2;
        assert.equal(ray.intersectObject(model, true).length, 0, `${fov}°/${aspect}: the reticle stays clear through the actual knife attack`);
        const inverseCamera = camera.matrixWorld.clone().invert(), point = new Vector3();
        for (const mesh of model.children) {
          const vertices = mesh.geometry.attributes.position;
          for (let index = 0; index < vertices.count; index++) {
            point.fromBufferAttribute(vertices, index).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverseCamera);
            const clearance = -point.z - camera.near;
            minimumNearClearance = Math.min(minimumNearClearance, clearance);
            assert.ok(clearance > 0.015, 'The complete imported knife and hand stay clear of the near plane');
          }
        }
        let bladeArea = 0, unoccludedArea = 0;
        for (let index = firstVertex; index < firstVertex + vertexCount; index += 3) {
          const worldVertices = [0, 1, 2].map(corner => new Vector3().fromBufferAttribute(positions, index + corner)
            .applyMatrix4(batch.matrixWorld));
          const area = visibleTriangleArea(worldVertices.map(vertex => vertex.clone().project(camera)));
          bladeArea += area;
          if (!area) continue;
          const center = worldVertices[0].clone().add(worldVertices[1]).add(worldVertices[2]).multiplyScalar(1 / 3).project(camera);
          if (Math.abs(center.x) > 1 || Math.abs(center.y) > 1) continue;
          ray.setFromCamera(center, camera);
          const hit = ray.intersectObject(model, true)[0];
          // Steel is shared with the guard and fittings. The nearest hit must
          // belong to the matched blade triangles, not merely its material.
          if (hit?.object === batch && hit.faceIndex >= firstVertex / 3 && hit.faceIndex < (firstVertex + vertexCount) / 3) {
            unoccludedArea += area;
          }
        }
        minimumBladeArea = Math.min(minimumBladeArea, bladeArea);
        minimumUnoccludedBladeArea = Math.min(minimumUnoccludedBladeArea, unoccludedArea);
        assert.ok(bladeArea > 0.008, `${fov}°/${aspect}: the actual ground blade has visible front-facing screen area`);
        assert.ok(unoccludedArea > 0.008, `${fov}°/${aspect}: actual blade surface remains visible in front of hands and fittings`);
      }
      assert.equal(Weapons.melee.active, false, 'The actual knife attack finishes');
      assert.equal(calls.damage.length - damageBefore, 1, 'Each completed attack applies exactly one contact');
    }
    assert.equal(calls.damage.length, CAMERA_SHAPES.length);
    return { cameraShapes: CAMERA_SHAPES.length, frames, contacts: calls.damage.length,
      minimumBladeArea, minimumUnoccludedBladeArea, minimumNearClearance };
  } finally {
    geometry.dispose();
    for (const mesh of raw.children) mesh.geometry.dispose();
  }
}

function watchResources(model, type) {
  const attributes = attribute => attribute && ({ attribute, array: attribute.array ?? attribute.data.array,
    version: attribute.version, data: attribute.data, dataVersion: attribute.data?.version,
    values: (attribute.array ?? attribute.data.array).slice() });
  const meshes = model.children.map(mesh => ({ mesh, geometry: mesh.geometry, material: mesh.material,
    materialVersion: mesh.material.version, index: attributes(mesh.geometry.index),
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) => [name, attributes(attribute)])),
    textures: Object.fromEntries(Object.entries(mesh.material).filter(([, value]) => value?.isTexture)
      .map(([name, texture]) => [name, { texture, version: texture.version, source: texture.source, sourceVersion: texture.source.version }])) }));
  const checkAttribute = (attribute, expected, final) => {
    assert.equal(attribute, expected?.attribute ?? null, `${type}: combat retains the attribute object`);
    if (!expected) return;
    const array = attribute.array ?? attribute.data.array;
    assert.equal(array, expected.array, `${type}: combat retains uploaded buffer storage`);
    assert.equal(attribute.version, expected.version, `${type}: rigid animation does not upload vertex buffers`);
    assert.equal(attribute.data, expected.data);
    assert.equal(attribute.data?.version, expected.dataVersion);
    if (final) assert.deepEqual(array, expected.values, `${type}: combat does not rewrite static geometry`);
  };
  return (final = false) => {
    assert.equal(model.children.length, meshes.length, `${type}: the live draw list is stable`);
    for (const [index, expected] of meshes.entries()) {
      const mesh = model.children[index];
      assert.equal(mesh, expected.mesh); assert.equal(mesh.geometry, expected.geometry, `${type}: no combat geometry rebuild`);
      assert.equal(mesh.material, expected.material); assert.equal(mesh.material.version, expected.materialVersion, `${type}: no combat material recompile`);
      assert.deepEqual(Object.keys(mesh.geometry.attributes), Object.keys(expected.attributes));
      checkAttribute(mesh.geometry.index, expected.index, final);
      for (const [name, attribute] of Object.entries(expected.attributes)) checkAttribute(mesh.geometry.attributes[name], attribute, final);
      const textureSlots = Object.entries(mesh.material).filter(([, value]) => value?.isTexture).map(([name]) => name);
      assert.deepEqual(textureSlots, Object.keys(expected.textures), `${type}: finish map bindings are stable`);
      for (const [name, texture] of Object.entries(expected.textures)) {
        assert.equal(mesh.material[name], texture.texture); assert.equal(texture.texture.version, texture.version, `${type}: no repeated finish texture upload`);
        assert.equal(texture.texture.source, texture.source); assert.equal(texture.source.version, texture.sourceVersion);
      }
    }
  };
}

/** Exercise real input, recoil, aim and complete timed reloads on imported guns. */
export function verifyAuthoredWeaponCombatReuse() {
  const metrics = {};
  for (const type of ['smg', 'shotgun', 'machinegun']) {
    const { Weapons, Player, calls, camera, settings, GameTime } = weaponHarness();
    const definition = WEAPON_DEFS[type], totalAmmo = definition.mag * 3;
    Weapons.init(); Weapons._equip(type, totalAmmo);
    const { raw, model } = importedModel(Weapons, type), checkResources = watchResources(model, type);
    for (const mesh of raw.children) mesh.geometry.dispose();
    let frames = 0;
    const step = (input = {}) => {
      GameTime.elapsed += STEP; Weapons.tick(STEP); Weapons.handleInput(input, STEP); Weapons.update(STEP);
      camera.updateMatrixWorld(true); frames++;
      assert.equal(Weapons._vm(type), model, `${type}: the controller retains its imported viewmodel cache`);
      checkResources();
    };
    const advance = seconds => { for (let frame = 0; frame < Math.ceil(seconds / STEP); frame++) step(); };
    advance(Weapons.cooldown + STEP);
    step({ leftPressed: true });
    assert.equal(calls.shots.length, 1, `${type}: a real trigger press records a shot`);
    assert.equal(Weapons.loaded, definition.mag - 1, `${type}: firing consumes a round`);
    assert.ok(Weapons.swingT > 0, `${type}: the real recoil clock runs`);
    Player.aiming = true; advance(Math.max(0.4, definition.rate + STEP));
    assert.ok(Weapons.aimBlend > 0.99 && camera.fov < settings.fov - 19, `${type}: the actual camera reaches the aimed view`);
    step({ leftPressed: true });
    assert.equal(calls.shots.length, 2, `${type}: the aimed trigger press fires`);
    step({ rPressed: true });
    assert.ok(Weapons.reloading > 0, `${type}: real reload input starts the timer`);
    advance(0.2);
    assert.ok(Weapons.aimBlend < 0.1, `${type}: the reload animation suppresses the aimed pose`);
    advance(definition.reloadTime);
    assert.equal(Weapons.reloading, 0, `${type}: the timed reload completes`);
    assert.equal(Weapons.loaded, definition.mag, `${type}: reload restores the magazine`);
    assert.equal(Weapons.totalAmmo(), totalAmmo - 2, `${type}: reload conserves remaining ammunition`);
    for (const action of ['reload-start', 'reload-insert', 'reload-end']) {
      assert.equal(calls.audioEvents.filter(event => event.name === 'weaponMechanical' && event.options.action === action).length, 1,
        `${type}: the real ${action} milestone occurs exactly once`);
    }
    advance(0.4);
    assert.ok(Weapons.aimBlend > 0.99, `${type}: aiming resumes after the completed reload`);
    step({ leftPressed: true });
    assert.equal(calls.shots.length, 3, `${type}: the reloaded gun fires again`);
    assert.equal(Weapons.totalAmmo(), totalAmmo - 3);
    Player.aiming = false; advance(0.4);
    assert.ok(Weapons.aimBlend < 0.01, `${type}: releasing aim restores the hip view`);
    checkResources(true);
    metrics[type] = { shots: calls.shots.length, reloads: 1, frames };
  }
  return metrics;
}
