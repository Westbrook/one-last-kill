import { clamp } from '../core/math.js';
import { Input, engageLock } from '../core/input.js';
import { Audio } from '../core/audio.js';
import { AUDIO_MIX_SETTINGS, Settings } from '../core/settings.js';
import { CombatStats } from '../game/combat-stats.js';
import { DIFFICULTY_LEVELS, RunSettings } from '../game/run-settings.js';

const byId = (id) => document.getElementById(id);
const write = (element, value) => {
  const text = String(value ?? '');
  if (element && element.textContent !== text) element.textContent = text;
};
const padded = (value) => String(Math.max(0, Math.round(value))).padStart(2, '0');
const nonNegative = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, value) : fallback;
const ZONE_ORDER = ['apartment', 'neighbor', 'balcony', 'stairwell', 'roof', 'scaffolding', 'street', 'bakery'];
const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const OFFSCREEN_DIRECTIONS = new Set(['BEHIND', 'LEFT', 'RIGHT', 'ABOVE', 'BELOW']);

/** The HUD only writes changed values; the simulation owns all gameplay state. */
const HUD = (() => {
  const healthfill = byId('healthfill');
  const healthtext = byId('healthtext');
  const healthbar = byId('healthbar');
  const armorbar = byId('armorbar');
  const armortext = byId('armortext');
  const armorReadout = byId('armorreadout');
  const vitals = byId('vitals');
  const healthVignette = byId('healthvignette');
  const healthWarningEl = byId('healthwarning');
  const rageCue = byId('ragecue');
  const rageLabel = byId('ragelabel');
  const rageKey = byId('ragekey');
  const rageCountdown = byId('ragecountdown');
  const rageHint = byId('ragehint');
  const weaponbox = byId('weaponbox');
  const weaponname = byId('weaponname');
  const ammoEl = byId('ammo');
  const ammoCurrent = byId('ammocurrent');
  const ammoReserve = byId('ammoreserve');
  const ammoSeparator = byId('ammoseparator');
  const messageEl = byId('message');
  const objective = byId('objective');
  const bloodEl = byId('bloodvignette');
  const deathEl = byId('deathscreen');
  const pickupEl = byId('pickupprompt');
  const reloadEl = byId('reloadindicator');
  const hitEl = byId('hitmarker');
  const killEl = byId('killmessage');
  const directionEl = byId('damageindicator');
  const threatEl = byId('offscreenthreat');
  const threatLabel = byId('offscreenthreatlabel');
  const threatCount = byId('offscreenthreatcount');
  const compassHeading = byId('compassheading');
  const compassDirection = byId('compassdirection');
  const compassLeft = byId('compassleft');
  const compassRight = byId('compassright');
  const combatSummary = byId('combatsummary');
  const killCount = byId('killcount');
  const combatStreak = byId('combatstreak');
  let messageTimer = 0, bloodOpacity = 0, hitTimer = 0, killTimer = 0, directionTimer = 0;
  let lastHeading = -1, lastOctant = -1;
  let threatPresentation = '', threatAngle = '', threatVisible = false;
  let healthWarning = 'normal';
  const rageState = { available: false, active: false, remaining: 0, gamepad: false };
  const state = { health: 100, armor: 0, weapon: 'FISTS', ammo: '∞', kills: 0, shots: 0, hits: 0, headshots: 0, streak: 0, bestStreak: 0 };

  function syncHealthWarning() {
    const level = state.health > 0 && !deathEl.classList.contains('show')
      ? state.health < 20 ? 'critical' : state.health < 40 ? 'low' : 'normal'
      : 'normal';
    if (level === healthWarning) return;
    healthWarning = level;
    healthVignette.dataset.level = level;
    healthVignette.hidden = level === 'normal';
    vitals.dataset.healthWarning = level;
    write(healthWarningEl, level === 'critical' ? 'CRITICAL HEALTH' : level === 'low' ? 'LOW HEALTH' : '');
  }

  function clearOffscreenThreat() {
    if (!threatVisible && !threatPresentation && !threatAngle && threatEl.hidden && threatEl.getAttribute('aria-hidden') === 'true') return;
    threatEl.hidden = true;
    threatEl.classList.remove('show');
    threatEl.setAttribute('aria-hidden', 'true');
    threatEl.removeAttribute('aria-label');
    if (threatAngle) threatEl.style.removeProperty('--threat-angle');
    delete threatEl.dataset.direction;
    delete threatEl.dataset.phase;
    write(threatLabel, '');
    write(threatCount, '');
    threatCount.hidden = true;
    threatPresentation = threatAngle = '';
    threatVisible = false;
  }

  /** Presentation only: the caller owns source visibility, attack phase and lifetime. */
  function setOffscreenThreat(threat) {
    if (!threat || !Number.isFinite(threat.angle) || !OFFSCREEN_DIRECTIONS.has(threat.direction)
      || (threat.phase !== 'windup' && threat.phase !== 'hit') || deathEl.classList.contains('show')) {
      clearOffscreenThreat();
      return;
    }
    const count = Math.max(1, Math.floor(nonNegative(threat.count, 1)));
    const countText = count > 1 ? (count > 99 ? '99+' : String(count)) + ' ATTACKERS' : '';
    const presentation = threat.direction + ':' + threat.phase + ':' + countText;
    if (presentation !== threatPresentation) {
      const action = threat.phase === 'hit' ? 'HIT' : 'ATTACK';
      write(threatLabel, action + ' FROM ' + threat.direction);
      write(threatCount, countText);
      threatCount.hidden = !countText;
      threatEl.dataset.direction = threat.direction;
      threatEl.dataset.phase = threat.phase;
      threatEl.setAttribute('aria-label', (threat.phase === 'hit' ? 'Hit' : 'Attack') + ' from ' + threat.direction.toLowerCase() + (countText ? '. ' + countText.toLowerCase() : '') + '.');
      threatPresentation = presentation;
    }
    // Quantize the display rotation, not the gameplay bearing. Tiny numerical
    // changes need not mutate styles or repeatedly announce the same warning.
    const turn = Math.PI * 2;
    const angle = (((threat.angle % turn) + turn) % turn).toFixed(3);
    if (angle !== threatAngle) {
      threatEl.style.setProperty('--threat-angle', angle + 'rad');
      threatAngle = angle;
    }
    if (!threatVisible) {
      threatEl.hidden = false;
      threatEl.classList.add('show');
      threatEl.setAttribute('aria-hidden', 'false');
      threatVisible = true;
    }
  }

  function clearFeedback() {
    clearOffscreenThreat();
    setRage();
    messageTimer = bloodOpacity = hitTimer = killTimer = directionTimer = 0;
    bloodEl.style.opacity = '0';
    messageEl.style.opacity = '0';
    hitEl.classList.remove('show', 'killed', 'headshot');
    killEl.classList.remove('show');
    directionEl.classList.remove('show');
    pickupEl.classList.remove('show');
    reloadEl.classList.remove('show');
    pickupEl.setAttribute('aria-hidden', 'true');
    reloadEl.setAttribute('aria-hidden', 'true');
  }

  /** The simulation owns eligibility and the clock, including paused time. */
  function setRage({ available = false, active = false, remaining = 0, gamepad = false } = {}) {
    const alive = !deathEl.classList.contains('show');
    rageState.active = alive && Boolean(active);
    rageState.available = alive && !rageState.active && Boolean(available);
    rageState.remaining = rageState.active ? nonNegative(remaining) : 0;
    rageState.gamepad = Boolean(gamepad);
    const mode = rageState.active ? 'active' : rageState.available ? 'available' : 'inactive';
    const hidden = mode === 'inactive';
    const key = Settings.get('touchControls') ? 'TAP RAGE' : gamepad ? 'D-PAD UP' : 'T';
    const seconds = Math.ceil(rageState.remaining);
    if (rageCue.dataset.state !== mode) rageCue.dataset.state = mode;
    if (rageCue.hidden !== hidden) rageCue.hidden = hidden;
    if (rageCue.getAttribute('aria-hidden') !== String(hidden)) rageCue.setAttribute('aria-hidden', String(hidden));
    write(rageLabel, rageState.active ? 'RAGE' : rageState.available ? 'ENTER RAGE' : '');
    write(rageKey, rageState.available ? key : '');
    if (rageKey.hidden !== !rageState.available) rageKey.hidden = !rageState.available;
    write(rageCountdown, rageState.active ? seconds + 's' : '');
    if (rageCountdown.hidden !== !rageState.active) rageCountdown.hidden = !rageState.active;
    const timerDescription = rageState.active ? seconds + ' seconds remaining' : '';
    if (rageCountdown.getAttribute('aria-label') !== timerDescription) rageCountdown.setAttribute('aria-label', timerDescription);
    write(rageHint, rageState.active ? 'KILL TO KEEP BOOSTED HEALTH' : rageState.available ? 'DOUBLE YOUR CURRENT HEALTH' : '');
  }

  return {
    setHealth(value) {
      const health = clamp(nonNegative(value, 100), 0, 100);
      if (state.health !== health || healthbar.getAttribute('aria-valuenow') !== String(health)) {
        state.health = health;
        healthfill.style.width = health + '%';
        write(healthtext, Math.round(health));
        healthbar.setAttribute('aria-valuenow', String(health));
        const low = String(health > 0 && health < 40);
        if (vitals.dataset.low !== low) vitals.dataset.low = low;
      }
      syncHealthWarning();
      const description = Math.round(health * 100) / 100 + ' percent health'
        + (healthWarning === 'critical' ? '. Critical health.' : healthWarning === 'low' ? '. Low health.' : '.');
      if (healthbar.getAttribute('aria-valuetext') !== description) healthbar.setAttribute('aria-valuetext', description);
    },
    setArmor(value) {
      const armor = clamp(nonNegative(value), 0, 100);
      if (state.armor === armor && armorbar.getAttribute('aria-valuenow') === String(armor)) return;
      state.armor = armor;
      armorbar.style.setProperty('--armor-remaining', armor + '%');
      armorbar.setAttribute('aria-valuenow', String(armor));
      armorbar.setAttribute('aria-valuetext', armor > 0
        ? Math.round(armor * 100) / 100 + ' percent armor. Absorbs damage before health.'
        : 'No armor equipped.');
      // A fractional last point still provides protection, so do not label it 0.
      write(armortext, Math.ceil(armor));
      if (armorReadout.hidden !== (armor === 0)) armorReadout.hidden = armor === 0;
    },
    setWeapon(name, ammoString) {
      state.weapon = String(name);
      state.ammo = String(ammoString);
      write(weaponname, name);
      const parts = String(ammoString).split('/').map((part) => part.trim());
      const ranged = parts.length > 1;
      write(ammoCurrent, parts[0]);
      write(ammoReserve, ranged ? parts[1] : '');
      ammoSeparator.hidden = !ranged;
      ammoReserve.hidden = !ranged;
      ammoEl.setAttribute('aria-label', ranged ? parts[0] + ' rounds loaded, ' + parts[1] + ' in reserve' : 'Unlimited melee attacks');
      write(byId('weaponclass'), ranged ? 'PRIMARY WEAPON' : 'CLOSE QUARTERS');
      weaponbox.dataset.empty = String(ranged && Number(parts[0]) === 0);
    },
    setObjective(text) { write(objective, text); },
    message(text, seconds = 2.5) {
      write(messageEl, text);
      messageEl.style.opacity = '1';
      messageTimer = Math.max(0.1, nonNegative(seconds, 2.5));
    },
    bloodFlash(strength = 1) {
      bloodOpacity = Math.max(bloodOpacity, clamp(nonNegative(strength), 0, 1));
      bloodEl.style.opacity = bloodOpacity.toFixed(3);
    },
    damageDirection(angle) {
      if (!Number.isFinite(angle)) return;
      directionEl.style.setProperty('--damage-angle', angle + 'rad');
      directionEl.classList.add('show');
      directionTimer = 0.65;
    },
    setOffscreenThreat,
    setRage,
    showDeath(on) {
      clearFeedback();
      deathEl.classList.toggle('show', Boolean(on));
      deathEl.setAttribute('aria-hidden', String(!on));
      deathEl.setAttribute('role', 'dialog');
      deathEl.setAttribute('aria-modal', String(Boolean(on)));
      // The persistent warning follows health, not the damage-flash timer.
      // Recompute after a death/retry transition even if health is unchanged.
      syncHealthWarning();
      if (on) {
        byId('overlay').classList.add('hidden');
        byId('restartbutton')?.focus({ preventScroll: true });
      }
    },
    setPickupPrompt(text) {
      const prompt = text && Settings.get('touchControls') ? String(text).replace(/^\[E\]/, '[USE]') : text;
      write(pickupEl, prompt || '');
      pickupEl.classList.toggle('show', Boolean(text));
      pickupEl.setAttribute('aria-hidden', String(!text));
    },
    setReloading(on) {
      reloadEl.classList.toggle('show', Boolean(on));
      reloadEl.setAttribute('aria-hidden', String(!on));
    },
    hit({ killed = false, headshot = false } = {}) {
      hitEl.classList.add('show');
      hitEl.classList.toggle('killed', killed);
      hitEl.classList.toggle('headshot', headshot);
      hitTimer = killed ? 0.26 : 0.13;
      if (killed || headshot) {
        write(killEl, killed ? (headshot ? 'HEADSHOT / HOSTILE DOWN' : 'HOSTILE DOWN') : 'HEADSHOT');
        killEl.classList.add('show');
        killTimer = killed ? 1.4 : 0.65;
      }
    },
    setCombat(stats = {}) {
      const nextKills = nonNegative(stats.kills, state.kills);
      if (nextKills < state.kills) state.bestStreak = 0;
      for (const key of ['kills', 'shots', 'hits', 'headshots', 'streak']) state[key] = nonNegative(stats[key], state[key]);
      state.bestStreak = Number.isFinite(stats.bestStreak) ? nonNegative(stats.bestStreak) : Math.max(state.bestStreak, state.streak);
      write(killCount, padded(state.kills));
      write(combatStreak, state.streak > 1 ? '× ' + padded(state.streak) : '');
      combatSummary.classList.toggle('show', state.kills > 0);
    },
    setCompass(yaw) {
      if (!Number.isFinite(yaw)) return;
      const heading = Math.round(((-yaw * 180 / Math.PI) % 360 + 360) % 360) % 360;
      if (heading === lastHeading) return;
      lastHeading = heading;
      write(compassHeading, String(heading).padStart(3, '0') + '°');
      const octant = Math.round(heading / 45) % 8;
      if (octant === lastOctant) return;
      lastOctant = octant;
      write(compassDirection, DIRECTIONS[octant]);
      write(compassLeft, DIRECTIONS[(octant + 7) % 8]);
      write(compassRight, DIRECTIONS[(octant + 1) % 8]);
    },
    /** progress accepts a caption, a 0–1 fraction, or { current, total }. */
    setStatus(value = {}) {
      const options = typeof value === 'string' ? { status: value } : value;
      if (!options) return;
      if (options.status != null) write(byId('playerstatus'), options.status);
      if (options.chapter != null) write(byId('chapterlabel'), String(options.chapter).toUpperCase());
      if (options.aiming != null) byId('hud').dataset.aiming = String(Boolean(options.aiming));
      const progress = options.progress;
      const meter = byId('missionmeter');
      if (options.progressLabel) meter.setAttribute('aria-label', options.progressLabel);
      if (typeof progress === 'string') write(byId('missionprogress'), progress);
      else if (typeof progress === 'number' && Number.isFinite(progress)) {
        meter.max = 1;
        meter.value = clamp(progress, 0, 1);
        write(byId('missionprogress'), Math.round(meter.value * 100) + '%');
      } else if (progress && typeof progress === 'object') {
        const total = Math.max(1, nonNegative(progress.total, 1));
        const current = clamp(nonNegative(progress.current), 0, total);
        meter.max = total;
        meter.value = current;
        write(byId('missionprogress'), padded(current) + ' / ' + padded(total));
      }
    },
    snapshot() {
      return { ...state, healthWarning, rage: { ...rageState }, accuracy: state.shots ? Math.round(clamp(state.hits / state.shots, 0, 1) * 100) : 0 };
    },
    update(dt) {
      const delta = nonNegative(dt);
      if (messageTimer > 0 && (messageTimer -= delta) <= 0) messageEl.style.opacity = '0';
      if (bloodOpacity > 0) {
        bloodOpacity = Math.max(0, bloodOpacity - delta * 1.6);
        bloodEl.style.opacity = bloodOpacity.toFixed(3);
      }
      if (hitTimer > 0 && (hitTimer -= delta) <= 0) hitEl.classList.remove('show');
      if (killTimer > 0 && (killTimer -= delta) <= 0) killEl.classList.remove('show');
      if (directionTimer > 0 && (directionTimer -= delta) <= 0) directionEl.classList.remove('show');
    },
    clearFeedback,
  };
})();

