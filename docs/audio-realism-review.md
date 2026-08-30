# Sound realism review

Reviewed 30 August 2026. This pass audits the game's effects and refines its existing local audio system. It does not add generated or recorded firearm samples, change gameplay damage/timing, or use a remote service at runtime.

## Changes

| Sound | Previous behavior | Current behavior |
| --- | --- | --- |
| Rifle, pistol, shotgun, SMG, machine gun | Narrow noise burst with a descending pitched oscillator | Original pressure transient, irregular broadband body, diffuse bass and darkening tail; four deterministic waveforms per family and small playback-rate variation |
| Remote gunfire | Gain and stereo pan | Also loses high-frequency detail with distance and arrives after distance / 343 seconds; inaudible events still allocate nothing |
| Indoor gunfire | One generic delayed noise burst | Two darker, quieter copies of the actual report provide early room reflections |
| New weapon pickup | Rising musical chime, plus a separate firearm equip cue | Fabric/grip contact and a short weapon-appropriate handling sound; one contextual event |
| Ammo / health | Same musical chime as weapons | Brief metal inventory contacts for ammo; softer fabric/package noise for health |
| Bat / knife pickup | Musical chime | Quiet wood contact or short sheath-like friction; no firearm action |
| Handling | Equip could start at a recording's leading silence; full cock/equip proxy clips | Short existing measured contact windows, filtered low rumble, restrained levels and slight rate variation |
| Recorded radio | Two clean tones and a 6.8 kHz low-pass | Short opening squelch, a quiet carrier, 350–3,300 Hz speech band and mild speech compression, then closing squelch |

The receiver opens only once a clip is ready or a fallback is chosen. Its carrier and closing noises belong to the current transmission. Pause, mute, death, restart and a superseding zone cue cancel them. The closing noise separates queued transmissions. The eight existing recordings and their matching subtitles are unchanged. Native-device speech is outside the Web Audio graph and cannot receive the same filtering; that fallback remains a documented limitation.

Gun synthesis is physically inspired sound design, **not a recording or validated simulation of a particular firearm**. The room reflections are authored stereo cues, not acoustic raycasts. Air absorption and travel time do not add wall occlusion or sound propagation through doorways. Existing airsoft, toy and object handling proxies retain their original provenance and limitations in [the asset credits](../public/assets/audio/README.md).

## Whole-game coverage

Player and NPC firearm events, shotgun pellet aggregation, reload phase contacts, melee windup/contact, player footsteps and landing, surface impacts, pickup paths and all eight radio checkpoints were inspected. Existing contact timing and material selection were sound and were retained. Footstep and impact samples already rotate variants. The score remains an original procedural bed; radio still ducks only music.

Remaining gaps are explicit: NPC footsteps are absent; the fire-crackle API is not connected to the visible fire barriers; dropped weapons have no falling/landing simulation; and the shotgun pump has no independent animated cycle. This pass does not invent a landing or pump contact. A synchronized pump sound needs an animation phase, and fire audio needs proximity/visibility ownership rather than a global noise loop.

## Verification and audition

Before commit, `npm run check` passed lint, **1,390 tests**, and the production build on an isolated snapshot containing only this audio change. Earlier shared-workspace checks also passed, including all **70 focused audio/integration/synthesis tests** after the final receiver lifetime and sample-reflection calibration fixes. The existing 900 kB chunk warning remains; the warning threshold was not changed. Logs are under ignored `artifacts/audio-realism/`, including `commit-check.log` for the isolated snapshot.

Tests cover report headroom, finite PCM, silent endpoints, negligible DC, distinct spectrum/decay, waveform variation, positional delay/filtering, receiver lifetime, contextual pickup integration, clip timing, cancellation, source cleanup and the unchanged immutable mute policy. The report cache holds at most 20 mono buffers: about 1.50 MiB at 48 kHz, in addition to the existing sample cache. All synthesis and loading remain disabled in hard-muted sessions. On this machine the complete warm report generation measured about 12.9 ms; the first cold variant was about 3.5 ms. These CPU measurements are not browser frame-rate results.

