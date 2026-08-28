// Verifier for Task 6 — drives the game in real Chrome via raw CDP. Serves the
// HTML via a local HTTP server with a small shim that exposes module-scoped
// objects on `window.__G` so we can drive them from the outside.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const SERVER_PORT = 8765;
const URL = 'http://127.0.0.1:' + SERVER_PORT + '/game.html?mute=1';
const PORT = 9223;
const OUT = '/tmp/verify-task6';
mkdirSync(OUT, { recursive: true });

// Read the game, inject a shim before the module's closing </script>.
const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = '\n;try{window.__G={Player,Colliders,Triggers,ZONE_WAVE_CONFIG,HealPickups,ZONE_HIDE_ON_ENTER,isBlocked,resolveSphereAABB,THREE,currentZone:()=>currentZone};}catch(e){console.error("shim",e);}\n';
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
  '--window-position=2000,2000',
  '--user-data-dir=/tmp/chrome-verify-task6',
  '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
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
    target = list.find(t => t.type === 'page' && t.url && t.url.includes('game.html'));
    if (target) break;
  } catch (_) {}
}
if (!target) { console.error('NO_TARGET', chromeErr.slice(0, 2000)); proc.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
let msgId = 0;
const pending = new Map();
const consoleMsgs = [];
const exceptions = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails.text||'') + ': ' + (m.params.exceptionDetails.exception?.description || ''));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleMsgs.push({ type: 'log-error', text: m.params.entry.text });
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

async function evalExpr(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval error: ' + r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description||''));
  return r.result.value;
}

let ready = false;
const progress = [];
for (let i = 0; i < 240; i++) {
  await sleep(250);
  try {
    const state = await evalExpr('({g: !!window.__G, c: window.__G && window.__G.Colliders ? window.__G.Colliders.list.length : -1, p: window.__G && window.__G.Player ? {x:window.__G.Player.pos.x,y:window.__G.Player.pos.y,z:window.__G.Player.pos.z} : null, t: window.__G && window.__G.Triggers ? window.__G.Triggers.list.length : -1})');
    progress.push({i, state});
    if (state.c > 50) { ready = true; break; }
  } catch (e) { progress.push({i, err: String(e).slice(0,200)}); }
}
if (!ready) { console.error('GAME_NOT_READY', JSON.stringify({consoleMsgs, exceptions, chromeErr: chromeErr.slice(0,1500), progress: progress.slice(-15)}, null, 2)); proc.kill(); process.exit(2); }

const diag0 = await evalExpr(`(() => {
  const G = window.__G;
  return {
    colliderCount: G.Colliders.list.length,
    playerStart: { x: G.Player.pos.x, y: G.Player.pos.y, z: G.Player.pos.z },
    triggerBoxes: G.Triggers.list.map(t => ({ name: t.name, min: t.box.min.toArray(), max: t.box.max.toArray() })),
    balconySpawns: G.ZONE_WAVE_CONFIG.balcony.spawns,
    stairwellSpawns: G.ZONE_WAVE_CONFIG.stairwell.spawns,
    roofSpawns: G.ZONE_WAVE_CONFIG.roof.spawns,
    zoneHide: G.ZONE_HIDE_ON_ENTER,
  };
})()`);

async function dropAndSettle(x, ySpawn, z, frames = 60) {
  return await evalExpr(`(() => {
    const G = window.__G;
    const Player = G.Player, Colliders = G.Colliders, THREE = G.THREE, resolveSphereAABB = G.resolveSphereAABB;
    Player.pos.set(${x}, ${ySpawn} + Player._eyeH, ${z});
    Player.vel.set(0, 0, 0);
    const dt = 1/60;
    for (let f = 0; f < ${frames}; f++) {
      Player.vel.y -= 22 * dt;
      Player.pos.addScaledVector(Player.vel, dt);
      const r = Player.radius;
      const bodyH = Player._bodyH;
      const list = Colliders.list;
      const _b = new THREE.Vector3(), _t = new THREE.Vector3();
      for (let pass = 0; pass < 4; pass++) {
        const footY = Player.pos.y - Player._eyeH;
        _b.set(Player.pos.x, footY + r, Player.pos.z);
        _t.set(Player.pos.x, footY + bodyH - r, Player.pos.z);
        let moved = false;
        for (let i = 0, n = list.length; i < n; i++) {
          const box = list[i];
          let hit = resolveSphereAABB(_b, r, box);
          if (hit) { Player.pos.addScaledVector(hit.normal, hit.depth); _b.addScaledVector(hit.normal, hit.depth);
            const vn = Player.vel.dot(hit.normal); if (vn < 0) Player.vel.addScaledVector(hit.normal, -vn); moved = true; }
          hit = resolveSphereAABB(_t, r, box);
          if (hit) { Player.pos.addScaledVector(hit.normal, hit.depth); _t.addScaledVector(hit.normal, hit.depth);
            const vn = Player.vel.dot(hit.normal); if (vn < 0) Player.vel.addScaledVector(hit.normal, -vn); moved = true; }
        }
        if (!moved) break;
      }
      if (Player.pos.y - Player._eyeH < 0) { Player.pos.y = Player._eyeH; if (Player.vel.y < 0) Player.vel.y = 0; }
    }
    return { x: Player.pos.x, y: Player.pos.y, z: Player.pos.z, footY: Player.pos.y - Player._eyeH };
  })()`);
}

