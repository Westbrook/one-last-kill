# Architecture and extension guide

The game is a Vite application using JavaScript ES modules and Three.js. It builds one connected world at startup and runs one local campaign. The refactor separates reusable rules and data from browser-facing systems, but the runtime still uses shared singleton objects and several circular imports. Treat this document as a map of the current implementation, not a claim that it is a general-purpose game engine.

## Startup and frame ownership

`src/main.js` owns boot order. It loads local surface maps with procedural fallbacks, builds the sky/environment map, constructs world geometry and decorative surroundings, resolves coincident structural surfaces, places the player at the apartment checkpoint, initializes weapons and mission listeners, prepares pickup lights, installs the light budget, and prebuilds enemy rigs. The player starts with **fists**, including after a full campaign reset; weapon pickups are earned from defeated armed enemies. The start button becomes available after initialization succeeds.

`renderer.setAnimationLoop(frame)` is the only gameplay frame driver. The `FixedStepClock` in `src/core/frame-budget.js` advances at **1/120 second**, with at most **eight simulation steps per rendered frame**. Excess time after a stall is bounded rather than replayed indefinitely. Pauses reset the accumulator; returning from a hidden tab does not advance missed gameplay time.

Within each simulation step, `main.js` advances `GameTime.elapsed`, weapon timers, player/input, enemies, the encounter director, triggers, healing, the final choice, endings, combat statistics, and HUD timers. Visual effects, weapon presentation, environment animation, objectives, and navigation then receive only the amount of simulation time that actually advanced. New cooldowns, deadlines, attack windups, and mission delays must use this clock and `dt`, not independent `setTimeout`, `setInterval`, or wall-clock comparisons.

The gamepad is polled even while menus are open so a controller can resume play. Simulation stops during pause, death, the briefing, a resolved ending, page hiding, or graphics-context loss. Rendering is also suspended while idle, except for explicit inspection or a final transition render. Graphics-context loss pauses the session and asks for a reload; there is no transparent world reconstruction.

## Module boundaries