const ObjectiveBanner = (() => {
  const element = byId('banner');
  const label = element.querySelector('small');
  const title = element.querySelector('span');
  let currentTime = 0, hideAt = 0;
  return {
    show(zone, text) {
      const name = String(zone || '').replaceAll('_', ' ');
      write(label, name);
      write(title, text);
      element.classList.add('show');
      hideAt = currentTime + 4.5;
      const index = ZONE_ORDER.indexOf(zone);
      HUD.setStatus({ chapter: name, progressLabel: 'Mission route progress', ...(index >= 0 ? { progress: { current: index + 1, total: ZONE_ORDER.length } } : {}) });
    },
    hide() { element.classList.remove('show'); hideAt = 0; },
    update(now) {
      if (!Number.isFinite(now)) return;
      if (now < currentTime && hideAt > 0) hideAt = now + 4.5;
      currentTime = now;
      if (hideAt > 0 && now >= hideAt) this.hide();
    },
  };
})();

function runDescription(run = RunSettings.snapshot()) {
  const difficulty = DIFFICULTY_LEVELS.find(level => level.id === run.difficulty)?.label ?? 'Not selected';
  const arena = run.arena === 'street' ? 'Street' : 'Rooftop';
  return {
    difficulty,
    arena,
    mode: run.mode === 'defense' ? 'Tower defense / ' + arena : 'Story campaign',
    summary: run.mode === 'defense'
      ? 'TOWER DEFENSE / ' + arena.toUpperCase() + ' · ' + run.waves + ' WAVES · ' + difficulty.toUpperCase()
      : 'STORY CAMPAIGN · ' + difficulty.toUpperCase(),
  };
}

