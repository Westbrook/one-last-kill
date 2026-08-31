import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig, resetHumanoidPose, updateHumanoidPose } from '../../src/render/humanoid-rig.js';
import { applyHeroSurfaceFinish } from '../../src/render/hero-surface-finish.js';

const BRAWLER = { role: 'brawler', kind: 'brawler', height: 1.78, build: 1, skin: '#c09072' };
const COMBAT_ROLES = [
  { ...BRAWLER, role: 'thug', kind: 'thug', height: 1.82, build: 1.05 }, BRAWLER,
  { ...BRAWLER, role: 'gunman', kind: 'gunman', height: 1.76, build: 0.98 },
  { ...BRAWLER, role: 'bruiser', kind: 'bruiser', height: 1.94, build: 1.32 },
  { ...BRAWLER, role: 'hitman', kind: 'hitman' },
  { ...BRAWLER, role: 'enforcer', kind: 'bruiser', height: 1.92, build: 1.28 },
];
const shaderFor = material => {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader);
  return shader;
};
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

function region(geometry, predicate, indices = null, channel = 0) {
  const { position, heroSurface } = geometry.attributes, result = [];
  for (const i of indices || Array.from({ length: position.count }, (_, at) => at)) {
    if (predicate(position.getX(i), position.getY(i), position.getZ(i))) result.push(heroSurface.getComponent(i, channel));
  }
  assert.ok(result.length > 3, 'The material check must sample an actual rendered region');
  return result;
}

function surfaceVertices(geometry, surface) {
  const vertices = new Set();
  for (let i = surface.triangleStart * 3; i < (surface.triangleStart + surface.triangleCount) * 3; i++) {
    vertices.add(geometry.index ? geometry.index.getX(i) : i);
  }
  return vertices;
}

test('all six combat roles carry compact authored finishes through four shared rendered surfaces', () => {
  for (const config of COMBAT_ROLES) {
    const rig = createHumanoidRig(config).userData.rig, copy = createHumanoidRig(config).userData.rig;
    assert.equal(rig.visualMeshes.length, 4, 'Material variation must retain the existing four body draws');
    for (const [i, mesh] of rig.visualMeshes.entries()) {
      const label = `${config.role}/${mesh.name}`;
      assert.ok(!Array.isArray(mesh.material), 'Finish regions must not create material groups');
      const attribute = mesh.geometry.attributes.heroSurface;
      assert.ok(attribute, `${label}: the actual rendered surface is missing its finish`);
      assert.equal(attribute.count, mesh.geometry.attributes.position.count);
      assert.equal(attribute.itemSize, 2); assert.equal(attribute.normalized, true);
      assert.ok(attribute.array instanceof Uint8Array);
      assert.equal(attribute.array.byteLength, attribute.count * 2);
      assert.equal(mesh.geometry, copy.visualMeshes[i].geometry, 'Pooled actors must share the authored bytes');
      assert.equal(mesh.material, copy.visualMeshes[i].material);
      const shader = shaderFor(mesh.material);
      assert.equal((shader.vertexShader.match(/attribute vec2 heroSurface;/g) || []).length, 1,
        `${label}: the material must consume its authored finish exactly once`);
      assert.ok(shader.uniforms.heroRoughnessReference, `${label}: missing roughness reference`);
      assert.ok(shader.fragmentShader.includes('#include <normal_fragment_maps>'));
      for (let vertex = 0; vertex < attribute.count; vertex++) {
        assert.ok(attribute.getX(vertex) >= 0.25 && attribute.getX(vertex) <= 1);
        assert.ok(attribute.getY(vertex) >= 0 && attribute.getY(vertex) <= 1);
      }
    }
  }
});