| Module | Owns | Main collaborators |
| --- | --- | --- |
| `core/renderer.js` | Scene, camera, WebGL renderer, shared simulation-time value, quality application | Settings and frame budget |
| `core/frame-budget.js` | Fixed simulation steps and resolution hysteresis | Pure JavaScript; tested without a browser |
| `core/input-state.js` | Held/edge actions, aim toggle, stick normalization, pause/reset behavior | Pure JavaScript |
| `core/input.js` | DOM events, pointer lock, gamepad polling, play/pause transitions | Input state, renderer canvas, audio, HUD |
| `core/collision.js` | Static AABBs, capsule resolution, supported stepping and clearance | Three.js math objects; no renderer needed in tests |
| `core/settings.js` | Validated preferences and optional local persistence | DOM notification is guarded; store logic is injectable |
| `core/audio-policy.js`, `core/audio.js` | Permanent silent-session policy and lazy Web Audio synthesis | Injected context factory in tests; browser adapter at runtime |
| `game/player.js` | Eye/feet conversion, movement, stance, camera, health state | Input, collision, settings, weapons, HUD |
| `game/weapon-data.js`, `weapon-rules.js`, `combat-stats.js` | Balance data, ammo/snapshot rules, combat counters | Browser-independent logic |
| `game/weapons.js` | Equipped weapon, firing/reload behavior, view model, dropped weapons | Player, enemies, collision, effects, audio, HUD |
| `game/melee-rules.js` | Reusable player attack timeline, contact event and cancellation | Pure weapon data; never retains a target or applies damage |
| `game/drop-placement.js` | Bounded pickup orientation and support search | Injected Three.js meshes and collider bounds; no renderer |
| `game/ammo-supply-rules.js`, `ammo-supplies.js` | Independent finite ammo-box budgets, reserve-only collection and grounded case presentation | Pure ledger plus injected world, player and interaction services |
| `game/combat-rules.js` | Damage multipliers, windup completion, visibility memory, occlusion, corpse ownership rules | Pure JavaScript |
| `game/enemies.js` | Archetypes, pooled rigs, AI, hits, death and cleanup | Combat rules, world, player, weapons, mission |
| `game/enemy-navigation.js` | Cached floor/clearance queries, incremental path searches, investigation travel time and pool-capacity rules | Pure rules consuming injected collider bounds and simulation time |
| `game/stair-pursuit.js` | Observed-target routes through the authored flights and landing turns, bounded investigation and arrival grace | Pure stair layout and observed positions; never reads the live player |
| `game/mission-data.js` | Zone order, foot anchors, finite encounter definitions, safe-spawn and checkpoint rules | Pure JavaScript with injected geometry probes |
| `game/encounter-rules.js` | Monotonic route progress, finite wave schedules, overlapping reserves and departed-stage retirement | Pure rules consuming mission data |
| `game/rear-encounter-rules.js`, `encounter-spawns.js` | Rear slot policy, weaker loadouts, perspective separation and safe placement | Pure rules with injected floor, collision, visibility and weapon state |
| `game/offscreen-threats.js`, `threat-feedback.js` | Full-body view checks and bounded attack/hit warnings | Pure tracker plus a camera/enemy/HUD adapter; no audio |
| `game/mission.js` | Checkpoint restoration, waves, pickups, branch choice and ending resolution | Mission data and the active gameplay systems |
| `game/navigation.js` | Route marker and original written story cues | Player, zone notifications, ending state |
| `world/world.js`, `world/zones/` | Shared construction helpers, collision registration, zone triggers and authored spaces | Materials, models, player, HUD |
| `world/layout.js` | Frozen `BUILDING`, `BALCONY`, `ROOF`, scaffold platforms and door openings, in metres | Shared data for builders, encounters, navigation and QA |
| `world/stair-layout.js`, `district-layout.js` | `STAIRS` flights, landings and turn route; `DISTRICT` street, shops, bakery and final arenas | Pure spatial contracts reused by geometry and gameplay |
| `world/architecture.js`, `structures.js` | Structural records, oriented members and visible guard assemblies | World builders, Three.js and collision |
| `world/surface-ownership.js` | One-time removal of covered horizontal architecture faces, preserving exposed fragments and UVs | Structural records and Three.js geometry; no renderer or collision mutation |
| `world/interior-props.js` | Reusable refrigerator, stove, sideboard, bookcase and bench builders | Injected construction, batching and materials; no scene or DOM import |
| `world/door-assemblies.js` | One door opening/leaf with aligned frames and hardware on both faces | Frozen descriptors from `APARTMENT_DOORS` and injected construction services |
| `render/materials.js`, `models.js` | Local/procedural materials and reusable geometry | Renderer capabilities; Three.js |
| `render/surface-detail.js`, `world-uv.js` | Coordinated static material maps and metre-scaled box UVs | Pure texture data and geometry attributes; browser adapter in materials |
| `render/humanoid-rig.js`, `humanoid-geometry.js`, `humanoid-motion.js`, `corpse-pose.js` | Articulated proportions, shared anatomy, joints, weight transfer, grounded collapse and reset | Three.js and shared weapon geometry; no DOM or renderer initialization |
| `render/environment.js` | Instanced distant buildings, architectural detail and atmosphere | World and materials; no gameplay collision changes |
| `render/lighting.js`, `effects.js` | Bounded practical lights and reusable combat effects | Scene, camera, active-zone information |
| `render/shadow-frustum.js` | Fits the directional shadow camera to authored playable bounds | Three.js math; called by world lighting |
| `render/first-person-hands.js` | Shared hand geometry, articulated fingers, alternating jab poses and sleeves | Three.js plus simulation-state inputs; no combat or camera ownership |
| `render/bat-asset.js`, `first-person-bat.js` | Canonical metre-scale bat, material maps, grip anchors and first-person swing | Three.js, shared hands and pure weapon timing data |
| `render/world-presentation.js` | Optional depth-based world contact shading and final color conversion | Injected renderer/scene/camera, quality getter and test resource factories |
| `render/viewmodel.js` | Depth-correct first-person weapon pass and shared lighting layers | Renderer, scene and camera supplied by the caller |
| `ui/hud.js` | Visible feedback, cards, objective banners and frame display | DOM; input engagement for menu actions |

Pure data/rule modules should remain leaves of the dependency graph: they must not import HUD, DOM input, scene construction, or renderer initialization. They are the preferred location for new state transitions that can be tested independently.

Runtime imports are not a strict hierarchy. Notable cycles include input/HUD, player/weapons, enemies/mission/weapons, and world/zone builders. Boot-time calls currently resolve these dependencies after module evaluation. Avoid reading a cyclic import's state during module initialization. Prefer an injected callback or a narrow event subscription, as with `onZoneChange`, when adding a new relationship. Extracting these remaining singleton dependencies is future work.

## Mission and spatial contracts

The authored route is `apartment → neighbor → balcony → stairwell → roof → scaffolding → street`, with the bakery as the eighth zone and one final arena. `ZONE_ORDER`, `CHECKPOINTS`, `ZONE_WAVE_CONFIG`, and `FINAL_ENCOUNTERS` live together in `game/mission-data.js`.

