import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const definitions = [
  ['Street · High 2×', 'street-high2'],
  ['Street · Automatic', 'street-auto'],
  ['Near row · High 2×', 'row-high2'],
  ['Near row · Automatic', 'row-auto'],
  ['Middle bay · front quarter', 'middle-front-high2'],
  ['Middle bay · rear quarter', 'middle-rear-high2'],
  ['Objective sedan · unchanged', 'objective-high2'],
];
const comparisonLimits = [
  'These are paused surface comparisons. All seven pairs show a different lower-left HUD hint, and row/objective views include changed pickup orientation. HUD values, overlays, particles and transient effects are not synchronized; they are not evidence of an asset regression.',
  'Feet and yaw/pitch are rounded by the visible QA report. Row and middle-bay reports also include the explicit camera anchor and look target. Street and objective reports do not include those two vectors.',
  'Separate control/final settings records confirm run setup at FOV 82° with reduced camera motion off. Each individual capture report omits both fields; their continuity across the capture sequence depends on the retained review setup. Exposure and the current selected practical lights are not exported.',
  'The final DOM viewport record directly confirms 1280×720 CSS pixels and a 2560×1440 canvas. Each individual report omits CSS dimensions; drawing buffer divided by ratio consistently implies 1280×720, matching the original capture dimensions.',
  'The recorded bake, directional-shadow projection, reflection configuration and roof-light settings match within each pair. Initialization timings and cumulative update counters differ and are excluded from the lighting comparison.',
  'Original browser capture bytes are preserved. The files retain their .png names but their encoded format is JPEG, so compression limits pixel-level or fine texture judgments.',
  'Automatic images are paused snapshots at the recorded 1.20× device/preset scale. They do not establish resolution adaptation or motion quality during ordinary gameplay.',
  'Screenshot sessions do not supply performance conclusions. The separate timing CSV reports callback cadence and CPU/GPU measurements; callback rate is not presented FPS.',
];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeHTML = text => String(text).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const select = (source, keys) => Object.fromEntries(keys.map(key => [key, source[key]]));

function imageDescription(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'Expected original JPEG or PNG browser capture');
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    assert.equal(bytes[offset++], 0xff, 'JPEG segment marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++], length = bytes.readUInt16BE(offset);
    if (frameMarkers.has(marker)) return { format: 'jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    assert.ok(length >= 2, 'JPEG segment length');
    offset += length;
  }
  throw new Error('No dimensions found in browser capture');
}

function capture(stem) {
  const reportFile = stem + '.txt', imageFile = stem + '.png';
  const text = fs.readFileSync(path.join(directory, reportFile), 'utf8');
  const bytes = fs.readFileSync(path.join(directory, imageFile));
  const line = prefix => {
    const value = text.split('\n').find(entry => entry.startsWith(prefix));
    assert.ok(value, `${reportFile}: missing ${prefix}`);
    return value.slice(prefix.length);
  };
  const jsonLine = prefix => JSON.parse(line(prefix));
  const feet = line('Feet ').split(', ').map(Number);
  const angles = line('Yaw ').match(/^(-?[\d.]+)° · pitch (-?[\d.]+)°$/);
  const quality = line('Quality ').match(/^(\w+) · (\d+) × (\d+) drawing buffer · ratio ([\d.]+)$/);
  assert.ok(angles && quality, `${reportFile}: valid camera/render report`);
  const anchor = text.match(/^Camera anchor (.+) · look target (.+) m\.$/m);
  const reflection = jsonLine('Local reflections: '), shadow = jsonLine('Shadow coverage: ');
  const image = imageDescription(bytes);
  const result = {
    image: imageFile, report: reportFile,
    sha256: { image: sha256(bytes), report: sha256(text) },
    encodedImage: image,
    camera: {
      reportedFeet: feet, reportedYawDegrees: Number(angles[1]), reportedPitchDegrees: Number(angles[2]),
      anchor: anchor ? anchor[1].split(', ').map(Number) : null,
      lookTarget: anchor ? anchor[2].split(', ').map(Number) : null,
      fovDegrees: null,
    },
    rendering: {
      quality: quality[1], drawingBuffer: { width: Number(quality[2]), height: Number(quality[3]) },
      pixelRatio: Number(quality[4]), reviewScale: line('Review scale: '),
      inferredCssViewport: { width: Number(quality[2]) / Number(quality[4]), height: Number(quality[3]) / Number(quality[4]) },
      device: line('Graphics device: '), surfaceDelivery: jsonLine('Surface delivery: '),
    },
    recordedLighting: {
      interiorBake: line('Interior bake '), directionalShadows: line('Directional shadows: '),
      shadowConfiguration: select(shadow, ['enabled', 'mode', 'reason', 'shadowsEnabled', 'fraction', 'areaFraction',
        'linearResolutionGain', 'mapSize', 'region', 'texelSize', 'referenceTexelSize', 'receiverBounds', 'receiverFloor', 'coverageMargin', 'casterBounds']),
      reflections: { ...select(reflection, ['status', 'enabled', 'captures', 'faces', 'faceSize', 'residentBytes', 'shadowSize',
        'staticPracticalSources', 'lightBudget', 'receivers', 'materialVariants', 'perFrameCaptures', 'addedDrawCalls']),
      probes: reflection.probes.map(probe => select(probe, ['id', 'receivers', 'width', 'height', 'bytes'])) },
      roofTaskLighting: jsonLine('Roof task lighting: '),
    },
    simulationPaused: text.includes('simulation paused'),
    audioLockedOff: text.includes('Audio locked off · no AudioContext'),
    designPreview: text.match(/^DESIGN PREVIEW · (.+)$/m)?.[1] || null,
  };
  assert.deepEqual(result.rendering.inferredCssViewport, { width: 1280, height: 720 }, `${reportFile}: expected inferred viewport`);
  assert.deepEqual({ width: image.width, height: image.height }, { width: 1280, height: 720 }, `${imageFile}: original capture size`);
  assert.ok(result.simulationPaused && result.audioLockedOff, `${reportFile}: paused and silent capture`);
  return result;
}

