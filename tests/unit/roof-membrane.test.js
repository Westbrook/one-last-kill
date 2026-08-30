import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyRoofMembraneFinish, bakeRoofMembraneData, ROOF_MEMBRANE_DIAGNOSTICS,
} from '../../src/render/roof-membrane.js';

function shader() {
  return {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
}

function bilinearRepeat(image, u, v, channel) {
  const wrap = value => ((value % image.width) + image.width) % image.width;
  const x = u * image.width - 0.5, y = v * image.height - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
  const sample = (px, py) => image.data[(wrap(py) * image.width + wrap(px)) * 4 + channel];
  return (sample(ix, iy) * (1 - tx) + sample(ix + 1, iy) * tx) * (1 - ty)
    + (sample(ix, iy + 1) * (1 - tx) + sample(ix + 1, iy + 1) * tx) * ty;
}

test('roof macro bake is deterministic, bounded and preserves repeat sampling at both borders', () => {
  const a = bakeRoofMembraneData(), b = bakeRoofMembraneData();
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.data, bakeRoofMembraneData({ seed: 18237 }).data);
  assert.equal(a.width, 128); assert.equal(a.height, 128);
  assert.equal(a.data.byteLength, ROOF_MEMBRANE_DIAGNOSTICS.textureBytes);
  for (let i = 0; i < a.width; i++) {
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(a.data[(i * a.width) * 4 + channel], a.data[(i * a.width + a.width - 1) * 4 + channel]);
      assert.equal(a.data[i * 4 + channel], a.data[((a.height - 1) * a.width + i) * 4 + channel]);
      const uv = (i + 0.31) / a.width;
      assert.ok(Math.abs(bilinearRepeat(a, -0.000001, uv, channel) - bilinearRepeat(a, 0.000001, uv, channel)) < 0.001);
      assert.ok(Math.abs(bilinearRepeat(a, uv, -0.000001, channel) - bilinearRepeat(a, uv, 0.000001, channel)) < 0.001);
      assert.ok(Math.abs(bilinearRepeat(a, uv, 0.42, channel) - bilinearRepeat(a, uv + 1, -0.58, channel)) < 1e-9);
    }
  }
});

test('macro encoded fields describe restrained dry material variation rather than painted shadows or opacity', () => {
  const { data } = bakeRoofMembraneData();
  let brightTotal = 0, repaired = 0, darkest = 2, brightest = 0;
  let roughest = 0, smoothest = 1, toneMin = 255, toneMax = 0;
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i + 3], 255);
    const tone = data[i] / 255, weather = data[i + 1] / 255, repair = data[i + 2] / 255;
    const multiplier = (1.03 + 0.42 * tone) * (1 - 0.14 * repair);
    const roughness = 0.91 + (weather - 0.5) * 0.08 - repair * 0.020;
    brightTotal += multiplier;
    darkest = Math.min(darkest, multiplier); brightest = Math.max(brightest, multiplier);
    smoothest = Math.min(smoothest, roughness); roughest = Math.max(roughest, roughness);
    toneMin = Math.min(toneMin, data[i]); toneMax = Math.max(toneMax, data[i]);
    if (repair > 0.25) repaired++;
  }
  assert.ok(toneMax - toneMin > 65, 'macro variation survives byte encoding');
  assert.ok(darkest > 0.95 && brightest < 1.42, 'existing albedo receives a modest neutral gain');
  const averageGain = brightTotal / (data.length / 4);
  assert.ok(averageGain > 1.15 && averageGain < 1.30);
  assert.ok(smoothest > 0.85 && roughest < 0.96, 'no mirror-like repair patches');
  assert.ok(repaired / (data.length / 4) > 0.035 && repaired / (data.length / 4) < 0.17, 'sparse repair coverage');
});

test('bake validates dimensions and seeds without browser or renderer state', () => {
  for (const size of [0, 16, 33, 127, 512, NaN, Infinity]) {
    assert.throws(() => bakeRoofMembraneData({ size }), RangeError);
  }
  for (const seed of [NaN, Infinity, 0.3, '12']) assert.throws(() => bakeRoofMembraneData({ seed }), RangeError);
  assert.equal(bakeRoofMembraneData({ size: 32, seed: -12 }).data.length, 32 * 32 * 4);
});

