# Character and neighborhood art pass — August 31, 2026

The six combat roles now share a consistent face/skin response, continuous hair perimeters and distinct cloth, leather and armor finishes. Seven closed shops have different construction, signs, windows and occupancy cues. The strongest broad-view improvement is the street; character gains are clearest in profiles, close combat and the brawler's wrist transition. This remains authored prototype art, with simplified anatomy and shallow background displays.

## Baseline and matched evidence

The working tree was clean at `c6d30358f87e68db5fed4ccec788a5ada2433170`. Its source/assets were copied before editing and verified by SHA-256 when served again for a control run. The August 30 assessment supplied priorities, not baseline measurements. This build already contained later gameplay work, which was preserved.

Evidence is in `artifacts/cohesive-art-2026-08-31/`. `index.html` provides an adjustable before/after comparison; `matched-pairs.json` links original captures and their visible QA reports. Captures use **1280×720 CSS pixels, 82° FOV, High, explicit 2× scale (2560×1440 buffer)** and the existing dusk lighting. Automatic comparisons use the normal device/preset setting, **1.2× on this Apple M5 Max**. No screenshot is retouched. Live frames are labeled `VISUAL-ONLY` and are excluded from timing summaries.

## Accepted changes and revisions

| Area | Accepted result and review |
| --- | --- |
| Face and skin | Palette-relative facial color and regional roughness align the face, jaw, neck and arms. The first contrast compression flattened the mouth/jaw too much; the revised response restores those landmarks while retaining restrained chroma. The original generated image is unchanged. |
| Hair | Continuous front/temple/nape profiles replace the abrupt side-cap step. Role-specific crops and subtle part/crown shapes retain recognizable silhouettes. Front, profile, rear and below views were captured for all six combat roles. |
| Clothing and contacts | Directional yarns, edge wear and separate regional finishes distinguish jersey, woven shirts, leather, rubber and armor within four body draws. Existing lathe/palm UVs are preserved. The brawler's bare forearm now meets the existing hand boundary; collars, bones and weapon anchors remain unchanged. |
| Neighborhood | Timber/enamel fronts, central/offset entrances, split shutters, varied sash/casement/industrial windows, blinds and display hints give existing shops distinct identities. Bakery geometry, warm objective lighting and access are retained. |
| Second street review | Consecutive pale fascias still formed a strip, so the barber became oxblood and laundry deeper sage. Square washer hints became round. A geometry inspection found a 5 mm gap behind fascia backing and a 17 mm print separation; the final backing seats into masonry with 2 mm to its printed face. |

The first collapse-review camera crossed the gallery fence and obscured the body. That capture is retained as a rejected **fixture**, not evidence of an art defect. The corrected camera stays inside the gallery. The actual death/release/reacquisition path verified the same pooled rig and resources, with the reviewed brawler surface 6 mm above its support floor.

## Resource costs

| Scope | Change from the fresh baseline |
| --- | --- |
| One cached appearance of each combat role | **+152 triangles**, **+214,838 geometry bytes**, including **123,238 bytes** of finish attributes; **24 body draws unchanged**. Pooled instances share these buffers. |
| Complete street builder, one color pass before culling | **+1,636 triangles**, **+112,728 merged geometry bytes**, **92→84 draws**. Shadow/presentation passes can repeat submissions. |
| Shop signage | Thirteen 1024×256 maps become one 1024² atlas: **17.33→5.33 MiB** estimated RGBA8 mip storage, a **12 MiB reduction**. All nineteen printed planes merge into one draw. |
| Downloads | No new art-file downloads. Main JavaScript grows **14,482 bytes raw / 5,636 bytes gzip** using the same Node gzip calculation. The build's large-chunk warning remains. |

The six 256² skin/cloth maps and 1254² generated face texture retain their storage and sampler counts. All texture painting, geometry construction and merging happen at startup. The finish hook adds vertex data and shader arithmetic; separate combat/civilian shader variants can have startup and retained-program costs. These source-buffer/texture estimates are not complete driver residency.

`character-resource-budget.json`, `storefront-budget.json` and `storefront-batching-uv-check.json` retain detailed accounting. The latter verifies final merged sign UVs and metre-scaled glazing UVs. [Character provenance](character-finish-provenance.md) and [storefront provenance](storefront-kit-provenance.md) record original code authorship, unchanged generated-face provenance and reuse of the existing local CC0/code-authored maps.

