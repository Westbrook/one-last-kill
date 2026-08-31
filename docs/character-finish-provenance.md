# Character finish provenance — August 31, 2026

This pass is original code-authored geometry, vertex colour, UV mapping and PBR material work. It introduces no photograph, scan, externally licensed model, new generated image, remote URL or runtime image-generation dependency.

The existing `public/assets/characters/face-albedo-trial.png` and its exact prompt record remain unchanged. That fictional adult face was generated without an actor reference; the original tool exposed no exact model selector. Its known mild directional shading remains in the source. The new palette response compresses its contrast and chroma around the same base skin colour as the neck and arms. The source is still diffuse reference, not calibrated albedo or independent normal/roughness data.

The authored finish lives in `src/render/hero-character-geometry.js`, `hero-character-head.js`, `hero-character-materials.js`, `hero-face-albedo.js` and `hero-surface-finish.js`. It reuses the six existing 256² procedural cloth/skin maps and the single existing face image. No extra texture sampler, texture allocation, light, rendering pass or body material draw is added. Finish regions use two normalized bytes per vertex: roughness and microdetail weight. Those immutable attributes are constructed and cached with each appearance at startup, shared by pooled actors, and interpolated by the existing GPU skinning draw.

The six combat roles receive the shared finish. The brawler retains olive jersey and a tapered crew cut; the thug has worn jacket leather; the gunman and hitman retain woven shirts with different roughness and wear; the bruiser and enforcer separate their matte armor/webbing from the cloth below. Each has its own continuous hair perimeter, with short crops for the heavy roles and restrained offset crown shaping for the gunman/hitman. Existing civilian and player silhouettes and face treatments are retained. The common cloth maps now use directional yarns and quieter broad crease colour, so their reuse also changes civilian cloth microdetail.

Hair perimeter/shape, garment wear, skin warmth and material-region values are authored estimates. They are not measured PBR properties, strand simulation, cloth simulation or a claim of photographic realism. Regional roughness keeps matte jersey, woven trousers, leather, rubber, skin and hair distinct under the established lighting. Existing roughness-map variation is retained at restrained amplitude; the source maps are not regenerated during play.

The connected field-sculpted garment body still uses its original planar UVs; it is not a fully unwrapped sewn cloth asset. This pass preserves the existing circumferential neck/arm/boot and palm UVs that the prior attribute builder replaced. Close side views of the implicit garment remain the appropriate place to check for projection compression. No additional triplanar texture sampling is used.

The reviewed collar, skeleton, hit dimensions, weapon attachments, grip/muzzle anchors, attack timelines and pose driver are preserved. The brawler's distal bare forearm is fitted to the existing palm's ten-sided wrist section with the same wrist-bone weights. This corrects a visible surface step without moving the hand or weapon. The live-motion review and measured resource deltas belong to the coordinated August 31 art review rather than this source record.

The first brawler trial compressed facial contrast too far and weakened mouth/jaw readability in the rendered front and low views. The accepted revision retains more of those diffuse landmarks and adds a restrained worn edge to the existing sleeve hems. No collar trial was introduced in this pass.

| Combat role | Body triangles, before → after | Shared geometry bytes added | Body draws |
| --- | ---: | ---: | ---: |
| Thug | 13,814 → 13,832 | 34,210 | 4 |
| Brawler | 13,572 → 13,618 | 40,350 | 4 |
| Gunman | 13,438 → 13,462 | 34,662 | 4 |
| Bruiser | 14,796 → 14,816 | 35,468 | 4 |
| Hitman | 13,570 → 13,600 | 35,622 | 4 |
| Enforcer | 14,682 → 14,696 | 34,526 | 4 |

One cached geometry of each combat appearance adds **152 triangles** and **214,838 bytes** (about 210 KiB), including **123,238 bytes** of finish attributes. Retaining cylindrical/palm UVs preserves separate UV seam vertices and accounts for the other additional vertex storage. These are typed-array budgets, not driver memory; weapons, bone textures and repeated render/shadow passes are excluded. The six procedural 256² RGBA maps retain about 2 MiB including mipmaps. The unchanged 1254² face image remains 2,102,953 download bytes and about 8 MiB of estimated RGBA mip storage. No additional image is downloaded. Exact per-role values, source hashes and the preserved baseline comparison are in `artifacts/cohesive-art-2026-08-31/character-resource-budget.json`.
