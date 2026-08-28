# Character, combat and supply review — 2026-08-28

This pass addresses the inconsistent bat, character anatomy and attack presentation, mismatched apartment door faces, and the ammunition gap before the stairwell. It preserves the eight checkpoints, fists-only start, encounter rosters, traversal routes and existing weapon damage/range/cooldown values.

## Bat and characters

The player, NPCs and floor pickups now use the same 0.84 m wooden bat. A continuous tapered barrel, narrow handle, turned knob, restrained wood grain and matte wrapped grip replace the separate incompatible shapes. Grip and tip anchors retain metre-scale dimensions; no scaled arm stretches the weapon. The asset shares geometry/material resources and uses two meshes with 1,208 triangles.

The first-person version adds two attached, articulated hands and connected sleeves. Its swing has a readable windup, passes through contact, follows across the body, and returns to guard. Twelve visible meshes total 9,512 triangles including both hands. Geometry tests sample the swing densely at 70°, 82° and 100° fields of view in 4:3 and 16:9, checking grip attachment, reticle clearance and the near plane. These are mathematical geometry checks, not rendered visual approval.

NPC faces now have shaped brows, eye sockets, cheekbones, a nasal tip, jaw, ears and hairline. Collars, hems, sleeves, palms, knuckles and thumbs add silhouette detail without increasing body mesh counts. The bruiser body drops from 5,728 to 5,476 triangles. Bat carriers use the same two-hand attachment and transfer weight through the pelvis and torso during the swing. Limb lengths, sole positions, pool resets and narrow-gallery corpse containment remain tested. Head hit bounds include the visible facial geometry.

## Contact and grounded weapons

Player melee no longer applies damage at button press. The actual contact times are 140 ms for fists, 250 ms for the bat, and 130 ms for the knife. Contact checks current aim, reach and cover and damages at most one nearest target. Moving out of reach or behind a wall during windup prevents a stale hit. Misses do not produce impact feedback or kill credit.

A successful hit briefly holds the held pose without stopping world simulation or input. Reduced motion disables movement bob but preserves essential contact travel. Equip, drop, death, checkpoint restore and a valid firearm reload cancel pending attacks; pause freezes and resumes the same timeline. Existing damage, cooldowns and firearm magazine behavior are unchanged.

Dropped bats no longer stand upright, and guns no longer clip a grip into the ground. Placement uses the actual model bounds and searches a bounded set of positions within 20 cm and orientations, checking floor support and solid geometry. Exact world-axis candidates allow long weapons to lie across narrow stair treads even when the original drop yaw was diagonal. Unsupported placement remains explicitly marked; this is not rigid-body physics.

## Doors and supply

Exterior door faces should correspond to real doors through the same wall. The burned 4A entry now has a cut wall opening, one closed colliding leaf, aligned frames/jambs/hardware on both sides, and a balcony address plate. The open 4B terrace passage has matching frame faces and retains its clear threshold. The neighbor's linen cupboard remains recessed interior storage; adding a balcony door there would incorrectly imply another entrance. These are static architectural assemblies, not newly operable doors.

A green **FIELD RESERVE** cabinet is mounted on the balcony wall beside the stairwell entrance, outside the clear walking lane. Pressing E adds reserve ammunition only for the currently carried firearm; it does not grant a gun or reload a magazine.

| Carried firearm | Maximum yield from a full cabinet | Reserve limit for cabinet collection |
| --- | ---: | ---: |
| Pistol | 24 rounds | 48 rounds |
| Shotgun | 6 shells | 18 shells |
| SMG | 30 rounds | 90 rounds |
| Machine gun | 40 rounds | 120 rounds |

All types share one 120-unit budget. Partial collection consumes only accepted rounds; changing weapons cannot refresh it, and richer ammunition reserves obtained elsewhere are not reduced. Melee weapons and full reserves leave stock untouched. Range, floor, active-session and line-of-sight checks prevent collection from upstairs or through the stair wall. One E press selects one nearest reachable object, not both a dropped weapon and the cabinet.

Checkpoints save the exact loaded/reserve inventory and cabinet ledger together. A retry undoes post-checkpoint collection on both sides, while later checkpoints retain previously spent stock. Only a full new-mission reset replenishes the original cache. The cabinet remains visibly present wherever its collider is active, even after it empties or the player leaves the area.

## Verification and limits

The final `npm run check` passed: **398/398 Node tests, ESLint and the production build**. The suite covers real controller code with explicit fake scene/audio services, material and geometry contracts, pickup support, door collision/clearance, ammo conservation, cancellation and existing campaign regressions. The produced bundle is `main-D_K9Vghx.js` (860.06 kB, 245.09 kB gzip). The full output is recorded in the ignored local artifact directory `artifacts/character-combat-review-2026-08-28/checks.log`. A status-only local HTTP check returned 200 for the muted production URL; that confirms server availability, not browser rendering.

Development QA retains the previous 38 runtime checks and adds seven, for 45 total, plus a paused held-weapon pose inspector. The added checks use actual input and gameplay paths for delayed contact, cancellation, pause, door alignment, ammo selection and checkpoint conservation. Controlled placements and loadouts are disclosed in the reports.

**The new browser checks, rendered visual review and fresh frame-rate measurements have not run.** The owned test tab initially reached a failed-connection page before the development server was ready. Browser security then blocked control of that error page. A user-opened `http://127.0.0.1:4173/?qa=1&mute=1` page is needed to continue; no alternate browser or policy workaround was used. Both local servers are running, and the production preview serves the latest built files after a normal user reload.

All attempted browser work used a hard-muted URL. Node tests use audio fakes and do not connect to an audio device. Earlier 38-check browser passes and performance results in the expansion review apply to the earlier build, not this pass. No new sustained-FPS, human-playthrough, final combat-balance or AAA-quality claim is made here. The characters and animation remain procedural; this pass does not add scanned assets, motion capture, physical ragdolls or destructible doors.
