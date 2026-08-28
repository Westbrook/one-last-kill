import * as THREE from 'three';
import { World, WorldState } from '../world/world.js';
import { scene, camera } from '../core/renderer.js';
import { MATS } from './materials.js';
import { mulberry32, TAU } from '../core/math.js';
import { BUILDING, ROOF } from '../world/layout.js';
import { DISTRICT } from '../world/district-layout.js';

// Decorative only: no collision, trigger, or player state changes. Build after
// buildWorld(), before the practical-light budget takes its source snapshot.
let environment = null;
let atmosphere = null;

function makeBatches(root) {
  const batches = [];
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  return {
    add(name, geometry, material, receiveShadow = false) {
      const entries = [];
      batches.push({ name, geometry, material, receiveShadow, entries });
      return (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0, tint = null) => {
        entries.push({ x, y, z, sx, sy, sz, rx, ry, rz, tint });
      };
    },
    flush() {
      let instances = 0;
      for (const batch of batches) {
        if (!batch.entries.length) continue;
        const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.entries.length);
        mesh.name = batch.name;
        const tinted = batch.entries.some(entry => entry.tint !== null);
        for (let i = 0; i < batch.entries.length; i++) {
          const e = batch.entries[i];
          transform.position.set(e.x, e.y, e.z);
          transform.rotation.set(e.rx, e.ry, e.rz);
          transform.scale.set(e.sx, e.sy, e.sz);
          transform.updateMatrix();
          mesh.setMatrixAt(i, transform.matrix);
          if (tinted) mesh.setColorAt(i, color.set(e.tint ?? 0xffffff));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = false;
        mesh.receiveShadow = batch.receiveShadow;
        mesh.matrixAutoUpdate = false;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        root.add(mesh);
        instances += batch.entries.length;
      }
      return instances;
    },
  };
}

function makePaperMaterial(rng) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c7c0aa'; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#817c6e'; ctx.fillRect(11, 13, 76, 4);
  // Indistinct print, not new story text or instructions.
  for (let row = 0; row < 14; row++) {
    ctx.fillStyle = row % 4 ? '#98917e' : '#a8a18e';
    ctx.fillRect(11, 26 + row * 6, 48 + rng() * 52, 1.3);
  }
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = 'rgba(71,62,44,0.08)';
    ctx.fillRect(rng() * 128, rng() * 128, 2 + rng() * 8, 1 + rng() * 5);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map, roughness: 1, side: THREE.DoubleSide });
}

function makeClothGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1, 8, 4);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i);
    positions.setZ(i, Math.sin(x * 28) * 0.055 * (0.7 - y * 0.35));
  }
  geometry.computeVertexNormals();
  return geometry;
}

// Include everything that projects beyond a city mass: cornices, window
// surrounds and roof caps. Reserve this dressed footprint, not just the brick.
function cityBuildingFootprint(building) {
  const margin = 0.45;
  return {
    x1: building.x - building.w / 2 - margin,
    x2: building.x + building.w / 2 + margin,
    z1: building.z - building.d / 2 - margin,
    z2: building.z + building.d / 2 + margin,
  };
}

function footprintsOverlap(a, b, clearance = 0) {
  return a.x1 < b.x2 + clearance && a.x2 > b.x1 - clearance
    && a.z1 < b.z2 + clearance && a.z2 > b.z1 - clearance;
}

