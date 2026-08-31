/** Static geometry queries and incremental navigation; no renderer or player state. */
import { ENEMY_MEMORY_SECONDS } from './combat-rules.js';
import { findStepUp, moveCapsule } from '../core/collision.js';

export const MAX_INVESTIGATION_SECONDS = 12;
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const FOOTPRINT = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071], [0.7071, -0.7071]];
const EMPTY = Object.freeze([]);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Peak for alternative encounters, including survivors across their waves. */
export function enemyPoolCapacity(type, encounters, corpseReserve = 2) {
  let alive = 0;
  for (const encounter of encounters) {
    // Turning during a pressure encounter can replace an armed contact with
    // melee. Those survivors still need their final archetype's pooled rig.
    const canReplace = encounter.rearPressure && (type === 'brawler' || type === 'thug');
    const count = (encounter.waves ?? []).reduce((total, wave) => total + wave.filter(value =>
      value === type || (canReplace && (type === 'brawler' || value !== 'brawler'))).length, 0);
    const limit = Math.max(0, encounter.maxAlive ?? 0);
    const typeLimit = encounter.typeCaps?.[type] ?? limit;
    alive = Math.max(alive, Math.min(count, limit, typeLimit));
  }
  return alive + Math.max(0, corpseReserve);
}

/** Every checkpoint may leave survivors; only one finale is ever selected. */
export function enemyCampaignPoolCapacity(type, encounters, finales, corpseReserve = 2) {
  const survivors = encounters.reduce((total, encounter) => total + enemyPoolCapacity(type, [encounter], 0), 0);
  return survivors + enemyPoolCapacity(type, finales, corpseReserve);
}

export function createNavigationAgent() {
  return {
    path: [], pointPool: [], index: 0,
    generation: -1, floorKey: null, floorMin: Infinity, floorMax: -Infinity, status: 'idle', pending: false,
    nextRequestAt: 0, nextShortcutAt: 0, lastRequestAt: -Infinity, lastWaypointAt: -Infinity,
    goal: { x: 0, y: 0, z: 0 }, start: { x: 0, y: 0, z: 0 },
    routeGoal: { x: 0, y: 0, z: 0 }, routeLength: 0,
    radius: 0.35, height: 1.94, routeVersion: 0,
  };
}

/** A detour grants travel time to the same observation, never a new sighting. */
export function investigationMemorySeconds(agent, observedGoal, speed, generation = agent.generation) {
  if (agent.generation !== generation || agent.index >= agent.path.length ||
      distance(agent.routeGoal, observedGoal) > 1e-6 || !Number.isFinite(agent.routeLength)) return ENEMY_MEMORY_SECONDS;
  const moveSpeed = Number.isFinite(speed) && speed > 0 ? speed : 0.1;
  const travelTime = agent.routeLength / (Math.max(0.1, moveSpeed) * 0.65) + 1.25;
  return Math.min(MAX_INVESTIGATION_SECONDS, Math.max(ENEMY_MEMORY_SECONDS, travelTime));
}

/** Cache the observation as well as the result; a cached true is not a new sighting. */
export function updateSightCache(observer, target, footY, now, testVisibility, interval = 0.16) {
  if (now >= observer.losTimer || now < observer.losSampleTime) {
    observer.losTimer = now + interval;
    observer.losSampleTime = now;
    observer.losCached = Boolean(testVisibility(observer));
    if (observer.losCached) {
      observer.losObservedPosition.x = target.x;
      observer.losObservedPosition.y = target.y;
      observer.losObservedPosition.z = target.z;
      observer.losObservedFootY = footY;
    }
  }
  return observer.losCached;
}

