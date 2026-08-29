import * as THREE from 'three';
import { lerp, clamp } from '../core/math.js';
import { camera } from '../core/renderer.js';
import { Audio } from '../core/audio.js';
import { Ballistics, createBallisticHit } from '../core/ballistics.js';
import { HUD } from '../ui/hud.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../core/collision.js';
import { Input } from '../core/input.js';
import { Settings } from '../core/settings.js';
import { Weapons } from './weapons.js';
import { currentZone } from '../world/world.js';

const Player = {
  // Public position is the eye anchor; collision movement is anchored at feet.
  pos: new THREE.Vector3(-9.0, 5.72, -4.0),
  vel: new THREE.Vector3(),
  yaw: Math.PI * 0.5, pitch: 0,
  eyeHeight: 1.72, crouchEye: 1.10,
  bodyHeight: 1.84, crouchBody: 1.22,
  radius: 0.32,
  isCrouching: false, onGround: false,
  isSprinting: false, aiming: false,
  speedWalk: 4.2, speedSprint: 7.0, jumpVel: 5.6,
  health: 100,
  footTimer: 0,
  cameraMotion: 0.6,
  _eyeH: 1.72, _bodyH: 1.84,
  _coyoteTime: 0, _jumpBuffer: 0, _jumpHeld: false,
  _stepOffset: 0, _walkPhase: 0, _bobOffset: 0,
};

const PlayerState = {
  dead: false,
  lastZoneSpawn: { pos: new THREE.Vector3(-9.0, 5.72, -4.0), yaw: Math.PI * 0.5 },
};

const STEP_UP_MAX = 0.30;
const COYOTE_TIME = 0.10;
const JUMP_BUFFER = 0.12;
const GRAVITY = 22;
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _soundProbe = new THREE.Vector3();
const _soundDown = new THREE.Vector3(0, -1, 0);
const _soundSurface = createBallisticHit();
const _body = {
  position: new THREE.Vector3(), velocity: Player.vel,
  radius: Player.radius, height: Player.bodyHeight,
  onGround: false, stepped: 0,
};

// Call after assigning a spawn expressed as a standing eye position. This
// avoids carrying crouch, held jump, and camera easing through a checkpoint.
function resetPlayerMotion() {
  Player.vel.set(0, 0, 0);
  Player._eyeH = Player.eyeHeight;
  Player._bodyH = Player.bodyHeight;
  Player.isCrouching = false;
  Player.isSprinting = false;
  Player.aiming = false;
  Player.onGround = false;
  Player.footTimer = 0;
  Player._coyoteTime = 0;
  Player._jumpBuffer = 0;
  Player._jumpHeld = false;
  Player._stepOffset = 0;
  Player._walkPhase = 0;
  Player._bobOffset = 0;
  camera.position.copy(Player.pos);
  camera.rotation.set(Player.pitch, Player.yaw, 0, 'YXZ');
}

function playerInit() {
  resetPlayerMotion();
  HUD.setHealth(Player.health);
}

function updateStance(dt, wantsCrouch) {
  _feet.copy(Player.pos);
  _feet.y -= Player._eyeH;
  // Check the full standing height before expanding. Growing until the head
  // intersects a beam makes the body oscillate and can shove feet into floors.
  if (!wantsCrouch && Player._bodyH < Player.bodyHeight - 0.001) {
    wantsCrouch = !capsuleHasClearance(_feet, Player.radius, Player.bodyHeight, Colliders.list);
  }
  Player.isCrouching = wantsCrouch;
  const blend = 1 - Math.exp(-14 * dt);
  const eyeTarget = wantsCrouch ? Player.crouchEye : Player.eyeHeight;
  const bodyTarget = wantsCrouch ? Player.crouchBody : Player.bodyHeight;
  Player._eyeH = lerp(Player._eyeH, eyeTarget, blend);
  Player._bodyH = lerp(Player._bodyH, bodyTarget, blend);
  if (Math.abs(Player._eyeH - eyeTarget) < 0.001) Player._eyeH = eyeTarget;
  if (Math.abs(Player._bodyH - bodyTarget) < 0.001) Player._bodyH = bodyTarget;
  Player.pos.y = _feet.y + Player._eyeH;
}

function updateCamera(dt, horizontalSpeed, stepped) {
  // Smooth riser height without smoothing aim or delaying player input.
  Player._stepOffset *= Math.exp(-18 * dt);
  Player._stepOffset = Math.min(0.45, Player._stepOffset + stepped);
  const motion = Settings.get('reducedMotion') ? 0 : clamp(Player.cameraMotion, 0, 1);
  if (Player.onGround) Player._walkPhase += horizontalSpeed * dt * 2.4;
  const bob = Player.onGround
    ? Math.sin(Player._walkPhase * 2) * 0.01 * motion * Math.min(1, horizontalSpeed / Player.speedWalk) * (Player.aiming ? 0.2 : 1)
    : 0;
  Player._bobOffset = motion ? lerp(Player._bobOffset, bob, 1 - Math.exp(-16 * dt)) : 0;
  camera.position.copy(Player.pos);
  camera.position.y += Player._bobOffset - Player._stepOffset;
  camera.rotation.set(Player.pitch, Player.yaw, 0, 'YXZ');
}

