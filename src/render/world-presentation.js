import {
  Color, DepthFormat, DepthTexture, HalfFloatType, LinearFilter,
  LinearSRGBColorSpace, UnsignedIntType, Vector2, WebGLRenderTarget,
} from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const AUTO = Object.freeze({
  blend: 0.55,
  ao: Object.freeze({ samples: 8, radius: 0.40, thickness: 0.18, distanceExponent: 1.2, distanceFallOff: 1, scale: 1, screenSpaceRadius: false }),
});
const HIGH = Object.freeze({
  blend: 0.62,
  ao: Object.freeze({ samples: 12, radius: 0.45, thickness: 0.20, distanceExponent: 1.2, distanceFallOff: 1, scale: 1, screenSpaceRadius: false }),
});
const DENOISE = Object.freeze({ samples: 8, radius: 3, rings: 2, radiusExponent: 2, lumaPhi: 10, depthPhi: 5, normalPhi: 4 });

const DEFAULT_FACTORIES = Object.freeze({
  createDepthTexture(width, height) { return new DepthTexture(width, height, UnsignedIntType); },
  createRenderTarget(width, height, options) { return new WebGLRenderTarget(width, height, options); },
  createGTAOPass(scene, camera, width, height) { return new GTAOPass(scene, camera, width, height); },
  createOutputPass() { return new OutputPass(); },
});

/**
 * Optional contact shading for the world layer, before the weapon overlay.
 * One scene draw supplies both HDR color and depth; every later draw is a
 * full-screen pass. OutputPass is the sole tone/color conversion for this path.
 *
 * References: https://threejs.org/docs/pages/GTAOPass.html
 *             https://threejs.org/docs/pages/OutputPass.html
 *
 * The fifth argument substitutes resource factories for CPU-only tests. No
 * render target, pass, or mutable presentation state is exposed to the game.
 */
