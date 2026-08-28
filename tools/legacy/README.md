# Historical diagnostics

These original scripts were preserved unchanged during the module migration.
They target the old single-file game, contain machine-specific paths, and launch
their own Chrome process. They are not supported tests for the current game and
are not part of any npm command. Do not use them for silent verification.

Use `npm run check` for current static/unit/build validation. Start `npm run dev`
and open `http://127.0.0.1:4173/?qa=1&mute=1` for the visible, hard-muted integration
suite and frame-time measurements.

Pre-existing untracked diagnostic scripts and screenshots were left untouched.