export class EnemyNavigationPlanner {
  constructor({
    bounds = { x1: -40, x2: 40, z1: -26, z2: 45 },
    cellSize = 0.7, bucketSize = 4, radius = 0.39, height = 1.98,
    stepHeight = 0.32, expansionsPerSlice = 96, sliceInterval = 1 / 30,
    maxSearchExpansions = 4096, maxLayers = 12, replanInterval = 0.8,
  } = {}) {
    this.bounds = { ...bounds };
    this.cellSize = cellSize;
    this.bucketSize = bucketSize;
    this.radius = radius;
    this.height = height;
    this.stepHeight = stepHeight;
    this.expansionsPerSlice = expansionsPerSlice;
    this.sliceInterval = sliceInterval;
    this.maxSearchExpansions = maxSearchExpansions;
    this.maxLayers = maxLayers;
    this.replanInterval = replanInterval;
    this.boxes = EMPTY;
    this.revision = -1;
    this.generation = 0;
    this.buckets = new Map();
    this.layers = new Map();
    this.queue = [];
    this.job = null;
    this.nextSliceAt = 0;
    this.lastUpdateAt = -Infinity;
    this._probeBoxes = [];
    this._stepPosition = { x: 0, y: 0, z: 0 };
    this._traceA = { x: 0, y: 0, z: 0 };
    this._traceB = { x: 0, y: 0, z: 0 };
    this._traceGoal = { x: 0, y: 0, z: 0 };
    this._supportFloorY = NaN;
    this.stats = { searches: 0, completed: 0, failed: 0, expansions: 0, lastSliceExpansions: 0, peakSliceExpansions: 0, cellChecks: 0, pathUses: 0 };
  }

  setGeometry(boxes, revision) {
    if (this.boxes === boxes && this.revision === revision) return false;
    this.boxes = boxes;
    this.revision = revision;
    this.generation++;
    this.layers.clear();
    this.buckets.clear();
    if (this.job) { this.job.agent.pending = false; this.job.agent.status = 'invalidated'; }
    for (const agent of this.queue) { agent.pending = false; agent.status = 'invalidated'; }
    this.job = null;
    this.queue.length = 0;
    this.nextSliceAt = 0;
    this.lastUpdateAt = -Infinity;
    const size = this.bucketSize, area = this.bounds;
    for (const box of boxes) {
      const x1 = Math.floor(Math.max(area.x1, box.min.x) / size);
      const x2 = Math.floor(Math.min(area.x2, box.max.x) / size);
      const z1 = Math.floor(Math.max(area.z1, box.min.z) / size);
      const z2 = Math.floor(Math.min(area.z2, box.max.z) / size);
      for (let z = z1; z <= z2; z++) for (let x = x1; x <= x2; x++) {
        const key = `${x},${z}`;
        let bucket = this.buckets.get(key);
        if (!bucket) { bucket = []; this.buckets.set(key, bucket); }
        bucket.push(box);
      }
    }
    return true;
  }

  _near(x, z) { return this.buckets.get(`${Math.floor(x / this.bucketSize)},${Math.floor(z / this.bucketSize)}`) ?? EMPTY; }
  _floor(x, z, hint, downSpan = this.stepHeight + 0.04) {
    let floor = -Infinity;
    for (const box of this._near(x, z)) {
      if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
      const top = box.max.y;
      if (top >= hint - downSpan && top <= hint + this.stepHeight && top > floor) floor = top;
    }
    return floor;
  }
  _blocked(x, y, z, radius, height) {
    const low = y + radius, high = y + height - radius;
    const r2 = radius * radius;
    // Buckets hold boxes expanded by the query's footprint via neighboring
    // lookups. The same box may appear twice, but no collision is missed at a seam.
    const minX = Math.floor((x - radius) / this.bucketSize), maxX = Math.floor((x + radius) / this.bucketSize);
    const minZ = Math.floor((z - radius) / this.bucketSize), maxZ = Math.floor((z + radius) / this.bucketSize);
    for (let bz = minZ; bz <= maxZ; bz++) for (let bx = minX; bx <= maxX; bx++) {
      const nearby = this.buckets.get(`${bx},${bz}`) ?? EMPTY;
      for (const box of nearby) {
        if (box.max.y <= y + 0.005 || box.min.y >= y + height) continue;
        const dx = x < box.min.x ? box.min.x - x : x > box.max.x ? x - box.max.x : 0;
        const dz = z < box.min.z ? box.min.z - z : z > box.max.z ? z - box.max.z : 0;
        const dy = low > box.max.y ? low - box.max.y : high < box.min.y ? box.min.y - high : 0;
        if (dx * dx + dy * dy + dz * dz < r2 - 1e-8) return true;
      }
    }
    return false;
  }

