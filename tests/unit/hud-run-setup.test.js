import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clamp } from '../../src/core/math.js';
import { createRunSettings, DIFFICULTY_LEVELS, DEFENSE_WAVE_OPTIONS } from '../../src/game/run-settings.js';

const markup = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../src/ui/hud.js', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map(), listeners = new Map();
  const calls = { configured: [], paused: 0, engaged: 0, reloaded: 0 };
  function event(type, extra = {}) {
    return { type, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...extra };
  }
  function makeElement(tagName, attributes = new Map()) {
    const handlers = new Map(), classes = new Set((attributes.get('class') ?? '').split(/\s+/));
    let text = '';
    const element = {
      tagName, id: attributes.get('id'), dataset: {}, children: [], handlers,
      value: attributes.get('value') ?? '', hidden: attributes.has('hidden'), disabled: attributes.has('disabled'),
      inert: false,
      get options() { return this.tagName === 'select' ? this.children : undefined; },
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { text = String(value); this.children = []; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { text = ''; this.children = children; },
      getAttribute(name) { return attributes.get(name) ?? null; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      focus() { document.activeElement = this; },
      classList: {
        add(...names) { for (const name of names) classes.add(name); },
        remove(...names) { for (const name of names) classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      addEventListener(type, callback) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(callback);
      },
      dispatch(type, extra = {}) {
        const value = event(type, { target: this, currentTarget: this, ...extra });
        for (const callback of handlers.get(type) ?? []) callback(value);
        return value;
      },
      click() {
        if (this.disabled) return;
        const value = this.dispatch('click');
        if (this.id === 'runsetupconfirm' && !value.defaultPrevented) document.getElementById('runsetupform').dispatch('submit');
      },
      querySelectorAll() {
        if (this.id === 'leavegame') return ['leavegamecancel', 'leavegameconfirm'].map(id => document.getElementById(id)).filter(control => !control.disabled);
        if (this.id === 'deathscreen') return ['restartbutton', 'deathleavebutton'].map(id => document.getElementById(id)).filter(control => !control.disabled);
        if (this.id !== 'runsetup') return [];
        const controls = ['runsetupback', 'runmode', 'runarena', 'runwaves', 'rundifficulty', 'runsetupconfirm'];
        return controls.filter(id => !['runarena', 'runwaves'].includes(id) || !document.getElementById('rundefenseoptions').disabled)
          .map(id => document.getElementById(id)).filter(control => !control.disabled);
      },
    };
    return element;
  }
  const document = {
    activeElement: null,
    createElement(tag) { return makeElement(tag); },
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = markup.match(new RegExp('<([a-z][a-z0-9]*)\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'));
        assert.ok(tag, id + ' exists in production markup');
        const attributes = new Map(Array.from(tag[0].matchAll(/([\w:-]+)="([^"]*)"/g), match => [match[1], match[2]]));
        for (const flag of ['hidden', 'disabled', 'required']) if (new RegExp('\\s' + flag + '(?:\\s|>)').test(tag[0])) attributes.set(flag, '');
        const element = makeElement(tag[1], attributes);
        if (tag[1] === 'select') {
          const contents = markup.slice(tag.index + tag[0].length, markup.indexOf('</select>', tag.index));
          for (const option of contents.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
            const child = makeElement('option', new Map([['value', option[1]]]));
            child.textContent = option[2];
            element.append(child);
          }
        }
        elements.set(id, element);
      }
      return elements.get(id);
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(value) {
      for (const callback of listeners.get(value.type) ?? []) callback(value);
      return !value.defaultPrevented;
    },
    emit(type, extra = {}) { const value = event(type, extra); this.dispatchEvent(value); return value; },
  };
  class CustomEvent { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } }
  const settings = createRunSettings({ onChange: detail => document.emit('run:settingschange', { detail }) });
  document.addEventListener('run:configured', value => calls.configured.push(value.detail));
  const input = { active: false, pause() { calls.paused++; this.active = false; } };
  const location = { href: 'http://localhost:4173/?mute=1', reload() { calls.reloaded++; } };
  const context = vm.createContext({ document, clamp, RunSettings: settings, DIFFICULTY_LEVELS, CustomEvent,
    Input: input, HUD: { snapshot: () => ({ bestStreak: calls.hudBestStreak ?? 0 }) },
    CombatStats: { snapshot: () => ({}) }, engageLock() { calls.engaged++; },
    location, openPanel: null,
  });
  const helpers = source.slice(source.indexOf('const byId ='), source.indexOf('const ZONE_ORDER'));
  const cards = source.slice(source.indexOf('function runDescription('), source.indexOf('/** Sample real frame time'));
  const summaries = source.slice(source.indexOf('function syncRunDetails('), source.indexOf("document.addEventListener('game:ready'"));
  vm.runInContext(helpers + cards + summaries + '\nglobalThis.cards = { RunSetup, IntroCard, EndCard, LeaveGame, PauseMenu };', context);
  const keyboard = source.slice(source.indexOf('// Native controls keep'), source.indexOf('\nconst audioSettingKeys'));
  vm.runInContext(keyboard, context);
  const field = id => document.getElementById(id);
  function choose(id, value) { field(id).value = String(value); field(id).dispatch('change'); }
  return { ...context.cards, document, settings, field, choose, calls, input, location };
}

test('begin requires an explicit difficulty and cancellation leaves the run unconfigured', () => {
  const ui = fixture();
  assert.equal(ui.RunSetup.present(), true);
  assert.equal(ui.RunSetup.isOpen(), true);
  assert.equal(ui.field('rundifficulty').value, '');
  assert.equal(ui.field('rundifficulty').getAttribute('required'), '');
  assert.equal(ui.field('runsetupconfirm').disabled, true);
  assert.equal(ui.document.activeElement.id, 'rundifficulty');
  assert.equal(ui.field('overlay').inert, true);
  assert.deepEqual(ui.field('rundifficulty').children.map(option => option.value), ['', ...DIFFICULTY_LEVELS.map(level => level.id)]);
  ui.field('runsetupform').dispatch('submit');
  assert.equal(ui.settings.isConfigured(), false);
  assert.equal(ui.calls.configured.length, 0);
  assert.equal(ui.field('runsetuperror').hidden, false);
  ui.choose('rundifficulty', 'hard');
  assert.equal(ui.field('runsetupconfirm').disabled, false);
  assert.equal(ui.settings.isConfigured(), false, 'previewing difficulty does not start or save a run');
  ui.field('runsetupback').dispatch('click');
  assert.equal(ui.RunSetup.isOpen(), false);
  assert.equal(ui.settings.isConfigured(), false);
  assert.equal(ui.field('overlay').inert, false);
  assert.equal(ui.document.activeElement.id, 'startbutton');
});

test('tower defense exposes every supported arena and wave target, then submits a numeric run choice', () => {
  for (const arena of ['roof', 'street']) for (const waves of DEFENSE_WAVE_OPTIONS) {
    const ui = fixture();
    ui.RunSetup.present();
    assert.equal(ui.field('rundefenseoptions').hidden, true);
    assert.equal(ui.field('rundefenseoptions').disabled, true);
    ui.choose('runmode', 'defense');
    assert.equal(ui.field('rundefenseoptions').hidden, false);
    assert.equal(ui.field('rundefenseoptions').disabled, false);
    ui.choose('runarena', arena);
    ui.choose('runwaves', waves);
    ui.choose('rundifficulty', 'easy');
    assert.match(ui.field('rundifficultydescription').textContent, /health regeneration/);
    ui.field('runsetupform').dispatch('submit');
    assert.equal(ui.RunSetup.isOpen(), false);
    assert.deepEqual(ui.calls.configured, [{ difficulty: 'easy', mode: 'defense', arena, waves, locked: false }]);
    assert.equal(ui.calls.engaged, 0, 'input owns the transition from configuration to gameplay');
    assert.equal(ui.field('overlay').inert, false);
  }
});

test('started runs cannot reopen or overwrite choices, and pause settings explain the lock', () => {
  const ui = fixture();
  ui.RunSetup.present();
  ui.choose('rundifficulty', 'very-hard');
  ui.choose('runmode', 'defense');
  ui.choose('runarena', 'street');
  ui.choose('runwaves', 50);
  ui.field('runsetupform').dispatch('submit');
  const run = ui.settings.start();
  ui.document.emit('run:started');
  assert.equal(ui.RunSetup.present(), false);
  ui.choose('rundifficulty', 'very-easy');
  ui.field('runsetupform').dispatch('submit');
  assert.equal(ui.calls.configured.length, 1);
  assert.deepEqual(ui.settings.snapshot(), run);
  assert.match(ui.field('menurunsummary').textContent, /STREET.*50 WAVES.*VERY HARD.*LOCKED/);
  assert.match(ui.field('settingsrunsummary').textContent, /Very hard.*Fixed for this run, including retries/);
  assert.equal(ui.field('restartlabel').textContent, 'RETRY DEFENSE');
  assert.match(ui.field('deathhint').textContent, /wave 1.*same difficulty/);
});

test('setup keeps keyboard focus within enabled controls and Escape returns to the menu', () => {
  const ui = fixture();
  ui.RunSetup.present();
  const first = ui.field('runsetupback'), difficulty = ui.field('rundifficulty');
  ui.document.activeElement = difficulty;
  const tab = ui.document.emit('keydown', { code: 'Tab', shiftKey: false });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(ui.document.activeElement, first, 'hidden defense choices and disabled Begin are not focus stops');
  const reverse = ui.document.emit('keydown', { code: 'Tab', shiftKey: true });
  assert.equal(reverse.defaultPrevented, true);
  assert.equal(ui.document.activeElement, difficulty);
  assert.equal(ui.document.emit('keydown', { code: 'ArrowDown' }).defaultPrevented, false);
  const escape = ui.document.emit('keydown', { code: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.equal(ui.RunSetup.isOpen(), false);
  assert.equal(ui.document.activeElement.id, 'startbutton');
});

test('briefing describes the selected defense and retains campaign copy for story runs', () => {
  const ui = fixture();
  ui.settings.configure({ difficulty: 'average', mode: 'defense', arena: 'roof', waves: 20 });
  ui.settings.start();
  ui.IntroCard.present();
  assert.equal(ui.field('introcampaigncopy').hidden, true);
  assert.equal(ui.field('introdefensecopy').hidden, false);
  assert.match(ui.field('introdefenseobjective').textContent, /rooftop.*20 waves.*Average/);
  assert.match(ui.field('introrunsummary').textContent, /AVERAGE.*LOCKED/);
  assert.equal(ui.field('introcontinuelabel').textContent, 'BEGIN THE DEFENSE');
  assert.match(ui.field('introskip').textContent, /WAVE 1/);
  ui.IntroCard.dismiss();
  assert.equal(ui.calls.engaged, 1);
  ui.settings.reset();
  ui.settings.configure({ difficulty: 'hard' });
  ui.settings.start();
  ui.IntroCard.present();
  assert.equal(ui.field('introcampaigncopy').hidden, false);
  assert.equal(ui.field('introdefensecopy').hidden, true);
  assert.equal(ui.field('introcontinuelabel').textContent, 'ENTER LITTLE SICILY');
});

function gamepad(buttons = [], axes = [0, 0]) {
  return { axes, buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: buttons.includes(index) })) };
}

