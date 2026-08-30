# Graphics expansion and acceptance review — August 29, 2026

This continues the four earlier passes recorded in [graphics-review.md](graphics-review.md). The work targets the largest remaining visible weaknesses of the existing Three.js/WebGL game, while retaining responsive combat and bounded rendering costs. It is not a claim that WebGL, web games, or this project have an absolute graphics ceiling.

## What changed and why

| Investment | Accepted change | Cost and guardrails |
| --- | --- | --- |
| Characters | Connected, GPU-skinned garment surfaces, shaped shoulders/limbs/boots, sculpted faces and reviewed frontal facial albedo. Independent bones retain the original rig, attack and grip contracts. | Four actual body draws per actor; 12,712–14,976 triangles depending on role. The face uses one shared 1254² image, just under 8 MiB including RGBA8 mip levels. Hidden bounds proxies are not counted as visible art. |
| Player hands | A connected palm, fingers, thumb and wrist surface, tailored sleeve, shared materials and a GPU clench morph. | Fists: 6,244 triangles and six draws. No recurring geometry-buffer uploads. Camera, reticle and bat checks inspect deformed vertices. |
| Weapons | Shaped receivers, stocks, magazines, grips, open guards and sights, hollow barrel ends, corrected physical UVs, restrained finish variation and a readable knife orientation. | Including hands: knife 3,314 triangles / six draws; pistol 4,350 / six; shotgun 7,884 / six; SMG 7,572 / five; machine gun 8,312 / five. Original damage, reload/contact clocks and muzzle anchors remain intact. |
| Furniture | Upholstered construction and piping, shaped chair/table supports, appliance controls/handles/glazing, dedicated wood and linen finishes. | +18,816 authored triangles; estimated +six merged world draws before culling/shadow passes. All 74 colliders and 43 support records are unchanged. New finish maps replace more costly unused fabric maps. |
| Wall materials | Matching licensed color, OpenGL normal and roughness maps replace estimated relief from generated color images. | Brick repeats every 1.4 m; plaster every 4 m. Atomic loading retains generated and procedural fallbacks. See [material provenance](../public/assets/materials/manifest.json). |
| Interior light | Static fixture fill and contact occlusion on actual indoor triangles. | One 512² linear atlas, at most 300,000 visibility rays during boot, time-sliced baking, no additional render pass/light/draw. This is authored diffuse fill, not a radiosity solve or real-time GI. |
| Reflections | Three isolated 64px room captures for eligible kitchen/preparation finishes. | About 1.97 MiB resident. No recurring captures or additional steady-state draws. Mixed indoor/outdoor batches and transient actors, weapons, particles and fire are excluded. |
| Shadows | Conservative camera-dependent cropping of the existing 2048² directional shadow map. | Fixed texel-aligned tiers, preserved light direction/caster depth, downstream ground coverage, and full-map fallback. Theoretical density gains are checked against the actual scene, not assumed from unit fixtures. |
| First encounter | Warm character and held-weapon variants before enabling play, including every real skeleton texture and cached skin sorting bounds. | Restores render/scene state on errors. Covers the current light/shadow configuration; it does not promise to precompile every future driver or quality-setting combination. |
| High-detail sampling | Permit up to 2.0× render scale on smaller high-DPI viewports, retaining four world MSAA samples within device limits. | Automatic and Performance are unchanged. The added scale allowance is capped by a 4 Mi-pixel drawing buffer; larger viewports retain the former 1.6× ceiling. Device pixel ratio remains an upper bound. This is not a universal 4 Mi-pixel cap or frame-rate guarantee. |

These are original code-authored meshes and animation, not imported scanned people, motion capture or a physically simulated ragdoll system. The generated face is a fictional adult, with the [exact prompt and acceptance notes](../public/assets/characters/face-albedo-trial.prompt.txt) retained. The built-in generation tool did not expose an exact model selector; an exact GPT Image 2 claim is not made. Mild source shading remains a documented limitation.

