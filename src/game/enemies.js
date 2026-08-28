import * as THREE from 'three';
import { lerp, smoothstep } from '../core/math.js';
import { scene, camera, renderer, GameTime } from '../core/renderer.js';
import { makeHumanoid } from '../render/models.js';
import { attachHeldWeapon, resetHumanoidPose, updateHumanoidPose } from '../render/humanoid-rig.js';
import { beginHumanoidCollapse, updateHumanoidCollapse } from '../render/corpse-pose.js';
import { Player, PlayerState } from './player.js';
import { Audio } from '../core/audio.js';
import { Colliders, resolveCapsuleAABB } from '../core/collision.js';
import { World } from '../world/world.js';
import { BUILDING, BALCONY, ROOF } from '../world/layout.js';
import { DISTRICT } from '../world/district-layout.js';
import { WeaponDrops } from './weapons.js';
import { Blood, FX } from '../render/effects.js';
import { applyPlayerDamage, surfaceTopAt } from './mission.js';
import { ZONE_WAVE_CONFIG, FINAL_ENCOUNTERS } from './mission-data.js';
import { EnemyNavigationPlanner, createNavigationAgent, enemyPoolCapacity, investigationMemorySeconds, updateSightCache } from './enemy-navigation.js';
import { createStairPursuit, stairPursuitWaypoint, stairPursuitMemorySeconds, resetStairPursuit, primeEnemyInvestigation } from './stair-pursuit.js';
import {
  CORPSE_LIMIT, CORPSE_LIFETIME, damageForHit, advanceAttackWindup,
  updateAwareness, canMeleeHit, isSegmentOccluded, oldestCorpseIndex, invalidateEnemy,
} from './combat-rules.js';

// Enemy archetypes separate presentation from movement and attack tuning.
// Attack windups and memory use simulation time, so pausing freezes combat.
const ENEMY_TYPES = {
  thug: {
    label: 'thug', maxHealth: 60,
    visual: { skin: '#c39780', shirt: '#41464a', shirtAccent: '#6a5a51',
      pants: '#2b3036', hair: '#0e0a08', height: 1.82, build: 1.05, kind: 'thug' },
    speed: 3.6, alertRange: 18, attackRange: 1.7, attack: 'melee',
    swingTime: 0.55, attackCooldown: 1.1, damage: 14,
    weaponType: 'bat', ammo: 0,
  },
  brawler: {
    label: 'brawler', maxHealth: 50,
    visual: { skin: '#c09072', shirt: '#646558', shirtAccent: '#868779',
      pants: '#353b3f', hair: '#211c18', height: 1.78, build: 1, kind: 'brawler' },
    speed: 4, alertRange: 18, attackRange: 1.2, attack: 'melee',
    swingTime: 0.46, attackCooldown: 0.85, damage: 9,
    weaponType: 'fists', ammo: 0,
  },
  gunman: {
    label: 'gunman', maxHealth: 50,
    visual: { skin: '#b89876', shirt: '#3f4652', shirtAccent: '#66707a',
      pants: '#2c323b', hair: '#1a1208', height: 1.76, build: 0.98, kind: 'gunman' },
    speed: 3.0, alertRange: 26, attackRange: 18, attack: 'hitscan',
    fireInterval: 1.05, aimTime: 0.4, burst: 1, spread: 0.08, damage: 12,
    weaponType: 'pistol', ammo: 9, holdDistance: 9,
  },
  bruiser: {
    label: 'bruiser', maxHealth: 110,
    visual: { skin: '#b78a72', shirt: '#51483b', shirtAccent: '#766957',
      pants: '#34342e', hair: '#1a0e08', height: 1.94, build: 1.32, kind: 'bruiser' },
    speed: 2.6, alertRange: 22, attackRange: 9, attack: 'hitscan',
    fireInterval: 1.6, aimTime: 0.65, burst: 4, burstDelay: 0.06, spread: 0.16, damage: 8,
    weaponType: 'shotgun', ammo: 6, holdDistance: 5,
  },
  hitman: {
    label: 'hitman', maxHealth: 55,
    visual: { skin: '#a88068', shirt: '#37434b', shirtAccent: '#576976',
      pants: '#29323a', hair: '#080808', height: 1.78, build: 1.0, kind: 'hitman' },
    speed: 3.6, alertRange: 24, attackRange: 16, attack: 'hitscan',
    fireInterval: 1.3, aimTime: 0.45, burst: 6, burstDelay: 0.07, spread: 0.10, damage: 7,
    weaponType: 'smg', ammo: 30, holdDistance: 8,
  },
  // Heavy gunner — slower, tougher, carries the full-auto machine gun. Spawns
  // in late street/roof waves so the player can reliably pick the weapon up.
  enforcer: {
    label: 'enforcer', maxHealth: 140,
    visual: { skin: '#b08068', shirt: '#424a45', shirtAccent: '#6b705c',
      pants: '#2c3434', hair: '#08060a', height: 1.92, build: 1.28, kind: 'bruiser' },
    speed: 2.8, alertRange: 28, attackRange: 22, attack: 'hitscan',
    fireInterval: 1.4, aimTime: 0.7, burst: 8, burstDelay: 0.09, spread: 0.09, damage: 9,
    weaponType: 'machinegun', ammo: 50, holdDistance: 10,
  },
};

const EnemyNavigation = new EnemyNavigationPlanner({
  bounds: {
    x1: Math.min(BUILDING.tower.x1, ROOF.x1, DISTRICT.bounds.x1) - 1,
    x2: Math.max(ROOF.x2, DISTRICT.bounds.x2) + 1,
    z1: ROOF.z1 - 1,
    z2: DISTRICT.bounds.z2 + 1,
  },
});

