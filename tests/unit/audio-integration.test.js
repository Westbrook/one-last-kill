import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createRageState } from '../../src/game/rage-rules.js';
import { createAudioController } from '../../src/core/audio.js';
import { createSettingsStore, audioMixFromSettings } from '../../src/core/settings.js';
import { FixedStepClock } from '../../src/core/frame-budget.js';
import { createBallisticWorld, createBallisticHit } from '../../src/core/ballistics.js';
import { capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { lerp, clamp } from '../../src/core/math.js';
import { CHECKPOINT_COMMS } from '../../src/game/checkpoint-comms.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { ZONE_ORDER } from '../../src/game/mission-data.js';
import { BALCONY, ROOF, SCAFFOLD_LEVELS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { weaponHarness } from './helpers/weapon-harness.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

const STEP = 1 / 120;
const mainSource = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../../public/assets/audio/manifest.json', import.meta.url), 'utf8'));
const near = (actual, expected, message = 'Values agree') => assert.ok(Math.abs(actual - expected) < 1e-8,
  message + ': expected ' + expected + ', got ' + actual);
const noOp = () => {};

function actualMain(name) {
  const source = mainSource.match(new RegExp('^function ' + name + '\\([^]*?^\\}', 'm'))?.[0];
  assert.ok(source, 'Keep the actual main hook fixture current: ' + name);
  return source;
}

function moduleSource(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export (?=function\b|const\b)/gm, '');
  assert.doesNotMatch(source, /^import\s|^export\s/m, 'Keep the explicit CPU bindings current');
  return source;
}

// No WebAudio, browser, speech service, network request or audio decoding is
// performed. Even "unmuted" tests below route into these plain JS records.
function outputDouble() {
  const calls = { contexts: 0, starts: 0, stops: 0, speech: [], cancels: 0 };
  const param = () => ({
    value: 0, cancelScheduledValues: noOp,
    setValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    exponentialRampToValueAtTime(value) { this.value = value; },
  });
  const node = () => ({
    gain: param(), frequency: param(), Q: param(), playbackRate: param(), pan: param(),
    connect(target) { return target; }, disconnect: noOp,
    start() { calls.starts++; },
    stop(when) { if (when === undefined) { calls.stops++; this.onended?.(); } },
  });
  const context = {
    state: 'suspended', currentTime: 0, sampleRate: 64, destination: {},
    createGain: node, createBufferSource: node, createOscillator: node,
    createBiquadFilter: node, createStereoPanner: node,
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { duration: length / sampleRate, numberOfChannels: channels, length,
        getChannelData: () => data };
    },
    resume() { this.state = 'running'; return Promise.resolve(); },
    suspend() { this.state = 'suspended'; return Promise.resolve(); },
    close() { this.state = 'closed'; return Promise.resolve(); },
  };
  return {
    calls, context, createContext() { calls.contexts++; return context; },
    speechAdapter: {
      available: () => true,
      speak(request) { calls.speech.push(request); return true; },
      cancel() { calls.cancels++; return true; },
    },
  };
}

function lockedAudio(options = {}) {
  const calls = { contexts: 0, loads: 0, speech: 0 };
  const forbidden = key => () => { calls[key]++; throw new Error('Hard mute attempted ' + key); };
  const audio = createAudioController({
    search: '?qa=1&mute=1', ...options,
    createContext: forbidden('contexts'), sampleLoader: forbidden('loads'),
    speechAdapter: { available: forbidden('speech'), speak: forbidden('speech'), cancel: forbidden('speech') },
  });
  audio.setSampleManifest(manifest);
  return { audio, calls };
}

function assertLocked(audio, calls) {
  const state = audio.getStatus(), samples = state.resources.samples;
  assert.equal(state.hardMuted, true); assert.equal(state.muted, true);
  assert.equal(state.initialized, false); assert.equal(state.running, false);
  assert.equal(state.radioActive, false); assert.equal(state.radioQueued, 0);
  assert.equal(state.resources.voices, 0); assert.equal(state.resources.noiseBuffers, 0);
  for (const key of ['queued', 'pending', 'inFlight', 'cached', 'bytes']) assert.equal(samples[key], 0, key);
  near(state.elapsed, 0); near(state.score.elapsed, 0);
  assert.deepEqual(calls, { contexts: 0, loads: 0, speech: 0 });
}

function actionRecorder(audio, events, time) {
  const actions = ['weaponMechanical', 'dryClick', 'pickupChime', 'meleeSwing', 'meleeHit', 'impact',
    'pistolShot', 'shotgunShot', 'smgShot', 'machinegunShot', 'gunshot'];
  return { ...audio, ...Object.fromEntries(actions.map(name => [name, (options = {}) => {
    events.push({ name, time: time(), options: { ...options,
      ...(options.pos ? { pos: { x: options.pos.x, y: options.pos.y, z: options.pos.z } } : {}) } });
    return audio[name](options);
  }])) };
}

