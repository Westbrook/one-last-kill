import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACESFilmicToneMapping, Color, DepthTexture, HalfFloatType, LinearSRGBColorSpace,
  PerspectiveCamera, Scene, SRGBColorSpace, UnsignedIntType, Vector2, WebGLRenderTarget,
} from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createWorldPresentation } from '../../src/render/world-presentation.js';

function fixture({ quality = 'auto', ratio = 1.3, maxSamples = 4, supported = true, failAtDraw = 0, failFactory = '' } = {}) {
  const scene = new Scene(), camera = new PerspectiveCamera(82, 16 / 9, 0.05, 300);
  scene.background = new Color(0x2b3b41);
  const state = { quality, ratio, width: 1600, height: 900, failAtDraw };
  const calls = [], targets = [], depths = [], aoPasses = [], outputPasses = [], sizeArguments = [];
  const originalTarget = { name: 'caller-target' };
  const clearColor = new Color(0x456789);
  let target = originalTarget, cubeFace = 3, mipLevel = 2, clearAlpha = 0.35, draws = 0;
  const renderer = {
    autoClear: false, autoClearColor: false, autoClearDepth: false, autoClearStencil: true,
    toneMapping: ACESFilmicToneMapping, outputColorSpace: SRGBColorSpace, toneMappingExposure: 1.12,
    shadowMap: { autoUpdate: true },
    capabilities: { maxSamples },
    extensions: { has(name) { assert.equal(name, 'EXT_color_buffer_float'); return supported; } },
    info: {
      autoReset: true, render: { calls: 23 }, resets: 0,
      reset() { this.resets++; this.render.calls = 0; },
    },
    getPixelRatio() { return state.ratio; },
    getDrawingBufferSize(out) { sizeArguments.push(out); return out.set(state.width, state.height); },
    getRenderTarget() { return target; },
    getActiveCubeFace() { return cubeFace; },
    getActiveMipmapLevel() { return mipLevel; },
    setRenderTarget(next, face = 0, level = 0) { target = next; cubeFace = face; mipLevel = level; },
    getClearColor(out) { return out.copy(clearColor); },
    getClearAlpha() { return clearAlpha; },
    setClearColor(value, alpha) { clearColor.set(value); if (alpha !== undefined) clearAlpha = alpha; },
    setClearAlpha(value) { clearAlpha = value; },
    clear() { calls.push({ clear: true, target }); },
    render(object, usedCamera) {
      if (this.info.autoReset) this.info.reset();
      const world = object === scene;
      this.info.render.calls += world ? 686 : 1;
      calls.push({ world, object, camera: usedCamera, target, autoClear: this.autoClear, shadowUpdate: this.shadowMap.autoUpdate });
      if (++draws === state.failAtDraw) throw new Error('draw interrupted');
    },
  };
  const disposable = () => ({ disposals: 0, dispose() { this.disposals++; } });
  const quad = { name: 'fullscreen' }, quadCamera = { name: 'fullscreen-camera' };
  const factories = {
    createDepthTexture(width, height) {
      const result = { ...disposable(), image: { width, height }, type: UnsignedIntType };
      depths.push(result);
      return result;
    },
    createRenderTarget(width, height, options) {
      const name = targets.length === 0 ? 'beauty' : 'composite';
      if (failFactory === name) throw new Error(`${name} allocation interrupted`);
      const result = {
        ...disposable(), width, height, options, samples: options.samples,
        texture: {}, depthTexture: options.depthTexture ?? null, resizes: [],
        setSize(w, h) { this.width = w; this.height = h; this.resizes.push([w, h]); },
        dispose() { this.disposals++; this.depthTexture?.dispose(); },
      };
      targets.push(result);
      return result;
    },
    createGTAOPass(...args) {
      assert.equal(args.length, 4, 'construct normally before attaching external depth');
      if (failFactory === 'gtao') throw new Error('gtao allocation interrupted');
      const result = {
        ...disposable(), width: args[2], height: args[3], bindings: [], configs: [], resizes: [],
        gtaoMaterial: disposable(), blendMaterial: disposable(),
        setGBuffer(depth, normal) { this.bindings.push({ depth, normal }); },
        updateGtaoMaterial(config) { this.configs.push(config); },
        updatePdMaterial(config) { this.denoise = config; },
        setSize(w, h) { this.width = w; this.height = h; this.resizes.push([w, h]); },
        render(activeRenderer, writeBuffer, readBuffer) {
          assert.equal(readBuffer.depthTexture, this.bindings[0].depth);
          assert.equal(this.bindings[0].normal, undefined);
          assert.equal(this.renderToScreen, false);
          assert.equal(this.output, GTAOPass.OUTPUT.Default);
          activeRenderer.setClearColor(0xffffff, 1);
          activeRenderer.autoClear = false;
          activeRenderer.setRenderTarget(writeBuffer);
          for (let pass = 0; pass < 4; pass++) activeRenderer.render(quad, quadCamera);
        },
      };
      aoPasses.push(result);
      return result;
    },
    createOutputPass() {
      if (failFactory === 'output') throw new Error('output allocation interrupted');
      const result = {
        ...disposable(),
        render(activeRenderer, writeBuffer, readBuffer) {
          assert.equal(this.renderToScreen, true);
          assert.equal(writeBuffer, null);
          assert.equal(readBuffer.texture.name, 'world-presentation-composite');
          activeRenderer.setRenderTarget(null);
          activeRenderer.render(quad, quadCamera);
        },
      };
      outputPasses.push(result);
      return result;
    },
  };
  const presentation = createWorldPresentation(renderer, scene, camera, { getQuality: () => state.quality }, factories);
  return { renderer, scene, camera, presentation, factories, state, calls, targets, depths, aoPasses, outputPasses, originalTarget, sizeArguments };
}

