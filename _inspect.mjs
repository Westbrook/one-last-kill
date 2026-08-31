// Instrument the scene: list all Mesh objects with their material names and counts.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_PATH = '/Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html';
const PORT = 9230;
const SERVER_PORT = 8768;
const URL = `http://127.0.0.1:${SERVER_PORT}/game.html?mute=1`;

const html = readFileSync(GAME_PATH, 'utf8');
const SHIM = `\n;try{window.__G={Player,Colliders,Triggers,ZoneCull,World,scene,camera,renderer,THREE,zoneChanged,
  setZone:(z)=>{try{zoneChanged(z);}catch(e){}},
  dismiss:()=>{try{document.getElementById('overlay').classList.add('hidden');document.getElementById('introcard').classList.remove('show');}catch(e){}}};}catch(e){}\n`;
const ix = html.lastIndexOf('</script>');
const patched = html.slice(0, ix) + SHIM + html.slice(ix);
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control','no-store'); res.end(patched); });
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(p) { return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:PORT,path:p},(r)=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b));}catch(e){rej(e);}});}).on('error',rej);}); }
const proc = spawn(CHROME, ['--remote-debugging-port='+PORT,'--window-size=1280,800','--user-data-dir=/tmp/chrome-inspect','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required',URL],{stdio:['ignore','pipe','pipe']});
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
async function ev(expr){const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;}
for (let i=0;i<200;i++){await sleep(250);try{const s=await ev('!!window.__G && window.__G.Colliders.list.length>50');if(s){break;}}catch(_){}}
await ev('window.__G.dismiss();true');
await sleep(500);

const stats = await ev(`(() => {
  const G = window.__G;
  const counts = { mesh: 0, instanced: 0, points: 0, line: 0 };
  const byGeom = {}; const byMat = {};
  G.scene.traverse(o => {
    if (o.isMesh) counts.mesh++;
    else if (o.isInstancedMesh) counts.instanced++;
    else if (o.isPoints) counts.points++;
    else if (o.isLine) counts.line++;
    if (o.isMesh || o.isInstancedMesh) {
      const g = o.geometry?.constructor?.name||'?';
      byGeom[g] = (byGeom[g]||0)+1;
      const m = o.material?.constructor?.name||'?';
      byMat[m] = (byMat[m]||0)+1;
    }
  });
  return { counts, byGeom, byMat };
})()`);
console.log('COUNTS:', JSON.stringify(stats.counts));
console.log('BY GEOM:', JSON.stringify(stats.byGeom, null, 2));
console.log('BY MAT:', JSON.stringify(stats.byMat, null, 2));

const ZONES = [
  { name:'apartment', x:-9, y:4, z:-4, yaw:0.6, pitch:-0.05 },
  { name:'balcony', x:6, y:4, z:0.65, yaw:Math.PI*0.8, pitch:-0.05 },
  { name:'stairwell', x:-18, y:0.5, z:-5.5, yaw:-Math.PI/2, pitch:0.2 },
  { name:'roof', x:-5, y:14, z:-5, yaw:Math.PI*0.3, pitch:-0.1 },
  { name:'bakery', x:-20, y:0.5, z:22, yaw:-Math.PI/2, pitch:0 },
];
for (const z of ZONES) {
  await ev(`(() => { const G=window.__G; G.setZone('${z.name}'); G.Player.pos.set(${z.x}, ${z.y+1.65}, ${z.z}); G.Player.vel.set(0,0,0); G.Player.yaw=${z.yaw}; G.Player.pitch=${z.pitch}; G.dismiss(); })()`);
  await sleep(800);
  await ev('window.__G.renderer.info.reset()');
  await sleep(800);
  // Get info, plus list of largest-frequency draws by material/geometry combos visible
  const info = await ev(`(() => {
    const r = window.__G.renderer.info;
    return { calls: r.render.calls, tris: r.render.triangles, geom: r.memory.geometries };
  })()`);
  // Count meshes within camera frustum
  const visibleCounts = await ev(`(() => {
    const G = window.__G;
    G.camera.updateMatrixWorld(); G.camera.updateProjectionMatrix();
    const f = new G.THREE.Frustum();
    const m = new G.THREE.Matrix4().multiplyMatrices(G.camera.projectionMatrix, G.camera.matrixWorldInverse);
    f.setFromProjectionMatrix(m);
    const byG = {}; const byM = {}; let visMesh = 0;
    G.scene.traverse(o => {
      if (!(o.isMesh||o.isInstancedMesh)) return;
      if (!o.geometry?.boundingSphere) o.geometry?.computeBoundingSphere?.();
      const bs = o.geometry?.boundingSphere;
      let visible = true;
      if (bs) {
        const sphere = bs.clone(); sphere.applyMatrix4(o.matrixWorld);
        visible = f.intersectsSphere(sphere);
      }
      if (visible) { visMesh++;
        const g = o.geometry?.constructor?.name||'?'; byG[g]=(byG[g]||0)+1;
        const mname = o.material?.constructor?.name||'?'; byM[mname]=(byM[mname]||0)+1;
      }
    });
    return { visMesh, byG, byM };
  })()`);
  console.log(`\n=== ${z.name} ===`);
  console.log(`renderer.info: calls=${info.calls} tris=${info.tris} geom=${info.geom}`);
  console.log(`visible meshes: ${visibleCounts.visMesh}`);
  console.log(`visible byG:`, JSON.stringify(visibleCounts.byG));
  console.log(`visible byM:`, JSON.stringify(visibleCounts.byM));
}

proc.kill(); process.exit(0);