function quietWeapons(type, loaded = 0, reserve = 0) {
  const locked = lockedAudio(), events = [], time = { elapsed: 0 };
  const h = weaponHarness({ audio: actionRecorder(locked.audio, events, () => time.elapsed), zone: 'balcony' });
  h.Weapons.init(); h.Weapons.restore({ current: type, loaded, reserve });
  h.Player.pos.y = h.Player._eyeH;
  return { ...h, ...locked, gameCalls: h.calls, lockedCalls: locked.calls, events,
    tick(dt) { time.elapsed += dt; h.GameTime.elapsed = time.elapsed; h.Weapons.tick(dt); },
    wall(surface = 'wood', z = -1) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 0.1), new THREE.MeshBasicMaterial());
      mesh.position.z = z; mesh.material.userData.surfaceKind = surface;
      h.World.add(mesh); h.ballistics.rebuild(h.World); return mesh;
    },
    dispose() {
      h.ballistics.clear();
      const geometries = new Set(), materials = new Set();
      for (const root of [h.World, ...Object.values(h.Weapons.vmCache)]) root.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of [object.material].flat().filter(Boolean)) materials.add(material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

test('real pickups distinguish weapon handling from reserve ammo without doubling equip or replaying consumed drops', () => {
  for (const type of ['bat', 'knife', 'pistol', 'shotgun', 'smg', 'machinegun']) {
    const h = quietWeapons('fists');
    try {
      const ranged = WEAPON_DEFS[type].kind === 'ranged';
      const drop = h.WeaponDrops.spawn(0, 0, 0, type, ranged ? 12 : 0);
      assert.equal(h.Weapons.pickup(drop), true);
      assert.equal(h.Weapons.current, type);
      assert.deepEqual(h.events.map(event => event.name), ['pickupChime']);
      assert.deepEqual(h.events[0].options, { kind: 'weapon', weapon: type, environment: 'balcony' });
      assert.equal(h.Weapons.pickup(drop), false);
      assert.equal(h.events.length, 1, 'A consumed pickup has no second handling sound');
      const same = h.WeaponDrops.spawn(0, 0, 0, type, ranged ? 6 : 0);
      const loaded = h.Weapons.loaded;
      assert.equal(h.Weapons.pickup(same), ranged);
      assert.equal(h.events.length, ranged ? 2 : 1, 'An identical melee weapon is not collected');
      if (ranged) {
        assert.equal(h.Weapons.loaded, loaded, 'Ammo scavenging cannot sound or behave like a reload');
        assert.equal(h.events[1].name, 'pickupChime');
        assert.deepEqual(h.events[1].options, { kind: 'ammo', weapon: type, environment: 'balcony' });
      }
      assertLocked(h.audio, h.lockedCalls);
    } finally { h.dispose(); }
  }
});

// Execute the real main functions without booting its renderer or world.
// Simulation services are explicit recording sinks; the clock and controller
// remain real, so accepted/paused time crosses the production boundary.
function mainHarness(audio, { updateNavigation = noOp } = {}) {
  const ticks = [], simulated = [], listeners = new Map();
  const document = {
    hidden: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const Settings = createSettingsStore({ onChange: detail => document.dispatchEvent({ type: 'settingschange', detail }) });
  const record = name => dt => simulated.push({ name, dt });
  const gates = { intro: false, ending: false };
  const Input = { active: true, pollGamepad: noOp };
  const Player = { pos: new THREE.Vector3(0, 5.72, 0), yaw: 0.3, health: 100 };
  const PlayerState = { dead: false }, camera = new THREE.PerspectiveCamera();
  camera.position.copy(Player.pos);
  const bindings = {
    FixedStepClock, Settings, audioMixFromSettings, document, Input, Player, PlayerState, camera, Rage: createRageState(),
    Audio: { ...audio, tick(dt, state) {
      ticks.push({ dt, zone: state.zone, threat: state.threat, paused: state.paused, dead: state.dead,
        listenerPosition: state.listener.position, yaw: state.listener.yaw });
      audio.tick(dt, state);
    } },
    IntroCard: { isOpen: () => gates.intro }, Endings: { isResolved: () => gates.ending, update: record('ending') },
    Enemies: { list: [] }, currentZone: 'roof', GameTime: { elapsed: 0 },
    Weapons: { tick: record('weapon'), update: record('viewmodel') },
    playerUpdate: record('player'), enemiesUpdate: record('enemy'), triggersUpdate: record('triggers'),
    WaveDirector: { update: record('wave') }, HealPickups: { update: record('heal') },
    StreetChoice: { update: record('choice') }, CombatStats: { update: record('stats'), snapshot: () => ({}) },
    HUD: { update: record('hud'), setRage: noOp, setHealth: noOp, message: noOp },
    Blood: { update: record('blood') }, FX: { update: record('fx') },
    ThreatFeedback: { update: record('threat'), clear: record('threatClear') },
    ObjectiveBanner: { update: record('objective') }, updateNavigation,
    animateFires: noOp, animateFlickerLights: noOp, animateSmoke: noOp, updateEnvironment: noOp,
    FPSMeter: { tick: noOp }, recordRenderTime: noOp, render: noOp,
  };
  const settingsHook = mainSource.match(/^syncAudioSettings\(\);\ndocument\.addEventListener\('settingschange',[^\n]+\);$/m)?.[0];
  assert.ok(settingsHook, 'Run the actual settings subscription, not a substitute listener');
  const prelude = 'const clock = new FixedStepClock(); let contextLost = false, hudTimer = 0;'
    + 'let previousTime = 0, wasPlaying = false, controlledTest = false, inspecting = false;'
    + 'const audioScene = {zone:"apartment",threat:0,paused:true,dead:false,listener:{position:camera.position,yaw:0}};\n';
  const api = runInNewContext(prelude
    + ['syncAudioSettings', 'isPlaying', 'updateAudioScene', 'stepFrame', 'frame'].map(actualMain).join('\n')
    + '\n' + settingsHook
    + '\n;({stepFrame,frame,updateAudioScene,isPlaying,setContextLost(value){contextLost=value;}});',
  bindings, { filename: 'src/main.js:audio-hooks' });
  return { ...api, ...bindings, audio, ticks, simulated, gates, setZone(zone) { bindings.currentZone = zone; } };
}

function navigationHarness(audio) {
  const nodes = new Map(), callbacks = [];
  function element() {
    const children = new Map(), classes = new Set();
    return {
      id: '', textContent: '', hidden: false, style: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      append(child) { nodes.set(child.id, child); },
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
      classList: {
        add(value) { classes.add(value); },
        toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
        contains: value => classes.has(value),
      },
    };
  }
  nodes.set('hud', element());
  const camera = new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 300);
  const Player = { pos: new THREE.Vector3(-9, 5.72, -4), yaw: 0, _eyeH: 1.72 };
  camera.position.copy(Player.pos); camera.updateMatrixWorld(true);
  const announcements = [], gates = { resolved: false };
  const bindings = {
    THREE, camera, Player, BALCONY, ROOF, SCAFFOLD_LEVELS, STAIRS, DISTRICT, CHECKPOINT_COMMS,
    currentZone: 'apartment', onZoneChange: callback => callbacks.push(callback),
    document: { createElement: element, getElementById: id => nodes.get(id) },
    Endings: { isResolved: () => gates.resolved, isCommitted: () => false },
    Audio: { getStatus: audio.getStatus, announceCheckpoint(cue) {
      const accepted = audio.announceCheckpoint(cue);
      announcements.push({ cue, accepted }); return accepted;
    } },
  };
  const api = runInNewContext(moduleSource('../../src/game/navigation.js')
    + '\n;({initNavigation,updateNavigation});', bindings, { filename: 'src/game/navigation.js' });
  api.initNavigation();
  return { ...api, nodes, announcements, gates,
    changeZone(zone) { bindings.currentZone = zone; for (const callback of callbacks) callback(zone); } };
}

function playerHarness(audio, zone = 'neighbor') {
  const floor = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), new THREE.MeshBasicMaterial());
  floor.position.y = 3.9; floor.material.userData.surfaceKind = 'metal';
  const world = new THREE.Group(); world.add(floor);
  const colliders = { list: [new THREE.Box3(new THREE.Vector3(-30, 3.8, -30), new THREE.Vector3(30, 4, 30))] };
  const ballistics = createBallisticWorld({ colliders }); ballistics.rebuild(world);
  const events = [], queries = [], clock = { elapsed: 0 };
  const Input = { active: true, keys: new Set(), isAiming: () => false,
    consumeFrame: () => ({ dx: 0, dy: 0 }) };
  const bindings = {
    THREE, lerp, clamp, camera: new THREE.PerspectiveCamera(82, 16 / 9, 0.05, 100),
    Colliders: colliders, capsuleHasClearance, moveCapsule, createBallisticHit, currentZone: zone, Input,
    Ballistics: { raycast(origin, direction, distance, channel, out) {
      queries.push({ origin: origin.clone(), direction: direction.clone(), distance, channel });
      return ballistics.raycast(origin, direction, distance, channel, out);
    } },
    Settings: { get: key => key === 'reducedMotion' ? false : 1 },
    HUD: { setHealth: noOp }, Weapons: { handleInput: noOp },
    Audio: {
      footstep(value) { events.push({ event: 'footstep', time: clock.elapsed, ...value }); audio.footstep(value); },
      movement(value) { events.push({ event: 'movement', time: clock.elapsed, ...value }); audio.movement(value); },
    },
  };
  const api = runInNewContext(moduleSource('../../src/game/player.js')
    + '\n;({Player,PlayerState,playerInit,playerUpdate,resetPlayerMotion});', bindings, { filename: 'src/game/player.js' });
  api.Player.pos.set(0, 4 + api.Player.eyeHeight + 0.02, 0); api.Player.yaw = 0; api.playerInit();
  const step = (count = 1) => { for (let index = 0; index < count; index++) { clock.elapsed += STEP; api.playerUpdate(STEP); } };
  step(120);
  assert.equal(api.Player.onGround, true); assert.equal(events.length, 0);
  return { ...api, Input, events, queries, step, dispose() { ballistics.clear(); floor.geometry.dispose(); floor.material.dispose(); } };
}

