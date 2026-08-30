import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Group, Mesh, PlaneGeometry, Raycaster, Vector3, SRGBColorSpace, NoColorSpace } from 'three';
import { weaponHarness } from './helpers/weapon-harness.js';
import { getViewModelMuzzle, VIEW_MODEL_LAYER } from '../../src/render/viewmodel.js';
import { createHeroWeapon } from '../../src/render/hero-weapons.js';
import { batchStaticWeaponParts, getWeaponFinishes } from '../../src/render/weapon-finishes.js';
import { getHandMaterials } from '../../src/render/hand-materials.js';
import { inspectHeroGripFit } from '../../scripts/inspect-hero-grip-fit.mjs';

// Keep the previous firearm framing and exact bore anchors. The knife gets a
// deliberate diagonal ready pose; all budgets include grip hands and sleeves.
const BASELINE = {
  knife: { maxDraws: 6, maxTriangles: 5000, min: [-0.16, -0.2953522435, -0.3126784609], max: [0.0827459271, 0.08, 0.515485926] },
  pistol: { maxDraws: 6, maxTriangles: 6500, min: [-0.0481, -0.2953522435, -0.2613], max: [0.0827459271, 0.1131, 0.515485926], muzzle: [0.201, 0.04, 0] },
  shotgun: { maxDraws: 6, maxTriangles: 13200, min: [-0.1568459271, -0.2953522435, -0.65], max: [0.13, 0.0845, 0.515485926], muzzle: [0.5, 0.03, 0] },
  smg: { maxDraws: 6, maxTriangles: 12500, min: [-0.1568459271, -0.2953522435, -0.364], max: [0.0827459271, 0.10075, 0.515485926], muzzle: [0.28, 0.02, 0] },
  machinegun: { maxDraws: 6, maxTriangles: 13200, min: [-0.1568459271, -0.2953522435, -0.767], max: [0.0827459271, 0.1235, 0.515485926], muzzle: [0.59, 0.03, 0] },
};

test('hero guns and knife fit their framing envelope and active geometry/draw budgets', () => {
  const { makeWeaponViewModel } = weaponHarness();
  for (const [type, baseline] of Object.entries(BASELINE)) {
    const model = makeWeaponViewModel(type), presentation = model.userData.presentation;
    assert.equal(model.userData.heroWeapon.source, 'original-profile-procedural', 'provenance does not imply downloaded/scanned art');
    assert.ok(presentation.sourceMeshes > presentation.drawCalls, `${type}: mechanical parts remain batched`);
    assert.ok(presentation.drawCalls <= baseline.maxDraws, `${type}: bounded material draws including hands`);
    assert.equal(model.children.length, presentation.drawCalls);
    assert.equal(presentation.sourceTriangles, presentation.triangles, 'batching preserves actual geometry');
    assert.ok(presentation.triangles <= baseline.maxTriangles, `${type}: active triangle budget including hands`);
    assert.equal(new Set(model.children.map(mesh => mesh.material)).size, presentation.drawCalls);
    let triangles = 0;
    for (const mesh of model.children) {
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      assert.equal(mesh.layers.mask, 1 << VIEW_MODEL_LAYER);
      assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
      assert.equal(mesh.material.depthWrite, true); assert.equal(mesh.material.depthTest, true);
      for (const attribute of ['position', 'normal', 'uv']) {
        assert.ok(mesh.geometry.attributes[attribute].array.every(Number.isFinite), `${type}: valid ${attribute}`);
      }
    }
    assert.equal(triangles, presentation.triangles);
    const bounds = new Box3().setFromObject(model, true);
    for (const [index, axis] of ['x', 'y', 'z'].entries()) {
      assert.ok(bounds.min[axis] >= baseline.min[index] - 1e-6, `${type}: bounded lower ${axis} extent`);
      assert.ok(bounds.max[axis] <= baseline.max[index] + 1e-6, `${type}: bounded upper ${axis} extent`);
    }
    assert.equal(model.userData.heroWeapon.grips.length, ['shotgun', 'smg', 'machinegun'].includes(type) ? 2 : 1);
  }
});