test('controller setup suppresses held opening A, requires a choice, and moves once per direction press', () => {
  const ui = fixture();
  ui.RunSetup.present();
  for (let frame = 0; frame < 30; frame++) ui.RunSetup.pollGamepad(gamepad([0]));
  assert.equal(ui.document.activeElement.id, 'rundifficulty');
  assert.equal(ui.field('runsetuperror').hidden, true, 'the opening confirm press is ignored');
  assert.equal(ui.settings.isConfigured(), false);
  const press = index => { ui.RunSetup.pollGamepad(gamepad()); ui.RunSetup.pollGamepad(gamepad([index])); };
  press(0);
  assert.equal(ui.document.activeElement.id, 'rundifficulty');
  assert.match(ui.field('runsetuperror').textContent, /choose a difficulty/);
  press(15);
  assert.equal(ui.field('rundifficulty').value, 'very-easy');
  for (let frame = 0; frame < 120; frame++) ui.RunSetup.pollGamepad(gamepad([15]));
  assert.equal(ui.field('rundifficulty').value, 'very-easy', 'holding right never races through the scale');
  press(15);
  assert.equal(ui.field('rundifficulty').value, 'easy');
  ui.RunSetup.pollGamepad(gamepad());
  ui.RunSetup.pollGamepad(gamepad([], [-1, 0]));
  assert.equal(ui.field('rundifficulty').value, 'very-easy', 'left stick adjusts the same native choice');
  press(0);
  assert.equal(ui.document.activeElement.id, 'runsetupconfirm');
  assert.equal(ui.field('runsetupconfirm').getAttribute('data-controller-focus'), 'true');
  assert.equal(ui.settings.isConfigured(), false);
  press(0);
  assert.equal(ui.RunSetup.isOpen(), false);
  assert.equal(ui.calls.configured.length, 1);
  assert.equal(ui.settings.snapshot().difficulty, 'very-easy');
  assert.equal(ui.RunSetup.pollGamepad(gamepad([0])), false);
});

