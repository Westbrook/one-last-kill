import * as THREE from 'three';
import { fitWorldShadow } from './shadow-frustum.js';

const SIZE = 64;
const SHADOW_SIZE = 512;
const BYTES_PER_HDR_PIXEL = 8;
export const INTERIOR_REFLECTION_PROBES = Object.freeze([
  { id: 'apartment-kitchen', zone: 'apartment', position: [-12.5, 5.3, -3.9],
    min: [-14.94, 3.98, -9.94], max: [-3.02, 7.42, -0.06], lights: ['apartment', 'neighbor'] },
  { id: 'neighbor-kitchen', zone: 'neighbor', position: [5.8, 5.4, -3.2],
    min: [-3.02, 3.98, -9.94], max: [8.96, 7.42, -0.06], lights: ['neighbor', 'apartment', 'balcony'] },
  // One probe is intentionally confined to the preparation room. Applying
  // its reflections across the solid retail partition would be misleading.
  { id: 'bakery-preparation', zone: 'bakery', position: [-25, 1.8, 38.1],
    min: [-33.85, 0.06, 35.65], max: [-16.15, 4.12, 42.85], lights: ['bakery', 'street'] },
]);

const DEFAULT_FACTORIES = Object.freeze({
  createTarget(size) {
    return new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter, depthBuffer: true, stencilBuffer: false,
    });
  },
  createCamera(target) { return new THREE.CubeCamera(0.06, 90, target); },
  createPMREM(renderer) { return new THREE.PMREMGenerator(renderer); },
  capture(renderer, camera, scene) { camera.update(renderer, scene); },
});

function staticMesh(mesh) {
  if (!mesh?.isMesh || mesh.isSkinnedMesh || !mesh.visible || mesh.layers.mask !== 1
    || mesh.userData.dynamic || mesh.userData.gate || mesh.userData.ballistics === false) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.every(material => material?.visible && material.opacity > 0 && !material.wireframe);
}

function staticSources(world, zoneMeshes) {
  const meshes = new Set(), lights = new Set();
  // Captured zone children predate health/ammo pickups and combat actors.
  // Do not recurse through arbitrary groups: those contain fire, NPC rigs,
  // cars with exhaust, progression gates or transient gameplay presentation.
  for (const children of Object.values(zoneMeshes)) for (const object of children) {
    if (staticMesh(object)) meshes.add(object);
    else if (object.isPointLight) lights.add(object);
  }
  // This one explicitly static group owns windows, radiators and the distant
  // city. Its particle Points/lines are excluded by the mesh predicate.
  const environment = world.getObjectByName('cinematic-environment');
  for (const object of environment?.children ?? []) {
    if (staticMesh(object)) meshes.add(object);
    else if (object.isPointLight) lights.add(object);
  }
  return { meshes, lights };
}

function proxyMesh(source) {
  source.updateWorldMatrix(true, false);
  const proxy = source.isInstancedMesh
    ? new THREE.InstancedMesh(source.geometry, source.material, source.count)
    : new THREE.Mesh(source.geometry, source.material);
  if (source.isInstancedMesh) {
    // InstancedMesh owns object-specific VAOs. Its disposal removes instance
    // attributes, so capture proxies need their own small buffers even though
    // ordinary geometry and texture maps remain shared with the live world.
    proxy.instanceMatrix = source.instanceMatrix.clone();
    proxy.instanceColor = source.instanceColor?.clone() ?? null;
    proxy.boundingBox = source.boundingBox?.clone() ?? null;
    proxy.boundingSphere = source.boundingSphere?.clone() ?? null;
  }
  proxy.name = source.name;
  proxy.matrix.copy(source.matrixWorld); proxy.matrixAutoUpdate = false;
  proxy.receiveShadow = source.receiveShadow;
  const materials = Array.isArray(source.material) ? source.material : [source.material];
  // One cold shadow capture can afford structural ceilings that omit casting
  // during normal play. Only actual opaque triangles cast this static shadow.
  proxy.castShadow = source.castShadow || materials.every(material => !material.transparent && material.opacity === 1);
  proxy.frustumCulled = source.frustumCulled;
  return proxy;
}

