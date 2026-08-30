import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createInteriorLighting } from '../../src/render/interior-lighting.js';
import { createInteriorReflections } from '../../src/render/interior-reflections.js';

async function fixture({ failCapture = 0, failPMREM = 0, failCompile = false, supported = true } = {}) {
  const scene = new THREE.Scene(), world = new THREE.Group(); scene.add(world);
  scene.background = new THREE.Color(0x283944); scene.environment = new THREE.Texture(); scene.environmentIntensity = 0.8;
  scene.add(new THREE.AmbientLight(0xffffff, 0.45), new THREE.HemisphereLight(0xffffff, 0x454344, 1));
  const moon = new THREE.DirectionalLight(0xffffff, 1.6); moon.castShadow = true; scene.add(moon, moon.target);
  const base = new THREE.MeshStandardMaterial({ metalness: 0.8, roughness: 0.45, envMapIntensity: 0.4 });
  base.onBeforeCompile = shader => { shader.uniforms.authored = { value: 3 }; };
  base.customProgramCacheKey = () => 'authored-metal';
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), base); box.position.set(0, 0.5, 0); box.name = 'reflective-box'; world.add(box);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5, roughness: 0.1 }));
  glass.position.set(1, 0.5, 0); glass.name = 'interior-glass'; world.add(glass);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8), new THREE.MeshStandardMaterial({ roughness: 1 }));
  floor.position.y = -0.1; floor.name = 'floor'; world.add(floor);
  const outside = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), base); outside.position.set(6, 0.5, 0); outside.name = 'outside'; world.add(outside);
  const mixed = new THREE.Mesh(mergeGeometries([
    new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(2, 0.5, 0),
    new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(6, 0.5, 0),
  ]), base); mixed.name = 'mixed-indoor-outdoor'; world.add(mixed);
  const practical = new THREE.PointLight(0xffc080, 2, 8, 1.7); practical.position.set(0, 2, 0); practical.visible = false; practical.userData.zone = 'test'; world.add(practical);
  const actor = new THREE.Group(); actor.name = 'npc-rig'; actor.add(new THREE.Mesh(new THREE.BoxGeometry(), base)); world.add(actor);
  const fire = new THREE.Group(); fire.name = 'fire'; fire.add(new THREE.PointLight(0xff0000, 100, 12)); world.add(fire);
  const pickup = new THREE.Mesh(new THREE.SphereGeometry(0.1), base); pickup.name = 'late-pickup'; world.add(pickup);
  const viewmodel = new THREE.Mesh(new THREE.BoxGeometry(), base); viewmodel.name = 'viewmodel'; viewmodel.layers.set(1); scene.add(viewmodel);
  const environment = new THREE.Group(); environment.name = 'cinematic-environment'; world.add(environment);
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(), base, 2);
  instances.name = 'colored-static-instances'; instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(3, 0.5, 1));
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0.5, -1));
  instances.setColorAt(0, new THREE.Color(0xff0000)); instances.setColorAt(1, new THREE.Color(0x0000ff)); environment.add(instances);
  const dust = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()); dust.name = 'dust'; environment.add(dust);
  const zoneMeshes = { test: [box, glass, floor, outside, mixed, practical, actor, fire] };
  const room = { id: 'test', min: [-4, -0.01, -4], max: [4, 4, 4], ambient: 0.8, lights: [{ position: [0, 2, 0], color: 0xffc080, energy: 4, samples: 1 }] };
  const lighting = await createInteriorLighting(world, { zoneMeshes, rooms: [room] });
  const probes = [{ id: 'test-kitchen', zone: 'test', position: [1, 1.5, 1], min: [-3, 0, -3], max: [3, 3, 3], lights: ['test'] }];
  const lightBudget = { pool: Array.from({ length: 8 }, () => new THREE.PointLight()), update() { throw new Error('Live light budget must never be mutated.'); } };
  let renderTarget = { name: 'caller-target' }, face = 2, mip = 1;
  const viewport = new THREE.Vector4(4, 5, 800, 450), scissor = new THREE.Vector4(8, 9, 400, 225), color = new THREE.Color(0x235467);
  let scissorTest = true, clearAlpha = 0.35, captureCount = 0, pmremCount = 0;
  const resources = [], capturedScenes = [], capturedLights = [];
  const disposable = value => {
    const resource = { ...value, disposals: 0, dispose() { this.disposals++; } };
    resources.push(resource); return resource;
  };
  const renderer = {
    coordinateSystem: THREE.WebGLCoordinateSystem, xr: { enabled: true },
    autoClear: false, autoClearColor: false, autoClearDepth: false, autoClearStencil: false,
    toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.12, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, autoUpdate: true, needsUpdate: false },
    extensions: { has() { return supported; } },
    info: { autoReset: true, render: { calls: 37, triangles: 83, frame: 12 }, reset() { this.render.calls = 0; this.render.triangles = 0; } },
    getRenderTarget: () => renderTarget, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, nextFace = 0, nextMip = 0) { renderTarget = value; face = nextFace; mip = nextMip; },
    getViewport: out => out.copy(viewport), setViewport: value => viewport.copy(value),
    getScissor: out => out.copy(scissor), setScissor: value => scissor.copy(value),
    getScissorTest: () => scissorTest, setScissorTest: value => { scissorTest = value; },
    getClearColor: out => out.copy(color), getClearAlpha: () => clearAlpha,
    setClearColor(value, alpha = clearAlpha) { color.copy(value); clearAlpha = alpha; },
    async compileAsync(captureScene) {
      assert.equal(captureScene.children.filter(child => child.isPointLight).length, 8);
      if (failCompile) throw new Error('compile failed');
    },
  };
  const initial = () => ({ target: renderTarget, face, mip, viewport: viewport.toArray(), scissor: scissor.toArray(), scissorTest,
    color: color.getHex(), clearAlpha, xr: renderer.xr.enabled, autoClear: renderer.autoClear, autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth, autoClearStencil: renderer.autoClearStencil, toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure, outputColorSpace: renderer.outputColorSpace, shadow: { ...renderer.shadowMap },
    infoAutoReset: renderer.info.autoReset, info: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles } });
  const originalState = initial();
  const factories = {
    createTarget(size) { assert.equal(size, 64); return disposable({ kind: 'cube', width: size, height: size, texture: new THREE.Texture() }); },
    createCamera(target) { return new THREE.CubeCamera(0.06, 90, target); },
    createPMREM() {
      return disposable({ kind: 'pmrem', fromCubemap() {
        if (++pmremCount === failPMREM) throw new Error('PMREM failed');
        renderer.info.render.calls += 24; renderer.info.render.frame += 24;
        return disposable({ kind: 'probe', width: 336, height: 256, texture: new THREE.Texture() });
      } });
    },
    capture(activeRenderer, camera, captureScene) {
      capturedScenes.push([...captureScene.children]);
      capturedLights.push(captureScene.children.filter(child => child.isPointLight).map(light => ({ visible: light.visible, intensity: light.intensity, color: light.color.getHex() })));
      assert.equal(camera.layers.mask, 1);
      renderer.info.render.calls += 42; renderer.info.render.frame += 6;
      for (const child of captureScene.children) if (child.isInstancedMesh) {
        child.addEventListener('dispose', () => { child.userData.disposals = (child.userData.disposals ?? 0) + 1; });
      }
      renderer.setRenderTarget(camera.renderTarget, 5, 0); renderer.xr.enabled = false;
      renderer.setViewport(new THREE.Vector4(0, 0, 64, 64)); renderer.setScissor(new THREE.Vector4(0, 0, 64, 64));
      renderer.setClearColor(new THREE.Color(0x000000), 1);
      if (++captureCount === failCapture) throw new Error('capture failed');
    },
  };
  return { scene, world, base, box, glass, outside, mixed, practical, instances, lighting, resources, probes, zoneMeshes,
    renderer, originalState, state: initial, capturedScenes, capturedLights,
    create: options => createInteriorReflections(renderer, scene, world, { zoneMeshes, interiorLighting: lighting, lightBudget, probes, yieldTask: async () => {}, ...options }, factories) };
}

