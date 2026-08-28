import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WEAPON_DEFS } from './weapon-data.js';
import { sanitizeWeaponSnapshot, reloadMagazine, canPickupWeapon, weaponPickupPrompt } from './weapon-rules.js';
import { CombatStats } from './combat-stats.js';
import { createMeleeState, beginMelee, advanceMelee, cancelMelee, meleeRemaining } from './melee-rules.js';
import { AmmoSupplies } from './ammo-supplies.js';
import { isSegmentOccluded } from './combat-rules.js';
import { placeWeaponDrop } from './drop-placement.js';
import { Settings } from '../core/settings.js';
import * as THREE from 'three';
import { lerp, clamp } from '../core/math.js';
import { scene, camera, GameTime } from '../core/renderer.js';

import { Player, PlayerState } from './player.js';
import { HUD } from '../ui/hud.js';
import { Audio } from '../core/audio.js';
import { Colliders } from '../core/collision.js';
import { World } from '../world/world.js';
import { raycastEnemies, damageEnemy } from './enemies.js';
import { FX } from '../render/effects.js';
import { prepareViewModel, getViewModelMuzzle } from '../render/viewmodel.js';
import { createFirstPersonHands, poseFirstPersonHands, FIRST_PERSON_PUNCH_SECONDS } from '../render/first-person-hands.js';
import { createFirstPersonBat, poseFirstPersonBat } from '../render/first-person-bat.js';
import { createBatAsset, BAT_DIMENSIONS } from '../render/bat-asset.js';