function makeCaptureScene(scene, sources, lightCount) {
  const capture = new THREE.Scene(); capture.name = 'static-interior-reflection-capture';
  capture.background = scene.background;
  capture.environment = scene.environment;
  capture.environmentIntensity = scene.environmentIntensity;
  capture.backgroundIntensity = scene.backgroundIntensity;
  capture.backgroundBlurriness = scene.backgroundBlurriness;
  capture.environmentRotation.copy(scene.environmentRotation);
  capture.backgroundRotation.copy(scene.backgroundRotation);
  capture.fog = scene.fog?.clone() ?? null;
  const instances = [];
  for (const source of sources.meshes) {
    const proxy = proxyMesh(source); capture.add(proxy);
    if (proxy.isInstancedMesh) instances.push(proxy);
  }
  const keys = [];
  for (const light of scene.children) {
    if (!light.visible || (!light.isAmbientLight && !light.isHemisphereLight && !light.isDirectionalLight)) continue;
    const copy = light.clone(); copy.layers.set(0);
    if (copy.isDirectionalLight) {
      copy.shadow.map = null; copy.shadow.mapPass = null;
      copy.shadow.autoUpdate = false; copy.shadow.needsUpdate = true;
      capture.add(copy.target); keys.push(copy);
    }
    capture.add(copy);
  }
  const pool = Array.from({ length: lightCount }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 15, 2);
    light.name = 'static-probe-practical'; capture.add(light); return light;
  });
  return { scene: capture, keys, pool, instances };
}

