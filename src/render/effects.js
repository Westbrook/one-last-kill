import * as THREE from 'three';

import { scene, camera } from '../core/renderer.js';
import { makeCanvas } from '../render/materials.js';
import { resolveImpactProfile, impactParticleStyle } from './impact-profile.js';

// ── Procedural blood-puff particle pool ─────────────────────────────────────
function makeBloodTexture() {
  const c = makeCanvas(32); const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
  g.addColorStop(0, 'rgba(108,18,12,0.85)');
  g.addColorStop(0.42, 'rgba(72,9,6,0.60)');
  g.addColorStop(1, 'rgba(40,3,2,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}
const BLOOD_TEXTURE = makeBloodTexture();
// PERF: single pooled Points object with N particles; spawn() recycles slots.
// Eliminates per-hit BufferGeometry/Material allocations and the GC pressure
// that came with them.
const Blood = (() => {
  const MAX = 256;
  const positions = new Float32Array(MAX * 3);
  const vel = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX);   // current age
  const maxLife = new Float32Array(MAX); // max age (0 = inactive)
  // Park inactive particles below the world so the size attenuation still
  // hides them even when a slot rolls over before update() can re-position.
  for (let i = 0; i < MAX; i++) { positions[3*i+1] = -500; }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    map: BLOOD_TEXTURE, size: 0.075, transparent: true, depthWrite: false,
    color: 0xffffff, blending: THREE.NormalBlending, opacity: 0.8,
  });
  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  let cursor = 0;
  return {
    spawn(x, y, z, count = 10, scatter = 0.7) {
      const life0 = 0.35;
      for (let i = 0; i < count; i++) {
        const k = cursor;
        cursor = (cursor + 1) % MAX;
        positions[3*k]   = x;
        positions[3*k+1] = y;
        positions[3*k+2] = z;
        vel[3*k]   = (Math.random() - 0.5) * scatter * 2;
        vel[3*k+1] = Math.random() * scatter * 1.6 + 0.2;
        vel[3*k+2] = (Math.random() - 0.5) * scatter * 2;
        life[k] = 0;
        maxLife[k] = life0;
      }
      geom.attributes.position.needsUpdate = true;
    },
    update(dt) {
      let any = false;
      for (let i = 0; i < MAX; i++) {
        if (maxLife[i] <= 0) continue;
        life[i] += dt;
        if (life[i] >= maxLife[i]) {
          maxLife[i] = 0;
          positions[3*i+1] = -500; // park out of view
          any = true;
          continue;
        }
        vel[3*i+1] -= dt * 6.0;
        positions[3*i]   += vel[3*i]   * dt;
        positions[3*i+1] += vel[3*i+1] * dt;
        positions[3*i+2] += vel[3*i+2] * dt;
        any = true;
      }
      if (any) geom.attributes.position.needsUpdate = true;
    },
  };
})();