Checkpoint and spawn `y` values describe the **feet/floor position**, not camera height. `Player.pos` is an eye anchor; restore code adds the standing eye height and resets crouching, velocity, jump buffering, camera easing, and held inputs. Keep authored anchors on supported floors with sufficient standing clearance. Do not save the player's arbitrary trigger-entry position, which can be airborne.

During descending movement, `moveCapsule` resolves a crossed horizontal floor plane directly under the feet before rounded-edge contacts. This stops an internal joint between flush slabs from projecting horizontal velocity upward. The plane must lie between the previous and current foot height, so the rule cannot bridge an unsupported gap, climb a tall face, or cancel an upward jump. Camera step easing and walking bob remain separate presentation effects; a flat seam must not produce new step offsets or false airborne frames.

The spatial contracts are the source of truth for an expanded but still authored eight-zone route:

| Space | Shared layout and construction contract |
| --- | --- |
| Apartments | The main shell stays at `x=-15..13, z=-10..0`, with apartment floors at 4 m and a ceiling/canopy at 7.4 m. Interior partitions form a sleeping alcove, hall and living/kitchen spaces in the first flat, and a foyer, dining area, kitchen and sitting area in the neighbor's flat. The breach remains at `x=-3, z=-7.5..-4.5`; the balcony opening stays at `x=9, z=-7..-3`. |
| Balcony | `BALCONY` defines the east terrace, its supporting columns and the 1.8 m exterior gallery, with a common route lane at `z=0.95`. Visible 2.7 m protective screens explain its movement boundary. |
| Stairs | `STAIRS` occupies the existing western tower at `x=-21..-15`. Four switchback flights rise from 4 m to 14 m through landings at 6.4, 9 and 11.6 m. Each flight has 14 treads over a 4.2 m run; turning landings are 2.8 m deep. Its staged route turns behind the guard ends, and the entrance route passes below the east flight. |
| Roof | `ROOF` spans `x=-15..25, z=-24..0` at 14 m. The 40 × 24 m envelope excludes a 5 × 5 m open lightwell: 935 m² of plan area before parapets, the service house and equipment. The lightwell at `x=-12.5..-7.5, z=-15..-10` preserves the apartment's north-facing window. Attached service wings support the added roof rather than leaving an unsupported platform. |
| Scaffolding | `SCAFFOLD_LEVELS` defines four offset work decks at 10, 7, 4 and 1.5 m. Continuous standards, ledgers and transoms carry them from the near apron. Guards leave deliberate drop openings; the trigger begins beyond the balcony gallery. |
| District | `DISTRICT` extends from `x=-38..38, z=0..43`, with a road at `z=8..25`, pavements, parked cars, cover and authored shop fronts. The bakery occupies `x=-34..-16, z=28..43`, with a front shop and a connected preparation room. Other shop fronts do not imply accessible interiors. |

`world/zones/traversal.js` only re-exports the balcony, stairwell, roof and scaffolding builders. Each of those spaces has its own module. Change the shared layout before moving geometry, checkpoints, navigation targets or encounter pockets independently.

`STAIRS.roofThreshold` defines the physical joint between the top landing and the roof. Their floor faces meet at edges instead of overlapping at height 14 m. The east wall stops at the threshold underside, sill bands carry the upper jambs, and the roof parapet/coping meet the wall exterior without overlapping visible doorway faces. Do not add a new surface over the threshold to hide a gap; verify the actual indexed triangles, support connections and bidirectional movement when changing this joint.

`APARTMENT_DOORS` identifies the closed 4A entrance and open 4B terrace passage. Builders cut each opening once and `createDoorAssemblies` supplies both faces from the same descriptor. A closed entrance has one colliding leaf, never a door skin over an uncut wall or two independent leaves. The neighbor's linen cupboard is recessed interior furniture, not a second exterior entrance. Keep thresholds flush and exterior trim out of the usable gallery lane.

`createInteriorProps` accepts construction services rather than importing the runtime world. Each prop has one grounded solid body and small details sent through the decoration batch. Dimensions are metres and positions are floor centres; yaw must be a quarter turn so the visual shape and its axis-aligned collision body agree. Preserve the clear route around the dining table and through the apartment partitions when adding furnishings. Environment props resolve named supporting surfaces, such as `apartment-kitchen-top` and `neighbor-dining-top`, instead of maintaining separate guessed heights.

Selected structural boxes use `addBox(..., { architecture: { id, kind, supports, supportKind } })`. `Architecture.elements` records intended bounds, the built object, its collider if any, and declared supports. A `bearing` connection rests on or modestly overlaps a lower support; `anchored` members connect at an edge or through a joint; `ground` roots reach the ground; `suspended` members hang from a higher connection. Diagonal members and screens register through `structures.js`. Runtime QA checks these selected connections and visible/collider bounds. This is a game authoring contract, not a building-code or structural engineering simulation, and does not certify unregistered decoration.