test('the angled knife shows its blade and keeps the reticle and near plane clear through the real attack clock', () => {
  const { Weapons, camera, settings, calls } = weaponHarness();
  Weapons.init(); Weapons._equip('knife', 0);
  const model = Weapons._vm('knife'), ray = new Raycaster(); ray.layers.set(VIEW_MODEL_LAYER);
  assert.deepEqual(model.userData.heroWeapon.readyAngle, { side: 25, up: 10 });
  for (const fov of [45, 62, 90]) {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      settings.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix();
      Weapons.cooldown = 0; Weapons.cancelAttack(); Weapons._swingMelee();
      for (let frame = 0; frame < 50; frame++) {
        Weapons.tick(1 / 120); Weapons.update(1 / 120); camera.updateMatrixWorld(true);
        ray.setFromCamera({ x: 0, y: 0 }, camera); ray.near = camera.near; ray.far = 2;
        assert.equal(ray.intersectObject(model, true).length, 0, 'the center stays clear throughout the actual knife attack');
        const inverseCamera = camera.matrixWorld.clone().invert();
        const point = new Vector3();
        for (const mesh of model.children) {
          const positions = mesh.geometry.attributes.position;
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverseCamera);
            assert.ok(point.z < -camera.near - 0.015, 'the complete hand/knife stays behind the near plane');
          }
        }
        if (frame === 0) {
          const blade = model.children.find(mesh => mesh.material.userData.weaponFinish?.profile === 'blade');
          const positions = blade.geometry.attributes.position;
          let visibleArea = 0;
          for (let i = 0; i < positions.count; i += 3) {
            const [a, b, c] = [0, 1, 2].map(corner => new Vector3().fromBufferAttribute(positions, i + corner)
              .applyMatrix4(blade.matrixWorld).project(camera));
            const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
            if (Math.abs(centroid.x) > 1 || Math.abs(centroid.y) > 1) continue;
            visibleArea += Math.max(0, ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2);
          }
          assert.ok(visibleArea > 0.008, 'the actual front-facing blade has visible screen area instead of appearing edge-on');
        }
      }
    }
  }
  assert.equal(calls.damage.length, 9, 'each real attack still lands only once');
});

test('actual grip surfaces meet the held shapes without burying the palm or wrist', () => {
  for (const type of Object.keys(BASELINE)) {
    for (const fit of inspectHeroGripFit(type)) {
      assert.equal(fit.rearPalmOrWristInside, 0, `${type}: wrist trails outside the gun`);
      assert.ok(fit.maximumDepthMm < 5, `${type}: only shallow finger-pad contact is allowed (${fit.maximumDepthMm}mm)`);
      assert.ok(fit.deeperThan3mm < fit.vertices * 0.025, `${type}: contact cannot hide large pieces of the hand`);
    }
  }
});

test('the angled shotgun stock grip remains visible in hip and aimed views without covering the reticle', () => {
  const { Weapons, Player, camera } = weaponHarness();
  Weapons.init(); Weapons._equip('shotgun', 0);
  const model = Weapons._vm('shotgun'), handMaterial = getHandMaterials().hand;
  const ray = new Raycaster(); ray.layers.set(VIEW_MODEL_LAYER);
  for (const aim of [false, true]) {
    Weapons.aimBlend = aim ? 1 : 0; Player.aiming = aim; Weapons.update(1 / 120); camera.updateMatrixWorld(true);
    let primaryPixels = 0;
    for (let y = 485; y < 720; y += 10) for (let x = 405; x < 1200; x += 10) {
      ray.setFromCamera({ x: x / 1280 * 2 - 1, y: 1 - y / 720 * 2 }, camera); ray.far = 2;
      const hit = ray.intersectObject(model, true)[0];
      if (hit?.object.material !== handMaterial) continue;
      // Both hands share a production draw; the primary hand is on the stock
      // behind the receiver, rather than the positive-X forward pump grip.
      if (model.worldToLocal(hit.point.clone()).x < -0.025) primaryPixels += 100;
    }
    assert.ok(primaryPixels >= (aim ? 10000 : 1000), `${aim ? 'aim' : 'hip'}: the correction must not crop the primary hand away`);
    for (const x of [-0.02, 0, 0.02]) for (const y of [-0.02, 0, 0.02]) {
      ray.setFromCamera({ x, y }, camera);
      assert.equal(ray.intersectObject(model, true).length, 0, 'the reticle remains clear');
    }
  }
  const primary = inspectHeroGripFit('shotgun').find(fit => fit.hand.startsWith('primary-'));
  assert.ok(primary.parts['shotgun-sculpted-stock'] > 0, 'the fingers still contact the actual stock neck');
});