function planCityBuildings(rng) {
  const playable = {
    x1: Math.min(DISTRICT.bounds.x1, BUILDING.tower.x1, ROOF.x1),
    x2: Math.max(DISTRICT.bounds.x2, ROOF.x2),
    z1: Math.min(DISTRICT.bounds.z1, ROOF.z1),
    z2: Math.max(DISTRICT.bounds.z2, ROOF.z2),
  };
  const buildings = [];
  function add(building) {
    const footprint = cityBuildingFootprint(building);
    if (footprintsOverlap(footprint, playable, 3)) return;
    if (buildings.some(other => footprintsOverlap(footprint, cityBuildingFootprint(other), 0.6))) return;
    buildings.push(building);
  }

  // Two continuous, separated blocks surround the playable district. The
  // inner north street now clears the annex and the south row clears the
  // bakery's rear wall; side streets clear the widened road and its end gates.
  for (const layer of [0, 1]) {
    const setback = layer ? 41 : 11;
    const ring = {
      x1: playable.x1 - setback, x2: playable.x2 + setback,
      z1: playable.z1 - setback, z2: playable.z2 + setback,
    };
    const columns = layer ? 9 : 7;
    const cornerInset = layer ? 12 : 10;
    for (let i = 0; i < columns; i++) {
      for (const side of [-1, 1]) {
        add({
          x: ring.x1 + cornerInset + (ring.x2 - ring.x1 - cornerInset * 2) * i / (columns - 1)
            + (rng() - 0.5) * 0.6,
          z: side < 0 ? ring.z1 : ring.z2,
          w: (layer ? 12 : 7.5) + rng() * (layer ? 2.5 : 3),
          d: 7 + rng() * 4,
          h: (layer ? 22 : 13) + rng() * (layer ? 28 : 15),
          yaw: side < 0 ? 0 : Math.PI,
          layer,
        });
      }
    }
    const endInset = layer ? 18 : 14;
    for (let i = 0; i < 6; i++) {
      for (const side of [-1, 1]) {
        add({
          x: side < 0 ? ring.x1 : ring.x2,
          z: ring.z1 + endInset + (ring.z2 - ring.z1 - endInset * 2) * i / 5,
          w: 8 + rng() * 4, d: (layer ? 12 : 7.5) + rng() * 3,
          h: (layer ? 24 : 14) + rng() * (layer ? 24 : 14),
          yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2,
          layer,
        });
      }
    }
  }
  return buildings;
}