/** Selection is temporary until the explicit Begin action; gameplay owns the lock. */
const RunSetup = (() => {
  const element = byId('runsetup');
  const form = byId('runsetupform');
  const mode = byId('runmode');
  const arena = byId('runarena');
  const waves = byId('runwaves');
  const difficulty = byId('rundifficulty');
  const defenseOptions = byId('rundefenseoptions');
  const confirm = byId('runsetupconfirm');
  const back = byId('runsetupback');
  const error = byId('runsetuperror');
  let open = false;
  let previousPad = null, controllerFocus = null;

  function clearControllerFocus() {
    controllerFocus?.setAttribute('data-controller-focus', 'false');
    controllerFocus = null;
  }
  function focusFromController(control) {
    clearControllerFocus();
    controllerFocus = control;
    control.setAttribute('data-controller-focus', 'true');
    // Native scrolling keeps a focused control visible in short viewports.
    control.focus();
  }

  for (const level of DIFFICULTY_LEVELS) {
    const option = document.createElement('option');
    option.value = level.id;
    option.textContent = level.label;
    difficulty.append(option);
  }

  function sync() {
    const defense = mode.value === 'defense';
    write(byId('runsetupconfirmlabel'), defense ? 'BEGIN DEFENSE' : 'BEGIN MISSION');
    defenseOptions.hidden = !defense;
    defenseOptions.disabled = !defense;
    write(byId('runmodehelp'), defense
      ? 'Hold one location against recurring waves. Survive every wave to win.'
      : 'Fight your way through Little Sicily and choose how the night ends.');
    const selected = DIFFICULTY_LEVELS.find(level => level.id === difficulty.value);
    write(byId('rundifficultydescription'), selected?.description
      ?? 'Difficulty controls enemy numbers, their weapons and damage, time between waves, and supplies. Below Average, health regenerates automatically.');
    confirm.disabled = !selected || RunSettings.isLocked();
    error.hidden = true;
  }

  function hide({ restoreFocus = false } = {}) {
    if (!open) return false;
    open = false;
    previousPad = null;
    clearControllerFocus();
    element.classList.remove('show');
    element.setAttribute('aria-hidden', 'true');
    byId('overlay').inert = false;
    if (restoreFocus) byId('startbutton').focus({ preventScroll: true });
    return true;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
    if (!open) return;
    if (RunSettings.isLocked()) {
      write(error, 'This run has started. Difficulty and game mode are locked.');
      error.hidden = false;
      confirm.disabled = true;
      return;
    }
    let configuration;
    try {
      configuration = RunSettings.configure({ difficulty: difficulty.value, mode: mode.value, arena: arena.value, waves: Number(waves.value) });
    } catch {
      write(error, 'Choose a difficulty, location and wave count before you begin.');
      error.hidden = false;
      difficulty.focus({ preventScroll: true });
      return;
    }
    hide();
    document.dispatchEvent(new CustomEvent('run:configured', { detail: configuration }));
  });
  for (const field of [mode, difficulty, arena, waves]) field.addEventListener('change', sync);
  back.addEventListener('click', event => {
    event.stopPropagation();
    hide({ restoreFocus: true });
  });
  element.addEventListener('pointerdown', clearControllerFocus);
  element.addEventListener('keydown', clearControllerFocus);

  function pollGamepad(pad) {
    if (!open) return false;
    if (!pad) { previousPad = null; return true; }
    const pressed = index => Boolean(pad.buttons?.[index]?.pressed);
    const current = {
      up: pressed(12) || pad.axes?.[1] < -0.55,
      down: pressed(13) || pad.axes?.[1] > 0.55,
      left: pressed(14) || pad.axes?.[0] < -0.55,
      right: pressed(15) || pad.axes?.[0] > 0.55,
      confirm: pressed(0), back: pressed(1),
    };
    // The A press that opened setup is still held on its first sampled frame.
    if (!previousPad) { previousPad = current; return true; }
    const edge = name => current[name] && !previousPad[name];
    const move = edge('down') ? 1 : edge('up') ? -1 : 0;
    const change = edge('right') ? 1 : edge('left') ? -1 : 0;
    const accept = edge('confirm'), cancel = edge('back');
    previousPad = current;
    if (cancel) { hide({ restoreFocus: true }); return true; }
    const controls = [mode, ...(mode.value === 'defense' ? [arena, waves] : []), difficulty, ...(!confirm.disabled ? [confirm] : []), back];
    let index = controls.indexOf(document.activeElement);
    if (index < 0) index = controls.indexOf(difficulty);
    const control = controls[index];
    if (move) {
      focusFromController(controls[(index + move + controls.length) % controls.length]);
    } else if (change && control.options) {
      const options = Array.from(control.options, option => option.value);
      const selected = Math.max(0, options.indexOf(control.value));
      control.value = options[(selected + change + options.length) % options.length];
      sync();
      focusFromController(control);
    } else if (accept) {
      if (control === back) hide({ restoreFocus: true });
      else if (control === confirm) confirm.click();
      else if (control === difficulty && !difficulty.value) {
        write(error, 'Use left or right to choose a difficulty.');
        error.hidden = false;
        focusFromController(difficulty);
      } else focusFromController(controls[(index + 1) % controls.length]);
    }
    return true;
  }

  return {
    present() {
      if (RunSettings.isLocked()) return false;
      const run = RunSettings.snapshot();
      mode.value = run.mode;
      arena.value = run.arena;
      waves.value = String(run.waves);
      difficulty.value = run.difficulty ?? '';
      sync();
      previousPad = null;
      clearControllerFocus();
      open = true;
      byId('overlay').classList.remove('hidden');
      byId('overlay').inert = true;
      element.classList.add('show');
      element.setAttribute('aria-hidden', 'false');
      difficulty.focus({ preventScroll: true });
      return true;
    },
    hide,
    pollGamepad,
    isOpen() { return open; },
  };
})();

