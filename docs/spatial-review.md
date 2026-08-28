# Architecture and NPC review — 27 August 2026

This pass responds to the review of building context, more believable NPC structure, and additional bat/fist encounters along the balcony. It retains the original escape route and both ending branches.

## Building and circulation

`src/world/layout.js` is the common spatial contract for builders, encounter placement, navigation and tests. The main envelope is `x=-15..13, z=-10..0`; the stair tower occupies `x=-21..-15`. The first playable floor is at 4 m and the roof at 14 m. The east terrace is a recessed gallery beneath the upper floors, with columns and a canopy at 7.4 m. Upper facades, returns and windows now agree with that envelope.

The balcony wrap is 1.8 m deep, leaving approximately 1.6 m between the wall and protective screen. The formerly invisible tall boundaries now have visible framed mesh. Steel brackets connect the gallery to masonry. The staircase has concrete treads, nosings, attached handrails and a roof cap. Service cabinets replace doors that previously implied rooms outside the tower. The roof doorway is narrowed to its actual landing, and the water tank has grounded feet, a cradle and a service ladder.

The scaffold has continuous grounded standards, footplates, ledgers, transoms, real diagonals and masonry ties. Braces do not cross the balcony access band. Offset decks preserve the original descent; guard openings and navigation agree about where to drop. The third deck begins beyond the widened balcony, and the scaffold trigger excludes the balcony.

Floating road-level facade strips were removed. Pavement reaches building fronts, the opposite shops have depth and closed entrances, and distant foundations meet background ground. Bakery signage and its awning face the street and have physical mounts. Furniture now meets its floor and supporting legs; cabinet depth, pendant cords, the charred apartment entrance, counter, oven flue and car placard provide consistent context.

## Actors and close combat

All six enemy archetypes use a shared articulated rig with 17 named joints, tapered anatomy, shaped heads, attached hands and boots, and planted-foot walking poses. Fist, bat and ranged attacks use separate guard, windup and contact poses. Grip sockets are unscaled, preserving the bat's approximately 0.84 m length. Head hit bounds follow the actual head. Clothing uses restrained, readable colors, with shared geometry and appearance materials. A 0.52-second local-axis collapse relaxes attack poses and keeps balcony bodies grounded within the railings and end caps; settled bodies stop scanning their bounds.

The balcony contains three finite pairs: three unarmed brawlers and three bat carriers, with at most two alive. Progress gates keep groups ahead of the player; retreating does not restart an ambush. Holding position allows a 4.5-second breather, while pushing onward can stage the next pair after at least 1.25 seconds. Ordinary floor, clearance and spawn-distance rules still apply. Retry restores the stage state.

Melee pickup prompts omit ammunition; an identical bat no longer offers a useless “+0 ammo” interaction or hides a useful nearby pickup. Hit particles are smaller and darker so they do not obscure NPC poses.

## Verification record

All browser inspection and gameplay use `mute=1`, with `qa=1` in development. The immutable audio policy prevents Web Audio allocation. The browser QA panel provides actual scene tests, paused NPC pose inspection and separate controlled street/balcony combat measurements.

The visual review covered all eight zones and both new melee archetypes. It found a noncolliding brace across the gallery that collision-only tests could not detect. A new check verifies the visible structural corridor as well as collision. Structural tests compare selected built meshes and collider bounds, check declared support contacts, and exercise actual door clearances. They are game-authoring checks, not an engineering or building-code assessment.

Final `npm run check` passed lint, **163 unit tests**, and the production build. Browser QA passed **29/29 checks in 3.72 seconds**, including 170 registered structural objects, 265 support connections, all five authored openings, the full escape route, 36 NPC pose samples, both balcony-end collapse cases, real fist attacks/bat pickup, all three encounter stages, pooling, retry and both endings.

The final production bundle is `main-UOCfZkWe.js`: 731.52 kB, 201.51 kB gzip. The existing preview at `http://127.0.0.1:4175/?mute=1` was refreshed and checked through Begin Mission, briefing, gameplay and pause. Pressing M retained the audio lock. No development QA panel appeared; the production console had no new warnings or errors. The preview was left paused and ready to resume.

Final measurements used an Apple M5 Max (Mac17,6), macOS 26.6.1, Node 24.16.0 and the in-app browser at its native 1280 × 720 CSS viewport, with render ratio 1.20. Each measurement followed a 0.5-second warmup and covered 10 measured seconds. These are real animation-frame intervals and JavaScript CPU measurements, not GPU timer queries.

| Controlled fixture | Frame samples | Average FPS | Median / p95 frame time | Median / p95 fixture + simulation + render CPU | Final-frame calls / triangles |
| --- | ---: | ---: | --- | --- | --- |
| Balcony melee | 1,198 | 119.8 | 8.30 / 9.20 ms | 2.70 / 4.90 ms | 828 / 96,242 |
| Street firefight | 1,200 | 120.0 | 8.30 / 9.20 ms | 2.30 / 4.50 ms | 665 / 119,919 |

The balcony fixture ran 12 real bat swings, 12 hits and 9 kills, with 1–2 live contacts and 9 replacement spawns. It restored health 12 times after 138 damage. The street fixture ran 84 real shots, 45 hits and 9 kills, with 3–4 live contacts, real reloads and 9 replacements. It restored health 31 times after 294 damage. Both checked the audio lock on every sampled frame and reported **no AudioContext**. Fixtures restored the apartment afterward. The final development console also had no new warnings or errors.

Raw reports and JPEG captures are kept in the ignored `artifacts/spatial-review-2026-08-27/` directory. `balcony-melee-final.jpg`, `brawler-guard.jpg`, and `bat-carrier-guard.jpg` show the finished encounter/rigs. Images labeled `initial` or `before-collapse-fix` retain visual evidence from the earlier polish pass; they are not the final state.

These remain procedural game characters and authored collapse animations, not scanned people or a physical ragdoll system. Controlled combat fixtures restore health and replace defeated enemies to sustain a reproducible workload. They do not establish an uninterrupted human campaign playthrough, console certification, GPU execution time or performance on other hardware.