function assertRestored(f) {
  assert.equal(f.renderer.getRenderTarget(), f.originalTarget);
  assert.equal(f.renderer.getActiveCubeFace(), 3);
  assert.equal(f.renderer.getActiveMipmapLevel(), 2);
  assert.equal(f.renderer.autoClear, false);
  assert.equal(f.renderer.autoClearColor, false);
  assert.equal(f.renderer.autoClearDepth, false);
  assert.equal(f.renderer.autoClearStencil, true);
  assert.equal(f.renderer.shadowMap.autoUpdate, true);
  assert.equal(f.renderer.info.autoReset, true);
  assert.equal(f.renderer.getClearColor(new Color()).getHex(), 0x456789);
  assert.equal(f.renderer.getClearAlpha(), 0.35);
  assert.equal(f.renderer.toneMapping, ACESFilmicToneMapping);
  assert.equal(f.renderer.outputColorSpace, SRGBColorSpace);
  assert.equal(f.renderer.toneMappingExposure, 1.12);
}

test('performance and low adaptive resolution draw directly without allocating effects', () => {
  for (const options of [{ quality: 'performance' }, { quality: 'auto', ratio: 0.95 }, { quality: 'invalid' }]) {
    const f = fixture(options);
    for (let frame = 0; frame < 3; frame++) f.presentation.render();
    assert.equal(f.targets.length + f.aoPasses.length + f.outputPasses.length + f.depths.length, 0);
    assert.equal(f.calls.filter(call => call.world).length, 3);
    assert.equal(f.presentation.snapshot().enabled, false);
    assert.equal(f.presentation.snapshot().allocated, false);
    assertRestored(f);
  }
});

test('unsupported HDR attachments bypass the optional effect safely', () => {
  const f = fixture({ supported: false });
  f.presentation.render();
  assert.equal(f.presentation.snapshot().reason, 'unsupported-float-buffer');
  assert.equal(f.targets.length, 0);
  assert.equal(f.calls.filter(call => call.world).length, 1);
  assertRestored(f);
});

test('one HDR scene draw supplies depth to half-resolution AO and one output conversion', () => {
  const f = fixture();
  const background = f.scene.background, mask = f.camera.layers.mask;
  f.presentation.render();
  const draws = f.calls.filter(call => 'world' in call);
  assert.equal(draws.length, 6);
  assert.equal(draws.filter(call => call.world).length, 1);
  assert.equal(draws[0].target, f.targets[0]);
  assert.equal(draws[0].shadowUpdate, true);
  assert.ok(draws.slice(1).every(call => call.shadowUpdate === false));
  assert.equal(draws.at(-1).target, null);
  assert.equal(draws.at(-1).autoClear, true, 'old weapon depth cannot occlude the output quad');
  assert.equal(f.renderer.info.render.calls, 691);
  assert.equal(f.renderer.info.resets, 1);
  assert.equal(f.scene.background, background);
  assert.equal(f.camera.layers.mask, mask);
  assert.equal(f.targets[0].options.type, HalfFloatType);
  assert.equal(f.targets[0].texture.colorSpace, LinearSRGBColorSpace);
  assert.equal(f.targets[0].options.resolveDepthBuffer, true);
  assert.equal(f.targets[0].samples, 2);
  assert.equal(f.targets[1].samples, 0, 'full-screen composition retains resolved geometry AA');
  assert.equal(f.targets[1].options.depthBuffer, false);
  assert.deepEqual(f.presentation.snapshot(), {
    enabled: true, reason: 'active', quality: 'auto', allocated: true, disposed: false,
    size: { width: 1600, height: 900 }, aoSize: { width: 800, height: 450 },
    aoSamples: 8, denoiseSamples: 8, msaaSamples: 2, worldPasses: 1, postPasses: 5,
  });
  assertRestored(f);
});

