const BUSES = new Set(['effects', 'ambience', 'music', 'radio']);
const MAX_GROUPS = 32;
const MAX_ENTRIES = 64;
const MAX_VARIANTS = 5;
const MAX_PENDING = 2;
const MAX_CACHED = 32;
const MAX_SAMPLE_BYTES = 3 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

function localSampleURL(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  // Deliberately exclude escapes, queries, and URL schemes. A manifest cannot
  // turn a local sample request into a remote request or leave its asset path.
  if (!/^[a-zA-Z0-9_./-]+$/.test(value) || value.includes('..') || value.includes('//')) return null;
  if (value.endsWith('/') || value === '.') return null;
  if (value.startsWith('/') && !/^\/(audio|assets)\//.test(value)) return null;
  return value;
}

function decodedBytes(buffer) {
  if (!buffer || typeof buffer.getChannelData !== 'function') return 0;
  const { length, numberOfChannels, sampleRate, duration } = buffer;
  if (!Number.isSafeInteger(length) || length <= 0) return 0;
  if (numberOfChannels !== 1 && numberOfChannels !== 2) return 0;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 8) return 0;
  if (length / sampleRate > 8) return 0;
  if (Math.abs(duration - length / sampleRate) > 1 / sampleRate) return 0;
  const bytes = length * numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (bytes > MAX_SAMPLE_BYTES) return 0;
  const backingBuffers = new Set();
  let backingBytes = 0;
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    if (!(data instanceof Float32Array) || data.length !== length) return 0;
    if (!backingBuffers.has(data.buffer)) {
      backingBuffers.add(data.buffer);
      backingBytes += data.buffer.byteLength;
    }
  }
  // An injected decoder may return channel views into a larger allocation.
  // Account for the retained backing memory, not just the visible PCM length.
  const retainedBytes = Math.max(bytes, backingBytes);
  return retainedBytes <= MAX_SAMPLE_BYTES ? retainedBytes : 0;
}

/**
 * A silent, bounded cache. Loading and decoding are supplied by the audio
 * controller; this module never fetches, constructs WebAudio nodes, or plays.
 * A request only warms the cache. Its completion never replays an old event.
 */
