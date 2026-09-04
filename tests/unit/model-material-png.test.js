import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { crc32, decodeMaterialPNG } from '../../tools/lib/model-material-png.mjs';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, bytes = Buffer.alloc(0)) {
  const data = Buffer.from(bytes), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function ihdr({ width = 1, height = 1, bitDepth = 8, colorType = 6, compression = 0, filter = 0, interlace = 0 } = {}) {
  const data = Buffer.alloc(13); data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data.set([bitDepth, colorType, compression, filter, interlace], 8);
  return chunk('IHDR', data);
}
function png(raw = [0, 100, 130, 170, 255], options = {}, extra = []) {
  return Buffer.concat([signature, ihdr(options), ...extra, chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND')]);
}
const decode = (bytes, options) => decodeMaterialPNG(bytes, options);

test('PNG CRC matches the published IEEE check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('RGBA samples survive all five scanline filters including Paeth edge cases', () => {
  // Two RGBA pixels per row. Rows exercise None, Sub, Up, Average and Paeth.
  // These encoded bytes are fixed independently of the decoder.
  const raw = [
    0, 10, 20, 30, 255, 50, 60, 70, 128,
    1, 12, 18, 45, 250, 88, 72, 35, 133,
    2, 238, 6, 6, 250, 1, 16, 31, 131,
    3, 128, 5, 5, 5, 202, 127, 195, 179,
    4, 246, 24, 230, 155, 197, 123, 224, 71,
  ];
  const decoded = decode(png(raw, { width: 2, height: 5 }));
  assert.equal(decoded.channels, 4); assert.equal(decoded.bitDepth, 8);
  assert.deepEqual([...decoded.pixels], [
    10, 20, 30, 255, 50, 60, 70, 128,
    12, 18, 45, 250, 100, 90, 80, 127,
    250, 24, 51, 244, 101, 106, 111, 2,
    253, 17, 30, 127, 123, 188, 9, 243,
    243, 41, 4, 26, 64, 55, 228, 198,
  ]);
});

test('gray, gray-alpha and RGB expand to RGBA, with explicit 16-bit alpha preserved', () => {
  assert.deepEqual([...decode(png([0, 77], { colorType: 0 })).pixels], [77, 77, 77, 255]);
  assert.deepEqual([...decode(png([0, 77, 128], { colorType: 4 })).pixels], [77, 77, 77, 128]);
  assert.deepEqual([...decode(png([0, 9, 10, 11], { colorType: 2 })).pixels], [9, 10, 11, 255]);
  const rgba16 = decode(png([0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], { bitDepth: 16 }));
  assert.deepEqual([...rgba16.pixels], [0x12, 0x56, 0x9a, 0xde]); assert.equal(rgba16.bitDepth, 16);
  assert.deepEqual([...decode(png([0, 0xab, 1, 0x45, 255], { bitDepth: 16, colorType: 4 })).pixels], [0xab, 0xab, 0xab, 0x45]);
  assert.deepEqual([...decode(png([0, 0xab, 1], { bitDepth: 16, colorType: 0 })).pixels], [0xab, 0xab, 0xab, 255]);
  const rgb16Sub = decode(png([1, 18, 52, 86, 120, 154, 188, 16, 237, 251, 139, 253, 88], { width: 2, colorType: 2, bitDepth: 16 }));
  assert.deepEqual([...rgb16Sub.pixels], [18, 86, 154, 255, 34, 81, 151, 255]);
});

test('opacity uses original sample precision before downconverting 16-bit alpha', () => {
  for (const colorType of [4, 6]) {
    const color = colorType === 4 ? [30, 90] : [30, 90, 40, 80, 50, 70];
    const opaque = decode(png([0, ...color, 255, 255], { colorType, bitDepth: 16 }));
    const translucent = decode(png([0, ...color, 255, 254], { colorType, bitDepth: 16 }));
    assert.equal(opaque.opaque, true);
    assert.equal(translucent.opaque, false, '65534 must not become fully opaque through RGBA8 downconversion');
    assert.equal(translucent.pixels[3], 255, 'The opacity flag retains precision that RGBA8 cannot represent');
  }
  assert.equal(decode(png([0, 30, 255], { colorType: 4 })).opaque, true);
  assert.equal(decode(png([0, 30, 254], { colorType: 4 })).opaque, false);
  assert.equal(decode(png([0, 30, 40, 50], { colorType: 2 })).opaque, true);
});

test('PNG signature, chunk truncation and CRC errors fail before decoding', () => {
  const badSignature = png(); badSignature[7] ^= 1;
  assert.throws(() => decode(badSignature), /signature/);
  const badCRC = png(); badCRC[badCRC.length - 1] ^= 1;
  assert.throws(() => decode(badCRC), /CRC mismatch in IEND/);
  const badData = png(); badData[45] ^= 1;
  assert.throws(() => decode(badData), /CRC mismatch in IDAT/);
  assert.throws(() => decode(png().subarray(0, -2)), /truncated/);
  assert.throws(() => decode(Buffer.concat([signature, Buffer.from([0, 0, 0, 0])])), /truncated/);
  const hugeChunk = Buffer.concat([signature, Buffer.alloc(12)]); hugeChunk.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => decode(hugeChunk), /oversized/);
});

test('dimensions and byte budgets are checked before any zlib allocation', () => {
  for (const dimensions of [{ width: 0 }, { height: 0 }, { width: 2049 }, { height: 2049 }, { width: 0xffffffff, height: 0xffffffff }]) {
    assert.throws(() => decode(Buffer.concat([signature, ihdr(dimensions), chunk('IDAT', [0]), chunk('IEND')])), /dimensions/);
  }
  assert.throws(() => decode(png([], { width: 2, height: 2 }), { maxPixels: 3 }), /pixel budget/);
  assert.throws(() => decode(png(), { maxBytes: 10 }), /byte budget/);
  assert.throws(() => decode(png(), { maxDimension: -1 }), /positive safe integer/);
  assert.throws(() => decode(png(), { maxPixels: Infinity }), /positive safe integer/);
});

test('unsupported data layouts and transparency are rejected explicitly', () => {
  for (const options of [{ colorType: 3 }, { colorType: 1 }, { bitDepth: 4 }, { interlace: 1 }, { filter: 1 }, { compression: 1 }]) {
    assert.throws(() => decode(png([], options)), /unsupported|interlaced/);
  }
  assert.throws(() => decode(png([0, 0x12, 0x34], { colorType: 0, bitDepth: 16 }, [chunk('tRNS', [0x12, 0x34])])), /tRNS transparency/);
  assert.throws(() => decode(png([0, 1, 2, 3], { colorType: 2 }, [chunk('tRNS', [0, 1, 0, 2, 0, 3])])), /tRNS transparency/);
});

test('chunk ordering, duplicate headers, unknown critical chunks and trailing file bytes fail', () => {
  const data = chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 4])));
  const assemble = chunks => Buffer.concat([signature, ...chunks]);
  assert.throws(() => decode(assemble([chunk('tEXt', [1]), ihdr(), data, chunk('IEND')])), /IHDR must be first/);
  assert.throws(() => decode(assemble([ihdr(), ihdr(), data, chunk('IEND')])), /unique/);
  assert.throws(() => decode(assemble([ihdr(), data, chunk('tEXt'), data, chunk('IEND')])), /contiguous/);
  assert.throws(() => decode(assemble([ihdr(), chunk('IEND')])), /nonempty IDAT/);
  assert.throws(() => decode(assemble([ihdr(), data])), /missing IEND/);
  assert.throws(() => decode(assemble([ihdr(), data, chunk('IEND', [0])])), /IEND must be empty/);
  assert.throws(() => decode(Buffer.concat([png(), Buffer.from([0])])), /trailing bytes/);
  assert.throws(() => decode(png(undefined, {}, [chunk('ABCD')])), /unknown critical/);
  assert.throws(() => decode(png(undefined, {}, [chunk('abca')])), /invalid chunk type/);
  assert.throws(() => decode(assemble([ihdr(), data, chunk('pHYs', Buffer.alloc(9)), chunk('IEND')])), /precede IDAT/);
  assert.throws(() => decode(png(undefined, {}, [chunk('gAMA', [0, 0, 0, 1]), chunk('gAMA', [0, 0, 0, 1])])), /duplicate/);
});

