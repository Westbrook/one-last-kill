# Two further graphics cycles — August 30, 2026

This follows the [August 29 quality review](graphics-quality-cycle.md). The request was to make two further passes over people, objects and environments, then assess whether more incremental work still justified its cost. Earlier test counts and timings describe earlier builds.

## What the two cycles changed

| Area | First cycle | Second review and decision |
| --- | --- | --- |
| Dropped weapons | Replaced disconnected primitive firearm pieces with the existing reduced NPC geometry. Added a cached, weapon-only knife profile. | Broad receiver highlights looked too polished under the pickup halo. Drop-only steel now reuses the existing darker finish maps; carried weapons, wood/polymer and knife finishes remain unchanged. Accepted. |
| Medical supplies | Replaced the white box with a rounded case, lid seam, latches, folded handle and readable top/side crosses. | The case reads clearly in close views and retains its original pickup cue at gameplay distance. Further small details were not justified. Accepted. |
| People | Lowered the brawler's raised sleeve cap and tailored the upper sleeve using existing vertices. | The shoulder change is modest and retains the same geometry count. A tighter fitted-collar experiment intersected the neck between sample points; its follow-up became fragile subpixel tuning. Rejected that experiment and restored the established collar. |
| Cars | Fitted the pillars to the actual sloped glazing and replaced the separate roof slab with a crowned profile. | Rolled bumper ends remove the conspicuous flat chrome bar, and shaped hood ends retain the cabin, trim and ornament contacts. Both passes reduce geometry. Accepted. |
| Rooftop tank | Corrected the horizontal floorboard mapping to vertical timber staves using the existing wood maps. | The construction reads correctly without adding physical slats. The selected strip deliberately stretches longitudinal grain to avoid board-end joints. Accepted with that limitation. |
| Street cover | The first review identified the central concrete block as a conspicuous primitive. | Replaced its surface with a closed Jersey barrier profile and fitted its existing reflectors to the slope. Its movement envelope remains unchanged. Accepted. |

Reviews used matching camera placements, 1280×720 CSS pixels, High quality and an explicit 2× render ratio. Close object views supplement ordinary street/roof views; they are not a claim that every small detail is equally visible during combat. Character review includes actual pose-driver samples, and final combat checks exercise the live simulation.

## Cost and behavior

| Change | Budget and preserved behavior |
| --- | --- |
| Firearm drops | Pistol 856, shotgun 1,172, SMG 1,280 and machine gun 1,320 triangles; two material groups each. Exact NPC geometry buffers reused. The darker drop materials reuse existing maps and do not mutate NPC/player finishes. |
| Dropped knife | 444 triangles, two material groups, 58,608 cached geometry bytes. Built once at pickup startup; that CPU preparation does not itself prove an explicit GPU upload before the first knife drop. |
| Full drop pool | Existing cap remains 16. Sixteen machine guns change from 4,608 triangles / 144 material draws to 21,120 / 32. This trades more coherent surfaces for fewer draws; neither number includes repeated shadow or other render passes. |
| Health case | 704 triangles / three draws, versus 48 / four. 50,688 shared geometry bytes across all 15 supplies; no textures or additional lights. At most four authored supplies are active in one zone before culling/collection. Original envelope, IDs, collection radius, hover, rotation and halo selection remain. |
| Brawler shoulders | Existing topology, joints and four body draws retained; 13,572 body triangles. No new textures or animation-loop geometry work. Other roles' clothing profiles are unchanged. |
| Five sedans | Cabin and panel passes together save 1,440 triangles and 138,240 merged geometry bytes. All 35 material draws, ten movement boxes, overall vehicle bounds, materials and light properties remain. |
| Tank | Only 98 cylinder-side UV pairs change; no added geometry, maps, draws or frame work. Caps and shared materials are untouched. |
| Central barrier | +16 triangles and +864 typed-array bytes, no new draw, material, map or light. Original collider/support records remain; bullets follow the actual sloped geometry and open upper corners. |

These are source-buffer and material-batch budgets, not complete driver memory or camera-independent rendering costs. Static construction is cached or merged. The new shapes do not add recurring texture generation, reflection captures or shadow maps. Existing health warnings below 40% and 20% are unchanged.

The development-only **Inspect world objects** controls expose the real health case, each weapon drop, sedan, tank, barrier and full 16-drop pool. Inspection explicitly pauses simulation and requires a reset before ordinary play. One early drop framing overlapped an authored health supply; those captures are retained with `fixture-overlap-` names and excluded from the matched weapon comparisons.

## Validation