`finalizeWorldSurfaces()` runs after **all** zones and surroundings have been built, before the first render. The street builder adds walls that support floors built earlier, so this cannot be finalized independently within a zone. The cached report lives in `WorldState.surfaceOwnership`; no clipping or geometry allocation runs per frame.

For static rectangular architecture, a floor, deck, slab, roof, landing, tread or ceiling owns its coplanar surface over a supporting wall, column, beam or building. An explicit `threshold` owns its flush strip within a floor. Equal-priority finishes use the stable architectural ID to choose one owner, independent of construction order. Only same-facing horizontal triangles compete, with a **0.000001 m** plane tolerance for float-buffer roundoff. Both upward wall caps and downward faces at ceiling joints are handled. Real height offsets, vertical faces, opposing bearing contacts and uncovered strips remain intact. A threshold placed above a floor is therefore not flattened into it.

The pass subtracts covered rectangles and clones only changed geometry. It preserves texture coordinates, face normals, complete index draw ranges, object transforms, materials, depth settings, shadow flags, structural bounds and colliders. Attribute values are decoded before copying, including normalized, interleaved and half-float buffers. New fragments remain in the original mesh. It does not use `renderOrder`, polygon offset, disabled depth testing, or overlapping replacement skins. Do not use a mesh bounding box as proof of rendered coverage after finalization: inspect the triangles referenced by its index buffer.

Eligibility is deliberately conservative: ordinary opaque built-in mesh materials on the world layer, a complete validated rectangular box, cardinal positive transforms and affine face UVs. Transparent, masked, displaced, clipped, custom-shader, non-world-layer, dynamic, door/gate, instanced and malformed inputs are skipped. Register new static structural surfaces with the appropriate kind; author physical seams for decorative trim and irregular meshes. Treat finalized geometry as immutable. A layout rebuild needs fresh authored geometry and a fresh finalization report, not repeated clipping of an edited finalized mesh. This is surface cleanup for the authored world, not a general CSG system.

`EncounterSchedule` owns pending contacts, spawned groups, clearance and retirement. The authored totals below are available rosters, not a promise that every player must defeat every contact before leaving a space.

| Zone | Finite contacts | Maximum alive | Composition and pacing |
| --- | ---: | ---: | --- |
| Apartment | 2 | 2 | One brawler and one bat carrier; the player begins empty-handed. |
| Neighbor | 4 | 2 | An opening melee pair, then a gunman and bat carrier. |
| Balcony | 6 | 2 | Three melee pairs staged along the terrace and gallery. |
| Stairwell | 8 | 2 | Four pairs assigned to successive landings. |
| Roof | 12 | 5 | Two opening sentries, followed by groups of four, three and three; at most one enforcer alive. |
| Scaffolding | 14 | 3 | Groups of three, four, three and four assigned to the four decks. |
| Street | 16 | 5 | Four finite groups across the block; at most one enforcer alive. |
| Bakery | 18 | 5 | Four groups across the shop and back room; also used by the protector finale. |

For the balcony, `EncounterRouteProgress` measures distance along the terrace/gallery centreline and never rewinds during a retreat. Stage gates keep forward contacts ahead of the player. Holding position allows a 4.5-second breather; advancing can stage the next pair after at least 1.25 seconds, while ordinary safe-spawn distance still applies. Gallery anchors alternate between z=0.62 and z=1.18. A perspective check also requires same-wave arrivals to differ by at least 0.4 m perpendicular to the viewing bearing and 0.04 radians; opposite sides of the player satisfy the separation rule. A checkpoint retry resets route and stage state. Fists do not produce a weapon pickup.

The balcony and stairs each assign the second authored entry of a pair to rear pressure. Stable `entryIndex` and simulation-only `waitedSeconds` survive deferred attempts. A blocked first entry must not starve a valid second entry. Balcony rear anchors must be on traversed ground; stair rear anchors belong to the lower landing of the current flight. Every actual rear arrival, including a forward slot the player has turned away from, is downgraded to fists against melee gear or an empty firearm and at most a bat against a firearm with loaded or reserve rounds. The authored contact budget and live cap are unchanged; the authored weapon composition is a template, not a guaranteed drop roster.

Rear slots require the full 0.48 m radius, 2.02 m high spawn envelope to be outside the rendered camera view or concealed behind opaque structural boxes. A delayed forward fallback becomes eligible after 1.5 seconds on the balcony or 4.5 seconds on stairs, but it must still be concealed and pass all ordinary placement checks. One solid box must block all nine rays to the body corners and centre; rays hitting different slats cannot prove that the gaps between them hide the body. Hidden parents, masked or transparent materials and collision-only screens are not cover. No valid candidate means deferral, never an unchecked spawn. Successful arrivals get one copied investigation target and at least one second before attacks can begin. Their type, entry metadata and count are committed only after pool acquisition succeeds.

