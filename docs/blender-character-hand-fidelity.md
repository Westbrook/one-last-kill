# Blender character and hand fidelity pass — September 4, 2026

The gunman and all eight first-person hand shapes now have accepted Blender geometry and baked finishes. Static/motion review, automated checks, defense, and production smoke pass. The timing runs show usable headroom on the tested machine, with occasional long intervals and measurable variation; they do not establish constant FPS. The other seven character appearances retain their accepted geometry from the [nine-family Blender rollout](blender-model-rollout.md).

Historical note: the subsequent [generated hand material and UI follow-up](texture-ui-followup.md) replaces the hand albedo/roughness and updates their hashes, download sizes, and editable source. The hand geometry and normal map remain identical. The measurements and final-file records below describe this earlier fidelity-pass snapshot.

## Comparison baseline

The baseline is the accepted rollout working tree saved at `/private/tmp/blender-fidelity-baseline-vxmliht4`, before this fidelity pass. It already includes the Blender weapon, character-surface, hand, vehicle, pickup, furniture, and dressing integration. It is **not** the earlier pre-Blender commit used in the rollout’s performance comparison.

The [baseline provenance record](../artifacts/blender-character-hand-fidelity-2026-09-04/baseline.json) records the source and delivery SHA-256 hashes. After the snapshot, `src/testing/qa.js` and `src/render/hero-weapon-grips.js` received matching report-only provenance helpers in both copies, without rendering or gameplay changes. The later current-only motion-report description was outside the timed path. The [evidence index](../artifacts/blender-character-hand-fidelity-2026-09-04/index.html) separates accepted before/after comparisons from rejected diagnostics.

| Baseline item | Encoded bytes | Runtime contract |
| --- | ---: | --- |
| Character catalog | 5,527,688 binary + 223,232 manifest | Eight appearances; gunman 13,462 visible body triangles / 4 body draws / 17 joints |
| Hand catalog | 966,724 binary + 2,439 manifest | Eight right-hand shapes at 3,138 triangles each; left hands mirrored at load |
| Shared hand clothing | Included in hand catalog | Sleeve 720 triangles; cuff 336; complete fists 8,388 triangles / 6 meshes |
| Editable character source | 6,060,210 | `assets/blender/characters.blend` |
| Editable hand source | 728,592 | `assets/blender/hands.blend` |

All six recorded baseline files were verified against their sizes and SHA-256 hashes. These are delivery/source file sizes, not decoded CPU buffers or GPU memory. Baseline hands use three generated 256² skin/glove maps plus three generated 128² clothing maps, approximately 1.25 MiB of RGBA storage with mipmaps. Characters use their existing procedural cloth/skin maps and projected fictional facial albedo. Those resources, rigs, morph animation, contact fitting, and caches form part of the baseline; this pass must account for replacements and additional retained copies.

Baseline complete held geometry is fists 8,388 triangles / 6 meshes; bat 9,596 / 8; knife 4,322 / 4; pistol 6,258 / 5; shotgun 12,596 / 5; SMG 12,188 / 5; and machine gun 12,990 / 5. These include hands and clothing. The 29 baseline images comprise 27 scene reports and two face crops; their reported Auto 1.2 drawing buffer is 1536 × 739.

## Authored scope and editing

The gunman has remodeled jaw, chin, brow, cheek/nose transitions, shoulders, torso, garment drape, and neck forms, with a baked surface finish. It retains the existing 17-joint production rig, contact locations, and four body material draws. The gunman uses **14,698 triangles versus 13,462 before** (1,236 more, approximately 9.2%), leaving 302 triangles under the existing 15,000-triangle ceiling. Its two editable sculpt masters contain 191,616 garment and 413,952 head triangles; those dense meshes do not ship to the game. This does not imply that all enemy appearances have been remodeled.

The final [character delivery provenance](../artifacts/blender-character-hand-fidelity-2026-09-04/character-final-provenance.json) records a 5,719,764-byte binary (+192,076) and 225,634-byte manifest. Four shared 512² tangent-normal/roughness PNGs total 957,054 encoded bytes, approximately 5.33 MiB of RGBA storage with mipmaps. The accepted projected facial albedo remains; there is no new face color image. The other seven character entries retain their exact earlier runtime buffers.

The hand work covers the fist and grip radii `0.015`, `0.022`, `0.030`, `0.034`, `0.036`, `0.038`, and `0.040` metres. It retains 3,138 triangles per hand and uses anatomical atlas regions with three replacement 512² finish maps for nail/cuticle form, skin folds, glove panels, seams, and stitching. The [final hand provenance](../artifacts/blender-character-hand-fidelity-2026-09-04/hand-source-provenance.json) records a 967,888-byte binary (+1,164), 5,769-byte manifest, and 458,956 bytes of PNGs. These maps occupy approximately 4 MiB with mipmaps, replacing approximately 1 MiB of existing hand maps; the shared sleeve/cuff maps remain. Albedo uses sRGB; tangent normals and roughness use linear data. Exporting the saved source reproduces the binary and all three accepted PNGs byte for byte.