test('actual settings subscription updates every mix bus and voice preference without granting audio permission', async () => {
  for (const search of ['?qa=1&mute=1', '?qa=0&qa=TRUE', '?mute=0&mute=true']) {
    const { audio, calls } = lockedAudio({ search }), h = mainHarness(audio);
    assert.deepEqual(audio.getStatus().mix, audioMixFromSettings(h.Settings.snapshot()));
    assert.equal(audio.getStatus().voiceEnabled, true);
    h.Settings.set({ audioMaster: 0.42, audioEffects: 0.31, audioAmbience: 0.22,
      audioMusic: 0.13, audioRadio: 0.64, checkpointVoice: false });
    assert.deepEqual(audio.getStatus().mix, { master: 0.42, effects: 0.31, ambience: 0.22, music: 0.13, radio: 0.64 });
    assert.equal(audio.getStatus().voiceEnabled, false);
    h.Settings.set('checkpointVoice', true);
    audio.setMuted(false); await audio.resume();
    h.stepFrame(1 / 30);
    audio.startAmbient(); audio.startFireCrackle();
    audio.movement({ action: 'land', surface: 'metal', intensity: 1 });
    audio.weaponMechanical({ action: 'reload-insert', weapon: 'pistol' });
    audio.meleeSwing({ weapon: 'bat' }); audio.surfaceImpact({ surface: 'wood' });
    assert.equal(audio.announceCheckpoint(CHECKPOINT_COMMS.roof), false);
    h.Input.active = false; h.stepFrame(100);
    await audio.reset();
    assertLocked(audio, calls);
    assert.equal(h.Player.health, 100); near(h.GameTime.elapsed, 1 / 30);
    assert.deepEqual(audio.getStatus().mix, audioMixFromSettings(h.Settings.snapshot()), 'Reset preserves mix preferences');
  }
});

