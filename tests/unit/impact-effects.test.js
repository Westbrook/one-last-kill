import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { IMPACT_PROFILES, resolveImpactProfile, impactParticleStyle } from '../../src/render/impact-profile.js';

function harness() {
  const allocations = {}, countedThree = { ...THREE }, canvases = [];
  for (const name of ['BufferGeometry', 'PlaneGeometry', 'CylinderGeometry', 'MeshBasicMaterial', 'PointsMaterial',
    'Mesh', 'Points', 'PointLight', 'CanvasTexture', 'Vector3', 'Quaternion']) {
    countedThree[name] = class extends THREE[name] {
      constructor(...args) { super(...args); allocations[name] = (allocations[name] || 0) + 1; }
    };
  }
  const makeCanvas = size => {
    const canvas = { width: size, height: size, gradients: [] };
    const noOp = () => {};
    const context = {
      clearRect: noOp, fillRect: noOp, beginPath: noOp, moveTo: noOp, lineTo: noOp, stroke: noOp,
      createRadialGradient() {
        const stops = []; canvas.gradients.push(stops);
        return { addColorStop(offset, color) { stops.push({ offset, color }); } };
      },
    };
    canvas.getContext = () => context; canvases.push(canvas); return canvas;
  };
  let seed = 1234567;
  const randomMath = Object.create(Math);
  randomMath.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const source = readFileSync(new URL('../../src/render/effects.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '');
  assert.doesNotMatch(source, /^import\s/m);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100);
  camera.position.set(0, 2, 5);
  // Canvas records drawing commands only. No DOM, renderer, audio or browser exists.
  const { FX } = runInNewContext(`${source}\n;({ FX });`, {
    THREE: countedThree, scene, camera, makeCanvas, Math: randomMath, resolveImpactProfile, impactParticleStyle,
  }, { filename: 'effects.js' });
  const impacts = scene.children.filter(object => object.name === 'impact-particle');
  return { FX, scene, camera, impacts, allocations, canvases };
}

const active = h => h.impacts.filter(mesh => mesh.visible);
const hit = (surfaceKind, point = new THREE.Vector3(0, 0, 0), normal = new THREE.Vector3(0, 0, 1)) => ({ surfaceKind, point, normal });
const state = mesh => ({ position: mesh.position.toArray(), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(),
  opacity: mesh.material.opacity, visible: mesh.visible, kind: mesh.userData.impactKind });

test('material-aware impacts use muted masonry/wood, warm tiny metal sparks and cool glass flecks', () => {
  const h = harness();
  for (const surfaceKind of ['plaster', 'brick', 'wood', 'roofMetal', 'glass', 'solid']) {
    h.FX.impact(0, 0, 0, 4, hit(surfaceKind));
    const meshes = active(h), profile = resolveImpactProfile({ surfaceKind });
    assert.equal(meshes.length, 4);
    for (const [ordinal, mesh] of meshes.entries()) {
      const style = impactParticleStyle(profile, ordinal);
      assert.equal(mesh.userData.impactKind, profile.id);
      assert.equal(mesh.material.color.getHex(), style.color);
      assert.equal(mesh.material.blending, style.additive ? THREE.AdditiveBlending : THREE.NormalBlending);
      assert.ok(mesh.scale.x * 0.18 <= style.width * 1.2 + 1e-8);
      assert.ok(mesh.scale.y * 0.18 <= style.height * 1.2 + 1e-8);
      if (style.texture === 'fleck') {
        for (const stop of mesh.material.map.image.gradients[0]) {
          const channels = stop.color.match(/[\d.]+/g).map(Number);
          assert.equal(channels[0], channels[1]); assert.equal(channels[1], channels[2], 'no baked orange halo');
        }
      }
    }
    h.FX.update(1); assert.equal(active(h).length, 0);
  }
});

test('the same 64 slots, shared geometry, materials and lights survive heavy bursts without hot-path construction', () => {
  const h = harness(), objects = [...h.scene.children], counts = { ...h.allocations }, canvasCount = h.canvases.length;
  const resources = h.impacts.map(mesh => [mesh.geometry, mesh.material]);
  const metadata = hit('metal');
  assert.equal(h.impacts.length, 64); assert.equal(new Set(h.impacts.map(mesh => mesh.geometry)).size, 1);
  for (let burst = 0; burst < 200; burst++) {
    metadata.surfaceKind = burst % 2 ? 'wood' : 'metal';
    h.FX.impact(0, 0, 0, 10000, metadata); h.FX.update(1 / 120);
  }
  assert.equal(active(h).length, 64);
  assert.deepEqual(h.allocations, counts, 'no new geometry, material, node, light, texture or vector during hits');
  assert.equal(h.canvases.length, canvasCount); assert.deepEqual(h.scene.children, objects);
  h.impacts.forEach((mesh, i) => { assert.equal(mesh.geometry, resources[i][0]); assert.equal(mesh.material, resources[i][1]); });
  const lights = h.scene.children.filter(object => object.isLight);
  assert.equal(lights.length, 24, 'only the existing muzzle-light slots exist');
  assert.ok(lights.every(light => !light.visible && light.intensity === 0), 'impacts never activate a light');
  h.FX.update(1); assert.equal(active(h).length, 0);
});

test('floor, ceiling, wall and sloped impacts keep every billboard vertex outside the contacted plane', () => {
  const h = harness(), point = new THREE.Vector3(1, 2, -3), corner = new THREE.Vector3();
  const normals = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 2, 3]];
  for (const values of normals) {
    const normal = new THREE.Vector3(...values).normalize();
    const tangent = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    h.camera.position.copy(point).addScaledVector(normal, 4).addScaledVector(tangent, 2);
    for (const surfaceKind of ['metal', 'plaster', 'brick', 'wood', 'glass']) {
      h.FX.impact(99, 99, 99, 8, hit(surfaceKind, point, normal));
      for (let frame = 0; frame < 44; frame++) {
        h.scene.updateMatrixWorld(true);
        for (const mesh of active(h)) {
          assert.equal(mesh.material.depthTest, true); assert.equal(mesh.material.depthWrite, false);
          assert.equal(mesh.material.polygonOffset, false); assert.equal(mesh.renderOrder, 0);
          const positions = mesh.geometry.attributes.position;
          for (let i = 0; i < positions.count; i++) {
            corner.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).sub(point);
            assert.ok(corner.dot(normal) >= 0.0039, `${surfaceKind} normal ${values}: particle penetrates its hit plane`);
          }
          assert.ok(mesh.material.opacity >= 0 && mesh.material.opacity <= 0.85);
        }
        h.FX.update(1 / 120);
      }
      assert.equal(active(h).length, 0, 'all material lifetimes are bounded below 0.37 s');
    }
  }
});