test('role-specific jackets, woven shirts and armor retain purposeful finish contrasts', () => {
  const shirts = {};
  for (const config of COMBAT_ROLES) {
    const rig = createHumanoidRig(config).userData.rig, h = rig.height;
    const garments = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments').geometry;
    const body = surfaceVertices(garments, { triangleStart: 0, triangleCount: rig.hero.continuousSurfaceTriangles });
    const torso = (x, y) => y / h > 0.65 && y / h < 0.77 && Math.abs(x) / h < 0.09;
    const shirt = mean(region(garments, torso, body)), detail = mean(region(garments, torso, body, 1));
    const trousers = mean(region(garments, (x, y) => y / h > 0.15 && y / h < 0.48, body));
    shirts[config.role] = shirt;
    if (config.role === 'thug') {
      assert.ok(shirt >= 0.62 && shirt <= 0.76 && detail < 0.20, 'The leather jacket must suppress cloth weave');
      assert.ok(trousers - shirt > 0.10, 'Denim must remain visibly more matte than the leather jacket');
    } else {
      assert.ok(shirt >= 0.80 && shirt <= 0.98 && detail >= 0.70,
        `${config.role}: the underlying shirt must retain its woven finish`);
    }
    if (['bruiser', 'enforcer'].includes(config.role)) {
      let triangleStart = rig.hero.continuousSurfaceTriangles, panels = 0, webbing = 0;
      for (const part of rig.hero.garmentDetails.parts) {
        const vertices = surfaceVertices(garments, { triangleStart, triangleCount: part.triangles });
        if (part.name.includes('webbing') || part.name.includes('strap') || part.name.includes('pouch')) {
          assert.ok(mean(region(garments, () => true, vertices)) >= 0.94, `${config.role}/${part.name}: straps must stay matte`);
          webbing++;
        } else if (part.name.startsWith('vest-')) {
          const armor = mean(region(garments, () => true, vertices));
          assert.ok(armor >= 0.90 && armor - shirt >= 0.035, `${config.role}/${part.name}: armor needs a distinct matte finish`);
          panels++;
        }
        triangleStart += part.triangles;
      }
      assert.ok(panels >= 2 && webbing >= 2, 'Armor checks must inspect actual panels and carrying straps');
    }
  }
  assert.ok(shirts.gunman - shirts.hitman > 0.035, 'The hitman shirt keeps a smoother woven finish');
  assert.ok(shirts.brawler - shirts.thug > 0.15, 'The short-sleeved brawler and leather-jacket thug must remain distinct');
});

test('civilian and player appearances retain their existing face treatment without combat finish attributes', () => {
  const combat = createHumanoidRig(BRAWLER).userData.rig;
  for (const kind of ['shopkeeper', 'woman', 'child', 'player', 'adult']) {
    // Matching palettes intentionally exercise material-cache separation;
    // civilians must not borrow a combat shader that requires absent data.
    const config = { ...BRAWLER, kind }; delete config.role;
    if (kind === 'child') { config.height = 1.28; config.build = 0.78; }
    const rig = createHumanoidRig(config).userData.rig;
    for (const [i, mesh] of rig.visualMeshes.entries()) {
      const label = `${kind}/${mesh.name}`, shader = shaderFor(mesh.material);
      assert.equal(mesh.geometry.attributes.heroSurface, undefined, `${label}: combat attribute leaked into a civilian`);
      assert.equal(mesh.material.userData.heroSurface, undefined, `${label}: combat metadata leaked through the cache`);
      assert.ok(!shader.vertexShader.includes('heroSurface') && !shader.fragmentShader.includes('vHeroSurface'),
        `${label}: shader must not request absent combat attributes`);
      assert.equal(shader.uniforms.heroRoughnessReference, undefined);
      assert.ok(!shader.fragmentShader.includes('faceLuminance'), `${label}: the new combat face correction must remain scoped`);
      assert.notEqual(mesh.material, combat.visualMeshes[i].material, `${label}: combat and civilian material caches must stay separate`);
    }
    const head = rig.visualMeshes.find(mesh => mesh.name === 'hero-head');
    assert.equal(head.material.name, ['woman', 'child'].includes(kind) ? 'hero-skin' : 'hero-projected-face',
      `${kind}: retain the established choice of facial projection`);
    const clothes = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments').material;
    assert.equal(clothes.map, combat.visualMeshes.find(mesh => mesh.name === 'hero-garments').material.map,
      'The globally revised cloth map remains shared without adding the combat shader');
  }
});

