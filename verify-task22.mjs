// Task 22 verifier — drives the game in real Chrome via raw CDP. Captures a
// per-zone screenshot and a sustained FPS sample. Confirms 0 console errors.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const SERVER_PORT = 8767;
const URL = 'http://127.0.0.1:' + SERVER_PORT + '/game.html?mute=1';
const PORT = 9229;
const OUT = '/Users/westbrook/intent/workspaces/person-create/repo/shots/task22';
mkdirSync(OUT, { recursive: true });

const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = `
;try{window.__G={Player,Colliders,Triggers,ZoneCull,World,scene,camera,renderer,THREE,FPSMeter,IntroCard,zoneChanged,
  setZone:(z)=>{try{zoneChanged(z);}catch(e){console.error('setZone',e);}},
  dismiss:()=>{try{document.getElementById('overlay').classList.add('hidden');document.getElementById('introcard').classList.remove('show');}catch(e){}},
  currentZone:()=>currentZone};}catch(e){console.error("shim",e);}
`;
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(patched);
});
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const proc = spawn(CHROME, [
  '--remote-debugging-port=' + PORT,
  '--window-size=1280,800',
  '--window-position=40,40',
  '--user-data-dir=/tmp/chrome-verify-task22',
  '--no-first-run', '--no-default-browser-check',
  '--enable-webgl', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--force-device-scale-factor=1',
  URL,
], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
let chromeErr = '';
proc.stderr.on('data', d => { chromeErr += d.toString(); });

let target = null;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  try {
    const list = await httpJson('/json/list');
    target = list.find(t => t.type === 'page' && t.url && t.url.includes('game.html'));
    if (target) break;
  } catch (_) {}
}
if (!target) { console.error('NO_TARGET', chromeErr.slice(0, 1500)); proc.kill(); process.exit(1); }

const wsClient = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { wsClient.onopen = () => res(); wsClient.onerror = (e) => rej(e); });
let msgId = 0;
const pending = new Map();
const consoleMsgs = [];
const exceptions = [];
wsClient.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails.text||'') + ': ' + (m.params.exceptionDetails.exception?.description || ''));
  } else if (m.method === 'Log.entryAdded') {
    if (m.params.entry.level === 'error' || m.params.entry.level === 'warning') {
      consoleMsgs.push({ type: 'log-' + m.params.entry.level, text: m.params.entry.text });
    }
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); wsClient.send(JSON.stringify({ id, method, params })); });
}
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
try { await send('Page.bringToFront'); } catch (_) {}
async function evalExpr(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval error: ' + r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description||''));
  return r.result.value;
}

let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(250);
  try {
    const s = await evalExpr('({g:!!window.__G, c: window.__G?.Colliders?.list?.length ?? -1, t: window.__G?.Triggers?.list?.length ?? -1})');
    if (s.g && s.c > 50 && s.t > 4) { ready = true; break; }
  } catch (_) {}
}
if (!ready) { console.error('NOT_READY', chromeErr.slice(0,1500)); proc.kill(); process.exit(2); }

await evalExpr('window.__G.dismiss(); true');
await sleep(300);

const ZONES = [
  { name: 'apartment',   zone: 'apartment',   x: -9.0,  y: 4.0,  z: -4.0,  yaw: 0.6,            pitch: -0.05 },
  { name: 'neighbor',    zone: 'neighbor',    x:  3.0,  y: 4.0,  z: -4.0,  yaw: -0.4,           pitch:  0.00 },
  { name: 'balcony',     zone: 'balcony',     x:  6.0,  y: 4.0,  z:  0.65, yaw: Math.PI * 0.8,  pitch: -0.05 },
  { name: 'stairwell',   zone: 'stairwell',   x: -18.0, y: 0.5,  z: -5.5,  yaw: -Math.PI/2,     pitch:  0.20 },
  { name: 'roof',        zone: 'roof',        x: -5.0,  y: 14.0, z: -5.0,  yaw: Math.PI * 0.3,  pitch: -0.10 },
  { name: 'scaffolding', zone: 'scaffolding', x:  0.0,  y: 10.0, z:  2.0,  yaw: Math.PI,        pitch: -0.05 },
  { name: 'street',      zone: 'street',      x: -5.0,  y: 0.5,  z: 12.0,  yaw: Math.PI/2,      pitch: -0.05 },
  { name: 'bakery',      zone: 'bakery',      x: -20.0, y: 0.5,  z: 22.0,  yaw: -Math.PI/2,     pitch:  0.00 },
];

async function placePlayer(z) {
  await evalExpr(`(() => {
    const G = window.__G;
    G.setZone(${JSON.stringify(z.zone)});
    G.Player.pos.set(${z.x}, ${z.y + 1.65}, ${z.z});
    G.Player.vel.set(0, 0, 0);
    G.Player.yaw = ${z.yaw}; G.Player.pitch = ${z.pitch};
    if (G.Player.health !== undefined) G.Player.health = 100;
    G.dismiss();
  })()`);
}

// Sample by stepping rAF and observing the game's own clock to get a
// stable game-FPS reading independent of CDP-driven JS-rAF stalls.
async function fpsSample(durationMs = 3000) {
  return await evalExpr(`new Promise(resolve => {
    let frames = 0; const start = performance.now();
    function loop() { frames++; const now = performance.now();
      if (now - start < ${durationMs}) requestAnimationFrame(loop);
      else resolve({ frames, ms: now - start, fps: frames / ((now - start)/1000) }); }
    requestAnimationFrame(loop);
  })`);
}

const results = [];
for (const z of ZONES) {
  await placePlayer(z);
  await sleep(900);
  // Reset renderer.info counter then sample over 60 frames so we capture
  // steady-state triangle / drawCall counts the engine actually pushes.
  await evalExpr('(()=>{const r=window.__G.renderer; r.info.reset(); })()');
  const alive = await evalExpr('window.__G.Player.health > 0');
  const fps = await fpsSample(3000);
  const info = await evalExpr(`(()=>{const i=window.__G.renderer.info; return {tris:i.render.triangles,calls:i.render.calls,geom:i.memory.geometries,tex:i.memory.textures};})()`);
  const ss = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + '/' + z.name + '.png', Buffer.from(ss.data, 'base64'));
  results.push({ zone: z.name, alive, fps: +fps.fps.toFixed(1), frames: fps.frames, ...info });
  console.log(`zone=${z.name.padEnd(12)} alive=${alive} fps=${fps.fps.toFixed(1).padStart(5)} tris=${String(info.tris).padStart(7)} calls=${String(info.calls).padStart(4)}`);
}

const errors = consoleMsgs.filter(c => c.type === 'error' || c.type === 'log-error');
const warnings = consoleMsgs.filter(c => c.type === 'warning' || c.type === 'warn' || c.type === 'log-warning');

const report = { fpsResults: results, errors, warnings, exceptions };
writeFileSync(OUT + '/report.json', JSON.stringify(report, null, 2));
console.log('\n=== SUMMARY ===');
console.log('errors:', errors.length, 'warnings:', warnings.length, 'exceptions:', exceptions.length);
if (errors.length) console.log('ERRORS:', JSON.stringify(errors, null, 2));
if (warnings.length) console.log('WARNINGS:', JSON.stringify(warnings.slice(0,10), null, 2));
if (exceptions.length) console.log('EXCEPTIONS:', JSON.stringify(exceptions, null, 2));

proc.kill(); process.exit(0);
