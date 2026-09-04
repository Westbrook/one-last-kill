# Blender material realism — September 4, 2026

This pass improves the gunman's material response and the knife, shotgun, SMG and machine-gun finishes while preserving their geometry, UVs, material draws, texture dimensions and runtime sampling. It also closes an authoring gap: exporting a saved Blender source now reliably delivers its packed images, including later paint edits. The [matched in-game review](../artifacts/blender-material-realism-2026-09-04/index.html) contains ten before/after views.

The visible improvement is modest under the game's lighting. Walnut grain is less regular; cloth, leather, rubber and facial regions respond more appropriately. Boots remain dark at normal gameplay distances. This work does not change eye/hair forms, animation or lighting, and texture integrity alone does not establish realism or FPS.

## Material sources and scope

The gunman's existing garment roughness atlas now distinguishes shirt, trousers, leather and rubber, with restrained contact wear and toe polish. The head atlas distinguishes cheek, nose, forehead, lip and ear response. Dense sculpt masters retain paintable `Finish_*` point attributes and labeled material Value controls. These are authored artistic values, not measured reflectance. Both accepted tangent-normal maps and the face albedo remain unchanged. The [character material guide](blender-character-material-finish.md) records the controls, decoded sample results and small-island limitations.

The four held weapons use the [generated walnut source](../assets/material-sources/weapon-finish-v1/walnut-source.png) only for diffuse pigmentation, normalized around the previous palette. Its full 1,254² image stays in the authoring source. Separately authored pores provide restrained wood microrelief; image luminance is not converted into height. Steel and molded polymer use irregular surface detail with corresponding normal and roughness variation. Existing `FinishTint` regions, atlas padding, normal strengths and zero metallic values for nonmetals are retained.

The [exact prompt and generation record](../assets/material-sources/weapon-finish-v1/generation.json) identify **built-in imagegen** as the method. The installed imagegen skill's CLI/API fallback defaults to **GPT Image 2**, but the built-in tool did not expose its underlying model name for this run. The provenance therefore makes no claim that this particular image used that model. The [authoring profile](../assets/material-sources/weapon-finish-v1/profile.json) records how the source enters the finish.

Hands and pistol materials retain their previously accepted content. See the [hand material workflow](texture-ui-followup.md) for the earlier generated skin/leather pass. Reduced world firearms still use the game's existing 128² finishes rather than Blender textures; editing their Blender preview materials alone does not reach the game.

## Export saved edits

Run commands from the repository root with Blender 5.2.1 LTS. Save edited images and pack them into the `.blend` before closing Blender. Runtime PNG edits alone do not update the source.

These commands export the accepted saved sources into isolated directories:

```sh
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender

"$BLENDER_BIN" --background --python tools/blender/build-characters.py -- \
  --export-only --source assets/blender/characters.blend \
  --output /tmp/character-source-check

"$BLENDER_BIN" --background --python tools/blender/build-weapons.py -- \
  --export-existing --source-file assets/blender/weapons.blend \
  --output-dir /tmp/weapon-source-check \
  --texture-dir /tmp/weapon-source-check/textures
```

The character export writes geometry, manifest and all four packed PNGs. It rejects missing or unpacked maps and incorrect dimensions/color space. The weapon export preserves saved geometry, UVs, tints, nodes and images; it exports held `vm_*` roots while excluding the studio. The temporary weapon manifest records its temporary PNG paths, so compare the actual GLB rather than expecting path-dependent manifests to match.

After reviewing edited sources, the ordinary delivery commands use the canonical sources and runtime destinations:

```sh
"$BLENDER_BIN" --background --python tools/blender/build-characters.py -- --export-only
"$BLENDER_BIN" --background --python tools/blender/build-weapons.py -- --export-existing
```

For character material edits, first copy the source into a staging location. A roughness-only rebake evaluates the saved masters and updates that source's packed roughness while retaining exact normal-map bytes:

```sh
cp assets/blender/characters.blend /tmp/characters-material-review.blend
"$BLENDER_BIN" --background --python tools/blender/build-characters.py -- \
  --bake-only --roughness-only --source /tmp/characters-material-review.blend \
  --output /tmp/character-material-review
```

Edit the staged file before rebaking. After sculpt geometry changes, omit `--roughness-only` so the normal map also reflects the edited surface. Re-running `character_material_finish.py` deliberately initializes its masks and controls again; it is not the preserving rebake workflow.

