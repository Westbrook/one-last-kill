/**
 * Visible, silent integration checks for the development build.
 *
 * Main imports this module only when import.meta.env.DEV && qa=1. The second
 * guard here requires mute=1 as well. Nothing is attached to window and no
 * test runs until a person presses a visible button.
 *
 * installQA({ stepFrame, render, setTesting, setInspection, resetToApartment? })
 * - stepFrame(seconds): the real simulation entry, including its play gate.
 * - render(): draw the real scene once, including normal render preparation.
 * - setTesting(boolean): suspend automatic simulation, not stepFrame calls.
 * - setInspection(boolean): show a paused scene without modal menus.
 * - resetToApartment(): optional full new-mission reset, including world gates.
 * - metrics(): optional read-only lighting and presentation configuration.
 *
 * The suite drives actual game controllers. Explicit state/visual fixtures
 * are disclosed in their reports and reset afterwards. Collision routes use
 * a separate body through the same solver and the built world's boxes.
 */
import { Box3, Matrix4, Ray, Vector3 } from 'three';
import { Audio } from '../core/audio.js';
import { Ballistics, createBallisticHit } from '../core/ballistics.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../core/collision.js';
import { Input, engageLock } from '../core/input.js';
import { scene, camera, renderer, GameTime, configureRenderer } from '../core/renderer.js';
import { AUDIO_MIX_SETTINGS, audioMixFromSettings, Settings } from '../core/settings.js';
import { Player, PlayerState, resetPlayerMotion } from '../game/player.js';
import { Weapons, WeaponDrops, WEAPON_DEFS } from '../game/weapons.js';
import { placeWeaponDrop } from '../game/drop-placement.js';
import { AmmoSupplies } from '../game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES, AMMO_SUPPLY_COSTS, AMMO_RESERVE_LIMITS } from '../game/ammo-supply-rules.js';
import {
  ENEMY_TYPES, Enemies, EnemyPool, EnemyNavigation, damageEnemy, killEnemy, enemyAttackPlayer, enemiesUpdate, raycastEnemies,
} from '../game/enemies.js';
import { CORPSE_LIMIT, CORPSE_LIFETIME, isSegmentOccluded } from '../game/combat-rules.js';
import { CombatStats } from '../game/combat-stats.js';
import { CHECKPOINT_COMMS } from '../game/checkpoint-comms.js';
import { EncounterSeeds } from '../game/encounter-session.js';
import { HEALTH_SUPPLIES, ROOF_HEALTH_ROUTES } from '../game/health-supply-data.js';
import { describeOffscreenThreat } from '../game/offscreen-threats.js';
import { readThreatView } from '../game/threat-feedback.js';
import { CHECKPOINTS, FINAL_ENCOUNTERS, ZONE_ORDER, ZONE_WAVE_CONFIG } from '../game/mission-data.js';
import {
  getCheckpointStatus, getMissionState, saveCheckpoint, restartFromZone,
  applyPlayerDamage, HealPickups, WaveDirector, StreetChoice, Endings, surfaceTopAt,
} from '../game/mission.js';
import { Blood, FX } from '../render/effects.js';
import { getHumanoidVisualBounds, resetHumanoidPose, updateHumanoidPose } from '../render/humanoid-rig.js';
import { HUD, IntroCard } from '../ui/hud.js';
import { World, WorldState, Triggers, triggersUpdate } from '../world/world.js';
import { Architecture } from '../world/architecture.js';
import { APARTMENT_DOORS, BALCONY, BUILDING, OPENINGS, ROOF } from '../world/layout.js';
import { STAIRS } from '../world/stair-layout.js';
import { DISTRICT } from '../world/district-layout.js';

const ZONE_LABELS = Object.freeze({
  apartment: 'Apartment', neighbor: 'Neighboring apartment', balcony: 'Balcony',
  stairwell: 'Stairwell', roof: 'Rooftop', scaffolding: 'Scaffolding',
  street: 'Street', bakery: 'Bakery',
});
const STEP = 1 / 120;
const BENCHMARK_MS = 10_000;
const WARMUP_MS = 500;
const STARTING_WEAPON = Object.freeze({ current: 'fists', loaded: 0, reserve: 0 });
const HELD_POSES = Object.freeze(['ready', 'windup', 'contact', 'followthrough', 'recovery']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function near(actual, expected, message, tolerance = 1e-6) {
  assert(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function same(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function pauseSilently() {
  Audio.setMuted(true);
  Input.pause({ showOverlay: false });
  for (const media of document.querySelectorAll('audio, video')) {
    media.muted = true;
    media.volume = 0;
    media.pause();
  }
}

function assertSilent() {
  const status = Audio.getStatus();
  assert(status.hardMuted && status.muted && !status.running,
    'QA must remain hard muted, with no running audio output');
  assert(!status.initialized, 'A silent QA session must never create an AudioContext');
  assert(status.resources.voices === 0 && status.resources.noiseBuffers === 0
    && !status.radioActive && !status.radioWaiting && status.radioQueued === 0,
  'Hard mute must create no voices, noise buffers or pending radio');
  for (const key of ['queued', 'pending', 'inFlight', 'cached', 'bytes']) {
    near(status.resources.samples[key], 0, `Silent sample ${key}`);
  }
  near(status.elapsed, 0, 'Muted audio cannot accumulate a score clock');
  near(status.score.elapsed, 0, 'Muted score remains stopped');
}

function placePlayer(anchor) {
  Player.pos.set(anchor.x, anchor.y + Player.eyeHeight + 0.02, anchor.z);
  Player.yaw = anchor.yaw ?? Player.yaw;
  Player.pitch = 0;
  resetPlayerMotion();
}

function pointCameraAt(point) {
  const dx = point.x - Player.pos.x, dy = point.y - Player.pos.y, dz = point.z - Player.pos.z;
  Player.yaw = Math.atan2(-dx, -dz);
  Player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  camera.position.copy(Player.pos);
  camera.rotation.set(Player.pitch, Player.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
}

function meleeTiming(type) {
  const definition = WEAPON_DEFS[type];
  assert(definition?.kind === 'melee' && Number.isFinite(definition.attackDuration)
    && definition.attackDuration > 0 && definition.contactPhase > 0 && definition.contactPhase < 1,
  `${type} must declare an attack duration and a contact phase inside its swing`);
  return { duration: definition.attackDuration, contactAt: definition.attackDuration * definition.contactPhase };
}

function aimAtBody(enemy) {
  const target = enemy.pos.clone(); target.y += enemy.height * 0.5;
  pointCameraAt(target);
  return target;
}

function fixtureBodyRayContacts(enemy, definition) {
  const zones = enemy.mesh.userData.hitZones;
  assert(zones?.headAnchor, 'The contact fixture requires the actual rig hit-zone anchor');
  const head = zones.headAnchor.getWorldPosition(new Vector3());
  const body = new Box3(new Vector3(enemy.pos.x - enemy.radius, enemy.pos.y, enemy.pos.z - enemy.radius),
    new Vector3(enemy.pos.x + enemy.radius, head.y - zones.headHalfHeight, enemy.pos.z + enemy.radius));
  const forward = camera.getWorldDirection(new Vector3());
  const angles = definition.contactArc > 0 ? [0, -definition.contactArc, definition.contactArc] : [0];
  const contacts = [];
  for (const angle of angles) {
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const direction = new Vector3(forward.x * cosine + forward.z * sine, forward.y,
      -forward.x * sine + forward.z * cosine).normalize();
    const point = new Ray(camera.position, direction).intersectBox(body, new Vector3());
    if (point) contacts.push({ distance: camera.position.distanceTo(point),
      blocked: Ballistics.segmentOccluded(camera.position, point, 'bullet') });
  }
  return contacts;
}

function spawnFixtureEnemy(type, anchor, zone = 'street') {
  const floor = surfaceTopAt(anchor.x, anchor.y, anchor.z, 0.25, 0.16);
  near(floor, anchor.y, `${type} fixture must stand on its authored floor`, 0.03);
  const enemy = Enemies.spawn(type, anchor.x, anchor.z, floor + 0.02);
  assert(enemy, `${type} fixture must acquire a real enemy rig`);
  enemy.zone = zone;
  enemy.yaw = Math.atan2(Player.pos.x - enemy.pos.x, Player.pos.z - enemy.pos.z);
  assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list),
    `${type} fixture intersects world geometry`);
  return enemy;
}

function makeBody(x, y, z) {
  return {
    position: new Vector3(x, y + 0.02, z),
    velocity: new Vector3(),
    radius: Player.radius,
    height: Player.bodyHeight,
    onGround: true,
  };
}

/** Each target is [x, feetY, z]; falling is resolved, never teleported. */
function walkRoute(body, targets, label) {
  for (let index = 0; index < targets.length; index++) {
    const [x, y, z] = targets[index];
    const startDistance = Math.hypot(x - body.position.x, z - body.position.z);
    const maxTicks = Math.ceil(startDistance / 4.2 / STEP) + 600;
    let reached = false;
    for (let tick = 0; tick < maxTicks; tick++) {
      const dx = x - body.position.x, dz = z - body.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.03 && body.onGround && Math.abs(body.position.y - y) < 0.06) {
        reached = true;
        break;
      }
      const speed = Math.min(4.2, distance / STEP);
      body.velocity.x = distance > 0.001 ? dx / distance * speed : 0;
      body.velocity.z = distance > 0.001 ? dz / distance * speed : 0;
      body.velocity.y = Math.max(-32, body.velocity.y - 22 * STEP);
      moveCapsule(body, STEP, Colliders.list, true);
    }
    const position = body.position.toArray().map(value => value.toFixed(2)).join(', ');
    assert(reached, `${label}, waypoint ${index + 1}: stuck at (${position}); expected (${x}, ${y}, ${z})`);
    assert(capsuleHasClearance(body.position, body.radius, body.height, Colliders.list, 1e-5),
      `${label}, waypoint ${index + 1}: body overlaps the built world`);
  }
}

function pooledSlots() {
  return Object.values(EnemyPool.pools).flat();
}

function worldResourceSignature() {
  const objects = [], geometries = new Set(), materials = new Set(), textures = new Set();
  World.traverse(object => {
    objects.push(object.uuid);
    if (object.geometry) geometries.add(object.geometry.uuid);
    const ownedMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of ownedMaterials) {
      if (!material) continue;
      materials.add(material.uuid);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value.uuid);
    }
  });
  return {
    children: World.children.length,
    objects: objects.sort(), geometries: [...geometries].sort(),
    materials: [...materials].sort(), textures: [...textures].sort(),
    fires: WorldState.fires.length, smokeSystems: WorldState.smokeSystems.length,
  };
}

function assertPracticalLightBudget() {
  const visible = [];
  scene.traverseVisible(object => { if (object.isPointLight) visible.push(object); });
  assert(visible.length === 8 && visible.every(light => light.name === 'budgeted-practical-light'),
    `The real visible scene must contain only its eight budgeted practical lights; found ${visible.length}`);
}

function boundsNear(actual, expected, label, tolerance = 0.031) {
  for (const edge of ['min', 'max']) {
    for (const axis of ['x', 'y', 'z']) near(actual[edge][axis], expected[edge][axis], `${label} ${edge}.${axis}`, tolerance);
  }
}

function polygonAreaXZ(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    twiceArea += a.x * b.z - b.x * a.z;
  }
  return twiceArea / 2;
}

// Clip convex horizontal polygons in world X/Z. Shared edges have zero area;
// duplicate coplanar floor or ceiling faces have positive area and can z-fight.
function clipFloorPolygon(subject, clip) {
  let result = subject;
  const orientation = Math.sign(polygonAreaXZ(clip));
  for (let edge = 0; edge < clip.length && result.length; edge++) {
    const a = clip[edge], b = clip[(edge + 1) % clip.length];
    const distance = point => orientation * ((b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x));
    const input = result;
    result = [];
    let previous = input[input.length - 1], previousDistance = distance(previous);
    for (const current of input) {
      const currentDistance = distance(current);
      const previousInside = previousDistance >= -1e-7, currentInside = currentDistance >= -1e-7;
      if (previousInside !== currentInside) {
        const fraction = previousDistance / (previousDistance - currentDistance);
        result.push({ x: previous.x + (current.x - previous.x) * fraction,
          z: previous.z + (current.z - previous.z) * fraction });
      }
      if (currentInside) result.push(current);
      previous = current; previousDistance = currentDistance;
    }
  }
  return result;
}

function visibleFloorFaces(region, floorY, facing = 1) {
  assert(facing === 1 || facing === -1, 'A horizontal surface audit needs an upward or downward facing sign');
  const clip = [{ x: region.x1, z: region.z1 }, { x: region.x2, z: region.z1 },
    { x: region.x2, z: region.z2 }, { x: region.x1, z: region.z2 }];
  const faces = [], seen = new Set();
  const vertices = [new Vector3(), new Vector3(), new Vector3()];
  const ab = new Vector3(), ac = new Vector3();
  const instanceMatrix = new Matrix4(), worldMatrix = new Matrix4();
  for (const record of Architecture.elements.values()) {
    const box = record.bounds;
    if (box.max.x <= region.x1 || box.min.x >= region.x2 || box.max.z <= region.z1 || box.min.z >= region.z2
      || box.min.y > floorY + 1e-5 || box.max.y < floorY - 1e-5) continue;
    let visible = true;
    for (let ancestor = record.mesh; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) visible = false;
    if (!visible) continue;
    record.mesh.updateWorldMatrix(true, true);
    record.mesh.traverseVisible(mesh => {
      if (!mesh.isMesh || seen.has(mesh)) return;
      seen.add(mesh);
      const geometry = mesh.geometry, position = geometry?.attributes.position;
      if (!position) return;
      const count = geometry.index?.count ?? position.count;
      const start = Math.max(0, geometry.drawRange.start), end = Math.min(count, start + geometry.drawRange.count);
      const instances = mesh.isInstancedMesh ? mesh.count : 1;
      const owner = mesh.userData.architectureId || record.id;
      const source = mesh === record.mesh ? owner : `${owner} / ${mesh.name || 'mesh'} ${mesh.id}`;
      for (let instance = 0; instance < instances; instance++) {
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(instance, instanceMatrix);
          worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        } else worldMatrix.copy(mesh.matrixWorld);
        for (let index = start; index + 2 < end; index += 3) {
          const group = Array.isArray(mesh.material)
            ? geometry.groups.find(entry => index >= entry.start && index + 3 <= entry.start + entry.count) : null;
          const material = Array.isArray(mesh.material) ? mesh.material[group?.materialIndex] : mesh.material;
          if (!material?.visible || (material.transparent && material.opacity === 0)) continue;
          for (let corner = 0; corner < 3; corner++) {
            vertices[corner].fromBufferAttribute(position, geometry.index ? geometry.index.getX(index + corner) : index + corner)
              .applyMatrix4(worldMatrix);
          }
          if (vertices.some(vertex => Math.abs(vertex.y - floorY) > 1e-5)) continue;
          if (facing * ab.subVectors(vertices[1], vertices[0]).cross(ac.subVectors(vertices[2], vertices[0])).y <= 1e-8) continue;
          const polygon = clipFloorPolygon(vertices.map(vertex => ({ x: vertex.x, z: vertex.z })), clip);
          const id = `${source}${mesh.isInstancedMesh ? ` instance ${instance}` : ''} triangle ${index / 3}`;
          if (Math.abs(polygonAreaXZ(polygon)) > 1e-7) faces.push({ id, owner, polygon });
        }
      }
    });
  }
  return faces;
}

function assertSurfacePatch(label, region, plane, facing, expectedOwners) {
  const faces = visibleFloorFaces(region, plane, facing), areas = new Map();
  for (let first = 0; first < faces.length; first++) {
    const face = faces[first], area = Math.abs(polygonAreaXZ(face.polygon));
    areas.set(face.owner, (areas.get(face.owner) || 0) + area);
    for (let second = first + 1; second < faces.length; second++) {
      const overlap = Math.abs(polygonAreaXZ(clipFloorPolygon(face.polygon, faces[second].polygon)));
      assert(overlap <= 1e-6,
        `${label}: ${face.id} overlaps ${faces[second].id} by ${(overlap * 10_000).toFixed(2)} cm²`);
    }
  }
  const expectedArea = Object.values(expectedOwners).reduce((sum, area) => sum + area, 0);
  // An empty owner map intentionally checks a void. Every occupied test patch
  // must be completely covered, so removing both competing faces cannot pass.
  if (Object.keys(expectedOwners).length) near(expectedArea, (region.x2 - region.x1) * (region.z2 - region.z1),
    `${label} expected finishes cover the whole audit patch`, 1e-5);
  const area = [...areas.values()].reduce((sum, value) => sum + value, 0);
  near(area, expectedArea, `${label} visible indexed area has no missing or excess surface`, 1e-5);
  same([...areas.keys()].sort(), Object.keys(expectedOwners).sort(), `${label} keeps the intended finish owners`);
  for (const [owner, expected] of Object.entries(expectedOwners)) near(areas.get(owner), expected,
    `${label} keeps the expected visible area of ${owner}`, 1e-5);
  return { triangles: faces.length, area };
}

function assertFinalizedSurfaceReport() {
  // Read the boot result only. Re-running the resolver here would conceal a
  // missing boot call and mutate the very geometry this regression inspects.
  const report = WorldState.surfaceOwnership;
  assert(report && Array.isArray(report.changes) && report.clippedMeshes > 0,
    'World boot must have finalized overlapping architecture before QA starts');
  assert(Number.isInteger(report.processedMeshes) && report.processedMeshes >= report.clippedMeshes,
    'The boot ownership report must count its actual processed meshes');
  const ids = new Set();
  let clippedFaces = 0, removedArea = 0;
  for (const change of report.changes) {
    const record = Architecture.elements.get(change.id), geometry = record?.mesh.geometry;
    assert(record && !ids.has(change.id), `Ownership report needs one existing record for ${change.id}`);
    ids.add(change.id);
    same(change.kind, record.kind, `${change.id} retains its architecture role`);
    assert(geometry?.userData.surfaceOwnership?.version === 1 && geometry.index,
      `${change.id} must carry the finalized indexed geometry, not merely a report entry`);
    same(geometry.userData.surfaceOwnership.faces, change.faces, `${change.id} geometry matches the boot report`);
    near(geometry.index.count / 3, change.triangles, `${change.id} renders the reported triangle count`);
    for (const face of change.faces) {
      assert([1, -1].includes(face.normal) && Number.isFinite(face.plane) && Number.isFinite(face.removedArea)
        && face.removedArea > 0 && Number.isFinite(face.visibleArea) && face.visibleArea >= 0,
      `${change.id} reports a finite signed face and positive removed overlap`);
      assert(face.owners.length > 0 && face.owners.every(id => id !== change.id && Architecture.elements.has(id)),
        `${change.id} replacements must reference existing finish owners`);
      const box = record.bounds, region = { x1: box.min.x, x2: box.max.x, z1: box.min.z, z2: box.max.z };
      const visibleArea = visibleFloorFaces(region, face.plane, face.normal)
        .filter(triangle => triangle.owner === change.id)
        .reduce((sum, triangle) => sum + Math.abs(polygonAreaXZ(triangle.polygon)), 0);
      near(visibleArea, face.visibleArea, `${change.id} actual indexed fragments match the reported visible area`, 1e-5);
      clippedFaces++; removedArea += face.removedArea;
    }
  }
  near(ids.size, report.clippedMeshes, 'The ownership report counts each changed mesh once');
  near(clippedFaces, report.clippedFaces, 'The ownership report counts the actual clipped faces');
  near(removedArea, report.removedArea, 'The ownership report sums the actual removed surface area', 1e-5);
  return report;
}

function checkFinalizedArchitectureSurfaces() {
  const report = assertFinalizedSurfaceReport(), patches = [];
  const northPatch = x => ({ x1: x - 0.25, x2: x + 0.25,
    z1: BUILDING.main.z1 - 0.08, z2: BUILDING.main.z1 + 0.08 });
  for (const [x, owner] of [[-13.7, 'roof-annex-west-link-deck'], [-10.2, 'main-upper-north'],
    [-6.2, 'roof-annex-east-link-deck']]) {
    patches.push(assertSurfacePatch(`North roof joint at x=${x}`, northPatch(x), ROOF.floorY, 1,
      { [owner]: 0.04, 'roof-deck': 0.04 }));
  }
  patches.push(assertSurfacePatch('Exposed south roof-wall cap',
    { x1: 0.92, x2: 1.42, z1: BUILDING.main.z2 - 0.08, z2: BUILDING.main.z2 + 0.08 }, ROOF.floorY, 1,
    { 'roof-deck': 0.04, 'main-upper-south': 0.04 }));
  patches.push(assertSurfacePatch('Eastern roof/deck joint over the wall',
    { x1: BUILDING.main.x2 - 0.08, x2: BUILDING.main.x2 + 0.08, z1: -5.25, z2: -4.75 }, ROOF.floorY, 1,
    { 'roof-deck': 0.04, 'roof-annex-east-deck': 0.04 }));
  for (const [x, floor, ceiling] of [[-11.13, 'apartment-floor', 'apartment-ceiling'],
    [2.37, 'neighbor-floor', 'neighbor-ceiling'], [11.41, 'balcony-east-deck', 'terrace-canopy']]) {
    patches.push(assertSurfacePatch(`${floor} meets its north wall cap`, northPatch(x), BUILDING.apartmentY, 1,
      { [floor]: 0.04, 'main-ground-north': 0.04 }));
    patches.push(assertSurfacePatch(`${ceiling} underside meets its exposed wall strip`, northPatch(x), BUILDING.canopyY, -1,
      { [ceiling]: 0.04, 'main-upper-north': 0.04 }));
  }
  patches.push(assertSurfacePatch('The lightwell beyond the retained brick cap stays open',
    { x1: -10.45, x2: -9.95, z1: ROOF.lightwell.z2 - 0.3, z2: ROOF.lightwell.z2 - 0.2 }, ROOF.floorY, 1, {}));
  return `${report.clippedMeshes} boot-finalized meshes / ${report.clippedFaces} signed faces match their actual indexed fragments (${report.removedArea.toFixed(2)} m² removed overlap); ${patches.length} selected floor, wall-cap and ceiling patches keep their finishes, exposed strips and lightwell void`;
}

function checkFlushThresholdSurfaces() {
  const door = APARTMENT_DOORS.neighborTerrace, thickness = door.wallThickness, halfWidth = door.width / 2;
  const acrossDoor = { x1: door.x - thickness, x2: door.x + thickness };
  const patches = [assertSurfacePatch('The complete stone terrace threshold and both adjoining floors',
    { ...acrossDoor, z1: door.z - halfWidth, z2: door.z + halfWidth }, door.floorY, 1,
    { 'neighbor-floor': thickness * door.width / 2, 'neighbor-terrace-threshold': thickness * door.width,
      'balcony-east-deck': thickness * door.width / 2 })];
  for (const z of [door.z - halfWidth - 0.1, door.z + halfWidth + 0.1]) {
    patches.push(assertSurfacePatch('Floors remain intact beyond the stone threshold ends',
      { ...acrossDoor, z1: z - 0.05, z2: z + 0.05 }, door.floorY, 1,
      { 'neighbor-floor': thickness * 0.1, 'balcony-east-deck': thickness * 0.1 }));
  }
  const width = ROOF.exit.x2 - ROOF.exit.x1 - 0.2, lip = Architecture.elements.get('roof-scaffold-threshold');
  assert(lip?.kind === 'threshold', 'The eastern roof metal lip must have an explicit threshold owner');
  patches.push(assertSurfacePatch('The complete eastern metal lip and its roof approach',
    { x1: ROOF.exit.x1 + 0.1, x2: ROOF.exit.x2 - 0.1, z1: ROOF.exit.z - 0.2, z2: ROOF.exit.z + 0.24 }, ROOF.floorY, 1,
    { 'roof-annex-east-deck': width * 0.1, 'roof-scaffold-threshold': width * 0.34 }));
  for (const x of [ROOF.exit.x1 + 0.05, ROOF.exit.x2 - 0.05]) {
    patches.push(assertSurfacePatch('Roof finish remains beside the metal lip ends',
      { x1: x - 0.03, x2: x + 0.03, z1: ROOF.exit.z - 0.16, z2: ROOF.exit.z - 0.02 }, ROOF.floorY, 1,
      { 'roof-annex-east-deck': 0.06 * 0.14 }));
  }
  patches.push(assertSurfacePatch('The outer edge of the metal lip does not fill the scaffold drop',
    { x1: 21.75, x2: 22.25, z1: ROOF.exit.z + 0.26, z2: ROOF.exit.z + 0.36 }, ROOF.floorY, 1, {}));
  return `${patches.length} actual indexed-surface patches retain the complete ${(thickness * door.width).toFixed(2)} m² stone and ${(width * 0.34).toFixed(2)} m² metal finishes, their adjacent floor textures and the open drop; no coplanar overlap or unintended hole in the audited joins`;
}

function boxGap(a, b) {
  return Math.hypot(...['x', 'y', 'z'].map(axis => Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis])));
}

function assertBalconyBody(position, radius, height, label) {
  near(position.y, BALCONY.floorY, `${label} retains balcony floor support`, 0.075);
  const inside = [BALCONY.east, BALCONY.wrap].some(rect => position.x >= rect.x1 - 0.01
    && position.x <= rect.x2 + 0.01 && position.z >= rect.z1 - 0.01 && position.z <= rect.z2 + 0.01);
  assert(inside, `${label} leaves the authored balcony footprint`);
  assert(capsuleHasClearance(position, radius, height, Colliders.list, 0.003),
    `${label} penetrates the balcony wall, screen or deck`);
}

function assertRigSegments(root, label) {
  const rig = root.userData.rig;
  assert(rig?.version === 2, `${label} must use the articulated rig`);
  near(root.scale.x, 1, `${label} root scale.x`);
  near(root.scale.y, 1, `${label} root scale.y`);
  near(root.scale.z, 1, `${label} root scale.z`);
  root.updateWorldMatrix(true, true);
  const a = new Vector3(), b = new Vector3();
  for (const side of ['L', 'R']) {
    for (const [parentName, childName, length] of [
      [`shoulder${side}`, `elbow${side}`, rig.dimensions.upperArmLength],
      [`elbow${side}`, `wrist${side}`, rig.dimensions.forearmLength],
      [`hip${side}`, `knee${side}`, rig.dimensions.thighLength],
      [`knee${side}`, `ankle${side}`, rig.dimensions.shinLength],
    ]) {
      const parent = rig.joints[parentName], child = rig.joints[childName];
      assert(parent && child?.parent === parent, `${label} ${childName} must pivot at ${parentName}`);
      parent.getWorldPosition(a); child.getWorldPosition(b);
      near(a.distanceTo(b), length, `${label} ${parentName}–${childName} keeps its authored length`, 1e-5);
    }
    assert(rig.anchors[`grip${side}`]?.parent === rig.joints[`wrist${side}`], `${label} grip follows the wrist`);
    rig.anchors[`sole${side}`].getWorldPosition(a);
    assert(a.y >= root.position.y - 0.012, `${label} ${side} sole is buried ${(root.position.y - a.y).toFixed(3)} m below the floor`);
    assert(a.y <= root.position.y + 0.1, `${label} ${side} foot floats beyond the authored step lift`);
  }
  for (const [name, joint] of Object.entries(rig.joints)) {
    assert([...joint.position.toArray(), ...joint.quaternion.toArray(), ...joint.scale.toArray()].every(Number.isFinite),
      `${label} ${name} contains a non-finite transform`);
  }
}

function assertNeutralRig(enemy) {
  const root = enemy.mesh, rig = root.userData.rig;
  assertRigSegments(root, enemy.type);
  near(rig.height, enemy.def.visual.height, `${enemy.type} visual height`);
  near(rig.dimensions.headHeight / rig.height, 0.135, `${enemy.type} adult head proportion`);
  for (const side of ['L', 'R']) {
    const sole = rig.anchors[`sole${side}`].getWorldPosition(new Vector3());
    near(sole.y, root.position.y, `${enemy.type} neutral ${side} sole is grounded`, 1e-5);
  }
  const crown = rig.anchors.crown.getWorldPosition(new Vector3());
  near(crown.y - root.position.y, enemy.height, `${enemy.type} crown matches collision height`, 1e-5);
  // Bounds proxies are deliberately conservative and invisible. Validate the
  // actual posed skin/morph vertices so a good proxy cannot hide bad artwork.
  const bodyBounds = getHumanoidVisualBounds(root, new Box3());
  assert(rig.visualMeshes?.length > 0 && rig.visualMeshes.every(mesh => mesh.visible),
    `${enemy.type} must render its authored character surfaces`);
  near(bodyBounds.min.y, root.position.y, `${enemy.type} actual body begins at the floor`, 0.005);
  near(bodyBounds.max.y, root.position.y + enemy.height, `${enemy.type} actual body ends at the crown`, 0.012);
  if (enemy.def.weaponType === 'fists') {
    assert(enemy.weaponMesh === null, 'An unarmed brawler must not retain a pooled weapon');
  } else {
    assert(enemy.weaponMesh?.parent === rig.anchors.gripR && enemy.weaponMesh.userData.role === 'weapon',
      `${enemy.type} weapon must attach to its right-hand grip, outside body bounds`);
    same(enemy.weaponMesh.userData.weaponType, enemy.def.weaponType, `${enemy.type} weapon appearance`);
  }
  for (const rest of rig.neutral) {
    near(rest.object.position.distanceTo(rest.position), 0, `${enemy.type} neutral joint position`, 1e-8);
    near(rest.object.quaternion.angleTo(rest.quaternion), 0, `${enemy.type} neutral joint rotation`, 1e-6);
    near(rest.object.scale.distanceTo(rest.scale), 0, `${enemy.type} neutral joint scale`, 1e-8);
  }
  same(rig.pose, { mode: 'idle', phase: 'idle', gait: 0, clock: 0 }, `${enemy.type} clean pose state`);
}

function poseForEnemy(enemy, name) {
  const mode = enemy.def.attack === 'melee' ? (enemy.def.weaponType === 'bat' ? 'bat' : 'fist') : 'ranged';
  if (name === 'walk') return { mode: 'walk', speed: 2.4, forward: 1, alert: 0, swingProgress: -1 };
  if (name === 'advance') return { mode, speed: 2.4, forward: 1, alert: 1, aim: 1, swingProgress: -1 };
  if (name === 'idle') return { mode: 'idle', speed: 0, alert: 0, swingProgress: -1 };
  return { mode, speed: 0, alert: 1, aim: 1,
    swingProgress: { windup: 0.18, contact: 0.5, recovery: 0.82 }[name] ?? -1, swingSide: 'R' };
}

function spawnMeleeContact() {
  const enemy = Enemies.spawn('thug', Player.pos.x + 0.8, Player.pos.z, Player.pos.y - Player._eyeH);
  assert(enemy, 'A melee contact must obtain a real pooled rig');
  enemy.yaw = Math.atan2(Player.pos.x - enemy.pos.x, Player.pos.z - enemy.pos.z);
  enemiesUpdate(STEP);
  assert(enemy.windupRemaining > 0, 'The real AI must begin a melee windup before cancellation is tested');
  return enemy;
}

function assertEndingSquad(branch) {
  const state = getMissionState();
  const zone = branch === 'car' ? 'street' : 'bakery';
  const alive = Enemies.list.filter(enemy => enemy.alive && enemy.zone === zone);
  const config = FINAL_ENCOUNTERS[branch];
  const expected = [...config.waves[0]].sort();
  const total = config.waves.flat().length;
  assert(Array.isArray(state.ending.pendingTypes), 'Ending status must expose a copied pending roster');
  const actual = [...alive.map(enemy => enemy.type), ...state.ending.pendingTypes].sort();
  same(actual, expected, `${branch} first encounter roster, including deferred safe spawns`);
  same([...state.ending.unstartedTypes].sort(), config.waves.slice(1).flat().sort(), `${branch} future waves retain their complete roster`);
  same([...state.ending.remainingTypes].sort(), config.waves.flat().sort(), `${branch} remaining roster includes all future waves`);
  near(state.ending.total, total, `${branch} total authored contacts`);
  near(state.ending.remaining, total, `${branch} initial contacts remaining`);
  near(state.ending.alive, alive.length, `${branch} visible live count`);
  near(state.ending.waveIndex, 1, `${branch} begins exactly its first wave`);
  near(state.ending.clearedWaves, 0, `${branch} begins with no completed waves`);
  same(state.ending.mode, branch, `${branch} ending mode`);
  same(state.checkpoint.branch, branch, `${branch} checkpoint branch`);
  assert(state.wave.finalLocked && !state.wave.active, 'A final encounter must stop ordinary waves');
  assert(!state.ending.resolved, 'A freshly started final encounter must remain unresolved');
  near(state.ending.deadlineSeconds, config.deadlineSeconds ?? 0, `${branch} authored deadline`);
  near(state.ending.deadline, config.deadlineSeconds ?? 0, `${branch} initial deadline`);
  return state;
}

function percentile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    maximum: sorted.at(-1),
  };
}

