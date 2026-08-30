import { Box3, Frustum, Matrix4, Plane, Vector3 } from 'three';

const EPSILON = 1e-6;
const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

function validBounds(bounds) {
  return bounds?.isBox3 && !bounds.isEmpty()
    && [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].every(Number.isFinite);
}

function boxCorners(bounds) {
  return Array.from({ length: 8 }, (_, index) => new Vector3(
    index & 1 ? bounds.max.x : bounds.min.x,
    index & 2 ? bounds.max.y : bounds.min.y,
    index & 4 ? bounds.max.z : bounds.min.z,
  ));
}

function addPlane(planes, plane) {
  if (!planes.some(other => other.normal.dot(plane.normal) > 1 - EPSILON
    && Math.abs(other.constant - plane.constant) < EPSILON)) planes.push(plane);
}

/** Exact convex envelope of an AABB swept along the light ray to a low floor. */
function receiverPlanes(bounds, ray, floor) {
  const planes = [], corners = boxCorners(bounds);
  for (let axis = 0; axis < 3; axis++) {
    const name = ['x', 'y', 'z'][axis], direction = AXES[axis];
    if (ray[name] >= 0) addPlane(planes, new Plane(direction.clone(), -bounds.min[name]));
    if (ray[name] <= 0) addPlane(planes, new Plane(direction.clone().negate(), bounds.max[name]));
    const normal = new Vector3().crossVectors(ray, direction);
    if (normal.lengthSq() < EPSILON * EPSILON) continue;
    normal.normalize();
    let min = Infinity, max = -Infinity;
    for (const corner of corners) {
      const distance = normal.dot(corner);
      min = Math.min(min, distance); max = Math.max(max, distance);
    }
    addPlane(planes, new Plane(normal.clone(), -min));
    addPlane(planes, new Plane(normal.negate(), max));
  }
  addPlane(planes, new Plane(new Vector3(0, 1, 0), -floor));
  return planes;
}

// Initialization only: derive the edges of the bounded receiver volume from
// its halfspaces. Frame updates subsequently clip these fixed edges, not meshes.
function volumeEdges(planes) {
  const vertices = [], edges = [], point = new Vector3();
  const bc = new Vector3(), ca = new Vector3(), ab = new Vector3();
  for (let a = 0; a < planes.length - 2; a++) for (let b = a + 1; b < planes.length - 1; b++) {
    for (let c = b + 1; c < planes.length; c++) {
      const pa = planes[a], pb = planes[b], pc = planes[c];
      bc.crossVectors(pb.normal, pc.normal);
      const divisor = pa.normal.dot(bc);
      if (Math.abs(divisor) < EPSILON) continue;
      ca.crossVectors(pc.normal, pa.normal); ab.crossVectors(pa.normal, pb.normal);
      point.copy(bc).multiplyScalar(-pa.constant).addScaledVector(ca, -pb.constant)
        .addScaledVector(ab, -pc.constant).divideScalar(divisor);
      if (planes.some(plane => plane.distanceToPoint(point) < -EPSILON)) continue;
      if (!vertices.some(vertex => vertex.distanceToSquared(point) < EPSILON * EPSILON)) vertices.push(point.clone());
    }
  }
  for (let a = 0; a < vertices.length - 1; a++) for (let b = a + 1; b < vertices.length; b++) {
    let shared = 0;
    for (const plane of planes) {
      if (Math.abs(plane.distanceToPoint(vertices[a])) < EPSILON * 4
        && Math.abs(plane.distanceToPoint(vertices[b])) < EPSILON * 4) shared++;
    }
    if (shared >= 2) edges.push([vertices[a], vertices[b]]);
  }
  return edges;
}