function buildCity(batches, geometry, wires, rng) {
  const body = batches.add('city-brick-buildings', geometry.box, MATS.brick);
  const trim = batches.add('city-cornices', geometry.box, MATS.concrete);
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x363c3b, roughness: 0.91, metalness: 0.18 });
  const hardware = batches.add('city-roof-hardware', geometry.box, darkMetal);
  const tanks = batches.add('city-water-tanks', geometry.cylinder, MATS.wood);
  const tankCaps = batches.add('city-water-tank-caps', geometry.cone, darkMetal);
  const windowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const window = batches.add('city-instanced-windows', geometry.plane, windowMaterial);
  const windowColors = [0x253032, 0x30383a, 0x313b3c, 0x72634b, 0x9c8662, 0x667678];
  const buildings = planCityBuildings(rng);

  function facade(b, yaw) {
    const cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const alongZ = Math.abs(cosine) > 0.5;
    const width = alongZ ? b.w : b.d, depth = alongZ ? b.d : b.w;
    const columns = Math.max(2, Math.floor(width / 1.8));
    const spacing = (width - 1.8) / (columns - 1);
    for (let y = 2.8; y < b.h - 1.3; y += 2.8) {
      for (let col = 0; col < columns; col++) {
        if (rng() < 0.13) continue;
        const u = -width / 2 + 0.9 + col * spacing;
        const tint = windowColors[rng() < 0.72 ? (rng() * 3) | 0 : 3 + ((rng() * 3) | 0)];
        window(b.x + cosine * u + sine * (depth / 2 + 0.025), y,
          b.z - sine * u + cosine * (depth / 2 + 0.025),
          0.62, 1.03, 1, 0, yaw, 0, tint);
      }
    }
  }

  for (const b of buildings) {
    body(b.x, b.h / 2 - 0.9, b.z, b.w, b.h + 1.8, b.d, 0, 0, 0,
      b.layer ? 0x697273 : [0x85887b, 0x777e79, 0x8a8375][(rng() * 3) | 0]);
    trim(b.x, b.h + 0.03, b.z, b.w + 0.35, 0.24, b.d + 0.35, 0, 0, 0, 0x737b76);
    if (!b.layer) {
      trim(b.x, b.h - 0.6, b.z, b.w + 0.14, 0.12, b.d + 0.14, 0, 0, 0, 0x7f8377);
      trim(b.x, 4.1, b.z, b.w + 0.12, 0.12, b.d + 0.12, 0, 0, 0, 0x858a7f);
    }
    facade(b, b.yaw);
    const secondaryYaw = Math.abs(Math.sin(b.yaw)) < 0.5
      ? (b.x > 0 ? -Math.PI / 2 : Math.PI / 2)
      : (b.z > 7 ? Math.PI : 0);
    facade(b, secondaryYaw);
    const roofY = b.h + 0.15;
    hardware(b.x + b.w * 0.2, roofY + 0.4, b.z, 1.4, 0.8, 1.1);
    if (rng() < 0.19) {
      const tx = b.x - b.w * 0.17, tz = b.z + 0.6;
      for (const dx of [-0.66, 0.66]) {
        for (const dz of [-0.66, 0.66]) hardware(tx + dx, roofY + 0.6, tz + dz, 0.085, 1.2, 0.085);
      }
      hardware(tx, roofY + 1.24, tz, 2.02, 0.08, 2.02);
      tanks(tx, roofY + 2.255, tz, 1.9, 1.95, 1.9);
      tankCaps(tx, roofY + 3.54, tz, 2.05, 0.62, 2.05);
    } else if (rng() < 0.25) {
      const ax = b.x + 1.1, az = b.z - 0.6;
      wires.push(ax, roofY, az, ax, b.h + 3.6, az);
      for (let i = 0; i < 3; i++) wires.push(ax - 0.6 + i * 0.1, b.h + 2 + i * 0.45, az,
        ax + 0.6 - i * 0.1, b.h + 2 + i * 0.45, az);
    } else if (!b.layer) {
      const sx = b.x - b.w * 0.24, sz = b.z - b.d * 0.22;
      hardware(sx, roofY + 0.55, sz, 0.7, 1.1, 0.8, 0, 0, 0, 0x858579);
      trim(sx, roofY + 1.16, sz, 0.86, 0.12, 0.96);
    }
  }
  return buildings.length;
}