## Runtime validation and timing

`npm run check` passes ESLint, **1,518 unit tests** and the production build. The final supported browser suite passes **58/58 checks**. New geometry checks include actual wrist-surface rays, shared shader/geometry ownership across six roles, unchanged shop envelopes, and nearest visible facade/projectile contacts. Live reviews cover walking/carry, turns, attacks, real collapse/reuse and fourteen actual AI-climbed risers. Normal Automatic street play exercised movement, attacks, incoming damage, death and checkpoint retry with reduced motion enabled, without fixture healing. The reviewed frames show no new seam, floating contact or conspicuous cloth shimmer; this is sampled local visual evidence, not cross-device certification.

The first matched ten-second runs are below; CPU is fixture + simulation + render p95. Times are milliseconds. Repeats remain separate in `final-performance-summary.json` and `final-performance.csv`.

| Workload | CPU p95 before → after | GPU p95 before → after | rAF p99 before → after |
| --- | ---: | ---: | ---: |
| Street, High 2× | 6.0 → 5.8 | 5.13 → 4.18 | 9.3 → 9.3 |
| Roof, High 2× | 6.1 → 5.7 | 4.18 → 4.18 | 9.4 → 9.4 |
| Melee, High 2× | 7.0 → 6.5 | 15.52 → 12.44 | 16.6 → 9.3 |
| Street, Automatic 1.2× | 6.3 → 5.5 | 4.42 → 4.58 | 9.4 → 9.4 |
| Roof, Automatic 1.2× | 6.1 → 5.5 | 3.63 → 3.53 | 9.4 → 9.4 |
| Melee, Automatic 1.2× | 6.8 → 6.3 | 7.32 → 7.93 | 9.4 → 9.4 |

The small Automatic melee tail increase prompted repeated controls. Final GPU p95 was **7.93–8.05 ms**; the preserved original later measured **10.80 and 12.17 ms**, alongside its first **7.32 ms**. High-2× melee measured **8.26–12.44 ms final**, versus **10.83–15.52 ms original**. Every melee run retained twelve swings, eleven hits, eight kills and eight replacements, with no skipped or disjoint GPU queries. Corpse/effect details are not deterministic per frame. These results do not isolate an art-induced regression or establish the cause of the variation.

Across nine final timing runs, **10,805 rAF intervals** had **none above 16.9 ms**; the maximum was **9.4 ms**, per-run p95 **9.0–9.3 ms**, and no main-thread long task was observed. Full sampled QA callback CPU p95 was **5.5–6.5 ms**. Callback cadence was approximately **120/s**. The final QA wording explicitly calls it callback rate; the legacy “FPS” label in earlier raw reports meant the same rAF-derived quantity, not presented frames.

At matching cache points the final build retains **eight fewer geometries, twelve fewer textures and six more shader programs**. Both builds' first roof workload retained four additional geometries; later final roof endpoints were stable. One repeat also retained one texture. Endpoints do not prove leak freedom. Observed startup was **2.46–2.51 s original** and **2.49–2.82 s final**; cache/context conditions and limited repeats prevent attributing the difference entirely to art. Detailed startup stages and renderer counts remain in the raw reports.

The production smoke passes menu/Field Notes, quality and reduced-motion settings, briefing, mission entry, normal keyboard movement/attacks and pause. It remains audio-locked, exposes no QA panel/report even with `qa=1`, and has no observed console warning/error. This is a smoke check rather than a complete campaign. `production-smoke.json` retains the observed UI and log results. `final-source.json` and the bundle manifests identify the delivered runtime.

## Limits

The connected garment body retains planar UVs; the preserved circumferential UVs cover skin/neck/boots and palms. Simplified head profiles, angular heavy-role shoulders and partly obscured trigger hands remain. Background displays are shallow occupancy hints backed by the existing solid masses; they are not newly accessible shops. Fine subtext disappears at distance, and browser-provided font metrics can differ across platforms.

GPU queries exclude browser/CSS composition. rAF intervals measure callback cadence, **not presented FPS or input latency**. The supported reports expose GPU median/p95, but not GPU p99/maximum or CPU p99; unavailable values remain null in the parser. Combat fixtures restore health and replace defeated actors, and hold their starting render ratio. Similar aggregate shot/kill counts do not guarantee identical per-frame work. These runs do not certify an uninterrupted campaign, the full adaptive-resolution lifecycle or other hardware.
