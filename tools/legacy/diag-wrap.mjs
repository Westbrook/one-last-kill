// Diagnostic: enumerate what colliders intersect the wrap walkway deck region.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const SERVER_PORT = 8765;
const URL = 'http://127.0.0.1:' + SERVER_PORT + '/game.html?mute=1';
const PORT = 9223;

const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = '\n;try{window.__G={Player,Colliders,Triggers,ZONE_WAVE_CONFIG,HealPickups,ZONE_HIDE_ON_ENTER,isBlocked,resolveSphereAABB,THREE};}catch(e){console.error("shim",e);}\n';
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);

const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store'); res.end(patched); });
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(path) { return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); }); }

const proc = spawn(CHROME, ['--remote-debugging-port=' + PORT, '--window-position=2000,2000', '--user-data-dir=/tmp/chrome-diag-wrap', '--no-first-run', '--no-default-browser-check', URL], { stdio: ['ignore', 'pipe', 'pipe'] });

let target = null;
for (let i = 0; i < 80; i++) { await sleep(250); try { const list = await httpJson('/json/list'); target = list.find(t => t.type === 'page' && t.url && t.url.includes('game.html')); if (target) break; } catch (_) {} }
if (!target) { proc.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id != null && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } };
const send = (method, params = {}) => { const id = ++msgId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); };
await send('Runtime.enable');

async function evalExpr(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description||'')); return r.result.value; }

for (let i = 0; i < 240; i++) { await sleep(250); try { const n = await evalExpr('window.__G && window.__G.Colliders ? window.__G.Colliders.list.length : 0'); if (n > 50) break; } catch (_) {} }

// Find colliders that contain the point (x=-7, y=2..4.0, z=0.65) — the region
// where the player fell through. Also look at all colliders whose Y range
// intersects [3.5, 4.0] AND whose X range overlaps [-10, -3] AND whose Z
// range overlaps [0, 1.3] (the wrap deck).
const out = await evalExpr(`(() => {
  const list = window.__G.Colliders.list;
  const xrange = [-10, -3], yrange = [3.5, 4.2], zrange = [-0.2, 1.5];
  const overlaps = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.max.x < xrange[0] || b.min.x > xrange[1]) continue;
    if (b.max.y < yrange[0] || b.min.y > yrange[1]) continue;
    if (b.max.z < zrange[0] || b.min.z > zrange[1]) continue;
    overlaps.push({ i, min: b.min.toArray(), max: b.max.toArray() });
  }
  // Also: at x=-7, z=0.65, what colliders are stacked above y=0?
  const stack = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.min.x <= -7 && b.max.x >= -7 && b.min.z <= 0.65 && b.max.z >= 0.65) {
      stack.push({ i, min: b.min.toArray(), max: b.max.toArray() });
    }
  }
  stack.sort((a, b) => a.min[1] - b.min[1]);
  return { overlaps, stack };
})()`);
writeFileSync('/tmp/verify-task6/diag-wrap.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
proc.kill(); process.exit(0);

