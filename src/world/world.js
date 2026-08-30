import { buildPlayerApartment, buildNeighborApartment } from './zones/apartments.js';
import { buildBalcony, buildStairwell, buildRoof, buildScaffolding } from './zones/traversal.js';
import { buildStreet, buildBakeryAndCar } from './zones/street.js';
import * as THREE from 'three';
import { clamp, makeValueNoise, fBm } from '../core/math.js';
import { scene, renderer } from '../core/renderer.js';
import { MATS, makeCanvas, makeRectCanvas } from '../render/materials.js';
import { flushDecor } from '../render/models.js';
import { applyBoxWorldUV } from '../render/world-uv.js';
import { fitWorldShadow } from '../render/shadow-frustum.js';
import { ROOF } from './layout.js';
import { DISTRICT } from './district-layout.js';

import { HUD, ObjectiveBanner } from '../ui/hud.js';
import { Colliders } from '../core/collision.js';
import { Ballistics } from '../core/ballistics.js';
import { Player } from '../game/player.js';
import { Architecture, boxBounds, signYaw } from './architecture.js';
import { resolveSurfaceOwnership } from './surface-ownership.js';

// ─── 10. WORLD: LITTLE SICILY (8 ZONES) ──────────────────────────────────────
const World = new THREE.Group(); World.name = 'world';
scene.add(World);

// Neutral sky fill and warm practical accents retain readable interior surfaces.
function addLights() {
  // Broad indirect fill remains cheap; only the directional key casts shadows.
  const ambient = new THREE.AmbientLight(0xb0b6ad, 0.45);
  scene.add(ambient);

  // One shadow map, focused conservatively by the render budget at runtime.
  const moon = new THREE.DirectionalLight(0xc3d5e0, 1.6);
  moon.castShadow = true;
  const shadowBounds = new THREE.Box3(
    new THREE.Vector3(DISTRICT.bounds.x1, -0.2, ROOF.z1),
    new THREE.Vector3(DISTRICT.bounds.x2, ROOF.floorY + 5.2, DISTRICT.bounds.z2),
  );
  fitWorldShadow(moon, shadowBounds);
  scene.add(moon, moon.target);

  // Hemisphere lifts indoor floors/ceilings without a second shadow caster.
  const cityGlow = new THREE.HemisphereLight(0x99b1c2, 0x554a3d, 1.0);
  scene.add(cityGlow);
  return { directional: moon, bounds: shadowBounds };
}

// World-state shared across zone builders.
const WorldState = {
  fires: [],
  flickerLights: [],
  smokeSystems: [],
  car: null,
  bakeryLights: [],
  surfaceOwnership: null,
};

// Zone trigger volumes. Each fires zoneChanged(name) the first time the
// player enters, and may add follow-up colliders (one-way gates).
const Triggers = {
  list: [],
  add(name, min, max, onEnter, onReset) {
    const trigger = {
      name,
      box: new THREE.Box3(min.clone(), max.clone()),
      fired: false,
      onEnter: onEnter || null,
      onReset: onReset || null,
    };
    this.list.push(trigger);
    return trigger;
  },
  // A full campaign reset restores authored passages. Checkpoint retries do
  // not call this: their existing one-way gates must remain closed behind them.
  reset() {
    for (const trigger of this.list) {
      trigger.fired = false;
      trigger.onReset?.();
    }
  },
};
let currentZone = null;
const ZONE_OBJECTIVES = {
  apartment:    'GET OUT — THE FIRE IS SPREADING',
  neighbor:     'THROUGH THE NEIGHBOR\'S UNIT',
  balcony:      'CROSS THE BALCONY TO THE STAIRWELL',
  stairwell:    'CLIMB TO THE ROOF',
  roof:         'FIND THE SCAFFOLDING',
  scaffolding:  'DESCEND TO THE STREET',
  street:       'LITTLE SICILY — CAR OR BAKERY?',
  bakery:       'INSIDE THE BAKERY',
};
const zoneListeners = new Set();
function onZoneChange(listener) { zoneListeners.add(listener); return () => zoneListeners.delete(listener); }
function zoneChanged(zone) {
  currentZone = zone;
  const obj = ZONE_OBJECTIVES[zone] || zone.toUpperCase();
  HUD.setObjective(obj);
  ObjectiveBanner.show(zone, obj);
  // Keep visible architecture consistent with collision during backtracking.
  for (const z of Object.keys(ZoneCull.byZone)) ZoneCull.setHidden(z, false);
  // PERF: forward light culling — only zones genuinely visible from the
  // current one keep their PointLights lit.
  ZoneCull.setActiveZone(zone);
  for (const listener of zoneListeners) listener(zone);
}
function triggersUpdate() {
  const p = Player.pos;
  for (const t of Triggers.list) {
    if (t.fired) continue;
    if (t.box.containsPoint(p)) {
      t.fired = true;
      zoneChanged(t.name);
      if (t.onEnter) t.onEnter();
    }
  }
}

