# Graphics review — August 29, 2026

The accepted work improves material scale, furniture and weapon finishes, ranged-character grips, distant windows and edge stability while retaining the WebGL renderer and existing gameplay rules. The [task series](graphics-roadmap.md) records the option assessment and subsequent asset, lighting and WebGPU experiments.

**Final validation:** lint, the production build, 1,096 unit tests and [56/56 silent browser checks](../artifacts/graphics-review-2026-08-29/regression-pass4.txt) pass after the final aimed-view sight polish. Seven final combat measurements and a limited production smoke check are recorded below. These results do not establish an INP score or certify minimum hardware.

## Four review passes

| Pass | Work and acceptance boundary |
| --- | --- |
| 1 — Materials | Corrected physical UV density on decorative boxes and differently sized environment batches. Added shared steel, polymer, wood, glove and sleeve finishes to held weapons; merged their rigid parts by material without moving muzzle anchors. |
| 2 — Silhouettes and surroundings | Replaced wallpaper upholstery with woven fabric and appliance plaster/tar with enamel/rubber. Rounded only cushions and bedding. Corrected ranged NPC support grips with reachable arm targets. Added one small opaque window texture to existing distant-window instances. |
| 3 — Presentation, warmup and QA | High uses up to 4× world-target MSAA; Auto retains 2×, and Performance bypasses contact shading and shadows. Rounded adaptive-scale steps keep the 1.0 AO threshold stable. Boot prepares all seven cached held models behind the loading menu, with state restoration and a first-use fallback. QA gained explicit review scales, firearm hip/aim views, GPU queries and fuller timing reports. |
| 4 — Final aimed-view sight polish | A further close review found solid blocks where pistol/SMG/machine-gun rear notches should be. Open sights and aligned front posts now retain the original overall bounds and material draw budgets. Actual geometry raycasts and projection checks cover three FOVs and aspect ratios; the final aimed views were also inspected in the browser. |

The furniture audit found all 74 apartment collider bounds and 43 furniture support records unchanged. No new practical lights, gameplay hit volumes or attack rules were introduced. The existing eight-light pool, bounded effects and fixed-step simulation remain in place.

Representative local captures include [upholstered furniture](../artifacts/graphics-review-2026-08-29/final-apartment-cushions.png), [the street](../artifacts/graphics-review-2026-08-29/final-street.png), [the rooftop](../artifacts/graphics-review-2026-08-29/pass2-roof.png), and the SMG sight [before](../artifacts/graphics-review-2026-08-29/final-smg-aim.png) / [after](../artifacts/graphics-review-2026-08-29/pass4-smg-aim.png) the fourth pass. All eight areas, all six enemy roles, firearm hip/aim framing and representative melee poses were inspected. Paused review now hides transient narrative overlays; ordinary gameplay keeps them.

## Resource and draw budget

These are incremental authored buffer/map estimates, not a measurement of total GPU memory. Mip estimates exclude driver padding, render targets and existing shared assets.

| Investment | Bounded cost or saving |
| --- | --- |
| Static environment UVs | About 0.75 MiB of additional geometry storage; converted box batches retain their draw counts, triangles and physical extent. |
| Upholstery and enamel | Two shared materials; approximately 1.083 MiB including mipmaps. Seven rounded pieces add 672 triangles through five cached shapes, with no additional authored meshes or colliders. Up to three additional material batches per apartment. |
| Held-weapon finishes | Seven shared finish profiles, 21 small maps, about 1.75 MiB including mipmaps; one shared sight material. No per-frame baking. |
| Distant windows | One 64×128 RGBA map, about 43 KiB including mipmaps; no additional window draws, transparency passes or lights. |
| Rigid weapon batching and sights | Draws versus the original: knife 11→5, pistol 23→6, shotgun 14→4, SMG 14→5, machine gun 18→5. Final triangles: knife 2,072; pistol 4,600 (−264); shotgun 2,212; SMG 2,704 (+36); machine gun 2,904 (+36). Other weapon geometry is unchanged. |
| High-quality edges | Four multisamples rather than two on the world beauty target, capped by hardware. Attachment cost increases with resolution; explicit quality changes release/rebuild the affected resources. |
| GPU timing | Development QA only, four reusable queries by default and a bounded 2,048-sample window; unfinished queries never block rendering. Zero-bit/invalid elapsed counters report unsupported rather than fabricated zero timings. |

