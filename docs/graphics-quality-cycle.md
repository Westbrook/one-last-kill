# Graphics quality follow-through — August 29, 2026

This continues the [graphics expansion review](graphics-ceiling-review.md). It is a further implementation and review cycle, not a claim that browser graphics have an absolute ceiling. The earlier report's timings and test counts remain historical; they do not certify these newer assets.

## Review decisions

The first additional pass improved hands, weapon construction, character proportions and clothing, distance-driven gait, interior belongings and roof detail. Close-up review then found problems that the first attractive screenshots had missed. Subsequent passes addressed those problems rather than uniformly increasing polygon counts.

| Review finding | Action and acceptance evidence |
| --- | --- |
| Visible shoulder openings, scalp cracks and an open jaw underside | Closed extracted clothing boundaries and skull caps; rebuilt hair coverage. Compared front, profile and low-angle views. Independent geometry checks inspect actual rendered surfaces, including 5,614 hair-coverage rays. |
| A remaining cuff slit and unnatural eye/jaw shapes | Closed the confirmed cuff gap, reshaped the mandibular edge and neck, narrowed the eye openings and corrected lid coverage and pupil shape. The final front/profile/underside review accepted these changes without increasing triangle counts. |
| Broad, repetitive fingers in shotgun aim | Varied finger reach/curl and sampling, shortened and tapered tips, reduced grip radius and corrected the grip angle. Hip and aimed captures retain the visible hand and clear sights without adding triangles or maps for this correction. |
| NPC guns still looked primitive beside the player weapons | Built reduced shared firearm profiles with shaped stocks/receivers, magazines, open guards, recessed bolts and hollow barrels. Reviewed all four guns in actual NPC poses. Each keeps one cached Mesh with two material groups and the original firing/support anchors. |
| Gait articulation and carry clearance | Support travel follows covered distance, with a smooth swing return, pelvis transfer and head stabilization. Actual completed movement drives visual speed, so blocked actors stop marching. Reviewed both generic walking and the raised combat carry, followed by a real moving melee fixture. |
| Repeated furniture surfaces and bare interiors | Added restrained upholstery variation, books, rugs, folded textiles, fridge notes and supported kitchen belongings. Apartment collision and support records remain unchanged. |
| Block-shaped bread and coarse rust on a food-preparation counter | Added 18 flattened scored loaves, varied paper provisions and a dedicated brushed preparation-steel finish. Shelf end pieces were also corrected to stay supported and clear of the stiles. The rolling-pin/bowl/recipe arrangement stays clear of adjacent boards. |
| Rusty rectangular TV casing | Replaced it with a tapered matte housing, recessed rear vents, bezel and circular dials. Front/rear review retained the original opaque glass, glow, console support and one body shadow caster. Bullet tests now check the actual tapered surfaces and vent backing. |
| Roof surfaces and fixtures lacked local context | Added fitted lintels, drainage, louvers, cowls and restrained roof-membrane variation. Repositioned the existing service lamp and added a sheltered exit lamp using the existing eight-light pool. On/off views retain the cool night exposure and readable routes. |
| Indoor contact shading might be too heavy | Rejected a lower-AO trial after matched kitchen and bakery comparisons: it weakened contacts without revealing useful detail. The actual bakery material defects were more productive to fix. Standard AO remains unchanged. |

A roof-material integration error was also caught: custom finishing hooks ran before structural face ownership, leaving two overlapping roof surfaces. Finishing now follows ownership resolution. Both failures and the later passing browser suite are retained in the evidence directory.

## Persistent health warning

The production HUD now shows a screen-wide, steady red vignette below 40% health and stronger red edges below 20%. The centre keeps a faint tint so the cue spans the screen without obscuring aiming; text and the reticle stay above it.

| Actual health | Cue |
| --- | --- |
| 40% and above | None |
| 20% to below 40% | Low health |
| Above 0% to below 20% | Critical health |
| Dead | Suppressed |

Thresholds use actual health, not its rounded displayed number. Healing reduces or clears the cue; retry restores normal presentation. Pause, briefing and ending screens hide it with the HUD. It is separate from the transient hit flash and includes accessible warning text. There is no animation, blur, new WebGL pass or per-frame texture work; severity changes cause the overlay updates. CSS composition still has a cost and is outside the WebGL GPU timer's scope.

The browser regression uses real damage, supply collection, pause, death and retry paths. Paused health fixtures expose exact boundary samples and explicitly require a reset before ordinary play.

## Asset budgets

These are authoring payloads and material-batch estimates, not complete driver memory or actual camera-dependent render calls. Normal, shadow and reflection passes can render the same object more than once.

| Addition | Recorded budget |
| --- | --- |
| Apartment belongings/material variation | +356 triangles, approximately +5 merged material draws; 256 KiB of atlas mipmaps; 74 colliders and 43 furniture records identical |
| Exterior detail | +2,132 triangles, +1 authored draw; 106,480 bytes of geometry/instance payload; one shared 128² membrane texture, 87,380 bytes including mips |
| Roof task fixtures | +324 triangles, 2 draw meshes, 10,920 geometry bytes; no new shadow maps or textures; existing eight-light selection budget |
| Bakery preparation vignette | 504 triangles, 3 merged draws, 16,720 draw-buffer bytes; no new textures, lights or colliders |
| Bakery loaves, packages and steel | +8,512 triangles, +3 merged material batches, 101,248 cached geometry bytes, 611,672 texture bytes including mips; all 78 collider AABBs and 65 Architecture records unchanged |
| Television housing | +568 triangles, +1 authored main-pass draw, 34,552 cached geometry bytes; no textures, lights or ongoing updates |
| NPC firearm variants | Pistol 856, shotgun 1,172, SMG 1,280 and machine gun 1,320 triangles; two draws each. +600–740 triangles and one draw versus each previous gun; 610,896 total cached geometry bytes; existing finish maps reused |
| NPC body surfaces | 13,438–14,796 triangles in four body draws; later jaw, eye and cuff corrections retain these counts |
| First-person hands | Fists 8,388 triangles / 6 draws; bat with both hands 9,596 / 8; static hand and sleeve 3,858 / 2. Finger-path correction adds no triangles, maps or ongoing uploads. |