## Review cycles that changed the result

The first replacement character still looked mannequin-like. Review led to stronger facial planes and correctly layered eyes, a low brawler collar, rounded/tailored shoulders, and then a facial-albedo trial. Its initial side view looked like a separate face mask; the final projection compresses the outer cheeks, masks existing eye/brow/hair surfaces, lowers contrast, and blends into authored side-jaw tone.

The first weapon revision retained oversized planar backs and square sight blocks. A second pass narrowed and chamfered the receivers, shaped rear plates and sights, exposed the knife blade, and corrected curved UV distortion. A remaining black crescent on the pistol thumb was traced to backstrap and release-button geometry through actual screen rays. Relieving those parts removed the visible defect; no texture was painted over it.

The initial upholstery inherited a conspicuous checker pattern. It was replaced with quiet linen detail. The pillow was also raised to its actual mattress surface. Furniture boundaries and clear bullet paths remained covered by geometry/support tests.

Kitchen A/B review accepted local reflection captures because the countertop no longer reflected an unrelated blue sky and enamel responded to the warm room. The change is subtle; the opening sofa view alone is not evidence for this feature.

The first integrated shadow measurements exposed a bug that camera-only unit fixtures had missed: inactive pooled characters parked underground expanded the supposedly static caster bounds to roughly −400 m. The fit then correctly rejected narrower crops against an invalid receiver volume. The corrected scan excludes inactive rig subtrees and hidden proxies, refreshes active skin bounds correctly, and keeps hidden static zones. The actual receiver floor is now −2.2 m; observed crops improve linear shadow density by 1.33× on the melee balcony and 2× on the roof. Wide views retain the full map. Those exploratory reports are retained separately under `pre-shadow-fix/`; they are not the final performance record.

The browser corpse check was tightened to the actual deformed skin and a 12 mm floor tolerance, replacing hidden proxy bounds and a 70 mm allowance. This exposed an immediate-death bug: a freshly spawned actor could retain its 20 mm spawn clearance as its collapse floor before the live support sampler ran. Death now samples the current physical support once, using the existing live-query window, before starting the collapse and dropping a weapon. Unsupported cases preserve the last known floor. This adds no recurring work. The collapse itself reuses a bounded support cloud only while falling; settled bodies do not rescan vertices.

## Material compression experiment

The offline trial uses official Khronos KTX tools, UASTC level 4 without RDO, Zstandard compression, complete mip chains, and the pinned Three.js Basis transcoder. Source files remain unchanged. Reproduction instructions and numerical error limits are in [tools/ktx2-trial.md](../tools/ktx2-trial.md).

The six candidate maps total 5,929,019 bytes; with 584,862 bytes of decoder assets, that is 6,513,881 bytes versus 9,084,707 bytes for the raw triplets. On an ASTC-capable device their compressed texture payload is 8,388,768 bytes versus approximately 33,554,424 bytes for full RGBA8 mip chains. These are payload estimates, not total browser or driver memory.

ASTC-decoded color PSNR is 44.71 dB for brick and 52.25 dB for plaster. Normal p95 angular error is 4.77° and 1.00° respectively; localized maximum errors are higher. All 66 mip levels were checked against the actual pinned Three.js WASM transcoder. BC7 also passed offline quality and mip checks (color PSNR 44.40/51.15 dB, normal p95 4.78°/1.00°); BC7 hardware performance has not been measured.

Production selects these compressed maps only on approved ASTC 4×4 or BC7/BPTC devices. Unsupported formats or failed decoding fall back atomically to raw PBR triplets, then to generated/procedural finishes if necessary. The reviewed browser actually uploaded all six maps as ASTC 4×4 with 11 mips each and no fallback. Paired apartment and balcony screenshots accepted the result. Selected static brick and plaster regions differed by mean absolute RGB values of 1.13/255 and 0.47/255 respectively; those regions are not whole-image or perceptual-quality scores. The raw reference remains accessible through silent development QA. Production ignores that override.