// ── Fire material: animated radial gradient drawn into a CanvasTexture ──────
// Fire texture painting is throttled independently from smooth light flicker.
const FIRE_PAINT_INTERVAL = 1 / 13;
function makeFireMaterial() {
  const c = makeCanvas(64);
  const ctx = c.getContext('2d');
  const noiseFn = makeValueNoise(7777 + ((Math.random() * 9000) | 0), 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  // _lastPaint seeded in [-INTERVAL, 0] so first paints stagger across the
  // first window (no all-fires-repaint-same-frame burst at scene init).
  return { mat, tex, ctx, c, noiseFn, phase: Math.random() * 1000,
    _lastPaint: -Math.random() * FIRE_PAINT_INTERVAL };
}
function paintFireCanvas(fire, t) {
  const { ctx, c, noiseFn } = fire;
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const dx = (u - 0.5) * 2;
      const radial = Math.max(0, 1 - Math.hypot(dx * 1.6, (v - 0.85) * 1.3));
      const n = fBm(noiseFn, u * 4 + t * 0.6, (1 - v) * 6 + t * 1.8, 4);
      let f = clamp(radial * (0.55 + n * 0.9) * (1.2 - v * 0.4), 0, 1);
      f = Math.pow(f, 1.4);
      const r = Math.min(255, 255 * f);
      const g = Math.min(255, 230 * Math.pow(f, 1.8));
      const b = Math.min(255, 80 * Math.pow(f, 3.2));
      const a = Math.min(255, 255 * Math.pow(f, 0.9));
      const i = (y * w + x) * 4;
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  fire.tex.needsUpdate = true;
}

// Spawn a fire patch: animated billboards + point light + smoke particles + hot collider.
function spawnFire(x, y, z, opts = {}) {
  const o = Object.assign({ width: 1.4, height: 1.8, blockHeight: 2.0, blockWidth: 1.6, blockDepth: null, color: 0xffa040, intensity: 3.8, addCollider: true }, opts);
  // blockDepth (z-size) defaults to blockWidth so legacy callers stay square.
  if (o.blockDepth === null) o.blockDepth = o.blockWidth;
  const group = new THREE.Group();
  // Fire can block a route without becoming an invisible bulletproof wall.
  group.userData.ballistics = false;
  group.position.set(x, y, z);
  const fireA = makeFireMaterial();
  const fireB = makeFireMaterial();
  fireB.phase += 1.7;
  const planeGeo = new THREE.PlaneGeometry(o.width, o.height);
  const mA = new THREE.Mesh(planeGeo, fireA.mat);
  const mB = new THREE.Mesh(planeGeo, fireB.mat);
  mA.position.y = o.height / 2;
  mB.position.y = o.height / 2;
  mB.rotation.y = Math.PI / 2;
  group.add(mA); group.add(mB);

  const light = new THREE.PointLight(o.color, o.intensity, 9, 1.8);
  light.position.y = o.height * 0.6;
  light.castShadow = false;
  group.add(light);

  const smoke = makeSmokeSystem(64);
  smoke.points.position.y = o.height * 0.95;
  group.add(smoke.points);
  WorldState.smokeSystems.push(smoke);

  World.add(group);
  const collider = o.addCollider
    ? Colliders.addBoxBySize(x, y + o.blockHeight / 2, z, o.blockWidth, o.blockHeight, o.blockDepth)
    : null;
  const entry = { group, fires: [fireA, fireB], light, smoke, collider, active: true, baseIntensity: o.intensity };
  WorldState.fires.push(entry);
  if (o.active === false) setFireActive(entry, false);
  return entry;
}

// Keep the source light registered with the practical-light budget even while
// inactive. Intensity zero excludes it without changing the GPU light count.
function setFireActive(entry, active) {
  const enabled = Boolean(active);
  const wasActive = entry.active;
  entry.active = enabled;
  entry.group.visible = enabled;
  entry.light.intensity = enabled ? entry.baseIntensity : 0;
  entry.smoke.active = enabled;
  entry.smoke.points.visible = enabled;
  if (entry.collider) Colliders.setEnabled(entry.collider, enabled);
  if (enabled && !wasActive) {
    for (const fire of entry.fires) fire._lastPaint = -Infinity;
  }
  return entry;
}

function animateFires(t, dt) {
  for (let i = 0; i < WorldState.fires.length; i++) {
    const f = WorldState.fires[i];
    if (f.active === false) continue;
    const fa = f.fires[0], fb = f.fires[1];
    // Per-plane throttle: repaint+upload at ~13 Hz instead of every frame.
    // Phases stay continuous (`t + phase`) so the flame look doesn't downgrade
    // — the noise just samples 4-5 frames apart instead of every frame.
    if (t < fa._lastPaint || t - fa._lastPaint >= FIRE_PAINT_INTERVAL) {
      paintFireCanvas(fa, t + fa.phase);
      fa._lastPaint = t;
    }
    if (t < fb._lastPaint || t - fb._lastPaint >= FIRE_PAINT_INTERVAL) {
      paintFireCanvas(fb, t + fb.phase);
      fb._lastPaint = t;
    }
    f.light.intensity = f.baseIntensity * (0.78 + Math.sin(t * 14 + fa.phase) * 0.12 + Math.sin(t * 23 + fb.phase) * 0.08);
  }
}

// ── Smoke particles (point sprites) ─────────────────────────────────────────
function makeSmokeTexture() {
  const c = makeCanvas(64); const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, 'rgba(128,133,130,0.35)');
  g.addColorStop(0.6, 'rgba(108,115,115,0.10)');
  g.addColorStop(1, 'rgba(20,18,18,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
const SMOKE_TEXTURE = makeSmokeTexture();
function makeSmokeSystem(count = 16) {
  count = Math.min(count, 16);
  const positions = new Float32Array(count * 3);
  const lifeAttr  = new Float32Array(count);
  const speedAttr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[3*i]   = (Math.random() - 0.5) * 0.6;
    positions[3*i+1] = Math.random() * 1.4;
    positions[3*i+2] = (Math.random() - 0.5) * 0.6;
    lifeAttr[i]  = Math.random();
    speedAttr[i] = 0.4 + Math.random() * 0.5;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    map: SMOKE_TEXTURE, size: 1.15, transparent: true, opacity: 0.18,
    depthWrite: false, sizeAttenuation: true, color: 0xb3b7b5,
    blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geom, mat);
  return { points, life: lifeAttr, speed: speedAttr, count, active: true };
}
function animateSmoke(dt) {
  for (const s of WorldState.smokeSystems) {
    if (s.active === false) continue;
    const pos = s.points.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < s.count; i++) {
      s.life[i] += dt * 0.35;
      arr[3*i+1] += s.speed[i] * dt;
      arr[3*i]   += Math.sin(s.life[i] * 2.0) * dt * 0.15;
      arr[3*i+2] += Math.cos(s.life[i] * 1.7) * dt * 0.15;
      if (s.life[i] > 1.0 || arr[3*i+1] > 2.4) {
        s.life[i] = 0;
        arr[3*i]   = (Math.random() - 0.5) * 0.5;
        arr[3*i+1] = 0;
        arr[3*i+2] = (Math.random() - 0.5) * 0.5;
      }
    }
    pos.needsUpdate = true;
  }
}