test('actual main hook supplies current listener, zone and bounded local enemy pressure', async () => {
  const { audio, calls } = lockedAudio(), h = mainHarness(audio);
  await audio.resume();
  const point = (distance, changes = {}) => ({
    alive: true, zone: 'roof', state: 'chase', pos: h.Player.pos.clone().add(new THREE.Vector3(distance, 0, 0)), ...changes,
  });
  h.Enemies.list.push(point(0, { state: 'attack' }), point(14), point(0, { alive: false }),
    point(0, { zone: 'bakery' }), point(50, { state: 'attack' }));
  h.camera.position.y += 0.15; h.Player.yaw = -1.2;
  near(h.stepFrame(STEP), STEP);
  const tick = h.ticks.at(-1);
  near(tick.threat, 0.53); near(tick.dt, STEP); near(tick.yaw, -1.2);
  assert.equal(tick.listenerPosition, h.camera.position, 'The listener follows the real eased camera rather than a copied player eye');
  assert.equal(tick.zone, 'roof'); assert.equal(tick.paused, false); assert.equal(tick.dead, false);
  h.Enemies.list.push(...Array.from({ length: 8 }, () => point(0, { state: 'attack' })));
  h.updateAudioScene(0); near(h.ticks.at(-1).threat, 1);
  h.setZone('bakery'); h.updateAudioScene(0);
  assert.equal(h.ticks.at(-1).zone, 'bakery'); near(h.ticks.at(-1).threat, 0.22);
  assertLocked(audio, calls);
});

test('actual fixed-step and animation hooks freeze audio for all pause gates and discard resume catch-up', async () => {
  const output = outputDouble(), audio = createAudioController(output), h = mainHarness(audio);
  audio.setMuted(false); await audio.resume();
  near(h.stepFrame(10), STEP * 8); near(audio.getStatus().elapsed, STEP * 8);
  const gates = [
    on => { h.Input.active = !on; }, on => { h.PlayerState.dead = on; },
    on => { h.gates.intro = on; }, on => { h.gates.ending = on; },
    on => { h.document.hidden = on; }, on => { h.setContextLost(on); },
  ];
  for (const gate of gates) {
    await audio.resume(); gate(true);
    const gameBefore = h.GameTime.elapsed, samples = h.simulated.length;
    near(h.stepFrame(60), 0);
    near(h.GameTime.elapsed, gameBefore); assert.equal(h.simulated.length, samples);
    assert.equal(h.ticks.at(-1).paused, true);
    assert.equal(audio.getStatus().active, false); assert.equal(audio.getStatus().resources.voices, 0);
    gate(false); await audio.resume();
    near(h.stepFrame(0), 0); near(h.stepFrame(STEP), STEP);
  }
  h.frame(1000); h.frame(1017);
  h.Input.active = false; h.frame(90000);
  assert.equal(audio.getStatus().active, false, 'The automatic rAF pause path also suspends the controller');
  h.Input.active = true; await audio.resume();
  const elapsed = audio.getStatus().elapsed, game = h.GameTime.elapsed;
  h.frame(180000);
  near(audio.getStatus().elapsed, elapsed); near(h.GameTime.elapsed, game);
  h.frame(180017); assert.ok(audio.getStatus().elapsed > elapsed);
  await audio.reset(); assert.equal(output.calls.contexts, 1);
});

