/**
 * Visible development-only defense checks. No global test API is exposed.
 * The regression uses real world spawning and simulation, with explicitly
 * scripted damageEnemy defeats; the results preview is a labeled fixture.
 */
import { Audio } from '../core/audio.js';
import { Input } from '../core/input.js';
import { Colliders, capsuleHasClearance } from '../core/collision.js';
import { GameTime } from '../core/renderer.js';
import { Enemies, damageEnemy } from '../game/enemies.js';
import { Player, PlayerState } from '../game/player.js';
import { WeaponDrops } from '../game/weapons.js';
import { WEAPON_DEFS } from '../game/weapon-data.js';
import { CombatStats } from '../game/combat-stats.js';
import { EncounterSeeds } from '../game/encounter-session.js';
import { RunSettings } from '../game/run-settings.js';
import { createDefenseEncounter, defenseUnlockedWeapons } from '../game/defense-rules.js';
import { startRun, DefenseDirector } from '../game/mission.js';
import { EndCard, IntroCard, RunSetup } from '../ui/hud.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const yieldToPage = () => new Promise(resolve => setTimeout(resolve, 0));
const STEP = 1 / 60;

function assertSilent() {
  const audio = Audio.getStatus();
  assert(audio.hardMuted && audio.muted && !audio.running && !audio.initialized,
    'Defense QA requires hard mute and must never initialize an audio device');
}

