import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { FrameBudget } from '../../src/core/frame-budget.js';

const source = readFileSync(new URL('../../src/core/renderer.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace(/^export \{[^}]+\};\s*$/gm, '')
  .replace(/^export /gm, '');
assert.doesNotMatch(source, /^import\s|^export\s/m);

function harness({ width = 1000, height = 600, dpr = 2 } = {}) {
  const viewport = { width, height }, settings = { quality: 'auto', fov: 82 };
  const windowListeners = new Map(), documentListeners = new Map();
  const bufferWrites = [], drawingBuffer = { width: 300, height: 150 };
  const canvas = { getBoundingClientRect: () => viewport, addEventListener() {} };
  for (const dimension of ['width', 'height']) Object.defineProperty(canvas, dimension, {
    get() { return drawingBuffer[dimension]; },
    set(value) { drawingBuffer[dimension] = value; bufferWrites.push({ dimension, value }); },
  });
  class Renderer {
    constructor() { this.domElement = canvas; this.shadowMap = {}; this.ratio = 1; this.width = 300; this.height = 150; }
    getPixelRatio() { return this.ratio; }
    // Match Three's resize behavior: assigning dimensions resets the drawing
    // buffer even when their values are unchanged. setPixelRatio resizes too.
    setPixelRatio(value) { this.ratio = value; this.setSize(this.width, this.height, false); }
    setSize(w, h) {
      this.width = w; this.height = h;
      canvas.width = Math.floor(w * this.ratio); canvas.height = Math.floor(h * this.ratio);
    }
    setDrawingBufferSize(w, h, ratio) { this.ratio = ratio; this.setSize(w, h, false); }
  }
  let resizeObserved;
  const context = {
    THREE: { ...THREE, WebGLRenderer: Renderer }, FrameBudget,
    Settings: { get: key => settings[key] }, devicePixelRatio: dpr,
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    document: {
      getElementById: id => id === 'game' ? canvas : null,
      addEventListener: (type, listener) => documentListeners.set(type, listener),
    },
    ResizeObserver: class {
      constructor(callback) { resizeObserved = callback; }
      observe() {}
    },
  };
  const api = runInNewContext(`${source}\n;({ renderer, camera, renderQuality, configureRenderer, recordRenderTime, renderBudgetSnapshot });`, context,
    { filename: 'renderer.js' });
  return {
    ...api, canvas, viewport, bufferWrites, settings,
    setDpr(value) { context.devicePixelRatio = value; windowListeners.get('resize')(); },
    resize(w, h) { viewport.width = w; viewport.height = h; resizeObserved(); },
    setQuality(value) { settings.quality = value; documentListeners.get('settingschange')(); },
  };
}

function frames(h, count, dt, timings) {
  for (let i = 0; i < count; i++) h.recordRenderTime(dt, timings);
}

test('CPU presentation reductions leave the canvas buffer resident', () => {
  const h = harness();
  assert.equal(h.bufferWrites.length, 2, 'boot assigns each buffer dimension once');
  const writes = h.bufferWrites.length;
  frames(h, 130, 0.02, { cpuMs: 18, simulationMs: 12, renderMs: 6, gpuMs: 4 });
  assert.equal(h.renderQuality.tier, 1);
  assert.equal(h.renderer.getPixelRatio(), 1.2);
  frames(h, 250, 0.02, { cpuMs: 18, simulationMs: 12, renderMs: 6, gpuMs: 4 });
  assert.equal(h.renderQuality.tier, 2);
  assert.equal(h.bufferWrites.length, writes, 'changing cosmetic tiers cannot clear or resize the drawing buffer');
});

test('DPR-capped quality recovery and unchanged settings do not resize the buffer', () => {
  const h = harness({ dpr: 1 });
  const writes = h.bufferWrites.length;
  frames(h, 1000, 1 / 120, { cpuMs: 3, simulationMs: 1, renderMs: 2, gpuMs: 4 });
  assert.ok(h.renderBudgetSnapshot().scale > 1.2, 'automatic quality recovers behind the DPR cap');
  assert.equal(h.renderer.getPixelRatio(), 1);
  h.configureRenderer();
  h.setQuality('high');
  assert.equal(h.renderQuality.tier, 0);
  assert.equal(h.bufferWrites.length, writes, 'unchanged effective resolution is preserved across preset changes');
});

test('viewport, DPR and adaptive scale changes each resize once to the final dimensions', () => {
  const h = harness();
  const verifyResize = (action, expectedWidth, expectedHeight, ratio) => {
    const before = h.bufferWrites.length;
    action();
    assert.equal(h.bufferWrites.length - before, 2, 'only one width/height assignment per configuration');
    assert.equal(h.canvas.width, expectedWidth); assert.equal(h.canvas.height, expectedHeight);
    assert.equal(h.renderer.getPixelRatio(), ratio);
    assert.equal(h.camera.aspect, h.viewport.width / h.viewport.height);
  };
  verifyResize(() => h.resize(800, 500), 960, 600, 1.2);
  verifyResize(() => h.setDpr(1), 800, 500, 1);
  verifyResize(() => { h.viewport.width = 700; h.viewport.height = 400; h.setDpr(2); }, 840, 480, 1.2);
  verifyResize(() => frames(h, 130, 0.02, { cpuMs: 3, gpuMs: 18 }), 770, 440, 1.1);
  const writes = h.bufferWrites.length;
  h.resize(700, 400);
  assert.equal(h.bufferWrites.length, writes, 'unchanged resize observations cannot reset the buffer');
});