// ── Enemy attachment: shared weapon prop on the unscaled right grip ─────────
function attachEnemyWeapon(humanoid, type) {
  if (!type || type === 'fists') return null;
  return attachHeldWeapon(humanoid, type, WeaponDrops._mat(type));
}

// ── Enemy rig pool ──────────────────────────────────────────────────────────
// PERF: humanoid rigs are pre-built ONCE per enemy type and reused. Spawning
// an enemy no longer allocates geometries/materials/textures or builds a new
// Group — it just grabs a hidden rig, resets its pose, and re-positions it.
// Corpses retain a rig briefly, but never reserve the slot indefinitely.
// Ownership invalidates old enemy references before a rig can be reused.
const EnemyPool = {
  pools: {},
  freeIdx: {},
  initialized: false,
  init() {
    if (this.initialized) return;
    EnemyNavigation.setGeometry(Colliders.list, Colliders.revision);
    for (const type in ENEMY_TYPES) {
      const def = ENEMY_TYPES[type];
      const size = this._poolSize(type);
      const arr = new Array(size);
      for (let i = 0; i < size; i++) {
        const visual = Object.assign({}, def.visual,
          { seed: 100 + i * 73 + (type.charCodeAt(0) * 17) });
        const rig = makeHumanoid(visual);
        rig.position.set(0, -200, 0);
        rig.visible = false;
        World.add(rig);
        const weaponMesh = attachEnemyWeapon(rig, def.weaponType);
        arr[i] = { rig, weaponMesh, inUse: false, owner: null };
      }
      this.pools[type] = arr;
      this.freeIdx[type] = 0;
    }
    this.initialized = true;
    // Pre-compile shaders for every pooled rig so the first real spawn does
    // not pay a shader-compile hitch. Show rigs briefly, run renderer.compile
    // against the active scene/camera, then re-hide.
    for (const type in this.pools) {
      const arr = this.pools[type];
      for (let i = 0; i < arr.length; i++) arr[i].rig.visible = true;
    }
    try { renderer.compile(scene, camera); } catch (_) {}
    for (const type in this.pools) {
      const arr = this.pools[type];
      for (let i = 0; i < arr.length; i++) arr[i].rig.visible = false;
    }
  },
  _poolSize(type) {
    // Zones and finale branches do not coexist, but survivors can span waves.
    // Two corpse slots preserve aftermath; acquire can reclaim older corpses.
    return enemyPoolCapacity(type, [...Object.values(ZONE_WAVE_CONFIG), ...Object.values(FINAL_ENCOUNTERS)]);
  },
  acquire(type) {
    const arr = this.pools[type];
    if (!arr) return null;
    for (let i = 0; i < arr.length; i++) {
      const slot = arr[i];
      if (!slot.inUse) {
        slot.inUse = true;
        this._reset(slot);
        return slot;
      }
    }
    return null;
  },
  release(slot) {
    if (!slot || !slot.inUse) return;
    if (slot.owner) {
      EnemyNavigation.cancel(slot.owner.navigation);
      invalidateEnemy(slot.owner);
      slot.owner.poolSlot = null;
      slot.owner = null;
    }
    slot.inUse = false;
    slot.rig.visible = false;
    slot.rig.position.set(0, -200, 0);
    slot.rig.rotation.set(0, 0, 0, 'YXZ');
    if (slot.weaponMesh) slot.weaponMesh.visible = true;
  },
  _reset(slot) {
    const rig = slot.rig;
    rig.visible = true;
    rig.rotation.set(0, 0, 0, 'YXZ');
    resetHumanoidPose(rig);
    if (slot.weaponMesh) slot.weaponMesh.visible = true;
  },
};

// ── Enemies registry + spawn ────────────────────────────────────────────────
let nextEnemyId = 1;
const Enemies = {
  list: [],
  spawn(type, x, z, floorY) {
    const def = ENEMY_TYPES[type];
    if (!def || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(floorY)) return null;
    let slot = EnemyPool.acquire(type);
    if (!slot) {
      const corpseIndex = oldestCorpseIndex(this.list, type);
      if (corpseIndex >= 0) {
        this.remove(this.list[corpseIndex]);
        slot = EnemyPool.acquire(type);
      }
    }
    if (!slot) return null;
    const mesh = slot.rig;
    mesh.position.set(x, floorY, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    const enemy = {
      id: nextEnemyId++,
      type, def, mesh, weaponMesh: slot.weaponMesh,
      poolSlot: slot,
      pos: new THREE.Vector3(x, floorY, z),
      vel: new THREE.Vector3(),
      radius: 0.35,
      height: def.visual.height || 1.8,
      yaw: mesh.rotation.y,
      health: def.maxHealth,
      state: 'idle', stateTime: 0,
      attackTimer: 0, swingTimer: 0, burstLeft: 0, burstDelayT: 0,
      windupRemaining: -1, aimCommitted: false,
      aimTarget: new THREE.Vector3(),
      attackCount: 0, swingSide: 'R',
      poseInput: { mode: 'idle', speed: 0, forward: 1, strafe: 0, alert: 0, aim: 0, swingProgress: -1, swingSide: 'R', stagger: false },
      staggerTime: 0,
      floorY,
      navigation: createNavigationAgent(),
      stairPursuit: createStairPursuit(),
      spawnGrace: 0,
      strafePhase: Math.random() * Math.PI * 2,
      strafeSide: Math.random() < 0.5 ? -1 : 1,
      strafeTimer: 1.5 + Math.random(),
      coverTarget: new THREE.Vector3(x, floorY, z),
      coverTimer: 0, coverCooldown: 0,
      alive: true,
      removed: false,
      corpseTimer: 0,
      deathLean: 0,
      tickAccumulator: 0,
      hasDroppedWeapon: false,
      lastSeenPlayer: false,
      lastSeenPosition: new THREE.Vector3(x, floorY, z),
      lastSeenFootY: floorY,
      timeSinceSeen: Infinity,
      // PERF: LoS throttling — staggered per-enemy phase so the ~6 Hz raycast
      // refreshes don't all pile onto the same frame.
      losPhase: (Math.random() * 160) | 0,
      losTimer: -1,
      losSampleTime: -Infinity,
      losCached: false,
      losObservedPosition: new THREE.Vector3(x, floorY, z),
      losObservedFootY: floorY,
    };
    enemy.body = { position: enemy.pos, velocity: enemy.vel, radius: enemy.radius, height: enemy.height, onGround: true };
    slot.owner = enemy;
    this.list.push(enemy);
    return enemy;
  },
  removeDead() {
    let corpses = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const enemy = this.list[i];
      if (enemy.removed || (!enemy.alive && enemy.corpseTimer >= CORPSE_LIFETIME)) {
        this.remove(enemy);
      } else if (!enemy.alive) corpses++;
    }
    while (corpses > CORPSE_LIMIT) {
      const index = oldestCorpseIndex(this.list);
      if (index < 0) break;
      this.remove(this.list[index]);
      corpses--;
    }
  },
  remove(enemy) {
    const index = this.list.indexOf(enemy);
    if (index < 0) return false;
    EnemyNavigation.cancel(enemy.navigation);
    if (enemy.poolSlot) EnemyPool.release(enemy.poolSlot);
    else invalidateEnemy(enemy);
    this.list.splice(index, 1);
    return true;
  },
  clearAll() {
    for (const e of this.list) {
      EnemyNavigation.cancel(e.navigation);
      if (e.poolSlot) EnemyPool.release(e.poolSlot);
      else invalidateEnemy(e);
    }
    this.list.length = 0;
  },
  countAliveInZone(zone) {
    let n = 0;
    for (const e of this.list) if (e.alive && e.zone === zone) n++;
    return n;
  },
};

