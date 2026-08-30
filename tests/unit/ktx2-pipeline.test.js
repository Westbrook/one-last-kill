import assert from 'node:assert/strict';
import test from 'node:test';
import { createOptions, prepareTrial, validateTrialInfo } from '../../tools/prepare-ktx2-trial.mjs';

function info(kind = 'normal') {
  return {
    valid: true,
    header: {
      pixelWidth: 1024, pixelHeight: 1024, levelCount: 11, faceCount: 1,
      layerCount: 0, pixelDepth: 0, vkFormat: 'VK_FORMAT_UNDEFINED', supercompressionScheme: 'KTX_SS_ZSTD',
    },
    dataFormatDescriptor: { blocks: [{
      colorModel: 'KHR_DF_MODEL_UASTC', samples: [{ channelType: 'KHR_DF_CHANNEL_UASTC_RGB' }],
      transferFunction: kind === 'albedo' ? 'KHR_DF_TRANSFER_SRGB' : 'KHR_DF_TRANSFER_LINEAR',
      colorPrimaries: kind === 'albedo' ? 'KHR_DF_PRIMARIES_BT709' : 'KHR_DF_PRIMARIES_UNSPECIFIED',
    }] },
    keyValueData: { KTXorientation: 'ru' },
  };
}

function option(args, name) { return args[args.indexOf(name) + 1]; }

test('offline normal/roughness recipe retains RGB data and changes only row orientation', () => {
  for (const kind of ['normal', 'roughness']) {
    const args = createOptions(kind);
    assert.equal(option(args, '--format'), 'R8G8B8_UNORM');
    assert.equal(option(args, '--assign-tf'), 'linear');
    assert.equal(option(args, '--assign-primaries'), 'none');
    assert.equal(option(args, '--assign-texcoord-origin'), 'top-left');
    assert.equal(option(args, '--convert-texcoord-origin'), 'bottom-left');
    assert.equal(option(args, '--mipmap-wrap'), 'wrap');
    for (const forbidden of ['--normal-mode', '--normalize', '--input-swizzle', '--swizzle', '--convert-tf', '--uastc-rdo']) {
      assert.ok(!args.includes(forbidden), `${kind}: ${forbidden} would change the existing shader contract`);
    }
  }
});

test('albedo recipe preserves sRGB and generates the full mip chain with bounded offline threads', () => {
  const args = createOptions('albedo');
  assert.equal(option(args, '--format'), 'R8G8B8_SRGB');
  assert.equal(option(args, '--assign-tf'), 'srgb');
  assert.equal(option(args, '--assign-primaries'), 'bt709');
  assert.ok(args.includes('--generate-mipmap'));
  assert.equal(option(args, '--mipmap-filter'), 'box');
  assert.equal(option(args, '--threads'), '2');
  assert.equal(option(args, '--uastc-quality'), '4');
  assert.equal(option(args, '--zstd'), '18');
});

test('16-bit data references avoid encoding or resampling the original values', () => {
  const args = createOptions('normal', { bits: 16, encode: false, mipmaps: false });
  assert.equal(option(args, '--format'), 'R16G16B16_UNORM');
  assert.ok(!args.includes('--encode'));
  assert.ok(!args.includes('--generate-mipmap'));
  assert.throws(() => createOptions('normal', { bits: 16 }), /8 bits/);
  assert.throws(() => createOptions('albedo', { bits: 16, encode: false }), /data maps/);
  assert.throws(() => createOptions('normal', { quality: 5 }), /0–4/);
  assert.throws(() => createOptions('unknown'), /Unknown map/);
});

test('validation rejects color transforms, packed normals, flipped orientation, and missing mips', () => {
  assert.equal(validateTrialInfo(info(), 'normal'), true);
  assert.equal(validateTrialInfo(info('albedo'), 'albedo'), true);
  const changes = [
    value => { value.valid = false; },
    value => { value.header.levelCount = 1; },
    value => { value.header.pixelWidth = 2048; },
    value => { value.header.supercompressionScheme = 'KTX_SS_BASIS_LZ'; },
    value => { value.keyValueData.KTXorientation = 'rd'; },
    value => { value.dataFormatDescriptor.blocks[0].samples[0].channelType = 'KHR_DF_CHANNEL_UASTC_RGBA'; },
    value => { value.dataFormatDescriptor.blocks[0].transferFunction = 'KHR_DF_TRANSFER_SRGB'; },
    value => { value.dataFormatDescriptor.blocks[0].colorPrimaries = 'KHR_DF_PRIMARIES_BT709'; },
  ];
  for (const mutate of changes) {
    const candidate = info();
    mutate(candidate);
    assert.throws(() => validateTrialInfo(candidate, 'normal'), /contract failed/);
  }
});

test('trial pipeline cannot write over production assets and needs an explicit local encoder', () => {
  assert.throws(() => prepareTrial(), /Pass --ktx/);
  assert.throws(() => prepareTrial({ ktx: '/not-run', output: 'public/assets/materials' }), /inside artifacts/);
  assert.throws(() => prepareTrial({ ktx: '/not-run', output: 'artifacts/../../outside' }), /inside artifacts/);
});
