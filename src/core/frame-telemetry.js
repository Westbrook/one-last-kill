const validTiming = value => Number.isFinite(value) && value >= 0;

/** Fixed storage on the frame path; sorting and result objects are diagnostic-only. */
class TimingSeries {
  constructor(capacity) {
    this.values = new Float64Array(capacity);
    this.index = 0;
    this.count = 0;
    this.totalSamples = 0;
  }

  record(value) {
    const previous = this.count === this.values.length ? this.values[this.index] : null;
    this.values[this.index] = value;
    this.index = (this.index + 1) % this.values.length;
    this.count = Math.min(this.count + 1, this.values.length);
    this.totalSamples++;
    return previous;
  }

  reset() { this.index = 0; this.count = 0; }

  snapshot() {
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((a, b) => a - b);
    let sum = 0;
    for (const value of sorted) sum += value;
    return {
      sampleCount: this.count,
      totalSamples: this.totalSamples,
      meanMs: this.count ? sum / this.count : null,
      p95Ms: this.count ? sorted[Math.ceil(this.count * 0.95) - 1] : null,
      p99Ms: this.count ? sorted[Math.ceil(this.count * 0.99) - 1] : null,
      maxMs: this.count ? sorted[this.count - 1] : null,
    };
  }
}

/**
 * Frame intervals are seconds; optional CPU section / GPU measurements are ms.
 * Reuse the timings object in callers. Missing GPU data stays unknown, never 0.
 * Long frames are observable symptoms; this does not infer garbage collection.
 */
export class FrameTelemetry {
  constructor({ sampleWindow = 240, longStallThresholdMs = 50 } = {}) {
    this.sampleWindow = Number.isFinite(sampleWindow) ? Math.max(1, Math.min(2048, Math.floor(sampleWindow))) : 240;
    this.longStallThresholdMs = validTiming(longStallThresholdMs) && longStallThresholdMs > 0 ? longStallThresholdMs : 50;
    this.frame = new TimingSeries(this.sampleWindow);
    this.cpu = new TimingSeries(this.sampleWindow);
    this.simulation = new TimingSeries(this.sampleWindow);
    this.render = new TimingSeries(this.sampleWindow);
    this.gpu = new TimingSeries(this.sampleWindow);
    this.stallCount = 0;
    this.recentStallCount = 0;
    this.maxStallMs = 0;
  }

  record(dt, timings) {
    if (!Number.isFinite(dt) || dt <= 0) return false;
    const frameMs = dt * 1000;
    if (!Number.isFinite(frameMs)) return false;
    const previous = this.frame.record(frameMs);
    if (previous !== null && previous >= this.longStallThresholdMs) this.recentStallCount--;
    if (frameMs >= this.longStallThresholdMs) {
      this.stallCount++;
      this.recentStallCount++;
      this.maxStallMs = Math.max(this.maxStallMs, frameMs);
    }
    if (validTiming(timings?.cpuMs)) this.cpu.record(timings.cpuMs);
    if (validTiming(timings?.simulationMs)) this.simulation.record(timings.simulationMs);
    if (validTiming(timings?.renderMs)) this.render.record(timings.renderMs);
    if (validTiming(timings?.gpuMs)) this.gpu.record(timings.gpuMs);
    return true;
  }

  /** A pause/resume starts a fresh recent window, retaining session stall evidence. */
  reset() {
    this.frame.reset();
    this.cpu.reset();
    this.simulation.reset();
    this.render.reset();
    this.gpu.reset();
    this.recentStallCount = 0;
  }

  snapshot() {
    return {
      sampleWindow: this.sampleWindow,
      frame: this.frame.snapshot(), cpu: this.cpu.snapshot(),
      simulation: this.simulation.snapshot(), render: this.render.snapshot(), gpu: this.gpu.snapshot(),
      longStalls: {
        totalCount: this.stallCount, recentCount: this.recentStallCount,
        maxMs: this.maxStallMs, thresholdMs: this.longStallThresholdMs,
      },
    };
  }
}