// ── AI helper: capsule-vs-collider resolution (mirrors player movement) ────
// PERF: scratch vectors reused per call — was 6 Vector3 allocations per
// enemy per frame in the hot combat loop.
const _ecBottom = new THREE.Vector3(), _ecTop = new THREE.Vector3();
function resolveEnemyCollision(enemy) {
  const r = enemy.radius;
  const bodyH = enemy.height;
  const list = Colliders.list;
  for (let pass = 0; pass < 3; pass++) {
    _ecBottom.set(enemy.pos.x, enemy.pos.y + r, enemy.pos.z);
    _ecTop.set(enemy.pos.x, enemy.pos.y + bodyH - r, enemy.pos.z);
    let moved = false;
    for (let i = 0, n = list.length; i < n; i++) {
      const box = list[i];
      if (box.max.x < enemy.pos.x - r || box.min.x > enemy.pos.x + r ||
          box.max.z < enemy.pos.z - r || box.min.z > enemy.pos.z + r ||
          box.max.y < enemy.pos.y || box.min.y > enemy.pos.y + bodyH) continue;
      const hit = resolveCapsuleAABB(_ecBottom, _ecTop, r, box);
      if (!hit) continue;
      enemy.pos.addScaledVector(hit.normal, hit.depth);
      _ecBottom.addScaledVector(hit.normal, hit.depth);
      _ecTop.addScaledVector(hit.normal, hit.depth);
      const vn = enemy.vel.dot(hit.normal);
      if (vn < 0) enemy.vel.addScaledVector(hit.normal, -vn);
      moved = true;
    }
    if (!moved) break;
  }
}

// PERF: all scratch is pre-allocated. hasLineOfSight + isBlocked are called
// per-enemy per-frame from the combat hot path; zero allocations is required.
const _losOrigin = new THREE.Vector3();
const _losTarget = new THREE.Vector3();
function _hasLineOfSightRaw(enemy) {
  _losOrigin.set(enemy.pos.x, enemy.pos.y + enemy.height - 0.18, enemy.pos.z);
  _losTarget.set(Player.pos.x, Player.pos.y - 0.2, Player.pos.z);
  return !isSegmentOccluded(_losOrigin, _losTarget, Colliders.list);
}
// Throttled wrapper: each enemy refreshes its cached LoS at ~6 Hz (every
// ~0.16s), staggered across frames via the enemy.losPhase offset assigned at
// spawn so the cost is spread evenly per frame instead of N raycasts/frame.
function hasLineOfSight(enemy) {
  const LOS_INTERVAL = 0.16;
  if (!enemy.alive || enemy.removed || PlayerState.dead) return false;
  return updateSightCache(enemy, Player.pos, Player.pos.y - Player._eyeH, GameTime.elapsed, _hasLineOfSightRaw,
    LOS_INTERVAL + (enemy.losPhase || 0) * 0.00015);
}

// Probe whether moving from `pos` by `step` is blocked by a collider.
// PERF: scratch sphere centers reused across all calls.
const _ibBottom = new THREE.Vector3(), _ibTop = new THREE.Vector3();
function isBlocked(pos, dx, dz, radius, height) {
  const tx = pos.x + dx, ty = pos.y, tz = pos.z + dz;
  _ibBottom.set(tx, ty + radius, tz);
  _ibTop.set(tx, ty + height - radius, tz);
  const r = radius * 0.98;
  const list = Colliders.list;
  for (let i = 0, n = list.length; i < n; i++) {
    const box = list[i];
    if (box.max.x < tx - r || box.min.x > tx + r || box.max.z < tz - r ||
        box.min.z > tz + r || box.max.y < ty || box.min.y > ty + height) continue;
    if (resolveCapsuleAABB(_ibBottom, _ibTop, r, box)) return true;
  }
  return false;
}