// ── Flickering lamp registry ────────────────────────────────────────────────
function addFlickerLight(light, baseIntensity, seed) {
  WorldState.flickerLights.push({ light, base: baseIntensity, seed: seed * 0.137 });
}
function animateFlickerLights(t) {
  for (const f of WorldState.flickerLights) {
    const n = Math.sin(t * 13 + f.seed) * 0.5 + Math.sin(t * 27 + f.seed * 3.1) * 0.3 + Math.sin(t * 5 + f.seed * 7.3) * 0.2;
    f.light.intensity = f.base * (0.45 + 0.55 * (n * 0.5 + 0.5));
  }
}

// ── Geometry helpers: solid boxes that also register a collider ─────────────
function addBox(cx, cy, cz, sx, sy, sz, mat, opts = {}) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  applyBoxWorldUV(geometry, mat.userData?.surfaceMeters, { x: cx, y: cy, z: cz });
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(cx, cy, cz);
  m.castShadow = opts.cast !== false;
  m.receiveShadow = opts.recv !== false;
  World.add(m);
  const collider = opts.collide !== false ? Colliders.addBoxBySize(cx, cy, cz, sx, sy, sz) : null;
  m.userData.collider = collider;
  if (opts.architecture) Architecture.register(m, collider, boxBounds(cx, cy, cz, sx, sy, sz), opts.architecture);
  return m;
}
// Wall along x-axis with an optional doorway carved out of it.
function addWallX(cx, cy, cz, length, height, thickness, mat, doorway) {
  if (!doorway) {
    addBox(cx, cy + height / 2, cz, length, height, thickness, mat);
    return;
  }
  const { xStart, xEnd, headerH = 0.3, sillH = 0 } = doorway;
  const xLeft  = cx - length / 2;
  const xRight = cx + length / 2;
  if (xStart > xLeft) {
    const segLen = xStart - xLeft;
    addBox(xLeft + segLen / 2, cy + height / 2, cz, segLen, height, thickness, mat);
  }
  if (xEnd < xRight) {
    const segLen = xRight - xEnd;
    addBox(xEnd + segLen / 2, cy + height / 2, cz, segLen, height, thickness, mat);
  }
  const opLen = xEnd - xStart;
  if (headerH > 0) {
    addBox((xStart + xEnd) / 2, cy + height - headerH / 2, cz, opLen, headerH, thickness, mat);
  }
  if (sillH > 0) {
    addBox((xStart + xEnd) / 2, cy + sillH / 2, cz, opLen, sillH, thickness, mat);
  }
}
function addWallZ(cx, cy, cz, length, height, thickness, mat, doorway) {
  if (!doorway) {
    addBox(cx, cy + height / 2, cz, thickness, height, length, mat);
    return;
  }
  const { zStart, zEnd, headerH = 0.3, sillH = 0 } = doorway;
  const zLow  = cz - length / 2;
  const zHigh = cz + length / 2;
  if (zStart > zLow) {
    const segLen = zStart - zLow;
    addBox(cx, cy + height / 2, zLow + segLen / 2, thickness, height, segLen, mat);
  }
  if (zEnd < zHigh) {
    const segLen = zHigh - zEnd;
    addBox(cx, cy + height / 2, zEnd + segLen / 2, thickness, height, segLen, mat);
  }
  const opLen = zEnd - zStart;
  if (headerH > 0) {
    addBox(cx, cy + height - headerH / 2, (zStart + zEnd) / 2, thickness, headerH, opLen, mat);
  }
  if (sillH > 0) {
    addBox(cx, cy + sillH / 2, (zStart + zEnd) / 2, thickness, sillH, opLen, mat);
  }
}