test('the rounded pistol backstrap and flush controls do not cut black islands through the aimed thumb', () => {
  const { camera, makeWeaponViewModel } = weaponHarness();
  camera.fov = 62; camera.aspect = 1280 / 720; camera.updateProjectionMatrix();
  const holder = new Group(); holder.position.set(0, -0.12, -0.36); camera.add(holder);
  const model = makeWeaponViewModel('pistol'); holder.add(model); camera.updateMatrixWorld(true);
  const ray = new Raycaster(); ray.layers.set(VIEW_MODEL_LAYER);
  // These interior thumb rays reproduced the actual captured crescent. Vertex
  // containment alone misses a gun corner crossing the middle of a skin face.
  for (const [x, y] of [[588, 674], [590, 680], [581, 670], [586, 687]]) {
    ray.setFromCamera({ x: x / 1280 * 2 - 1, y: 1 - y / 720 * 2 }, camera);
    const hit = ray.intersectObject(model, true)[0];
    assert.ok(hit, 'the thumb remains visible');
    assert.equal(hit.object.material, getHandMaterials().hand, `${x},${y}: continuous skin in front of the grip`);
  }
});

test('the current receiver crowns and recessed assembly panels have real depth in the built assets', () => {
  const fixtures = [
    { type: 'shotgun', shell: 'shotgun-action', x: -0.030, edge: 0.015 },
    { type: 'smg', shell: 'smg-stamped-upper', x: -0.035, edge: 0.0125 },
    { type: 'machinegun', shell: 'machinegun-receiver', x: -0.035, edge: 0.016 },
  ];
  const ray = new Raycaster();
  for (const { type, shell: name, x, edge } of fixtures) {
    const model = createHeroWeapon(type); model.updateMatrixWorld(true);
    const shell = model.getObjectByName(name);
    const roof = z => {
      ray.set(new Vector3(x, 0.15, z), new Vector3(0, -1, 0)); ray.near = 0; ray.far = 0.3;
      const hit = ray.intersectObject(shell)[0]; assert.ok(hit, `${type}: continuous crown`); return hit.point.y;
    };
    const middle = roof(0), left = roof(-edge), right = roof(edge);
    assert.ok(middle - left > 0.003 && middle - right > 0.003, `${type}: broad roof has an authored rounded cross-section`);
    assert.ok(Math.abs(left - right) < 1e-6, `${type}: symmetric crown without random triangulation facets`);
    for (const panel of model.userData.heroWeapon.panels) {
      ray.set(new Vector3(...panel.point).add(new Vector3(0, 0, -0.020)), new Vector3(0, 0, 1));
      ray.far = 0.060;
      const hit = ray.intersectObject(model, true)[0];
      assert.ok(hit.object.name.includes(`${panel.name}-floor`), `${type}: pocket has its own solid recessed floor`);
      assert.ok(Math.abs(hit.distance - 0.020 - panel.depth) < 1e-6, `${type}: panel depth survives all shell shaping`);
    }
  }
});

test('close-up crown fasteners have open sockets with recessed floors instead of painted circles', () => {
  for (const [type, name] of [['shotgun', 'shotgun-crown-plug'], ['machinegun', 'machinegun-cover-release']]) {
    const model = createHeroWeapon(type); model.updateMatrixWorld(true);
    const rim = model.getObjectByName(`${name}-rim`), socket = model.getObjectByName(`${name}-socket`);
    rim.geometry.computeBoundingBox();
    const center = rim.geometry.boundingBox.getCenter(new Vector3()), ray = new Raycaster();
    ray.set(center.clone().add(new Vector3(0, 0.02, 0)), new Vector3(0, -1, 0)); ray.far = 0.04;
    const hit = ray.intersectObject(model, true)[0];
    assert.equal(hit.object, socket, `${type}: the socket remains visible inside the metal rim`);
    assert.ok(hit.point.y < rim.geometry.boundingBox.max.y - 0.0003, 'the recess is physical');
  }
});

