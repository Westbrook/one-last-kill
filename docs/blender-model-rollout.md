# Blender model rollout — September 4, 2026

The Blender pipeline now supplies nine asset families at startup: the pistol, other held weapons, world weapons, characters, hands, vehicles, supplies/CRT, furniture, and selected world dressing. This extends the earlier [pistol pilot](blender-pistol-pilot.md). Most of the expansion refines original project geometry while retaining its fitted contacts, materials, placement rules, and animation contracts.

This is the historical first-rollout record. Current character/hand budgets and artist export instructions are superseded by the accepted [character and hand fidelity pass](blender-character-hand-fidelity.md).

The actual-game comparisons show modest surface refinement, with firearm edge highlights and sights the clearest improvement. Most changes are subtle; characters and fists look essentially unchanged at 720p. All nine families load successfully, the final automated checks pass, and the measured workloads retain frame-time headroom on the tested machine.

## Delivered families and budgets

All nine families have an editable `.blend` under [assets/blender](../assets/blender/) and a builder under [tools/blender](../tools/blender/). Runtime delivery is under [public/assets/models](../public/assets/models/). Each linked manifest records the current file hash and source provenance.

| Family / manifest | Runtime delivery bytes | Geometry and draws |
| --- | ---: | --- |
| [Pistol](../public/assets/models/pistol/manifest.json) | 670,636 GLB | 2,400 weapon triangles / 3 weapon draws; 6,258 triangles / 5 draws with hand and sleeve |
| [Other held weapons](../public/assets/models/weapons/manifest.json) | 2,111,156 GLB | Knife 464, shotgun 4,880, SMG 4,472, machine gun 5,274 weapon triangles; 2/3/3/3 weapon draws, 4/5/5/5 complete held draws |
| [World weapons](../public/assets/models/world-weapons/manifest.json) | 481,020 GLB | Pistol 758, shotgun 1,144, SMG 1,258, machine gun 1,268, bat 1,208 triangles; 2 draws per weapon |
| [Characters](../public/assets/models/characters/manifest.json) | 5,527,688 binary + 223,232 runtime manifest | Eight appearances, 13,238–14,816 visible body triangles each; 4 draws and the existing 17-bone rig |
| [Hands](../public/assets/models/hands/manifest.json) | 966,724 binary | Eight right-hand shapes at 3,138 triangles each; sleeve 720 and cuff 336; no additional draws |
| [Vehicles](../public/assets/models/vehicles/manifest.json) | 2,505,508 GLB | Five civilian variants at 3,640–3,960 triangles / 6 draws; objective sedan 4,312 / 7 |
| [Supplies and CRT](../public/assets/models/supplies-props/manifest.json) | 303,188 JSON catalog | Health 752 / 3 draws; armor 692–749 / 3–4; CRT housing 724 / 2; complete ammo case 464 / 5 |
| [Furniture](../public/assets/models/furniture/manifest.json) | 38,646 JSON catalog | Six templates at 44–300 triangles; 169 placed meshes use them; no additional draws |
| [World dressing](../public/assets/models/world-dressing/manifest.json) | 227,076 JSON catalog | 28 dimension-specific templates across 185 placements; 8,972 placed triangles; no additional draws |

Bytes are uncompressed encoded delivery sizes, not retained memory. Other than the character manifest, the small sidecar manifests serve provenance and validation rather than the runtime loading path. Draw counts describe the relevant material batches before culling; geometry totals mix individual assets and explicitly labeled placements and must not be added as a scene total.

Only the two held-weapon GLBs add finish images: six shared 256² maps in each catalog, approximately **4 MiB combined RGBA8 storage with mipmaps**. The other seven families reuse existing materials and textures. Procedural fallbacks and their shared resources remain available. Downloads, cached source geometry, decoded images, owned assembly copies, and GPU buffers have different lifetimes; delivery bytes do not measure driver residency or total memory growth.

Useful comparisons from the family construction records:

