# Map expansion and stability review

This pass keeps all eight checkpoints, starts new missions with fists and zero ammunition, expands the playable spaces, and raises the authored enemy totals through the route. It remains an original fan-made WebGL game, not a completed AAA console release or a reproduction of the film's locations.

## Spaces and encounters

| Checkpoint | Physical change | Authored contacts | Maximum alive |
| --- | --- | ---: | ---: |
| Apartment | Bedroom, living space and kitchen divisions; connected doorways, storage and furniture within the existing 120 m² flat | 2, both melee | 2 |
| Neighbor | Foyer and dining/living rooms create a longer turn through the furnished 120 m² flat | 4 | 2 |
| Balcony | Benches, utility storage and facade services dress the east terrace; the supported gallery remains clear for melee | 6, fists and bats | 2 |
| Stairwell | Four rebuilt flights, open turning platforms and visible railings replace tall rectangular stringer blocks | 8, staged by landing | 2 |
| Rooftop | Connected service wings, a mechanical yard, tank, equipment cover and an open guarded lightwell | 12 | 5 |
| Scaffolding | Four larger work platforms with supported bays, supplies and alternating descent openings | 14, staged by deck | 3 |
| Street | Longer road, wider approaches, seven shop fronts, vehicles, cover and visible end barriers | 16 | 5 |
| Bakery | Larger retail floor and a connected preparation room, ovens, shelves, work surfaces and family refuge | 18 in the protector encounter | 5 |

These are finite available rosters, not mandatory kill counts. Leaving an area can bypass its remaining contacts. The car branch instead has eight bodyguards in two groups. The bakery's deadline is 180 simulated seconds to accommodate its larger arena and eighteen raiders; pausing stops the clock, and a retry restores the full branch and exact saved ammunition.

The roof grows from 280 m² to **935 m² of deck**, before subtracting equipment and the mechanical house. Its 25 m² lightwell remains open to the sky, preserving the apartment window's exterior face. The route to the relocated eastern scaffold opening is more than 38 m. New roof slabs rest on full building wings rather than floating beyond the old facade.

Each scaffold platform provides about **77–93 m²**, versus roughly 21–24 m² previously. Standards, ledgers, transoms, bracing and facade ties support their actual footprints. The three western rear standards bridge around the balcony using supported consoles; neither their collision nor decorative members cross the balcony passage.

The street road grows from 50 × 12 m to **76 × 17 m**. The bakery grows from 9 × 8 m to **18 × 15 m**. Its retail/preparation doorway is four metres wide, and tested routes connect both rooms without passing through counters or other furniture.

## Stair review

The previous flights used eleven unusually deep treads and full-height rectangular fills along their sides. Those fills made the space read as long internal walls, and crowded the approaches to the turning landings.

Each flight now has **fourteen 0.30 m treads**, with consistent risers of approximately 0.171 or 0.186 m. Shallow connected stair slabs and sloped stringers leave the lower passage usable. Both ends have **2.8 m-deep turning platforms**. Railings terminate at the flight limits; the final landing has a guard at its exposed edge and a flush, aligned roof threshold.

The final encounter test exposed another physical defect: the original roof cap left only 2.0 m of headroom above the last landing. The director's conservative full-body spawn probe intersected it, preventing both final contacts from arriving. The tower now provides **2.4 m of clear landing headroom**, with its enclosing walls and roof-door header extended to support the raised cap. Spawn clearance and five-metre player separation remain unchanged.

Tests use the built geometry, not only a diagram: they cover standing headroom below the second flight, both door headers, walking and sprinting up all flights, descending without jumps, turning loops, enemy anchors, and matching visible/collision bounds. The selected structural registry checks physical contact between declared supports; it is not a structural engineering or building-code certification.

A pacing audit also found a fast-ascent deadlock: waiting contacts on a lower landing could become permanently ineligible for spawning and block every group above. The scheduler now distinguishes a passed landing from a defeated squad. It discards only that landing's unspawned contacts; living stair enemies remain present and keep their capacity slots. Moving up a committed flight can bring the next pair forward, but never bypasses spawn clearance or distance checks.

## Combat and presentation

New missions and development resets use the same empty-handed loadout. Checkpoint retries preserve legitimately acquired weapons; they do not introduce a gun. Tests exercise actual fist hits, a dropped bat, E pickup, and a later firearm earned from a defeated gunman. Two articulated first-person hands replace the oversized box fist, with alternating jabs and a clear central view.

On the roof, both initial sentries must be defeated before the response starts. The remaining ten enemies arrive in finite groups of four, three and three, overlapping within the five-enemy cap. The full roster includes fists, bats, pistols, shotguns, SMGs and **one machine-gun carrier**. Pending and unstarted reinforcements remain accounted for when a spawn is blocked; an empty or exhausted pool cannot falsely clear the encounter.

