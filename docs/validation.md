# Validation record — August 27, 2026

The final source passes **103 unit tests, 21 browser integration checks, ESLint, and the production build**. Short production play checks and paused visual inspections of all eight areas also completed. This record distinguishes controlled fixtures from ordinary play; it does not certify AAA visual quality, a complete human playthrough, or console compatibility.

## Environment and silence

- Apple M5 Max, Mac17,6; macOS 26.6.1; Codex in-app browser.
- 1280 × 720 CSS viewport, render ratio 1.20, automatic quality: approximately 1536 × 864 rendering resolution. The browser viewport was not resized for the tests.
- Node.js 24.16.0; dependencies pinned by the lockfile.
- Every browser session used `mute=1`; development fixtures also used `qa=1`. No trailer or other audiovisual reference was played.
- QA verified that the immutable audio lock could not be removed and that **no AudioContext was allocated**, including during every sampled benchmark frame. Production M-key input left the audio control locked off.

Development verification used port 4173. Production verification used `npm run preview -- --port 4175`; an existing service on port 4174 was left alone. The standard commands in the README use port 4173 when it is available.

## Static checks and unit tests

`npm run check` completed successfully: ESLint, **103/103** Node tests, and Vite production compilation. The tests cover capsule collision and stepping, collider ownership/reset, input edges and gamepad state, silent audio lifecycle, fixed simulation timing, settings validation, finite encounters and safe spawns, checkpoint/ammunition rules, combat timing and damage, corpse ownership, lighting limits, the depth-correct weapon rendering pass, and muzzle transforms.

The final production JavaScript bundle is 695.95 kB before compression, 188.90 kB gzip. Raster assets are separate local files. These sizes do not include an assertion about cold-load speed on a network connection. `git diff --check` was clean.

## Browser integration

The visible development suite passed **21/21 checks in 4.81 seconds** using the built world and actual gameplay modules:

| Area | Observed result |
| --- | --- |
| Session safety | Audio remains locked; Settings and Field Notes reject play engagement, with a successful-start positive control after closing them. |
| Checkpoints and traversal | All eight anchors have support and capsule clearance. The breach, balcony wrap, all four stair flights, roof exit, every scaffold tier and street landing are traversable in collision fixtures. |
| Progression reset | Real neighbor entry closes the breach; a full reset removes both blockers. Reentry reuses the same fire, debris, collider, geometry and material resources, with exactly eight visible practical lights. |
| Pause | An active control advances. Pausing freezes game time, health, position, attack windup, waves and reload timers. |
| Weapons | Actual input consumes pistol ammunition and hits a contact through the camera/raycast path. The next shot stops at an actual bakery wall. Four ranged weapon snapshots conserve ammunition. Head damage applies its multiplier once. |
| Enemy lifecycle | Cleared or restarted melee attacks cannot land later. Corpse limits, expiration and rig reuse preserve live ownership. |
| Endings | Both branch retries restore their four-contact squads and checkpoint loadouts. Car completion requires a cleared squad and arrival. Bakery clearance displays Protector; 60 simulated seconds with live raiders displays Too Late. Pause preserves that deadline. |
| Blocked spawns and supplies | Exhausted pool capacity cannot produce an instant win. Full health preserves a supply; low health consumes it; retry restores it. |

Ending-resolution fixtures deliberately apply body damage to real contacts, without inventing player shots or kill credit. The timeout fixture replenishes health to isolate deadline behavior. These are state-transition tests, not recorded player victories.

## Frame measurements

Both measurements used 0.5 seconds of warmup followed by ten seconds of real animation-frame intervals. Rendering statistics include the world and weapon passes. No viewport changes, screenshots, or gameplay inputs were issued during the measured intervals.

| Measurement | Paused apartment | Controlled street combat |
| --- | ---: | ---: |
| Samples / elapsed | 1,201 / 10.01 s | 1,200 / 10.00 s |
| Average rate | 120.0 FPS | 120.0 FPS |
| Median frame interval | 8.30 ms | 8.30 ms |
| 95th percentile frame interval | 10.00 ms | 10.20 ms |
| Median measured CPU time | 2.10 ms | 1.90 ms |
| 95th percentile CPU time | 2.30 ms | 6.60 ms |
| Average render calls | 795 | 662 |
| Average triangles | 49,578 | 67,265 |

The combat fixture held a fixed street view with three to four live contacts, up to four NPCs attacking, automatic SMG input, and normal magazine/reload timing. It recorded **84 shots, 36 hits, seven kills and seven replacement spawns**. Player health was replenished 25 times, absorbing 246 damage. This sustains a repeatable workload; ordinary play does not grant that protection. NPC behavior introduces variation between runs.

These are display-paced frame intervals and CPU submission timings, not GPU timer queries, maximum engine throughput, long-session endurance results, or guarantees for other hardware. 4K output and console hardware were not tested.

## Production and visual checks

The legacy `punisher-game.html?qa=1&mute=1` URL redirected to the new entry point while retaining both flags. Production contained no QA panel or executable QA controls. Begin Mission opened the paused briefing; continuing started play. Q engaged aim, J consumed one pistol round (12 → 11, reserve 36), and P opened the pause menu. The keyboard fallback remained usable when mouse capture was unavailable. Production error/warning logs were empty after these checks.

Quality selection and reduced-motion settings persisted across reload in the visible production UI; restoring defaults worked. Field Notes and Escape dismissal were checked in development. Native field-of-view slider interaction could not be confirmed through this browser automation surface: its displayed value stayed at 82 during attempted native actions. Source review found no blocked range defaults, and normalization/store tests pass; direct human slider verification remains open.

All eight areas were inspected while paused. Those reviews prompted fixes to weapon self-occlusion, car wheels and glass, backward window planes, material scale, smoke, excessive road/concrete gloss, inconsistent wood colors, lighting and route feedback. Separate combat captures also led to smaller, shorter muzzle flashes, corrected barrel-origin effects and upward visual recoil. Generated texture provenance and the remaining brick-repeat limitation are recorded in [art-direction.md](art-direction.md).

## Evidence and remaining limits

Local evidence is in `artifacts/validation-2026-08-27/`: `check.log`, `regression.txt`, `regression-report.png`, both benchmark reports, `production-smoke.txt`, `production-console.json`, production menu/gameplay images, and one inspection image per zone. `controlled-combat.png` comes from a separate visual capture run, not either recorded timing run. This directory is intentionally gitignored; it is present in this workspace, not promised in a fresh clone.

Physical controller hardware, mouse capture in other browsers, screen-reader use, mobile layouts, long-session memory behavior and an uninterrupted human campaign completion remain unverified. Audio playback quality was intentionally not evaluated. Character rigs and much of the environment are still procedural; animation, asset detail and AI navigation remain below a finished AAA production. Runtime singleton/circular dependencies are documented in [architecture.md](architecture.md) rather than hidden by the module split.
