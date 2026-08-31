import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Colliders } from '../core/collision.js';
import { Architecture } from '../world/architecture.js';
import { isSegmentOccluded } from './combat-rules.js';
import { WEAPON_DEFS } from './weapon-data.js';
import { AMMO_SUPPLY_CACHES, AmmoSupplyLedger } from './ammo-supply-rules.js';
import { RunSettings } from './run-settings.js';

function makeLabelTexture() {
  if (!globalThis.document?.createElement) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 224;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#d9bc74'; context.fillRect(0, 0, 512, 224);
  context.fillStyle = '#222c27';
  context.font = '900 92px sans-serif'; context.textAlign = 'center';
  context.fillText('AMMO', 256, 102);
  context.font = '700 26px sans-serif'; context.fillText('FIELD RESERVE', 256, 149);
  context.font = '600 18px sans-serif'; context.fillText('CARRIED WEAPON ONLY', 256, 190);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createResources() {
  return {
    box: new THREE.BoxGeometry(1, 1, 1),
    body: new RoundedBoxGeometry(1, 1, 1, 2, 0.035),
    plane: new THREE.PlaneGeometry(1, 1),
    casing: new THREE.MeshStandardMaterial({ color: 0x53634a, roughness: 0.74, metalness: 0.42 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x16261f, roughness: 0.76, metalness: 0.32 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x798678, roughness: 0.45, metalness: 0.75 }),
    label: new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeLabelTexture(), roughness: 0.74, metalness: 0.05 }),
    indicator: new THREE.MeshStandardMaterial({ color: 0xf0cb74, emissive: 0x9a6721, emissiveIntensity: 0.5, roughness: 0.65 }),
  };
}