// Direct local steering stays cheap. A blocked route queues a bounded search;
// committed waypoints allow a detour away from the target around long walls.
const STEERING_ANGLES = [0, 0.45, -0.45, 0.95, -0.95, 1.5, -1.5];
const _steerResult = { x: 0, z: 0 };
const _navGoal = { x: 0, y: 0, z: 0 };
function steerDirection(enemy, goalX, goalZ, detours = true, goalY = enemy.floorY) {
  _navGoal.x = goalX; _navGoal.y = goalY; _navGoal.z = goalZ;
  const stairPoint = detours && enemy.zone === 'stairwell' && enemy.state !== 'cover'
    ? stairPursuitWaypoint(enemy.stairPursuit, enemy.pos, _navGoal) : null;
  if (stairPoint) Object.assign(_navGoal, stairPoint);
  const waypoint = detours ? EnemyNavigation.waypoint(enemy.navigation, enemy.pos, _navGoal, GameTime.elapsed) : null;
  const dx = (waypoint?.x ?? _navGoal.x) - enemy.pos.x, dz = (waypoint?.z ?? _navGoal.z) - enemy.pos.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ux = dx / dist, uz = dz / dist;
  const probe = Math.min(0.55, dist);
  for (const ang of STEERING_ANGLES) {
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const rx = ux * cs - uz * sn;
    const rz = ux * sn + uz * cs;
    if (EnemyNavigation.canStep(enemy.pos, rx * probe, rz * probe, enemy.radius, enemy.height)) {
      const approach = waypoint || stairPoint ? Math.min(1, dist / 0.16) : 1;
      _steerResult.x = rx * approach; _steerResult.z = rz * approach;
      return _steerResult;
    }
    if (ang === 0 && detours) {
      EnemyNavigation.request(enemy.navigation, enemy.pos, _navGoal, GameTime.elapsed, enemy.radius, enemy.height);
    }
  }
  _steerResult.x = 0; _steerResult.z = 0;
  return _steerResult;
}

function setEnemyState(enemy, state) {
  if (enemy.state !== state) {
    enemy.state = state;
    enemy.stateTime = 0;
  }
}

function cancelAttack(enemy) {
  advanceAttackWindup(enemy, 0, true);
  enemy.swingTimer = 0;
  enemy.burstLeft = 0;
  enemy.aimCommitted = false;
}

// A bounded local search on taking damage, not a pathfinder per frame.
// Tall nearby props can provide cover; floors, ceilings and distant walls
// cannot become destinations. Without a safe candidate, keep normal strafing.
const _coverPosition = new THREE.Vector3();
const _coverEye = new THREE.Vector3();
const _coverTargetEye = new THREE.Vector3();
function seekLocalCover(enemy) {
  if (enemy.coverCooldown > 0 || enemy.def.attack !== 'hitscan') return false;
  enemy.coverCooldown = 3.5;
  // A damage reaction may take cover from an observed threat, not locate an
  // unseen shooter through a partition. A fresh visible hit can refresh memory.
  if (_hasLineOfSightRaw(enemy)) {
    enemy.losObservedPosition.copy(Player.pos);
    enemy.losObservedFootY = Player.pos.y - Player._eyeH;
    updateAwareness(enemy, enemy.losObservedPosition, true, 0);
    enemy.lastSeenFootY = enemy.losObservedFootY;
  }
  if (!enemy.lastSeenPlayer) return false;
  _coverTargetEye.copy(enemy.lastSeenPosition); _coverTargetEye.y -= 0.2;
  let bestDistance = 4.5 * 4.5;
  let found = false;
  for (const box of Colliders.list) {
    if (box.min.y > enemy.pos.y + 0.4 || box.max.y < enemy.pos.y + enemy.height - 0.2) continue;
    const width = box.max.x - box.min.x, depth = box.max.z - box.min.z;
    if (width > 6 || depth > 6) continue;
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    const awayX = cx - enemy.lastSeenPosition.x, awayZ = cz - enemy.lastSeenPosition.z;
    _coverPosition.set(cx, enemy.pos.y, cz);
    if (Math.abs(awayX) > Math.abs(awayZ)) {
      _coverPosition.x += Math.sign(awayX || 1) * (width * 0.5 + enemy.radius + 0.18);
    } else {
      _coverPosition.z += Math.sign(awayZ || 1) * (depth * 0.5 + enemy.radius + 0.18);
    }
    const distance = _coverPosition.distanceToSquared(enemy.pos);
    if (distance < 0.35 || distance >= bestDistance) continue;
    const floor = surfaceTopAt(_coverPosition.x, enemy.pos.y + 0.1, _coverPosition.z, 0.5);
    if (!Number.isFinite(floor) || Math.abs(floor - enemy.floorY) > 0.3) continue;
    _coverPosition.y = floor;
    if (isBlocked(_coverPosition, 0, 0, enemy.radius, enemy.height)) continue;
    _coverEye.set(_coverPosition.x, floor + enemy.height - 0.18, _coverPosition.z);
    if (!isSegmentOccluded(_coverEye, _coverTargetEye, Colliders.list)) continue;
    bestDistance = distance;
    enemy.coverTarget.copy(_coverPosition);
    found = true;
  }
  if (found) enemy.coverTimer = 1.6;
  return found;
}

