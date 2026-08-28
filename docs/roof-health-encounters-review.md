# Rooftop supplies and encounter variation

Both rooftop crossings now have two fixed 30-HP packs. Previously both roof packs were on the front crossing, leaving the longer northern route without a supply. The original thirteen campaign supplies, including both front packs, retain their positions and amounts; two packs have been added to the back route.

| Route | Landmark | Supply ID | Floor position (metres) | Health |
| --- | --- | --- | --- | ---: |
| Front, straight out of the stairwell | Western crossing beside the water tank | `roof-front-west` | `(-10, 14, -5)` | 30 |
| Front | Eastern crossing | `roof-front-east` | `(13, 14, -5)` | 30 |
| Back, left out of the stairwell | West link beside the open lightwell | `roof-north-west` | `(-13.75, 14, -14.2)` | 30 |
| Back | Beyond the mechanical house, south of the northern HVAC bank | `roof-north-east` | `(12, 14, -19)` | 30 |

`HEALTH_SUPPLIES` is the shared frozen authoring list. `ROOF_HEALTH_ROUTES` describes both paths through physical landmarks, so supply documentation does not depend on which enemy happens to appear nearby. The front route faces east from the stairs; turning left means north, around the west side of the lightwell and then behind the mechanical house. The routes rejoin at the eastern scaffold exit.

Real world geometry tests walk the complete front crossing (about 41.3 m) and north crossing (about 64.9 m) in both directions with a 0.48 m radius, 2.02 m high capsule. They check support, eight nearby approaches to each pack, clear sightlines, camera projection and the actual pickup's rotating/bobbing bounds. The western approach includes the authored 1.5 cm gravel finish; it is not a hole or floating supply. Collection tests use the production pickup controller and confirm exactly 60 HP per chosen route while preserving the other route's two packs.

Full health leaves packs available, collection clamps at 100 HP, and a rooftop checkpoint retry restores its packs using the same meshes and lights. The light source now goes to zero intensity when collected or in another zone. This matters because the practical-light pool uses intensity rather than source visibility: merely hiding the halo previously left a pooled glow behind. The GPU light budget remains eight; the two new packs add sources, not extra rendered lights.

Normal encounter attempts and checkpoint retries now draw fresh uint32 seeds. The pure schedule samples first-arrival, recovery and reinforcement delays once, generally within 18% of their authored duration. It also shuffles the eligible pockets for each wave/entry and applies modest horizontal offsets. Roof offsets are at most 0.6 m per axis; narrower spaces have smaller allowances. Supplies remain fixed.

Each jittered position retains its untouched authored anchor as a fallback. Both must pass real support and full-body clearance, five-metre player separation, height, route, crowding, concealment and pair-bearing checks. Spawn clearance uses the complete conservative capsule, rather than the slightly shrunken AI steering probe. A few west-balcony offsets exposed that distinction during review; they now fall back instead of entering the clearance margin.

Timing and placement have separate addressed hash streams. Failed placements and pool acquisitions do not reroll a contact; pausing does not advance its timer. Resetting an existing schedule reuses its plan, while beginning a new gameplay attempt creates a new plan. Null seeds retain authored behavior for explicit fixtures; fixed seeds, including zero, reproduce arrival preferences and delay samples. A seed does not promise an identical playthrough when the player's movement or live geometry changes.

The safety and pacing rules remain intact: six balcony front contacts arrive as three atomic pairs, supplemented by two separately capped rear entries. Rear arrivals remain concealed, weaker than an armed player and protected by their existing attack grace. Minimum recovery and stage handoffs do not randomize. The balcony opening never starts later than its established 0.1-second sprint window and prefers its exposed pair of anchors, varying within that tier before considering corner fallbacks. Both opening roof sentries must be defeated before the remaining ten contacts can pile on, with no more than five alive and one enforcer. Finite rosters, checkpoint count, pickup amounts outside the two new packs, and final-branch deadlines are unchanged.

Controlled development QA temporarily pins authored or explicit fixed seeds. An idempotent cleanup restores the previous seed policy before the final apartment reset, including on failure or disposal during an asynchronous check. Ordinary play, inspectors and manual benchmarks do not leave the seed policy pinned to a regression fixture.

The final `npm run check` passes ESLint, **984 Node tests**, and the production build. New coverage includes 22 health/controller tests, 20 actual-world variation tests across 33 seeds, 19 QA seed-lifecycle tests and five runtime director integration tests using eight selected fixed seeds, alongside pure timing/placement and existing campaign regressions. Actual rig-pool rollback, head visibility, full capsule clearance, paused timers, finite rosters and checkpoint/finale seed ownership are checked with explicit quiet presentation/audio sinks. The development interface now has 56 visible QA checks; those were updated but were not executed in a browser.

The final production JavaScript is `main-CbfcjWoB.js`, **936.41 kB / 273.73 kB gzip**. It still emits the configured 900 kB chunk warning; the warning threshold was not raised. Offline artifact inspection confirms both new northern supply IDs are bundled, HTML assets exist locally and the development QA interface is excluded. The game still requires only a static web server.

Local logs and source/build hashes are retained in `artifacts/roof-health-encounters-2026-08-28/`, which is ignored by git. All work used silent CPU fixtures and static builds; no audio was played. Browser permission remains unavailable, so there is no new browser playthrough or GPU-performance claim. No remote changes, CI jobs or GitHub Actions were requested or run.