test('reused hit metadata is copied and cannot move or recolor already spawned particles', () => {
  const h = harness(), point = new THREE.Vector3(1, 3, -2), normal = new THREE.Vector3(0, 1, 0);
  const metadata = hit('brick', point, normal);
  h.FX.impact(0, 0, 0, 4, metadata);
  const meshes = active(h), colors = meshes.map(mesh => mesh.material.color.getHex());
  point.set(100, 200, 300); normal.set(0, -1, 0); metadata.surfaceKind = 'metal';
  h.FX.update(0.03);
  for (const [index, mesh] of meshes.entries()) {
    assert.ok(mesh.position.distanceTo(new THREE.Vector3(1, 3, -2)) < 0.2);
    assert.ok(mesh.position.y > 3); assert.equal(mesh.material.color.getHex(), colors[index]);
    assert.equal(mesh.userData.impactKind, 'brick');
  }
});

test('zero dt pauses impacts exactly and equal elapsed time produces the same motion at 30/60/120 Hz', () => {
  const paused = harness(); paused.FX.impact(0, 0, 0, 4, hit('plaster'));
  const before = paused.impacts.map(state);
  for (const dt of [0, 0, NaN, -1, Infinity]) paused.FX.update(dt);
  assert.deepEqual(paused.impacts.map(state), before);
  let reference = null;
  for (const fps of [30, 60, 120]) {
    const h = harness(); h.FX.impact(0, 0, 0, 4, hit('plaster'));
    for (let frame = 0; frame < fps / 10; frame++) h.FX.update(1 / fps);
    const poses = active(h).map(state);
    if (!reference) reference = poses;
    else for (let i = 0; i < poses.length; i++) {
      for (const key of ['position', 'rotation', 'scale']) for (let axis = 0; axis < poses[i][key].length; axis++) {
        assert.ok(Math.abs(poses[i][key][axis] - reference[i][key][axis]) < 1e-10, `${key} at ${fps} Hz`);
      }
      assert.ok(Math.abs(poses[i].opacity - reference[i].opacity) < 1e-10);
    }
  }
});

test('legacy calls are neutral, counts are bounded, and invalid points or normals cannot poison pooled transforms', () => {
  const h = harness();
  for (const count of [0, -1, NaN, Infinity]) h.FX.impact(0, 0, 0, count);
  h.FX.impact(NaN, 0, 0); assert.equal(active(h).length, 0);
  h.FX.impact(0, 0, 0);
  assert.equal(active(h).length, 4);
  for (const mesh of active(h)) { assert.equal(mesh.userData.impactKind, 'neutral'); assert.equal(mesh.material.blending, THREE.NormalBlending); }
  h.FX.update(1);
  h.FX.impact(0, 0, 0, 4, hit('glass', new THREE.Vector3(), new THREE.Vector3(NaN, 0, 0)));
  h.FX.update(0.01);
  for (const mesh of active(h)) assert.ok([...mesh.position.toArray(), ...mesh.quaternion.toArray(), ...mesh.scale.toArray()].every(Number.isFinite));
});
