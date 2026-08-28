// Spatial encounter pacing stays independent of the renderer, input and AI.
// Route coordinates describe feet positions along an authored centerline.
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

export function encounterWaveReady(config, index, timer, routeProgress, footY) {
  if (!Number.isInteger(index) || index < 0 || index >= config.waveCount) return false;
  if (!Number.isFinite(timer) || !Number.isFinite(footY)) return false;
  const stage = config.stages?.[index];
  if (footY + EPSILON < (stage?.minFootY ?? config.waveMinFootY?.[index] ?? -Infinity)) return false;
  if (footY - EPSILON > (stage?.maxFootY ?? Infinity)) return false;
  if (stage && !Number.isFinite(routeProgress)) return false;
  if (stage && routeProgress + EPSILON < (stage.minProgress ?? 0)) return false;
  if (timer <= 0) return true;
  // Holding position gives the full breather. A player pushing into the next
  // stretch can bring contacts forward after a guaranteed recovery interval,
  // while there is still enough distance to place them safely ahead.
  const advancingRoute = stage?.advanceAt !== undefined && routeProgress + EPSILON >= stage.advanceAt;
  const ascendingFlight = stage?.advanceFootY !== undefined && footY + EPSILON >= stage.advanceFootY;
  return index > 0 && (advancingRoute || ascendingFlight)
    && timer <= config.waveInterval - config.minRecovery + EPSILON;
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

/**
 * Finite wave ownership and arrival timing, with no renderer or enemy objects.
 * The caller supplies live counts and confirms a spawn only after geometry and
 * pool checks succeed. The update result is reused; consume it before ticking.
 */
export class EncounterSchedule {
  constructor(config) {
    this.config = config;
    this.events = { queuedWave: null, clearedWaves: [], retiredWaves: [], completed: false };
    this.reset();
  }

  reset() {
    this.waveIndex = 0;
    this.timer = this.config.firstWave;
    this.pending = [];
    this.groups = [];
    this.spawned = 0;
    this.skipped = 0;
    this.cleared = false;
    this.reinforcementsActive = false;
  }

  get total() { return this.config.waves.reduce((sum, wave) => sum + wave.length, 0); }
  get pendingTypes() { return this.pending.map(entry => entry.type); }
  get unstartedTypes() { return this.config.waves.slice(this.waveIndex).flat(); }
  get clearedWaves() { return this.groups.filter(group => group.cleared).length; }
  get wavePending() { return this.groups.some(group => !group.cleared && !group.retired); }

  update(dt, { alive = 0, aliveByWave = [], routeProgress = 0, footY = 0, grounded = true } = {}) {
    const events = this.events;
    events.queuedWave = null;
    events.clearedWaves.length = 0;
    events.retiredWaves.length = 0;
    events.completed = false;
    if (this.cleared || !Number.isFinite(dt) || dt < 0 || !Number.isFinite(footY)) return events;
    for (const entry of this.pending) entry.waitedSeconds += dt;

    for (const group of this.groups) {
      if (group.cleared || group.retired || group.pending || !group.spawned) continue;
      if ((aliveByWave[group.index] || 0) === 0) {
        group.cleared = true;
        events.clearedWaves.push(group.index);
      }
    }

    let resetTimer = false;
    const policy = this.config.reinforcements;
    if (policy && !this.reinforcementsActive && this.groups[policy.afterClearWave]?.cleared) {
      this.reinforcementsActive = true;
      this.timer = policy.firstDelay;
      resetTimer = true;
    } else if (!this.reinforcementsActive && events.clearedWaves.length) {
      this.timer = this.config.waveInterval;
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
      group.retired = true;
      events.retiredWaves.push(group.index);
    }
    while (this.waveIndex < this.config.waveCount) {
      if (!hasDepartedStage(this.config.stages?.[this.waveIndex], footY, grounded)) break;
      const index = this.waveIndex++;
      this.groups.push({ index, pending: 0, spawned: 0, cleared: false, retired: true });
      this.skipped += this.config.waves[index].length;
      events.retiredWaves.push(index);
    }
    if (events.retiredWaves.length) {
      this.timer = this.config.stageTransitionDelay ?? 0.75;
      resetTimer = true;
    }

    const allGroupsDone = this.groups.every(group => group.cleared || group.retired);
    if (this.waveIndex >= this.config.waveCount) {
      this.cleared = this.spawned > 0 && !this.pending.length && allGroupsDone && alive === 0;
      events.completed = this.cleared;
      return events;
    }

    if (!resetTimer && (this.waveIndex === 0 || this.reinforcementsActive || allGroupsDone)) {
      this.timer -= dt;
    }
    const canQueue = this.waveIndex === 0
      || (this.reinforcementsActive ? this.pending.length === 0 : allGroupsDone);
    if (!canQueue || !encounterWaveReady(this.config, this.waveIndex, this.timer, routeProgress, footY)) return events;
    const index = this.waveIndex++;
    const types = this.config.composition(index);
    this.groups.push({ index, pending: types.length, spawned: 0, cleared: false, retired: false });
    for (const [entryIndex, type] of types.entries()) this.pending.push({ type, waveIndex: index, entryIndex, waitedSeconds: 0 });
    events.queuedWave = index;
    if (this.reinforcementsActive) this.timer = policy.interval;
    return events;
  }

  /** A false spawn callback keeps that contact pending; capacity is never exceeded. */
  spawnAvailable({ total = 0, byType = {} }, trySpawn) {
    let spawned = 0;
    const counts = { ...byType };
    let index = 0;
    while (index < this.pending.length && total + spawned < this.config.maxAlive) {
      const entry = this.pending[index];
      if ((counts[entry.type] || 0) >= (this.config.typeCaps?.[entry.type] ?? Infinity)) { index++; continue; }
      const group = this.groups[entry.waveIndex];
      // One blocked forward anchor must not starve a safe rear arrival. Each
      // pending slot is tried at most once per call, retaining its authored ID.
      if (!trySpawn(entry, group.spawned === 0)) { index++; continue; }
      this.pending.splice(index, 1);
      group.pending--;
      group.spawned++;
      this.spawned++;
      spawned++;
      counts[entry.type] = (counts[entry.type] || 0) + 1;
    }
    return spawned;
  }
}