export function installDifficultyQA(api) {
  const query = new URLSearchParams(location.search);
  if (!import.meta.env.DEV || query.get('qa') !== '1' || query.get('mute') !== '1') return null;
  const panel = document.getElementById('qa-panel');
  const body = document.getElementById('qa-body');
  const report = document.getElementById('qa-report');
  if (!panel || !body || !report || document.getElementById('qa-defense-run')) return null;
  for (const method of ['stepFrame', 'render', 'setTesting', 'setInspection', 'resetToApartment']) {
    assert(typeof api?.[method] === 'function', `Defense QA requires api.${method}()`);
  }

  let busy = false, disposed = false, preview = false;
  let restoreControls = () => {};
  const actions = document.createElement('div');
  actions.className = 'qa-row';
  actions.setAttribute('aria-label', 'Difficulty and tower defense checks');
  const runButton = document.createElement('button');
  runButton.type = 'button'; runButton.id = 'qa-defense-run';
  runButton.textContent = 'Run defense regression';
  const previewButton = document.createElement('button');
  previewButton.type = 'button'; previewButton.id = 'qa-defense-results';
  previewButton.textContent = 'Inspect defense results';
  actions.append(runButton, previewButton);
  body.prepend(actions);

  function describe(state, lines) {
    panel.dataset.state = report.dataset.state = state;
    report.textContent = lines.join('\n');
  }
  function begin() {
    if (busy || disposed || panel.dataset.state === 'running') return false;
    // Let the original visible menu action retire any existing NPC/weapon
    // inspection fixture before this independent check takes over the scene.
    document.getElementById('qa-menu')?.click();
    busy = true; preview = false;
    const controls = [...panel.querySelectorAll('button, select, input')].map(control => [control, control.disabled]);
    for (const [control] of controls) control.disabled = true;
    restoreControls = () => { for (const [control, disabled] of controls) control.disabled = disabled; };
    try {
      Audio.setMuted(true);
      Input.pause({ showOverlay: false });
      RunSetup.hide(); IntroCard.dismiss({ engage: false }); EndCard.hide();
      api.setTesting(true);
      assertSilent();
      return true;
    } catch (error) {
      try { resetToMenu(); } catch { /* Retain the original setup failure. */ }
      finish();
      describe('fail', [`DEFENSE QA SETUP FAILED · ${error.message || String(error)}`]);
      return false;
    }
  }
  function resetToMenu() {
    Input.pause({ showOverlay: false });
    RunSetup.hide(); IntroCard.dismiss({ engage: false }); EndCard.hide();
    assert(api.resetToApartment() !== false, 'The fresh apartment reset failed');
    api.setInspection(false);
    document.body.classList.remove('qa-scene-inspection', 'qa-npc-inspection', 'qa-held-inspection', 'qa-transition-inspection');
    document.getElementById('overlay')?.classList.remove('hidden');
    const zone = document.getElementById('qa-zone');
    if (zone) zone.value = 'apartment';
    Input.pause();
    api.render();
    assert(!RunSettings.isStarted() && !Input.active && !PlayerState.dead,
      'QA must leave a fresh, paused game menu with no locked run');
  }
  function finish() {
    api.setTesting(false);
    restoreControls(); busy = false;
  }

  async function checkArena(arena, lines) {
    assert(api.resetToApartment() !== false, 'Could not reset before defense');
    RunSettings.configure({ mode: 'defense', arena, waves: 10, difficulty: 'average' });
    RunSettings.start();
    assert(startRun(), `${arena}: the real run start failed`);
    api.setInspection(true);
    api.setInspection(false);
    Input.activate();
    const config = createDefenseEncounter(RunSettings.snapshot());
    const seenEntries = new Set(), observed = config.waves.map(() => []), supplyWaves = new Set();
    const issuedSupplyWaves = new Set();
    const startedAt = GameTime.elapsed;
    let priorWave = 0, priorCleared = 0;
    for (let tick = 0; tick < 240 / STEP; tick++) {
      assert(!disposed && !document.hidden, 'Keep the QA page visible until the defense check finishes');
      const progressed = api.stepFrame(STEP);
      const state = DefenseDirector.snapshot();
      assert(progressed > 0 || state.resolved, `${arena}: the real gameplay clock stopped`);
      assert(!PlayerState.dead && Player.health > 0, `${arena}: the scripted scheduler fixture unexpectedly died`);
      assert(state.wave >= priorWave && state.wave <= priorWave + 1, `${arena}: wave numbering skipped`);
      assert(state.wavesSurvived >= priorCleared && state.wavesSurvived <= priorCleared + 1, `${arena}: clear numbering skipped`);
      priorWave = state.wave; priorCleared = state.wavesSurvived;

      const supplies = state.supplies;
      assert(supplies?.arena === arena && supplies.difficulty === 'average', `${arena}: resupply lost its run settings`);
      assert(supplies.wave === Math.min(10, state.wavesSurvived + 1), `${arena}: supplies did not follow the next wave`);
      assert(supplies.supplies.length === 3 && supplies.active <= 3, `${arena}: supply pool grew beyond three cases`);
      supplyWaves.add(supplies.wave);
      if (!supplies.pending) issuedSupplyWaves.add(supplies.wave);
      for (const entry of supplies.supplies) {
        const budget = supplies.budget[entry.kind === 'ammo' ? 'ammoUnits' : entry.kind];
        assert(Number.isFinite(entry.amount) && entry.amount >= 0 && entry.amount <= budget, `${arena}: invalid ${entry.kind} budget`);
      }
      for (const supplied of supplies.weapons) {
        assert(WeaponDrops.list.some(drop => drop.defenseSupply && drop.weaponType === supplied.type),
          `${arena}: ${supplied.type} resupply has no physical weapon drop`);
      }

      const living = Enemies.list.filter(enemy => enemy.alive && !enemy.removed);
      assert(living.length <= config.maxAlive, `${arena}: live enemy cap exceeded`);
      for (const enemy of living) {
        assert(enemy.encounterKey === 'defense-' + arena && enemy.zone === arena, `${arena}: enemy belongs to another encounter`);
        assert(Number.isInteger(enemy.encounterWave) && observed[enemy.encounterWave], `${arena}: enemy has no valid wave`);
        const key = `${enemy.encounterWave}:${enemy.encounterEntry}`;
        assert(!seenEntries.has(key), `${arena}: a wave entry spawned more than once`);
        assert(capsuleHasClearance(enemy.pos, enemy.radius, enemy.height, Colliders.list, 1e-5),
          `${arena}: ${enemy.type} spawned inside world geometry`);
        assert(defenseUnlockedWeapons(enemy.encounterWave + 1).includes(enemy.def.weaponType),
          `${arena}: ${enemy.def.weaponType} arrived before its weapon stage`);
        seenEntries.add(key); observed[enemy.encounterWave].push(enemy.type);
        // This is an explicit scheduler/death fixture, not player aiming or
        // balance validation. It intentionally does not award weapon stats.
        assert(damageEnemy(enemy, 10000, 'body')?.killed, `${arena}: scripted damage could not defeat an arrival`);
      }
      if (state.resolved) {
        assert(state.wavesSurvived === 10 && state.wave === 10 && state.pending === 0 && living.length === 0,
          `${arena}: victory occurred before every wave cleared`);
        assert(state.spawned === config.totalContacts && seenEntries.size === config.totalContacts,
          `${arena}: victory skipped scheduled enemies`);
        for (const [wave, roster] of config.waves.entries()) {
          assert(JSON.stringify(observed[wave].sort()) === JSON.stringify([...roster].sort()),
            `${arena}: wave ${wave + 1} did not deliver its complete authored defense roster`);
        }
        assert(supplyWaves.size === 10 && issuedSupplyWaves.size === 10, `${arena}: one or more wave supplies never reached the scene`);
        assert(document.getElementById('endcard')?.classList.contains('show'), `${arena}: the victory screen did not open`);
        assert(document.getElementById('enddifficulty')?.textContent === 'Average', `${arena}: victory omitted difficulty`);
        assert(document.getElementById('endwaves')?.textContent === '10 / 10', `${arena}: victory omitted completed waves`);
        assertSilent();
        lines.push(`PASS · ${arena === 'roof' ? 'Rooftop' : 'Street'} · Average · 10 / 10 waves · ${seenEntries.size} arrivals · 10 resupplies · ${(GameTime.elapsed - startedAt).toFixed(1)}s simulated`);
        describe('running', lines); api.render();
        await yieldToPage();
        return;
      }
      if (tick % 120 === 0) {
        assertSilent();
        describe('running', [...lines, `RUNNING · ${arena} · wave ${state.wave} / 10 · ${seenEntries.size} scripted defeats`]);
        api.render();
        await yieldToPage();
      }
    }
    throw new Error(`${arena}: defense did not finish within 240 simulated seconds`);
  }

  async function runRegression() {
    if (!begin()) return;
    const priorSeed = EncounterSeeds.setOverride(0x5eed);
    const lines = ['DEFENSE REGRESSION · real scene, physics, schedules and death/drop paths',
      'Explicit QA damageEnemy defeats; this does not test human aiming or combat balance.'];
    let failure = null;
    try {
      for (const arena of ['roof', 'street']) await checkArena(arena, lines);
    } catch (error) { failure = error; }
    finally {
      EncounterSeeds.setOverride(priorSeed);
      try { resetToMenu(); assertSilent(); }
      catch (error) { failure ||= error; }
      finish();
    }
    if (failure) lines.push(`FAIL · ${failure.message || String(failure)}`);
    else lines.push('RESTORED · Fresh game menu · difficulty selection required · audio locked off');
    describe(failure ? 'fail' : 'pass', lines);
  }

  function inspectResults() {
    if (!begin()) return;
    try {
      assert(api.resetToApartment() !== false, 'Could not reset the result fixture');
      RunSettings.configure({ mode: 'defense', arena: 'roof', waves: 20, difficulty: 'hard' });
      RunSettings.start();
      assert(startRun(), 'Could not start the result fixture');
      DefenseDirector.reset();
      CombatStats.reset();
      for (const [type, attacks, hits, kills, headshots] of [
        ['fists', 8, 5, 2, 0], ['bat', 12, 9, 5, 1], ['knife', 6, 4, 2, 0],
        ['pistol', 30, 21, 10, 4], ['shotgun', 22, 17, 15, 3],
        ['smg', 45, 30, 12, 2], ['machinegun', 60, 42, 24, 7],
      ]) {
        const def = WEAPON_DEFS[type];
        for (let attack = 0; attack < attacks; attack++) {
          const hit = attack < hits;
          const damage = def.dmg * (def.pellets || 1);
          if (def.kind === 'ranged') CombatStats.recordShot(hit, type, hit ? damage : 0);
          else CombatStats.recordMelee(hit, type, hit ? damage : 0);
        }
        for (let kill = 0; kill < kills; kill++) CombatStats.recordKill(kill < headshots, type);
      }
      api.setInspection(false);
      EndCard.show('— DEFENSE COMPLETE · QA FIXTURE —', 'YOU HELD THE LINE',
        'QA RESULTS FIXTURE · Deterministic sample statistics for visual inspection.\nThese recorded weapon results and 20 completed waves were not played.',
        CombatStats.snapshot(), { wavesSurvived: 20, wavesTotal: 20 });
      preview = true;
      api.render(); assertSilent();
      describe('ready', ['RESULTS FIXTURE · production victory screen · Hard · rooftop · 20 / 20 waves',
        'Sample statistics use the real CombatStats record methods. Favorite: MACHINE GUN.',
        'Use Return to game menu or Reset apartment to clear this fixture. Audio is locked off.']);
    } catch (error) {
      try { resetToMenu(); } catch { /* Retain the original failure. */ }
      describe('fail', [`RESULTS FIXTURE FAILED · ${error.message || String(error)}`]);
    } finally { finish(); }
  }

  function leavePreview() {
    if (!preview || busy) return;
    preview = false;
    try { resetToMenu(); describe('ready', ['GAME MENU · Results fixture cleared · audio locked off']); }
    catch (error) { describe('fail', [`FIXTURE RESET FAILED · ${error.message || String(error)}`]); }
  }
  runButton.addEventListener('click', runRegression);
  previewButton.addEventListener('click', inspectResults);
  const menu = document.getElementById('qa-menu'), reset = document.getElementById('qa-reset');
  menu?.addEventListener('click', leavePreview);
  reset?.addEventListener('click', leavePreview);
  return {
    dispose() {
      disposed = true;
      menu?.removeEventListener('click', leavePreview);
      reset?.removeEventListener('click', leavePreview);
      if (preview && !busy) resetToMenu();
      actions.remove();
    },
  };
}