function buildDetails(root, batches, geometry, wires, rng) {
  const wood = batches.add('environment-wood-details', geometry.box, MATS.wood, true);
  const plaster = batches.add('environment-plaster-details', geometry.box, MATS.plaster, true);
  const ironMaterial = new THREE.MeshStandardMaterial({ color: 0x4f554e, roughness: 0.84, metalness: 0.32 });
  const iron = batches.add('environment-metal-details', geometry.box, ironMaterial, true);
  const pipe = batches.add('environment-pipes', geometry.cylinder, ironMaterial, true);
  const clothMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide });
  const cloth = batches.add('environment-folded-cloth', makeClothGeometry(), clothMaterial, true);
  const paper = batches.add('environment-papers', geometry.plane, makePaperMaterial(rng), true);
  const panes = batches.add('environment-window-panes', geometry.plane,
    new THREE.MeshStandardMaterial({ color: 0x71807e, emissive: 0x586765, emissiveIntensity: 0.24, roughness: 0.84 }));

  // The closed window looks into the open lightwell, not through the annex.
  // It does not suggest a new exit or change the broken-wall route at x=-3.
  const wx = -10.1, wz = BUILDING.main.z1 + BUILDING.wallThickness / 2 + 0.06, wy = 6.02;
  panes(wx, wy, wz - 0.03, 2.34, 1.8);
  for (const x of [wx - 1.22, wx + 1.22]) wood(x, wy, wz, 0.12, 2.04, 0.13);
  for (const y of [5.02, 7.02]) wood(wx, y, wz, 2.55, 0.12, 0.17);
  wood(wx, wy, wz + 0.05, 0.055, 1.9, 0.075);
  wood(wx, wy - 0.08, wz + 0.05, 2.4, 0.05, 0.075);
  wood(wx, 4.99, wz + 0.05, 2.75, 0.07, 0.32);
  for (let i = 0; i < 13; i++) {
    iron(wx, 6.9 - i * 0.085, wz + 0.06, 2.28, 0.055, 0.038, 0.15, 0, 0, 0xb5b3a1);
  }
  pipe(wx, 7.14, wz + 0.14, 0.026, 3.05, 0.026, 0, 0, Math.PI / 2);
  for (const x of [wx - 1.44, wx + 1.44]) cloth(x, 6.09, wz + 0.13, 0.4, 2.04, 1, 0, 0, 0, 0x8c8979);
  // This outside face remains inside ROOF.lightwell, whose open roof admits
  // daylight. There are no fake north-facing panes buried in the annex mass.
  const exteriorWindowZ = BUILDING.main.z1 - BUILDING.wallThickness / 2 - 0.03;
  panes(wx, wy, exteriorWindowZ, 2.34, 1.8, 1, 0, Math.PI);
  for (const x of [wx - 1.22, wx + 1.22]) wood(x, wy, exteriorWindowZ - 0.025, 0.12, 2.04, 0.13);
  for (const y of [5.02, 7.02]) wood(wx, y, exteriorWindowZ - 0.025, 2.55, 0.12, 0.17);
  plaster(wx, 4.99, exteriorWindowZ - 0.05, 2.75, 0.08, 0.28);

  // Radiator fins remain in the 0.45m strip against the north wall.
  const finGeometry = new THREE.CapsuleGeometry(0.05, 0.49, 2, 6);
  const fins = batches.add('apartment-radiator-fins', finGeometry,
    new THREE.MeshStandardMaterial({ color: 0x8c8b75, roughness: 0.92, metalness: 0.21 }), true);
  for (let i = 0; i < 13; i++) fins(wx - 0.88 + i * 0.146, 4.43, -9.57, 1, 1, 2.5);
  for (const y of [4.19, 4.64]) pipe(wx, y, -9.59, 0.068, 2.0, 0.068, 0, 0, Math.PI / 2);
  for (const x of [wx - 0.76, wx + 0.76]) iron(x, BUILDING.apartmentY + 0.08, -9.57, 0.08, 0.16, 0.26);
  pipe(wx + 1.07, BUILDING.apartmentY + 0.255, -9.62, 0.04, 0.51, 0.04);
  const valve = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.013, 4, 12), ironMaterial);
  valve.name = 'radiator-valve'; valve.position.set(wx + 1.07, 4.55, -9.56); root.add(valve);

  // One caged practical on the west wall, and a modest fill from the closed
  // window. Both join the existing budget and have no shadow maps.
  iron(BUILDING.main.x1 + BUILDING.wallThickness / 2 + 0.025, 6.12, -5.95, 0.08, 0.48, 0.24);
  const bulbMaterial = new THREE.MeshStandardMaterial({ color: 0xf2d6a5, emissive: 0xffbc74, emissiveIntensity: 1.25, roughness: 0.6 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), bulbMaterial);
  bulb.name = 'apartment-caged-bulb'; bulb.position.set(-14.65, 6.14, -5.95); root.add(bulb);
  for (const z of [-6.06, -5.84]) iron(-14.6, 6.14, z, 0.02, 0.28, 0.02);
  for (const y of [5.99, 6.28]) iron(-14.73, y, -5.95, 0.27, 0.02, 0.25);
  const practical = new THREE.PointLight(0xffc58a, 0.95, 6, 2);
  practical.name = 'environment-apartment-practical';
  practical.position.set(-14.48, 6.15, -5.95); practical.userData.zone = 'apartment'; root.add(practical);
  WorldState.flickerLights.push({ light: practical, base: 0.95, seed: 18.73 });
  const windowFill = new THREE.PointLight(0xb6c6c8, 0.72, 7.5, 2);
  windowFill.name = 'environment-apartment-window-fill';
  windowFill.position.set(wx, 6.3, -9.15); windowFill.userData.zone = 'apartment'; root.add(windowFill);

  // Follow live furniture surfaces when the apartment layout changes. The
  // objects remain decorative and do not introduce a new collision or route.
  function furnitureSurface(name, fallback) {
    const object = World.getObjectByName(name);
    if (!object) return fallback;
    const bounds = new THREE.Box3().setFromObject(object);
    return { x: (bounds.min.x + bounds.max.x) / 2, y: bounds.max.y, z: (bounds.min.z + bounds.max.z) / 2 };
  }
  const mattress = furnitureSurface('apartment-mattress', { x: -13.8, y: BUILDING.apartmentY + 0.8, z: -8 });
  const coffee = furnitureSurface('apartment-coffee-table', { x: -10, y: BUILDING.apartmentY + 0.48, z: -5 });
  const dining = furnitureSurface('neighbor-dining-top', { x: 3, y: BUILDING.apartmentY + 0.74, z: -5 });
  const kitchen = furnitureSurface('apartment-kitchen-top', { x: -14.4, y: BUILDING.apartmentY + 0.945, z: -2.5 });
  cloth(mattress.x - 0.02, mattress.y + 0.018, mattress.z + 0.3, 1.6, 0.43, 0.35, -Math.PI / 2, 0, 0.02, 0x656c61);
  paper(coffee.x - 0.21, coffee.y + 0.004, coffee.z - 0.07, 0.43, 0.32, 1, -Math.PI / 2, 0, -0.13);
  paper(coffee.x + 0.06, coffee.y + 0.007, coffee.z - 0.11, 0.29, 0.39, 1, -Math.PI / 2, 0, 0.12, 0xdbd6c6);
  paper(dining.x - 0.45, dining.y + 0.006, dining.z - 0.12, 0.4, 0.32, 1, -Math.PI / 2, 0, 0.25);
  wood(coffee.x - 0.42, coffee.y + 0.0375, coffee.z + 0.18, 0.24, 0.075, 0.31, 0, 0.13, 0, 0x5a675b);
  paper(coffee.x - 0.42, coffee.y + 0.078, coffee.z + 0.18, 0.2, 0.28, 1, -Math.PI / 2, 0, -0.13);
  pipe(kitchen.x, kitchen.y + 0.05, kitchen.z + 0.79, 0.15, 0.1, 0.15);
  pipe(kitchen.x, kitchen.y + 0.14, kitchen.z - 0.87, 0.09, 0.28, 0.09);
  plaster(kitchen.x + 0.1, kitchen.y + 0.03, kitchen.z - 0.51, 0.24, 0.06, 0.26, 0, 0.15);
  // Surface-mounted electrical conduit beside the neighbor's TV alcove.
  iron(8.83, 5.3, -8.0, 0.08, 0.3, 0.21);
  pipe(8.84, 6.33, -8.0, 0.025, 1.77, 0.025);
  for (let i = 0; i < 21; i++) {
    const neighbor = i > 12;
    const x = neighbor ? -1.8 + rng() * 9.8 : -14.25 + rng() * 10.2;
    const z = i % 3 ? -9.03 + rng() * 0.34 : -0.48 - rng() * 0.35;
    paper(x, BUILDING.apartmentY + 0.004 + (i % 3) * 0.001, z, 0.13 + rng() * 0.25, 0.13 + rng() * 0.24,
      1, -Math.PI / 2, 0, rng() * TAU, i % 4 ? 0xb7b19e : 0x676556);
  }

  function facadeWindow(x, y, z, yaw, tint) {
    const alongX = Math.cos(yaw), alongZ = -Math.sin(yaw);
    const normalX = Math.sin(yaw), normalZ = Math.cos(yaw);
    panes(x, y, z, 1.0, 1.65, 1, 0, yaw, 0, tint);
    for (const offset of [-0.55, 0.55]) {
      wood(x + alongX * offset + normalX * 0.01, y,
        z + alongZ * offset + normalZ * 0.01, 0.07, 1.8, 0.1, 0, yaw);
    }
    for (const dy of [-0.86, 0.04, 0.86]) {
      wood(x + normalX * 0.01, y + dy, z + normalZ * 0.01,
        1.14, 0.065, 0.1, 0, yaw);
    }
    plaster(x + normalX * 0.04, y - 0.92, z + normalZ * 0.04,
      1.32, 0.10, 0.3, 0, yaw);
  }

  // Preserve the old south face and ghost sign. Its east return at x=13 is
  // now internal, so all east-facing windows move to the annex's real edge.
  const facadeZ = BUILDING.main.z2 + BUILDING.wallThickness / 2 + 0.015;
  for (const y of [BUILDING.canopyY + 1.75, BUILDING.roofY - 1.65]) {
    for (let x = BUILDING.main.x1 + 2; x < BUILDING.main.x2 - 1; x += 4) {
      if (y > 11 && x > -11 && x < -3) continue;
      facadeWindow(x, y, facadeZ, 0, rng() < 0.25 ? 0xceb886 : 0x798787);
    }
  }
  // The service wing is a grounded building with the same storey rhythm.
  // All frames embed their supporting face; these reuse the existing three
  // material batches rather than adding per-window meshes or lights.
  for (const y of [2.3, 6.05, BUILDING.canopyY + 1.75, ROOF.floorY - 1.65]) {
    for (let x = ROOF.x1 + 2; x < ROOF.x2 - 1; x += 4) {
      facadeWindow(x, y, ROOF.z1 - 0.015, Math.PI, 0x74807c);
    }
    for (let z = ROOF.z1 + 2.5; z < ROOF.z2 - 1; z += 4) {
      facadeWindow(ROOF.x2 + 0.015, y, z, Math.PI / 2, 0x7d8780);
    }
    for (let x = BUILDING.main.x2 + 2.3; x < ROOF.x2 - 1; x += 3.7) {
      facadeWindow(x, y, ROOF.z2 + 0.015, 0, rng() < 0.18 ? 0xb1a386 : 0x798787);
    }
  }

  function cable(ax, ay, az, bx, by, bz, sag) {
    for (let i = 0; i < 20; i++) {
      for (const t of [i / 20, (i + 1) / 20]) {
        wires.push(ax + (bx - ax) * t, ay + (by - ay) * t - 4 * sag * t * (1 - t), az + (bz - az) * t);
      }
    }
  }
  // The line is mounted to the new north parapet, clear of the lightwell and
  // roof service house. Its posts enter the coping and its cloth stays above
  // head height without crossing the stair or scaffold route.
  const lineX1 = ROOF.x1 + 3.4, lineX2 = ROOF.x2 - 3;
  const lineZ = ROOF.z1 + 0.03, lineY = ROOF.floorY + 3.28;
  for (const x of [lineX1, lineX2]) pipe(x, ROOF.floorY + 2.19, lineZ, 0.044, 2.18, 0.044);
  cable(lineX1, lineY, lineZ, lineX2, lineY, lineZ, 0.33);
  for (const [t, width, height, tint] of [[0.2, 0.56, 0.76, 0x898d85], [0.25, 0.67, 0.91, 0xa49c85], [0.77, 0.46, 0.67, 0x646e6e]]) {
    const x = lineX1 + (lineX2 - lineX1) * t;
    const top = lineY - 4 * 0.33 * t * (1 - t);
    cloth(x, top - height / 2, lineZ + 0.03, width, height, 1, 0.05, 0, 0.035, tint);
    for (const dx of [-width * 0.33, width * 0.33]) wood(x + dx, top + 0.015, lineZ + 0.03, 0.025, 0.095, 0.03);
  }
  // Keep only the clothesline with its two real parapet mounts. The former
  // street-spanning wires ended in free air rather than at poles or buildings.

  const { road, nearApron, farWalk } = DISTRICT.street;
  for (const x of [road.x1 + 9, (road.x1 + road.x2) / 2 + 4.5, road.x2 - 8.5]) {
    const z = road.z1 + 0.28;
    iron(x, road.floorY + 0.009, z, 0.65, 0.018, 0.33, 0, 0, 0, 0x4a504c);
    for (let i = 0; i < 7; i++) plaster(x - 0.26 + i * 0.088, road.floorY + 0.022, z,
      0.02, 0.014, 0.25, 0, 0, 0, 0x7d8278);
  }
  for (let i = 0; i < 30; i++) {
    const surface = i % 3 === 0 ? road : i % 3 === 1 ? nearApron : farWalk;
    const z = i % 3 === 1 ? nearApron.z2 - 0.85 + rng() * 0.45
      : surface.z1 + 0.4 + rng() * 0.6;
    const x = surface.x1 + 1 + rng() * (surface.x2 - surface.x1 - 2);
    paper(x, surface.floorY + 0.005 + (i % 3) * 0.001, z,
      0.12 + rng() * 0.3, 0.1 + rng() * 0.26, 1, -Math.PI / 2, 0, rng() * TAU, 0x9c9a87);
  }
}

