import * as THREE from 'three';
import { camera } from '../core/renderer.js';
import { Audio } from '../core/audio.js';
import { Player } from './player.js';
import { currentZone, onZoneChange } from '../world/world.js';
import { Endings } from './mission.js';
import { BALCONY, ROOF, SCAFFOLD_LEVELS } from '../world/layout.js';
import { STAIRS } from '../world/stair-layout.js';
import { DISTRICT } from '../world/district-layout.js';
import { CHECKPOINT_COMMS } from './checkpoint-comms.js';
import '../navigation.css';

// Original fan-mission dialogue, not a transcription of the film.
const LINES = {
  apartment: ['CASTLE', 'They came for me. The people downstairs didn’t choose this.'],
  neighbor: ['A VOICE NEXT DOOR', 'The stairs are burning. Take the balcony. My family is still downstairs.'],
  balcony: ['CASTLE', 'Stay low. Keep moving.'],
  stairwell: ['INTERCEPTED COMMS', 'Roof team, hold your position. Don’t let him reach the street.'],
  roof: ['CASTLE', 'They locked down the whole block. They didn’t lock me in.'],
  scaffolding: ['BAKERY RADIO', 'If anyone can hear me… they’re at the door.'],
  street: ['CASTLE', 'One car. One chance. And a room full of people.'],
  bakery: ['A VOICE IN THE BACK', 'We’re in here! Please!'],
};

const ROUTES = {
  apartment: [[-8.5, 5.15, -6, 'THROUGH THE LIVING ROOM'], [-3.4, 5.15, -6, 'BREACH · SPACE TO JUMP']],
  neighbor: [[-0.1, 5.15, -4.2, 'THROUGH THE FOYER'], [1.9, 5.15, -3.8, 'ROUND THE PARTITION'],
    [5.6, 5.15, -3.8, 'PAST THE DINING ROOM'], [5.6, 5.15, -5.5, 'BALCONY DOOR'], [8.6, 5.15, -5.5, 'BALCONY DOOR']],
  balcony: [[11, 5.1, BALCONY.laneZ, 'ROUND THE CORNER'], [-18, 5.1, BALCONY.laneZ, 'FOLLOW THE WALKWAY'], [-18, 5.1, -0.5, 'STAIRWELL']],
  roof: ROOF.route.slice(1).map(([x, y, z], index) => [x, y + 1.1, z,
    ['CROSS THE SERVICE ROOF', 'EAST SERVICE YARD', 'SCAFFOLD ACCESS', 'SCAFFOLDING · DROP'][index]]),
};

let marker, caption, captionTime = 0, routeIndex = 0;
let pendingRadio = null;
const projected = new THREE.Vector3();
const toward = new THREE.Vector3();
const forward = new THREE.Vector3();

export function initNavigation() {
  marker = document.createElement('div');
  marker.id = 'route-marker';
  marker.innerHTML = '<i></i><span></span><small></small>';
  document.getElementById('hud').append(marker);
  caption = document.createElement('div');
  caption.id = 'mission-caption';
  caption.setAttribute('role', 'status');
  caption.setAttribute('aria-atomic', 'true');
  caption.innerHTML = '<span></span><p></p><small class="radio-caption"></small>';
  document.getElementById('hud').append(caption);
  onZoneChange(zone => {
    routeIndex = 0;
    const line = LINES[zone];
    if (!line) return;
    caption.querySelector('span').textContent = line[0];
    caption.querySelector('p').textContent = line[1];
    pendingRadio = CHECKPOINT_COMMS[zone] ?? null;
    const radioCaption = caption.querySelector('.radio-caption');
    radioCaption.hidden = !pendingRadio;
    radioCaption.textContent = pendingRadio ? `INTERCEPTED RADIO · ${pendingRadio.text}` : '';
    caption.classList.add('show');
    captionTime = 6;
  });
}

