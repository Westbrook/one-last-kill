# Mobile message overlays — September 4, 2026

Compact screens now keep the game canvas and HUD at the full viewport height. The former opaque communication rail reserved 104–192 CSS pixels even with no message; it has been removed. A small objective remains visible, while temporary messages appear near the top with a background only behind the text. Desktop placement is unchanged.

Only `src/gameplay-layout.css` changes runtime behavior. The existing lifetimes remain: ordinary status messages default to 2.5 seconds, objective banners last 4.5 seconds, and story captions receive six seconds of simulation reading time. Pause preserves that time. Status messages and contextual pickup prompts interrupt the story, while its separate radio subtitle remains visible; story reading resumes afterward. A pickup prompt still lasts while it is relevant.

Mobile overlays leave room for motion/recenter, audio and the full drop/rage/pause controls. Compact route choices, armor, rage and threat feedback were repositioned where their old layout depended on the reserved strip. Paused menus, briefings, endings and death screens hide mobile communications. The overlays do not intercept touch input.

## Verification

- 79 existing HUD, checkpoint/audio and touch-control tests pass, including message replacement/expiry and caption interruption/resumption. Production build passes with the existing large-chunk advisory.
- Actual game frames at 390 × 844, 320 × 568, 844 × 390 and 568 × 320 report full-size canvases and HUDs. Live status/radio overlays overlap no touch button. A paused game hides all communications.
- A separate, explicitly labelled static fixture uses actual HUD markup, CSS and the touch-control factory. Four mobile sizes passed layout checks with RECENTER, RAGE, active rage, FPS, armor, low health, radio and urgent messages visible. Narrative messages and route choices also clear controls at the smallest portrait and landscape sizes. This fixture does not start gameplay, sensors or audio, and its sample FPS is not a measurement.
- The cleared fixture paints no message or communication bar. The 1280 × 720 desktop fixture retains the original banner at 18%, status at 74%, and caption 118px above the bottom. A source comparison confirms that declarations outside the compact media queries are unchanged.

The first live run showed the normal caption disappearing during play. A later nine-second observation ended in player death and is retained as a death-visibility observation, not as proof of timer expiry; the existing controller tests verify the exact timer behavior.

[Responsive review](../artifacts/mobile-message-overlay-2026-09-04/responsive-check.html) offers the live game and the static control fixture. [Live layout measurements](../artifacts/mobile-message-overlay-2026-09-04/layout-live.json), [final stress measurements](../artifacts/mobile-message-overlay-2026-09-04/stress-active-layout-final.json), [desktop check](../artifacts/mobile-message-overlay-2026-09-04/desktop-source-check.json), [tests](../artifacts/mobile-message-overlay-2026-09-04/scoped-tests.txt) and [build log](../artifacts/mobile-message-overlay-2026-09-04/build.txt) preserve the evidence.

At a fixed render scale, reclaiming the strip increases rendered pixels by 26.3% at 390 × 844 and 36.4% at 844 × 390 with touch enabled. Automatic quality remains available and unchanged. These are layout checks on the local browser, not new phone GPU, sensor or sustained-FPS benchmarks.