test('merged rear sights have real open notches bounded by solid ears and a base', () => {
  const { makeWeaponViewModel } = weaponHarness();
  for (const type of ['pistol', 'smg', 'machinegun']) {
    const model = makeWeaponViewModel(type), { rear, front } = model.userData.ironSights;
    const raycaster = new Raycaster(); raycaster.layers.set(VIEW_MODEL_LAYER);
    model.updateMatrixWorld(true);
    const direction = new Vector3(1, 0, 0).transformDirection(model.matrixWorld);
    const probe = (x, length, y, z) => {
      raycaster.set(model.localToWorld(new Vector3(x - length / 2 - 0.002, y, z)), direction);
      raycaster.near = 0; raycaster.far = (length + 0.004) * 1.3;
      return raycaster.intersectObject(model, true);
    };
    for (const heightFraction of [0.15, 0.5, 0.85]) {
      for (const widthFraction of [-0.35, 0, 0.35]) {
        const hits = probe(rear.x, rear.length, rear.floor + (rear.top - rear.floor) * heightFraction, rear.gap * widthFraction);
        assert.equal(hits.length, 0, `${type}: the opening continues through the entire sight depth`);
      }
    }
    const earCenter = (rear.width + rear.gap) / 4, middleY = (rear.floor + rear.top) / 2;
    for (const sign of [-1, 1]) {
      assert.ok(probe(rear.x, rear.length, middleY, sign * earCenter).length > 0, `${type}: solid protective ear`);
    }
    assert.ok(probe(rear.x, rear.length, (rear.bottom + rear.floor) / 2, 0).length > 0, `${type}: supported notch base`);
    assert.ok(probe(front.x, front.length, front.top - 0.001, 0).length > 0, `${type}: visible front post`);
  }
});

test('aimed front posts project inside the notches and are visible through the actual merged geometry', () => {
  const { camera, makeWeaponViewModel } = weaponHarness();
  const holder = new Group(); holder.position.set(0, -0.12, -0.36); camera.add(holder);
  const raycaster = new Raycaster(); raycaster.layers.set(VIEW_MODEL_LAYER);
  for (const type of ['pistol', 'smg', 'machinegun']) {
    const model = makeWeaponViewModel(type), { rear, front } = model.userData.ironSights;
    holder.add(model);
    for (const fov of [45, 62, 90]) {
      for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
        camera.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
        const project = (x, y, z = 0) => model.localToWorld(new Vector3(x, y, z)).project(camera);
        const rearX = rear.x - rear.length / 2;
        const floor = project(rearX, rear.floor), top = project(rearX, rear.top);
        const gapLeft = project(rearX, rear.floor, -rear.gap / 2), gapRight = project(rearX, rear.floor, rear.gap / 2);
        const tip = project(front.x - front.length / 2, front.top - 0.00075);
        const postLeft = project(front.x - front.length / 2, front.top, -front.width / 2);
        const postRight = project(front.x - front.length / 2, front.top, front.width / 2);
        assert.ok(tip.y > floor.y + 1e-5 && tip.y < top.y - 1e-5, `${type}: front tip lies inside the opening at ${fov}°`);
        assert.ok(postLeft.x > gapLeft.x && postRight.x < gapRight.x, `${type}: space remains on both sides of the post`);
        raycaster.setFromCamera(tip, camera);
        raycaster.near = camera.near; raycaster.far = 2;
        const hits = raycaster.intersectObject(model, true);
        assert.ok(hits.length > 0, `${type}: the front sight is rendered`);
        const nearest = model.worldToLocal(hits[0].point.clone());
        assert.ok(nearest.x >= front.x - front.length / 2 - 0.003,
          `${type}: the rear notch or receiver must not obscure the front sight`);
      }
    }
    holder.remove(model);
  }
});