function buildAtmosphere(root, rng) {
  const count = 144;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  // Per-particle bounds, speed, and phase are fixed once. No spawning,
  // allocation, texture painting, or material changes in the frame loop.
  const bounds = new Float32Array(count * 6);
  const speeds = new Float32Array(count);
  const phases = new Float32Array(count);
  const volumes = [
    [-14.2, -3.7, 4.35, 7.12, -9.3, -0.65],
    [-2.4, 8.5, 4.35, 7.12, -9.3, -0.7],
    [ROOF.x1 + 1, ROOF.x2 - 1, ROOF.floorY + 0.3, ROOF.floorY + 3.5,
      ROOF.z1 + 0.7, ROOF.serviceHouse.z1 - 0.5],
    [DISTRICT.street.road.x1 + 1, DISTRICT.street.road.x2 - 1,
      DISTRICT.street.road.floorY + 0.35, 4.2, DISTRICT.street.road.z1 + 0.3, DISTRICT.street.road.z2 - 0.3],
  ];
  const tint = new THREE.Color();
  const fireCount = Math.min(2, WorldState.fires.length);
  for (let i = 0; i < count; i++) {
    const ember = i >= 124;
    const fire = ember && fireCount ? WorldState.fires[(i - 124) % fireCount] : null;
    const origin = fire?.group.position;
    const volume = ember
      ? [(origin?.x ?? -6) - 0.6, (origin?.x ?? -6) + 0.6, 4.15, 6.8, (origin?.z ?? -0.9) - 0.35, (origin?.z ?? -0.9) + 0.35]
      : volumes[i < 44 ? 0 : i < 76 ? 1 : i < 106 ? 2 : 3];
    bounds.set(volume, i * 6);
    positions[i * 3] = volume[0] + rng() * (volume[1] - volume[0]);
    positions[i * 3 + 1] = volume[2] + rng() * (volume[3] - volume[2]);
    positions[i * 3 + 2] = volume[4] + rng() * (volume[5] - volume[4]);
    speeds[i] = ember ? 0.33 + rng() * 0.4 : 0.013 + rng() * 0.025;
    phases[i] = rng() * TAU;
    tint.set(ember ? 0xe6a35c : 0xb9b7a8).multiplyScalar(ember ? 1 : 0.65 + rng() * 0.3);
    tint.toArray(colors, i * 3);
  }
  const pixels = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const index = (y * 16 + x) * 4;
      const radius = Math.hypot((x - 7.5) / 7.5, (y - 7.5) / 7.5);
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
      pixels[index + 3] = 255 * Math.max(0, 1 - radius) ** 2;
    }
  }
  const map = new THREE.DataTexture(pixels, 16, 16);
  map.magFilter = map.minFilter = THREE.LinearFilter; map.needsUpdate = true;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Include the whole permitted motion volume. The old fixed 32m sphere
  // clipped particles at the expanded street ends before they left the view.
  const particleBounds = new THREE.Box3(), corner = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const offset = i * 6;
    particleBounds.expandByPoint(corner.set(bounds[offset], bounds[offset + 2], bounds[offset + 4]));
    particleBounds.expandByPoint(corner.set(bounds[offset + 1], bounds[offset + 3], bounds[offset + 5]));
  }
  geometry.boundingBox = particleBounds;
  geometry.boundingSphere = particleBounds.getBoundingSphere(new THREE.Sphere());
  geometry.boundingSphere.radius += 0.05;
  const material = new THREE.PointsMaterial({
    map, size: 0.045, opacity: 0.34, transparent: true, vertexColors: true,
    depthWrite: false, sizeAttenuation: true, blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'environment-dust-and-embers'; root.add(points);
  atmosphere = { points, positions, bounds, speeds, phases, count, elapsed: 0, center: geometry.boundingSphere.center.clone() };
}

export function buildEnvironment() {
  if (environment) return environment;
  if (World.parent !== scene || World.children.length === 0) return null;
  const root = new THREE.Group(); root.name = 'cinematic-environment';
  root.matrixAutoUpdate = false;
  // Distant footings extend below street grade. Background ground is just
  // below the authored pavement, so no building or road slab hangs over a void.
  const cityGround = new THREE.Mesh(new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x343b3b, roughness: 1 }));
  cityGround.name = 'city-ground';
  cityGround.rotation.x = -Math.PI / 2;
  cityGround.position.set(0, -0.02, 5);
  cityGround.receiveShadow = true;
  root.add(cityGround);
  const rng = mulberry32(27082026);
  const geometry = {
    box: new THREE.BoxGeometry(1, 1, 1),
    plane: new THREE.PlaneGeometry(1, 1),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
    cone: new THREE.ConeGeometry(0.5, 1, 10),
  };
  const batches = makeBatches(root), wires = [];
  root.userData.cityBuildings = buildCity(batches, geometry, wires, rng);
  buildDetails(root, batches, geometry, wires, rng);
  root.userData.instances = batches.flush();
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  const wireMesh = new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({ color: 0x363e3c }));
  wireMesh.name = 'city-wires-and-antennas'; root.add(wireMesh);
  buildAtmosphere(root, rng);
  root.userData.particleCount = atmosphere.count;
  root.userData.addedLights = 2;
  World.add(root);
  environment = root;
  return root;
}