function verifyMatch(first, second) {
  for (const field of ['camera', 'rendering', 'recordedLighting']) {
    assert.deepEqual(first[field], second[field], `${first.report} vs ${second.report}: ${field} must match`);
  }
  return { recordedCameraMatches: true, renderSettingsMatch: true, recordedLightingMatches: true,
    imageDimensionsMatch: true, independentlyRecordedFov: false, directlyRecordedCssViewport: false };
}

const runSettings = ['control-visible-settings.txt', 'final-visible-settings.txt'].map(report => {
  const text = fs.readFileSync(path.join(directory, report), 'utf8');
  const fovDegrees = Number(text.match(/slider "Field of view": "([\d.]+)"/)?.[1]);
  const reducedMotionLine = text.split('\n').find(line => line.includes('checkbox "Reduced camera motion"'));
  assert.ok(reducedMotionLine, `${report}: visible reduced-motion state`);
  const reducedMotion = reducedMotionLine.includes('[checked]');
  assert.equal(fovDegrees, 82, `${report}: review FOV`);
  assert.equal(reducedMotion, false, `${report}: review reduced motion`);
  return { report, sha256: sha256(text), fovDegrees, reducedMotion };
});
const viewportText = fs.readFileSync(path.join(directory, 'final-viewport.json'), 'utf8');
const viewport = JSON.parse(viewportText);
assert.equal(viewport.cssWidth, 1280); assert.equal(viewport.cssHeight, 720);
assert.ok(viewport.canvases.some(canvas => canvas.width === 2560 && canvas.height === 1440));
const runSetup = { settings: runSettings, viewport: { report: 'final-viewport.json', sha256: sha256(viewportText), ...viewport },
  scope: 'Run-level control/final records; individual capture reports do not export FOV, reduced motion or CSS viewport.' };

const pairs = definitions.map(([label, stem]) => {
  const before = capture('before-' + stem), after = capture('after-' + stem);
  const match = verifyMatch(before, after);
  assert.equal(after.rendering.quality, stem.endsWith('-auto') ? 'auto' : 'high');
  assert.equal(after.rendering.pixelRatio, stem.endsWith('-auto') ? 1.2 : 2);
  return { label, stem, before, after, match };
});
const designs = ['front', 'rear'].map(view => {
  const panel = capture(`after-middle-${view}-high2`), passenger = capture(`after-passenger-${view}-high2`);
  assert.ok(passenger.designPreview?.startsWith('passenger-van'), 'Passenger design must disclose its paused render-only preview');
  return { label: view === 'front' ? 'Front quarter' : 'Rear quarter', panel, passenger, match: verifyMatch(panel, passenger),
    note: 'Design comparison, not before/after. Panel is installed; passenger is a paused render-only factory option at the same parking transform. Its preview retains authored panel-van collision and does not demonstrate passenger gameplay integration.' };
});
const evidence = {
  schemaVersion: 1,
  title: 'One Last Kill · civilian van art review',
  scope: 'Fresh baseline after the civilian car pass. Only the middle sedan becomes the panel van; four parking centres and headings stay fixed. The objective sedan is unchanged.',
  middleParkingTransform: { position: [-12.7, 0.05, 9.5], yawRadians: Math.PI },
  runSetup,
  comparisonLimits,
  pairs, designs,
};
fs.writeFileSync(path.join(directory, 'matched-pairs.json'), JSON.stringify(evidence, null, 2) + '\n');

