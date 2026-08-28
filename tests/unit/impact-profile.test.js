import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPACT_PROFILES, resolveImpactProfile, impactParticleStyle } from '../../src/render/impact-profile.js';

test('actual world material aliases select metal, masonry, wood, glass or muted dark dust', () => {
  const aliases = {
    metal: 'metal', roofMetal: 'metal', 'roof-metal': 'metal', wire: 'metal',
    concrete: 'concrete', agedStone: 'concrete', stone: 'concrete', gravel: 'concrete',
    plaster: 'plaster', wallpaper: 'plaster', tile: 'plaster', brick: 'brick',
    wood: 'wood', 'bat-aged-wood': 'wood', glass: 'glass', glazing: 'glass',
    tar: 'dark', asphalt: 'dark', rubber: 'dark',
  };
  for (const [surfaceKind, expected] of Object.entries(aliases)) {
    assert.equal(resolveImpactProfile({ surfaceKind }), IMPACT_PROFILES[expected], surfaceKind);
    assert.equal(resolveImpactProfile({ material: { userData: { surfaceKind } } }), IMPACT_PROFILES[expected]);
    assert.equal(resolveImpactProfile({ material: { name: `surface-${surfaceKind}` } }), IMPACT_PROFILES[expected]);
  }
  assert.equal(resolveImpactProfile({ surfaceKind: ' SURFACE-ROOFMETAL ' }), IMPACT_PROFILES.metal);
});

test('explicit surface labels win and unlabelled legacy calls fall back to neutral dust', () => {
  assert.equal(resolveImpactProfile({ surfaceKind: 'wood', material: { metalness: 1 } }), IMPACT_PROFILES.wood);
  assert.equal(resolveImpactProfile({ surfaceKind: 'solid', material: { metalness: 0.7 } }), IMPACT_PROFILES.metal);
  assert.equal(resolveImpactProfile({ material: { transmission: 0.5 } }), IMPACT_PROFILES.glass);
  for (const hit of [undefined, null, {}, { surfaceKind: 'solid' }, { surfaceKind: 'unknown' }, { material: {} }]) {
    assert.equal(resolveImpactProfile(hit), IMPACT_PROFILES.neutral);
  }
});

test('wood mixes matte chips with dust and glass uses only one small flash per burst', () => {
  assert.deepEqual([0, 1, 2, 3].map(i => impactParticleStyle(IMPACT_PROFILES.wood, i).kind), ['dust', 'chip', 'chip', 'dust']);
  assert.deepEqual([0, 1, 2, 3].map(i => impactParticleStyle(IMPACT_PROFILES.glass, i).kind), ['flash', 'fleck', 'fleck', 'fleck']);
  for (let i = 0; i < 8; i++) {
    assert.equal(impactParticleStyle(IMPACT_PROFILES.wood, i).additive, false);
    assert.equal(impactParticleStyle(IMPACT_PROFILES.metal, i).kind, 'spark');
  }
  assert.equal(impactParticleStyle(null), IMPACT_PROFILES.neutral.primary);
});

test('profiles reuse immutable, short-lived styles and reserve additive blending for tiny flashes or sparks', () => {
  assert.equal(Object.isFrozen(IMPACT_PROFILES), true);
  for (const profile of Object.values(IMPACT_PROFILES)) {
    assert.equal(Object.isFrozen(profile), true);
    for (const style of [profile.primary, profile.secondary].filter(Boolean)) {
      assert.equal(Object.isFrozen(style), true);
      for (const value of Object.values(style)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
      assert.ok(style.life * 1.2 <= 0.34 && style.life * 0.8 > 0.04);
      assert.ok(style.opacity > 0 && style.opacity <= 0.85);
      assert.ok(style.speed > 0 && style.growth > -1);
      if (style.additive) {
        assert.ok(['spark', 'flash'].includes(style.kind));
        assert.ok(style.width * 1.2 <= 0.036 && style.height * 1.2 <= 0.036);
      } else if (style.kind === 'dust') assert.equal(style.texture, 'dust');
    }
  }
});