test('batched real firearm muzzle effects remain attached through hip and aim transforms', () => {
  const { camera, makeWeaponViewModel } = weaponHarness();
  camera.position.set(10, 2, -3);
  const holder = new Group(); holder.position.set(0.22, -0.22, -0.36); camera.add(holder);
  for (const [type, { muzzle }] of Object.entries(BASELINE)) {
    if (!muzzle) continue;
    const model = makeWeaponViewModel(type), result = new Vector3();
    holder.add(model);
    assert.deepEqual(Array.from(model.userData.muzzle), muzzle);
    for (const handX of [0.22, 0]) {
      holder.position.x = handX;
      const expected = new Vector3(10 + handX, 1.78 + muzzle[1] * 1.3, -3.36 - muzzle[0] * 1.3);
      assert.ok(getViewModelMuzzle(model, result).distanceTo(expected) < 1e-8, `${type}: ${handX ? 'hip' : 'aim'}`);
    }
    holder.remove(model);
  }
});

test('firearm variants reuse a bounded set of coordinated static finish textures', () => {
  const { makeWeaponViewModel } = weaponHarness();
  const profiles = new Map(), textures = new Set();
  for (const type of Object.keys(BASELINE)) {
    for (const mesh of makeWeaponViewModel(type).children) {
      const material = mesh.material, profile = material.userData.weaponFinish?.profile;
      if (!profile) continue;
      if (profiles.has(profile)) assert.equal(material, profiles.get(profile), `${profile}: shared material`);
      profiles.set(profile, material);
      assert.equal(material.map.colorSpace, SRGBColorSpace);
      assert.equal(material.normalMap.colorSpace, NoColorSpace);
      assert.equal(material.roughnessMap.colorSpace, NoColorSpace);
      assert.equal(material.roughnessMap, material.metalnessMap);
      for (const map of [material.map, material.normalMap, material.roughnessMap]) {
        assert.equal(map.image.width, 128); assert.equal(map.image.height, 128);
        assert.equal(map.generateMipmaps, true); textures.add(map);
      }
    }
  }
  assert.equal(profiles.size, 5, 'weapon surfaces use five finishes; hands use their shared atlas');
  assert.equal(textures.size, 15);
  assert.ok([...textures].reduce((sum, texture) => sum + texture.image.data.byteLength, 0) < 1.5 * 1024 * 1024);
});

test('hero firearms have geometric ejection recesses, open trigger guards and hollow muzzle crowns', () => {
  const radii = { pistol: 0.013, shotgun: 0.021, smg: 0.013, machinegun: 0.023 };
  const ray = new Raycaster(); ray.near = 0; ray.far = 0.20;
  for (const type of Object.keys(radii)) {
    const model = createHeroWeapon(type); model.updateMatrixWorld(true);
    const asset = model.userData.heroWeapon;
    const opening = asset.triggerOpening;
    ray.set(new Vector3(opening[0], opening[1], -0.10), new Vector3(0, 0, 1));
    assert.equal(ray.intersectObject(model, true).length, 0, `${type}: trigger guard is a genuine opening`);
    const recess = asset.recess;
    ray.set(new Vector3(recess.point[0], recess.point[1], recess.point[2] - 0.02), new Vector3(0, 0, 1));
    const bolt = ray.intersectObject(model, true)[0];
    assert.ok(bolt && bolt.distance > 0.030 && bolt.distance < 0.036, `${type}: bolt is visibly recessed behind the side wall`);
    assert.match(bolt.object.name, /recessed-bolt/);
    const muzzle = model.userData.muzzle;
    ray.set(new Vector3(muzzle[0] + 0.02, muzzle[1], 0), new Vector3(-1, 0, 0));
    const bore = ray.intersectObject(model, true)[0];
    assert.ok(bore && bore.distance > 0.04, `${type}: bore opening continues into the barrel`);
    ray.set(new Vector3(muzzle[0] + 0.02, muzzle[1] + radii[type] * 0.9, 0), new Vector3(-1, 0, 0));
    const crown = ray.intersectObject(model, true)[0];
    assert.ok(crown && Math.abs(crown.point.x - muzzle[0]) < 1e-6, `${type}: solid crown meets the unchanged effect anchor`);
  }
});

