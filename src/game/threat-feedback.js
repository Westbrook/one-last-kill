import { camera } from '../core/renderer.js';
import { PlayerState } from './player.js';
import { HUD } from '../ui/hud.js';
import { createOffscreenThreatTracker } from './offscreen-threats.js';

const tracker = createOffscreenThreatTracker();
const attacks = [];
const view = { position: camera.position, yaw: 0, pitch: 0, fov: 82, aspect: 1, zoom: 1 };

/** The actual rendered camera includes crouch, stair smoothing, aim FOV and aspect. */
export function readThreatView() {
  view.yaw = camera.rotation.y;
  view.pitch = camera.rotation.x;
  view.fov = camera.fov;
  view.aspect = camera.aspect;
  view.zoom = camera.zoom;
  return view;
}

export const ThreatFeedback = {
  hit(source) { if (!PlayerState.dead) tracker.hit(source); },
  update(dt, enemies) {
    if (PlayerState.dead) { this.clear(); return; }
    attacks.length = 0;
    for (const enemy of enemies) {
      if (enemy.alive && !enemy.removed && enemy.state === 'attack' && enemy.staggerTime <= 0
        && !(enemy.spawnGrace > 0) && (enemy.windupRemaining >= 0 || enemy.burstLeft > 0)) attacks.push(enemy);
    }
    HUD.setOffscreenThreat(tracker.update(dt, readThreatView(), attacks));
  },
  clear() {
    tracker.clear();
    attacks.length = 0;
    HUD.setOffscreenThreat(null);
  },
};
