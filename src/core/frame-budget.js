import { FrameTelemetry } from './frame-telemetry.js';

const validTiming = value => Number.isFinite(value) && value >= 0;
const rounded = value => Math.round(value * 100) / 100;
const boundedFps = value => Number.isFinite(value) && value > 0 ? Math.max(24, Math.min(240, value)) : 60;
const tierForScale = scale => scale < 0.9 ? 2 : scale < 1.05 ? 1 : 0;

/**
 * Target-relative hysteresis controls presentation, never the simulation rate.
 * The default target is 60 fps; high-refresh targets must be chosen explicitly.
 * sample() preserves the resolution-scale return API. Inspect revision as well
 * to apply a CPU-driven qualityTier change (0 full, 1 balanced, 2 lean).
 * Pass timings.allowRecovery = false during combat or other sensitive activity;
 * quality reductions remain available, but recovery needs fresh clean windows.
 */
export class FrameBudget {
  constructor({ min = 0.7, max = 1.4, initial = 1.2, targetFps = 60, sampleWindow = 240 } = {}) {
    this.min = min; this.max = max; this.scale = Math.max(min, Math.min(max, initial));
    this.targetFps = boundedFps(targetFps);
    this.telemetry = new FrameTelemetry({ sampleWindow });
    this.cpuTier = 0;
    this.qualityTier = tierForScale(this.scale);
    this.revision = 0;
    this.lastChange = 'initial';
    this.reset();
  }

  clearWindow() {
    this.windowSeconds = 0;
    this.frames = 0;
    this.total = 0;
    this.lateFrames = 0;
    this.windowStalls = 0;
    this.windowAllowsRecovery = true;
    this.cpuTotal = 0; this.cpuSamples = 0;
    this.simulationTotal = 0; this.simulationSamples = 0;
    this.gpuTotal = 0; this.gpuSamples = 0;
  }

  /** Call on pause/visibility/resume boundaries; do not submit hidden-tab gaps. */
  reset() {
    this.telemetry.reset();
    this.clearWindow();
    this.slowWindows = 0;
    this.fastWindows = 0;
    this.sinceChange = 0;
    this.sinceStall = Infinity;
    this.bottleneck = 'unknown';
  }

  setTargetFps(value) {
    const next = boundedFps(value);
    if (this.targetFps === next) return;
    this.targetFps = next;
    this.reset();
  }

  sample(dt, timings) {
    if (!this.telemetry.record(dt, timings)) return null;
    // Fixed High/Performance presets still collect diagnostics. Their work
    // cannot change the automatic preset's decision history or quality.
    if (timings?.adaptive === false) return null;
    if (timings?.allowRecovery === false) {
      this.windowAllowsRecovery = false;
      this.fastWindows = 0;
    }
    const budgetMs = 1000 / this.targetFps;
    const frameMs = dt * 1000;
    // A large stall is kept in telemetry, but cannot instantly advance several
    // decisions or earn recovery time. Background gaps must use reset().
    const elapsed = Math.min(dt, 0.25);
    this.windowSeconds += elapsed;
    this.sinceChange += elapsed;
    this.sinceStall += elapsed;
    this.frames++;
    // Limit one stall's influence on sustained-load classification. Repeated
    // long frames still exceed the budget; a single stall has its own cooldown.
    this.total += Math.min(frameMs, budgetMs * 3);
    if (frameMs > budgetMs * 1.1) this.lateFrames++;
    if (frameMs >= this.telemetry.longStallThresholdMs) {
      this.windowStalls++;
      this.sinceStall = 0;
      this.fastWindows = 0;
    }
    if (validTiming(timings?.cpuMs)) { this.cpuTotal += timings.cpuMs; this.cpuSamples++; }
    if (validTiming(timings?.simulationMs)) { this.simulationTotal += timings.simulationMs; this.simulationSamples++; }
    if (validTiming(timings?.gpuMs)) { this.gpuTotal += timings.gpuMs; this.gpuSamples++; }
    if (this.windowSeconds < 1 || this.frames < 8) return null;

    const meanMs = this.total / this.frames;
    const cpuMs = this.cpuSamples ? this.cpuTotal / this.cpuSamples : null;
    const simulationMs = this.simulationSamples ? this.simulationTotal / this.simulationSamples : null;
    const gpuMs = this.gpuSamples ? this.gpuTotal / this.gpuSamples : null;
    const cpuBusy = cpuMs !== null && cpuMs > budgetMs * 0.85;
    const gpuBusy = gpuMs !== null && gpuMs > budgetMs * 0.85;
    // Callback wall time includes rendering and can contain driver/GPU waits.
    // Without GPU measurements, only clearly dominant simulation work warrants
    // locking out resolution changes. Uncertain render pressure may need both.
    const simulationDominates = simulationMs !== null && simulationMs > budgetMs * 0.65 && simulationMs >= cpuMs * 0.6;
    const cpuAttributed = cpuBusy && (gpuMs !== null || simulationDominates);
    const slow = meanMs > budgetMs * 1.08 || cpuBusy || gpuBusy;
    this.bottleneck = !slow ? 'none' : cpuBusy && gpuBusy ? 'mixed' : cpuAttributed ? 'cpu' : gpuBusy ? 'gpu' : 'unknown';
    const fast = this.windowAllowsRecovery && !slow && meanMs <= budgetMs * 1.02 && this.lateFrames / this.frames < 0.05 &&
      (cpuMs === null || cpuMs < budgetMs * 0.6) && (gpuMs === null || gpuMs < budgetMs * 0.65) &&
      this.windowStalls === 0 && this.sinceStall >= 10;
    this.slowWindows = slow ? this.slowWindows + 1 : 0;
    this.fastWindows = fast ? this.fastWindows + 1 : 0;
    this.clearWindow();

    const previousScale = this.scale;
    const previousTier = this.qualityTier;
    if (this.slowWindows >= 2 && this.sinceChange >= 2) {
      if (cpuBusy) this.cpuTier = Math.min(2, this.cpuTier + 1);
      if (this.bottleneck !== 'cpu') this.scale = Math.max(this.min, rounded(this.scale - 0.1));
      this.lastChange = 'load';
      this.slowWindows = 0;
    } else if (this.fastWindows >= 8 && this.sinceChange >= 8) {
      if (this.cpuTier > 0) this.cpuTier--;
      else this.scale = Math.min(this.max, rounded(this.scale + 0.05));
      this.lastChange = 'recovery';
      this.fastWindows = 0;
    }
    this.qualityTier = Math.max(this.cpuTier, tierForScale(this.scale));
    if (this.scale !== previousScale || this.qualityTier !== previousTier) {
      this.revision++;
      this.sinceChange = 0;
    }
    return this.scale !== previousScale ? this.scale : null;
  }

  /** Allocate diagnostics only when inspected, never on each animation frame. */
  snapshot() {
    return {
      ...this.telemetry.snapshot(),
      targetFps: this.targetFps, budgetMs: 1000 / this.targetFps,
      scale: this.scale, qualityTier: this.qualityTier, revision: this.revision,
      bottleneck: this.bottleneck, lastChange: this.lastChange,
      stallRecoverySeconds: Math.max(0, 10 - this.sinceStall),
    };
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
