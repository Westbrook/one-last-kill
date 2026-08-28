<!-- SPDX-License-Identifier: CC0-1.0 -->

This directory contains a small CC0 sound subset for the game. The 29 WAV files use mono, 44,100 Hz, signed 16-bit PCM and total 1,371,812 bytes. No recording or converted file was played during acquisition or validation; perceptual quality and the final mix remain unauditioned.

`manifest.json` separates the runtime sound groups in `samples` from the original sources and per-file provenance. Every file records its original filename and SHA-256, output SHA-256, duration, and exact conversion steps. The `licenses` directory preserves the original Kenney license and performer credits, plus source notices for the individual OpenGameArt submissions.

The JavaScript bundle imports only the small generated `src/core/audio-catalog.json`, so it does not parse the full licensing and conversion audit at startup. After changing the manifest, run `node tools/update-audio-catalog.mjs`. Unit tests require an exact catalog match and validate every shipped WAV's hash, format, duration, headroom and silent endpoints without playing it.

The included material comes from these author pages:

- [Kenney — Impact Sounds](https://kenney.nl/assets/impact-sounds): wood and concrete footsteps, plus metal, wood, glass, punch, and generic impacts. Three footstep variations are included for each surface. Generic impacts are not claimed as recordings of concrete; no metal footstep recording is included.
- [Kenney — Voiceover Pack](https://kenney.nl/assets/voiceover-pack): eight short tactical phrases, performed by Jeffrey M. Smith. The source pack also credits Giselle for its female voice, which is not included here. These are existing generic human performances, not movie dialogue, character imitations, or custom campaign narration. Phrase labels follow the source filenames.
- [SpringySpringo — Gun reload sounds](https://opengameart.org/content/gun-reload-sounds): an airsoft rifle reload. The source contains a small number of full-scale peak plateaus; the manifest records this limitation. Its more saturated pistol and cocking files were not included.
- [LFA — Equipment Clicks II](https://opengameart.org/content/equipment-clicks-ii): a 1.00–2.80 second excerpt of recorded desk-object foley, used as the pistol handling cue. It is a sound-design proxy, not a recording of the depicted firearm. The selected excerpt does not reach full scale before conversion.
- [JumboSizedFish — Toy Double Barrel Shotgun Sounds](https://opengameart.org/content/toy-double-barrel-shotgun-sounds): a toy mechanism recording used for the cocking cue. It is not claimed as a real shotgun recording, and its source samples do not reach full scale.

All five author pages identify [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Attribution is retained for provenance even though those dedications do not require it. The sound dedications do not change the license of the game's code or other assets.

Conversion happened offline. Stereo sources were averaged equally into mono; mono sources stayed mono. Each included clip received a 22-frame entrance fade, a 132-frame exit fade, peak normalization to −3 dBFS, and rounding into PCM16. Source timing and pitch were preserved; only the LFA excerpt was trimmed. Attenuation provides output headroom but does not repair clipping already present in a source recording.

The radio IDs are `radio:ready`, `radio:hold`, `radio:hurry-up`, `radio:cover-me`, `radio:get-down`, `radio:go-go-go`, `radio:target-engaged`, and `radio:watch-my-back`. Their filenames use the same suffixes under `radio/`. Runtime captions should match these supplied phrases rather than imply that they speak the campaign's longer written narration.

No firearm discharge recording, external music track, film audio, or cloned voice is included. The game supplies its own procedural gunshot layers and score. This manifest is data; playback, caching, pause behavior, and silent-session restrictions remain the audio controller's responsibility.