function prepareProbe(capture, probe, sources) {
  const position = new THREE.Vector3(...probe.position);
  const candidates = [];
  for (const light of sources.lights) {
    if (!(light.intensity > 0) || (light.userData.zone && !probe.lights.includes(light.userData.zone))) continue;
    const worldPosition = light.getWorldPosition(new THREE.Vector3()), distanceSq = worldPosition.distanceToSquared(position);
    if (distanceSq > ((light.distance || 30) + 12) ** 2) continue;
    candidates.push({ light, position: worldPosition, score: light.intensity / (distanceSq + 6) });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (let i = 0; i < capture.pool.length; i++) {
    const target = capture.pool[i], entry = candidates[i];
    target.intensity = entry ? entry.light.intensity * 1.8 : 0;
    if (!entry) continue;
    target.position.copy(entry.position); target.color.copy(entry.light.color);
    target.distance = entry.light.distance; target.decay = entry.light.decay;
  }
  const bounds = new THREE.Box3(new THREE.Vector3(...probe.min), new THREE.Vector3(...probe.max));
  bounds.min.add(new THREE.Vector3(-2, -1, -2)); bounds.max.add(new THREE.Vector3(2, 10, 2));
  for (const key of capture.keys) {
    fitWorldShadow(key, bounds, { mapSize: SHADOW_SIZE, margin: 1 });
    key.shadow.needsUpdate = true;
  }
}

function receiversForProbe(probe, zoneMeshes, interiorLighting) {
  const room = new THREE.Box3(new THREE.Vector3(...probe.min), new THREE.Vector3(...probe.max));
  const receivers = [];
  for (const mesh of zoneMeshes[probe.zone] ?? []) {
    if (!staticMesh(mesh) || mesh.isInstancedMesh || Array.isArray(mesh.material)) continue;
    const variants = interiorLighting.materialVariants(mesh), material = variants?.plain;
    if (!material?.isMeshStandardMaterial || material.alphaTest || material.alphaMap || material.alphaHash
      || material.displacementMap || material.transmission > 0) continue;
    if (!(material.metalness >= 0.15 || material.metalnessMap || material.roughness < 0.85 || material.userData.surfaceKind === 'metal')) continue;
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    // A conservative whole-mesh test is essential. A single merged material
    // may include indoor and outdoor faces; skip it instead of leaking a room
    // environment onto the roof/street or silently splitting its draw calls.
    if (!room.containsBox(bounds)) continue;
    receivers.push({ mesh, variants });
  }
  return receivers;
}

function reflectedMaterial(source, texture) {
  const material = source.clone();
  // Material.clone does not copy shader callbacks. Preserve the lightmap hook
  // and any authored finish hook rather than dropping them on the probe path.
  material.onBeforeCompile = source.onBeforeCompile;
  material.customProgramCacheKey = source.customProgramCacheKey.bind(source);
  material.envMap = texture;
  // The sky environment was intentionally faint. Captured room radiance has
  // already been shaded once and needs a normal unit-strength IBL response.
  material.envMapIntensity = Math.max(1, source.envMapIntensity);
  material.userData.interiorReflection = true;
  return material;
}

/**
 * Three 64px static local IBL captures, never updated during gameplay.
 * A private capture scene excludes every actor/fire/particle/pickup and uses
 * its own fixed light pool, leaving live visibility, zones and lighting intact.
 * All state and temporary targets are restored even if capture/PMREM fails.
 */
export async function createInteriorReflections(renderer, scene, world, {
  zoneMeshes, interiorLighting, lightBudget,
  probes = INTERIOR_REFLECTION_PROBES, now = () => performance.now(),
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
} = {}, factories = DEFAULT_FACTORIES) {
  if (!scene?.isScene || !world?.isObject3D || !zoneMeshes || !interiorLighting?.attachReflectionMaterials) {
    throw new TypeError('Interior reflections require scene, static zones and the interior material controller.');
  }
  if (!Array.isArray(probes) || !probes.length || probes.length > 3 || probes.some(probe =>
    !probe.id || !probe.zone || ![...probe.position, ...probe.min, ...probe.max].every(Number.isFinite))) {
    throw new RangeError('Interior reflections support one to three finite static room probes.');
  }
  if (renderer.extensions?.has('EXT_color_buffer_float') === false) {
    return { snapshot: () => ({ status: 'unsupported', enabled: false, captures: 0, residentBytes: 0 }), setEnabled() {}, dispose() {} };
  }
  const lightCount = Math.max(1, Math.min(8, lightBudget?.pool.length ?? 8));
  const started = now(), sources = staticSources(world, zoneMeshes);
  const active = probes.map(probe => ({ probe, receivers: receiversForProbe(probe, zoneMeshes, interiorLighting) }))
    .filter(entry => entry.receivers.length);
  if (!active.length) {
    return { snapshot: () => ({ status: 'no-receivers', enabled: false, captures: 0, residentBytes: 0 }), setEnabled() {}, dispose() {} };
  }
  const saved = {
    target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear, autoClearColor: renderer.autoClearColor, autoClearDepth: renderer.autoClearDepth, autoClearStencil: renderer.autoClearStencil,
    toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure, outputColorSpace: renderer.outputColorSpace,
    xrEnabled: renderer.xr?.enabled, shadowEnabled: renderer.shadowMap.enabled,
    shadowAutoUpdate: renderer.shadowMap.autoUpdate, shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
    infoAutoReset: renderer.info.autoReset, renderInfo: { ...renderer.info.render },
  };
  let capture = null, pmrem = null, cubeTarget = null, layer = null, captureElapsedMs = 0, compileElapsedMs = 0, captureCalls = 0, temporaryInstanceBytes = 0;
  const targets = [], materials = new Set(), assignments = new Map(), results = [];
  let complete = false;
  try {
    capture = makeCaptureScene(scene, sources, lightCount);
    temporaryInstanceBytes = capture.instances.reduce((sum, mesh) => sum + mesh.instanceMatrix.array.byteLength + (mesh.instanceColor?.array.byteLength ?? 0), 0);
    cubeTarget = factories.createTarget(SIZE); cubeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const camera = factories.createCamera(cubeTarget);
    camera.layers.set(0);
    pmrem = factories.createPMREM(renderer);
    renderer.autoClear = true; renderer.autoClearColor = true; renderer.autoClearDepth = true; renderer.autoClearStencil = true;
    renderer.setScissorTest(false); renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.shadowMap.enabled = true; renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    renderer.info.reset();
    let compiled = false;
    for (const { probe, receivers } of active) {
      const probeStart = now();
      prepareProbe(capture, probe, sources);
      camera.position.set(...probe.position); camera.updateMatrixWorld(true);
      if (camera.coordinateSystem !== renderer.coordinateSystem && camera.updateCoordinateSystem) {
        camera.coordinateSystem = renderer.coordinateSystem; camera.updateCoordinateSystem();
      }
      if (!compiled && renderer.compileAsync) {
        const compileStart = now();
        await renderer.compileAsync(capture.scene, camera.children[0]); compiled = true;
        compileElapsedMs += now() - compileStart;
      }
      renderer.shadowMap.needsUpdate = true;
      const callsBefore = renderer.info.render.calls;
      await factories.capture(renderer, camera, capture.scene);
      const target = pmrem.fromCubemap(cubeTarget.texture); targets.push(target);
      target.texture.name = `interior-reflection-${probe.id}`;
      const cache = new Map();
      const variant = source => {
        if (!source) return null;
        if (!cache.has(source)) { const copy = reflectedMaterial(source, target.texture); cache.set(source, copy); materials.add(copy); }
        return cache.get(source);
      };
      for (const { mesh, variants } of receivers) assignments.set(mesh, { plain: variant(variants.plain), baked: variant(variants.baked) });
      const calls = renderer.info.render.calls - callsBefore;
      captureCalls += calls;
      results.push({ id: probe.id, receivers: receivers.length, drawCalls: calls, elapsedMs: now() - probeStart,
        width: target.width, height: target.height, bytes: target.width * target.height * BYTES_PER_HDR_PIXEL });
      captureElapsedMs += now() - probeStart;
      await yieldTask();
    }
    layer = interiorLighting.attachReflectionMaterials(assignments);
    complete = true;
  } finally {
    pmrem?.dispose(); cubeTarget?.dispose();
    for (const key of capture?.keys ?? []) key.shadow.dispose();
    for (const instance of capture?.instances ?? []) instance.dispose();
    capture?.scene.clear();
    renderer.autoClear = saved.autoClear; renderer.autoClearColor = saved.autoClearColor;
    renderer.autoClearDepth = saved.autoClearDepth; renderer.autoClearStencil = saved.autoClearStencil;
    renderer.toneMapping = saved.toneMapping; renderer.toneMappingExposure = saved.exposure; renderer.outputColorSpace = saved.outputColorSpace;
    renderer.shadowMap.enabled = saved.shadowEnabled; renderer.shadowMap.autoUpdate = saved.shadowAutoUpdate;
    renderer.shadowMap.needsUpdate = saved.shadowNeedsUpdate;
    if (renderer.xr) renderer.xr.enabled = saved.xrEnabled;
    renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    renderer.setViewport(saved.viewport); renderer.setScissor(saved.scissor); renderer.setScissorTest(saved.scissorTest);
    renderer.setClearColor(saved.clearColor, saved.clearAlpha);
    renderer.info.autoReset = saved.infoAutoReset;
    // Three's geometry uploader uses info.render.frame as an internal upload
    // generation. Rewinding it can skip later instance-buffer updates.
    for (const [key, value] of Object.entries(saved.renderInfo)) if (key !== 'frame') renderer.info.render[key] = value;
    if (!complete) {
      layer?.dispose();
      for (const material of materials) material.dispose();
      for (const target of targets) target.dispose();
    }
  }
  const stats = {
    status: 'ready', captures: results.length, faces: results.length * 6, faceSize: SIZE,
    residentBytes: results.reduce((sum, result) => sum + result.bytes, 0),
    temporaryCubeBytes: SIZE * SIZE * 6 * (BYTES_PER_HDR_PIXEL + 4),
    temporaryInstanceBytes,
    shadowSize: SHADOW_SIZE, staticMeshes: sources.meshes.size, staticPracticalSources: sources.lights.size, lightBudget: lightCount,
    receivers: assignments.size, materialVariants: materials.size, captureDrawCalls: captureCalls,
    captureElapsedMs, compileElapsedMs, elapsedMs: now() - started, probes: results, perFrameCaptures: 0, addedDrawCalls: 0,
  };
  let enabled = true, disposed = false;
  return {
    snapshot: () => ({ ...stats, probes: results.map(result => ({ ...result })), enabled, status: disposed ? 'disposed' : stats.status }),
    setEnabled(value) { if (disposed) return; enabled = Boolean(value); layer.setEnabled(enabled); },
    dispose() {
      if (disposed) return;
      disposed = true; layer.dispose();
      for (const material of materials) material.dispose();
      for (const target of targets) target.dispose();
      assignments.clear(); materials.clear(); targets.length = 0;
    },
  };
}