const IntroCard = (() => {
  const element = byId('introcard');
  let open = false;
  function dismiss({ engage = true } = {}) {
    if (!open) return false;
    open = false;
    element.classList.remove('show');
    element.setAttribute('aria-hidden', 'true');
    // Pointer capture must stay inside the original click or key gesture.
    if (engage) engageLock();
    return true;
  }
  byId('introcontinue').addEventListener('click', (event) => {
    event.stopPropagation();
    dismiss();
  });
  return {
    present() {
      const run = RunSettings.snapshot(), description = runDescription(run);
      const defense = run.mode === 'defense';
      write(byId('introlocation'), defense ? 'TOWER DEFENSE / ' + description.arena.toUpperCase() : 'NEW YORK CITY / LITTLE SICILY');
      write(byId('introtitle'), defense ? 'HOLD YOUR\nGROUND.' : 'THEY CAME TO\nFINISH THE JOB.');
      byId('introcampaigncopy').hidden = defense;
      byId('introdefensecopy').hidden = !defense;
      write(byId('introdefenseobjective'), 'Defend the ' + description.arena.toLowerCase() + ' through ' + run.waves + ' waves on ' + description.difficulty + ' difficulty.');
      write(byId('introrunsummary'), description.summary + ' · LOCKED');
      write(byId('introcontinuelabel'), defense ? 'BEGIN THE DEFENSE' : 'ENTER LITTLE SICILY');
      write(byId('introskip'), defense ? 'RETRIES RESTART THE DEFENSE AT WAVE 1' : 'CHECKPOINTS AT EACH NEW AREA');
      open = true;
      element.classList.add('show');
      element.setAttribute('aria-hidden', 'false');
      byId('introcontinue').focus({ preventScroll: true });
    },
    dismiss,
    isOpen() { return open; },
  };
})();