function createPanel() {
  const style = document.createElement('style');
  style.textContent = `
    #qa-panel { position: fixed; z-index: 10000; right: 14px; bottom: 14px;
      width: min(430px, calc(100vw - 28px)); color: #edf3ee; background: #101914f2;
      max-height: calc(100vh - 28px); overflow-y: auto;
      border: 1px solid #698372; border-radius: 8px; padding: 12px;
      font: 12px/1.5 system-ui, sans-serif; text-align: left;
      box-shadow: 0 10px 45px #0008; pointer-events: auto; box-sizing: border-box; }
    #qa-panel header { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
    #qa-panel strong { font-size: 13px; letter-spacing: .04em; }
    #qa-panel button, #qa-panel select { font: inherit; color: #f1f6f2;
      background: #263c2f; border: 1px solid #789681; border-radius: 4px;
      padding: 7px 9px; cursor: pointer; min-height: 34px; text-transform: none;
      letter-spacing: normal; box-sizing: border-box; }
    #qa-panel button:hover { background: #365240; }
    #qa-panel button:focus-visible, #qa-panel select:focus-visible { outline: 2px solid #c4ffad; outline-offset: 2px; }
    #qa-panel button:disabled, #qa-panel select:disabled { opacity: .45; cursor: wait; }
    #qa-panel label { display: block; margin: 10px 0 4px; }
    #qa-panel select { flex: 1; min-width: 0; }
    #qa-panel .qa-row { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
    #qa-panel .qa-directions button { flex: 1; padding-inline: 4px; }
    #qa-panel .qa-note { margin: 8px 0 0; color: #b3c6b9; }
    #qa-panel details { margin-top: 9px; border-top: 1px solid #496052; padding-top: 7px; }
    #qa-panel summary { cursor: pointer; }
    #qa-panel [hidden] { display: none !important; }
    #qa-report { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 230px;
      overflow-y: auto; margin: 10px 0 0; padding: 8px; background: #07110b;
      border-radius: 4px; font: 11px/1.55 ui-monospace, monospace; color: #d9e7dc; }
    #qa-report[data-state="fail"] { color: #ffb2a5; }
    #qa-report[data-state="pass"] { color: #b7f7b0; }
    #qa-panel.qa-collapsed { width: auto; }
    body:is(.qa-scene-inspection, .qa-npc-inspection, .qa-held-inspection, .qa-transition-inspection) :is(#banner, #route-marker, #mission-caption,
      #message, #pickupprompt, #hitmarker, #killmessage, #damageindicator, #crosshair) {
      display: none !important;
    }
    @media (max-height: 650px) { #qa-report { max-height: 125px; } }
  `;
  document.head.append(style);

  const panel = document.createElement('aside');
  panel.id = 'qa-panel';
  panel.setAttribute('aria-label', 'Silent development QA');
  panel.dataset.state = 'ready';
  // Native buttons/selects keep their keyboard behavior without sending fire,
  // reload or Enter-to-resume events to the game's window listeners.
  // Releases still bubble to the input controller, so moving focus over this
  // panel cannot leave a gameplay key or mouse button held indefinitely.
  for (const type of ['keydown', 'mousedown']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = 'DEVELOPMENT QA · AUDIO OFF';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Hide QA panel';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-controls', 'qa-body');
  header.append(title, toggle);
  const body = document.createElement('div');
  body.id = 'qa-body';
  const label = document.createElement('label');
  label.htmlFor = 'qa-zone';
  label.textContent = 'Inspection area';
  const select = document.createElement('select');
  select.id = 'qa-zone';
  for (const zone of ZONE_ORDER) {
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = ZONE_LABELS[zone];
    select.append(option);
  }
  const inspectionRow = document.createElement('div');
  inspectionRow.className = 'qa-row';
  inspectionRow.append(select);
  const directions = document.createElement('div');
  directions.className = 'qa-row qa-directions';
  directions.setAttribute('aria-label', 'Inspection camera direction');
  const actions = document.createElement('div');
  actions.className = 'qa-row';
  const actorPanel = document.createElement('details');
  const actorTitle = document.createElement('summary');
  actorTitle.textContent = 'Inspect an NPC on the balcony';
  actorPanel.append(actorTitle);
  function inspectionSelect(parent, id, labelText, entries) {
    const label = document.createElement('label');
    label.htmlFor = id; label.textContent = labelText;
    const select = document.createElement('select');
    select.id = id;
    for (const [value, text] of entries) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text; select.append(option);
    }
    parent.append(label, select);
    return select;
  }
  const graphicsRow = document.createElement('div');
  const quality = inspectionSelect(graphicsRow, 'qa-quality', 'Graphics quality', [
    ['auto', 'Automatic'], ['high', 'High detail'], ['performance', 'Performance'],
  ]);
  quality.value = Settings.get('quality');
  const renderScale = inspectionSelect(graphicsRow, 'qa-scale', 'Review render scale', [
    ['device', 'Device / preset default'], ['0.85', 'Fixed 0.85×'], ['1', 'Fixed 1.00×'],
    ['1.2', 'Fixed 1.20×'], ['1.6', 'Fixed 1.60×'], ['2', 'Fixed 2.00×'],
  ]);
  const surfaceMode = inspectionSelect(graphicsRow, 'qa-surface-mode', 'Surface texture delivery (reloads)', [
    ['raw', 'Raw PBR maps'], ['ktx2', 'KTX2 compressed maps'],
  ]);
  surfaceMode.value = new URLSearchParams(location.search).get('surfaces') === 'raw' ? 'raw' : 'ktx2';
  function reviewToggle(id, text) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = id; input.type = 'checkbox'; input.checked = true;
    label.append(input, document.createTextNode(` ${text}`));
    graphicsRow.append(label);
    return input;
  }
  const interiorLight = reviewToggle('qa-interior-light', 'Baked interior lighting');
  const interiorReflection = reviewToggle('qa-interior-reflection', 'Local interior reflections');
  const heroFace = reviewToggle('qa-hero-face', 'Facial albedo');
  const focusedShadow = reviewToggle('qa-focused-shadow', 'Focused directional shadows');
  const roofTaskLight = reviewToggle('qa-roof-task-light', 'Roof task lighting');
  const actorType = inspectionSelect(actorPanel, 'qa-npc-type', 'NPC type',
    Object.keys(ENEMY_TYPES).map(type => [type, `${type[0].toUpperCase()}${type.slice(1)}`]));
  actorType.value = 'brawler';
  const actorPose = inspectionSelect(actorPanel, 'qa-npc-pose', 'Pose sample', [
    ['neutral', 'Neutral anatomy'], ['idle', 'Idle breathing'], ['walk', 'Walking stride'],
    ['guard', 'Combat guard / aim'], ['advance', 'Guarded advance'], ['windup', 'Attack windup'],
    ['contact', 'Attack contact'], ['recovery', 'Attack recovery'],
  ]);
  const actorFraming = inspectionSelect(actorPanel, 'qa-npc-framing', 'NPC framing', [
    ['body', 'Full body'], ['portrait', 'Face and shoulders'], ['face', 'Face close-up'],
    ['lowface', 'Face from below'], ['grip', 'Weapon grip'],
  ]);
  const actorActions = document.createElement('div');
  actorActions.className = 'qa-row'; actorPanel.append(actorActions);
  const heldPanel = document.createElement('details');
  const heldTitle = document.createElement('summary');
  heldTitle.textContent = 'Inspect the held weapon';
  heldPanel.append(heldTitle);
  const heldType = inspectionSelect(heldPanel, 'qa-held-type', 'Held weapon', [
    ['bat', 'Baseball bat'], ['fists', 'Fists'], ['knife', 'Knife'],
    ['pistol', 'Pistol'], ['shotgun', 'Shotgun'], ['smg', 'SMG'], ['machinegun', 'Machine gun'],
  ]);
  const heldPose = inspectionSelect(heldPanel, 'qa-held-pose', 'Attack pose sample', [
    ['ready', 'Ready'], ['windup', 'Windup'], ['contact', 'Contact'],
    ['followthrough', 'Followthrough'], ['recovery', 'Recovery'],
  ]);
  const heldSide = inspectionSelect(heldPanel, 'qa-held-side', 'Punch hand', [
    ['right', 'Right'], ['left', 'Left'],
  ]);
  const heldAim = inspectionSelect(heldPanel, 'qa-held-aim', 'Firearm framing', [
    ['hip', 'Hip fire'], ['aim', 'Aimed'],
  ]);
  const heldActions = document.createElement('div');
  heldActions.className = 'qa-row'; heldPanel.append(heldActions);
  const objectPanel = document.createElement('details');
  const objectTitle = document.createElement('summary');
  objectTitle.textContent = 'Inspect world objects';
  objectPanel.append(objectTitle);
  const objectType = inspectionSelect(objectPanel, 'qa-object-type', 'World object', [
    ['health', 'Health case'], ['pistol', 'Dropped pistol'], ['shotgun', 'Dropped shotgun'],
    ['smg', 'Dropped SMG'], ['machinegun', 'Dropped machine gun'], ['knife', 'Dropped knife'],
    ['car', 'Sedan cabin'], ['tank', 'Water tank'], ['barrier', 'Street barrier'],
    ['drops', 'Full drop pool (16)'],
  ]);
  const objectActions = document.createElement('div');
  objectActions.className = 'qa-row'; objectPanel.append(objectActions);
  const healthPanel = document.createElement('details');
  const healthTitle = document.createElement('summary');
  healthTitle.textContent = 'Inspect low-health feedback';
  healthPanel.append(healthTitle);
  const healthSample = inspectionSelect(healthPanel, 'qa-health-sample', 'Health warning sample', [
    ['100', '100% · healthy'], ['40', '40% · normal boundary'], ['39', '39% · low health'],
    ['20', '20% · low boundary'], ['19', '19% · critical health'], ['1', '1% · critical health'],
  ]);
  const healthActions = document.createElement('div');
  healthActions.className = 'qa-row'; healthPanel.append(healthActions);
  const note = document.createElement('p');
  note.className = 'qa-note';
  note.textContent = 'Tests reset the mission. Scene inspection is paused. Combat benchmark uses a controlled live fixture. Audio is locked off.';
  const report = document.createElement('pre');
  report.id = 'qa-report';
  report.dataset.state = 'ready';
  report.setAttribute('role', 'status');
  report.setAttribute('aria-live', 'polite');
  report.tabIndex = 0;
  report.textContent = 'READY · No tests have run.\nUse Run regression suite to test the real game.';
  body.append(graphicsRow, label, inspectionRow, directions, actorPanel, heldPanel, objectPanel, healthPanel, actions, note, report);
  panel.append(header, body);
  document.body.append(panel);

  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    title.hidden = body.hidden;
    panel.classList.toggle('qa-collapsed', body.hidden);
    toggle.textContent = body.hidden ? 'Show QA panel' : 'Hide QA panel';
    toggle.setAttribute('aria-expanded', String(!body.hidden));
  });
  const controls = [select, quality, renderScale, surfaceMode, interiorLight, interiorReflection, heroFace, focusedShadow, roofTaskLight, actorType, actorPose, actorFraming, heldType, heldPose, heldSide, heldAim, objectType, healthSample];
  function button(parent, text, id, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.id = id;
    element.textContent = text;
    element.addEventListener('click', onClick);
    parent.append(element);
    controls.push(element);
    return element;
  }
  return { panel, report, select, quality, renderScale, surfaceMode, interiorLight, interiorReflection, heroFace, focusedShadow, roofTaskLight, controls, button, inspectionRow, directions, actions,
    actorType, actorPose, actorFraming, actorActions, heldType, heldPose, heldSide, heldAim, heldActions,
    objectType, objectActions, healthSample, healthActions,
    dispose() { panel.remove(); style.remove(); } };
}