function clipEdge(a, b, planes, start, end) {
  let low = 0, high = 1;
  for (const plane of planes) {
    const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
    if (da >= 0 && db >= 0) continue;
    if (da < -EPSILON && db < -EPSILON) return false;
    const divisor = da - db;
    if (Math.abs(divisor) < EPSILON) continue;
    const crossing = da / divisor;
    if (da < 0) low = Math.max(low, crossing);
    else high = Math.min(high, crossing);
    if (low > high + EPSILON) return false;
  }
  start.lerpVectors(a, b, Math.max(0, low));
  end.lerpVectors(a, b, Math.min(1, high));
  return true;
}

/** One-time scan includes new static hero assets without a per-frame traversal. */
function includeCasterBounds(root, bounds) {
  const box = new Box3();
  root.updateWorldMatrix(true, false);
  // SkinnedMesh refreshes its attached bind inverse in updateMatrixWorld(),
  // not updateWorldMatrix(). The latter alone can count a moved rig twice.
  root.updateMatrixWorld(true);
  function visit(object) {
    // Pool slots are parked below the world, and legacy body proxies never
    // draw. Prune their descendants too, including visible held-weapon meshes.
    // Keep other hidden geometry: ZoneCull hides legitimate static world zones
    // at boot, and their future shadows must remain inside this envelope.
    if (!object.visible && (object.userData.rig || object.userData.role === 'bounds-proxy')) return;
    if (object.castShadow && object.geometry) {
      if (object.isSkinnedMesh) {
        // A cached box may describe a previous pose or parked pool position.
        object.computeBoundingBox();
        box.copy(object.boundingBox);
      } else if (object.isInstancedMesh) {
        if (!object.boundingBox) object.computeBoundingBox();
        box.copy(object.boundingBox);
      } else {
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        box.copy(object.geometry.boundingBox);
      }
      box.applyMatrix4(object.matrixWorld);
      if (validBounds(box)) bounds.union(box);
    }
    for (const child of object.children) visit(child);
  }
  visit(root);
}

/**
 * Conservatively crop an already fitted directional shadow, without changing
 * the light, its map size, depth range, caster flags, or dynamic update policy.
 * The caster envelope includes downstream shadows on ground outside the world
 * AABB. Every potentially shadowed visible receiver must fit the chosen crop;
 * wide views retain the exact static fit. Fixed sizes and whole-texel shifts
 * prevent a continuously changing shadow sampling grid.
 *
 * Construct after building the world. casterRoot optionally expands bounds for
 * actual static assets; bounds must also contain future moving NPCs. update()
 * allocates no objects and never traverses casters. Pass false as its optional
 * second argument while renderer.shadowMap.enabled is false (Performance).
 */