test('the knife has a tapered clip-point and ground bevels rather than a constant-width blade', () => {
  const model = createHeroWeapon('knife'), blade = model.getObjectByName('knife-ground-blade');
  const { position, normal } = blade.geometry.attributes;
  const ring = x => {
    const points = [];
    for (let i = 0; i < position.count; i++) if (Math.abs(position.getX(i) - x) < 1e-6) points.push(new Vector3().fromBufferAttribute(position, i));
    return new Box3().setFromPoints(points).getSize(new Vector3());
  };
  const body = ring(0.048), tip = ring(0.239);
  assert.ok(tip.y < body.y * 0.1 && tip.z < body.z * 0.1, 'the point narrows in both height and thickness');
  let bevels = 0;
  for (let i = 0; i < normal.count; i++) if (Math.abs(normal.getY(i)) > 0.1 && Math.abs(normal.getZ(i)) > 0.1) bevels++;
  assert.ok(bevels > 12, 'angled ground faces can catch a different highlight from the blade flats');
});

test('explicit physical profile UVs survive material batching and keep adjacent texture phase', () => {
  const root = new Group(), material = getWeaponFinishes().metal, expectedUV = [];
  for (const center of [-0.09, 0.09]) {
    const geometry = new PlaneGeometry(0.18, 0.10); geometry.translate(center, 0, 0);
    const { position, uv } = geometry.attributes;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, position.getX(i) / 0.18, position.getY(i) / 0.18);
    geometry.userData.weaponSurfaceUV = true;
    for (let i = 0; i < geometry.index.count; i++) {
      const vertex = geometry.index.getX(i); expectedUV.push(uv.getX(vertex), uv.getY(vertex));
    }
    root.add(new Mesh(geometry, material));
  }
  batchStaticWeaponParts(root);
  assert.equal(root.children.length, 1);
  const { position, uv } = root.children[0].geometry.attributes;
  assert.deepEqual(Array.from(uv.array), expectedUV, 'custom profile coordinates are not rescaled as cylinders');
  for (let i = 0; i < uv.count; i++) if (Math.abs(position.getX(i)) < 1e-6) {
    assert.ok(Math.abs(uv.getX(i)) < 1e-6, 'both panels have the same phase at their shared edge');
  }
});

test('connected grip hands share their atlas and cached model buffers stay stable through aim, fire and reload', () => {
  const { Weapons, Player } = weaponHarness(); Weapons.init();
  const materials = getHandMaterials();
  for (const type of Object.keys(BASELINE)) {
    const model = Weapons._vm(type), geometry = model.children.map(mesh => mesh.geometry);
    const attributes = geometry.map(item => Object.fromEntries(Object.entries(item.attributes).map(([key, attribute]) => [key, attribute.array])));
    const textures = new Map();
    for (const mesh of model.children) for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
      if (mesh.material[key]) textures.set(mesh.material[key], mesh.material[key].version);
    }
    assert.equal(model.children.filter(mesh => mesh.material === materials.hand).length, 1, 'both hands share one atlas draw');
    assert.equal(model.children.filter(mesh => mesh.material === materials.sleeve).length, 1, 'sleeves share one draw');
    Weapons._equip(type, 120);
    if (type !== 'knife') { Weapons._fireRanged(); Weapons.startReload(); }
    for (let frame = 0; frame < 80; frame++) {
      Player.aiming = frame >= 40; Weapons.tick(1 / 120); Weapons.update(1 / 120);
    }
    assert.equal(Weapons._vm(type), model);
    for (let i = 0; i < model.children.length; i++) {
      assert.equal(model.children[i].geometry, geometry[i]);
      for (const [key, array] of Object.entries(attributes[i])) assert.equal(geometry[i].attributes[key].array, array);
      assert.deepEqual(geometry[i].morphAttributes, {}, 'static firearm grip geometry has no unused morph upload');
    }
    for (const [texture, version] of textures) assert.equal(texture.version, version, 'no repeated texture uploads during interaction');
  }
});