// ── Weapon drops ────────────
// Each drop is a small mesh + light + userData payload { weaponType, ammo,
// kind:'weaponDrop' } used by the pickup controller.
// Drops are small composite Groups built from a tiny set of shared sub-
// geometries and materials. Compared to the prior single-Box mesh the world
// pickup now reads as a proper weapon silhouette (barrel + grip + mag etc.)
// without per-spawn geometry allocations beyond the few small Mesh objects
// the Group needs.
const WeaponDrops = {
  list: [],
  matCache: {},
  _smallGeoCache: null,
  // ── Pickup light pool ──
  // PERF: spawn() used to allocate a brand-new PointLight per drop, which
  // bumped the renderer's active-light count and forced a Three.js shader
  // recompile mid-combat (visible 60–80 ms hitch on the first kill that drops
  // a weapon). The pool pre-allocates a generous number of PointLights up
  // front, parked at intensity=0 below the floor, so the light count seen by
  // the renderer never changes after init. spawn() raises a slot's intensity
  // and moves it onto the drop; remove() returns it to intensity 0. Sized to
  // comfortably cover realistic simultaneous drops across a full playthrough.
  _haloPool: [],
  _haloPoolSize: 16,
  _initHaloPool() {
    if (this._haloPool.length) return;
    for (let i = 0; i < this._haloPoolSize; i++) {
      const l = new THREE.PointLight(0xffd070, 0, 1.6, 1.8);
      l.position.set(0, -200, 0);
      World.add(l);
      this._haloPool.push({ light: l, inUse: false });
    }
  },
  _acquireHalo() {
    for (let i = 0; i < this._haloPool.length; i++) {
      const slot = this._haloPool[i];
      if (!slot.inUse) {
        slot.inUse = true;
        slot.light.intensity = 0.45;
        // PERF: pool lights are parked invisible at init so the fragment
        // shader light loop only iterates slots actually carrying a drop.
        slot.light.visible = true;
        return slot.light;
      }
    }
    // A drop remains usable without a halo. Never bypass the fixed light pool.
    return null;
  },
  _releaseHalo(light) {
    if (!light) return;
    for (let i = 0; i < this._haloPool.length; i++) {
      const slot = this._haloPool[i];
      if (slot.light === light) {
        slot.inUse = false;
        light.intensity = 0;
        light.position.set(0, -200, 0);
        light.visible = false;
        return;
      }
    }
  },
  _geos() {
    if (this._smallGeoCache) return this._smallGeoCache;
    this._smallGeoCache = {
      box1:   new THREE.BoxGeometry(1, 1, 1),
      cyl12:  new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
      sph8:   new THREE.SphereGeometry(0.5, 8, 6),
    };
    return this._smallGeoCache;
  },
  _mat(type) {
    if (this.matCache[type]) return this.matCache[type];
    let col, rough, metal;
    if (type === 'bat')          { col = 0x6b4628; rough = 0.6;  metal = 0.05; }
    else if (type === 'knife')   { col = 0xc8ccd2; rough = 0.25; metal = 0.9;  }
    else                          { col = 0x303034; rough = 0.5; metal = 0.7;  }
    const m = new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: metal });
    this.matCache[type] = m; return m;
  },
  _matDark() {
    if (!this._dm) this._dm = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.6, metalness: 0.4 });
    return this._dm;
  },
  _matWood() {
    if (!this._wm) this._wm = new THREE.MeshStandardMaterial({ color: 0x6b4628, roughness: 0.6, metalness: 0.05 });
    return this._wm;
  },
  _build(weaponType) {
    if (weaponType === 'bat') {
      const group = new THREE.Group(), asset = createBatAsset();
      // The same handle-origin asset is used by both visible grips. World
      // pickups center it and lay its axis along the floor, never upright.
      asset.rotation.y = Math.PI / 2;
      asset.position.x = -BAT_DIMENSIONS.centerZ;
      group.add(asset);
      return group;
    }
    const G = this._geos();
    const mainMat = this._mat(weaponType);
    const darkMat = this._matDark();
    const woodMat = this._matWood();
    const group = new THREE.Group();
    const mk = (geo, mat) => new THREE.Mesh(geo, mat);
    if (weaponType === 'knife') {
      const bl = mk(G.box1, this._mat('knife'));
      bl.scale.set(0.22, 0.025, 0.005);
      const handle = mk(G.box1, woodMat);
      handle.scale.set(0.12, 0.04, 0.04); handle.position.x = -0.17;
      const guard = mk(G.box1, darkMat);
      guard.scale.set(0.015, 0.07, 0.05); guard.position.x = -0.10;
      group.add(bl, handle, guard);
    } else if (weaponType === 'pistol') {
      const slide = mk(G.box1, mainMat);
      slide.scale.set(0.22, 0.06, 0.05); slide.position.y = 0.04;
      const grip = mk(G.box1, darkMat);
      grip.scale.set(0.05, 0.14, 0.06); grip.position.set(-0.07, -0.03, 0);
      const bbl = mk(G.cyl12, mainMat);
      bbl.scale.set(0.013, 0.06, 0.013); bbl.rotation.z = Math.PI / 2; bbl.position.set(0.13, 0.04, 0);
      const sight = mk(G.box1, darkMat);
      sight.scale.set(0.02, 0.012, 0.04); sight.position.set(-0.08, 0.075, 0);
      group.add(slide, grip, bbl, sight);
    } else if (weaponType === 'shotgun') {
      const stock = mk(G.box1, woodMat);
      stock.scale.set(0.22, 0.08, 0.06); stock.position.set(-0.36, 0, 0);
      const barrel = mk(G.cyl12, mainMat);
      barrel.scale.set(0.022, 0.55, 0.022); barrel.rotation.z = Math.PI / 2; barrel.position.set(0.10, 0.03, 0);
      const tube = mk(G.cyl12, mainMat);
      tube.scale.set(0.017, 0.42, 0.017); tube.rotation.z = Math.PI / 2; tube.position.set(0.08, -0.01, 0);
      const pump = mk(G.box1, woodMat);
      pump.scale.set(0.10, 0.045, 0.07); pump.position.set(-0.05, -0.005, 0);
      const grip = mk(G.box1, woodMat);
      grip.scale.set(0.06, 0.10, 0.05); grip.position.set(-0.18, -0.06, 0);
      group.add(stock, barrel, tube, pump, grip);
    } else if (weaponType === 'smg') {
      const body = mk(G.box1, mainMat);
      body.scale.set(0.30, 0.08, 0.06);
      const bbl = mk(G.cyl12, mainMat);
      bbl.scale.set(0.013, 0.10, 0.013); bbl.rotation.z = Math.PI / 2; bbl.position.set(0.18, 0.0, 0);
      const mag = mk(G.box1, darkMat);
      mag.scale.set(0.05, 0.13, 0.045); mag.position.set(-0.02, -0.10, 0);
      const grip = mk(G.box1, darkMat);
      grip.scale.set(0.04, 0.09, 0.05); grip.position.set(-0.12, -0.07, 0);
      const sight = mk(G.box1, darkMat);
      sight.scale.set(0.022, 0.025, 0.03); sight.position.set(-0.06, 0.06, 0);
      group.add(body, bbl, mag, grip, sight);
    } else if (weaponType === 'machinegun') {
      const receiver = mk(G.box1, mainMat);
      receiver.scale.set(0.40, 0.10, 0.07);
      const barrel = mk(G.cyl12, mainMat);
      barrel.scale.set(0.018, 0.42, 0.018); barrel.rotation.z = Math.PI / 2; barrel.position.set(0.32, 0.02, 0);
      for (let r = 0; r < 3; r++) {
        const rib = mk(G.cyl12, darkMat);
        rib.scale.set(0.024, 0.02, 0.024); rib.rotation.z = Math.PI / 2;
        rib.position.set(0.20 + r * 0.08, 0.02, 0);
        group.add(rib);
      }
      const stock = mk(G.box1, mainMat);
      stock.scale.set(0.18, 0.07, 0.05); stock.position.set(-0.28, 0, 0);
      const mag = mk(G.box1, darkMat);
      mag.scale.set(0.06, 0.18, 0.045); mag.position.set(-0.04, -0.11, 0); mag.rotation.z = -0.18;
      const grip = mk(G.box1, darkMat);
      grip.scale.set(0.045, 0.10, 0.05); grip.position.set(-0.14, -0.07, 0);
      const fh = mk(G.cyl12, darkMat);
      fh.scale.set(0.024, 0.04, 0.024); fh.rotation.z = Math.PI / 2; fh.position.set(0.55, 0.02, 0);
      group.add(receiver, barrel, stock, mag, grip, fh);
    } else {
      const fallback = mk(G.box1, mainMat); fallback.scale.set(0.2, 0.14, 0.05);
      group.add(fallback);
    }
    group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    return group;
  },
  spawn(x, y, z, weaponType, ammo) {
    if (this.list.length >= this._haloPoolSize) this.remove(this.list[0]);
    const mesh = this._build(weaponType);
    const placement = placeWeaponDrop(mesh, weaponType, { x, y, z }, Colliders.list, Math.random() * Math.PI * 2);
    mesh.userData = { kind: 'weaponDrop', weaponType, ammo, spawnTime: GameTime.elapsed, ...placement };
    World.add(mesh);
    const halo = this._acquireHalo();
    if (halo) { halo.position.copy(mesh.position); halo.position.y += 0.15; }
    const entry = { mesh, halo, weaponType, ammo };
    this.list.push(entry);
    return entry;
  },
  clearAll() {
    while (this.list.length) this.remove(this.list[this.list.length - 1]);
  },
  remove(entry) {
    const i = this.list.indexOf(entry);
    if (i < 0) return;
    World.remove(entry.mesh);
    this._releaseHalo(entry.halo);
    this.list.splice(i, 1);
  },
};