test('ancillary chunks are bounded and CRC checked, and contiguous IDAT is supported', () => {
  const encoded = deflateSync(Buffer.from([0, 10, 20, 30, 40]));
  const file = Buffer.concat([signature, ihdr(), chunk('tEXt', [97, 0, 98]), chunk('IDAT', encoded.subarray(0, 3)), chunk('IDAT'), chunk('IDAT', encoded.subarray(3)), chunk('tEXt'), chunk('IEND')]);
  assert.deepEqual([...decode(file).pixels], [10, 20, 30, 40]);
  const badAncillary = chunk('tEXt', [1]); badAncillary[8] ^= 1;
  assert.throws(() => decode(png(undefined, {}, [badAncillary])), /CRC mismatch in tEXt/);
  assert.throws(() => decode(png(undefined, {}, Array.from({ length: 4096 }, () => chunk('tEXt')))), /chunk count/);
});

test('bad filters, truncated streams, expanded-size mismatch and extra compressed input fail', () => {
  assert.throws(() => decode(png([5, 1, 2, 3, 4])), /scanline filter/);
  assert.throws(() => decode(png([0, 1, 2, 3])), /expanded byte count/);
  assert.throws(() => decode(png([0, 1, 2, 3, 4, 5])), /over-budget zlib/);
  const encoded = deflateSync(Buffer.from([0, 1, 2, 3, 4]));
  for (const extra of [Buffer.from([1, 2, 3]), deflateSync(Buffer.from([0, 9, 9, 9, 9]))]) {
    assert.throws(() => decode(Buffer.concat([signature, ihdr(), chunk('IDAT', Buffer.concat([encoded, extra])), chunk('IEND')])), /trailing compressed data/);
  }
  assert.throws(() => decode(Buffer.concat([signature, ihdr(), chunk('IDAT', encoded.subarray(0, -1)), chunk('IEND')])), /zlib stream/);
});
