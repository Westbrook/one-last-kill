import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AUDIO_MIX_SETTINGS, DEFAULT_SETTINGS, createSettingsStore } from '../../src/core/settings.js';

const markup = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../src/ui/hud.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

function fixture({ initial = {}, status = { muted: true, hardMuted: false, supported: true } } = {}) {
  const elements = new Map(), listeners = new Map();
  const document = {
    documentElement: { dataset: {} },
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = markup.match(new RegExp('<[a-z][a-z0-9]*\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'))?.[0];
        assert.ok(tag, id + ' exists in production markup');
        const attributes = new Map(Array.from(tag.matchAll(/([\w:-]+)="([^"]*)"/g), match => [match[1], match[2]]));
        const handlers = new Map(), writes = { text: 0, attributes: 0 };
        let content = '';
        const element = {
          id, handlers, writes, dataset: {},
          type: attributes.get('type') ?? '',
          value: attributes.get('value') ?? '',
          checked: /\bchecked\b/.test(tag),
          disabled: /\bdisabled\b/.test(tag),
          get textContent() { return content; },
          set textContent(value) { content = String(value); writes.text++; },
          getAttribute(name) { return attributes.get(name) ?? null; },
          setAttribute(name, value) { attributes.set(name, String(value)); writes.attributes++; },
          addEventListener(type, listener) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(listener);
          },
          dispatch(type, extra = {}) {
            const event = { type, target: element, currentTarget: element, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
            for (const listener of handlers.get(type) ?? []) listener(event);
            return event;
          },
          focus() { document.activeElement = element; },
        };
        elements.set(id, element);
      }
      return elements.get(id);
    },
    querySelector(selector) {
      assert.equal(selector, '.settings-audio-note');
      return this.getElementById('settingsaudionote');
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    emit(type, detail, extra = {}) {
      const event = { type, detail, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (const listener of listeners.get(type) ?? []) listener(event);
      return event;
    },
  };
  const settings = createSettingsStore({ initial, onChange: detail => document.emit('settingschange', detail) });
  let audioStatusReads = 0;
  const Audio = new Proxy({}, {
    get(_, key) {
      assert.equal(key, 'getStatus', 'settings controls must never invoke an audio device, playback or mute API');
      return () => { audioStatusReads++; return status; };
    },
  });
  const context = vm.createContext({ document, Settings: settings, AUDIO_MIX_SETTINGS, Audio });
  const helpers = source.slice(source.indexOf('const byId ='), source.indexOf('const padded ='));
  const start = source.indexOf('const audioSettingKeys ='), end = source.indexOf('\nfunction primaryLabel');
  assert.ok(start > 0 && end > start);
  // Run the actual settings bindings with native-control-shaped DOM objects.
  // Audio exposes only a read operation, so an accidental activation fails here.
  vm.runInContext(helpers + source.slice(start, end), context);
  return { settings, document, context, element: id => document.getElementById(id), audioStatusReads: () => audioStatusReads };
}

function changeLevel(ui, channel, percent) {
  const key = AUDIO_MIX_SETTINGS[channel];
  const field = ui.element('setting' + key.toLowerCase());
  field.value = String(percent);
  field.dispatch('input');
  return field;
}

test('all five mix channels use labeled native percentage sliders with live accessible readouts', () => {
  const ui = fixture();
  assert.match(markup, /<fieldset class="settings-group audio-mix">\s*<legend>AUDIO MIX<\/legend>/);
  for (const key of Object.values(AUDIO_MIX_SETTINGS)) {
    const id = 'setting' + key.toLowerCase(), field = ui.element(id);
    const percent = Math.round(DEFAULT_SETTINGS[key] * 100);
    assert.equal(field.type, 'range');
    assert.equal(field.getAttribute('name'), key);
    assert.equal(field.getAttribute('min'), '0');
    assert.equal(field.getAttribute('max'), '100');
    assert.equal(field.getAttribute('step'), '1');
    assert.equal(field.getAttribute('aria-valuetext'), percent + ' percent');
    assert.match(field.getAttribute('aria-describedby'), /settingsaudionote/);
    assert.match(markup, new RegExp('<label for="' + id + '">[^<]+<\\/label>'));
    const output = ui.element(key.toLowerCase() + 'value');
    assert.equal(output.getAttribute('for'), id);
    assert.equal(output.textContent, percent + '%');
    assert.equal(field.handlers.get('input').length, 1);
    assert.equal(field.handlers.has('keydown'), false, 'native keyboard range behavior is untouched');
    assert.equal(field.disabled, false);
  }
  assert.match(styles, /\.settings-group\s*\{[^}]*min-inline-size:\s*0/);
  assert.match(styles, /@media\s*\(max-width:\s*440px\)\s*\{\s*\.audio-mix-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('moving one slider changes only its normalized preference and does not unmute', () => {
  const ui = fixture();
  for (const channel of Object.keys(AUDIO_MIX_SETTINGS)) {
    const before = ui.settings.snapshot(), key = AUDIO_MIX_SETTINGS[channel];
    const field = changeLevel(ui, channel, 37);
    assert.equal(ui.settings.get(key), 0.37);
    for (const other of Object.keys(DEFAULT_SETTINGS)) if (other !== key) assert.equal(ui.settings.get(other), before[other]);
    assert.equal(field.getAttribute('aria-valuetext'), '37 percent');
    assert.equal(ui.element(key.toLowerCase() + 'value').textContent, '37%');
    changeLevel(ui, channel, 0);
    assert.equal(ui.settings.get(key), 0);
    changeLevel(ui, channel, 100);
    assert.equal(ui.settings.get(key), 1);
  }
  assert.equal(ui.element('audiostatus').textContent, 'AUDIO OFF');
  assert.equal(ui.element('audiotoggle').getAttribute('aria-pressed'), 'false');
  assert.match(ui.element('settingsaudionote').textContent, /does not enable sound/);
  assert.equal(ui.audioStatusReads(), 1);
});

test('silent-session lock remains explicit while mix and voice preferences stay editable', () => {
  const ui = fixture({ status: { muted: true, hardMuted: true, supported: true } });
  for (const channel of Object.keys(AUDIO_MIX_SETTINGS)) {
    const field = changeLevel(ui, channel, 64);
    assert.equal(field.disabled, false);
    assert.equal(ui.settings.get(AUDIO_MIX_SETTINGS[channel]), 0.64);
  }
  const voice = ui.element('settingcheckpointvoice');
  voice.checked = false;
  voice.dispatch('change');
  assert.equal(ui.settings.get('checkpointVoice'), false);
  voice.checked = true;
  voice.dispatch('change');
  assert.equal(ui.settings.get('checkpointVoice'), true);
  assert.equal(voice.disabled, false);
  for (const supported of [true, false]) {
    ui.document.emit('audiochange', { hardMuted: true, muted: false, supported });
    assert.equal(ui.element('audiotoggle').disabled, true);
    assert.equal(ui.element('audiotoggle').dataset.muted, 'true');
    assert.equal(ui.element('audiotoggle').getAttribute('aria-pressed'), 'false');
    assert.equal(ui.element('audiostatus').textContent, 'AUDIO LOCKED OFF');
    assert.match(ui.element('settingsaudionote').textContent, /locked off.*cannot be enabled/);
  }
  ui.element('resetsettings').dispatch('click');
  assert.deepEqual(ui.settings.snapshot(), DEFAULT_SETTINGS);
  assert.equal(ui.element('audiostatus').textContent, 'AUDIO LOCKED OFF');
  assert.equal(ui.element('audiotoggle').disabled, true);
  assert.equal(ui.audioStatusReads(), 1);
});

test('reset and externally restored settings synchronize percentages and the voice checkbox', () => {
  const ui = fixture({ initial: { audioMaster: 0, audioEffects: 0.23, audioAmbience: 0.48, audioMusic: 1, audioRadio: 0.03, checkpointVoice: false } });
  assert.equal(ui.element('settingaudiomaster').value, '0');
  assert.equal(ui.element('audioeffectsvalue').textContent, '23%');
  assert.equal(ui.element('settingcheckpointvoice').checked, false);
  ui.settings.set({ audioRadio: 0.72, checkpointVoice: true });
  assert.equal(ui.element('settingaudioradio').value, '72');
  assert.equal(ui.element('audioradiovalue').textContent, '72%');
  assert.equal(ui.element('settingcheckpointvoice').checked, true);
  ui.element('resetsettings').dispatch('click');
  assert.deepEqual(ui.settings.snapshot(), DEFAULT_SETTINGS);
  for (const key of Object.values(AUDIO_MIX_SETTINGS)) {
    const value = String(Math.round(DEFAULT_SETTINGS[key] * 100));
    assert.equal(ui.element('setting' + key.toLowerCase()).value, value);
    assert.equal(ui.element(key.toLowerCase() + 'value').textContent, value + '%');
  }
  assert.equal(ui.element('settingssaved').textContent, 'DEFAULTS RESTORED');
  assert.equal(ui.element('audiostatus').textContent, 'AUDIO OFF');
  assert.equal(ui.element('settingsform').dispatch('submit').defaultPrevented, true);
});

test('audio status changes preserve mix settings and unchanged synchronization avoids readout rewrites', () => {
  const ui = fixture();
  const before = ui.settings.snapshot();
  const output = ui.element('audiomusicvalue'), field = ui.element('settingaudiomusic');
  const outputWrites = output.writes.text, fieldWrites = field.writes.attributes;
  for (let index = 0; index < 30; index++) ui.document.emit('settingschange', ui.settings.snapshot());
  assert.equal(output.writes.text, outputWrites);
  assert.equal(field.writes.attributes, fieldWrites);
  ui.document.emit('audiochange', { muted: false, hardMuted: false, supported: true });
  assert.equal(ui.element('audiostatus').textContent, 'AUDIO ON');
  assert.equal(ui.element('audiotoggle').getAttribute('aria-pressed'), 'true');
  ui.document.emit('audiochange', { muted: true, hardMuted: false, supported: false });
  assert.equal(ui.element('audiostatus').textContent, 'AUDIO UNAVAILABLE');
  assert.equal(ui.element('audiotoggle').disabled, true);
  assert.equal(field.disabled, false);
  assert.deepEqual(ui.settings.snapshot(), before);
});

test('the settings dialog leaves slider adjustment keys native and keeps Tab inside the dialog', () => {
  const ui = fixture();
  const controls = [ui.element('settingaudiomaster'), ui.element('settingaudioeffects'), ui.element('resetsettings')];
  ui.context.openPanel = { querySelectorAll: () => controls };
  const start = source.indexOf('// Native controls keep'), end = source.indexOf('\nconst audioSettingKeys');
  vm.runInContext(source.slice(start, end), ui.context);
  for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
    ui.document.activeElement = controls[0];
    assert.equal(ui.document.emit('keydown', null, { code }).defaultPrevented, false, code + ' stays native');
  }
  ui.document.activeElement = controls.at(-1);
  assert.equal(ui.document.emit('keydown', null, { code: 'Tab', shiftKey: false }).defaultPrevented, true);
  assert.equal(ui.document.activeElement, controls[0]);
  assert.equal(ui.document.emit('keydown', null, { code: 'Tab', shiftKey: true }).defaultPrevented, true);
  assert.equal(ui.document.activeElement, controls.at(-1));
});
