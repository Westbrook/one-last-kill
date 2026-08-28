// Walk a capsule from in-front-of-the-door all the way to the back room
// inside the bakery. Confirm the path reaches z>=27 (back wall) without
// getting stuck on the counter or door jambs.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const SERVER_PORT = 8767;
const URL = 'http://127.0.0.1:' + SERVER_PORT + '/game.html?mute=1';
const PORT = 9225;

const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = '\n;try{window.__G={Player,Colliders,Triggers,ZONE_WAVE_CONFIG,HealPickups,isBlocked,resolveSphereAABB,THREE};}catch(e){console.error(e);}\n';
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(patched); });
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(p) { return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); }); }

const proc = spawn(CHROME, ['--remote-debugging-port=' + PORT, '--window-position=2000,2000', '--user-data-dir=/tmp/chrome-diag-bakery', '--no-first-run', URL], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 80; i++) { await sleep(250); try { const list = await httpJson('/json/list'); target = list.find(t => t.type === 'page' && t.url && t.url.includes('game.html')); if (target) break; } catch (_) {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id != null && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } };
const send = (method, params = {}) => { const id = ++msgId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); };
await send('Runtime.enable');
async function evalExpr(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
for (let i = 0; i < 240; i++) { await sleep(250); try { if ((await evalExpr('window.__G && window.__G.Colliders ? window.__G.Colliders.list.length : 0')) > 50) break; } catch (_) {} }

// Walk from (-18.75, 0.6, 18) NORTH through the bakery door and inside.
// Use a steering policy that biases NORTH but also gently nudges east when
// blocked, mimicking a player navigating around obstacles.
async function walkInto(startX) {
  return await evalExpr(`(() => {
    const G = window.__G, Player = G.Player, Colliders = G.Colliders, THREE = G.THREE, R = G.resolveSphereAABB;
    Player.pos.set(${startX}, 0 + Player._eyeH, 18); Player.vel.set(0,0,0);
    const dt = 1/60;
    let maxZ = -Infinity;
    for (let f = 0; f < 600; f++) {
      Player.vel.x = 0; Player.vel.z = 5.5;
      Player.vel.y -= 22 * dt;
      Player.pos.addScaledVector(Player.vel, dt);
      const r = Player.radius, bH = Player._bodyH, list = Colliders.list;
      const _b = new THREE.Vector3(), _t = new THREE.Vector3();
      for (let pass = 0; pass < 4; pass++) {
        const fy = Player.pos.y - Player._eyeH;
        _b.set(Player.pos.x, fy + r, Player.pos.z); _t.set(Player.pos.x, fy + bH - r, Player.pos.z);
        let moved = false;
        for (let i = 0, n = list.length; i < n; i++) {
          const box = list[i]; let hit = R(_b, r, box);
          if (hit) { Player.pos.addScaledVector(hit.normal, hit.depth); _b.addScaledVector(hit.normal, hit.depth); const vn = Player.vel.dot(hit.normal); if (vn < 0) Player.vel.addScaledVector(hit.normal, -vn); moved = true; }
          hit = R(_t, r, box);
          if (hit) { Player.pos.addScaledVector(hit.normal, hit.depth); _t.addScaledVector(hit.normal, hit.depth); const vn = Player.vel.dot(hit.normal); if (vn < 0) Player.vel.addScaledVector(hit.normal, -vn); moved = true; }
        }
        if (!moved) break;
      }
      if (Player.pos.y - Player._eyeH < 0) { Player.pos.y = Player._eyeH; if (Player.vel.y < 0) Player.vel.y = 0; }
      if (Player.pos.z > maxZ) maxZ = Player.pos.z;
    }
    return { x: Player.pos.x, z: Player.pos.z, maxZ, footY: Player.pos.y - Player._eyeH };
  })()`);
}

const results = [];
// Three entry trajectories: through the west side, center, and east side of the door.
for (const sx of [-20, -19, -18.5, -17.5]) {
  const r = await walkInto(sx);
  results.push({ startX: sx, settledX: +r.x.toFixed(2), settledZ: +r.z.toFixed(2), maxZ: +r.maxZ.toFixed(2), footY: +r.footY.toFixed(2) });
}
console.log(JSON.stringify({ results }, null, 2));
proc.kill(); process.exit(0);