// ── Per-enemy AI tick ──────────────────────────────────────────────────────
// PERF: pre-allocated scratch so enemies firing allocates nothing per shot.
const _enemyFireScratch = {
  muzzle: new THREE.Vector3(), dir: new THREE.Vector3(),
  ray: new THREE.Ray(new THREE.Vector3(), new THREE.Vector3()),
  hp: new THREE.Vector3(), endPt: new THREE.Vector3(),
  playerBox: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
  target: new THREE.Vector3(),
};
function enemyAttackPlayer(enemy) {
  if (!enemy.alive || enemy.removed || enemy.spawnGrace > 0 || PlayerState.dead || Player.health <= 0) return false;
  const def = enemy.def;
  if (def.attack === 'melee') {
    const dx = Player.pos.x - enemy.pos.x;
    const dz = Player.pos.z - enemy.pos.z;
    const distance = Math.hypot(dx, dz);
    const playerFoot = Player.pos.y - Player._eyeH;
    _losOrigin.set(enemy.pos.x, enemy.pos.y + enemy.height * 0.6, enemy.pos.z);
    _losTarget.set(Player.pos.x, playerFoot + Player._bodyH * 0.55, Player.pos.z);
    const connects = canMeleeHit({
      distance, range: def.attackRange,
      heightDifference: playerFoot - enemy.pos.y,
      facingDot: distance < 0.01 ? 1 : (Math.sin(enemy.yaw) * dx + Math.cos(enemy.yaw) * dz) / distance,
      clear: !isSegmentOccluded(_losOrigin, _losTarget, Colliders.list),
    });
    if (connects) {
      applyPlayerDamage(def.damage, enemy.pos, enemy);
      Audio.meleeHit();
    }
    return connects;
  }
  // Recheck immediately, rather than trusting the slower perception cache.
  if (!_hasLineOfSightRaw(enemy)) return false;
  const s = _enemyFireScratch;
  const shoulderY = enemy.pos.y + enemy.height - 0.32;
  s.muzzle.set(enemy.pos.x, shoulderY, enemy.pos.z);
  const aimYaw = Math.atan2(Player.pos.x - enemy.pos.x, Player.pos.z - enemy.pos.z);
  s.muzzle.x += Math.sin(aimYaw) * 0.45;
  s.muzzle.z += Math.cos(aimYaw) * 0.45;
  const muzzleAnchor = enemy.mesh.userData.rig?.anchors.weaponMuzzle;
  if (muzzleAnchor) muzzleAnchor.getWorldPosition(s.muzzle);
  const spread = def.spread;
  s.target.set(Player.pos.x, Player.pos.y - 0.3, Player.pos.z);
  if (enemy.aimCommitted) s.target.copy(enemy.aimTarget);
  s.dir.set(
    s.target.x - s.muzzle.x + (Math.random() - 0.5) * spread * 12,
    s.target.y - s.muzzle.y + (Math.random() - 0.5) * spread * 8,
    s.target.z - s.muzzle.z + (Math.random() - 0.5) * spread * 12,
  );
  const dist = s.dir.length();
  s.dir.divideScalar(dist || 1);
  s.ray.origin.copy(s.muzzle); s.ray.direction.copy(s.dir);
  let hitDist = 80;
  for (const box of Colliders.list) {
    if (s.ray.intersectBox(box, s.hp)) {
      const d = s.hp.distanceTo(s.muzzle);
      if (d < hitDist) hitDist = d;
    }
  }
  const footY = Player.pos.y - Player._eyeH;
  const radius = Player.radius;
  s.playerBox.min.set(Player.pos.x - radius, footY, Player.pos.z - radius);
  s.playerBox.max.set(Player.pos.x + radius, footY + Player._bodyH, Player.pos.z + radius);
  let playerHit = false;
  if (s.ray.intersectBox(s.playerBox, s.hp)) {
    const playerDist = s.hp.distanceTo(s.muzzle);
    if (playerDist < hitDist) { playerHit = true; hitDist = playerDist; }
  }
  s.endPt.copy(s.muzzle).addScaledVector(s.dir, hitDist);
  FX.muzzleFlash(s.muzzle);
  FX.tracer(s.muzzle, s.endPt);
  if (def.weaponType === 'pistol') Audio.pistolShot();
  else if (def.weaponType === 'shotgun') Audio.shotgunShot();
  else if (def.weaponType === 'smg') Audio.smgShot();
  else Audio.machinegunShot();
  if (playerHit) applyPlayerDamage(def.damage, enemy.pos, enemy);
  else if (hitDist < 80) FX.impact(s.endPt.x, s.endPt.y, s.endPt.z, 3);
  if (enemy.aimCommitted) {
    s.target.set(Player.pos.x, Player.pos.y - 0.3, Player.pos.z);
    enemy.aimTarget.lerp(s.target, 0.4);
  }
  return playerHit;
}