`npm run check` passes lint, **1,378 unit tests** and the production build. The final frozen build also passes **57/57 browser checks** in 15.35 seconds, including actual pickup/health lifecycles, pooled actors, combat, geometry ownership and checkpoint recovery. The source/assets are recorded in `final-runtime.json` (194 files).

Twelve final ten-second benchmarks on the reviewed **Apple M5 Max**, at **1280×720 CSS pixels**, recorded **14,408 rAF intervals**, **none above 16.9 ms**, and **no observed main-thread long tasks during measurement**. The maximum interval was **10.40 ms**; per-run rAF p95 was **9.00–9.80 ms**, with approximately 120 callbacks per second. Workloads include street and roof combat, repeated melee, the full drop pool, a moving street camera, and a final Automatic run after clearing the viewport override.

| Workload / quality | GPU p95 (ms) |
| --- | ---: |
| Street, Automatic 1.2× / normal device setting | 4.05–4.14 |
| Street / roof, High 2× | 5.37 / 4.62 |
| Melee, High 2×, including repeats and fresh context | 11.77–17.37 |
| Melee, High 1.6× review option | 14.69 |
| Melee, Automatic 1.2× | 12.91 |
| Melee, Performance 0.85× | 11.41 |
| Full 16-drop pool, High 2× | 5.58 |
| Street camera sweep, High 2× | 5.85 |

Combat fixtures replenish player health and replace defeated actors to sustain the workload. Every measured run holds its starting render ratio fixed; this does not validate the entire adaptive-resolution lifecycle. GPU queries are asynchronous and exclude browser/CSS composition. The variable tails below prevent treating isolated p95 values as a reliable quality-mode speed ranking. Callback cadence does not certify presented FPS or input latency.

Renderer geometry and retained-program counts had no net growth within any final run. Two street runs each retained one additional texture; other texture endpoints were stable. Mode changes and context reloads change cached resources between runs. These endpoint observations do not establish leak freedom or complete GPU memory use. Raw reports, CSV and the full table are retained with `final-performance-summary.json`.

Production smoke checks exercised settings, Field Notes, mission entry, keyboard fallback and pause. The production URL exposed no development QA even with `qa=1`, and warning/error logs were clean. This is a basic smoke check, not an uninterrupted campaign or measured interaction score.

The build retains its large-chunk warning: main JavaScript is **1,194.23 kB / 365.94 kB gzip**. It has not been suppressed. Intermediate evidence is retained separately: the combined candidate passed 57/57 browser checks, and its full-pool High-2× run recorded 1,201 intervals with none above 16.9 ms and a 5.29 ms GPU p95. Those intermediate results do not certify later source revisions. Live combat capture runs are labelled `VISUAL-ONLY` and excluded from performance conclusions.

GPU tail variation required an additional control. The early original-build High-2× melee run had a 14.29 ms GPU p95; two later final-build runs measured 17.13 and 17.37 ms. The preserved original source was then served again and verified against its saved hashes. Its two matched High-2× melee controls measured 19.33 and 15.72 ms. Quality, render size, AO samples, shadow fraction, swings, hits, kills and replacement counts matched, with no query skips or disjoint events. The fixture does not fix every random corpse/effect state, so aggregate counts do not establish identical GPU work each frame. These measurements do not isolate a regression caused by the new art, and they do not establish the cause of the variation. All results remain in the evidence; High-2× GPU tails still warrant preserving performance headroom.

A subsequent fresh final-build High-2× melee run measured 11.77 ms GPU p95. It is included alongside the higher runs, not substituted for them. Automatic remains the normal gameplay preset; no quality or workload was silently lowered to replace a slow measurement.

## Stopping assessment

The largest gains in these two passes came from replacing visibly coarse pickup shapes and correcting construction. The later material, shoulder and car-fit changes were smaller. The rejected collar experiment is a useful stopping signal: it added fitting complexity without a robust visible improvement.

This is a sensible place to pause isolated geometry polish. The current art still has visible limits: face, hair, skin and clothing do not yet have one consistently authored finish, and repeated storefront/window treatments dominate broad street views. A further substantial visual jump would be a broader character/environment art effort with its own motion, readability and performance review. These results establish neither an absolute graphics ceiling nor a need to change rendering APIs.

Source manifests, matched captures, per-asset budgets, rejected-trial evidence and raw checks are under `artifacts/graphics-two-cycles-2026-08-30/`. The earlier review's timing anomaly remains in its original report; no new claim about its cause is made here. Keep callback cadence, GPU elapsed time, presented FPS and input latency separate: a smooth local fixture is not cross-device certification or an INP score.
