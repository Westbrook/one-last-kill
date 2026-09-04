import { inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COMPONENTS = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]);
const MAX_CHUNKS = 4096;
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function reject(message) { throw new Error(`Invalid material PNG: ${message}`); }
function checkLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode the noninterlaced 8/16-bit gray, gray-alpha, RGB and RGBA PNGs emitted
 * by Blender. `channels` and `bitDepth` describe the source; `pixels` is always
 * RGBA8. A 16-bit sample becomes its high byte. `opaque` checks alpha at its
 * original precision so downconversion cannot hide translucent samples.
 * No metadata is decompressed.
 * maxBytes bounds the entire encoded file; maxPixels bounds the output image.
 */
export function decodeMaterialPNG(bytes, { maxDimension = 2048, maxPixels = 4194304, maxBytes = 16777216 } = {}) {
  checkLimit(maxDimension, 'maxDimension'); checkLimit(maxPixels, 'maxPixels'); checkLimit(maxBytes, 'maxBytes');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('PNG bytes must be a Uint8Array or Buffer');
  if (bytes.byteLength > maxBytes) reject('encoded file exceeds byte budget');
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (input.length < SIGNATURE.length || !input.subarray(0, 8).equals(SIGNATURE)) reject('signature mismatch');
  let offset = 8, chunks = 0, header, ended = false, idatState = 0, compressedLength = 0;
  const compressed = [], seen = new Set();
  const beforePalette = new Set(['cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB']);
  const beforeData = new Set(['bKGD', 'hIST', 'pHYs', ...beforePalette]);
  const unique = new Set(['PLTE', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'pHYs', 'tIME', 'eXIf']);
  while (offset < input.length) {
    if (++chunks > MAX_CHUNKS) reject('chunk count exceeds limit');
    if (input.length - offset < 12) reject('truncated chunk header');
    const length = input.readUInt32BE(offset);
    if (length > 0x7fffffff || length > maxBytes || length > input.length - offset - 12) reject('truncated or oversized chunk');
    const typeBytes = input.subarray(offset + 4, offset + 8), type = typeBytes.toString('ascii');
    if (!typeBytes.every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || (typeBytes[2] & 32)) reject('invalid chunk type');
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCRC = input.readUInt32BE(offset + 8 + length);
    if (crc32(input.subarray(offset + 4, offset + 8 + length)) !== expectedCRC) reject(`CRC mismatch in ${type}`);
    offset += 12 + length;
    if (!header && type !== 'IHDR') reject('IHDR must be first');
    if (idatState === 1 && type !== 'IDAT') idatState = 2;
    if (unique.has(type) && seen.has(type)) reject(`duplicate ${type}`);
    if (beforeData.has(type) && idatState !== 0) reject(`${type} must precede IDAT`);
    if (beforePalette.has(type) && seen.has('PLTE')) reject(`${type} must precede PLTE`);
    if (type === 'IHDR') {
      if (header || chunks !== 1 || length !== 13) reject('IHDR must be first, unique, and 13 bytes');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), bitDepth = data[8], colorType = data[9];
      if (!width || !height || width > maxDimension || height > maxDimension || width * height > maxPixels) reject('dimensions exceed pixel budget or are zero');
      const channels = COMPONENTS.get(colorType);
      if (!channels || ![8, 16].includes(bitDepth)) reject('unsupported color type or bit depth (palette PNGs are not accepted)');
      if (data[10] !== 0 || data[11] !== 0) reject('unsupported compression or filter method');
      if (data[12] !== 0) reject('interlaced PNGs are not accepted');
      const stride = width * channels * (bitDepth / 8), expandedBytes = (stride + 1) * height;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > 0x7fffffff || width * height * 4 > 0x7fffffff) reject('decoded image exceeds allocation limit');
      header = { width, height, bitDepth, colorType, channels, stride, expandedBytes };
    } else if (type === 'IDAT') {
      if (idatState === 2) reject('IDAT chunks must be contiguous');
      idatState = 1; compressed.push(data); compressedLength += length;
    } else if (type === 'IEND') {
      if (length !== 0 || compressedLength === 0) reject('IEND must be empty and follow nonempty IDAT');
      if (offset !== input.length) reject('trailing bytes after IEND');
      ended = true; break;
    } else if (type === 'PLTE') {
      if (idatState !== 0 || [0, 4].includes(header.colorType) || !length || length % 3 || length > 768) reject('invalid PLTE contents or order');
    } else if (type === 'tRNS') {
      reject('tRNS transparency is not accepted; export explicit RGBA or grayscale-alpha');
    } else if (!(typeBytes[0] & 32)) {
      reject(`unknown critical chunk ${type}`);
    }
    seen.add(type);
  }
  if (!ended) reject('missing IEND');
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(compressed, compressedLength), { maxOutputLength: header.expandedBytes, info: true });
  } catch (error) {
    reject(`invalid or over-budget zlib stream (${error.code || error.message})`);
  }
  if (inflated.buffer.length !== header.expandedBytes) reject('unexpected expanded byte count');
  if (inflated.engine.bytesWritten !== compressedLength) reject('trailing compressed data');
  const { width, height, bitDepth, colorType, channels, stride } = header;
  const sampleBytes = bitDepth / 8, pixelBytes = channels * sampleBytes, grayscale = colorType === 0 || colorType === 4;
  const alphaOffset = colorType === 4 ? sampleBytes : colorType === 6 ? sampleBytes * 3 : -1;
  const pixels = new Uint8Array(width * height * 4);
  let opaque = true;
  let previous = new Uint8Array(stride), row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = inflated.buffer[start];
    if (filter > 4) reject(`unsupported scanline filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const left = x >= pixelBytes ? row[x - pixelBytes] : 0;
      const up = previous[x], upperLeft = x >= pixelBytes ? previous[x - pixelBytes] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[x] = (inflated.buffer[start + 1 + x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const source = x * pixelBytes, target = (y * width + x) * 4;
      pixels[target] = row[source];
      pixels[target + 1] = grayscale ? row[source] : row[source + sampleBytes];
      pixels[target + 2] = grayscale ? row[source] : row[source + sampleBytes * 2];
      pixels[target + 3] = colorType === 4 ? row[source + sampleBytes] : colorType === 6 ? row[source + sampleBytes * 3] : 255;
      if (alphaOffset >= 0 && (row[source + alphaOffset] !== 255 || (sampleBytes === 2 && row[source + alphaOffset + 1] !== 255))) opaque = false;
    }
    [previous, row] = [row, previous];
  }
  return { width, height, bitDepth, channels, pixels, opaque };
}