`selectSafeSpawn` enforces floor support, height tolerance, capsule clearance, distance from the player, and spacing from living enemies. A rejected candidate returns `null`; the director retries the pending enemy later. Never turn a failed safety check into an unchecked fallback spawn. This is especially important for stacked stairwell and scaffolding surfaces.

Ordinary groups wait for the previous group to clear before the recovery interval and next stage. The roof deliberately differs: both opening sentries must spawn and be defeated before reserves activate. After a 1.75-second delay, later groups may overlap living survivors, with 4.5 seconds between reserve groups. Pending contacts, the total live cap and the enforcer cap still apply. No encounter repeats its final group indefinitely.

Stairs and scaffolding gate groups by the player's foot height. Continuing above a stair landing retires only its unspawned contacts: existing stair enemies remain alive, can pursue the player, and retain their slots under the two-enemy cap until defeated. Stair departure requires grounded progress, so jumping on a landing cannot erase its encounter. Dropping below an irreversible scaffold platform can retire its living and unspawned contacts; removed actors grant no kills, drops or recovery reward. The scheduler records skipped contacts separately from defeated ones and does not declare a wholly unspawned encounter cleared. Retry resets this state.

A checkpoint contains a zone, an authored anchor, the weapon/ammunition snapshot, the ammo-cache ledger, and an optional final branch. Restore validates the anchor, clears transient enemies and drops, resets the director and ending state, restores player/loadout/supplies, and re-enters the correct encounter. It is an in-memory session checkpoint, not a disk save or an exact replay of every world object.

Three floor ammo boxes are declared in `AMMO_SUPPLY_CACHES`: `balcony-reserve`, `roof-west-reserve`, and `roof-east-reserve`. Each owns an independent 120-unit budget shared across firearm types. A round costs 5 units for a pistol, 20 for a shotgun, 4 for an SMG, or 3 for a machine gun. A box adds only accepted reserve rounds, with per-type reserve limits, and neither equips a weapon nor fills a magazine. Full reserves and melee weapons consume nothing. Collection requires an active session, the correct floor, range and a clear line to a target just above the case handle. That target allows access from clear sides without the case blocking its own interaction. Boxes remain visible with their colliders in every zone; zone state gates interaction only. `Weapons.findNearestPickup` arbitrates drops and boxes so one E press collects one object. A full campaign reset restores every box; an ordinary retry restores the complete saved ledger together with the exact weapon inventory.

Ammo-box positions are floor origins, not mesh centres. Each low olive case rests on two rails, has a lid, handle and latches, and labels its lid and front with AMMO. Static parts are instanced by shared geometry/material for five meshes per box and no added lights. Register each box as bearing on its actual deck, and validate the gallery lane, rooftop route, authored enemy spawn pockets and declared approach point against its full visible collider bounds when adding or moving supplies.

Normal checkpoint retries preserve one-way gates behind the player. A full development reset calls `Triggers.reset()` first: trigger flags clear and authored reset hooks disable their cached fire, smoke, debris and colliders. Reentry reuses those objects. `Colliders.setEnabled` only accepts registered boxes, and an inactive fire keeps its light source at zero intensity rather than allocating a new light on every replay.

The street choice commits by entering an arena at street height. Committing a branch stops ordinary waves and saves a checkpoint for that branch. Crossing another trigger afterward must not cancel its enemies, timer, or objective. The car finale has eight bodyguards in two groups and also requires reaching the car after they are defeated. The bakery finale uses its eighteen-contact roster and a 180-second deadline. Both wait for all authored groups, including pending and unstarted contacts; clearing only the opening group cannot win. The bakery deadline advances on simulation time and therefore stops during pause.

## Enemy navigation and perception

`EnemyNavigationPlanner` builds spatial buckets from the active collision list and lazily caches walkable cells and edges on floor layers. It uses a 0.7 m grid and incremental A* with a shared limit of 96 expansions per slice, no more often than every 1/30 second of simulation time. A search stops after 4,096 expansions; cached layers and replan frequency are also bounded. These are work limits, not a frame-rate guarantee. Short support/clearance probes handle ordinary steps; detours are requested when a direct approach is blocked.

Changing `Colliders.revision` invalidates cached geometry and routes. Disabling a one-way gate must therefore use the collider API, not mutate the list behind the planner. Removing or recycling an enemy cancels its pending route as well as its attack. Paths own a copy of the observed goal. Investigation can allow more time for a detour, up to twelve seconds, but it cannot reveal the player's new unseen position or refresh its own observation by replanning.