function stairTarget() {
  const foot = Player.pos.y - Player._eyeH;
  const { lanes, landings, turns } = STAIRS;
  const center = (lanes.west + lanes.east) / 2;
  const waypoint = (x, y, z, label) => [x, y + 1.1, z, label];
  if (foot < landings[1].y - 0.2) {
    if (Player.pos.x > center && Player.pos.z > turns.northZ + 0.8) return waypoint(lanes.east, STAIRS.entryY, turns.northZ, 'AROUND TO THE FIRST FLIGHT');
    if (Player.pos.x > center) return waypoint(lanes.west, STAIRS.entryY, turns.northZ, 'FIRST FLIGHT');
    return waypoint(lanes.west, landings[1].y, turns.southZ, 'UP TO THE LANDING');
  }
  if (foot < landings[2].y - 0.2) return Player.pos.x < center
    ? waypoint(lanes.east, landings[1].y, turns.southZ, 'CROSS THE LANDING')
    : waypoint(lanes.east, landings[2].y, turns.northZ, 'KEEP CLIMBING');
  if (foot < landings[3].y - 0.2) return Player.pos.x > center
    ? waypoint(lanes.west, landings[2].y, turns.northZ, 'CROSS THE LANDING')
    : waypoint(lanes.west, landings[3].y, turns.southZ, 'UP TO THE NEXT FLOOR');
  if (foot < STAIRS.exitY - 0.2) return Player.pos.x < center
    ? waypoint(lanes.east, landings[3].y, turns.southZ, 'LAST FLIGHT')
    : waypoint(lanes.east, STAIRS.exitY, turns.northZ, 'ROOF ACCESS');
  return waypoint(STAIRS.roofExit[0], STAIRS.exitY, STAIRS.roofExit[2], 'THROUGH THE ROOF DOOR');
}

function target() {
  if (Endings.isResolved()) return null;
  if (Endings.isCommitted()) return Endings.getMode() === 'car'
    ? [DISTRICT.car.approach.x, 1.4, DISTRICT.car.approach.z, 'GNUCCI’S CAR']
    : [-21, 1.4, 37.2, 'PROTECT THE FAMILY'];
  if (currentZone === 'stairwell') return stairTarget();
  if (currentZone === 'scaffolding') {
    const foot = Player.pos.y - Player._eyeH;
    if (foot > SCAFFOLD_LEVELS[1].y + 1) return [9.5, SCAFFOLD_LEVELS[1].y + 1.1, 3.2, 'WEST END · NEXT PLATFORM'];
    if (foot > SCAFFOLD_LEVELS[2].y + 1) return [25, SCAFFOLD_LEVELS[2].y + 1.1, 4.2, 'CROSS EAST AND DROP'];
    if (foot > SCAFFOLD_LEVELS[3].y + 1) return [13, SCAFFOLD_LEVELS[3].y + 1.1, 4.5, 'WEST END · LOWER DECK'];
    if (Player.pos.x < 23.4 && foot > 1) return [24, SCAFFOLD_LEVELS[3].y + 1.1, 5.2, 'FOLLOW THE OPEN RAIL'];
    return [24, 1.2, 10, 'DOWN TO THE STREET'];
  }
  if (currentZone === 'street') return null; // Both final choices must remain equal.
  const route = ROUTES[currentZone];
  if (!route) return null;
  let next = route[Math.min(routeIndex, route.length - 1)];
  if (routeIndex < route.length - 1 && Math.hypot(Player.pos.x - next[0], Player.pos.z - next[2]) < 1.5) next = route[++routeIndex];
  return next;
}

export function updateNavigation(dt) {
  if (!marker) return;
  // A restore can change the zone while paused. Play only its current cue on
  // the next simulation step; inspection and muted sessions never speak.
  if (pendingRadio && dt > 0 && !Endings.isResolved()) {
    const status = Audio.getStatus();
    const resuming = status.active && status.supported && !status.muted && !status.hardMuted
      && !status.blocked && !status.running && status.mix.master > 0 && status.mix.radio > 0;
    // Context resume is asynchronous on some devices. Retain only this visible
    // cue for at most 1.5 seconds of play; never queue muted checkpoints to be
    // spoken later or let an old message follow the player into another zone.
    if (!resuming) {
      Audio.announceCheckpoint(pendingRadio);
      pendingRadio = null;
    } else if (captionTime <= 4.5) pendingRadio = null;
  }
  captionTime = Math.max(0, captionTime - dt);
  caption.classList.toggle('show', captionTime > 0);
  const next = target();
  marker.hidden = !next;
  if (!next) return;
  projected.set(next[0], next[1], next[2]);
  toward.copy(projected).sub(camera.position);
  const distance = toward.length();
  camera.getWorldDirection(forward);
  const behind = toward.dot(forward) < 0;
  projected.project(camera);
  let x = projected.x, y = projected.y;
  if (behind) { x = Math.sign(-toward.x * Math.cos(Player.yaw) + toward.z * Math.sin(Player.yaw)) || 1; y = 0; }
  const clampedX = Math.max(-0.76, Math.min(0.76, x));
  const clampedY = Math.max(-0.48, Math.min(0.48, y));
  marker.style.left = `${(clampedX + 1) * 50}%`;
  marker.style.top = `${(1 - clampedY) * 50}%`;
  marker.classList.toggle('offscreen', behind || Math.abs(x) > 0.76 || Math.abs(y) > 0.48);
  marker.querySelector('span').textContent = next[3];
  marker.querySelector('small').textContent = `${Math.round(distance)} m`;
}