test('all eight actual checkpoint captions match local radio IDs and announce once only after positive simulation time', () => {
  const { audio, calls } = lockedAudio(), h = navigationHarness(audio);
  assert.deepEqual(Object.keys(CHECKPOINT_COMMS), [...ZONE_ORDER]);
  for (const zone of ZONE_ORDER) {
    const cue = CHECKPOINT_COMMS[zone], sample = manifest.samples[cue.sampleId];
    assert.equal(cue.id, 'checkpoint:' + zone); assert.equal(cue.zone, zone);
    assert.ok(Object.isFrozen(cue)); assert.equal(sample?.bus, 'radio');
    assert.match(sample.url, /^\/assets\/audio\/radio\/[\w-]+\.wav$/);
    assert.equal(existsSync(new URL('../../public' + sample.url, import.meta.url)), true);
    h.changeZone(zone);
    const caption = h.nodes.get('mission-caption'), radio = caption.querySelector('.radio-caption');
    assert.equal(caption.attributes.role, 'status'); assert.equal(caption.attributes['aria-atomic'], 'true');
    assert.equal(radio.hidden, false); assert.equal(radio.textContent, 'INTERCEPTED RADIO · ' + cue.text);
    assert.ok(caption.querySelector('p').textContent.length > cue.text.length,
      'Original story dialogue remains separate from the short radio subtitle');
    const count = h.announcements.length;
    for (let frame = 0; frame < 120; frame++) h.updateNavigation(0);
    assert.equal(h.announcements.length, count, 'Paused inspection cannot announce or consume the cue');
    h.updateNavigation(STEP); h.updateNavigation(STEP);
    assert.equal(h.announcements.length, count + 1);
    assert.equal(h.announcements.at(-1).cue, cue); assert.equal(h.announcements.at(-1).accepted, false);
    assertLocked(audio, calls);
  }
});

test('paused zone changes keep only the latest checkpoint and muted cues do not replay when audio later starts', async () => {
  const output = outputDouble(), audio = createAudioController(output), h = navigationHarness(audio);
  audio.setVoiceEnabled(true);
  h.changeZone('apartment'); h.updateNavigation(0); h.changeZone('neighbor'); h.updateNavigation(0);
  h.changeZone('roof'); h.updateNavigation(STEP);
  assert.deepEqual(h.announcements.map(item => item.cue.zone), ['roof']);
  assert.equal(h.announcements[0].accepted, false);
  audio.setMuted(false); await audio.resume();
  h.updateNavigation(STEP); audio.tick(STEP, { zone: 'roof' });
  assert.equal(output.calls.speech.length, 0, 'Enabling output later does not replay an already-consumed muted cue');
  h.changeZone('bakery'); h.gates.resolved = true; h.updateNavigation(STEP);
  assert.equal(h.announcements.length, 1, 'A final result cannot begin another checkpoint voice');
  h.gates.resolved = false; h.updateNavigation(STEP);
  assert.equal(h.announcements.length, 2); assert.equal(output.calls.speech[0].text, CHECKPOINT_COMMS.bakery.text);
  await audio.reset();
});

test('actual navigation waits for an asynchronous resume without consuming the cue or retaining a previous zone', async () => {
  const output = outputDouble();
  let finishResume;
  output.context.resume = () => new Promise(resolve => {
    finishResume = () => { output.context.state = 'running'; resolve(); };
  });
  const audio = createAudioController(output), h = navigationHarness(audio);
  audio.setVoiceEnabled(true); audio.setMuted(false);
  const pending = audio.resume();
  h.changeZone('apartment');
  for (let frame = 0; frame < 60; frame++) h.updateNavigation(STEP);
  assert.equal(h.announcements.length, 0);
  h.changeZone('roof');
  for (let frame = 0; frame < 60; frame++) h.updateNavigation(STEP);
  for (let frame = 0; frame < 600; frame++) h.updateNavigation(0);
  assert.equal(h.announcements.length, 0, 'Paused inspection neither speaks nor spends the bounded resume window');
  finishResume(); assert.equal(await pending, true);
  h.updateNavigation(STEP); h.updateNavigation(STEP);
  assert.deepEqual(h.announcements.map(event => event.cue.zone), ['roof']);
  assert.equal(output.calls.speech.length, 1); assert.equal(output.calls.speech[0].text, CHECKPOINT_COMMS.roof.text);
  await audio.reset();
});

test('actual navigation expires an unresolved resume after bounded simulation time and never plays its stale cue', async () => {
  const output = outputDouble();
  let finishResume;
  output.context.resume = () => new Promise(resolve => {
    finishResume = () => { output.context.state = 'running'; resolve(); };
  });
  const audio = createAudioController(output), h = navigationHarness(audio);
  audio.setVoiceEnabled(true); audio.setMuted(false);
  const pending = audio.resume();
  h.changeZone('balcony');
  for (let frame = 0; frame < Math.ceil((1.5 + STEP * 2) / STEP); frame++) h.updateNavigation(STEP);
  assert.equal(h.announcements.length, 0);
  finishResume(); await pending;
  h.updateNavigation(STEP);
  assert.equal(h.announcements.length, 0); assert.equal(output.calls.speech.length, 0);
  h.changeZone('stairwell'); h.updateNavigation(STEP);
  assert.equal(output.calls.speech.length, 1); assert.equal(output.calls.speech[0].text, CHECKPOINT_COMMS.stairwell.text);
  await audio.reset();
});