Stair pursuers additionally follow the shared `STAIRS` route, split at the actual flight ends. Their waypoints cross between lanes only on the end landings and lead through the real tower doorways. Elevation participates in route projection, so a target on the floor above does not become a target directly underneath it. Melee enemies on stairs keep climbing until within attack height. The same bounded observation memory applies; waypoints never query an unseen player's new position. Ordinary spawns retain their previous attack timing, while primed rear arrivals alone receive the grace period.

This is a bounded grid planner, not a navmesh, a general multi-storey navigation system or a full crowd solver. Stacked floors, curbs, furniture corners, sightlines and movement integration still need actual actor tests and silent play after layout changes. Unit coverage of the planner alone cannot establish that an NPC reaches a target in the full scene.

## Player contact and pickup rules

`WEAPON_DEFS` supplies melee duration and contact phase as well as damage, range and cooldown. Fists contact at 140 ms, the bat at 250 ms, and the knife at 130 ms. `beginMelee` records an owner/type and starts the windup without storing an enemy. At the single contact event, `Weapons` queries the current camera direction, reach and world occlusion, choosing at most one nearest target from a narrow ray fan. A target leaving reach or moving behind cover during windup cannot receive a cached hit. Pause stops this simulation timeline; equip, drop, restore, death and a valid firearm reload cancel it.

A successful contact briefly holds only the held pose, not the simulation or input. Essential melee travel remains visible under reduced motion; movement bob is removed. Damage, cooldown, range and ammunition tuning stay separate from pose code. New melee animations must peak at the authored contact phase rather than applying damage on button press.

`ThreatFeedback` checks actual windups, firing bursts and recent damaging actors against the rendered camera after weapon aim updates its FOV. `offscreen-threats.js` tests the entire body against the yaw/pitch/FOV/aspect/zoom frustum; a partly visible body is not called offscreen. Amber windup warnings and red hit warnings identify direction without audio. The newest unseen hit takes priority; otherwise the nearest unseen attack is shown, with a unique-source count. Hit history retains up to eight live actor references for 1.1 seconds of simulation, not wall time. Seeing the actor acknowledges the hit, preventing it from reappearing on a later turn away. Removed/dead sources, player death, checkpoint restore and completed play clear feedback. Pause freezes its time. The HUD owns only presentation and cached DOM writes, not threat selection or timers.

`placeWeaponDrop` tries a bounded set of rotations and offsets within 20 cm, computes real mesh bounds, and checks supporting floor corners and blocking solids. Random yaw is preserved when it fits; exact world axes let long weapons rest across narrow treads. Pickups lie on their side instead of balancing on a grip or clipping through the floor. An unsupported fallback reports `settled: false`; this is static placement, not a falling rigid-body simulation.

## Rendering and resource budgets

`createLightBudget` snapshots authored point lights after world, environment, effects, weapons, and pickup lights exist. It exposes a constant pool of **eight point lights** to the renderer, choosing relevant sources by active zone, distance, and intensity. Authored lights act as data sources; their visibility is disabled during selection. Ambient/hemisphere light and the single shadow-casting directional light are separate from this budget.

Create new practical-light sources before the budget is constructed, or pass them to the idempotent `lightBudget.register(light)` method. Progression fire gates register their sources before rendering. Adding arbitrary point lights during play can bypass the budget and change shader variants. Animate/reuse existing sources instead. `fitWorldShadow` fits the single directional light's 2048 × 2048 shadow map to the expanded roof/district bounds. The performance quality setting disables shadows; automatic quality adjusts resolution with hysteresis. These controls manage cost, but do not promise a frame rate on every GPU.

Enemy rigs are prebuilt per archetype and reused. Capacity is derived from normal/final rosters, live caps and type caps, with a corpse reserve, so overlapping waves are considered rather than just the largest single group. Releasing a rig invalidates its old owner before another enemy can acquire it. Corpses expire and are capped; they must not hold pool slots forever or keep a delayed attack alive. Shared humanoid/car/building primitives avoid repeated geometry construction. `pushDecor` and `flushDecor` merge static decoration per material, while `environment.js` instances repeated surroundings. Decorative meshes must not silently become collision or cover.

Deaths use a 0.52-second authored collapse with local yaw/pitch ordering, relaxed limbs and cached mesh bounds. Balcony bounds keep bodies inside the narrow gallery and its end caps; settled bodies reuse their final offset without rescanning joints each frame. This is a bounded pose transition rather than a physical ragdoll system. Pool reset clears collapse state as well as the live attack pose.