test('finish clones only the deck material and shares one immutable-upload macro texture across sources', () => {
  const source = new THREE.MeshStandardMaterial({
    map: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture(),
    color: 0x9a9e98, roughness: 0.92, metalness: 0, normalScale: new THREE.Vector2(0.6, 0.6),
  });
  source.userData = { surfaceMeters: 2, staticSurfaceMaps: true };
  const originalCompile = source.onBeforeCompile, originalKey = source.customProgramCacheKey;
  const finish = applyRoofMembraneFinish(source);
  assert.notEqual(finish, source);
  assert.equal(applyRoofMembraneFinish(source), finish);
  assert.equal(applyRoofMembraneFinish(finish), finish);
  assert.equal(source.onBeforeCompile, originalCompile); assert.equal(source.customProgramCacheKey, originalKey);
  assert.deepEqual(source.userData, { surfaceMeters: 2, staticSurfaceMaps: true });
  assert.equal(source.roofMembraneMap, undefined);
  for (const property of ['map', 'normalMap', 'roughnessMap']) assert.equal(finish[property], source[property]);
  for (const property of ['roughness', 'metalness', 'transparent', 'depthWrite', 'side']) assert.equal(finish[property], source[property]);
  assert.deepEqual(finish.color, source.color); assert.deepEqual(finish.normalScale, source.normalScale);
  const macro = finish.roofMembraneMap, version = macro.version;
  assert.equal(applyRoofMembraneFinish(new THREE.MeshStandardMaterial()).roofMembraneMap, macro);
  assert.equal(macro.version, version, 'reuse does not dirty the texture');
  assert.equal(macro.isDataTexture, true);
  assert.equal(macro.format, THREE.RGBAFormat); assert.equal(macro.type, THREE.UnsignedByteType);
  assert.equal(macro.colorSpace, THREE.NoColorSpace);
  assert.equal(macro.wrapS, THREE.RepeatWrapping); assert.equal(macro.wrapT, THREE.RepeatWrapping);
  assert.equal(macro.minFilter, THREE.LinearMipmapLinearFilter); assert.equal(macro.magFilter, THREE.LinearFilter);
  assert.equal(macro.flipY, false); assert.equal(macro.generateMipmaps, true);
  assert.equal(macro.anisotropy, 4);
  let bytes = 0;
  for (let size = macro.image.width; size >= 1; size /= 2) bytes += size * size * 4;
  assert.equal(bytes, ROOF_MEMBRANE_DIAGNOSTICS.textureBytesWithMipmaps);
  assert.ok(bytes < 86 * 1024);
  assert.equal(finish.userData.roofMembraneFinish, ROOF_MEMBRANE_DIAGNOSTICS);
  for (const property of ['extraDrawCallsPerMesh', 'extraTriangles', 'extraPasses', 'perFrameUpdates']) assert.equal(ROOF_MEMBRANE_DIAGNOSTICS[property], 0);
});

test('existing compile callbacks execute with the clone and native cache keys keep prior hook identity', () => {
  const source = new THREE.MeshStandardMaterial(), other = new THREE.MeshStandardMaterial();
  let seenMaterial, seenRenderer;
  source.onBeforeCompile = function(shader, renderer) {
    seenMaterial = this; seenRenderer = renderer;
    shader.uniforms.priorFinish = { value: 13 };
    shader.fragmentShader += '\n// first existing finish';
  };
  other.onBeforeCompile = function(shader) { shader.fragmentShader += '\n// second existing finish'; };
  const firstKey = source.customProgramCacheKey(), secondKey = other.customProgramCacheKey();
  assert.notEqual(firstKey, secondKey);
  const finish = applyRoofMembraneFinish(source), otherFinish = applyRoofMembraneFinish(other);
  assert.equal(finish.customProgramCacheKey(), `${firstKey}:${ROOF_MEMBRANE_DIAGNOSTICS.version}`);
  assert.equal(otherFinish.customProgramCacheKey(), `${secondKey}:${ROOF_MEMBRANE_DIAGNOSTICS.version}`);
  assert.notEqual(finish.customProgramCacheKey(), otherFinish.customProgramCacheKey());
  const compiled = shader(), renderer = {};
  finish.onBeforeCompile(compiled, renderer);
  assert.equal(seenMaterial, finish); assert.equal(seenRenderer, renderer);
  assert.equal(compiled.uniforms.priorFinish.value, 13);
  assert.equal(compiled.uniforms.roofMembraneMap.value, finish.roofMembraneMap);
  assert.ok(compiled.fragmentShader.includes('// first existing finish'));
  assert.ok(compiled.fragmentShader.includes('#include <normal_fragment_maps>'), 'original micro normal stage retained');
  assert.ok(compiled.fragmentShader.includes('#include <map_fragment>'));
  assert.ok(compiled.fragmentShader.includes('#include <roughnessmap_fragment>'));
  assert.ok(compiled.vertexShader.includes('vRoofMembraneUv = uv * 0.125;'), '2 m metric UV becomes a 16 m macro repeat');
  assert.equal(compiled.fragmentShader.match(/texture2D\(roofMembraneMap,/g)?.length, 1);
});

test('custom cache key closures remain bound to the original material and incompatible shaders fail closed', () => {
  const source = new THREE.MeshStandardMaterial();
  let revision = 2;
  source.userData.keyTag = 'existing';
  source.customProgramCacheKey = function() { return `${this.userData.keyTag}-${revision}`; };
  source.onBeforeCompile = shader => { shader.uniforms.kept = { value: true }; };
  const finish = applyRoofMembraneFinish(source);
  finish.userData.keyTag = 'clone';
  assert.equal(finish.customProgramCacheKey(), `existing-2:${ROOF_MEMBRANE_DIAGNOSTICS.version}`);
  revision = 3;
  assert.equal(finish.customProgramCacheKey(), `existing-3:${ROOF_MEMBRANE_DIAGNOSTICS.version}`);
  const incompatible = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
  finish.onBeforeCompile(incompatible, {});
  assert.equal(incompatible.uniforms.kept.value, true);
  assert.equal(incompatible.uniforms.roofMembraneMap, undefined);
  assert.equal(incompatible.vertexShader, 'void main() {}');
  assert.equal(incompatible.fragmentShader, 'void main() {}');
  assert.equal(finish.userData.roofMembraneFallback, true);
  assert.throws(() => applyRoofMembraneFinish(new THREE.MeshBasicMaterial()), TypeError);
});