const EndCard = (() => {
  const element = byId('endcard');
  const restart = byId('endrestart');
  restart.addEventListener('click', (event) => {
    event.stopPropagation();
    location.reload();
  });
  return {
    show(tag, title, body, stats = CombatStats.snapshot(), result = {}) {
      const run = RunSettings.snapshot(), description = runDescription(run);
      write(byId('endtag'), tag);
      write(byId('endtitle'), title);
      // Legacy mission copy uses <br>; preserve its line breaks without HTML injection.
      write(byId('endbody'), String(body ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
      write(byId('endkills'), padded(nonNegative(stats.kills)));
      write(byId('endaccuracy'), stats.shots ? Math.round(clamp(stats.hits / stats.shots, 0, 1) * 100) + '%' : '—');
      write(byId('endstreak'), padded(Number.isFinite(stats.bestStreak) ? nonNegative(stats.bestStreak) : Math.max(nonNegative(stats.streak), HUD.snapshot().bestStreak)));
      write(byId('enddifficulty'), description.difficulty);
      write(byId('endmode'), description.mode);
      byId('endwavesdetail').hidden = run.mode !== 'defense';
      write(byId('endwaves'), nonNegative(result.wavesSurvived, run.waves) + ' / ' + nonNegative(result.wavesTotal, run.waves));
      write(byId('endfavorite'), stats.favoriteWeaponName || 'No weapon used');
      const weaponRows = Array.isArray(stats.weapons) ? stats.weapons : [];
      byId('endweaponstats').replaceChildren(...weaponRows.map(weapon => {
        const row = document.createElement('tr');
        const attacks = nonNegative(weapon.attacks);
        row.dataset.used = String(attacks > 0);
        const heading = document.createElement('th');
        heading.scope = 'row';
        heading.textContent = String(weapon.name ?? weapon.type ?? 'Weapon');
        row.append(heading);
        const values = [
          attacks,
          nonNegative(weapon.hits),
          attacks ? Math.round(clamp(nonNegative(weapon.hits) / attacks, 0, 1) * 100) + '%' : '—',
          nonNegative(weapon.kills),
          nonNegative(weapon.headshots),
          Math.round(nonNegative(weapon.damageDealt)),
        ];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = String(value);
          row.append(cell);
        }
        return row;
      }));
      write(byId('endnote'), run.mode === 'defense'
        ? 'Choose another location, wave count or difficulty for your next defense.'
        : 'A different choice. A different ending.');
      element.classList.add('show');
      element.setAttribute('aria-hidden', 'false');
      Input.pause({ showOverlay: false });
      restart.focus({ preventScroll: true });
    },
    hide() {
      element.classList.remove('show');
      element.setAttribute('aria-hidden', 'true');
    },
  };
})();

/** Sample real frame time, not the clamped simulation step. Memory stays bounded. */
const FPSMeter = (() => {
  const element = byId('fps');
  let frames = 0, elapsed = 0, worst = 0, totalFrames = 0, visible = false;
  let lastClock = 0;
  let sample = { fps: 0, frameMs: 0, worstFrameMs: 0, sampleFrames: 0, totalFrames: 0 };
  let benchmark = { active: false, duration: 30, elapsed: 0, frames: 0, worst: 0, slow: 0 };

  function benchmarkSnapshot() {
    return {
      active: benchmark.active,
      seconds: benchmark.elapsed,
      frames: benchmark.frames,
      fps: benchmark.elapsed ? benchmark.frames / benchmark.elapsed : 0,
      worstFrameMs: benchmark.worst * 1000,
      slowFramePercent: benchmark.frames ? benchmark.slow / benchmark.frames * 100 : 0,
    };
  }

  return {
    toggle(force) {
      visible = typeof force === 'boolean' ? force : !visible;
      element.classList.toggle('show', visible);
      return visible;
    },
    startBench(seconds = 30) {
      benchmark = { active: true, duration: Math.max(1, nonNegative(seconds, 30)), elapsed: 0, frames: 0, worst: 0, slow: 0 };
      element.dataset.benchmark = 'running';
    },
    tick(now, rawDt) {
      const clock = performance.now() / 1000;
      const fallbackDt = lastClock ? clock - lastClock : 0;
      lastClock = clock;
      const dt = Number.isFinite(rawDt) && rawDt > 0 ? rawDt : fallbackDt;
      if (!Number.isFinite(dt) || dt <= 0) return;
      frames++;
      totalFrames++;
      elapsed += dt;
      worst = Math.max(worst, dt);
      if (elapsed >= 1) {
        sample = { fps: frames / elapsed, frameMs: elapsed / frames * 1000, worstFrameMs: worst * 1000, sampleFrames: frames, totalFrames };
        write(element, sample.fps.toFixed(0) + ' FPS · ' + sample.frameMs.toFixed(1) + ' MS');
        element.dataset.fps = sample.fps.toFixed(2);
        element.dataset.frameMs = sample.frameMs.toFixed(2);
        element.dataset.worstFrameMs = sample.worstFrameMs.toFixed(2);
        element.title = 'Slowest frame in the last sample: ' + sample.worstFrameMs.toFixed(1) + ' ms';
        frames = elapsed = worst = 0;
      }
      if (benchmark.active) {
        benchmark.elapsed += dt;
        benchmark.frames++;
        benchmark.worst = Math.max(benchmark.worst, dt);
        if (dt > 1 / 60 + 0.001) benchmark.slow++;
        if (benchmark.elapsed >= benchmark.duration) {
          benchmark.active = false;
          element.dataset.benchmark = JSON.stringify(benchmarkSnapshot());
        }
      }
    },
    snapshot() { return { ...sample, totalFrames, visible, benchmark: benchmarkSnapshot() }; },
  };
})();

const menu = byId('overlay');
const menuContent = byId('menucontent');
let openPanel = null, panelOpener = null, missionStarted = false;

function closePanel({ restoreFocus = true } = {}) {
  if (!openPanel) return;
  openPanel.hidden = true;
  openPanel = null;
  menu.classList.remove('is-panel-open');
  menuContent.inert = false;
  document.dispatchEvent(new CustomEvent('menu:panelchange', { detail: { open: false, id: null } }));
  if (restoreFocus) panelOpener?.focus({ preventScroll: true });
}

function showPanel(id, opener) {
  closePanel({ restoreFocus: false });
  openPanel = byId(id);
  panelOpener = opener;
  openPanel.hidden = false;
  menu.classList.add('is-panel-open');
  menuContent.inert = true;
  openPanel.querySelector('button')?.focus({ preventScroll: true });
  document.dispatchEvent(new CustomEvent('menu:panelchange', { detail: { open: true, id } }));
}

byId('fieldnotesbutton').addEventListener('click', (event) => {
  event.stopPropagation();
  showPanel('fieldnotes', event.currentTarget);
});
byId('settingsbutton').addEventListener('click', (event) => {
  event.stopPropagation();
  showPanel('settingspanel', event.currentTarget);
});
document.querySelectorAll('[data-close-panel]').forEach((button) => button.addEventListener('click', (event) => {
  event.stopPropagation();
  closePanel();
}));

// Native controls keep their usual keyboard behavior; modal focus cannot start play.
document.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && !openPanel && RunSetup.isOpen()) {
    event.preventDefault();
    event.stopPropagation();
    RunSetup.hide({ restoreFocus: true });
    return;
  }
  if (openPanel && event.code === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
    return;
  }
  const dialog = openPanel || (RunSetup.isOpen() ? byId('runsetup') : IntroCard.isOpen() ? byId('introcard') : byId('endcard').classList.contains('show') ? byId('endcard') : byId('deathscreen').classList.contains('show') ? byId('deathscreen') : null);
  if (!dialog || event.code !== 'Tab') return;
  const controls = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
  const first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

