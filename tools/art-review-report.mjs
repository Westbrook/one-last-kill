#!/usr/bin/env node
/**
 * Summarize the visible QA benchmark reports without inferring presentation FPS.
 *
 *   node tools/art-review-report.mjs
 *   node tools/art-review-report.mjs artifacts/cohesive-art-2026-08-31 --prefix final-performance
 *
 * Only complete BENCHMARK MEASURED reports are included. Live/visual/capture
 * reports are excluded even if they contain timing text. Missing statistics stay null: the
 * current report does not supply GPU p99/max or CPU p99. Historical evidence is
 * never read unless its directory is explicitly supplied by the caller.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIRECTORY = join(ROOT, 'artifacts/cohesive-art-2026-08-31');
const NUMBER = '[\\d.]+';
const LIMITATIONS = [
  'rAF interval statistics and callback cadence do not measure presented FPS or input latency.',
  'CPU sections cover the named QA work; they exclude browser paint/composition, separate callbacks and time between callbacks.',
  'GPU elapsed queries are asynchronous, may cover only the retained sample window, and exclude browser/CSS composition.',
  'Missing p99, maximum or tail statistics remain null; they cannot be recovered from a median and p95.',
  'Each controlled run holds its initial render ratio. This does not validate adaptive resolution over an ordinary playthrough.',
  'Controlled combat restores health and replaces enemies. Similar aggregate outcomes do not guarantee identical per-frame work.',
  'Renderer counts and optional JS heap values are endpoints, not complete GPU residency or proof of leak freedom.',
  'Texture byte figures are reported asset/payload estimates. Startup times include the local cache/network state.',
  'Per-run percentiles are retained separately. A range of per-run percentiles is not a pooled percentile.',
  'Files named live, visual, capture or screenshot (separate filename terms) and reports marked VISUAL-ONLY are excluded. Other capture/timing separation remains the reviewer\'s responsibility.',
  'Callback rate is an approximation calculated from the report\'s rounded measured duration.',
];

function visualEvidence(source, file) {
  return /(?:^|[-_])(?:live|visual|capture|screenshot)(?:[-_.]|$)/i.test(file)
    || /VISUAL[-_ ]ONLY/i.test(file) || /VISUAL[-_ ]ONLY/i.test(source);
}

function numericMatch(source, expression, required = false) {
  const found = source.match(expression);
  if (!found && required) throw new Error(`Missing required report field: ${expression}`);
  return found ? found.slice(1).map(value => value === undefined ? null : Number(value)) : null;
}

function jsonLine(source, label) {
  const line = source.split('\n').find(value => value.startsWith(`${label}: `));
  return line ? JSON.parse(line.slice(label.length + 2)) : null;
}

function timingLine(source, label) {
  const line = source.split('\n').find(value => value.startsWith(`${label}: `));
  const value = name => line ? numericMatch(line, new RegExp(`${name} (${NUMBER}) ms`))?.[0] ?? null : null;
  return { medianMs: value('median'), p95Ms: value('p95'), p99Ms: value('p99'),
    maximumMs: value('maximum'), averageMs: value('average') };
}

function endpointDelta(endpoints) {
  if (!endpoints?.before || !endpoints?.after
    || typeof endpoints.before !== 'object' || typeof endpoints.after !== 'object') return null;
  const keys = new Set([...Object.keys(endpoints.before), ...Object.keys(endpoints.after)]);
  return Object.fromEntries([...keys].map(key => [key,
    Number.isFinite(endpoints.before[key]) && Number.isFinite(endpoints.after[key])
      ? endpoints.after[key] - endpoints.before[key] : null]));
}

function phaseFromFile(file) {
  if (/^(?:before|baseline)[-_]/i.test(file)) return 'baseline';
  if (/^control[-_]/i.test(file)) return 'control';
  if (/^(?:after|final)[-_]/i.test(file)) return 'final';
  return 'candidate';
}

export function parseBenchmark(source, file = 'benchmark.txt') {
  if (visualEvidence(source, file)) return null;
  const heading = source.match(/^(.+ BENCHMARK MEASURED) · (.+)$/m);
  if (!heading) return null;
  const [intervals, seconds] = numericMatch(source, /(\d+) real rAF intervals · ([\d.]+) s measured/, true);
  const [maximumMs, sectionMaximumMs] = numericMatch(source,
    /Maximum rAF interval: ([\d.]+) ms · maximum sampled CPU section: ([\d.]+) ms/, true);
  const [over16_9, total, over33_5, over50] = numericMatch(source,
    /Frames over budget: (\d+)\/(\d+) over 16.9 ms · (\d+) over 33.5 ms · (\d+) over 50 ms/, true);
  if (intervals !== total || !intervals || seconds <= 0) throw new Error('Inconsistent or empty rAF measurement');
  const [width, height, ratio] = numericMatch(source,
    /Viewport: (\d+) × (\d+) CSS px · render ratio ([\d.]+)/, true);
  const [drawCalls, triangles] = numericMatch(source, /Renderer: (\d+) calls\/frame · (\d+) triangles\/frame/, true);
  const raf = { ...timingLine(source, 'Frame time'), maximumMs, intervals, seconds,
    callbackRateHz: Number((intervals / seconds).toFixed(1)), over16_9, over33_5, over50 };
  if (![raf.medianMs, raf.p95Ms, raf.p99Ms, raf.averageMs].every(Number.isFinite)) {
    throw new Error('Incomplete rAF timing statistics');
  }
  const sectionLabel = source.includes('Fixture + simulation + render CPU:')
    ? 'Fixture + simulation + render CPU' : 'Render CPU';
  const section = { ...timingLine(source, sectionLabel), maximumMs: sectionMaximumMs };
  const callback = { ...timingLine(source, 'Full sampled QA callback CPU'),
    samples: numericMatch(source, /Full sampled QA callback CPU: [^\n]+ · (\d+) samples/)?.[0] ?? null };
  const gpuCounts = numericMatch(source, /GPU elapsed: [^\n]+ · (\d+) completed samples(?: \((\d+) total\))?/);
  const queryCounts = numericMatch(source,
    /GPU queries: (\d+) pending · (\d+) skipped frames · (\d+) disjoint events · (\d+) discarded results/);
  const gpu = { ...timingLine(source, 'GPU elapsed'), samples: gpuCounts?.[0] ?? null,
    totalSamples: gpuCounts?.[1] ?? null, pending: queryCounts?.[0] ?? null, skipped: queryCounts?.[1] ?? null,
    disjoint: queryCounts?.[2] ?? null, discarded: queryCounts?.[3] ?? null,
    status: gpuCounts ? 'available' : source.match(/GPU elapsed unavailable \(([^)]+)\)/)?.[1] ?? 'not-reported' };
  const presentations = [...source.matchAll(/Presentation \((\d+) frames\): quality (\w+) · AO (ON|OFF) \(([^)]+)\) · (\d+) world \+ (\d+) post passes/g)]
    .map(match => ({ frames: Number(match[1]), quality: match[2], ao: match[3] === 'ON', reason: match[4],
      worldPasses: Number(match[5]), postPasses: Number(match[6]) }));
  const buffers = [...source.matchAll(/Drawing buffer: (\d+) × (\d+) px · ratio ([\d.]+)/g)]
    .map(match => ({ width: Number(match[1]), height: Number(match[2]), ratio: Number(match[3]) }));
  const sampleProfiles = [...source.matchAll(/Samples: AO (\d+) · denoise (\d+) · target MSAA (\d+)/g)]
    .map(match => ({ ao: Number(match[1]), denoise: Number(match[2]), msaa: Number(match[3]) }));
  const endpoints = jsonLine(source, 'Renderer resource counts');
  const heapEndpoints = jsonLine(source, 'Optional JS heap bytes (performance.memory)');
  const longTasks = numericMatch(source, /Main-thread long tasks: (\d+) · ([\d.]+) ms total during measurement/);
  const startup = numericMatch(source,
    /Graphics startup: ([\d.]+) ms to ready · ([\d.]+) ms maps · ([\d.]+) ms world build/);
  const simulated = numericMatch(source, /([\d.]+) s simulated · (\d+) actual (?:bat swings|shots) · (\d+) hits · (\d+) kills/);
  const contacts = numericMatch(source, /(\d+)–(\d+) live contacts · (\d+) replacement spawns · up to (\d+) NPCs attacking/);
  const surfaceDelivery = jsonLine(source, 'Surface delivery');
  const face = jsonLine(source, 'Facial albedo');
  const reflections = jsonLine(source, 'Local reflections');
  return {
    file, phase: phaseFromFile(file), heading: heading[1], zone: heading[2],
    sha256: createHash('sha256').update(source).digest('hex'),
    device: source.match(/^Graphics device: (.+)$/m)?.[1] ?? null,
    viewport: { width, height, ratio }, presentations, buffers, sampleProfiles,
    reviewScale: source.match(/^Review scale: (.+)$/m)?.[1] ?? null,
    ratioHeld: source.includes('Render ratio held at the start value'),
    raf, cpu: { sectionLabel, section, callback, simulation: timingLine(source, 'Simulation CPU'), render: timingLine(source, 'Render CPU') },
    gpu, renderer: { drawCalls, triangles, endpoints, delta: endpointDelta(endpoints) },
    heap: { endpoints: heapEndpoints, delta: endpointDelta(heapEndpoints) },
    longTasks: { count: longTasks?.[0] ?? null, totalMs: longTasks?.[1] ?? null },
    startup: { readyMs: startup?.[0] ?? null, mapsMs: startup?.[1] ?? null, worldBuildMs: startup?.[2] ?? null },
    assetEstimates: {
      surfaceDelivery,
      faceBytes: face?.memoryBytes ?? null,
      reflectionBytes: reflections?.residentBytes ?? null,
    },
    fixture: simulated ? { simulatedSeconds: simulated[0], actions: simulated[1], hits: simulated[2], kills: simulated[3],
      minimumContacts: contacts?.[0] ?? null, maximumContacts: contacts?.[1] ?? null,
      respawns: contacts?.[2] ?? null, maximumAttackers: contacts?.[3] ?? null } : null,
    lateIntervals: jsonLine(source, 'Late interval samples (first 32)'),
  };
}

function range(values) {
  const available = values.filter(Number.isFinite);
  return available.length ? [Math.min(...available), Math.max(...available)] : null;
}

function phaseSummary(runs) {
  const knownLongTasks = runs.every(run => run.longTasks.count !== null);
  return { runs: runs.length, intervals: runs.reduce((sum, run) => sum + run.raf.intervals, 0),
    over16_9: runs.reduce((sum, run) => sum + run.raf.over16_9, 0),
    over33_5: runs.reduce((sum, run) => sum + run.raf.over33_5, 0),
    over50: runs.reduce((sum, run) => sum + run.raf.over50, 0),
    longTasks: knownLongTasks ? runs.reduce((sum, run) => sum + run.longTasks.count, 0) : null,
    rafP95RangeMs: range(runs.map(run => run.raf.p95Ms)), rafP99RangeMs: range(runs.map(run => run.raf.p99Ms)),
    rafMaximumRangeMs: range(runs.map(run => run.raf.maximumMs)),
    callbackP95RangeMs: range(runs.map(run => run.cpu.callback.p95Ms)), gpuP95RangeMs: range(runs.map(run => run.gpu.p95Ms)) };
}

function csvRow(run) {
  return {
    file: run.file, phase: run.phase, workload: `${run.heading} · ${run.zone}`,
    quality: [...new Set(run.presentations.map(profile => profile.quality))].join('|'),
    cssWidth: run.viewport.width, cssHeight: run.viewport.height, ratio: run.viewport.ratio,
    intervals: run.raf.intervals, seconds: run.raf.seconds, callbackRateHz: run.raf.callbackRateHz,
    rafMedianMs: run.raf.medianMs, rafP95Ms: run.raf.p95Ms, rafP99Ms: run.raf.p99Ms, rafMaximumMs: run.raf.maximumMs,
    over16_9: run.raf.over16_9, over33_5: run.raf.over33_5, over50: run.raf.over50,
    cpuSectionP95Ms: run.cpu.section.p95Ms, cpuSectionP99Ms: run.cpu.section.p99Ms, cpuSectionMaximumMs: run.cpu.section.maximumMs,
    cpuCallbackP95Ms: run.cpu.callback.p95Ms, cpuCallbackP99Ms: run.cpu.callback.p99Ms, cpuCallbackMaximumMs: run.cpu.callback.maximumMs,
    cpuSimulationP95Ms: run.cpu.simulation.p95Ms, cpuRenderP95Ms: run.cpu.render.p95Ms,
    gpuMedianMs: run.gpu.medianMs, gpuP95Ms: run.gpu.p95Ms, gpuP99Ms: run.gpu.p99Ms, gpuMaximumMs: run.gpu.maximumMs,
    gpuSamples: run.gpu.samples, gpuSkipped: run.gpu.skipped, gpuDisjoint: run.gpu.disjoint, gpuDiscarded: run.gpu.discarded,
    drawCalls: run.renderer.drawCalls, triangles: run.renderer.triangles,
    geometryDelta: run.renderer.delta?.geometries, textureDelta: run.renderer.delta?.textures,
    retainedProgramDelta: run.renderer.delta?.retainedPrograms,
    longTasks: run.longTasks.count, readyMs: run.startup.readyMs, mapsMs: run.startup.mapsMs, worldBuildMs: run.startup.worldBuildMs,
    device: run.device,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function createArtReviewReport(directory = DEFAULT_DIRECTORY, prefix = 'performance') {
  const resolvedDirectory = resolve(directory);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(prefix)) throw new Error('Output prefix must be a plain filename stem');
  const files = (await readdir(resolvedDirectory)).filter(file => file.endsWith('.txt')).sort();
  const runs = [], excludedVisual = [], rejected = [];
  for (const file of files) {
    const source = await readFile(join(resolvedDirectory, file), 'utf8');
    if (visualEvidence(source, file)) {
      excludedVisual.push(file);
      continue;
    }
    try {
      const run = parseBenchmark(source, file);
      if (run) runs.push(run);
      else if (/BENCHMARK.*(?:FAILED|INTERRUPTED)|BENCHMARK SETUP FAILED/i.test(source)) {
        rejected.push({ file, reason: 'Failed or interrupted report; no result inferred' });
      }
    } catch (error) { rejected.push({ file, reason: error.message }); }
  }
  if (!runs.length) throw new Error(`No complete measured benchmarks in ${resolvedDirectory}`);
  const phases = Object.fromEntries(['baseline', 'candidate', 'final', 'control'].map(phase =>
    [phase, phaseSummary(runs.filter(run => run.phase === phase))]));
  const result = { schemaVersion: 1, directory: resolvedDirectory, generatedAt: new Date().toISOString(),
    phases, runs, excludedVisual, rejected, limitations: LIMITATIONS };
  const rows = runs.map(csvRow), columns = Object.keys(rows[0]);
  const csv = [columns.join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\n') + '\n';
  await writeFile(join(resolvedDirectory, `${prefix}-summary.json`), JSON.stringify(result, null, 2) + '\n');
  await writeFile(join(resolvedDirectory, `${prefix}.csv`), csv);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let directory = DEFAULT_DIRECTORY, prefix = 'performance';
  if (args[0] && !args[0].startsWith('--')) directory = resolve(args.shift());
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--prefix') throw new Error('Expected [directory] [--prefix filename-stem]');
    prefix = args[1];
  }
  const report = await createArtReviewReport(directory, prefix);
  console.log(JSON.stringify({ phases: report.phases, excludedVisual: report.excludedVisual.length,
    rejected: report.rejected, outputs: [`${prefix}-summary.json`, `${prefix}.csv`] }, null, 2));
}