Warmup shifts cached geometry, texture uploads and shader preparation into loading. It does not prove that a future context, driver or material variant cannot stall.

## Rejected image trials

Two built-in edits of the existing brick were rejected. Although vertical edge RGB error fell from 19.381 to 15.205 and then 10.616, the last course became shortened and the wrapped mortar joint remained too wide. The second trial also coarsened the clay grain. Numerical boundary agreement did not establish visually seamless masonry.

The original brick and runtime references remain unchanged. [Exact prompts, measurements and output provenance](../public/assets/brick-weathered-v2.prompt.txt) are retained. The built-in tool does not expose a model selector, so these trials do not establish that GPT Image 2 specifically ran. No runtime generation service or API key was added.

## Controlled performance

All runs used the local in-app browser and silent Vite development QA, a 1280×720 CSS viewport, a fixed camera, a 0.5-second warmup and approximately ten seconds of controlled combat. Street used up to four contacts, roof up to five, and balcony melee up to two; fixtures replenished health and replaced defeated enemies. Spawn, hit and kill differences affect per-frame draw/triangle averages, so these are sustained workloads rather than identical replay traces.

Times are milliseconds. CPU includes fixture work, simulation and render submission. Links point to the complete local reports under the ignored artifact directory; they resolve in the reviewed workspace and are not additional tracked screenshot assets. “—” means the earlier instrumentation did not record that metric.

The final revision is identified by [source and build hashes](../artifacts/graphics-review-2026-08-29/source-manifest.json); [structured measurements](../artifacts/graphics-review-2026-08-29/performance-summary.json) preserve the figures below.

| Final workload | Quality / ratio | rAF median / p95 / p99 | CPU median / p95 | GPU median / p95 | Calls / triangles per frame |
| --- | --- | --- | --- | --- | --- |
| [Street](../artifacts/graphics-review-2026-08-29/pass4-street-auto.txt) | Auto / 1.20 | 8.30 / 9.30 / 9.40 | 2.90 / 5.30 | 2.06 / 4.66 | 829 / 165,834 |
| [Roof](../artifacts/graphics-review-2026-08-29/pass4-roof-auto.txt) | Auto / 1.20 | 8.30 / 9.30 / 9.40 | 2.80 / 5.20 | 1.68 / 3.77 | 789 / 162,770 |
| [Balcony melee](../artifacts/graphics-review-2026-08-29/pass4-balcony-auto.txt) | Auto / 1.20 | 8.30 / 10.30 / 10.40 | 3.40 / 6.10 | 2.78 / 9.15 | 929 / 183,010 |
| [Street](../artifacts/graphics-review-2026-08-29/pass4-street-high.txt) | High / 1.60 | 8.30 / 10.30 / 10.40 | 3.00 / 5.50 | 3.35 / 5.14 | 842 / 168,194 |
| [Roof](../artifacts/graphics-review-2026-08-29/pass4-roof-high.txt) | High / 1.60 | 8.30 / 10.20 / 10.40 | 2.90 / 5.30 | 3.43 / 4.68 | 797 / 164,992 |
| [Balcony melee](../artifacts/graphics-review-2026-08-29/pass4-balcony-high.txt) | High / 1.60 | 8.30 / 10.30 / 10.40 | 3.30 / 6.00 | 2.74 / 7.36 | 928 / 182,936 |
| [Street](../artifacts/graphics-review-2026-08-29/pass4-street-performance.txt) | Performance / 0.85 | 8.30 / 10.10 / 10.30 | 2.20 / 4.90 | 0.92 / 1.58 | 257 / 77,804 |