export function installQA(api) {
  const query = new URLSearchParams(location.search);
  if (!import.meta.env.DEV || query.get('qa') !== '1' || query.get('mute') !== '1') return null;
  if (document.getElementById('qa-panel')) return null;
  for (const method of ['stepFrame', 'render', 'setTesting', 'setInspection']) {
    assert(typeof api?.[method] === 'function', `QA installation requires api.${method}()`);
  }

  pauseSilently();
  assertSilent();
  const ui = createPanel();
  const gl = renderer.getContext(), adapterInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const graphicsDevice = adapterInfo ? String(gl.getParameter(adapterInfo.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  const textureFormats = ['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc']
    .filter(extension => renderer.extensions.has(extension)).join(', ') || 'none exposed';
  const startupWeapon = Weapons.snapshot();
  let busy = false;
  let disposed = false;
  let abortBenchmark = null;
  let abortSuite = null;
  let restoreFixtureTriggers = null;
  let inspectedActor = null;
  let inspectedWeapon = null;
  let visualFixtureActive = false;

  // Hide only specimen-obscuring overlays, without changing HUD timers or
  // classes. Removing this QA mode restores their normal game presentation.
  function setNPCInspection(active) {
    if (inspectedWeapon) {
      Weapons.cancelAttack();
      Weapons.restore(inspectedWeapon.restoreWeapon);
      inspectedWeapon = null;
    }
    document.body.classList.remove('qa-scene-inspection', 'qa-held-inspection', 'qa-transition-inspection');
    document.body.classList.toggle('qa-npc-inspection', active);
    ui.panel.dataset.mode = active ? 'npc-inspection' : 'scene';
  }

  function report(state, lines) {
    ui.panel.dataset.state = state;
    ui.report.dataset.state = state;
    ui.report.textContent = Array.isArray(lines) ? lines.join('\n') : lines;
  }
  function setBusy(value) {
    busy = value;
    for (const control of ui.controls) control.disabled = value;
  }
  function pausedRender() {
    assert(!Input.active, 'Scene inspection must never render active gameplay');
    assert(!renderer.getContext().isContextLost(), 'Graphics context was lost; reload before inspecting or benchmarking');
    camera.position.copy(Player.pos);
    camera.rotation.set(Player.pitch, Player.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    api.render();
  }
  function applyReviewScale() {
    configureRenderer();
    retainReviewScale();
  }
  function retainReviewScale() {
    if (disposed || (!busy && Input.active)) return;
    const scale = Number(ui.renderScale.value);
    if (Number.isFinite(scale) && scale >= 0.7 && scale <= 2) {
      // Explicit QA-only supersampling enables reproducible comparisons even
      // when the browser's device-pixel ratio changes. Never stored in Settings.
      renderer.setPixelRatio(scale);
      renderer.setSize(innerWidth, innerHeight, false);
    }
  }
  function restoreGameplayScale() {
    if (!busy && Input.active) {
      ui.renderScale.value = 'device';
      ui.interiorLight.checked = ui.interiorReflection.checked = ui.focusedShadow.checked = true;
      ui.roofTaskLight.checked = true;
      ui.heroFace.checked = true;
      api.setInteriorLightingEnabled?.(true);
      api.setInteriorReflectionsEnabled?.(true);
      api.setHeroFaceTextureEnabled?.(true);
      api.setFocusedShadowsEnabled?.(true);
      api.setRoofTaskLightingEnabled?.(true);
      configureRenderer();
      document.body.classList.remove('qa-scene-inspection');
    }
  }
  function freshApartment() {
    pauseSilently();
    setNPCInspection(false);
    inspectedActor = null;
    visualFixtureActive = false;
    for (const id of ['settingspanel', 'fieldnotes']) {
      const panel = document.getElementById(id);
      if (panel && !panel.hidden) panel.querySelector('[data-close-panel]')?.click();
    }
    restoreFixtureTriggers?.();
    // Use the effects' normal expiry paths to clear fixture flashes, tracers,
    // impacts and blood before restoring the fresh scene.
    Blood.update(1);
    FX.update(1);
    GameTime.elapsed = 0;
    CombatStats.reset();
    if (api.resetToApartment) {
      assert(api.resetToApartment() !== false, 'Could not reset the apartment');
    } else {
      Weapons.restore(STARTING_WEAPON);
      saveCheckpoint('apartment');
      assert(restartFromZone(), 'The apartment checkpoint cannot be restored');
    }
    api.setInspection(true);
    const state = getMissionState();
    assert(state.zone === 'apartment' && state.checkpoint?.zone === 'apartment' && !state.checkpoint.branch,
      'A fresh reset must restore the apartment checkpoint with no ending branch');
    assert(!PlayerState.dead && Player.health === 100, 'Fresh apartment must restore full health');
    same(Weapons.snapshot(), STARTING_WEAPON, 'Fresh apartment restores fists with no loaded or spare ammunition');
    assert(Enemies.list.length === 0 && pooledSlots().every(slot => !slot.inUse && slot.owner === null),
      'Fresh apartment must release all previous encounter rigs');
    HUD.setCombat(CombatStats.snapshot());
    HUD.setCompass(Player.yaw);
    assertSilent();
  }
  function checkpointAt(zone) {
    pauseSilently();
    setNPCInspection(false);
    inspectedActor = null;
    visualFixtureActive = false;
    saveCheckpoint(zone);
    assert(restartFromZone(), `${ZONE_LABELS[zone]} checkpoint cannot be restored`);
    api.setInspection(true);
  }
  function sceneDescription(zone) {
    const foot = Player.pos.y - Player._eyeH;
    const metrics = api.metrics?.() ?? {}, warmup = metrics.weaponWarmup;
    return [
      `INSPECTING · ${ZONE_LABELS[zone]} · simulation paused`,
      `Feet ${Player.pos.x.toFixed(2)}, ${foot.toFixed(2)}, ${Player.pos.z.toFixed(2)}`,
      `Yaw ${(Player.yaw * 180 / Math.PI).toFixed(0)}° · pitch ${(Player.pitch * 180 / Math.PI).toFixed(0)}°`,
      `Render: ${renderer.info.render.calls} calls · ${renderer.info.render.triangles.toLocaleString()} triangles`,
      `Quality ${Settings.get('quality')} · ${renderer.domElement.width} × ${renderer.domElement.height} drawing buffer · ratio ${renderer.getPixelRatio().toFixed(2)}`,
      `Review scale: ${ui.renderScale.value === 'device' ? 'device/preset' : 'explicit QA override (not saved)'}`,
      ...(warmup ? [`Weapon warmup: ${warmup.status} · ${warmup.models ?? 0} cached models · ${warmup.textures ?? 0} shared textures`] : []),
      ...(metrics.characterWarmup ? [`Character warmup: ${metrics.characterWarmup.status} · ${metrics.characterWarmup.characters ?? 0} rigs · ${metrics.characterWarmup.meshes ?? 0} draw variants · ${metrics.characterWarmup.skeletons ?? 0} skeletons · ${metrics.characterWarmup.elapsedMs?.toFixed(0) ?? '?'} ms`] : []),
      ...graphicsDescription(metrics),
      'Paused visual review hides narrative overlays; ordinary gameplay is unchanged.',
      'Audio locked off · no AudioContext',
    ];
  }
  function graphicsDescription(metrics = api.metrics?.() ?? {}) {
    const bake = metrics.interiorLighting, shadows = metrics.focusedShadows, reflections = metrics.interiorReflections;
    return [
      `Graphics device: ${graphicsDevice}`,
      `Compressed texture support: ${textureFormats}`,
      ...(metrics.surfaceDelivery ? [`Surface delivery: ${JSON.stringify(metrics.surfaceDelivery)}`] : []),
      ...(metrics.startup ? [`Graphics startup: ${metrics.startup.readyMs?.toFixed(0) ?? 'pending'} ms to ready · ${metrics.startup.surfaceMapsMs?.toFixed(0) ?? '?'} ms maps · ${metrics.startup.worldBuildMs?.toFixed(0) ?? '?'} ms world build (local cache/network state applies)`] : []),
      ...(bake ? [`Interior bake ${bake.enabled ? 'ON' : 'OFF'}: ${bake.receivers} receivers · ${bake.charts} charts · ${bake.atlasSize}² atlas · ${bake.rays} rays`,
        `Bake startup: ${bake.cpuMs.toFixed(1)} ms CPU / ${bake.elapsedMs.toFixed(1)} ms wall · ${bake.yieldCount} yields · ${(bake.atlasBytes / 1048576).toFixed(2)} MiB atlas · ${(bake.geometryBytes / 1024).toFixed(0)} KiB UVs`] : []),
      ...(shadows ? [`Directional shadows: ${shadows.mode} (${shadows.reason}) · ${shadows.linearResolutionGain.toFixed(2)}× linear texel density · ${(shadows.texelSize.x * 100).toFixed(2)} × ${(shadows.texelSize.y * 100).toFixed(2)} cm/texel`] : []),
      ...(shadows ? [`Shadow coverage: ${JSON.stringify(shadows)}`] : []),
      ...(reflections ? [`Local reflections: ${JSON.stringify(reflections)}`] : []),
      ...(metrics.roofTaskLighting ? [`Roof task lighting: ${JSON.stringify(metrics.roofTaskLighting)}`] : []),
      ...(metrics.heroFace ? [`Facial albedo: ${JSON.stringify(metrics.heroFace)}`] : []),
    ];
  }

  function controlledArea(zone) {
    checkpointAt(zone);
    const triggerState = Triggers.list.map(trigger => [trigger, trigger.fired]);
    restoreFixtureTriggers = () => {
      for (const [trigger, fired] of triggerState) trigger.fired = fired;
      restoreFixtureTriggers = null;
    };
    // Enter through the real trigger once, then stop authored waves and the
    // ending prompt so the fixture owns only its documented contacts.
    triggersUpdate();
    WaveDirector.reset();
    StreetChoice.reset();
    Endings.reset();
    Enemies.clearAll();
  }
  function controlledStreet() { controlledArea('street'); }

  function startSimulation() {
    api.setInspection(false);
    Input.activate();
    assert(Input.active && !PlayerState.dead, 'The fixture must activate real gameplay');
  }

  function simulateFor(seconds, afterStep = () => {}) {
    const before = GameTime.elapsed, ticks = Math.ceil(seconds * 60);
    for (let tick = 0; tick < ticks; tick++) {
      api.stepFrame(1 / 60);
      assertSilent();
      afterStep();
    }
    near(GameTime.elapsed - before, ticks / 60, 'The real simulation advances the requested fixture duration', 0.025);
  }

  function simulateStep(afterStep = () => {}) {
    const before = GameTime.elapsed;
    near(api.stepFrame(STEP), STEP, 'A contact-boundary probe advances exactly one real simulation step', 1e-9);
    near(GameTime.elapsed - before, STEP, 'The contact-boundary clock advances by one simulation step', 1e-9);
    assertSilent();
    afterStep();
  }

  function simulateUntil(predicate, seconds, label, afterStep = () => {}) {
    try {
      for (let tick = 0; tick < Math.ceil(seconds / STEP) && !predicate(); tick++) simulateStep(afterStep);
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}; `
        + `active=${Input.active}, dead=${PlayerState.dead}, health=${Player.health.toFixed(1)}, hidden=${document.hidden}`);
    }
    assert(predicate(), `${label}; wave=${JSON.stringify(getMissionState().wave)}`);
  }

  function observeArrivals(zone) {
    const config = ZONE_WAVE_CONFIG[zone], arrivals = new Map();
    function capture() {
      const alive = Enemies.list.filter(enemy => enemy.alive && enemy.zone === zone);
      assert(alive.length <= config.maxAlive, `${zone} must retain its authored live cap`);
      const newlyArrived = new Set(alive.filter(enemy => !arrivals.has(enemy)));
      if (config.maxRearAlive) assert(alive.filter(enemy => enemy.arrivalRole === 'rear').length <= config.maxRearAlive,
        'A living rear contact must occupy the single authored rear slot');
      for (const enemy of alive) {
        if (arrivals.has(enemy)) continue;
        const authored = config.waves[enemy.encounterWave]?.[enemy.encounterEntry];
        assert(enemy.encounterKey === zone && authored && enemy.authoredType === authored,
          `${zone} arrival must retain its original wave, entry and authored type`);
        same(enemy.arrivalRole, (config.rearEntryIndices ?? [1]).includes(enemy.encounterEntry) ? 'rear' : 'front',
          'Each arrival must retain its explicitly authored front or rear slot');
        const dx = enemy.pos.x - Player.pos.x, dz = enemy.pos.z - Player.pos.z, distance = Math.hypot(dx, dz);
        assert(distance >= 5 - 1e-5, `${zone} actual arrival must start at least five metres away, got ${distance}`);
        const rear = dx * Math.sin(Player.yaw) + dz * Math.cos(Player.yaw) >= -1e-7;
        same(enemy.arrivalSide, rear ? 'rear' : 'front', 'Arrival side follows the actual player-facing direction');
        const usableGun = Weapons.def().kind === 'ranged' && (Weapons.loaded > 0 || Weapons.reserve > 0);
        const expectedType = rear ? usableGun && authored !== 'brawler' ? 'thug' : 'brawler' : authored;
        same(enemy.type, expectedType, 'An actual rear contact must use the permitted weaker melee loadout');
        const floor = surfaceTopAt(enemy.pos.x, enemy.pos.y, enemy.pos.z, 0.28, 0.16);
        near(enemy.pos.y, floor + 0.03, `${zone} arrival retains the authored spawn clearance`, 1e-5);
        assert(capsuleHasClearance(enemy.pos, 0.48, 2.02, Colliders.list, 1e-5),
          `${zone} arrival must clear the full conservative director capsule`);
        if (config.frontPairSize === 2 && enemy.encounterEntry < 2) {
          const pair = alive.filter(other => other.encounterWave === enemy.encounterWave && other.encounterEntry < 2);
          same(pair.map(other => other.encounterEntry).sort(), [0, 1], 'Both front slots must exist in the same actual simulation step');
          assert(pair.every(other => newlyArrived.has(other) && other.arrivalRole === 'front' && other.arrivalSide === 'front'),
            'A front pair cannot appear across separate frames or surrender its second member to the rear');
          const head = enemy.mesh.userData.rig.anchors.headCenter.getWorldPosition(new Vector3());
          camera.updateWorldMatrix(true, false);
          const projected = head.clone().project(camera);
          assert(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z >= -1 && projected.z <= 1,
            'Both arriving front heads must be inside the actual rendered field of view');
          assert(!Ballistics.segmentOccluded(camera.position, head, 'sight'),
            'The actual rendered world cannot conceal a member of the promised visible front pair');
        }
        if (rear || enemy.arrivalRole === 'rear') {
          near(enemy.spawnGrace, 1, 'Grace begins on the actual spawn, not the earlier pending request');
          assert(enemy.lastSeenPlayer && enemy.timeSinceSeen === 0 && enemy.windupRemaining < 0 && !enemy.burstLeft,
            'A protected arrival receives one observation and cannot already be attacking');
          const source = { pos: enemy.pos, radius: 0.48, height: 2.02 };
          const projection = describeOffscreenThreat(readThreatView(), source);
          assert(projection, 'A real arrival requires a valid rendered camera');
          if (projection.visible) {
            const kinds = new Set(['wall', 'building', 'partition', 'lintel', 'floor', 'deck', 'slab', 'roof', 'ceiling']);
            const solids = [...Architecture.elements.values()].filter(record => {
              const mesh = record.mesh, material = mesh.material;
              if (!kinds.has(record.kind) || !mesh.isMesh || mesh.geometry.type !== 'BoxGeometry' || !material?.visible
                || material.transparent || material.opacity !== 1 || material.alphaTest || material.alphaMap
                || material.alphaHash || material.colorWrite === false) return false;
              for (let parent = mesh; parent; parent = parent.parent) if (!parent.visible) return false;
              return true;
            }).map(record => record.bounds);
            const targets = Array.from({ length: 9 }, (_, corner) =>
              new Vector3(enemy.pos.x + (corner === 8 ? 0 : corner & 1 ? 0.48 : -0.48),
                enemy.pos.y + (corner === 8 ? 1.01 : corner & 2 ? 2.02 : 0),
                enemy.pos.z + (corner === 8 ? 0 : corner & 4 ? 0.48 : -0.48)));
            assert(solids.some(box => targets.every(target => isSegmentOccluded(camera.position, target, [box]))),
              'One opaque visible structural box must conceal the entire fallback body envelope');
          }
        }
        for (const other of alive) {
          if (other === enemy || Math.abs(other.pos.y - enemy.pos.y) > 2.2) continue;
          assert(Math.hypot(other.pos.x - enemy.pos.x, other.pos.z - enemy.pos.z) >= 1.5 - 1e-5,
            'A newly arriving contact must not overlap an existing actor');
          if (!config.rearPressure.stagger || other.encounterWave !== enemy.encounterWave) continue;
          const ox = other.pos.x - Player.pos.x, oz = other.pos.z - Player.pos.z, otherDistance = Math.hypot(ox, oz);
          const dot = (dx * ox + dz * oz) / (distance * otherDistance);
          const cross = Math.abs(dx * oz - dz * ox) / (distance * otherDistance);
          assert(dot < 0 || (Math.min(distance, otherDistance) * cross >= 0.4 - 1e-6
            && Math.atan2(cross, dot) >= 0.04 - 1e-6), 'A same-side balcony pair needs distinct lateral space and head bearings');
        }
        arrivals.set(enemy, { position: enemy.pos.clone(), time: GameTime.elapsed, distance,
          type: enemy.type, role: enemy.arrivalRole, side: enemy.arrivalSide, wave: enemy.encounterWave });
      }
      assert(arrivals.size <= config.totalContacts, `${zone} cannot expand its finite authored contact budget`);
    }
    return { arrivals, capture };
  }

  function readOffscreenAlert() {
    const element = document.getElementById('offscreenthreat'), label = document.getElementById('offscreenthreatlabel');
    const count = document.getElementById('offscreenthreatcount');
    assert(element && label && count, 'The real HUD must expose its offscreen threat status and text');
    return { hidden: element.hidden, ariaHidden: element.getAttribute('aria-hidden'), shown: element.classList.contains('show'),
      phase: element.dataset.phase ?? null, direction: element.dataset.direction ?? null, label: label.textContent,
      count: count.textContent, countHidden: count.hidden, ariaLabel: element.getAttribute('aria-label'),
      angle: element.style.getPropertyValue('--threat-angle') };
  }

  function assertOffscreenAlert(phase = null) {
    const state = readOffscreenAlert(), element = document.getElementById('offscreenthreat');
    if (phase) {
      assert(!state.hidden && state.shown && state.ariaHidden === 'false', 'An active offscreen attack must expose the real HUD warning');
      same([state.phase, state.direction], [phase, 'BEHIND'], 'The rear fixture must show its actual phase and direction');
      same(state.label, (phase === 'hit' ? 'HIT' : 'ATTACK') + ' FROM BEHIND', 'Threat text describes the actual combat event');
      same(state.ariaLabel, (phase === 'hit' ? 'Hit' : 'Attack') + ' from behind.', 'Assistive text matches the visible threat');
      assert(element.getAttribute('role') === 'status' && element.getAttribute('aria-live') === 'assertive'
        && state.countHidden && !state.count, 'One real attacker needs an accessible status, without a fabricated multi-attacker count');
      const angle = Number.parseFloat(state.angle);
      assert(Number.isFinite(angle) && angle > Math.PI / 2 && angle < Math.PI * 1.5,
        'The warning arrow must have a finite rearward bearing');
      assert(window.getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0,
        'The active warning must actually participate in the visible HUD layout');
    } else {
      same(state, { hidden: true, ariaHidden: 'true', shown: false, phase: null, direction: null,
        label: '', count: '', countHidden: true, ariaLabel: null, angle: '' }, 'No stale offscreen alert may survive its source');
    }
    return state;
  }

  function interactThroughInput() {
    assert(Input.active && Input.keyDown('KeyE'), 'Interaction requires a real active E input edge');
    try { simulateFor(1 / 60); }
    finally { Input.keyUp('KeyE'); }
  }

  function assertBalconyActors(label) {
    const foot = new Vector3(Player.pos.x, Player.pos.y - Player._eyeH, Player.pos.z);
    assertBalconyBody(foot, Player.radius, Player.bodyHeight, `${label} player`);
    for (const enemy of Enemies.list) {
      if (enemy.alive) assertBalconyBody(enemy.pos, enemy.radius, enemy.height, `${label} ${enemy.type}`);
    }
  }

  function beginMeleeThroughInput(enemy, { key = 'KeyJ', attackType = Weapons.current,
    hold = false, checkActors = () => {}, aimPoint = null } = {}) {
    const timing = meleeTiming(attackType);
    simulateFor(Math.max(1 / 60, Weapons.cooldown + 1 / 60), checkActors);
    const target = aimAtBody(enemy);
    if (aimPoint) pointCameraAt(aimPoint);
    assert(!isSegmentOccluded(Player.pos, target, Colliders.list), 'Actual melee needs a clear world sightline');
    const initialHit = raycastEnemies(camera.position, camera.getWorldDirection(new Vector3()), WEAPON_DEFS[attackType].range);
    assert(initialHit?.enemy === enemy, 'The target must be hittable by the actual initial melee ray');
    const health = enemy.health, previousSequence = Weapons.melee.sequence, owner = Weapons.current;
    assert(Input.keyDown(key), 'Each actual melee strike must begin with a fresh input edge');
    try { simulateFor(1 / 60, checkActors); }
    finally { if (!hold) Input.keyUp(key); }
    const attack = Weapons.melee;
    assert(attack.active && attack.type === attackType && attack.owner === owner && attack.sequence > previousSequence,
      'Real input must start one attack owned by the currently equipped weapon');
    near(attack.duration, timing.duration, 'The actual swing uses its authored duration');
    near(attack.contactAt, timing.contactAt, 'The actual swing uses its authored contact time');
    near(enemy.health, health, 'Starting a swing cannot apply damage before visual contact');
    assert(!attack.contactDelivered, 'A newly started swing must still be waiting for contact');
    return { health, sequence: attack.sequence, timing,
      expectedDamage: Math.min(health, WEAPON_DEFS[attackType].dmg) };
  }

  function advanceMeleeToContact(enemy, strike, checkActors = () => {}, trackTarget = true) {
    for (let frame = 0; frame < Math.ceil(strike.timing.duration / STEP) + 2 && !Weapons.melee.contactDelivered; frame++) {
      assert(Weapons.melee.active && Weapons.melee.sequence === strike.sequence,
        'The same pending swing must survive until its contact phase');
      if (trackTarget) aimAtBody(enemy);
      simulateStep(checkActors);
    }
    assert(Weapons.melee.contactDelivered && Weapons.melee.sequence === strike.sequence,
      'The pending attack must commit exactly one contact during the authored swing');
  }

  function strikeBodyThroughInput(enemy, checkActors = () => {}) {
    assert(Weapons.def().kind === 'melee', 'The melee fixture requires an actual equipped melee weapon');
    const strike = beginMeleeThroughInput(enemy, { checkActors });
    advanceMeleeToContact(enemy, strike, checkActors);
    near(strike.health - enemy.health, strike.expectedDamage, 'Real melee input hits the centered torso exactly once at contact');
  }

  function prepareCombatFixture({ roof = false } = {}) {
    freshApartment();
    const zone = roof ? 'roof' : 'street';
    controlledArea(zone);
    const types = roof ? ['bruiser', 'enforcer', 'hitman', 'gunman', 'thug'] : ['gunman', 'hitman', 'bruiser', 'gunman'];
    const points = roof
      ? [[20, -12], [20, -20], [12, -20], [4, -5], [22, -4]].map(([x, z]) => ({ x, y: ROOF.floorY, z }))
      : DISTRICT.street.qa.benchmark;
    if (roof) placeOnClearFloor({ x: 15, y: ROOF.floorY, z: -7 });
    const entries = points.map((point, index) => ({ ...point, type: types[index] }));
    for (const entry of entries) entry.enemy = spawnFixtureEnemy(entry.type, entry, zone);
    Weapons.restore({ current: 'smg', loaded: WEAPON_DEFS.smg.mag, reserve: 240 });
    const aim = roof ? entries[0] : entries[1];
    pointCameraAt({ x: aim.x, y: aim.y + 1.02, z: aim.z });
    const view = { yaw: Player.yaw, pitch: Player.pitch };
    const station = { x: Player.pos.x, z: Player.pos.z };
    let respawns = 0, absorbedDamage = 0, healthRestores = 0;
    let measuredStart = null;
    api.setInspection(false);
    Input.activate();
    Input.keyDown('KeyQ');
    assert(Input.keyDown('KeyJ'), 'Combat fixture must activate the real automatic-fire input');

    function counters() {
      const combat = CombatStats.snapshot();
      return { elapsed: GameTime.elapsed, shots: combat.shots, hits: combat.hits,
        kills: combat.kills, respawns, absorbedDamage, healthRestores };
    }
    return {
      prepareFrame() {
        assert(Input.active && !PlayerState.dead, 'Combat fixture was paused or the player died');
        near(Player.pos.x, station.x, 'Combat fixture must remain at its fixed camera station', 0.03);
        near(Player.pos.z, station.z, 'Combat fixture must remain at its fixed camera station', 0.03);
        if (Player.health < 100) {
          healthRestores++;
          Player.health = 100;
          HUD.setHealth(100);
        }
        for (const entry of entries) {
          if (!entry.enemy.alive) {
            entry.enemy = spawnFixtureEnemy(entry.type, entry, zone);
            respawns++;
          }
        }
        Player.yaw = view.yaw;
        Player.pitch = view.pitch;
        // Fire is held through the real full-auto input path. Empty magazines
        // request a normal timed reload; ammunition is not injected per frame.
        if (Weapons.loaded === 0 && Weapons.reloading <= 0 && Weapons.reserve > 0) Input.keyDown('KeyR');
      },
      afterFrame() {
        Input.keyUp('KeyR');
        absorbedDamage += Math.max(0, 100 - Player.health);
        assert(!PlayerState.dead, 'The controlled combat fixture cannot continue after death');
        const alive = Enemies.list.filter(enemy => enemy.alive);
        assert(alive.length >= entries.length - 1 && alive.length <= entries.length,
          `Combat benchmark must retain ${entries.length - 1}–${entries.length} real live contacts`);
        if (roof) {
          for (const enemy of alive) {
            near(enemy.pos.y, ROOF.floorY, `${enemy.type} retains the rooftop fighting floor`, 0.075);
            assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 0.003),
              `${enemy.type} penetrates rooftop cover or the service-house wall`);
          }
        }
        // Recoil, aiming and hit effects still execute. Holding the observer
        // angle constant makes comparisons repeatable rather than a play test.
        Player.yaw = view.yaw;
        Player.pitch = view.pitch;
        camera.position.copy(Player.pos);
        camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
        camera.updateMatrixWorld();
        return { alive: alive.length, attacking: alive.filter(enemy => enemy.state === 'attack').length };
      },
      markMeasured() { measuredStart = counters(); },
      measurement() {
        assert(measuredStart, 'Combat measurement requires a completed warmup');
        const end = counters();
        return Object.fromEntries(Object.entries(end).map(([key, value]) => [key, value - measuredStart[key]]));
      },
    };
  }

  function prepareBalconyCombatFixture() {
    freshApartment();
    controlledArea('balcony');
    placeOnClearFloor({ x: 7, y: BALCONY.floorY, z: BALCONY.laneZ });
    Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
    const entries = [{ type: 'brawler', enemy: null }, { type: 'thug', enemy: null }];
    const anchors = [1.3, -1.2, -3.7].map(x => ({ x, y: BALCONY.floorY, z: BALCONY.laneZ }));
    pointCameraAt({ x: 5.3, y: BALCONY.floorY + 1.02, z: BALCONY.laneZ });
    const view = { yaw: Player.yaw, pitch: Player.pitch };
    let respawns = 0, absorbedDamage = 0, healthRestores = 0, strikes = 0, hits = 0;
    let measuredStart = null, requestedSwing = false, contactsBefore = [], sequenceBefore = 0;
    let nextStrikeAt = GameTime.elapsed + 1.4;
    startSimulation();

    function counters() {
      return { elapsed: GameTime.elapsed, strikes, hits, kills: CombatStats.snapshot().kills,
        respawns, absorbedDamage, healthRestores };
    }
    return {
      prepareFrame() {
        assert(Input.active && !PlayerState.dead, 'Balcony combat fixture was paused or the player died');
        near(Player.pos.x, 7, 'Balcony melee camera station x', 0.03);
        near(Player.pos.z, BALCONY.laneZ, 'Balcony melee camera station z', 0.03);
        if (Player.health < 100) {
          healthRestores++; Player.health = 100; HUD.setHealth(100);
        }
        for (const entry of entries) {
          if (entry.enemy?.alive) continue;
          const anchor = anchors.find(point => Enemies.list.every(enemy => !enemy.alive
            || Math.hypot(enemy.pos.x - point.x, enemy.pos.z - point.z) >= 1.4));
          assert(anchor, 'A replacement balcony contact requires a clear, separated spawn');
          if (entry.enemy) respawns++;
          entry.enemy = spawnFixtureEnemy(entry.type, anchor, 'balcony');
        }
        contactsBefore = entries.map(entry => [entry.enemy, entry.enemy.health]);
        sequenceBefore = Weapons.melee.sequence;
        Player.yaw = view.yaw; Player.pitch = view.pitch;
        // A deliberate 0.8-second cadence leaves time for real fist/bat
        // windups to reach contact instead of cancelling every NPC attack.
        requestedSwing = Weapons.cooldown <= 0 && GameTime.elapsed >= nextStrikeAt;
        if (requestedSwing) assert(Input.keyDown('KeyJ'), 'Each bat strike requires a new real input edge');
        assertBalconyActors('Before measured melee');
      },
      afterFrame() {
        Input.keyUp('KeyJ');
        if (requestedSwing && Weapons.melee.sequence > sequenceBefore) {
          strikes++; nextStrikeAt = GameTime.elapsed + 0.8;
          assert(Weapons.melee.active && !Weapons.melee.contactDelivered,
            'A measured bat swing must begin with a visible windup, not immediate damage');
          for (const [enemy, health] of contactsBefore) near(enemy.health, health, 'No measured melee damage before contact');
        }
        for (const [enemy, health] of contactsBefore) if (enemy.health < health) hits++;
        absorbedDamage += Math.max(0, 100 - Player.health);
        assert(!PlayerState.dead, 'Balcony fixture cannot continue after death');
        assertBalconyActors('After measured melee');
        const alive = Enemies.list.filter(enemy => enemy.alive);
        assert(alive.length >= 1 && alive.length <= 2, 'Balcony benchmark must retain one or two live melee contacts');
        assert(alive.every(enemy => enemy.type === 'thug' || enemy.type === 'brawler'), 'Balcony fixture must run fist and bat AI only');
        Player.yaw = view.yaw; Player.pitch = view.pitch;
        camera.position.copy(Player.pos);
        camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
        camera.updateMatrixWorld();
        return { alive: alive.length, attacking: alive.filter(enemy => enemy.state === 'attack').length };
      },
      markMeasured() { measuredStart = counters(); },
      measurement() {
        assert(measuredStart, 'Balcony measurement requires a completed warmup');
        const end = counters();
        return Object.fromEntries(Object.entries(end).map(([key, value]) => [key, value - measuredStart[key]]));
      },
    };
  }

  function beginFinalFixture(branch) {
    controlledStreet();
    if (branch === 'bakery') {
      checkpointAt('bakery');
      // The shared access route begins on the real pavement outside the door,
      // leaving room for the entire opening squad to spawn safely inside.
      placeOnClearFloor(DISTRICT.bakery.accessRoute[0]);
      StreetChoice.commitBakery();
    } else {
      StreetChoice.commitCar();
    }
    const state = assertEndingSquad(branch);
    assert(state.ending.pending === 0 && state.ending.spawned === FINAL_ENCOUNTERS[branch].waves[0].length,
      `${branch} resolution fixture requires its complete opening squad to spawn`);
    api.setInspection(false);
    Input.activate();
    return CombatStats.snapshot();
  }

  function placeOnClearFloor(anchor) {
    near(surfaceTopAt(anchor.x, anchor.y, anchor.z, 0.25, 0.16), anchor.y,
      'Fixture player position must have authored floor support', 0.03);
    const foot = new Vector3(anchor.x, anchor.y + 0.02, anchor.z);
    assert(capsuleHasClearance(foot, Player.radius, Player.bodyHeight, Colliders.list),
      'Fixture player position must not overlap world geometry');
    placePlayer(anchor);
  }

  function repositionFixtureEnemy(enemy, anchor) {
    assert(enemy.alive && !enemy.removed && enemy.body.position === enemy.pos,
      'A disclosed target-position fixture must retain the real living body');
    near(surfaceTopAt(anchor.x, anchor.y, anchor.z, 0.25, 0.16), anchor.y,
      'Repositioned fixture target needs a real supporting floor', 0.03);
    const foot = new Vector3(anchor.x, anchor.y + 0.02, anchor.z);
    assert(capsuleHasClearance(foot, enemy.radius, enemy.height, Colliders.list),
      'Repositioned fixture target must not intersect world geometry');
    enemy.pos.copy(foot); enemy.vel.set(0, 0, 0);
    enemy.floorY = anchor.y; enemy.body.onGround = false;
    enemy.mesh.position.copy(enemy.pos); enemy.mesh.updateMatrixWorld(true);
  }

  function clearFinalByFixtureDamage(branch) {
    const zone = branch === 'car' ? 'street' : 'bakery';
    const config = FINAL_ENCOUNTERS[branch], total = config.waves.flat().length;
    const observed = new Map(), defeated = new Set(), byWave = new Map();
    let appliedDamage = 0;
    const timeoutSeconds = Math.max(30, config.waveCount * ((config.waveInterval ?? 5) + 5));
    for (let tick = 0; tick < timeoutSeconds * 60 && defeated.size < total; tick++) {
      const live = Enemies.list.filter(enemy => enemy.alive && enemy.zone === zone);
      const state = Endings.getStatus();
      assert(live.length <= config.maxAlive, `${branch} finale exceeds its live actor cap`);
      near(state.remaining, live.length + state.pending + state.unstartedTypes.length,
        `${branch} remaining count includes live, deferred and unstarted opponents`);
      assert(!state.resolved, `${branch} cannot resolve while an authored opponent remains unprocessed`);
      for (const enemy of live) {
        assert(!observed.has(enemy.id), 'A defeated final contact cannot be reused as a second logical opponent');
        assert(enemy.encounterKey === `final-${branch}` && Number.isInteger(enemy.encounterWave),
          'Final contacts must retain their owning encounter and wave');
        observed.set(enemy.id, enemy.type);
        const roster = byWave.get(enemy.encounterWave) ?? [];
        roster.push(enemy.type); byWave.set(enemy.encounterWave, roster);
        const result = damageEnemy(enemy, enemy.health, 'body');
        assert(result?.killed && !enemy.alive, 'Fixture damage must use the real enemy death path');
        appliedDamage += result.damage; defeated.add(enemy.id);
      }
      assert(defeated.size <= total, `${branch} finale cannot create excess contacts`);
      const progressed = api.stepFrame(1 / 60);
      assert(progressed > 0 || Endings.isResolved(), 'Final encounter fixture must advance the actual simulation');
      assertSilent();
    }
    near(defeated.size, total, `${branch} all authored waves must become safely spawnable and defeatable`);
    for (let index = 0; index < config.waveCount; index++) {
      same([...(byWave.get(index) ?? [])].sort(), [...config.waves[index]].sort(), `${branch} actual wave ${index + 1} roster`);
    }
    const end = Endings.getStatus();
    near(end.spawned, total, `${branch} final successful-spawn count`);
    near(end.remaining, 0, `${branch} final remaining count`);
    near(end.pending, 0, `${branch} final deferred count`);
    near(end.unstartedTypes.length, 0, `${branch} final unstarted count`);
    return { contacts: defeated.size, appliedDamage };
  }

  function assertEndingCard(branch, title, tag) {
    assert(Endings.getMode() === branch && Endings.isResolved(), `${branch} ending must resolve through the simulation`);
    const card = document.getElementById('endcard');
    assert(card.classList.contains('show') && card.getAttribute('aria-hidden') === 'false',
      'The resolved ending must display its real accessible debrief');
    same(document.getElementById('endtitle').textContent, title, 'Resolved ending title');
    assert(document.getElementById('endtag').textContent.includes(tag), 'Resolved ending branch tag');
  }

  function assertNoPlayerCombatCredit(before) {
    const after = CombatStats.snapshot();
    near(after.kills, before.kills, 'Fixture damage must not fabricate player kill credit');
    near(after.shots, before.shots, 'Ending fixture must not fabricate player shots');
    near(after.hits, before.hits, 'Ending fixture must not fabricate player hits');
  }

  const tests = [
    ['Silent audio policy, real mix controls and checkpoint captions', () => {
      const preferences = Settings.snapshot(), inventory = Weapons.snapshot(), supplies = AmmoSupplies.snapshot();
      const panel = document.getElementById('settingspanel');
      try {
        api.setInspection(false); Input.pause();
        document.getElementById('settingsbutton').click();
        assert(panel && !panel.hidden, 'The real Settings button must expose the audio mix controls');
        let percent = 23;
        for (const [bus, key] of Object.entries(AUDIO_MIX_SETTINGS)) {
          const slider = document.getElementById('setting' + key.toLowerCase());
          assert(slider?.type === 'range', `${bus} requires its actual native range control`);
          slider.value = String(percent);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          near(Settings.get(key), percent / 100, `${bus} stores the native input value`);
          near(Audio.getStatus().mix[bus], percent / 100, `${bus} reaches the actual audio controller`);
          same(slider.getAttribute('aria-valuetext'), `${percent} percent`, `${bus} accessible value`);
          same(document.getElementById(key.toLowerCase() + 'value').textContent, `${percent}%`, `${bus} visible value`);
          percent += 11;
          assertSilent();
        }
        const voice = document.getElementById('settingcheckpointvoice');
        assert(voice?.type === 'checkbox', 'Checkpoint voice requires its actual native checkbox');
        for (let toggle = 0; toggle < 2; toggle++) {
          voice.click();
          same(Audio.getStatus().voiceEnabled, voice.checked, 'The actual voice preference reaches the controller');
          same(Settings.get('checkpointVoice'), voice.checked, 'The voice checkbox saves its preference');
          assertSilent();
        }
        Audio.setMuted(false);
        document.getElementById('audiotoggle').click();
        assert(document.getElementById('audiotoggle').disabled, 'The normal audio toggle is disabled by the immutable QA policy');
        same(document.getElementById('audiostatus').textContent, 'AUDIO LOCKED OFF', 'Visible audio status must remain locked');
        assertSilent();
        panel.querySelector('[data-close-panel]').click();
        for (const zone of ZONE_ORDER) {
          checkpointAt(zone);
          const cue = CHECKPOINT_COMMS[zone], caption = document.querySelector('#mission-caption .radio-caption');
          assert(cue && caption && !caption.hidden, `${zone} must retain a separate visible radio subtitle`);
          same(caption.textContent, `INTERCEPTED RADIO · ${cue.text}`, `${zone} uses the authored short radio subtitle`);
          near(api.stepFrame(STEP), 0, 'Paused checkpoint inspection cannot advance audio or gameplay');
          startSimulation(); simulateStep(); pauseSilently();
          assertSilent();
        }
        same(Weapons.snapshot(), inventory, 'Mix changes and checkpoint cues cannot corrupt inventory');
        same(AmmoSupplies.snapshot(), supplies, 'Mix changes and checkpoint cues cannot consume or refill supply ledgers');
      } finally {
        pauseSilently();
        panel?.querySelector('[data-close-panel]')?.click();
        Settings.set(preferences);
      }
      same(Settings.snapshot(), preferences, 'The QA fixture restores the exact saved preferences');
      same(Audio.getStatus().mix, audioMixFromSettings(preferences), 'Restored preferences reach every audio bus');
      assertSilent();
      return 'Five real mix sliders and the voice checkbox update settings without unlocking sound; all eight checkpoint subtitles survive paused/active steps. Preferences, inventory and supply ledgers are preserved; no context, voices, sample work or queued radio';
    }],
    ['Initial load and full reset start with empty hands', () => {
      same(startupWeapon, STARTING_WEAPON, 'The actual first loaded game must start with fists and no ammunition');
      Weapons.restore({ current: 'pistol', loaded: 5, reserve: 19 });
      freshApartment();
      same(Weapons.snapshot(), STARTING_WEAPON, 'A full new-mission reset must discard previously acquired guns and ammunition');
      same(getMissionState().checkpoint.weapon, STARTING_WEAPON, 'The initial apartment checkpoint must save the fists-only loadout');
      same(document.getElementById('weaponname').textContent, 'FISTS', 'The actual starting HUD shows fists');
      same(document.getElementById('ammocurrent').textContent, '∞', 'The actual starting HUD shows melee ammunition');
      return 'Actual boot snapshot and a full reset both contain fists, zero loaded rounds and zero reserve; checkpoint retry cannot grant an unearned starter gun';
    }],
    ['Low-health screen feedback follows damage, healing, pause and retry', () => {
      const cue = document.getElementById('healthvignette');
      const label = document.getElementById('healthwarning');
      assert(cue && label, 'The real HUD must contain a screen-wide health cue and accessible status');
      const before = CombatStats.snapshot(), inventory = Weapons.snapshot();
      function check(health, level) {
        near(Player.health, health, 'The health cue cannot change player health');
        same(HUD.snapshot().healthWarning, level, 'HUD warning follows exact unrounded health');
        same(cue.dataset.level, level, 'The real overlay selects the expected presentation');
        same(cue.hidden, level === 'normal', 'Only a living low/critical player exposes the overlay');
        same(label.textContent, level === 'critical' ? 'CRITICAL HEALTH' : level === 'low' ? 'LOW HEALTH' : '',
          'Warning text does not rely solely on color');
        if (level !== 'normal') {
          const rect = cue.getBoundingClientRect(), style = globalThis.getComputedStyle(cue);
          near(rect.width, innerWidth, 'Health cue spans the actual viewport width', 1);
          near(rect.height, innerHeight, 'Health cue spans the actual viewport height', 1);
          same(style.visibility, 'visible', 'The cue is visible during scene play/inspection');
          same(style.pointerEvents, 'none', 'The cue never intercepts aiming or interaction');
          same(style.animationName, 'none', 'The persistent warning does not flash or animate');
        }
      }
      check(100, 'normal');
      for (const [damage, health, level] of [[60, 40, 'normal'], [1, 39, 'low'], [19, 20, 'low'], [1, 19, 'critical']]) {
        applyPlayerDamage(damage);
        check(health, level);
        HUD.update(2);
        near(Number(document.getElementById('bloodvignette').style.opacity), 0, 'Transient damage flash expires independently');
        check(health, level);
      }
      startSimulation();
      Input.pause();
      same(globalThis.getComputedStyle(cue).visibility, 'hidden', 'The normal pause menu hides the screen cue');
      near(Player.health, 19, 'Pausing cannot heal the player');
      api.setInspection(true);
      check(19, 'critical');
      const pickup = HealPickups.list.find(entry => entry.zone === 'apartment');
      assert(pickup?.active, 'The actual apartment health supply must be available');
      placePlayer({ x: pickup.mesh.position.x, y: CHECKPOINTS.apartment.y, z: pickup.mesh.position.z });
      HealPickups.update(1 / 60);
      const recovered = Math.min(100, 19 + pickup.amount);
      check(recovered, recovered < 20 ? 'critical' : recovered < 40 ? 'low' : 'normal');
      assert(!pickup.active, 'Recovery must consume the real finite supply');
      applyPlayerDamage(Player.health);
      assert(PlayerState.dead && cue.hidden && HUD.snapshot().healthWarning === 'normal',
        'Actual death clears the persistent health cue');
      assert(restartFromZone(), 'The real checkpoint must restore the player after death');
      api.setInspection(true);
      check(100, 'normal');
      same(CombatStats.snapshot(), before, 'Explicit fixture damage never fabricates player combat credit');
      same(Weapons.snapshot(), inventory, 'The health presentation never changes the loadout');
      return 'Real damage path crosses 40/39/20/19 HP, persistent cue survives damage-flash expiry, pause hides it, an actual health pickup recovers it, death/retry clears it; disclosed fixture damage, no fabricated combat credit';
    }],
    ['Settings and Field Notes prevent starting play', () => {
      api.setInspection(false);
      // Establish a positive control after the one-time intro. Otherwise its
      // first-engage return could make an absent modal guard appear to pass.
      let entered = engageLock({ pointerLock: false });
      if (!entered && IntroCard.isOpen()) {
        IntroCard.dismiss({ engage: false });
        entered = engageLock({ pointerLock: false });
      }
      assert(entered && Input.active, 'Positive control: play must start when no panel is open');
      Input.pause();
      for (const [buttonId, panelId, label] of [
        ['settingsbutton', 'settingspanel', 'Settings'],
        ['fieldnotesbutton', 'fieldnotes', 'Field Notes'],
      ]) {
        const opener = document.getElementById(buttonId), panel = document.getElementById(panelId);
        assert(opener && panel, `${label} must have real UI controls`);
        try {
          opener.click();
          assert(!panel.hidden && document.getElementById('overlay').classList.contains('is-panel-open'),
            `${label} must open through its actual UI handler`);
          assert(engageLock({ pointerLock: false }) === false && !Input.active,
            `${label} must block gameplay activation while open`);
          assert(!IntroCard.isOpen(), `${label} must not open an intro behind the modal`);
          assertSilent();
        } finally {
          pauseSilently();
          panel.querySelector('[data-close-panel]')?.click();
        }
        assert(panel.hidden && !document.getElementById('overlay').classList.contains('is-panel-open')
          && !document.getElementById('menucontent').inert, `${label} must restore the normal menu when closed`);
      }
      assert(engageLock({ pointerLock: false }) && Input.active, 'Closing both panels must restore normal play activation');
      pauseSilently();
      return 'Actual Settings/Field Notes buttons open protected modals; play is rejected until they close';
    }],
    ['All eight checkpoint floors and capsule clearances', () => {
      assert(ZONE_ORDER.length === 8, 'All eight authored areas must be covered');
      for (const zone of ZONE_ORDER) {
        const status = getCheckpointStatus(zone);
        assert(status.valid, `${ZONE_LABELS[zone]}: ${status.reason}`);
        assert(capsuleHasClearance(status.foot, Player.radius, Player.bodyHeight, Colliders.list),
          `${ZONE_LABELS[zone]}: player capsule intersects geometry`);
        near(status.foot.y, CHECKPOINTS[zone].y + 0.02, `${zone} supporting floor`, 0.16);
      }
      return ZONE_ORDER.map(zone => ZONE_LABELS[zone]).join(', ');
    }],
    ['Boot ballistics follows rendered furniture and open stair guards', () => {
      const topology = () => Object.fromEntries(Object.entries(Ballistics.snapshot()).filter(([key]) => key !== 'lastQuery'));
      const before = topology();
      assert(before.ready && before.objects > 100 && before.geometryCount > 0 && before.nodes > 0 && before.triangles > 0,
        'Boot must index the final rendered world before gameplay; QA never rebuilds that live index');
      near(before.unreadableAlphaMasks, 0, 'All loaded browser alpha masks must be readable');
      const inventory = Weapons.snapshot(), supplies = AmmoSupplies.snapshot(), resources = worldResourceSignature();
      const health = Player.health, elapsed = GameTime.elapsed, revision = Colliders.revision;
      let segments = 0;
      function probe(label, start, end, axis, faces) {
        for (const [side, [a, b]] of [[start, end], [end, start]].entries()) {
          const origin = new Vector3(...a), target = new Vector3(...b), direction = target.clone().sub(origin);
          const hit = Ballistics.raycast(origin, direction, direction.length(), 'bullet', createBallisticHit());
          if (faces) {
            assert(hit?.object?.isMesh && hit.material && hit.triangleIndex >= 0, `${label} must hit a rendered triangle from side ${side}`);
            near(hit.point[axis], faces[side], `${label} actual contact surface`, 1e-5);
            near(hit.normal.length(), 1, `${label} contact has a unit normal`, 1e-5);
          } else assert(hit === null, `${label} must not invent solid cover across a visible opening`);
          for (const channel of ['bullet', 'sight']) same(Ballistics.segmentOccluded(origin, target, channel), Boolean(faces),
            `${label} ${channel} query agrees with the actual opening`);
          segments++;
        }
      }
      probe('Dining chair seat', [1.7, 4.415, -5.6], [1.7, 4.415, -4.4], 'z', [-5.2, -4.8]);
      probe('Dining chair leg without a movement box', [1.55, 4.195, -5.27], [1.55, 4.195, -5.03], 'z', [-5.1775, -5.1225]);
      probe('Open space between chair legs', [1.7, 4.195, -5.6], [1.7, 4.195, -4.4]);
      // The matte casing has a recessed solid back between its vent ribs.
      probe('CRT screen and rear housing', [7.05, 5.105, -7.7], [7.05, 5.105, -6.3], 'z', [-7.28, -6.747]);
      probe('Open space between TV feet', [7, 4.805, -7.5], [7, 4.805, -6.4]);
      near(AmmoSupplies.list.length, 3, 'The boot index must include all three authored floor ammo boxes');
      for (const entry of AmmoSupplies.list) {
        const bounds = new Box3().setFromObject(entry.mesh), origin = bounds.getCenter(new Vector3());
        origin.y = bounds.max.y + 0.3;
        const hit = Ballistics.raycast(origin, new Vector3(0, -1, 0), 0.8, 'bullet', createBallisticHit());
        let owner = hit?.object;
        while (owner && owner !== entry.mesh) owner = owner.parent;
        assert(owner === entry.mesh && hit.point.y >= bounds.min.y,
          `${entry.id} must already own its actual rendered cover in the boot index`);
        segments++;
      }
      for (const flight of STAIRS.flights) {
        const tread = flight.treads[6], next = flight.treads[7];
        const postZ = (tread.z1 + tread.z2) / 2, nextZ = (next.z1 + next.z2) / 2;
        const middleZ = (postZ + nextZ) / 2, floor = (tread.topY + next.topY) / 2;
        const x1 = flight.guardX - 0.55, x2 = flight.guardX + 0.25;
        probe(`${flight.id} actual baluster`, [x1, tread.topY + 0.3, postZ], [x2, tread.topY + 0.3, postZ],
          'x', [flight.guardX - 0.0225, flight.guardX + 0.0225]);
        probe(`${flight.id} open baluster bay`, [x1, floor + 0.32, middleZ], [x2, floor + 0.32, middleZ]);
        const start = [x1, floor + 0.62, middleZ], end = [x2, floor + 0.62, middleZ];
        assert(isSegmentOccluded(new Vector3(...start), new Vector3(...end), Colliders.list),
          'This positive control must cross the generous movement box above an inclined rail');
        probe(`${flight.id} air above inclined rail`, start, end);
      }
      same(topology(), before, 'Read-only ballistics queries must not rebuild or grow the live index');
      same(worldResourceSignature(), resources, 'Ballistics queries cannot add scene resources');
      near(Colliders.revision, revision, 'Queries cannot alter physical collision ownership');
      same(Weapons.snapshot(), inventory, 'Queries cannot change weapon state');
      same(AmmoSupplies.snapshot(), supplies, 'Queries cannot change supply state');
      near(Player.health, health, 'Queries cannot apply damage'); near(GameTime.elapsed, elapsed, 'Queries cannot advance simulation');
      return `${segments} real bidirectional rendered-surface queries distinguish chair/TV solids and four stair rails from visible air; boot index ${before.objects} objects / ${before.triangles} unique-geometry triangles remains unchanged`;
    }],
    ['Registered architecture matches visible bounds and connected supports', () => {
      const records = [...Architecture.elements.values()];
      assert(records.length >= 20, 'The built world must register its selected structural elements');
      World.updateWorldMatrix(true, true);
      let supportLinks = 0, grounds = 0, guards = 0;
      for (const record of records) {
        assert(record.mesh?.parent && record.mesh.visible, `${record.id} has no visible built object`);
        assert(!record.bounds.isEmpty(), `${record.id} has empty architectural bounds`);
        boundsNear(new Box3().setFromObject(record.mesh), record.bounds, `${record.id} visible bounds`);
        if (record.collider) {
          assert(Colliders.isEnabled(record.collider), `${record.id} collider is not active`);
          boundsNear(record.collider, record.bounds, `${record.id} collision bounds`);
        }
        if (record.kind === 'guard') {
          const balconyScreen = record.id.startsWith('balcony-screen-');
          if (balconyScreen) guards++;
          near(record.bounds.max.y - record.bounds.min.y, balconyScreen ? BALCONY.guardHeight : BALCONY.railHeight,
            `${record.id} visible safety-screen height`);
          assert(record.collider, `${record.id} must block movement at the visible screen`);
        }
        const kind = record.supportKind;
        assert(['bearing', 'ground', 'anchored', 'suspended'].includes(kind), `${record.id} has an unknown support relationship`);
        if (!record.supports.length || kind === 'ground') {
          // A floor or footing rooted in the actual ground is not a floating
          // exception. Supportless elevated parts always fail this assertion.
          assert(record.bounds.min.y <= 0.17 && record.bounds.max.y >= -0.03,
            `${record.id} has neither a ground contact nor a declared support`);
          grounds++;
        }
        for (const supportId of record.supports) {
          assert(supportId !== record.id, `${record.id} cannot support itself`);
          const support = Architecture.elements.get(supportId);
          assert(support, `${record.id} references missing support ${supportId}`);
          const a = record.bounds, b = support.bounds;
          if (kind === 'bearing') {
            const overlapX = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
            const overlapZ = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
            const joint = b.max.y - a.min.y;
            assert(overlapX > 0 && overlapZ > 0 && joint >= -0.031 && joint <= 0.251
              && (b.min.y + b.max.y) / 2 < (a.min.y + a.max.y) / 2,
            `${record.id} does not bear on ${supportId} (joint ${joint.toFixed(3)} m)`);
          } else {
            assert(boxGap(a, b) <= 0.031, `${record.id} is disconnected from ${supportId}`);
            if (kind === 'suspended') assert(b.max.y >= a.max.y - 0.031, `${record.id} suspension must connect above it`);
          }
          supportLinks++;
        }
      }
      assert(guards >= 4, 'All four balcony boundary screens must have visible matched collision');
      return `${records.length} selected structural records, ${supportLinks} support links, ${grounds} ground roots and ${guards} matched screens; not a whole-building engineering claim`;
    }],
    ['Boot surface ownership preserves floor caps and ceiling finishes', checkFinalizedArchitectureSurfaces],
    ['Stone and metal thresholds keep one flush visible finish', checkFlushThresholdSurfaces],
    ['Balcony combat lane has no visible structural obstructions', () => {
      const { wrap, floorY } = BALCONY;
      const lane = new Box3(
        new Vector3(wrap.x1 + 0.45, floorY + 0.02, wrap.z1 + 0.42),
        new Vector3(wrap.x2 - 0.45, floorY + Player.bodyHeight, wrap.z2 - 0.38),
      );
      for (const record of Architecture.elements.values()) {
        assert(!record.bounds.intersectsBox(lane), `${record.id} visibly crosses the balcony combat lane`);
      }
      return 'Registered braces, standards, ledgers and guards leave the body-height gallery corridor open, including decorative members without colliders';
    }],
    ['Authored openings remain clear at their actual supporting floors', () => {
      for (const [name, opening] of Object.entries(OPENINGS)) {
        const x = (opening.min[0] + opening.max[0]) / 2;
        const z = (opening.min[2] + opening.max[2]) / 2;
        const y = surfaceTopAt(x, opening.min[1], z, 0.25, 0.16);
        near(y, opening.min[1], `${name} has a real floor at the authored opening`, 0.16);
        assert(capsuleHasClearance(new Vector3(x, y + 0.02, z), Player.radius, Player.bodyHeight, Colliders.list),
          `${name} visible opening contains a blocking wall or misplaced decoration`);
      }
      return `${Object.keys(OPENINGS).length} actual door/parapet openings clear a standing player capsule`;
    }],
    ['Exterior doors share their interior frames, hardware and collision', () => {
      // Isolate the physical leaf from the intentional fire blocking this
      // entrance in the story. Live fire/collision state is never mutated.
      const fireColliders = new Set(WorldState.fires.map(fire => fire.collider).filter(Boolean));
      const doorSolids = Colliders.list.filter(box => !fireColliders.has(box));
      for (const door of Object.values(APARTMENT_DOORS)) {
        const tangent = door.axis === 'z' ? 'x' : 'z';
        const jambs = [0, 1].map(index => World.getObjectByName(`${door.id}-jamb-${index}`));
        const header = World.getObjectByName(`${door.id}-header`);
        const threshold = World.getObjectByName(`${door.id}-threshold`);
        assert(jambs.every(Boolean) && header && threshold, `${door.id} needs one complete real frame`);
        const bounds = [...jambs, header, threshold].map(mesh => {
          assert(mesh.userData.doorId === door.id, `${door.id} parts share the same authored doorway`);
          return new Box3().setFromObject(mesh);
        });
        near(bounds[0].max[tangent], door[tangent] - door.width / 2, `${door.id} first jamb inner edge`, 1e-5);
        near(bounds[1].min[tangent], door[tangent] + door.width / 2, `${door.id} second jamb inner edge`, 1e-5);
        near(bounds[2].min.y, door.floorY + door.height, `${door.id} header preserves the shared clear height`, 1e-5);
        for (const [index, box] of bounds.entries()) {
          near((box.min[door.axis] + box.max[door.axis]) / 2, door[door.axis],
            `${door.id} frame part ${index} lies on the same wall plane from either face`, 1e-5);
        }
        const leaves = [];
        World.traverse(object => {
          if (object.userData.doorId === door.id && object.userData.doorPart === 'slab') leaves.push(object);
        });
        if (door.closed) {
          near(leaves.length, 1, 'The closed entry must have one physical slab, not unrelated front and back doors');
          const leaf = leaves[0], box = new Box3().setFromObject(leaf);
          assert(leaf.userData.collider && Colliders.isEnabled(leaf.userData.collider), 'The visible closed slab must remain collidable');
          boundsNear(box, leaf.userData.collider, `${door.id} slab matches its physical blocker`);
          near(box.min.y, bounds[3].max.y, `${door.id} slab meets its supported threshold`, 1e-5);
          const handles = ['interior', 'exterior'].map(side => {
            const handle = World.getObjectByName(`${door.id}-${side}-handle`);
            assert(handle?.userData.doorSide === side, `${door.id} has an attached ${side} handle`);
            return new Box3().setFromObject(handle).getCenter(new Vector3());
          });
          near(handles[0][tangent], handles[1][tangent], 'Both handles share their actual latch position', 1e-5);
          near(handles[0].y, handles[1].y, 'Both handles share their actual latch height', 1e-5);
          near(handles[0][door.axis] + handles[1][door.axis], door[door.axis] * 2,
            'Door hardware belongs to opposing faces of one slab', 1e-5);
          for (const side of [-1, 1]) {
            const start = { x: door.x, y: door.floorY, z: door.z };
            start[door.axis] += side * 0.75;
            const body = makeBody(start.x, start.y, start.z);
            assert(capsuleHasClearance(body.position, body.radius, body.height, doorSolids), 'Both door-only approach positions need real clearance');
            for (let tick = 0; tick < 120; tick++) {
              body.velocity[door.axis] = -side * Player.speedWalk;
              body.velocity.y -= 22 * STEP;
              moveCapsule(body, STEP, doorSolids, true);
            }
            assert(side * (body.position[door.axis] - door[door.axis]) >= body.radius + door.slabThickness / 2 - 0.003,
              'The visible closed door must stop passage from both faces');
            near(body.position.y, door.floorY, 'The closed-door approach remains on its actual floor', 0.03);
          }
        } else {
          near(leaves.length, 0, 'The open terrace frame cannot hide a second closed door');
          near(bounds[3].max.y, door.floorY, 'The open threshold stays flush with both connected floors', 1e-5);
          const body = makeBody(door.x - 0.7, door.floorY, door.z - 0.5);
          walkRoute(body, [[door.x + 1.3, door.floorY, door.z - 0.5],
            [door.x - 0.7, door.floorY, door.z - 0.5]], 'Two-way terrace doorway');
        }
      }
      return 'One supported closed entry slab and paired latch hardware stop both approaches in a door-only fixture (story fires excluded locally, live colliders unchanged); the neighbor terrace shares one aligned frame and a flush threshold traversed both ways';
    }],
    ['Breach jump through built apartment geometry', () => {
      const body = makeBody(-4, 4, -6);
      body.onGround = false;
      body.velocity.y = Player.jumpVel;
      walkRoute(body, [[-1.5, 4, -6]], 'Apartment breach');
      return 'Full capsule clears the sill and lands in the neighboring apartment';
    }],
    ['Apartment rooms connect through the breach and neighboring doorway', () => {
      const start = CHECKPOINTS.apartment;
      const body = makeBody(start.x, start.y, start.z);
      walkRoute(body, [[-8.5, 4, -4], [-8.5, 4, -6], [-5, 4, -6], [-4, 4, -6]], 'Apartment room route');
      body.onGround = false;
      body.velocity.y = Player.jumpVel;
      walkRoute(body, [[-1.5, 4, -6]], 'Connected breach jump');
      walkRoute(body, [
        [-0.6, 4, -6], [-0.1, 4, -4.2], [1.9, 4, -3.8],
        [5.6, 4, -3.8], [5.6, 4, -5.5], [8.5, 4, -5.5], [11, 4, -5.5],
      ], 'Neighboring apartment room route');
      return 'Real capsule crosses both rooms, makes the sole required breach jump, turns through the interior partition and reaches the balcony without furniture penetration';
    }],
    ['Neighbor gate resets and reuses its original resources', () => {
      assert(typeof api.resetToApartment === 'function', 'Gate regression requires the real full-mission reset API');
      const trigger = Triggers.list.find(entry => entry.name === 'neighbor');
      assert(trigger && !trigger.fired, 'A fresh mission must leave the neighbor trigger unfired');
      const baselineBoxes = new Set(Colliders.list);
      const before = worldResourceSignature();
      const wasCached = Boolean(World.getObjectByName('neighbor-breach-fire'));
      const opening = new Vector3(-3, 4.52, -6);
      assert(capsuleHasClearance(opening, Player.radius, Player.bodyHeight, Colliders.list),
        'The initial breach must clear a capsule above its original sill');

      function enterNeighbor() {
        placeOnClearFloor(CHECKPOINTS.neighbor);
        triggersUpdate();
        assert(trigger.fired, 'The actual neighbor trigger must fire on entry');
        Input.activate();
        assert(api.stepFrame(1 / 60) > 0, 'Gate animation must execute through the real simulation');
        pauseSilently();
        pointCameraAt({ x: -3, y: 5.2, z: -6 });
        pausedRender();
        assertPracticalLightBudget();
      }
      enterNeighbor();
      const fire = WorldState.fires.find(entry => entry.group.name === 'neighbor-breach-fire');
      const debris = World.getObjectByName('neighbor-breach-debris');
      assert(fire && debris && debris.userData.collider, 'The actual gate must own its fire, debris and collision objects');
      const gateBoxes = Colliders.list.filter(box => !baselineBoxes.has(box));
      assert(gateBoxes.length === 2 && gateBoxes.includes(fire.collider) && gateBoxes.includes(debris.userData.collider),
        'Neighbor entry must enable exactly its two real gate colliders');
      assert(fire.active && fire.group.visible && fire.smoke.active && fire.smoke.points.visible && debris.visible,
        'First entry must activate the real gate fire, smoke and debris');
      assert(!capsuleHasClearance(opening, Player.radius, Player.bodyHeight, Colliders.list),
        'An active gate must physically block the breach');
      const first = worldResourceSignature();
      near(first.fires, before.fires + (wasCached ? 0 : 1), 'First entry allocates at most one cached fire');
      near(first.smokeSystems, before.smokeSystems + (wasCached ? 0 : 1), 'First entry allocates at most one cached smoke system');
      near(first.children, before.children + (wasCached ? 0 : 2), 'First entry allocates only the cached fire and debris children');
      const sourceCount = api.metrics?.().lighting?.sources;

      assert(api.resetToApartment() !== false, 'The real apartment reset must succeed after neighbor traversal');
      assert(!trigger.fired, 'Apartment reset must restore the neighbor trigger to unfired');
      assert(gateBoxes.every(box => !Colliders.isEnabled(box) && !Colliders.list.includes(box)),
        'Apartment reset must remove both gate colliders from the active collision world');
      near(Colliders.list.length, baselineBoxes.size, 'Apartment reset restores the original active collider count');
      assert(!fire.active && !fire.group.visible && !fire.smoke.active && !fire.smoke.points.visible && !debris.visible,
        'Apartment reset must deactivate cached gate visuals and smoke');
      near(fire.light.intensity, 0, 'An inactive gate contributes no source-light intensity');
      Input.activate();
      assert(api.stepFrame(1 / 60) > 0, 'A reset frame must exercise normal fire/smoke animation');
      pauseSilently();
      near(fire.light.intensity, 0, 'Animation cannot reactivate a reset gate light');
      assert(!fire.smoke.active && !fire.smoke.points.visible && !trigger.fired,
        'Animation cannot reactivate cached gate smoke or re-fire a distant trigger');
      const body = makeBody(-4, 4, -6);
      body.onGround = false;
      body.velocity.y = Player.jumpVel;
      walkRoute(body, [[-1.5, 4, -6]], 'Breach after real mission reset');

      enterNeighbor();
      assert(World.getObjectByName('neighbor-breach-fire') === fire.group
        && World.getObjectByName('neighbor-breach-debris') === debris,
      'A second entry must reuse the identical cached gate objects');
      assert(gateBoxes.every(box => Colliders.isEnabled(box) && Colliders.list.includes(box)),
        'A second entry must reactivate the same collider objects');
      near(Colliders.list.length, baselineBoxes.size + 2, 'A second entry cannot accumulate gate colliders');
      assert(fire.active && fire.group.visible && fire.smoke.active && fire.smoke.points.visible && debris.visible,
        'A second entry must reactivate the cached gate visuals');
      const repeated = worldResourceSignature();
      for (const key of Object.keys(first)) {
        const initialCount = Array.isArray(first[key]) ? first[key].length : first[key];
        const repeatedCount = Array.isArray(repeated[key]) ? repeated[key].length : repeated[key];
        assert(JSON.stringify(repeated[key]) === JSON.stringify(first[key]),
          `Reentry changed world ${key} identities/counts (${initialCount} → ${repeatedCount})`);
      }
      if (Number.isFinite(sourceCount)) near(api.metrics().lighting.sources, sourceCount, 'Reentry must not add another lighting source');
      return 'Real entry enables two blockers; full reset removes them and clears the jump route; reentry reuses identical resources and keeps exactly eight visible practical lights';
    }],
    ['Balcony route and stairwell entrance', () => {
      const body = makeBody(11, 4, -4.5);
      walkRoute(body, [[11, 4, BALCONY.laneZ], [-18, 4, BALCONY.laneZ], [-18, 4, -0.65]], 'Balcony wrap');
      return 'Supported east terrace → shared wrap centerline → stairwell, without falling or wall penetration';
    }],
    ['Every enemy rig has grounded anatomy and articulated combat poses', () => {
      controlledArea('balcony');
      let poses = 0;
      for (const type of Object.keys(ENEMY_TYPES)) {
        const enemy = spawnFixtureEnemy(type, { x: 11, y: BALCONY.floorY, z: -2.4 }, 'balcony');
        assertNeutralRig(enemy);
        for (const name of ['idle', 'walk', 'guard', 'windup', 'contact', 'recovery']) {
          resetHumanoidPose(enemy.mesh);
          const state = poseForEnemy(enemy, name);
          for (let frame = 0; frame < 30; frame++) {
            updateHumanoidPose(enemy.mesh, state, 1 / 60);
            assertRigSegments(enemy.mesh, `${type} ${name}`);
          }
          const expectedPhase = ['windup', 'contact', 'recovery'].includes(name) ? name : 'idle';
          same(enemy.mesh.userData.rig.pose.phase, expectedPhase, `${type} ${name} pose phase`);
          const rig = enemy.mesh.userData.rig;
          const soles = ['L', 'R'].map(side => rig.anchors[`sole${side}`].getWorldPosition(new Vector3()).y);
          near(Math.min(...soles), enemy.pos.y, `${type} ${name} keeps a stance foot planted`, 0.012);
          poses++;
        }
        Enemies.remove(enemy);
      }
      return `${Object.keys(ENEMY_TYPES).length} actual pooled archetypes, ${poses} pose samples; measured body heights, soles, rigid limb lengths and wrist-mounted props`;
    }],
    ['Pooled fist and bat rigs reset every joint and ownership flag', () => {
      controlledArea('balcony');
      for (const type of ['brawler', 'thug']) {
        const anchor = { x: 11, y: BALCONY.floorY, z: -2.4 };
        const enemy = spawnFixtureEnemy(type, anchor, 'balcony');
        const slot = enemy.poolSlot, root = enemy.mesh;
        const objects = [], resources = [];
        root.traverse(object => {
          objects.push(object.uuid);
          if (object.isMesh) resources.push([object.geometry.uuid, object.material.uuid]);
        });
        for (let frame = 0; frame < 40; frame++) updateHumanoidPose(root, poseForEnemy(enemy, 'contact'), 1 / 60);
        root.userData.rig.joints.wristR.position.x += 0.12;
        const result = damageEnemy(enemy, enemy.health, 'body');
        assert(result?.killed && !enemy.alive, `${type} fixture must enter the real death path`);
        enemiesUpdate(0.12);
        Enemies.remove(enemy);
        assert(enemy.removed && enemy.poolSlot === null && slot.owner === null && !slot.inUse,
          `${type} release must invalidate the old owner before reuse`);
        const replacement = spawnFixtureEnemy(type, anchor, 'balcony');
        assert(replacement.poolSlot === slot && replacement.mesh === root, `${type} must reuse the released rig`);
        assertNeutralRig(replacement);
        assert(replacement.alive && !replacement.removed && !replacement.hasDroppedWeapon
          && replacement.windupRemaining < 0 && replacement.attackCount === 0,
        `${type} recycled actor must not inherit death, drop or attack state`);
        assert(!replacement.weaponMesh || replacement.weaponMesh.visible, `${type} recycled weapon must be visible again`);
        const afterObjects = [], afterResources = [];
        root.traverse(object => {
          afterObjects.push(object.uuid);
          if (object.isMesh) afterResources.push([object.geometry.uuid, object.material.uuid]);
        });
        same(afterObjects, objects, `${type} reuse preserves all rig object identities`);
        same(afterResources, resources, `${type} reuse preserves all rig mesh resources`);
        Enemies.remove(replacement);
      }
      return 'Actual brawler/thug death → release → same-slot respawn restores anatomy, attack state and weapon visibility without allocating replacement rigs; fixture damage earns no player credit';
    }],
    ['Balcony corpses settle above the floor and inside the gallery', () => {
      checkpointAt('balcony');
      const { wrap, floorY } = BALCONY;
      const before = CombatStats.snapshot().kills;
      for (const fixture of [
        { type: 'thug', x: -18.25, z: 0.56, yaw: -Math.PI / 2 },
        { type: 'brawler', x: 12.25, z: 1.30, yaw: Math.PI / 2 },
      ]) {
        Enemies.clearAll();
        const enemy = spawnFixtureEnemy(fixture.type, { x: fixture.x, y: floorY + 0.02, z: fixture.z }, 'balcony');
        enemy.yaw = fixture.yaw; enemy.mesh.rotation.y = fixture.yaw;
        updateHumanoidPose(enemy.mesh, { mode: fixture.type === 'thug' ? 'bat' : 'fist', alert: 1, swingProgress: 0.3 }, 0.1);
        assert(killEnemy(enemy), 'The collapse fixture requires a real death transition');
        for (let tick = 0; tick < 90; tick++) enemiesUpdate(STEP);
        const bounds = getHumanoidVisualBounds(enemy.mesh, new Box3());
        assert(bounds.min.y >= floorY - 0.001 && bounds.min.y <= floorY + 0.012,
          `${fixture.type} skin is ${((bounds.min.y - floorY) * 1000).toFixed(1)} mm above the floor; expected −1 to 12 mm (collapse support ${enemy.floorY.toFixed(3)} m)`);
        assert(bounds.max.y < floorY + 0.85, `${fixture.type} remains in an upright attack pose after dying`);
        assert(bounds.min.x >= wrap.x1 + 0.09 - 0.005 && bounds.max.x <= wrap.x2 - 0.09 + 0.005
          && bounds.min.z >= wrap.z1 + 0.10 - 0.005 && bounds.max.z <= wrap.z2 - 0.09 + 0.005,
        `${fixture.type} corpse crosses the wall or visible end/outer screen`);
      }
      near(CombatStats.snapshot().kills, before, 'Fixture deaths never count as player kills');
      return 'Real thug/brawler death ticks relax attack poses; actual deformed skin vertices settle within 12 mm of the floor and inside both end caps. Hidden proxies are excluded; no ragdoll simulation or player kill credit';
    }],
    ['Actual balcony fists, dropped bat pickup and bat contact', () => {
      controlledArea('balcony');
      placeOnClearFloor({ x: 7, y: BALCONY.floorY, z: BALCONY.laneZ });
      Weapons.restore({ current: 'fists', loaded: 0, reserve: 0 });
      const before = CombatStats.snapshot();
      const thug = spawnFixtureEnemy('thug', { x: 5.8, y: BALCONY.floorY, z: BALCONY.laneZ }, 'balcony');
      startSimulation();
      const strike = enemy => strikeBodyThroughInput(enemy, () => assertBalconyActors('Actual melee exchange'));
      const fistStrikes = Math.ceil(thug.health / WEAPON_DEFS.fists.dmg);
      for (let index = 0; index < fistStrikes; index++) strike(thug);
      assert(!thug.alive, 'Actual fist contacts must defeat the bat carrier');
      const drop = WeaponDrops.list.find(entry => entry.weaponType === 'bat');
      assert(drop && Weapons.findNearestPickup() === drop, 'The real thug death must leave its reachable bat drop');
      assert(Input.keyDown('KeyE'), 'Bat pickup must use the real interaction input');
      simulateFor(1 / 60, () => assertBalconyActors('Bat pickup'));
      Input.keyUp('KeyE');
      assert(Weapons.current === 'bat' && !WeaponDrops.list.includes(drop), 'Interaction must consume the drop and equip its bat');
      const brawler = spawnFixtureEnemy('brawler', { x: 5.8, y: BALCONY.floorY, z: BALCONY.laneZ }, 'balcony');
      const batDrops = WeaponDrops.list.length;
      strike(brawler);
      assert(!brawler.alive, 'One actual bat body contact must defeat the unarmed brawler');
      near(WeaponDrops.list.length, batDrops, 'An unarmed brawler must not invent a weapon drop');
      near(CombatStats.snapshot().kills - before.kills, 2, 'Only the two actual melee kills earn player credit');
      near(CombatStats.snapshot().shots - before.shots, 0, 'A melee exchange must not fabricate fired rounds');
      assert(Player.health > 0 && !PlayerState.dead, 'This bounded melee exchange must remain survivable without health injection');
      return `${fistStrikes} actual fist body hits → real thug bat drop → E pickup → one actual bat body hit; two earned kills, no fixture-applied damage or health refill`;
    }],
    ['Balcony encounters retain three front pairs and two finite rear contacts', () => {
      checkpointAt('balcony');
      triggersUpdate();
      const config = ZONE_WAVE_CONFIG.balcony;
      const before = CombatStats.snapshot();
      const observer = observeArrivals('balcony');
      let fixtureDamage = 0, clearedContacts = 0;
      startSimulation();
      function advance(seconds) {
        for (let tick = 0; tick < Math.ceil(seconds / STEP); tick++) simulateStep(observer.capture);
      }
      function checkGroup(index) {
        simulateUntil(() => getMissionState().wave.pending === 0
          && Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === index).length === config.waves[index].length,
        config.rearPressure.fallbackAfter + 0.75, 'Every safe authored slot must arrive within its bounded fallback window', observer.capture);
        const state = getMissionState();
        const alive = Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === index);
        same(state.zone, 'balcony', 'The wrap lane must not trigger the scaffolding or street');
        same(state.wave.stage, config.stages[index].id, 'The real director exposes its current spatial stage');
        near(state.wave.index, index + 1, 'Each real stage increments the wave index once');
        same(alive.map(enemy => enemy.authoredType).sort(), [...config.waves[index]].sort(),
          'Rear adaptation must retain every original identity in the finite group');
        same(alive.map(enemy => enemy.encounterEntry).sort(), config.waves[index].map((_, entry) => entry),
          'A group cannot duplicate or exchange its authored slots');
        assert(alive.filter(enemy => enemy.arrivalRole === 'front').length === 2 && state.wave.pending === 0,
          'Every group retains two front contacts and finds actual supported positions for its rear reserve');
        assertBalconyActors('Authored stage');
        for (const enemy of alive) assert(observer.arrivals.get(enemy)?.distance >= 5 - 1e-5,
          'Every contact must start safely separated, before ordinary AI approaches the player');
      }
      function clearContacts(contacts = Enemies.list.filter(enemy => enemy.alive)) {
        for (const enemy of contacts) {
          const result = damageEnemy(enemy, enemy.health, 'body');
          assert(result?.killed, 'Progression fixture clears only real contacts through their damage path');
          fixtureDamage += result.damage; clearedContacts++;
        }
        advance(1 / 60);
      }
      advance(config.firstWave + 0.04);
      checkGroup(0);
      assert(Enemies.list.filter(enemy => enemy.alive).every(enemy => enemy.arrivalRole === 'front'),
        'The opening must expose two front contacts without a rear substitution');
      clearContacts();
      advance(config.waveInterval + 0.2);
      assert(getMissionState().wave.index === 1 && Enemies.list.every(enemy => !enemy.alive),
        'Waiting on cleared east ground must not summon the next pair behind the route gate');
      placeOnClearFloor({ x: 4, y: BALCONY.floorY, z: BALCONY.laneZ, yaw: Math.PI / 2 });
      advance(1 / 60);
      checkGroup(1);
      const forwardProgress = getMissionState().wave.routeProgress;
      placeOnClearFloor({ x: 5, y: BALCONY.floorY, z: BALCONY.laneZ });
      advance(1 / 60);
      near(getMissionState().wave.routeProgress, forwardProgress, 'Backing up must not reset completed route progress');
      const middleRear = Enemies.list.find(enemy => enemy.alive && enemy.encounterWave === 1 && enemy.arrivalRole === 'rear');
      assert(middleRear, 'The middle group must acquire its separate rear reserve');
      // This disclosed health fixture detects an undeserved recovery reward.
      // All arrivals and attacks still use the normal director and simulation.
      Player.health = 67; HUD.setHealth(67);
      clearContacts(Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === 1 && enemy.arrivalRole === 'front'));
      near(Player.health, 67, 'Defeating only the front pair must not award full-group recovery');
      placeOnClearFloor({ x: -4, y: BALCONY.floorY, z: BALCONY.laneZ });
      advance(0.5);
      near(getMissionState().wave.index, 2, 'The final pair must respect the recovery interval at its entry gate');
      placeOnClearFloor({ x: -6, y: BALCONY.floorY, z: BALCONY.laneZ });
      advance(config.minRecovery - 0.65);
      near(getMissionState().wave.index, 2, 'Pushing forward cannot bypass the guaranteed minimum recovery');
      advance(0.3);
      simulateUntil(() => Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === 2 && enemy.arrivalRole === 'front').length === 2,
        0.75, 'The next front pair must not wait forever for an older rear contact', observer.capture);
      const retained = getMissionState().wave;
      assert(middleRear.alive && middleRear.poolSlot?.owner === middleRear && Enemies.list.includes(middleRear),
        'The old rear contact must remain a real living actor with its original pool ownership');
      assert(retained.spawned === 7 && retained.alive === 3 && retained.pending === 1 && retained.remaining === 4
        && retained.clearedWaves === 1 && retained.skipped === 0,
      'The old rear occupies capacity while two new fronts arrive; the final rear remains pending without reward or retirement');
      same(retained.pendingTypes, [config.waves[2][2]], 'The pending final rear retains its authored type');
      near(Player.health, 67, 'Advancing while an old rear survives cannot grant a recovery heal');
      clearContacts([middleRear]);
      checkGroup(2);
      near(getMissionState().wave.clearedWaves, 2, 'The second group completes only after its actual rear dies');
      clearContacts();
      assert(getMissionState().wave.cleared && !getMissionState().wave.active, 'Clearing all eight contacts must complete the encounter');
      advance(config.waveInterval + 1);
      assert(getMissionState().wave.index === 3 && Enemies.list.every(enemy => !enemy.alive),
        'The completed balcony encounter must not repeat or escalate endlessly');
      assertNoPlayerCombatCredit(before);
      near(observer.arrivals.size, 8, 'Three front pairs plus two rear reserves consume exactly eight contacts');
      near(config.totalContacts, 8, 'The authored balcony budget remains eight');
      return `Three visible front pairs commit atomically; two separate rear contacts preserve the eight-slot budget and three-actor cap. The old rear survives the next front pair and blocks a second rear. Disclosed 67 HP fixture proves no early healing; ${clearedContacts} actual contacts cleared with ${fixtureDamage} fixture-applied damage, zero fabricated player kills`;
    }],
    ['Balcony rear arrivals adapt loadouts without expanding the finite roster', () => {
      const variants = [
        { current: 'fists', loaded: 0, reserve: 0, rearType: 'brawler' },
        { current: 'bat', loaded: 0, reserve: 0, rearType: 'brawler' },
        { current: 'pistol', loaded: 0, reserve: 0, rearType: 'brawler' },
        { current: 'pistol', loaded: 1, reserve: 0, rearType: 'thug' },
      ];
      let fixtureDamage = 0;
      for (const { rearType, ...weapon } of variants) {
        freshApartment(); checkpointAt('balcony'); Weapons.restore(weapon);
        triggersUpdate();
        const observer = observeArrivals('balcony'), credit = CombatStats.snapshot(), caches = AmmoSupplies.snapshot();
        const config = ZONE_WAVE_CONFIG.balcony;
        startSimulation();
        simulateUntil(() => observer.arrivals.size === 2, config.firstWave + 0.2,
          'The opening must expose its complete front pair before a later rear fixture begins', observer.capture);
        for (const enemy of observer.arrivals.keys()) {
          assert(enemy.arrivalRole === 'front' && enemy.encounterWave === 0, 'The opening cannot convert its second front slot to a rear');
          const result = damageEnemy(enemy, enemy.health, 'body');
          assert(result?.killed, 'The disclosed progression fixture clears the actual opening'); fixtureDamage += result.damage;
        }
        simulateStep(observer.capture);
        placeOnClearFloor({ x: 4, y: BALCONY.floorY, z: BALCONY.laneZ, yaw: Math.PI / 2 });
        simulateUntil(() => [...observer.arrivals.keys()].some(enemy => enemy.encounterWave === 1 && enemy.arrivalRole === 'rear'),
          config.minRecovery + 0.75, 'The middle group must acquire its separate protected rear slot', observer.capture);
        const group = [...observer.arrivals.keys()].filter(enemy => enemy.encounterWave === 1);
        const rear = group.find(enemy => enemy.arrivalRole === 'rear');
        assert(rear?.arrivalSide === 'rear' && rear.type === rearType, 'The designated rear slot must respect the actual equipped inventory');
        same(group.map(enemy => enemy.encounterEntry).sort(), [0, 1, 2], 'The middle rear supplements both promised front contacts');
        same(rear.encounterEntry, 2, 'Only the explicitly authored third slot owns this rear arrival');
        const born = observer.arrivals.get(rear).time;
        let protectedFrames = 0;
        simulateUntil(() => GameTime.elapsed - born >= 0.9, 1.1, 'The protected rear contact must run through actual AI time', () => {
          protectedFrames++;
          observer.capture(); assertBalconyActors('Rear arrival grace');
          assert(rear.spawnGrace > 0 && rear.windupRemaining < 0 && rear.burstLeft === 0,
            'A newly arrived rear contact cannot begin an attack during its one-second grace');
          near(Player.health, 100, 'The bounded arrival fixture cannot inflict immediate spawn damage');
        });
        assert(protectedFrames >= 107, 'The grace test must observe real protected frames starting at the rear birth, not pass after waiting elsewhere');
        same(Weapons.snapshot(), weapon, 'Arrival balancing cannot alter the player weapon or ammunition');
        same(AmmoSupplies.snapshot(), caches, 'Rear balancing cannot consume or refill a supply ledger');
        for (const enemy of group) {
          const result = damageEnemy(enemy, enemy.health, 'body');
          assert(result?.killed, 'The finite-roster cleanup uses the actual death path'); fixtureDamage += result.damage;
        }
        simulateStep(observer.capture);
        const wave = getMissionState().wave;
        assert(wave.totalContacts === 8 && wave.spawned === 5 && wave.remaining === 3 && wave.pending === 0
          && wave.clearedWaves === 2 && !wave.cleared,
        'Clearing the opening pair and middle trio must leave exactly the three unstarted final contacts');
        assertNoPlayerCombatCredit(credit);
      }
      return `Four real director fixtures preserve both front actors: fists, bat and empty pistol add a rear brawler; a loaded pistol adds a bat carrier. Actual AI respects observed arrival grace, supported lanes and the eight-contact budget. ${fixtureDamage} explicitly fixture-applied cleanup damage; no player kill credit, ammunition change or health refill`;
    }],
    ['Fixed encounter seeds vary safe balcony arrivals without expanding the roster', () => {
      const seeds = [0, 0x71e6b20d, 0xdeadbeef, 0], fingerprints = new Map();
      let appliedDamage = 0;
      for (const seed of seeds) {
        const previous = EncounterSeeds.setOverride(seed);
        try {
          freshApartment(); checkpointAt('balcony'); triggersUpdate();
          const config = ZONE_WAVE_CONFIG.balcony, schedule = WaveDirector.schedule;
          const plan = schedule.variation, observer = observeArrivals('balcony');
          const credit = CombatStats.snapshot(), inventory = Weapons.snapshot(), supplies = AmmoSupplies.snapshot();
          assert(plan.enabled && plan.seed === seed && Object.isFrozen(plan), 'Each controlled seed creates one immutable randomized plan');
          assert(plan.firstDelay >= config.firstWave * 0.82 && plan.firstDelay <= config.firstWave,
            'Opening variation cannot delay the immediate two-contact balcony presentation');
          near(schedule.timerDuration, plan.firstDelay, 'The opening timer uses its sampled plan');
          for (const delay of plan.recoveryDelays) assert(delay >= config.waveInterval * 0.82
            && delay <= config.waveInterval * 1.18 && delay >= config.minRecovery,
          'Randomized full recovery remains bounded and cannot shorten the guaranteed minimum');
          const started = GameTime.elapsed;
          startSimulation();
          for (let wave = 0; wave < config.waveCount; wave++) {
            if (wave) placeOnClearFloor({ x: wave === 1 ? 4 : -6, y: BALCONY.floorY, z: BALCONY.laneZ, yaw: Math.PI / 2 });
            simulateUntil(() => Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === wave).length === config.waves[wave].length
              && getMissionState().wave.pending === 0,
            (wave ? plan.recoveryDelays[wave] : plan.firstDelay) + config.rearPressure.fallbackAfter + 0.75,
            'The fixed plan must acquire every finite contact through actual safe placement', observer.capture);
            const group = Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === wave);
            same(group.map(enemy => enemy.authoredType), [...config.waves[wave]], 'Variation cannot rewrite the authored composition');
            assert(group.filter(enemy => enemy.arrivalRole === 'front').length === 2,
              'Randomized groups retain both simultaneous front actors');
            if (wave === 0) for (const enemy of group) {
              const born = observer.arrivals.get(enemy).time - started;
              assert(born >= plan.firstDelay - 1e-6 && born <= plan.firstDelay + STEP + 1e-6,
                'The real opening occurs at the first accepted step crossing its sampled delay');
            }
            for (const enemy of group) {
              const result = damageEnemy(enemy, enemy.health, 'body');
              assert(result?.killed, 'Disclosed seeded progression clears only actual spawned contacts');
              appliedDamage += result.damage;
            }
            simulateStep(observer.capture);
            if (wave < config.waveCount - 1) {
              near(schedule.recoveryDelay, plan.recoveryDelays[wave + 1], 'The next full recovery uses the same precomputed plan');
              const timer = schedule.timer;
              pauseSilently(); near(api.stepFrame(10), 0, 'Pause cannot spend a sampled encounter timer');
              near(schedule.timer, timer, 'The sampled recovery freezes while paused');
              assert(schedule.variation === plan, 'Updates and pause cannot reroll a pending plan');
              startSimulation();
            }
          }
          const state = getMissionState().wave, entries = [...observer.arrivals.entries()];
          assert(state.cleared && state.spawned === 8 && state.remaining === 0 && state.skipped === 0
            && entries.filter(([, value]) => value.role === 'front').length === 6
            && entries.filter(([, value]) => value.role === 'rear').length === 2,
          'Every randomized attempt finishes exactly six front and two rear contacts without retirement');
          const fingerprint = JSON.stringify({ firstDelay: plan.firstDelay, recoveryDelays: plan.recoveryDelays,
            arrivals: entries.map(([enemy, value]) => ({
            wave: enemy.encounterWave, entry: enemy.encounterEntry, role: value.role, type: value.type,
            position: value.position.toArray(), time: value.time - started,
          })) });
          if (fingerprints.has(seed)) same(fingerprint, fingerprints.get(seed), 'A fixed seed reproduces exact birth positions and simulation timing');
          else fingerprints.set(seed, fingerprint);
          same(Weapons.snapshot(), inventory, 'Seed variation cannot grant or consume ammunition');
          same(AmmoSupplies.snapshot(), supplies, 'Seed variation cannot change supply ledgers');
          assertNoPlayerCombatCredit(credit);
        } catch (error) {
          throw new Error(`Seed ${seed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        } finally { EncounterSeeds.setOverride(previous); }
      }
      assert(new Set(fingerprints.values()).size === 3, 'Distinct selected seeds must actually vary this encounter');
      return `Seeds 0, 0x71e6b20d and 0xdeadbeef plus an exact seed-0 replay each finish eight safe contacts, with atomic visible front pairs, protected rear arrivals and frozen pause timers. ${appliedDamage} explicitly fixture-applied damage; no player kill credit or ammunition changes; prior seed mode restored`;
    }],
    ['A stair rear contact climbs the real flight before attacking', () => {
      checkpointAt('stairwell');
      const flight = STAIRS.flights[0];
      placeOnClearFloor({ x: flight.x, y: flight.toY, z: STAIRS.turns.southZ, yaw: Math.PI });
      triggersUpdate();
      const observer = observeArrivals('stairwell'), credit = CombatStats.snapshot();
      const weapon = Weapons.snapshot(), caches = AmmoSupplies.snapshot();
      startSimulation();
      simulateUntil(() => observer.arrivals.size === 1, ZONE_WAVE_CONFIG.stairwell.firstWave + 0.2,
        'The first stair stage must create its safe lower-landing rear contact', observer.capture);
      const enemy = [...observer.arrivals.keys()][0], arrival = observer.arrivals.get(enemy);
      assert(enemy.arrivalRole === 'rear' && enemy.arrivalSide === 'rear' && enemy.type === 'brawler',
        'The lower contact must be the designated weak rear arrival');
      near(arrival.position.y, flight.fromY + 0.03, 'The pursuer starts on the real lower landing');
      const beforeHealth = Player.health, previous = enemy.pos.clone();
      let moved = 0;
      simulateUntil(() => Player.health < beforeHealth, 7, 'The rear pursuer must climb into a real melee contact', () => {
        observer.capture();
        const travel = Math.hypot(enemy.pos.x - previous.x, enemy.pos.z - previous.z);
        assert(travel <= 0.2 && enemy.pos.y - previous.y <= 0.321, 'A rear pursuer must walk and step, not teleport between landings');
        assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 0.003),
          'The pursuing body must remain clear of the actual stairs and overhead flights');
        moved += travel; previous.copy(enemy.pos);
        if (GameTime.elapsed - arrival.time < 0.99) near(Player.health, beforeHealth, 'Rear attack grace cannot be spent while pending');
      });
      near(enemy.pos.y, flight.toY, 'The actual attacker has climbed to the player landing', 0.06);
      assert(moved > Math.abs(flight.zEnd - flight.zStart), 'The pursuer must cover the actual flight before contact');
      near(beforeHealth - Player.health, enemy.def.damage, 'One real rear fist contact supplies the damage event');
      assertOffscreenAlert('hit');
      const wave = getMissionState().wave;
      assert(wave.totalContacts === 8 && wave.spawned === 1 && wave.pending === 1 && wave.remaining === 8 && wave.skipped === 0,
        'The too-close forward slot stays pending; the rear arrival does not add or silently retire contacts');
      same(Weapons.snapshot(), weapon, 'Stair pursuit does not change player inventory');
      same(AmmoSupplies.snapshot(), caches, 'Stair pursuit preserves all supply budgets');
      assertNoPlayerCombatCredit(credit);
      assert(restartFromZone(), 'The actual checkpoint retry must clear the pursuit');
      assert(enemy.removed && enemy.poolSlot === null && Enemies.list.length === 0, 'Retry releases the real rear actor and its pool ownership');
      assertOffscreenAlert();
      return `One actual director-created rear brawler walks the ${STAIRS.stepsPerFlight}-riser flight and lands one real fist hit after grace; the visible HUD reports HIT FROM BEHIND. Eight-contact budget and pending front slot remain intact, then real retry clears actor and alert. No injected damage, AI target refresh, health refill or enemy reposition`;
    }],
    ['Offscreen attack feedback follows real windups, hits, pause and cancellation', () => {
      controlledStreet();
      placeOnClearFloor({ ...DISTRICT.street.checkpoint, yaw: 0 });
      const enemy = spawnFixtureEnemy('brawler', DISTRICT.street.qa.firstGun);
      const credit = CombatStats.snapshot(), weapon = Weapons.snapshot(), caches = AmmoSupplies.snapshot();
      assertOffscreenAlert(); startSimulation();
      simulateUntil(() => enemy.windupRemaining >= 0, 1, 'The real rear fist AI must enter a telegraphed attack');
      assertOffscreenAlert('windup');
      pauseSilently();
      const frozen = { time: GameTime.elapsed, windup: enemy.windupRemaining, health: Player.health,
        position: enemy.pos.toArray(), alert: readOffscreenAlert() };
      for (let frame = 0; frame < 120; frame++) { near(api.stepFrame(1 / 60), 0, 'Paused threat frames cannot advance combat'); assertSilent(); }
      same({ time: GameTime.elapsed, windup: enemy.windupRemaining, health: Player.health,
        position: enemy.pos.toArray(), alert: readOffscreenAlert() }, frozen, 'Pause freezes the pending attack and its existing warning');
      startSimulation();
      simulateUntil(() => Player.health < frozen.health, 1, 'Resuming must allow the remaining actual windup to reach contact');
      near(frozen.health - Player.health, enemy.def.damage, 'The hit warning must follow one actual NPC contact');
      assertOffscreenAlert('hit');
      aimAtBody(enemy); simulateStep(); assertOffscreenAlert();
      Player.yaw = 0; Player.pitch = 0; simulateStep(); assertOffscreenAlert();
      simulateUntil(() => enemy.windupRemaining >= 0, 1.2, 'A new real attack must re-arm the rear warning');
      assertOffscreenAlert('windup');
      const health = Player.health, result = damageEnemy(enemy, 1, 'body');
      assert(result?.damage === 1 && !result.killed && enemy.staggerTime > 0 && enemy.windupRemaining < 0,
        'One disclosed fixture damage point must cancel the pending attack through the actual stagger path');
      simulateStep(); assertOffscreenAlert();
      simulateFor(enemy.def.swingTime * 0.5 + 0.05);
      near(Player.health, health, 'A staggered old windup cannot land late damage');
      simulateUntil(() => enemy.windupRemaining >= 0, 1.2, 'Recovery must permit a later ordinary attack');
      assertOffscreenAlert('windup');
      Enemies.clearAll(); simulateStep(); assertOffscreenAlert();
      assert(enemy.removed && enemy.poolSlot === null, 'Clearing the source invalidates its real enemy ownership');
      same(Weapons.snapshot(), weapon, 'The alert fixture leaves the player weapon and ammunition unchanged');
      same(AmmoSupplies.snapshot(), caches, 'The alert fixture leaves supply state unchanged');
      assertNoPlayerCombatCredit(credit);
      return 'Actual rear AI drives accessible ATTACK/HIT FROM BEHIND text and arrow. Pause freezes it; seeing the attacker acknowledges the hit without resurrection, stagger cancels windup, and removing the actor clears feedback. Exactly one NPC fist hit and one explicitly fixture-applied damage point; no fabricated player credit';
    }],
    ['All four stair flights and roof doorway', () => {
      const body = makeBody(...STAIRS.route[0]);
      const roof = CHECKPOINTS.roof;
      walkRoute(body, [...STAIRS.route.slice(1), STAIRS.roofExit, [roof.x, roof.y, roof.z]], 'Stairwell');
      return `${STAIRS.flights.length} authored flights of ${STAIRS.stepsPerFlight} treads; every turning platform and the supported roof threshold remain traversable`;
    }],
    ['The stair-to-roof floor has no overlapping visible top faces', () => {
      const opening = STAIRS.roofDoor;
      const region = { x1: STAIRS.interior.x2 - 0.25, x2: ROOF.x1 + 0.25,
        z1: opening.min[2] + 0.05, z2: opening.max[2] - 0.05 };
      const faces = visibleFloorFaces(region, STAIRS.exitY);
      assert(faces.length >= 3, 'The surface audit must include actual landing, threshold and rooftop triangles');
      const expectedArea = (region.x2 - region.x1) * (region.z2 - region.z1);
      let area = 0;
      for (let first = 0; first < faces.length; first++) {
        area += Math.abs(polygonAreaXZ(faces[first].polygon));
        for (let second = first + 1; second < faces.length; second++) {
          const overlap = Math.abs(polygonAreaXZ(clipFloorPolygon(faces[first].polygon, faces[second].polygon)));
          assert(overlap <= 1e-6,
            `${faces[first].id} overlaps ${faces[second].id} by ${(overlap * 10_000).toFixed(2)} cm² at roof-floor height`);
        }
      }
      near(area, expectedArea, 'The nonoverlapping visible faces still cover the complete doorway floor', 1e-5);
      return `${faces.length} actual upward-facing triangles cover ${area.toFixed(3)} m² of the threshold continuously, with no duplicate coplanar surface; this checks geometry, not a perceived-flicker rating`;
    }],
    ['A real stair-to-roof crossing keeps the body and rendered camera stable', () => {
      controlledArea('stairwell');
      const z = (STAIRS.roofDoor.min[2] + STAIRS.roofDoor.max[2]) / 2;
      const insideX = STAIRS.lanes.east, outsideX = STAIRS.roofExit[0];
      placeOnClearFloor({ x: insideX, y: STAIRS.exitY, z, yaw: -Math.PI / 2 });
      startSimulation();
      simulateFor(0.15);
      assert(Player.onGround, 'The transition fixture must settle on the real upper landing before walking');
      const zones = [getMissionState().zone];
      let frames = 0, maximumCameraDelta = 0, previousCameraY = camera.position.y;
      let previousStepOffset = Player._stepOffset, presentation = null;
      function observe() {
        const foot = new Vector3(Player.pos.x, Player.pos.y - Player._eyeH, Player.pos.z);
        near(foot.y, STAIRS.exitY, 'Crossing a flush threshold cannot change the supporting floor', 1e-5);
        near(foot.z, z, 'The actual forward input must stay inside the doorway lane', 0.003);
        assert(Player.onGround && Player.vel.y <= 1e-6,
          `The flush seam cannot launch or unground the player: feet=${foot.toArray()}, vy=${Player.vel.y}, grounded=${Player.onGround}`);
        assert(capsuleHasClearance(foot, Player.radius, Player.bodyHeight, Colliders.list, 0.003),
          'The crossing body must stay clear of the actual jamb, lintel and slabs');
        assert(Player._stepOffset <= previousStepOffset * Math.exp(-18 / 60) + 1e-5,
          'A level joint cannot add a fictitious riser to the camera smoothing');
        previousStepOffset = Player._stepOffset;
        near(camera.position.y, Player.pos.y + Player._bobOffset - Player._stepOffset,
          'The camera retains its actual walking-bob and riser-smoothing formula', 1e-6);
        assert(Math.abs(Player._bobOffset) <= 0.011, 'Intentional walking bob stays within its authored one-centimetre envelope');
        maximumCameraDelta = Math.max(maximumCameraDelta, Math.abs(camera.position.y - previousCameraY));
        previousCameraY = camera.position.y;
        api.render();
        assert(!renderer.getContext().isContextLost(), 'The real renderer must retain its graphics context during the transition');
        assert([...camera.position.toArray(), ...camera.quaternion.toArray(), ...camera.matrixWorld.elements,
          ...camera.projectionMatrix.elements].every(Number.isFinite), 'The rendered transition camera must have finite transforms');
        const metrics = api.metrics?.().presentation;
        if (metrics) {
          const current = { enabled: metrics.enabled, reason: metrics.reason, quality: metrics.quality,
            size: metrics.size, aoSize: metrics.aoSize, aoSamples: metrics.aoSamples, pixelRatio: renderer.getPixelRatio() };
          if (presentation) same(current, presentation, 'The controlled doorway crossing cannot flap between presentation configurations');
          else presentation = current;
        }
        for (const record of Architecture.elements.values()) assert(record.mesh.visible,
          `${record.id} must not disappear when the roof trigger fires`);
        const zone = getMissionState().zone;
        if (zones[zones.length - 1] !== zone) zones.push(zone);
        assert(Enemies.list.length === 0, 'The short traversal fixture must finish before any rooftop contact spawns');
        assertSilent();
        frames++;
      }
      for (const [targetX, direction] of [[outsideX, 1], [insideX, -1]]) {
        Player.yaw = direction > 0 ? -Math.PI / 2 : Math.PI / 2;
        assert(Input.keyDown('KeyW'), 'Each doorway crossing requires real forward input');
        try {
          for (let frame = 0; frame < 100 && direction * (Player.pos.x - targetX) < 0; frame++) simulateFor(1 / 60, observe);
        } finally { Input.keyUp('KeyW'); }
        assert(direction * (Player.pos.x - targetX) >= 0,
          `Actual walking must reach the other side of the threshold; x=${Player.pos.x}, target=${targetX}`);
        simulateFor(0.12, observe);
      }
      same(zones, ['stairwell', 'roof'], 'The actual roof transition fires once, without repeated zone changes on return');
      same(getMissionState().checkpoint.zone, 'roof', 'Crossing the doorway saves the real rooftop checkpoint');
      return `${frames} actual simulation/render frames cross the doorway in both directions; feet stay on the 14 m floor and the roof trigger fires once. Largest observed camera-Y change ${(maximumCameraDelta * 1000).toFixed(2)} mm includes intentional bob; no visual-smoothness or FPS claim`;
    }],
    ['Stair landings give a standing player room to turn', () => {
      const landings = STAIRS.landings.filter(landing => landing.side !== 'entry');
      assert(landings.length === 4, 'Every switchback flight must finish on a real landing');
      for (const landing of landings) {
        assert(landing.z2 - landing.z1 >= 2.7 && landing.x2 - landing.x1 >= 4,
          `${landing.id} must provide a broad turning platform, not a narrow tread`);
        const z1 = landing.z1 + 0.5, z2 = landing.z2 - 0.5;
        // Include actual wall-mounted fittings, not just the masonry face.
        // The landing service box projects 0.24 m, about the same distance as
        // the flight handrail. A capsule needs its radius beyond that face.
        let wallProjection = 0;
        for (const box of Colliders.list) {
          if (box.max.y <= landing.y + 0.03 || box.min.y >= landing.y + Player.bodyHeight
            || box.max.z < z1 - Player.radius || box.min.z > z2 + Player.radius) continue;
          if (box.min.x <= landing.x1 + 0.03 && box.max.x >= landing.x1) {
            wallProjection = Math.max(wallProjection, box.max.x - landing.x1);
          }
          if (box.max.x >= landing.x2 - 0.03 && box.min.x <= landing.x2) {
            wallProjection = Math.max(wallProjection, landing.x2 - box.min.x);
          }
        }
        const margin = Math.ceil((wallProjection + Player.radius + 0.1) * 10) / 10;
        const x1 = landing.x1 + margin, x2 = landing.x2 - margin;
        assert(x2 - x1 >= 4 && x1 < STAIRS.lanes.west && x2 > STAIRS.lanes.east,
          `${landing.id} wall fittings must leave a full turn across both stair lanes`);
        const body = makeBody(x1, landing.y, z1);
        assert(capsuleHasClearance(body.position, body.radius, body.height, Colliders.list, 1e-5),
          `${landing.id} turning loop must start with a clear standing capsule`);
        walkRoute(body, [[x2, landing.y, z1], [x2, landing.y, z2],
          [x1, landing.y, z2], [x1, landing.y, z1]], `${landing.id} turning loop`);
        const clearVolume = new Box3(new Vector3(x1, landing.y + 0.03, z1),
          new Vector3(x2, landing.y + Player.bodyHeight, z2));
        for (const record of Architecture.elements.values()) {
          assert(!clearVolume.intersectsBox(record.bounds),
            `${landing.id} turning space contains visible structural obstruction ${record.id}`);
        }
      }
      return 'Four real 2.8 m landings support complete turning loops; no stair guard, tread, beam or registered brace passes through standing headroom';
    }],
    ['Fast stair ascent retires only unspawned contacts and preserves living pursuers', () => {
      const config = ZONE_WAVE_CONFIG.stairwell;
      assert(config.retireLive === false && config.maxAlive === 2, 'Stairs must preserve living pursuers under the two-actor cap');
      let fixtureDamage = 0, arrivalDamage = 0;
      function waitForStairPair(predicate, seconds, label, afterStep = () => {}) {
        // This stationary wait tests arrival/slot policy, not player survival.
        // Live actors can attack during the several-second safety fallback.
        // Keep that damage real, record it, and isolate it from the separate
        // 63/90-HP assertions around actual bypass movement below.
        const health = Player.health;
        Player.health = 100;
        try {
          simulateUntil(predicate, seconds, label, () => {
            afterStep();
            assert(!PlayerState.dead, 'A protected single stair step must not kill the arrival fixture');
            arrivalDamage += Math.max(0, 100 - Player.health);
            Player.health = 100;
          });
        } finally {
          Player.health = health;
          HUD.setHealth(health);
        }
      }
      function entryPair() {
        checkpointAt('stairwell');
        placeOnClearFloor({ x: STAIRS.lanes.east, y: STAIRS.entryY, z: STAIRS.turns.northZ, yaw: 0 });
        triggersUpdate();
        const observer = observeArrivals('stairwell');
        startSimulation();
        waitForStairPair(() => Enemies.list.filter(enemy => enemy.alive && enemy.zone === 'stairwell').length === 2,
          config.firstWave + config.rearPressure.fallbackAfter + 0.75, 'The complete initial stair pair needs a safe finite fallback', observer.capture);
        const pair = Enemies.list.filter(enemy => enemy.alive && enemy.zone === 'stairwell');
        same(pair.map(enemy => enemy.authoredType).sort(), [...config.waves[0]].sort(), 'The complete lower pair retains its original authored roster');
        assert(pair.every(enemy => enemy.encounterWave === 0), 'Both initial stair contacts belong to the first landing');
        return pair;
      }
      function fixtureDefeat(enemy) {
        const result = damageEnemy(enemy, enemy.health, 'body');
        assert(result?.killed, 'Stair fixture damage must use the actual enemy death path');
        fixtureDamage += result.damage;
      }
      function advanceUpFlight(until, label) {
        Player.yaw = 0; Player.pitch = 0;
        assert(Input.keyDown('KeyW'), `${label} needs real forward input`);
        try {
          for (let frame = 0; frame < 90 && !until(); frame++) {
            simulateFor(1 / 60);
            const foot = new Vector3(Player.pos.x, Player.pos.y - Player._eyeH, Player.pos.z);
            assert(capsuleHasClearance(foot, Player.radius, Player.bodyHeight, Colliders.list, 0.003),
              `${label} must retain a clear real player capsule`);
          }
        } finally { Input.keyUp('KeyW'); }
        const wave = getMissionState().wave;
        const details = JSON.stringify({
          feet: [Player.pos.x, Player.pos.y - Player._eyeH, Player.pos.z].map(value => +value.toFixed(3)),
          velocity: Player.vel.toArray().map(value => +value.toFixed(3)),
          grounded: Player.onGround, inputActive: Input.active,
          wave: { index: wave.index, alive: wave.alive, pending: wave.pending, pendingTypes: wave.pendingTypes,
            skipped: wave.skipped, spawned: wave.spawned, timer: wave.timer, clearedWaves: wave.clearedWaves },
        });
        assert(Player.onGround && until(), `${label} must advance through a real grounded stair step; ${details}`);
      }

      const firstPair = entryPair(), firstCredit = CombatStats.snapshot();
      for (const enemy of firstPair) fixtureDefeat(enemy);
      simulateFor(1 / 60);
      near(getMissionState().wave.clearedWaves, 1, 'Only the actually defeated lower pair receives clear credit');
      // Deliberately fast fixture placements reproduce reaching the next
      // landing before its recovery timer. Physics establishes ground; this
      // is disclosed state setup, not a claim of a recorded player speedrun.
      Player.health = 63; HUD.setHealth(Player.health);
      // Watch the lower landing while holding each impossible forward pair:
      // a safe hidden rear arrival would otherwise legitimately fill a slot.
      placeOnClearFloor({ x: -18, y: STAIRS.landings[2].y, z: -8.55, yaw: Math.PI });
      simulateFor(config.minRecovery + 0.1);
      let wave = getMissionState().wave;
      assert(Player.onGround && wave.index === 2 && wave.alive === 0,
        'Fast arrival must leave the unsafe second landing pair unspawned');
      same(wave.pendingTypes, [...config.waves[1]], 'Both too-close landing contacts remain pending without relaxed spawn safety');
      simulateFor(0.5);
      same(getMissionState().wave.pendingTypes, [...config.waves[1]], 'Waiting briefly cannot bypass the five-metre spawn rule');
      placeOnClearFloor({ x: STAIRS.lanes.west, y: STAIRS.landings[3].y, z: STAIRS.turns.southZ, yaw: 0 });
      simulateFor(0.1);
      wave = getMissionState().wave;
      assert(Player.onGround && wave.index === 3 && wave.skipped === config.waves[1].length,
        'Grounded ascent must retire the impossible pending lower roster and make the next stage available');
      same(wave.pendingTypes, [...config.waves[2]], 'The next landing keeps its own pending roster');
      near(wave.clearedWaves, 1, 'Bypassing pending opponents must not award a cleared wave');
      near(Player.health, 63, 'Bypassing unspawned opponents must not grant recovery health');
      placeOnClearFloor({ x: STAIRS.lanes.east, y: STAIRS.landings[3].y, z: STAIRS.turns.southZ });
      advanceUpFlight(() => getMissionState().wave.index === 4, 'Final-flight commitment');
      // Turn only AFTER the grounded step retires stage three. Looking back
      // sooner would create a legal lower rear contact instead of a bypass.
      Player.yaw = Math.PI;
      assert(Player.health <= 63, 'Fast ascent cannot invent a health reward before the protected arrival wait');
      waitForStairPair(() => getMissionState().wave.pending === 0 && getMissionState().wave.alive === 2,
        config.rearPressure.fallbackAfter + 0.75, 'The final landing must finish its hidden-forward fallback');
      wave = getMissionState().wave;
      assert(wave.index === 4 && wave.pending === 0 && wave.spawned === 4 && wave.skipped === 4,
        'A real upper-flight step must release the final safe pair instead of preserving an impossible pending stage');
      assert(Enemies.list.filter(enemy => enemy.alive).every(enemy => enemy.encounterWave === 3), 'Only the final landing pair may spawn above the bypassed stages');
      near(wave.clearedWaves, 1, 'Only actual defeated contacts earn stage-clear credit');
      assertNoPlayerCombatCredit(firstCredit);

      freshApartment();
      const pursuers = entryPair(), secondCredit = CombatStats.snapshot();
      const owners = pursuers.map(enemy => [enemy, enemy.poolSlot, enemy.health]);
      const dropsBefore = WeaponDrops.list.length;
      Player.health = 90; HUD.setHealth(Player.health);
      // This entry stays away from the authored health pack on the landing.
      placeOnClearFloor({ x: -17.1, y: STAIRS.landings[1].y, z: -2.1 });
      advanceUpFlight(() => getMissionState().wave.index >= 2, 'Passing living pursuers');
      const healthAfterAscent = Player.health;
      simulateFor(0.75);
      wave = getMissionState().wave;
      for (const [enemy, slot, health] of owners) {
        assert(Enemies.list.includes(enemy) && enemy.alive && !enemy.removed && enemy.poolSlot === slot && slot.owner === enemy,
          'A passed living stair contact must retain its object, body and pooled ownership');
        near(enemy.health, health, 'Passing a living contact must not silently damage it');
      }
      assert(wave.spawned === 2 && wave.alive === 2 && wave.pending === 2 && wave.skipped === 0,
        'Living pursuers must continue reserving both global slots while the next pair waits');
      near(wave.clearedWaves, 0, 'Passing living pursuers is not a clear');
      near(WeaponDrops.list.length, dropsBefore, 'A bypass must not produce weapon drops');
      assert(Player.health <= healthAfterAscent && healthAfterAscent <= 90, 'A bypass must not manufacture health recovery');
      fixtureDefeat(pursuers[0]);
      simulateFor(0.75);
      wave = getMissionState().wave;
      assert(pursuers[1].alive && !pursuers[1].removed && wave.alive === 2 && wave.spawned === 3 && wave.pending === 1,
        'One actual death frees exactly one occupied slot without deleting the other pursuer');
      fixtureDefeat(pursuers[1]);
      Player.yaw = Math.PI;
      waitForStairPair(() => getMissionState().wave.alive === 2 && getMissionState().wave.pending === 0,
        config.rearPressure.fallbackAfter + 0.75, 'The remaining stair slot must arrive after its safe fallback wait');
      wave = getMissionState().wave;
      assert(wave.alive === 2 && wave.spawned === 4 && wave.pending === 0 && wave.skipped === 0 && !wave.cleared,
        'The second actual death releases the remaining slot for the next real pair');
      assertNoPlayerCombatCredit(secondCredit);
      return `Disclosed fast placements, deliberate views and real W-input steps retire four unspawned contacts without rewards; hidden-forward fallbacks respect their finite wait, and living pursuers retain identity/cap slots until actual deaths. Fixture applied ${fixtureDamage} damage, zero player kill credit; 63/90-HP bypass checks are separate from stationary arrival waits, which protected health against ${arrivalDamage.toFixed(1)} actual incoming damage`;
    }],
    ['Real NPC movement steps onto the street curb and climbs the first flight', () => {
      let completed = 0;
      const flight = STAIRS.flights[0], sidewalk = DISTRICT.street.farWalk;
      const fixtures = [
        { label: 'Nine-centimetre street curb', zone: 'street',
          start: { x: 10, y: DISTRICT.street.road.floorY, z: sidewalk.z1 - 2 },
          goal: { x: 10, y: sidewalk.floorY, z: sidewalk.z2 - 0.6 },
          arrived: enemy => enemy.pos.z > sidewalk.z1 + enemy.radius + 0.1 },
        { label: 'Fourteen-riser first flight', zone: 'stairwell',
          start: { x: flight.x, y: flight.fromY, z: flight.zStart - 0.4 },
          goal: { x: flight.x, y: flight.toY, z: STAIRS.turns.southZ },
          arrived: enemy => enemy.pos.z > flight.zEnd + enemy.radius + 0.1 },
      ];
      near(sidewalk.floorY - DISTRICT.street.road.floorY, 0.09, 'The actual curb rise remains nine centimetres');
      for (const fixture of fixtures) {
        freshApartment();
        controlledArea(fixture.zone);
        placeOnClearFloor(fixture.goal);
        const enemy = spawnFixtureEnemy('thug', fixture.start, fixture.zone);
        const before = CombatStats.snapshot();
        // A single prior-observation seed is explicit fixture setup; the
        // production sight cache, AI and shared capsule stepper own the rest.
        enemy.lastSeenPlayer = true;
        enemy.lastSeenPosition.copy(Player.pos);
        enemy.lastSeenFootY = fixture.goal.y;
        enemy.timeSinceSeen = 0;
        startSimulation();
        let arrived = false;
        for (let frame = 0; frame < 12 * 60 && !arrived; frame++) {
          simulateFor(1 / 60);
          assert(enemy.alive && !enemy.removed && !PlayerState.dead, `${fixture.label} requires living actors`);
          assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 0.003),
            `${fixture.label} NPC penetrates a riser, wall or overhead flight`);
          near(enemy.mesh.position.distanceTo(enemy.pos), 0, `${fixture.label} visible rig follows its real body`, 1e-5);
          arrived = fixture.arrived(enemy) && enemy.body.onGround && Math.abs(enemy.pos.y - fixture.goal.y) < 0.03;
        }
        assert(arrived, `${fixture.label} NPC remains stuck at ${enemy.pos.toArray().map(value => value.toFixed(2)).join(', ')}`);
        near(enemy.floorY, fixture.goal.y, `${fixture.label} updates its supporting floor`, 0.02);
        near(enemy.pos.y, fixture.goal.y, `${fixture.label} body settles at the new floor`, 0.03);
        near(enemy.lastSeenFootY, fixture.goal.y, `${fixture.label} pursuit retains the actually observed target floor`, 0.03);
        assertRigSegments(enemy.mesh, fixture.label);
        const rig = enemy.mesh.userData.rig;
        const soles = ['L', 'R'].map(side => rig.anchors[`sole${side}`].getWorldPosition(new Vector3()).y);
        near(Math.min(...soles), enemy.pos.y, `${fixture.label} has a planted visible foot`, 0.012);
        assertNoPlayerCombatCredit(before);
        Enemies.remove(enemy);
        completed++;
      }
      return `${completed} actual AI traversals: 0.09 m pavement step and all ${flight.steps} authored risers, with matching collision body, floor and planted rig foot. One prior-observation seed per fixture; no injected NPC movement, repeated memory refresh, damage or healing`;
    }],
    ['A real rooftop NPC detours around the mechanical house', () => {
      controlledArea('roof');
      const house = ROOF.serviceHouse, floorY = ROOF.floorY;
      const z = (house.z1 + house.z2) / 2;
      const goal = { x: house.x2 + 3, y: floorY, z };
      placeOnClearFloor(goal);
      const enemy = spawnFixtureEnemy('thug', { x: house.x1 - 2, y: floorY, z }, 'roof');
      const eye = enemy.pos.clone(); eye.y += enemy.height * 0.9;
      assert(isSegmentOccluded(eye, Player.pos, Colliders.list),
        'The actual mechanical-house walls must block a direct line between the actors');
      const building = Architecture.elements.get('roof-service-house');
      assert(building?.collider && Colliders.isEnabled(building.collider), 'The detour must go around a real visible, colliding building');

      // A previous observation is the one explicit fixture input. The AI owns
      // every subsequent movement and path request. Its remembered goal and
      // memory age are never refreshed by this test after the initial seed.
      enemy.lastSeenPlayer = true;
      enemy.lastSeenPosition.copy(Player.pos);
      enemy.timeSinceSeen = 0;
      const baseline = EnemyNavigation.snapshot(), credit = CombatStats.snapshot();
      const previous = enemy.pos.clone();
      const directDistance = Math.hypot(goal.x - enemy.pos.x, goal.z - enemy.pos.z);
      let travelled = 0, detoured = false, reached = false, reusedFrames = 0, checkedVersion = 0;
      let lastPathUses = baseline.pathUses;
      startSimulation();
      const startedAt = GameTime.elapsed;
      for (let frame = 0; frame < 14 * 60 && !reached; frame++) {
        simulateFor(1 / 60);
        assert(enemy.alive && !enemy.removed && !PlayerState.dead, 'The detour must execute with real living actors');
        near(enemy.pos.y, floorY, 'The detouring NPC remains supported on the rooftop', 0.075);
        assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 0.003),
          `The detouring NPC penetrates actual geometry at ${enemy.pos.toArray().map(value => value.toFixed(2)).join(', ')}`);
        travelled += Math.hypot(enemy.pos.x - previous.x, enemy.pos.z - previous.z);
        previous.copy(enemy.pos);
        if (enemy.pos.x >= house.x1 && enemy.pos.x <= house.x2
          && (enemy.pos.z < house.z1 - enemy.radius || enemy.pos.z > house.z2 + enemy.radius)) detoured = true;
        const stats = EnemyNavigation.snapshot();
        assert(stats.lastSliceExpansions <= stats.expansionsPerSlice && stats.peakSliceExpansions <= stats.expansionsPerSlice,
          'Real NPC path searches must stay inside their shared per-slice work budget');
        if (stats.pathUses > lastPathUses) reusedFrames++;
        lastPathUses = stats.pathUses;
        const navigation = enemy.navigation;
        if (navigation.routeVersion > checkedVersion) {
          assert(navigation.path.length > 0, 'A newly completed NPC route must contain usable waypoints');
          let from = navigation.start;
          for (const waypoint of navigation.path) {
            assert(EnemyNavigation.segmentClear(from, waypoint, enemy.radius, enemy.height),
              'Every cached detour segment must clear the actual building and keep floor support');
            from = waypoint;
          }
          checkedVersion = navigation.routeVersion;
        }
        reached = enemy.pos.x > house.x2 + enemy.radius
          && Math.hypot(enemy.pos.x - goal.x, enemy.pos.z - goal.z) <= enemy.def.attackRange + 0.25
          && !isSegmentOccluded(enemy.pos.clone().add(new Vector3(0, enemy.height * 0.9, 0)), Player.pos, Colliders.list);
      }
      const after = EnemyNavigation.snapshot();
      assert(reached && detoured && travelled > directDistance,
        `The NPC must walk around the house and reacquire its target; stopped at ${enemy.pos.toArray().map(value => value.toFixed(2)).join(', ')} after ${(GameTime.elapsed - startedAt).toFixed(2)} s`);
      assert(after.searches > baseline.searches && after.completed > baseline.completed && checkedVersion > 0,
        'The actual AI must request and complete a real detour search');
      assert(reusedFrames > 1 && after.pathUses > baseline.pathUses,
        'The moving NPC must reuse committed route waypoints across simulation frames');
      assertNoPlayerCombatCredit(credit);
      Enemies.remove(enemy);
      assert(!enemy.navigation.pending && enemy.navigation.path.length === 0,
        'Releasing the fixture actor must cancel its queued navigation and route');
      return `${travelled.toFixed(1)} m walked in ${(GameTime.elapsed - startedAt).toFixed(2)} simulated seconds; ${after.searches - baseline.searches} real searches, ${reusedFrames} frames reusing routes, ≤${after.expansionsPerSlice} expansions per slice. One disclosed prior-observation seed; no injected paths, movement, refreshed memory, damage or healing`;
    }],
    ['Roof sentries unlock finite overlapping reinforcements within capacity', () => {
      checkpointAt('roof');
      placeOnClearFloor({ x: 15, y: ROOF.floorY, z: -7 });
      triggersUpdate();
      const config = ZONE_WAVE_CONFIG.roof, policy = config.reinforcements;
      const total = config.waves.flat().length;
      assert(policy && config.waves[0].length === 2 && config.waveCount >= 4,
        'The roof must author two opening sentries and multiple finite reserve teams');
      const before = CombatStats.snapshot(), observed = new Map(), defeated = new Set();
      let fixtureDamage = 0, healthRestores = 0, maximumAlive = 0;
      function audit() {
        assert(Input.active && !PlayerState.dead, 'Roof schedule fixture must stay alive in the real simulation');
        const state = getMissionState().wave;
        const alive = Enemies.list.filter(enemy => enemy.alive && enemy.zone === 'roof');
        maximumAlive = Math.max(maximumAlive, alive.length);
        near(state.totalContacts, total, 'Roof total contact budget');
        near(state.alive, alive.length, 'Roof live count matches real actors');
        near(state.remaining, alive.length + state.pendingTypes.length + state.unstartedTypes.length,
          'Roof remaining includes deferred and unstarted reserves');
        near(state.remaining + defeated.size, total, 'Roof reserve ownership cannot lose or invent contacts');
        near(state.skipped, 0, 'The rooftop fixture must not abandon contacts as a shortcut');
        assert(alive.length <= config.maxAlive, 'Rooftop reinforcement overlap must respect the actual live cap');
        for (const [type, cap] of Object.entries(config.typeCaps ?? {})) {
          assert(alive.filter(enemy => enemy.type === type).length <= cap, `${type} exceeds its rooftop role cap`);
        }
        for (const enemy of alive) {
          assert(enemy.encounterKey === 'roof' && Number.isInteger(enemy.encounterWave)
            && enemy.encounterWave >= 0 && enemy.encounterWave < config.waveCount,
          'Each rooftop actor must keep its own authored wave identity');
          observed.set(enemy.id, { type: enemy.type, wave: enemy.encounterWave, weapon: enemy.def.weaponType });
          near(enemy.pos.y, ROOF.floorY, 'Every real rooftop reinforcement remains supported', 0.075);
          assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 0.003),
            'A rooftop reinforcement overlaps its service building, cover or edge guard');
        }
        near(state.spawned, observed.size, 'Every reported rooftop spawn must correspond to a real observed actor');
        if (Player.health < 100) { Player.health = 100; HUD.setHealth(100); healthRestores++; }
      }
      function advance(seconds) { simulateFor(seconds, audit); }
      function clearContact(enemy) {
        assert(enemy?.alive && !defeated.has(enemy.id), 'Only a live, previously unprocessed roof contact can be cleared');
        const result = damageEnemy(enemy, enemy.health, 'body');
        assert(result?.killed, 'Roof fixture damage must execute the real death path');
        fixtureDamage += result.damage; defeated.add(enemy.id);
      }
      startSimulation();
      advance(config.firstWave + 0.05);
      const sentries = Enemies.list.filter(enemy => enemy.alive && enemy.zone === 'roof');
      same(sentries.map(enemy => enemy.type).sort(), [...config.waves[0]].sort(), 'The roof starts with exactly its opening pair');
      assert(getMissionState().wave.pending === 0, 'Both opening sentries must find real safe spawn positions');
      advance(policy.firstDelay + policy.interval + 0.15);
      assert(getMissionState().wave.index === 1 && !getMissionState().wave.reinforcementsActive,
        'Elapsed time alone cannot summon reserves while the opening pair remains alive');
      clearContact(sentries[0]);
      advance(policy.firstDelay + 0.1);
      assert(getMissionState().wave.index === 1 && getMissionState().wave.clearedWaves === 0,
        'Defeating just one sentry cannot unlock the reserve teams');
      clearContact(sentries[1]);
      advance(1 / 60);
      assert(getMissionState().wave.reinforcementsActive && getMissionState().wave.clearedWaves === 1,
        'Defeating both sentries must arm the real reinforcement schedule');
      pauseSilently();
      const paused = getMissionState().wave;
      for (let frame = 0; frame < 90; frame++) api.stepFrame(1 / 60);
      same(getMissionState().wave, paused, 'Paused frames cannot consume the rooftop reinforcement delay');
      Input.activate();
      advance(policy.firstDelay - 0.1);
      near(getMissionState().wave.index, 1, 'The response team cannot arrive before its full first delay');
      advance(0.2);
      const response = Enemies.list.filter(enemy => enemy.alive && enemy.encounterWave === 1);
      same(response.map(enemy => enemy.type).sort(), [...config.waves[1]].sort(), 'The complete response team must spawn safely');
      near(getMissionState().wave.index, 2, 'The response team is the second authored group');
      advance(policy.interval + 0.1);
      const overlap = Enemies.list.filter(enemy => enemy.alive && enemy.zone === 'roof');
      assert(response.every(enemy => enemy.alive) && overlap.some(enemy => enemy.encounterWave === 2),
        'Actual new reserves must join while the earlier response team remains alive');
      near(overlap.length, config.maxAlive, 'Real overlapping reinforcements fill but do not exceed the global cap');
      const blocked = getMissionState().wave;
      assert(blocked.pendingTypes.length > 0 && blocked.unstartedTypes.length > 0,
        'A full rooftop must preserve both deferred and unstarted reserve contacts');
      advance(policy.interval + 0.1);
      const retained = getMissionState().wave;
      same(retained.pendingTypes, blocked.pendingTypes, 'A full live pool must not consume the deferred reserve roster');
      same(retained.unstartedTypes, blocked.unstartedTypes, 'Deferred reserves cannot discard the final unstarted team');
      assert(!retained.cleared, 'Living and deferred roof reserves cannot produce a clear result');

      for (let tick = 0; tick < 60 * 30 && !getMissionState().wave.cleared; tick++) {
        for (const enemy of Enemies.list) if (enemy.alive && enemy.zone === 'roof') clearContact(enemy);
        advance(1 / 60);
      }
      const final = getMissionState().wave;
      assert(final.cleared && !final.active, 'Every finite rooftop team must eventually resolve after genuine spawn/death paths');
      near(final.spawned, total, 'All authored rooftop contacts must have spawned');
      near(defeated.size, total, 'Every spawned rooftop contact must be accounted for');
      near(final.remaining, 0, 'No rooftop opponent remains deferred after completion');
      for (let index = 0; index < config.waveCount; index++) {
        const actual = [...observed.values()].filter(entry => entry.wave === index).map(entry => entry.type).sort();
        same(actual, [...config.waves[index]].sort(), `Actual rooftop wave ${index + 1} composition`);
      }
      const weaponMix = [...new Set([...observed.values()].map(entry => entry.weapon))].sort();
      same(weaponMix, [...new Set(config.waves.flat().map(type => ENEMY_TYPES[type].weaponType))].sort(), 'Actual rooftop weapon mix');
      advance(policy.interval + 1);
      near(getMissionState().wave.spawned, total, 'A completed rooftop encounter cannot restart or escalate indefinitely');
      assertNoPlayerCombatCredit(before);
      return `${total} actual contacts across ${config.waveCount} groups and ${weaponMix.length} weapon roles; opening pair, pause and arrival delays verified; peak ${maximumAlive}/${config.maxAlive} live. Fixture applied ${fixtureDamage} damage and refreshed health ${healthRestores} times, with zero fabricated player kills`;
    }],
    ['Roof and scaffold descent to street', () => {
      const body = makeBody(...ROOF.route[0]);
      const street = CHECKPOINTS.street;
      walkRoute(body, ROOF.route.slice(1), 'Expanded rooftop route');
      walkRoute(body, [
        [22, 10, 2.4], [15.2, 10, 3.2], [9.5, 7, 3.2],
        [21.8, 7, 4.2], [25, 4, 4.2], [18, 4, 4.5],
        [13, 1.5, 4.5], [24, 1.5, 5.2], [24, 0.05, 10],
        [street.x, street.y, street.z],
      ], 'Scaffold descent');
      return 'Roof service-wing route and each expanded scaffold tier remain walkable; every drop lands on its real receiving deck before the open street exit';
    }],
    ['Expanded street and bakery rooms form one supported route', () => {
      const start = CHECKPOINTS.street, car = DISTRICT.car.approach;
      const body = makeBody(start.x, start.y, start.z);
      const roadY = DISTRICT.street.road.floorY;
      walkRoute(body, [
        [car.x, car.y, car.z], [14, roadY, car.z], [-18.75, roadY, car.z],
        ...DISTRICT.bakery.accessRoute.map(point => [point.x, point.y, point.z]),
      ], 'District and bakery access route');
      return 'Actual capsule reaches the car approach, crosses the expanded road, steps onto the far pavement and walks through both bakery rooms without passing through counters or the partition';
    }],
    ['Floor ammo boxes stay supported and conserve their finite budgets through E', () => {
      controlledArea('balcony');
      same(AmmoSupplies.list.map(entry => entry.id).sort(), ['balcony-reserve', 'roof-east-reserve', 'roof-west-reserve'],
        'The actual world contains one balcony and two independent rooftop ammo boxes');
      for (const config of AMMO_SUPPLY_CACHES) {
        const entry = AmmoSupplies.list.find(candidate => candidate.id === config.id);
        const bounds = new Box3().setFromObject(entry.mesh);
        const record = Architecture.elements.get(`ammo-cache-${config.id}`);
        assert(record?.mesh === entry.mesh && record.supportKind === 'bearing' && record.supports.includes(config.support),
          `${config.id} must bear on its real authored deck`);
        near(config.position.y, config.floorY, `${config.id} uses a floor-origin placement`);
        near(bounds.min.y, config.floorY, `${config.id} feet rest on the floor without floating`, 1e-5);
        near(bounds.max.y - bounds.min.y, config.height, `${config.id} has its authored low case height`, 1e-5);
        near(surfaceTopAt(config.position.x, config.floorY, config.position.z, 0.25, 0.16), config.floorY,
          `${config.id} has actual supporting floor beneath it`, 1e-5);
        boundsNear(bounds, entry.collider, `${config.id} collision follows the rendered case`, 1e-5);
        near(entry.interactionPosition.y, bounds.max.y + 0.025, `${config.id} can be reached above its handle`, 1e-5);
        near(entry.interactionPosition.x, config.position.x, `${config.id} interaction lies above its own centre`);
        near(entry.interactionPosition.z, config.position.z, `${config.id} interaction lies above its own centre`);
        const foot = new Vector3(config.approach.x, config.approach.y + 0.02, config.approach.z);
        assert(capsuleHasClearance(foot, Player.radius, Player.bodyHeight, Colliders.list),
          `${config.id} must leave a standing approach outside its collision volume`);
        near(entry.remainingUnits, config.units, `${config.id} begins with its own independent finite stock`);
      }
      const config = AMMO_SUPPLY_CACHES.find(entry => entry.id === 'balcony-reserve');
      const cache = AmmoSupplies.list.find(entry => entry.id === config.id);
      assert(cache?.mesh.visible && cache.active && Colliders.isEnabled(cache.collider),
        'The supply must be an actual visible floor box with matching collision');
      const front = config.approach;
      placeOnClearFloor(front);
      startSimulation();
      near(cache.remainingUnits, config.units, 'A fresh campaign begins with the authored finite supply');
      for (const current of ['fists', 'bat']) {
        Weapons.restore({ current, loaded: 0, reserve: 0 });
        const weapon = Weapons.snapshot(), ledger = AmmoSupplies.snapshot();
        assert(Weapons.findNearestPickup() === null, 'A melee weapon cannot select or obtain a firearm from the ammo box');
        interactThroughInput();
        same(Weapons.snapshot(), weapon, 'Using an ammo box while unarmed cannot grant a gun');
        same(AmmoSupplies.snapshot(), ledger, 'Melee interaction preserves the whole finite supply');
      }

      // One staged, clearly disclosed pickup checks that a single E edge
      // cannot consume a nearer weapon drop and the ammo box behind it.
      placeOnClearFloor({ ...front, z: 1.3 });
      Weapons.restore({ current: 'pistol', loaded: 3, reserve: 0 });
      const drop = WeaponDrops.spawn(Player.pos.x, cache.floorY, Player.pos.z, 'pistol', 5);
      assert(AmmoSupplies.findNearest(Weapons) === cache && Weapons.findNearestPickup() === drop,
        'The arbitration fixture needs both reachable objects, with the real drop closer');
      interactThroughInput();
      same(Weapons.snapshot(), { current: 'pistol', loaded: 3, reserve: 5 }, 'One E press collects only the nearer declared drop');
      assert(!WeaponDrops.list.includes(drop), 'The selected weapon drop is consumed exactly once');
      near(cache.remainingUnits, config.units, 'The same E edge cannot also spend the cache');
      placeOnClearFloor(front);

      let expectedUnits = config.units;
      for (const current of Object.keys(AMMO_SUPPLY_COSTS)) {
        const cap = AMMO_RESERVE_LIMITS[current], cost = AMMO_SUPPLY_COSTS[current];
        Weapons.restore({ current, loaded: 2, reserve: cap + 7 });
        const fullWeapon = Weapons.snapshot();
        assert(Weapons.findNearestPickup() === null, 'A reserve at or above the supply limit must leave the box alone');
        interactThroughInput();
        same(Weapons.snapshot(), fullWeapon, 'Full reserve preserves both loaded rounds and any richer looted inventory');
        near(cache.remainingUnits, expectedUnits, 'Full reserve cannot spend supply units');
        Weapons.restore({ current, loaded: 2, reserve: cap - 1 });
        assert(Weapons.findNearestPickup() === cache, `${current} must find the real supply when one reserve round fits`);
        interactThroughInput();
        expectedUnits -= cost;
        same(Weapons.snapshot(), { current, loaded: 2, reserve: cap }, `${current} gains one reserve round without filling its magazine`);
        near(Weapons.reloading, 0, 'Collecting ammunition does not silently reload');
        near(cache.remainingUnits, expectedUnits, `${current} partial refill charges only the accepted round`);
      }
      Weapons.restore({ current: 'pistol', loaded: 2, reserve: 0 });
      const pistolRounds = Math.floor(expectedUnits / AMMO_SUPPLY_COSTS.pistol);
      interactThroughInput();
      expectedUnits -= pistolRounds * AMMO_SUPPLY_COSTS.pistol;
      same(Weapons.snapshot(), { current: 'pistol', loaded: 2, reserve: pistolRounds }, 'The remaining budget cannot produce a fractional pistol round');
      near(cache.remainingUnits, expectedUnits, 'A remainder survives switching ammunition types');
      Weapons.restore({ current: 'machinegun', loaded: 2, reserve: 0 });
      const machinegunRounds = Math.floor(expectedUnits / AMMO_SUPPLY_COSTS.machinegun);
      assert(machinegunRounds > 0, 'The declared conversion fixture leaves a usable final supply remainder');
      interactThroughInput();
      expectedUnits -= machinegunRounds * AMMO_SUPPLY_COSTS.machinegun;
      same(Weapons.snapshot(), { current: 'machinegun', loaded: 2, reserve: machinegunRounds }, 'A weapon swap shares the remaining budget instead of resetting it');
      near(cache.remainingUnits, expectedUnits, 'All accepted rounds retain exact integer cost');
      near(expectedUnits, 0, 'The authored conversion fixture drains exactly the original finite supply');
      const emptyLedger = AmmoSupplies.snapshot(), emptyWeapon = Weapons.snapshot();
      interactThroughInput();
      same(AmmoSupplies.snapshot(), emptyLedger, 'An exhausted box cannot be collected twice');
      same(Weapons.snapshot(), emptyWeapon, 'An exhausted box cannot grant more rounds');
      assert(!cache.active && cache.mesh.visible && !cache.indicator.visible && Colliders.isEnabled(cache.collider),
        'The empty box stays physically present while its ammunition indicator turns off');
      return 'Three low cases rest on actual floors with top-centre interaction points. Actual E arbitration, melee/full reserve preservation and all four firearm costs conserve the balcony budget through exhaustion. Fixture equips inventories and stages one 5-round drop; magazines never auto-fill';
    }],
    ['Ammo cache access and checkpoint retry preserve one atomic inventory', () => {
      controlledArea('balcony');
      const config = AMMO_SUPPLY_CACHES.find(entry => entry.id === 'balcony-reserve');
      const cache = AmmoSupplies.list.find(entry => entry.id === config.id);
      assert(cache, 'Checkpoint inventory requires the authored floor ammo box');
      const front = config.approach;
      placeOnClearFloor(front);
      Weapons.restore({ current: 'pistol', loaded: 3, reserve: AMMO_RESERVE_LIMITS.pistol - 1 });
      startSimulation();
      interactThroughInput();
      near(cache.remainingUnits, config.units - AMMO_SUPPLY_COSTS.pistol, 'Initial collection spends only one pistol round');
      checkpointAt('stairwell');
      triggersUpdate(); WaveDirector.reset(); StreetChoice.reset(); Endings.reset();
      const savedWeapon = Weapons.snapshot(), savedLedger = AmmoSupplies.snapshot();
      same(getMissionState().checkpoint.ammoSupplies, savedLedger, 'The stair checkpoint saves the partially used supply ledger');
      same(getMissionState().checkpoint.weapon, savedWeapon, 'The same checkpoint saves exact loaded and spare rounds');
      const identity = { mesh: cache.mesh, collider: cache.collider, resources: worldResourceSignature() };

      placeOnClearFloor({ x: front.x, y: front.y, z: -0.75 });
      startSimulation();
      Player.yaw = Math.PI; Player.pitch = 0;
      assert(Input.keyDown('KeyJ'), 'The conservation fixture must consume a real pistol round');
      try { simulateFor(1 / 60); }
      finally { Input.keyUp('KeyJ'); }
      near(Weapons.loaded, savedWeapon.loaded - 1, 'Actual firing consumes one loaded round before refill');
      assert(Input.keyDown('KeyR'), 'The refill fixture must perform a real timed reload');
      try { simulateFor(1 / 60); }
      finally { Input.keyUp('KeyR'); }
      assert(Weapons.reloading > 0, 'Reload starts through normal input');
      simulateFor(WEAPON_DEFS.pistol.reloadTime + 1 / 60);
      near(Weapons.loaded, WEAPON_DEFS.pistol.mag, 'The actual reload fills the held magazine');
      near(Weapons.totalAmmo(), savedWeapon.loaded + savedWeapon.reserve - 1, 'Reload conserves ammunition after the real shot');
      const behindWall = Weapons.snapshot(), ledgerBeforeReturn = AmmoSupplies.snapshot();
      const center = new Vector3(Player.pos.x, Player.pos.y - Player._eyeH + 0.95, Player.pos.z);
      assert(isSegmentOccluded(center, cache.interactionPosition, Colliders.list), 'The box-access fixture starts behind the actual stair wall');
      assert(AmmoSupplies.findNearest(Weapons) === null && Weapons.findNearestPickup() === null,
        'A nearby ammo box cannot be collected through the real wall');
      interactThroughInput();
      same(Weapons.snapshot(), behindWall, 'An E press behind the wall does not collect ammunition');
      same(AmmoSupplies.snapshot(), ledgerBeforeReturn, 'An obstructed interaction does not debit the box');

      placeOnClearFloor(front);
      simulateFor(0.1);
      same(getMissionState().zone, 'stairwell', 'Returning to the already visited gallery cannot reset the current checkpoint or supply');
      assert(cache.visibleZones.includes('balcony') && cache.visibleZones.includes('stairwell')
        && Weapons.findNearestPickup() === cache, 'The same floor box serves both adjacent encounter areas');
      const needed = AMMO_RESERVE_LIMITS.pistol - Weapons.reserve;
      interactThroughInput();
      near(Weapons.loaded, WEAPON_DEFS.pistol.mag, 'Cache collection preserves the actual loaded magazine');
      near(Weapons.reserve, AMMO_RESERVE_LIMITS.pistol, 'The returned player receives exactly the missing reserve');
      near(cache.remainingUnits, savedLedger.caches.find(entry => entry.id === cache.id).remainingUnits - needed * AMMO_SUPPLY_COSTS.pistol,
        'Revisiting spends the existing budget without refreshing it');
      assert(restartFromZone(), 'The real retry restores the supply and weapon checkpoint together');
      same(Weapons.snapshot(), savedWeapon, 'Retry restores the exact earlier magazine and reserve, not the refilled values');
      same(AmmoSupplies.snapshot(), savedLedger, 'Retry preserves supply spent before the checkpoint while undoing later collection');
      assert(cache.mesh === identity.mesh && cache.collider === identity.collider,
        'Retry reuses the original supply geometry and collision');
      same(worldResourceSignature(), identity.resources, 'Retry reuses all three floor boxes without adding world resources');
      freshApartment();
      near(cache.remainingUnits, config.units, 'Only a full new-mission reset replenishes the original supply');
      same(Weapons.snapshot(), STARTING_WEAPON, 'A new mission resets the weapon side of the same inventory');
      return 'One actual shot, timed reload and E refill verify reserve conservation; the real stair wall blocks access. Revisiting does not refresh supply, retry restores weapon + cache atomically, and only a full mission reset restores the starting budget';
    }],
    ['Both rooftop ammo boxes refill through E without sharing or renewing stock', () => {
      controlledArea('roof');
      const configs = AMMO_SUPPLY_CACHES.filter(entry => entry.zone === 'roof');
      near(configs.length, 2, 'The expanded rooftop must have two authored floor supplies');
      const expected = new Map(AmmoSupplies.snapshot().caches.map(entry => [entry.id, entry.remainingUnits]));
      const resources = worldResourceSignature();
      for (const [index, config] of configs.entries()) {
        const cache = AmmoSupplies.list.find(entry => entry.id === config.id);
        const current = index === 0 ? 'pistol' : 'smg';
        Weapons.restore({ current, loaded: 2, reserve: 0 });
        placeOnClearFloor(config.approach);
        startSimulation();
        simulateFor(0.1);
        assert(cache?.mesh.visible && cache.active && Weapons.findNearestPickup() === cache,
          `${config.id} must be independently reachable through the actual interaction selector`);
        const rounds = Math.floor(config.units / AMMO_SUPPLY_COSTS[current]);
        interactThroughInput();
        same(Weapons.snapshot(), { current, loaded: 2, reserve: rounds },
          `${config.id} adds real reserve rounds without changing the loaded magazine`);
        expected.set(config.id, config.units - rounds * AMMO_SUPPLY_COSTS[current]);
        for (const entry of AmmoSupplies.snapshot().caches) near(entry.remainingUnits, expected.get(entry.id),
          `Collecting ${config.id} cannot debit or refill ${entry.id}`);
        assert(!cache.active && cache.mesh.visible && Colliders.isEnabled(cache.collider),
          'An empty rooftop case remains visible and solid');
      }
      const exhausted = AmmoSupplies.snapshot();
      for (const config of configs) {
        placeOnClearFloor(config.approach);
        Weapons.restore({ current: 'pistol', loaded: 2, reserve: 0 });
        assert(Weapons.findNearestPickup() === null, 'Returning with an empty reserve cannot renew a spent rooftop box');
        interactThroughInput();
        same(Weapons.snapshot(), { current: 'pistol', loaded: 2, reserve: 0 }, 'A depleted rooftop supply cannot grant a duplicate refill');
        same(AmmoSupplies.snapshot(), exhausted, 'Returning to either rooftop supply preserves the complete three-box ledger');
      }
      near(AmmoSupplies.list.find(entry => entry.id === 'balcony-reserve').remainingUnits,
        AMMO_SUPPLY_CACHES.find(entry => entry.id === 'balcony-reserve').units,
        'Rooftop collection must leave the separate balcony supply untouched');
      same(worldResourceSignature(), resources, 'Collection and revisits reuse the actual floor-box resources');
      return 'Actual E input collects the west and east rooftop cases independently; each keeps its empty body, neither renews on revisit or weapon swap, and the balcony stock remains unchanged. Inventory equipment and approach placements are declared fixtures';
    }],
    ['Exact weapon snapshot and ammunition conservation', () => {
      const ranged = Object.entries(WEAPON_DEFS).filter(([, definition]) => definition.kind === 'ranged');
      assert(ranged.length > 0, 'At least one ranged weapon must be tested');
      for (const [current, definition] of ranged) {
        const loaded = Math.min(3, definition.mag - 1);
        const reserve = definition.mag + 7;
        const snapshot = { current, loaded, reserve };
        Weapons.restore(snapshot);
        same(Weapons.snapshot(), snapshot, `${current} preserves partially loaded magazine`);
        assert(Weapons.startReload(), `${current} reload must start`);
        Weapons.tick(definition.reloadTime - 0.01);
        same(Weapons.snapshot(), snapshot, `${current} does not reload early`);
        Weapons.tick(0.02);
        same(Weapons.snapshot(), { current, loaded: definition.mag, reserve: loaded + reserve - definition.mag },
          `${current} reload transfers exactly the missing rounds`);
        near(Weapons.totalAmmo(), loaded + reserve, `${current} total ammunition`);
        assert(!Weapons.startReload(), `${current} cannot reload a full magazine`);
        Weapons.restore({ current, loaded: 1, reserve: 2 });
        assert(Weapons.startReload(), `${current} starts a limited-reserve reload`);
        Weapons.tick(definition.reloadTime + 0.01);
        same(Weapons.snapshot(), { current, loaded: 3, reserve: 0 }, `${current} cannot create spare ammunition`);
      }
      return `${ranged.length} weapon types preserve exact magazines and total ammunition`;
    }],
    ['Pause freezes the actual simulation', () => {
      const enemy = spawnMeleeContact();
      Weapons.restore({ current: 'pistol', loaded: 1, reserve: 8 });
      assert(Weapons.startReload(), 'Pause check requires a reload in progress');
      api.setInspection(false);
      const beforeActive = GameTime.elapsed;
      Input.activate();
      api.stepFrame(1 / 60);
      assert(GameTime.elapsed > beforeActive, 'Positive control: an active frame must advance simulation');
      pauseSilently();
      api.setInspection(true);
      const snapshot = {
        elapsed: GameTime.elapsed, health: Player.health, position: Player.pos.toArray(),
        windup: enemy.windupRemaining, waveTimer: WaveDirector.timer, reload: Weapons.reloading,
      };
      for (let tick = 0; tick < 180; tick++) api.stepFrame(1 / 60);
      same({
        elapsed: GameTime.elapsed, health: Player.health, position: Player.pos.toArray(),
        windup: enemy.windupRemaining, waveTimer: WaveDirector.timer, reload: Weapons.reloading,
      }, snapshot, 'Three seconds of paused frames must not advance gameplay');
      return 'Active control advances; paused time, health, position, windup, waves and reload remain identical';
    }],
    ['Real pistol input hits a contact and stops at a wall', () => {
      controlledStreet();
      Weapons.restore({ current: 'pistol', loaded: 5, reserve: 11 });
      let enemy = spawnFixtureEnemy('bruiser', DISTRICT.street.qa.benchmark[1]);
      const target = enemy.pos.clone();
      target.y += enemy.height * 0.5;
      pointCameraAt(target);
      assert(!isSegmentOccluded(Player.pos, target, Colliders.list), 'The clear-shot fixture must have an unobstructed street sightline');
      const firstHealth = enemy.health, firstStats = CombatStats.snapshot();
      const ammo = Weapons.snapshot();
      pausedRender();
      api.setInspection(false);
      Input.activate();
      Input.keyDown('KeyQ');
      assert(Input.keyDown('KeyJ'), 'Pistol fire requires a real input edge');
      assert(api.stepFrame(1 / 60) > 0, 'Pistol check must run the real active simulation');
      Input.keyUp('KeyJ');
      near(firstHealth - enemy.health, WEAPON_DEFS.pistol.dmg, 'A centered real pistol ray hits the torso once');
      same(Weapons.snapshot(), { ...ammo, loaded: ammo.loaded - 1 }, 'A real shot consumes exactly one loaded round');
      near(CombatStats.snapshot().shots - firstStats.shots, 1, 'The real weapon records one shot');
      near(CombatStats.snapshot().hits - firstStats.hits, 1, 'The real weapon records one hit');

      pauseSilently();
      Enemies.clearAll();
      // Both actors stand on actual authored floors, on opposite sides of
      // the solid western bakery corner rather than a display window.
      const wallShot = DISTRICT.street.qa.wallShot;
      placeOnClearFloor(wallShot);
      enemy = spawnFixtureEnemy('bruiser', { x: wallShot.x, y: DISTRICT.bakery.floorY, z: DISTRICT.bakery.z1 + 2.2 }, 'bakery');
      target.copy(enemy.pos);
      target.y += enemy.height * 0.5;
      pointCameraAt(target);
      assert(isSegmentOccluded(Player.pos, target, Colliders.list), 'The blocked-shot fixture requires an actual solid world wall');
      pausedRender();
      Input.activate();
      Input.keyDown('KeyQ');
      // Let the pistol's real cooldown expire, with the AI and collision
      // systems still running, before generating the second input edge.
      for (let tick = 0; tick < Math.ceil(WEAPON_DEFS.pistol.rate * 60) + 1; tick++) api.stepFrame(1 / 60);
      const blockedHealth = enemy.health, blockedAmmo = Weapons.snapshot(), blockedStats = CombatStats.snapshot();
      assert(Input.keyDown('KeyJ'), 'The wall shot requires a second real input edge');
      assert(api.stepFrame(1 / 60) > 0, 'The wall shot must run through the simulation');
      Input.keyUp('KeyJ');
      near(enemy.health, blockedHealth, 'The actual bakery wall stops the bullet before the enemy');
      same(Weapons.snapshot(), { ...blockedAmmo, loaded: blockedAmmo.loaded - 1 }, 'A wall impact still consumes a real round');
      near(CombatStats.snapshot().shots - blockedStats.shots, 1, 'The blocked weapon shot is recorded');
      near(CombatStats.snapshot().hits - blockedStats.hits, 0, 'A wall impact is not an enemy hit');
      pauseSilently();
      return 'Input → simulation → camera/raycast → torso damage; solid bakery wall blocks the next shot; two rounds consumed';
    }],
    ['Player melee waits for visual contact and hits only once', () => {
      const variants = [
        { held: 'fists', attack: 'fists', key: 'KeyJ' },
        { held: 'bat', attack: 'bat', key: 'KeyJ' },
        { held: 'pistol', attack: 'fists', key: 'KeyV' },
      ];
      for (const variant of variants) {
        freshApartment(); controlledStreet();
        Weapons.restore({ current: variant.held, loaded: variant.held === 'pistol' ? 5 : 0,
          reserve: variant.held === 'pistol' ? 11 : 0 });
        const enemy = spawnFixtureEnemy('bruiser', DISTRICT.street.qa.firstGun);
        const ammo = Weapons.snapshot(), credit = CombatStats.snapshot();
        startSimulation();
        try {
          const strike = beginMeleeThroughInput(enemy, { key: variant.key, attackType: variant.attack, hold: true });
          while (Weapons.melee.elapsed + STEP < strike.timing.contactAt - 1e-9) {
            aimAtBody(enemy);
            simulateStep();
            assert(!Weapons.melee.contactDelivered, `${variant.held} cannot commit before its contact time`);
            near(enemy.health, strike.health, `${variant.held} windup must remain harmless`);
          }
          assert(Weapons.melee.elapsed >= strike.timing.contactAt - STEP - 1e-9,
            'The delay check must reach the last individual simulation step before contact');
          advanceMeleeToContact(enemy, strike);
          near(strike.health - enemy.health, strike.expectedDamage, `${variant.held} commits one real body hit`);
          const afterContact = enemy.health;
          simulateFor(strike.timing.duration + WEAPON_DEFS[variant.attack].rate + 1 / 60, () => {
            near(enemy.health, afterContact, 'Recovery and held input cannot deliver a second melee hit');
          });
          near(Weapons.melee.sequence, strike.sequence, 'Holding a melee button cannot manufacture another attack edge');
          same(Weapons.snapshot(), ammo, 'Melee, including an offhand punch, cannot consume firearm ammunition');
          assertNoPlayerCombatCredit(credit);
          assert(!PlayerState.dead, 'The bounded contact fixture stays alive without health replenishment');
        } finally { Input.keyUp(variant.key); }
      }
      return 'Real J fists/bat and V offhand input remain harmless until authored contact, then deal one body hit; holding through recovery adds no hit or shot. Fixture equips loadouts and tracks the torso; no damage or health is injected';
    }],
    ['Melee rechecks target distance and actual walls at contact', () => {
      const fixtures = [
        { name: 'Retreat beyond reach', zone: 'street', player: DISTRICT.street.checkpoint,
          initial: DISTRICT.street.qa.firstGun, moved: { x: 24, y: DISTRICT.street.road.floorY, z: 16.4 }, wall: false },
        { name: 'Bakery partition', zone: 'bakery', player: { x: -24, y: DISTRICT.bakery.floorY, z: 34.15 },
          initial: { x: -24, y: DISTRICT.bakery.floorY, z: 34.9 },
          moved: { x: -24, y: DISTRICT.bakery.floorY, z: 36.15 }, wall: true },
      ];
      for (const fixture of fixtures) {
        freshApartment(); controlledArea(fixture.zone);
        placeOnClearFloor(fixture.player);
        Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
        const enemy = spawnFixtureEnemy('brawler', fixture.initial, fixture.zone);
        const credit = CombatStats.snapshot();
        startSimulation();
        const aimPoint = { x: fixture.moved.x, y: fixture.moved.y + 0.02 + enemy.height * 0.5, z: fixture.moved.z };
        const strike = beginMeleeThroughInput(enemy, { aimPoint });
        const fixedView = [Player.yaw, Player.pitch];
        repositionFixtureEnemy(enemy, fixture.moved);
        const verifyMissCause = () => {
          const contacts = fixtureBodyRayContacts(enemy, WEAPON_DEFS.bat);
          assert(contacts.length > 0, `${fixture.name} must retain a target inside the original aiming fan`);
          if (fixture.wall) {
            const withinReach = contacts.filter(contact => contact.distance < WEAPON_DEFS.bat.range);
            assert(withinReach.length > 0 && withinReach.every(contact => contact.blocked),
              'The actual partition must block each otherwise reachable body ray through contact');
          } else {
            assert(contacts.every(contact => contact.distance > WEAPON_DEFS.bat.range && !contact.blocked),
              'Retreat alone, without changed aim or wall cover, must explain the miss through contact');
          }
          assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 0.003),
            `${fixture.name} target must remain outside walls`);
        };
        const target = enemy.pos.clone(); target.y += enemy.height * 0.5;
        if (fixture.wall) {
          assert(Player.pos.distanceTo(target) < WEAPON_DEFS.bat.range,
            'The partition fixture must keep the target torso inside bat reach');
          assert(Ballistics.segmentOccluded(Player.pos, target, 'bullet'),
            'The moved target must be behind the actual bakery partition');
        } else {
          assert(Player.pos.distanceTo(target) > WEAPON_DEFS.bat.range + enemy.radius,
            'The retreated target must be beyond the complete bat hit volume');
          assert(!Ballistics.segmentOccluded(Player.pos, target, 'bullet'),
            'The retreat miss must not be explained by an intervening wall');
        }
        verifyMissCause();
        advanceMeleeToContact(enemy, strike, verifyMissCause, false);
        same([Player.yaw, Player.pitch], fixedView, 'The revalidation fixture keeps its original aim through contact');
        near(enemy.health, strike.health, `${fixture.name} must prevent the previously available melee hit`);
        assertNoPlayerCombatCredit(credit);
        assert(enemy.alive && !PlayerState.dead, 'A missed swing must leave the fixture alive');
      }
      return 'Two disclosed target repositions during a real bat windup: beyond reach, and behind a real bakery partition while initially still within reach. Original aim is unchanged; contact rays miss without damage or fabricated credit';
    }],
    ['Dropping, retrying and dying cancel a pending player attack', () => {
      for (const mode of ['drop', 'retry', 'death']) {
        freshApartment(); controlledStreet();
        Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
        let enemy = spawnFixtureEnemy('bruiser', DISTRICT.street.qa.firstGun);
        const oldEnemy = enemy, credit = CombatStats.snapshot();
        startSimulation();
        const strike = beginMeleeThroughInput(enemy);
        if (mode === 'drop') {
          assert(Input.keyDown('KeyG'), 'The equip cancellation must use a real drop input edge');
          try { simulateFor(1 / 60); }
          finally { Input.keyUp('KeyG'); }
          assert(Weapons.current === 'fists' && WeaponDrops.list.some(drop => drop.weaponType === 'bat'),
            'The real G action must drop the bat and equip fists');
        } else if (mode === 'retry') {
          assert(restartFromZone(), 'The real checkpoint retry must succeed during windup');
          assert(oldEnemy.removed && oldEnemy.poolSlot === null, 'Retry invalidates the previous target and its ownership');
          WaveDirector.reset(); StreetChoice.reset(); Endings.reset();
          enemy = spawnFixtureEnemy('bruiser', DISTRICT.street.qa.firstGun);
        } else {
          applyPlayerDamage(Player.health);
          assert(PlayerState.dead && !Input.active, 'Fixture damage must use the real player death path');
        }
        assert(!Weapons.melee.active && !Weapons.melee.contactDelivered && Weapons.melee.type === null,
          `${mode} must invalidate the pending attack immediately`);
        near(Weapons.swingT, 0, `${mode} clears the old attack pose`);
        const health = enemy.health;
        if (mode === 'death') {
          const elapsed = GameTime.elapsed;
          for (let frame = 0; frame < 60; frame++) near(api.stepFrame(1 / 60), 0, 'Dead gameplay cannot advance an old swing');
          near(GameTime.elapsed, elapsed, 'Player death freezes the world clock');
        } else {
          if (mode === 'retry') startSimulation();
          simulateFor(strike.timing.duration + 0.2);
        }
        near(enemy.health, health, `${mode} cannot land a late hit on the retained or replacement target`);
        assertNoPlayerCombatCredit(credit);
      }
      return 'Actual G equip, checkpoint retry and player death invalidate windups; subsequent frames cannot damage old or replacement targets. The death case explicitly applies lethal fixture damage to the player';
    }],
    ['Pausing a player swing freezes contact and resumes it once', () => {
      controlledStreet();
      Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
      const enemy = spawnFixtureEnemy('bruiser', DISTRICT.street.qa.firstGun);
      startSimulation();
      const strike = beginMeleeThroughInput(enemy);
      simulateFor(strike.timing.contactAt / 3);
      assert(Weapons.melee.active && !Weapons.melee.contactDelivered, 'The pause must begin during a real harmless windup');
      pauseSilently();
      const frozen = { time: GameTime.elapsed, attack: { ...Weapons.melee }, swingT: Weapons.swingT,
        playerHealth: Player.health, targetHealth: enemy.health, position: enemy.pos.toArray() };
      for (let frame = 0; frame < 180; frame++) near(api.stepFrame(1 / 60), 0, 'Paused swing frames cannot simulate');
      same({ time: GameTime.elapsed, attack: { ...Weapons.melee }, swingT: Weapons.swingT,
        playerHealth: Player.health, targetHealth: enemy.health, position: enemy.pos.toArray() }, frozen,
      'Three seconds of paused frames preserve both actors and the pending contact exactly');
      startSimulation();
      advanceMeleeToContact(enemy, strike);
      near(strike.health - enemy.health, strike.expectedDamage, 'Resuming the pending swing delivers one real hit');
      const afterContact = enemy.health;
      simulateFor(strike.timing.duration + 0.1);
      near(enemy.health, afterContact, 'Resuming and recovering cannot replay contact damage');
      return 'A real bat windup survives three paused seconds unchanged, then commits exactly one hit after the remaining simulation time';
    }],
    ['The first firearm is earned from a real melee defeat and pickup', () => {
      same(Weapons.snapshot(), STARTING_WEAPON, 'No firearm may exist in the initial player loadout');
      controlledStreet();
      const enemy = spawnFixtureEnemy('gunman', DISTRICT.street.qa.firstGun);
      const before = CombatStats.snapshot();
      const count = Math.ceil(enemy.health / WEAPON_DEFS.fists.dmg);
      startSimulation();
      for (let hit = 0; hit < count; hit++) strikeBodyThroughInput(enemy);
      assert(!enemy.alive, 'Real fist contacts must defeat the gun carrier');
      same(Weapons.snapshot(), STARTING_WEAPON, 'Defeating a gun carrier must not automatically equip its firearm');
      const drop = WeaponDrops.list.find(entry => entry.weaponType === enemy.def.weaponType);
      assert(drop && Weapons.findNearestPickup() === drop, 'The defeated carrier must leave a reachable actual firearm drop');
      const dropAmmo = drop.ammo;
      assert(Input.keyDown('KeyE'), 'The first firearm must be collected through real interaction input');
      try { simulateFor(1 / 60); }
      finally { Input.keyUp('KeyE'); }
      const expected = { current: enemy.def.weaponType,
        loaded: Math.min(dropAmmo, WEAPON_DEFS[enemy.def.weaponType].mag),
        reserve: Math.max(0, dropAmmo - WEAPON_DEFS[enemy.def.weaponType].mag) };
      same(Weapons.snapshot(), expected, 'Picking up the earned firearm preserves exactly its dropped ammunition');
      assert(!WeaponDrops.list.includes(drop), 'A collected firearm cannot remain available for duplicate pickups');
      near(CombatStats.snapshot().kills - before.kills, 1, 'The actual melee defeat earns one player kill');
      near(CombatStats.snapshot().shots - before.shots, 0, 'The first firearm fixture does not fabricate shots');
      assert(!PlayerState.dead && Player.health > 0, 'The first firearm can be earned without fixture healing');
      pauseSilently();
      saveCheckpoint('street');
      Weapons.restore(STARTING_WEAPON);
      assert(restartFromZone(), 'A later checkpoint must restore the legitimately earned loadout');
      same(Weapons.snapshot(), expected, 'Checkpoint retry preserves the earned firearm and exact ammunition');
      return `${count} actual fist hits → real ${expected.current} drop → E pickup with ${dropAmmo} total rounds; no free gun, direct damage or health refill`;
    }],
    ['Headshot multiplier applies exactly once', () => {
      const enemy = Enemies.spawn('bruiser', -6, -8, 4.02);
      assert(enemy, 'Headshot check requires a real pooled bruiser');
      const before = enemy.health;
      const result = damageEnemy(enemy, 20, 'head');
      near(before - enemy.health, 50, '20 base damage × one 2.5 head multiplier');
      assert(result?.damage === 50 && result.headshot && !result.killed, 'Nonlethal headshot result must match health');
      const bodyBefore = enemy.health;
      damageEnemy(enemy, 20, 'body');
      near(bodyBefore - enemy.health, 20, 'Body damage remains unscaled');
      return '20 base → 50 head damage; body remains 20';
    }],
    ['Cleared and restarted melee cannot land late', async () => {
      let enemy = spawnMeleeContact();
      assert(enemyAttackPlayer(enemy), 'Positive control: this live melee contact must connect');
      near(Player.health, 100 - enemy.def.damage, 'Live melee damage');
      Player.health = 100;
      Enemies.clearAll();
      enemiesUpdate(0.5);
      // This is a lower-bound grace period, not a frame-rate assertion. It
      // also catches a regression to wall-clock callbacks from the old AI.
      await new Promise(resolve => setTimeout(resolve, enemy.def.swingTime * 1000 + 100));
      assert(!disposed, 'QA was disposed while waiting for the cancelled attack');
      assert(!enemyAttackPlayer(enemy), 'A cleared enemy reference must never attack');
      near(Player.health, 100, 'Clearing enemies cancels pending damage');
      assert(enemy.removed && !enemy.alive && enemy.windupRemaining < 0 && enemy.poolSlot === null,
        'Clearing invalidates old enemy ownership and windup');
      enemy = spawnMeleeContact();
      assert(restartFromZone(), 'Restart must succeed during a melee windup');
      enemiesUpdate(0.5);
      await new Promise(resolve => setTimeout(resolve, enemy.def.swingTime * 1000 + 100));
      assert(!disposed, 'QA was disposed while waiting for the restarted attack');
      assert(!enemyAttackPlayer(enemy), 'A previous-life melee reference must never attack');
      near(Player.health, 100, 'Restarted health cannot be damaged by previous-life attacks');
      return 'A live control hits; clear and checkpoint retry cancel old references and windups';
    }],
    ['Corpse limits, expiry and rig reuse', () => {
      const capacity = EnemyPool.pools.thug.length;
      const originalSlots = pooledSlots().length;
      const corpses = [];
      for (let index = 0; index < capacity; index++) {
        const enemy = Enemies.spawn('thug', -6, -8, 4.02);
        assert(enemy, `Thug pool must supply slot ${index + 1}`);
        killEnemy(enemy);
        enemy.corpseTimer = (capacity - index) * 0.1;
        corpses.push(enemy);
      }
      const oldest = corpses[0], releasedSlot = oldest.poolSlot;
      const replacement = Enemies.spawn('thug', -6, -8, 4.02);
      assert(replacement, 'A full pool with a corpse must allow a new contact');
      assert(oldest.removed && oldest.poolSlot === null, 'The oldest corpse loses rig ownership');
      assert(replacement.poolSlot === releasedSlot && releasedSlot.owner === replacement,
        'The same rig is reused with a new owner');
      assert(!enemyAttackPlayer(oldest), 'Reusing a rig must not reactivate its old enemy');
      for (let index = 0; index < 4; index++) {
        const enemy = Enemies.spawn('gunman', -6, -8, 4.02);
        assert(enemy, 'Gunman pool must supply a corpse-limit fixture');
        killEnemy(enemy);
      }
      Enemies.removeDead();
      assert(Enemies.list.filter(enemy => !enemy.alive).length <= CORPSE_LIMIT, 'Corpse count must remain bounded');
      assert(replacement.alive && replacement.poolSlot.owner === replacement, 'Corpse cleanup cannot reclaim a live rig');
      for (const enemy of Enemies.list) if (!enemy.alive) enemy.corpseTimer = CORPSE_LIFETIME;
      Enemies.removeDead();
      assert(Enemies.list.every(enemy => enemy.alive), 'Expired corpses must release their rigs');
      near(pooledSlots().length, originalSlots, 'Rig pool allocation count remains fixed');
      Enemies.clearAll();
      assert(pooledSlots().every(slot => !slot.inUse && slot.owner === null), 'Clearing returns every rig to the pool');
      return 'Oldest corpse reused; live rigs preserved; corpse cap and 18 s expiry release ownership';
    }],
    ...['car', 'bakery'].map(branch => [
      `${branch === 'car' ? 'Car' : 'Bakery'} ending checkpoint retry`, () => {
        checkpointAt(branch === 'car' ? 'street' : 'bakery');
        if (branch === 'car') StreetChoice.commitCar();
        else StreetChoice.commitBakery();
        const initial = assertEndingSquad(branch);
        const oldContacts = [...Enemies.list];
        Endings.update(1.25);
        if (branch === 'bakery') near(Endings.getStatus().deadline, FINAL_ENCOUNTERS.bakery.deadlineSeconds - 1.25, 'Bakery timer advances in simulation');
        applyPlayerDamage(500);
        assert(PlayerState.dead, 'Ending retry must begin from a real death');
        assert(restartFromZone(), `${branch} ending checkpoint must restart`);
        const restarted = assertEndingSquad(branch);
        same(restarted.checkpoint.weapon, initial.checkpoint.weapon, `${branch} retry preserves exact weapon snapshot`);
        same(Weapons.snapshot(), initial.checkpoint.weapon, `${branch} retry restores loaded and reserve ammunition`);
        assert(oldContacts.every(enemy => enemy.removed && !enemy.alive), 'Previous ending squad must be invalidated');
        assert(!PlayerState.dead && Player.health === 100, 'Ending retry restores living player at full health');
        return `${FINAL_ENCOUNTERS[branch].waves.flat().length} contacts preserved across initial and future waves; branch lock and exact weapon snapshot restored`
          + (branch === 'bakery' ? `; timer resets to ${FINAL_ENCOUNTERS.bakery.deadlineSeconds} s` : '');
      },
    ]),
    ['Car resolution requires a cleared squad and arrival', () => {
      const creditBefore = beginFinalFixture('car');
      const besideCar = DISTRICT.car.approach;
      placeOnClearFloor(besideCar);
      assert(api.stepFrame(1 / 60) > 0, 'The car arrival fixture must execute the real simulation');
      assert(!Endings.isResolved() && !document.getElementById('endcard').classList.contains('show'),
        'Reaching the car while guards remain alive cannot complete the mission');

      placeOnClearFloor(CHECKPOINTS.street);
      const cleared = clearFinalByFixtureDamage('car');
      assert(api.stepFrame(1 / 60) > 0, 'The cleared car fixture must execute the real simulation');
      assert(!Endings.isResolved(), 'A cleared squad cannot complete the car ending while the player is distant');
      placeOnClearFloor(besideCar);
      assert(api.stepFrame(1 / 60) > 0, 'Returning to the cleared car must advance its resolution frame');
      assertEndingCard('car', 'THE LAST RIDE', 'VENGEANCE');
      assertNoPlayerCombatCredit(creditBefore);
      const resolvedTime = GameTime.elapsed;
      api.stepFrame(1 / 30);
      near(GameTime.elapsed, resolvedTime, 'A resolved ending stops further gameplay');
      return `Fixture applied ${cleared.appliedDamage} body damage to ${cleared.contacts} real guards (no player kill credit); alive guards and distance block completion; clear + arrival resolves Vengeance`;
    }],
    ['Clearing the bakery resolves the protector ending', () => {
      const creditBefore = beginFinalFixture('bakery');
      assert(api.stepFrame(1 / 60) > 0, 'The bakery fixture must execute the real simulation');
      assert(!Endings.isResolved(), 'An uncleared bakery cannot complete the protector ending');
      const cleared = clearFinalByFixtureDamage('bakery');
      assert(Endings.getStatus().deadline > 0, 'Protector success must occur before the authored deadline');
      assertEndingCard('bakery', 'A PAPER ROSE', 'PROTECTOR');
      assertNoPlayerCombatCredit(creditBefore);
      return `Fixture applied ${cleared.appliedDamage} body damage to ${cleared.contacts} real raiders (no player kill credit); clearing them before the deadline displays Protector`;
    }],
    ['Bakery timeout uses its authored simulation deadline and respects pause', async () => {
      const creditBefore = beginFinalFixture('bakery');
      const deadlineSeconds = FINAL_ENCOUNTERS.bakery.deadlineSeconds;
      assert(Number.isFinite(deadlineSeconds) && deadlineSeconds > 0, 'The expanded bakery encounter must author a positive deadline');
      const startedAt = GameTime.elapsed;
      let healthRestores = 0;
      function timeoutFrame() {
        assert(Input.active && !PlayerState.dead, 'The timeout fixture must remain active and alive');
        if (Player.health < 100) {
          Player.health = 100;
          HUD.setHealth(100);
          healthRestores++;
        }
        const progressed = api.stepFrame(1 / 30);
        assert(progressed > 0 || Endings.isResolved(), 'Timeout fixture simulation must advance');
        assertSilent();
      }
      // Drive the existing bounded fixed-step engine. No wall-clock shortcut
      // or direct deadline mutation is used; AI, physics and mission all tick.
      for (let frame = 0; frame < Math.round((deadlineSeconds - 0.1) * 30); frame++) {
        timeoutFrame();
        if (frame % 240 === 239) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          assert(!disposed, 'QA was disposed during the simulated bakery deadline');
        }
      }
      near(GameTime.elapsed - startedAt, deadlineSeconds - 0.1, 'Pre-deadline simulation duration', STEP + 1e-6);
      near(Endings.getStatus().deadline, 0.1, 'Bakery must retain its final tenth of a second', STEP + 1e-6);
      assert(!Endings.isResolved(), 'The bakery cannot time out before its full authored simulation duration');
      pauseSilently();
      const paused = { elapsed: GameTime.elapsed, deadline: Endings.getStatus().deadline, health: Player.health };
      for (let frame = 0; frame < 30; frame++) api.stepFrame(1 / 30);
      same({ elapsed: GameTime.elapsed, deadline: Endings.getStatus().deadline, health: Player.health }, paused,
        'Paused frames cannot consume the final bakery deadline or damage the player');
      Input.activate();
      for (let frame = 0; frame < 8 && !Endings.isResolved(); frame++) timeoutFrame();
      near(GameTime.elapsed - startedAt, deadlineSeconds, 'Bakery failure occurs at the real authored simulation boundary', STEP + 1e-6);
      assert(Endings.getStatus().deadline <= 0, 'The timeout branch requires an expired deadline');
      assert(Enemies.list.some(enemy => enemy.alive && enemy.zone === 'bakery'),
        'The timeout fixture must leave actual raiders alive');
      assertEndingCard('bakery', 'A QUIET HOUSE', 'TOO LATE');
      assertNoPlayerCombatCredit(creditBefore);
      return `${deadlineSeconds} s through stepFrame; pause preserves deadline; live raiders cause Too Late. Fixture replenished player health ${healthRestores} times; no player shots or kills were invented`;
    }],
    ['Empty safe-spawn attempts cannot win encounters', () => {
      for (const branch of ['car', 'bakery']) {
        freshApartment();
        checkpointAt(branch === 'car' ? 'street' : 'bakery');
        const reserved = [];
        try {
          // Reserve actual pool slots without owners. Ending cleanup can clear
          // real enemies but cannot make these deliberate capacity fixtures free.
          for (const type of Object.keys(EnemyPool.pools)) {
            let slot = EnemyPool.acquire(type);
            while (slot) { reserved.push(slot); slot = EnemyPool.acquire(type); }
          }
          if (branch === 'car') {
            placeOnClearFloor(DISTRICT.car.approach);
            StreetChoice.commitCar();
          } else StreetChoice.commitBakery();
          startSimulation();
          simulateFor(0.75);
          const state = Endings.getStatus();
          near(state.spawned, 0, `${branch} fixture has no successful spawns`);
          near(state.pending, FINAL_ENCOUNTERS[branch].waves[0].length, `${branch} failed spawns remain pending`);
          near(state.remaining, FINAL_ENCOUNTERS[branch].waves.flat().length, `${branch} blocked capacity retains every future opponent`);
          same([...state.unstartedTypes].sort(), FINAL_ENCOUNTERS[branch].waves.slice(1).flat().sort(),
            `${branch} blocked initial squad must not discard unstarted waves`);
          assert(!state.resolved, `${branch} cannot win before any opponent has spawned`);
          state.pendingTypes.length = 0;
          near(Endings.getStatus().pending, FINAL_ENCOUNTERS[branch].waves[0].length, 'Reported pending rosters must be defensive copies');
        } finally {
          for (const slot of reserved) EnemyPool.release(slot);
        }
      }
      freshApartment();
      checkpointAt('roof');
      triggersUpdate();
      const reserved = [];
      try {
        for (const type of Object.keys(EnemyPool.pools)) {
          let slot = EnemyPool.acquire(type);
          while (slot) { reserved.push(slot); slot = EnemyPool.acquire(type); }
        }
        startSimulation();
        simulateFor(ZONE_WAVE_CONFIG.roof.firstWave + 0.75);
        const wave = getMissionState().wave;
        near(wave.spawned, 0, 'The blocked roof fixture must have no successful spawns');
        near(wave.remaining, ZONE_WAVE_CONFIG.roof.waves.flat().length, 'All rooftop contacts survive a blocked opening spawn');
        near(wave.pendingTypes.length, ZONE_WAVE_CONFIG.roof.waves[0].length, 'The rooftop opening pair remains pending');
        assert(wave.active && !wave.cleared && !wave.reinforcementsActive,
          'An empty blocked roof cannot clear itself or bypass the opening-pair requirement');
      } finally {
        for (const slot of reserved) EnemyPool.release(slot);
      }
      return 'Both expanded finales and the roof defer real blocked pool requests, retain all future waves and refuse an empty victory';
    }],
    ['Both rooftop crossings provide finite health supplies and preserve full health', () => {
      controlledArea('roof');
      const metadata = HEALTH_SUPPLIES.filter(entry => entry.zone === 'roof');
      const pickups = metadata.map(entry => HealPickups.list.find(pickup => pickup.id === entry.id));
      assert(metadata.length === 4 && pickups.every(Boolean), 'The roof must contain all four fixed crossing supplies');
      const resources = worldResourceSignature(), inventory = Weapons.snapshot(), supplies = AmmoSupplies.snapshot();
      const identities = pickups.map(pickup => [pickup.mesh, pickup.halo]);
      for (const route of Object.values(ROOF_HEALTH_ROUTES)) {
        assert(route.supplyIds.length === 2 && route.supplyIds.every(id => metadata.some(entry => entry.id === id && entry.route === route.id)),
          `${route.label} must own its two distinct fixed supplies`);
        near(metadata.filter(entry => route.supplyIds.includes(entry.id)).reduce((total, entry) => total + entry.amount, 0), 60,
          `${route.label} provides the same finite recovery budget`);
        const body = makeBody(...route.waypoints[0]); body.radius = 0.48; body.height = 2.02;
        walkRoute(body, route.waypoints.slice(1), `${route.label} supported capsule route`);
      }
      for (const [index, entry] of metadata.entries()) {
        const pickup = pickups[index];
        same(pickup.mesh.userData.healthSupplyId, entry.id, 'The actual health prop retains its stable supply identity');
        near(surfaceTopAt(entry.x, entry.y, entry.z, 0.25, 0.16), entry.y, `${entry.id} has an authored supporting floor`);
        near(pickup.baseY, entry.y + 0.18, `${entry.id} retains the pickup presentation offset`);
        placeOnClearFloor({ x: entry.x + 0.55, y: entry.y, z: entry.z });
        Player.health = 100; HUD.setHealth(100);
        startSimulation(); simulateFor(1 / 60); pauseSilently();
        assert(pickup.active && pickup.mesh.visible, 'Full health must preserve each rooftop pack on either crossing');
        // Controlled low health tests the real automatic collection path;
        // no enemy hit or player combat credit is invented for this fixture.
        Player.health = 65; HUD.setHealth(65);
        startSimulation(); simulateFor(1 / 60);
        near(Player.health, 95, `${entry.id} grants exactly its fixed 30 HP`);
        assert(!pickup.active && !pickup.mesh.visible && !pickup.halo.visible, 'A collected rooftop pack hides its existing model and halo');
        simulateFor(0.1); pauseSilently();
        near(Player.health, 95, 'Remaining near a collected pack cannot heal twice');
      }
      same(Weapons.snapshot(), inventory, 'Roof health collection cannot change inventory');
      same(AmmoSupplies.snapshot(), supplies, 'Health collection cannot consume or refill ammo boxes');
      assert(restartFromZone(), 'The actual roof checkpoint must restore its finite health supplies');
      for (const [index, pickup] of pickups.entries()) {
        assert(pickup.active && pickup.mesh.visible && pickup.mesh === identities[index][0] && pickup.halo === identities[index][1],
          'Checkpoint retry reactivates the same four models and halos without allocating replacements');
      }
      same(worldResourceSignature(), resources, 'Collection and retry cannot grow world resources');
      return 'Front and north crossings each retain two fixed 30 HP packs on complete supported routes. Actual simulation preserves them at full health, heals the disclosed 65 HP fixture once per pack, and retry reuses all four props; ammunition is unchanged';
    }],
    ['Health supplies heal only when needed', () => {
      const pickup = HealPickups.list.find(entry => entry.zone === 'apartment');
      assert(pickup, 'The apartment must contain an authored health supply');
      HealPickups.restoreZone('apartment');
      placePlayer({ x: pickup.mesh.position.x, y: CHECKPOINTS.apartment.y, z: pickup.mesh.position.z });
      Player.health = 100;
      HealPickups.update(1 / 60);
      assert(pickup.active && pickup.mesh.visible, 'A full-health player must leave the supply available');
      Player.health = 100 - Math.min(pickup.amount, 8);
      HealPickups.update(1 / 60);
      near(Player.health, 100, 'Low health is restored without exceeding 100');
      assert(!pickup.active && !pickup.mesh.visible && !pickup.halo.visible, 'A collected supply hides mesh and halo');
      assert(restartFromZone(), 'Checkpoint retry must restore its supplies');
      assert(pickup.active && pickup.mesh.visible, 'Retry restores the authored health supply');
      return 'Full health preserves the pack; low health consumes it; retry restores it';
    }],
  ];

  async function runSuite() {
    if (busy || disposed) return;
    const lines = ['RUNNING · real game integration checks · authored encounter fixtures · audio locked off'];
    let failures = 0, passes = 0;
    const start = performance.now();
    let finished = false;
    const previousSeedOverride = EncounterSeeds.setOverride(null);
    function finish() {
      if (finished) return;
      finished = true;
      abortSuite = null;
      // Restore the exact previous mode before creating the apartment left
      // for ordinary play. Seed 0, authored null and random undefined differ.
      EncounterSeeds.setOverride(previousSeedOverride);
      try {
        freshApartment();
        ui.select.value = 'apartment';
        pausedRender();
        lines.push('RESTORED · Fresh apartment · prior encounter seed mode · full health · starting loadout · audio off');
      } catch (error) {
        failures++;
        lines.push(`FAIL · Final reset\n  ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        api.setTesting(false);
        setBusy(false);
      }
      lines[0] = `${failures ? 'FAILED' : 'PASSED'} · ${passes}/${tests.length} checks · ${((performance.now() - start) / 1000).toFixed(2)} s`;
      if (!disposed) report(failures ? 'fail' : 'pass', lines);
    }
    abortSuite = finish;
    try {
      setBusy(true);
      api.setTesting(true);
      pauseSilently();
      report('running', lines);
      for (const [name, run] of tests) {
        if (disposed) break;
        try {
          freshApartment();
          const detail = await run();
          if (disposed) break;
          assertSilent();
          lines.push(`PASS · ${name}\n  ${detail}`);
          passes++;
        } catch (error) {
          if (disposed) break;
          failures++;
          lines.push(`FAIL · ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (!disposed) {
            pauseSilently();
            api.setInspection(true);
          }
        }
        report('running', lines);
        // Yield to paint the visible report; this is not a timing assertion.
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    } catch (error) {
      if (!disposed) {
        failures++;
        lines.push(`FAIL · Suite interrupted\n  ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      finish();
    }
  }

  function inspect() {
    if (busy || disposed) return;
    try {
      checkpointAt(ui.select.value);
      document.body.classList.add('qa-scene-inspection');
      pausedRender();
      report('ready', sceneDescription(ui.select.value));
    } catch (error) {
      report('fail', error instanceof Error ? error.message : String(error));
    }
  }

  function inspectHealthWarning({ keepView = false } = {}) {
    if (busy || disposed) return;
    try {
      const health = Number(ui.healthSample.value);
      assert([100, 40, 39, 20, 19, 1].includes(health), 'Choose an explicit living-player health sample');
      if (keepView) {
        assert(!PlayerState.dead, 'Reset the scene before previewing a living-player health warning');
        pauseSilently();
        api.setInspection(true);
      } else checkpointAt(ui.select.value);
      visualFixtureActive = true;
      // A disclosed paused health fixture uses the normal HUD entry point.
      // It never invents enemy damage or carries reduced health into play.
      Player.health = health;
      HUD.setHealth(health);
      HUD.clearFeedback();
      pausedRender();
      const vignette = document.getElementById('healthvignette');
      assert(vignette, 'The production HUD must contain its persistent health cue');
      report('ready', [
        `HEALTH WARNING INSPECTION · ${health}% · ${HUD.snapshot().healthWarning} · simulation paused`,
        `Actual health ${Player.health} · HUD ${document.getElementById('healthbar').getAttribute('aria-valuenow')}`,
        `Screen cue ${vignette.hidden ? 'hidden' : 'visible'} · ${document.getElementById('healthwarning').textContent || 'no warning'}`,
        `Render: ${renderer.info.render.calls} calls · ${renderer.info.render.triangles.toLocaleString()} triangles`,
        'Persistent production overlay; transient blood flash cleared to isolate the health cue. No new 3D pass.',
        `Explicit health placement only, not enemy damage; ${keepView ? 'current paused view retained' : 'checkpoint view restored'}. Use Return to game menu to reset this fixture before ordinary play.`,
        'Audio locked off · no AudioContext',
      ]);
      assertSilent();
    } catch (error) { report('fail', error instanceof Error ? error.message : String(error)); }
  }

  function inspectFurniture({ kitchen = false } = {}) {
    if (busy || disposed) return;
    try {
      const zone = ['neighbor', 'bakery'].includes(ui.select.value) ? ui.select.value : 'apartment';
      checkpointAt(zone);
      ui.select.value = zone;
      visualFixtureActive = true;
      document.body.classList.add('qa-scene-inspection');
      if (zone === 'bakery') {
        Player.pos.set(-28.5, 1.70, 37.2);
        pointCameraAt({ x: -28.5, y: 1.32, z: 38.8 });
      } else if (kitchen && zone === 'neighbor') {
        Player.pos.set(4, 5.65, -3.8);
        pointCameraAt({ x: 5.4, y: 5.05, z: -0.6 });
      } else if (kitchen) {
        Player.pos.set(-12.3, 5.6, -3.7);
        pointCameraAt({ x: -14.4, y: 5.0, z: -3.9 });
      } else if (zone === 'neighbor') {
        Player.pos.set(5.4, 5.65, -5.8);
        pointCameraAt({ x: 6.8, y: 4.85, z: -8.9 });
      } else {
        Player.pos.set(-8.7, 5.6, -5.6);
        pointCameraAt({ x: -9, y: 4.85, z: -8.4 });
      }
      pausedRender();
      report('ready', [...sceneDescription(zone), 'Furniture framing is a paused review placement; reset before ordinary play.']);
    } catch (error) { report('fail', error instanceof Error ? error.message : String(error)); }
  }

  function inspectTelevision() {
    if (busy || disposed) return;
    try {
      checkpointAt('neighbor');
      ui.select.value = 'neighbor';
      visualFixtureActive = true;
      document.body.classList.add('qa-scene-inspection');
      Player.pos.set(6.6, 5.55, -8.2);
      pointCameraAt({ x: 7, y: 5.06, z: -6.99 });
      pausedRender();
      report('ready', [...sceneDescription('neighbor'), 'Television front is a paused review placement; reset before ordinary play.']);
    } catch (error) { report('fail', error instanceof Error ? error.message : String(error)); }
  }

  function inspectWorldObject() {
    if (busy || disposed) return;
    try {
      const type = ui.objectType.value;
      const zone = ['car', 'barrier', 'drops'].includes(type) ? 'street' : 'roof';
      freshApartment();
      controlledArea(zone);
      visualFixtureActive = true;
      ui.select.value = zone;
      document.body.classList.add('qa-scene-inspection');
      let specimen = null;
      const details = [];
      if (type === 'health') {
        const pickup = HealPickups.list.find(entry => entry.id === 'roof-front-west');
        assert(pickup?.active && pickup.mesh.visible, 'The authored roof health supply must be visible');
        specimen = pickup.mesh;
        specimen.position.y = pickup.baseY;
        specimen.rotation.y = 0;
        Player.pos.set(specimen.position.x + 0.39, specimen.position.y + 0.35, specimen.position.z + 0.46);
        pointCameraAt(specimen.position);
        details.push('Actual authored health supply; paused hover at its base height and zero yaw for comparison. No collection or health change.');
      } else if (['pistol', 'shotgun', 'smg', 'machinegun', 'knife'].includes(type)) {
        const anchor = { x: -12, y: ROOF.floorY, z: -5 };
        const drop = WeaponDrops.spawn(anchor.x, anchor.y, anchor.z, type, 12);
        assert(drop?.mesh, 'The production weapon drop path must return a visible specimen');
        specimen = drop.mesh;
        Object.assign(specimen.userData, placeWeaponDrop(specimen, type, anchor, Colliders.list, Math.PI / 6));
        if (drop.halo) { drop.halo.position.copy(specimen.position); drop.halo.position.y += 0.15; }
        const target = new Box3().setFromObject(specimen).getCenter(new Vector3());
        Player.pos.set(target.x + 0.6, target.y + 0.8, target.z + 0.8);
        pointCameraAt(target);
        details.push(`Production drop geometry and placement; deterministic heading only. Settled ${specimen.userData.settled} on floor ${specimen.userData.floorY.toFixed(3)} m. No pickup or ammunition transfer.`);
      } else if (type === 'drops') {
        for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
          const anchor = { x: 18 + column * 1.4, y: DISTRICT.street.road.floorY, z: 13 + row * 1.2 };
          const drop = WeaponDrops.spawn(anchor.x, anchor.y, anchor.z, 'machinegun', 12);
          Object.assign(drop.mesh.userData, placeWeaponDrop(drop.mesh, 'machinegun', anchor, Colliders.list, Math.PI / 6));
          assert(drop.mesh.userData.settled, 'Each specimen in the full drop pool must settle on the actual street');
          if (drop.halo) { drop.halo.position.copy(drop.mesh.position); drop.halo.position.y += 0.15; }
        }
        assert(WeaponDrops.list.length === 16, 'The full pickup fixture must match the production pool cap');
        Player.pos.set(20.1, 2.8, 10);
        pointCameraAt({ x: 20.1, y: 0.1, z: 14.8 });
        details.push('Sixteen actual machine-gun drops exercise the existing pool cap, shared assets and normal halo selection. No added lights or altered light budget; no collection.');
      } else if (type === 'car') {
        specimen = WorldState.car;
        assert(specimen, 'The finale sedan must exist');
        Player.pos.set(DISTRICT.car.x - 4, DISTRICT.car.y + 1.55, DISTRICT.car.z - 3.6);
        pointCameraAt({ x: DISTRICT.car.x, y: DISTRICT.car.y + 0.9, z: DISTRICT.car.z });
        details.push('Actual finale sedan, with its original environment lighting and material batches.');
      } else if (type === 'tank') {
        Player.pos.set(-11.5, ROOF.floorY + 3, -6.3);
        pointCameraAt({ x: -8, y: ROOF.floorY + 3.3, z: -2 });
        details.push('Actual rooftop water tank and support assembly.');
      } else if (type === 'barrier') {
        Player.pos.set(6.7, 1.45, 19.5);
        pointCameraAt({ x: 5, y: 0.57, z: 22.4 });
        details.push('Actual central street cover and fitted reflectors.');
      } else throw new Error('Choose an explicit world object');
      api.setInspection(true);
      pausedRender();
      assert(!Input.active && Enemies.list.length === 0, 'Object review must contain no active simulation or enemies');
      if (specimen) {
        let triangles = 0, draws = 0;
        specimen.traverseVisible(object => {
          if (!object.isMesh) return;
          triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
          draws += Array.isArray(object.material) ? object.geometry.groups.length : 1;
        });
        details.push(`Specimen: ${triangles.toLocaleString()} triangles · ${draws} material groups (render passes may multiply draws).`);
      }
      report('ready', [`WORLD OBJECT INSPECTION · ${type} · simulation paused`, ...sceneDescription(zone), ...details,
        'Explicit camera/placement fixture; use Return to game menu to reset before ordinary play.']);
      assertSilent();
    } catch (error) { report('fail', error instanceof Error ? error.message : String(error)); }
  }

  function inspectActor({ rotate = 0, advance = false } = {}) {
    if (busy || disposed) return;
    try {
      pauseSilently();
      if (!inspectedActor?.alive || inspectedActor.type !== ui.actorType.value) {
        freshApartment();
        controlledArea('balcony');
        // The uncovered gallery uses the real environment lighting. No
        // inspector lights, exposure changes or material overrides are added.
        placeOnClearFloor({ x: 10.5, y: BALCONY.floorY, z: BALCONY.laneZ });
        inspectedActor = spawnFixtureEnemy(ui.actorType.value, { x: 7, y: BALCONY.floorY, z: BALCONY.laneZ }, 'balcony');
        // This paused specimen stands exactly on the authored floor, without
        // the small spawn clearance used before the first physics step.
        inspectedActor.pos.y = BALCONY.floorY;
        inspectedActor.mesh.position.copy(inspectedActor.pos);
        inspectedActor.mesh.rotation.set(0, Math.PI / 2, 0);
        ui.select.value = 'balcony';
      }
      api.setInspection(true);
      setNPCInspection(true);
      inspectedActor.mesh.rotation.y += rotate;
      const pose = ui.actorPose.value;
      if (!advance) resetHumanoidPose(inspectedActor.mesh);
      if (pose !== 'neutral') {
        const state = poseForEnemy(inspectedActor, pose);
        for (let frame = 0; frame < (advance ? 6 : 30); frame++) updateHumanoidPose(inspectedActor.mesh, state, 1 / 60);
      }
      assertRigSegments(inspectedActor.mesh, `${inspectedActor.type} inspection`);
      const framing = ui.actorFraming.value;
      const actorPosition = inspectedActor.pos, height = inspectedActor.height;
      // Close framing is an explicit paused camera placement, never a playable
      // body position. The specimen guard requires a reset before normal play.
      if (framing === 'lowface') {
        Player.pos.set(actorPosition.x + 0.58, BALCONY.floorY + height * 0.78, actorPosition.z + 0.06);
        pointCameraAt({ x: actorPosition.x, y: BALCONY.floorY + height * 0.925, z: actorPosition.z });
      } else if (framing === 'face') {
        Player.pos.set(actorPosition.x + 0.55, BALCONY.floorY + height * 0.925, actorPosition.z + 0.06);
        pointCameraAt({ x: actorPosition.x, y: BALCONY.floorY + height * 0.925, z: actorPosition.z });
      } else if (framing === 'portrait') {
        Player.pos.set(actorPosition.x + 0.95, BALCONY.floorY + height * 0.91, actorPosition.z + 0.18);
        pointCameraAt({ x: actorPosition.x, y: BALCONY.floorY + height * 0.89, z: actorPosition.z });
      } else if (framing === 'grip') {
        Player.pos.set(actorPosition.x + 1.15, BALCONY.floorY + height * 0.72, actorPosition.z + 0.65);
        pointCameraAt({ x: actorPosition.x + 0.25, y: BALCONY.floorY + height * 0.69, z: actorPosition.z });
      } else {
        Player.pos.set(actorPosition.x + 3.5, BALCONY.floorY + Player.eyeHeight + 0.02, actorPosition.z);
        pointCameraAt({ x: actorPosition.x, y: BALCONY.floorY + height * 0.57, z: actorPosition.z });
      }
      pausedRender();
      const rig = inspectedActor.mesh.userData.rig;
      const soles = ['L', 'R'].map(side => rig.anchors[`sole${side}`].getWorldPosition(new Vector3()).y - BALCONY.floorY);
      report('ready', [
        `NPC INSPECTION · ${inspectedActor.type} · ${pose} · simulation paused`,
        `Actual pooled rig v${rig.version} · ${Object.keys(rig.joints).length} joints · ${rig.height.toFixed(2)} m height`,
        ...(rig.hero ? [`Character surface: ${rig.hero.triangles.toLocaleString()} triangles · ${rig.hero.draws} visible body draws · ${rig.hero.contactSamples} bounded collapse samples`] : []),
        `Pose ${rig.pose.mode} / ${rig.pose.phase} · sole height L ${soles[0].toFixed(3)} m, R ${soles[1].toFixed(3)} m`,
        `Facing ${(inspectedActor.mesh.rotation.y * 180 / Math.PI).toFixed(0)}° · held prop ${inspectedActor.def.weaponType}`,
        `Framing ${framing} · same camera FOV and production materials; inspection placement only`,
        `Quality ${Settings.get('quality')} · ${renderer.domElement.width} × ${renderer.domElement.height} drawing buffer · ratio ${renderer.getPixelRatio().toFixed(2)}`,
        'The actor uses the production pose driver; AI and damage are paused. Advance pose moves only this visible specimen.',
        'Uncovered wrap walkway · unchanged environment lighting · transient HUD overlays hidden for inspection only',
        'Audio locked off · no AudioContext',
      ]);
      assertSilent();
    } catch (error) {
      setNPCInspection(false);
      report('fail', error instanceof Error ? error.message : String(error));
    }
  }

  function inspectRoofTransition(outside = false) {
    if (busy || disposed) return;
    try {
      freshApartment();
      const zone = outside ? 'roof' : 'stairwell';
      controlledArea(zone);
      placeOnClearFloor({ x: outside ? STAIRS.roofExit[0] + 0.6 : STAIRS.lanes.east,
        y: STAIRS.exitY, z: (STAIRS.roofDoor.min[2] + STAIRS.roofDoor.max[2]) / 2,
        yaw: outside ? Math.PI / 2 : -Math.PI / 2 });
      visualFixtureActive = true;
      ui.select.value = zone;
      document.body.classList.add('qa-transition-inspection');
      ui.panel.dataset.mode = 'transition-inspection';
      api.setInspection(true);
      pausedRender();
      assert(!Input.active && Enemies.list.length === 0, 'Threshold inspection must contain no active simulation or enemies');
      report('ready', [
        `ROOF THRESHOLD INSPECTION · ${outside ? 'outside looking into the stairwell' : 'inside looking onto the roof'}`,
        `Actual shared floor ${STAIRS.exitY.toFixed(2)} m · camera at ${Player.pos.toArray().map(value => value.toFixed(2)).join(', ')}`,
        'Paused placement fixture · original geometry, lighting and presentation · no AI or attacks',
        'Run the regression suite for actual input-driven crossing and rendered-floor overlap checks.',
        'Audio locked off · use Return to game menu to leave this fixture safely',
      ]);
      assertSilent();
    } catch (error) {
      setNPCInspection(false);
      report('fail', error instanceof Error ? error.message : String(error));
    }
  }

  function inspectRoofLight(exit = false) {
    if (busy || disposed) return;
    try {
      checkpointAt('roof');
      visualFixtureActive = true;
      ui.select.value = 'roof';
      document.body.classList.add('qa-scene-inspection');
      if (exit) {
        Player.pos.set(22, 15.65, -0.8);
        pointCameraAt({ x: 24.68, y: 14.85, z: -3.55 });
      } else {
        Player.pos.set(-2.3, 15.65, -5);
        pointCameraAt({ x: 0.4, y: 15.45, z: -9.9 });
      }
      pausedRender();
      report('ready', [...sceneDescription('roof'),
        `Roof ${exit ? 'exit' : 'service-door'} light framing; paused review placement, original production exposure and point-light pool.`]);
    } catch (error) { report('fail', error instanceof Error ? error.message : String(error)); }
  }

  function inspectHeldWeapon({ next = false } = {}) {
    if (busy || disposed) return;
    try {
      pauseSilently();
      if (!inspectedWeapon) {
        freshApartment();
        controlledArea('balcony');
        placeOnClearFloor({ x: 7, y: BALCONY.floorY, z: BALCONY.laneZ, yaw: Math.PI / 2 });
        inspectedWeapon = { restoreWeapon: Weapons.snapshot() };
        visualFixtureActive = true;
        ui.select.value = 'balcony';
      }
      if (next) ui.heldPose.value = HELD_POSES[(HELD_POSES.indexOf(ui.heldPose.value) + 1) % HELD_POSES.length];
      const type = ui.heldType.value, pose = ui.heldPose.value;
      const ranged = WEAPON_DEFS[type].kind === 'ranged';
      const timing = ranged ? null : meleeTiming(type);
      const contactPhase = ranged ? 0.5 : WEAPON_DEFS[type].contactPhase;
      const progress = { ready: 0, windup: contactPhase * 0.45, contact: contactPhase,
        followthrough: contactPhase + (1 - contactPhase) * 0.35,
        recovery: contactPhase + (1 - contactPhase) * 0.82 }[pose];
      Weapons.restore({ current: type, loaded: 0, reserve: 0 });
      Weapons.cancelAttack();
      Weapons.aimBlend = ranged && ui.heldAim.value === 'aim' ? 1 : 0;
      // This explicit, paused visual fixture changes only the production
      // view-model's pose clock. It never starts a gameplay attack or AI tick.
      Weapons.swingT = pose === 'ready' ? 0 : 1 - progress;
      Weapons.punchIndex = ui.heldSide.value === 'left' ? 1 : 0;
      document.body.classList.remove('qa-scene-inspection', 'qa-npc-inspection');
      document.body.classList.add('qa-held-inspection');
      ui.panel.dataset.mode = 'held-inspection';
      const before = { time: GameTime.elapsed, health: Player.health, combat: CombatStats.snapshot() };
      api.setInspection(true);
      pausedRender();
      near(api.stepFrame(0.25), 0, 'A paused held-weapon inspection cannot advance gameplay');
      same({ time: GameTime.elapsed, health: Player.health, combat: CombatStats.snapshot() }, before,
        'Changing a held pose cannot simulate AI, damage, ammunition or combat credit');
      assert(!Weapons.melee.active && !Input.active && Enemies.list.length === 0,
        'The held-weapon specimen must contain no pending attack or NPC');
      const model = Weapons.vmGroup?.children[0];
      assert(model?.name === `vm_${type}` && Weapons.vmGroup.parent === camera,
        'The specimen must be the actual equipped first-person model');
      for (let object = model; object; object = object.parent) assert(object.visible,
        'The held specimen and all of its scene ancestors must be visible');
      let meshes = 0, triangles = 0;
      Weapons.vmGroup.traverseVisible(object => {
        if (object.isMesh) {
          meshes++;
          triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3
            * (object.isInstancedMesh ? object.count : 1);
        }
        assert([...object.position.toArray(), ...object.quaternion.toArray(), ...object.scale.toArray()].every(Number.isFinite),
          `${type} held pose contains a non-finite transform`);
      });
      assert(meshes > 0, 'The held-weapon specimen must contain visible geometry');
      report('ready', [
        `HELD WEAPON INSPECTION · ${WEAPON_DEFS[type].name} · ${pose} · simulation paused`,
        `${meshes} actual view-model meshes · ${triangles.toLocaleString()} triangles · ${type === 'fists' ? ui.heldSide.value + ' punch · ' : ''}pose ${(progress * 100).toFixed(0)}%`,
        `Quality ${Settings.get('quality')} · ${renderer.domElement.width} × ${renderer.domElement.height} drawing buffer · ratio ${renderer.getPixelRatio().toFixed(2)}`,
        ranged ? `Firearm framing: ${ui.heldAim.value} · static recoil sample only; no shots or reloads executed`
          : `Authored duration ${(timing.duration * 1000).toFixed(0)} ms · contact ${(timing.contactAt * 1000).toFixed(0)} ms`,
        'Visual fixture only: the pose clock is selected directly; no attack, NPC update or damage is executed.',
        'Uncovered balcony · unchanged environment lighting · leaving inspection clears the visual clock and fixture loadout',
        'Audio locked off · no AudioContext',
      ]);
      assertSilent();
    } catch (error) {
      try { freshApartment(); ui.select.value = 'apartment'; }
      catch { /* Keep the original inspection error visible. */ }
      report('fail', error instanceof Error ? error.message : String(error));
    }
  }

  function turn(yaw, pitch) {
    if (busy || disposed) return;
    pauseSilently();
    api.setInspection(true);
    Player.yaw += yaw;
    Player.pitch = Math.max(-1.25, Math.min(1.25, Player.pitch + pitch));
    pausedRender();
    report('ready', sceneDescription(ui.select.value));
  }

  function benchmark({ combat = false, balcony = false, roof = false, sweep = false } = {}) {
    if (busy || disposed) return;
    combat ||= balcony || roof;
    pauseSilently();
    setNPCInspection(false);
    api.setTesting(true);
    setBusy(true);
    const reviewDirection = { yaw: Player.yaw, pitch: Player.pitch };
    let fixture = null;
    try {
      api.setInspection(true);
      if (combat) fixture = balcony ? prepareBalconyCombatFixture() : prepareCombatFixture({ roof });
      assertSilent();
    } catch (error) {
      pauseSilently();
      if (combat) {
        try { freshApartment(); ui.select.value = 'apartment'; }
        catch { /* Preserve the original setup failure in the visible report. */ }
      }
      api.setTesting(false);
      setBusy(false);
      report('fail', `BENCHMARK SETUP FAILED · ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    report('running', combat ? [
      `${balcony ? 'BALCONY MELEE' : roof ? 'ROOFTOP COMBAT' : 'STREET COMBAT'} BENCHMARK · 0.5 s warmup, then 10 s measured simulation + rendering`,
      balcony ? `Fixed balcony camera; actual brawler and bat thug, respawned on death; real bat input every 0.8 s, ${(meleeTiming('bat').contactAt * 1000).toFixed(0)} ms contact delay and capsule-safety assertions.`
        : roof ? 'Fixed rooftop camera; 5 actual mixed-weapon contacts, respawned on death; automatic SMG fire, timed reloads and world-collision assertions.'
        : 'Fixed street camera; 4 actual contacts, respawned on death; automatic SMG fire and normal timed reloads.',
      'Player health is replenished between frames for this fixture. Keep this tab visible. Audio is locked off.',
    ] : sweep ? 'CAMERA SWEEP · 0.5 s warmup, then a measured 10 s full turn with a gentle vertical sweep.\nPaused review camera only, not gameplay movement or input-latency measurement. Audio is locked off.'
      : 'BENCHMARK · 0.5 s warmup, then 10 s measured rendering\nKeep this tab visible. Gameplay is paused; audio is locked off.');
    const intervals = [], frameTimes = [], callbackTimes = [], simulationTimes = [], renderTimes = [], calls = [], triangles = [];
    const lateIntervals = [], healthCue = document.getElementById('healthvignette');
    let previousCpuMs = null, previousCallbackCpuMs = null, resourcesBefore = null;
    const liveContacts = [], attackingContacts = [];
    const presentationProfiles = new Map();
    const longTasks = [];
    let taskObserver = null, measurementStart = null;
    const Observer = globalThis.PerformanceObserver;
    if (Observer?.supportedEntryTypes?.includes('longtask')) {
      try {
        taskObserver = new Observer(list => longTasks.push(...list.getEntries()));
        taskObserver.observe({ type: 'longtask' });
      } catch {
        taskObserver?.disconnect();
        taskObserver = null;
      }
    }
    api.gpuTimer?.reset();
    api.gpuTimer?.setEnabled(true);
    let warmupStart = null, start = null, previous = null, previousFrame = null, frameId = null;
    let finished = false;
    const zone = getMissionState().zone;
    const timeout = setTimeout(() => finish(new Error('Benchmark interrupted: insufficient visible animation frames')), 20_000);

    // Copy only scalar counters at the two measurement boundaries. These are
    // retained resources, not GPU byte usage or a shader-compilation trace.
    function resourceSnapshot() {
      const count = value => Number.isFinite(value) && value >= 0 ? value : null;
      let heap = null;
      try {
        const memory = performance.memory;
        if (memory) {
          const usedJSHeapSize = count(memory.usedJSHeapSize);
          const totalJSHeapSize = count(memory.totalJSHeapSize);
          const jsHeapSizeLimit = count(memory.jsHeapSizeLimit);
          if (usedJSHeapSize !== null && totalJSHeapSize !== null && jsHeapSizeLimit !== null) {
            heap = { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit };
          }
        }
      } catch { /* Optional browser heap diagnostics can be unavailable. */ }
      return {
        renderer: {
          geometries: count(renderer.info.memory?.geometries),
          textures: count(renderer.info.memory?.textures),
          retainedPrograms: count(renderer.info.programs?.length),
        },
        heap,
      };
    }

    async function finish(error = null) {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frameId);
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('resize', onBenchmarkResize);
      abortBenchmark = null;
      const measurementEnd = performance.now();
      const resourcesAfter = measurementStart === null ? null : resourceSnapshot();
      // A long-task entry for this final rAF callback is queued only after
      // its task finishes. Yield once before collecting, without extending
      // the measurement or including the later fixture reset/report work.
      if (taskObserver && !disposed) await new Promise(resolve => setTimeout(resolve, 0));
      if (taskObserver) {
        longTasks.push(...taskObserver.takeRecords());
        taskObserver.disconnect();
      }
      if (disposed) return;
      const gpu = api.gpuTimer?.snapshot();
      api.gpuTimer?.setEnabled(false);
      pauseSilently();
      let result = null;
      try {
        if (!error) {
          assertSilent();
          assert(intervals.length >= 2, 'Not enough real animation frames to calculate statistics');
          assert(callbackTimes.length === intervals.length, 'Every measured interval must have one QA callback sample');
          const time = summarize(intervals), cpu = summarize(frameTimes), renderCpu = summarize(renderTimes);
          const callbackCpu = summarize(callbackTimes);
          const draw = summarize(calls), geometry = summarize(triangles);
          const elapsed = intervals.reduce((sum, value) => sum + value, 0);
          result = [
            `${balcony ? 'CONTROLLED BALCONY MELEE' : roof ? 'CONTROLLED ROOFTOP COMBAT' : combat ? 'CONTROLLED COMBAT' : sweep ? 'PAUSED CAMERA SWEEP' : 'PAUSED SCENE'} BENCHMARK MEASURED · ${ZONE_LABELS[zone] ?? zone}`,
            `${intervals.length} real rAF intervals · ${(elapsed / 1000).toFixed(2)} s measured`,
            `Frame time: median ${time.median.toFixed(2)} ms · p95 ${time.p95.toFixed(2)} ms · p99 ${time.p99.toFixed(2)} ms · average ${time.average.toFixed(2)} ms`,
            `Maximum rAF interval: ${time.maximum.toFixed(2)} ms · maximum sampled CPU section: ${cpu.maximum.toFixed(2)} ms`,
            `Measured rate: ${(1000 / time.average).toFixed(1)} FPS average · ${(1000 / time.median).toFixed(1)} FPS median`,
            `Frames over budget: ${intervals.filter(value => value > 16.9).length}/${intervals.length} over 16.9 ms · ${intervals.filter(value => value > 33.5).length} over 33.5 ms · ${intervals.filter(value => value > 50).length} over 50 ms`,
            `${combat ? 'Fixture + simulation + render' : 'Render'} CPU: median ${cpu.median.toFixed(2)} ms · p95 ${cpu.p95.toFixed(2)} ms · average ${cpu.average.toFixed(2)} ms`,
            `Full sampled QA callback CPU: p95 ${callbackCpu.p95.toFixed(2)} ms · maximum ${callbackCpu.maximum.toFixed(2)} ms · ${callbackTimes.length} samples`,
            'Callback elapsed time includes pre-render checks and post-render QA bookkeeping; excludes final reporting/reset, separate main-loop/gamepad work, other callbacks, browser paint/compositor, and time between callbacks.',
            `Renderer: ${draw.average.toFixed(0)} calls/frame · ${geometry.average.toFixed(0)} triangles/frame`,
            `Renderer resource counts: ${JSON.stringify({ before: resourcesBefore?.renderer, after: resourcesAfter?.renderer })}`,
            `Optional JS heap bytes (performance.memory): ${JSON.stringify({ before: resourcesBefore?.heap ?? 'unavailable', after: resourcesAfter?.heap ?? 'unavailable' })}`,
            'Resource snapshots: after warmup → measurement end, before reporting/reset. Null resource counts are unavailable; programs are retained cache entries. Counts are not GPU memory or compilation timing; optional browser-reported heap includes QA data. Stable endpoints do not rule out transient allocations, compilation, or garbage collection.',
            `Viewport: ${innerWidth} × ${innerHeight} CSS px · render ratio ${renderer.getPixelRatio().toFixed(2)}`,
            ...graphicsDescription(),
          ];
          if (gpu?.sampleCount) {
            result.push(`GPU elapsed: median ${gpu.medianMs.toFixed(2)} ms · p95 ${gpu.p95Ms.toFixed(2)} ms · ${gpu.sampleCount} completed samples (${gpu.totalSamples} total)`,
              `GPU queries: ${gpu.pendingQueries} pending · ${gpu.skippedFrames} skipped frames · ${gpu.disjointEvents} disjoint events · ${gpu.discardedQueries} discarded results`);
          } else result.push(`GPU elapsed unavailable (${gpu?.status ?? 'not-instrumented'}); CPU submission time is not GPU time.`);
          if (taskObserver) {
            const measuredTasks = longTasks.filter(entry => entry.startTime >= measurementStart && entry.startTime < measurementEnd);
            result.push(`Main-thread long tasks: ${measuredTasks.length} · ${measuredTasks.reduce((sum, entry) => sum + entry.duration, 0).toFixed(1)} ms total during measurement`);
          } else result.push('Main-thread long-task API unavailable; no long-task score inferred.');
          for (const { profile, frames } of presentationProfiles.values()) {
            if (!profile) {
              result.push(`Presentation metadata unavailable for ${frames} sampled frames; no AO configuration inferred.`);
              continue;
            }
            const targets = profile.enabled ? 'active' : profile.allocated ? 'cached, inactive' : 'unallocated';
            result.push(
              `Presentation (${frames} frames): quality ${profile.quality} · AO ${profile.enabled ? 'ON' : 'OFF'} (${profile.reason}) · ${profile.worldPasses} world + ${profile.postPasses} post passes`,
              `Drawing buffer: ${profile.bufferWidth} × ${profile.bufferHeight} px · ratio ${profile.pixelRatio.toFixed(2)}`,
              `Targets (${targets}): beauty ${profile.width} × ${profile.height} px · AO ${profile.aoWidth} × ${profile.aoHeight} px`,
              `Samples: AO ${profile.aoSamples} · denoise ${profile.denoiseSamples} · target MSAA ${profile.msaaSamples}`,
              `Shadow crop fraction: ${profile.shadowFraction ?? 'unavailable'} · baked interiors ${profile.interiorLighting ? 'ON' : 'OFF'}`,
            );
          }
          if (presentationProfiles.size > 1) result.push('Timing spans the presentation configurations listed above.');
          result.push('Render ratio held at the start value during this controlled measurement.');
          result.push(`Review scale: ${ui.renderScale.value === 'device' ? 'device/preset' : 'explicit QA override, not a device capability claim'}.`);
          result.push(`Health screen cue: ${healthCue?.dataset.level ?? 'unavailable'} · current player health ${Player.health.toFixed(2)}`);
          if (lateIntervals.length) {
            result.push(`Late interval samples (first 32): ${JSON.stringify(lateIntervals)}`,
              'rAF intervals span callbacks; previous/current CPU sections, full QA callback times, and view metadata are diagnostic context, not causal attribution. GPU completions are asynchronous and unpaired.');
          }
          if (combat) {
            const measured = fixture.measurement(), simulationCpu = summarize(simulationTimes);
            assert(measured.elapsed > 0 && (balcony ? measured.strikes > 0 && measured.hits > 0 : measured.shots > 0),
              'Combat benchmark must advance real simulation and produce actual weapon contacts');
            assert(Math.max(...attackingContacts) > 0, 'Combat benchmark must execute attacking NPC behavior');
            result.push(
              `Simulation CPU: median ${simulationCpu.median.toFixed(2)} ms · p95 ${simulationCpu.p95.toFixed(2)} ms`,
              `Render CPU: median ${renderCpu.median.toFixed(2)} ms · p95 ${renderCpu.p95.toFixed(2)} ms`,
              `${measured.elapsed.toFixed(2)} s simulated · ${balcony ? measured.strikes + ' actual bat swings' : measured.shots + ' actual shots'} · ${measured.hits} hits · ${measured.kills} kills`,
              `${Math.min(...liveContacts)}–${Math.max(...liveContacts)} live contacts · ${measured.respawns} replacement spawns · up to ${Math.max(...attackingContacts)} NPCs attacking`,
              `Fixture: fixed camera; player health replenished ${measured.healthRestores} times (${measured.absorbedDamage.toFixed(0)} damage absorbed); ${balcony ? 'player/NPC floor and capsule safety checked every frame.' : 'real magazines and reloads.'}`,
              'Controlled workload, not an ordinary playthrough or an input-latency/INP score. The simulation retains its normal stall limits.',
            );
            if (balcony) result.push(`Bat timeline: ${(meleeTiming('bat').duration * 1000).toFixed(0)} ms swing · ${(meleeTiming('bat').contactAt * 1000).toFixed(0)} ms to contact; hits count actual target-health changes.`);
          } else {
            result.push('This is a paused-scene render measurement, not a combat or input-latency/INP score.');
            if (sweep) result.push('Camera completed a 360° yaw sweep with ±7° pitch; original viewing direction restored afterward. No player movement or input latency inferred.');
          }
          result.push('Audio locked off on every sampled frame · no AudioContext');
        }
      } catch (failure) { error = failure; }
      if (combat) {
        try {
          freshApartment();
          ui.select.value = 'apartment';
          pausedRender();
          result?.push('RESTORED · Fresh apartment · starting loadout · full health · no fixture enemies or effects');
        } catch (failure) {
          error = new Error(`${error ? error.message + '; ' : ''}Final reset failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      } else if (sweep) {
        try {
          Player.yaw = reviewDirection.yaw; Player.pitch = reviewDirection.pitch;
          pausedRender();
        } catch (failure) { error = failure; }
      }
      api.setTesting(false);
      setBusy(false);
      if (error) {
        report('fail', `BENCHMARK INCOMPLETE · ${error instanceof Error ? error.message : String(error)}\nNo performance result was fabricated.`);
      } else {
        report('pass', result);
      }
    }
    function onVisibility() {
      if (document.hidden) finish(new Error('Tab became hidden; rerun while it stays visible'));
    }
    function onBenchmarkResize() {
      finish(new Error('Viewport resized during measurement; rerun at a fixed viewport'));
    }
    function sample(timestamp) {
      const callbackStart = performance.now();
      if (finished || disposed) return;
      if (document.hidden) { finish(new Error('Tab is hidden')); return; }
      try {
        let measuredFrame = false, measurementComplete = false, lateContext = null;
        assertSilent();
        assert(!renderer.getContext().isContextLost(), 'Graphics context was lost during measurement');
        const dt = previousFrame === null ? 0 : (timestamp - previousFrame) / 1000;
        previousFrame = timestamp;
        const before = performance.now();
        let simulationTime = 0, contactState = null, renderStart;
        if (combat) {
          fixture.prepareFrame();
          const simulationStart = performance.now();
          api.stepFrame(dt);
          simulationTime = performance.now() - simulationStart;
          contactState = fixture.afterFrame();
          renderStart = performance.now();
          api.render();
        } else {
          assert(!Input.active, 'Gameplay was resumed during the paused-scene benchmark');
          if (sweep) {
            const progress = start === null ? 0 : Math.min(1, (timestamp - start) / BENCHMARK_MS);
            Player.yaw = reviewDirection.yaw + progress * Math.PI * 2;
            Player.pitch = reviewDirection.pitch + Math.sin(progress * Math.PI * 4) * Math.PI / 26;
          }
          renderStart = performance.now();
          pausedRender();
        }
        const after = performance.now();
        const renderTime = after - renderStart, frameTime = after - before;
        if (warmupStart === null) warmupStart = timestamp;
        if (timestamp - warmupStart >= WARMUP_MS) {
          if (start === null) {
            start = timestamp;
            measurementStart = performance.now();
            previous = timestamp;
            previousCpuMs = frameTime;
            api.gpuTimer?.reset();
            fixture?.markMeasured();
            resourcesBefore = resourceSnapshot();
          }
          else {
            measuredFrame = true;
            const interval = timestamp - previous;
            intervals.push(interval);
            frameTimes.push(frameTime);
            simulationTimes.push(simulationTime);
            renderTimes.push(renderTime);
            calls.push(renderer.info.render.calls);
            triangles.push(renderer.info.render.triangles);
            // Capture the actual renderer configuration after the measured
            // CPU section. rAF timings still include this QA bookkeeping.
            const graphicsMetrics = api.metrics?.() ?? {}, presentation = graphicsMetrics.presentation;
            const profile = presentation ? {
              enabled: presentation.enabled, allocated: presentation.allocated,
              quality: presentation.quality, reason: presentation.reason,
              width: presentation.size.width, height: presentation.size.height,
              aoWidth: presentation.aoSize.width, aoHeight: presentation.aoSize.height,
              aoSamples: presentation.aoSamples, denoiseSamples: presentation.denoiseSamples,
              msaaSamples: presentation.msaaSamples,
              worldPasses: presentation.worldPasses, postPasses: presentation.postPasses,
              bufferWidth: renderer.domElement.width, bufferHeight: renderer.domElement.height,
              pixelRatio: renderer.getPixelRatio(),
              shadowFraction: graphicsMetrics.focusedShadows?.fraction,
              interiorLighting: graphicsMetrics.interiorLighting?.enabled ?? false,
            } : null;
            const profileKey = JSON.stringify(profile);
            const recorded = presentationProfiles.get(profileKey);
            if (recorded) recorded.frames++;
            else presentationProfiles.set(profileKey, { profile, frames: 1 });
            if (interval > 16.9 && lateIntervals.length < 32) {
              lateContext = {
                sample: intervals.length, elapsedMs: Number((timestamp - start).toFixed(2)),
                intervalMs: Number(interval.toFixed(2)), previousCpuMs: Number(previousCpuMs.toFixed(2)),
                currentCpuMs: Number(frameTime.toFixed(2)),
                previousCallbackCpuMs: Number(previousCallbackCpuMs.toFixed(2)), currentCallbackCpuMs: null,
                yawDegrees: Number((Player.yaw * 180 / Math.PI).toFixed(2)),
                pitchDegrees: Number((Player.pitch * 180 / Math.PI).toFixed(2)),
                shadowFraction: profile?.shadowFraction ?? null, healthWarning: healthCue?.dataset.level ?? null,
              };
              lateIntervals.push(lateContext);
            }
            previousCpuMs = frameTime;
            if (contactState) {
              liveContacts.push(contactState.alive);
              attackingContacts.push(contactState.attacking);
            }
            previous = timestamp;
            measurementComplete = timestamp - start >= BENCHMARK_MS;
          }
        }
        if (!measurementComplete) frameId = requestAnimationFrame(sample);
        // Keep this end clock before finish(): without the long-task observer,
        // finish can synchronously report and reset the entire combat fixture.
        // Recording the clock itself is the only per-frame bookkeeping below it.
        const callbackTime = performance.now() - callbackStart;
        if (measuredFrame) callbackTimes.push(callbackTime);
        if (lateContext) lateContext.currentCallbackCpuMs = Number(callbackTime.toFixed(2));
        previousCallbackCpuMs = callbackTime;
        if (measurementComplete) finish();
      } catch (error) { finish(error); }
    }
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('resize', onBenchmarkResize);
    abortBenchmark = () => finish(new Error('QA panel was disposed'));
    frameId = requestAnimationFrame(sample);
  }

  ui.button(ui.inspectionRow, 'Inspect area', 'qa-inspect', inspect);
  ui.button(ui.inspectionRow, 'Inspect furniture', 'qa-furniture-inspect', inspectFurniture);
  ui.button(ui.inspectionRow, 'Inspect kitchen finishes', 'qa-kitchen-inspect', () => inspectFurniture({ kitchen: true }));
  ui.quality.addEventListener('change', () => {
    if (busy || disposed) return;
    Settings.set('quality', ui.quality.value);
    applyReviewScale();
    pauseSilently();
    api.setInspection(true);
    pausedRender();
    report('ready', sceneDescription(ui.select.value));
  });
  ui.renderScale.addEventListener('change', () => {
    if (busy || disposed) return;
    pauseSilently();
    applyReviewScale();
    api.setInspection(true);
    pausedRender();
    report('ready', sceneDescription(ui.select.value));
  });
  ui.surfaceMode.addEventListener('change', () => {
    if (busy || disposed) return;
    pauseSilently();
    const params = new URLSearchParams(location.search);
    params.set('surfaces', ui.surfaceMode.value);
    // A fresh boot avoids keeping both full texture sets resident during A/B.
    location.search = params.toString();
  });
  for (const [control, setter] of [[ui.interiorLight, 'setInteriorLightingEnabled'],
    [ui.interiorReflection, 'setInteriorReflectionsEnabled'], [ui.heroFace, 'setHeroFaceTextureEnabled'],
    [ui.focusedShadow, 'setFocusedShadowsEnabled'], [ui.roofTaskLight, 'setRoofTaskLightingEnabled']]) {
    control.addEventListener('change', () => {
      if (busy || disposed) return;
      pauseSilently();
      api[setter]?.(control.checked);
      api.setInspection(true);
      pausedRender();
      report('ready', sceneDescription(ui.select.value));
    });
  }
  ui.button(ui.inspectionRow, 'Inspect roof threshold', 'qa-transition-inspect', () => inspectRoofTransition());
  ui.button(ui.inspectionRow, 'Inspect television front', 'qa-television-inspect', inspectTelevision);
  ui.button(ui.inspectionRow, 'View threshold from roof', 'qa-transition-outside', () => inspectRoofTransition(true));
  ui.button(ui.inspectionRow, 'Inspect roof service light', 'qa-roof-service-light', () => inspectRoofLight());
  ui.button(ui.inspectionRow, 'Inspect roof exit light', 'qa-roof-exit-light', () => inspectRoofLight(true));
  ui.button(ui.directions, 'Look left', 'qa-look-left', () => turn(Math.PI / 4, 0));
  ui.button(ui.directions, 'Look right', 'qa-look-right', () => turn(-Math.PI / 4, 0));
  ui.button(ui.directions, 'Look up', 'qa-look-up', () => turn(0, Math.PI / 12));
  ui.button(ui.directions, 'Look down', 'qa-look-down', () => turn(0, -Math.PI / 12));
  ui.button(ui.actorActions, 'Inspect NPC', 'qa-npc-inspect', () => inspectActor());
  ui.button(ui.actorActions, 'Rotate NPC left', 'qa-npc-left', () => inspectActor({ rotate: Math.PI / 4 }));
  ui.button(ui.actorActions, 'Rotate NPC right', 'qa-npc-right', () => inspectActor({ rotate: -Math.PI / 4 }));
  ui.button(ui.actorActions, 'Advance pose', 'qa-npc-advance', () => inspectActor({ advance: true }));
  ui.button(ui.heldActions, 'Inspect held weapon', 'qa-held-inspect', () => inspectHeldWeapon());
  ui.button(ui.heldActions, 'Next attack pose', 'qa-held-next', () => inspectHeldWeapon({ next: true }));
  ui.button(ui.objectActions, 'Inspect world object', 'qa-object-inspect', inspectWorldObject);
  ui.button(ui.healthActions, 'Inspect health warning', 'qa-health-inspect', inspectHealthWarning);
  ui.button(ui.healthActions, 'Preview health in current view', 'qa-health-current', () => inspectHealthWarning({ keepView: true }));
  ui.button(ui.actions, 'Run regression suite', 'qa-run', runSuite);
  ui.button(ui.actions, 'Benchmark 10 seconds', 'qa-benchmark', () => benchmark());
  ui.button(ui.actions, 'Benchmark camera sweep 10 seconds', 'qa-sweep-benchmark', () => benchmark({ sweep: true }));
  ui.button(ui.actions, 'Benchmark combat 10 seconds', 'qa-combat-benchmark', () => benchmark({ combat: true }));
  ui.button(ui.actions, 'Benchmark balcony melee 10 seconds', 'qa-balcony-benchmark', () => benchmark({ balcony: true }));
  ui.button(ui.actions, 'Benchmark rooftop combat 10 seconds', 'qa-roof-benchmark', () => benchmark({ roof: true }));
  ui.button(ui.actions, 'Reset apartment', 'qa-reset', () => {
    try {
      freshApartment();
      ui.select.value = 'apartment';
      pausedRender();
      report('ready', sceneDescription('apartment'));
    } catch (error) { report('fail', error instanceof Error ? error.message : String(error)); }
  });
  ui.button(ui.actions, 'Return to game menu', 'qa-menu', () => {
    pauseSilently();
    setNPCInspection(false);
    if (inspectedActor || visualFixtureActive) { freshApartment(); ui.select.value = 'apartment'; }
    api.setInspection(false);
    Input.pause();
    report('ready', 'GAME MENU · Audio remains locked off.\nUse the normal play controls to resume.');
  });

  function blockSpecimenClick(event) {
    if (disposed || busy || !(inspectedActor || visualFixtureActive)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function guardSpecimenSession() {
    if (disposed || busy || !Input.active || !(inspectedActor || visualFixtureActive)) return;
    pauseSilently();
    api.setInspection(true);
    report('ready', 'INSPECTION PAUSED · This specimen cannot enter normal gameplay.\nUse Return to game menu to reset the fixture before playing. Audio remains locked off.');
  }
  renderer.domElement.addEventListener('click', blockSpecimenClick, true);
  document.addEventListener('playstatechange', guardSpecimenSession);
  document.addEventListener('playstatechange', restoreGameplayScale);
  addEventListener('resize', retainReviewScale);
  document.addEventListener('settingschange', retainReviewScale);

  return {
    dispose() {
      disposed = true;
      abortSuite?.();
      abortBenchmark?.();
      renderer.domElement.removeEventListener('click', blockSpecimenClick, true);
      document.removeEventListener('playstatechange', guardSpecimenSession);
      document.removeEventListener('playstatechange', restoreGameplayScale);
      removeEventListener('resize', retainReviewScale);
      document.removeEventListener('settingschange', retainReviewScale);
      pauseSilently();
      setNPCInspection(false);
      if (inspectedActor || visualFixtureActive) freshApartment();
      restoreFixtureTriggers?.();
      api.setTesting(false);
      api.setInspection(false);
      api.gpuTimer?.dispose();
      configureRenderer();
      ui.dispose();
    },
  };
}