test('local probes capture only static world geometry with eight non-fire lights and preserve renderer/live state', async () => {
  const f = await fixture(), originalVisibility = f.practical.visible;
  const reflections = await f.create();
  assert.deepEqual(f.state(), f.originalState);
  assert.equal(f.practical.visible, originalVisibility); assert.equal(f.practical.intensity, 2);
  const children = f.capturedScenes[0], names = new Set(children.map(child => child.name));
  for (const absent of ['npc-rig', 'fire', 'late-pickup', 'viewmodel', 'dust']) assert.equal(names.has(absent), false, absent);
  for (const present of ['reflective-box', 'floor', 'outside', 'mixed-indoor-outdoor', 'colored-static-instances']) assert.equal(names.has(present), true, present);
  const instances = children.find(child => child.name === 'colored-static-instances');
  assert.notEqual(instances.instanceMatrix, f.instances.instanceMatrix); assert.notEqual(instances.instanceColor, f.instances.instanceColor);
  assert.deepEqual(instances.instanceMatrix.array, f.instances.instanceMatrix.array); assert.deepEqual(instances.instanceColor.array, f.instances.instanceColor.array);
  assert.equal(instances.geometry, f.instances.geometry);
  assert.equal(instances.userData.disposals, 1); assert.equal(f.instances.userData.disposals, undefined);
  assert.equal(f.renderer.info.render.frame, 42, 'capture/PMREM frames remain monotonic after public counters are restored');
  assert.equal(f.capturedLights[0].length, 8); assert.ok(f.capturedLights[0].every(light => light.visible));
  assert.equal(f.capturedLights[0][0].intensity, 3.6); assert.equal(f.capturedLights[0].filter(light => light.intensity > 0).length, 1);
  const stats = reflections.snapshot();
  assert.equal(stats.captures, 1); assert.equal(stats.faces, 6); assert.equal(stats.faceSize, 64);
  assert.equal(stats.residentBytes, 336 * 256 * 8); assert.equal(stats.perFrameCaptures, 0); assert.equal(stats.addedDrawCalls, 0);
  assert.equal(stats.receivers, 2); assert.equal(stats.captureDrawCalls, 66);
  assert.equal(f.resources.filter(resource => resource.kind !== 'probe').every(resource => resource.disposals === 1), true);
  reflections.dispose(); f.lighting.dispose();
});