- The pistol remains 5,632 → 6,258 complete triangles and 6 → 5 draws. The other four held weapons share one three-material finish catalog and preserve their existing complete-model limits.
- World pistol/shotgun/SMG/machine-gun triangles fall from 856/1,172/1,280/1,320 to 758/1,144/1,258/1,268; the bat remains 1,208. The same bat body serves held, NPC, and dropped uses. Dropped knives reuse the held catalog’s 464-triangle, two-material prepared blade with cached geometry.
- Character counts remain unchanged: thug 13,832; brawler 13,618; gunman 13,462; bruiser 14,816; hitman 13,600; enforcer 14,696; shopkeeper 13,570; woman 13,238. Weapons are outside these body totals.
- Hand counts also remain unchanged: 8,388 triangles for complete fists and 3,858 per firearm hand/forearm. Left-hand surfaces are mirrored once at load from the eight shipped right-hand shapes.
- Sedan/hatchback/wagon/panel-van/passenger-van counts are 3,776/3,640/3,776/3,780/3,960. The five installed cars, including the objective, total 17,908 → 19,284 triangles with 31 material draws unchanged. The cache also retains the unused passenger-van option.
- Production apartment geometry changes from 29,486 → 29,390 triangles. Its equivalent 104-entry furniture cache changes from 1,011,616 → 390,056 buffer bytes, a 61.4% reduction; eight piping entries remain procedural.
- World dressing changes from 9,332 → 8,972 placed triangles. Mesh/material counts, lights, and registered support/collision identities remain unchanged.

## What Blender owns

The weapon catalogs add receiver edge breaks, weighted surface normals, cutting bevels, differentiated finish regions, and readable sight inserts. The reduced world guns use chamfered muzzles and cleaned receiver surfaces; the bat has a refined contour within its existing budget.

Character delivery consists of mesh-local surfaces with the original topology, UVs, colors, skin weights, finish attributes, and face projection retained. Blender adjusts garment contours, trouser creases, collar/pocket edges, and cheek/jaw transitions. The game still creates each skeleton, attaches the surfaces, advances animation, handles hits and collapse, and reuses its NPC pools. This is surface refinement against the existing rig, with no new animation clips or retargeting system.

Hands retain their contact topology, padded atlas islands, wrist attachments, and `Clench` morph relationship. Blender refines palm/knuckle/heel contours and sleeves. The geometry-only pack deduplicates equal buffers and quantizes normals and morph deltas; the runtime reconstructs the existing GPU morph path.

Vehicles retain the game’s tire contacts, glazing openings, paint/glass/lamp materials, collision envelopes, placement, scorch behavior, and objective effects. Blender adds targeted physical edge breaks and weighted panel normals. Supplies retain pickup rules, identity marks, labels, stock indicators, and transforms; new geometry supplies recessed lids/latches, pouch chamfers, CRT vent rims, and smoother case profiles.

Furniture remains parameterized assembly. Six Blender meshes supply milled boxes, soft boxes, profiled legs, knobs, cups, and cup handles at the game’s exact dimensions; existing decorations and material batching complete each object. World dressing replaces selected HVAC bodies/vents/fan guards, tank barrel/cap, concrete barrier, cases, handles, and pallet boards. Its templates match known dimensions; the game still places and registers them.

Architecture, room layouts, floors/walls, stairs, doors, collision/support registries, most trim, material assignment, signs, effects, lighting, and gameplay remain code-authored. Exporting an entire Blender scene into the world is not part of this pipeline. Unsupported character configurations, hand radii, furniture cases, and dressing dimensions retain their procedural paths.

## Startup, ownership, and fallback

[main.js](../src/main.js) starts all nine loads concurrently with the existing surface and face maps, then waits before constructing the world, NPC pools, and held-model caches. Readiness is recorded in `graphicsStartup.authoredAssets`. Existing character and viewmodel warmup then compiles/renders the actual selected assets under the loading menu.

Each [authored loader](../src/render/) coalesces concurrent calls, validates its geometry/metadata contract, caches successful results, and uses an eight-second default timeout. Failures preserve the procedural factory path. The four-weapon catalog can report `partial` and retain valid entries while failed weapons fall back individually. A cached partial catalog stays selected for that session; reloading is the reliable way to review a repaired delivery. Loading or retrying after factories have built their caches does not retroactively replace existing scene objects.

Static held weapons receive owned geometry copies because their material batcher consumes the source meshes. Their authored UVs and `COLOR_0` tints survive batching. NPC/world weapons, vehicles, character surfaces, hands, and supplies share prepared buffers through their existing caches. Furniture and dressing return owned dimension/UV-adjusted geometry to the existing immutable assembly caches. Materials remain shared except where the game already needs a per-instance variant, such as scorched vehicle paint.

No Blender process is needed at runtime. Decoding, mirroring, geometric preparation, and batching occur during loading/construction; existing rigid transforms, GPU skinning, and morph animation drive play. JSON/binary catalogs intentionally preserve game-specific attributes and parameterization that a generic scene import would otherwise lose.

## Rebuild and edit workflow

