import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createInteriorStoryDetails } from '../world/interior-story-details.js';

/** Build only on the actual prep island; a missing support means no vignette. */
export function buildBakeryStoryDetail(world, materials) {
  const support = world.getObjectByName('bakery-prep-island-top');
  if (!support?.isMesh) return null;
  const bounds = new THREE.Box3().setFromObject(support);
  if (bounds.max.x - bounds.min.x < 2.12 || bounds.max.z - bounds.min.z < 0.40) return null;
  // The clear interval between the first and second existing bread boards.
  // The named support supplies both position and actual top, including any
  // future translation. No guessed floor height or free-standing object.
  const x = (bounds.min.x + bounds.max.x) / 2 - 0.75;
  const z = (bounds.min.z + bounds.max.z) / 2, topY = bounds.max.y;
  const buckets = new Map(), transform = new THREE.Object3D();
  const story = createInteriorStoryDetails({ materials,
    pushDecor(source, material, px, py, pz, sx, sy, sz, yaw = 0) {
      transform.position.set(px, py, pz); transform.rotation.set(0, yaw, 0);
      transform.scale.set(sx, sy, sz); transform.updateMatrix();
      const geometry = source.clone().applyMatrix4(transform.matrix);
      // The chamfered board is non-indexed; the lathed pin is indexed. Give
      // both explicit indices so they share one wood draw without UV changes.
      if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, i) => i));
      if (!buckets.has(material)) buckets.set(material, []);
      buckets.get(material).push(geometry);
    },
  });
  story.bakeryPreparation({ x, z, topY, yaw: 0 });
  const root = new THREE.Group(); root.name = 'bakery-preparation-vignette'; root.matrixAutoUpdate = false;
  let triangles = 0, geometryBytes = 0;
  for (const [material, parts] of buckets) {
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `bakery-preparation-${material.name || root.children.length}`;
    mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false;
    root.add(mesh);
    triangles += geometry.index.count / 3;
    geometryBytes += geometry.index.array.byteLength + Object.values(geometry.attributes)
      .reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
  }
  root.userData.storyDetail = { support: support.name, x, topY, z, triangles, geometryBytes, draws: root.children.length };
  return root;
}
