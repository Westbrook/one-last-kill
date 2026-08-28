import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyBoxWorldUV } from '../../src/render/world-uv.js';

test('world surface tiles retain their physical scale on long and short boxes', () => {
  for (const width of [1, 4, 40]) {
    const box = new THREE.BoxGeometry(width, 2, 3);
    applyBoxWorldUV(box, 2, { x: 10, y: 4, z: -3 });
    const uv = box.attributes.uv;
    // BoxGeometry stores its +Y face at vertices 8..11.
    const span = Math.max(...[8, 9, 10, 11].map(i => uv.getX(i)))
      - Math.min(...[8, 9, 10, 11].map(i => uv.getX(i)));
    assert.equal(span, width / 2);
    box.dispose();
  }
});

test('adjacent surfaces share texture phase at their physical seam', () => {
  const a = new THREE.BoxGeometry(4, 2, 1), b = new THREE.BoxGeometry(4, 2, 1);
  applyBoxWorldUV(a, 2, { x: -2, y: 2, z: 0 });
  applyBoxWorldUV(b, 2, { x: 2, y: 2, z: 0 });
  const seam = (g, localX) => {
    const out = [];
    for (let i = 0; i < g.attributes.position.count; i++) {
      if (g.attributes.normal.getZ(i) > 0.9 && g.attributes.position.getX(i) === localX) {
        out.push([g.attributes.uv.getX(i), g.attributes.uv.getY(i)]);
      }
    }
    return out.sort((x, y) => x[1] - y[1]);
  };
  assert.deepEqual(seam(a, 2), seam(b, -2));
  a.dispose(); b.dispose();
});

test('materials without a world span retain object UVs', () => {
  const box = new THREE.BoxGeometry(2, 2, 2);
  const before = [...box.attributes.uv.array];
  for (const scale of [undefined, 0, -2, NaN]) applyBoxWorldUV(box, scale);
  assert.deepEqual([...box.attributes.uv.array], before);
  box.dispose();
});