Weapon texture regeneration is also explicit. This command keeps saved geometry but replaces the six finish images from the recorded profile, saving to a separate source:

```sh
"$BLENDER_BIN" --background --python tools/blender/build-weapons.py -- \
  --export-existing --source-file assets/blender/weapons.blend \
  --refresh-materials assets/material-sources/weapon-finish-v1/profile.json \
  --source-output /tmp/weapons-material-review.blend \
  --output-dir /tmp/weapon-material-review \
  --texture-dir /tmp/weapon-material-review/textures
```

Omit `--refresh-materials` to retain subsequent paint. Running the weapon builder without `--export-existing` deliberately reconstructs the original seed scene, replacing geometry authoring, UVs and paint. The earlier [model rollout guide](blender-model-rollout.md) describes that seed workflow; its statement that held weapons lack a preserving export path is superseded here.

## Fixed runtime budgets

| Audited catalog | Finish images | Estimated RGBA8 storage with mips |
| --- | ---: | ---: |
| Hands | 3 × 512² | 4 MiB |
| Gunman | 4 × 512² | 5.33 MiB |
| Pistol | 6 × 256² | 2 MiB |
| Four held weapons | 6 × 256² | 2 MiB |
| **Total** | **19 images** | **13.33 MiB** |

These estimates cover the audited maps, excluding other game textures, and are not measured driver residency. No image, sampler, shader sample or draw is added. The entire character catalog binary and the two character normal PNGs are byte-identical. The gunman retains 14,698 triangles, four body draws and 17 bones. The held catalog retains three materials and 15,090 triangles: knife 464, shotgun 4,880, SMG 4,472 and machine gun 5,274. All 159 named primitive accessor sets retain exact content, including positions, normals, UVs, vertex colors and indices.

| Changed delivery payload | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Two character roughness PNGs | 427,848 B | 170,040 B | 257,808 B |
| Four-weapon GLB | 2,111,156 B | 1,910,732 B | 200,424 B |
| **Combined payloads** | **2,539,004 B** | **2,080,772 B** | **458,232 B (447.5 KiB)** |

This measures encoded asset payloads, excluding manifests and offline `.blend` sources. The character manifest grows by 1,604 bytes and the weapon manifest by 3,101 bytes to retain more validation/provenance metadata. Including all files in the four audited delivery directories, the total falls from **11,332,420 to 10,878,893 bytes**, a net reduction of **453,527 bytes (442.9 KiB)**. This directory total includes sidecar provenance that is not loaded by every runtime catalog. Smaller PNG/GLB files do not reduce the unchanged decoded texture allocation or prove faster rendering.

## Validation and quality gate

The normal project check now includes an offline material audit:

```sh
npm run check:materials
npm run check

# Also preserve this material-only milestone's frozen geometry and bindings.
node tools/audit-model-materials.mjs \
  --reference artifacts/blender-material-realism-2026-09-04/material-reference.json \
  --json artifacts/blender-material-realism-2026-09-04/material-current.json
```

The gate decodes delivered PNG pixels, verifies CRCs, dimensions, opacity, map budgets, actual-image checksums and semantic material bindings. With a reference it also checks geometry, morphs, node transforms, extras and samplers. Held textures are read from the GLB itself. It rejects unused resources and sharing image content between color and data semantics as project policy. See the [gate notes](../artifacts/blender-material-realism-2026-09-04/material-gate-notes.md) for supported formats, deliberate restrictions and normal-vector tolerances.

