/** Hysteresis prevents resolution oscillation around the frame budget. */
export class FrameBudget {
  constructor({ min = 0.7, max = 1.4, initial = 1.2 } = {}) {
    this.min = min; this.max = max; this.scale = initial;
    this.frames = 0; this.total = 0; this.slowWindows = 0; this.fastWindows = 0;
  }
  sample(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.15) return null;
    this.frames++; this.total += dt;
    if (this.frames < 90) return null;
    const average = this.total / this.frames;
    this.frames = 0; this.total = 0;
    this.slowWindows = average > 0.0205 ? this.slowWindows + 1 : 0;
    this.fastWindows = average < 0.0155 ? this.fastWindows + 1 : 0;
    let next = this.scale;
    if (this.slowWindows >= 2) { next = Math.max(this.min, this.scale - 0.1); this.slowWindows = 0; }
    if (this.fastWindows >= 4) { next = Math.min(this.max, this.scale + 0.05); this.fastWindows = 0; }
    if (Math.abs(next - this.scale) < 0.001) return null;
    this.scale = next;
    return next;
  }
}

/** Fixed simulation steps are bounded after stalls and reset on every pause. */
export class FixedStepClock {
  constructor(step = 1 / 120, maxSteps = 8) {
    this.step = step; this.maxSteps = maxSteps; this.accumulator = 0;
  }
  advance(dt, playing) {
    if (!playing || !Number.isFinite(dt) || dt < 0) { this.accumulator = 0; return 0; }
    this.accumulator = Math.min(this.accumulator + dt, this.step * this.maxSteps);
    const steps = Math.min(this.maxSteps, Math.floor((this.accumulator + 1e-10) / this.step));
    this.accumulator -= steps * this.step;
    return steps;
  }
}
