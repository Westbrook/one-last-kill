# Offline KTX2 material trial

This workflow produces review artifacts for the approved Red Brick and Plastered Wall 03 triplets. It does not change production URLs, delete raw maps, or enable compression in the game. The source files and their licenses/hashes remain recorded in `public/assets/materials/manifest.json`.

Use official **Khronos KTX-Software 4.4.2**. Its sRGB mip generation fix matters for the color maps. The macOS ARM64 release package can be unpacked with `pkgutil --expand-full` into a temporary directory; merge the tools package's `bin` and library package's `lib` under that temporary prefix. Do not run the installer. The verified release used for this trial was:

- [Official release](https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2)
- Asset: `KTX-Software-4.4.2-Darwin-arm64.pkg`
- SHA-256: `500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c`

From the repository root:

```sh
node tools/prepare-ktx2-trial.mjs \
  --ktx /absolute/path/to/ktx \
  --output artifacts/graphics-ceiling-2026-08-29/ktx2-uastc4 \
  --quality 4

node tools/verify-ktx2-runtime.mjs \
  --ktx /absolute/path/to/ktx \
  --manifest artifacts/graphics-ceiling-2026-08-29/ktx2-uastc4/manifest.json

node --test tests/unit/texture-quality.test.js tests/unit/ktx2-pipeline.test.js
```

The encoder uses two CPU threads and can take roughly a minute per 1K map at quality 4. Do not collect game performance results while it runs. `--materials red_brick` and `--kinds normal` permit bounded reruns. Different quality/output directories allow comparisons without overwriting previous candidates. The script requires no image library or network request; it invokes the explicitly supplied local encoder. A different encoder version fails closed until its command and metadata semantics are reviewed.

The result directory contains encoded textures, decoded diagnostic PNGs, and a JSON manifest with source/output hashes, exact commands, byte counts, metadata, transcode formats, and quality measurements. The manifest stays `incomplete` if a run fails. All output paths are restricted to `artifacts/`; moving selected assets into `public/` is a separate decision after visual review. Raw source hashes are verified before encoding; verified scratch copies keep encoding and reference reads consistent, and original hashes are checked again before the final manifest is written.

The encoding contract is deliberate:

- Albedo remains sRGB with BT709 primaries. Normals and roughness are linear data with unspecified primaries, which Three treats as `NoColorSpace`.
- All textures use ordinary RGB UASTC, quality 4, Zstandard level 18, and no lossy RDO pass. Roughness remains replicated RGB so its green channel is preserved.
- Do not enable `--normal-mode`: it packs normal Y into alpha for a shader contract the current game does not use. There is no green inversion, normalization, channel swizzle, or image resize.
- All rows are flipped vertically offline. Current raw `TextureLoader` maps use `flipY=true`; a compressed texture cannot perform that flip at upload. Compressed loading must use `flipY=false`, embedded mipmaps, `generateMipmaps=false`, the same UV transform, and positive OpenGL normal Y scale.
- Eleven mip levels use a box filter with wrapping. Color mip filtering is linearized by the fixed encoder. Base-level metrics do not prove mip/anisotropic quality.

Quality is measured against an uncompressed reference decoded by the same encoder, using the same row conversion. RGB PSNR is measured in the stored channel values; roughness measures green only. Normal angular error normalizes both RGB-decoded direction vectors, and reports mean/p95/max and invalid-vector counts. The 16-bit plaster source also receives a separate comparison against the 8-bit reference and compressed result, so quantization is not hidden inside the codec score. The raw game path currently uploads unsigned-byte RGBA even for its 16-bit source PNG.

The pipeline measures decoded UASTC RGBA8 **and actual ASTC decode**; rounding can differ by one code value. It also verifies complete BC7, ETC RGB, BC1, and RGBA8 transcodes and counts their payload bytes, but does not measure those additional codecs' decoded error. Byte counts exclude driver allocation overhead and cannot establish FPS savings. The Three Basis JS/WASM transcoder adds its own download/startup cost.

The second command runs the exact pinned Three Basis wrapper/WASM and compares every ASTC mip block byte with the native decoder used for the quality measurements. It records the wrapper/WASM hashes and sizes in `runtime-verification.json`. This proves that the measured codec matches the browser's selected ASTC codec; it does not replace browser loading, filtering, or performance checks.

Before enabling a candidate, compare raw/compressed close-range brick mortar, grazing plaster highlights, distant/moving walls, texture orientation, and normal direction in the actual game. Repeat startup and fixed-scene GPU tests with the encoder stopped. Record the actual selected target format: Three r185 prefers ASTC, then BC7 for UASTC, but may choose a lower-quality format or RGBA8 on other devices. Keep the raw triplets as atomic fallbacks and avoid claiming untested device quality.

Primary references: [KTX create](https://github.khronos.org/KTX-Software/ktxtools/ktx_create.html), [KTX extract](https://github.khronos.org/KTX-Software/ktxtools/ktx_extract.html), [Khronos developer guide](https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXDeveloperGuide.md), [pinned Three loader](https://github.com/mrdoob/three.js/blob/r185/examples/jsm/loaders/KTX2Loader.js), [Three compressed textures](https://threejs.org/docs/pages/CompressedTexture.html). Hosted KTX documentation may describe a newer version; the script uses the checked 4.4.2 CLI.
