import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SCAFFOLD_LEVELS } from '../../src/world/layout.js';
import { buildWorldSurfaceFixture, collectAxisAlignedBoxFaces, findCoplanarBoxOverlaps } from './helpers/world-surface-fixture.js';

const fixture = buildWorldSurfaceFixture();
const clothIds = ['scaffold-drape-0', 'scaffold-drape-2'];
const isClothOverlap = ({ a, b }) => clothIds.includes(a.id) || clothIds.includes(b.id);
const near = (actual, expected, label, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${label}: ${actual} != ${expected}`);
const projectedOverlap = (a, b) => Math.max(0, Math.min(a.maxU, b.maxU) - Math.max(a.minU, b.minU))
  * Math.max(0, Math.min(a.maxV, b.maxV) - Math.max(a.minV, b.minV));

test('actual cloth faces clear transom ends on every level and sit 2cm ahead of the outer couplers', () => {
  const faces = collectAxisAlignedBoxFaces(fixture);
  for (const [levelIndex, level] of SCAFFOLD_LEVELS.entries()) {
    const transoms = faces.filter(face => face.id.startsWith(`scaffold-transom-${levelIndex}-`) && face.axis === 'z' && face.sign === 1);
    assert.ok(transoms.length >= 6, `level ${levelIndex} retains all transoms`);
    for (const face of transoms) {
      near(face.plane, 7.7, `${face.id} unchanged front face`);
      const record = fixture.records.get(face.id);
      assert.ok(record.collider, `${face.id} retains its collider`);
      near(record.collider.min.z, 0.16, `${face.id} unchanged rear collision`);
      near(record.collider.max.z, 7.7, `${face.id} unchanged front collision`);
      near(record.collider.min.y, level.y - 0.23, `${face.id} unchanged lower collision`);
      near(record.collider.max.y, level.y - 0.08, `${face.id} unchanged upper collision`);
    }
  }
  for (const id of clothIds) {
    const cloth = faces.find(face => face.id === id && face.axis === 'z' && face.sign === 1);
    assert.ok(cloth, `${id} has an actual rendered rectangular face`);
    near(cloth.plane, 7.805, `${id} physical cloth plane`);
    const metalBehind = faces.filter(face => face.entry.zone === 'scaffolding' && face.material.name === 'metal'
      && face.axis === 'z' && face.sign === 1 && face.plane < cloth.plane && projectedOverlap(face, cloth) > 1e-5);
    assert.ok(metalBehind.length > 0);
    const outerMetal = Math.max(...metalBehind.map(face => face.plane));
    near(outerMetal, 7.785, `${id} actual outer coupler face`);
    near(cloth.plane - outerMetal, 0.02, `${id} separation from nearest metal behind it`);
    assert.equal(cloth.material.color.getHex(), 0x586152);
    assert.equal(cloth.material.side, THREE.DoubleSide);
    assert.equal(cloth.material.roughness, 0.96);
    assert.equal(cloth.material.polygonOffset, false);
    assert.equal(cloth.material.depthTest, true);
    assert.equal(cloth.material.depthWrite, true);
    assert.equal(cloth.entry.mesh.renderOrder, 0);
  }
  assert.equal(findCoplanarBoxOverlaps(fixture).filter(isClothOverlap).length, 0);
});

test('the face audit reproduces both original conflicts when the cloth is returned to its old plane', () => {
  const cloths = clothIds.map(id => fixture.World.getObjectByName(id));
  const positions = cloths.map(cloth => cloth.position.z);
  try {
    for (const cloth of cloths) cloth.position.z = 7.7;
    const before = findCoplanarBoxOverlaps(fixture).filter(isClothOverlap);
    assert.equal(before.length, 2, 'the old layout exposes both distinct-material overlaps');
    for (const [index, area] of [[0, 0.009], [2, 0.0057]]) {
      const hit = before.find(({ a, b }) => [a.id, b.id].includes(`scaffold-drape-${index}`)
        && [a.id, b.id].includes(`scaffold-transom-${index}-5`));
      assert.ok(hit, `old level ${index} conflict is detected from actual triangles`);
      near(hit.plane, 7.7, `old level ${index} face plane`);
      near(hit.area, area, `old level ${index} overlap area`);
      assert.notEqual(hit.a.material, hit.b.material);
    }
  } finally {
    for (const [index, cloth] of cloths.entries()) cloth.position.z = positions[index];
    fixture.World.updateMatrixWorld(true);
  }
  assert.equal(findCoplanarBoxOverlaps(fixture).filter(isClothOverlap).length, 0, 'physical separation removes both conflicts');
});

test('four noncolliding clips grip the cloth hem and attach to unchanged original tie anchors', () => {
  const faces = collectAxisAlignedBoxFaces(fixture);
  for (const index of [0, 2]) {
    const level = SCAFFOLD_LEVELS[index], centerX = level.x2 - 1.4;
    const cloth = fixture.World.getObjectByName(`scaffold-drape-${index}`);
    const clothBounds = new THREE.Box3().setFromObject(cloth);
    const tieId = `scaffold-drape-tie-${index}`, tie = fixture.records.get(tieId);
    assert.equal(tie.collider, null);
    assert.deepEqual([...tie.supports], [`scaffold-ledger-${index}-3`]);
    near(tie.bounds.min.x, centerX - 1.2, `${tieId} west anchor`);
    near(tie.bounds.max.x, centerX + 1.2, `${tieId} east anchor`);
    near(tie.bounds.min.z, 7.68, `${tieId} rear anchor`);
    near(tie.bounds.max.z, 7.72, `${tieId} front anchor`);
    near(tie.bounds.min.y, level.y - 0.19, `${tieId} lower anchor`);
    near(tie.bounds.max.y, level.y - 0.15, `${tieId} upper anchor`);
    for (const side of ['left', 'right']) {
      const id = `scaffold-drape-clip-${index}-${side}`, clip = fixture.records.get(id);
      assert.ok(clip, `${id} exists`);
      assert.equal(clip.collider, null, 'clip does not change collision or the walk lane');
      assert.deepEqual([...clip.supports], [tieId]);
      assert.ok(clip.bounds.intersectsBox(tie.bounds), `${id} meets its fixed tie`);
      assert.ok(clip.bounds.intersectsBox(clothBounds), `${id} grips the cloth hem`);
      near(clip.bounds.getCenter(new THREE.Vector3()).y, clothBounds.max.y, `${id} hem height`);
      const front = faces.find(face => face.id === id && face.axis === 'z' && face.sign === 1);
      assert.ok(front);
      near(front.plane - cloth.position.z, 0.02, `${id} front is not coplanar with cloth`);
    }
  }
});