export function createSampleBank({ load = null, decode = null, canLoad = () => false } = {}) {
  let generation = 0;
  let entryCount = 0;
  let cacheBytes = 0;
  const groups = new Map();
  const cursors = new Map();
  const cache = new Map();
  const failed = new Set();
  const warmed = new Set();
  const queue = [];
  const queued = new Set();
  const pending = new Map();
  // Aborted loaders may ignore their signal. Keep their worker slots occupied
  // until they settle so repeated cancellation cannot exceed the load budget.
  const workers = new Set();

  function allowed(entry) {
    if (!entry || entry.gain <= 0 || typeof canLoad !== 'function') return false;
    try { return canLoad(entry.bus) === true; } catch { return false; }
  }

  function current(job) {
    return job.generation === generation && !job.controller.signal.aborted && allowed(job.entry);
  }

  function remember(entry, buffer, bytes) {
    while (cache.size >= MAX_CACHED || cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    cache.set(entry, { buffer, bytes });
    cacheBytes += bytes;
    // Retain this mark even when LRU eviction drops the buffer. A per-frame
    // preload must not keep reloading a manifest larger than the cache.
    warmed.add(entry);
  }

  async function run(job) {
    try {
      if (!current(job)) return;
      const bytes = await load({ id: job.entry.id, url: job.entry.url, signal: job.controller.signal });
      if (!current(job)) return;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_SAMPLE_BYTES) {
        throw new Error('Invalid sample data');
      }
      if (!current(job)) return;
      const buffer = await decode(bytes);
      if (!current(job)) return;
      const size = decodedBytes(buffer);
      if (!size) throw new Error('Invalid decoded sample');
      if (!current(job)) return;
      remember(job.entry, buffer, size);
    } catch {
      // Muting and cancellation are not asset failures. Genuine failures stay
      // cached until a new manifest avoids retrying a missing file every frame.
      if (current(job)) failed.add(job.entry);
    } finally {
      if (pending.get(job.entry) === job) pending.delete(job.entry);
      workers.delete(job);
      pump();
    }
  }

  function pump() {
    while (workers.size < MAX_PENDING && queue.length) {
      const entry = queue.shift();
      queued.delete(entry);
      if (cache.has(entry) || failed.has(entry) || !allowed(entry)) continue;
      const job = { entry, generation, controller: new globalThis.AbortController() };
      pending.set(entry, job);
      workers.add(job);
      void run(job);
    }
  }

  function cancel() {
    generation++;
    queue.length = 0;
    queued.clear();
    pending.clear();
    for (const job of workers) job.controller.abort();
  }

  function clear() {
    cancel();
    cache.clear();
    warmed.clear();
    cacheBytes = 0;
    cursors.clear();
  }

  function setManifest(manifest) {
    clear();
    groups.clear();
    failed.clear();
    entryCount = 0;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return snapshot();
    const pairs = manifest instanceof Map ? manifest.entries() : Object.entries(manifest);
    for (const [id, value] of pairs) {
      if (groups.size >= MAX_GROUPS || entryCount >= MAX_ENTRIES) break;
      if (typeof id !== 'string' || !id.trim() || id.length > 128) continue;
      const candidates = Array.isArray(value) ? value.slice(0, MAX_VARIANTS) : [value];
      const variants = [];
      for (const candidate of candidates) {
        if (entryCount >= MAX_ENTRIES) break;
        if (!candidate || typeof candidate !== 'object' || !BUSES.has(candidate.bus)) continue;
        const url = localSampleURL(candidate.url);
        if (!url) continue;
        const gain = Number.isFinite(candidate.gain) ? Math.max(0, Math.min(1, candidate.gain)) : 1;
        variants.push({ id, url, bus: candidate.bus, gain });
        entryCount++;
      }
      if (variants.length) groups.set(id, variants);
    }
    return snapshot();
  }

  function enqueueGroup(id, warmup, priority = false) {
    const variants = groups.get(id);
    if (!variants || typeof load !== 'function' || typeof decode !== 'function') return false;
    let accepted = false;
    const promoted = priority ? [] : null;
    for (const entry of variants) {
      if (warmup && warmed.has(entry)) continue;
      if (!allowed(entry) || failed.has(entry)) continue;
      if (cache.has(entry) || pending.has(entry) || queued.has(entry)) {
        accepted = true;
      } else if (queue.length < MAX_ENTRIES) {
        queue.push(entry);
        queued.add(entry);
        accepted = true;
      }
      if (priority && queued.has(entry)) promoted.push(entry);
    }
    if (promoted?.length) {
      const promotedEntries = new Set(promoted);
      const remainder = queue.filter(entry => !promotedEntries.has(entry));
      // Promote only queued work, preserving the group's variant order. The
      // two active workers finish normally and their slots are never bypassed.
      queue.splice(0, queue.length, ...promoted, ...remainder);
    }
    pump();
    return accepted;
  }

  function request(id, { priority = false } = {}) {
    return enqueueGroup(id, false, priority === true);
  }

  function peek(id) {
    const variants = groups.get(id);
    if (!variants) return null;
    const first = cursors.get(id) ?? 0;
    for (let offset = 0; offset < variants.length; offset++) {
      const index = (first + offset) % variants.length;
      const entry = variants[index];
      const value = cache.get(entry);
      if (!value || !allowed(entry)) continue;
      cursors.set(id, (index + 1) % variants.length);
      cache.delete(entry);
      cache.set(entry, value);
      return { buffer: value.buffer, gain: entry.gain };
    }
    return null;
  }

  function preload() {
    let accepted = 0;
    // Only successful loads are marked warm, so canceled or gated work can
    // retry without undoing completed warmup when the controller resumes.
    for (const id of groups.keys()) if (enqueueGroup(id, true)) accepted++;
    return accepted;
  }

  function snapshot() {
    return {
      groups: groups.size, entries: entryCount, queued: queue.length,
      pending: pending.size, inFlight: workers.size, cached: cache.size,
      bytes: cacheBytes, failed: failed.size, generation,
    };
  }

  return Object.freeze({ setManifest, request, peek, preload, cancel, clear, snapshot });
}
