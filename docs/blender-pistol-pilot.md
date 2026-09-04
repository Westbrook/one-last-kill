# Blender pistol pilot — September 4, 2026

The first-person pistol now uses an original Blender-authored asset. This is a modest visual refinement: the slide has shaped edge breaks and milled serrations, the chamber remains visibly recessed, the grip has a continuous palm swell, and a small self-lit ceramic dot remains visible through the rear sight. The pilot establishes an editable source, repeatable export, cached loading, and measured geometry limits for further asset work.

This pilot covers the held pistol. NPC character conversion has not been done; NPC and dropped firearms continue to use their existing separate assets. The original first-person pistol remains available as the loading fallback.

## Source and rebuild

| File | Purpose |
| --- | --- |
| [pistol.blend](../assets/blender/pistol.blend) | Editable model with named mesh parts and a separate review studio |
| [pistol-textures](../assets/blender/pistol-textures/) | Original source PNGs for steel and polymer finishes |
| [build-pistol.py](../tools/blender/build-pistol.py) | Reconstructs the Blender scene, creates textures, and exports delivery files |
| [pistol.glb](../public/assets/models/pistol/pistol.glb) | Self-contained runtime model, including finish images |
| [manifest.json](../public/assets/models/pistol/manifest.json) | Provenance, coordinate contract, measured budgets, and delivery hash |