const walk = {
  apartment:      await dropAndSettle(-9, 4.0, -4.0, 30),
  neighbor:       await dropAndSettle(7, 4.0, -5, 30),
  eastCantilever: await dropAndSettle(11, 4.0, -5, 30),
  wrapMid:        await dropAndSettle(0, 4.0, 0.65, 30),
  wrapWest:       await dropAndSettle(-18, 4.0, 0.65, 30),
  stairEntry:     await dropAndSettle(-18, 4.0, -1.5, 30),
  stairTop:       await dropAndSettle(-16.6, 14.0, -7.8, 30),
  roofEntry:      await dropAndSettle(-13, 14.0, -7, 30),
  scaffTop:       await dropAndSettle(0, 10.0, 2.0, 30),
  street:         await dropAndSettle(0, 0.5, 12.0, 30),
  wrapEscape:     await dropAndSettle(-6.0, 4.5, 2.0, 60),
};

const STAIR_GAPS = [
  { x: -20.7, y: 6.0, z: -5.0, label: 'lane-A-west-gap (vs west wall)' },
  { x: -18.0, y: 6.0, z: -5.0, label: 'inter-lane-gap (flight 1 mid)' },
  { x: -18.0, y: 6.0, z: -7.5, label: 'inter-lane-gap (flight 1 north)' },
  { x: -15.4, y: 6.0, z: -5.0, label: 'lane-B-east-gap (vs east wall)' },
  { x: -19.4, y: 13.0, z: -5.0, label: 'lane A mid drop (high)' },
  { x: -16.6, y: 13.0, z: -5.0, label: 'lane B mid drop (high)' },
  { x: -18.0, y: 12.0, z: -1.5, label: 'inter-lane gap landing y=11.6' },
];
const stairDrops = [];
for (const g of STAIR_GAPS) {
  const r = await dropAndSettle(g.x, g.y, g.z, 120);
  stairDrops.push({ label: g.label, start: g, end: r, fellThrough: r.footY < 1.0 });
}

const treadRays = await evalExpr(`(() => {
  const G = window.__G;
  const Colliders = G.Colliders, THREE = G.THREE;
  const results = [];
  function rayHit(origin, direction) {
    const ray = new THREE.Ray(origin.clone(), direction.clone().normalize());
    let bestT = Infinity, bestBox = null;
    const hit = new THREE.Vector3();
    for (const box of Colliders.list) {
      if (ray.intersectBox(box, hit)) {
        const d = hit.distanceTo(ray.origin);
        if (d > 0.01 && d < bestT) { bestT = d; bestBox = box.clone(); }
      }
    }
    return { hitDist: bestT === Infinity ? null : bestT, hitBoxMin: bestBox ? bestBox.min.toArray() : null, hitBoxMax: bestBox ? bestBox.max.toArray() : null };
  }
  results.push({ label: 'below flight1 lane A shoot up', res: rayHit(new THREE.Vector3(-19.4, 4.2, -5.0), new THREE.Vector3(0, 1, 0)) });
  results.push({ label: 'inter-lane shoot up from y=4.2 (mid-flight 1)', res: rayHit(new THREE.Vector3(-18.0, 4.2, -5.0), new THREE.Vector3(0, 1, 0)) });
  results.push({ label: 'lane A shoot horizontally into flight 1 from south', res: rayHit(new THREE.Vector3(-19.4, 4.5, -1.0), new THREE.Vector3(0, 0.05, -1).normalize()) });
  results.push({ label: 'roof exit doorway from -14,15,-7 shoot west', res: rayHit(new THREE.Vector3(-14, 15, -7), new THREE.Vector3(-1, 0, 0)) });
  results.push({ label: 'stair-tread side shot from inter-lane gap into lane A flight 3', res: rayHit(new THREE.Vector3(-17.5, 10.5, -5.0), new THREE.Vector3(-1, 0, 0)) });
  results.push({ label: 'stair-tread shot up from below lane B flight 4', res: rayHit(new THREE.Vector3(-16.6, 11.7, -5.0), new THREE.Vector3(0, 1, 0)) });
  return results;
})()`);