`tools/audio-review.html`, served by the development server, renders a repeatable stereo WAV through the actual controller using **OfflineAudioContext**. Rendering does not play audio; the listening control requires a separate user action. The reel covers each weapon, automatic repetition, indoor/outdoor/distant reports, pickups, reload phases and radio. It reports measured output levels and invalid/clipped samples. Optional baseline modules can be placed under ignored `artifacts/audio-realism/before/` to compare the old graph against the same local sample catalog.

The current and baseline graphs were both rendered successfully in the in-app browser: 40 seconds, stereo, 48 kHz PCM16. All 29 local samples decoded, and both renders contained **zero clipped or non-finite samples**. The current reel peaked at **−3.48 dBFS** (baseline **−4.50 dBFS**). Levels were not normalized; this is the actual default mix with music and ambience disabled. Playback controls were confirmed paused, muted and without autoplay. Files: `artifacts/audio-realism/audio-review-current.wav` and `audio-review-before.wav`, with matching JSON measurements and timestamps. The baseline includes the former extra equip event on firearm pickup.

No human listening audition is claimed by code, waveform or offline-render validation. Perceived realism, fatigue and the final mix still need listening at a comfortable level. The procedural weapon-only preview and cue timing are also retained under ignored `artifacts/audio-realism/`.

## Optional fal.ai sample pass

No fal.ai requests were sent and no API key was written to project files, environment files, scripts, browser state or Git. The repository text scan found no fal credential pattern. A later acquisition tool should read a session-only environment variable, never embed a key in code, command arguments, asset metadata or client-side JavaScript. Imported samples should remain local, with model, prompt, seed/request metadata where available, processing, hash and rights recorded separately from the existing CC0 manifest.

Current official model information was checked on 30 August 2026:

| Purpose | Model | Relevant controls / listed price |
| --- | --- | --- |
| Discharges, handling, radio squelch | [ElevenLabs Sound Effects V2](https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/api) (`fal-ai/elevenlabs/sound-effects/v2`) | 0.5–22 seconds, prompt influence, loop option, PCM formats as well as MP3; $0.002 per second |
| Alternative effects generator | [Stable Audio 3 Small SFX](https://fal.ai/models/fal-ai/stable-audio-3/small/sfx/text-to-audio/api) (`fal-ai/stable-audio-3/small/sfx/text-to-audio`) | Seed, negative prompt, WAV/FLAC, eight-step default; $0.0206 per output. Documented duration default is 30 seconds; public prose does not establish min/max |
| Optional new original radio performance | [Eleven v3](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3) (`fal-ai/elevenlabs/tts/eleven-v3`) | Expressive direction, selectable voice, stability; $0.10 per 1,000 characters. Do not assume speed, seed or output-format controls absent from its actual schema |
| Alternative original radio performance | [MiniMax Speech 2.8 HD](https://fal.ai/models/fal-ai/minimax/speech-2.8-hd/api) (`fal-ai/minimax/speech-2.8-hd`) | Emotion, speed, pitch, pauses, PCM/FLAC/MP3; $0.10 per 1,000 characters |

The proposed first comparison is three takes of one isolated discharge, one handling action and one radio squelch from each SFX model: 18 clips. Nine eight-second ElevenLabs clips plus nine Stable Audio outputs have a listed generation cost of approximately **$0.33**, before retries or funding requirements. This is a comparison plan, not evidence that either model produces convincing firearms. Use the same source perspective and event descriptions, compare at matched loudness, reject extra hits/voices/music, trim silence, retain useful tails and assess repeated-play fatigue before choosing assets. Generate any speech clean and apply the receiver processing locally.

Questions before acquisition:

1. Should gunfire be dry and naturalistic, or heavier and cinematic? Are there sound references for the desired perspective and weight?
2. Should radio keep the eight existing phrases and improve receiver noise only, or include new original dialogue? If new, what character and delivery?
3. Is the two-model comparison suitable, or is there a preferred model or spending limit?

The model cards indicate commercial use, but generated outputs are not CC0. Review [fal's terms](https://fal.ai/legal/terms-of-service) and [API terms](https://fal.ai/legal/api-services), including provider terms and input rights, before importing winners. Use original scripts and authorized voices; do not imitate a film performance.