## Validation record

The review machine reports ANGLE Metal on Apple M5 Max. Comparable captures and benchmarks use a 1280 × 720 CSS viewport with explicit review scales, not a claim about weaker hardware. Each benchmark has a 0.5-second warmup followed by about 10 seconds of measurement. Combat fixtures exercise actual input/simulation/contact paths with disclosed health replenishment and replacement spawns; camera sweeps pause simulation and rotate 360° with ±7° pitch. All automated browser sessions are locked silent.

`npm run check` passes lint, **1,252/1,252 unit tests**, and the production build. The strengthened real-browser suite passes **56/56** checks in 13.67 seconds, including all eight route areas, actual skinned anatomy/corpse bounds, collisions, melee/ranged contacts, pools, supplies, pause and endings. The production build passes normal menu/briefing entry, three quality-setting switches, live apartment rendering/AI and keyboard pause. QA UI is absent even with `qa=1`; QA/GPU-timer markers are absent from the production main bundle. There are no new browser warnings/errors after reloading the frozen source or during the production smoke check. An earlier transient HMR error from the in-progress loader edit remains in the historical log and is not presented as a final-build error.

| Final workload | Quality / scale | rAF p95 / p99, ms | CPU median / p95, ms | GPU median / p95, ms | Intervals >16.9 ms |
| --- | --- | --- | --- | --- | --- |
| Balcony melee | Auto / 1.20× | 10.10 / 10.30 | 3.70 / 5.80 | 3.23 / 13.30 | 0 / 1,201 |
| Street combat | Auto / 1.20× | 9.70 / 10.30 | 3.00 / 5.00 | 2.78 / 4.08 | 0 / 1,201 |
| Rooftop combat | Auto / 1.20× | 10.30 / 10.40 | 2.90 / 4.91 | 2.32 / 3.39 | 0 / 1,200 |
| Balcony melee | High / 1.60× | 10.20 / 10.40 | 3.70 / 5.80 | 3.93 / 13.14 | 0 / 1,201 |
| Balcony melee | High / 2.00× | 9.70 / 10.30 | 3.80 / 5.90 | 4.23 / 15.26 | 0 / 1,201 |
| Street combat | High / 2.00× | 9.90 / 10.30 | 3.10 / 5.10 | 4.07 / 5.22 | 0 / 1,200 |
| Rooftop combat | High / 2.00× | 10.20 / 10.40 | 3.00 / 5.00 | 3.52 / 4.85 | 0 / 1,200 |
| Street combat | Performance / 0.85× | 10.30 / 10.40 | 2.10 / 4.10 | 1.67 / 2.43 | 0 / 1,201 |
| Rooftop camera sweep | High / 2.00× | 9.90 / 10.20 | 2.80 / 3.90 | 4.76 / 5.44 | 0 / 1,200 |
| Apartment camera sweep | Auto / 1.20× | 9.70 / 10.30 | 3.00 / 3.70 | 3.71 / 5.04 | **1 / 1,196** |

All eight combat runs held approximately 120 Hz rAF cadence with no intervals over 16.9 ms. Each melee run produced 12 actual swings, 11 contacts and eight kills. Street runs varied with shot spread/AI (84–86 shots, 29–54 hits, 6–11 kills); these are controlled scene comparisons, not identical replay traces or an isolated resolution A/B. The roof runs each recorded 84 shots/hits and ten kills. Performance mode retained the improved assets and static light/reflections while reducing the street workload to 150 draws and disabling live shadows/AO.