test('actual pause, death and reset paths cancel radio and stale voice completions cannot finish a restored cue', async () => {
  const output = outputDouble(), audio = createAudioController(output), nav = navigationHarness(audio);
  const h = mainHarness(audio, { updateNavigation: nav.updateNavigation });
  audio.setMuted(false); await audio.resume();
  nav.changeZone('roof'); h.stepFrame(STEP);
  assert.equal(output.calls.speech.length, 1);
  const staleSpeech = output.calls.speech[0];
  audio.announceCheckpoint({ id: 'fixture:queued', zone: 'roof', text: 'Queued fixture.' });
  assert.equal(audio.getStatus().radioQueued, 1);
  h.Input.active = false; h.stepFrame(STEP);
  assert.equal(audio.getStatus().radioActive, false); assert.equal(audio.getStatus().radioQueued, 0);
  assert.equal(output.calls.cancels, 1);
  h.Input.active = true; await audio.resume(); h.stepFrame(STEP);
  assert.equal(output.calls.speech.length, 1, 'Pause drops queued speech rather than delaying it');
  assert.equal(audio.announceCheckpoint(CHECKPOINT_COMMS.roof), false, 'Pause preserves deduplication history');
  h.PlayerState.dead = true; h.stepFrame(STEP);
  near(audio.getStatus().elapsed, 0); near(audio.getStatus().score.elapsed, 0);
  assert.equal(audio.getStatus().active, false);
  h.PlayerState.dead = false; await audio.resume();
  nav.changeZone('roof'); h.stepFrame(STEP);
  assert.equal(output.calls.speech.length, 2, 'Death reset permits the restored checkpoint to announce again');
  staleSpeech.onend(); audio.tick(STEP, { zone: 'roof' });
  assert.equal(audio.getStatus().radioActive, true, 'Old voice callbacks cannot complete the new radio token');
  await audio.reset();
});

test('actual player footsteps query rendered materials at contact and keep walk, sprint and crouch cadence', () => {
  for (const [keys, intensity, interval] of [
    [['KeyW'], 0.68, 0.45], [['KeyW', 'ShiftLeft'], 1, 0.32], [['KeyW', 'KeyC'], 0.36, 0.62],
  ]) {
    const { audio, calls } = lockedAudio(), h = playerHarness(audio);
    try {
      for (const key of keys) h.Input.keys.add(key);
      h.step(3 * 120);
      assert.ok(h.events.length >= 4);
      assert.equal(h.queries.length, h.events.length, 'Surface queries happen on actual contacts rather than every render frame');
      for (const [index, event] of h.events.entries()) {
        assert.equal(event.event, 'footstep'); assert.equal(event.surface, 'metal');
        assert.equal(event.environment, 'neighbor'); near(event.intensity, intensity);
        assert.ok(event.speed > 1.5);
        if (index) assert.ok(event.time - h.events[index - 1].time >= interval - 1e-8);
        const query = h.queries[index];
        near(query.origin.y, 4.2); assert.deepEqual(query.direction.toArray(), [0, -1, 0]);
        near(query.distance, 0.65); assert.equal(query.channel, 'bullet');
      }
      assertLocked(audio, calls);
    } finally { h.dispose(); }
  }
});

test('actual jump and landing contacts emit once, while inactive or dead movement emits nothing', () => {
  const { audio, calls } = lockedAudio(), h = playerHarness(audio);
  try {
    h.Input.keys.add('Space'); h.step(); h.Input.keys.delete('Space');
    assert.equal(h.events.length, 1); assert.equal(h.events[0].action, 'jump'); assert.equal(h.Player.onGround, false);
    h.step(120);
    assert.equal(h.Player.onGround, true); assert.equal(h.events.length, 2);
    assert.equal(h.events[1].action, 'land'); assert.ok(h.events[1].time > h.events[0].time);
    assert.equal(h.events[1].surface, 'metal'); assert.ok(h.events[1].intensity > h.events[0].intensity);
    const count = h.events.length, queries = h.queries.length;
    h.Input.keys.add('KeyW'); h.Input.keys.add('Space');
    h.Input.active = false; h.step(120);
    h.Input.active = true; h.PlayerState.dead = true; h.step(120);
    assert.equal(h.events.length, count); assert.equal(h.queries.length, queries);
    assertLocked(audio, calls);
  } finally { h.dispose(); }
});

