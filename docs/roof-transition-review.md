# Roof transition, raised bat guards and floor supplies — 2026-08-28

This pass responds to flicker/jitter at the stairwell's rooftop exit, forward-pointing bat guards, and the request for recognizable floor ammo boxes on the balcony and roof. It preserves checkpoint positions, doorway clearance, encounter rosters, weapon damage, and attack contact timing.

## Stair and roof stability

Two separate defects were reproduced without a browser:

- Actual indexed floor triangles overlapped at the same height: the threshold extended 13 cm into the roof, 1 cm into the landing, and covered the masonry wall's top. The different material faces were separated by at most a few billionths of a metre, making them vulnerable to depth-buffer flicker. Eight more coplanar face overlaps occurred at the doorway's parapet, coping and flashing returns.
- The capsule solver sometimes resolved the corner of an adjacent slab before the floor underneath the player. At a flush joint, this projected horizontal motion into upward velocity and briefly marked the player airborne. The actual player-controller regression reproduced an unwanted 0.36 m/s upward impulse despite a flat floor.

The threshold now meets the landing and roof at their edges, occupying `x=-15.3..-15` at floor height 14 m. Masonry stops at the threshold's underside, with sill bands supporting the adjoining jambs. Parapets and coping join the stair wall's exterior face; flashing terminates with a small reveal instead of overlaying the doorway faces. These are actual geometry changes, not depth-bias changes or adjusted test metadata.

The collision solver now resolves a descending, crossed horizontal support plane directly under the feet before rounded-edge contacts. It does not bridge gaps, climb a taller obstacle or cancel upward jumps. Player camera bob and normal step easing remain unchanged.

The new regressions inspect actual mesh triangles, check one visible floor surface at 40 positions across the seam, verify solid support connections, and traverse the combined stair/roof geometry in both directions at 1.2, 4.2 and 7 m/s. The repaired seam produces zero spurious steps, zero vertical velocity and zero airborne frames, with foot-height error below `1e-7` m. Separate tests run the actual player/camera code at 120, 60 and 30 Hz with normal and reduced motion, including stationary and post-riser settling cases. An independent solver audit also checked collider ordering, both axes, diagonal slab corners, jumps, unsupported gaps, ceilings, thin-floor falls and complete stair traversals.

## Raised bat guards

The player's bat now rests upright beside the right shoulder, leaning slightly backward. Windup draws it farther back and right before the swing. It does not remain extended toward the target between attacks. At 70° field of view the very tip intentionally leaves the top of the frame; the barrel and grips remain visible, and near-plane/reticle constraints are unchanged.

NPCs use raised, backward guards both at rest and while alert. Recovery raises the barrel clear of the head before turning it back to the shoulder. Tests check both hands' attachments, full shaft/head clearance, joint reach and flexibility, grounded feet, pool resets and gallery corpse behavior. The canonical 0.84 m bat, geometry budget and contact at phase .50 remain unchanged.

## Floor ammo boxes

The wall cabinet is replaced by a low olive ammo case on the balcony floor beside the stair entrance. Two more cases sit near rooftop cover: west of the front equipment bank and south of the eastern pallet stack. Each has a recognizable lid, carrying handle, latches, rubber support rails, and **AMMO** labels on its lid and front. The interaction prompt also names it an **AMMO BOX**.

All three cases have independent finite stock. Each can supply up to 24 pistol rounds, 6 shotgun shells, 30 SMG rounds or 40 machine-gun rounds, shared across weapon types within that case. Collection adds reserve only for the current firearm; it cannot grant a gun or automatically reload. Exact weapon inventory and all three supply ledgers restore together at checkpoints.

Pickup targets sit just above each case so the box does not block its own interaction from the sides. Tests use the real builders to check deck support, walking lanes, rooftop approaches, spawn clearance and occlusion. Parts share three geometries and five materials across all cases: 15 meshes, 2,172 triangles and no added lights in total. Empty boxes remain physically visible with their colliders.

## Verification record

The initial integrated run in `artifacts/roof-transition-review-2026-08-28/integration.log` recorded 412 passing tests and three newly failing triangle-overlap checks before the geometry repair. This preserves evidence that those regressions detect the defect rather than merely accepting the replacement geometry. Final command results are recorded separately in `checks.log` in the same ignored artifact directory.

The integrated command check passed **422/422 Node tests, ESLint and the production build**. The bundle is `main-D5pbLTfV.js` (862.34 kB, 245.75 kB gzip). A limited production-browser smoke check loaded that exact script, entered the mission through the normal briefing, captured the rendered apartment, paused and resumed, and returned to a fresh game menu. The visible audio control stayed locked off. `production-startup.jpg` records that startup check; it does not show or certify the roof transition, bat guards or ammo boxes.

Development QA now contains 48 runtime checks, preserving the previous 45 and adding actual floor-face coverage, normal-input/camera seam traversal, and independent rooftop supply collection. It also provides paused views from both sides of the threshold. Inspection specimens cannot resume through a canvas click; returning to the game menu clears them. These new browser checks are implemented but have not been executed in this pass.

Rendered inspection of these specific changes and new frame-rate measurements are still pending. The separate QA test page remains blocked by browser URL safety after an earlier failed connection. No alternate browser or access workaround has been used. A user-opened `http://127.0.0.1:4173/?qa=1&mute=1` page is required to complete those checks. All browser work stays muted; CPU tests use fake audio services and never connect to a sound device. Prior browser performance results do not certify this build.