const audioSettingKeys = new Set(Object.values(AUDIO_MIX_SETTINGS));
const settingFields = {
  quality: byId('settingquality'),
  sensitivity: byId('settingsensitivity'),
  fov: byId('settingfov'),
  reducedMotion: byId('settingmotion'),
  touchControls: byId('settingtouchcontrols'),
  ...Object.fromEntries([...audioSettingKeys].map((key) => [key, byId('setting' + key.toLowerCase())])),
  checkpointVoice: byId('settingcheckpointvoice'),
};
function syncSettings(settings = Settings.snapshot()) {
  for (const [key, field] of Object.entries(settingFields)) {
    if (field.type === 'checkbox') {
      field.checked = settings[key];
      continue;
    }
    const audioLevel = audioSettingKeys.has(key);
    const value = String(audioLevel ? Math.round(settings[key] * 100) : settings[key]);
    if (field.value !== value) field.value = value;
    if (audioLevel) {
      write(byId(key.toLowerCase() + 'value'), value + '%');
      const description = value + ' percent';
      if (field.getAttribute('aria-valuetext') !== description) field.setAttribute('aria-valuetext', description);
    }
  }
  write(byId('sensitivityvalue'), settings.sensitivity.toFixed(2) + '×');
  write(byId('fovvalue'), settings.fov + '°');
  document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
}
for (const [key, field] of Object.entries(settingFields)) {
  field.addEventListener(field.type === 'range' ? 'input' : 'change', () => {
    const value = field.type === 'checkbox' ? field.checked : audioSettingKeys.has(key)
      ? (field.value.trim() ? Number(field.value) / 100 : NaN)
      : field.value;
    // Editing the mix only saves preferences. Unmuting remains an explicit,
    // separate audio-control gesture, including after restoring defaults.
    Settings.set(key, value);
    write(byId('settingssaved'), 'PREFERENCES APPLIED');
  });
}
byId('settingsform').addEventListener('submit', (event) => event.preventDefault());
byId('resetsettings').addEventListener('click', () => {
  Settings.reset();
  syncSettings();
  write(byId('settingssaved'), 'DEFAULTS RESTORED');
});
document.addEventListener('settingschange', (event) => syncSettings(event.detail));
syncSettings();

