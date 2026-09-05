// A fixed eight-frame period can sample only shadow refreshes or only reused
// shadows. This 35-frame cycle visits every phase of 2/3/4/6-frame updates.
const INTERVALS = Object.freeze([7, 8, 9, 11]);

/** Sparse GPU measurements without allocating work or locking to shadow cadence. */
export function createFrameSampleCadence() {
  let framesUntilSample = 0, nextInterval = 0;
  return {
    tick() {
      if (framesUntilSample > 0) {
        framesUntilSample--;
        return false;
      }
      framesUntilSample = INTERVALS[nextInterval] - 1;
      nextInterval = (nextInterval + 1) % INTERVALS.length;
      return true;
    },
    reset() {
      framesUntilSample = 0;
      nextInterval = 0;
    },
  };
}