test('actual reload input emits start, insert and end only at their simulation phases without changing ammunition conservation', () => {
  for (const type of ['pistol', 'shotgun', 'smg', 'machinegun']) {
    const h = quietWeapons(type, 2, 17), d = WEAPON_DEFS[type];
    try {
      h.Weapons.handleInput({ rPressed: true }, STEP);
      assert.ok(h.Weapons.reloading > 0);
      assert.equal(h.Weapons.startReload(), false, 'A duplicate reload request is rejected');
      for (let frame = 0; frame < 120; frame++) { h.Weapons.tick(0); h.Weapons.update(0); }
      assert.deepEqual(h.events.map(event => event.options.action), ['reload-start']);
      near(h.Weapons.reloading, d.reloadTime);
      h.tick(d.reloadTime * 0.66 - STEP / 2);
      assert.equal(h.events.length, 1);
      assert.deepEqual({ ...h.Weapons.snapshot() }, { current: type, loaded: 2, reserve: 17 });
      h.tick(STEP);
      assert.deepEqual(h.events.map(event => event.options.action), ['reload-start', 'reload-insert']);
      near(h.events[1].time, d.reloadTime * 0.66 + STEP / 2);
      h.tick(d.reloadTime * 0.34 - STEP);
      assert.equal(h.events.length, 2, 'The final sound cannot precede magazine completion');
      h.tick(STEP);
      assert.deepEqual(h.events.map(event => event.options.action), ['reload-start', 'reload-insert', 'reload-end']);
      near(h.Weapons.loaded, Math.min(d.mag, 19)); near(h.Weapons.totalAmmo(), 19);
      h.tick(5); assert.equal(h.events.length, 3);
      assert.ok(h.events.every(event => event.name === 'weaponMechanical'
        && event.options.weapon === type && event.options.environment === 'balcony'));
      assertLocked(h.audio, h.lockedCalls);
    } finally { h.dispose(); }
  }
});

test('real reload rejection, pause, equip, drop, restore and death never emit a late insert or completion', () => {
  for (const cancel of ['equip', 'drop', 'restore', 'death']) {
    const h = quietWeapons('pistol', 1, 8);
    try {
      h.Weapons.handleInput({ rPressed: true }, STEP); h.tick(0.2);
      const main = mainHarness(h.audio);
      main.Weapons.tick = dt => h.tick(dt);
      main.Input.active = false;
      const remaining = h.Weapons.reloading;
      near(main.stepFrame(30), 0); near(h.Weapons.reloading, remaining);
      if (cancel === 'equip') h.Weapons._equip('shotgun', 4);
      else if (cancel === 'drop') h.Weapons.dropCurrent();
      else if (cancel === 'restore') h.Weapons.restore({ current: 'pistol', loaded: 1, reserve: 8 });
      else h.PlayerState.dead = true;
      h.tick(5);
      assert.deepEqual(h.events.filter(event => event.name === 'weaponMechanical').map(event => event.options.action),
        ['reload-start'], cancel + ' cannot finish an obsolete reload');
      if (cancel === 'death') {
        near(h.Weapons.reloading, remaining);
        assert.equal(h.Weapons.startReload(), false);
        h.Weapons.restore({ current: 'pistol', loaded: 1, reserve: 8 });
        h.PlayerState.dead = false; h.tick(5);
        near(h.Weapons.totalAmmo(), 9); assert.equal(h.events.length, 1);
      }
      assertLocked(h.audio, h.lockedCalls);
    } finally { h.dispose(); }
  }
  for (const [type, loaded, reserve] of [['fists', 0, 0], ['pistol', 12, 5], ['pistol', 0, 0]]) {
    const h = quietWeapons(type, loaded, reserve);
    try { assert.equal(h.Weapons.startReload(), false); assert.equal(h.events.length, 0); }
    finally { h.dispose(); }
  }
});

test('real melee input emits one windup and one delayed body contact, never a sound on every fan ray', () => {
  for (const type of ['fists', 'bat', 'knife']) {
    const h = quietWeapons(type), d = WEAPON_DEFS[type];
    try {
      h.Weapons.handleInput({ leftPressed: true }, STEP);
      h.Weapons.handleInput({ leftPressed: true }, STEP);
      assert.deepEqual(h.events.map(event => event.name), ['meleeSwing']);
      assert.equal(h.gameCalls.damage.length, 0);
      const contact = d.attackDuration * d.contactPhase;
      h.tick(contact - STEP / 2); assert.equal(h.events.length, 1);
      h.Weapons.update(0); assert.equal(h.events.length, 1);
      h.tick(STEP);
      assert.deepEqual(h.events.map(event => event.name), ['meleeSwing', 'meleeHit']);
      near(h.events[1].time, contact + STEP / 2);
      assert.deepEqual(h.gameCalls.damage, [d.dmg]);
      assert.deepEqual(h.events[1].options.pos, { x: 0, y: 0, z: -1 });
      assert.ok(h.events.every(event => event.options.weapon === type && event.options.environment === 'balcony'));
      h.tick(2); assert.equal(h.events.length, 2); assert.equal(h.gameCalls.damage.length, 1);
      assertLocked(h.audio, h.lockedCalls);
    } finally { h.dispose(); }
  }
});

