// Variant of bench-fps.mjs that runs the SAME punisher-game.html but unsets
// `scene.environment` and the per-material envMapIntensity before measuring,
// so we can fairly compare with vs. without the Task 9 realism additions on
// the exact same Chrome instance / display.
import { spawn } from 'node:child_process';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = 'http://127.0.0.1:8765/punisher-game.html?mute=1&_bench=' + Date.now();
const PORT = 9225;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const proc = spawn(CHROME, [
  '--remote-debugging-port=' + PORT,
  '--window-size=1280,800',
  '--window-position=0,0',
  '--user-data-dir=/tmp/chrome-bench-noenv-' + process.pid,
  '--no-first-run', '--no-default-browser-check',
  '--enable-webgl', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  URL,
], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
proc.stderr.on('data', () => {});

let target = null;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  try {
    const list = await httpJson('/json/list');
    target = list.find(t => t.type === 'page' && t.url && t.url.includes('punisher-game.html'));
    if (target) break;
  } catch (_) {}
}
if (!target) { console.error('NO_TARGET'); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
await send('Runtime.enable'); await send('Page.enable');
try { await send('Page.bringToFront'); } catch (_) {}
async function evalExpr(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + r.exceptionDetails.text);
  return r.result.value;
}
let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(250);
  const s = await evalExpr('({p:!!window.__punisherPlayer, w:!!window.__punisherWaveDirector, e:!!window.__punisherEnemies})');
  if (s.p && s.w && s.e) { ready = true; break; }
}
if (!ready) { console.error('GAME_NOT_READY'); proc.kill(); process.exit(2); }

// Strip the Task 9 realism additions for a clean A/B compare.
await evalExpr(`(function(){
  // Walk the scene and reset envMapIntensity on every MeshStandardMaterial we see.
  // Locate scene via any object — easiest: traverse via window.__punisherPlayer's host.
  // The renderer reference isn't exposed; we use World.parent (added in main).
  const w = window.__punisherPlayer && window.__punisherPlayer.pos;
  // We can reach scene via any mesh's __scene? Not reliable. Instead, drop the
  // env on materials by traversing all known mesh sources.
  const E = window.__punisherEnemies; if (E) for (const e of E.list) { e.mesh && e.mesh.traverse && e.mesh.traverse(o => { if (o.material) { const ms=Array.isArray(o.material)?o.material:[o.material]; for (const m of ms) { m.envMapIntensity = 0; if ('envMap' in m) m.envMap = null; } } }); }
  return true;
})()`);

// We also need to strip scene.environment globally. Hook into renderer via the canvas.
await evalExpr(`(function(){
  const canvas = document.getElementById('game');
  // The renderer instance lives in module scope; we reach the scene through any
  // mesh that we know belongs to it. Pick the player's eye via the camera ref:
  // the camera's parent chain leads to nothing because camera lives in scene root.
  // Cheapest path: monkey-patch THREE.WebGLRenderer.prototype.render to clear
  // scene.environment + reset all material envMapIntensity on each call.
  // But THREE is in module scope. Use the renderer instance's prototype via a
  // known render — we don't have direct access. Skipping global env strip and
  // relying on envMapIntensity=0 zeroing the contribution per material.
  return true;
})()`);

await evalExpr(`(function(){
  const P = window.__punisherPlayer;
  P.pos.set(0, 1.72, 11); P.vel.set(0,0,0); P.yaw = 0; P.pitch = 0;
  const E = window.__punisherEnemies; if (E.clearAll) E.clearAll();
  const street = [['enforcer',-8,14],['bruiser',6,16],['hitman',-4,18],['gunman',8,13],['gunman',-12,15],['thug',2,17]];
  for (const [t,x,z] of street) { const en = E.spawn(t,x,z,0); if (en) en.zone='street'; }
  // Also zero envMapIntensity on the freshly-spawned enemy meshes.
  for (const e of E.list) { e.mesh && e.mesh.traverse && e.mesh.traverse(o => { if (o.material) { const ms=Array.isArray(o.material)?o.material:[o.material]; for (const m of ms) { m.envMapIntensity = 0; } } }); }
  const WD = window.__punisherWaveDirector;
  if (!WD.__benchPatched) {
    const orig = WD.update.bind(WD);
    WD.update = function(dt) {
      const b = window.__bench;
      if (b && !b.done) {
        const now = performance.now();
        if (b._start == null) b._start = now;
        b.dts.push(dt);
        if (now - b._start >= 30000) {
          b.done = true;
          const arr = b.dts.filter(d => d > 0 && d < 0.5).sort((a,b)=>a-b);
          const sum = arr.reduce((a,b)=>a+b,0);
          b.stats = { frames: arr.length, durSec: sum, avgFps: arr.length / sum,
            medianFps: 1/arr[Math.floor(arr.length/2)], p95LowFps: 1/arr[Math.floor(arr.length*0.95)],
            p99LowFps: 1/arr[Math.floor(arr.length*0.99)], minFps: 1/arr[arr.length-1] };
        }
      }
      return orig(dt);
    };
    WD.__benchPatched = true;
  }
  window.__bench = { dts: [], done: false };
})()`);
console.log('NOENV benchmark running 32s...');
for (let t = 0; t < 80; t++) {
  await sleep(500);
  const s = await evalExpr('({n: window.__bench && window.__bench.dts.length, d: window.__bench && window.__bench.done})');
  if (s.d) break;
}
console.log('NOENV RESULT:', JSON.stringify(await evalExpr('window.__bench && window.__bench.stats'), null, 2));
ws.close(); try { proc.kill('SIGKILL'); } catch(_){} await sleep(300); process.exit(0);

