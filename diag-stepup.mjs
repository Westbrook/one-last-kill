// Task 13 verification: real-Chrome CDP probe of auto step-up.
// (1) Place player at the stairwell bottom (lane A, north end) and "hold W"
//     by ticking playerUpdate with KeyW pressed for ~25s. Confirm Player.pos.y
//     rises monotonically (after filtering tiny float jitter) to the top-flight
//     landing y≈14 + eyeHeight, without ever pressing Space.
// (2) Place player against a normal ~1m brick wall (the building NE corner)
//     and confirm holding W does NOT lift them (no wall-climbing).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const SERVER_PORT = 8770;
const URL = 'http://127.0.0.1:' + SERVER_PORT + '/game.html?mute=1';
const PORT = 9231;
const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = `\n;try{window.__G={Player,PlayerState,Input,Colliders,playerUpdate,THREE};}catch(e){console.error(e);}\n`;
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(patched); });
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const httpJson = (p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
const proc = spawn(CHROME, ['--remote-debugging-port=' + PORT, '--window-position=2000,2000', '--user-data-dir=/tmp/chrome-stepup', '--no-first-run', URL], { stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 80; i++) { await sleep(250); try { const list = await httpJson('/json/list'); target = list.find(t => t.type === 'page' && t.url && t.url.includes('game.html')); if (target) break; } catch (_) {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
let msgId = 0; const pending = new Map();
const consoleMessages = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') consoleMessages.push({ type: m.params.type, text: (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ') });
  if (m.method === 'Runtime.exceptionThrown') consoleMessages.push({ type: 'exception', text: m.params.exceptionDetails.text });
  if (m.id != null && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
};
const send = (method, params = {}) => { const id = ++msgId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); };
await send('Runtime.enable');
async function evalExpr(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
for (let i = 0; i < 240; i++) { await sleep(250); try { if ((await evalExpr('window.__G && window.__G.Colliders ? window.__G.Colliders.list.length : 0')) > 50) break; } catch (_) {} }

// --- Probe 1: each flight climbs while holding W (no Space). Flights alternate
// lane (A=-19.4 / B=-16.6) and direction (south +z / north -z) at every landing.
const FLIGHTS = [
  { name: 'F1', x: -19.4, z0: -8.4, y0: 4.0,  yawFwdZ: +1, topY: 6.4 },  // NORTH→SOUTH
  { name: 'F2', x: -16.6, z0: -1.6, y0: 6.4,  yawFwdZ: -1, topY: 9.0 },  // SOUTH→NORTH
  { name: 'F3', x: -19.4, z0: -8.4, y0: 9.0,  yawFwdZ: +1, topY: 11.6 }, // NORTH→SOUTH
  { name: 'F4', x: -16.6, z0: -1.6, y0: 11.6, yawFwdZ: -1, topY: 14.0 }, // SOUTH→NORTH
];
const climbAll = await evalExpr(`(() => {
  const G = window.__G;
  const flights = ${JSON.stringify(FLIGHTS)};
  const results = [];
  for (const f of flights) {
    G.Player.pos.set(f.x, f.y0 + G.Player.eyeHeight, f.z0);
    G.Player.vel.set(0, 0, 0);
    // forward.z = -cos(yaw); want +1 ⇒ yaw=PI, want -1 ⇒ yaw=0.
    G.Player.yaw = f.yawFwdZ > 0 ? Math.PI : 0;
    G.Player.pitch = 0;
    G.Player._eyeH = G.Player.eyeHeight; G.Player._bodyH = G.Player.bodyHeight;
    G.Input.keys.clear(); G.Input.keys.add('KeyW'); G.Input.locked = false;
    const dt = 1/60; const frames = 60*8;
    let usedSpace = false; let maxFootY = f.y0; let regressions = 0;
    const path = [];
    for (let i = 0; i < frames; i++) {
      if (G.Input.keys.has('Space')) usedSpace = true;
      G.playerUpdate(dt);
      const footY = G.Player.pos.y - G.Player._eyeH;
      if (footY > maxFootY) maxFootY = footY;
      if (footY < maxFootY - 0.05) regressions++;
      if (i % 15 === 0) path.push({ t:+(i*dt).toFixed(2), y:+footY.toFixed(2), z:+G.Player.pos.z.toFixed(2), og:G.Player.onGround });
    }
    const finalFootY = +(G.Player.pos.y - G.Player._eyeH).toFixed(3);
    results.push({
      flight: f.name, startFootY: f.y0, targetTopY: f.topY,
      finalFootY, maxFootY: +maxFootY.toFixed(3),
      reachedTop: maxFootY >= f.topY - 0.05,
      usedSpace, regressions, path,
    });
  }
  return results;
})()`);
console.log('CLIMB (per flight):');
for (const r of climbAll) console.log(' ', r.flight, JSON.stringify({ start:r.startFootY, target:r.targetTopY, max:r.maxFootY, final:r.finalFootY, reachedTop:r.reachedTop, regressions:r.regressions, usedSpace:r.usedSpace }));
for (const r of climbAll) console.log('  DETAIL', r.flight, JSON.stringify(r.path));

// Diagnostic: dump nearby colliders at the F2 stuck position to find blocker.
const dump = await evalExpr(`(() => {
  const G = window.__G; const list = G.Colliders.list;
  const px = -16.6, py = 8.7, pz = -6.36;
  const near = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.max.x < px-1.0 || b.min.x > px+1.0) continue;
    if (b.max.z < pz-1.5 || b.min.z > pz+1.5) continue;
    if (b.max.y < py-0.5 || b.min.y > py+2.5) continue;
    near.push({ idx:i, min:[+b.min.x.toFixed(2),+b.min.y.toFixed(2),+b.min.z.toFixed(2)], max:[+b.max.x.toFixed(2),+b.max.y.toFixed(2),+b.max.z.toFixed(2)] });
  }
  return near;
})()`);
console.log('NEAR F2 STUCK ('+dump.length+' colliders):'); for (const b of dump) console.log('  ', JSON.stringify(b));

// --- Probe 2: cannot climb a 1m+ vertical wall ---
//  Pick the stairwell west wall (face at x=-20.9, y∈[0,14]) and stand outside
//  it at (-20.4, foot 0, -5). Hold W westward and confirm foot Y stays at 0.
const wall = await evalExpr(`(() => {
  const G = window.__G;
  // Find a tall west-facing wall: brick wall at SX1=-21, face at x=-20.9, y∈[0,14], z∈[-10,0].
  G.Player.pos.set(-20.5, 0 + G.Player.eyeHeight, -5);
  G.Player.vel.set(0, 0, 0);
  G.Player.yaw = -Math.PI / 2;     // forward = (-sin(-PI/2), 0, -cos(-PI/2)) = (1, 0, 0) — push east INTO wall? no, +x is east. we want WEST. Set yaw=PI/2 for forward=(-1,0,0).
  G.Player.yaw = Math.PI / 2;
  G.Player.pitch = 0;
  G.Player._eyeH = G.Player.eyeHeight;
  G.Player._bodyH = G.Player.bodyHeight;
  G.Input.keys.clear();
  G.Input.keys.add('KeyW');
  G.Input.locked = false;
  const dt = 1/60; const frames = 60*5;
  let maxFootY = 0;
  for (let i = 0; i < frames; i++) { G.playerUpdate(dt); const fy = G.Player.pos.y - G.Player._eyeH; if (fy > maxFootY) maxFootY = fy; }
  return { finalFootY: +(G.Player.pos.y - G.Player._eyeH).toFixed(3), finalX: +G.Player.pos.x.toFixed(3), finalZ: +G.Player.pos.z.toFixed(3), maxFootY: +maxFootY.toFixed(3) };
})()`);
console.log('WALL:', JSON.stringify(wall, null, 2));

// --- Probe 3: short crate <0.3m IS stepped onto; tall crate (>0.3m) is NOT ---
const crates = await evalExpr(`(() => {
  const G = window.__G;
  // Inject two synthetic boxes far from anything (y=0 ground): a short 0.25m one and a tall 1.2m one.
  G.Colliders.addBoxBySize(50, 0.125, 50, 1.0, 0.25, 1.0);
  G.Colliders.addBoxBySize(60, 0.6,   60, 1.0, 1.20, 1.0);
  // Try walking onto the short crate from x=49 toward east (+x).
  G.Player.pos.set(48.5, 0 + G.Player.eyeHeight, 50);
  G.Player.vel.set(0,0,0); G.Player.yaw = -Math.PI/2; // forward=(1,0,0) east
  G.Player.pitch = 0; G.Player._eyeH = G.Player.eyeHeight; G.Player._bodyH = G.Player.bodyHeight;
  G.Input.keys.clear(); G.Input.keys.add('KeyW'); G.Input.locked = false;
  for (let i = 0; i < 60*3; i++) G.playerUpdate(1/60);
  const onShort = +(G.Player.pos.y - G.Player._eyeH).toFixed(3);
  // Try walking onto the tall crate.
  G.Player.pos.set(58.5, 0 + G.Player.eyeHeight, 60);
  G.Player.vel.set(0,0,0); G.Player.yaw = -Math.PI/2;
  G.Input.keys.clear(); G.Input.keys.add('KeyW');
  for (let i = 0; i < 60*3; i++) G.playerUpdate(1/60);
  const onTall = +(G.Player.pos.y - G.Player._eyeH).toFixed(3);
  return { shortCrateFootY: onShort, tallCrateFootY: onTall };
})()`);
console.log('CRATES:', JSON.stringify(crates, null, 2));

// --- Probe 4: FPS sanity ---
const fps = await evalExpr(`new Promise(r => { let f = 0; const t0 = performance.now(); function step(){ f++; if (performance.now()-t0 > 5000) r({frames:f, sec:((performance.now()-t0)/1000).toFixed(2), fps:+(f/((performance.now()-t0)/1000)).toFixed(2)}); else requestAnimationFrame(step);} requestAnimationFrame(step); })`);
console.log('FPS:', JSON.stringify(fps));

console.log('CONSOLE ERRORS:', consoleMessages.filter(m => m.type === 'error' || m.type === 'exception').length);
for (const m of consoleMessages.filter(m => m.type === 'error' || m.type === 'exception')) console.log('  -', m.text);

proc.kill('SIGTERM'); server.close();
process.exit(0);

