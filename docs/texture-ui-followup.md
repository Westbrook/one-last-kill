# Generated hand materials and game navigation — September 4, 2026

This follow-up adds generated skin and leather source detail to the existing Blender hand material, adds a way to leave an active game, and restores desktop messaging to its earlier positions. The compact top communication area remains available for small screens. The hand work changes color and roughness; it retains the accepted geometry, UVs, shape keys, normal map, and runtime material configuration from the [character and hand fidelity pass](blender-character-hand-fidelity.md).

## Hand material source and delivery

The two original generated samples are [skin-source.png](../assets/material-sources/hand-material-v1/skin-source.png) and [leather-source.png](../assets/material-sources/hand-material-v1/leather-source.png). Their [generation record](../assets/material-sources/hand-material-v1/generation.json) contains the exact prompts, built-in image-generation provenance, and original output locations. Both returned images are 1254 × 1254, despite the requested 1024 × 1024 size. These are flat material art sources, not measured reflectance or scanned skin. No normal map is derived from them.

The [offline projection helper](../tools/blender/paint-hand-materials.py) reads source color in linear space, normalizes it around the accepted hand palette, and applies bounded variation to the saved `SCULPT_Atlas_Master`. It keeps the existing nail/cuticle masks and adds restrained joint coloration, leather grain, panel-edge wear, and corresponding roughness variation. Angular seams and island borders taper back toward the accepted material. All four fingers share a semantic strip; the thumb and wrist have their own strips. Both mirrored hands and all eight grip shapes continue to use this shared layout.

The editable [hands.blend](../assets/blender/hands.blend) contains the generated source images and the baked output images as packed data. `SculptAlbedo` and `SculptRoughness` remain the authoritative POINT paint attributes for rebaking. `MaterialBaseAlbedo` and `MaterialBaseRoughness` preserve the prior paint for reversible projection edits. The candidate and immutable rollback source are retained under [the evidence directory](../artifacts/texture-ui-followup-2026-09-04/).

| Item | Before | Updated |
| --- | ---: | ---: |
| Hand albedo PNG | 51,183 bytes | 230,235 bytes |
| Hand roughness PNG | 181,548 bytes | 193,078 bytes |
| Hand normal PNG | 226,225 bytes | 226,225 bytes, identical |
| Three-map download total | 458,956 bytes | 649,538 bytes |
| Geometry binary | 967,888 bytes | 967,888 bytes, identical |
| Editable Blender source | 23,123,084 bytes | 30,068,206 bytes |

The two changed textures add **190,582 encoded download bytes**. The shared finish remains three 512² maps, approximately 4 MiB of RGBA storage with mipmaps; the existing sleeve/cuff maps add approximately 0.25 MiB. There are no additional texture objects, material draws, shader samples, triangles, bones, or per-frame generation. The larger editable source does not ship in the game. Download bytes and these allocation estimates are not measurements of driver residency or FPS.

The [publication record](../artifacts/texture-ui-followup-2026-09-04/hand-material-publication.json) contains exact sizes and hashes for source and delivery. Updated albedo SHA-256 is `96bad7a1aa399c2c41d4ef5460cb0ded758a69601426eeccfb55e38292e0828c`; roughness is `c2841eaef6f728fc59ee5aef32116597d8c04abb7af66060e6aedc5276886b52`. The retained normal is `f6a3a5b9274663103a715a3fe2723664bb448498d2055d4d86db14379a2c4bc6`, and geometry is `c7b5cf4d53eaf5113589660d05396eb689f2d13942565c7fb5876fb5660e655e`. The [material provenance](../artifacts/texture-ui-followup-2026-09-04/hand-material-candidate/material-provenance.json) also records source hashes, sampling parameters, saved paint checksums, and the unchanged runtime contract.

## Editing and rebaking

Run these commands from the project root. Export-only publishes saved production geometry and packed images. Color-only rebaking evaluates the saved paint and preserves the packed normal image exactly. A full rebake remains available after sculpt geometry edits, when the normal should be regenerated.

```sh
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender

# Export saved production geometry and packed material edits.
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --export-only

# Rebake saved albedo/roughness paint; preserve the saved sculpt normal bytes.
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --bake-color

# After sculpt geometry edits, rebake all three maps, including the normal.
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --bake
```

To project alternate material sources, use the helper with a separate staging output. Its default sampling preserves the saved base paint instead of compounding previous generated variation. The helper refuses the production map directory as its output and checks the unchanged geometry and normal hashes before saving a candidate.