// Decorative-only mesh (no collider).
function addDecor(cx, cy, cz, sx, sy, sz, mat) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  applyBoxWorldUV(geometry, mat.userData?.surfaceMeters, { x: cx, y: cy, z: cz });
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(cx, cy, cz);
  m.castShadow = true; m.receiveShadow = true;
  World.add(m);
  return m;
}

// ── Canvas-drawn shop sign (original names, fan-fiction Little Sicily) ──────
function makeSignTexture(text, opts = {}) {
  const o = Object.assign({ bg: '#3a1a14', fg: '#ffdd88', accent: '#caa040', font: 'bold 84px serif', sub: '', subFont: 'italic 36px serif' }, opts);
  const c = makeRectCanvas(1024, 256); const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, o.bg); g.addColorStop(1, '#1a0805');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 256);
  ctx.strokeStyle = o.accent; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 1024 - 16, 256 - 16);
  ctx.fillStyle = o.fg; ctx.font = o.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, o.sub ? 110 : 128);
  if (o.sub) {
    ctx.fillStyle = o.accent; ctx.font = o.subFont;
    ctx.fillText(o.sub, 512, 188);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}
function addSign(cx, cy, cz, w, h, faceNormal, text, opts) {
  const tex = makeSignTexture(text, opts);
  // Self-illuminate sign faces using the texture itself as the emissiveMap so the
  // painted letters glow at night without resorting to a full bloom pass — zero
  // extra material/shader cost beyond what was already in flight.
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffeecc, emissiveIntensity: 0.55, roughness: 0.6, metalness: 0.05 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  sign.position.set(cx, cy, cz);
  sign.rotation.y = signYaw(faceNormal);
  sign.castShadow = false; sign.receiveShadow = true;
  World.add(sign);
  return sign;
}

