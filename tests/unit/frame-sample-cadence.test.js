import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameSampleCadence } from '../../src/core/frame-sample-cadence.js';
import { createShadowCadence } from '../../src/render/shadow-cadence.js';

test('GPU sampling starts immediately and remains sparse across repeated cycles', () => {
  const cadence = createFrameSampleCadence(), frames = [];
  for (let frame = 0; frame < 70; frame++) if (cadence.tick()) frames.push(frame);
  assert.deepEqual(frames, [0, 7, 15, 24, 35, 42, 50, 59]);
});

test('reset resumes sampling immediately without carrying prior spacing or changing another instance', () => {
  const cadence = createFrameSampleCadence(), other = createFrameSampleCadence();
  for (let frame = 0; frame < 18; frame++) {
    assert.equal(cadence.tick(), other.tick());
  }
  cadence.reset();
  assert.equal(cadence.tick(), true);
  assert.equal(other.tick(), false, 'another measurement session keeps its schedule');
  for (let frame = 1; frame < 7; frame++) assert.equal(cadence.tick(), false);
  assert.equal(cadence.tick(), true, 'resuming restarts the full schedule');
});

for (const fps of [60, 120]) {
  for (const shadowHz of [30, 20]) {
    test(`sparse GPU samples cover every shadow phase at ${fps} FPS with ${shadowHz} Hz shadows`, () => {
      const cadence = createFrameSampleCadence();
      const shadow = { map: {}, autoUpdate: true, needsUpdate: false };
      const shadows = createShadowCadence(shadow);
      const interval = fps / shadowHz, tier = shadowHz === 30 ? 1 : 2;
      const samplesByPhase = Array(interval).fill(0);
      let samples = 0, sampledRefreshes = 0, refreshes = 0;
      // Twelve 35-frame cycles make every standard shadow period divide this
      // observation window; using the real updater also checks timing phases.
      const frameCount = 35 * 12;
      for (let frame = 0; frame < frameCount; frame++) {
        const refresh = shadows.update(1 / fps, tier);
        if (refresh) refreshes++;
        if (cadence.tick()) {
          samples++;
          samplesByPhase[frame % interval]++;
          if (refresh) sampledRefreshes++;
        }
        shadow.needsUpdate = false;
      }
      assert.equal(samples, 48, 'only four GPU queries are requested per 35-frame cycle');
      for (const count of samplesByPhase) assert.equal(count, samples / interval);
      assert.equal(sampledRefreshes / samples, refreshes / frameCount,
        'sampled shadow cost has the same refresh share as the rendered workload');
      assert.ok(sampledRefreshes > 0 && sampledRefreshes < samples,
        'the estimator sees both shadow refreshes and frames that reuse the map');
    });
  }
}
