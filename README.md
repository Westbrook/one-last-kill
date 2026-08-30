# One Last Kill

An original, fan-made browser FPS inspired by the grounded urban atmosphere of *The Punisher: One Last Kill*. Escape a burning apartment, cross the adjoining building and rooftops, recover weapons, and reach a street-level choice between vengeance and protecting a family. The authored campaign has eight zones, finite encounters, checkpoints, and alternate outcomes.

This is an independent prototype with mature fictional violence. It is not an official Marvel or Disney adaptation, a recreation of the film's screenplay, or a completed AAA console production. Characters and their associated marks belong to their respective owners.

## Run locally

Use **Node.js 22.13+ (22 LTS) or Node.js 24+** and npm:

```sh
npm ci
npm run dev
```

Open [the silent local game](http://127.0.0.1:4173/?mute=1). The server binds to the loopback interface on port **4173**; `localhost:4173` addresses the same local service. A current desktop browser with WebGL 2 and hardware acceleration is required. There is no account, backend, or API key to configure.

Dependencies are pinned in `package.json` and `package-lock.json`: **Three.js 0.185.1**, **Vite 8.2.2**, and ESLint 10.9.1. Use `npm ci` to preserve that dependency graph. All runtime assets are served locally: no CDN imports, remote fonts, streaming video, or live image-generation service is required. Dependency installation may need registry access.

```sh
npm run check
```

This runs ESLint, the Node unit tests, and the production build. It does not launch a browser or play sound. To inspect the production bundle locally, run `npm run preview` after building; it uses the same port, so stop the development server first. Production output is written to `dist/`.

## Play

Choose **Begin Mission**, then continue past the briefing. Mouse capture is requested from the play action. If the browser denies pointer lock, the game remains playable with the keyboard or a standard gamepad. Losing focus, hiding the page, or releasing an established pointer lock pauses play and clears held inputs.

You begin with **fists and no ammunition**. Defeat a bat carrier or gunman and use E to take their weapon. New missions never grant a starter gun; checkpoint retries preserve only the weapon and ammunition you actually reached that checkpoint with.

| Action | Keyboard / mouse | Standard gamepad |
| --- | --- | --- |
| Move | W A S D | Left stick |
| Look | Mouse; arrow keys without capture | Right stick |
| Fire / primary attack | Left mouse; J | Right trigger / R2 |
| Aim | Hold right mouse; Q toggles | Hold left trigger / L2 |
| Sprint forward | Hold Shift | Hold left-stick click / L3 |
| Jump | Space | A / Cross |
| Crouch | Hold C or Ctrl | Hold B / Circle |
| Pick up weapon or ammunition | E | Y / Triangle |
| Reload | R | X / Square |
| Melee | V | Right bumper / R1, or right-stick click / R3 |
| Enter rage when available | T | D-pad up |
| Drop weapon | G | D-pad down |
| Pause | P or Escape | Start / Options |
| Confirm / resume | Enter or the visible button | A / Cross, or Start / Options |
| Audio preference, normal sessions only | M or the audio button | Not mapped |

Gamepads must expose the browser's `standard` mapping. Stick dead zones and held-button suppression prevent drift and accidental actions when resuming. This is browser controller support, not console platform certification. Semi-automatic weapons require separate presses; automatic weapons repeat while fire is held.

**Melee keeps your firearm.** Press V (or RB / R1 / R3) for a close attack without dropping your gun or losing loaded or reserve ammunition. Your firearm remains ready after the melee attack finishes.

**Rage** becomes available while alive and below 30% health after at least four credited enemy kills in the preceding 60 seconds. The prompt appears above your health display: press T or D-pad up to double your **current** HP, without changing maximum HP. Kill an enemy within the next 10 gameplay seconds to keep the remaining boosted health; otherwise health returns to the HP you had when you entered rage. Taking damage still costs health, and rage cannot revive a dead player. Pausing freezes the kill window and the countdown. The eligibility window is configurable through `RAGE_CONFIG.killWindowSeconds` in `src/game/rage-rules.js`.

The menu includes quality, sensitivity, field-of-view, reduced-motion, and audio settings. **Master, Effects, Ambience, Music, and Radio / Voice** each have a volume control; checkpoint voice can also be disabled separately. Preferences are stored locally when browser storage is available. Changing a level never unmutes the game. Checkpoints are held in memory for the current session, not saved across page reloads. F toggles the frame display; B starts the in-game benchmark display. Neither is a substitute for a recorded performance test.

The balcony has **three pairs of melee enemies in front**, plus two additional rear contacts: eight enemies total, with at most three alive and one designated rear pursuer. Each forward pair arrives together at positions checked for lateral and angular separation. A rear attacker does not replace the second forward enemy or prevent the next pair from staging after its predecessors fall. The stairs also allow a pursuer from the lower landing. Rear arrivals use fists against melee weapons or an empty gun, and at most a bat against a firearm with ammunition. They appear outside your view or fully behind solid cover, at least five metres away, with a brief delay before attacking. If no safe position is available, the contact waits. Watch the distinct punch/bat windups, recover between groups, and use E to take a fallen carrier's bat. Duplicate melee weapons do not offer ammunition.

An amber directional warning identifies attacks from outside your view; it turns red when an unseen attacker hits you. It can point behind, left, right, above or below and shows a count when several attackers are active. Turning to see the source clears its offscreen warning. This feedback works with sound locked off.

While alive, a steady red edge tint warns when health is **below 40**, becoming stronger **below 20**. It is separate from the brief damage flash and does not pulse. Healing and checkpoint restoration update it immediately; death clears it. Pause and briefing screens hide the HUD without discarding its health state.

Look for olive **AMMO** boxes on the floor: one beside the balcony stair entrance, one near the western rooftop equipment, and one near the eastern rooftop pallet cover. Press E to collect reserve rounds for the gun you carry, then R when you need to reload. Each full box provides 24 pistol rounds, 6 shotgun shells, 30 SMG rounds, or 40 machine-gun rounds. Each box has independent finite stock shared across weapon types; partial collections and weapon swaps cannot refill it. Checkpoints preserve inventory and all three boxes, so retries cannot duplicate ammunition. Boxes never give an empty-handed player a gun.

The bat uses one human-scale asset for the player's two-handed grip, NPCs and floor pickups. The player and NPCs hold it raised or drawn back beside the shoulder, extending it forward during the strike. Windup, contact and follow-through match the attack timeline; fist and knife damage also waits until contact. Attacks recheck distance and cover at that moment. Apartment entry doors and their balcony faces share one opening and leaf; interior cupboards remain interior storage.

All eight checkpoints remain. The two apartments now contain connected furnished rooms; the stairwell has four proper flights and broad turning landings. The later route crosses a 935 m² rooftop and four larger scaffold platforms before reaching an expanded street and bakery. Authored encounter totals are **2 → 4 → 8 → 8 → 12 → 14 → 16 → 18**, with smaller simultaneous groups. On the roof, defeating the first two sentries brings overlapping reinforcements, capped at five active enemies and one machine-gun carrier across the encounter. You can leave contacts behind; bypassing them grants no kills or combat rewards.

Both rooftop crossings have **two 30-HP health packs**. The front route retains its packs beside the water-tank crossing; turning left out of the stairs leads to another beside the lightwell and a fourth beyond the mechanical room. Walk over a pack to heal. Full health leaves it available, and a rooftop checkpoint retry restores the roof's supplies.

Enemy arrival pockets and group delays vary on each encounter attempt, including checkpoint retries. Small position offsets keep close quarters safe; the roof and street allow more spread. Finite counts, simultaneous balcony pairs, rear-attack safeguards and the rooftop opening fight remain unchanged. Supplies stay in fixed locations so either rooftop route can be learned.

Player and enemy bullets now test the world's visible solid geometry independently of movement barriers. Chair seats, TV cases, furniture, stair handrails and actual bars catch shots; the open space between those parts does not. Glass blocks bullets while remaining transparent to enemy sight. The barrel's path is checked too, so a weapon drawn beyond nearby cover cannot fire through it. This is still hitscan combat, not material penetration or destructible furniture.

Action audio combines local foley with procedural weapon layers, material-specific footsteps and impacts, positional enemy sounds, and reload cues tied to simulation events. Eight short human radio recordings accompany the checkpoint captions, with their own matching subtitles. An original low-register score responds to nearby pressure and ducks during radio cues. These are generic licensed recordings and original synthesis, not film audio or an actor imitation. See the [audio asset credits](public/assets/audio/README.md) for sources and recording limitations. All audio remains local and the production build still needs only a static web server.

Automatic and High graphics add restrained contact shading to the world, with a separate clear view of the player's hands and weapon. Performance mode skips that effect and shadows. Automatic quality also skips contact shading when its resolution budget drops below 1.0. The renderer retains bounded light, particle, corpse and navigation budgets.

Connected GPU-skinned character surfaces include shaped jaw/neck transitions, ears, folded collars, sleeve hems and role-specific clothing details. NPC stride follows completed movement after collision, with eased stance and swing transitions. First-person hands have joined finger roots and thumb webs, shaped knuckles/pads, stitched glove panels and GPU clench morphs. Authored firearm/knife profiles retain fitted grips and shared finishes. These are original game assets and authored motion, not scans or motion capture.

Dropped firearms share the reduced NPC geometry, with a darker steel finish confined to drops that reuses existing maps. The dropped knife has its own cached blade/handle asset. Health supplies now use a shaped case with a handle, latches and readable crosses, retaining the same collection rules and health-warning thresholds. The brawler's shoulders and sleeves are shaped during construction without adding triangles or draws; the prior collar is retained.

Upholstery, shaped furniture legs, appliance controls, books, rugs and supported kitchen belongings add domestic detail while retaining the movement layout. The bakery uses scored loaves, varied paper packages and a dedicated preparation-steel finish. Exterior lintels, drainage, service-house louvers and roof cowls add structure; a shared roof membrane finish breaks up the large deck surface. Visible task lamps give the mechanical doors and roof exit local context through the existing eight-light pool, without extra shadow maps.

The rooftop tank's existing wood maps now run as vertical staves without extra geometry. Sedans have fitted cabin pillars, a shaped roof and hood, and rolled bumpers, using fewer triangles overall than the earlier construction. The central street barrier has a tapered Jersey profile and fitted reflectors while retaining its movement bounds.

Local Poly Haven CC0 brick and plaster sets supply coordinated color, normal and roughness maps at physical scale; complete generated/procedural fallbacks remain available. The fictional face color texture is generated and projected onto authored geometry, not an actor scan. See [asset provenance](docs/art-direction.md#assets-and-source-provenance).

Interior lighting uses a bounded 512² startup diffuse bake and three static 64² room reflection captures; neither repeats its capture/bake work during play. A focused 2048² directional shadow map uses stable crop tiers. High detail uses up to four MSAA samples for world edges, subject to the GPU limit. On smaller high-DPI viewports it can now use up to 2.0× render scale; the additional allowance is limited to a 4 Mi-pixel buffer, while larger viewports retain the prior 1.6× ceiling. Automatic and Performance are unchanged. Character skinning resources and all seven held-model variants are warmed behind the loading menu before play becomes available. These features have measured costs and fallbacks, rather than a frame-rate guarantee.

See the [graphics task series](docs/graphics-roadmap.md) for priorities, the [initial graphics review](docs/graphics-review.md) for the historical four-pass ledger, and the [extended graphics review](docs/graphics-ceiling-review.md) for the subsequent art, lighting and performance record. KTX2 wall maps are the production default on approved ASTC 4×4 or BC7/BPTC targets, with the original JPEG/PNG triplets as fallback. ASTC was reviewed in-game; BC7 passed offline quality checks but has not had hardware performance testing. The [compressed asset manifest](public/assets/materials-ktx2-trial/manifest.json) preserves the reviewed files and encoding provenance.

## Silent testing

**Every browser test must remain silent.** Use [the silent development QA session](http://127.0.0.1:4173/?qa=1&mute=1) for controlled inspection, and `?mute=1` for ordinary play or production-preview checks. Keep the browser tab or host volume muted too when that control is available.

Audio starts muted even without URL flags. `mute=1`, `qa=1`, or a browser reporting `navigator.webdriver` locks audio off for that entire page session. The M key, UI toggle, and public audio API cannot remove that lock. Silent sessions create no Web Audio context, audio nodes, sample downloads, decoded buffers, or speech. In a normal session without a lock, only an explicit unmute allows audio to start while play is active. Recorded checkpoint speech has an optional local-device voice fallback; remote speech services are not used. Pause, mute, death and restart cancel active or pending audio.

The development QA helper is installed only when the Vite development server receives `qa=1`; production builds do not expose it. Adding `qa=1` to a production URL still enforces the audio lock. Unit tests cover the audio policy using fakes, without connecting to an audio device.

**Run regression suite** exercises the real scene, input, collision, mission and ending code with controlled fixtures, then restores the apartment. **Inspect area** pauses the simulation for visual review. Expand **Inspect an NPC on the balcony** to review actual pooled models, joints, poses and grips without AI or damage. The held-weapon inspector shows the bat, fists and knife at specific animation phases without applying damage. Five benchmark buttons separately measure a paused scene, a camera sweep, a street firefight, balcony melee, and the rooftop firefight. Combat fixtures replenish health and replace defeated enemies to sustain the workload. Reports disclose those conditions and check the audio lock on every sampled frame. These fixtures do not replace an uninterrupted human playthrough.

**Inspect low-health feedback** provides exact threshold samples and a way to preview the cue in the current paused view. Use **Return to game menu** to restore normal health and clear visual fixtures before playing.

That panel also offers **Inspect rage ready** and **Inspect rage countdown**, using disclosed 20-HP/four-kill fixtures. **Inspect off-hand punch** under the held-weapon panel freezes an actual punch at contact while preserving a pistol and its ammunition. These are paused visual checks, not earned combat results; reset before ordinary play.

**Inspect world objects** adds a dropdown for the health case, each firearm/knife drop, sedan cabin, water tank, street barrier and **Full drop pool (16)**. The latter places sixteen actual machine-gun drops through the production path. These are paused fixtures with normal materials and halo selection, not gameplay or performance results; reset before ordinary play.

The regression suite explicitly uses authored or fixed encounter seeds for repeatable checks, then restores the previous seed policy before resetting the apartment. Ordinary play and manual inspection do not pin enemy arrivals to a test seed.

The QA panel includes graphics-quality and explicit review render-scale controls for comparable captures, hip/aim inspection of every held firearm, and A/B controls for the interior bake, room reflections, roof task lights, focused shadows and projected face color. Character fit checks inspect the actual visible surfaces; hidden legacy bounds proxies are not visual evidence. The scale override is not saved and returns to the normal device/preset setting on ordinary play. Benchmarks report p95/p99/maximum frame time, over-budget intervals, measured render/simulation and full QA callback costs, main-thread long tasks when supported, and optional asynchronous GPU timing across the world and weapon passes. Before/after renderer resource counts and optional heap snapshots help investigate retained state; stable counts do not prove absence of allocations or leaks. Unsupported timing is reported explicitly. rAF intervals describe callback cadence, not proof of presented FPS; these controlled results are not an INP or end-to-end input-latency score.

## Find the code

| Location | Responsibility |
| --- | --- |
| `src/main.js` | Initialization, the simulation clock, frame orchestration |
| `src/core/` | Renderer, collision, input, settings, audio, timing |
| `src/game/` | Player, weapons, enemies, mission state, navigation, testable rules |
| `src/world/` | Shared spatial layout, structural registry/helpers and the eight zone builders |
| `src/render/` | Materials, articulated humanoid rigs, environment detail, lighting, effects |
| `src/ui/` | HUD, objectives, briefing, end cards, frame display |
| `public/assets/` | Local generated art, licensed audio, and provenance records |
| `tests/unit/` | Browser-independent regression tests |

Read [the architecture guide](docs/architecture.md) before adding gameplay or a zone, and [the art-direction notes](docs/art-direction.md) before changing assets or film-inspired details.

The [graphics task series](docs/graphics-roadmap.md) tracks the options and acceptance gates. The [August 29 quality follow-through](docs/graphics-quality-cycle.md) records that pass's asset revisions, health warning and rejected experiments. The [two further graphics cycles](docs/graphics-two-cycle-review.md) record the subsequent object and character refinements. Earlier counts and benchmarks describe their recorded builds, not the current build.

See [the stair physics review](docs/stair-physics-review.md) for the ascent, ground-support and fine gamepad-input fixes. [The rooftop supplies and encounter variation review](docs/roof-health-encounters-review.md) covers fixed supplies and randomized arrivals. [The audio, cover and balcony review](docs/audio-cover-review.md) describes the audio system, precise projectile surfaces and restored forward pairs. [The earlier rear encounter review](docs/rear-encounter-review.md) records the preceding rear-arrival and warning behavior. [The surface ownership review](docs/surface-ownership-review.md) covers the floor/wall and ceiling seam cleanup. [The roof transition and ammo-box review](docs/roof-transition-review.md) covers the preceding doorway stabilization, raised bat guards and floor supplies. [The character, combat and supply review](docs/character-combat-review.md), [expansion and stability review](docs/expansion-review.md), [earlier architecture and NPC review](docs/spatial-review.md), and [initial validation record](docs/validation.md) preserve prior measurements; those browser performance results do not certify the newest build.

Original tracked diagnostics are preserved in `tools/legacy/`. Pre-existing untracked `_inspect.mjs`, `_probe.mjs`, `verify-task22.mjs`, and `shots/` captures were left untouched. They are not the supported test interface; do not assume their browser launch commands, selectors, timings, or audio behavior are safe or current. Use `npm run check` and the explicit silent QA entry point for new work.
