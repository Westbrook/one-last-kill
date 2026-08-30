// Read-only CPU diagnostic: node scripts/inspect-hero-grip-fit.mjs [weapon ...]
// A few shallow contacts are expected on a gripping hand. Deep intersections,
// especially in the rear palm or wrist, identify fits needing visual review.
import { createHeroWeapon } from '../src/render/hero-weapons.js';
import { addHeroWeaponHands } from '../src/render/hero-weapon-grips.js';
import { Vector3, Raycaster, DoubleSide, Box3, Triangle } from 'three';
import { pathToFileURL } from 'node:url';

const HELD_PARTS = {
  knife: ['knife-contoured-handle'],
  pistol: ['pistol-canted-grip', 'pistol-frame', 'pistol-slide'],
  shotgun: ['shotgun-sculpted-stock', 'shotgun-ribbed-pump', 'shotgun-action', 'shotgun-barrel',
    'shotgun-stock-tang', 'shotgun-stepped-breech-cap', 'shotgun-breech-insert',
    'shotgun-pump-rear-ferrule', 'shotgun-pump-front-ferrule'],
  smg: ['smg-angled-grip', 'smg-stamped-upper', 'smg-foreend-heel', 'smg-vented-foreend--1', 'smg-vented-foreend-1',
    'smg-stock-hinge-neck', 'smg-rear-hinge-cap'],
  machinegun: ['machinegun-pistol-grip', 'machinegun-vented-handguard--1', 'machinegun-vented-handguard-1',
    'machinegun-handguard-floor', 'machinegun-barrel', 'machinegun-rear-takedown-cap', 'machinegun-stock-socket-inset'],
};

function prepareSolid(mesh) {
  // Do not alter the application's shared finish materials while probing.
  mesh.material = mesh.material.clone(); mesh.material.side = DoubleSide;
  const position = mesh.geometry.attributes.position, index = mesh.geometry.index, triangles = [];
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    triangles.push(new Triangle(...[0, 1, 2].map(corner =>
      new Vector3().fromBufferAttribute(position, index ? index.getX(i + corner) : i + corner).applyMatrix4(mesh.matrixWorld))));
  }
  return { mesh, triangles, bounds: new Box3().setFromObject(mesh) };
}

export function inspectHeroGripFit(type, configure = null) {
  if (!HELD_PARTS[type]) throw new RangeError(`Unknown firearm or knife: ${type}`);
  const root = createHeroWeapon(type); addHeroWeaponHands(root, type); configure?.(root); root.updateMatrixWorld(true);
  const solids = HELD_PARTS[type].map(name => root.getObjectByName(name)).filter(Boolean).map(prepareSolid);
  const direction = new Vector3(0.743, 0.311, 0.593).normalize(), ray = new Raycaster(), closest = new Vector3();
  const reports = [];
  for (const hand of root.children.filter(mesh => mesh.name.includes('grip-hand'))) {
    const vertices = new Map(), position = hand.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const local = new Vector3().fromBufferAttribute(position, i), world = local.clone().applyMatrix4(hand.matrixWorld);
      vertices.set(world.toArray().map(coordinate => coordinate.toFixed(6)).join(','), { local, world });
    }
    const report = { type, hand: hand.name, vertices: vertices.size, inside: 0, deeperThan3mm: 0,
      rearPalmOrWristInside: 0, maximumDepthMm: 0, worst: null, parts: {} };
    for (const { local, world } of vertices.values()) {
      for (const { mesh, triangles, bounds } of solids) {
        if (!bounds.containsPoint(world)) continue;
        ray.set(world, direction); ray.near = 1e-6; ray.far = 2;
        const hits = ray.intersectObject(mesh);
        // Double-sided parity handles concave solids and holes. Deduplicate
        // hits along a shared triangle edge before deciding inside/outside.
        const crossings = hits.filter((hit, i) => !i || Math.abs(hit.distance - hits[i - 1].distance) > 1e-6).length;
        if (!(crossings % 2)) continue;
        let distance = Infinity;
        for (const triangle of triangles) {
          triangle.closestPointToPoint(world, closest); distance = Math.min(distance, closest.distanceTo(world));
        }
        if (distance < 1e-6) continue;
        report.inside++; report.parts[mesh.name] = (report.parts[mesh.name] ?? 0) + 1;
        if (distance > 0.003) report.deeperThan3mm++;
        // Factory-local +Z trails from the grip center toward the wrist.
        // This threshold excludes the fingers and their joining front palm.
        if (local.z > 0.075) report.rearPalmOrWristInside++;
        if (distance * 1000 > report.maximumDepthMm) {
          report.maximumDepthMm = distance * 1000;
          report.worst = { part: mesh.name, position: world.toArray(), localPosition: local.toArray() };
        }
        break;
      }
    }
    reports.push(report);
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv.slice(2);
  for (const type of requested.length ? requested : Object.keys(HELD_PARTS)) {
    for (const report of inspectHeroGripFit(type)) console.log(JSON.stringify(report));
  }
}