The first apartment sweep contains one interval **over 33.5 and no greater than 50 ms**. Two complete repeats each recorded 1,200 intervals, none over 16.9 ms; p95/p99 were 10.11/10.30 and 9.70/10.30 ms. Across all 12 final runs, there are **14,401 intervals, one over 16.9 ms, none over 50 ms, and zero reported main-thread long tasks**. The outlier remains unattributed: the saved telemetry has no exact maximum, frame timestamps, compiler events or paired CPU/GPU trace. Zero long tasks does not exclude a task shorter than 50 ms. Sweep warmup covers its starting view, not every later angle. A preceding 2× rooftop trial also retained one interval over 16.9 ms; it was not silently discarded.

The roof sweep exercised full, three-quarter and half shadow coverage for 468, 454 and 278 frames respectively. This confirms that the real camera-dependent controller changes tiers and preserves its full-map fallback; screenshots and these counters alone do not prove every shadow transition is invisible.

The earlier local melee reference used 928 calls and 182,898 triangles per frame; final Auto melee uses 776 calls and 322,003 triangles. More detailed assets therefore cost more triangles and GPU time while batching reduced calls. Both held the reference display's callback cadence. This is a multi-change comparison, not a causal claim that any single feature improved performance.

The fresh final development startup reported 2,513 ms to ready: 220 ms map loading, 545 ms world construction, 412 ms CPU / 538 ms wall for the time-sliced bake, approximately 193 ms for room reflections, and 159 ms character warmup. These are observations on this local cache/network state, not cold-network guarantees or necessarily additive phases. The real runtime warmed seven held models, 32 rigs/skeletons and 38 character draw variants. After removing the viewport override, High's device/preset setting produced an actual 2560 × 1440 buffer at 2.00×; Automatic was restored afterward. High 2× has a visible thin-edge benefit and a higher GPU cost, so Automatic was not raised.

The production main chunk is 1,117.68 kB / 336.01 kB gzip, plus the lazy 59.00 kB / 24.23 kB gzip KTX2 loader and assets. The existing 900 kB chunk warning remains. Code splitting may improve transfer/startup on slower devices; this pass does not hide that warning by increasing the limit.

Raw reports, accepted/rejected captures, the CSV/JSON benchmark summary, production smoke record and source/asset hash manifest live in `artifacts/graphics-ceiling-2026-08-29/`. The directory intentionally includes intermediate failures and trials; `final-*` reports describe the frozen build. Measured rAF cadence, CPU submission, GPU elapsed queries and long tasks describe different aspects of performance. They do not establish presented-frame rate, input-to-photon latency, INP, a complete human playthrough, or minimum-device certification.

## Architecture decisions and remaining limits

The renderer remains WebGL. Migrating the current GTAO/OutputPass and custom shader hooks to WebGPU would require an equivalent material/post-processing implementation and browser fallback validation. No equivalent WebGPU prototype was measured in this delivery, so neither a speedup nor a visual upgrade is claimed. [Three.js migration guidance](https://threejs.org/manual/en/webgpurenderer)

More triangles were spent on silhouettes and deformation where review exposed a defect. Unbounded polygon counts, higher texture resolution everywhere, another shadow light, broad bloom/motion blur, and displacement were not adopted as automatic improvements. The accepted changes preserve target readability and use the existing quality settings.

The last independent still-image review found no further concrete rendering defect in the sampled roof, shotgun, kitchen and face views. It still identified simplified receiver/hand shapes, rigid neck/clothing motion and sparse distant buildings as artistic limits. Stills cannot certify motion or every contact case; combat measurements and the rendered-geometry checks remain separate evidence.

The next substantial quality step would be a new asset-production phase: sculpted and retopologized characters with richer facial/cloth animation, hand-authored hero weapon surfaces, a larger calibrated material library and more varied environmental storytelling. Those tasks can still benefit WebGL; moving APIs alone does not supply them. Each would need the same in-game review and memory/frame-budget gates. This pass reaches a reviewed, measured stopping point for the current asset approach, not proof that better graphics are impossible.

Broader hardware testing and sustained human play remain necessary before promising a minimum frame rate or input-latency score. Real-time global illumination or an equivalent WebGPU renderer would be separate measured prototypes, not untested defaults added to this build.
