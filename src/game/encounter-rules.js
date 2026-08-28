// Spatial encounter pacing stays independent of the renderer, input and AI.
// Route coordinates describe feet positions along an authored centerline.
import { encounterSpawnRole } from './rear-encounter-rules.js';
import { createEncounterVariation } from './encounter-variation.js';

const EPSILON = 1e-6;

export function routeDistanceAt(route, position) {
  if (!route || !position || !Number.isFinite(position.x)
    || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return null;
  if (Math.abs(position.y - route.floorY) > (route.maxHeightDifference ?? 1.2)) return null;
  let lengthBefore = 0;
  let nearestDistanceSquared = Infinity;
  let distanceAlong = 0;
  for (let index = 1; index < route.points.length; index++) {
    const from = route.points[index - 1], to = route.points[index];
    const dx = to.x - from.x, dz = to.z - from.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= EPSILON) continue;
    const fraction = Math.max(0, Math.min(1,
      ((position.x - from.x) * dx + (position.z - from.z) * dz) / lengthSquared));
    const awayX = position.x - from.x - fraction * dx;
    const awayZ = position.z - from.z - fraction * dz;
    const distanceSquared = awayX * awayX + awayZ * awayZ;
    const length = Math.sqrt(lengthSquared);
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      distanceAlong = lengthBefore + fraction * length;
    }
    lengthBefore += length;
  }
  const maxDistance = route.maxLateralDistance ?? 2.3;
  return nearestDistanceSquared <= maxDistance * maxDistance ? distanceAlong : null;
}

/** A retreat never re-arms an earlier ambush; a checkpoint retry starts fresh. */
export class EncounterRouteProgress {
  constructor(route) {
    this.route = route;
    this.distance = 0;
  }
  update(position) {
    const distance = routeDistanceAt(this.route, position);
    if (distance !== null) this.distance = Math.max(this.distance, distance);
    return this.distance;
  }
  reset() { this.distance = 0; }
}

export function encounterWaveReady(config, index, timer, routeProgress, footY, recoveryDelay = config.waveInterval) {
  if (!Number.isInteger(index) || index < 0 || index >= config.waveCount) return false;
  if (!Number.isFinite(timer) || !Number.isFinite(footY)) return false;
  const stage = config.stages?.[index];
  if (footY + EPSILON < (stage?.minFootY ?? config.waveMinFootY?.[index] ?? -Infinity)) return false;
  if (footY - EPSILON > (stage?.maxFootY ?? Infinity)) return false;
  if (stage && !Number.isFinite(routeProgress)) return false;
  if (stage && routeProgress + EPSILON < (stage.minProgress ?? 0)) return false;
  if (timer <= EPSILON) return true;
  // Holding position gives the full breather. A player pushing into the next
  // stretch can bring contacts forward after a guaranteed recovery interval,
  // while there is still enough distance to place them safely ahead.
  const advancingRoute = stage?.advanceAt !== undefined && routeProgress + EPSILON >= stage.advanceAt;
  const ascendingFlight = stage?.advanceFootY !== undefined && footY + EPSILON >= stage.advanceFootY;
  return index > 0 && (advancingRoute || ascendingFlight)
    && Number.isFinite(recoveryDelay) && timer <= recoveryDelay - config.minRecovery + EPSILON;
}

export function encounterSpawnCandidates(config, index, routeProgress, footY) {
  const stage = config.stages?.[index];
  // These are the forward anchors. Passed front landings retire their pending
  // roster; an explicit rear slot uses separately authored lower anchors.
  if (stage?.departAbove !== undefined && footY > stage.departAbove) return [];
  const candidates = stage ? stage.spawnIndices.map(spawnIndex => config.spawns[spawnIndex]) : config.spawns;
  if (!config.route) return candidates;
  if (!stage) return [];
  const margin = config.forwardSpawnMargin ?? 0.25;
  return candidates.filter(point => {
    const distance = routeDistanceAt(config.route, point);
    return distance !== null && distance > routeProgress + margin;
  });
}

function hasDepartedStage(stage, footY, grounded) {
  return stage && ((stage.departBelow !== undefined && footY < stage.departBelow)
    || (stage.departAbove !== undefined && grounded && footY > stage.departAbove));
}

function entryRole(config, entry) {
  return config.rearPressure
    ? encounterSpawnRole(entry.entryIndex, config.waves[entry.waveIndex].length, config.rearEntryIndices)
    : 'front';
}