Geometry is cached and reused. Gameplay joints, head hit zones, grip and muzzle anchors, weapon timing, movement collision, mission routes and encounter budgets remain the contracts for these visual changes. Current movement is not full world-space foot locking on every turn or stair transition, and the face remains authored geometry with projected fictional albedo rather than a calibrated scan.

The development benchmark now reports full sampled callback cost alongside the original render/simulation sections, with bounded previous/current context for late intervals. It records copied resource counts and optional browser-reported heap values after warmup and before report/reset. These are not GPU memory measurements; stable endpoints do not establish absence of allocation churn or leaks. Other callbacks, browser paint/composition, finalization and time between callbacks remain outside the full callback timer.

## Final validation

`npm run check` passes lint, all **1,345 unit tests** and the production build. The final browser suite passes **57/57**, including actual low-health damage/healing/pause/death/retry behavior, geometry ownership, pooled actors, combat and checkpoint restoration. The production build exposes no development QA even with `qa=1` in its URL; settings, field notes, mission entry, keyboard fallback and pause were exercised with clean warning/error logs. This is a smoke check, not an uninterrupted campaign playthrough.

The build retains its existing large-chunk warning: the main JavaScript is **1,185.06 kB / 361.93 kB gzip**. The warning was not suppressed. One cached local development startup reached ready in **2.459 s**, including 205 ms for maps and 526 ms for world building; that is not a cold-network or production-loading guarantee. Runtime inspection confirmed all six wall PBR channels using ASTC 4×4, seven cached held models, and 32 warmed actor skeletons.

The frozen runtime was measured in **16 ten-second runs**, including repeats after mode changes and normal device/preset runs after clearing the viewport override. On the reviewed **Apple M5 Max**, at **1280×720 CSS pixels**, the runs recorded **19,208 rAF intervals**, **zero above 16.9 ms**, **zero main-thread long tasks**, and a **10.50 ms maximum interval**. Per-run rAF p95 was 9.70–10.30 ms, with approximately 120 callbacks per second. Auto used 1.20×, High 2.00× and Performance 0.85×; each controlled run held its starting ratio fixed.

| Workload | rAF p95 (ms) | GPU p95 (ms) |
| --- | --- | --- |
| Auto street, including repeats/default device setting | 9.90–10.20 | 4.18–4.58 |
| High street | 10.10 | 5.16 |
| Auto roof | 10.20 | 3.62 |
| High roof, including default device setting | 9.80–10.10 | 3.99–4.50 |
| Auto melee | 9.80 | 11.13 |
| High melee and repeat | 10.00–10.10 | 13.98–14.05 |
| Performance street/roof | 9.70–9.90 | 2.55–2.73 |
| Apartment/roof camera sweeps | 9.80–9.90 | 4.55–5.74 |
| High bakery, normal/critical health | 10.30 / 10.30 | 5.62 / 5.57 |

The matched health runs each rendered **220 calls and 117,633 triangles** per frame, with identical **2.40 ms full-callback p95** and no late intervals. The small GPU difference does not establish a performance improvement caused by the overlay. CSS composition is outside the WebGL query. The normal/critical runs preserve the same camera and scene.

Geometry and retained program counts had no net growth within any measured run. The first street run retained one additional texture, 192→193; later measured texture endpoints were stable. Quality switches changed cached resources between runs. These observations do not certify leak freedom.

The High-melee GPU p95 of about **14 ms** is a reason to preserve frame headroom. rAF cadence alone does not prove 120 presented FPS, and these tests do not certify slower hardware, the full adaptive-resolution lifecycle, INP or input-to-photon latency. Combat fixtures replenish player health and replace defeated enemies to sustain actual attacks and contacts. Raw measurements, resource snapshots, CSV and the complete 16-row table are retained beside `final-runtime.json`.

## Evidence and scope

An intermediate timing investigation must not be omitted. The long-lived development review tab produced four degraded runs, including paused Performance rendering: maximum intervals reached 75–125 ms despite short sampled CPU sections and GPU p95. A separate no-renderer browser control was smooth. After closing that review tab and opening a fresh game context, identical Performance-street and High-2× roof controls had no intervals over 16.9 ms. The fresh context then passed all 57 browser regressions and another smooth High-2× roof run. A high-CPU Codex renderer was observed during the anomaly, but no trace establishes its cause. This is a recovered test condition, not a proven game optimization or a reason to erase the slow runs; `timing-investigation.json` links the full record.

Local captures, source snapshot hashes, isolated budgets, rejected-AO records and raw regression reports are under `artifacts/graphics-quality-cycle-2026-08-29/`. Snapshot copies kept ongoing asset edits from invalidating comparisons. Captures use explicit review quality and scale; they do not establish device DPR capability. Runs labelled `VISUAL-ONLY` include screenshot work and are excluded from performance conclusions.

The architecture remains Three.js WebGL. This cycle improves assets, spatial light, motion and review coverage; it does not claim a WebGPU migration, photorealistic scanned assets, universal device performance, an INP score or an absolute graphics ceiling. Further architectural changes should be compared at equal image quality and workload, not credited merely for using a newer API.