function movementSound(intensity, speed = 0) {
  // Sample the actual tread beneath the foot only when a step occurs, not at
  // render frequency. Moving through a zone does not change a wooden floor
  // into concrete or turn the roof's metal grating into an indoor footstep.
  _soundProbe.copy(Player.pos);
  _soundProbe.y -= Player._eyeH - 0.2;
  const hit = Ballistics.raycast(_soundProbe, _soundDown, 0.65, 'bullet', _soundSurface);
  const fallback = currentZone === 'apartment' || currentZone === 'neighbor' ? 'wood'
    : currentZone === 'scaffolding' ? 'metal' : 'concrete';
  return { surface: hit && hit.surfaceKind !== 'solid' ? hit.surfaceKind : fallback,
    intensity, speed, environment: currentZone };
}

function playerUpdate(dt) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  dt = Math.min(dt, 1 / 30);
  const inp = Input.consumeFrame(dt);
  const active = Input.active && !PlayerState.dead;
  Player.aiming = active && Input.isAiming();
  if (active) {
    const sensitivity = 0.0025 * Settings.get('sensitivity') * (Player.aiming ? 0.72 : 1);
    Player.yaw -= inp.dx * sensitivity;
    Player.pitch = clamp(Player.pitch - inp.dy * sensitivity, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
  }

  _forward.set(-Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
  _right.set(Math.cos(Player.yaw), 0, -Math.sin(Player.yaw));
  updateStance(dt, active && Boolean(inp.crouchDown || Input.keys.has('KeyC') || Input.keys.has('ControlLeft')));

  _move.set(0, 0, 0);
  if (active) {
    if (Input.keys.has('KeyW')) _move.add(_forward);
    if (Input.keys.has('KeyS')) _move.sub(_forward);
    if (Input.keys.has('KeyD')) _move.add(_right);
    if (Input.keys.has('KeyA')) _move.sub(_right);
    _move.addScaledVector(_forward, inp.moveY || 0);
    _move.addScaledVector(_right, inp.moveX || 0);
  }
  if (_move.lengthSq() > 1) _move.normalize();
  // Input already applies the stick dead zone. A second threshold here would
  // move the body with fine stick input while disabling its ability to step.
  const moving = _move.lengthSq() > 1e-12;
  Player.isSprinting = active && Boolean(inp.sprintDown || Input.keys.has('ShiftLeft'))
    && !Player.isCrouching && !Player.aiming && _move.dot(_forward) > 0.35;
  let speed = Player.isSprinting ? Player.speedSprint : Player.speedWalk;
  if (Player.isCrouching) speed *= 0.5;
  if (Player.aiming) speed *= 0.65;
  const acceleration = 1 - Math.exp(-(Player.onGround ? 20 : 4) * dt);
  Player.vel.x = lerp(Player.vel.x, _move.x * speed, acceleration);
  Player.vel.z = lerp(Player.vel.z, _move.z * speed, acceleration);
  if (!active) { Player.vel.x = 0; Player.vel.z = 0; }

  const jumpDown = active && Boolean(inp.jumpDown || Input.keys.has('Space'));
  const jumpPressed = active && (inp.jumpPressed ?? (jumpDown && !Player._jumpHeld));
  Player._jumpHeld = jumpDown;
  Player._jumpBuffer = jumpPressed ? JUMP_BUFFER : Math.max(0, Player._jumpBuffer - dt);
  Player._coyoteTime = Player.onGround ? COYOTE_TIME : Math.max(0, Player._coyoteTime - dt);
  const wasGrounded = Player.onGround;
  Player.vel.y = Math.max(-32, Player.vel.y - GRAVITY * dt);
  if (Player._jumpBuffer > 0 && Player._coyoteTime > 0 && active) {
    Player.vel.y = Player.jumpVel;
    Player.onGround = false;
    Player._jumpBuffer = 0;
    Player._coyoteTime = 0;
    Audio.movement({ ...movementSound(0.5), action: 'jump' });
  }
  const landingSpeed = Math.max(0, -Player.vel.y);

  _body.position.copy(Player.pos);
  _body.position.y -= Player._eyeH;
  _body.radius = Player.radius;
  _body.height = Player._bodyH;
  _body.onGround = Player.onGround;
  moveCapsule(_body, dt, Colliders.list, moving, STEP_UP_MAX);
  // Street level is the final safety floor outside the authored level shell.
  if (_body.position.y < 0) {
    _body.position.y = 0;
    if (Player.vel.y < 0) Player.vel.y = 0;
    _body.onGround = true;
  }
  Player.pos.copy(_body.position);
  Player.pos.y += Player._eyeH;
  Player.onGround = _body.onGround;

  const horizontalSpeed = Math.hypot(Player.vel.x, Player.vel.z);
  updateCamera(dt, horizontalSpeed, _body.stepped);
  if (active && !wasGrounded && Player.onGround && landingSpeed > 2.5) {
    Audio.movement({ ...movementSound(Math.min(1.4, 0.65 + landingSpeed / 16), horizontalSpeed), action: 'land' });
    Player.footTimer = 0.24;
  }
  if (active && Player.onGround && horizontalSpeed > 1.5) {
    Player.footTimer -= dt;
    if (Player.footTimer <= 0) {
      Audio.footstep(movementSound(Player.isCrouching ? 0.36 : Player.isSprinting ? 1 : 0.68, horizontalSpeed));
      Player.footTimer = Player.isCrouching ? 0.62 : (Player.isSprinting ? 0.32 : 0.45);
    }
  } else {
    Player.footTimer = 0;
  }

  if (active) Weapons.handleInput(inp, dt);
}

export { Player, PlayerState, playerInit, playerUpdate, resetPlayerMotion };
