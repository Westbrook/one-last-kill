import { Vector3 } from 'three';
import { Colliders } from '../core/collision.js';
import { createArmorPickupModel } from '../render/armor-pickup-model.js';
import { MAX_ARMOR, clampArmor } from './armor-rules.js';
import { isSegmentOccluded } from './combat-rules.js';

export const ARMOR_DROP_LIMIT = 16;
const PICKUP_RADIUS_SQ = 0.9 * 0.9;
const HOVER_HEIGHT = 0.45;

/** Enemy drops are temporary; checkpoint retries clear them and replay kills. */
export function createArmorPickups() {
  const list = [];
  const playerCenter = new Vector3();
  let world, player, canCollect, onCollect, colliders;
  let elapsed = 0;

  function remove(pickup) {
    pickup.active = false;
    pickup.mesh.visible = false;
    pickup.mesh.removeFromParent();
    const index = list.indexOf(pickup);
    if (index >= 0) list.splice(index, 1);
    // All instances share the model's cached materials and geometry.
  }

  return {
    list,
    init(options) {
      this.clearAll();
      ({ world, player, canCollect = () => true, onCollect = () => {}, colliders = Colliders.list } = options);
    },
    spawn(x, floorY, z, amount = MAX_ARMOR, zone = null) {
      const strength = clampArmor(amount);
      if (!world || !strength || ![x, floorY, z].every(Number.isFinite)) return null;
      if (list.length >= ARMOR_DROP_LIMIT) remove(list[0]);
      const mesh = createArmorPickupModel({ damaged: strength < MAX_ARMOR });
      mesh.name = 'armor-vest';
      mesh.userData.armorStrength = strength;
      mesh.position.set(x, floorY + HOVER_HEIGHT, z);
      const pickup = { mesh, amount: strength, zone, active: true, baseY: mesh.position.y, phase: Math.random() * Math.PI * 2 };
      list.push(pickup);
      world.add(mesh);
      return pickup;
    },
    setZone() {
      // A pursuer can die beyond its original encounter. Keep that metadata
      // for feedback, while physical distance and cover govern collection.
      for (const pickup of list) pickup.mesh.visible = pickup.active;
    },
    clearAll() {
      while (list.length) remove(list[list.length - 1]);
      elapsed = 0;
    },
    update(dt) {
      if (!player || !Number.isFinite(dt) || dt <= 0 || !canCollect() || player.health <= 0) return;
      elapsed += dt;
      playerCenter.copy(player.pos);
      playerCenter.y -= player._eyeH - HOVER_HEIGHT;
      let best = null;
      for (const pickup of list) {
        if (!pickup.active || !pickup.mesh.visible) continue;
        pickup.mesh.position.y = pickup.baseY + Math.sin(elapsed * 2.6 + pickup.phase) * 0.04;
        pickup.mesh.rotation.y += dt * 0.8;
        if (pickup.amount <= clampArmor(player.armor) || (best && pickup.amount <= best.amount)) continue;
        // Use the stable height for collection, independently of the hover.
        const dx = pickup.mesh.position.x - playerCenter.x;
        const dy = pickup.baseY - playerCenter.y;
        const dz = pickup.mesh.position.z - playerCenter.z;
        if (dx * dx + dy * dy + dz * dz >= PICKUP_RADIUS_SQ) continue;
        if (isSegmentOccluded(player.pos, pickup.mesh.position, colliders)) continue;
        best = pickup;
      }
      if (!best) return;
      // Equip the strongest nearby vest. Weaker vests stay for a later visit;
      // two half-strength vests never combine into undamaged armor.
      player.armor = best.amount;
      remove(best);
      onCollect(best);
    },
  };
}

export const ArmorPickups = createArmorPickups();