// ── Player weapon system ──────────────────────────────────────────
// Single weapon slot. Fists are the always-available baseline (kind:'melee',
// no ammo). Picking up a different weaponType swaps and drops the current one
// as a re-pickupable world entity (retaining its remaining ammo). Same-type
// pickup adds spare ammunition without silently reloading the magazine.

// Procedural first-person view models. Built once per type, attached/detached
// to the camera as the active weapon changes. Held weapons use the lower-right
// framing; fists have a separate camera-space rig with a clear lower guard.
function makeWeaponViewModel(type) {
  if (type === 'fists') return prepareViewModel(createFirstPersonHands());
  if (type === 'bat') return prepareViewModel(createFirstPersonBat());
  const vmBox = (w, h, d) => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.16);
  const g = new THREE.Group();
  g.name = 'vm_' + type;
  const metal = new THREE.MeshStandardMaterial({ color: 0x62696c, roughness: 0.4, metalness: 0.65 });
  const metalDark = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.55, metalness: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4628, roughness: 0.6, metalness: 0.05 });
  const blade = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.2, metalness: 0.92 });
  if (type === 'knife') {
    const handle = new THREE.Mesh(vmBox(0.12, 0.04, 0.04), wood);
    handle.position.set(-0.04, -0.01, 0.0);
    const bl = new THREE.Mesh(vmBox(0.22, 0.025, 0.005), blade);
    bl.position.set(0.13, 0.0, 0.0);
    // Crossguard + pommel — tiny details that make the knife read.
    const guard = new THREE.Mesh(vmBox(0.015, 0.07, 0.05), metal);
    guard.position.set(0.025, -0.005, 0.0);
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), metal);
    pommel.position.set(-0.105, -0.01, 0.0);
    // Bevelled blade tip — a small angled box edge.
    const edge = new THREE.Mesh(vmBox(0.04, 0.012, 0.008), blade);
    edge.position.set(0.22, 0.0, 0.0); edge.rotation.z = -0.18;
    g.add(handle, bl, guard, pommel, edge);
  } else if (type === 'pistol') {
    g.userData.muzzle = [0.201, 0.04, 0];
    const grip = new THREE.Mesh(vmBox(0.05, 0.14, 0.06), metalDark);
    grip.position.set(-0.05, -0.04, 0.0);
    const slide = new THREE.Mesh(vmBox(0.22, 0.06, 0.05), metal);
    slide.position.set(0.04, 0.04, 0.0);
    // Barrel cylinder peeking out the front of the slide.
    const bbl = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.06, 10), metal);
    bbl.rotation.z = Math.PI / 2; bbl.position.set(0.17, 0.04, 0.0);
    // Trigger guard (small ring approximated by a thin torus-like shape).
    const tg = new THREE.Mesh(new THREE.TorusGeometry(0.020, 0.006, 6, 12, Math.PI), metalDark);
    tg.rotation.x = Math.PI / 2; tg.rotation.z = Math.PI; tg.position.set(-0.025, -0.005, 0.0);
    // Rear sight notch.
    const sight = new THREE.Mesh(vmBox(0.02, 0.012, 0.04), metalDark);
    sight.position.set(-0.05, 0.075, 0.0);
    // Magazine base peeking from grip.
    const magBase = new THREE.Mesh(vmBox(0.055, 0.015, 0.06), metal);
    magBase.position.set(-0.05, -0.115, 0.0);
    const port = new THREE.Mesh(vmBox(0.056, 0.021, 0.003), metalDark);
    port.position.set(0.055, 0.055, 0.027);
    const frontSight = new THREE.Mesh(vmBox(0.012, 0.014, 0.008), metalDark);
    frontSight.position.set(0.13, 0.079, 0);
    const sightDot = new THREE.Mesh(new THREE.SphereGeometry(0.003, 6, 4), new THREE.MeshBasicMaterial({ color: 0xaebfb0 }));
    sightDot.position.set(0.126, 0.084, 0);
    const muzzleBore = new THREE.Mesh(new THREE.CircleGeometry(0.008, 12), metalDark);
    muzzleBore.rotation.y = Math.PI / 2; muzzleBore.position.set(0.201, 0.04, 0);
    for (let i = 0; i < 7; i++) {
      const serration = new THREE.Mesh(vmBox(0.003, 0.047, 0.053), metalDark);
      serration.position.set(-0.043 + i * 0.007, 0.04, 0);
      g.add(serration);
    }
    g.add(grip, slide, bbl, tg, sight, magBase, port, frontSight, sightDot, muzzleBore);
  } else if (type === 'shotgun') {
    g.userData.muzzle = [0.50, 0.03, 0];
    const stock = new THREE.Mesh(vmBox(0.22, 0.07, 0.05), wood);
    stock.position.set(-0.14, -0.02, 0.0);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 14), metal);
    barrel.rotation.z = Math.PI / 2; barrel.position.set(0.22, 0.03, 0.0);
    // Magazine tube under the barrel.
    const magTube = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.45, 12), metal);
    magTube.rotation.z = Math.PI / 2; magTube.position.set(0.18, -0.005, 0.0);
    // Pump action (chunky ribbed slider mid-barrel).
    const pump = new THREE.Mesh(vmBox(0.10, 0.045, 0.07), wood);
    pump.position.set(0.05, -0.005, 0.0);
    const grip = new THREE.Mesh(vmBox(0.06, 0.10, 0.05), wood);
    grip.position.set(-0.05, -0.06, 0.0);
    // Front bead sight.
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.010, 8, 6), metal);
    bead.position.set(0.49, 0.055, 0.0);
    g.add(stock, barrel, magTube, pump, grip, bead);
  } else if (type === 'smg') {
    g.userData.muzzle = [0.28, 0.02, 0];
    const body = new THREE.Mesh(vmBox(0.30, 0.07, 0.05), metal);
    body.position.set(0.04, 0.02, 0.0);
    const mag = new THREE.Mesh(vmBox(0.05, 0.12, 0.04), metalDark);
    mag.position.set(0.0, -0.06, 0.0);
    const grip = new THREE.Mesh(vmBox(0.04, 0.10, 0.05), metalDark);
    grip.position.set(-0.08, -0.05, 0.0);
    // Short barrel poking out the front.
    const bbl = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.10, 10), metal);
    bbl.rotation.z = Math.PI / 2; bbl.position.set(0.23, 0.02, 0.0);
    // Foregrip handle.
    const fore = new THREE.Mesh(vmBox(0.035, 0.07, 0.04), metalDark);
    fore.position.set(0.10, -0.025, 0.0);
    // Iron sight.
    const sight = new THREE.Mesh(vmBox(0.022, 0.025, 0.03), metalDark);
    sight.position.set(-0.05, 0.065, 0.0);
    g.add(body, mag, grip, bbl, fore, sight);
  } else if (type === 'machinegun') {
    g.userData.muzzle = [0.59, 0.03, 0];
    // Longer receiver, ribbed barrel, banana mag, stock — reads as a heavy
    // assault rifle / LMG distinct from the compact SMG silhouette.
    const stock = new THREE.Mesh(vmBox(0.18, 0.07, 0.05), metal);
    stock.position.set(-0.16, 0.0, 0.0);
    const receiver = new THREE.Mesh(vmBox(0.36, 0.09, 0.06), metal);
    receiver.position.set(0.04, 0.02, 0.0);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.40, 14), metal);
    barrel.rotation.z = Math.PI / 2; barrel.position.set(0.36, 0.03, 0.0);
    // Heat shroud/handguard ribs — three small bands along the barrel.
    for (let r = 0; r < 3; r++) {
      const rib = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.02, 12), metalDark);
      rib.rotation.z = Math.PI / 2; rib.position.set(0.22 + r * 0.08, 0.03, 0.0);
      g.add(rib);
    }
    const mag = new THREE.Mesh(vmBox(0.06, 0.18, 0.045), metalDark);
    mag.position.set(0.0, -0.10, 0.0); mag.rotation.z = -0.18;
    const grip = new THREE.Mesh(vmBox(0.045, 0.11, 0.05), metalDark);
    grip.position.set(-0.09, -0.06, 0.0);
    const sight = new THREE.Mesh(vmBox(0.04, 0.03, 0.04), metalDark);
    sight.position.set(0.06, 0.08, 0.0);
    // Flash hider on muzzle.
    const fh = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.020, 0.04, 10), metalDark);
    fh.rotation.z = Math.PI / 2; fh.position.set(0.57, 0.03, 0.0);
    g.add(stock, receiver, barrel, mag, grip, sight, fh);
  } else {
    const box = new THREE.Mesh(vmBox(0.1, 0.1, 0.1), metal);
    g.add(box);
  }
  // A rounded gloved grip and sleeved forearm anchor each weapon to the player.
  const glove = new THREE.MeshStandardMaterial({ color: 0x24282a, roughness: 0.92 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x161b1c, roughness: 0.9 });
  const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), glove);
  hand.scale.set(0.054, 0.064, 0.045);
  hand.position.set(-0.055, -0.07, 0.008);
  const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.048, 0.25, 4, 10), sleeve);
  forearm.rotation.z = Math.PI / 2 + 0.32;
  forearm.position.set(-0.23, -0.14, 0.018);
  g.add(hand, forearm);
  for (let i = 0; i < 4; i++) {
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.032, 3, 6), glove);
    finger.rotation.z = Math.PI / 2;
    finger.position.set(-0.027, -0.04 - i * 0.017, 0.038);
    g.add(finger);
  }
  if (['shotgun', 'smg', 'machinegun'].includes(type)) {
    const support = hand.clone();
    support.position.set(0.13, -0.052, -0.05);
    const supportArm = forearm.clone();
    supportArm.position.set(-0.035, -0.14, -0.075);
    supportArm.rotation.z = Math.PI / 2 - 0.26;
    g.add(support, supportArm);
  }
  prepareViewModel(g);
  // Hand-held offset (right-handed, slightly down, slightly forward of near plane).
  g.position.set(0, 0, 0);
  g.rotation.set(0, Math.PI / 2, 0);
  g.scale.setScalar(1.3);
  return g;
}