// Continuous-walkway sweep: drop the player at many x positions along the
// wrap walkway and confirm every drop lands on the deck (footY ≈ 4).
const wrapSweep = [];
for (let x = -19; x <= 13; x += 1) {
  const r = await dropAndSettle(x, 4.5, 0.65, 30);
  wrapSweep.push({ x, footY: r.footY, settledX: r.x, settledZ: r.z });
}

// Stair flight continuous walk: drop at intervals along each lane to confirm
// no holes in the stairs.
const stairSweep = [];
for (const lane of [{ x: -19.4, label: 'A' }, { x: -16.6, label: 'B' }]) {
  for (let z = -8.5; z <= -1.4; z += 1) {
    const r = await dropAndSettle(lane.x, 14.5, z, 90);
    stairSweep.push({ lane: lane.label, z, footY: r.footY });
  }
}

// Try to walk SOUTH from the wrap walkway against the railing — confirms the
// railing collider blocks horizontal motion (no escape-from-world).
const wrapRailingTest = await evalExpr(`(() => {
  const G = window.__G;
  const Player = G.Player, Colliders = G.Colliders, THREE = G.THREE, resolveSphereAABB = G.resolveSphereAABB;
  Player.pos.set(-6, 4 + Player._eyeH, 0.65); Player.vel.set(0, 0, 0);
  const dt = 1/60;
  for (let f = 0; f < 60; f++) {
    Player.vel.z += 8.0 * dt;
    Player.pos.addScaledVector(Player.vel, dt);
    const r = Player.radius, bodyH = Player._bodyH, list = Colliders.list;
    const _b = new THREE.Vector3(), _t = new THREE.Vector3();
    for (let pass = 0; pass < 4; pass++) {
      const footY = Player.pos.y - Player._eyeH;
      _b.set(Player.pos.x, footY + r, Player.pos.z);
      _t.set(Player.pos.x, footY + bodyH - r, Player.pos.z);
      let moved = false;
      for (let i = 0, n = list.length; i < n; i++) {
        const box = list[i];
        let hit = resolveSphereAABB(_b, r, box);
        if (hit) { Player.pos.addScaledVector(hit.normal, hit.depth); _b.addScaledVector(hit.normal, hit.depth);
          const vn = Player.vel.dot(hit.normal); if (vn < 0) Player.vel.addScaledVector(hit.normal, -vn); moved = true; }
        hit = resolveSphereAABB(_t, r, box);
        if (hit) { Player.pos.addScaledVector(hit.normal, hit.depth); _t.addScaledVector(hit.normal, hit.depth);
          const vn = Player.vel.dot(hit.normal); if (vn < 0) Player.vel.addScaledVector(hit.normal, -vn); moved = true; }
      }
      if (!moved) break;
    }
  }
  return { finalZ: Player.pos.z, finalY: Player.pos.y, footY: Player.pos.y - Player._eyeH };
})()`);

// FPS measurement.
const fps = await evalExpr(`new Promise(resolve => {
  let frames = 0; const start = performance.now();
  function loop() { frames++; const now = performance.now(); if (now - start < 2000) requestAnimationFrame(loop); else resolve({ frames, ms: now - start, fps: frames / ((now - start)/1000) }); }
  requestAnimationFrame(loop);
})`);

const ss = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT + '/screenshot.png', Buffer.from(ss.data, 'base64'));

const report = { diag0, consoleMsgs, exceptions, walk, stairDrops, treadRays, wrapSweep, stairSweep, wrapRailingTest, fps };
writeFileSync(OUT + '/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
proc.kill(); process.exit(0);