function syncAudio({ muted = true, hardMuted = false, supported = true } = {}) {
  const button = byId('audiotoggle');
  const outputMuted = hardMuted || muted;
  button.dataset.muted = String(outputMuted);
  button.dataset.forced = String(hardMuted);
  button.disabled = hardMuted || !supported;
  button.setAttribute('aria-pressed', String(!outputMuted));
  const label = hardMuted ? 'AUDIO LOCKED OFF' : !supported ? 'AUDIO UNAVAILABLE' : muted ? 'AUDIO OFF' : 'AUDIO ON';
  write(byId('audiostatus'), label);
  const description = hardMuted ? 'Audio is locked off for this silent session.' : !supported ? 'Audio is not supported in this browser.' : muted ? 'Audio is muted. Enable audio.' : 'Audio is enabled. Mute audio.';
  button.setAttribute('aria-label', description);
  button.title = description;
  const note = document.querySelector('.settings-audio-note');
  if (note) {
    note.dataset.forced = String(hardMuted);
    write(note, hardMuted
      ? 'Audio is locked off for this silent session and cannot be enabled. Levels and voice preferences can still be saved.'
      : !supported
        ? 'Audio is not supported in this browser. Levels and voice preferences can still be saved.'
        : muted
          ? 'Audio is muted. Changing levels or voice preferences does not enable sound. Use the audio control or press M to unmute.'
          : 'Audio is on. Master scales every channel. Use the audio control or press M to mute.');
  }
}
document.addEventListener('audiochange', (event) => syncAudio(event.detail));
syncAudio(Audio.getStatus?.() ?? { muted: true });

