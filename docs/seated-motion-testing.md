# Seated motion comparison

The game now has two selectable seated motion modes. Physical comfort and real sensor behavior remain for phone/tablet testing.

## Try both modes

1. Open the device-test HTTPS link directly in Safari on iPhone/iPad or Chrome on Android. Sign in to the private preview if requested.
2. Open **Settings**, enable **On-screen touch controls**, and allow motion access.
3. Choose **Swipe + gyro** or **Gyro edge turning** under **Seated motion mode**. The choice is saved on that device when storage is available.
4. Begin or resume while holding the device comfortably. Initial motion setup makes this pose a level view.
5. Stay seated and try turning around, tracking a target above/below the horizon, moving while firing, and changing grip.
6. Pause, open Settings, choose the other mode, and resume the same run to compare.

**Swipe + gyro:** swipe the right side for large turns and use small device movements for fine horizontal/vertical aim. FIRE remains an independent hold-to-fire trigger.

**Gyro edge turning:** small device movements aim directly. Hold farther left/right to turn continuously; return to your comfortable center to stop. The status text indicates the turning direction. Returning reverses only the small bounded aiming offset, retaining accumulated large turns.

**RECENTER:** hold while changing grip, then release. It preserves camera direction and stops continuous turning while held. Cancellation and lost touch capture also establish a fresh baseline.

**LEVEL VIEW ON RESUME:** pause and use this separate Settings action when you want the current comfortable device pose to correspond to a level game horizon. Ordinary reposition, pause/resume and mode changes preserve existing vertical aim.

**Vertical motion sensitivity:** start at the default 1.5× and adjust in Settings if up/down aiming needs too much wrist movement. General Look sensitivity and the usual sights reduction also apply. MOTION can still switch to swipe-only aiming or retry sensor access.

## Prototype tuning

Edge mode allows ±15° of direct wrist yaw. Continuous turning smoothly grows from zero at 15° to 120°/second at 27°, measured at normal look sensitivity without sights. These values are prototype choices, not ergonomic limits. Pitch remains relative so recoil, sights, touch input and existing camera clamps continue to work together.

The game advances edge turning every active simulation step, including when browsers suppress unchanged sensor samples. Invalid sensor values, lost focus, pause, disabled controls and reference changes stop retained turning. Recovery establishes a fresh baseline. Permission denial and unavailable sensors retain swipe play.

## What feedback helps

- Device/browser, portrait or landscape, and whether the tablet is held or supported.
- Which mode makes a full turn and looking behind easier while seated.
- Whether fine target tracking, stopping at neutral and vertical aiming feel predictable.
- Accidental turns, drift, grip fatigue, difficult button reach, or jumps after resuming/changing posture.
- Preferred vertical sensitivity and whether edge turning begins too early or too late.

## Verification

Automated coverage includes independent physical-pose math; continuous turns without new samples; equivalent elapsed time at 30/60/120 Hz; invalid sensor recovery; additive hybrid gyro/swipe with separate movement and FIRE; cancellation, reference changes, mode switches, and one-shot leveling. Existing complete project checks pass 1,976 tests, lint, material audit and production build. The existing large-bundle build advisory remains.

Browser Settings checks at 320×568 and 568×320 verified mode selection, level-view action, scrolling and no horizontal overflow. All 63 full gameplay browser regression checks passed in 19.17 seconds, with no recorded console errors. No physical-device comfort claim is made by these checks.