function enemyTick(enemy, dt) {
  if (enemy.removed) return;
  if (!enemy.alive) {
    enemy.corpseTimer += dt;
    const sink = Math.max(0, enemy.corpseTimer - CORPSE_LIFETIME + 1) * 0.45;
    if (!updateHumanoidCollapse(enemy.mesh, enemy.corpseTimer, sink)) {
      const fall = smoothstep(0, 0.52, enemy.corpseTimer);
      enemy.mesh.rotation.set(Math.PI * 0.5 * fall, enemy.yaw, 0, 'YXZ');
      enemy.mesh.position.y = enemy.floorY + 0.18 - sink;
    }
    return;
  }
  enemy.stateTime += dt;
  enemy.spawnGrace = Math.max(0, (enemy.spawnGrace || 0) - dt);
  enemy.attackTimer = Math.max(0, enemy.attackTimer - dt);
  enemy.swingTimer = Math.max(0, enemy.swingTimer - dt);
  enemy.staggerTime = Math.max(0, enemy.staggerTime - dt);
  enemy.coverTimer = Math.max(0, enemy.coverTimer - dt);
  enemy.coverCooldown = Math.max(0, enemy.coverCooldown - dt);

  const dx = Player.pos.x - enemy.pos.x;
  const dz = Player.pos.z - enemy.pos.z;
  const distToPlayer = Math.hypot(dx, dz);
  const def = enemy.def;

  const visible = !PlayerState.dead && distToPlayer < def.alertRange && hasLineOfSight(enemy);
  _navGoal.x = enemy.lastSeenPosition.x; _navGoal.y = enemy.lastSeenFootY; _navGoal.z = enemy.lastSeenPosition.z;
  const memoryDuration = Math.max(
    investigationMemorySeconds(enemy.navigation, enemy.lastSeenPosition, def.speed, EnemyNavigation.generation),
    enemy.zone === 'stairwell' ? stairPursuitMemorySeconds(enemy.stairPursuit, _navGoal, def.speed) : 0,
  );
  const awareness = updateAwareness(enemy, enemy.losObservedPosition, visible, dt, memoryDuration);
  if (visible) enemy.lastSeenFootY = enemy.losObservedFootY;
  if (enemy.staggerTime > 0) {
    setEnemyState(enemy, 'stagger');
  } else if (PlayerState.dead) {
    setEnemyState(enemy, 'idle');
  } else if (enemy.coverTimer > 0) {
    setEnemyState(enemy, 'cover');
  } else if (awareness === 'visible') {
    const attackLevel = enemy.zone !== 'stairwell' || def.attack === 'hitscan' || Math.abs(enemy.lastSeenFootY - enemy.pos.y) <= 0.9;
    setEnemyState(enemy, distToPlayer <= def.attackRange && attackLevel ? 'attack' : 'chase');
  } else if (awareness === 'investigate') {
    setEnemyState(enemy, 'investigate');
  } else {
    setEnemyState(enemy, 'idle');
  }
  if (enemy.state === 'idle') {
    EnemyNavigation.cancel(enemy.navigation);
    resetStairPursuit(enemy.stairPursuit);
  }
  if (enemy.state !== 'attack' || enemy.spawnGrace > 0) cancelAttack(enemy);
  const attackReady = advanceAttackWindup(enemy, dt);

  // Gravity.
  enemy.vel.y = Math.max(-32, enemy.vel.y - 22 * dt);

  let moveX = 0, moveZ = 0;
  if (enemy.state === 'chase' || enemy.state === 'investigate' || enemy.state === 'cover') {
    const goal = enemy.state === 'cover' ? enemy.coverTarget : enemy.lastSeenPosition;
    const goalX = goal.x, goalZ = goal.z;
    const distance = Math.hypot(goalX - enemy.pos.x, goalZ - enemy.pos.z);
    const goalY = enemy.state === 'cover' ? goal.y : enemy.lastSeenFootY;
    const dir = steerDirection(enemy, goalX, goalZ, true, goalY);
    const speed = def.speed * (enemy.state === 'investigate' ? 0.65 : 1);
    if (distance > 0.45 || (enemy.zone === 'stairwell' && Math.abs(goalY - enemy.pos.y) > 0.55)) {
      moveX = dir.x * speed;
      moveZ = dir.z * speed;
      const targetYaw = dir.x || dir.z ? Math.atan2(dir.x, dir.z) : enemy.yaw;
      enemy.yaw = lerpAngle(enemy.yaw, targetYaw, Math.min(1, dt * 7));
    } else if (enemy.state === 'investigate') {
      enemy.yaw += Math.sin(enemy.stateTime * 2) * dt * 0.6;
    }
  } else if (enemy.state === 'attack') {
    // Face player. Ranged enemies maintain hold distance; melee close in.
    const targetYaw = Math.atan2(dx, dz);
    enemy.yaw = lerpAngle(enemy.yaw, targetYaw, Math.min(1, dt * 10));
    if (def.attack === 'hitscan') {
      const hold = def.holdDistance || 6;
      if (distToPlayer > hold + 1.2) {
        const dir = steerDirection(enemy, enemy.lastSeenPosition.x, enemy.lastSeenPosition.z, true, enemy.lastSeenFootY);
        moveX = dir.x * def.speed * 0.85;
        moveZ = dir.z * def.speed * 0.85;
      } else if (distToPlayer < hold - 1.8) {
        const dir = steerDirection(enemy, enemy.pos.x - dx, enemy.pos.z - dz, false);
        moveX = dir.x * def.speed * 0.65;
        moveZ = dir.z * def.speed * 0.65;
      } else {
        // Commit to a short lateral move rather than oscillating every frame.
        enemy.strafeTimer -= dt;
        if (enemy.strafeTimer <= 0) {
          enemy.strafeSide *= -1;
          enemy.strafeTimer = 1.5 + Math.random();
        }
        const px = -dz / (distToPlayer || 1), pz = dx / (distToPlayer || 1);
        const s = enemy.strafeSide * 0.7;
        if (EnemyNavigation.canStep(enemy.pos, px * s * 0.4, pz * s * 0.4, enemy.radius, enemy.height)) {
          moveX = px * def.speed * 0.4 * s;
          moveZ = pz * def.speed * 0.4 * s;
        } else if (enemy.strafeTimer > 0.4) {
          enemy.strafeSide *= -1;
          enemy.strafeTimer = 0.35;
        }
      }
      if (attackReady) {
        enemy.burstLeft = def.burst;
        enemy.burstDelayT = 0;
        enemy.attackTimer = def.fireInterval;
      }
      if (enemy.burstLeft > 0) {
        enemy.burstDelayT -= dt;
        if (enemy.burstDelayT <= 0) {
          enemyAttackPlayer(enemy);
          enemy.burstLeft--;
          enemy.burstDelayT = def.burstDelay || 0.05;
          if (enemy.burstLeft === 0) enemy.aimCommitted = false;
        }
      }
      if (enemy.spawnGrace <= 0 && enemy.attackTimer <= 0 && enemy.windupRemaining < 0 && enemy.burstLeft === 0) {
        enemy.windupRemaining = def.aimTime;
        enemy.aimTarget.set(Player.pos.x, Player.pos.y - 0.3, Player.pos.z);
        enemy.aimCommitted = true;
      }
      // Brace before and during a burst; this silhouette is the firing cue.
      if (enemy.windupRemaining >= 0 || enemy.burstLeft > 0) {
        moveX *= 0.2; moveZ *= 0.2;
      }
    } else {
      if (distToPlayer > def.attackRange * 0.8 && enemy.swingTimer <= 0) {
        const dir = steerDirection(enemy, enemy.lastSeenPosition.x, enemy.lastSeenPosition.z, true, enemy.lastSeenFootY);
        moveX = dir.x * def.speed;
        moveZ = dir.z * def.speed;
      }
      if (enemy.spawnGrace <= 0 && enemy.attackTimer <= 0) {
        enemy.swingTimer = def.swingTime;
        enemy.attackTimer = def.attackCooldown;
        enemy.windupRemaining = def.swingTime * 0.5;
        enemy.swingSide = def.weaponType === 'fists' && enemy.attackCount++ % 2 ? 'L' : 'R';
      }
      if (attackReady) enemyAttackPlayer(enemy);
    }
  } else if (enemy.state === 'idle') {
    enemy.yaw += Math.sin(GameTime.elapsed * 0.8 + enemy.strafePhase) * dt * 0.12;
  }

  // Small separation keeps a squad from sharing one silhouette or weapon.
  if (enemy.state !== 'stagger' && enemy.state !== 'idle') {
    for (const other of Enemies.list) {
      if (other === enemy || !other.alive || Math.abs(other.pos.y - enemy.pos.y) > 0.8) continue;
      const sx = enemy.pos.x - other.pos.x, sz = enemy.pos.z - other.pos.z;
      const distance = Math.hypot(sx, sz);
      if (distance >= 0.85) continue;
      const strength = (0.85 - distance) * 1.5;
      if (distance < 0.01) {
        moveX += (enemy.id < other.id ? -1 : 1) * strength;
      } else {
        moveX += sx / distance * strength;
        moveZ += sz / distance * strength;
      }
    }
  }

  enemy.vel.x = moveX;
  enemy.vel.z = moveZ;

  // Navigation and movement share the player's capsule stepper. A valid
  // curb/flight probe therefore produces an actual step, not a stopped body
  // whose lower spherical cap still collides with the riser face.
  const SUPPORT_LOOKDOWN = 2.5; // how far below feet still counts as "on ground"
  enemy.body.radius = enemy.radius; enemy.body.height = enemy.height;
  EnemyNavigation.moveBody(enemy.body, dt);

  // Re-sample the actual surface under the CURRENT (x,z) so enemy.floorY
  // tracks landings/ledges instead of clamping to the stale spawn-time
  // value (root cause of enemies hovering past open edges).
  const supNow = surfaceTopAt(enemy.pos.x, enemy.pos.y + 0.20, enemy.pos.z, SUPPORT_LOOKDOWN);
  if (supNow !== -Infinity) {
    enemy.floorY = supNow;
  }
  // else: no support within reach — let gravity carry them down naturally.

  // Apply pose to mesh.
  enemy.mesh.position.copy(enemy.pos);
  enemy.mesh.rotation.y = enemy.yaw;
  enemy.mesh.rotation.z = lerp(enemy.mesh.rotation.z, 0, Math.min(1, dt * 12));
  const speed2d = Math.hypot(enemy.vel.x, enemy.vel.z);
  const pose = enemy.poseInput;
  pose.mode = def.attack === 'hitscan' ? 'ranged' : def.weaponType === 'fists' ? 'fist' : 'bat';
  pose.speed = speed2d;
  pose.forward = speed2d > 0.01 ? (Math.sin(enemy.yaw) * enemy.vel.x + Math.cos(enemy.yaw) * enemy.vel.z) / speed2d : 1;
  pose.strafe = speed2d > 0.01 ? (Math.cos(enemy.yaw) * enemy.vel.x - Math.sin(enemy.yaw) * enemy.vel.z) / speed2d : 0;
  pose.alert = enemy.state === 'attack' || enemy.state === 'chase' ? 1 : 0;
  pose.aim = def.attack !== 'hitscan' ? 0 : enemy.burstLeft > 0 || enemy.attackTimer > def.fireInterval - 0.14 ? 1 : enemy.windupRemaining >= 0 ? 1 - enemy.windupRemaining / def.aimTime : 0.12;
  pose.swingProgress = enemy.swingTimer > 0 ? 1 - enemy.swingTimer / def.swingTime : -1;
  pose.swingSide = enemy.swingSide;
  pose.stagger = enemy.state === 'stagger';
  updateHumanoidPose(enemy.mesh, pose, dt);
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// PERF: enemy AI is the worst-case hotspot during combat (user-reported).
// Halve the AI rate by ticking each enemy every other simulation step;
// staggered across enemies so per-frame load is even instead of bursty.
let _enemyTickFrame = 0;
function enemiesUpdate(dt) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  EnemyNavigation.setGeometry(Colliders.list, Colliders.revision);
  EnemyNavigation.update(GameTime.elapsed);
  _enemyTickFrame++;
  const list = Enemies.list;
  const parity = _enemyTickFrame & 1;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    e.tickAccumulator += dt;
    // Always tick if dead (cheap branch) so corpses fade on schedule, and
    // always tick if the enemy is in melee/attack range so combat reads tight.
    const dx = Player.pos.x - e.pos.x;
    const dz = Player.pos.z - e.pos.z;
    const closeSq = dx * dx + dz * dz < 9; // ≤3m: tick every frame
    if (!e.alive || closeSq || ((e.id & 1) === parity)) {
      enemyTick(e, e.tickAccumulator);
      e.tickAccumulator = 0;
    }
  }
  Enemies.removeDead();
}