The hand atlas master contains 301,248 triangles; its isolated bake uses 177,984 triangles to prevent neighboring fingers and atlas regions from projecting onto each other. These meshes remain in the editable source. An [independent PNG round-trip check](../artifacts/blender-character-hand-fidelity-2026-09-04/hand-png-roundtrip-verified.json) also found zero changed decoded channels in all three maps after source export. Encoded download sizes and these RGBA estimates do not measure driver residency or total retained memory.

The two packs add 193,240 encoded geometry bytes in total. Selected texture storage increases by approximately **8.33 MiB with mipmaps**: 5.33 MiB for the gunman plus the 3 MiB hand-map replacement difference. Shared resources are reused across actors and held weapons; fallback resources can coexist. Final source files are 35,735,165 bytes for characters and 23,123,084 for hands. All [16 final source/delivery/tool hashes](../artifacts/blender-character-hand-fidelity-2026-09-04/final-file-verification.json) match the authoring provenance.

The source families remain under [assets/blender](../assets/blender/), with builders in [tools/blender](../tools/blender/) and runtime catalogs in [public/assets/models](../public/assets/models/). Export saved low-mesh edits, or rebake saved dense sculpt masters before exporting:

```sh
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender

# Export the saved character low meshes and UV edits.
"$BLENDER_BIN" --background assets/blender/characters.blend --python tools/blender/build-characters.py -- --export-only

# Rebake the saved gunman masters onto the saved low meshes.
"$BLENDER_BIN" --background assets/blender/characters.blend --python tools/blender/build-characters.py -- --bake-only

# Export saved production geometry, UVs, and paired shape keys.
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --export-only

# Rebake the edited saved sculpt master, then export geometry and maps.
"$BLENDER_BIN" --background assets/blender/hands.blend --python tools/blender/build-hands.py -- --bake
```

Gunman low meshes can change topology: the exporter transfers game attributes from the preserved reference, combines and normalizes bone weights, and splits UV seams. Preserve the reference collections and production binding attributes. Review placement and armature poses are excluded. A default character rebuild restores the accepted reference and reconstructs the gunman sculpt, overwriting manual low/master edits; `--rebuild-base` additionally recreates the procedural seed. Use the two saved-edit commands above for artist work.

Hand edits live in the `GAME` meshes’ `Basis`/`Clench` keys and the saved `SCULPT_Atlas_Master`. Maintain the paired contact poses, shared semantic atlas layout, and production topology; review transforms are excluded from runtime geometry. The new hand builder preserves the saved source. Its explicit `--upgrade` option performs the one-time migration from the earlier source and is not part of ordinary artist export or rebaking. Final validation still applies after manual edits.

Both low-mesh exporters read raw mesh data, so unapplied modifiers and review poses are excluded; use triangulated production meshes. Hand export uses the named `Basis`/`Clench` keys, active atlas UVs, and `HandTint`. Hand rebaking evaluates a private copy of the saved sculpt master, including its modifiers and shape values; preserve the POINT `SculptAlbedo` and `SculptRoughness` attributes. Hand export-only also publishes the three saved packed images and refreshes their size/hash metadata. Character rebaking preserves the existing high-master roughness material and can evaluate high modifiers while low modifiers are disabled. Gunman weights come from Blender vertex groups; head/garment UVs use the active UV layer, while other character UVs remain `game_uv_*` point attributes. Gunman `GameColor` paint exports from either POINT or CORNER domain, splitting vertices where corner colors differ. The other seven character exports retain their existing `game_color_*` point attributes.

Both geometry and finish load before world/pool/viewmodel construction and shader warmup. The new hand geometry and three maps are selected together; failure uses the existing geometry/material path instead of pairing the new atlas with incompatible UVs. The character catalog likewise publishes only after its gunman finish loads; failure retains the existing character factory path. Successful assets and maps are shared through caches, with no per-frame bake or image generation. Final browser reports confirm both prepared packs and their baked finishes are active.

## Validation and acceptance

The [combined check](../artifacts/blender-character-hand-fidelity-2026-09-04/check.txt) passed lint, **1,856 unit tests**, and the production build. The [real-game browser regression](../artifacts/blender-character-hand-fidelity-2026-09-04/browser-regression.txt) passed **63/63 checks in 19.37 seconds**. [Defense regression](../artifacts/blender-character-hand-fidelity-2026-09-04/defense-regression.txt) passed **10/10 waves each on Rooftop and Street at Average difficulty**; it uses explicit QA damage rather than human aiming.

