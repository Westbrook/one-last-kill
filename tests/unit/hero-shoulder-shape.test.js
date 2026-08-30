import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHumanoidRig, resetHumanoidPose, updateHumanoidPose } from '../../src/render/humanoid-rig.js';

const BRAWLERS = [
  { height: 1.64, build: 0.85, before: { center: 0.004837, offset: 0.019731 }, accepted: { center: 0, offset: 0.0117 } },
  { height: 1.78, build: 1, before: { center: 0.013342, offset: 0.025545 }, accepted: { center: 0, offset: 0.0086 } },
  { height: 1.94, build: 1.30, before: { center: 0.020058, offset: 0.027367 }, accepted: { center: 0.001, offset: 0.0100 } },
];
// Measured rendered field heights before the brawler-only tailoring pass.
// These few silhouette landmarks guard its scope without freezing topology.
const UNCHANGED_ROLES = [
  { role: 'thug', height: 1.82, build: 1.05, heights: [1.51870235, 1.50827829, 1.51634244] },
  { role: 'gunman', height: 1.76, build: 0.98, heights: [1.47031945, 1.45873646, 1.46603719] },
  { role: 'bruiser', height: 1.94, build: 1.32, heights: [1.61900140, 1.60654937, 1.61734177] },
  { role: 'hitman', height: 1.78, build: 1, heights: [1.48641368, 1.47572069, 1.48279537] },
  { role: 'enforcer', height: 1.92, build: 1.28, heights: [1.60282416, 1.59045138, 1.60058912] },
];