/** A low field case with lid, latches and handle, resting on its rubber rails. */
export function buildAmmoBox(config, resources) {
  const group = new THREE.Group();
  group.position.set(config.position.x, config.position.y, config.position.z);
  const transform = new THREE.Object3D();
  const batch = (name, geometry, material, parts) => {
    const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
    mesh.name = name;
    for (const [index, [x, y, z, width, height, depth, rotationX = 0]] of parts.entries()) {
      transform.position.set(x, y, z); transform.scale.set(width, height, depth);
      transform.rotation.set(rotationX, 0, 0); transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    }
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const { width, height, depth } = config;
  const lidTop = height - 0.04, lidBottom = lidTop - 0.03, footHeight = 0.024;
  batch('ammo-case-body-and-lid', resources.body, resources.casing, [
    [0, (footHeight + lidBottom) / 2, 0, width, lidBottom - footHeight, depth],
    [0, lidTop - 0.015, 0, width + 0.018, 0.03, depth + 0.018],
  ]);
  batch('ammo-case-feet-and-seal', resources.box, resources.dark, [
    [-width * 0.34, footHeight / 2, 0, 0.065, footHeight, depth * 0.86],
    [width * 0.34, footHeight / 2, 0, 0.065, footHeight, depth * 0.86],
    [0, lidBottom, 0, width + 0.009, 0.014, depth + 0.009],
    [0, 0.054, depth / 2 + 0.006, width * 0.57, 0.024, 0.01],
  ]);
  batch('ammo-case-handle-and-latches', resources.box, resources.metal, [
    [-0.099, lidTop + 0.012, 0.08, 0.022, 0.024, 0.032],
    [0.099, lidTop + 0.012, 0.08, 0.022, 0.024, 0.032],
    [0, height - 0.008, 0.08, 0.22, 0.016, 0.032],
    [-width * 0.39, lidBottom - 0.05, depth / 2 + 0.014, 0.032, 0.085, 0.028],
    [width * 0.39, lidBottom - 0.05, depth / 2 + 0.014, 0.032, 0.085, 0.028],
  ]);
  batch('ammo-case-lid-and-front-labels', resources.plane, resources.label, [
    [0, lidTop + 0.001, -0.04, width * 0.63, depth * 0.58, 1, -Math.PI / 2],
    [0, lidBottom * 0.56, depth / 2 + 0.003, width * 0.55, 0.13, 1],
  ]);
  const indicatorWidth = width * 0.53;
  const indicator = new THREE.Mesh(resources.box, resources.indicator);
  indicator.name = 'ammo-case-supply-indicator';
  indicator.position.set(0, 0.054, depth / 2 + 0.013);
  indicator.scale.set(indicatorWidth, 0.01, 0.008);
  group.add(indicator);
  return { mesh: group, indicator, indicatorWidth };
}

/** Services arrive at boot, keeping imports free of player/world/input cycles. */
export function createAmmoSupplies(caches = AMMO_SUPPLY_CACHES) {
  const ledger = new AmmoSupplyLedger(caches);
  const list = [];
  const playerCenter = new THREE.Vector3();
  let player = null, canInteract = () => false, activeZone = 'apartment', initialized = false;

  function sync(entry) {
    // A spent case remains on its supporting floor. A solid supply object
    // must never disappear while its collider still belongs to the world.
    entry.mesh.visible = true;
    const fraction = entry.capacity > 0 ? entry.remainingUnits / entry.capacity : 0;
    entry.indicator.visible = fraction > 0;
    entry.indicator.scale.x = entry.indicatorWidth * fraction;
    entry.indicator.position.x = entry.indicatorWidth * (fraction - 1) / 2;
  }

  function isReachable(entry, maxDist) {
    if (!player || !entry.mesh.visible || !entry.visibleZones.includes(activeZone) || !entry.active || !canInteract()) return false;
    const footY = player.pos.y - player._eyeH;
    if (!Number.isFinite(footY) || Math.abs(footY - entry.floorY) > 0.65) return false;
    playerCenter.set(player.pos.x, footY + 0.95, player.pos.z);
    return playerCenter.distanceToSquared(entry.interactionPosition) < maxDist * maxDist
      && !isSegmentOccluded(playerCenter, entry.interactionPosition, Colliders.list);
  }

  return {
    list,
    init({ world, player: livePlayer, canInteract: interactionAllowed } = {}) {
      if (initialized) return;
      if (!world?.add || !livePlayer?.pos || typeof interactionAllowed !== 'function') {
        throw new TypeError('Ammo supplies require the world, player and gameplay availability callback');
      }
      player = livePlayer; canInteract = interactionAllowed;
      const resources = createResources();
      for (const config of caches) {
        const box = buildAmmoBox(config, resources);
        world.add(box.mesh);
        box.mesh.updateWorldMatrix(true, true);
        const bounds = new THREE.Box3().setFromObject(box.mesh);
        const collider = Colliders.addBox(bounds.min, bounds.max);
        Architecture.register(box.mesh, collider, bounds, {
          id: 'ammo-cache-' + config.id, kind: 'supply-cache', supports: [config.support], supportKind: 'bearing',
        });
        const entry = {
          id: config.id, kind: 'ammoSupply', zone: config.zone, floorY: config.floorY,
          visibleZones: config.visibleZones, ...box, collider,
          // The target sits above the complete case, including its handle.
          // Every side can reach it without a ray crossing its own collider.
          interactionPosition: new THREE.Vector3(config.position.x, bounds.max.y + 0.025, config.position.z),
          get capacity() { return ledger.capacity(config.id); },
          get remainingUnits() { return ledger.units(config.id); },
          get active() { return ledger.units(config.id) >= 3; },
        };
        list.push(entry); sync(entry);
      }
      initialized = true;
    },
    setZone(zone) {
      activeZone = zone;
      for (const entry of list) sync(entry);
    },
    findNearest(weapon, maxDist = 1.8) {
      if (!Number.isFinite(maxDist) || maxDist <= 0) return null;
      let nearest = null, nearestSquared = maxDist * maxDist;
      for (const entry of list) {
        if (!ledger.available(entry.id, weapon) || !isReachable(entry, maxDist)) continue;
        const distance = playerCenter.distanceToSquared(entry.interactionPosition);
        if (distance < nearestSquared) { nearest = entry; nearestSquared = distance; }
      }
      return nearest;
    },
    prompt(entry, weapon) {
      if (!list.includes(entry)) return null;
      const amount = ledger.available(entry.id, weapon);
      return amount ? `[E] +${amount} ${WEAPON_DEFS[weapon.current].name} AMMO · AMMO BOX` : null;
    },
    pickup(entry, weapon, acceptReserve) {
      if (!list.includes(entry) || !isReachable(entry, 1.8)) return 0;
      const accepted = ledger.take(entry.id, weapon, acceptReserve, { active: canInteract() });
      if (accepted) sync(entry);
      return accepted;
    },
    snapshot() { return ledger.snapshot(); },
    restore(snapshot) {
      const restored = ledger.restore(snapshot);
      if (restored) for (const entry of list) sync(entry);
      return restored;
    },
    reset(ammoMultiplier = RunSettings.profile.ammo) {
      ledger.reset(ammoMultiplier);
      this.setZone('apartment');
    },
  };
}

export const AmmoSupplies = createAmmoSupplies();
