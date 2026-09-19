# Seated motion control options

Design assessment, 11 September 2026. These are recommendations, not implemented or physically validated controls.

## Recommendation

Start with **swipe for large turns and gyro for fine aim**, plus explicit comfortable-pose calibration and a separate **Level view** action. If turning should remain mostly motion-driven, compare this with **direct aim near center and continuous turning beyond a comfortable yaw boundary**.

The current implementation maps physical heading/elevation changes approximately one-for-one into camera changes at normal sensitivity. It also disables swipe aiming while motion is active. That leaves physical turning or repeated use of RECENTER as the available ways to turn through large angles.

## Options

| Option | Seated experience | Tradeoff |
| --- | --- | --- |
| Swipe + gyro | Swipe horizontally to turn around; move wrists slightly for precise horizontal and vertical aim. | Most straightforward first prototype. Requires thumb travel and careful layout beside FIRE, movement and other actions. |
| Tilt controls turn speed | Turn the device a little left/right and hold it there to keep turning; return to the calibrated resting pose to stop. | Unlimited turns with small movement, but less direct for precise tracking. Needs a forgiving neutral zone, smooth acceleration and an adjustable speed limit. |
| Direct aim + edge turning | Small wrist movements aim directly. Beyond a comfortable left/right boundary, holding the device there adds continuous turning. | Preserves fine motion aiming while allowing large turns. The transition needs clear feedback and hysteresis; the return movement must not undo the accumulated large turn. |
| Clutch + quick turns | Rotate wrists, hold RECENTER while returning to a comfortable grip, release and continue. Optional 90/180-degree touch turns handle large changes. | Builds on existing behavior, but repeated clutching can be awkward on a heavy tablet. Quick turns can be abrupt. |

Higher sensitivity can supplement any direct-aim option. For example, 3x gain turns a 20-degree wrist sweep into a 60-degree camera turn. It also amplifies hand motion, and returning the device still reverses the turn unless a clutch or other large-turn mechanism is used. Gain alone does not solve the problem.

## Establishing a vertical center

The game should distinguish the camera's horizon, the player's comfortable device pose, and sensor reference calibration.

1. **Initial seated setup:** Let the player hold the device comfortably, including a supported tablet at an angle. An explicit setup action associates that pose with a level game view.
2. **Reposition:** Preserve the current camera aim while the player moves to another comfortable grip, then capture the new sensor baseline. This is what the existing hold-to-RECENTER behavior largely provides.
3. **Level view:** Explicitly return camera pitch to the game horizon and capture the current comfortable pose. Do not silently level while the player is tracking a target.
4. **Vertical response:** Offer independent vertical sensitivity and comfortable physical travel. Direct relative pitch is suitable for hybrid controls; an optional bounded neutral-relative pitch mapping can return the view to level at the calibrated resting pose. Any absolute pitch mapping must deliberately reconcile recoil, touch pitch, sights and pitch clamps rather than overwrite their effects.
5. **Stable frame:** Keep camera roll level, make portrait/landscape and posture changes jump-free, and keep axes consistent for supported or nearly flat holds. The current pole/flat-start safeguards address ambiguity, but do not define a permanent comfortable-pose horizon.

For an experimental motion-first preset, a yaw boundary around 12–18 degrees and comfortable pitch travel around 15–25 degrees each way are starting hypotheses only. They need real seated testing and user adjustment; they are not established ergonomic limits.

## Fit with this codebase

- `src/core/motion-aim.js:98` chooses gravity or a near-flat screen reference; `:133` computes relative heading/elevation deltas; `:166` clears the sensor baseline without leveling the camera.
- `src/ui/touch-controls.js:68` suppresses gyro while RECENTER is held. `:103` hides swipe-look in motion mode and `:252` rejects look movement while motion is enabled. Hybrid mode must deliberately allow valid touch and motion deltas together while preserving calibration, recenter, permission and inactive-session gates.
- `src/game/player.js:137` applies camera sensitivity, with a different sights sensitivity; pitch clamps and recoil also affect the final camera angle. Shared input scaling needs explicit treatment when adding a neutral-relative pitch target or a rate input.
- `src/core/input-state.js:195` provides a frame-based gamepad turn-rate pattern. Continuous tilt steering must run each active game frame; browsers can suppress unchanged sensor readings, so sensor callbacks alone cannot sustain a held turn. Stop rate output on pause, focus loss and sensor/session failure.
- Preserve sensor permission handling, swipe fallback, independent movement/FIRE, screen rotation handling and camera roll suppression across prototypes.

## Validation needed before choosing a default

Compare seated phones and supported/handheld tablets in portrait and landscape. Ask players to turn through 360 degrees in both directions, track a target across the horizon, look behind while moving/firing, release and return to neutral, and change grip or resume play without a camera jump. Test sights, recoil, vertical limits and screen rotation. Evaluate reach, fatigue, accidental turning and tracking accuracy. Existing deterministic tests do not establish physical comfort.

This assessment reviewed source and existing test coverage; no runtime code was changed and no new physical-device test was performed.

## Sources

- Current repository at commit `261f970b7d9fabfc4e0aa70666f6cb30d472232b`; motion, touch, player and input modules above.
- [Valve Steam Deck FAQ](https://partner.steamgames.com/doc/steamhardware/steamdeck/faq?l=english) recommends considering gyro combined with joystick or trackpad for camera/cursor games. The proposed phone swipe adaptation is our design recommendation, not a claimed Valve phone implementation.
- [W3C Device Orientation and Motion](https://www.w3.org/TR/orientation-event/) defines the orientation event/reference frames. A comfortable gameplay horizon is an application mapping decision.