function posedSurface(mesh, count = (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3) {
  const geometry = mesh.geometry, vertices = Array.from({ length: geometry.attributes.position.count }, (_, i) =>
    mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  const triangles = Array.from({ length: count }, (_, i) => [0, 1, 2].map(corner =>
    vertices[geometry.index ? geometry.index.getX(i * 3 + corner) : i * 3 + corner]));
  return { vertices, triangles };
}

function firstHit(triangles, ray) {
  const point = new THREE.Vector3(); let result = null;
  for (const [a, b, c] of triangles) {
    if (!ray.intersectTriangle(a, b, c, true, point)) continue;
    const distance = point.distanceTo(ray.origin);
    if (!result || distance < result.distance) result = { distance, point: point.clone() };
  }
  return result;
}

function fieldSurface(root) {
  root.updateMatrixWorld(true);
  const rig = root.userData.rig, garment = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments');
  return posedSurface(garment, rig.hero.continuousSurfaceTriangles).triangles;
}

function topAt(surface, x, z, height) {
  const hit = firstHit(surface, new THREE.Ray(new THREE.Vector3(x, height * 1.2, z), new THREE.Vector3(0, -1, 0)));
  assert.ok(hit && hit.point.y > height * 0.78, `Missing real upper-shirt surface at (${x}, ${z})`);
  return hit.point.y;
}

function proximalSkinTriangles(rig, skin, side) {
  const bone = rig.hero.skeleton.bones.indexOf(rig.joints[`shoulder${side}`]);
  const { position, skinIndex, skinWeight } = skin.geometry.attributes, point = new THREE.Vector3();
  const distances = new Map();
  for (let i = 0; i < position.count; i++) {
    let shoulderWeight = 0;
    for (let k = 0; k < 4; k++) if (skinIndex.getComponent(i, k) === bone) shoulderWeight += skinWeight.getComponent(i, k);
    if (shoulderWeight <= 1e-6) continue;
    point.fromBufferAttribute(position, i).applyMatrix4(skin.bindMatrix).applyMatrix4(rig.hero.skeleton.boneInverses[bone]);
    distances.set(i, -point.y);
  }
  assert.ok(distances.size > 0, `Missing actual bare-arm skin on ${side}`);
  const start = Math.min(...distances.values());
  const rim = new Set([...distances].filter(([, distance]) => Math.abs(distance - start) < 1e-5).map(([i]) => i));
  assert.ok(rim.size >= 12, 'The seam target must be the actual proximal skin ring');
  const index = skin.geometry.index, triangles = [];
  for (let i = 0; i < index.count; i += 3) {
    const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (vertices.some(vertex => rim.has(vertex))) triangles.push(vertices);
  }
  assert.ok(triangles.length >= 24, 'Coverage must include the first real skin band, not an arbitrary arm point');
  return triangles;
}

test('brawler shoulder silhouettes preserve the accepted neckline drop and improvement over the previous cap', t => {
  for (const config of BRAWLERS) {
    const root = createHumanoidRig({ height: config.height, build: config.build, role: 'brawler', kind: 'brawler' });
    const rig = root.userData.rig, h = config.height, width = rig.dimensions.width, surface = fieldSurface(root);
    const remaining = { center: 0, offset: 0 }; let minimumDrop = Infinity, maximumDrop = -Infinity;
    for (const side of [-1, 1]) for (const z of [-0.02 * h, 0, 0.02 * h]) {
      const samples = Array.from({ length: 21 }, (_, i) => {
        const fraction = 0.04 + i * 0.005;
        return { fraction, x: side * fraction * h * width, y: topAt(surface, side * fraction * h * width, z, h) };
      });
      const inner = Math.max(...samples.filter(point => point.fraction <= 0.061).map(point => point.y));
      const outer = Math.max(...samples.filter(point => point.fraction >= 0.1149).map(point => point.y));
      const middle = samples.filter(point => point.fraction >= 0.0649 && point.fraction <= 0.1101);
      const trough = middle.reduce((low, point) => point.y < low.y ? point : low);
      const drop = inner - outer, rebound = outer - trough.y;
      const band = z === 0 ? 'center' : 'offset';
      remaining[band] = Math.max(remaining[band], rebound);
      minimumDrop = Math.min(minimumDrop, drop); maximumDrop = Math.max(maximumDrop, drop);
      assert.ok(drop >= h * 0.0045 && drop <= h * 0.023,
        `h=${h}, build=${config.build}, side=${side}, z=${z}: collar-to-cap drop is ${drop} m`);
      // Preserve the reviewed improvement. The accepted surface retains a
      // measurable coarse trough; this is deliberately not a monotonicity test.
      assert.ok(rebound <= config.before[band] * 0.70 + 0.001,
        `h=${h}, build=${config.build}, side=${side}, z=${z}: rebound ${rebound} m loses the improvement over the previous ${config.before[band]} m cap`);
      assert.ok(rebound <= config.accepted[band] + 0.001,
        `h=${h}, build=${config.build}, side=${side}, z=${z}: rebound ${rebound} m exceeds the accepted residual at trough (${trough.x}, ${trough.y})`);
    }
    assert.ok(rig.hero.triangles <= 15000 && rig.visualMeshes.length === 4, 'Tailoring must retain the existing rendering budget');
    t.diagnostic(`Brawler ${h} m/build ${config.build}: remaining center/front-back rebound ${(remaining.center * 1000).toFixed(2)}/${(remaining.offset * 1000).toFixed(2)} mm; neckline drop ${(minimumDrop * 1000).toFixed(2)}–${(maximumDrop * 1000).toFixed(2)} mm.`);
  }
});

test('brawler tailoring leaves the other archetypes rendered shoulder profiles unchanged', () => {
  for (const config of UNCHANGED_ROLES) {
    const root = createHumanoidRig({ ...config, kind: config.role === 'enforcer' ? 'bruiser' : config.role });
    const surface = fieldSurface(root), width = root.userData.rig.dimensions.width;
    for (const side of [-1, 1]) for (const [i, fraction] of [0.06, 0.10, 0.12].entries()) {
      const y = topAt(surface, side * fraction * config.height * width, 0, config.height);
      assert.ok(Math.abs(y - config.heights[i]) <= 0.001,
        `${config.role}: the approved brawler pass changed another role's shoulder by ${y - config.heights[i]} m`);
    }
  }
});

test('the first bare-arm band stays covered in guard and both punching poses', () => {
  const root = createHumanoidRig({ role: 'brawler', kind: 'brawler', height: 1.78, build: 1 });
  const rig = root.userData.rig, h = rig.height;
  const garment = rig.visualMeshes.find(mesh => mesh.name === 'hero-garments');
  const skin = rig.visualMeshes.find(mesh => mesh.name === 'hero-skin');
  const targets = Object.fromEntries(['L', 'R'].map(side => [side, proximalSkinTriangles(rig, skin, side)]));
  const states = [
    ['guard', { mode: 'fist', alert: 1 }],
    ['left contact', { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'L' }],
    ['right contact', { mode: 'fist', alert: 1, swingProgress: 0.5, swingSide: 'R' }],
  ];
  let checked = 0;
  const target = new THREE.Vector3(), normal = new THREE.Vector3(), edge = new THREE.Vector3(), axis = new THREE.Vector3();
  const outward = new THREE.Vector3(), origin = new THREE.Vector3(), direction = new THREE.Vector3(), ray = new THREE.Ray();
  for (const [name, state] of states) {
    resetHumanoidPose(root);
    for (let i = 0; i < 30; i++) updateHumanoidPose(root, state, 1 / 60);
    root.updateMatrixWorld(true);
    const cloth = posedSurface(garment), flesh = posedSurface(skin);
    for (const side of ['L', 'R']) {
      const shoulder = rig.joints[`shoulder${side}`].getWorldPosition(new THREE.Vector3());
      axis.copy(rig.joints[`elbow${side}`].getWorldPosition(new THREE.Vector3())).sub(shoulder).normalize();
      let checkedSide = 0;
      for (const indices of targets[side]) {
        const [a, b, c] = indices.map(i => flesh.vertices[i]);
        target.copy(a).add(b).add(c).divideScalar(3);
        normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
        for (const angle of [0, Math.PI / 6, Math.PI / 4]) {
          outward.copy(normal).multiplyScalar(Math.cos(angle)).addScaledVector(axis, -Math.sin(angle)).normalize();
          origin.copy(target).addScaledVector(outward, h * 0.4); direction.copy(outward).negate(); ray.set(origin, direction);
          const visibleSkin = firstHit(flesh.triangles, ray);
          if (!visibleSkin || visibleSkin.point.distanceTo(target) > h * 0.006) continue;
          const visibleCloth = firstHit(cloth.triangles, ray);
          assert.ok(visibleCloth && visibleCloth.distance <= visibleSkin.distance + 1e-5,
            `${name}/${side}: proximal skin is exposed at (${target.x}, ${target.y}, ${target.z}), view elevation ${angle}`);
          checked++; checkedSide++;
        }
      }
      assert.ok(checkedSide >= 30, `${name}/${side}: coverage must test actual visible points around the upper arm`);
    }
  }
  assert.ok(checked >= 250, 'The check must inspect the actual first skin band across both arms and all poses');
});