test('controller alone can choose street defense and 100 waves or cancel with B', () => {
  const ui = fixture();
  ui.RunSetup.present();
  ui.RunSetup.pollGamepad(gamepad());
  const press = index => { ui.RunSetup.pollGamepad(gamepad()); ui.RunSetup.pollGamepad(gamepad([index])); };
  press(12);
  assert.equal(ui.document.activeElement.id, 'runmode');
  press(15);
  assert.equal(ui.field('runmode').value, 'defense');
  press(13);
  assert.equal(ui.document.activeElement.id, 'runarena');
  press(15);
  assert.equal(ui.field('runarena').value, 'street');
  press(0);
  assert.equal(ui.document.activeElement.id, 'runwaves');
  press(14);
  assert.equal(ui.field('runwaves').value, '100');
  press(13);
  assert.equal(ui.document.activeElement.id, 'rundifficulty');
  press(14);
  assert.equal(ui.field('rundifficulty').value, 'very-hard');
  press(0);
  press(0);
  assert.deepEqual(ui.calls.configured, [{ difficulty: 'very-hard', mode: 'defense', arena: 'street', waves: 100, locked: false }]);
  const canceled = fixture();
  canceled.RunSetup.present();
  canceled.RunSetup.pollGamepad(gamepad());
  canceled.RunSetup.pollGamepad(gamepad([1]));
  assert.equal(canceled.RunSetup.isOpen(), false);
  assert.equal(canceled.settings.isConfigured(), false);
  assert.equal(canceled.document.activeElement.id, 'startbutton');
});