Enemy movement uses cached, bounded navigation around partitions and equipment. Searches follow observed positions, preserve floor support and body clearance, and reuse paths rather than searching every frame. NPCs share the player's capsule step solver, with a 0.32 m limit per verified riser; a nine-centimetre curb and all four fourteen-riser flights are covered by actual movement tests. Cached visibility also stores the observed position, so an old clear-sight result cannot track a new position behind a wall. The search work budget is capped at 96 expansions per simulation slice. Geometry changes, retry clock resets, death and pool release invalidate old navigation safely. This remains a bounded authored-world solution, not a general navigation mesh or a claim that every possible pursuit is perfect.

Surface maps now share physical metre scales and matching albedo, normal and roughness coordinates. Concrete, wood, asphalt, roofing and metal have restrained material-specific grain; stone, gravel, rubber and tile provide additional finishes. Generated brick/plaster color assets are retained, with matching derived surface channels rather than unrelated fallback roughness. The documented brick repeat limitation remains.

The directional shadow map is fitted to the larger playable block. Automatic and High quality add restrained contact shading at half the drawing-buffer dimensions, using depth from the existing world draw. The weapon layer remains separate. Performance mode skips this effect and shadows; automatic quality can also bypass contact shading under resolution pressure. The pipeline uses the pinned Three.js [GTAOPass](https://threejs.org/docs/pages/GTAOPass.html) and [OutputPass](https://threejs.org/docs/pages/OutputPass.html), with renderer state and resource ownership covered by tests.

## Verification record

All browser inspection, traversal, combat and benchmark work uses `?qa=1&mute=1` or the production `?mute=1` URL. Audio is hard-locked off, and the integration checks verify that no AudioContext is allocated.

`npm run check` passes: ESLint, **303/303 unit tests**, and the production build. The final script is `main-BjuHzubE.js` (833.90 kB, 235.29 kB gzip). The production preview was reloaded and verified through its real briefing, fists-only opening, M-key mute-lock attempt, and pause action. It has no development QA panel. Both development and production warning/error logs were empty. The preview was then reset to the new-mission menu, still muted.

The final browser suite passed **38/38 checks in 9.73 seconds**. It verified all eight checkpoint floors, 470 selected structural records and 806 support links, all authored openings, room and stair traversal, roof/scaffold descent, the full rooftop reinforcement schedule, and both final branches. It also exercised fast stair progression, living pursuer retention, and real NPC movement over the pavement curb and first fourteen-riser flight. The real rooftop detour check walked a contact 19.1 m around the mechanical house in 7.67 simulated seconds using one cached search.

Measurements used the same local Apple M5 Max (Mac17,6), macOS 26.6.1 and in-app browser, at **1280 × 720 CSS pixels**. Each combat run had a 0.5-second warmup followed by ten measured seconds. Automatic quality rendered at ratio 1.20 (1536 × 864 internally), with contact shading active at 768 × 432, eight AO samples, eight denoise samples and two target MSAA samples.

| Controlled workload | Measured frames | Average FPS | Frame median / p95 | Total CPU median / p95 | Reported calls / triangles |
| --- | ---: | ---: | --- | --- | --- |
| Rooftop, Automatic | 1,201 | 120.0 | 8.30 / 10.00 ms | 2.50 / 5.30 ms | 764 / 163,006 |
| Street, Automatic | 1,199 | 119.9 | 8.30 / 10.30 ms | 2.50 / 5.00 ms | 816 / 169,135 |
| Balcony melee, Automatic | 1,201 | 120.0 | 8.30 / 10.20 ms | 2.90 / 5.10 ms | 854 / 168,963 |
| Rooftop, High | 1,198 | 119.7 | 8.30 / 10.20 ms | 2.50 / 5.20 ms | 761 / 162,250 |

The High run rendered internally at **2048 × 1152**, with 1024 × 576 contact shading and twelve AO samples. Both quality levels used one world draw and five fullscreen passes. The actual settings UI also passed a High → Performance → Automatic switch, including resource release/recreation without console errors; the original Automatic setting was restored.

Controlled combat benchmarks use real input, weapons, AI, hit detection and rendering, but replenish health and replace defeated NPCs to sustain a reproducible workload. They hold the starting render ratio because their controlled frame loop bypasses normal adaptive-resolution sampling; reports list the actual contact-shading state, buffer dimensions and sample counts for every measured configuration. They are not uninterrupted normal play, GPU timings, or console performance measurements. Frame results apply only to their reported viewport, quality, device and workload.

The results are display-paced frame intervals, not maximum engine throughput. This pass does not establish 4K performance, console certification, long-session endurance, physical controller coverage, or an uninterrupted human campaign completion. Audio playback quality was deliberately not evaluated. Characters and most geometry remain procedural; scanned assets, authored cinematic animation and other work would still be needed to approach the menu illustration's realism.

Local screenshots, reports and command logs are saved in `artifacts/expansion-review-2026-08-27/`, an ignored verification folder. Earlier results remain in [spatial-review.md](spatial-review.md) and [validation.md](validation.md); they must not be substituted for measurements of this expanded build.