// Dispatcher: builds the full traversable world.
// PERF: zone-visibility culling. After each zone is built we snapshot which
// World children belong to it; ZoneCull.setHidden(zone) then hides meshes for
// zones the player has permanently left via one-way gates. Colliders are
// untouched (they're cheap and a few are referenced by raycasts).
// PERF: lightsByZone tracks every PointLight introduced by a zone (including
// those nested inside fire / car groups). setActiveZone(zone) toggles each
// zone's PointLights based on ZONE_ADJACENT_LIGHTS so only the rooms the
// player can realistically see are lit per frame — three.js's per-fragment
// light loop iterates only visible lights, so this is the dominant FPS lever.
// Mesh visibility is NOT touched here (sightlines through windows stay).
const ZoneCull = {
  byZone: {},
  lightsByZone: {},
  activeZones: new Set(['apartment', 'neighbor']),
  capture(zone, before) {
    const arr = [];
    const lights = [];
    for (let i = before; i < World.children.length; i++) {
      const c = World.children[i];
      arr.push(c);
      c.traverse(o => { if (o.isLight) { o.userData.zone = zone; lights.push(o); } });
    }
    this.byZone[zone] = arr;
    this.lightsByZone[zone] = lights;
  },
  setHidden(zone, hidden) {
    const arr = this.byZone[zone];
    if (!arr) return;
    for (const m of arr) m.visible = !hidden;
  },
  setActiveZone(zone) {
    const list = ZONE_ADJACENT_LIGHTS[zone] || [zone];
    const set = new Set(list);
    this.activeZones = set;
    for (const z in this.lightsByZone) {
      const want = set.has(z);
      const arr = this.lightsByZone[z];
      for (const l of arr) l.visible = want;
    }
  },
};
// For each zone, the set of zones whose PointLights stay LIT while the player
// is here. Includes the current zone and immediate neighbours visible through
// doorways / broken walls so the camera doesn't see a dark hole when looking
// into an adjacent room. The fragment shader still iterates every visible
// light per pixel, so we keep this list as tight as the sightlines allow.
const ZONE_ADJACENT_LIGHTS = {
  apartment:   ['apartment', 'neighbor'],
  neighbor:    ['neighbor', 'apartment', 'balcony'],
  balcony:     ['balcony', 'neighbor', 'stairwell'],
  stairwell:   ['stairwell', 'balcony', 'roof'],
  roof:        ['roof', 'stairwell', 'scaffolding'],
  scaffolding: ['scaffolding', 'roof', 'street'],
  street:      ['street', 'scaffolding', 'bakery'],
  bakery:      ['bakery', 'street'],
};
function buildZone(zone, fn) {
  const before = World.children.length;
  fn();
  flushDecor(World);
  ZoneCull.capture(zone, before);
}
function buildWorld() {
  Ballistics.clear();
  buildZone('apartment',   buildPlayerApartment);
  buildZone('neighbor',    buildNeighborApartment);
  buildZone('balcony',     buildBalcony);
  buildZone('stairwell',   buildStairwell);
  buildZone('roof',        buildRoof);
  buildZone('scaffolding', buildScaffolding);
  buildZone('street',      buildStreet);
  buildZone('bakery',      buildBakeryAndCar);
  buildWorldBoundary();
}

// Run after every zone and the surroundings exist: some supporting walls are
// authored in the street builder, after the floors they support. Finishing
// faces must be resolved together, once, before the first scene render.
function finalizeWorldSurfaces() {
  WorldState.surfaceOwnership ??= resolveSurfaceOwnership(Architecture.elements.values());
  return WorldState.surfaceOwnership;
}

// Outer kill-floor: a low concrete pad below the playable area so the player
// can never fall out of the world even if a future change exposes a gap.
function buildWorldBoundary() {
  const pad = new THREE.Mesh(new THREE.BoxGeometry(120, 0.4, 120), MATS.asphalt);
  pad.position.set(0, -2.0, 5);
  pad.receiveShadow = true;
  World.add(pad);
  Colliders.addBoxBySize(0, -2.0, 5, 120, 0.4, 120);
}

export { World, WorldState, Triggers, currentZone, ZONE_OBJECTIVES, zoneChanged, triggersUpdate, onZoneChange, ZoneCull, addLights, buildWorld, finalizeWorldSurfaces, animateFires, animateFlickerLights, animateSmoke, addBox, addDecor, addSign, spawnFire, setFireActive, buildZone, addWallX, addWallZ, addFlickerLight, makeSmokeSystem, makeSignTexture };
