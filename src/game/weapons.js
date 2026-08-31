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
import { Ballistics, createBallisticHit } from '../core/ballistics.js';
import { World, currentZone } from '../world/world.js';
import { raycastEnemies, damageEnemy } from './enemies.js';
import { FX } from '../render/effects.js';
import { prepareViewModel, getViewModelMuzzle } from '../render/viewmodel.js';
import { createFirstPersonHands, poseFirstPersonHands, FIRST_PERSON_PUNCH_SECONDS } from '../render/first-person-hands.js';
import { createFirstPersonBat, poseFirstPersonBat } from '../render/first-person-bat.js';
import { createBatAsset, BAT_DIMENSIONS } from '../render/bat-asset.js';
import { getWeaponFinishes, batchStaticWeaponParts } from '../render/weapon-finishes.js';
import { createHeroWeapon } from '../render/hero-weapons.js';
import { addHeroWeaponHands } from '../render/hero-weapon-grips.js';
import { createDroppedWeaponAsset, warmDroppedWeaponAssets } from '../render/dropped-weapon-assets.js';

// ── Weapon drops ────────────
// Static pickups share the authored NPC firearm/knife surfaces. Placement
// nodes are independent; collecting/removing a drop never disposes the cached
// geometry or alters the matching held weapon. Firearms use two draws each.
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
    warmDroppedWeaponAssets(type => this._mat(type));
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
    const material = this._mat(weaponType);
    const authored = createDroppedWeaponAsset(weaponType, material);
    if (authored) return authored;
    const group = new THREE.Group();
    const fallback = new THREE.Mesh(this._geos().box1, material);
    fallback.scale.set(0.2, 0.14, 0.05); fallback.castShadow = true;
    group.add(fallback);
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
  const model = createHeroWeapon(type);
  addHeroWeaponHands(model, type);
  // Owned profile meshes and connected grip hands are assembled only once.
  // Preserve the established rigid animation, framing and exact muzzle anchors.
  batchStaticWeaponParts(model);
  prepareViewModel(model);
  model.position.set(0, 0, 0);
  model.rotation.set(0, Math.PI / 2, 0);
  model.scale.setScalar(1.3);
  return model;
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
  vmType: null,  // off-hand punches temporarily show fists without changing the slot
  vmCache: {},
  basePos: new THREE.Vector3(0.22, -0.22, -0.36),
  aimBlend: 0,
  baseRot: new THREE.Euler(0, 0, 0),
  init() {
    // Bake once during setup, not at the first weapon pickup during combat.
    getWeaponFinishes();
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
    this.vmType = type;
    if (type === 'fists' || type === 'bat') {
      this.vmGroup.position.set(0, 0, 0); this.vmGroup.rotation.set(0, 0, 0);
      this.vmGroup.scale.setScalar(1);
      if (type === 'fists') poseFirstPersonHands(this._vm(type));
      else poseFirstPersonBat(this._vm(type));
    } else {
      // Restore the firearm's camera-space anchor immediately: another fixed
      // simulation step can fire before the next visual update runs.
      this.vmGroup.position.set(lerp(this.basePos.x, 0, this.aimBlend),
        lerp(this.basePos.y, -0.12, this.aimBlend), this.basePos.z);
      this.vmGroup.rotation.copy(this.baseRot);
      this.vmGroup.scale.setScalar(1);
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
    end: new THREE.Vector3(), barrelDirection: new THREE.Vector3(), travelDirection: new THREE.Vector3(),
    worldHit: createBallisticHit(), barrelHit: createBallisticHit(), muzzleHit: createBallisticHit(),
    meleeWorldHit: createBallisticHit(),
    meleeHit: { enemy: null, part: 'body', point: new THREE.Vector3(), dist: 0 },
    worldSound: { surface: 'concrete', intensity: 0.7, pos: new THREE.Vector3(), environment: '' },
    bodySound: { surface: 'body', intensity: 0.42, pos: new THREE.Vector3(), environment: '' },
    shotSound: { environment: '' },
  },
  // Fire one shot from the held ranged weapon. Caller verifies cooldown/loaded.
  _fireRanged() {
    const d = this.def();
    const s = this._scratch;
    s.origin.copy(camera.position);
    camera.getWorldDirection(s.fwd);
    // Effects originate at the visible barrel, including hip-fire/aim offsets.
    // The camera selects the aim point; the muzzle still cannot shoot through
    // nearby furniture or start a round on the far side of a wall.
    if (!getViewModelMuzzle(this._vm(this.current), s.muzzle)) {
      s.muzzle.copy(s.origin).addScaledVector(s.fwd, 0.55);
    }
    s.barrelDirection.copy(s.muzzle).sub(s.origin);
    const barrelLength = s.barrelDirection.length();
    const barrelBlocked = barrelLength > 1e-5
      && Boolean(Ballistics.raycast(s.origin, s.barrelDirection, barrelLength, 'bullet', s.barrelHit));
    FX.muzzleFlash(s.muzzle);
    const pellets = d.pellets || 1;
    let anyHit = false;
    let damageDealt = 0;
    let killed = false, headshot = false;
    let worldSoundDistance = Infinity, bodySoundDistance = Infinity;
    const spread = d.spread * (Player.aiming ? 0.30 : 1);
    for (let i = 0; i < pellets; i++) {
      s.dir.copy(s.fwd);
      s.dir.x += (Math.random() - 0.5) * spread * 2;
      s.dir.y += (Math.random() - 0.5) * spread * 2;
      s.dir.z += (Math.random() - 0.5) * spread * 2;
      s.dir.normalize();
      const worldHit = barrelBlocked ? null : Ballistics.raycast(s.origin, s.dir, d.range, 'bullet', s.worldHit);
      let hit = barrelBlocked ? null : raycastEnemies(s.origin, s.dir, d.range, worldHit?.distance ?? d.range);
      let impact = barrelBlocked ? s.barrelHit : worldHit;
      if (hit) s.end.copy(hit.point);
      else if (impact) s.end.copy(impact.point);
      else s.end.copy(s.origin).addScaledVector(s.dir, d.range);
      if (!barrelBlocked) {
        s.travelDirection.copy(s.end).sub(s.muzzle);
        const travel = s.travelDirection.length();
        const obstruction = travel > 1e-4
          ? Ballistics.raycast(s.muzzle, s.travelDirection, travel - 1e-4, 'bullet', s.muzzleHit) : null;
        if (obstruction) { hit = null; impact = obstruction; s.end.copy(obstruction.point); }
      }
      if (hit) {
        const wasAlive = hit.enemy.alive;
        const result = damageEnemy(hit.enemy, d.dmg, hit.part, hit.point);
        damageDealt += result?.damage ?? 0;
        if (wasAlive && !hit.enemy.alive) {
          killed = true;
          CombatStats.recordKill(hit.part === 'head', this.current);
        }
        headshot = headshot || hit.part === 'head';
        anyHit = true;
        const distance = s.origin.distanceToSquared(hit.point);
        if (distance < bodySoundDistance) {
          bodySoundDistance = distance;
          s.bodySound.pos.copy(hit.point);
        }
      } else if (impact) {
        FX.impact(s.end.x, s.end.y, s.end.z, 4, impact);
        const distance = s.origin.distanceToSquared(impact.point);
        if (distance < worldSoundDistance) {
          worldSoundDistance = distance;
          s.worldSound.pos.copy(impact.point);
          s.worldSound.surface = impact.surfaceKind;
        }
      }
      FX.tracer(barrelBlocked ? s.origin : s.muzzle, s.end);
    }
    CombatStats.recordShot(anyHit, this.current, damageDealt);
    if (anyHit) HUD.hit?.({ killed, headshot });
    const recoil = d.recoil * (Player.aiming ? 0.32 : 0.50);
    Player.pitch = clamp(Player.pitch + recoil, -1.5, 1.5);
    Player.yaw += (Math.random() - 0.5) * recoil * 0.24;
    this.loaded -= 1;
    this.cooldown = d.rate;
    this.swingT = 1.0;
    s.shotSound.environment = currentZone;
    if (Audio[d.sound]) Audio[d.sound](s.shotSound);
    // A shotgun may make many real contacts, but one trigger pull must not
    // stack a full-volume sound for every pellet on the same piece of cover.
    if (Number.isFinite(worldSoundDistance)) {
      s.worldSound.environment = currentZone;
      Audio.impact(s.worldSound);
    }
    if (Number.isFinite(bodySoundDistance)) {
      s.bodySound.environment = currentZone;
      Audio.impact(s.bodySound);
    }
    this._syncHUD();
    return anyHit;
  },
  cancelAttack() {
    cancelMelee(this.melee);
    this.impactHold = 0;
    this.swingT = 0;
    if (this.vmGroup && this.vmType !== this.def().vm) this._setActiveVM(this.def().vm);
  },
  // Windup starts now; target, range and cover are evaluated only at contact.
  _swingMelee(type = this.current) {
    if (PlayerState.dead || this.cooldown > 0 || this.reloading > 0 || !beginMelee(this.melee, type, this.current)) return false;
    const d = WEAPON_DEFS[type];
    this.cooldown = d.rate;
    this.swingT = 1;
    this.impactHold = 0;
    if (type === 'fists') this.punchIndex = (this.punchIndex + 1) & 1;
    if (this.vmGroup && this.vmType !== d.vm) this._setActiveVM(d.vm);
    Audio.meleeSwing({ weapon: type, intensity: type === 'bat' ? 1 : 0.65, environment: currentZone });
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
    s.meleeWorldHit.distance = Infinity;
    // A short fan makes close combat forgiving without striking enemies
    // behind the player. Each ray performs its own current wall/cover check.
    const rayCount = d.contactArc > 0 ? 3 : 1;
    for (let index = 0; index < rayCount; index++) {
      const angle = index === 0 ? 0 : index === 1 ? -d.contactArc : d.contactArc;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      s.dir.set(s.fwd.x * cosine + s.fwd.z * sine, s.fwd.y, -s.fwd.x * sine + s.fwd.z * cosine);
      const worldHit = Ballistics.raycast(s.origin, s.dir, d.range, 'bullet', s.worldHit);
      const hit = raycastEnemies(s.origin, s.dir, d.range, worldHit?.distance ?? d.range);
      if (hit && hit.dist < best.dist) {
        best.enemy = hit.enemy; best.part = hit.part; best.point.copy(hit.point); best.dist = hit.dist;
      }
      if (worldHit && worldHit.distance < s.meleeWorldHit.distance) {
        s.meleeWorldHit.distance = worldHit.distance;
        s.meleeWorldHit.point.copy(worldHit.point);
        s.meleeWorldHit.normal.copy(worldHit.normal);
        s.meleeWorldHit.surfaceKind = worldHit.surfaceKind;
        s.meleeWorldHit.material = worldHit.material;
      }
    }
    if (!best.enemy) {
      CombatStats.recordMelee(false, this.melee.type);
      if (Number.isFinite(s.meleeWorldHit.distance)) {
        const hit = s.meleeWorldHit;
        Audio.impact({ surface: hit.surfaceKind, pos: hit.point, intensity: 0.65, environment: currentZone });
        FX.impact(hit.point.x, hit.point.y, hit.point.z, 2, hit);
        this.impactHold = 0.018;
      }
      return false;
    }
    const wasAlive = best.enemy.alive;
    const result = damageEnemy(best.enemy, d.dmg, best.part, best.point);
    CombatStats.recordMelee(true, this.melee.type, result?.damage ?? 0);
    const killed = wasAlive && !best.enemy.alive;
    if (killed) CombatStats.recordKill(false, this.melee.type);
    HUD.hit?.({ killed, headshot: false });
    // Only the held pose pauses briefly at impact; the world and input keep
    // advancing, so this feedback cannot grant invulnerability or extra hits.
    this.impactHold = this.melee.type === 'bat' ? 0.028 : 0.018;
    if (Audio[d.sound]) Audio[d.sound]({ weapon: this.melee.type, pos: best.point,
      intensity: this.melee.type === 'bat' ? 1 : 0.75, environment: currentZone });
    return true;
  },
  startReload() {
    const d = this.def();
    if (PlayerState.dead || d.kind !== 'ranged') return false;
    if (this.reloading > 0) return false;
    if (this.loaded >= d.mag) return false;
    if (this.reserve <= 0) return false;
    this.cancelAttack();
    this.reloading = d.reloadTime;
    HUD.setReloading(true);
    Audio.weaponMechanical({ weapon: this.current, action: 'reload-start', environment: currentZone });
    return true;
  },
  _finishReload() {
    const d = this.def();
    const next = reloadMagazine(this.loaded, this.reserve, d.mag);
    this.loaded = next.loaded;
    this.reserve = next.reserve;
    this.reloading = 0;
    Audio.weaponMechanical({ weapon: this.current, action: 'reload-end', environment: currentZone });
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
      Audio.pickupChime({ kind: 'ammo', weapon: this.current, environment: currentZone });
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
      Audio.pickupChime({ kind: 'ammo', weapon: newType, environment: currentZone });
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
    // One contextual cue owns the lift and handling: a second equip event
    // would double the same mechanism, and melee pickups need their own foley.
    Audio.pickupChime({ kind: 'weapon', weapon: newType, environment: currentZone });
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
    if (PlayerState.dead) { this.cancelAttack(); return; }
    if (this.melee.active && this.melee.owner !== this.current) this.cancelAttack();
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      const previous = this.reloading;
      this.reloading -= dt;
      const insertAt = this.def().reloadTime * 0.34;
      if (previous > insertAt && this.reloading <= insertAt) {
        Audio.weaponMechanical({ weapon: this.current, action: 'reload-insert', environment: currentZone });
      }
      if (this.reloading <= 0) this._finishReload();
    }
    this.impactHold = Math.max(0, this.impactHold - dt);
    if (this.melee.active) {
      if (advanceMelee(this.melee, dt)) this._commitMeleeContact();
      this.swingT = this.impactHold > 0 && this.melee.active
        ? 1 - WEAPON_DEFS[this.melee.type].contactPhase : meleeRemaining(this.melee);
      if (!this.melee.active && this.vmGroup && this.vmType !== this.def().vm) this._setActiveVM(this.def().vm);
    } else if (this.swingT > 0) {
      const decay = this.current === 'fists' ? 1 / FIRST_PERSON_PUNCH_SECONDS : 5.5;
      this.swingT = Math.max(0, this.swingT - dt * decay);
    }
  },
  update(dt) {
    const targetAim = Player.aiming && this.def().kind === 'ranged' && this.reloading <= 0 && !this.melee.active ? 1 : 0;
    this.aimBlend = lerp(this.aimBlend, targetAim, 1 - Math.exp(-dt * 14));
    const fov = Settings.get('fov') - this.aimBlend * 20;
    if (Math.abs(camera.fov - fov) > 0.02) { camera.fov = fov; camera.updateProjectionMatrix(); }
    document.getElementById('crosshair')?.classList.toggle('aiming', this.aimBlend > 0.7);
    // View-model bob is visual only and respects reduced-motion preferences.
    if (this.vmGroup) {
      const viewType = this.melee.active ? this.melee.type : this.current;
      if (viewType === 'fists' || viewType === 'bat') {
        // Hands are authored in camera space. The legacy gun offset/scale
        // would move them towards the near plane and enlarge them again.
        this.vmGroup.position.set(0, 0, 0); this.vmGroup.rotation.set(0, 0, 0);
        this.vmGroup.scale.setScalar(1);
        const movement = clamp(Math.hypot(Player.vel.x, Player.vel.z) / Player.speedSprint, 0, 1);
        if (viewType === 'fists') {
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
    if (PlayerState.dead) return;
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
    // A quick tap can be released before the next simulation step. Preserve
    // its press edge for every weapon; automatic weapons also repeat on hold.
    const d = this.def();
    const wantsFire = inp.leftPressed || (d.full && inp.leftDown);
    if (wantsFire && this.cooldown <= 0 && this.reloading <= 0 && !this.melee.active) {
      if (d.kind === 'ranged') {
        if (this.loaded > 0) {
          this._fireRanged();
        } else if (inp.leftPressed) {
          Audio.dryClick({ weapon: this.current, environment: currentZone });
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
