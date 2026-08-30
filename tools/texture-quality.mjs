function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
    throw new TypeError('Texture quality options must be a plain object.');
  }
}

function validateStride(stride, minimum, name) {
  if (!Number.isSafeInteger(stride) || stride < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${minimum}.`);
  }
}

function validateMaximum(maximum, name) {
  if (!Number.isFinite(maximum) || maximum <= 0) {
    throw new RangeError(`${name} must be a finite positive number.`);
  }
}

function validateSamples(samples, stride, maximum, name) {
  if (!(samples instanceof Uint8Array) && !(samples instanceof Uint16Array) && !Array.isArray(samples)) {
    throw new TypeError(`${name} must be a Uint8Array, Uint16Array, or numeric array.`);
  }
  if (!samples.length || samples.length % stride !== 0) {
    throw new RangeError(`${name} must contain complete, nonempty pixels for its stride.`);
  }
  // Validate every component, including unmeasured alpha, before scoring.
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index];
    if (!Number.isFinite(value)) throw new TypeError(`${name}[${index}] must be a finite number.`);
    if (value < 0 || value > maximum) throw new RangeError(`${name}[${index}] is outside [0, ${maximum}].`);
  }
  return samples.length / stride;
}

function validatePair(reference, decoded, options, minimumStride) {
  validateOptions(options);
  const { referenceStride = 3, decodedStride = 4, referenceMax = 255, decodedMax = 255 } = options;
  validateStride(referenceStride, minimumStride, 'referenceStride');
  validateStride(decodedStride, minimumStride, 'decodedStride');
  validateMaximum(referenceMax, 'referenceMax');
  validateMaximum(decodedMax, 'decodedMax');
  const pixelCount = validateSamples(reference, referenceStride, referenceMax, 'reference');
  if (validateSamples(decoded, decodedStride, decodedMax, 'decoded') !== pixelCount) {
    throw new RangeError('Reference and decoded images must have the same pixel count.');
  }
  return { referenceStride, decodedStride, referenceMax, decodedMax, pixelCount };
}

/**
 * Compare matching channels after independently scaling both images to [0, 1].
 * MSE, RMSE and maximum error are normalized; PSNR uses a peak value of 1.
 * Exact matches return null PSNR instead of a non-JSON-safe Infinity.
 */
export function measurePixelError(reference, decoded, options = {}) {
  const { referenceStride, decodedStride, referenceMax, decodedMax, pixelCount } = validatePair(reference, decoded, options, 1);
  const { channels = [0, 1, 2] } = options;
  if (!Array.isArray(channels) || !channels.length) throw new TypeError('channels must be a nonempty array of unique channel indices.');
  const measuredChannels = channels.slice();
  const unique = new Set();
  for (const channel of measuredChannels) {
    if (!Number.isSafeInteger(channel) || channel < 0 || channel >= referenceStride || channel >= decodedStride) {
      throw new RangeError('Each measured channel must be an integer present in both pixel strides.');
    }
    if (unique.has(channel)) throw new RangeError('Measured channels must not contain duplicates.');
    unique.add(channel);
  }
  let sumSquaredError = 0, maxAbsoluteError = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const referenceOffset = pixel * referenceStride, decodedOffset = pixel * decodedStride;
    for (let index = 0; index < measuredChannels.length; index++) {
      const channel = measuredChannels[index];
      const error = reference[referenceOffset + channel] / referenceMax - decoded[decodedOffset + channel] / decodedMax;
      sumSquaredError += error * error;
      maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(error));
    }
  }
  const normalizedMse = sumSquaredError / (pixelCount * measuredChannels.length);
  return {
    normalizedMse,
    rmse: Math.sqrt(normalizedMse),
    psnrDb: normalizedMse === 0 ? null : Math.max(0, -10 * Math.log10(normalizedMse)),
    maxAbsoluteError,
    pixelCount,
    measuredChannels,
  };
}

/**
 * Compare RGB normal directions, unpacked to [-1, 1] and normalized separately.
 * Angles are measured only for valid pairs. A zero vector in either image makes
 * that pixel invalid; if all pairs are invalid, all angle statistics are null.
 * p95 uses the nearest-rank percentile. Inputs and alpha are never modified.
 */
export function measureNormalError(reference, decoded, options = {}) {
  const { referenceStride, decodedStride, referenceMax, decodedMax, pixelCount } = validatePair(reference, decoded, options, 3);
  const angles = new Float64Array(pixelCount);
  let invalidNormals = 0, validNormals = 0, sumDegrees = 0, maxDegrees = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const referenceOffset = pixel * referenceStride, decodedOffset = pixel * decodedStride;
    let rx = reference[referenceOffset] / referenceMax * 2 - 1;
    let ry = reference[referenceOffset + 1] / referenceMax * 2 - 1;
    let rz = reference[referenceOffset + 2] / referenceMax * 2 - 1;
    let dx = decoded[decodedOffset] / decodedMax * 2 - 1;
    let dy = decoded[decodedOffset + 1] / decodedMax * 2 - 1;
    let dz = decoded[decodedOffset + 2] / decodedMax * 2 - 1;
    const referenceLength = Math.hypot(rx, ry, rz), decodedLength = Math.hypot(dx, dy, dz);
    if (referenceLength === 0 || decodedLength === 0) {
      invalidNormals++;
      continue;
    }
    rx /= referenceLength; ry /= referenceLength; rz /= referenceLength;
    dx /= decodedLength; dy /= decodedLength; dz /= decodedLength;
    // atan2 remains stable at both zero error and reversed normals, without
    // turning dot-product roundoff into a nonzero angle for identical pixels.
    const crossLength = Math.hypot(ry * dz - rz * dy, rz * dx - rx * dz, rx * dy - ry * dx);
    const dot = rx * dx + ry * dy + rz * dz;
    const degrees = Math.atan2(crossLength, dot) * 180 / Math.PI;
    angles[validNormals++] = degrees;
    sumDegrees += degrees;
    maxDegrees = Math.max(maxDegrees, degrees);
  }
  if (!validNormals) return { meanDegrees: null, p95Degrees: null, maxDegrees: null, invalidNormals, validNormals, pixelCount };
  // One view allocation per image; there are no per-pixel objects or arrays.
  const sorted = angles.subarray(0, validNormals).sort();
  return {
    meanDegrees: sumDegrees / validNormals,
    p95Degrees: sorted[Math.ceil(validNormals * 0.95) - 1],
    maxDegrees,
    invalidNormals,
    validNormals,
    pixelCount,
  };
}
