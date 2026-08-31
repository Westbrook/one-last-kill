import * as THREE from 'three';
import { createHumanoidRig, HUMANOID_GEOMETRY } from './humanoid-rig.js';
import { applyBoxWorldUV } from './world-uv.js';

// Keep the public geometry cache while the articulated rig owns its shapes.
const _HG = HUMANOID_GEOMETRY;

// Legacy sedan parts retained for the objective car. Civilian vehicles use
// their own shared variant meshes; these size-invariant wheels, hubs, lugs,
// spokes, mirrors, trim slats, antennas and plates keep its startup bounded.
// Body / hood / cabin / roof are still per-car since their box dimensions
// scale with the `length`/`width`/`height` option.
const _CG = {
  wheel:      new THREE.CylinderGeometry(0.35, 0.35, 0.30, 22),
  hub:        new THREE.CylinderGeometry(0.13, 0.13, 0.32, 14),
  lug:        new THREE.SphereGeometry(0.022, 6, 4),
  // Tapered rim spoke — slightly narrower at the centre than at the rim.
  spoke:      new THREE.BoxGeometry(0.02, 0.28, 0.04),
  wheelWell:  new THREE.TorusGeometry(0.42, 0.05, 6, 16),
  headlight:  new THREE.CylinderGeometry(0.12, 0.12, 0.08, 18),
  headBezel:  new THREE.TorusGeometry(0.13, 0.018, 6, 14),
  taillight:  new THREE.CylinderGeometry(0.09, 0.09, 0.06, 14),
  mirror:     new THREE.BoxGeometry(0.13, 0.08, 0.06),
  mirrorArm:  new THREE.BoxGeometry(0.04, 0.025, 0.06),
  antenna:    new THREE.CylinderGeometry(0.008, 0.008, 0.45, 6),
  // Front grille slat — thin vertical chrome bar.
  grilleSlat: new THREE.BoxGeometry(0.04, 0.10, 0.03),
  // License plate panels.
  plate:      new THREE.BoxGeometry(0.04, 0.10, 0.30),
  // Door handle (was an inline box).
  doorHandle: new THREE.BoxGeometry(0.18, 0.04, 0.03),
  // Unit-size pieces for per-car body trim (scaled per-instance).
  unitBox:    new THREE.BoxGeometry(1, 1, 1),
};

// Shared building-detail geometries — sills, lintels, trim bands, conduit,
// junction boxes, parapet caps. Unit-size primitives are transformed and
// pushed into per-material buckets via pushDecor(); buildZone() then calls
// flushDecor() once per zone to MERGE each bucket into a SINGLE BufferGeometry,
// collapsing what would be ~40 individual meshes into 1-3 draw calls/zone.
// No colliders are emitted so the walkable layout cannot regress.
const _BG = {
  unitBox: new THREE.BoxGeometry(1, 1, 1),
  pipe:    new THREE.CylinderGeometry(1, 1, 1, 12),
};
const _decorBuckets = new Map();
const _decorMat4    = new THREE.Matrix4();
const _decorScale   = new THREE.Matrix4();
const _decorRot     = new THREE.Matrix4();
const _decorTrans   = new THREE.Matrix4();
function pushDecor(geo, mat, cx, cy, cz, sx, sy, sz, rotY = 0) {
  const g = geo.clone();
  _decorScale.makeScale(sx, sy, sz);
  _decorRot.makeRotationY(rotY);
  _decorTrans.makeTranslation(cx, cy, cz);
  _decorMat4.copy(_decorTrans).multiply(_decorRot).multiply(_decorScale);
  g.applyMatrix4(_decorMat4);
  if (geo === _BG.unitBox) applyBoxWorldUV(g, mat.userData?.surfaceMeters);
  let bucket = _decorBuckets.get(mat);
  if (!bucket) { bucket = []; _decorBuckets.set(mat, bucket); }
  bucket.push(g);
}
function _mergeAttrGeometries(geos) {
  let totalVerts = 0, totalIdx = 0;
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIdx   += g.index ? g.index.count : g.attributes.position.count;
  }
  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const uvs       = new Float32Array(totalVerts * 2);
  const indices   = totalVerts > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
  let pO = 0, nO = 0, uO = 0, iO = 0, vBase = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const u = g.attributes.uv.array;
    positions.set(p, pO); pO += p.length;
    normals.set(n, nO);   nO += n.length;
    uvs.set(u, uO);       uO += u.length;
    const idx = g.index ? g.index.array : null;
    if (idx) {
      for (let k = 0; k < idx.length; k++) indices[iO++] = idx[k] + vBase;
    } else {
      for (let k = 0; k < g.attributes.position.count; k++) indices[iO++] = k + vBase;
    }
    vBase += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}
function flushDecor(parent) {
  for (const [mat, geos] of _decorBuckets) {
    if (geos.length === 0) continue;
    const merged = _mergeAttrGeometries(geos);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = false; mesh.receiveShadow = true;
    parent.add(mesh);
    for (const g of geos) g.dispose();
  }
  _decorBuckets.clear();
}

function makeHumanoid(opts = {}) {
  const o = {
    skin: '#caa590', shirt: '#3a3a44', shirtAccent: '#1a1a1f',
    pants: '#1d1d24', hair: '#1c1410', height: 1.78, build: 1,
    seed: 1, kind: 'adult', ...opts,
  };
  return createHumanoidRig(o);
}

// Civilian and combat appearances share the same articulated anatomy.
const HUMANOID_PRESETS = {
  thug:    { skin: '#c39780', shirt: '#41464a', shirtAccent: '#6a5a51', pants: '#2b3036', hair: '#0e0a08', height: 1.82, build: 1.05, seed: 11, kind: 'thug' },
  brawler: { skin: '#c09072', shirt: '#646558', shirtAccent: '#868779', pants: '#353b3f', hair: '#211c18', height: 1.78, build: 1, seed: 17, kind: 'brawler' },
  bruiser: { skin: '#b78a72', shirt: '#51483b', shirtAccent: '#766957', pants: '#34342e', hair: '#1a0e08', height: 1.92, build: 1.25, seed: 12, kind: 'bruiser' },
  shopkeeper: { skin: '#c8a78a', shirt: '#b0a070', shirtAccent: '#704020', pants: '#3a2a18', hair: '#2a1a10', height: 1.74, build: 1.0, seed: 13, kind: 'shopkeeper' },
  woman:   { skin: '#d0a890', shirt: '#5a2a48', shirtAccent: '#80405a', pants: '#222028', hair: '#3a1a10', height: 1.66, build: 0.92, seed: 14, kind: 'woman' },
  child:   { skin: '#d8b095', shirt: '#3a6a3a', shirtAccent: '#a0c060', pants: '#283050', hair: '#5a3a18', height: 1.28, build: 0.78, seed: 15, kind: 'child' },
  player:  { skin: '#c39780', shirt: '#262626', shirtAccent: '#5a1818', pants: '#161616', hair: '#0a0a08', height: 1.84, build: 1.1, seed: 16, kind: 'player' },
};

export { makeHumanoid, HUMANOID_PRESETS, _HG, _CG, _BG, pushDecor, flushDecor };