```sh
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/paint-hand-materials.py -- \
  --skin assets/material-sources/hand-material-v1/skin-source.png \
  --leather assets/material-sources/hand-material-v1/leather-source.png \
  --output artifacts/hand-material-review
```

The [verification helper](../tools/blender/verify-hand-materials.py) reopens a candidate and writes into an isolated directory without saving over the source or publishing runtime files:

```sh
"$BLENDER_BIN" --background artifacts/hand-material-review/hands.blend --python tools/blender/verify-hand-materials.py -- \
  --mode export --reference artifacts/hand-material-review --output artifacts/hand-material-export-review

"$BLENDER_BIN" --background artifacts/hand-material-review/hands.blend --python tools/blender/verify-hand-materials.py -- \
  --mode bake-color --reference artifacts/hand-material-review --output artifacts/hand-material-rebake-review
```

The ordinary builder targets `assets/blender/hands.blend` and `public/assets/models/hands`; opening an artifact copy does not change those destinations. Use the isolated verification helper when checking a staged source. Preserve the production `Basis`/`Clench` pair, `HandTint`, semantic UV islands, and master POINT attributes. Changing a runtime PNG alone does not update the editable source and will be replaced by the next source export.

## Leaving a game and desktop messaging

An active run now has **Leave Game** in the pause menu and on the death screen. On desktop, pause with **Esc** or **P**, then choose **Leave Game**. Touch users can use the pause control; controller users can navigate the pause/death actions and confirmation with direction controls and the confirm/back buttons. The confirmation opens on **Cancel** and explains that leaving clears the current run and checkpoints while retaining saved settings. **Leave to Menu** reloads the current page into the main menu, where a new run can start from the beginning with another mode or difficulty. Cancel returns to the paused/death screen without resuming or retrying behind the dialog.

Desktop now uses the full-height playfield and the earlier overlay positions for the objective, banner, pickup prompt, transient message, and mission caption. The wrappers participate in layout only when the viewport is **760 CSS pixels wide or narrower, or 500 CSS pixels high or shorter**. Those compact viewports retain the top communication area, including landscape phones; its reserved height stays stable as messages change. This is based on viewport size, so a sufficiently small desktop window also receives the compact layout. Touch-specific control spacing remains separate from this breakpoint.

The restored desktop playfield renders more pixels than the earlier global top-area layout at the same window size and render scale. Any performance comparison must use matching canvas dimensions; it must not attribute the larger render area to a texture cost.

## Further fidelity priorities

1. **NPC material-specific roughness.** The gunman's new head and garment maps currently use broad procedural roughness variation. Painting cloth, leather shoes/belts, seam wear, and different facial regions into those existing maps is the next low-cost material opportunity. It can preserve the four-map and four-body-draw contracts.
2. **Garment and metal texture authoring.** Better diffuse wear, weave scale, paint/coating wear, and contact polish should follow real seams and handled areas. Existing weapon PBR maps can be improved in place. The gunman's garment color currently comes from vertex paint, so fine new garment albedo would require either a deliberately budgeted atlas or a reviewed packing/shader change; it is not already supported by its four normal/roughness maps.
3. **Eyes, brows, hair and silhouette.** The character already uses a detailed generated frontal face image, but the shader excludes the rendered eyes, brow strips, hair, and much of the sides. Replacing that image cannot repair those forms. Better eyelid/iris seating, hair shape, material variation, and redistribution of existing geometry have more value there. The gunman has only 302 triangles left under the 15,000-triangle limit.
4. **Motion and attachment quality.** Shoulder deformation, cloth compression around poses, grip fit, and transitions between carry/aim/recovery can improve perceived realism without increasing mesh counts. Those changes need actual animation, collapse, reuse, and contact review.

Keep generated images as editable source inputs and bake detail for the actual UV layout. Increasing the hand maps from 512² to 1024² would quadruple their estimated mipmapped storage from about 4 to 16 MiB; the present pilot improves content at the existing size. Remaining gains should be judged at normal gameplay distances, with matched before/after views and sustained workloads rather than studio closeups alone.

## Validation