test('reflection and baked-light toggles are independent, reuse resources and preserve authored shader hooks', async () => {
  const f = await fixture(), baked = f.box.material, geometry = f.box.geometry;
  const reflections = await f.create(), both = f.box.material, texture = both.envMap;
  assert.ok(both.lightMap); assert.ok(texture); assert.equal(f.box.geometry, geometry);
  const shader = { uniforms: {}, fragmentShader: '#include <lights_fragment_maps>' };
  both.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.authored.value, 3); assert.match(shader.fragmentShader, /irradiance \*= lightMapTexel\.a/);
  reflections.setEnabled(false); assert.equal(f.box.material, baked);
  f.lighting.setEnabled(false); assert.equal(f.box.material, f.base);
  reflections.setEnabled(true); assert.equal(f.box.material.envMap, texture); assert.equal(f.box.material.lightMap, null);
  f.lighting.setEnabled(true); assert.equal(f.box.material, both);
  assert.equal(f.box.geometry, geometry); assert.equal(f.outside.material, f.base); assert.equal(f.mixed.material.envMap, null);
  reflections.dispose(); reflections.dispose(); assert.equal(f.box.material, baked); assert.equal(f.glass.material.envMap, null);
  assert.equal(f.resources.filter(resource => resource.kind === 'probe').every(resource => resource.disposals === 1), true);
  f.lighting.dispose(); assert.equal(f.box.material, f.base);
});

test('disposing the bake first cannot resurrect disposed material layers', async () => {
  const f = await fixture(), reflections = await f.create();
  f.lighting.dispose();
  assert.equal(f.box.material, f.base); assert.equal(f.glass.material.envMap, null);
  reflections.setEnabled(false); reflections.setEnabled(true);
  assert.equal(f.box.material, f.base); assert.equal(f.glass.material.envMap, null);
  reflections.dispose();
});

test('capture, shader preparation and PMREM failures restore state and dispose every owned target without changing live materials', async () => {
  for (const failure of [{ failCapture: 1 }, { failCompile: true }, { failPMREM: 1 }]) {
    const f = await fixture(failure), material = f.box.material;
    await assert.rejects(f.create(), /failed/);
    assert.deepEqual(f.state(), f.originalState);
    assert.equal(f.box.material, material); assert.equal(f.glass.material.envMap, null);
    assert.ok(f.resources.every(resource => resource.disposals === 1));
    f.lighting.dispose();
  }
});

test('failure on a later room rolls back earlier probe targets before any material layer is installed', async () => {
  const f = await fixture({ failPMREM: 2 }), material = f.box.material;
  const second = { ...f.probes[0], id: 'second-probe' };
  await assert.rejects(f.create({ probes: [...f.probes, second] }), /PMREM failed/);
  assert.deepEqual(f.state(), f.originalState); assert.equal(f.box.material, material);
  assert.ok(f.resources.every(resource => resource.disposals === 1));
  f.lighting.dispose();
});

test('unsupported float targets and empty receiver sets allocate no GPU resources', async () => {
  const unsupported = await fixture({ supported: false }), first = await unsupported.create();
  assert.equal(first.snapshot().status, 'unsupported'); assert.equal(unsupported.resources.length, 0);
  first.dispose(); unsupported.lighting.dispose();
  const empty = await fixture();
  const second = await empty.create({ probes: [{ ...empty.probes[0], min: [20, 0, 20], max: [23, 3, 23] }] });
  assert.equal(second.snapshot().status, 'no-receivers'); assert.equal(empty.resources.length, 0);
  assert.deepEqual(empty.state(), empty.originalState);
  second.dispose(); empty.lighting.dispose();
});

test('more than three probes fail before resources or shared materials can change', async () => {
  const f = await fixture(), material = f.box.material;
  await assert.rejects(f.create({ probes: Array(4).fill(f.probes[0]) }), RangeError);
  assert.equal(f.resources.length, 0); assert.equal(f.box.material, material);
  f.lighting.dispose();
});
