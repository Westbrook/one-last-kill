import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyBoxWorldUV } from './world-uv.js';

// Authored locations in the existing roof builder. Match all three objects
// before changing anything: a later architecture edit must not silently cause
// a second service lamp or move an unrelated mesh.
const LEGACY = Object.freeze({
  housing: [6.4, 16, -9.85], bulb: [6.4, 15.99, -9.75], light: [6.4, 15.99, -9.75],
});
const SERVICE = Object.freeze({
  housing: [-0.06, 16.05, -9.95], bulb: [-0.06, 16.04, -9.77], light: [-0.06, 16.04, -9.64],
  color: 0xffcf96, intensity: 2, distance: 7.5, decay: 2,
});
const EXIT = Object.freeze({
  bulb: [24.68, 14.95, -3.55], light: [24.60, 14.95, -3.55],
  color: 0xffd4a1, intensity: 1.5, distance: 6.5, decay: 2,
});

function findServiceFixture(meshes) {
  const position = new THREE.Vector3();
  const at = (object, expected) => object.getWorldPosition(position).distanceToSquared(new THREE.Vector3(...expected)) < 1e-8;
  const housing = meshes.filter(object => object.isMesh && object.geometry?.type === 'BoxGeometry'
    && Math.abs(object.geometry.parameters.width - 0.28) < 1e-6
    && Math.abs(object.geometry.parameters.height - 0.26) < 1e-6
    && Math.abs(object.geometry.parameters.depth - 0.10) < 1e-6 && at(object, LEGACY.housing));
  const bulb = meshes.filter(object => object.isMesh && object.geometry?.type === 'SphereGeometry'
    && Math.abs(object.geometry.parameters.radius - 0.06) < 1e-6 && at(object, LEGACY.bulb));
  const light = meshes.filter(object => object.isPointLight && at(object, LEGACY.light));
  if (housing.length !== 1 || bulb.length !== 1 || light.length !== 1) {
    return { status: 'legacy-fixture-unresolved', matches: { housing: housing.length, bulb: bulb.length, light: light.length } };
  }
  return { status: 'matched', housing: housing[0], bulb: bulb[0], light: light[0] };
}

function setWorldPosition(object, coordinates) {
  const position = new THREE.Vector3(...coordinates);
  object.parent?.worldToLocal(position);
  object.position.copy(position); object.updateMatrix(); object.updateWorldMatrix(false, false);
}

function hardwareGeometry(withService, material) {
  const pieces = [];
  const box = (position, size) => {
    const geometry = new THREE.BoxGeometry(...size).translate(...position);
    applyBoxWorldUV(geometry, material.userData?.surfaceMeters);
    pieces.push(geometry);
  };
  if (withService) {
    // The lamp sits left of the door jamb; the highest hood point is 16.253m,
    // below the sign and outside the header's horizontal extent. The rear
    // plate and socket physically connect the original housing and globe.
    box([-0.06, 16.04, -9.986], [0.12, 0.43, 0.04]);
    box([-0.06, 16.04, -9.86], [0.07, 0.08, 0.12]);
    box([-0.06, 16.235, -9.81], [0.38, 0.035, 0.34]);
    for (const x of [-0.21, 0.09]) box([x, 16.085, -9.68], [0.018, 0.30, 0.018]);
    box([-0.06, 15.93, -9.68], [0.32, 0.025, 0.025]);
  }
  // Mount to the inside face of the east parapet, away from the open exit and
  // its x=22m route center. No post or collision volume enters the walkway.
  box([24.865, 14.95, -3.55], [0.04, 0.38, 0.30]);
  box([24.805, 14.95, -3.55], [0.11, 0.26, 0.28]);
  box([24.76, 14.95, -3.55], [0.06, 0.07, 0.08]);
  box([24.725, 15.155, -3.55], [0.32, 0.035, 0.40]);
  for (const z of [-3.70, -3.40]) box([24.60, 14.99, z], [0.018, 0.30, 0.018]);
  box([24.60, 14.84, -3.55], [0.024, 0.025, 0.32]);
  const result = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  result.computeBoundingBox(); result.computeBoundingSphere();
  return result;
}

/**
 * Two restrained practicals using the game's existing fixed point-light pool.
 * Repositions one authored lamp and adds one sheltered exit lamp. No shadow
 * map, fullscreen pass, texture, collider, or per-frame helper work is added.
 * Parent must use the world's coordinate space (the environment root does).
 *
 * Build before createLightBudget/Ballistics.rebuild. setEnabled() returns the
 * moved original meshes: QA callers should refresh their ballistic entries
 * after an A/B toggle; ordinary gameplay keeps the accepted layout enabled.
 */