- [Export-only roundtrip](../artifacts/texture-ui-followup-2026-09-04/hand-material-export-check/verification.json): reopened source reproduces the geometry and all three PNGs byte for byte, retaining generated-source provenance.
- [Color-only rebake roundtrip](../artifacts/texture-ui-followup-2026-09-04/hand-material-rebake-check/verification.json): saved paint reproduces both changed PNGs and retains identical normal/geometry bytes. This does not claim that a future full sculpt rebake preserves the old normal.
- [Targeted hand checks](../artifacts/texture-ui-followup-2026-09-04/hand-material-tests.txt): **16/16 passed**, including contacts, mirrored ownership, shape-key surfaces, loaded map coverage and hashes, material fallback, and camera envelopes.
- Visual review: **accepted** across matched fists, knife, bat, aimed pistol, and aimed shotgun views. The improvement is modest skin pigmentation and glove grain/wear, with no observed projection seams. [Interactive before/after review](../artifacts/texture-ui-followup-2026-09-04/index.html).
- Leave/cancel/restart: verified death → leave → Escape returns to death, Retry → pause → leave → Cancel returns to pause, and confirmed leave returns to fresh setup with the muted URL retained. A subsequent run successfully changed Story/Average to Tower Defense/Easy. Touch pause/leave/cancel worked in portrait and landscape. Controller routes and held-button suppression are covered by the input/UI unit tests; no physical controller was attached for this browser review.
- Responsive UI: verified full 1280 × 720 desktop canvas, 390 × 844 portrait with a 176px top area, and 844 × 390 landscape with a 104px top area. [Boundary checks](../artifacts/texture-ui-followup-2026-09-04/responsive-layout-checks.json) verify 760/761px width and 500/501px height transitions, including touch enabled on a desktop-sized viewport. The earlier objective/banner/lower-message positions were visually reviewed on desktop.
- Combined [lint/unit/build](../artifacts/texture-ui-followup-2026-09-04/check.log): **1,868 tests passed**, ESLint passed, and the production build completed. The build retains its existing large-chunk advisory. [Real-game integration](../artifacts/texture-ui-followup-2026-09-04/browser-regression.txt): **63/63 passed**.
- [Built-game smoke test](../artifacts/texture-ui-followup-2026-09-04/production-smoke.json): Story/Average start → enter mission → P pause → Leave/Cancel → Leave/Confirm → fresh menu passed, with mute retained and **zero new browser warnings or errors**. The comparison page loaded every image and its grip selector and zoom control worked. Graphics were returned to Automatic/device defaults and touch controls to off after testing.

## Full-height desktop timing

Four controlled 10-second measurements ran at 1280 × 720 CSS pixels on the local Apple M5 Max, with one rendered game tab and no concurrent Blender, builds, tests, screenshots, or image generation. All retained a median rAF interval of 8.30ms and p95 of 9.30ms. These are callback intervals, not measured presented FPS. GPU samples are asynchronous and must not be added to the sampled CPU duration.

| Workload | Drawing buffer | rAF maximum | Intervals over 16.9ms | GPU p95 |
| --- | --- | ---: | ---: | ---: |
| [High 2× balcony melee](../artifacts/texture-ui-followup-2026-09-04/performance-high-2-melee.txt) | 2560 × 1440 | 17.60ms | 1 / 1,200 | 12.71ms |
| [Auto fixed 1.2× balcony melee](../artifacts/texture-ui-followup-2026-09-04/performance-auto-1.2-melee.txt) | 1536 × 864 | 9.40ms | 0 / 1,201 | 8.49ms |
| [High 2× pistol combat](../artifacts/texture-ui-followup-2026-09-04/performance-high-2-pistol.txt) | 2560 × 1440 | 216.70ms | 7 / 1,150 | 7.75ms |
| [High 2× pistol repeat](../artifacts/texture-ui-followup-2026-09-04/performance-high-2-pistol-repeat.txt) | 2560 × 1440 | 9.40ms | 0 / 1,202 | 5.32ms |

The first pistol sample contained three intervals above 50ms and a texture-count increase from 281 to 282. The repeat retained 282 textures, 891 geometries, and 108 programs throughout and had no interval above 16.9ms. This does not identify the cause of the earlier stalls; both results are retained. Typical local timing is compatible with the current target, but these short samples do not establish sustained 120 FPS or performance on an unspecified minimum device.

The previous 104px desktop top area left a 616px-high playfield. Returning to 720px adds about **16.9% more rendered pixels** at a matching scale. The reports above validate the resulting layout; they are not a controlled before/after measurement of the material change. Texture allocation, shader samples, and geometry remain structurally unchanged by that material change.

For the underlying color-only and normal-bake distinction, see the [Blender render-baking manual](https://docs.blender.org/manual/en/4.3/render/cycles/baking.html). The generated samples supply diffuse variation; the retained sculpt supplies the normal map.

Final review artifacts and validation results belong in [the follow-up evidence directory](../artifacts/texture-ui-followup-2026-09-04/). The earlier fidelity-pass performance measurements remain historical evidence; unchanged map counts alone do not establish constant FPS on every device.
