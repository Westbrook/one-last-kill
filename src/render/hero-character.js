import * as THREE from 'three';
import { heroBodyGeometry, HERO_BIND_ARM_ANGLE } from './hero-character-geometry.js';
import { heroHeadGeometry } from './hero-character-head.js';
import { heroCharacterMaterials } from './hero-character-materials.js';
import { getAuthoredCharacterSurfaces } from './authored-character-surfaces.js';

const supportCache = new WeakMap();
const SUPPORT_DIRECTIONS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (x || y || z) SUPPORT_DIRECTIONS.push(new THREE.Vector3(x, y, z).normalize());
}
const FOOT_DIRECTIONS = [...SUPPORT_DIRECTIONS];
for (let i = 0; i < 36; i++) FOOT_DIRECTIONS.push(new THREE.Vector3(0, Math.cos(i * Math.PI / 18), Math.sin(i * Math.PI / 18)));

function supportSamples(mesh, skeleton) {
  if (supportCache.has(mesh.geometry)) return supportCache.get(mesh.geometry);
  const geometry = mesh.geometry, p = geometry.attributes.position;
  const indices = geometry.attributes.skinIndex, weights = geometry.attributes.skinWeight;
  const groups = new Map(), position = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const bone = indices ? indices.getX(i) : 0;
    const key = indices ? `${bone}:${indices.getY(i)}:${Math.floor(weights.getX(i) * 4)}` : 'rigid';
    let group = groups.get(key);
    if (!group) {
      const directions = indices && skeleton.bones[bone].name.includes('ankle') ? FOOT_DIRECTIONS : SUPPORT_DIRECTIONS;
      group = directions.map(direction => ({ direction, value: -Infinity, index: 0 })); groups.set(key, group);
    }
    position.fromBufferAttribute(p, i);
    if (indices) position.applyMatrix4(skeleton.boneInverses[bone]);
    for (let j = 0; j < group.length; j++) {
      const value = position.dot(group[j].direction);
      if (value > group[j].value) { group[j].value = value; group[j].index = i; }
    }
  }
  const selected = new Uint32Array([...new Set([...groups.values()].flatMap(group => group.map(sample => sample.index)))]);
  supportCache.set(geometry, selected); return selected;
}

function influenceBounds(mesh, skeleton) {
  const boxes = skeleton.bones.map(() => new THREE.Box3());
  const position = mesh.geometry.attributes.position, weights = mesh.geometry.attributes.skinWeight;
  const indices = mesh.geometry.attributes.skinIndex, vertex = new THREE.Vector3(), local = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.bindMatrix);
    for (let k = 0; k < 4; k++) {
      if (weights.getComponent(i, k) <= 0) continue;
      const index = indices.getComponent(i, k);
      local.copy(vertex).applyMatrix4(skeleton.boneInverses[index]); boxes[index].expandByPoint(local);
    }
  }
  // A normalized linear blend is inside the AABB union of its transformed
  // influence boxes. Corpse placement can reuse its O(bones) cached-box path.
  return boxes.flatMap((box, index) => box.isEmpty() ? [] : [{
    name: `skin-bound:${skeleton.bones[index].name}`, geometry: { boundingBox: box },
    matrixWorld: skeleton.bones[index].matrixWorld, userData: { role: 'skin-bound' },
  }]);
}