// ── Enemy damage / death ───────────────────────────────────────────────────
// This is the sole body-part multiplier. Weapons pass unscaled base damage.
function damageEnemy(enemy, dmg, hitPart, hitPos) {
  if (!enemy.alive || enemy.removed) return null;
  const damage = damageForHit(dmg, hitPart);
  if (damage <= 0) return null;
  const applied = Math.min(enemy.health, damage);
  enemy.health = Math.max(0, enemy.health - damage);
  enemy.staggerTime = Math.max(enemy.staggerTime, 0.18);
  cancelAttack(enemy);
  if (hitPos) Blood.spawn(hitPos.x, hitPos.y, hitPos.z, hitPart === 'head' ? 14 : 8, 0.8);
  if (enemy.health <= 0) killEnemy(enemy, hitPos);
  else seekLocalCover(enemy);
  return { damage: applied, killed: !enemy.alive, headshot: hitPart === 'head' };
}
function killEnemy(enemy, hitPos) {
  if (!enemy.alive || enemy.removed) return false;
  EnemyNavigation.cancel(enemy.navigation);
  cancelAttack(enemy);
  enemy.alive = false;
  enemy.corpseTimer = 0;
  enemy.state = 'dead';
  enemy.stateTime = 0;
  enemy.coverTimer = 0;
  enemy.deathLean = (enemy.id % 2 ? -1 : 1) * 0.08;
  enemy.vel.set(0, 0, 0);
  const fallAxis = enemy.zone === 'balcony'
    ? enemy.pos.z >= BALCONY.wrap.z1 ? 'x' : 'z'
    : null;
  const fallRegion = enemy.zone === 'balcony' ? fallAxis === 'x' ? BALCONY.wrap : BALCONY.east : null;
  beginHumanoidCollapse(enemy.mesh, enemy.yaw, enemy.floorY, fallAxis, enemy.deathLean, fallRegion);
  if (hitPos) Blood.spawn(hitPos.x, hitPos.y, hitPos.z, 18, 1.1);
  // Drop weapon if not already done.
  if (!enemy.hasDroppedWeapon) {
    enemy.hasDroppedWeapon = true;
    if (enemy.def.weaponType && enemy.def.weaponType !== 'fists') {
      WeaponDrops.spawn(enemy.pos.x, enemy.floorY, enemy.pos.z,
        enemy.def.weaponType, enemy.def.ammo);
    }
    // Detach the held weapon so it stays with the corpse (cosmetic).
    if (enemy.weaponMesh) enemy.weaponMesh.visible = false;
  }
  return true;
}

