# Surface ownership review — 28 August 2026

Different materials were occupying the same plane, allowing depth-buffer roundoff to switch the visible texture as the camera moved. The earlier stair-doorway repair removed local overlaps but did not cover supporting wall caps beneath the rest of the building's floors, or wall bottoms sharing ceiling faces.

## Geometry changes

The world now finalizes registered static architecture after every zone and its surroundings have been built. A finish owns its visible horizontal surface over a support: roof tar over a brick wall cap, apartment flooring over masonry, and plaster ceilings over coincident wall bottoms. An explicit flush threshold owns its strip within the surrounding floor. Only covered fragments are removed; exposed brick edges, the lightwell, opposing bearing faces and intentional height differences remain.

In the complete eight-zone CPU fixture, **28 registered finish/support overlaps fall to zero**. The pass changes **16 faces across 11 meshes**, removing **33.42 m²** of redundant face area. The north roof wall retains its **0.5 m²** lightwell cap, and the south roof wall retains its **2.8 m²** exterior cap. These figures refer to indexed geometry, not overlapping bounding boxes.

Geometry is prepared once before rendering. Fragmentation adds a net **22 triangles**, with no added mesh, material, light or draw call from the ownership pass. The pass does not change collision objects, route geometry, structural support records, material/depth settings or shadow flags. No global polygon offset or rendering priority override is used. The world beauty and contact-shading passes consume the same resulting geometry.

Separate decorative intersections require physical repairs rather than ownership of a floor:

- Roof flashing is fitted outside the parapet masonry instead of sharing its exposed faces.
- The kitchen cabinet ends at the metal worktop underside rather than penetrating it by 5 mm.
- The terrace address plate clears both the timber and masonry underside planes, while retaining a supported mount.
- Bakery and parking signs have physical backing and clear printed faces.
- Scaffold cloth clears the outer metal couplers and is held by noncolliding clips.
- Bakery entrance casing meets the facade without overlapping the doorway reveals or narrowing the opening; fitted corner returns cover the fascia/ceiling ends.
- The gallery's exposed end and the annex/deck junction receive fitted edge covers rather than flush competing materials.

The original all-surface audit also finds buried construction contacts and unrelated decorative overlaps. Its total candidate count is not a count of visible defects, and this pass does not claim that every possible surface intersection in the scene has been eliminated.

## Verification

Automated checks read actual indexed triangles, compare exposed areas, cast rays from frontal and shallow angles, and move a capsule through the complete rebuilt roof doorway in both directions. They verify floor and ceiling ownership, both flush thresholds, the open lightwell, unchanged vertical faces, collision/support identity, shared geometry safety, UV continuity, normals, draw ranges and repeat-call stability. Unsupported or nonvisible owners are rejected rather than removing a face with no visible replacement.

`npm run check` passes: **549/549 unit tests**, ESLint and the production build. The built entry loads `main-CBs0pp5L.js` (871.12 kB; 249.18 kB gzip). The shared geometry pass's single CPU sample took about 10 ms during world construction; this is not a frame-rate measurement.

The rebuilt production page at `http://127.0.0.1:4175/?mute=1` was reloaded and its loaded script URL confirmed from the DOM. Begin Mission, the briefing, Enter Little Sicily, pause and resume worked. A gameplay screenshot was captured and inspected: the opening renders with fists, 100 health and **AUDIO LOCKED OFF**. The page was returned to the fresh start menu. This is a startup check, not rooftop visual approval or a campaign playthrough.

The development QA suite now contains **50 checks**, including two new read-only surface checks. The exact new QA helpers also pass in the CPU fixture, with controls that deliberately reintroduce overlaps, hide a finish or remove indices. The complete 50-check suite has **not** been run in the browser for this build.

The final check log, geometry report, production startup record and capture are in `artifacts/surface-ownership-review-2026-08-28/`. That folder is intentionally gitignored and available in this workspace, not guaranteed in a fresh clone.

Rendered roof inspection, shadow/light-leak review and new frame-rate measurements require the silent development QA page. The browser-control skill blocks the stale test tab's error-page URL; no alternate browser or access workaround is used. A user-opened `http://127.0.0.1:4173/?qa=1&mute=1` page is needed to finish those checks. CPU ray tests do not establish GPU pixel stability, shadow appearance or frame rate. Previous browser timings do not certify this build. All browser use remains audio locked; CPU tests do not connect to an audio device.