test('real melee misses are silent except for a rendered wall contact and cancellation removes the late impact', () => {
  for (const scenario of ['air', 'wall', 'cancel']) {
    const h = quietWeapons('bat');
    try {
      h.ray.query = () => null;
      if (scenario !== 'air') h.wall();
      h.Weapons.handleInput({ leftPressed: true }, STEP);
      h.tick(0.1);
      if (scenario === 'cancel') h.Weapons.restore({ current: 'fists', loaded: 0, reserve: 0 });
      h.tick(1);
      assert.equal(h.gameCalls.damage.length, 0); assert.equal(h.gameCalls.hits.length, 0);
      assert.equal(h.gameCalls.kills, 0);
      assert.deepEqual(h.events.map(event => event.name), scenario === 'wall' ? ['meleeSwing', 'impact'] : ['meleeSwing']);
      if (scenario === 'wall') {
        assert.equal(h.events[1].options.surface, 'wood');
        assert.equal(h.events[1].options.environment, 'balcony');
        near(h.events[1].options.pos.z, -0.95);
        assert.equal(h.gameCalls.impacts.length, 1);
      }
      assertLocked(h.audio, h.lockedCalls);
    } finally { h.dispose(); }
  }
});

test('actual ranged triggers aggregate surface and body impact hooks while preserving per-pellet damage and one spent round', () => {
  for (const type of ['pistol', 'shotgun', 'smg', 'machinegun']) for (const hitBody of [false, true]) {
    const h = quietWeapons(type, 1, 0), d = WEAPON_DEFS[type];
    try {
      h.wall('metal', -6);
      h.ray.query = () => hitBody ? { enemy: h.enemy, part: 'body', point: new THREE.Vector3(0, 0, -4), dist: 4 } : null;
      h.Weapons.update(0); h.camera.updateWorldMatrix(true, true);
      h.Weapons.handleInput({ leftPressed: true, leftDown: true }, STEP);
      const shots = h.events.filter(event => event.name === d.sound), impacts = h.events.filter(event => event.name === 'impact');
      assert.equal(shots.length, 1); assert.equal(impacts.length, 1);
      assert.equal(impacts[0].options.surface, hitBody ? 'body' : 'metal');
      assert.ok(h.events.every(event => event.options.environment === 'balcony'));
      assert.equal(h.gameCalls.damage.length, hitBody ? d.pellets : 0);
      assert.equal(h.gameCalls.impacts.length, hitBody ? 0 : d.pellets);
      assert.deepEqual(h.gameCalls.shots, [hitBody]);
      near(h.Weapons.loaded, 0); near(h.Weapons.reserve, 0);
      assertLocked(h.audio, h.lockedCalls);
    } finally { h.dispose(); }
  }
});

test('actual enemy windups, contacts and spatial shots use the hard-muted engine and cleared actors emit nothing', () => {
  const { audio, calls } = lockedAudio(), events = [];
  let ai;
  ai = createEnemyAIHarness({ audio: actionRecorder(audio, events, () => ai.clock.elapsed) });
  try {
    ai.reset({ x: 5, y: 4.02, z: BALCONY.laneZ });
    const thug = ai.spawn('thug', { x: 6, y: 4, z: BALCONY.laneZ }, { zone: 'balcony' });
    for (let frame = 0; frame < 3 * 120 && ai.damage.length === 0; frame++) ai.step();
    const swing = events.find(event => event.name === 'meleeSwing'), hit = events.find(event => event.name === 'meleeHit');
    assert.ok(swing && hit && ai.damage.length === 1, 'The real AI must wind up and connect');
    assert.ok(Math.abs(hit.time - swing.time - thug.def.swingTime * 0.5) <= STEP + 1e-8,
      'NPC impact belongs to its midpoint contact phase, not the windup or the recovery end');
    assert.equal(hit.options.environment, 'balcony'); assert.equal(hit.options.weapon, 'bat');
    assert.ok(Object.values(hit.options.pos).every(Number.isFinite));
    ai.Enemies.clearAll();
    const previous = events.length;
    assert.equal(ai.enemyAttackPlayer(thug), false); ai.step();
    assert.equal(events.length, previous, 'Released pool ownership cannot emit a late impact');
    events.length = 0;
    ai.reset({ x: 24, y: 0.05, z: 12.2 });
    const gunman = ai.spawn('gunman', { x: 24, y: 0.05, z: 18 }, { zone: 'street' });
    for (let frame = 0; frame < 3 * 120 && ai.damage.length === 0; frame++) ai.step();
    const shot = events.find(event => /Shot$/.test(event.name)), body = events.find(event => event.options.surface === 'body');
    assert.ok(shot && body && ai.damage.length > 0, 'The actual ranged aim and shot must reach the player');
    assert.equal(shot.options.environment, 'street'); assert.equal(body.options.environment, 'street');
    assert.ok(Object.values(shot.options.pos).every(Number.isFinite));
    assert.ok(shot.options.pos.y > gunman.pos.y + 1, 'The spatial shot uses the muzzle, not the feet');
    assertLocked(audio, calls);
  } finally { ai.Enemies.clearAll(); ai.ballistics.clear(); ai.supplies.reset(); }
});
