import { createAudioController } from '../src/core/audio.js';
import catalog from '../src/core/audio-catalog.json' with { type: 'json' };

const SAMPLE_RATE = 48000;
const DURATION = 40;
const QUANTUM = 128;
const STEP_FRAMES = 1920; // 40 ms, exactly 15 render quanta.
const listener = { position: { x: 0, y: 1.6, z: 0 }, yaw: 0 };
const outdoor = { environment: 'street' };
const cues = [];
const cue = (at, label, method, options = {}) => cues.push({ at, label, method, options });

cue(0.4, 'Pistol · isolated', 'pistolShot', outdoor);
cue(1.8, 'Rifle · isolated', 'gunshot', outdoor);
cue(3.2, 'Shotgun · isolated', 'shotgunShot', outdoor);
cue(4.6, 'SMG · isolated', 'smgShot', outdoor);
cue(6, 'Machine gun · isolated', 'machinegunShot', outdoor);
for (let shot = 0; shot < 6; shot++) cue(7.6 + shot * 0.075, `SMG burst · shot ${shot + 1}`, 'smgShot', outdoor);
cue(9.6, 'Rifle · outdoors, nearby', 'gunshot', outdoor);
cue(11.2, 'Rifle · indoors, nearby', 'gunshot', { environment: 'apartment' });
cue(12.8, 'Rifle · outdoors, 45 m to the right', 'gunshot', { environment: 'street', pos: { x: 45, y: 1.6, z: 0 } });
for (const [index, weapon] of ['pistol', 'shotgun', 'bat', 'knife'].entries()) {
  cue(14.4 + index * 1.2, `Pickup · ${weapon}`, 'pickupChime', { kind: 'weapon', weapon, ...outdoor });
}
cue(19.2, 'Pickup · ammunition', 'pickupChime', { kind: 'ammo', weapon: 'pistol', ...outdoor });
cue(20.4, 'Pickup · health', 'pickupChime', { kind: 'health', ...outdoor });
cue(22, 'Pistol reload · remove magazine', 'weaponMechanical', { weapon: 'pistol', action: 'reload-start', ...outdoor });
cue(22.792, 'Pistol reload · insert magazine', 'weaponMechanical', { weapon: 'pistol', action: 'reload-insert', ...outdoor });
cue(23.2, 'Pistol reload · finish', 'weaponMechanical', { weapon: 'pistol', action: 'reload-end', ...outdoor });
cue(25.6, 'Recorded radio · ready', 'announceCheckpoint', { id: 'review-ready', text: 'Ready.', sampleId: 'radio:ready', zone: 'street' });
cue(30.4, 'Recorded radio · cover me', 'announceCheckpoint', { id: 'review-cover', text: 'Cover me.', sampleId: 'radio:cover-me', zone: 'street' });

const button = document.querySelector('#render');
const selector = document.querySelector('#version');
const status = document.querySelector('#status');
const report = document.querySelector('#report');
const player = document.querySelector('#player');
const download = document.querySelector('#download');
const factories = new Map([['current', createAudioController]]);
let objectURL = null;

function showReport(value) { report.textContent = JSON.stringify(value, null, 2); }
function clearDownload() {
  player.pause();
  player.removeAttribute('src');
  player.muted = true;
  player.hidden = true;
  player.load();
  download.hidden = true;
  download.removeAttribute('href');
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
}

for (const item of cues) {
  const row = document.createElement('tr');
  for (const value of [item.at.toFixed(3), item.label]) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }
  document.querySelector('#timeline').append(row);
}