These seven final runs recorded 8,402 rAF intervals, approximately 120 callbacks/second on average, zero intervals above 16.9/33.5/50 ms, and zero observed main-thread long tasks. Each run ended with one pending GPU query and no skipped, disjoint or discarded results. The original Auto street/roof cadence was also approximately 120 Hz, with p95 9.2 ms; the graphics changes preserved similar cadence rather than establishing an FPS increase.

<details>
<summary>Earlier baseline and intermediate-pass measurements</summary>

The following reports precede the fourth sight pass, including files originally named `final-*`. They remain available so the review history and heavier melee samples are not hidden.

| Report / workload | Quality / ratio | rAF median / p95 / p99 | CPU median / p95 | GPU median / p95 | Calls / triangles per frame |
| --- | --- | --- | --- | --- | --- |
| [Baseline street](../artifacts/graphics-review-2026-08-29/baseline-street-combat.txt) | Auto / 1.20 | 8.30 / 9.20 / — | 2.70 / 5.10 | — | 841 / 167,178 |
| [Baseline roof](../artifacts/graphics-review-2026-08-29/baseline-roof-combat.txt) | Auto / 1.20 | 8.30 / 9.20 / — | 2.70 / 5.10 | — | 798 / 163,302 |
| [Pass 2 roof](../artifacts/graphics-review-2026-08-29/pass2-roof-high-native.txt) | High / 1.00 | 8.30 / 9.30 / 9.40 | 2.80 / 4.90 | 2.48 / 3.12 | 795 / 164,145 |
| [Street](../artifacts/graphics-review-2026-08-29/final-street-auto.txt) | Auto / 1.20 | 8.30 / 9.30 / 9.40 | 2.80 / 5.50 | 2.67 / 3.93 | 830 / 164,582 |
| [Roof](../artifacts/graphics-review-2026-08-29/final-roof-auto.txt) | Auto / 1.20 | 8.30 / 9.30 / 9.30 | 2.80 / 5.60 | 2.21 / 3.44 | 794 / 164,287 |
| [Balcony melee](../artifacts/graphics-review-2026-08-29/final-balcony-auto.txt) | Auto / 1.20 | 8.30 / 9.20 / 9.30 | 3.30 / 5.80 | 2.64 / 10.02 | 928 / 182,958 |
| [Balcony melee repeat](../artifacts/graphics-review-2026-08-29/final-balcony-auto-repeat.txt) | Auto / 1.20 | 8.30 / 9.80 / 10.30 | 3.30 / 5.60 | 3.08 / 10.75 | 929 / 183,026 |
| [Street](../artifacts/graphics-review-2026-08-29/final-street-high.txt) | High / 1.60 | 8.30 / 10.10 / 10.30 | 2.80 / 5.00 | 3.40 / 4.99 | 842 / 168,149 |
| [Roof](../artifacts/graphics-review-2026-08-29/final-roof-high.txt) | High / 1.60 | 8.30 / 9.30 / 9.40 | 2.80 / 5.40 | 3.23 / 3.90 | 789 / 162,768 |
| [Balcony melee](../artifacts/graphics-review-2026-08-29/final-balcony-high.txt) | High / 1.60 | 8.30 / 10.21 / 10.40 | 3.50 / 5.80 | 3.14 / 10.73 | 928 / 182,928 |
| [Street](../artifacts/graphics-review-2026-08-29/final-street-performance.txt) | Performance / 0.85 | 8.30 / 10.00 / 10.30 | 2.00 / 5.50 | 1.44 / 1.74 | 254 / 76,947 |

Every run averaged 8.33 ms between rAF callbacks, approximately 120 callbacks/second. All nine instrumented reports recorded zero intervals above 16.9, 33.5 or 50 ms and zero observed main-thread long tasks. GPU runs had no skipped/disjoint/discarded results and one or two pending queries at collection; pending work was not forced to finish.

</details>

**Melee retains a GPU-time tail:** final Auto p95 was 9.15 ms, with 7.36–10.75 ms across the recorded Auto/High repeats. Several runs exceed the 8.33 ms budget for 120 presented frames per second even though callback cadence stayed near 120 Hz. This variation is not evidence of a melee GPU optimization. GPU elapsed can include scheduling effects within the measured command interval. [Khronos timer-query specification](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_disjoint_timer_query.txt)