export function createWorldPresentation(renderer, scene, camera, { getQuality = () => 'auto' } = {}, factories = DEFAULT_FACTORIES) {
  const drawingSize = new Vector2();
  const savedClearColor = new Color();
  let beauty = null, composite = null, depth = null, gtao = null, output = null;
  let width = 0, height = 0, aoWidth = 0, aoHeight = 0;
  let profile = null, quality = getQuality(), floatSupported = null;
  let enabled = false, disposed = false, reason = 'not-rendered';

  function release() {
    // r185.1's pass.dispose() omits these two shader materials. Dispose their
    // public resources explicitly, then let the pass release its own targets.
    gtao?.gtaoMaterial?.dispose();
    gtao?.blendMaterial?.dispose();
    gtao?.dispose();
    output?.dispose();
    if (beauty) beauty.dispose();
    else depth?.dispose(); // A factory failure may leave depth unattached.
    composite?.dispose();
    beauty = composite = depth = gtao = output = null;
    width = height = aoWidth = aoHeight = 0;
    profile = null;
    enabled = false;
  }

  function prepare(nextProfile) {
    renderer.getDrawingBufferSize(drawingSize);
    const nextWidth = Math.max(1, Math.floor(drawingSize.x));
    const nextHeight = Math.max(1, Math.floor(drawingSize.y));
    const nextAoWidth = Math.max(1, Math.ceil(nextWidth / 2));
    const nextAoHeight = Math.max(1, Math.ceil(nextHeight / 2));
    if (!beauty) {
      try {
        const samples = Math.min(2, Math.max(0, Math.floor(renderer.capabilities.maxSamples || 0)));
        depth = factories.createDepthTexture(nextWidth, nextHeight);
        depth.name = 'world-presentation-depth';
        depth.format = DepthFormat;
        beauty = factories.createRenderTarget(nextWidth, nextHeight, {
          type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
          generateMipmaps: false, depthBuffer: true, stencilBuffer: false,
          depthTexture: depth, resolveDepthBuffer: true, samples,
        });
        beauty.texture.name = 'world-presentation-beauty';
        beauty.texture.colorSpace = LinearSRGBColorSpace;
        composite = factories.createRenderTarget(nextWidth, nextHeight, {
          type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
          generateMipmaps: false, depthBuffer: false, stencilBuffer: false, samples: 0,
        });
        composite.texture.name = 'world-presentation-composite';
        composite.texture.colorSpace = LinearSRGBColorSpace;

        // Construct normally first. In r185.1, passing an external depth in
        // the constructor leaves normalRenderTarget missing in setGBuffer().
        // The public setter then selects depth-reconstructed normals and
        // disables the additional scene geometry pass.
        gtao = factories.createGTAOPass(scene, camera, nextAoWidth, nextAoHeight);
        gtao.setGBuffer(depth, undefined);
        gtao.output = GTAOPass.OUTPUT.Default;
        gtao.renderToScreen = false;
        gtao.updatePdMaterial(DENOISE);
        output = factories.createOutputPass();
        output.renderToScreen = true;
      } catch (error) {
        release();
        reason = 'allocation-error';
        throw error;
      }
    } else if (nextWidth !== width || nextHeight !== height) {
      beauty.setSize(nextWidth, nextHeight);
      composite.setSize(nextWidth, nextHeight);
      gtao.setSize(nextAoWidth, nextAoHeight);
    }
    width = nextWidth; height = nextHeight;
    aoWidth = nextAoWidth; aoHeight = nextAoHeight;
    if (profile !== nextProfile) {
      gtao.updateGtaoMaterial(nextProfile.ao);
      gtao.blendIntensity = nextProfile.blend;
      profile = nextProfile;
    }
  }

  function render() {
    enabled = false;
    quality = getQuality();
    if (disposed || (quality !== 'auto' && quality !== 'high')) {
      reason = disposed ? 'disposed' : 'quality-disabled';
      if (!disposed && beauty) release();
      renderer.render(scene, camera);
      return;
    }
    if (quality === 'auto' && renderer.getPixelRatio() < 1) {
      // Keep existing resources during adaptive resolution changes to avoid
      // repeated allocation/compilation when the budget crosses this boundary.
      reason = 'resolution-budget';
      renderer.render(scene, camera);
      return;
    }
    if (floatSupported === null) floatSupported = renderer.extensions.has('EXT_color_buffer_float');
    if (!floatSupported) {
      reason = 'unsupported-float-buffer';
      renderer.render(scene, camera);
      return;
    }
    prepare(quality === 'high' ? HIGH : AUTO);

    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    const clearColor = renderer.autoClearColor;
    const clearDepth = renderer.autoClearDepth;
    const clearStencil = renderer.autoClearStencil;
    const shadowUpdate = renderer.shadowMap.autoUpdate;
    const infoReset = renderer.info.autoReset;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(savedClearColor);
    try {
      if (infoReset) renderer.info.reset();
      renderer.info.autoReset = false;
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      renderer.autoClearStencil = false;
      renderer.setRenderTarget(beauty);
      renderer.render(scene, camera);

      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false;
      gtao.render(renderer, composite, beauty);
      // The canvas must start with fresh depth even when the caller disabled
      // auto-clear. Its next draw is the separately depth-tested weapon layer.
      renderer.autoClear = true;
      output.render(renderer, null, composite);
      enabled = true;
      reason = 'active';
    } catch (error) {
      reason = 'render-error';
      throw error;
    } finally {
      renderer.setClearColor(savedClearColor, clearAlpha);
      renderer.autoClear = autoClear;
      renderer.autoClearColor = clearColor;
      renderer.autoClearDepth = clearDepth;
      renderer.autoClearStencil = clearStencil;
      renderer.shadowMap.autoUpdate = shadowUpdate;
      renderer.info.autoReset = infoReset;
      renderer.setRenderTarget(target, cubeFace, mipLevel);
    }
  }

  function snapshot() {
    return {
      enabled, reason, quality, allocated: beauty !== null, disposed,
      size: { width, height }, aoSize: { width: aoWidth, height: aoHeight },
      aoSamples: enabled ? profile.ao.samples : 0,
      denoiseSamples: enabled ? DENOISE.samples : 0,
      msaaSamples: beauty?.samples ?? 0,
      worldPasses: 1, postPasses: enabled ? 5 : 0,
    };
  }

  function dispose() {
    if (disposed) return;
    release();
    disposed = true;
    reason = 'disposed';
  }

  return { render, snapshot, dispose };
}