/**
 * Finite wave ownership and arrival timing, with no renderer or enemy objects.
 * The caller supplies live counts and confirms a spawn only after geometry and
 * pool checks succeed. The update result is reused; consume it before ticking.
 */
export class EncounterSchedule {
  constructor(config, { seed = null } = {}) {
    this.config = config;
    this.variation = createEncounterVariation(config, seed);
    this.events = { queuedWave: null, clearedWaves: [], clearedFrontWaves: [], retiredWaves: [], completed: false };
    this.reset();
  }

  reset() {
    this.waveIndex = 0;
    this.timer = this.variation.firstDelay;
    this.timerDuration = this.timer;
    this.recoveryDelay = this.variation.recoveryDelays[0] ?? this.config.waveInterval;
    this.pending = [];
    this.groups = [];
    this.spawned = 0;
    this.skipped = 0;
    this.cleared = false;
    this.reinforcementsActive = false;
  }

  get total() { return this.config.waves.reduce((sum, wave) => sum + wave.length, 0); }
  get seed() { return this.variation.seed; }
  get pendingTypes() { return this.pending.map(entry => entry.type); }
  get unstartedTypes() { return this.config.waves.slice(this.waveIndex).flat(); }
  get clearedWaves() { return this.groups.filter(group => group.cleared).length; }
  get wavePending() { return this.groups.some(group => !group.cleared && !group.retired); }

  update(dt, { alive = 0, aliveByWave = [], frontAliveByWave = [], routeProgress = 0, footY = 0, grounded = true } = {}) {
    const events = this.events;
    events.queuedWave = null;
    events.clearedWaves.length = 0;
    events.clearedFrontWaves.length = 0;
    events.retiredWaves.length = 0;
    events.completed = false;
    if (this.cleared || !Number.isFinite(dt) || dt < 0 || !Number.isFinite(footY)) return events;
    for (const entry of this.pending) entry.waitedSeconds += dt;

    for (const group of this.groups) {
      if (group.cleared || group.retired) continue;
      // Missing role counts are conservative: a living rear contact may delay
      // a pair, but can never make a living forward contact appear defeated.
      const frontAlive = frontAliveByWave[group.index] ?? aliveByWave[group.index] ?? 0;
      if (!group.frontCleared && group.frontPending === 0 && group.frontSpawned > 0 && frontAlive === 0) {
        group.frontCleared = true;
        events.clearedFrontWaves.push(group.index);
      }
      if (group.pending === 0 && group.spawned > 0 && (aliveByWave[group.index] || 0) === 0) {
        group.cleared = true;
        events.clearedWaves.push(group.index);
      }
    }

    let resetTimer = false;
    const policy = this.config.reinforcements;
    if (policy && !this.reinforcementsActive && this.groups[policy.afterClearWave]?.cleared) {
      this.reinforcementsActive = true;
      this.timer = this.variation.reinforcementFirstDelay;
      this.timerDuration = this.timer;
      resetTimer = true;
    } else if (!this.reinforcementsActive
      && (this.config.advanceOnFrontClear ? events.clearedFrontWaves.length : events.clearedWaves.length)) {
      this.recoveryDelay = this.variation.recoveryDelays[this.waveIndex] ?? this.config.waveInterval;
      this.timer = this.recoveryDelay;
      this.timerDuration = this.timer;
      resetTimer = true;
    }

    // Passing a platform abandons its unspawned contacts without clear credit.
    // Reversible stairs retain living pursuers; irreversible scaffold drops
    // retire them too. Ascent needs ground support so a jump cannot skip a pair.
    for (const group of this.groups) {
      const stage = this.config.stages?.[group.index];
      if (group.cleared || group.retired || !hasDepartedStage(stage, footY, grounded)) continue;
      this.skipped += group.pending + (this.config.retireLive === false ? 0 : (aliveByWave[group.index] || 0));
      this.pending = this.pending.filter(entry => entry.waveIndex !== group.index);
      group.pending = 0;
      group.frontPending = 0;
      group.retired = true;
      events.retiredWaves.push(group.index);
    }
    while (this.waveIndex < this.config.waveCount) {
      if (!hasDepartedStage(this.config.stages?.[this.waveIndex], footY, grounded)) break;
      const index = this.waveIndex++;
      this.groups.push({ index, pending: 0, spawned: 0, frontPending: 0, frontSpawned: 0, frontCleared: false, cleared: false, retired: true });
      this.skipped += this.config.waves[index].length;
      events.retiredWaves.push(index);
    }
    if (events.retiredWaves.length) {
      this.timer = this.config.stageTransitionDelay ?? 0.75;
      this.timerDuration = this.timer;
      resetTimer = true;
    }

    const allGroupsDone = this.groups.every(group => group.cleared || group.retired);
    const frontGroupsDone = this.config.advanceOnFrontClear
      ? this.groups.every(group => group.frontCleared || group.cleared || group.retired) : allGroupsDone;
    if (this.waveIndex >= this.config.waveCount) {
      this.cleared = this.spawned > 0 && !this.pending.length && allGroupsDone && alive === 0;
      events.completed = this.cleared;
      return events;
    }

    if (!resetTimer && (this.waveIndex === 0 || this.reinforcementsActive || frontGroupsDone)) {
      this.timer -= dt;
    }
    const canQueue = this.waveIndex === 0
      || (this.reinforcementsActive ? this.pending.length === 0 : frontGroupsDone);
    if (!canQueue || !encounterWaveReady(this.config, this.waveIndex, this.timer, routeProgress, footY, this.recoveryDelay)) return events;
    const index = this.waveIndex++;
    const types = this.config.composition(index);
    const entries = types.map((type, entryIndex) => ({ type, waveIndex: index, entryIndex, waitedSeconds: 0 }));
    this.groups.push({
      index, pending: entries.length, spawned: 0,
      frontPending: entries.filter(entry => entryRole(this.config, entry) === 'front').length,
      frontSpawned: 0, frontCleared: false, cleared: false, retired: false,
    });
    this.pending.push(...entries);
    events.queuedWave = index;
    if (this.reinforcementsActive) {
      this.timer = this.variation.reinforcementIntervals[this.waveIndex] ?? policy.interval;
      this.timerDuration = this.timer;
    }
    return events;
  }

