/** Keep shadow resources/shaders resident while reducing repeated shadow draws. */
export function createShadowCadence(shadow) {
  let elapsed = 0, previousTier = -1, refreshes = 0, skipped = 0;
  return {
    update(dt, tier = 0, changed = false) {
      const nextTier = tier >= 2 ? 2 : tier >= 1 ? 1 : 0;
      elapsed += Number.isFinite(dt) && dt > 0 ? dt : 0;
      const interval = nextTier === 2 ? 1 / 20 : 1 / 30;
      const refresh = nextTier === 0 || changed || nextTier !== previousTier
        || !shadow.map || elapsed + 1e-9 >= interval;
      // Changing a focused projection must update its map in the same render.
      // Never resize/dispose the map or change material shader light counts.
      shadow.autoUpdate = nextTier === 0;
      if (refresh) { shadow.needsUpdate = true; elapsed = 0; refreshes++; }
      else skipped++;
      previousTier = nextTier;
      return refresh;
    },
    snapshot() { return { tier: previousTier, refreshes, skipped, autoUpdate: shadow.autoUpdate }; },
  };
}