Use Node.js and **Blender 5.2.1 LTS** from the repository root. Each ordinary builder reconstructs its `.blend` and delivery files from the script and, where listed, an exported procedural seed. **An ordinary rebuild overwrites manual `.blend` edits.** Keep edited source copies and incorporate lasting changes into the builder unless using one of the supported export-only paths below.

```sh
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender

"$BLENDER_BIN" --background --python tools/blender/build-pistol.py -- --skip-render

node tools/blender/export-weapon-source.mjs
"$BLENDER_BIN" --background --python tools/blender/build-weapons.py -- --skip-render

node tools/blender/export-world-weapons.mjs /tmp/world-weapons-source.json
"$BLENDER_BIN" --background --python tools/blender/build-world-weapons.py -- --source /tmp/world-weapons-source.json

"$BLENDER_BIN" --background --python tools/blender/build-characters.py
"$BLENDER_BIN" --background --python tools/blender/build-hands.py

node tools/blender/export-vehicle-source.mjs
"$BLENDER_BIN" --background --python tools/blender/build-vehicles.py

node tools/blender/export-supplies-source.mjs
"$BLENDER_BIN" --background --python tools/blender/build-supplies-props.py

"$BLENDER_BIN" --background --python tools/blender/build-furniture.py

node tools/blender/export-world-dressing-source.mjs
"$BLENDER_BIN" --background --python tools/blender/build-world-dressing.py
```

The character and hand builders invoke their Node seed exporters internally. The vehicle seed exporter includes the objective sedan. Studio rendering is skipped explicitly for the two textured held-weapon builders; supplies render only when `-- --render` is requested. Source-review lights/cameras are excluded from runtime exports.

Three builders support exporting saved edits without reconstructing the design:

```sh
"$BLENDER_BIN" --background assets/blender/characters.blend --python tools/blender/build-characters.py -- --export-only
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --export-only
"$BLENDER_BIN" --background --python tools/blender/build-furniture.py -- --export-existing
```

Character edits must preserve vertex count, triangle order, named surfaces, and `game_*` point attributes; export ignores review placement and armature pose. Hand edits must preserve triangular topology and UV seam splits, the active atlas UV layer, `HandTint`, the named `Basis`/`Clench` keys, and contact/attachment limits; object transforms are ignored. Furniture’s export-existing mode opens `assets/blender/furniture.blend` itself and exports local mesh vertices/normals; object placement is only a review layout. Retain its planar-face normals for baked-lighting chart ownership. All three paths read mesh data directly, so unapplied modifiers are excluded. Re-export updates delivery and manifest, but does not waive runtime budgets or geometry contracts.

Pistol, other held weapons, world weapons, vehicles, supplies, and dressing currently have no export-only switch. Manually edited copies need a separate validated export/manifest workflow or corresponding builder changes. A generic Blender GLB export is insufficient for families delivered as custom JSON/binary catalogs.

## Validation and acceptance record

Family tests cover actual delivered buffers and runtime factories, including fallback/retry/timeout behavior, shared-resource ownership, topology/UVs, hand and weapon fit, sight visibility, character skin weights and pooled motion, vehicle tire placement, pickup lifecycle, furniture support/shooting lanes, and dressing collision identities. Useful entry points are the `blender-*.test.js` and `authored-*.test.js` files in [tests/unit](../tests/unit/), together with [weapon](../tools/validate-weapons-assets.mjs), [vehicle](../tools/validate-vehicle-assets.mjs), and [pistol](../tools/validate-pistol-asset.mjs) inspection tools.

```sh
npm run check
```

The final [combined check](../artifacts/blender-model-rollout-2026-09-04/check-final.txt) passed lint, **1,835 unit tests**, and the production build. The final [real-game browser regression](../artifacts/blender-model-rollout-2026-09-04/browser-regression.txt) passed **63/63 checks in 19.70 seconds**. The [defense regression](../artifacts/blender-model-rollout-2026-09-04/browser-defense-regression.txt) completed **10/10 waves in both Rooftop and Street on Average** using real schedules, physics, and death/drop paths. Defense automation uses explicit QA damage; it does not establish human aiming difficulty or combat balance.

The [production smoke check](../artifacts/blender-model-rollout-2026-09-04/production-smoke.txt) passed the normal menu → Average Story → briefing → active apartment flow without QA or production warnings/errors. Its [final screenshot](../artifacts/blender-model-rollout-2026-09-04/production-smoke.png) records the live HUD.

