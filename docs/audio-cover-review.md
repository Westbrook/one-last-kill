# Audio, projectile cover and balcony pairs

Reviewed on 28 August 2026. This pass addresses action audio, checkpoint radio, a background score, independent levels, inconsistent projectile cover, and the missing second forward balcony attacker. It preserves all eight checkpoints and the static-server deployment model.

## Audio behavior

The settings panel exposes Master, Effects, Ambience, Music and Radio / Voice levels, plus a checkpoint-voice switch. Values persist with the existing preferences and reset with them. Neither sliders nor saved preferences unmute the session.

Twenty-nine local mono WAVs total **1,371,812 bytes**: six footsteps, twelve impacts, three mechanical recordings and eight short human radio phrases. Their [asset credits and limitations](../public/assets/audio/README.md) and [source/transform manifest](../public/assets/audio/manifest.json) retain CC0 notices, performer credits, file hashes and conversion details. The mechanical set includes disclosed object/toy substitutes and an airsoft reload; it is not described as authentic recordings of the depicted firearms. No film dialogue, film soundtrack or cloned voice was added.

Footsteps sample the surface beneath the player's feet and vary with stance and movement. Jump and landing contacts are separate events, with vertical landing force retained even without horizontal movement. Gunshots use layered procedural transients and bodies, with a short interior reflection and positional enemy balance. Reload start, insertion and completion follow the real simulation timeline; taking a bat does not play a firearm mechanism. Melee distinguishes a windup, a body hit, a solid-surface hit and an empty swing. Player shotgun impact audio is aggregated per trigger rather than stacked for every pellet. The NPC shotgun also emits one discharge cue per existing pellet cluster, preserving its damage timing, while automatic weapons retain one cue per round.

Eight recorded tactical phrases accompany the original story captions. The short radio subtitles match those recordings and do not imply that they read Castle's longer written lines. Only the current checkpoint can wait briefly for audio-context readiness or its local clip; expired and superseded messages never play from an asynchronous completion. An optional fallback uses an available local-device voice, with no remote speech service. Radio ducks an original low-register harmonic bed and pressure-responsive pulse without changing the user's music setting.

Every session starts muted. `mute=1`, `qa=1` and WebDriver sessions remain permanently silent: no audio context, nodes, sample requests, decoded buffers or speech. Pause, mute, death and restore cancel audio and pending work. The controller limits source voices, decoded memory and concurrent loads, and successful warmup does not repeatedly fetch evicted samples. The runtime catalog omits the larger provenance audit from the JavaScript bundle; `node tools/update-audio-catalog.mjs` regenerates it after an asset-manifest change.

## Projectile and contact behavior

Movement clearance still uses the same authored collision boxes. Player and NPC shots now query the final visible world triangles, including batched furniture and instanced parts. Chair backs, seats and legs, TV cases, railing bars and handrails stop shots. The spaces between them remain open. Masked wire screens use their alpha holes, while transparent solid glass stops bullets without blocking sight.

The nearest world surface bounds the actor query. Player camera-to-barrel and barrel-to-target checks, plus the NPC shoulder-to-barrel check, prevent a drawn weapon from starting a bullet beyond nearby cover. The neighbor's cached debris registers once and follows its actual enable/visibility state. Render-only fire and smoke do not become bulletproof volumes.

Impacts consume the real hit material and normal: muted masonry dust, wood chips, small metal sparks and cool glass flecks. The existing 64 impact slots are reused, with no new per-hit rendering resources. Motion keeps particle quads outside the contacted plane, including floors and slopes, without disabling depth tests or changing surface ownership.

This remains hitscan combat. There is no material penetration, ricochet or destructible glass/furniture, and enemy damage retains the established head/body hit volumes. Explicit transform/material/mask edits need a ballistic object update; geometry-buffer edits need an index rebuild.

## Balcony behavior

The balcony now has **six forward contacts in three pairs, plus two additional rear contacts**: eight total, with at most three alive and one designated rear pursuer. The opening has two fronts; the later groups each add one rear slot. Rear contacts no longer consume the second forward slot.

Forward positions are selected jointly against real floor support, body clearance, separation and the player's bearing. The first anchor is reconsidered if it prevents a valid second one. A pair commits only after both real rigs are acquired; failure of the second rig rolls back the first without consuming an entry or granting kills, drops or health.

Defeating a forward pair allows the next pair to stage after its recovery interval even when an older rear contact is alive or awaiting safe placement. That rear contact stays in the finite roster. Full group-clear rewards still require all its contacts to be defeated. Rear loadout, concealment, distance and attack grace remain in force. The stairwell retains its existing eight contacts and two-enemy cap. Overall zone totals are now **2 → 4 → 8 → 8 → 12 → 14 → 16 → 18**.

## Verification and limits

The combined local check passed lint, **891 Node tests**, and the production build. Tests exercise real player and weapon controllers, NPC damage and pursuit, every authored stair guard, actual chairs and TV, atomic rig rollback, all eight balcony contacts, audio event timing, mute and resume races, recorded-cue timeouts, source cleanup and asset integrity. These are CPU fixtures with explicit quiet presentation/audio services, not a replacement for playtesting. The development interface now contains 54 visible QA checks, which were updated but not executed in a browser during this pass.

The final CPU geometry report records 3,178 fixture meshes and 80,290 triangles, a 55.8 ms index build, and approximately 1.4–3.3 microseconds per tested query after warmup. That fixture omits distant decoration and actors from the timing; instancing and live AI paths have separate correctness tests. These numbers do not establish browser FPS or GPU performance.

The production JavaScript chunk is approximately **930 kB / 271 kB gzip** and still exceeds the configured 900 kB warning threshold. The build succeeds; no threshold was raised to hide the warning. All new media is local, with no backend or account dependency.

**No audio was played or auditioned.** Waveform, format, gain, timing and resource checks were performed offline. Perceived balance and sound quality still need a listening pass. Existing browser permissions prevented visual/play confirmation; no alternative browser or port was used to bypass that restriction. This task made no remote changes and did not request or run CI jobs or GitHub Actions.

Local logs are retained under `artifacts/audio-review-2026-08-28/`; the CPU query record is under `artifacts/ballistics-review-2026-08-28/`. Those generated directories are ignored by git.