function pausedRun(ui, { dead = false } = {}) {
  ui.settings.configure({ difficulty: 'hard', mode: 'defense', arena: 'street', waves: 20 });
  ui.settings.start();
  if (dead) {
    ui.field('deathscreen').classList.add('show');
    ui.field('overlay').classList.add('hidden');
  }
  return ui.settings.snapshot();
}

test('leave controls become available only for a started run and cannot abandon active gameplay directly', () => {
  const ui = fixture();
  assert.equal(ui.field('pausegameactions').hidden, true);
  assert.equal(ui.field('deathleavebutton').disabled, true);
  assert.equal(ui.LeaveGame.present(), false);
  ui.field('leavegameconfirm').click();
  assert.equal(ui.calls.reloaded, 0);
  pausedRun(ui);
  assert.equal(ui.field('pausegameactions').hidden, false);
  assert.equal(ui.field('deathleavebutton').disabled, false);
  ui.input.active = true;
  assert.equal(ui.LeaveGame.present(), false);
  assert.equal(ui.calls.reloaded, 0);
});

test('leave confirmation keeps the paused run intact until an explicit decision and cancel restores focus', () => {
  const ui = fixture(), run = pausedRun(ui);
  const source = ui.field('leavegamebutton');
  ui.field('choice').inert = true;
  source.click();
  assert.equal(ui.LeaveGame.isOpen(), true);
  assert.equal(ui.field('leavegame').getAttribute('aria-hidden'), 'false');
  assert.equal(ui.document.activeElement.id, 'leavegamecancel', 'the safe action receives initial focus');
  for (const id of ['overlay', 'hud', 'choice', 'game', 'audiotoggle']) assert.equal(ui.field(id).inert, true, id);
  assert.equal(ui.calls.paused, 1);
  assert.equal(ui.settings.snapshot(), run);
  assert.equal(ui.calls.reloaded, 0);
  ui.field('leavegamecancel').click();
  assert.equal(ui.LeaveGame.isOpen(), false);
  assert.equal(ui.field('leavegame').getAttribute('aria-hidden'), 'true');
  assert.equal(ui.field('overlay').inert, false);
  assert.equal(ui.field('hud').inert, false);
  assert.equal(ui.field('choice').inert, true, 'preexisting inert state is preserved');
  assert.equal(ui.document.activeElement, source);
  assert.equal(ui.settings.snapshot(), run, 'cancel preserves locked mode, difficulty, arena and waves');
  assert.equal(ui.calls.engaged, 0, 'cancel returns to the paused menu without silently resuming');
});

