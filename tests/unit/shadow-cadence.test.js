import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowCadence } from '../../src/render/shadow-cadence.js';

test('lower tiers reuse the map and skip repeated draws without changing resources', () => {
  const map = {}, shadow = { map, autoUpdate: true, needsUpdate: false };
  const cadence = createShadowCadence(shadow);
  let draws = 0;
  for (let i = 0; i < 120; i++) {
    if (cadence.update(1 / 120, 1)) draws++;
    shadow.needsUpdate = false; // WebGL consumes the requested update.
  }
  assert.equal(draws, 30);
  assert.equal(shadow.map, map);
  assert.equal(shadow.autoUpdate, false);
  assert.equal(cadence.update(0, 0), true);
  assert.equal(shadow.autoUpdate, true);
});

test('changed projection, first allocation and tier changes always refresh immediately', () => {
  const shadow = { map: {}, autoUpdate: true, needsUpdate: false };
  const cadence = createShadowCadence(shadow);
  assert.equal(cadence.update(0, 2), true);
  shadow.needsUpdate = false;
  assert.equal(cadence.update(0.001, 2), false);
  assert.equal(cadence.update(0, 2, true), true);
  assert.equal(shadow.needsUpdate, true);
  shadow.needsUpdate = false;
  assert.equal(cadence.update(0, 1), true);
  shadow.map = null;
  assert.equal(cadence.update(0, 1), true);
});
