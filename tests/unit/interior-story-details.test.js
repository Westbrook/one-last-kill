import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createInteriorStoryDetails, interiorStoryGeometryBudget, storyBoxGeometry } from '../../src/world/interior-story-details.js';
import { createInteriorProps } from '../../src/world/interior-props.js';
import { INTERIOR_STORY_ATLAS } from '../../src/render/interior-story-materials.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

function fixture(materials = { enamel: new THREE.MeshStandardMaterial(), rubber: new THREE.MeshStandardMaterial() }) {
  const group = new THREE.Group(), decorations = [], bodies = [];
  const pushDecor = (geometry, material, x, y, z, sx, sy, sz, yaw = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw;
    mesh.updateMatrixWorld(); group.add(mesh); decorations.push(mesh);
  };
  const addBox = (x, y, z, width, height, depth, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z); group.add(mesh); bodies.push(mesh); return mesh;
  };
  const props = createInteriorProps({ addBox, pushDecor, materials,
    boxGeometry: new THREE.BoxGeometry(1, 1, 1), pipeGeometry: new THREE.CylinderGeometry(1, 1, 1, 8) });
  return { group, decorations, bodies, materials, story: createInteriorStoryDetails({ pushDecor, materials }), props };
}

test('bookcase collections keep real-scale books grounded on existing shelves under each quarter turn', () => {
  for (const width of [0.7, 1.15, 2.2]) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const { props, decorations, bodies } = fixture();
    const height = 2, floorY = 4;
    props.bookcase({ id: 'neighbor-study-shelves', x: 0, z: 0, floorY, width, height, depth: 0.4, yaw });
    assert.equal(bodies.length, 1, 'contents never add a movement body');
    const upright = decorations.filter(mesh => mesh.geometry.userData.story?.kind === 'spine');
    assert.ok(upright.length >= 10 && upright.length <= 40);
    const shelfTops = [0.055, 0.275, 0.495, 0.715].map(y => floorY + (y + 0.014) * height);
    for (const book of upright) {
      const bounds = new THREE.Box3().setFromObject(book), size = bounds.getSize(new THREE.Vector3());
      assert.ok(shelfTops.some(top => Math.abs(bounds.min.y - top) < 1e-6), 'book bottom meets an actual shelf top');
      assert.ok(size.y >= 0.21 && size.y <= 0.31, 'book height remains a physical paperback/hardback size');
      assert.ok(Math.max(size.x, size.z) < 0.06, 'wide cabinets do not inflate book thickness');
      assert.ok(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.z), Math.abs(bounds.max.z)) < width / 2 + 0.24);
    }
    assert.ok(decorations.some(mesh => mesh.geometry.userData.story?.kind === 'postcard'));
    assert.ok(decorations.some(mesh => mesh.geometry.userData.story?.kind === 'pages'));
  }
});

test('rugs preserve their old physical footprint and select separate opaque atlas panels', () => {
  const { story, decorations } = fixture();
  for (const variant of ['warm', 'cool']) story.rug({ x: 0, z: 0, floorY: 4, width: 3.8, depth: 4.5, variant });
  assert.equal(decorations.length, 2);
  for (const [index, mesh] of decorations.entries()) {
    const bounds = new THREE.Box3().setFromObject(mesh);
    near(bounds.min.x, -1.9); near(bounds.max.z, 2.25); near(bounds.min.y, 4.003); near(bounds.max.y, 4.015);
    const cell = INTERIOR_STORY_ATLAS.rugs[index ? 'cool' : 'warm'], uv = mesh.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      assert.ok(uv.getX(i) >= cell.uMin - 1e-6 && uv.getX(i) <= cell.uMax + 1e-6);
      assert.ok(uv.getY(i) >= cell.vMin - 1e-6 && uv.getY(i) <= cell.vMax + 1e-6);
    }
    assert.equal(mesh.material.transparent, false);
  }
});

test('kitchen and bakery groups stay on their declared supporting tops with fitted labels and hollow bowls', () => {
  for (const kind of ['kitchenStillLife', 'bakeryPreparation']) {
    const { story, decorations, group, bodies } = fixture();
    story[kind]({ x: 0, z: 0, topY: 4.945 }); group.updateMatrixWorld();
    assert.equal(bodies.length, 0);
    const bounds = new THREE.Box3().setFromObject(group);
    near(bounds.min.y, 4.945);
    assert.ok(bounds.max.y < 5.12 && bounds.max.x <= 0.30 && bounds.min.x >= -0.30);
    assert.ok(bounds.min.z >= -0.18 && bounds.max.z <= 0.18);
    for (const label of decorations.filter(mesh => mesh.geometry.userData.story?.kind === 'canister-label')) {
      const p = label.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) near(Math.hypot(p.getX(i), p.getZ(i)), 0.0504);
    }
    for (const bowl of decorations.filter(mesh => mesh.geometry.userData.story?.kind === 'bowl')) {
      const origin = bowl.position.clone().add(new THREE.Vector3(0, 0.2, 0));
      const hit = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0)).intersectObject(bowl)[0];
      assert.ok(hit); near(hit.point.y, bowl.position.y + 0.012 * bowl.scale.y);
    }
  }
});

test('story construction is deterministic and reuses its bounded geometry cache', () => {
  const first = fixture(), second = fixture(first.materials);
  first.story.kitchenStillLife({ x: 0, z: 0, topY: 1 });
  first.story.rug({ x: 0, z: 0, floorY: 0, width: 2, depth: 3 });
  const budget = interiorStoryGeometryBudget();
  second.story.kitchenStillLife({ x: 0, z: 0, topY: 1 });
  second.story.rug({ x: 0, z: 0, floorY: 0, width: 2, depth: 3 });
  assert.deepEqual(interiorStoryGeometryBudget(), budget);
  assert.ok(budget.bytes < 200 * 1024 && budget.triangles < 2500);
  assert.equal(first.decorations.length, second.decorations.length);
  for (let i = 0; i < first.decorations.length; i++) {
    assert.equal(first.decorations[i].geometry, second.decorations[i].geometry);
    assert.equal(first.decorations[i].material, second.decorations[i].material);
    assert.ok(first.decorations[i].position.equals(second.decorations[i].position));
  }
  assert.equal(storyBoxGeometry('spine', 2), storyBoxGeometry('spine', 2));
});
