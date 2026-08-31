# Civilian vehicle review — August 31, 2026

Four background cars now use three recognizable silhouettes: a short hatchback, conventional sedan and longer station wagon. Quieter lamps, muted owner-specific finishes and less regular parking make the street feel occupied. Gnucci's black idling sedan retains its factory, position, dimensions, lighting and objective behavior. The completed character/storefront work is preserved.

## Baseline and visual evidence

The fresh baseline is the working build after the coordinated character/storefront pass, not the older August 30 sedan screenshots. Its 375 source/assets files were copied before vehicle integration and verified again for control measurements. Only the added development car-camera controls were copied into that baseline separately; its production sources remained unchanged.

`artifacts/civilian-vehicles-2026-08-31/index.html` contains **13 matched before/after comparisons**. Original captures and visible setup reports cover the street, each civilian car's front/rear quarters, the near row and objective sedan. All thirteen camera/quality pairs match: **1280×720 CSS pixels, 82° FOV, existing dusk lighting**, High at explicit **2×** (2560×1440), or normal Automatic at **1.2×** on the reviewed Apple M5 Max. No image was retouched.

The first candidate's sloping nose/tail left the black lamp-panel upper corners inadequately backed by metal. Raising the existing stamped face seats the panels while retaining the topology and outer bounds. Candidate images and actual-triangle backing tests retain this revision. Independent review found the final wheel, arch, roof, glass, pillar and mirror contacts acceptable.

An eleven-second visual fixture walks the real player **41.41 m** with held-W input and production collision, checking road support and capsule clearance every frame. Normal and reduced-motion runs completed; pause, resume and early-stop cleanup also worked. Its camera looks toward the curb independently and waves are stopped, so it is disclosed as a visual fixture. A separate brief normal street session exercised incoming damage, attacks and pause. An earlier input attempt stayed in paused QA focus and is labeled rejected evidence. Screenshots and visual runs do not supply timing conclusions.

## Placement and integration

| Car | Previous centre x,z (m) | Final centre x,z (m) | Treatment |
| --- | --- | --- | --- |
| West | −29, 9.7 | −30.2, 9.35 | Olive work wagon |
| Middle | −14, 9.7 | −12.7, 9.50 | Blue-gray kept sedan |
| East | 1, 9.7 | 1.8, 9.40 | Dusty gray used hatchback |
| Far curb | −6, 23.3 | −5.2, 23.60 | Brown used sedan |

Existing headings and four-car count remain. Near-row centre gaps become 17.5/14.5 m instead of 15/15 m. All tires contact the real road, with at least 0.24 m between the complete visible envelope and curb lip. The full enemy-arrival jitter envelopes, checkpoint/QA positions, bakery crossing and objective approach stay clear.

Each car still registers two movement boxes, now derived from its actual lower body and upper cabin. These are conservative around tapered glass and arches; bullets follow visible triangles. Tests compare actual renderer-ray contacts with the ballistic index, including body/glass hits and open underbody air. The objective's geometry/material fingerprint matches the baseline exactly. Mission rules, attack timing, pooling, checkpoints, eight-light budget and quality pipeline are unchanged.

## Resource costs

| Four civilian cars | Before | After |
| --- | ---: | ---: |
| Triangles | 16,480 | 13,752 |
| Material draws per colour pass before culling | 28 | 24 |
| Unique merged geometry bytes | 1,582,080 | 1,359,072 |
| Materials | 28 | 11 |
| Textures / added lights | 0 / 0 | 0 / 0 |

The new shared source primitives retain another **25,408 bytes**. Including those, net retained CPU geometry savings are **197,600 bytes (193 KiB)**. The older shared primitives remain needed by the objective sedan and are unchanged. Scene-only merged-buffer savings are 223,008 bytes. These estimates exclude temporary construction peaks and complete driver residency.

Main JavaScript grows **11,106 bytes raw / 4,111 bytes gzip**, calculated consistently with Node gzip. There are no new art-file downloads or dependencies. Geometry, vertex-color wear and material batching run at startup; variants and finishes share caches. The build's existing large-chunk warning remains. [Asset provenance](civilian-vehicle-provenance.md) records original authorship, construction limits and detailed budgets.

## Validation and performance

`npm run check` passes lint, **1,536 unit tests** and production build. The final browser suite passes **58/58**. Eighteen new asset/integration tests cover surface topology and seating, wheel support, collision, routes, projectile contacts and sharing. Production smoke passes Field Notes/settings, Automatic mode, briefing, keyboard gameplay and pause; audio stays locked off, QA is absent even with `qa=1`, and warning/error logs are empty. It is an opening smoke check, not a full production campaign.

The first matched ten-second measurements are below. CPU is fixture + simulation + render p95; the camera sweep measures render submission. Times are milliseconds. Screenshots, builds and unit tests were kept outside timing runs.

| Workload | CPU p95 before → after | GPU p95 before → after | rAF p99 before → after |
| --- | ---: | ---: | ---: |
| Street combat, High 2× | 5.60 → 5.00 | 5.63 → 6.89 | 9.40 → 9.40 |
| Roof combat, High 2× | 6.00 → 5.20 | 4.20 → 4.77 | 9.30 → 9.40 |
| Melee, High 2× | 7.00 → 6.10 | 13.83 → 17.23 | 9.40 → 16.04 |
| Street combat, Automatic | 5.80 → 5.20 | 4.79 → 3.74 | 9.40 → 9.40 |
| Street camera sweep, Automatic | 4.50 → 4.10 | 5.46 → 4.71 | 9.40 → 9.40 |

The first High GPU increases prompted repeats. Final street GPU p95 returned to **5.58 ms**, versus **5.22 ms** in the later original-build control. Final melee repeated at **17.18 ms**; original-build controls measured **18.53 and 14.47 ms**. All melee runs retained twelve swings, eleven hits, eight kills and eight replacements, with no skipped/disjoint queries. These controls do not isolate a vehicle-induced regression or explain the variation. The smaller roof difference is also not a demonstrated causal cost.

Across eight final runs, **7 of 9,492 rAF intervals exceeded 16.9 ms**, all in the repeated High melee run; maximum **25.0 ms**, none above 33.5 ms, and no observed main-thread long tasks. Original controls had **12 of 3,479** above 16.9 ms and maximum **25.7 ms**. Final per-run callback rate ranged about **111–120/s**, which is not presented FPS or input latency. The evidence also retains a matched apartment sweep as an additional control; it is not mislabeled as a street workload.

Matching resource endpoints retain **ten fewer geometries**, with unchanged texture/program counts. Both builds' first street run gained one geometry/texture and first roof run gained four geometries; later endpoints were stable. Startup was **2.455 s original / 2.586 s final**, then **2.752 s** in the original control; cache/context variation prevents isolated attribution. GPU queries exclude browser composition, aggregate combat counts do not fix every corpse/effect frame, and endpoint counts do not prove leak freedom. Missing CPU/GPU tail statistics remain null in `final-performance-summary.json` and `final-performance.csv`.

The remaining art limits are simple cabin interiors, plain wheel faces, conservative movement boxes and static non-destructible bodywork. Further microdetail is unlikely to improve the broad street as much as these silhouette and placement changes did.