  _gatherBoxes(x, z, radius) {
    const boxes = this._probeBoxes;
    boxes.length = 0;
    const minX = Math.floor((x - radius) / this.bucketSize), maxX = Math.floor((x + radius) / this.bucketSize);
    const minZ = Math.floor((z - radius) / this.bucketSize), maxZ = Math.floor((z + radius) / this.bucketSize);
    for (let bz = minZ; bz <= maxZ; bz++) for (let bx = minX; bx <= maxX; bx++) {
      for (const box of this.buckets.get(`${bx},${bz}`) ?? EMPTY) boxes.push(box);
    }
    return boxes;
  }

  _footprintSupported(x, z, floor, radius) {
    for (const offset of FOOTPRINT) {
      const endX = x + offset[0] * radius, endZ = z + offset[1] * radius;
      const support = this._floor(endX, endZ, floor);
      if (Number.isFinite(support) && Math.abs(support - floor) <= 0.005) continue;
      // A footprint can span two shallow treads. Validate each small change
      // along that footprint instead of comparing its ends to one flat plane.
      const samples = Math.max(1, Math.ceil(radius / 0.12));
      let previous = floor;
      for (let step = 1; step <= samples; step++) {
        const t = step / samples;
        const next = this._floor(x + (endX - x) * t, z + (endZ - z) * t, previous);
        if (!Number.isFinite(next) || Math.abs(next - previous) > this.stepHeight + 1e-6) return false;
        previous = next;
      }
    }
    return true;
  }

  /** Return clear capsule feet after a valid riser chain, or NaN for unsafe terrain. */
  walkableFloor(x, z, hint, radius = this.radius, height = this.height) {
    this._supportFloorY = NaN;
    const area = this.bounds;
    if (!Number.isFinite(x + z + hint) || x - radius < area.x1 || x + radius > area.x2 || z - radius < area.z1 || z + radius > area.z2) return NaN;
    // Auto-stepping can temporarily put the centre above the tread beneath
    // it while its front cap meets the next tread. Recover that support, then
    // prove the lift; this wider lookup never authorizes a larger drop.
    const floor = this._floor(x, z, hint, this.stepHeight + radius + 0.04);
    if (!Number.isFinite(floor) || !this._footprintSupported(x, z, floor, radius)) return NaN;
    let feet = floor;
    if (this._blocked(x, feet + 0.001, z, radius, height)) {
      this._stepPosition.x = x; this._stepPosition.y = feet; this._stepPosition.z = z;
      const raised = findStepUp(this._stepPosition, radius, height, this._gatherBoxes(x, z, radius), this.stepHeight);
      if (raised === null || this._blocked(x, raised + 0.001, z, radius, height)) return NaN;
      feet = raised;
    }
    if (feet < hint - this.stepHeight - 0.04) return NaN;
    this._supportFloorY = floor;
    return feet;
  }