export function updateEnvironment(dt, time) {
  if (!atmosphere || !Number.isFinite(dt) || dt <= 0) return;
  const step = Math.min(dt, 0.05);
  const a = atmosphere;
  const elapsed = Number.isFinite(time) ? time : a.elapsed + step;
  a.elapsed = elapsed;
  a.points.visible = camera.position.distanceToSquared(a.center) < 80 * 80;
  if (!a.points.visible) return;
  for (let i = 0; i < a.count; i++) {
    const p = i * 3, b = i * 6;
    const drift = i >= 124 ? 0.09 : 0.025;
    a.positions[p] += Math.sin(elapsed * 0.43 + a.phases[i]) * step * drift;
    a.positions[p + 1] += a.speeds[i] * step;
    a.positions[p + 2] += Math.cos(elapsed * 0.31 + a.phases[i]) * step * drift;
    if (a.positions[p] > a.bounds[b + 1]) a.positions[p] = a.bounds[b];
    else if (a.positions[p] < a.bounds[b]) a.positions[p] = a.bounds[b + 1];
    if (a.positions[p + 1] > a.bounds[b + 3]) a.positions[p + 1] = a.bounds[b + 2];
    if (a.positions[p + 2] > a.bounds[b + 5]) a.positions[p + 2] = a.bounds[b + 4];
    else if (a.positions[p + 2] < a.bounds[b + 4]) a.positions[p + 2] = a.bounds[b + 5];
  }
  a.points.geometry.attributes.position.needsUpdate = true;
}
