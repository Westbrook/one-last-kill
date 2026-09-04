// Offline semantic correspondence for the accepted topology. Geometry edits live
// in hands.blend; this instruments the seed builder only to identify its rings.
import { readFile, writeFile } from 'node:fs/promises';
const sourceUrl = new URL('../../src/render/hand-geometry.js', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
source = source.replaceAll("from './hand-materials.js'", `from '${new URL('../../src/render/hand-materials.js', import.meta.url).href}'`)
  .replaceAll("from './authored-hand-surfaces.js'", `from '${new URL('../../src/render/authored-hand-surfaces.js', import.meta.url).href}'`)
  .replace("from 'three'", `from '${new URL('../../node_modules/three/build/three.module.js', import.meta.url).href}'`)
  .replace('const positions = [], uv = [], colors = [], indices = [];', "const positions = [], uv = [], colors = [], indices = [], semantics = []; let region = 'palm';")
  .replace('points.push(point.clone()); positions.push', 'semantics.push({ part: region, kind, u, v }); points.push(point.clone()); positions.push')
  .replace('return { positions, uv, colors, indices, points, vertex, triangle, strip };', 'return { positions, uv, colors, indices, points, vertex, triangle, strip, semantics, setRegion: value => { region = value; } };')
  .replace('const center = root.reduce', 'mesh.setRegion(digit.name); const center = root.reduce')
  .replace('const key = `${index}:${', 'const key = `${index}:${');
// UV repair duplicates must retain anatomical identity.
source = source.replaceAll('mesh.points.push(p.clone()); mesh.positions.push', 'mesh.semantics.push({ ...mesh.semantics[index] }); mesh.points.push(p.clone()); mesh.positions.push');
source = source.replaceAll('mesh.points.push(mesh.points[index].clone()); mesh.positions.push', 'mesh.semantics.push({ ...mesh.semantics[index], seam: true }); mesh.points.push(mesh.points[index].clone()); mesh.positions.push');
// Angular seam repairs use a different point name in the current builder.
source = source.replaceAll('mesh.points.push(point.clone()); mesh.positions.push', 'mesh.semantics.push({ ...mesh.semantics[index] }); mesh.points.push(point.clone()); mesh.positions.push');
source = source.replace('const used = new Set(mesh.indices), remap = new Map(), positions = [], uv = [], colors = [];', 'const used = new Set(mesh.indices), remap = new Map(), positions = [], uv = [], colors = [], semantics = [];')
  .replace('remap.set(i, positions.length / 3); positions.push', 'semantics.push(mesh.semantics[i]); remap.set(i, positions.length / 3); positions.push')
  .replace('mesh.positions = positions; mesh.uv = uv;', 'mesh.semantics = semantics; mesh.positions = positions; mesh.uv = uv;')
  .replace('geometry.userData.authoredHand = { kind:', 'geometry.userData.semantics = mesh.semantics; geometry.userData.authoredHand = { kind:');
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const radii = [null, .015, .022, .030, .034, .036, .038, .040];
const result = radii.map(radius => { const geo = module.getProceduralHandGeometry(1, radius); if (geo.userData.semantics.length !== geo.attributes.position.count || geo.userData.semantics.some(x=>!x)) throw new Error('Semantic correspondence failed'); return { key: radius === null ? 'fist' : `grip-${String(Math.round(radius*1000)).padStart(3,'0')}`, vertices: geo.userData.semantics }; });
await writeFile(process.argv[2], JSON.stringify(result));