test('repeated frames reuse all targets, passes, parameter objects and scratch dimensions', () => {
  const f = fixture();
  for (let frame = 0; frame < 5; frame++) f.presentation.render();
  assert.equal(f.targets.length, 2);
  assert.equal(f.depths.length, 1);
  assert.equal(f.aoPasses.length, 1);
  assert.equal(f.outputPasses.length, 1);
  assert.equal(f.aoPasses[0].configs.length, 1);
  assert.equal(f.aoPasses[0].bindings.length, 1);
  assert.equal(f.targets[0].resizes.length, 0);
  assert.equal(f.aoPasses[0].resizes.length, 0);
  assert.ok(f.sizeArguments.every(value => value === f.sizeArguments[0]));
});

test('physical drawing-buffer changes resize existing targets only once', () => {
  const f = fixture();
  f.presentation.render();
  f.state.width = 1919; f.state.height = 1079;
  f.presentation.render();
  f.presentation.render();
  assert.deepEqual(f.targets[0].resizes, [[1919, 1079]]);
  assert.deepEqual(f.targets[1].resizes, [[1919, 1079]]);
  assert.deepEqual(f.aoPasses[0].resizes, [[960, 540]]);
  assert.deepEqual(f.presentation.snapshot().size, { width: 1919, height: 1079 });
  assert.deepEqual(f.presentation.snapshot().aoSize, { width: 960, height: 540 });
  assert.equal(f.targets.length, 2);
});

test('high quality keeps contact shading restrained and respects the hardware MSAA cap', () => {
  const f = fixture({ quality: 'high', ratio: 0.8, maxSamples: 1 });
  f.presentation.render();
  const ao = f.aoPasses[0];
  assert.equal(ao.configs[0].samples, 12);
  assert.ok(ao.configs[0].radius >= 0.35 && ao.configs[0].radius <= 0.5);
  assert.equal(ao.configs[0].screenSpaceRadius, false);
  assert.ok(ao.configs[0].thickness <= 0.2);
  assert.ok(ao.blendIntensity >= 0.5 && ao.blendIntensity <= 0.65);
  assert.equal(ao.denoise.samples, 8);
  assert.equal(f.presentation.snapshot().msaaSamples, 1);
  f.state.quality = 'auto'; f.state.ratio = 1.3;
  f.presentation.render();
  assert.equal(f.aoPasses.length, 1);
  assert.equal(ao.configs.at(-1).samples, 8);
  assert.equal(f.presentation.snapshot().aoSamples, 8);
});

test('high detail allocates four-sample edges and quality switches release old attachments', () => {
  const f = fixture({ maxSamples: 4 });
  f.presentation.render();
  const previousBeauty = f.targets[0], previousComposite = f.targets[1], previousAO = f.aoPasses[0];
  f.state.quality = 'high';
  f.presentation.render();
  assert.equal(f.presentation.snapshot().msaaSamples, 4);
  assert.equal(previousBeauty.disposals, 1);
  assert.equal(previousComposite.disposals, 1);
  assert.equal(previousAO.disposals, 1);
  assert.equal(f.targets[2].depthTexture, f.depths[1], 'new AA allocation supplies its own resolved depth to AO');
  assert.equal(f.aoPasses[1].bindings[0].depth, f.depths[1]);
  f.presentation.render();
  assert.equal(f.targets.length, 4, 'steady High frames reuse their four-sample targets');
  f.state.quality = 'auto';
  f.presentation.render();
  assert.equal(f.presentation.snapshot().msaaSamples, 2);
  assert.equal(f.targets[2].disposals, 1);
  assertRestored(f);
});

test('adaptive bypass retains buffers but explicit performance mode releases them', () => {
  const f = fixture();
  f.presentation.render();
  f.state.ratio = 0.85;
  f.presentation.render();
  assert.equal(f.presentation.snapshot().reason, 'resolution-budget');
  assert.equal(f.presentation.snapshot().allocated, true);
  f.state.ratio = 1.1;
  f.presentation.render();
  assert.equal(f.targets.length, 2);
  f.state.quality = 'performance';
  f.presentation.render();
  assert.equal(f.presentation.snapshot().allocated, false);
  assert.ok([...f.targets, ...f.depths, ...f.aoPasses, ...f.outputPasses].every(resource => resource.disposals === 1));
  assert.equal(f.aoPasses[0].gtaoMaterial.disposals, 1);
  assert.equal(f.aoPasses[0].blendMaterial.disposals, 1);
});

