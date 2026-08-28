import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BAT_DIMENSIONS, createBatAsset } from '../../src/render/bat-asset.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

function ringRadius(geometry, z) {
  const position = geometry.attributes.position;
  let radius = -Infinity;
  for (let i = 0; i < position.count; i++) {
    if (Math.abs(position.getZ(i) - z) < 1e-6) radius = Math.max(radius, Math.hypot(position.getX(i), position.getY(i)));
  }
  assert.ok(Number.isFinite(radius), `profile ring at ${z}`);
  return radius;
}

test('canonical bat is a full-size tapered wooden silhouette with a narrow handle and turned knob', () => {
  const bat = createBatAsset(), wood = bat.getObjectByName('bat-wood');
  const bounds = new THREE.Box3().setFromObject(bat), size = bounds.getSize(new THREE.Vector3());
  assert.equal(bat.isGroup, true); assert.equal(bat.userData.weaponType, 'bat');
  assert.deepEqual(bat.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(bat.rotation.toArray().slice(0, 3), [0, 0, 0]);
  close(bounds.min.z, BAT_DIMENSIONS.knobZ); close(bounds.max.z, BAT_DIMENSIONS.tipZ);
  close(size.z, BAT_DIMENSIONS.length); close(size.x, BAT_DIMENSIONS.barrelRadius * 2);
  close(ringRadius(wood.geometry, -0.130), BAT_DIMENSIONS.knobRadius);
  close(ringRadius(wood.geometry, 0), 0.0131);
  close(ringRadius(wood.geometry, 0.620), BAT_DIMENSIONS.barrelRadius);
  close(ringRadius(wood.geometry, 0.700), 0);
  const taper = [0.12, 0.20, 0.29, 0.38, 0.47, 0.55, 0.62].map(z => ringRadius(wood.geometry, z));
  assert.ok(taper.every((radius, i) => i === 0 || radius > taper[i - 1]), 'handle grows gradually into the barrel');
  assert.ok(BAT_DIMENSIONS.barrelRadius > BAT_DIMENSIONS.handleRadius * 2.3);
  assert.ok(BAT_DIMENSIONS.knobRadius > BAT_DIMENSIONS.gripRadius * 1.5);
});

test('world, NPC and first-person callers get independent anchors and shared bat resources', () => {
  const a = createBatAsset(), b = createBatAsset({ castShadow: false });
  for (const name of ['bat-wood', 'bat-grip']) {
    const first = a.getObjectByName(name), second = b.getObjectByName(name);
    assert.notEqual(first, second); assert.equal(first.geometry, second.geometry);
    assert.equal(first.material, second.material);
    assert.equal(first.material.map, second.material.map);
    assert.equal(first.castShadow, true); assert.equal(second.castShadow, false);
    assert.equal(first.receiveShadow, true); assert.equal(second.receiveShadow, false);
  }
  const anchors = a.userData.anchors;
  assert.deepEqual(anchors.grip.position.toArray(), [0, 0, 0]);
  close(anchors.lowerGrip.position.z, BAT_DIMENSIONS.lowerGripZ);
  close(anchors.upperGrip.position.z, BAT_DIMENSIONS.upperGripZ);
  close(anchors.supportHand.position.z, BAT_DIMENSIONS.supportGripZ);
  close(anchors.npcSupportHand.position.z, BAT_DIMENSIONS.npcSupportGripZ);
  close(anchors.strikeCenter.position.z, BAT_DIMENSIONS.strikeCenterZ);
  close(anchors.tip.position.z, BAT_DIMENSIONS.tipZ);
  for (const anchor of Object.values(anchors)) {
    assert.equal(anchor.parent, a);
    assert.ok(Math.abs(anchor.position.x) + Math.abs(anchor.position.y) === 0);
  }
  a.position.set(1, 2, 3); a.rotation.y = Math.PI / 2;
  assert.deepEqual(b.position.toArray(), [0, 0, 0]);
  assert.notEqual(anchors.grip, b.userData.anchors.grip);
});

test('bat materials have coordinated restrained wood grain, matte tape and valid texture channels', () => {
  const bat = createBatAsset();
  let byteCount = 0;
  for (const name of ['bat-wood', 'bat-grip']) {
    const material = bat.getObjectByName(name).material;
    assert.equal(material.isMeshStandardMaterial, true);
    assert.equal(material.metalness, 0); assert.equal(material.roughness, 1);
    assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
    assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
    assert.equal(material.roughnessMap.colorSpace, THREE.NoColorSpace);
    const color = material.map.image, normals = material.normalMap.image, rough = material.roughnessMap.image;
    assert.deepEqual([color.width, color.height], [normals.width, normals.height]);
    assert.deepEqual([color.width, color.height], [rough.width, rough.height]);
    let minR = 255, maxR = 0, minRough = 255, maxRough = 0;
    for (let i = 0; i < color.data.length; i += 4) {
      const [red, green, blue] = color.data.subarray(i, i + 3);
      minR = Math.min(minR, red); maxR = Math.max(maxR, red);
      minRough = Math.min(minRough, rough.data[i + 1]); maxRough = Math.max(maxRough, rough.data[i + 1]);
      assert.equal(color.data[i + 3], 255); assert.equal(rough.data[i + 2], 0);
      if (name === 'bat-wood') {
        assert.ok(red > green && green > blue, 'grain changes brightness without colored stripes');
        assert.equal(red - green, 22); assert.equal(green - blue, 30);
      } else assert.ok(Math.abs(red - green) <= 4 && Math.abs(green - blue) <= 4);
      const normalLength = Math.hypot(normals.data[i] / 127.5 - 1, normals.data[i + 1] / 127.5 - 1, normals.data[i + 2] / 127.5 - 1);
      assert.ok(Math.abs(normalLength - 1) < 0.008);
    }
    assert.ok(maxR - minR >= 5 && maxR - minR < 18, 'fine restrained wear');
    assert.ok(minRough >= 0.72 * 255 && maxRough <= 0.96 * 255);
    for (const texture of [material.map, material.normalMap, material.roughnessMap]) {
      assert.equal(texture.isDataTexture, true, 'DOM-free procedural surface');
      assert.equal(texture.flipY, true); assert.equal(texture.wrapS, THREE.RepeatWrapping);
      assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
      byteCount += texture.image.data.byteLength;
    }
  }
  assert.ok(byteCount < 1_200_000, `shared texture bytes ${byteCount}`);
});

test('bat geometry has finite normals, physical UVs and a bounded two-draw budget', () => {
  const bat = createBatAsset();
  let meshes = 0, triangles = 0;
  bat.traverse(object => {
    if (!object.isMesh) return;
    meshes++; triangles += object.geometry.index.count / 3;
    const { position, normal, uv } = object.geometry.attributes;
    assert.equal(position.count, normal.count); assert.equal(position.count, uv.count);
    for (const attribute of [position, normal, uv]) assert.ok(attribute.array.every(Number.isFinite));
    for (let i = 0; i < position.count; i++) {
      assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 1e-5);
      assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1);
      assert.ok(uv.getY(i) >= -1e-6 && uv.getY(i) <= 1 + 1e-6);
      if (object.name === 'bat-wood') close(uv.getY(i), (position.getZ(i) - BAT_DIMENSIONS.knobZ) / BAT_DIMENSIONS.length);
    }
  });
  assert.equal(meshes, 2); assert.ok(triangles <= 1300, `bat triangles ${triangles}`);
});
