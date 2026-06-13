// Task 9 — capture matched screenshots with and without realism pass.
// Usage: `node screenshot-zones.mjs noenv=1 out=noenv` or no args for env on.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const extra = args.noenv ? 'noenv=1' : '';
const tag = args.out || (args.noenv ? 'noenv' : 'env');
const URL = 'http://127.0.0.1:8765/punisher-game.html?mute=1' + (extra ? '&' + extra : '');
const PORT = 9226 + (extra ? 1 : 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(p) {
  return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{res(JSON.parse(b))}catch(e){rej(e)}}); }).on('error',rej); });
}
const proc = spawn(CHROME, [
  '--remote-debugging-port=' + PORT, '--window-size=1280,800', '--window-position=0,0',
  '--user-data-dir=/tmp/chrome-shot-' + tag + '-' + process.pid,
  '--no-first-run', '--no-default-browser-check', '--enable-webgl', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required', URL,
], { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', () => {});
let target = null;
for (let i = 0; i < 80; i++) { await sleep(250); try {
  const list = await httpJson('/json/list'); target = list.find(t => t.type==='page' && t.url && t.url.includes('punisher-game.html')); if (target) break;
} catch(_){} }
if (!target) { console.error('NO_TARGET'); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j) => { ws.onopen=()=>r(); ws.onerror=j; });
let id=0; const pend=new Map();
ws.onmessage = (ev) => { const m=JSON.parse(ev.data); if (m.id!=null && pend.has(m.id)) { const{resolve,reject}=pend.get(m.id); pend.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } };
const send = (method, params={}) => { const i=++id; return new Promise((res,rej)=>{ pend.set(i,{resolve:res,reject:rej}); ws.send(JSON.stringify({id:i,method,params})); }); };
await send('Runtime.enable'); await send('Page.enable');
try { await send('Page.bringToFront'); } catch (_) {}
async function ev(expr){ const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
for (let i = 0; i < 240; i++) { await sleep(250); const s = await ev('({p:!!window.__punisherPlayer,e:!!window.__punisherEnemies})'); if (s.p && s.e) break; }
// Dismiss the splash overlay and the intro card so the canvas is the only thing on screen.
await ev(`(()=>{
  const o=document.getElementById('overlay'); if(o) o.classList.add('hidden');
  const ic=document.getElementById('introcard'); if(ic) ic.classList.remove('show');
  return true;
})()`);
await sleep(200);

const POSES = [
  { name: 'street', expr: `(()=>{const P=window.__punisherPlayer;P.pos.set(0,1.72,8);P.yaw=Math.PI;P.pitch=-0.05;const E=window.__punisherEnemies;E.clearAll&&E.clearAll();[['enforcer',-6,-4],['bruiser',5,-6],['gunman',-3,-10]].forEach(([t,x,z])=>E.spawn(t,x,z,0));return true;})()` },
  { name: 'apartment', expr: `(()=>{const P=window.__punisherPlayer;P.pos.set(-8,1.72,-3);P.yaw=0.3;P.pitch=-0.1;return true;})()` },
  { name: 'rooftop', expr: `(()=>{const P=window.__punisherPlayer;P.pos.set(12,7.0,-12);P.yaw=-1.2;P.pitch=-0.15;return true;})()` },
];
fs.mkdirSync('shots', { recursive: true });
for (const pose of POSES) {
  try { await ev(pose.expr); } catch (e) { console.warn('pose failed', pose.name, e.message); continue; }
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `shots/${pose.name}-${tag}.png`;
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('wrote', file);
}
ws.close(); try { proc.kill('SIGKILL'); } catch(_) {}
await sleep(300); process.exit(0);