The [production smoke](../artifacts/blender-character-hand-fidelity-2026-09-04/production-smoke.txt) reached the active apartment through the normal menu and briefing, without QA, with fists and 100 health. [Fresh production logs](../artifacts/blender-character-hand-fidelity-2026-09-04/production-logs.json) contain zero warnings/errors. Historical development HMR warnings remain in the separate development log; they are not represented as a clean production run.

Both final [body](../artifacts/blender-character-hand-fidelity-2026-09-04/after-motion-body.txt) and [grip](../artifacts/blender-character-hand-fidelity-2026-09-04/after-motion-grip.txt) motion reviews completed walking/carry, turns, guard/aim, collapse, and reuse. They verify the same pooled slot and mesh resources, with collapsed skin at least 6 mm above the floor. Living poses use production animation inputs with AI and hit tests paused; the sequence does not verify traversal, human aiming, or attack timing. Kill/drop/release and same-slot recycling use their real paths.

The [29 paired views](../artifacts/blender-character-hand-fidelity-2026-09-04/index.html) include gunman body/face/grip views, fists, bat and knife phases, firearm hip/aim views, and the offhand. The primary and independent reviewers accepted the final direction, and all ten gunman captures were refreshed after the carry-pose correction. That correction changed arm binding weights without changing topology, positions, UVs, or maps. Static comparisons use the same Auto 1.2 cameras and drawing buffers. These are visual fixtures driven by production pose code with simulation paused; they do not establish combat correctness. Rejected candidate images and unsynchronized carry-pose screenshots are retained only as diagnostics, outside the accepted comparison set. Studio images alone do not establish gameplay quality.

## Performance evidence

The [17 full reports](../artifacts/blender-character-hand-fidelity-2026-09-04/index.html#measurements) retain seven primary pairs plus three late controls; none are excluded. Each measured ten seconds on an Apple M5 Max at 1280 × 720 CSS pixels, with one rendered game tab and no concurrent Blender, builds, tests, or screenshots. Matched buffers were 2560 × 1232 for High 2.0, 1536 × 739 for Auto 1.2, and 1088 × 523 for Performance 0.85. The baseline is the accepted rollout described above.

Observed milliseconds, **before → after**:

| Primary workload | rAF p99 | Full QA callback p95 | GPU p95 |
| --- | ---: | ---: | ---: |
| Gunman guard, High 2.0 | 9.30 → 9.40 | 5.40 → 7.20 | 5.24 → 4.76 |
| Fist contact, High 2.0 | 9.30 → 9.30 | 4.80 → 5.90 | 5.95 → 5.34 |
| Machine-gun combat, Auto 1.2 | 9.30 → 9.40 | 7.30 → 7.90 | 4.12 → 3.55 |
| Bat melee, Auto 1.2 | 9.30 → 9.40 | 8.10 → 8.50 | 8.48 → 8.64 |
| Bat melee, High 2.0 A | 9.40 → 9.30 | 8.20 → 8.80 | 11.54 → 9.39 |
| Bat melee, High 2.0 B | 9.30 → 16.26 | 8.40 → 8.80 | 10.23 → 12.82 |
| Bat melee, Performance 0.85 | 9.40 → 9.30 | 7.50 → 7.70 | 7.49 → 7.55 |

Primary callback p95 rose by 0.2–1.8 ms; GPU changes were mixed. The late gunman control measured callback 6.80 → 6.50 ms and GPU 8.01 → 7.85 ms, while an additional baseline High melee run reached GPU p95 14.39 ms. The late after-gunman GPU sample skipped 59 frames (1,101 completed samples and three queries still pending), so that comparison lacks full-frame coverage. These controls had different cache histories and demonstrate variability rather than isolate an asset cost. No sustained FPS loss is demonstrated by this sample, and it does not prove zero added rendering cost.

All outliers remain in the evidence: the primary baseline melee Auto run had one interval over 16.9 ms; the after gunman run had two, and after High melee B had four. Late gunman controls had eight before and ten after; the latter included one **34.2 ms** interval. No interval exceeded 50 ms. GPU queries had no disjoints or discarded results, but skipped one frame in the first after-gunman run and **59 frames** in its late after-control, limiting interpretation of that GPU sample. Callback cadence is not presented FPS or input latency.

Primary static renderer counts were stable at 879 geometries / 270 textures / 103 programs before and 879 / 274 / 108 after. All after-run endpoints were stable; the primary baseline machine-gun run added one geometry and one texture. Late controls retained different caches. These counts and optional browser heap are preserved in [parsed/raw evidence](../artifacts/blender-character-hand-fidelity-2026-09-04/evidence-summary.json); they are not driver-memory measurements or proof of allocation-free frames. Local ready times were 2,171 ms initially before, 2,000 ms in late baseline controls, and 2,000 ms after, with different cache/settings history; they are not cold-load benchmarks. Fixed combat fixtures still vary normal hits, kills, and whole-scene work. Performance on other hardware remains untested.
