// Minimal probe: load whatever HTML is at punisher-game.html and report
// per-zone draw call counts using the same FPS-sampling approach as verify-task22.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const PORT = 9231; const SP = 8769;
const URL = `http://127.0.0.1:${SP}/game.html?mute=1`;

const html = readFileSync(GAME, 'utf8');
const SHIM = `\n;try{window.__G={Player,Colliders,Triggers,World,scene,camera,renderer,THREE,zoneChanged,
  setZone:(z)=>{try{zoneChanged(z);}catch(e){}},
  dismiss:()=>{try{document.getElementById('overlay').classList.add('hidden');var i=document.getElementById('introcard');if(i)i.classList.remove('show');}catch(e){}}};}catch(e){}\n`;
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);
const server = http.createServer((req, res) => { res.setHeader('Content-Type','text/html'); res.setHeader('Cache-Control','no-store'); res.end(patched); });
await new Promise(r => server.listen(SP, '127.0.0.1', r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(p) { return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:PORT,path:p},(r)=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b));}catch(e){rej(e);}});}).on('error',rej);}); }
const proc = spawn(CHROME, ['--remote-debugging-port='+PORT,'--window-size=1280,800','--user-data-dir=/tmp/chrome-probe','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required',URL],{stdio:['ignore','pipe','pipe']});
proc.stderr.on('data',()=>{});
let target=null;
for (let i=0;i<80;i++){ await sleep(250); try{ const l=await httpJson('/json/list'); target=l.find(t=>t.type==='page'&&t.url&&t.url.includes('game.html')); if(target) break; }catch(_){}}
if(!target){console.error('NO_TARGET');proc.kill();process.exit(1);}
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.onopen=()=>res();ws.onerror=rej;});
let id=0;const pend=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id!=null&&pend.has(m.id)){const{r,e}=pend.get(m.id);pend.delete(m.id);if(m.error)e(new Error(JSON.stringify(m.error)));else r(m.result);}};
function send(method,params={}){const i=++id;return new Promise((r,e)=>{pend.set(i,{r,e});ws.send(JSON.stringify({id:i,method,params}));});}
await send('Runtime.enable');
async function ev(expr){const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+' '+(r.exceptionDetails.exception?.description||''));return r.result.value;}
for (let i=0;i<200;i++){await sleep(250);try{const s=await ev('!!window.__G && !!window.__G.Colliders && window.__G.Colliders.list.length>3');if(s){console.log('ready after',(i+1)*250,'ms');break;}}catch(e){if(i%8===0)console.log('wait',i,e.message.slice(0,80));}}
await ev('window.__G.dismiss();true');
await sleep(800);

// Total mesh count
const totals = await ev(`(() => { const G=window.__G; let mesh=0, inst=0; G.scene.traverse(o=>{if(o.isMesh)mesh++;else if(o.isInstancedMesh)inst++;}); return {mesh,inst}; })()`);
console.log('total mesh:', totals.mesh, 'instanced:', totals.inst);

const ZONES = [
  { name:'apartment', zone:'apartment', x:-9, y:4, z:-4, yaw:0.6, pitch:-0.05 },
  { name:'neighbor', zone:'neighbor', x:3, y:4, z:-4, yaw:-0.4, pitch:0 },
  { name:'balcony', zone:'balcony', x:6, y:4, z:0.65, yaw:Math.PI*0.8, pitch:-0.05 },
  { name:'stairwell', zone:'stairwell', x:-18, y:0.5, z:-5.5, yaw:-Math.PI/2, pitch:0.2 },
  { name:'roof', zone:'roof', x:-5, y:14, z:-5, yaw:Math.PI*0.3, pitch:-0.1 },
  { name:'scaffolding', zone:'scaffolding', x:0, y:10, z:2, yaw:Math.PI, pitch:-0.05 },
  { name:'street', zone:'street', x:-5, y:0.5, z:12, yaw:Math.PI/2, pitch:-0.05 },
  { name:'bakery', zone:'bakery', x:-20, y:0.5, z:22, yaw:-Math.PI/2, pitch:0 },
];
for (const z of ZONES) {
  await ev(`(() => { const G=window.__G; G.setZone('${z.zone}'); G.Player.pos.set(${z.x}, ${z.y+1.65}, ${z.z}); G.Player.vel.set(0,0,0); G.Player.yaw=${z.yaw}; G.Player.pitch=${z.pitch}; G.dismiss(); })()`);
  await sleep(700);
  await ev('window.__G.renderer.info.reset()');
  const fps = await ev(`new Promise(r=>{let f=0;const s=performance.now();(function L(){f++;const n=performance.now();if(n-s<2000)requestAnimationFrame(L);else r({fps:f/((n-s)/1000)});})();})`);
  const info = await ev(`(()=>{const i=window.__G.renderer.info; return {c:i.render.calls,t:i.render.triangles};})()`);
  console.log(`${z.name.padEnd(12)} fps=${fps.fps.toFixed(1).padStart(5)} calls=${String(info.c).padStart(5)} tris=${String(info.t).padStart(7)}`);
}
proc.kill(); process.exit(0);