test('statistics accumulate into an outer world-and-weapon renderer without another reset', () => {
  const f = fixture();
  f.renderer.info.autoReset = false;
  f.renderer.info.render.calls = 40;
  f.presentation.render();
  assert.equal(f.renderer.info.render.calls, 731);
  assert.equal(f.renderer.info.resets, 0);
  assert.equal(f.renderer.info.autoReset, false);
});

test('every interrupted draw restores caller state without a second world draw', () => {
  for (let failAtDraw = 1; failAtDraw <= 6; failAtDraw++) {
    const f = fixture({ failAtDraw });
    assert.throws(() => f.presentation.render(), /draw interrupted/);
    assertRestored(f);
    assert.equal(f.calls.filter(call => call.world).length, 1);
    assert.equal(f.presentation.snapshot().reason, 'render-error');
    assert.equal(f.presentation.snapshot().enabled, false);
    f.state.failAtDraw = 0;
    f.presentation.render();
    assert.equal(f.presentation.snapshot().enabled, true);
    assert.equal(f.targets.length, 2);
  }
});

test('partial initialization failures release resources already created', () => {
  for (const failFactory of ['beauty', 'composite', 'gtao', 'output']) {
    const f = fixture({ failFactory });
    assert.throws(() => f.presentation.render(), /allocation interrupted/);
    assert.ok([...f.targets, ...f.depths, ...f.aoPasses, ...f.outputPasses].every(resource => resource.disposals === 1), failFactory);
    assert.equal(f.presentation.snapshot().allocated, false);
    assert.equal(f.presentation.snapshot().reason, 'allocation-error');
    assertRestored(f);
  }
});

test('disposal is idempotent and cannot resurrect a pass on later renders', () => {
  const f = fixture();
  f.presentation.render();
  f.presentation.dispose();
  f.presentation.dispose();
  f.presentation.render();
  assert.ok([...f.targets, ...f.depths, ...f.aoPasses, ...f.outputPasses].every(resource => resource.disposals === 1));
  assert.equal(f.targets.length, 2);
  assert.equal(f.presentation.snapshot().disposed, true);
  assert.equal(f.presentation.snapshot().enabled, false);
  assert.equal(f.presentation.snapshot().reason, 'disposed');
});

test('pinned Three.js passes use beauty depth, never redraw world normals, and apply output once', () => {
  const f = fixture();
  const actual = { gtao: null, output: null };
  let aoMaterialDisposals = 0, blendMaterialDisposals = 0;
  const presentation = createWorldPresentation(f.renderer, f.scene, f.camera, { getQuality: () => 'auto' }, {
    createDepthTexture(w, h) { return new DepthTexture(w, h, UnsignedIntType); },
    createRenderTarget(w, h, options) { return new WebGLRenderTarget(w, h, options); },
    createGTAOPass(scene, camera, w, h) {
      const pass = new GTAOPass(scene, camera, w, h);
      pass.gtaoMaterial.addEventListener('dispose', () => aoMaterialDisposals++);
      pass.blendMaterial.addEventListener('dispose', () => blendMaterialDisposals++);
      actual.gtao = pass;
      return pass;
    },
    createOutputPass() { actual.output = new OutputPass(); return actual.output; },
  });
  presentation.render();
  const draws = f.calls.filter(call => 'world' in call);
  assert.equal(draws.length, 6);
  assert.equal(draws.filter(call => call.world).length, 1);
  assert.equal(actual.gtao.gtaoMaterial.defines.NORMAL_VECTOR_TYPE, 0);
  assert.equal(actual.gtao.pdMaterial.defines.NORMAL_VECTOR_TYPE, 0);
  assert.equal(actual.gtao.gtaoMaterial.uniforms.tDepth.value, draws[0].target.depthTexture);
  assert.equal(actual.gtao.pdMaterial.uniforms.tDepth.value, draws[0].target.depthTexture);
  assert.equal(actual.gtao.gtaoMaterial.defines.SAMPLES, 8);
  assert.equal(actual.gtao.pdMaterial.defines.SAMPLES, 8);
  assert.deepEqual(actual.gtao.gtaoMaterial.uniforms.resolution.value, new Vector2(800, 450));
  assert.ok('ACES_FILMIC_TONE_MAPPING' in actual.output.material.defines);
  assert.ok('SRGB_TRANSFER' in actual.output.material.defines);
  assert.equal(actual.output.uniforms.toneMappingExposure.value, 1.12);
  assertRestored(f);
  presentation.dispose();
  assert.equal(aoMaterialDisposals, 1);
  assert.equal(blendMaterialDisposals, 1);
});