The asset was built with **Blender 5.2.1 LTS**. Run the following from the repository root to reproduce the generated source and export:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-pistol.py -- --skip-render
```

The rebuild **overwrites the generated `.blend`, source textures, GLB, and manifest**. Save manual Blender edits under a separate filename before rebuilding. To make those edits reproducible, incorporate them into the builder; a manually edited `.blend` otherwise needs its own export and manifest update. The command reconstructs the scene from the script and does not preserve edits made only in the saved source file. Omit `-- --skip-render` to also regenerate the two studio review images.

The export includes selected model parts, normals, one UV channel, and the `FinishTint` vertex colors. The camera, studio lights, and review environment stay out of the GLB. The source uses metres and exports to game coordinates: **+X forward along the bore, +Y up, +Z right**. Geometry and finish textures are original project work, with no third-party model, photograph, or trademark source.

After rebuilding, inspect and validate the delivered asset:

```sh
node tools/validate-pistol-asset.mjs
node --test tests/unit/blender-pistol.test.js
npm run check
```

## Geometry and delivery costs

| Production held model | Original procedural pistol | Blender pistol |
| --- | ---: | ---: |
| Weapon-only triangles | 1,774 | 2,400 |
| Complete viewmodel triangles, including hand and sleeve | 5,632 | 6,258 |
| Complete viewmodel material draws | 6 | 5 |

The complete held model adds **626 triangles (11.1%)** and removes one draw. It stays within the existing **6,500-triangle and six-draw** limits. The weapon-only loader also enforces a 4,000-triangle, three-material ceiling; the final asset uses three materials, including the small ceramic sight finish. The 51 named source parts become three weapon batches, with separate hand and sleeve batches.

The final GLB is **670,636 bytes**, with **3,318 exported vertices** and **146,256 bytes of unique geometry accessors**, as recorded by the export manifest. Its SHA-256 is `146f2852199599897c94f602e0cc1798fdb3554fd8b51fb5b6e86da35d2aeb3d`. It embeds six **256 × 256** PNG images: base color, normal, and packed metal/roughness for each of the two textured finishes. The runtime needs no external texture fetches for this asset.

Those six images represent approximately **2 MiB of RGBA8 texture storage with mipmaps**. The original shared procedural maps remain available for other weapons and fallback, so this is added texture storage. The estimate excludes temporary decode buffers, retained CPU images, geometry clones, and driver overhead; it is not measured GPU residency. Standalone source PNGs live outside `public/` and are not additional runtime downloads.

## Runtime integration

[authored-pistol.js](../src/render/authored-pistol.js) loads the GLB once during startup, alongside the existing surface and face maps. Concurrent requests share a pending load. A load error, invalid asset, or the default eight-second timeout selects the procedural pistol and permits startup to continue. Validation checks static geometry, finite position/normal/UV data, compatible vertex layouts within each material, texture dimensions, and the grip/framing envelope before marking the asset ready.

Imported node transforms are baked into a flat cached template. Each synchronous factory call receives owned geometry copies because the existing weapon batcher consumes and disposes its source geometry. Materials and textures remain shared. The cached template survives assembly and disposal of individual instances, and all geometry construction and decoding occur before play.

The authored UVs bypass the legacy primitive remapping. Exported `COLOR_0` values remain active through `material.vertexColors`; UV and color buffers survive batching exactly. Base-color images use sRGB, while normal and metal/roughness maps retain linear data. The existing startup viewmodel warmup compiles and renders the actual cached pistol under the loading menu before it can be equipped.

The established controller still supplies root motion, firing, aiming, recoil, and reload timing. The muzzle remains **`[0.201, 0.04, 0]`**, and the primary grip center remains **`[-0.052, -0.060, 0.012]`** in weapon-local metres. The model retains the existing 1.3 scale and first-person orientation, dedicated render layer, depth testing, and depth writes. It adds no lights, skinning, subpart animation, or per-frame geometry work.

## Visual and structural validation

The final gameplay views are [hip fire](../artifacts/blender-pistol-2026-09-04/final-hip.png) and [aimed](../artifacts/blender-pistol-2026-09-04/final-aim.png). They show the final integrated asset with the production hands and lighting. Earlier studio renders precede the final finish and visibility corrections and are not evidence for this delivered version.

The [Blender pistol test file](../tests/unit/blender-pistol.test.js) passes **13 checks**, including the parent test. These use the actual shipped GLB and Three.js geometry/material parser. The CPU fixture substitutes texture objects for browser image decoding and checks real embedded PNG headers and dimensions; browser captures supply the rendered appearance review.

Coverage includes:

- Delivery hash and manifest accuracy; presence of the editable source and rebuild script; geometry, texture, and material limits.
- Finite normals, positions, UVs, and colors; valid indices; noncollapsed UV triangles; active surface tints and exact UV/color preservation through batching.
- Failed-load fallback, retry, concurrent load caching, and rejection of incompatible primitive attributes before viewmodel assembly.
- Owned geometry copies, stable shared textures, unchanged framing and muzzle transforms, and complete model draw/triangle limits.
- Real trigger and rear-sight openings, a hollow muzzle, and a chamber floor **2.7 mm** behind the adjacent slide surface.
- Hand contact with a **0.710 mm** maximum measured penetration, no vertices deeper than 3 mm, and no rear-palm or wrist penetration into the inspected grip solids.
- A ceramic dot facing the player, with visible area through the assembled aimed model across nine FOV/aspect combinations; front-post visibility, clear reticle, and continuous aimed thumb coverage.
- Stable cached geometry and texture versions through the actual firing, aiming, and reload clock.

`npm run check` passes ESLint, **1,732 unit tests**, and the production build. The [saved final check output](../artifacts/blender-pistol-2026-09-04/check-final.txt) retains the result, including the existing Vite large-chunk warning.

The [final browser regression](../artifacts/blender-pistol-2026-09-04/browser-regression-final.txt) passes **63/63 checks**, including actual pistol firing, weapon pickup, ammunition conservation, reload timing, and checkpoint restoration. The first run exposed an older QA assumption that omitted the required difficulty setup. That test now completes the real Average campaign form before checking the Settings/Field Notes guards, and fixture cleanup hides the setup modal. Production input behavior was unchanged.

The [production smoke check](../artifacts/blender-pistol-2026-09-04/production-smoke.json) completed Begin Mission → Average campaign → briefing → active apartment play with no QA panel and no browser console warnings or errors. The final production bundle is identical to the smoke-tested bundle; the later setup correction is development-only QA code.

## Paired combat measurements

Both in-app game tabs were found reporting a visible document state and rendering concurrently during the earlier measurements. The retained `*-final.txt` and `*initial.txt` reports are diagnostic records and are excluded from acceptance. Final comparisons use six new `*-isolated.txt` reports, with the other game tab navigated to `about:blank` during each measured run.

The six initial isolated runs used the Codex browser's ANGLE Metal renderer on an Apple M5 Max, a 1280 × 720 CSS viewport, KTX2 ASTC wall maps, and audio locked off. Each run measured ten seconds after a half-second warmup. No Blender render, build, test suite, or screenshot capture ran during measurement. The baseline copied the original runtime source at `a5f7f8cdf92b06fcc32199a73b8985c6a60d82ec` and used the same new pistol benchmark fixture. These are local development-build timings.

| Isolated combat preset | rAF p95 ms, original → Blender | Full callback p95 ms, original → Blender | GPU p95 ms, original → Blender | Paired reports |
| --- | ---: | ---: | ---: | --- |
| Performance, 0.85× | 9.30 → 9.30 | 6.80 → 7.60 | 1.81 → 2.01 | [Original](../artifacts/blender-pistol-2026-09-04/before-combat-performance-isolated.txt) · [Blender](../artifacts/blender-pistol-2026-09-04/after-combat-performance-isolated.txt) |
| Automatic, 1.20× | 9.20 → 9.25 | 8.10 → 11.40 | 3.80 → 4.08 | [Original](../artifacts/blender-pistol-2026-09-04/before-combat-auto-isolated.txt) · [Blender](../artifacts/blender-pistol-2026-09-04/after-combat-auto-isolated.txt) |
| High, 2.00× | 9.30 → 13.70 | 11.39 → 9.00 | 7.18 → 6.42 | [Original](../artifacts/blender-pistol-2026-09-04/before-combat-high-isolated.txt) · [Blender](../artifacts/blender-pistol-2026-09-04/after-combat-high-isolated.txt) |

Drawing buffers were 1088 × 523, 1536 × 739, and 2560 × 1232 respectively; the HUD occupies part of the CSS viewport. All GPU timings were available. The Blender runs recorded 0/1201, 4/1190, and 13/1140 intervals over 16.9 ms, with none over 33.5 ms. High's p99 was 17.00 ms. These results retain headroom at p95 but do not certify a minimum 60 presented FPS or an unchanged worst-case frame time. The generic paused benchmark restores the held specimen to fists, so its timings are not pistol measurements.

Automatic and Performance retained identical geometry, texture, and shader-program counts at both measurement endpoints. The first High combat run after page load added one geometry and one texture; retained shader programs stayed at 103. It therefore does not support a claim of zero first-use resource growth. The unit tests independently check that the cached pistol's own buffers and shared maps stay unchanged during firing, aiming, and reloading.

A [second isolated High run](../artifacts/blender-pistol-2026-09-04/after-combat-high-isolated-repeat.txt), after the browser regression had exercised effects and pooled objects, retained identical endpoint counts: 892 geometries, 275 textures, and 161 cached programs. It recorded 16.50 ms rAF p95, 17.20 ms p99, 12.70 ms callback p95, and 5.63 ms GPU p95, with 21/1116 intervals over 16.9 ms and none over 33.5 ms. Both High runs are retained: the pilot fits its geometry/draw limits, but these short runs do not demonstrate equal worst-case performance or sustained 90–120 presented FPS at 2× scale.

Combat fixtures fix the camera, roster, and fire schedule, but ordinary AI, spread, and callback cadence can vary hits, kills, and the resulting whole-scene draw/triangle counts. These are comparable bounded workloads, not deterministic identical frames or causal proof of the asset's timing cost. The exact pistol geometry and draw differences come from the production held-model tests above. rAF intervals describe callback cadence, and GPU queries exclude browser composition. These measurements do not establish a frame-rate guarantee across target hardware.
