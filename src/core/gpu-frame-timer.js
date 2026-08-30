const EXTENSION = 'EXT_disjoint_timer_query_webgl2';

function boundedInteger(value, fallback, max) {
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

/**
 * Opt-in WebGL 2 elapsed-GPU-time measurement. Bracket the complete render with
 * begin()/end(); completed queries are collected on the next begin or snapshot.
 * Nothing waits for the GPU, and a full pool skips a sample instead of growing.
 * reset() discards both samples and in-flight queries for a fresh benchmark.
 */
export function createGpuFrameTimer(gl, { enabled = false, maxQueries = 4, sampleWindow = 240 } = {}) {
  const poolLimit = boundedInteger(maxQueries, 4, 8);
  const windowLimit = boundedInteger(sampleWindow, 240, 2048);
  const queries = [], idle = [], pending = [], samples = [];
  let extension = null, active = null, supported = null, status = 'disabled';
  let counterBits = null;
  let measuring = false, disposed = false, listening = false;
  let sampleIndex = 0, latestMs = null, totalSamples = 0;
  let skippedFrames = 0, discardedQueries = 0, disjointEvents = 0;

  function clearSamples() {
    samples.length = 0;
    sampleIndex = 0;
    latestMs = null;
    totalSamples = 0;
    skippedFrames = 0;
    discardedQueries = 0;
    disjointEvents = 0;
  }

  function forgetQueries() {
    queries.length = idle.length = pending.length = 0;
    active = null;
  }

  function contextLost() {
    // Context loss invalidates WebGL objects. Do not submit cleanup commands.
    forgetQueries();
    clearSamples();
    extension = null;
    counterBits = null;
    status = 'context-lost';
  }

  function releaseQueries() {
    if (queries.length) {
      try {
        if (gl.isContextLost?.()) { contextLost(); return; }
        if (active && extension) gl.endQuery(extension.TIME_ELAPSED_EXT);
      } catch { /* Telemetry must never interrupt rendering or cleanup. */ }
      for (const query of queries) {
        try { gl.deleteQuery(query); } catch { /* The context may have been lost. */ }
      }
    }
    forgetQueries();
  }

  function fail() {
    releaseQueries();
    clearSamples();
    extension = null;
    if (status !== 'context-lost') status = 'error';
  }

  function initialize() {
    supported = false;
    counterBits = null;
    try {
      if (gl?.isContextLost?.()) { contextLost(); return false; }
      if (!['getExtension', 'getQuery', 'createQuery', 'beginQuery', 'endQuery', 'getQueryParameter',
        'getParameter', 'deleteQuery'].every(name => typeof gl?.[name] === 'function')) {
        clearSamples();
        status = 'unsupported';
        return false;
      }
      extension = gl.getExtension(EXTENSION);
      if (extension) {
        // An exposed extension may still provide a zero-bit elapsed counter.
        // Probe the WebGL 2 query target once, not an allocated query object.
        const bits = gl.getQuery(extension.TIME_ELAPSED_EXT, extension.QUERY_COUNTER_BITS_EXT);
        counterBits = Number.isInteger(bits) && bits >= 0 ? bits : null;
        supported = counterBits > 0;
      }
      status = supported ? 'ready' : 'unsupported';
      if (!supported) { extension = null; clearSamples(); }
      return supported;
    } catch {
      fail();
      return false;
    }
  }

  function contextRestored() {
    if (!disposed && measuring) initialize();
  }

  function listen(value) {
    const canvas = gl?.canvas;
    if (value === listening || !canvas?.addEventListener || !canvas?.removeEventListener) return;
    const method = value ? 'addEventListener' : 'removeEventListener';
    canvas[method]('webglcontextlost', contextLost);
    canvas[method]('webglcontextrestored', contextRestored);
    listening = value;
  }

  function ready() {
    if (!measuring || disposed || status !== 'ready') return false;
    if (gl.isContextLost?.()) { contextLost(); return false; }
    return true;
  }

  function collect() {
    if (!ready()) return false;
    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      disjointEvents++;
      discardedQueries += pending.length;
      releaseQueries();
      return false;
    }
    // Queries execute in submission order. Leave unfinished work for a later
    // animation frame; QUERY_RESULT is never requested before availability.
    while (pending.length) {
      const query = pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
      pending.shift();
      idle.push(query);
      if (!Number.isFinite(nanoseconds) || nanoseconds < 0) { discardedQueries++; continue; }
      latestMs = nanoseconds / 1e6;
      samples[sampleIndex] = latestMs;
      sampleIndex = (sampleIndex + 1) % windowLimit;
      totalSamples++;
    }
    return true;
  }

  function begin() {
    if (!measuring || disposed || active) return false;
    try {
      if (!collect()) return false;
      let query = idle.pop();
      if (!query) {
        if (queries.length >= poolLimit) { skippedFrames++; return false; }
        query = gl.createQuery();
        if (!query) { fail(); return false; }
        queries.push(query);
      }
      active = query;
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      return true;
    } catch {
      fail();
      return false;
    }
  }

  function end() {
    if (!measuring || disposed || !active) return false;
    try {
      if (!ready()) return false;
      gl.endQuery(extension.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
      return true;
    } catch {
      fail();
      return false;
    }
  }

  function setEnabled(value) {
    if (disposed) return false;
    const next = Boolean(value);
    if (next === measuring) return status === 'ready';
    measuring = next;
    listen(next);
    if (next) return initialize();
    releaseQueries();
    extension = null;
    status = 'disabled';
    // Preserve the completed result when a benchmark stops measuring.
    return false;
  }

  function snapshot() {
    if (measuring && !disposed && !active) {
      try { collect(); } catch { fail(); }
    }
    const sorted = samples.slice().sort((a, b) => a - b), count = sorted.length;
    const middle = Math.floor(count / 2);
    return {
      enabled: measuring, supported, status, counterBits,
      latestMs,
      medianMs: count ? (count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
      p95Ms: count ? sorted[Math.ceil(count * 0.95) - 1] : null,
      sampleCount: count, totalSamples, sampleWindow: windowLimit,
      pendingQueries: pending.length, activeQuery: active !== null,
      allocatedQueries: queries.length, maxQueries: poolLimit,
      skippedFrames, discardedQueries, disjointEvents,
    };
  }

  function reset() {
    if (disposed) return;
    releaseQueries();
    clearSamples();
  }

  function dispose() {
    if (disposed) return;
    releaseQueries();
    clearSamples();
    listen(false);
    extension = null;
    measuring = false;
    disposed = true;
    status = 'disposed';
  }

  setEnabled(enabled);
  return Object.freeze({ setEnabled, begin, end, snapshot, reset, dispose });
}