test('leave dialog traps keyboard focus and Escape or P cancels without triggering death retry shortcuts', () => {
  const ui = fixture(); pausedRun(ui, { dead: true });
  const source = ui.field('deathleavebutton');
  assert.equal(source.dispatch('keydown', { code: 'Enter' }).propagationStopped, true);
  source.click();
  ui.field('leavegameconfirm').focus();
  assert.equal(ui.document.emit('keydown', { code: 'Tab', shiftKey: false }).defaultPrevented, true);
  assert.equal(ui.document.activeElement.id, 'leavegamecancel');
  assert.equal(ui.document.emit('keydown', { code: 'Tab', shiftKey: true }).defaultPrevented, true);
  assert.equal(ui.document.activeElement.id, 'leavegameconfirm');
  assert.equal(ui.field('leavegame').dispatch('keydown', { code: 'Enter' }).propagationStopped, true);
  for (const code of ['Escape', 'KeyP']) {
    const event = ui.document.emit('keydown', { code });
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(ui.LeaveGame.isOpen(), false);
    assert.equal(ui.document.activeElement, source);
    assert.equal(ui.field('deathscreen').classList.contains('show'), true);
    assert.equal(ui.calls.reloaded, 0);
    if (code === 'Escape') source.click();
  }
});

test('explicit leave reloads the current muted URL once without resetting saved settings or mutating the old run', () => {
  const ui = fixture(), run = pausedRun(ui);
  const url = ui.location.href;
  ui.field('leavegamebutton').click();
  ui.field('leavegameconfirm').click();
  ui.field('leavegameconfirm').click();
  assert.equal(ui.calls.reloaded, 1);
  assert.equal(ui.location.href, url, 'reload preserves the mute query and existing route');
  assert.equal(ui.settings.snapshot(), run, 'only a fresh page creates a new run; no half-reset gameplay is exposed');
  assert.equal(ui.field('leavegameconfirm').disabled, true);
  assert.equal(ui.LeaveGame.cancel(), false, 'navigation cannot be raced by cancel');
});

test('controller can select Leave from either pause or death and confirm only with a fresh deliberate press', () => {
  for (const dead of [false, true]) {
    const ui = fixture(); pausedRun(ui, { dead });
    const primary = dead ? 'restartbutton' : 'startbutton';
    const leave = dead ? 'deathleavebutton' : 'leavegamebutton';
    const press = index => { ui.PauseMenu.pollGamepad(gamepad()); return ui.PauseMenu.pollGamepad(gamepad([index])); };
    assert.equal(ui.PauseMenu.pollGamepad(gamepad([0])), true);
    assert.equal(ui.document.activeElement.id, primary);
    assert.equal(ui.LeaveGame.isOpen(), false, 'opening A is not a second confirmation');
    press(13);
    for (let frame = 0; frame < 120; frame++) ui.PauseMenu.pollGamepad(gamepad([13]));
    assert.equal(ui.document.activeElement.id, leave, 'held navigation changes selection only once');
    assert.equal(press(0), true);
    assert.equal(ui.LeaveGame.isOpen(), true);
    ui.LeaveGame.pollGamepad(gamepad([0]));
    ui.LeaveGame.pollGamepad(gamepad([0]));
    assert.equal(ui.calls.reloaded, 0);
    assert.equal(ui.document.activeElement.id, 'leavegamecancel');
    ui.LeaveGame.pollGamepad(gamepad());
    ui.LeaveGame.pollGamepad(gamepad([], [0, 1]));
    assert.equal(ui.document.activeElement.id, 'leavegameconfirm');
    ui.LeaveGame.pollGamepad(gamepad());
    ui.LeaveGame.pollGamepad(gamepad([0]));
    assert.equal(ui.calls.reloaded, 1);
  }
});

