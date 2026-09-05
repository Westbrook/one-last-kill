# Motion controls and runtime responsiveness

Implementation and local validation, 4 September 2026. Reference commit: `90c1b52fac12ff5e95580dac01213e245050564b`.

## Player behavior

Enabling **Settings → On-screen touch controls** requests motion access directly from that user gesture. Where iOS exposes `DeviceOrientationEvent.requestPermission()`, the call occurs synchronously before awaiting its result. A saved touch preference waits for an explicit Start, briefing-continue or Resume action. Page load and gamepad polling cannot initiate the request.

Permission and usable readings select motion automatically. Denial, missing sensors or initial silence preserve swipe controls. **MOTION** remains an optional off/retry control, rather than a required second opt-in. A manual choice of swipe mode and a failed automatic request suppress repeated requests during the page session. HTTPS is required on a real phone; an ordinary HTTP LAN address is not equivalent to localhost on that phone.

Pan and tilt use the device's forward direction with a gravity reference, so rolling the screen sideways does not exchange the axes. A flat starting hold adopts gravity as the device is lifted. Ambiguous straight-up/down transitions discard one reading to establish a safe new reference. Recenter, pause/resume and display rotation also establish a new reference.

Motion **FIRE** retains the same large circle and position as swipe **FIRE**. Its motion behavior is a dedicated trigger: press/hold to fire; dragging does not aim. The existing movement control remains available.

## Runtime budgets

- Auto targets a 60 fps budget; this is neither a frame cap nor a presented-FPS guarantee. It reacts to sustained load after two slow windows and requires eight clean, quiet windows for recovery. Nearby live contacts inhibit recovery; pressure can still reduce work during combat.
- CPU, simulation and render wall times are measured separately from optional asynchronous GPU queries. Without GPU results, render-heavy wall time remains uncertain and can reduce resolution. Clearly simulation-heavy work can reduce cosmetic tiers while retaining resolution.
- Auto scale remains bounded at 0.70–1.40, capped by device pixel ratio. Three presentation tiers coordinate full/two-thirds/one-third cosmetic density, contact shading, and normal/30 Hz/20 Hz shadow refresh. Projection changes refresh immediately. Gameplay geometry, damage, combat random-number consumption and simulation limits remain consistent.
- Tier-only changes do not resize the canvas. Actual size/ratio changes resize once. Shadow maps, effect pools and postprocessing resources remain resident across cosmetic tier changes. Resolution changes still require attachment resizing and have a real cost.
- Fixed timing buffers retain recent frame/CPU/GPU percentiles and session long-stall evidence. A frame of at least 50 ms counts as a long stall and inhibits recovery. Pauses discard recent timing and pending GPU queries; the resumed frame starts with zero elapsed time. Sparse GPU sampling changes its phase relative to shadow updates.
- Reusable input, gamepad, touch context, rage and combat-HUD outputs remove recurring allocations from selected hot paths. Default snapshot APIs still return independent objects for callers that need them.

High and Performance remain explicit presets. Auto does not change textures, enemy counts or simulation rules to recover performance. These changes reduce selected sources of allocation/work; they cannot prevent every browser GC or scheduling pause.

## Validation and review

The independent [local review page](http://localhost:4173/artifacts/motion-runtime-2026-09-04/index.html) links the current controls fixture and machine-readable evidence. The `artifacts/` directory contains ignored local review output and is not included in a fresh checkout; the validation findings are recorded below. Run `npm run check` for lint, all unit tests, the four-catalog material audit and production build. The DEV-only `?mute=1&qa=1&progress-report` panel exposes the browser regression suite, **Benchmark adaptive combat 10 seconds**, and **Inspect runtime performance**. The adaptive benchmark feeds the production controller and captures its snapshot before fixture cleanup. Audio stays locked off.

Motion tests include rolled/locked screens, both landscape directions, flat pickup, vertical poles, permission outcomes and lifecycle transitions. Browser layout checks at 390×844, 320×568, 844×390 and 568×320 found no touch-button overlap or offscreen controls. FIRE measured 112×112 CSS pixels at 390×844 and 102×102 at the other three sizes; comparison with swipe mode confirmed the same size.

The local 20-second allocation workload observes **10,200 objects before → 14 reusable setup objects after**, with identical input checksums. It counts selected externally observable output/state objects only. It excludes engine internals and other systems, and is not a heap-byte measurement or GC profile. See `artifacts/motion-runtime-2026-09-04/allocation-workload.mjs` and `allocation-results.json`.

Desktop timing used Apple M5 Max / ANGLE Metal, 1280×720 CSS pixels, silent 10-second controlled street combat after 0.5-second warmup, and KTX2 surfaces. Reference and candidate fixed-scale runs both measured rAF p95 **9.9 ms**, maximum **10.4 ms**, and zero main-thread long tasks at 1.20×. Combat is randomized; hits, kills and respawns differed. GPU p95 was 2.12 ms versus 4.14 ms in these individual samples. This is a matched protocol, not identical execution or evidence of a speedup.

An initial adaptive run exposed one **50.4 ms** interval immediately following a 1.20→1.25 resolution increase. Its previous full QA callback took 50.1 ms, versus 5.2 ms before controller/QA bookkeeping. The temporal association motivated the quiet-play recovery gate; no GC cause was established. The evidence record preserves this finding separately from the final validation run.

The final adaptive sample kept 1.20× during combat: 1,201 intervals, p95 **10.0 ms**, maximum **10.4 ms**, zero measured intervals over 16.9 ms and zero measured long tasks. Session telemetry also retained an **83.4 ms warmup stall** outside that measured window. This is evidence that stalls are preserved and combat recovery is deferred, not a claim that all stalls have been eliminated. GPU p95 was 6.29 ms in this sample.

Final checks passed: **1,960 unit tests**, lint, material audit and production build; **63/63 browser regression checks**. The production preview at port 4188 enabled touch, displayed the denied-motion swipe fallback, resumed with that fallback, and returned to a fresh menu. It reported no console warnings/errors; test preferences were restored. The existing build chunk-size advisory remains.

Physical iOS/Android permission dialogs, aiming feel, thermal throttling, long sessions and GC traces remain untested. Desktop tests cannot certify those behaviors. Representative-device profiling should identify the source of remaining stalls before optimizing heavier enemy/drop/navigation paths.
