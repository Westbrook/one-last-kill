// Real-browser verification for the balcony/scaffolding/heal-pack batch:
//   F1: HealPickups never consume a pack at Player.health === 100.
//   F2: A heal pickup exists at the west walkway terminus (~x=-18, y≈4.18, z=0.65).
//   F3: pickSafeSpawn('balcony') only returns positions on the balcony deck,
//       NOT inside the scaffolding x∈[-7.5,7.5] z∈[0.3,5.2] footprint.
//       Also: pickSafeSpawn('scaffolding') still returns valid spawns.
//   F4: Walking the entire wrap walkway at y=4, z=0.65 from x=-18 to x=12
//       does NOT fire the 'scaffolding' Trigger (only 'balcony' may fire).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const SERVER_PORT = 8768;
const URL = 'http://127.0.0.1:' + SERVER_PORT + '/game.html?mute=1';
const PORT = 9226;

const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = `\n;try{window.__G={Player,PlayerState,Colliders,Triggers,ZONE_WAVE_CONFIG,HealPickups,pickSafeSpawn,hasGroundBelow,isBlocked,resolveSphereAABB,THREE};window.__triggerLog=[];const _o=Triggers.add;Triggers.add=function(name,a,b,cb){const wrap=cb?function(){window.__triggerLog.push(name);return cb.apply(this,arguments);}:function(){window.__triggerLog.push(name);};return _o.call(this,name,a,b,wrap);};}catch(e){console.error(e);}\n`;
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(patched); });
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(p) { return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); }); }

const proc = spawn(CHROME, ['--remote-debugging-port=' + PORT, '--window-position=2000,2000', '--user-data-dir=/tmp/chrome-diag-balscaff', '--no-first-run', URL], { stdio: ['ignore', 'pipe', 'pipe'] });
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

// F2: confirm a heal pickup exists at the west walkway terminus.
const healCheck = await evalExpr(`(() => {
  const list = window.__G.HealPickups; // not directly exposed; query DOM via internal list isn't trivial.
  // Instead, locate by World mesh proximity: scan colliders + scene. We exposed HealPickups, but the inner list is closed.
  // Use a proxy: simulate the pickup loop by setting Player to test position and ticking. We already have the API.
  // Easier: walk the player TO that position and watch health restore.
  return true;
})()`);

// F1: at full HP, walk through every pickup and confirm none vanish.
const fullHpResult = await evalExpr(`(() => {
  const G = window.__G;
  G.Player.health = 100;
  // Walk capsule through each seeded pickup position; record any HP change.
  const positions = [[-10,4,-4],[3,4,-7],[11.5,4,-3.5],[-18,4,0.65],[-16.6,6.4,-1.2],[5,14,-4],[0,7,2.5],[-5,0,10],[12,0,11],[-19.5,0,25]];
  const before = G.Player.health;
  for (const [x,y,z] of positions) {
    G.Player.pos.set(x, y + G.Player._eyeH, z);
    // Tick HealPickups.update enough to detect proximity consumption.
    for (let f = 0; f < 5; f++) G.HealPickups.update(1/60);
  }
  return { before, after: G.Player.health, anyConsumed: G.Player.health !== before };
})()`);

// F2 (cont): drop HP to 50, walk to the new west-walkway pickup spot,
// and confirm HP restores (proving the pickup is there and reachable).
const reachWestPickup = await evalExpr(`(() => {
  const G = window.__G;
  G.Player.health = 50;
  G.Player.pos.set(-18, 4 + G.Player._eyeH, 0.65);
  for (let f = 0; f < 30; f++) G.HealPickups.update(1/60);
  return { health: G.Player.health };
})()`);

// F3: sample pickSafeSpawn('balcony') 200 times; none should be in the
// scaffold footprint. Also confirm pickSafeSpawn('scaffolding') always
// returns a valid spawn (hasGroundBelow gate doesn't reject every option).
const spawnSamples = await evalExpr(`(() => {
  const G = window.__G;
  // Park player far away so the d<5 filter doesn't randomly reject.
  G.Player.pos.set(-50, 4 + G.Player._eyeH, -50);
  const balcony = []; const scaff = [];
  for (let i = 0; i < 200; i++) {
    const b = G.pickSafeSpawn('balcony');
    const s = G.pickSafeSpawn('scaffolding');
    balcony.push(b); scaff.push(s);
  }
  const inScaff = balcony.filter(p => p && p.x >= -7.5 && p.x <= 7.5 && p.z >= 0.3 && p.z <= 5.2);
  const noGround = scaff.filter(p => !p || !G.hasGroundBelow(p.x, p.y, p.z));
  const uniq = (arr) => [...new Set(arr.map(p => p?p.x+','+p.y+','+p.z:'null'))];
  return {
    balconyUnique: uniq(balcony),
    scaffUnique: uniq(scaff),
    balconyInScaffold: inScaff.length,
    scaffWithoutGround: noGround.length,
  };
})()`);

// F4: walk a player capsule along the wrap walkway from x=-18 to x=12 at
// y=4, z=0.65 and tally which Triggers fire. We tick the trigger system
// by polling Triggers.update() — but the actual integration runs every
// frame. We'll simulate by directly moving Player.pos in small steps and
// invoking the runtime trigger update path.
const walkResult = await evalExpr(`(() => {
  const G = window.__G;
  window.__triggerLog.length = 0;
  // Reset the engine's trigger 'fired' state so balcony/scaffolding can fire fresh.
  if (G.Triggers && G.Triggers.list) {
    for (const t of G.Triggers.list) { if (t.fired) t.fired = false; }
  }
  // Move along the walkway. Each iteration we call Triggers.update().
  const fired = new Set();
  for (let x = -18; x <= 12; x += 0.25) {
    G.Player.pos.set(x, 4 + G.Player._eyeH, 0.65);
    if (G.Triggers && G.Triggers.update) G.Triggers.update();
  }
  return { triggerLog: window.__triggerLog.slice(), uniqueFired: [...new Set(window.__triggerLog)] };
})()`);

console.log(JSON.stringify({
  F1_fullHpResult: fullHpResult,
  F2_reachWestPickup: reachWestPickup,
  F3_spawnSamples: spawnSamples,
  F4_walkResult: walkResult,
}, null, 2));
proc.kill(); process.exit(0);