test('controller cancel returns to the current menu and Start selects resume or retry without leaving', () => {
  for (const cancelButton of [1, 9]) {
    const ui = fixture(); pausedRun(ui);
    ui.field('leavegamebutton').click();
    ui.LeaveGame.pollGamepad(gamepad());
    ui.LeaveGame.pollGamepad(gamepad([cancelButton]));
    assert.equal(ui.LeaveGame.isOpen(), false);
    assert.equal(ui.calls.reloaded, 0);
    assert.equal(ui.PauseMenu.pollGamepad(gamepad([cancelButton])), true, 'held cancel is only an opening sample');
    ui.PauseMenu.pollGamepad(gamepad());
    ui.PauseMenu.pollGamepad(gamepad([13]));
    assert.equal(ui.document.activeElement.id, 'leavegamebutton');
    ui.PauseMenu.pollGamepad(gamepad());
    assert.equal(ui.PauseMenu.pollGamepad(gamepad([9])), 'primary');
    assert.equal(ui.calls.reloaded, 0);
  }
  const ui = fixture(); pausedRun(ui, { dead: true });
  ui.PauseMenu.pollGamepad(gamepad());
  assert.equal(ui.PauseMenu.pollGamepad(gamepad([0])), 'primary');
  ui.input.active = true;
  assert.equal(ui.PauseMenu.pollGamepad(gamepad()), false);
});

test('victory shows difficulty, defense progress, favorite, and distinct weapon attack statistics safely', () => {
  const ui = fixture();
  ui.settings.configure({ difficulty: 'easy', mode: 'defense', arena: 'street', waves: 100 });
  ui.settings.start();
  ui.calls.hudBestStreak = 12;
  ui.EndCard.show('DEFENSE COMPLETE', 'STILL STANDING.', 'You held.<br>Every wave.', {
    kills: 8, shots: 3, hits: 2, bestStreak: 4, favoriteWeaponName: 'FISTS',
    weapons: [
      { name: 'FISTS', attacks: 8, hits: 4, kills: 2, headshots: 0, damageDealt: 100.4 },
      { name: 'SHOTGUN', attacks: 3, hits: 2, kills: 6, headshots: 1, damageDealt: 540.8 },
      { name: '<img src=x onerror=alert(1)>', attacks: 0, hits: 0, kills: 0, headshots: 0, damageDealt: 0 },
    ],
  }, { wavesSurvived: 100, wavesTotal: 100 });
  assert.equal(ui.field('enddifficulty').textContent, 'Easy');
  assert.equal(ui.field('endmode').textContent, 'Tower defense / Street');
  assert.equal(ui.field('endwavesdetail').hidden, false);
  assert.equal(ui.field('endwaves').textContent, '100 / 100');
  assert.equal(ui.field('endbody').textContent, 'You held.\nEvery wave.');
  assert.equal(ui.field('endfavorite').textContent, 'FISTS');
  assert.equal(ui.field('endaccuracy').textContent, '67%');
  assert.equal(ui.field('endstreak').textContent, '04', 'the saved run statistic takes precedence over feedback from a failed attempt');
  const rows = ui.field('endweaponstats').children;
  assert.deepEqual(rows.map(row => Array.from(row.children, cell => cell.textContent)), [
    ['FISTS', '8', '4', '50%', '2', '0', '100'],
    ['SHOTGUN', '3', '2', '67%', '6', '1', '541'],
    ['<img src=x onerror=alert(1)>', '0', '0', '—', '0', '0', '0'],
  ]);
  assert.equal(rows[2].children[0].children.length, 0, 'names remain text, never HTML');
  assert.equal(rows[2].dataset.used, 'false');
  assert.equal(ui.field('endcard').getAttribute('aria-hidden'), 'false');
  assert.equal(ui.calls.paused, 1);
  assert.equal(ui.document.activeElement.id, 'endrestart');
});