Base color uses sRGB encoding, while packed roughness uses linear G and metallic uses linear B, following the [Khronos PBR schema](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/schema/material.pbrMetallicRoughness.schema.json). Blender material graphs must also follow supported export conventions; the [Blender glTF exporter documentation](https://github.com/KhronosGroup/glTF-Blender-IO/blob/main/docs/blender_docs/scene_gltf2.rst) describes the supported material layout. The game's custom hand and character packs retain their own explicit contracts.

Source delivery has separate evidence: character clean export and roughness-only rebake reproduce all six delivery files, and a controlled material edit changes the expected pixels while preserving normals. The weapon saved-source export reproduces the entire GLB; a disposable one-pixel paint edit reaches the embedded base-color image while the other five images remain unchanged. These checks exercise later artist edits rather than merely comparing filenames. See [character roundtrip](../artifacts/blender-material-realism-2026-09-04/character-candidate/roundtrip-validation.json), [character edit](../artifacts/blender-material-realism-2026-09-04/character-candidate/material-edit-validation.log), [weapon roundtrip](../artifacts/blender-material-realism-2026-09-04/weapon-source-roundtrip.json) and [weapon paint retention](../artifacts/blender-material-realism-2026-09-04/weapon-paint-retention.json).

Passing the gate is necessary but not an artistic score. Review neutral diffuse color, material scale, repeated patterns, seams, contact wear and response in matching game views. The accepted character atlas still has 28 tiny garment triangle centroids sampling zero roughness, present before and after; none are reliable interior samples. This pass does not claim a perfect bake or resolved detail on every tiny island.

The completed combined check passes **1,894 unit tests**, ESLint, the default material gate and the production build. The build retains its existing advisory for a chunk larger than 900 kB. The scoped source checks and full project check establish delivery correctness; actual-game and timing results are recorded separately below.

The [combined check log](../artifacts/blender-material-realism-2026-09-04/check.log) records that result. The [browser regression suite](../artifacts/blender-material-realism-2026-09-04/browser-regression.txt) passed all **63 checks** with the new assets. A production preview on port 4188 rendered the mission, entered pause and returned through Leave Game to the fresh main menu; no warning/error entries originated from that preview. Development hot-reload history contains Three.js duplicate-import warnings and is not counted as a clean production log.

The review page loads both captures, switches character/weapon views, supports the keyboard comparison slider and 2× viewing zoom, and links to the independent Progress Report. The optional game return link stays absent without its flag. Its [responsive check](../artifacts/blender-material-realism-2026-09-04/report-link-responsive.json) rendered the actual game inside 390 × 844 and 844 × 390 CSS-size frames, with live touch controls; it overlapped no visible button in either orientation. Fixed frames were used because the browser viewport override did not change the game tab's reported dimensions. These are layout checks, not physical-device touch or sensor tests. Normal game preferences were restored to Automatic quality, device render scale and touch controls off.

Three quiet ten-second samples used one rendered game tab, muted audio, **1280 × 720 CSS pixels**, and the local **Apple M5 Max / ANGLE Metal** renderer. No Blender export, build, image generation or screenshot ran during sampling. All runs had zero intervals over 16.9 ms, zero main-thread long tasks, and unchanged renderer resource counts between warmup and sample end.

| Workload | Drawing buffer | rAF interval p95 / maximum | GPU elapsed p95 | Raw report |
| --- | --- | --- | --- | --- |
| Balcony melee, High at fixed 2× | 2560 × 1440 | 9.20 / 9.40 ms | 10.57 ms | [Melee High](../artifacts/blender-material-realism-2026-09-04/benchmark-melee-high2.txt) |
| Shotgun combat, High at fixed 2× | 2560 × 1440 | 9.20 / 16.70 ms | 6.53 ms | [Shotgun High](../artifacts/blender-material-realism-2026-09-04/benchmark-shotgun-high2.txt) |
| Balcony melee, Automatic at fixed 1.2× | 1536 × 864 | 9.20 / 9.40 ms | 9.40 ms | [Melee Automatic](../artifacts/blender-material-realism-2026-09-04/benchmark-melee-auto1.2.txt) |

The approximately 120 callbacks per second are **not measured presented FPS**. Some GPU tails exceed an 8.33 ms frame budget; these results do not establish sustained 120 FPS. They provide no measured speedup from smaller files, input-latency score, long-session guarantee or coverage of minimum/mobile hardware. The fixtures use controlled cameras and replenish player health; the raw reports disclose their actual attacks, hits, reloads and sampling limits.

## Next realism priorities

Keep higher-resolution source art in Blender and select detail that survives the actual game atlas, mip level and viewing distance. Extra grain that shimmers, baked highlights that conflict with game lighting, or repeated edge wear without object-local UVs should not ship merely because the source looks detailed.

The next character gains are eyelid/iris seating, brows/hair forms, shoulder deformation, cloth compression and grip transitions. These require geometry/contact and motion review; the gunman has only 302 triangles remaining under its current 15,000-triangle limit. Garment color is still vertex paint, so new fine albedo needs a reviewed atlas or shader change. UV allocation should prioritize visible face, hand and contact areas before increasing every map.

Pistol, shared bat and world-weapon texture integration remain separate candidates. Better object-local wear may require revised UV ownership. Increasing a square texture's edge size from 512 to 1,024 quadruples its pixel storage; new maps, material splits or shader effects require new resource and performance checks. Judge each addition in matched gameplay views and sustained workloads on the intended minimum hardware, which is not yet specified.
