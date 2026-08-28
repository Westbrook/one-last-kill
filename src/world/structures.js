import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MATS, makeCanvas } from '../render/materials.js';
import { Colliders } from '../core/collision.js';
import { Architecture, boxBounds } from './architecture.js';
import { World } from './world.js';

const UP = new THREE.Vector3(0, 1, 0);
let screenMaterial;

function getScreenMaterial() {
  if (screenMaterial) return screenMaterial;
  const canvas = makeCanvas(32);
  const context = canvas.getContext('2d');
  context.strokeStyle = '#67736c';
  context.lineWidth = 1.25;
  context.beginPath();
  context.moveTo(0, 16); context.lineTo(16, 0); context.lineTo(32, 16);
  context.lineTo(16, 32); context.closePath(); context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  screenMaterial = new THREE.MeshStandardMaterial({
    map: texture, color: 0x6c786e, roughness: 0.91, metalness: 0.25,
    alphaTest: 0.15, side: THREE.DoubleSide,
  });
  screenMaterial.userData.surfaceKind = 'metal';
  return screenMaterial;
}

/** A straight member with true end-to-end orientation, including diagonals. */
export function addBeam(id, start, end, width, supports = [], { depth = width, material = MATS.metal } = {}) {
  const from = new THREE.Vector3(...start), to = new THREE.Vector3(...end);
  const direction = to.clone().sub(from);
  if (direction.lengthSq() === 0) throw new Error(`Zero-length member: ${id}`);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, direction.length(), depth), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  mesh.receiveShadow = true;
  World.add(mesh);
  mesh.updateWorldMatrix(true, false);
  Architecture.register(mesh, null, new THREE.Box3().setFromObject(mesh), {
    id, kind: 'brace', supports, supportKind: 'anchored',
  });
  return mesh;
}

/** Visible framed enclosure. Its full bounds exactly match player collision. */
export function addProtectiveScreen(id, start, end, floorY, height, supports, { mesh = true } = {}) {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const width = Math.hypot(dx, dz), thickness = 0.08, frame = 0.07;
  if (Math.min(width, height) <= frame) throw new Error(`Invalid guard: ${id}`);
  const group = new THREE.Group();
  group.position.set((start[0] + end[0]) / 2, floorY + height / 2, (start[1] + end[1]) / 2);
  group.rotation.y = -Math.atan2(dz, dx);
  const geometry = [];
  const member = (x, y, w, h) => {
    const part = new THREE.BoxGeometry(w, h, thickness);
    part.translate(x, y, 0); geometry.push(part);
  };
  member(0, -height / 2 + frame / 2, width, frame);
  member(0, height / 2 - frame / 2, width, frame);
  for (const y of [0.55, 1.1]) {
    if (y < height - frame) member(0, y - height / 2, width, frame);
  }
  const bays = Math.ceil(width / 1.6);
  for (let i = 0; i <= bays; i++) {
    member(-width / 2 + frame / 2 + (width - frame) * i / bays, 0, frame, height);
  }
  const frameMesh = new THREE.Mesh(mergeGeometries(geometry), MATS.metal);
  for (const part of geometry) part.dispose();
  frameMesh.receiveShadow = true; group.add(frameMesh);
  if (mesh) {
    const panel = new THREE.PlaneGeometry(width - frame, height - frame);
    const uv = panel.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width / 0.13, uv.getY(i) * height / 0.13);
    group.add(new THREE.Mesh(panel, getScreenMaterial()));
  }
  World.add(group);
  const bounds = boxBounds(group.position.x, group.position.y, group.position.z,
    Math.abs(dx) + Math.abs(dz / width) * thickness, height,
    Math.abs(dz) + Math.abs(dx / width) * thickness);
  const collider = Colliders.addBox(bounds.min, bounds.max);
  group.userData.collider = collider;
  Architecture.register(group, collider, bounds, { id, kind: 'guard', supports, supportKind: 'bearing' });
  return group;
}