function seededRandom() {
  let seed = 0x51a7cafe;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

// Only lifecycle state is adapted. Every node, destination, decoder, sample rate
// and currentTime belongs to the real offline context; nothing reaches a device.
function offlineFacade(context) {
  let state = 'suspended';
  return new Proxy(context, {
    get(target, property) {
      if (property === 'state') return state;
      if (property === 'resume') return async () => { state = 'running'; };
      if (property === 'suspend') return async () => { state = 'suspended'; };
      if (property === 'close') return async () => { state = 'closed'; };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function waitForSamples(controller) {
  const deadline = performance.now() + 30000;
  while (true) {
    const samples = controller.getStatus().resources.samples;
    if (!samples.pending && !samples.inFlight && !samples.queued) {
      if (samples.failed || samples.cached !== samples.entries) {
        throw new Error(`Local catalog did not fully preload: ${samples.cached}/${samples.entries} cached, ${samples.failed} failed.`);
      }
      return samples;
    }
    if (performance.now() > deadline) throw new Error('Local sample loading timed out.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function schedule() {
  const points = new Map();
  for (let frame = STEP_FRAMES; frame < SAMPLE_RATE * DURATION; frame += STEP_FRAMES) points.set(frame, []);
  for (const item of cues) {
    const frame = Math.round(item.at * SAMPLE_RATE / QUANTUM) * QUANTUM;
    if (!points.has(frame)) points.set(frame, []);
    points.get(frame).push(item);
  }
  return [...points].sort(([a], [b]) => a - b).map(([frame, events]) => ({ time: frame / SAMPLE_RATE, events }));
}

function pcmMetrics(buffer, start = 0, end = buffer.duration) {
  const first = Math.max(0, Math.floor(start * buffer.sampleRate));
  const last = Math.min(buffer.length, Math.ceil(end * buffer.sampleRate));
  let peak = 0, squareSum = 0, clippedSamples = 0, nonFiniteSamples = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const values = buffer.getChannelData(channel);
    for (let index = first; index < last; index++) {
      const value = values[index];
      if (!Number.isFinite(value)) { nonFiniteSamples++; continue; }
      const absolute = Math.abs(value);
      peak = Math.max(peak, absolute);
      squareSum += value * value;
      if (absolute >= 1) clippedSamples++;
    }
  }
  const count = (last - first) * buffer.numberOfChannels;
  const rms = Math.sqrt(squareSum / Math.max(1, count - nonFiniteSamples));
  const db = value => value > 0 ? Number((20 * Math.log10(value)).toFixed(2)) : null;
  return { peak: Number(peak.toFixed(6)), peakDbFS: db(peak), rms: Number(rms.toFixed(6)),
    rmsDbFS: db(rms), clippedSamples, nonFiniteSamples };
}

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const bytes = new ArrayBuffer(44 + buffer.length * channels * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < buffer.length; frame++) for (let channel = 0; channel < channels; channel++) {
    const value = Math.max(-1, Math.min(1, data[channel][frame]));
    view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    offset += 2;
  }
  return bytes;
}

function downloadableDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('Could not prepare WAV download.'));
    reader.readAsDataURL(blob);
  });
}

async function renderReview(factory) {
  const context = new OfflineAudioContext(2, SAMPLE_RATE * DURATION, SAMPLE_RATE);
  const controller = factory({
    createContext: () => offlineFacade(context),
    // This controller is exclusively offline. The game's singleton and its
    // immutable automation/silent-mode policy are neither resumed nor changed.
    search: '', webdriver: false, random: seededRandom(), speechAdapter: null,
    sampleLoader: async ({ url, signal }) => {
      const response = await fetch(url, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Cannot read local audio asset: ${response.status}`);
      return response.arrayBuffer();
    },
  });
  try {
    controller.setSampleManifest(catalog.samples);
    controller.setMix({ music: 0, ambience: 0 });
    controller.setVoiceEnabled(true);
    controller.setListener(listener);
    controller.setMuted(false);
    if (!await controller.resume()) throw new Error('Offline audio controller did not initialize.');
    const samples = await waitForSamples(controller);
    status.textContent = 'Rendering the offline graph…';
    showReport({ state: 'rendering', version: selector.value, samples });
    const steps = schedule();
    const suspensions = steps.map(step => context.suspend(step.time));
    // Attach a rejection handler immediately while the graph is being stepped.
    const rendering = context.startRendering().then(buffer => ({ buffer }), error => ({ error }));
    let previousTime = 0, failure = null;
    const renderedCues = [];
    for (let index = 0; index < steps.length; index++) {
      const reached = await Promise.race([suspensions[index].then(() => null), rendering]);
      if (reached) throw reached.error ?? new Error('Offline render ended before its scheduled review events.');
      const now = context.currentTime;
      try {
        if (!failure) {
          controller.tick(now - previousTime, { zone: 'street', threat: 0, listener });
          for (const item of steps[index].events) {
            controller[item.method](item.options);
            // The previous gameplay pickup path also emitted equip separately.
            // Include it in the baseline so the comparison represents the old
            // combined event rather than its chime in isolation.
            if (selector.value === 'before' && item.method === 'pickupChime'
              && item.options.kind === 'weapon' && !['bat', 'knife', 'fists'].includes(item.options.weapon)) {
              controller.weaponMechanical({ ...item.options, action: 'equip' });
            }
            renderedCues.push({ at: Number(now.toFixed(6)), label: item.label });
          }
        }
      } catch (error) { failure ??= error; }
      previousTime = now;
      // Always drain already-booked suspends, including after an event error.
      // Disposing voices while currentTime is still zero would erase the reel.
      await context.resume();
    }
    const result = await rendering;
    if (failure || result.error) throw failure ?? result.error;
    const buffer = result.buffer;
    const metrics = pcmMetrics(buffer);
    if (metrics.nonFiniteSamples) throw new Error('Rendered PCM contains non-finite samples.');
    return { bytes: encodeWav(buffer), report: {
      state: 'ready', version: selector.value, duration: buffer.duration,
      sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
      sampleFormat: 'PCM signed 16-bit little-endian', normalized: false,
      metricsSource: 'Unclamped float PCM before WAV encoding', metrics, samples,
      cues: renderedCues.map((item, index) => ({ ...item,
        metrics: pcmMetrics(buffer, item.at, renderedCues[index + 1]?.at ?? buffer.duration),
      })),
    } };
  } finally {
    await controller.reset();
  }
}

button.addEventListener('click', async () => {
  button.disabled = true;
  selector.disabled = true;
  clearDownload();
  status.textContent = 'Loading local samples into the offline graph…';
  showReport({ state: 'loading-samples', version: selector.value });
  try {
    const result = await renderReview(factories.get(selector.value));
    const blob = new Blob([result.bytes], { type: 'audio/wav' });
    // A data URL keeps the rendered bytes available through the DOM for silent
    // browser review tools; the player uses a revocable URL to avoid copying it.
    download.href = await downloadableDataURL(blob);
    objectURL = URL.createObjectURL(blob);
    download.download = `audio-review-${selector.value}.wav`;
    download.hidden = false;
    player.src = objectURL;
    player.muted = true;
    player.hidden = false;
    showReport(result.report);
    const { clippedSamples, peakDbFS } = result.report.metrics;
    status.textContent = `Ready · ${DURATION} seconds · peak ${peakDbFS} dBFS · ${clippedSamples} clipped samples. Playback remains stopped and muted.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `Review failed: ${message}`;
    showReport({ state: 'error', version: selector.value, message });
  } finally {
    button.disabled = false;
    selector.disabled = false;
  }
});

window.addEventListener('pagehide', clearDownload);
if (typeof OfflineAudioContext !== 'function') {
  status.textContent = 'This browser does not support OfflineAudioContext.';
  showReport({ state: 'unsupported' });
} else {
  button.disabled = false;
  status.textContent = 'Ready to render. No sound has been played.';
  showReport({ state: 'idle', versions: ['current'] });
}

// This optional local comparison is deliberately outside the production build.
const baselinePath = '/artifacts/audio-realism/before/audio.js';
try {
  const baseline = await import(/* @vite-ignore */ baselinePath);
  if (typeof baseline.createAudioController !== 'function') throw new Error('No baseline factory');
  factories.set('before', baseline.createAudioController);
  const option = document.createElement('option');
  option.value = 'before'; option.textContent = 'Before'; selector.append(option);
  document.querySelector('#baseline-status').textContent = 'Local baseline available for the same reel and mix.';
} catch {
  document.querySelector('#baseline-status').textContent = 'No local baseline supplied; the current graph is available.';
}