The world renders on layer 0, then `renderWithViewModel` clears only depth and draws camera-held meshes on layer 1. Its optional fourth argument supplies the world render callback. Weapon materials retain depth tests and writes, so parts hide one another without clipping through nearby world geometry. Lights are shared with both layers. The weapon pass does not repaint the sky or regenerate shadows; renderer statistics include both passes, and temporary render state is restored even if rendering fails.

`main.js` wires this callback to `createWorldPresentation`. On auto/high quality with supported floating-point render targets, one world geometry draw supplies color and depth. GTAO reconstructs normals from that depth instead of drawing a separate normal scene, computes contact shading at half the drawing-buffer width and height, and denoises/composites it before `OutputPass` applies the final tone/color conversion. Auto uses eight AO samples; high uses twelve. The first-person layer is drawn afterward and does not receive world AO.

Performance quality bypasses this path and creates no presentation targets; changing to it releases existing presentation resources. Unsupported floating-point targets also use the direct world render. Auto bypasses AO when adaptive pixel ratio drops below one, keeping existing resources to avoid repeated allocation at that boundary. The module reports its current state through `snapshot()` and restores renderer state after rendering. Added full-screen passes still have a GPU cost; their existence does not establish better performance or visual quality.

`first-person-hands.js` builds two procedural hands with shaped palms, articulated fingers and thumbs, cuffs and forearms. Shared geometry and instanced finger parts replace the former block-shaped fists. Alternating jabs, guard and movement sway are functions of simulation state; reduced motion removes bob while retaining contact travel. The same hand primitives form the bat's two-handed grip. These modules own presentation, while `weapons.js` retains attack acceptance, damage, range and cooldown ownership. This is procedural anatomy and animation, not scanned actors or motion capture.

`bat-asset.js` supplies one 0.84 m bat with a narrow handle, turned knob, tapered barrel and matte wrapped grip. NPC, first-person and dropped versions reuse its geometry and material maps at unit scale. Its grip and tip anchors are separate from scaled limb meshes. The first-person guard is upright beside the right shoulder with a backward lean; windup draws it farther back before a forward strike. `first-person-bat.js` uses continuous position/direction interpolation through contact, then follows through and recovers to the raised guard. Reticle/near-plane geometry tests cover both 4:3 and 16:9 at fields of view from 70 to 100 degrees. At 70°, the very tip intentionally extends above the frame while the barrel and grips remain visible.

NPC heads include shaped eye sockets, brows, cheeks, nose, jaw and ears; garments and hands add silhouette detail through shared geometry. Body mesh counts remain bounded, and animated head hit bounds contain the visible facial geometry. Both relaxed and alert bat guards hold the barrel raised and back rather than pointing it at the player. Attacks transfer weight through the pelvis and torso while the two hands retain their grip. Reset must clear these pose offsets, including when a pooled actor is reused after a collapse.

Each ranged view model authors its barrel tip in local coordinates. Muzzle effects transform that point through the weapon, hand and camera hierarchy, so they follow hip-fire and aiming poses. Hitscan uses the camera ray as the reticle's aiming reference.

Blood particles, muzzle flashes, tracers and impact effects use bounded reusable slots. Preserve these ownership rules when extending them. Do not dispose a shared material or geometry when removing one enemy or prop. The entire world is currently retained until reload; there is no streaming level loader or complete scene teardown API.

`surface-detail.js` creates coordinated static color, normal and roughness/metalness data for concrete, wood, metal, asphalt, tar, roof metal, stone, rubber, gravel and tile. Lazy material construction performs this work once, outside the frame loop. `loadSurfaceTextures` loads local generated brick and plaster albedo, then derives restrained normal and roughness channels from a 512 × 512 sample of the same image. It clears the old bump map. Failed loads or derivation preserve the procedural material; replacing a shared map disposes only the superseded texture resources.

Every `MATS` entry declares `userData.surfaceKind` and `surfaceMeters`. `applyBoxWorldUV` uses that scale in both `addBox` and batched `pushDecor` unit boxes after their transforms, with texture repeat fixed at one across coordinated channels. Moving a material to a new primitive must preserve or deliberately author its UVs; the box helper does not automatically fix every cylinder, rig or instanced mesh. Environment and combat systems must not depend on remote media or runtime image generation. See the art-direction guide for source provenance and the remaining brick-repeat limitation.

## Add a zone

