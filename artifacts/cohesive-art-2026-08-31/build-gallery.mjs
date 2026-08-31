import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const pairs = [
  ['Street · High 2×', 'street-high2'], ['Street, turned toward shops · High 2×', 'street-left-high2'],
  ['Street · Automatic', 'street-auto'], ['Brawler · front', 'brawler-front'],
  ['Brawler · profile', 'brawler-profile'], ['Brawler · rear', 'brawler-rear'],
  ['Brawler · from below', 'brawler-below'], ['Brawler · ordinary encounter distance', 'brawler-full'],
  ['Brawler · windup', 'brawler-windup'], ['Brawler · contact', 'brawler-contact'],
  ['Gunman · aim', 'gunman-aim'], ['Bat carrier · carry', 'thug-carry'],
  ['Bruiser · aim', 'bruiser-aim'], ['Hitman · aim', 'hitman-aim'],
  ['Enforcer · aim', 'enforcer-aim'], ['Bakery · High 2×', 'bakery-high2'], ['Roof · High 2×', 'roof-high2'],
].filter(([, stem]) => ['before', 'after'].every(phase => fs.existsSync(path.join(directory, `${phase}-${stem}.png`))));
fs.writeFileSync(path.join(directory, 'matched-pairs.json'), JSON.stringify(pairs.map(([label, stem]) => ({
  label, before: `before-${stem}.png`, after: `after-${stem}.png`,
  beforeReport: `before-${stem}.txt`, afterReport: `after-${stem}.txt`,
  viewport: { width: 1280, height: 720 },
  note: 'Original browser captures; no image retouching. Inspector fixture, camera, quality and scale matched. Live combat frames are retained separately and are not pixel-matched.',
})), null, 2));
fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>One Last Kill · art review</title>
<style>body{margin:0;background:#171c1e;color:#e8e3d5;font:16px/1.5 system-ui}main{max-width:1280px;margin:auto;padding:24px}h1{font-size:26px;margin:0}p{color:#b8bebd;max-width:900px}nav{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}select,button{font:inherit;color:inherit;background:#293132;border:1px solid #6a746d;padding:8px 12px;border-radius:3px}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #e6c993;outline-offset:3px}figure{margin:0;position:relative;aspect-ratio:16/9;overflow:hidden;background:#000}figure img{width:100%;height:100%;object-fit:contain;display:block}#after{position:absolute;inset:0;clip-path:inset(0 0 0 var(--split,50%))}.tag{position:absolute;top:14px;background:#101719df;padding:4px 12px;font-size:12px;letter-spacing:2px}.old{left:14px}.new{right:14px}#divider{position:absolute;left:var(--split,50%);top:0;bottom:0;border-left:2px solid #e6c993;pointer-events:none}label{display:block;margin-top:16px}input{width:100%;accent-color:#e6c993}footer{display:flex;gap:24px;flex-wrap:wrap;margin-top:18px}a{color:#e6c993}.help{font-size:13px}</style>
<main><h1>One Last Kill · character & neighborhood art pass</h1><p>Matched captures at 1280 × 720 CSS pixels, the existing dusk lighting and camera. High uses an explicit 2× drawing buffer; Automatic uses its normal device/preset setting. These images compare surfaces. Separate reports cover motion, behavior and performance.</p><nav><select id="view" aria-label="Matched view">${pairs.map(([label], index) => `<option value="${index}">${label}</option>`).join('')}</select><button id="previous">Previous view</button><button id="next">Next view</button></nav><figure id="comparison"><img id="before" alt="Before art pass"><img id="after" alt="After art pass"><div id="divider"></div><span class="tag old">BEFORE</span><span class="tag new">AFTER</span></figure><label>Before / after divider <input id="split" type="range" min="0" max="100" value="50" aria-label="Before after divider"></label><p class="help">Use the arrow keys on the slider. Original PNGs and their setup reports are linked below. Screenshot runs never supply timing conclusions.</p><footer><a id="beforeLink">Before PNG</a><a id="afterLink">After PNG</a><a id="beforeReport">Before setup</a><a id="afterReport">After setup</a><a href="final-performance.csv">Timing CSV</a><a href="final-performance-summary.json">Timing details</a></footer></main>
<script>const pairs=${JSON.stringify(pairs)};const select=document.getElementById('view');function show(){const stem=pairs[Number(select.value)][1];for(const phase of ['before','after']){document.getElementById(phase).src=phase+'-'+stem+'.png';document.getElementById(phase+'Link').href=phase+'-'+stem+'.png';document.getElementById(phase+'Report').href=phase+'-'+stem+'.txt';}}select.addEventListener('change',show);for(const [id,step]of [['previous',-1],['next',1]])document.getElementById(id).onclick=()=>{select.value=(Number(select.value)+step+pairs.length)%pairs.length;show()};document.getElementById('split').oninput=e=>document.getElementById('comparison').style.setProperty('--split',e.target.value+'%');if(pairs.length)show();</script></html>`);
console.log(`${pairs.length} matched pairs written to ${directory}/index.html`);