  _sweptBlocked(start, end, radius, height) {
    const dx = end.x - start.x, dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const r2 = radius * radius - 1e-8;
    const lowX = Math.min(start.x, end.x) - radius, highX = Math.max(start.x, end.x) + radius;
    const lowZ = Math.min(start.z, end.z) - radius, highZ = Math.max(start.z, end.z) + radius;
    const minX = Math.floor(lowX / this.bucketSize), maxX = Math.floor(highX / this.bucketSize);
    const minZ = Math.floor(lowZ / this.bucketSize), maxZ = Math.floor(highZ / this.bucketSize);
    for (let bz = minZ; bz <= maxZ; bz++) for (let bx = minX; bx <= maxX; bx++) {
      for (const box of this.buckets.get(`${bx},${bz}`) ?? EMPTY) {
        // Small floor steps are verified by support probes, not treated as walls.
        if (box.max.y <= Math.max(start.y, end.y) + this.stepHeight || box.min.y >= Math.max(start.y, end.y) + height) continue;
        if (box.max.x < lowX || box.min.x > highX || box.max.z < lowZ || box.min.z > highZ) continue;
        let near = 0, far = 1;
        if (Math.abs(dx) < 1e-9) {
          if (start.x < box.min.x || start.x > box.max.x) near = Infinity;
        } else {
          const a = (box.min.x - start.x) / dx, b = (box.max.x - start.x) / dx;
          near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        }
        if (Math.abs(dz) < 1e-9) {
          if (start.z < box.min.z || start.z > box.max.z) near = Infinity;
        } else {
          const a = (box.min.z - start.z) / dz, b = (box.max.z - start.z) / dz;
          near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        }
        if (near <= far) return true;
        // Exact 2D segment-to-rectangle distance covers rounded capsule corners;
        // sparse point samples alone can miss a brief graze between samples.
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const p = endpoint ? end : start;
          const ex = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
          const ez = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
          if (ex * ex + ez * ez < r2) return true;
        }
        for (let ix = 0; ix < 2; ix++) for (let iz = 0; iz < 2; iz++) {
          const x = ix ? box.max.x : box.min.x, z = iz ? box.max.z : box.min.z;
          const t = Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / (lengthSquared || 1)));
          const ex = x - start.x - dx * t, ez = z - start.z - dz * t;
          if (ex * ex + ez * ez < r2) return true;
        }
      }
    }
    return false;
  }

  segmentClear(start, end, radius = this.radius, height = this.height) {
    const floor = this._traverse(start, end, radius, height);
    return Number.isFinite(floor) && Math.abs(floor - end.y) <= this.stepHeight + 0.04;
  }

  _traverse(start, end, radius, height) {
    const length = distance(start, end);
    if (!Number.isFinite(length) || length > 90) return NaN;
    const samples = Math.max(1, Math.ceil(length / 0.12));
    let previousY = start.y, previousSupport = NaN;
    const a = this._traceA, b = this._traceB;
    for (let index = 0; index <= samples; index++) {
      const t = index / samples;
      b.x = start.x + (end.x - start.x) * t; b.z = start.z + (end.z - start.z) * t;
      b.y = this.walkableFloor(b.x, b.z, previousY, radius, height);
      const support = this._supportFloorY;
      if (!Number.isFinite(b.y) || (index > 0 && Math.abs(support - previousSupport) > this.stepHeight + 1e-6)) return NaN;
      // Sweep at the locally validated elevation. Using the final landing's
      // height for a whole flight would hide a lower wall or overhead beam.
      if (index > 0 && this._sweptBlocked(a, b, radius, height)) return NaN;
      previousY = b.y; previousSupport = support;
      a.x = b.x; a.y = b.y; a.z = b.z;
    }
    return previousY;
  }

  /** The normal movement path uses only a short support/clearance probe. */
  canStep(position, dx, dz, radius, height) {
    const goal = this._traceGoal;
    goal.x = position.x + dx; goal.y = position.y; goal.z = position.z + dz;
    return Number.isFinite(this._traverse(position, goal, radius, height));
  }

  /** Apply the same guarded step using the player's tested continuous capsule solver. */
  moveBody(body, dt) {
    if (!Number.isFinite(dt) || dt <= 0) return body;
    const { position, velocity, radius, height } = body;
    const dx = velocity.x * dt, dz = velocity.z * dt;
    if ((dx || dz) && !this.canStep(position, dx, dz, radius, height)) {
      const xOK = this.canStep(position, dx, 0, radius, height);
      const zOK = this.canStep(position, 0, dz, radius, height);
      if (xOK && !zOK) velocity.z = 0;
      else if (zOK && !xOK) velocity.x = 0;
      else if (!xOK && !zOK) { velocity.x = 0; velocity.z = 0; }
      else if (Math.abs(dx) >= Math.abs(dz)) velocity.z = 0;
      else velocity.x = 0;
    }
    const reach = radius + Math.hypot(velocity.x, velocity.z) * Math.min(dt, 1 / 30) + 0.02;
    return moveCapsule(body, dt, this._gatherBoxes(position.x, position.z, reach), Boolean(velocity.x || velocity.z), this.stepHeight);
  }

  _layer(floorY) {
    const key = Math.round(floorY * 2) / 2;
    let layer = this.layers.get(key);
    if (layer) return layer;
    // Restrict each floor to authored supporting boxes, not the world's safety
    // plane. Cells are checked lazily, within the same search work budget.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const box of this.boxes) {
      if (Math.abs(box.max.y - key) > this.stepHeight) continue;
      minX = Math.min(minX, box.min.x); maxX = Math.max(maxX, box.max.x);
      minZ = Math.min(minZ, box.min.z); maxZ = Math.max(maxZ, box.max.z);
    }
    if (!Number.isFinite(minX)) return null;
    const area = this.bounds, cell = this.cellSize;
    minX = Math.max(area.x1, minX); maxX = Math.min(area.x2, maxX);
    minZ = Math.max(area.z1, minZ); maxZ = Math.min(area.z2, maxZ);
    const x = Math.floor(minX / cell) * cell + cell * 0.5;
    const z = Math.floor(minZ / cell) * cell + cell * 0.5;
    const width = Math.max(1, Math.ceil((maxX - x) / cell) + 1);
    const depth = Math.max(1, Math.ceil((maxZ - z) / cell) + 1);
    const count = width * depth;
    if (count > 20000) return null;
    layer = {
      key, x, z, width, depth, count, searchId: 0,
      cells: new Int8Array(count), floors: new Float32Array(count),
      edgeTested: new Uint8Array(count), edgeClear: new Uint8Array(count),
      stamp: new Uint32Array(count), closed: new Uint32Array(count),
      g: new Float32Array(count), f: new Float32Array(count), parent: new Int32Array(count),
      heap: new Int32Array(count), heapIndex: new Int32Array(count), chain: new Int32Array(count),
    };
    if (this.layers.size >= this.maxLayers) this.layers.delete(this.layers.keys().next().value);
    this.layers.set(key, layer);
    return layer;
  }

  _cell(layer, index) {
    if (index < 0 || index >= layer.count) return false;
    if (layer.cells[index]) return layer.cells[index] === 1;
    this.stats.cellChecks++;
    const x = layer.x + index % layer.width * this.cellSize;
    const z = layer.z + Math.floor(index / layer.width) * this.cellSize;
    const floor = this.walkableFloor(x, z, layer.key);
    layer.cells[index] = Number.isFinite(floor) ? 1 : -1;
    layer.floors[index] = floor;
    return layer.cells[index] === 1;
  }
  _point(layer, index, out) {
    out.x = layer.x + index % layer.width * this.cellSize;
    out.z = layer.z + Math.floor(index / layer.width) * this.cellSize;
    out.y = layer.floors[index];
    return out;
  }
  _nearest(layer, point, radius, height, end = false) {
    const cx = Math.round((point.x - layer.x) / this.cellSize);
    const cz = Math.round((point.z - layer.z) / this.cellSize);
    let best = -1, bestDistance = Infinity;
    const candidate = { x: 0, y: 0, z: 0 };
    for (let z = cz - 2; z <= cz + 2; z++) for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || x >= layer.width || z < 0 || z >= layer.depth) continue;
      const index = z * layer.width + x;
      if (!this._cell(layer, index)) continue;
      this._point(layer, index, candidate);
      const d = distance(candidate, point);
      if (d >= bestDistance || d > this.cellSize * 2.2) continue;
      // A player can stand closer to a wall than a wider NPC. The goal may
      // snap nearby, but its connector must remain on the same side of walls.
      if (!this.segmentClear(point, candidate, end ? 0.02 : radius, height)) continue;
      best = index; bestDistance = d;
    }
    return best;
  }

  request(agent, start, goal, now, radius = 0.35, height = 1.94) {
    if (now < agent.lastRequestAt) agent.nextRequestAt = now;
    if (agent.pending || now < agent.nextRequestAt || !Number.isFinite(now + start.x + start.y + start.z + goal.x + goal.y + goal.z)) return false;
    Object.assign(agent.start, start);
    Object.assign(agent.goal, goal);
    agent.radius = radius; agent.height = height;
    agent.pending = true; agent.status = 'pending';
    agent.nextRequestAt = now + this.replanInterval;
    agent.lastRequestAt = now;
    this.queue.push(agent);
    return true;
  }
  cancel(agent) {
    if (!agent) return;
    if (this.job?.agent === agent) this.job = null;
    const index = this.queue.indexOf(agent);
    if (index >= 0) this.queue.splice(index, 1);
    agent.pending = false; agent.status = 'idle'; agent.path.length = 0; agent.index = 0;
    agent.routeLength = 0; agent.generation = -1; agent.floorKey = null;
    agent.floorMin = Infinity; agent.floorMax = -Infinity;
    agent.nextRequestAt = 0; agent.nextShortcutAt = 0;
    agent.lastRequestAt = -Infinity; agent.lastWaypointAt = -Infinity;
  }

  _push(job, index) {
    const layer = job.layer;
    let at = layer.heapIndex[index];
    if (at < 0) { at = job.heapSize++; layer.heap[at] = index; }
    while (at > 0) {
      const parent = (at - 1) >> 1, other = layer.heap[parent];
      if (layer.f[other] <= layer.f[index]) break;
      layer.heap[at] = other; layer.heapIndex[other] = at; at = parent;
    }
    layer.heap[at] = index; layer.heapIndex[index] = at;
  }
  _pop(job) {
    const layer = job.layer, first = layer.heap[0], last = layer.heap[--job.heapSize];
    layer.heapIndex[first] = -1;
    if (!job.heapSize) return first;
    let at = 0;
    while (at * 2 + 1 < job.heapSize) {
      let child = at * 2 + 1;
      if (child + 1 < job.heapSize && layer.f[layer.heap[child + 1]] < layer.f[layer.heap[child]]) child++;
      if (layer.f[last] <= layer.f[layer.heap[child]]) break;
      layer.heap[at] = layer.heap[child]; layer.heapIndex[layer.heap[at]] = at; at = child;
    }
    layer.heap[at] = last; layer.heapIndex[last] = at;
    return first;
  }
  _start(agent) {
    this.stats.searches++;
    // A supported, unobstructed flight is a real connection between floor
    // caches. Validate its gradual rise rather than projecting its top onto
    // the bottom floor, or merging unrelated stacked rooms into one grid.
    if (Math.abs(agent.goal.y - agent.start.y) > this.stepHeight + 0.04 && distance(agent.start, agent.goal) <= 16 &&
        this.segmentClear(agent.start, agent.goal, agent.radius, agent.height)) {
      agent.path.length = 0; agent.index = 0;
      const point = agent.pointPool[0] ?? (agent.pointPool[0] = {});
      Object.assign(point, agent.goal); agent.path.push(point);
      Object.assign(agent.routeGoal, agent.goal);
      agent.routeLength = distance(agent.start, agent.goal);
      agent.floorKey = Math.round(agent.start.y * 2) / 2;
      agent.floorMin = Math.min(agent.start.y, agent.goal.y); agent.floorMax = Math.max(agent.start.y, agent.goal.y);
      agent.generation = this.generation; agent.pending = false; agent.status = 'ready';
      agent.routeVersion++; agent.nextShortcutAt = 0;
      this.stats.completed++;
      return true;
    }
    const layer = this._layer(agent.start.y);
    if (!layer) return false;
    const start = this._nearest(layer, agent.start, agent.radius, agent.height);
    const end = this._nearest(layer, agent.goal, agent.radius, agent.height, true);
    if (start < 0 || end < 0) return false;
    const id = ++layer.searchId;
    const job = { agent, layer, start, end, id, heapSize: 0, expanded: 0, a: {}, b: {} };
    layer.stamp[start] = id; layer.g[start] = 0; layer.f[start] = 0;
    layer.parent[start] = -1; layer.heapIndex[start] = -1;
    this._push(job, start);
    this.job = job;
    return true;
  }
  _edge(job, from, to, direction) {
    const layer = job.layer, bit = 1 << direction;
    if (layer.edgeTested[from] & bit) return Boolean(layer.edgeClear[from] & bit);
    const opposite = 1 << ((direction + 4) % 8);
    layer.edgeTested[from] |= bit; layer.edgeTested[to] |= opposite;
    if (!this._cell(layer, to) || Math.abs(layer.floors[from] - layer.floors[to]) > this.stepHeight) return false;
    const [dx, dz] = DIRECTIONS[direction];
    if (dx && dz && (!this._cell(layer, from + dx) || !this._cell(layer, from + dz * layer.width))) return false;
    this._point(layer, from, job.a); this._point(layer, to, job.b);
    if (!this.segmentClear(job.a, job.b)) return false;
    layer.edgeClear[from] |= bit; layer.edgeClear[to] |= opposite;
    return true;
  }
  _finish(job, reached) {
    const { agent, layer } = job;
    agent.pending = false;
    agent.status = reached ? 'ready' : 'unreachable';
    agent.path.length = 0; agent.index = 0;
    agent.routeLength = 0;
    agent.generation = this.generation; agent.floorKey = layer.key;
    this.job = null;
    if (!reached) { this.stats.failed++; return; }
    this.stats.completed++;
    let length = 0, current = job.end;
    while (current >= 0 && length < layer.count) { layer.chain[length++] = current; current = layer.parent[current]; }
    const append = (point) => {
      const index = agent.path.length;
      const value = agent.pointPool[index] ?? (agent.pointPool[index] = {});
      Object.assign(value, point); agent.path.push(value);
    };
    let previousDX = NaN, previousDZ = NaN;
    // Only collinear edges are joined. Every resulting segment has already
    // passed clearance and support checks; there is no unbounded smoothing pass.
    for (let index = length - 1; index >= 0; index--) {
      current = layer.chain[index];
      this._point(layer, current, job.a);
      const next = index > 0 ? layer.chain[index - 1] : current;
      const dx = next % layer.width - current % layer.width;
      const dz = Math.floor(next / layer.width) - Math.floor(current / layer.width);
      if (index === length - 1 || index === 0 || dx !== previousDX || dz !== previousDZ) append(job.a);
      previousDX = dx; previousDZ = dz;
    }
    this._point(layer, job.end, job.a);
    if (this.segmentClear(job.a, agent.goal, agent.radius, agent.height)) append(agent.goal);
    let previous = agent.start;
    agent.floorMin = agent.start.y; agent.floorMax = agent.start.y;
    for (const waypoint of agent.path) {
      agent.routeLength += distance(previous, waypoint); previous = waypoint;
      agent.floorMin = Math.min(agent.floorMin, waypoint.y); agent.floorMax = Math.max(agent.floorMax, waypoint.y);
    }
    Object.assign(agent.routeGoal, agent.goal);
    agent.routeVersion++;
    agent.nextShortcutAt = 0;
  }

  /** At most one new job and a fixed number of expansions per simulation slice. */
  update(now) {
    if (!Number.isFinite(now)) return 0;
    // Checkpoint/QA resets can rewind simulation time while retaining static
    // geometry. A previous run must never postpone a new run's search budget.
    if (now + 1e-8 < this.lastUpdateAt) this.nextSliceAt = now;
    this.lastUpdateAt = now;
    if (now + 1e-8 < this.nextSliceAt) return 0;
    this.nextSliceAt = now + this.sliceInterval;
    this.stats.lastSliceExpansions = 0;
    if (!this.job && this.queue.length) {
      const agent = this.queue.shift();
      if (!this._start(agent)) {
        agent.pending = false; agent.status = 'unreachable'; agent.path.length = 0;
        this.stats.failed++;
      }
    }
    const job = this.job;
    if (!job) return 0;
    const layer = job.layer;
    while (job.heapSize && this.stats.lastSliceExpansions < this.expansionsPerSlice) {
      const current = this._pop(job);
      layer.closed[current] = job.id;
      job.expanded++; this.stats.expansions++; this.stats.lastSliceExpansions++;
      if (current === job.end) { this._finish(job, true); break; }
      if (job.expanded >= this.maxSearchExpansions) { this._finish(job, false); break; }
      const cx = current % layer.width, cz = Math.floor(current / layer.width);
      for (let direction = 0; direction < DIRECTIONS.length; direction++) {
        const [dx, dz] = DIRECTIONS[direction], x = cx + dx, z = cz + dz;
        if (x < 0 || x >= layer.width || z < 0 || z >= layer.depth) continue;
        const next = z * layer.width + x;
        if (layer.closed[next] === job.id || !this._edge(job, current, next, direction)) continue;
        const score = layer.g[current] + (dx && dz ? Math.SQRT2 : 1) * this.cellSize;
        const seen = layer.stamp[next] === job.id;
        if (seen && score >= layer.g[next]) continue;
        layer.stamp[next] = job.id; layer.g[next] = score; layer.parent[next] = current;
        const goalX = job.end % layer.width, goalZ = Math.floor(job.end / layer.width);
        layer.f[next] = score + Math.hypot(goalX - x, goalZ - z) * this.cellSize;
        if (!seen) layer.heapIndex[next] = -1;
        this._push(job, next);
      }
    }
    if (this.job && !job.heapSize) this._finish(job, false);
    this.stats.peakSliceExpansions = Math.max(this.stats.peakSliceExpansions, this.stats.lastSliceExpansions);
    return this.stats.lastSliceExpansions;
  }

  /** Reuse a committed route; this never reads the player's live position. */
  waypoint(agent, position, goal, now) {
    if (now < agent.lastWaypointAt) agent.nextShortcutAt = now;
    agent.lastWaypointAt = now;
    if (agent.generation !== this.generation || position.y < agent.floorMin - 0.45 || position.y > agent.floorMax + 0.45 || distance(goal, agent.routeGoal) > 1.8) {
      agent.path.length = 0; agent.index = 0;
      return null;
    }
    while (agent.index < agent.path.length && distance(position, agent.path[agent.index]) < 0.24) {
      const next = agent.path[agent.index + 1];
      // Being near a corner is not permission to cut through its wall. Keep
      // approaching the turn until the actual capsule can see the next leg.
      if (next && distance(position, agent.path[agent.index]) > 0.025 && !this.segmentClear(position, next, agent.radius, agent.height)) break;
      agent.index++;
    }
    if (agent.index >= agent.path.length) return null;
    if (now >= agent.nextShortcutAt) {
      agent.nextShortcutAt = now + 0.24;
      for (let index = Math.min(agent.index + 3, agent.path.length - 1); index > agent.index; index--) {
        const point = agent.path[index];
        if (distance(position, point) <= 8 && this.segmentClear(position, point, agent.radius, agent.height)) {
          agent.index = index; break;
        }
      }
    }
    this.stats.pathUses++;
    return agent.path[agent.index];
  }

  snapshot() {
    return { ...this.stats, generation: this.generation, layers: this.layers.size, pending: this.queue.length + Number(Boolean(this.job)), expansionsPerSlice: this.expansionsPerSlice, maxSearchExpansions: this.maxSearchExpansions };
  }
}
