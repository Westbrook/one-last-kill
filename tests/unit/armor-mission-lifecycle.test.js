import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Group, Vector3 } from 'three';
import { createArmorPickups } from '../../src/game/armor-pickups.js';
import { CHECKPOINTS, FINAL_ENCOUNTERS } from '../../src/game/mission-data.js';

const source = readFileSync(new URL('../../src/game/mission.js', import.meta.url), 'utf8');
const endingStart = source.indexOf('const Endings = (() => {');
const endingEnd = source.indexOf('\nfunction initMission()', endingStart);
const zoneChange = source.match(/^function handleZoneChange\([^]*?^\}/m)?.[0];
assert.ok(endingStart >= 0 && endingEnd > endingStart && zoneChange, 'exercise actual branch and zone lifecycles');
const noOp = () => {};

test('committing the bakery branch keeps survivor and bakery vests collectible across its zone trigger', () => {
  const player = { health: 100, armor: 0, pos: new Vector3(0, 1.72, 0), _eyeH: 1.72 };
  const pickups = createArmorPickups();
  pickups.init({ world: new Group(), player, colliders: [] });
  pickups.setZone('street');
  const oldStreetVest = pickups.spawn(2, 0, 0, 100, 'street');
  const checkpoints = [];
  // Run the complete production ending/zone handlers; encounter scheduling and
  // presentation are sinks so this regression isolates pickup accessibility.
  const mission = runInNewContext(`
let checkpoint = { zone: 'street' }, restoringCheckpoint = false;
const spawnCursors = new Map();
${source.slice(endingStart, endingEnd)}
${zoneChange}
;({ Endings, handleZoneChange });`, {
    CHECKPOINTS, FINAL_ENCOUNTERS, Player: player,
    EncounterSeeds: { next: () => 1 },
    EncounterSchedule: class {
      constructor(config) { this.config = config; }
      update() {}
    },
    createEncounterCounts: () => ({}), encounterStatus: () => ({ remaining: 1 }),
    spawnScheduled: noOp, Enemies: { clearAll: noOp },
    WaveDirector: { lockFinal: noOp }, StreetChoice: { dismiss: noOp },
    saveCheckpoint: (...args) => checkpoints.push(args),
    HealPickups: { setZone: noOp }, ArmorPickups: pickups, AmmoSupplies: { setZone: noOp },
    ObjectiveBanner: { show: noOp }, HUD: { setObjective: noOp },
  }, { filename: 'src/game/mission.js:armor-branch-lifecycle' });

  mission.Endings.beginBakery();
  assert.deepEqual(checkpoints, [['bakery', 'bakery']]);
  const bakeryVest = pickups.spawn(0, 0, 0, 50, 'bakery');
  assert.equal(oldStreetVest.mesh.visible, true);
  assert.equal(bakeryVest.mesh.visible, true);
  pickups.update(1 / 120);
  assert.equal(player.armor, 50);
  assert.equal(bakeryVest.active, false);
  assert.equal(oldStreetVest.active, true);
  // Once committed, the ordinary zone handler returns early. Physical loot
  // remains available on either side of that trigger, regardless of origin.
  mission.handleZoneChange('bakery');
  player.pos.x = 2;
  pickups.update(1 / 120);
  assert.equal(player.armor, 100);
  assert.equal(oldStreetVest.active, false);
});