function primaryLabel(text) {
  const button = byId('startbutton');
  let label = button.querySelector('span');
  if (!label) {
    label = document.createElement('span');
    const arrow = document.createElement('span');
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    button.replaceChildren(label, arrow);
  }
  write(label, text);
}

function syncRunDetails(run = RunSettings.snapshot()) {
  const description = runDescription(run);
  const selected = Boolean(run.difficulty);
  const defense = run.mode === 'defense';
  byId('menurunsummary').hidden = !selected;
  write(byId('menurunsummary'), description.summary + (run.locked ? ' · LOCKED' : ''));
  write(byId('settingsrunsummary'), selected
    ? 'Difficulty level: ' + description.difficulty + '. ' + description.mode + (defense ? ', ' + run.waves + ' waves' : '') + '. ' + (run.locked ? 'Fixed for this run, including retries.' : 'Locks when you begin.')
    : 'Choose your difficulty when you begin. It stays fixed throughout the run.');
  write(byId('restartlabel'), defense ? 'RETRY DEFENSE' : 'RETRY CHECKPOINT');
  write(byId('deathhint'), defense ? 'Restart from wave 1 with the same difficulty. Hold your ground this time.' : 'Return to your last checkpoint. Make the next move count.');
}
document.addEventListener('run:settingschange', event => syncRunDetails(event.detail));
document.addEventListener('run:started', () => syncRunDetails());
syncRunDetails();

document.addEventListener('game:ready', () => {
  byId('startbutton').disabled = false;
  primaryLabel(missionStarted ? 'RESUME MISSION' : 'BEGIN MISSION');
  write(byId('loadstatus'), '');
});
document.addEventListener('playstatechange', (event) => {
  const { active = false, mode = 'mouse' } = event.detail ?? {};
  document.body.dataset.playing = String(active);
  if (active) {
    missionStarted = true;
    closePanel({ restoreFocus: false });
    write(byId('menustatus'), 'MISSION PAUSED / LITTLE SICILY');
  }
  if (missionStarted) primaryLabel('RESUME MISSION');
  if (active && mode !== 'mouse') HUD.setStatus(mode === 'touch' ? 'TOUCH CONTROLS / TAP PAUSE FOR MENU' : mode === 'gamepad' ? 'CONTROLLER / START TO PAUSE' : 'ARROWS LOOK / J FIRE / P PAUSE');
});

export { HUD, ObjectiveBanner, RunSetup, IntroCard, EndCard, FPSMeter };