rAF cadence is not a presented-frame counter; GPU elapsed time also does not measure input-to-photon latency. Neither zero long tasks nor these controlled results establish an INP score, a minimum-device guarantee or an uninterrupted campaign playthrough. CPU and GPU percentiles must not be added: their work overlaps, and the percentile samples are not paired. Baseline GPU timings were not captured, so no GPU speedup against baseline is claimed.

Review ratios were held explicitly: 1.20 means 1536×864 pixels, 1.60 means 2048×1152, and 0.85 means 1088×612. Auto/High used half-resolution AO with 8/12 AO samples and eight denoise samples; Performance used no post passes or shadow rendering. Fixed review scales are QA overrides, not device capabilities or a full adaptive-quality test.

## Regression corrections and production smoke

The [first browser run](../artifacts/graphics-review-2026-08-29/regression-first.txt) exposed three fixture defects; the [corrected run](../artifacts/graphics-review-2026-08-29/regression-final.txt) passed all 56 checks in 12.33 seconds:

- Horizontal-face auditing now applies each instance transform, including the ammo-cache feet; it does not treat their shared source geometry as one untransformed object.
- The closed-door probe locally excludes story-fire collider references, matching the existing door-only unit fixture. Live fire/collision state remains untouched. The original inside approach was intentionally occupied by the fire on both HEAD and this revision.
- The stair-arrival fixture protects health only during stationary waits for finite arrival/slot policy, records incoming damage, and restores prior health. Actual bypass movement retains separate 63/90-HP checks; no production invulnerability or survival rule changed.

QA review also corrected instanced triangle totals, retained explicit scales across resize/settings events, aborted resized benchmarks, and deferred final long-task collection until the measured callback could complete. These changes improve the evidence rather than relaxing gameplay checks.

The final repeat passed 56/56 checks in 12.45 seconds. `npm run check` passed lint, 1,096 tests and the production build; the [full log](../artifacts/graphics-review-2026-08-29/final-check.log) retains the bundle warning. The production main chunk is 952.28 kB minified / 279.81 kB gzip. QA controls and GPU-timer code are absent from the production JavaScript.

[Resize checks](../artifacts/graphics-review-2026-08-29/resize-fixed-scale.txt) confirmed that a 1.60 review ratio survives a 960×540 viewport change. A deliberately [resized benchmark](../artifacts/graphics-review-2026-08-29/resize-benchmark-abort.txt) reported incomplete instead of publishing mixed-resolution timing. Entering ordinary play restored the [device/preset scale](../artifacts/graphics-review-2026-08-29/ordinary-scale-reset.txt). Temporary browser viewport overrides were removed.

The packaged game at `http://127.0.0.1:4175/?mute=1` passed a [limited production smoke check](../artifacts/graphics-review-2026-08-29/production-smoke.json): boot and briefing, menu resume, native P-key pause, all three graphics modes, resize and real checkpoint retry after unattended fire damage. The quality modes produced 2048×1152, 1536×864 and 1088×612 drawing buffers at the normal 1280×720 viewport. No QA panel or browser-console warnings/errors appeared; audio stayed locked off. The preview was left paused with Automatic selected.

This smoke check does not certify continuous native keyboard/mouse movement: brief automated W/arrow taps and Enter while a menu button retained focus did not establish that result. Continuous movement, aiming, combat, collision and pause semantics were exercised by the separate 56-check game QA suite. A sustained manual campaign, real input-latency capture and testing on the intended minimum device remain release gates.

The brick still has its documented vertical-repeat limitation. Characters, hands and most props remain procedural assets; proper UV-unwrapped hero models, baked detail, animation refinement, LODs and compressed textures remain substantial next investments. The current production JavaScript is still roughly 0.95 MB minified with a large-bundle warning, and the entire world remains resident. This pass does not add asset streaming, a bundle split or a WebGPU migration. Minimum-hardware/browser coverage and sustained ordinary-play input latency remain unestablished.