// Central Weapons controller: holds exactly one weapon (defaulting to fists),
// drives firing/melee, reload, view-model swap, pickup/drop, and HUD sync.
const Weapons = {
  current: 'fists',
  loaded: 0,     // rounds in magazine (0 for melee)
  reserve: 0,    // spare rounds in pool (0 for melee)
  cooldown: 0,
  reloading: 0,
  swingT: 0,     // 0..1 anim driver for melee/recoil kick
  punchIndex: 0, // toggled only by an actual fist swing, never by rendering
  melee: createMeleeState(),
  impactHold: 0,
  vmGroup: null, // THREE.Group attached to camera holding active view-model
  vmCache: {},
  basePos: new THREE.Vector3(0.22, -0.22, -0.36),
  aimBlend: 0,
  baseRot: new THREE.Euler(0, 0, 0),
  init() {
    this.vmGroup = new THREE.Group();
    this.vmGroup.name = 'weaponViewModel';
    camera.add(this.vmGroup);
    if (!scene.children.includes(camera)) scene.add(camera);
    this._setActiveVM('fists');
    this._syncHUD();
  },
  _vm(type) {
    if (!this.vmCache[type]) this.vmCache[type] = makeWeaponViewModel(type);
    return this.vmCache[type];
  },
  _setActiveVM(type) {
    while (this.vmGroup.children.length) this.vmGroup.remove(this.vmGroup.children[0]);
    this.vmGroup.add(this._vm(type));
    if (type === 'fists' || type === 'bat') {
      this.vmGroup.position.set(0, 0, 0); this.vmGroup.rotation.set(0, 0, 0);
      this.vmGroup.scale.setScalar(1);
      if (type === 'fists') poseFirstPersonHands(this._vm(type));
      else poseFirstPersonBat(this._vm(type));
    }
  },
  def() { return WEAPON_DEFS[this.current]; },
  ammoString() {
    const d = this.def();
    if (d.kind === 'melee') return '∞';
    return this.loaded + ' / ' + this.reserve;
  },
  _syncHUD() { HUD.setWeapon(this.def().name, this.ammoString()); },
  // Equip a weapon type with a given total ammo pool (loaded+reserve combined).
  // Fills the magazine first, the rest spills into reserve.
  _equip(type, totalAmmo) {
    if (!Object.hasOwn(WEAPON_DEFS, type)) return;
    this.cancelAttack();
    HUD.setReloading(false);
    this.aimBlend = 0;
    this.current = type;
    const d = WEAPON_DEFS[type];
    if (d.kind === 'melee') {
      this.loaded = 0; this.reserve = 0;
    } else {
      const total = Math.max(0, totalAmmo | 0);
      this.loaded = Math.min(d.mag, total);
      this.reserve = total - this.loaded;
    }
    this.cooldown = 0.15;
    this.reloading = 0;
    this.swingT = 0;
    if (type === 'fists') this.punchIndex = 0;
    this._setActiveVM(d.vm);
    this._syncHUD();
  },
  // Total ammo currently held for the active weapon (loaded + reserve).
  totalAmmo() { return this.loaded + this.reserve; },
  /** Supplies add reserve only; collecting never equips a gun or fills its magazine. */
  acceptReserveAmmo(amount, maxReserve = 999) {
    if (this.def().kind !== 'ranged' || !Number.isFinite(amount) || !Number.isFinite(maxReserve)) return 0;
    const accepted = Math.max(0, Math.min(Math.floor(amount), Math.min(999, Math.floor(maxReserve)) - this.reserve));
    if (accepted <= 0) return 0;
    this.reserve += accepted;
    this._syncHUD();
    return accepted;
  },
  snapshot() { return { current: this.current, loaded: this.loaded, reserve: this.reserve }; },
  restore(snapshot) {
    const value = sanitizeWeaponSnapshot(snapshot);
    this._equip(value.current, value.loaded + value.reserve);
    this.loaded = value.loaded; this.reserve = value.reserve;
    this.cooldown = 0; this.reloading = 0; this.swingT = 0;
    HUD.setReloading(false); this._syncHUD();
  },
  // PERF: scratch vectors so firing allocates nothing.
  _scratch: {
    origin: new THREE.Vector3(), fwd: new THREE.Vector3(),
    muzzle: new THREE.Vector3(), dir: new THREE.Vector3(),
    end: new THREE.Vector3(),
    wallRay: new THREE.Ray(new THREE.Vector3(), new THREE.Vector3()),
    wallHit: new THREE.Vector3(),
    meleeHit: { enemy: null, part: 'body', point: new THREE.Vector3(), dist: 0 },
  },
  // Fire one shot from the held ranged weapon. Caller verifies cooldown/loaded.
  _fireRanged() {
    const d = this.def();
    const s = this._scratch;
    s.origin.copy(camera.position);
    camera.getWorldDirection(s.fwd);
    // Effects originate at the visible barrel, including hip-fire/aim offsets.
    // Hitscan still uses the camera so the reticle remains the aiming reference.
    if (!getViewModelMuzzle(this._vm(this.current), s.muzzle)) {
      s.muzzle.copy(s.origin).addScaledVector(s.fwd, 0.55);
    }
    FX.muzzleFlash(s.muzzle);
    const pellets = d.pellets || 1;
    let anyHit = false;
    let killed = false, headshot = false;
    const spread = d.spread * (Player.aiming ? 0.30 : 1);
    for (let i = 0; i < pellets; i++) {
      s.dir.copy(s.fwd);
      s.dir.x += (Math.random() - 0.5) * spread * 2;
      s.dir.y += (Math.random() - 0.5) * spread * 2;
      s.dir.z += (Math.random() - 0.5) * spread * 2;
      s.dir.normalize();
      const hit = raycastEnemies(s.origin, s.dir, d.range);
      if (hit) {
        s.end.copy(hit.point);
        const wasAlive = hit.enemy.alive;
        damageEnemy(hit.enemy, d.dmg, hit.part, hit.point);
        if (wasAlive && !hit.enemy.alive) {
          killed = true;
          CombatStats.recordKill(hit.part === 'head');
        }
        headshot = headshot || hit.part === 'head';
        anyHit = true;
      } else {
        // Cheap world raycast so wall misses spawn an impact spark at the
        // first collider face the bullet would strike. Scratch ray reused.
        s.wallRay.origin.copy(s.origin); s.wallRay.direction.copy(s.dir);
        let wallDist = d.range;
        let wallFound = false;
        const list = Colliders.list;
        for (let bi = 0, bn = list.length; bi < bn; bi++) {
          if (s.wallRay.intersectBox(list[bi], s.wallHit)) {
            const dd = s.wallHit.distanceTo(s.origin);
            if (dd < wallDist) { wallDist = dd; wallFound = true; s.end.copy(s.wallHit); }
          }
        }
        if (wallFound) {
          FX.impact(s.end.x, s.end.y, s.end.z, 4);
        } else {
          s.end.copy(s.origin).addScaledVector(s.dir, d.range);
        }
      }
      FX.tracer(s.muzzle, s.end);
    }
    CombatStats.recordShot(anyHit);
    if (anyHit) HUD.hit?.({ killed, headshot });
    const recoil = d.recoil * (Player.aiming ? 0.32 : 0.50);
    Player.pitch = clamp(Player.pitch + recoil, -1.5, 1.5);
    Player.yaw += (Math.random() - 0.5) * recoil * 0.24;
    this.loaded -= 1;
    this.cooldown = d.rate;
    this.swingT = 1.0;
    if (Audio[d.sound]) Audio[d.sound]();
    this._syncHUD();
    return anyHit;
  },
  cancelAttack() {
    cancelMelee(this.melee);
    this.impactHold = 0;
    this.swingT = 0;
  },
  // Windup starts now; target, range and cover are evaluated only at contact.
  _swingMelee(type = this.current) {
    if (PlayerState.dead || this.cooldown > 0 || this.reloading > 0 || !beginMelee(this.melee, type, this.current)) return false;
    const d = WEAPON_DEFS[type];
    this.cooldown = d.rate;
    this.swingT = 1;
    this.impactHold = 0;
    if (type === 'fists') this.punchIndex = (this.punchIndex + 1) & 1;
    return true;
  },
  _commitMeleeContact() {
    const d = WEAPON_DEFS[this.melee.type];
    if (PlayerState.dead || this.melee.owner !== this.current || !d) return false;
    const s = this._scratch;
    s.origin.copy(camera.position);
    camera.getWorldDirection(s.fwd);
    const best = s.meleeHit;
    best.enemy = null; best.dist = Infinity;
    // A short fan makes close combat forgiving without striking enemies
    // behind the player. Each ray performs its own current wall/cover check.
    const rayCount = d.contactArc > 0 ? 3 : 1;
    for (let index = 0; index < rayCount; index++) {
      const angle = index === 0 ? 0 : index === 1 ? -d.contactArc : d.contactArc;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      s.dir.set(s.fwd.x * cosine + s.fwd.z * sine, s.fwd.y, -s.fwd.x * sine + s.fwd.z * cosine);
      const hit = raycastEnemies(s.origin, s.dir, d.range);
      if (hit && hit.dist < best.dist) {
        best.enemy = hit.enemy; best.part = hit.part; best.point.copy(hit.point); best.dist = hit.dist;
      }
    }
    if (!best.enemy) return false;
    const wasAlive = best.enemy.alive;
    damageEnemy(best.enemy, d.dmg, best.part, best.point);
    const killed = wasAlive && !best.enemy.alive;
    if (killed) CombatStats.recordKill(false);
    HUD.hit?.({ killed, headshot: false });
    // Only the held pose pauses briefly at impact; the world and input keep
    // advancing, so this feedback cannot grant invulnerability or extra hits.
    this.impactHold = this.melee.type === 'bat' ? 0.028 : 0.018;
    if (Audio[d.sound]) Audio[d.sound]();
    return true;
  },
  startReload() {
    const d = this.def();
    if (d.kind !== 'ranged') return false;
    if (this.reloading > 0) return false;
    if (this.loaded >= d.mag) return false;
    if (this.reserve <= 0) return false;
    this.cancelAttack();
    this.reloading = d.reloadTime;
    HUD.setReloading(true);
    Audio.reloadClack();
    return true;
  },
  _finishReload() {
    const d = this.def();
    const next = reloadMagazine(this.loaded, this.reserve, d.mag);
    this.loaded = next.loaded;
    this.reserve = next.reserve;
    this.reloading = 0;
    HUD.setReloading(false);
    this._syncHUD();
  },
  // One E press selects one reachable object, whether a drop or a reserve cache.
  findNearestPickup(maxDist = 1.8) {
    if (PlayerState.dead) return null;
    let best = null, bestD = maxDist * maxDist;
    const origin = this._scratch.origin;
    origin.set(Player.pos.x, Player.pos.y - Player._eyeH + 0.95, Player.pos.z);
    for (const e of WeaponDrops.list) {
      if (!canPickupWeapon(this.current, e)) continue;
      const d2 = e.mesh.position.distanceToSquared(origin);
      if (d2 < bestD && !isSegmentOccluded(origin, e.mesh.position, Colliders.list)) { bestD = d2; best = e; }
    }
    const cache = AmmoSupplies.findNearest(this, maxDist);
    if (cache && cache.interactionPosition.distanceToSquared(origin) < bestD) best = cache;
    return best;
  },
  // Pickup logic: same-type merges ammo; different type drops current weapon
  // (preserving its remaining ammo) and equips the new one.
  pickup(drop) {
    if (PlayerState.dead) return false;
    if (drop?.kind === 'ammoSupply') {
      const accepted = AmmoSupplies.pickup(drop, this, (amount, cap) => this.acceptReserveAmmo(amount, cap));
      if (!accepted) return false;
      Audio.pickupChime();
      HUD.message(`+${accepted} ${this.def().name} RESERVE`, 1.5);
      return true;
    }
    if (!WeaponDrops.list.includes(drop)) return false;
    if (!canPickupWeapon(this.current, drop)) return false;
    const newType = drop.weaponType;
    const newAmmo = drop.ammo | 0;
    if (this.current === newType) {
      // Same type: merge ammo into the held weapon's pool.
      const d = WEAPON_DEFS[newType];
      if (d.kind === 'ranged') {
        this.reserve = Math.min(999, this.reserve + newAmmo);
      }
      WeaponDrops.remove(drop);
      Audio.pickupChime();
      HUD.message('+ ' + d.name + ' AMMO', 1.2);
      this._syncHUD();
      return true;
    }
    // Different type: drop the currently held weapon at the player's feet
    // (only if it carries pickup value — fists are never dropped).
    if (this.current !== 'fists') {
      const heldTotal = this.totalAmmo();
      const footY = Player.pos.y - Player._eyeH;
      WeaponDrops.spawn(Player.pos.x, footY, Player.pos.z, this.current, heldTotal);
    }
    // Consume the picked-up drop and equip it.
    WeaponDrops.remove(drop);
    this._equip(newType, newAmmo);
    Audio.pickupChime();
    HUD.message('PICKED UP ' + WEAPON_DEFS[newType].name, 1.4);
    return true;
  },
  // Voluntary drop (G key): drop current weapon to the world; revert to fists.
  dropCurrent() {
    if (this.current === 'fists') return false;
    const heldTotal = this.totalAmmo();
    const type = this.current;
    const footY = Player.pos.y - Player._eyeH;
    WeaponDrops.spawn(Player.pos.x, footY, Player.pos.z, type, heldTotal);
    this._equip('fists', 0);
    HUD.message('DROPPED ' + WEAPON_DEFS[type].name, 1.1);
    return true;
  },
  // Per-frame: cooldowns, reload progression, view-model animation,
  // pickup-prompt visibility. Input handling lives in handleInput().
  tick(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (PlayerState.dead || (this.melee.active && this.melee.owner !== this.current)) this.cancelAttack();
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this._finishReload();
    }
    this.impactHold = Math.max(0, this.impactHold - dt);
    if (this.melee.active) {
      if (advanceMelee(this.melee, dt)) this._commitMeleeContact();
      this.swingT = this.impactHold > 0 && this.melee.active
        ? 1 - WEAPON_DEFS[this.melee.type].contactPhase : meleeRemaining(this.melee);
    } else if (this.swingT > 0) {
      const decay = this.current === 'fists' ? 1 / FIRST_PERSON_PUNCH_SECONDS : 5.5;
      this.swingT = Math.max(0, this.swingT - dt * decay);
    }
  },
  update(dt) {
    const targetAim = Player.aiming && this.def().kind === 'ranged' && this.reloading <= 0 ? 1 : 0;
    this.aimBlend = lerp(this.aimBlend, targetAim, 1 - Math.exp(-dt * 14));
    const fov = Settings.get('fov') - this.aimBlend * 20;
    if (Math.abs(camera.fov - fov) > 0.02) { camera.fov = fov; camera.updateProjectionMatrix(); }
    document.getElementById('crosshair')?.classList.toggle('aiming', this.aimBlend > 0.7);
    // View-model bob is visual only and respects reduced-motion preferences.
    if (this.vmGroup) {
      if (this.current === 'fists' || this.current === 'bat') {
        // Hands are authored in camera space. The legacy gun offset/scale
        // would move them towards the near plane and enlarge them again.
        this.vmGroup.position.set(0, 0, 0); this.vmGroup.rotation.set(0, 0, 0);
        this.vmGroup.scale.setScalar(1);
        const movement = clamp(Math.hypot(Player.vel.x, Player.vel.z) / Player.speedSprint, 0, 1);
        if (this.current === 'fists') {
          poseFirstPersonHands(this._vm('fists'), this.swingT, this.punchIndex, GameTime.elapsed, movement, Settings.get('reducedMotion'));
        } else {
          poseFirstPersonBat(this._vm('bat'), this.swingT, GameTime.elapsed, movement, Settings.get('reducedMotion'));
        }
      } else {
        const speed = Math.hypot(Player.vel.x, Player.vel.z);
        const bobAmt = Settings.get('reducedMotion') ? 0 : clamp(speed / Player.speedSprint, 0, 1) * (1 - this.aimBlend * 0.9);
        const t = GameTime.elapsed * 8.5;
        const bx = Math.cos(t) * 0.012 * bobAmt;
        const by = Math.abs(Math.sin(t)) * 0.018 * bobAmt;
        const kick = Settings.get('reducedMotion') ? 0 : this.swingT * this.swingT;
        const reloadProgress = this.reloading > 0 ? this.reloading / this.def().reloadTime : 0;
        const reloadDip = Math.sin(reloadProgress * Math.PI);
        this.vmGroup.position.set(
          lerp(this.basePos.x, 0, this.aimBlend) + bx,
          lerp(this.basePos.y, -0.12, this.aimBlend) + by - kick * 0.026 - reloadDip * 0.18,
          this.basePos.z + kick * 0.055,
        );
        this.vmGroup.rotation.set(
          this.baseRot.x + kick * 0.16 - reloadDip * 0.4,
          this.baseRot.y,
          this.baseRot.z - reloadDip * 0.3,
        );
      }
    }
    // Pickup prompt: show when standing near a drop.
    const near = this.findNearestPickup(1.8);
    if (near) {
      HUD.setPickupPrompt(near.kind === 'ammoSupply' ? AmmoSupplies.prompt(near, this) : weaponPickupPrompt(this.current, near));
    } else {
      HUD.setPickupPrompt(null);
    }
  },
  // Wired from playerUpdate(): consumes already-extracted input flags.
  handleInput(inp, dt) {
    if (inp.ePressed) {
      const near = this.findNearestPickup(1.8);
      if (near) this.pickup(near);
    }
    if (inp.gPressed) this.dropCurrent();
    if (inp.rPressed) this.startReload();
    // V always triggers melee (with fists if a ranged weapon is held).
    if (inp.vPressed && this.cooldown <= 0 && this.reloading <= 0) {
      // Use fists damage/range for off-hand melee when holding a ranged gun.
      if (this.def().kind === 'ranged') {
        this._swingMelee('fists');
      } else {
        this._swingMelee();
      }
    }
    // Primary attack: LMB. Ranged fires, melee swings, full-auto weapons
    // repeat on leftDown.
    const d = this.def();
    const wantsFire = d.full ? inp.leftDown : inp.leftPressed;
    if (wantsFire && this.cooldown <= 0 && this.reloading <= 0) {
      if (d.kind === 'ranged') {
        if (this.loaded > 0) {
          this._fireRanged();
        } else if (inp.leftPressed) {
          Audio.dryClick();
          this.cooldown = 0.25;
          if (this.reserve > 0) this.startReload();
        }
      } else {
        this._swingMelee();
      }
    }
  },
};

export { Weapons, WeaponDrops, WEAPON_DEFS, makeWeaponViewModel };
