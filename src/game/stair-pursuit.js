import { BALCONY } from '../world/layout.js';
import { STAIRS } from '../world/stair-layout.js';
import { ENEMY_MEMORY_SECONDS } from './combat-rules.js';
import { MAX_INVESTIGATION_SECONDS } from './enemy-navigation.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
const samePoint = (a, b) => distance(a, b) < 0.001;

// Flat end landings and sloped flights have different grades. Split the
// authored route at the real flight ends so stacked floors cannot project
// onto one another. The outer points are the two actual tower doorways.
const route = [{ x: (STAIRS.entryDoor.min[0] + STAIRS.entryDoor.max[0]) / 2, y: STAIRS.entryY, z: BALCONY.laneZ }];
for (let index = 0; index < STAIRS.route.length; index++) {
  const point = STAIRS.route[index], previous = STAIRS.route[index - 1];
  if (previous && point[1] !== previous[1]) {
    const flight = STAIRS.flights.find(item => item.fromY === previous[1] && item.toY === point[1]);
    route.push({ x: flight.x, y: flight.fromY, z: flight.zStart }, { x: flight.x, y: flight.toY, z: flight.zEnd });
  }
  route.push({ x: point[0], y: point[1], z: point[2] });
}
route.push({ x: STAIRS.roofExit[0], y: STAIRS.roofExit[1], z: STAIRS.roofExit[2] });
const routeDistances = [0];
for (let index = 1; index < route.length; index++) routeDistances.push(routeDistances[index - 1] + distance(route[index - 1], route[index]));

function inTower(point, margin = 0) {
  const bounds = STAIRS.footprint;
  return point.x >= bounds.x1 - margin && point.x <= bounds.x2 + margin
    && point.z >= bounds.z1 - margin && point.z <= bounds.z2 + margin;
}

function projection(point, result) {
  let best = Infinity;
  for (let index = 0; index < route.length - 1; index++) {
    const a = route[index], b = route[index + 1];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    // Elevation matters more than a small offset within a two-metre lane.
    const lengthSquared = dx * dx + dy * dy * 16 + dz * dz;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy * 16 + (point.z - a.z) * dz) / lengthSquared));
    const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
    const score = (point.x - x) ** 2 + (point.y - y) ** 2 * 16 + (point.z - z) ** 2;
    if (score >= best) continue;
    best = score;
    Object.assign(result, { x, y, z, index, progress: routeDistances[index] + distance(a, b) * t });
  }
  return result;
}

export function createStairPursuit() {
  return {
    active: false, path: [], pointPool: [], index: 0, routeLength: 0,
    goal: { x: 0, y: 0, z: 0 }, from: {}, to: {},
  };
}

export function resetStairPursuit(state) {
  if (!state) return;
  state.active = false; state.path.length = 0; state.index = 0; state.routeLength = 0;
}

function append(state, point) {
  if (state.path.length && samePoint(state.path[state.path.length - 1], point)) return;
  const index = state.path.length;
  const stored = state.pointPool[index] ?? (state.pointPool[index] = {});
  stored.x = point.x; stored.y = point.y; stored.z = point.z;
  state.path.push(stored);
}

function buildPath(state, position, goal) {
  resetStairPursuit(state);
  Object.assign(state.goal, goal);
  const start = projection(position, state.from), end = projection(goal, state.to);
  // An observation outside the tower must be reached through its doorway,
  // never by drawing a diagonal from the nearest interior lane through a wall.
  if (!inTower(goal)) {
    if (Math.abs(goal.y - STAIRS.entryY) < 0.5) Object.assign(end, route[0], { index: 0, progress: 0 });
    else if (Math.abs(goal.y - STAIRS.exitY) < 0.5) {
      Object.assign(end, route[route.length - 1], { index: route.length - 2, progress: routeDistances[route.length - 1] });
    }
  }
  if (horizontalDistance(position, start) > 0.10) append(state, start);
  if (end.progress >= start.progress) {
    for (let index = start.index + 1; index < route.length && routeDistances[index] < end.progress - 0.01; index++) append(state, route[index]);
  } else {
    for (let index = start.index; index >= 0 && routeDistances[index] > end.progress + 0.01; index--) append(state, route[index]);
  }
  append(state, end); append(state, goal);
  let previous = position;
  for (const point of state.path) { state.routeLength += distance(previous, point); previous = point; }
  state.active = true;
}

/** Only the supplied observed foot position is used; this module never reads Player. */
export function stairPursuitWaypoint(state, position, observedGoal) {
  if (!state || !finitePoint(position) || !finitePoint(observedGoal)
    || !inTower(position, 1.2) || position.y < STAIRS.entryY - 0.4 || position.y > STAIRS.exitY + 0.5
    || observedGoal.y < STAIRS.entryY - 0.4 || observedGoal.y > STAIRS.exitY + 0.5
    || (!inTower(position) && !inTower(observedGoal) && Math.abs(position.y - observedGoal.y) < 0.4)) {
    resetStairPursuit(state);
    return null;
  }
  if (!state.active || distance(state.goal, observedGoal) > 0.55) buildPath(state, position, observedGoal);
  // Finishing the landing turn is deliberate. Merely being close to the
  // target in X/Z is not enough to cut across a guard or an open flight.
  while (state.index < state.path.length && horizontalDistance(position, state.path[state.index]) < 0.08
    && Math.abs(position.y - state.path[state.index].y) < 0.55) state.index++;
  return state.path[state.index] ?? null;
}

/** A known stair detour earns the same bounded travel memory as an A* route. */
export function stairPursuitMemorySeconds(state, observedGoal, speed) {
  if (!state?.active || state.index >= state.path.length || !finitePoint(observedGoal)
    || distance(state.goal, observedGoal) > 0.56 || !Number.isFinite(speed) || speed <= 0) return ENEMY_MEMORY_SECONDS;
  return Math.min(MAX_INVESTIGATION_SECONDS, Math.max(ENEMY_MEMORY_SECONDS, state.routeLength / (speed * 0.65) + 1.25));
}

/** Give a reinforcement one initial search observation, not persistent player knowledge. */
export function primeEnemyInvestigation(enemy, eyePosition, footY) {
  if (!enemy || enemy.alive === false || enemy.removed || !finitePoint(eyePosition) || !Number.isFinite(footY)) return false;
  enemy.lastSeenPosition ??= { x: 0, y: 0, z: 0 };
  Object.assign(enemy.lastSeenPosition, { x: eyePosition.x, y: eyePosition.y, z: eyePosition.z });
  enemy.lastSeenFootY = footY; enemy.lastSeenPlayer = true; enemy.timeSinceSeen = 0;
  enemy.losCached = false; enemy.losTimer = -Infinity; enemy.losSampleTime = -Infinity;
  enemy.spawnGrace = Math.max(1, enemy.spawnGrace || 0);
  enemy.windupRemaining = -1; enemy.swingTimer = 0; enemy.burstLeft = 0; enemy.aimCommitted = false;
  enemy.stairPursuit ??= createStairPursuit();
  resetStairPursuit(enemy.stairPursuit);
  if (enemy.zone === 'stairwell' && finitePoint(enemy.pos)) {
    stairPursuitWaypoint(enemy.stairPursuit, enemy.pos, { x: eyePosition.x, y: footY, z: eyePosition.z });
  }
  return true;
}