// Raycast against alive enemies; returns nearest hit info for combat use.
// Shared by player melee and every ranged weapon.
// PERF: pre-allocated scratch — raycastEnemies must not allocate per shot.
const _rayScratch = {
  ray: new THREE.Ray(new THREE.Vector3(), new THREE.Vector3()),
  dir: new THREE.Vector3(),
  bodyBox: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
  headBox: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
  headCenter: new THREE.Vector3(),
  hp: new THREE.Vector3(),
  result: { enemy: null, part: 'body', point: new THREE.Vector3(), dist: 0 },
};
function raycastEnemies(origin, direction, maxDist = 80) {
  const s = _rayScratch;
  s.dir.copy(direction).normalize();
  s.ray.origin.copy(origin); s.ray.direction.copy(s.dir);
  let nearestDist = maxDist;
  let hitEnemy = null, hitPart = 'body';
  s.result.point.set(0, 0, 0);
  for (const e of Enemies.list) {
    if (!e.alive) continue;
    const r = e.radius;
    const hitZones = e.mesh.userData.hitZones;
    if (hitZones) {
      hitZones.headAnchor.getWorldPosition(s.headCenter);
      s.headBox.min.set(s.headCenter.x - hitZones.headHalfWidth, s.headCenter.y - hitZones.headHalfHeight, s.headCenter.z - hitZones.headHalfDepth);
      s.headBox.max.set(s.headCenter.x + hitZones.headHalfWidth, s.headCenter.y + hitZones.headHalfHeight, s.headCenter.z + hitZones.headHalfDepth);
    } else {
      s.headBox.min.set(e.pos.x - r * 0.7, e.pos.y + e.height * 0.78, e.pos.z - r * 0.7);
      s.headBox.max.set(e.pos.x + r * 0.7, e.pos.y + e.height, e.pos.z + r * 0.7);
    }
    s.bodyBox.min.set(e.pos.x - r, e.pos.y, e.pos.z - r);
    s.bodyBox.max.set(e.pos.x + r, s.headBox.min.y, e.pos.z + r);
    if (s.ray.intersectBox(s.headBox, s.hp)) {
      const d = s.hp.distanceTo(origin);
      if (d < nearestDist) { nearestDist = d; hitEnemy = e; hitPart = 'head'; s.result.point.copy(s.hp); }
    }
    if (s.ray.intersectBox(s.bodyBox, s.hp)) {
      const d = s.hp.distanceTo(origin);
      if (d < nearestDist) { nearestDist = d; hitEnemy = e; hitPart = 'body'; s.result.point.copy(s.hp); }
    }
  }
  // Colliders blocking the shot.
  for (const box of Colliders.list) {
    if (s.ray.intersectBox(box, s.hp)) {
      const d = s.hp.distanceTo(origin);
      if (d < nearestDist) return null;
    }
  }
  if (!hitEnemy) return null;
  s.result.enemy = hitEnemy; s.result.part = hitPart; s.result.dist = nearestDist;
  return s.result;
}

export { ENEMY_TYPES, EnemyPool, EnemyNavigation, Enemies, enemiesUpdate, damageEnemy, killEnemy, raycastEnemies, enemyAttackPlayer, hasLineOfSight, resolveEnemyCollision, isBlocked, primeEnemyInvestigation };
