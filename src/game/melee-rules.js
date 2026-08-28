import { WEAPON_DEFS } from './weapon-data.js';

/** A reusable simulation timeline. It never stores a target or grants damage. */
export function createMeleeState() {
  return {
    active: false, type: null, owner: null, elapsed: 0, duration: 0,
    contactAt: 0, contactDelivered: false, sequence: 0,
  };
}

export function beginMelee(state, type, owner = type) {
  const definition = Object.hasOwn(WEAPON_DEFS, type) ? WEAPON_DEFS[type] : null;
  if (state.active || definition?.kind !== 'melee' || !Object.hasOwn(WEAPON_DEFS, owner)) return false;
  state.active = true;
  state.type = type; state.owner = owner;
  state.elapsed = 0; state.duration = definition.attackDuration;
  state.contactAt = definition.attackDuration * definition.contactPhase;
  state.contactDelivered = false;
  state.sequence++;
  return true;
}

/** True exactly once when contact time is crossed, including a bounded long frame. */
export function advanceMelee(state, delta) {
  if (!state.active || !Number.isFinite(delta) || delta <= 0) return false;
  state.elapsed = Math.min(state.duration, state.elapsed + delta);
  const contact = !state.contactDelivered && state.elapsed + 1e-9 >= state.contactAt;
  if (contact) state.contactDelivered = true;
  if (state.elapsed + 1e-9 >= state.duration) state.active = false;
  return contact;
}

export function cancelMelee(state) {
  state.active = false; state.type = null; state.owner = null;
  state.elapsed = 0; state.duration = 0; state.contactAt = 0;
  state.contactDelivered = false;
}

export function meleeRemaining(state) {
  return state.active && state.duration > 0 ? Math.max(0, 1 - state.elapsed / state.duration) : 0;
}
