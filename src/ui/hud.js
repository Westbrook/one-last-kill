import { clamp } from '../core/math.js';
import { engageLock } from '../core/input.js';
import { Audio } from '../core/audio.js';
import { Settings } from '../core/settings.js';
import { CombatStats } from '../game/combat-stats.js';

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
  const vitals = byId('vitals');
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
  const state = { health: 100, weapon: 'FISTS', ammo: '∞', kills: 0, shots: 0, hits: 0, headshots: 0, streak: 0, bestStreak: 0 };

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

  return {
    setHealth(value) {
      const health = clamp(nonNegative(value, 100), 0, 100);
      if (state.health === health && healthbar.getAttribute('aria-valuenow') === String(Math.round(health))) return;
      state.health = health;
      healthfill.style.width = health + '%';
      write(healthtext, Math.round(health));
      healthbar.setAttribute('aria-valuenow', String(Math.round(health)));
      vitals.dataset.low = String(health <= 30);
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
    showDeath(on) {
      clearFeedback();
      deathEl.classList.toggle('show', Boolean(on));
      deathEl.setAttribute('aria-hidden', String(!on));
      deathEl.setAttribute('role', 'dialog');
      deathEl.setAttribute('aria-modal', String(Boolean(on)));
      if (on) {
        byId('overlay').classList.add('hidden');
        byId('restartbutton')?.focus({ preventScroll: true });
      }
    },
    setPickupPrompt(text) {
      write(pickupEl, text || '');
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
      state.bestStreak = Math.max(state.bestStreak, state.streak, nonNegative(stats.bestStreak));
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
      return { ...state, accuracy: state.shots ? Math.round(clamp(state.hits / state.shots, 0, 1) * 100) : 0 };
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
      HUD.setStatus({ chapter: name, ...(index >= 0 ? { progress: { current: index + 1, total: ZONE_ORDER.length } } : {}) });
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
    show(tag, title, body, stats = CombatStats.snapshot()) {
      write(byId('endtag'), tag);
      write(byId('endtitle'), title);
      // Legacy mission copy uses <br>; preserve its line breaks without HTML injection.
      write(byId('endbody'), String(body ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
      write(byId('endkills'), padded(nonNegative(stats.kills)));
      write(byId('endaccuracy'), stats.shots ? Math.round(clamp(stats.hits / stats.shots, 0, 1) * 100) + '%' : '—');
      write(byId('endstreak'), padded(Math.max(nonNegative(stats.bestStreak), nonNegative(stats.streak), HUD.snapshot().bestStreak)));
      element.classList.add('show');
      element.setAttribute('aria-hidden', 'false');
      if (document.pointerLockElement) document.exitPointerLock();
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
  if (openPanel && event.code === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
    return;
  }
  const dialog = openPanel || (IntroCard.isOpen() ? byId('introcard') : byId('endcard').classList.contains('show') ? byId('endcard') : byId('deathscreen').classList.contains('show') ? byId('deathscreen') : null);
  if (!dialog || event.code !== 'Tab') return;
  const controls = Array.from(dialog.querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]'));
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

const settingFields = {
  quality: byId('settingquality'),
  sensitivity: byId('settingsensitivity'),
  fov: byId('settingfov'),
  reducedMotion: byId('settingmotion'),
};
function syncSettings(settings = Settings.snapshot()) {
  settingFields.quality.value = settings.quality;
  settingFields.sensitivity.value = settings.sensitivity;
  settingFields.fov.value = settings.fov;
  settingFields.reducedMotion.checked = settings.reducedMotion;
  write(byId('sensitivityvalue'), settings.sensitivity.toFixed(2) + '×');
  write(byId('fovvalue'), settings.fov + '°');
  document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
}
for (const [key, field] of Object.entries(settingFields)) {
  field.addEventListener(field.type === 'range' ? 'input' : 'change', () => {
    Settings.set(key, field.type === 'checkbox' ? field.checked : field.value);
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
  button.dataset.muted = String(muted);
  button.dataset.forced = String(hardMuted);
  button.disabled = hardMuted || !supported;
  button.setAttribute('aria-pressed', String(!muted));
  const label = !supported ? 'AUDIO UNAVAILABLE' : hardMuted ? 'AUDIO LOCKED OFF' : muted ? 'AUDIO OFF' : 'AUDIO ON';
  write(byId('audiostatus'), label);
  const description = !supported ? 'Audio is not supported in this browser.' : hardMuted ? 'Audio is locked off for this silent session.' : muted ? 'Audio is muted. Enable audio.' : 'Audio is enabled. Mute audio.';
  button.setAttribute('aria-label', description);
  button.title = description;
  const note = document.querySelector('.settings-audio-note');
  if (note) {
    note.textContent = !supported
      ? 'Audio is not supported in this browser.'
      : hardMuted
        ? 'Audio is locked off for this silent session and cannot be enabled.'
        : 'Audio starts muted. Use the audio control or press M to change it.';
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
  if (active && mode !== 'mouse') HUD.setStatus(mode === 'gamepad' ? 'CONTROLLER / START TO PAUSE' : 'ARROWS LOOK / J FIRE / P PAUSE');
});

export { HUD, ObjectiveBanner, IntroCard, EndCard, FPSMeter };
