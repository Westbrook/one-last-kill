import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clamp } from '../../src/core/math.js';

const markup = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../src/ui/hud.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set(), attributes = new Map(), properties = new Map();
        const writes = { text: 0, attributes: 0, style: 0 };
        let content = '';
        elements.set(id, {
          get textContent() { return content; },
          set textContent(value) { content = String(value); writes.text++; },
          hidden: false, dataset: {}, writes,
          style: {
            setProperty(name, value) { properties.set(name, String(value)); writes.style++; },
            removeProperty(name) { const old = properties.get(name) ?? ''; properties.delete(name); writes.style++; return old; },
            getPropertyValue(name) { return properties.get(name) ?? ''; },
          },
          focus() {},
          classList: {
            add(...names) { for (const name of names) classes.add(name); },
            remove(...names) { for (const name of names) classes.delete(name); },
            contains(name) { return classes.has(name); },
            toggle(name, on = !classes.has(name)) {
              if (on) classes.add(name); else classes.delete(name);
              return on;
            },
          },
          setAttribute(name, value) { attributes.set(name, String(value)); writes.attributes++; },
          removeAttribute(name) { attributes.delete(name); writes.attributes++; },
          getAttribute(name) { return attributes.get(name) ?? null; },
        });
      }
      return elements.get(id);
    },
  };
  // Exercise the production HUD closure without initializing browser input,
  // audio or the independent menu controllers that follow it in the module.
  const boundary = source.indexOf('const ObjectiveBanner =');
  assert.ok(boundary > 0, 'the HUD closure must precede the menu controllers');
  const context = vm.createContext({ document, clamp });
  vm.runInContext(source.slice(0, boundary).replace(/^import .*;\n/gm, '') + '\nglobalThis.hud = HUD;', context);
  return { hud: context.hud, element: id => document.getElementById(id) };
}

test('initial HUD describes fists and hides an inactive reload from accessibility', () => {
  assert.match(markup, /id="weaponname">FISTS<\/div>/);
  assert.match(markup, /id="ammo" aria-label="Unlimited melee attacks"/);
  assert.match(markup, /id="reloadindicator" aria-hidden="true"/);
});

test('switching from a firearm to fists clears the ammunition presentation', () => {
  const { hud, element } = fixture();
  hud.setWeapon('PISTOL', '3 / 17');
  assert.equal(element('ammo').getAttribute('aria-label'), '3 rounds loaded, 17 in reserve');
  assert.equal(element('ammoreserve').textContent, '17');
  assert.equal(element('ammoseparator').hidden, false);
  hud.setWeapon('FISTS', '∞');
  assert.equal(element('ammo').getAttribute('aria-label'), 'Unlimited melee attacks');
  assert.equal(element('ammoreserve').textContent, '');
  assert.equal(element('ammoreserve').hidden, true);
  assert.equal(element('ammoseparator').hidden, true);
  assert.equal(hud.snapshot().weapon, 'FISTS');
});

test('clearing or dismissing feedback also hides stale reload and pickup announcements', () => {
  const { hud, element } = fixture();
  hud.setReloading(true);
  hud.setPickupPrompt('E · PICK UP BAT');
  assert.equal(element('reloadindicator').getAttribute('aria-hidden'), 'false');
  assert.equal(element('pickupprompt').getAttribute('aria-hidden'), 'false');
  hud.clearFeedback();
  for (const id of ['reloadindicator', 'pickupprompt']) {
    assert.equal(element(id).classList.contains('show'), false);
    assert.equal(element(id).getAttribute('aria-hidden'), 'true');
  }
  hud.setReloading(true);
  hud.setReloading(false);
  hud.setPickupPrompt('E · PICK UP BAT');
  hud.setPickupPrompt('');
  assert.equal(element('reloadindicator').getAttribute('aria-hidden'), 'true');
  assert.equal(element('pickupprompt').getAttribute('aria-hidden'), 'true');
  assert.equal(element('pickupprompt').textContent, '');
});

test('offscreen warnings name every supported direction in windup and hit phases', () => {
  const { hud, element } = fixture();
  const cases = [['BEHIND', Math.PI], ['LEFT', -Math.PI / 2], ['RIGHT', Math.PI / 2], ['ABOVE', 0], ['BELOW', Math.PI]];
  for (const [direction, angle] of cases) for (const phase of ['windup', 'hit']) {
    hud.setOffscreenThreat({ direction, angle, phase, count: 1 });
    const warning = element('offscreenthreat');
    assert.equal(warning.hidden, false);
    assert.equal(warning.classList.contains('show'), true);
    assert.equal(warning.getAttribute('aria-hidden'), 'false');
    assert.equal(warning.dataset.direction, direction);
    assert.equal(warning.dataset.phase, phase);
    assert.equal(element('offscreenthreatlabel').textContent, (phase === 'hit' ? 'HIT' : 'ATTACK') + ' FROM ' + direction);
    assert.equal(warning.getAttribute('aria-label'), (phase === 'hit' ? 'Hit' : 'Attack') + ' from ' + direction.toLowerCase() + '.');
    const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    assert.equal(warning.style.getPropertyValue('--threat-angle'), normalized.toFixed(3) + 'rad');
    assert.equal(element('offscreenthreatcount').hidden, true);
  }
});

