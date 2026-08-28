import * as THREE from 'three';
import { TAU, clamp, mulberry32, makeValueNoise, fBm } from '../core/math.js';
import { renderer } from '../core/renderer.js';
import { SURFACE_METERS, SURFACE_SPECS, bakeSurfaceData, deriveSurfaceData } from './surface-detail.js';

// ─── 2. CANVAS / TEXTURE HELPERS ─────────────────────────────────────────────
const TEX_SIZE = 512;
function makeCanvas(size = TEX_SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
function makeRectCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function canvasToTexture(c, { repeat = 1, color = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
// Sobel-style normal map derived from a grayscale "height" canvas.
function heightToNormalCanvas(heightCanvas, strength = 2.0) {
  const w = heightCanvas.width, h = heightCanvas.height;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = makeCanvas(w);
  const dctx = out.getContext('2d');
  const img = dctx.createImageData(w, h);
  const data = img.data;
  const lum = (i) => src[i] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w;
      const yu = (y - 1 + h) % h, yd = (y + 1) % h;
      const tl = lum((yu * w + xl) * 4), tr = lum((yu * w + xr) * 4);
      const bl = lum((yd * w + xl) * 4), br = lum((yd * w + xr) * 4);
      const l = lum((y * w + xl) * 4), r = lum((y * w + xr) * 4);
      const u = lum((yu * w + x) * 4), d = lum((yd * w + x) * 4);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * d + br) - (tl + 2 * u + tr);
      const nx = -dx * strength, ny = -dy * strength, nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      data[i]     = ((nx * inv) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny * inv) * 0.5 + 0.5) * 255;
      data[i + 2] = ((nz * inv) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  dctx.putImageData(img, 0, 0);
  return out;
}
function fillNoiseCanvas(canvas, sampleFn, { octaves = 5, scale = 8, contrast = 1, bias = 0 } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = fBm(sampleFn, x / w * scale, y / h * scale, octaves);
      const v = clamp(((n - 0.5) * contrast + 0.5) + bias, 0, 1) * 255;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ─── 3. PROCEDURAL TEXTURES & MATERIALS ──────────────────────────────────────
const MATS = {};
function defineMat(name, builder) {
  Object.defineProperty(MATS, name, {
    configurable: true,
    get() {
      const material = builder();
      material.name = `surface-${name}`;
      material.userData.surfaceMeters = SURFACE_METERS[name] ?? 1;
      material.userData.surfaceKind = name;
      // World UVs carry the physical scale. Keep every PBR channel aligned,
      // including legacy canvas fallbacks and instanced object-space props.
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'bumpMap']) {
        const texture = material[key];
        if (!texture) continue;
        texture.repeat.set(1, 1);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
      Object.defineProperty(MATS, name, { value: material, writable: false });
      return material;
    },
  });
}

function surfaceTexture(data, width, height, color = false) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = true;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  return texture;
}

function makeSurfaceMaterial(kind) {
  const spec = SURFACE_SPECS[kind];
  const data = bakeSurfaceData(kind);
  const orm = surfaceTexture(data.orm, data.width, data.height);
  const material = new THREE.MeshStandardMaterial({
    map: surfaceTexture(data.albedo, data.width, data.height, true),
    normalMap: surfaceTexture(data.normal, data.width, data.height),
    normalScale: new THREE.Vector2(spec.normalScale, spec.normalScale),
    roughnessMap: orm, roughness: 1,
    metalnessMap: spec.metallic ? orm : null, metalness: spec.metallic ? 1 : 0,
    envMapIntensity: spec.metallic ? 0.42 : kind === 'rubber' ? 0.1 : 0.22,
  });
  material.userData.staticSurfaceMaps = true;
  material.userData.textureBytes = data.width * data.height * 4 * 3;
  return material;
}

defineMat('plaster', () => {
  const c = makeCanvas(); const ctx = c.getContext('2d');
  const rng = mulberry32(1001);
  ctx.fillStyle = '#d8cdb8'; ctx.fillRect(0, 0, c.width, c.height);
  const noise = makeCanvas(); fillNoiseCanvas(noise, makeValueNoise(1011), { octaves: 6, scale: 12, contrast: 0.7 });
  ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(noise, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 8; i++) {
    const x = rng() * c.width, y = rng() * c.height, r = 60 + rng() * 180;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(105,70,40,${0.18 + rng() * 0.2})`);
    g.addColorStop(1, 'rgba(105,70,40,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(40,28,18,0.6)';
  for (let i = 0; i < 14; i++) {
    let x = rng() * c.width, y = rng() * c.height;
    ctx.lineWidth = 0.6 + rng() * 0.8;
    ctx.beginPath(); ctx.moveTo(x, y);
    const segs = 6 + ((rng() * 8) | 0); let ang = rng() * TAU;
    for (let s = 0; s < segs; s++) { ang += (rng() - 0.5) * 1.4; x += Math.cos(ang) * 10; y += Math.sin(ang) * 10; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // Water-stain streaks dripping from random upper points — sells the lived-in
  // tenement look. Soft dark vertical gradients, no extra draw cost beyond init.
  for (let i = 0; i < 6; i++) {
    const sx = rng() * c.width, top = rng() * c.height * 0.35;
    const sw = 18 + rng() * 36, sh = 60 + rng() * 180;
    const sg = ctx.createLinearGradient(sx, top, sx, top + sh);
    sg.addColorStop(0, `rgba(58,44,28,${0.06 + rng() * 0.08})`);
    sg.addColorStop(0.4, `rgba(58,44,28,${0.16 + rng() * 0.12})`);
    sg.addColorStop(1, 'rgba(58,44,28,0)');
    ctx.fillStyle = sg; ctx.fillRect(sx - sw / 2, top, sw, sh);
  }
  // Paint-chip flecks — tiny lighter/darker dots scattered for edge-wear feel.
  for (let i = 0; i < 220; i++) {
    const cx = (rng() * c.width) | 0, cy = (rng() * c.height) | 0;
    const v = rng() < 0.5 ? 230 : 110;
    ctx.fillStyle = `rgba(${v},${v - 20},${v - 40},${0.25 + rng() * 0.3})`;
    ctx.fillRect(cx, cy, 1 + ((rng() * 2) | 0), 1 + ((rng() * 2) | 0));
  }
  const hc = makeCanvas(); fillNoiseCanvas(hc, makeValueNoise(1012), { octaves: 5, scale: 14, contrast: 1.4 });
  // A dry fallback stays matte. Generated albedo gets its own coordinated
  // surface maps below; unrelated height noise must not make paint glossy.
  return new THREE.MeshStandardMaterial({
    map: canvasToTexture(c, { repeat: 2 }),
    normalMap: canvasToTexture(heightToNormalCanvas(hc, 1.9), { repeat: 2, color: false }),
    normalScale: new THREE.Vector2(0.18, 0.18),
    roughness: 0.95, metalness: 0, envMapIntensity: 0.22,
  });
});

defineMat('wallpaper', () => {
  const c = makeCanvas(); const ctx = c.getContext('2d');
  const rng = mulberry32(2001);
  const stripeA = '#7a3a2a', stripeB = '#a86040';
  for (let x = 0; x < c.width; x += 24) {
    ctx.fillStyle = ((x / 24) | 0) % 2 === 0 ? stripeA : stripeB;
    ctx.fillRect(x, 0, 24, c.height);
  }
  for (let y = 16; y < c.height; y += 40) {
    const off = ((y / 40) | 0) % 2 ? 24 : 0;
    for (let x = 12; x < c.width; x += 48) {
      ctx.fillStyle = 'rgba(255,210,160,0.55)';
      ctx.beginPath(); ctx.arc(x + off, y, 3.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(60,30,20,0.6)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(x + off, y, 6, 0, TAU); ctx.stroke();
    }
  }
  const noise = makeCanvas(); fillNoiseCanvas(noise, makeValueNoise(2002), { octaves: 5, scale: 10, contrast: 0.6 });
  ctx.globalAlpha = 0.45; ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(noise, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  // Height canvas built from the stripe pattern + floral dots so the normal map
  // gives the wallpaper subtle relief at grazing angles (same fragment cost as
  // any other normal-mapped wall — just one extra sample shared across MATS).
  const hc = makeCanvas(); const hctx = hc.getContext('2d');
  hctx.fillStyle = '#202020'; hctx.fillRect(0, 0, hc.width, hc.height);
  for (let x = 0; x < hc.width; x += 24) {
    hctx.fillStyle = ((x / 24) | 0) % 2 === 0 ? '#404040' : '#808080';
    hctx.fillRect(x, 0, 24, hc.height);
  }
  for (let y = 16; y < hc.height; y += 40) {
    const off = ((y / 40) | 0) % 2 ? 24 : 0;
    hctx.fillStyle = '#e0e0e0';
    for (let x = 12; x < hc.width; x += 48) { hctx.beginPath(); hctx.arc(x + off, y, 4, 0, TAU); hctx.fill(); }
  }
  return new THREE.MeshStandardMaterial({
    map: canvasToTexture(c, { repeat: 2 }),
    normalMap: canvasToTexture(heightToNormalCanvas(hc, 1.4), { repeat: 2, color: false }),
    roughness: 0.85, metalness: 0.0, envMapIntensity: 0.32,
  });
});

defineMat('brick', () => {
  // Brick canvas runs at 768² so individual bricks read sharply on the long
  // street facades without the per-frame cost going up — texture sampling is
  // still one fetch per fragment regardless of source resolution.
  const c = makeCanvas(768); const ctx = c.getContext('2d');
  const rng = mulberry32(3001);
  ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, c.width, c.height);
  const bw = 96, bh = 36;
  for (let y = 0; y < c.height; y += bh) {
    const offset = ((y / bh) & 1) ? bw / 2 : 0;
    for (let x = -bw; x < c.width; x += bw) {
      const bx = x + offset + 3, by = y + 3, w = bw - 6, h = bh - 6;
      // Wider per-brick hue spread so the wall doesn't read as one flat colour:
      // some bricks pale/sandy, some bruise-purple, most warm red-brown.
      const tint = rng();
      let r, g, b;
      if (tint < 0.12) { r = 150 + ((rng() * 50) | 0); g = 120 + ((rng() * 30) | 0); b = 95 + ((rng() * 25) | 0); }
      else if (tint < 0.22) { r = 70 + ((rng() * 30) | 0); g = 45 + ((rng() * 20) | 0); b = 55 + ((rng() * 25) | 0); }
      else { r = 110 + ((rng() * 70) | 0); g = 50 + ((rng() * 32) | 0); b = 35 + ((rng() * 22) | 0); }
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(bx, by, w, h);
      // Per-brick AO: darken one short edge so each face reads slightly bevelled.
      const aog = ctx.createLinearGradient(bx, by, bx, by + h);
      aog.addColorStop(0, 'rgba(0,0,0,0.28)'); aog.addColorStop(0.4, 'rgba(0,0,0,0)');
      aog.addColorStop(0.6, 'rgba(0,0,0,0)'); aog.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = aog; ctx.fillRect(bx, by, w, h);
      // Speckled grit on the face.
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let s = 0; s < 10; s++) ctx.fillRect((bx + rng() * w) | 0, (by + rng() * h) | 0, 1, 1);
      // Occasional missing-chip corner — paints a dark triangle into one edge.
      if (rng() < 0.08) {
        ctx.fillStyle = 'rgba(15,10,8,0.7)';
        const cw = 4 + ((rng() * 6) | 0), ch = 3 + ((rng() * 4) | 0);
        const cxp = rng() < 0.5 ? bx : bx + w - cw;
        const cyp = rng() < 0.5 ? by : by + h - ch;
        ctx.fillRect(cxp, cyp, cw, ch);
      }
    }
  }
  const noise = makeCanvas(); fillNoiseCanvas(noise, makeValueNoise(3002), { octaves: 5, scale: 8, contrast: 0.7 });
  ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(noise, 0, 0, c.width, c.height);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  // Efflorescence (white salt blooms) — pale calcium streaks under windows.
  for (let i = 0; i < 5; i++) {
    const sx = rng() * c.width, top = rng() * c.height * 0.4;
    const sw = 30 + rng() * 80, sh = 90 + rng() * 220;
    const sg = ctx.createLinearGradient(sx, top, sx, top + sh);
    sg.addColorStop(0, 'rgba(230,225,210,0)');
    sg.addColorStop(0.4, `rgba(230,225,210,${0.18 + rng() * 0.18})`);
    sg.addColorStop(1, 'rgba(230,225,210,0)');
    ctx.fillStyle = sg; ctx.fillRect(sx - sw / 2, top, sw, sh);
  }
  // Soot/grime dark streaks — opposite tone of efflorescence; sells smog age.
  for (let i = 0; i < 5; i++) {
    const sx = rng() * c.width, top = rng() * c.height * 0.5;
    const sw = 40 + rng() * 90, sh = 120 + rng() * 220;
    const sg = ctx.createLinearGradient(sx, top, sx, top + sh);
    sg.addColorStop(0, 'rgba(20,14,10,0)');
    sg.addColorStop(0.5, `rgba(20,14,10,${0.22 + rng() * 0.18})`);
    sg.addColorStop(1, 'rgba(20,14,10,0)');
    ctx.fillStyle = sg; ctx.fillRect(sx - sw / 2, top, sw, sh);
  }
  const hc = makeCanvas(768); const hctx = hc.getContext('2d');
  hctx.fillStyle = '#000'; hctx.fillRect(0, 0, hc.width, hc.height);
  for (let y = 0; y < hc.height; y += bh) {
    const offset = ((y / bh) & 1) ? bw / 2 : 0;
    hctx.fillStyle = '#fff';
    for (let x = -bw; x < hc.width; x += bw) hctx.fillRect(x + offset + 3, y + 3, bw - 6, bh - 6);
  }
  // Light contact-AO darkening painted into the mortar gutters before texturing
  // — gives the brick faces a touch more relief without per-frame cost.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let y = 0; y < c.height; y += bh) ctx.fillRect(0, y, c.width, 3);
  for (let y = 0; y < c.height; y += bh) {
    const offset = ((y / bh) & 1) ? bw / 2 : 0;
    for (let x = -bw; x < c.width; x += bw) ctx.fillRect(x + offset, y, 3, bh);
  }
  // Both fired clay and mortar remain dry, with slightly rougher mortar.
  const rc = makeCanvas(768); const rctx = rc.getContext('2d');
  rctx.fillStyle = '#f3f3f3'; rctx.fillRect(0, 0, rc.width, rc.height);
  for (let y = 0; y < rc.height; y += bh) {
    const offset = ((y / bh) & 1) ? bw / 2 : 0;
    rctx.fillStyle = '#dedede';
    for (let x = -bw; x < rc.width; x += bw) rctx.fillRect(x + offset + 3, y + 3, bw - 6, bh - 6);
  }
  return new THREE.MeshStandardMaterial({
    map: canvasToTexture(c, { repeat: 2 }),
    normalMap: canvasToTexture(heightToNormalCanvas(hc, 1.2), { repeat: 2, color: false }),
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughnessMap: canvasToTexture(rc, { repeat: 2, color: false }),
    roughness: 1, metalness: 0, envMapIntensity: 0.22,
  });
});

// These shared materials bake once when first requested. Their albedo,
// relief and finish describe the same grain, pores, seams and worn regions.
for (const kind of ['concrete', 'wood', 'metal', 'asphalt', 'tar', 'roofMetal', 'agedStone', 'rubber', 'gravel', 'tile']) {
  defineMat(kind, () => makeSurfaceMaterial(kind));
}

defineMat('glass', () => {
  const c = makeCanvas(256); const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(180,200,210,0.7)'; ctx.fillRect(0, 0, c.width, c.height);
  const noise = makeCanvas(256); fillNoiseCanvas(noise, makeValueNoise(9001, 64), { octaves: 4, scale: 10, contrast: 0.3 });
  ctx.globalAlpha = 0.5; ctx.drawImage(noise, 0, 0); ctx.globalAlpha = 1;
  return new THREE.MeshStandardMaterial({
    map: canvasToTexture(c, { repeat: 1 }),
    color: 0xb0c8d8, transparent: true, opacity: 0.45,
    roughness: 0.12, metalness: 0.2,
    envMapIntensity: 1.40, side: THREE.DoubleSide,
  });
});

// Night-sky equirectangular skybox with city silhouette + amber glow.
function buildSkybox() {
  const w = 2048, h = 1024;
  const c = makeRectCanvas(w, h); const ctx = c.getContext('2d');
  const rng = mulberry32(9999);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#14232f'); g.addColorStop(0.55, '#53616a');
  g.addColorStop(0.78, '#8b7562'); g.addColorStop(1, '#292b2a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    const x = rng() * w, y = rng() * h * 0.62;
    const r = rng() * 1.6 + 0.2;
    ctx.fillStyle = `rgba(255,255,${(200 + rng() * 55) | 0},${0.3 + rng() * 0.7})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  const horizon = h * 0.78;
  ctx.fillStyle = '#000';
  let x = 0;
  while (x < w) {
    const bw = 28 + rng() * 80;
    const bh = 40 + rng() * 220;
    ctx.fillStyle = '#000'; ctx.fillRect(x, horizon - bh, bw, bh + 30);
    for (let wy = horizon - bh + 8; wy < horizon - 4; wy += 10) {
      for (let wx = x + 4; wx < x + bw - 4; wx += 8) {
        if (rng() > 0.55) {
          ctx.fillStyle = rng() > 0.5 ? '#ffd680' : '#fff2b0';
          ctx.fillRect(wx, wy, 3, 4);
        }
      }
    }
    x += bw + 1;
  }
  const og = ctx.createLinearGradient(0, horizon - 140, 0, horizon + 30);
  og.addColorStop(0, 'rgba(255,120,40,0)');
  og.addColorStop(1, 'rgba(198,157,112,0.25)');
  ctx.fillStyle = og; ctx.fillRect(0, horizon - 140, w, 170);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export { MATS, makeCanvas, makeRectCanvas, canvasToTexture, heightToNormalCanvas, fillNoiseCanvas, buildSkybox };

let surfaceTextureLoad = null;

/** Generated albedo maps upgrade shared materials; procedural maps remain fallbacks. */
export function loadSurfaceTextures() {
  if (surfaceTextureLoad) return surfaceTextureLoad;
  const loader = new THREE.TextureLoader();
  const assets = [['plaster', '/assets/plaster-aged.png'], ['brick', '/assets/brick-weathered.png']];
  surfaceTextureLoad = Promise.allSettled(assets.map(async ([name, url]) => {
    const texture = await loader.loadAsync(url);
    const created = [texture];
    try {
      // Downsample only the derived PBR channels. Original full-resolution
      // albedo is preserved; this work never runs in the frame loop.
      const sample = makeCanvas(512), ctx = sample.getContext('2d');
      ctx.drawImage(texture.image, 0, 0, 512, 512);
      const data = deriveSurfaceData(ctx.getImageData(0, 0, 512, 512).data, 512, 512, name);
      const normal = surfaceTexture(data.normal, 512, 512);
      const roughness = surfaceTexture(data.orm, 512, 512);
      created.push(normal, roughness);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1, 1);
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const material = MATS[name];
      const previous = new Set([material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.bumpMap]);
      material.map = texture; material.normalMap = normal; material.roughnessMap = roughness;
      material.bumpMap = null; material.metalnessMap = null;
      material.roughness = 1; material.metalness = 0;
      const strength = name === 'brick' ? 0.65 : 0.8;
      material.normalScale.set(strength, strength);
      if (name === 'plaster') material.color.setHex(0xb4bdae);
      material.userData.staticSurfaceMaps = true;
      material.userData.generatedAlbedoUrl = url;
      material.needsUpdate = true;
      for (const old of previous) old?.dispose();
      return name;
    } catch (error) {
      for (const resource of created) resource.dispose();
      throw error;
    }
  }));
  return surfaceTextureLoad;
}
