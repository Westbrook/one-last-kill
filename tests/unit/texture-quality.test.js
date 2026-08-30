import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePixelError, measureNormalError } from '../../tools/texture-quality.mjs';

function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('exact RGB and RGBA pixels report JSON-safe zero error and ignore alpha', () => {
  const reference = new Uint8Array([12, 128, 255, 7, 80, 41]);
  const decoded = new Uint8Array([12, 128, 255, 0, 7, 80, 41, 255]);
  const beforeReference = reference.slice(), beforeDecoded = decoded.slice();
  const result = measurePixelError(reference, decoded);
  assert.deepEqual(result, {
    normalizedMse: 0, rmse: 0, psnrDb: null, maxAbsoluteError: 0,
    pixelCount: 2, measuredChannels: [0, 1, 2],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(reference, beforeReference);
  assert.deepEqual(decoded, beforeDecoded);
});

test('a known one-channel error is averaged over all measured samples', () => {
  const result = measurePixelError([0, 0, 0, 0, 0, 0], [255, 0, 0, 255, 0, 0, 0, 255]);
  near(result.normalizedMse, 1 / 6);
  near(result.rmse, Math.sqrt(1 / 6));
  near(result.psnrDb, 10 * Math.log10(6));
  assert.equal(result.maxAbsoluteError, 1);
});

test('green-only roughness metrics do not measure unrelated RGB or alpha channels', () => {
  const channels = [1];
  const result = measurePixelError([0, 0, 0, 0, 255, 0], [255, 255, 255, 0, 255, 255, 255, 255], { channels });
  channels[0] = 0;
  assert.deepEqual(result.measuredChannels, [1]);
  assert.equal(result.normalizedMse, 0.5);
  assert.equal(result.maxAbsoluteError, 1);
  assert.equal(result.pixelCount, 2);
});

test('pixel metrics support single-channel strides and normalized numeric input', () => {
  const result = measurePixelError([0, 0.5], [0.25, 0.75], {
    referenceStride: 1, decodedStride: 1, referenceMax: 1, decodedMax: 1, channels: [0],
  });
  assert.equal(result.normalizedMse, 0.0625);
  assert.equal(result.rmse, 0.25);
  assert.equal(result.maxAbsoluteError, 0.25);
});

test('matching 16-bit and 8-bit values compare after independent scaling', () => {
  const reference = new Uint16Array([12 * 257, 128 * 257, 65535]);
  const decoded = new Uint8Array([12, 128, 255, 255]);
  const result = measurePixelError(reference, decoded, { referenceMax: 65535 });
  assert.equal(result.normalizedMse, 0);
  assert.equal(result.psnrDb, null);
  const normal = measureNormalError(reference, decoded, { referenceMax: 65535 });
  assert.equal(normal.maxDegrees, 0);
});

test('explicit alpha measurement and alternate strides are supported', () => {
  const result = measurePixelError([10, 20, 30, 0], [10, 20, 30, 255], {
    referenceStride: 4, decodedStride: 4, channels: [3],
  });
  assert.equal(result.normalizedMse, 1);
  assert.equal(result.psnrDb, 0);
  assert.deepEqual(result.measuredChannels, [3]);
});

test('identical normal directions have exact zero angular error without changing input', () => {
  const reference = new Uint8Array([128, 128, 255, 255, 128, 128]);
  const decoded = new Uint8Array([128, 128, 255, 0, 255, 128, 128, 255]);
  const before = decoded.slice();
  assert.deepEqual(measureNormalError(reference, decoded), {
    meanDegrees: 0, p95Degrees: 0, maxDegrees: 0, invalidNormals: 0, validNormals: 2, pixelCount: 2,
  });
  assert.deepEqual(decoded, before);
});

test('normal metrics report perpendicular directions as ninety degrees', () => {
  const result = measureNormalError(new Uint8Array([2, 1, 1]), new Uint8Array([1, 2, 1, 0]), {
    referenceMax: 2, decodedMax: 2,
  });
  near(result.meanDegrees, 90);
  near(result.p95Degrees, 90);
  near(result.maxDegrees, 90);
});

test('reversed normal directions report 180 degrees', () => {
  const result = measureNormalError([2, 1, 1], [0, 1, 1, 2], { referenceMax: 2, decodedMax: 2 });
  near(result.meanDegrees, 180);
  near(result.p95Degrees, 180);
  near(result.maxDegrees, 180);
});

test('normal comparison normalizes vector lengths and accepts explicit RGB strides', () => {
  const result = measureNormalError([1, 1, 0.5], [0.75, 0.75, 0.5], {
    referenceMax: 1, decodedMax: 1, decodedStride: 3,
  });
  assert.equal(result.meanDegrees, 0);
  assert.equal(result.invalidNormals, 0);
});

test('normal p95 uses nearest rank and does not replace the maximum', () => {
  const reference = [], decoded = [];
  for (let degrees = 99; degrees >= 0; degrees--) {
    const radians = degrees * Math.PI / 180;
    reference.push(1, 0.5, 0.5);
    decoded.push((Math.cos(radians) + 1) / 2, (Math.sin(radians) + 1) / 2, 0.5, 1);
  }
  const result = measureNormalError(reference, decoded, { referenceMax: 1, decodedMax: 1 });
  near(result.meanDegrees, 49.5);
  near(result.p95Degrees, 94);
  near(result.maxDegrees, 99);
  assert.equal(result.pixelCount, 100);
});

test('zero vectors in either or both images count once per invalid pixel and do not enter angle statistics', () => {
  const reference = [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5];
  const decoded = [1, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5, 1, 0.5, 1];
  const result = measureNormalError(reference, decoded, { referenceMax: 1, decodedMax: 1 });
  assert.equal(result.invalidNormals, 3);
  assert.equal(result.validNormals, 1);
  assert.equal(result.pixelCount, 4);
  near(result.meanDegrees, 90);
  near(result.p95Degrees, 90);
  near(result.maxDegrees, 90);
});

test('entirely invalid normals produce null statistics instead of a perfect score', () => {
  const result = measureNormalError([1, 1, 1], [1, 1, 1, 0], { referenceMax: 2, decodedMax: 2 });
  assert.deepEqual(result, {
    meanDegrees: null, p95Degrees: null, maxDegrees: null, invalidNormals: 1, validNormals: 0, pixelCount: 1,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

for (const [name, measure] of [['pixel', measurePixelError], ['normal', measureNormalError]]) {
  test(`${name} metrics reject unsupported arrays, empty images, incomplete pixels, and mismatched counts`, () => {
    for (const reference of [null, 'rgb', new Float32Array([0, 0, 0]), { length: 3, 0: 0, 1: 0, 2: 0 }]) {
      assert.throws(() => measure(reference, [0, 0, 0, 255]), TypeError);
    }
    assert.throws(() => measure([0, 0, 0], new Uint32Array(4)), TypeError);
    for (const [reference, decoded] of [[[], []], [[0, 0], [0, 0, 0, 255]], [[0, 0, 0], [0, 0, 0]], [[0, 0, 0], new Uint8Array(8)]]) {
      assert.throws(() => measure(reference, decoded), RangeError);
    }
  });

  test(`${name} metrics reject malformed options, strides, and channel maxima`, () => {
    for (const options of [null, [], 1, 'options', new Date()]) {
      assert.throws(() => measure([0, 0, 255], [0, 0, 255, 255], options), TypeError);
    }
    for (const key of ['referenceStride', 'decodedStride']) for (const value of [0, -1, 1.5, Infinity, '3', null]) {
      assert.throws(() => measure([0, 0, 255], [0, 0, 255, 255], { [key]: value }), RangeError);
    }
    for (const key of ['referenceMax', 'decodedMax']) for (const value of [0, -1, Infinity, NaN, '255', null]) {
      assert.throws(() => measure([0, 0, 255], [0, 0, 255, 255], { [key]: value }), RangeError);
    }
  });

  test(`${name} metrics validate all values, including unmeasured alpha`, () => {
    for (const value of [NaN, Infinity, -Infinity, undefined, '0']) {
      assert.throws(() => measure([value, 0, 255], [0, 0, 255, 255]), TypeError);
      assert.throws(() => measure([0, 0, 255], [0, 0, 255, value]), TypeError);
    }
    for (const value of [-1, 256]) {
      assert.throws(() => measure([value, 0, 255], [0, 0, 255, 255]), RangeError);
      assert.throws(() => measure([0, 0, 255], [0, 0, 255, value]), RangeError);
    }
    assert.throws(() => measure([0, 0, 255], Array(4)), TypeError);
    assert.throws(() => measure(new Uint16Array([0, 0, 65535]), [0, 0, 255, 255]), RangeError);
  });
}

test('pixel channels must be nonempty, unique integer indices available in both images', () => {
  for (const channels of [null, [], 'rgb', new Uint8Array([0, 1, 2])]) {
    assert.throws(() => measurePixelError([0, 0, 0], [0, 0, 0, 255], { channels }), TypeError);
  }
  for (const channels of [[0, 0], [-1], [0.5], [3], [NaN], ['1']]) {
    assert.throws(() => measurePixelError([0, 0, 0], [0, 0, 0, 255], { channels }), RangeError);
  }
  assert.throws(() => measurePixelError([0, 0, 0, 255], [0, 0, 0], { referenceStride: 4, decodedStride: 3, channels: [3] }), RangeError);
});

test('normal metrics require all three RGB components in each stride', () => {
  assert.throws(() => measureNormalError([0, 255], [0, 0, 255, 255], { referenceStride: 2 }), RangeError);
  assert.throws(() => measureNormalError([0, 0, 255], [0, 255], { decodedStride: 2 }), RangeError);
});