export function createRoofTaskLighting(parent, { roofMeshes, metalMaterial } = {}) {
  if (!parent?.isObject3D || !Array.isArray(roofMeshes) || !metalMaterial?.isMaterial) {
    throw new TypeError('Roof task lighting requires a parent, captured roof meshes and a shared metal material.');
  }
  const fixture = findServiceFixture(roofMeshes), matched = fixture.status === 'matched';
  const original = matched ? {
    housingPosition: fixture.housing.position.clone(), bulbPosition: fixture.bulb.position.clone(), lightPosition: fixture.light.position.clone(),
    bulbMaterial: fixture.bulb.material, intensity: fixture.light.intensity, distance: fixture.light.distance,
    decay: fixture.light.decay, color: fixture.light.color.clone(),
  } : null;
  const group = new THREE.Group(); group.name = 'roof-task-lighting';
  group.userData.zone = 'roof'; group.matrixAutoUpdate = false;
  const geometry = hardwareGeometry(matched, metalMaterial);
  const hardware = new THREE.Mesh(geometry, metalMaterial);
  hardware.name = 'roof-task-lamp-hardware'; hardware.castShadow = false; hardware.receiveShadow = true;
  hardware.userData.collider = null; group.add(hardware);
  const emissive = new THREE.MeshStandardMaterial({ color: 0xe8ddc4, emissive: 0xffd0a0, emissiveIntensity: 1.3, roughness: 0.55 });
  const ownsGlobeGeometry = !matched;
  const globeGeometry = matched ? fixture.bulb.geometry : new THREE.SphereGeometry(0.06, 12, 8);
  const globe = new THREE.Mesh(globeGeometry, emissive);
  globe.name = 'roof-exit-task-lamp'; globe.position.set(...EXIT.bulb); globe.castShadow = false;
  globe.userData.collider = null; group.add(globe);
  const exitLight = new THREE.PointLight(EXIT.color, EXIT.intensity, EXIT.distance, EXIT.decay);
  exitLight.name = 'roof-exit-task-light'; exitLight.position.set(...EXIT.light);
  exitLight.userData.zone = 'roof'; exitLight.castShadow = false;
  // Authored lights are data sources. Only createLightBudget's eight lights
  // reach the GPU, including when this controller is used for paused QA.
  exitLight.visible = false; group.add(exitLight);
  parent.add(group);
  let enabled = false, disposed = false;
  const movedMeshes = matched ? [fixture.housing, fixture.bulb] : [];
  function setEnabled(value) {
    if (disposed || enabled === Boolean(value)) return [];
    enabled = Boolean(value);
    group.visible = enabled;
    exitLight.intensity = enabled ? EXIT.intensity : 0;
    if (matched) {
      if (enabled) {
        setWorldPosition(fixture.housing, SERVICE.housing);
        setWorldPosition(fixture.bulb, SERVICE.bulb);
        setWorldPosition(fixture.light, SERVICE.light);
        fixture.bulb.material = emissive;
        fixture.light.color.setHex(SERVICE.color);
        fixture.light.intensity = SERVICE.intensity; fixture.light.distance = SERVICE.distance; fixture.light.decay = SERVICE.decay;
      } else {
        fixture.housing.position.copy(original.housingPosition); fixture.housing.updateMatrix(); fixture.housing.updateWorldMatrix(false, false);
        fixture.bulb.position.copy(original.bulbPosition); fixture.bulb.updateMatrix(); fixture.bulb.updateWorldMatrix(false, false);
        fixture.light.position.copy(original.lightPosition); fixture.light.updateMatrix(); fixture.light.updateWorldMatrix(false, false);
        fixture.bulb.material = original.bulbMaterial;
        fixture.light.color.copy(original.color);
        fixture.light.intensity = original.intensity; fixture.light.distance = original.distance; fixture.light.decay = original.decay;
      }
    }
    return movedMeshes;
  }
  setEnabled(true);
  const addedTriangles = (geometry.index?.count ?? geometry.attributes.position.count) / 3
    + (globeGeometry.index?.count ?? globeGeometry.attributes.position.count) / 3;
  const geometryBytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
    + (geometry.index?.array.byteLength ?? 0)
    + (ownsGlobeGeometry ? Object.values(globeGeometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
      + (globeGeometry.index?.array.byteLength ?? 0) : 0);
  return {
    setEnabled,
    // This is only needed if a development caller installs the helper after
    // the normal boot-time light-budget scan has already completed.
    registerLights(lightBudget) { if (!disposed) lightBudget.register(exitLight); },
    snapshot() {
      return {
        status: disposed ? 'disposed' : matched ? 'ready' : 'partial', enabled,
        serviceFixture: fixture.status, legacyMatches: fixture.matches ?? null,
        addedLightSources: 1, retunedLightSources: matched ? 1 : 0,
        addedMeshes: 2, addedTriangles, geometryBytes, addedTextures: 0, addedShadowCasters: 0,
        newShadowMaps: 0, extraFullscreenPasses: 0, perFrameWork: 0,
        service: matched ? { position: enabled ? [...SERVICE.light] : [...LEGACY.light], intensity: fixture.light.intensity, distance: fixture.light.distance } : null,
        exit: { position: [...EXIT.light], intensity: exitLight.intensity, distance: exitLight.distance },
      };
    },
    dispose() {
      if (disposed) return [];
      const changed = setEnabled(false);
      disposed = true; parent.remove(group);
      geometry.dispose(); emissive.dispose();
      if (ownsGlobeGeometry) globeGeometry.dispose();
      return changed;
    },
  };
}