1. Define the space in the appropriate shared layout, then add a named builder in `world/zones/` using construction helpers and `MATS`. Register actual walkable surfaces and obstacles with `Colliders`; keep purely decorative work non-colliding. Structural IDs should declare real supporting elements, and furniture should leave a clear route around it.
2. Register the builder through `buildZone` in `buildWorld`, so its world children and lights receive zone ownership. Define its trigger and objective, and update adjacent-light visibility for real sightlines. The full world is built at boot; this is not an on-demand loader.
3. Add its position in `ZONE_ORDER`, a safe foot anchor in `CHECKPOINTS`, and finite waves/spawn candidates in `ZONE_WAVE_CONFIG`. Author stage gates, live/type caps and any deliberate reinforcement or departure policy. If it belongs to a new ending, update branch validation and explicit reset/restore paths as well.
4. Add navigation targets and original captions in `game/navigation.js`. Stair or drop targets must account for foot height, not just horizontal proximity. Health/armor pickups are authored in `initMission`; floor ammo boxes are declared in `ammo-supply-rules.js` and initialized once before the first mission checkpoint.
5. Extend mission-data, builder, collision and NPC-route tests. Check actual geometry, not only a second copy of its coordinates; navigation caches must observe collider revisions. In silent development QA, inspect checkpoint support and clearance, travel the route normally, clear or intentionally bypass staged contacts, die/restart, and check neighboring sightlines. Record observed results separately from implementation notes.

## Add a weapon

1. Add its tuning to `WEAPON_DEFS`: attack kind, damage, range and cadence. Melee weapons need `attackDuration`, `contactPhase` and `contactArc`; ranged weapons need magazine, reload, spread, pellet and recoil values. `full: true` requests held automatic fire.
2. Implement or reuse one canonical weapon asset for the view model, world pickup and enemy attachment where applicable. Keep material and geometry ownership compatible with the existing pools and test actual pickup bounds on floors and stairs.
3. Extend snapshot/reload rules only where the new behavior requires it. Preserve ammo across checkpoints, handle empty magazines and zero reserve, and make pickup/drop behavior explicit.
4. If adding a sound, route it through `Audio` with its early silent check. Do not construct an audio context or node in weapon code. Add unit coverage for new balance rules and silent lifecycle behavior, then test firing/reload/pickup/restart through a muted session.

## Add an enemy

1. Add an archetype to `ENEMY_TYPES` in `enemies.js`, separating visual proportions/colors from health, movement, perception, attack tuning and weapon drops. The current archetypes are thug, brawler, gunman, bruiser, hitman and enforcer.
2. Reuse `makeHumanoid` or deliberately extend its rig contract. `root.userData.rig` exposes joints, anchors, dimensions, body meshes, pose state and reset. Use `updateHumanoidPose` and `resetHumanoidPose`; never parent a weapon to a scaled limb mesh. Grip and muzzle anchors use world-metre dimensions, and head hit bounds follow the articulated head. Ensure `EnemyPool` can preallocate enough slots for normal waves and both final squads. Shared geometry and appearance materials must not be disposed when a single actor is released.
3. Put reusable damage, visibility-memory, attack-windup or melee-validation rules in `combat-rules.js`. A lost line of sight must not reveal a player's unseen position. Interrupted or released enemies must not finish an old attack.
4. Add the archetype to a finite authored encounter and test spawn deferral, death, corpse retirement, pool reuse and checkpoint clearing. Check its body dimensions against navigation clearance and verify the derived pool capacity under overlapping reserves and finals. Test the readable attack cue, line of sight and actual movement in silent browser play; unit rules alone cannot prove those qualities.

## Verification boundaries

`npm run check` runs lint, Node tests and a production build. The suite includes pure rule tests and geometry/actor fixtures for collision, authored rooms and stairs, navigation, encounter schedules, material data, hand poses and pooled ownership. Builder fixtures inject scene services and use Three.js math without starting a renderer or audio. These checks do not by themselves establish full browser route completion, visual quality, controller hardware compatibility or sustained performance.

For browser work, use `?qa=1&mute=1` with the development server. QA installation is gated by `import.meta.env.DEV`; production builds omit that inspection interface. The audio hard lock also applies to `?mute=1` in production and cannot be undone from the menu. Muted sound calls and resume operations do not create a Web Audio context, nodes, or sample buffers; normal audio initialization is lazy and requires explicit unmuting.

The paused NPC inspector uses actual pooled actors and production pose helpers, with type and pose selections. The held-weapon inspector changes only the visible pose of the real bat, fists or knife, with no active attack or damage. The separate balcony melee benchmark measures a disclosed controlled fixture, not a full campaign playthrough. It uses real attack/input/AI paths while replacing defeated contacts and restoring health to keep a bounded workload. Record those interventions alongside performance numbers.

Keep actual browser findings, device details, screenshots and measurements in a separate validation record. Historical scripts in `tools/legacy/`, pre-existing untracked root scripts, and `shots/` are preserved context, not maintained browser automation. Do not reuse their raw browser-launch commands as a substitute for the supported silent workflow.