/** Keep the established animation skeleton, replacing only rendered surfaces. */
export function installHeroCharacter(root, rig, config) {
  const { joints, dimensions: d, bodyMeshes } = rig;
  joints.shoulderL.rotation.z = -HERO_BIND_ARM_ANGLE;
  joints.shoulderR.rotation.z = HERO_BIND_ARM_ANGLE;
  root.updateMatrixWorld(true);
  const bones = Object.values(joints), skeleton = new THREE.Skeleton(bones);
  const authored = getAuthoredCharacterSurfaces(config, d, bones);
  const body = authored?.body || heroBodyGeometry(config, d, bones, bodyMeshes), head = authored?.head || heroHeadGeometry(config);
  const materials = heroCharacterMaterials(config, { finish: authored?.finish }), visualMeshes = [], bounds = [];
  for (const [name, geometry, material] of [['garments', body.garments, materials.garments], ['skin', body.skin, materials.skin]]) {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = `hero-${name}`; mesh.userData.role = 'body';
    // Rigs are pooled and parent visibility gates them. Avoid stale skinned
    // culling spheres and any per-frame CPU vertex bounds scan.
    mesh.frustumCulled = false; mesh.castShadow = mesh.receiveShadow = true;
    // Three also requests a sphere for render sorting when culling is disabled.
    // Its static bind-space center is sufficient for opaque sorting; assigning
    // it now prevents an otherwise hidden full skin scan on a pool slot's first draw.
    mesh.boundingSphere = geometry.boundingSphere.clone();
    root.add(mesh); mesh.bind(skeleton, new THREE.Matrix4());
    visualMeshes.push(mesh); bounds.push(...influenceBounds(mesh, skeleton));
  }
  const oldHead = bodyMeshes.find(mesh => mesh.name === 'head');
  for (const [name, geometry, material] of [['head', head.head, materials.face], ['face-hair', head.details, materials.details]]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `hero-${name}`; mesh.userData.role = 'body';
    mesh.position.copy(oldHead.position); mesh.scale.copy(oldHead.scale);
    mesh.scale.multiply(new THREE.Vector3(head.scale.x, head.scale.y, head.scale.z));
    mesh.castShadow = mesh.receiveShadow = true;
    joints.head.add(mesh); visualMeshes.push(mesh); bounds.push(mesh);
  }
  for (const mesh of bodyMeshes) { mesh.visible = false; mesh.userData.role = 'bounds-proxy'; }
  joints.shoulderL.rotation.z = joints.shoulderR.rotation.z = 0;
  root.updateMatrixWorld(true);
  rig.visualMeshes = visualMeshes;
  rig.visualBoundsProxies = bounds;
  rig.contactSurfaces = visualMeshes.map(mesh => ({ mesh, indices: supportSamples(mesh, skeleton) }));
  rig.contactBounds = target => getHumanoidContactBounds(root, target);
  rig.hero = {
    version: 1, role: body.role, skeleton, source: authored?.source || 'original-procedural',
    triangles: visualMeshes.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0),
    draws: visualMeshes.length,
    continuousSurfaceTriangles: body.surfaceTriangles, continuousSurfaceVertices: body.surfaceVertices,
    garmentDetails: body.garmentDetails,
    contactSamples: rig.contactSurfaces.reduce((sum, surface) => sum + surface.indices.length, 0),
    provenance: body.provenance,
    ...(authored?.finish ? { finish: authored.finish.id } : {}),
    ...(authored?.revision ? { revision: authored.revision } : {}),
  };
}

const _vertex = new THREE.Vector3();

/** Bounded support geometry for an active collapse, never a render-buffer update. */
export function getHumanoidContactBounds(root, target) {
  target.makeEmpty();
  for (const { mesh, indices } of root.userData.rig.contactSurfaces) {
    for (const index of indices) {
      mesh.getVertexPosition(index, _vertex).applyMatrix4(mesh.matrixWorld); target.expandByPoint(_vertex);
    }
  }
  return target.expandByScalar(0.002);
}

/** Explicit inspection-only vertex scan; never used by the animation loop. */
export function getHumanoidVisualBounds(root, target = new THREE.Box3()) {
  target.makeEmpty(); root.updateMatrixWorld(true);
  const meshes = root.userData.rig?.visualMeshes || root.userData.rig?.bodyMeshes || [];
  for (const mesh of meshes) {
    if (!mesh.visible) continue;
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      mesh.getVertexPosition(i, _vertex).applyMatrix4(mesh.matrixWorld); target.expandByPoint(_vertex);
    }
  }
  return target;
}
