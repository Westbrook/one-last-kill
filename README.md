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
| Drop weapon | G | D-pad down |
| Pause | P or Escape | Start / Options |
| Confirm / resume | Enter or the visible button | A / Cross, or Start / Options |
| Audio preference, normal sessions only | M or the audio button | Not mapped |

Gamepads must expose the browser's `standard` mapping. Stick dead zones and held-button suppression prevent drift and accidental actions when resuming. This is browser controller support, not console platform certification. Semi-automatic weapons require separate presses; automatic weapons repeat while fire is held.

The menu includes quality, sensitivity, field-of-view, and reduced-motion settings. Preferences are stored locally when browser storage is available. Checkpoints are held in memory for the current session, not saved across page reloads. F toggles the frame display; B starts the in-game benchmark display. Neither is a substitute for a recorded performance test.

The balcony has three pairs of melee enemies, with at most two alive. Pairs use staggered positions, and one contact can arrive from cleared ground behind you. The stairs also allow a pursuer from the lower landing. Rear arrivals use fists against melee weapons or an empty gun, and at most a bat against a firearm with ammunition. They appear outside your view or fully behind solid cover, at least five metres away, with a brief delay before attacking. If no safe position is available, the contact waits. Watch the distinct punch/bat windups, recover between groups, and use E to take a fallen carrier's bat. Duplicate melee weapons do not offer ammunition.

An amber directional warning identifies attacks from outside your view; it turns red when an unseen attacker hits you. It can point behind, left, right, above or below and shows a count when several attackers are active. Turning to see the source clears its offscreen warning. This feedback works with sound locked off.

Look for olive **AMMO** boxes on the floor: one beside the balcony stair entrance, one near the western rooftop equipment, and one near the eastern rooftop pallet cover. Press E to collect reserve rounds for the gun you carry, then R when you need to reload. Each full box provides 24 pistol rounds, 6 shotgun shells, 30 SMG rounds, or 40 machine-gun rounds. Each box has independent finite stock shared across weapon types; partial collections and weapon swaps cannot refill it. Checkpoints preserve inventory and all three boxes, so retries cannot duplicate ammunition. Boxes never give an empty-handed player a gun.

The bat uses one human-scale asset for the player's two-handed grip, NPCs and floor pickups. The player and NPCs hold it raised or drawn back beside the shoulder, extending it forward during the strike. Windup, contact and follow-through match the attack timeline; fist and knife damage also waits until contact. Attacks recheck distance and cover at that moment. Apartment entry doors and their balcony faces share one opening and leaf; interior cupboards remain interior storage.

All eight checkpoints remain. The two apartments now contain connected furnished rooms; the stairwell has four proper flights and broad turning landings. The later route crosses a 935 m² rooftop and four larger scaffold platforms before reaching an expanded street and bakery. Authored encounter totals rise **2 → 4 → 6 → 8 → 12 → 14 → 16 → 18**, with smaller simultaneous groups. On the roof, defeating the first two sentries brings overlapping reinforcements, capped at five active enemies and one machine-gun carrier across the encounter. You can leave contacts behind; bypassing them grants no kills or combat rewards.

Automatic and High graphics add restrained contact shading to the world, with a separate clear view of the player's hands and weapon. Performance mode skips that effect and shadows. Automatic quality also skips contact shading when its resolution budget drops below 1.0. The renderer retains bounded light, particle, corpse and navigation budgets.

## Silent testing

**Every browser test must remain silent.** Use [the silent development QA session](http://127.0.0.1:4173/?qa=1&mute=1) for controlled inspection, and `?mute=1` for ordinary play or production-preview checks. Keep the browser tab or host volume muted too when that control is available.

Audio starts muted even without URL flags. `mute=1`, `qa=1`, or a browser reporting `navigator.webdriver` locks audio off for that entire page session. The M key, UI toggle, and public audio API cannot remove that lock. Silent sessions create no Web Audio context, audio nodes, or sample buffers. In a normal session without a lock, only an explicit unmute allows audio to start while play is active.

The development QA helper is installed only when the Vite development server receives `qa=1`; production builds do not expose it. Adding `qa=1` to a production URL still enforces the audio lock. Unit tests cover the audio policy using fakes, without connecting to an audio device.

**Run regression suite** exercises the real scene, input, collision, mission and ending code with controlled fixtures, then restores the apartment. **Inspect area** pauses the simulation for visual review. Expand **Inspect an NPC on the balcony** to review actual pooled models, joints, poses and grips without AI or damage. The held-weapon inspector shows the bat, fists and knife at specific animation phases without applying damage. Four benchmark buttons separately measure paused rendering, a street firefight, balcony melee, and the rooftop firefight. Combat fixtures replenish health and replace defeated enemies to sustain the workload. Reports disclose those conditions and check the audio lock on every sampled frame. These fixtures do not replace an uninterrupted human playthrough.

## Find the code

| Location | Responsibility |
| --- | --- |
| `src/main.js` | Initialization, the simulation clock, frame orchestration |
| `src/core/` | Renderer, collision, input, settings, audio, timing |
| `src/game/` | Player, weapons, enemies, mission state, navigation, testable rules |
| `src/world/` | Shared spatial layout, structural registry/helpers and the eight zone builders |
| `src/render/` | Materials, articulated humanoid rigs, environment detail, lighting, effects |
| `src/ui/` | HUD, objectives, briefing, end cards, frame display |
| `public/assets/` | Local generated art and its prompt/provenance sidecars |
| `tests/unit/` | Browser-independent regression tests |

Read [the architecture guide](docs/architecture.md) before adding gameplay or a zone, and [the art-direction notes](docs/art-direction.md) before changing assets or film-inspired details.

See [the rear encounter review](docs/rear-encounter-review.md) for rear arrivals, staggered balcony pairs, directional attack warnings and verification limits. [The surface ownership review](docs/surface-ownership-review.md) covers the floor/wall and ceiling seam cleanup. [The roof transition and ammo-box review](docs/roof-transition-review.md) covers the preceding doorway stabilization, raised bat guards and floor supplies. [The character, combat and supply review](docs/character-combat-review.md), [expansion and stability review](docs/expansion-review.md), [earlier architecture and NPC review](docs/spatial-review.md), and [initial validation record](docs/validation.md) preserve prior measurements; those browser performance results do not certify the newest build.

Original tracked diagnostics are preserved in `tools/legacy/`. Pre-existing untracked `_inspect.mjs`, `_probe.mjs`, `verify-task22.mjs`, and `shots/` captures were left untouched. They are not the supported test interface; do not assume their browser launch commands, selectors, timings, or audio behavior are safe or current. Use `npm run check` and the explicit silent QA entry point for new work.
