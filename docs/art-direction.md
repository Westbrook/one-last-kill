# Art direction and reference provenance

The target is a grounded, readable urban crime thriller: worn materials, plausible spaces, restrained color, recognizable civilian surroundings, and short dangerous encounters with breathing room between them. This is an original fan-made campaign inspired by *The Punisher: One Last Kill*, not an official adaptation or a reconstruction of its film frames and dialogue. Cinematic presentation is a direction for iteration, not proof that the browser prototype has reached AAA console production quality.

## Verified reference material

Research was performed on August 27, 2026 using official Disney/Marvel material. Static publicity images were inspected without playing trailers, video, or audio. No official still, poster, film footage or screenplay was added to this repository as a game asset.

Disney identifies the work as a Marvel Television Special Presentation released May 12, 2026 in the US. Jon Bernthal stars and co-wrote it with director Reinaldo Marcus Green. The official interview describes Frank seeking meaning after revenge, Ma Gnucci pursuing payback, a quiet psychological opening, and later action driven by character and survival. These are tone and story-context references, not specifications for this game's mission. [Official Disney interview](https://thewaltdisneycompany.com/news/the-punisher-one-last-kill/)

| Reference | Observable direction for this project |
| --- | --- |
| [Official apartment still](https://thewaltdisneycompany.com/app/uploads/2026/05/Punisher_Trailer_Still_2_R2-1024x428.jpg) | Dusty green-gray walls, worn wood flooring, sparse belongings, exposed utility wiring, warm kitchenette light, and hazy window backlight. Wear and light explain the room without covering every surface in clutter. |
| [Official street still](https://thewaltdisneycompany.com/app/uploads/2026/05/Punisher_Trailer_Still_9_R-1024x428.jpg) | Everyday neighborhood space, weathered yellow school buses and muted olive clothing. The world should feel inhabited and ordinary before it feels like an arena. |
| [Official streaming poster](https://thewaltdisneycompany.com/app/uploads/2026/05/Punisher_Now-Streaming_Poster-691x1024.jpg) | Scuffed black leather and tactical cloth, distressed white paint, controlled neutral gray atmosphere, and clear figure/background separation. |
| [Disney trailer and key-art announcement](https://press.disney.co.uk/news/trailer-and-key-art-revealed-for-a-marvel-television-special-presentation-the-punisher-one-last-kill) | Primary-source links to the official trailer and publicity still collection. The trailer is a reference link only; it is not embedded or played by the game. |

No official public screenplay release was found in this research. The game's written cues are original text in `src/game/navigation.js`; the final outcomes are authored in `src/game/mission.js`. They must not be presented as quotations or transcribed scenes from the special.

## Deliberate creative differences

The connected apartment/balcony/stairwell/roof/scaffolding/street/bakery route, its exact geometry, the Little Sicily mission setting, finite squads, checkpoint behavior, and player-selected car/bakery endings are this game's authored construction. Their presence does not establish that those events or routes occur in the special. The expanded service roof, open lightwell, shop fronts, bakery preparation room and interior furnishings are also original level design. Dusk lighting, the skyline composition, HUD, weapon balance, pickup halos and navigation cues are game presentation choices.

The inspected street still is daylight; the darker game palette is therefore a creative choice rather than a claim of frame accuracy. Keep practical lighting, believable materials and ordinary architecture as the common ground. Any new film-specific detail should have a primary reference, and any invented detail should remain identified as original game content.

## Visual priorities

| Area | Direction | Guardrail |
| --- | --- | --- |
| Materials | Dusty sage-gray plaster, umber brick, dark worn wood, scuffed metal and restrained cloth detail | Keep material scale consistent between surfaces; avoid oversized stains, painted-in directional shadows, or plastic specular highlights. |
| Light | Warm utility lamps against cooler exterior light, with visible route and enemy silhouettes | Darkness must not hide stairs, exits, pickup prompts or attack cues. Use the existing eight-light practical budget rather than adding unbounded point lights. |
| Space | Door frames, conduits, lintels, rooftop hardware, distant windows, scattered mundane belongings | Preserve traversal clearance and distinguish decorative background objects from real cover. |
| Atmosphere | Layered distant buildings and moderate haze, small particles and localized effects | Keep contrast around targets; avoid filling the screen with smoke, glare or unrelated neon color. |
| Characters | Distinct proportions, clothing, weapons and readable movement/attack preparation | Different enemy roles should remain recognizable without relying only on an outline or label. Current procedural rigs are a prototype limitation. |
| Combat | Responsive input, legible impacts, useful cover, ammunition decisions and recovery beats | Effects should confirm an action rather than obscure it. Reduced-motion settings must remain usable. |
| Story | Original captions, environmental evidence of civilian life, and a meaningful protection choice | The mission must remain understandable with sound permanently off. Do not make a spoken line the sole source of a necessary instruction. |
| Interface | Restrained typography, clear objectives, consistent ammunition/health feedback | Decorative film styling must not reduce contrast, obscure the reticle, or disguise menu focus and interaction states. |

## Spaces and encounter rhythm

The opening apartments keep their existing exterior walls and exits but use partitions and furnishings to suggest daily life. The player's sleeping alcove, kitchenette, storage and sitting area provide different views of the room. The neighbor's foyer opens around a dining table into a living area and kitchen. Refrigerators, cookers, shelves, coat hooks and supported cabinets should read as useful objects, not scattered cover boxes. Rugs and small belongings rest on their actual supporting surfaces. Keep the starting sidestep pocket and the routes through these rooms clear; dense decoration is not a reason to force extra jumps.

Outside, the 1.8 m gallery remains a close encounter space. The stair tower has four flights, each with fourteen treads over a 4.2 m run and deep turning landings, so the route reads as a connected circulation space. The roof then opens into a service yard: a mechanical house, ventilation equipment, water tank, maintenance supplies, drainage and guarded edges explain both the building's function and the combat cover. Its 935 m² plan area excludes the open lightwell but still includes equipment and parapets; it is not all free walking space. The lightwell preserves a real exterior opening for the first apartment's north window.

Four offset scaffold decks lead down into a larger district with pavement, parked vehicles, separate shop fronts and street cover. The bakery contains a public shop and a connected preparation room with an oven and work surfaces. Shared `ROOF`, `STAIRS` and `DISTRICT` definitions keep these places, their entrances and encounter positions aligned. Background shops remain scenery unless an interior is explicitly built.

The player begins with fists. The first flat has two melee contacts; the neighbor adds the first armed opponent after its opening pair. The finite zone rosters rise through 2, 4, 6, 8, 12, 14, 16 and 18 contacts, with smaller limits on how many can be alive at once. This progression creates room for weapon acquisition and recovery instead of immediately filling every room with gunfire.

The roof's first two sentries must be defeated before finite reserves begin arriving; later groups can overlap, with at most five contacts and one enforcer alive. Passing a stair landing or descending beyond a scaffold deck can leave its contacts behind without granting kills or clear rewards. At street level, the car finale has eight bodyguards, while protecting the bakery means facing its eighteen-contact roster within 180 seconds of active simulation. These are authored pacing choices, not evidence that the experience is balanced, difficult or compelling for every player. The entire mission must remain understandable without sound.

## Generated assets

The shipped raster assets are original generated material, served from `public/assets/`. They are not downloaded film frames or actor photographs. Exact generation requests and edit history are retained beside them so a future contributor can understand intent and provenance.

| Asset | Purpose | Sidecar |
| --- | --- | --- |
| `last-kill-keyart.png` | Menu background: a rear-facing lone vigilante in a worn tenement doorway, city depth to the right and dark space for UI on the left | `last-kill-keyart.prompt.txt` |
| `plaster-aged.png` | Aged sage-gray plaster base color | `textures.prompt.txt` |
| `brick-weathered.png` | Weathered umber running-bond masonry base color | `textures.prompt.txt`, including the authorized boundary edit |

Generated texture prompts requested flat albedo and continuous tiling. Those requests are not a guarantee of calibrated physically based material data or perfect repeat boundaries. The current brick received one documented boundary edit, but it still has a narrow partial-course/mortar band at the vertical edge. **Perfect vertical seamlessness is not established.** Check a repeated 2×2 sample and a tall in-game wall before accepting a future replacement as seamless.

`loadSurfaceTextures` in `src/render/materials.js` keeps procedural materials as load-failure fallbacks. The generated brick and plaster color images remain at their original resolution. `surface-detail.js` derives coordinated normal and roughness data from a smaller sample of each same image: pale mortar is recessed, while plaster uses local microcontrast so a broad stain does not become a raised lump. The old color-image bump map is removed. This is an authored estimate of relief and finish, not independently measured height, normal or roughness data; the derived channels cannot repair a seam already present in the albedo.

Other surfaces use static procedural profiles in `surface-detail.js`: concrete pores, wood boards and grain, scuffed metal, asphalt aggregate, overlapping tar, ribbed roof metal, aged stone, rubber, gravel and tile. Each profile coordinates color, shallow relief and roughness; metallic surfaces also use a metalness channel. These maps are built once when a material is first created, not animated or regenerated every frame. They are code-authored materials and do not need image-generation prompt sidecars.

`SURFACE_METERS` and material metadata define the physical scale of each repeat. `world-uv.js` applies that scale in `addBox` and in transformed unit boxes passed through `pushDecor`, so large walls, slabs and batched trim do not stretch one tile across arbitrary dimensions. Texture repeats remain aligned across color, normal and roughness channels. Other geometry still needs suitable authored UVs; this helper is not a universal mapping fix for every character, pipe or instanced prop.

For a replacement asset, retain the original prompt, generation/edit method, reference provenance, intended use and known limitations in its sidecar. Keep runtime files local and remove dependencies on external image hosts. Test the asset in both a close view and repeated architectural context; a convincing isolated tile can still create visible patterns across a building.

## Character and lighting presentation

The first-person fists now use two procedural hands with shaped palms, curled finger segments, opposed thumbs, cuffs and sleeves. Jabs alternate sides and return to a lower guard. Hand pose follows simulation state and respects reduced motion; the presentation does not change attack range or damage. Shared geometry and instanced finger parts keep the construction reusable. These are game models, not scans of Jon Bernthal or a claim of anatomically exact hands.

Warm practical lights remain constrained by the eight-light pool. A single 2048 × 2048 directional shadow map is fitted to the playable roof and district bounds rather than distant skyline dressing. Auto/high quality can add restrained GTAO contact shading before the weapon layer. The pass reconstructs normals from the world's depth, works at half the drawing-buffer dimensions with eight or twelve samples, then denoises and composites the result. It uses one world geometry draw; it still adds full-screen GPU work. Performance quality bypasses it, and auto bypasses it when adaptive resolution falls below its budget threshold.

Contact shading can help corners, furniture and equipment sit against nearby surfaces, but it does not supply baked global illumination, material scans or film lighting. Keep it subtle enough that brick mortar and shaded cloth remain readable. Changes to exposure, roughness, shadow fit or AO should be judged together, with the player moving and with both quality paths available.

## Practical limits and evaluation

This renderer does not supply a film production's scans, bespoke facial animation, motion capture, large texture library, or console certification. Most geometry is procedural, static world content is created at boot, and background detail is batched or instanced. Directional lighting, bounded practical lights, shared geometry and effect pools are chosen to keep that workload manageable. NPCs use a bounded cached grid planner; it is not a navmesh or a guarantee of natural movement through every furnishing arrangement.

Evaluate changes by silently playing the route, not only by a flattering menu image or isolated screenshot. Check target readability, material scale, motion comfort, checkpoint recovery and frame consistency during combat. Keep measured performance and actual playthrough evidence in the validation record; do not infer them from image quality or the existence of a performance setting.