// ── Muzzle flash + bullet tracer + material-aware impacts ───────────────────
// All three effect systems use pre-allocated pools — spawn() rotates a cursor,
// update() walks active slots and hides expired entries. No per-hit geometry,
// material, light or scene-node allocation. Three sub-pools:
//   FLASH (24 slots × 3 sprites): core plane + flare-star sprite + smoke puff,
//     with per-shot scale/rotation jitter; per-slot PointLight kept.
//   TRACER (48 slots): thin additive cylinder stretched between origin/end —
//     reads as a glowing beam instead of a 1-px line.
//   IMPACT (64 sprites): muted dust/chips or tiny sparks/flecks selected from
//     the actual struck material and emitted outside its contact plane.
const FX = (() => {
  const FLASH_MAX = 24;
  const TRACER_MAX = 48;
  const IMPACT_MAX = 64;

  // Star/flare texture for the muzzle flare element — a centered bright disk
  // with eight thin radiating spikes. Drawn once at module load.
  function makeFlareTex() {
    const c = makeCanvas(64); const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 64, 64);
    const cx = 32, cy = 32;
    const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, 28);
    grad.addColorStop(0,    'rgba(255,250,220,1)');
    grad.addColorStop(0.25, 'rgba(255,200,120,0.85)');
    grad.addColorStop(0.65, 'rgba(255,140,40,0.25)');
    grad.addColorStop(1,    'rgba(255,80,0,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,240,200,0.9)';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const lw = (i % 2 === 0) ? 4 : 2;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30);
      ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    return t;
  }
  function makeSmokeTex() {
    const c = makeCanvas(32); const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
    g.addColorStop(0,    'rgba(200,190,180,0.55)');
    g.addColorStop(0.5,  'rgba(160,150,140,0.25)');
    g.addColorStop(1,    'rgba(60,55,50,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    return t;
  }
  function makeSparkTex() {
    const c = makeCanvas(32); const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 0.5, 16, 16, 14);
    // A neutral mask accepts wood/glass tints without an orange halo.
    g.addColorStop(0,    'rgba(255,255,255,1)');
    g.addColorStop(0.3,  'rgba(245,245,245,0.8)');
    g.addColorStop(0.7,  'rgba(210,210,210,0.2)');
    g.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    return t;
  }

  const FLARE_TEX = makeFlareTex();
  const SMOKE_TEX = makeSmokeTex();
  const SPARK_TEX = makeSparkTex();

  // Shared base geometries — one PlaneGeometry per sub-element, one Cylinder
  // for tracers. Slot meshes share geometry, clone material per slot for
  // independent opacity fading.
  // At first-person muzzle distance a half-meter sprite obscures the target.
  // Keep the flash brief and physically small, especially during automatic fire.
  const coreGeom  = new THREE.PlaneGeometry(0.065, 0.065);
  const flareGeom = new THREE.PlaneGeometry(0.16, 0.16);
  const smokeGeom = new THREE.PlaneGeometry(0.22, 0.22);
  const sparkGeom = new THREE.PlaneGeometry(0.18, 0.18);
  // Unit cylinder along +Y, radius 0.02, length 1, 6 radial segs. Per-slot
  // scale.y stretches it to the actual beam length.
  const beamGeom  = new THREE.CylinderGeometry(0.004, 0.004, 1, 5, 1, true);
  // Translate cylinder so its base sits at y=0 — then we can position at the
  // origin point and scale toward the target without recomputing midpoints.
  beamGeom.translate(0, 0.5, 0);

  const coreMatBase  = new THREE.MeshBasicMaterial({ map: FLARE_TEX, color: 0xfff4c0, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
  const flareMatBase = new THREE.MeshBasicMaterial({ map: FLARE_TEX, color: 0xffe0a0, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
  const smokeMatBase = new THREE.MeshBasicMaterial({ map: SMOKE_TEX, color: 0xb8a890, transparent: true, opacity: 0.55, depthWrite: false });
  const beamMatBase  = new THREE.MeshBasicMaterial({ color: 0xffe090, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  const sparkMatBase = new THREE.MeshBasicMaterial({ map: SPARK_TEX, color: 0xffffff, transparent: true, opacity: 1, depthTest: true, depthWrite: false, blending: THREE.NormalBlending });

  const flashes = new Array(FLASH_MAX);
  const tracers = new Array(TRACER_MAX);
  const impacts = new Array(IMPACT_MAX);

  for (let i = 0; i < FLASH_MAX; i++) {
    const coreMat  = coreMatBase.clone();
    const flareMat = flareMatBase.clone();
    const smokeMat = smokeMatBase.clone();
    const core  = new THREE.Mesh(coreGeom,  coreMat);
    const flare = new THREE.Mesh(flareGeom, flareMat);
    const smoke = new THREE.Mesh(smokeGeom, smokeMat);
    core.visible = flare.visible = smoke.visible = false;
    core.frustumCulled = flare.frustumCulled = smoke.frustumCulled = false;
    scene.add(core); scene.add(flare); scene.add(smoke);
    const light = new THREE.PointLight(0xffc070, 0, 5, 2.0);
    light.visible = false; light.castShadow = false;
    scene.add(light);
    flashes[i] = { core, flare, smoke, coreMat, flareMat, smokeMat, light, age: 0, life: 0.04, active: false };
  }

  // Tracer slots — per-slot cylinder mesh and a scratch Quaternion so the
  // orient code allocates nothing in the hot path.
  for (let i = 0; i < TRACER_MAX; i++) {
    const mat = beamMatBase.clone();
    const mesh = new THREE.Mesh(beamGeom, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    tracers[i] = { mesh, mat, age: 0, life: 0.08, active: false };
  }

  for (let i = 0; i < IMPACT_MAX; i++) {
    const mat = sparkMatBase.clone();
    const mesh = new THREE.Mesh(sparkGeom, mat);
    mesh.name = 'impact-particle'; mesh.userData.impactKind = 'neutral';
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    impacts[i] = {
      mesh, mat, age: 0, life: 0.22, width0: 0, height0: 0, active: false, style: null,
      origin: new THREE.Vector3(), start: new THREE.Vector3(), normal: new THREE.Vector3(), velocity: new THREE.Vector3(),
      normalX: 0, normalY: 0,
    };
  }

  let flashCursor = 0, tracerCursor = 0, impactCursor = 0;
  // Scratch vectors / quaternion — used by tracer().
  const _tFrom = new THREE.Vector3(), _tDir = new THREE.Vector3();
  const _tUp = new THREE.Vector3(0, 1, 0), _tQuat = new THREE.Quaternion();
  const _iOrigin = new THREE.Vector3(), _iNormal = new THREE.Vector3(), _iTangent = new THREE.Vector3();
  const _iBitangent = new THREE.Vector3(), _iAxis = new THREE.Vector3();

  return {
    muzzleFlash(pos) {
      const f = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % FLASH_MAX;
      // All three sprites at the same world point; lookAt camera so the
      // billboards face the player. Per-shot scale + rotation jitter on the
      // flare gives the flash a non-repeating shape.
      f.core.position.copy(pos);  f.core.lookAt(camera.position);
      f.flare.position.copy(pos); f.flare.lookAt(camera.position);
      f.smoke.position.copy(pos); f.smoke.lookAt(camera.position);
      const sJit = 0.85 + Math.random() * 0.55;
      const rJit = Math.random() * Math.PI * 2;
      f.flare.rotation.z = rJit;
      f.flare.scale.setScalar(sJit);
      f.smoke.scale.setScalar(0.7);
      f.core.scale.setScalar(0.85 + Math.random() * 0.3);
      f.coreMat.opacity = 1; f.flareMat.opacity = 1; f.smokeMat.opacity = 0.55;
      f.core.visible = f.flare.visible = f.smoke.visible = true;
      f.light.position.copy(pos);
      f.light.intensity = 4;
      f.light.visible = true;
      f.age = 0; f.active = true;
    },
    tracer(from, to) {
      const t = tracers[tracerCursor];
      tracerCursor = (tracerCursor + 1) % TRACER_MAX;
      _tFrom.copy(from);
      _tDir.copy(to).sub(from);
      const len = _tDir.length() || 0.001;
      _tDir.divideScalar(len);
      // Rotate unit Y axis onto bullet direction.
      _tQuat.setFromUnitVectors(_tUp, _tDir);
      t.mesh.position.copy(_tFrom);
      t.mesh.quaternion.copy(_tQuat);
      t.mesh.scale.set(1, len, 1);
      t.mesh.visible = true;
      t.mat.opacity = 0.95;
      t.age = 0; t.active = true;
    },
    impact(x, y, z, count = 4, hit = null) {
      const point = hit?.point;
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) _iOrigin.copy(point);
      else _iOrigin.set(x, y, z);
      if (!Number.isFinite(_iOrigin.x) || !Number.isFinite(_iOrigin.y) || !Number.isFinite(_iOrigin.z)) return;
      const amount = Number.isFinite(count) ? Math.min(IMPACT_MAX, Math.max(0, Math.floor(count))) : 0;
      if (!amount) return;
      const profile = resolveImpactProfile(hit), normal = hit?.normal;
      _iNormal.set(normal?.x ?? 0, normal?.y ?? 0, normal?.z ?? 0);
      let normalLength = Math.hypot(_iNormal.x, _iNormal.y, _iNormal.z);
      if (!Number.isFinite(normalLength) || normalLength < 1e-8) {
        _iNormal.subVectors(camera.position, _iOrigin);
        normalLength = Math.hypot(_iNormal.x, _iNormal.y, _iNormal.z);
      }
      if (normalLength > 1e-8 && Number.isFinite(normalLength)) _iNormal.multiplyScalar(1 / normalLength);
      else _iNormal.set(0, 1, 0);
      _iAxis.set(1, 0, 0);
      _iTangent.crossVectors(_iNormal, Math.abs(_iNormal.y) > 0.9 ? _iAxis : _tUp).normalize();
      _iBitangent.crossVectors(_iNormal, _iTangent);
      for (let i = 0; i < amount; i++) {
        const sp = impacts[impactCursor];
        impactCursor = (impactCursor + 1) % IMPACT_MAX;
        const style = impactParticleStyle(profile, i), jitter = 0.8 + Math.random() * 0.4;
        sp.style = style; sp.width0 = style.width * jitter; sp.height0 = style.height * jitter;
        // Ballistics reuses its result object. Store only values in pooled state.
        sp.origin.copy(_iOrigin); sp.normal.copy(_iNormal);
        sp.mesh.position.copy(_iOrigin);
        sp.mesh.lookAt(camera.position);
        sp.mesh.rotateZ(Math.random() * Math.PI * 2);
        _iAxis.set(1, 0, 0).applyQuaternion(sp.mesh.quaternion); sp.normalX = Math.abs(_iAxis.dot(_iNormal));
        _iAxis.set(0, 1, 0).applyQuaternion(sp.mesh.quaternion); sp.normalY = Math.abs(_iAxis.dot(_iNormal));
        const clearance = 0.004 + (sp.width0 * sp.normalX + sp.height0 * sp.normalY) * 0.5;
        sp.start.copy(_iOrigin).addScaledVector(_iNormal, clearance)
          .addScaledVector(_iTangent, (Math.random() - 0.5) * style.spread)
          .addScaledVector(_iBitangent, (Math.random() - 0.5) * style.spread);
        sp.velocity.copy(_iNormal).multiplyScalar(style.speed * (0.75 + Math.random() * 0.5))
          .addScaledVector(_iTangent, (Math.random() - 0.5) * style.scatter)
          .addScaledVector(_iBitangent, (Math.random() - 0.5) * style.scatter);
        sp.velocity.y += style.rise;
        sp.mesh.position.copy(sp.start); sp.mesh.scale.set(sp.width0 / 0.18, sp.height0 / 0.18, 1);
        sp.mat.map = style.texture === 'dust' ? SMOKE_TEX : SPARK_TEX;
        sp.mat.color.setHex(style.color); sp.mat.opacity = style.opacity;
        sp.mat.blending = style.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        sp.mesh.userData.impactKind = profile.id;
        sp.life = style.life * (0.8 + Math.random() * 0.4);
        sp.mesh.visible = true;
        sp.age = 0; sp.active = true;
      }
    },
    update(dt) {
      for (let i = 0; i < FLASH_MAX; i++) {
        const f = flashes[i];
        if (!f.active) continue;
        f.age += dt;
        const k = 1 - f.age / f.life;
        if (k <= 0) {
          f.core.visible = f.flare.visible = f.smoke.visible = false;
          f.light.intensity = 0; f.light.visible = false; f.active = false;
        } else {
          // Core/flare snap-fade; smoke lingers and expands.
          f.coreMat.opacity = k * k;
          f.flareMat.opacity = k;
          f.smokeMat.opacity = 0.55 * k * 0.7;
          f.smoke.scale.setScalar(0.7 + (1 - k) * 0.6);
          f.light.intensity = 4 * k;
        }
      }
      for (let i = 0; i < TRACER_MAX; i++) {
        const t = tracers[i];
        if (!t.active) continue;
        t.age += dt;
        const k = 1 - t.age / t.life;
        if (k <= 0) { t.mesh.visible = false; t.active = false; }
        else { t.mat.opacity = 0.95 * k; }
      }
      const advanceImpacts = Number.isFinite(dt) && dt > 0;
      for (let i = 0; i < IMPACT_MAX; i++) {
        const sp = impacts[i];
        if (!sp.active || !advanceImpacts) continue;
        sp.age += dt;
        const k = 1 - sp.age / sp.life;
        if (k <= 0) { sp.mesh.visible = false; sp.active = false; sp.mat.opacity = 0; }
        else {
          const growth = 1 + (1 - k) * sp.style.growth;
          const width = sp.width0 * growth, height = sp.height0 * growth;
          sp.mat.opacity = sp.style.opacity * k * k;
          sp.mesh.scale.set(width / 0.18, height / 0.18, 1);
          // Analytic motion stays the same at different frame rates. Expanded
          // billboard corners remain outside the contacted plane, including floors.
          sp.mesh.position.copy(sp.start).addScaledVector(sp.velocity, sp.age);
          sp.mesh.position.y -= 0.5 * sp.style.gravity * sp.age * sp.age;
          const separation = (sp.mesh.position.x - sp.origin.x) * sp.normal.x
            + (sp.mesh.position.y - sp.origin.y) * sp.normal.y + (sp.mesh.position.z - sp.origin.z) * sp.normal.z;
          const clearance = 0.004 + (width * sp.normalX + height * sp.normalY) * 0.5;
          if (separation < clearance) sp.mesh.position.addScaledVector(sp.normal, clearance - separation);
        }
      }
    },
  };
})();

export { Blood, FX };
