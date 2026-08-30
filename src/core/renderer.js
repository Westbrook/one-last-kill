import * as THREE from 'three';
import { Settings } from './settings.js';
import { FrameBudget } from './frame-budget.js';

export const canvas = document.getElementById('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (error) {
  const status = document.getElementById('loadstatus');
  if (status) status.textContent = 'WebGL 2 is unavailable. Enable hardware acceleration or try a supported desktop browser.';
  document.body.classList.add('boot-failed');
  throw error;
}
export { renderer };

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.type = THREE.PCFShadowMap;

export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x444f55, 0.011);
export const camera = new THREE.PerspectiveCamera(Settings.get('fov'), innerWidth / innerHeight, 0.05, 300);
export const GameTime = { elapsed: 0 };

const frameBudget = new FrameBudget();
export function configureRenderer() {
  const quality = Settings.get('quality');
  // Spend the reviewed extra sampling on smaller high-DPI viewports. Do not
  // increase large-window allocations beyond their previous 1.6× ceiling:
  // only the additional headroom is limited to a four-megapixel buffer.
  const highScale = Math.min(2, Math.max(1.6, Math.sqrt(4 * 1024 * 1024 / Math.max(1, innerWidth * innerHeight))));
  const ratio = quality === 'high' ? highScale : quality === 'performance' ? 0.85 : frameBudget.scale;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, ratio));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = quality !== 'performance';
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

export function recordRenderTime(dt) {
  if (Settings.get('quality') !== 'auto') return;
  const next = frameBudget.sample(dt);
  if (next !== null) configureRenderer();
}

configureRenderer();
addEventListener('resize', configureRenderer);
document.addEventListener('settingschange', configureRenderer);
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  document.dispatchEvent(new CustomEvent('game:contextlost'));
});