test('rendered cloth, denim, boot leather, rubber, skin and hair retain distinct absolute roughness', () => {
  const rig = createHumanoidRig(BRAWLER).userData.rig, h = rig.height;
  const garments = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments').geometry;
  const body = surfaceVertices(garments, { triangleStart: 0, triangleCount: rig.hero.continuousSurfaceTriangles });
  const shirt = region(garments, (x, y) => y / h > 0.65 && y / h < 0.77 && Math.abs(x) / h < 0.09, body);
  const denim = region(garments, (x, y) => y / h > 0.15 && y / h < 0.48, body);
  const leather = region(garments, (x, y, z) => y / h > 0.029 && y / h < 0.05 && z / h > 0.06);
  const rubber = region(garments, (x, y) => y / h < 0.021);
  assert.ok(mean(shirt) >= 0.90 && mean(shirt) <= 0.98, 'The shirt must read as matte woven cloth');
  assert.ok(mean(denim) >= 0.81 && mean(denim) <= 0.90);
  assert.ok(mean(leather) >= 0.55 && mean(leather) <= 0.75);
  assert.ok(mean(rubber) >= 0.90);
  assert.ok(mean(shirt) - mean(denim) > 0.04 && mean(denim) - mean(leather) > 0.10);
  assert.ok(mean(rubber) - mean(leather) > 0.15, 'The sole must not inherit polished boot leather');

  const head = rig.visualMeshes.find(mesh => mesh.name === 'hero-head').geometry;
  const nose = region(head, (x, y, z) => Math.abs(x) < 0.055 && y > 0.40 && y < 0.50 && z > 0.3);
  const cheeks = region(head, (x, y, z) => Math.abs(x) > 0.25 && Math.abs(x) < 0.35 && y > 0.40 && y < 0.50 && z > 0.2);
  assert.ok(mean(nose) >= 0.58 && mean(nose) < mean(cheeks) - 0.035, 'Nose/cheek variation must come from the skin finish');
  const details = rig.visualMeshes.find(mesh => mesh.name === 'hero-face-hair').geometry;
  const hair = region(details, () => true, surfaceVertices(details, details.userData.surfaces.hair));
  const eye = region(details, () => true, surfaceVertices(details, details.userData.surfaces.eyes[0].sclera));
  assert.ok(Math.min(...hair) >= 0.86 && Math.max(...hair) <= 0.98);
  assert.ok(mean(eye) < mean(cheeks) - 0.08 && mean(hair) > mean(cheeks) + 0.12,
    'The combined face detail draw must distinguish moist eyes, skin and matte hair');
});

test('the finish hook composes with existing PBR shaders without additional texture sampling', () => {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.72 });
  let calls = 0;
  material.onBeforeCompile = shader => { calls++; shader.uniforms.previousFinish = { value: 7 }; };
  material.customProgramCacheKey = () => 'existing-finish';
  const before = shaderFor(material);
  applyHeroSurfaceFinish(material, 0.72);
  const after = shaderFor(material);
  assert.equal(calls, 2); assert.equal(after.uniforms.previousFinish.value, 7);
  assert.equal(after.uniforms.heroRoughnessReference.value, 0.72);
  assert.ok(material.customProgramCacheKey().startsWith('existing-finish|'));
  assert.equal((after.vertexShader.match(/attribute vec2 heroSurface;/g) || []).length, 1);
  for (const chunk of ['map_fragment', 'roughnessmap_fragment', 'normal_fragment_maps', 'lights_physical_fragment']) {
    assert.equal((after.fragmentShader.match(new RegExp(`#include <${chunk}>`, 'g')) || []).length, 1,
      `The material must preserve Three.js ${chunk}`);
  }
  const samples = source => (source.match(/\btexture(?:2D|Cube|2DLod|Lod|Grad)?\s*\(/g) || []).length;
  assert.equal(samples(after.fragmentShader), samples(before.fragmentShader), 'Finish variation must reuse the existing PBR lookups');
  assert.match(after.fragmentShader, /roughnessFactor\s*=\s*clamp\(vHeroSurface\.x\s*\+/,
    'The region stores absolute roughness, not another multiplier on the texture');
  material.dispose();
});

