import { Vector3 } from 'three';
import { Colliders } from '../core/collision.js';
import { createHealthPickupModel } from '../render/health-pickup-model.js';
import { createArmorPickupModel } from '../render/armor-pickup-model.js';
import { buildAmmoBox, createResources } from './ammo-supplies.js';
import { ammoSupplyAmount, AMMO_RESERVE_LIMITS } from './ammo-supply-rules.js';
import { MAX_ARMOR, clampArmor } from './armor-rules.js';
import { isSegmentOccluded } from './combat-rules.js';
import { defenseSupplyBudget, defenseSupplyCandidates } from './defense-rules.js';

export const DEFENSE_SUPPLY_LIMIT = 3;
const PICKUP_RADIUS_SQ = 0.85 * 0.85;
const FOOTPRINT_RADIUS = 0.38;
const FLOOR_TOLERANCE = 0.18;
const FLOOR_CLEARANCE = 0.025;

/**
 * Three finite field supplies are reused every intermission. Their shared
 * pickup geometry is never disposed or added to the physical collider list.
 * Walking over a case is the interaction; an ammo case only feeds the held
 * firearm's reserve and cannot equip a gun or refill its loaded magazine.
 */
export function createDefenseSupplies() {
  const list = [];
  const foot = new Vector3(), sightStart = new Vector3(), sightEnd = new Vector3();
  const probe = new Vector3();
  const lastPlacementFoot = new Vector3(Infinity, Infinity, Infinity);
  let world, player, weapons, floorAt, blocked, canCollect, onCollect, spawnWeapon;
  let clearWeapons = () => {};
  let colliders = Colliders.list;
  let elapsed = 0, arena = null, wave = 0, difficulty = null, budget = null, pending = false;
  let placementDelay = 0;
  const weaponPlacements = [];
  const weaponQueue = [];

  function hide(entry) {
    entry.active = false;
    entry.mesh.visible = false;
  }

  function readFoot() {
    const eyeHeight = Number.isFinite(player?._eyeH) ? player._eyeH : player?.eyeHeight;
    if (!player?.pos || !Number.isFinite(eyeHeight)) return false;
    foot.set(player.pos.x, player.pos.y - eyeHeight, player.pos.z);
    return [foot.x, foot.y, foot.z].every(Number.isFinite);
  }

  function supported(point, radius = FOOTPRINT_RADIUS) {
    // Test the complete footprint, not just its center: a valid center at a
    // lightwell edge must not place half a supply over the open roof.
    for (const dx of [-radius, 0, radius]) for (const dz of [-radius, 0, radius]) {
      probe.set(point.x + dx, point.y, point.z + dz);
      const floor = floorAt(probe);
      if (!Number.isFinite(floor) || Math.abs(floor - point.y) > 0.055) return false;
    }
    return true;
  }

  function clearWalkTo(point) {
    const steps = Math.max(1, Math.ceil(Math.hypot(point.x - foot.x, point.z - foot.z) / 0.3));
    let previousFloor = foot.y;
    // Checking the walking line avoids supplies appearing across a roof hole
    // or behind a low barrier that a chest-height visibility ray could miss.
    for (let step = 1; step <= steps; step++) {
      const part = step / steps;
      const sample = {
        x: foot.x + (point.x - foot.x) * part,
        y: foot.y + (point.y - foot.y) * part,
        z: foot.z + (point.z - foot.z) * part,
      };
      const floor = floorAt(sample);
      if (!Number.isFinite(floor) || Math.abs(floor - sample.y) > FLOOR_TOLERANCE
        || Math.abs(floor - previousFloor) > FLOOR_TOLERANCE) return false;
      sample.y = floor;
      if (!supported(sample, 0.25)) return false;
      sample.y += FLOOR_CLEARANCE;
      if (blocked(sample)) return false;
      previousFloor = floor;
    }
    return true;
  }

  function safePosition(candidate, radius = FOOTPRINT_RADIUS) {
    if (!candidate || ![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) return null;
    const floor = floorAt(candidate);
    if (!Number.isFinite(floor) || Math.abs(floor - candidate.y) > FLOOR_TOLERANCE
      || Math.abs(floor - foot.y) > FLOOR_TOLERANCE) return null;
    const point = { x: candidate.x, y: floor, z: candidate.z };
    if (!supported(point, radius)) return null;
    if (blocked({ x: point.x, y: point.y + FLOOR_CLEARANCE, z: point.z })) return null;
    if (list.some(entry => entry.active && Math.hypot(entry.mesh.position.x - point.x, entry.mesh.position.z - point.z) < 1.15)) return null;
    if (weaponPlacements.some(entry => Math.hypot(entry.position.x - point.x, entry.position.z - point.z) < 1.5)) return null;
    sightEnd.set(point.x, point.y + 0.5, point.z);
    if (isSegmentOccluded(sightStart, sightEnd, colliders) || !clearWalkTo(point)) return null;
    return point;
  }

  function placePending() {
    if (!pending || !readFoot()) return false;
    const currentFloor = floorAt(foot);
    // A wave may finish while jumping. Defer its supplies until the player has
    // supporting ground instead of placing floating cases or falling back to
    // a distant arena anchor.
    if (!Number.isFinite(currentFloor) || Math.abs(currentFloor - foot.y) > 0.28) return false;
    foot.y = currentFloor;
    // A cramped position may expose no valid place. Retry after movement, or
    // twice a second when stationary, without scanning the world every frame.
    if (placementDelay > 0 && lastPlacementFoot.distanceToSquared(foot) < 0.04) return false;
    placementDelay = 0.5;
    lastPlacementFoot.copy(foot);
    sightStart.set(foot.x, foot.y + 0.95, foot.z);
    const candidates = defenseSupplyCandidates({ arena, playerFoot: foot, wave });
    for (const entry of list) {
      if (!entry.amount || entry.issued) continue;
      let point = null;
      for (const candidate of candidates) {
        point = safePosition(candidate);
        if (point) break;
      }
      if (!point) continue;
      entry.floorY = point.y;
      entry.baseY = point.y + (entry.kind === 'ammo' ? 0.006 : 0.45);
      entry.mesh.position.set(point.x, entry.baseY, point.z);
      entry.mesh.rotation.set(0, Math.atan2(foot.x - point.x, foot.z - point.z), 0);
      entry.active = true;
      entry.issued = true;
      entry.mesh.visible = true;
      entry.mesh.userData.defenseWave = wave;
      if (entry.kind === 'armor') {
        entry.mesh.userData.armorStrength = entry.amount;
        const marks = entry.mesh.getObjectByName('armor-vest-bullet-marks');
        if (marks) marks.visible = entry.amount < MAX_ARMOR;
      }
    }
    for (const item of weaponQueue) {
      if (item.issued) continue;
      let point = null;
      for (const candidate of candidates) {
        // Full-length firearms need a wider footprint than resource cases.
        point = safePosition(candidate, 0.7);
        if (point) break;
      }
      if (!point) continue;
      const placed = { type: item.type, ammo: item.ammo, position: point };
      const spawned = spawnWeapon(placed);
      if (spawned !== null && spawned !== false) {
        weaponPlacements.push(placed);
        item.issued = true;
      }
    }
    pending = list.some(entry => entry.amount > 0 && !entry.issued) || weaponQueue.some(item => !item.issued);
    return true;
  }

  function collect(entry) {
    let amount = 0, weaponType = null;
    if (entry.kind === 'health') {
      amount = Math.min(entry.amount, Math.max(0, 100 - player.health));
      if (amount > 0) player.health += amount;
    } else if (entry.kind === 'armor') {
      const current = clampArmor(player.armor);
      if (entry.amount > current) {
        player.armor = entry.amount;
        amount = entry.amount - current;
      }
    } else {
      const available = ammoSupplyAmount(weapons, entry.amount);
      if (!available) return;
      weaponType = weapons.current;
      amount = weapons.acceptReserveAmmo(available, AMMO_RESERVE_LIMITS[weaponType]);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > available) return;
    }
    if (!(amount > 0)) return;
    hide(entry);
    // Each pack is a one-shot transaction. A partially useful pickup does not
    // become an unlimited source after a weapon swap or a later injury.
    onCollect({ kind: entry.kind, amount, strength: entry.amount, weaponType, arena, wave });
  }

  const api = {
    list,
    init(options = {}) {
      const required = ['floorAt', 'blocked', 'canCollect'];
      if (!options.world?.add || !options.player?.pos || !options.weapons
        || typeof options.weapons.acceptReserveAmmo !== 'function'
        || required.some(key => typeof options[key] !== 'function')) {
        throw new TypeError('Defense supplies require world, player, weapons and gameplay/placement callbacks');
      }
      api.clear();
      ({ world, player, weapons, floorAt, blocked, canCollect, spawnWeapon,
        onCollect = () => {}, clearWeapons = () => {}, colliders = Colliders.list } = options);
      if (!list.length) {
        const ammo = buildAmmoBox({ position: { x: 0, y: 0, z: 0 }, width: 0.64, height: 0.34, depth: 0.28 }, createResources());
        const models = [
          ['ammo', ammo.mesh], ['health', createHealthPickupModel()], ['armor', createArmorPickupModel({ damaged: true })],
        ];
        for (const [kind, mesh] of models) {
          mesh.name = 'defense-supply-' + kind;
          mesh.userData.defenseSupply = kind;
          mesh.visible = false;
          list.push({ id: mesh.name, kind, mesh, amount: 0, active: false, issued: false, floorY: 0, baseY: 0 });
        }
      }
      for (const entry of list) world.add(entry.mesh);
      return api;
    },
    refill(request = {}) {
      if (!world) return api.snapshot();
      if (request.arena === arena && request.wave <= wave) return api.snapshot();
      // Validate before replacing the last wave, so a malformed request cannot
      // erase usable supplies or grant a second budget for an old wave.
      if (!['roof', 'street'].includes(request.arena) || !Number.isSafeInteger(request.wave)
        || request.wave < 1 || request.wave > 100) return api.snapshot();
      const nextBudget = defenseSupplyBudget({ ...request, health: player.health, armor: player.armor, weapon: weapons });
      for (const entry of list) hide(entry);
      clearWeapons();
      weaponPlacements.length = 0;
      weaponQueue.length = 0;
      arena = request.arena;
      wave = request.wave;
      difficulty = request.difficulty;
      budget = nextBudget;
      if (typeof spawnWeapon === 'function') for (const item of budget.weapons) weaponQueue.push({ ...item, issued: false });
      for (const entry of list) {
        const value = budget[entry.kind === 'ammo' ? 'ammoUnits' : entry.kind];
        entry.amount = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
        entry.issued = false;
      }
      pending = true;
      elapsed = 0;
      placementDelay = 0;
      lastPlacementFoot.set(Infinity, Infinity, Infinity);
      placePending();
      return api.snapshot();
    },
    update(dt) {
      if (!world || !Number.isFinite(dt) || dt <= 0 || !canCollect() || !(player.health > 0)) return;
      placementDelay = Math.max(0, placementDelay - dt);
      placePending();
      if (!readFoot()) return;
      elapsed += dt;
      sightStart.set(foot.x, foot.y + 0.95, foot.z);
      for (const entry of list) {
        if (!entry.active) continue;
        if (entry.kind !== 'ammo') {
          entry.mesh.position.y = entry.baseY + Math.sin(elapsed * 2.5) * 0.035;
          entry.mesh.rotation.y += dt * 0.8;
        }
        if (Math.abs(foot.y - entry.floorY) > 0.5) continue;
        const dx = foot.x - entry.mesh.position.x, dz = foot.z - entry.mesh.position.z;
        if (dx * dx + dz * dz >= PICKUP_RADIUS_SQ) continue;
        sightEnd.set(entry.mesh.position.x, entry.floorY + 0.5, entry.mesh.position.z);
        if (!isSegmentOccluded(sightStart, sightEnd, colliders)) collect(entry);
      }
    },
    clear() {
      for (const entry of list) { hide(entry); entry.amount = 0; entry.issued = false; }
      clearWeapons();
      weaponPlacements.length = 0;
      weaponQueue.length = 0;
      placementDelay = 0;
      lastPlacementFoot.set(Infinity, Infinity, Infinity);
      elapsed = 0; arena = null; wave = 0; difficulty = null; budget = null; pending = false;
    },
    reset() { api.clear(); },
    snapshot() {
      return {
        arena, wave, difficulty, budget, pending,
        active: list.reduce((count, entry) => count + Number(entry.active), 0),
        weapons: weaponPlacements.map(entry => ({ type: entry.type, ammo: entry.ammo, position: { ...entry.position } })),
        supplies: list.map(entry => ({
          id: entry.id, kind: entry.kind, amount: entry.amount, active: entry.active, issued: entry.issued, floorY: entry.floorY,
          position: { x: entry.mesh.position.x, y: entry.mesh.position.y, z: entry.mesh.position.z },
        })),
      };
    },
    status() { return api.snapshot(); },
  };
  return api;
}

export const DefenseSupplies = createDefenseSupplies();
