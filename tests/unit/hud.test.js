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
        const tag = markup.match(new RegExp('<[a-z][a-z0-9]*\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'))?.[0] ?? '';
        const classes = new Set(), properties = new Map();
        const attributes = new Map(Array.from(tag.matchAll(/([\w:-]+)="([^"]*)"/g), match => [match[1], match[2]]));
        const writes = { text: 0, attributes: 0, style: 0, dataset: 0, hidden: 0 };
        let hidden = /\shidden(?:\s|>)/.test(tag);
        const dataset = Object.fromEntries(Array.from(attributes).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
        let content = '';
        elements.set(id, {
          get textContent() { return content; },
          set textContent(value) { content = String(value); writes.text++; },
          get hidden() { return hidden; },
          set hidden(value) { hidden = Boolean(value); writes.hidden++; },
          dataset: new Proxy(dataset, { set(target, name, value) { target[name] = value; writes.dataset++; return true; } }), writes,
          style: new Proxy({
            setProperty(name, value) { properties.set(name, String(value)); writes.style++; },
            removeProperty(name) { const old = properties.get(name) ?? ''; properties.delete(name); writes.style++; return old; },
            getPropertyValue(name) { return properties.get(name) ?? ''; },
          }, { set(target, name, value) { target[name] = value; writes.style++; return true; } }),
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

test('rage availability shows the current control and repeated frames do not rewrite its cue', () => {
  const { hud, element } = fixture();
  const ids = ['ragecue', 'ragelabel', 'ragekey', 'ragecountdown', 'ragehint'];
  const cue = element('ragecue');
  assert.equal(cue.hidden, true);
  assert.equal(cue.getAttribute('aria-hidden'), 'true');
  for (const [gamepad, key] of [[false, 'T'], [true, 'D-PAD UP']]) {
    hud.setRage({ available: true, gamepad });
    assert.equal(cue.hidden, false);
    assert.equal(cue.dataset.state, 'available');
    assert.equal(cue.getAttribute('aria-hidden'), 'false');
    assert.equal(element('ragelabel').textContent, 'ENTER RAGE');
    assert.equal(element('ragekey').textContent, key);
    assert.equal(element('ragekey').hidden, false);
    assert.equal(element('ragecountdown').hidden, true);
    assert.equal(element('ragehint').textContent, 'DOUBLE YOUR CURRENT HEALTH');
    const writes = ids.map(id => ({ ...element(id).writes }));
    for (let frame = 0; frame < 120; frame++) hud.setRage({ available: true, gamepad });
    assert.deepEqual(ids.map(id => ({ ...element(id).writes })), writes);
  }
  hud.setRage();
  assert.equal(cue.hidden, true);
  assert.equal(cue.getAttribute('aria-hidden'), 'true');
  assert.equal(element('ragelabel').textContent, '');
  assert.equal(element('ragehint').textContent, '');
  const writes = ids.map(id => ({ ...element(id).writes }));
  hud.setRage();
  assert.deepEqual(ids.map(id => ({ ...element(id).writes })), writes);
});

test('active rage renders whole seconds without advancing or repeatedly announcing its clock', () => {
  const { hud, element } = fixture();
  hud.setRage({ available: true });
  hud.setRage({ active: true, remaining: 10 });
  assert.equal(element('ragecue').dataset.state, 'active');
  assert.equal(element('ragelabel').textContent, 'RAGE');
  assert.equal(element('ragekey').hidden, true);
  assert.equal(element('ragecountdown').hidden, false);
  assert.equal(element('ragecountdown').textContent, '10s');
  assert.equal(element('ragehint').textContent, 'KILL TO KEEP BOOSTED HEALTH');
  const ids = ['ragecue', 'ragelabel', 'ragekey', 'ragecountdown', 'ragehint'];
  const writes = ids.map(id => ({ ...element(id).writes }));
  for (let frame = 1; frame < 60; frame++) hud.setRage({ active: true, remaining: 10 - frame / 60 });
  assert.deepEqual(ids.map(id => ({ ...element(id).writes })), writes, 'sub-second simulation updates do not mutate the DOM');
  hud.setRage({ active: true, remaining: 8.75 });
  assert.equal(element('ragecountdown').textContent, '9s');
  assert.equal(element('ragecountdown').getAttribute('aria-label'), '9 seconds remaining');
  assert.equal(element('ragecountdown').getAttribute('aria-live'), 'off');
  hud.update(30);
  assert.equal(hud.snapshot().rage.remaining, 8.75, 'the simulation owns the exact remaining gameplay time');
  assert.equal(element('ragecountdown').textContent, '9s');
  const snapshot = hud.snapshot();
  snapshot.rage.active = false;
  assert.equal(hud.snapshot().rage.active, true, 'inspection cannot mutate HUD state');
});

test('death, retry and feedback resets cannot preserve a stale rage prompt', () => {
  const { hud, element } = fixture();
  hud.setHealth(12);
  hud.setRage({ active: true, remaining: 6 });
  hud.showDeath(true);
  assert.equal(element('ragecue').hidden, true);
  assert.equal(hud.snapshot().rage.active, false);
  hud.setRage({ available: true });
  assert.equal(element('ragecue').hidden, true, 'late gameplay frames cannot paint over death');
  hud.setRage({ active: true, remaining: 3 });
  assert.equal(element('ragecue').hidden, true);
  hud.showDeath(false);
  hud.setRage({ available: true });
  assert.equal(element('ragecue').hidden, false);
  hud.clearFeedback();
  assert.equal(element('ragecue').hidden, true);
  assert.equal(element('ragecountdown').textContent, '');
  assert.equal(element('ragecountdown').getAttribute('aria-label'), '');
  assert.equal(element('ragehint').textContent, '');
  assert.equal(hud.snapshot().rage.available, false);
  assert.equal(hud.snapshot().health, 12, 'resetting a cue never changes health');
});

test('rage countdown rejects invalid time without inventing an expiry or health change', () => {
  const { hud, element } = fixture();
  for (const remaining of [NaN, Infinity, -10, undefined]) {
    hud.setRage({ active: true, remaining });
    assert.equal(element('ragecountdown').textContent, '0s');
    assert.equal(hud.snapshot().rage.remaining, 0);
    assert.equal(hud.snapshot().rage.active, true, 'only the simulation may end rage');
    assert.equal(hud.snapshot().health, 100);
  }
});

test('rage cue is accessible, bounded above vitals, and never animated', () => {
  assert.match(markup, /id="ragecue"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="false"[^>]*aria-hidden="true"[^>]* hidden>/);
  assert.match(markup, /id="ragecountdown"[^>]*role="timer"[^>]*aria-live="off"/);
  const rule = styles.match(/#ragecue\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /bottom:\s*calc\(100% \+ 16px\)/);
  assert.match(rule, /max-width:\s*calc\(/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /animation:\s*none/);
  assert.match(rule, /transition:\s*none/);
});

test('low-health warning uses strict 40 and 20 percent boundaries, including fractional damage', () => {
  const { hud, element } = fixture();
  const vignette = element('healthvignette'), warning = element('healthwarning');
  for (const [health, expected] of [[100, 'normal'], [40, 'normal'], [39.99, 'low'], [20, 'low'], [19.99, 'critical'], [1, 'critical']]) {
    hud.setHealth(health);
    assert.equal(hud.snapshot().health, health, 'presentation does not round simulation health');
    assert.equal(hud.snapshot().healthWarning, expected);
    assert.equal(vignette.dataset.level, expected);
    assert.equal(vignette.hidden, expected === 'normal');
    assert.equal(element('vitals').dataset.healthWarning, expected);
    assert.equal(element('healthbar').getAttribute('aria-valuenow'), String(health));
    assert.equal(warning.textContent, expected === 'critical' ? 'CRITICAL HEALTH' : expected === 'low' ? 'LOW HEALTH' : '');
  }
  assert.equal(element('healthbar').getAttribute('aria-valuetext'), '1 percent health. Critical health.');
});

test('healing reduces critical warning to low and clears it at exactly 40 percent', () => {
  const { hud, element } = fixture();
  hud.setHealth(8);
  hud.setHealth(20);
  assert.equal(element('healthvignette').dataset.level, 'low');
  assert.equal(element('healthwarning').textContent, 'LOW HEALTH');
  assert.equal(element('healthbar').getAttribute('aria-valuetext'), '20 percent health. Low health.');
  hud.setHealth(40);
  assert.equal(element('healthvignette').hidden, true);
  assert.equal(element('healthwarning').textContent, '');
  assert.equal(element('vitals').dataset.low, 'false');
  assert.equal(element('healthbar').getAttribute('aria-valuetext'), '40 percent health.');
  hud.setHealth(100);
  assert.equal(hud.snapshot().healthWarning, 'normal');
});

test('persistent health warning survives elapsed time and transient feedback clears independently', () => {
  const { hud, element } = fixture();
  hud.setHealth(25);
  hud.bloodFlash(0.8);
  assert.equal(element('bloodvignette').style.opacity, '0.800');
  hud.update(10);
  assert.equal(element('bloodvignette').style.opacity, '0.000');
  assert.equal(element('healthvignette').hidden, false);
  assert.equal(hud.snapshot().healthWarning, 'low');
  hud.bloodFlash(1);
  hud.clearFeedback();
  assert.equal(element('bloodvignette').style.opacity, '0');
  assert.equal(element('healthvignette').hidden, false, 'clearing a hit flash must not erase actual low health');
  assert.equal(element('healthwarning').textContent, 'LOW HEALTH');
});

test('death hides the persistent cue, rejects late low-health painting, and retry restores normal', () => {
  const { hud, element } = fixture();
  hud.setHealth(15);
  hud.showDeath(true);
  assert.equal(element('healthvignette').hidden, true);
  assert.equal(element('healthwarning').textContent, '');
  hud.setHealth(9);
  assert.equal(element('healthvignette').hidden, true);
  assert.equal(hud.snapshot().healthWarning, 'normal');
  hud.setHealth(100);
  hud.showDeath(false);
  assert.equal(hud.snapshot().health, 100);
  assert.equal(element('healthvignette').hidden, true);
  assert.equal(element('healthwarning').textContent, '');
  hud.setHealth(39);
  assert.equal(element('healthvignette').hidden, false, 'a later life can warn normally');
  hud.setHealth(0);
  assert.equal(element('healthvignette').hidden, true, 'zero health clears even before the death dialog arrives');
});

test('repeated health updates and simulation ticks do not rewrite the persistent effect', () => {
  const { hud, element } = fixture();
  const ids = ['healthvignette', 'healthwarning', 'healthbar', 'healthtext', 'healthfill', 'vitals'];
  for (const health of [100, 39, 20, 19, 0, 100]) {
    hud.setHealth(health);
    const writes = ids.map(id => ({ ...element(id).writes }));
    for (let frame = 0; frame < 120; frame++) {
      hud.setHealth(health);
      hud.update(1 / 120);
    }
    assert.deepEqual(ids.map(id => ({ ...element(id).writes })), writes);
  }
  hud.setHealth(19);
  const writes = ['healthvignette', 'healthwarning'].map(id => ({ ...element(id).writes }));
  hud.setHealth(18);
  assert.deepEqual(['healthvignette', 'healthwarning'].map(id => ({ ...element(id).writes })), writes, 'same severity does not repaint the screen-wide effect');
});

test('health display clamps invalid input without creating a stuck critical effect', () => {
  const { hud, element } = fixture();
  for (const value of [NaN, Infinity, undefined, 500]) {
    hud.setHealth(10);
    hud.setHealth(value);
    assert.equal(hud.snapshot().health, 100);
    assert.equal(element('healthvignette').hidden, true);
  }
  hud.setHealth(-1);
  assert.equal(hud.snapshot().health, 0);
  assert.equal(element('healthvignette').hidden, true);
});

test('health effect is a static full-screen layer below reticle text and respects HUD modal visibility', () => {
  assert.match(markup, /id="healthvignette"[^>]*aria-hidden="true"[^>]* hidden>/);
  assert.match(markup, /id="healthwarning"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  const rule = styles.match(/#healthvignette\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /inset:\s*0/);
  assert.match(rule, /z-index:\s*-1/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /animation:\s*none/);
  assert.match(rule, /transition:\s*none/);
  assert.doesNotMatch(rule, /(?:backdrop-filter|filter|will-change):/);
  assert.match(styles, /#healthvignette\[data-level="critical"\]/);
  assert.match(styles, /body:has\(#overlay:not\(\.hidden\)\) #hud, body:has\(#introcard\.show\) #hud, body:has\(#endcard\.show\) #hud \{ visibility: hidden; \}/);
  assert.match(styles, /body:has\(#deathscreen\.show\) #healthvignette, body:has\(#deathscreen\.show\) #healthwarning \{ display: none; \}/);
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