export function createFocusedShadowBudget(light, worldBounds, {
  enabled = true, casterRoot = null, receiverFloor = -2.2, margin = 1.5,
  hysteresis = 1, cropFractions = [0.5, 0.75],
} = {}) {
  const camera = light?.shadow?.camera;
  if (!light?.isDirectionalLight || !camera?.isOrthographicCamera || camera.zoom !== 1) {
    throw new TypeError('Focused shadows require an already fitted directional light with an unzoomed orthographic camera.');
  }
  if (!validBounds(worldBounds)) throw new TypeError('Focused shadows require finite caster bounds.');
  const width = camera.right - camera.left, height = camera.top - camera.bottom;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    throw new TypeError('Focused shadows require a finite static shadow fit.');
  }
  const bounds = worldBounds.clone();
  if (casterRoot) includeCasterBounds(casterRoot, bounds);
  // Include bounded animation/normal-bias excursions around authored geometry.
  const padding = Number.isFinite(margin) ? Math.max(0.1, Math.min(10, margin)) : 1.5;
  bounds.expandByScalar(padding);
  const floor = Number.isFinite(receiverFloor) ? Math.min(receiverFloor, bounds.min.y) : bounds.min.y;
  const shrinkMargin = Number.isFinite(hysteresis) ? Math.max(0, Math.min(4, hysteresis)) : 1;
  const fractions = [...new Set((Array.isArray(cropFractions) ? cropFractions : [0.5, 0.75])
    .filter(value => Number.isFinite(value) && value >= 0.25 && value < 1))].sort((a, b) => a - b).slice(0, 3);
  fractions.push(1);
  const original = { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom,
    near: camera.near, far: camera.far };
  light.updateWorldMatrix(true, false); light.target.updateWorldMatrix(true, false);
  light.shadow.updateMatrices(light);
  const lightView = camera.matrixWorldInverse.clone(), originalProjection = camera.projectionMatrix.clone();
  const originalFrustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(originalProjection, lightView));
  const lightWorld = light.matrixWorld.clone(), targetWorld = light.target.matrixWorld.clone();
  const ray = new Vector3().setFromMatrixPosition(targetWorld).sub(new Vector3().setFromMatrixPosition(lightWorld)).normalize();
  const supported = ray.y < -EPSILON;
  const planes = supported ? receiverPlanes(bounds, ray, floor) : [];
  for (const plane of originalFrustum.planes) addPlane(planes, plane.clone());
  const edges = supported ? volumeEdges(planes) : [];
  const usable = supported && edges.length > 0 && edges.length <= 128;

  const viewFrustum = new Frustum(), viewProjection = new Matrix4(), previousProjection = new Matrix4();
  const inverseViewProjection = new Matrix4(), auditProjection = new Matrix4(), auditFrustum = new Frustum();
  const viewCorners = Array.from({ length: 8 }, () => new Vector3());
  const clippedStart = new Vector3(), clippedEnd = new Vector3(), lightPoint = new Vector3(), observer = new Vector3();
  const fit = { left: 0, bottom: 0 };
  let active = Boolean(enabled), disposed = false, dirty = true, lastShadowsEnabled = true;
  let fraction = 1, reason = active ? 'awaiting-camera' : 'disabled';
  let minX = 0, maxX = 0, minY = 0, maxY = 0, receiverPoints = 0;
  let mapX = light.shadow.mapSize.x, mapY = light.shadow.mapSize.y;
  let updates = 0, evaluations = 0, revisions = 0, tierChanges = 0, lastAudit = null;

  function apply(left, bottom, nextFraction, nextReason) {
    reason = nextReason;
    const cropWidth = nextFraction === 1 ? width : width * mapX / Math.ceil(mapX / nextFraction);
    const cropHeight = nextFraction === 1 ? height : height * mapY / Math.ceil(mapY / nextFraction);
    const right = nextFraction === 1 ? original.right : left + cropWidth;
    const top = nextFraction === 1 ? original.top : bottom + cropHeight;
    const changed = Math.abs(camera.left - left) > EPSILON || Math.abs(camera.right - right) > EPSILON
      || Math.abs(camera.bottom - bottom) > EPSILON || Math.abs(camera.top - top) > EPSILON
      || camera.near !== original.near || camera.far !== original.far;
    if (nextFraction !== fraction) tierChanges++;
    fraction = nextFraction;
    if (changed) {
      camera.left = left; camera.right = right; camera.bottom = bottom; camera.top = top;
      camera.near = original.near; camera.far = original.far;
      camera.updateProjectionMatrix();
      light.shadow.needsUpdate = true;
      revisions++;
    }
    return changed;
  }

  function restore(nextReason) { return apply(original.left, original.bottom, 1, nextReason); }

  function includePoint(point) {
    lightPoint.copy(point).applyMatrix4(lightView);
    minX = Math.min(minX, lightPoint.x); maxX = Math.max(maxX, lightPoint.x);
    minY = Math.min(minY, lightPoint.y); maxY = Math.max(maxY, lightPoint.y);
    receiverPoints++;
  }

  function fits(candidate, guard) {
    // Make the entire reference extent an integer number of focused texels.
    // This also lets a snapped crop retain either original map edge exactly
    // (2048 / .75 is otherwise fractional, making an edge-aligned fit impossible).
    const stepX = width / Math.ceil(mapX / candidate), stepY = height / Math.ceil(mapY / candidate);
    const candidateWidth = stepX * mapX, candidateHeight = stepY * mapY;
    // A receiver on an existing full-map edge needs that same edge retained,
    // not impossible extra padding beyond the original shadow coverage.
    const lowX = Math.max(original.left, Math.min(original.right, maxX + guard) - candidateWidth);
    const highX = Math.min(original.right - candidateWidth, Math.max(original.left, minX - guard));
    const lowY = Math.max(original.bottom, Math.min(original.top, maxY + guard) - candidateHeight);
    const highY = Math.min(original.top - candidateHeight, Math.max(original.bottom, minY - guard));
    const firstX = Math.ceil((lowX - original.left) / stepX - EPSILON);
    const lastX = Math.floor((highX - original.left) / stepX + EPSILON);
    const firstY = Math.ceil((lowY - original.bottom) / stepY - EPSILON);
    const lastY = Math.floor((highY - original.bottom) / stepY + EPSILON);
    if (firstX > lastX || firstY > lastY) return false;
    const preferredX = candidate === fraction ? camera.left : observer.x - candidateWidth / 2;
    const preferredY = candidate === fraction ? camera.bottom : observer.y - candidateHeight / 2;
    fit.left = original.left + Math.max(firstX, Math.min(lastX, Math.round((preferredX - original.left) / stepX))) * stepX;
    fit.bottom = original.bottom + Math.max(firstY, Math.min(lastY, Math.round((preferredY - original.bottom) / stepY))) * stepY;
    return true;
  }

  function update(viewCamera, options) {
    updates++;
    lastShadowsEnabled = typeof options === 'boolean' ? options : options?.shadowsEnabled !== false;
    if (disposed || !active || !lastShadowsEnabled) {
      dirty = true;
      return restore(disposed ? 'disposed' : !active ? 'disabled' : 'shadows-disabled');
    }
    if (!usable) return restore('unsupported-receiver-volume');
    if (!viewCamera?.isPerspectiveCamera) return restore('unsupported-view-camera');
    light.updateWorldMatrix(true, false); light.target.updateWorldMatrix(true, false);
    if (!light.matrixWorld.equals(lightWorld) || !light.target.matrixWorld.equals(targetWorld)) {
      dirty = true;
      return restore('light-transform-changed');
    }
    viewCamera.updateWorldMatrix(true, false);
    viewProjection.multiplyMatrices(viewCamera.projectionMatrix, viewCamera.matrixWorldInverse);
    if (!dirty && viewProjection.equals(previousProjection) && mapX === light.shadow.mapSize.x && mapY === light.shadow.mapSize.y) return false;
    mapX = light.shadow.mapSize.x; mapY = light.shadow.mapSize.y;
    if (!(Number.isInteger(mapX) && mapX > 0 && Number.isInteger(mapY) && mapY > 0)) return restore('invalid-map-size');
    previousProjection.copy(viewProjection); dirty = false; evaluations++;
    viewFrustum.setFromProjectionMatrix(viewProjection, viewCamera.coordinateSystem, viewCamera.reversedDepth);
    inverseViewProjection.copy(viewProjection).invert();
    for (let index = 0; index < 8; index++) {
      viewCorners[index].set(index & 1 ? 1 : -1, index & 2 ? 1 : -1, index & 4 ? 1 : -1).applyMatrix4(inverseViewProjection);
      const point = viewCorners[index];
      if (!Number.isFinite(point.x + point.y + point.z)) return restore('invalid-view-projection');
    }
    minX = minY = Infinity; maxX = maxY = -Infinity; receiverPoints = 0;
    // Intersections of convex polyhedra have vertices at their original
    // vertices or an edge/face crossing; clipping both edge sets covers both.
    for (const edge of edges) if (clipEdge(edge[0], edge[1], viewFrustum.planes, clippedStart, clippedEnd)) {
      includePoint(clippedStart); includePoint(clippedEnd);
    }
    for (const edge of BOX_EDGES) if (clipEdge(viewCorners[edge[0]], viewCorners[edge[1]], planes, clippedStart, clippedEnd)) {
      includePoint(clippedStart); includePoint(clippedEnd);
    }
    if (!receiverPoints) return restore('no-visible-receivers');
    observer.setFromMatrixPosition(viewCamera.matrixWorld).applyMatrix4(lightView);
    // Expand immediately for new coverage. A smaller tier needs extra room,
    // preventing small FOV/reload changes from alternating the resolution.
    for (const candidate of fractions) {
      if (candidate === 1) return restore('full-coverage-required');
      const guard = padding + (evaluations > 1 && candidate < fraction ? shrinkMargin : 0);
      if (fits(candidate, guard)) return apply(fit.left, fit.bottom, candidate, 'visible-receivers-fit');
    }
    return restore('full-coverage-required');
  }

  function setEnabled(value) {
    if (disposed) return false;
    active = Boolean(value); dirty = true;
    if (!active) restore('disabled');
    return active;
  }

  /** Explicit QA inspection only; not called by update() or snapshot(). */
  function auditCasters(root, viewCamera) {
    const result = { eligibleMeshes: 0, referenceMeshes: 0, focusedMeshes: 0,
      referenceDrawCandidates: 0, focusedDrawCandidates: 0, projectionRevision: revisions };
    auditFrustum.setFromProjectionMatrix(auditProjection.multiplyMatrices(camera.projectionMatrix, lightView));
    root.updateWorldMatrix(true, true);
    root.traverseVisible(object => {
      if (!object.castShadow || !object.geometry || (viewCamera && !object.layers.test(viewCamera.layers))) return;
      result.eligibleMeshes++;
      let draws = 0;
      if (Array.isArray(object.material)) {
        for (const group of object.geometry.groups) if (object.material[group.materialIndex]?.visible) draws++;
      } else if (object.material?.visible) draws = 1;
      if (!object.frustumCulled || originalFrustum.intersectsObject(object)) {
        result.referenceMeshes++; result.referenceDrawCandidates += draws;
      }
      if (!object.frustumCulled || auditFrustum.intersectsObject(object)) {
        result.focusedMeshes++; result.focusedDrawCandidates += draws;
      }
    });
    lastAudit = result;
    return { ...result };
  }

  function snapshot() {
    const regionWidth = camera.right - camera.left, regionHeight = camera.top - camera.bottom;
    return {
      enabled: active, disposed, mode: fraction < 1 ? 'focused' : 'static', reason,
      shadowsEnabled: lastShadowsEnabled, fraction, areaFraction: regionWidth * regionHeight / (width * height),
      linearResolutionGain: Math.min(width / regionWidth, height / regionHeight),
      mapSize: { width: light.shadow.mapSize.x, height: light.shadow.mapSize.y },
      region: { left: camera.left, right: camera.right, bottom: camera.bottom, top: camera.top,
        width: regionWidth, height: regionHeight, near: camera.near, far: camera.far },
      texelSize: { x: regionWidth / light.shadow.mapSize.x, y: regionHeight / light.shadow.mapSize.y },
      referenceTexelSize: { x: width / light.shadow.mapSize.x, y: height / light.shadow.mapSize.y },
      receiverBounds: receiverPoints ? { minX, maxX, minY, maxY } : null,
      receiverFloor: floor, coverageMargin: padding,
      casterBounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
      updates, coverageEvaluations: evaluations, projectionRevisions: revisions, tierChanges,
      clipEdges: edges.length + BOX_EDGES.length,
      casterAudit: lastAudit ? { ...lastAudit } : null,
    };
  }

  function dispose() {
    if (disposed) return;
    active = false; disposed = true;
    restore('disposed');
  }

  return Object.freeze({ setEnabled, update, snapshot, auditCasters, dispose });
}