test('count and phase updates stay bounded and repeated frames do not rewrite the warning', () => {
  const { hud, element } = fixture();
  const threat = { direction: 'RIGHT', angle: Math.PI / 2, phase: 'windup', count: 3 };
  hud.setOffscreenThreat(threat);
  const warning = element('offscreenthreat'), label = element('offscreenthreatlabel'), count = element('offscreenthreatcount');
  assert.equal(count.textContent, '3 ATTACKERS');
  assert.equal(count.hidden, false);
  const writes = [warning, label, count].map(item => ({ ...item.writes }));
  for (let frame = 0; frame < 120; frame++) hud.setOffscreenThreat({ ...threat, angle: threat.angle + 0.00001 });
  assert.deepEqual([warning, label, count].map(item => ({ ...item.writes })), writes);
  hud.setOffscreenThreat({ ...threat, angle: 2 });
  assert.equal(warning.writes.style, writes[0].style + 1);
  assert.equal(label.writes.text, writes[1].text);
  assert.equal(count.writes.text, writes[2].text);
  assert.equal(warning.writes.attributes, writes[0].attributes);
  threat.phase = 'hit';
  threat.count = 500;
  hud.setOffscreenThreat(threat);
  assert.equal(label.textContent, 'HIT FROM RIGHT');
  assert.equal(count.textContent, '99+ ATTACKERS');
  assert.equal(warning.getAttribute('aria-label'), 'Hit from right. 99+ attackers.');
  hud.setOffscreenThreat({ ...threat, count: -5 });
  assert.equal(count.hidden, true);
  assert.equal(count.textContent, '');
});

test('null clears visuals and announcements without owning the threat lifetime or other feedback', () => {
  const { hud, element } = fixture();
  hud.damageDirection(1);
  hud.setOffscreenThreat({ direction: 'BEHIND', angle: Math.PI, phase: 'windup', count: 2 });
  hud.update(20);
  assert.equal(element('offscreenthreat').hidden, false, 'the caller alone decides expiration');
  hud.damageDirection(1);
  hud.setOffscreenThreat(null);
  const warning = element('offscreenthreat');
  assert.equal(warning.hidden, true);
  assert.equal(warning.classList.contains('show'), false);
  assert.equal(warning.getAttribute('aria-hidden'), 'true');
  assert.equal(warning.getAttribute('aria-label'), null);
  assert.equal(warning.style.getPropertyValue('--threat-angle'), '');
  assert.equal(warning.dataset.direction, undefined);
  assert.equal(warning.dataset.phase, undefined);
  assert.equal(element('offscreenthreatlabel').textContent, '');
  assert.equal(element('offscreenthreatcount').textContent, '');
  assert.equal(element('offscreenthreatcount').hidden, true);
  assert.equal(element('damageindicator').classList.contains('show'), true, 'existing damage bearing remains independent');
  const writes = { ...warning.writes };
  hud.setOffscreenThreat(null);
  assert.deepEqual(warning.writes, writes, 'repeated clears do not mutate the inactive alert');
});

test('death, checkpoint reset and feedback reset cannot retain a stale offscreen warning', () => {
  const { hud, element } = fixture();
  const threat = { direction: 'LEFT', angle: -Math.PI / 2, phase: 'hit', count: 1 };
  hud.setOffscreenThreat(threat);
  hud.showDeath(true);
  assert.equal(element('offscreenthreat').hidden, true);
  assert.equal(element('offscreenthreat').getAttribute('aria-label'), null);
  hud.setOffscreenThreat(threat);
  assert.equal(element('offscreenthreat').hidden, true, 'late attack events cannot paint over the death screen');
  hud.showDeath(false);
  assert.equal(element('offscreenthreatlabel').textContent, '');
  hud.setOffscreenThreat(threat);
  assert.equal(element('offscreenthreat').hidden, false);
  hud.clearFeedback();
  assert.equal(element('offscreenthreat').hidden, true);
  assert.equal(element('offscreenthreat').getAttribute('aria-hidden'), 'true');
  assert.equal(element('offscreenthreat').getAttribute('aria-label'), null);
  assert.equal(element('offscreenthreatlabel').textContent, '');
});

test('invalid threat data clears rather than retaining a misleading direction', () => {
  const { hud, element } = fixture();
  const valid = { direction: 'ABOVE', angle: 0, phase: 'windup', count: 1 };
  for (const invalid of [{ ...valid, angle: NaN }, { ...valid, angle: Infinity }, { ...valid, direction: 'FRONT' }, { ...valid, phase: 'idle' }, undefined]) {
    hud.setOffscreenThreat(valid);
    hud.setOffscreenThreat(invalid);
    assert.equal(element('offscreenthreat').hidden, true);
    assert.equal(element('offscreenthreatlabel').textContent, '');
  }
});

test('threat markup and styles provide a bounded silent alert without reduced-motion flashes', () => {
  assert.match(markup, /id="offscreenthreat"[^>]*role="status"[^>]*aria-atomic="true"[^>]*aria-hidden="true"[^>]* hidden>/);
  assert.match(markup, /class="threat-bearing" aria-hidden="true"/);
  const rule = styles.match(/#offscreenthreat\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /max-width:\s*min\(/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /animation:\s*none/);
  assert.match(styles, /#offscreenthreat\[data-phase="hit"\]/);
  const systemMotion = styles.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.match(systemMotion, /#offscreenthreat[^}]*animation:\s*none\s*!important[^}]*transition:\s*none\s*!important/);
  assert.match(styles, /html\[data-reduced-motion="true"\] #offscreenthreat[^}]*animation:\s*none\s*!important[^}]*transition:\s*none\s*!important/);
});