  /**
   * A false callback retains the exact pending entries. A forward pair needs
   * two free slots and an atomic callback: both rigs are acquired or neither
   * contact is consumed. One rear reserve can never take a forward pair slot.
   */
  spawnAvailable({ total = 0, byType = {}, rearAlive = 0 }, trySpawn, trySpawnPair) {
    let spawned = 0;
    let rearSpawned = 0;
    const counts = { ...byType };
    const attemptedPairs = new Set();
    const commit = entry => {
      this.pending.splice(this.pending.indexOf(entry), 1);
      const group = this.groups[entry.waveIndex];
      group.pending--;
      group.spawned++;
      if (entryRole(this.config, entry) === 'front') {
        group.frontPending--;
        group.frontSpawned++;
      } else rearSpawned++;
      this.spawned++;
      spawned++;
      counts[entry.type] = (counts[entry.type] || 0) + 1;
    };
    let index = 0;
    while (index < this.pending.length && total + spawned < this.config.maxAlive) {
      const entry = this.pending[index];
      const role = entryRole(this.config, entry);
      const group = this.groups[entry.waveIndex];
      if (role === 'front' && this.config.frontPairSize === 2 && entry.entryIndex < 2) {
        if (attemptedPairs.has(entry.waveIndex)) { index++; continue; }
        attemptedPairs.add(entry.waveIndex);
        const pair = this.pending.filter(candidate => candidate.waveIndex === entry.waveIndex
          && candidate.entryIndex < 2 && entryRole(this.config, candidate) === 'front')
          .sort((a, b) => a.entryIndex - b.entryIndex);
        const pairCounts = { ...counts };
        const fitsTypes = pair.every(candidate => {
          pairCounts[candidate.type] = (pairCounts[candidate.type] || 0) + 1;
          return pairCounts[candidate.type] <= (this.config.typeCaps?.[candidate.type] ?? Infinity);
        });
        if (pair.length !== 2 || total + spawned + 2 > this.config.maxAlive || !fitsTypes
          || typeof trySpawnPair !== 'function' || !trySpawnPair(pair, group.spawned === 0)) { index++; continue; }
        for (const candidate of pair) commit(candidate);
        continue;
      }
      if (role === 'rear' && rearAlive + rearSpawned >= (this.config.maxRearAlive ?? Infinity)) { index++; continue; }
      if ((counts[entry.type] || 0) >= (this.config.typeCaps?.[entry.type] ?? Infinity)) { index++; continue; }
      // One blocked forward anchor must not starve a safe rear arrival. Each
      // pending slot is tried at most once per call, retaining its authored ID.
      if (!trySpawn(entry, group.spawned === 0)) { index++; continue; }
      commit(entry);
    }
    return spawned;
  }
}
