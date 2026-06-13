// Task 9 — Real-Chrome CDP FPS benchmark for punisher-game.html.
// Spawns a heavy street combat scene and samples frame intervals from inside
// the renderer for ~32s. Use as: `node bench-fps.mjs` (server on :8765 must be up).
import { spawn } from 'node:child_process';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
// Extra URL query args (e.g. `noenv=1`) may be passed as CLI args.
const EXTRA = process.argv.slice(2).filter(a => a && !a.startsWith('--')).join('&');
const URL = 'http://127.0.0.1:8765/punisher-game.html?mute=1&_bench=' + Date.now() + (EXTRA ? '&' + EXTRA : '');
const PORT = 9224 + (EXTRA ? 1 : 0);
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
  '--user-data-dir=/tmp/chrome-bench-fps-' + process.pid,
  '--no-first-run', '--no-default-browser-check',
  '--enable-webgl', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  URL,
], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
let chromeErr = '';
proc.stderr.on('data', d => { chromeErr += d.toString(); });

let target = null;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  try {
    const list = await httpJson('/json/list');
    target = list.find(t => t.type === 'page' && t.url && t.url.includes('punisher-game.html'));
    if (target) break;
  } catch (_) {}
}
if (!target) { console.error('NO_TARGET', chromeErr.slice(0, 1500)); proc.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
let msgId = 0; const pending = new Map();
const consoleMsgs = []; const exceptions = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails.text||'') + ': ' + (m.params.exceptionDetails.exception?.description || ''));
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
  if (r.exceptionDetails) throw new Error('eval error: ' + r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description||''));
  return r.result.value;
}

let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(250);
  try {
    const s = await evalExpr('({p:!!window.__punisherPlayer, w:!!window.__punisherWaveDirector, e:!!window.__punisherEnemies})');
    if (s.p && s.w && s.e) { ready = true; break; }
  } catch (_) {}
}
if (!ready) { console.error('GAME_NOT_READY', JSON.stringify({consoleMsgs: consoleMsgs.slice(-10), exceptions}, null, 2)); proc.kill(); process.exit(2); }

await evalExpr(`(function(){
  const P = window.__punisherPlayer;
  P.pos.set(0, 1.72, 11); P.vel.set(0,0,0); P.yaw = 0; P.pitch = 0;
  const E = window.__punisherEnemies;
  if (E.clearAll) E.clearAll();
  const street = [['enforcer',-8,14],['bruiser',6,16],['hitman',-4,18],['gunman',8,13],['gunman',-12,15],['thug',2,17]];
  for (const [t,x,z] of street) { const en = E.spawn(t,x,z,0); if (en) en.zone='street'; }
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
          const arr = b.dts.filter(d => d > 0 && d < 0.5);
          arr.sort((a,b)=>a-b);
          const sum = arr.reduce((a,b)=>a+b,0);
          b.stats = {
            frames: arr.length, durSec: sum, avgFps: arr.length / sum,
            medianFps: 1 / arr[Math.floor(arr.length / 2)],
            p95LowFps: 1 / arr[Math.floor(arr.length * 0.95)],
            p99LowFps: 1 / arr[Math.floor(arr.length * 0.99)],
            minFps: 1 / arr[arr.length - 1],
          };
        }
      }
      return orig(dt);
    };
    WD.__benchPatched = true;
  }
  window.__bench = { dts: [], done: false };
  return true;
})()`);

console.log('benchmark running for 32s...');
for (let t = 0; t < 80; t++) {
  await sleep(500);
  const s = await evalExpr('({n: window.__bench && window.__bench.dts.length, d: window.__bench && window.__bench.done, patched: window.__punisherWaveDirector && window.__punisherWaveDirector.__benchPatched, perf: performance.now()})');
  if (t % 4 === 0) console.log('  t=' + (t*0.5).toFixed(1) + 's', s);
  if (s.d) break;
}

const result = await evalExpr('window.__bench && window.__bench.stats');
console.log('RESULT:', JSON.stringify(result, null, 2));
console.log('ERRORS:', exceptions.length, exceptions.slice(0, 3));
console.log('CONSOLE-tail:', consoleMsgs.slice(-5));

ws.close();
try { proc.kill('SIGKILL'); } catch (_) {}
await sleep(300);
process.exit(0);