test('projected face colour preserves the authored skin hook and the shared roughness reference', () => {
  for (const config of COMBAT_ROLES) {
    const rig = createHumanoidRig(config).userData.rig;
    const skin = rig.visualMeshes.find(mesh => mesh.name === 'hero-skin').material;
    const face = rig.visualMeshes.find(mesh => mesh.name === 'hero-head').material;
    const skinShader = shaderFor(skin), faceShader = shaderFor(face);
    near(faceShader.uniforms.heroRoughnessReference.value, skinShader.uniforms.heroRoughnessReference.value);
    assert.ok(faceShader.uniforms.heroFaceAlbedo, 'The facial projection must still share its decoded image');
    assert.equal((faceShader.vertexShader.match(/attribute vec2 heroSurface;/g) || []).length, 1,
      'The cloned face material must compose the skin hook exactly once');
    assert.ok(faceShader.vertexShader.includes('vHeroFaceProjection = heroFaceProjection;'));
    assert.ok(faceShader.fragmentShader.includes('#include <normal_fragment_maps>'));
    assert.ok(face.customProgramCacheKey().startsWith(skin.customProgramCacheKey()));
  }
});

function posedTriangles(mesh, wrist) {
  const inverse = wrist.matrixWorld.clone().invert(), geometry = mesh.geometry;
  const vertices = Array.from({ length: geometry.attributes.position.count }, (_, i) =>
    mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse));
  const result = [];
  for (let i = 0; i < geometry.index.count; i += 3) {
    const triangle = [0, 1, 2].map(k => vertices[geometry.index.getX(i + k)]);
    // Inspect the real wrist neighborhood, excluding the other hand/body in
    // close guard poses. This selection does not assume a vertex ordering.
    if (triangle.every(point => Math.abs(point.y) < 0.04 && Math.hypot(point.x, point.z) < 0.07)) result.push(triangle);
  }
  return result;
}

function radialSurface(triangles, angle, y) {
  const radial = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
  const ray = new THREE.Ray(radial.clone().multiplyScalar(0.08).setY(y), radial.clone().negate());
  const point = new THREE.Vector3(); let distance = Infinity;
  for (const [a, b, c] of triangles) {
    if (ray.intersectTriangle(a, b, c, true, point)) distance = Math.min(distance, point.distanceTo(ray.origin));
  }
  return Number.isFinite(distance) ? 0.08 - distance : null;
}

test('actual bare forearms meet the palm boundary through rest and both fist contacts', () => {
  const root = createHumanoidRig(BRAWLER), rig = root.userData.rig;
  const skin = rig.visualMeshes.find(mesh => mesh.name === 'hero-skin');
  const poses = [['rest', null], ['guard', { mode: 'fist', alert: 1 }],
    ['left contact', { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'L' }],
    ['right contact', { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'R' }]];
  let checked = 0;
  for (const [name, state] of poses) {
    resetHumanoidPose(root);
    if (state) for (let frame = 0; frame < 30; frame++) updateHumanoidPose(root, state, 1 / 60);
    root.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const triangles = posedTriangles(skin, rig.joints[`wrist${side}`]);
      for (let sample = 0; sample < 40; sample++) {
        const angle = (sample + 0.37) / 40 * Math.PI * 2;
        // Rays 20 micrometres to either side avoid exact shared-edge ties;
        // their returned radii measure the drawn transition, not its AABB.
        const forearm = radialSurface(triangles, angle, 0.00002);
        const palm = radialSurface(triangles, angle, -0.00002);
        assert.ok(forearm !== null && palm !== null && forearm > 0.009 && palm > 0.009,
          `${name}/${side}: the wrist has an open radial view at ${angle}`);
        assert.ok(Math.abs(forearm - palm) < 0.0005,
          `${name}/${side}: the drawn wrist has a ${(Math.abs(forearm - palm) * 1000).toFixed(3)} mm step at ${angle}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 300, 'Both wrist surfaces need a full circumferential review in every pose');
});