const style = `body{margin:0;background:#171c1e;color:#e8e3d5;font:16px/1.5 system-ui}main{max-width:1280px;margin:auto;padding:24px}h1{font-size:26px;margin:0}h2{font-size:23px;margin:0}p{color:#b8bebd;max-width:1040px}nav,.links{display:flex;gap:12px 22px;flex-wrap:wrap;margin:20px 0}select,button{font:inherit;color:inherit;background:#293132;border:1px solid #6a746d;padding:8px 12px;border-radius:3px}button:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid #e6c993;outline-offset:3px}figure{margin:0}#comparison{position:relative;aspect-ratio:16/9;overflow:hidden;background:#000}figure img{width:100%;height:100%;object-fit:contain;display:block}#after{position:absolute;inset:0;clip-path:inset(0 0 0 var(--split,50%))}.tag{position:absolute;top:14px;background:#101719ed;padding:4px 12px;font-size:12px;letter-spacing:2px}.old{left:14px}.new{right:14px}#divider{position:absolute;left:var(--split,50%);top:0;bottom:0;border-left:2px solid #e6c993;pointer-events:none}label{display:block;margin-top:16px}input{width:100%;accent-color:#e6c993}a{color:#e6c993}.help,.setup{font-size:13px}.setup{padding:12px 16px;background:#202829;border-left:2px solid #788b7e;margin:12px 0;color:#c5cfcb}details{margin-top:20px;border:1px solid #394446;padding:12px 16px}summary{cursor:pointer}li{margin:9px 0;color:#b8bebd}.designs{border-top:1px solid #56635e;margin-top:42px;padding-top:30px}.design-row{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:22px}.design-row img{aspect-ratio:16/9;background:#000}.design-row figcaption{margin-top:10px}.design-row h3{font-size:17px;margin:0 0 5px}.design-row p{font-size:13px;margin:4px 0}.design-row .links{font-size:13px;margin:8px 0}footer{margin-top:30px}.badge{color:#e6c993}@media(max-width:680px){main{padding:16px}.design-row{grid-template-columns:1fr}nav select{width:100%}.tag{font-size:10px;letter-spacing:1px;top:8px}.old{left:8px}.new{right:8px}}`;
// Design images occupy only their own 16:9 box. Captions contribute natural
// card height instead of inheriting the slider's full-height image treatment.
const designStyle = `.design-row{align-items:start;margin-top:32px;row-gap:32px}.design-row figure{min-width:0;height:auto;aspect-ratio:auto;overflow:visible}.design-row figure>a{display:block;aspect-ratio:16/9}.design-row img{width:100%;height:auto;aspect-ratio:16/9;object-fit:contain}.design-row figcaption{margin-top:12px}`;
const designHTML = designs.map(design => `<div class="design-row">${[
  ['Panel van · installed', design.panel, 'Opaque cargo body; the middle parking space used in gameplay.'],
  ['Passenger van · design option', design.passenger, 'Glazed passenger body; paused render-only preview, with authored collision retained.'],
].map(([label, capture, note]) => `<figure><a href="${capture.image}"><img src="${capture.image}" alt="${escapeHTML(label + ', ' + design.label.toLowerCase())}" loading="lazy" width="1280" height="720"></a><figcaption><h3>${escapeHTML(label)}</h3><p>${escapeHTML(design.label)} · High, explicit 2×</p><p>${escapeHTML(note)}</p><div class="links"><a href="${capture.image}">Original capture</a><a href="${capture.report}">Capture report</a></div></figcaption></figure>`).join('')}</div>`).join('');

fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>One Last Kill · civilian van review</title><style>${style}${designStyle}</style></head><body>
<main><h1>One Last Kill · civilian van art pass</h1>
<p>Seven matched views compare the current civilian-car baseline with the installed panel van. Only the middle sedan changes; all four parking centres and headings stay fixed. The objective sedan remains unchanged.</p>
<p class="help">Run setup: 1280 × 720 CSS pixels, FOV 82°, reduced camera motion off. High uses an explicit 2× drawing buffer; Automatic records its normal 1.20× device/preset scale here. The visible reports match camera and recorded lighting settings. <a href="#limits">Comparison limits</a> · <a href="#designs">Panel and passenger designs</a></p>
<nav aria-label="Matched views"><select id="view" aria-label="Matched view">${definitions.map(([label], index) => `<option value="${index}">${escapeHTML(label)}</option>`).join('')}</select><button id="previous" type="button">Previous view</button><button id="next" type="button">Next view</button></nav>
<figure id="comparison"><img id="before" src="${pairs[0].before.image}" alt="Street before the van pass"><img id="after" src="${pairs[0].after.image}" alt="Street after the van pass"><div id="divider"></div><span class="tag old">BEFORE</span><span class="tag new">AFTER</span></figure>
<label for="split">Before / after divider</label><input id="split" type="range" min="0" max="100" value="50" aria-label="Before after divider">
<p id="setup" class="setup" aria-live="polite"></p>
<div class="links"><a id="beforeLink" href="${pairs[0].before.image}">Before capture</a><a id="afterLink" href="${pairs[0].after.image}">After capture</a><a id="beforeReport" href="${pairs[0].before.report}">Before report</a><a id="afterReport" href="${pairs[0].after.report}">After report</a><a href="matched-pairs.json">Verified capture metadata</a><a href="final-performance.csv">Separate timing CSV</a></div>
<details id="limits"><summary>What these comparisons establish, and their limits</summary><ul>${comparisonLimits.map(limit => `<li>${escapeHTML(limit)}</li>`).join('')}</ul><div class="links"><a href="control-visible-settings.txt">Control settings</a><a href="final-visible-settings.txt">Final settings</a><a href="final-viewport.json">Final DOM viewport</a></div></details>
<section class="designs" id="designs" aria-labelledby="design-title"><h2 id="design-title">Panel and passenger design options</h2><p><span class="badge">Design comparison · not before/after.</span> These are final front and rear views at the same camera and parking transform. The panel van is installed in the district; the passenger van is available through the factory and paused QA preview. It is not a second parked van in the playable street.</p>${designHTML}</section>
<footer><p class="help">Use the divider’s arrow keys to compare surfaces. Open an original capture to inspect it at full size. Walking, collision/projectile validation and timing are separate evidence; paused frames do not establish motion quality or frame rate.</p></footer></main>
<script>
const pairs=${JSON.stringify(pairs.map(pair => ({ label: pair.label, before: pair.before.image, after: pair.after.image,
  beforeReport: pair.before.report, afterReport: pair.after.report, camera: pair.after.camera, rendering: pair.after.rendering,
  shadow: pair.after.recordedLighting.directionalShadows })))};
const selector=document.getElementById('view');
function show(){const pair=pairs[Number(selector.value)];for(const phase of ['before','after']){document.getElementById(phase).src=pair[phase];document.getElementById(phase).alt=pair.label+' · '+phase+' van pass';document.getElementById(phase+'Link').href=pair[phase];document.getElementById(phase+'Report').href=pair[phase+'Report'];}const r=pair.rendering,c=pair.camera;const camera=c.anchor?'Camera '+c.anchor.join(', ')+' → '+c.lookTarget.join(', '):'Reported feet '+c.reportedFeet.join(', ');document.getElementById('setup').textContent='Matched report fields · '+camera+' m · yaw '+c.reportedYawDegrees+'°, pitch '+c.reportedPitchDegrees+'° · '+r.quality+' · '+r.drawingBuffer.width+' × '+r.drawingBuffer.height+' buffer · '+r.pixelRatio.toFixed(2)+'×. FOV 82° is confirmed in separate run settings.';}
selector.addEventListener('change',show);for(const [id,step]of [['previous',-1],['next',1]])document.getElementById(id).addEventListener('click',()=>{selector.value=(Number(selector.value)+step+pairs.length)%pairs.length;show();});document.getElementById('split').addEventListener('input',event=>document.getElementById('comparison').style.setProperty('--split',event.target.value+'%'));show();
</script></body></html>\n`);
console.log(`Verified ${pairs.length} before/after pairs and ${designs.length} design comparisons; wrote index.html and matched-pairs.json.`);
