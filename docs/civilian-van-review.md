# Civilian van addition — August 31, 2026

The vehicle kit now offers a **panel van** and **passenger van** alongside the sedan, hatchback and wagon. Both have a taller cab, short nose, continuous cargo roof, larger mirrors and restrained used paint. The panel van has opaque loading doors, a sliding-door track and rear hinges. The passenger van has actual window openings, division posts and a passenger step. [Provenance and construction budgets](civilian-vehicle-provenance.md) document the original code-authored assets; no external models, textures or dependencies were added.

The panel van replaces the middle near-curb sedan at **(−12.7, 0.05, 9.50), yaw π**. All four parking positions and headings remain fixed. The far-curb sedan stays low: a tall cargo body there would obscure the bakery doorway from the street checkpoint. The existing wagon, hatchback and far sedan retain identical geometry buffers, materials and bounds; the objective sedan's complete geometry/material fingerprint also matches the baseline.

## Visual review and revision

The baseline was captured from the current working build before van integration, including the completed character, storefront and civilian-car work. A preserved 402-file source/assets snapshot supplied later control measurements; its hashes remain unchanged, and the preservation audit finds no unrelated source edits.

Open `artifacts/civilian-vans-2026-08-31/index.html` through the development server for **seven matched before/after views**, plus separate final panel/passenger design comparisons. Street, near-row, middle front/rear and objective views retain the same camera, dusk lighting, **1280×720 CSS viewport and 82° FOV**. High uses explicit **2×**; Automatic uses its normal **1.20×** setting on the reviewed Apple M5 Max. Capture reports match camera, buffers and recorded lighting; separate visible settings confirm FOV. Original browser bytes are unretouched JPEG captures despite the `.png` filenames. HUD/pickup orientation and particles can vary; these are surface comparisons, not pixel-identical frames or motion measurements.

Both silhouettes read clearly at ordinary street distances. Front/rear quarters and the moving curbside review show supported wheels, roof, mirrors and door hardware. The first passenger body left a **25 mm slit** between its forward cargo windows and the cab posts. Actual triangle probes exposed missing projectile contact. Extending the existing panes and rails into the posts closes it with 25 mm overlap, without added triangles or changed bounds. Rejected test output, candidate views and corrected views are retained.

Normal and reduced-motion walking fixtures each traverse **41.41 m** with real held-W input and production movement/collision. Road support and capsule clearance are checked every frame; pause/resume and cleanup complete. The fixture stops waves and independently directs the camera toward parked vehicles, so it is separate from ordinary combat. A stale “sedan” review caption was corrected to derive the displayed design from district data.

In development QA, open **Inspect world objects**, choose an individual civilian view, then choose **Civilian design** and inspect. All five designs are cached before play. Previews replace only rendered appearance while paused; reset, another inspection, benchmarks and return to gameplay restore the authored vehicle. The passenger van is an available design, not another parked vehicle in the district.

## Integration and costs

The taller body has honest upper/lower movement bounds. Opaque cargo blocks standing-height sight and bullets; passenger glazing transmits sight while its actual panes catch bullets. Tests inspect real renderer and ballistic contacts, tire support, underbody air, full arrival jitter, road approaches, crossing clearance and direct views of the bakery doorway/sign and objective. The middle van's complete mirror envelope remains about **0.35 m** clear of the curb lip. Its taller local cover is intentional; it is not visually tall but physically sedan-sized. Encounter rules, attack timing, pooling, checkpoints, lighting and quality behavior are unchanged.

| Four installed civilian vehicles | Before vans | With panel van |
| --- | ---: | ---: |
| Triangles | 13,752 | 13,788 |
| Material draws before culling, one colour pass | 24 | 24 |
| Unique merged geometry bytes | 1,359,072 | 1,820,016 |
| Material instances | 11 | 10 |
| Textures / added lights | 0 / 0 | 0 / 0 |

The extra shape retains **460,944 bytes (450 KiB)** because the remaining sedan still needs its cache. Shared tire/hub/arch prototypes add an unchanged 25,408 bytes. QA's unused passenger option adds another 484,704 CPU buffer bytes; production constructs only installed variants. Geometry/vertex colour/batching work occurs at startup, with shared caches and no added per-frame construction. Main JavaScript grows **7,832 bytes raw / 2,153 bytes gzip**, measured consistently with Node gzip. Buffer estimates exclude temporary construction peaks and full driver residency. The eight-practical-light budget is unchanged.

## Validation and performance

`npm run check` passes lint, **1,546 unit tests** and the production build. The supported browser suite passes **59/59**, including five-design preview restoration and actual projectile participation after cleanup. Twenty asset-fit and eight world integration checks cover all vehicle designs. Production smoke passes menu/Field Notes/settings, briefing, Automatic keyboard play and pause; QA is absent even with `qa=1`, audio stays locked off, and a fresh production tab has no warning/error logs. This is an opening smoke check, not a complete production campaign. The build retains its existing large-chunk warning.

Measurements use separate ten-second runs without screenshots or concurrent builds/tests. CPU below is fixture + simulation + render p95, or render submission for the sweep; all times are milliseconds.

| Workload | CPU p95 original → final | GPU p95 original → final | rAF p99 original → final |
| --- | ---: | ---: | ---: |
| Street combat, High 2× | 9.97 → 6.00 | 6.21 → 4.95 | 16.77 → 9.40 |
| Roof combat, High 2× | 6.80 → 6.20 | 4.24 → 4.35 | 9.30 → 9.30 |
| Street combat, Automatic | 8.30 → 6.10 | 4.49 → 3.94 | 9.40 → 9.30 |
| Street sweep, Automatic | 6.50 → 5.00 | 4.54 → 5.52 | 25.00 → 9.40 |

The sweep GPU increase prompted a final repeat (**4.99 ms**) and a later preserved-original control (**5.06 ms**). Sustained High melee was also measured twice on each source build: original CPU p95 **4.90/5.90**, GPU **8.81/15.61**; final CPU **7.50/6.20**, GPU **13.39/15.80**. All four melee runs retain twelve swings, eleven hits, eight kills and eight replacements. These repeats show substantial variation and do not isolate a van-induced timing regression. The later original controls were measured from the untouched pre-van snapshot, not historical benchmarks.

Seven final runs contain **8,405 rAF intervals**, none above 16.9 ms; maximum **9.50 ms**. The four early baseline runs contain 56 intervals above 16.9 ms and maximum 25.70 ms; later original controls have none. No measured run reports a long task or disjoint GPU query. These figures describe callback cadence, **not presented FPS or input latency**, and do not establish a performance improvement. High street outcomes differ (seven versus five kills), so that comparison is not identical simulation work.

Comparable warmed Automatic and fresh melee endpoints add six renderer geometries, with unchanged texture/program counts. Both builds still warm transient combat resources; stable later endpoints do not prove leak freedom. Reported startup is **2.670 s** initially, **2.470/2.605 s** final and **2.482 s** in the original control; cache and context variation prevent isolated attribution. GPU queries omit browser composition, and unavailable CPU/GPU p99/max statistics remain null in `final-performance-summary.json` and the timing CSV.

Remaining limits are simple interiors, conservative movement boxes, static non-destructible doors/bodywork and no passenger-van placement in ordinary play. Future placements need their own sightline and route checks. The gallery also records comparison limits and original evidence hashes.