The bake audit caught a real compatibility issue: shared indices connected furniture’s planar faces to its bevels, causing the baker to omit receivers. The corrected exporter separates that topology while preserving positions, surface normals, UVs, materials, and triangle counts. A focused construction fixture matches all 199 receivers and 572 charts before/after; the final batched browser restores the original **101 receivers, 560 charts, and 133,617 rays**. The baker’s smooth-surface exclusion was retained.

The [43 paired actual-game captures](../artifacts/blender-model-rollout-2026-09-04/index.html) cover held/aimed weapons, fists, bat, enemy appearances, vehicles, pickups, furnished rooms, and roof/street dressing. All comparisons were accepted with no visible regressions found, including six recaptured interior/dropped-knife views after the final fixes. The final knife finish restores blade readability. Firearm bevel highlights and sights, ammo-case details, and HVAC details show the clearest gains; the other changes are modest. This does not establish a major fidelity or anatomy upgrade. [Actual startup reports](../artifacts/blender-model-rollout-2026-09-04/after-furniture.txt) record all nine families ready. Studio images are design diagnostics and are excluded from gameplay acceptance.

## Measured performance

Nine paired ten-second workloads ran on an **Apple M5 Max**, with a 1280 × 720 CSS viewport and matched drawing buffers: Auto at 1.2 used 1536 × 739, High at 2.0 used 2560 × 1232, and Performance at 0.85 used 1088 × 523. These are explicit QA scales. Auto/High retain AO; Performance disables it. Only one game tab rendered, and Blender, tests, builds, and screenshots were stopped during timing. All nine after-runs are included.

Across the 18 reports, **21,609 rAF intervals had zero samples over 16.9 ms**; rAF p99 stayed at 9.3–9.4 ms. GPU timing was available without disjoint events. The table gives observed p95 milliseconds, **before → after**; each workload links its two full reports through the [evidence index](../artifacts/blender-model-rollout-2026-09-04/index.html#measurements).

| Workload | Full QA callback p95 | GPU elapsed p95 |
| --- | ---: | ---: |
| Held SMG, Auto 1.2 | 5.40 → 4.60 | 4.54 → 4.98 |
| Held shotgun, Auto 1.2 | 5.40 → 4.60 | 4.67 → 4.40 |
| Held machine gun, Auto 1.2 | 5.20 → 4.60 | 4.67 → 5.03 |
| Held knife, Auto 1.2 | 5.40 → 4.70 | 5.67 → 4.73 |
| SMG combat, Auto 1.2 | 7.50 → 6.60 | 4.46 → 4.36 |
| Shotgun combat, Auto 1.2 | 7.90 → 7.40 | 3.62 → 3.68 |
| Machine gun combat, Auto 1.2 | 8.30 → 7.70 | 4.84 → 4.38 |
| Rooftop combat, High 2.0 | 8.10 → 7.41 | 4.72 → 4.11 |
| Rooftop combat, Performance 0.85 | 7.30 → 6.80 | 2.05 → 2.16 |

Held-run renderer resources were stable at 881 geometries / 264 textures / 102 programs before and 879 / 270 / 103 after. Some combat runs activated shared cache entries: SMG added one texture in both versions (plus one geometry in the baseline), and rooftop High added four geometries in each. Shotgun, machine-gun, and Performance endpoints were stable; programs stayed stable within every run. These are renderer counts, not memory sizes, and two endpoints do not rule out transient allocations or establish per-frame growth. The [parsed evidence data](../artifacts/blender-model-rollout-2026-09-04/evidence-summary.json) retains every resource and optional browser-heap snapshot.

The reports observed 2,904 ms to ready before and 2,044 ms after on these local starts. Cache, network, settings, and initialization history differ, so those are **not controlled cold-load results or evidence of a causal startup speedup**. Fixed combat cameras and fire schedules bound the workload, but normal AI, spread, and cadence vary hits, kills, and whole-scene work. Exact asset geometry/draw changes come from construction checks. Callback cadence and asynchronous GPU queries do not prove presented FPS, input latency, or performance on untested hardware.

The baseline is commit `a5f7f8cdf92b06fcc32199a73b8985c6a60d82ec`, exported to a separate checkout before the Blender work, including the pistol pilot. Its original factories never import the new catalogs. Only the current QA helpers for retained held-weapon poses and selected-weapon combat workloads were copied into that checkout; delivery files and dependencies are shared, and Vite caches are isolated. Baseline port 4186 and current port 4173 run sequentially, with the inactive game tab navigated to `about:blank`. The current side uses this working tree and the final linked manifest hashes.
