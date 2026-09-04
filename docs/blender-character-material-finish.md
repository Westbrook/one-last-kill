# Gunman material response — September 4, 2026

The gunman's saved Blender source now distinguishes woven shirt, trousers, boot leather, rubber soles and skin regions in the existing roughness atlases. This corrects a material response gap: the sculpted gunman uses its baked roughness directly, bypassing the older vertex-region finish, while the previous bake assigned the same generic noise range to every garment material.

This is a **modest fidelity improvement**. The actual dim balcony review keeps the boots dark at ordinary distances; it does not produce a dramatic visual transformation. Skin response is also restrained. No new texture, sampler, material draw, light, runtime shader or geometry is introduced. The face albedo, hair/eye geometry and all accepted tangent normal maps remain unchanged.

## What is editable

`assets/blender/characters.blend` contains the accepted low meshes and dense `GUNMAN_SCULPT_MASTERS`. Each head/garment master has paintable grayscale `Finish_*` point color attributes. Its material graph contains labeled Value controls for base roughness and regional adjustments. Painting these attributes or adjusting those controls changes the next roughness bake.

Garment controls distinguish shirt from trousers, boot/belt leather, soles and buttons, with restrained cloth contact wear and toe polish. The head controls distinguish central forehead/nose, cheek, lip and ear response. Values are artistic estimates informed by the existing authored palette; they are not measured material properties. Anatomical/material masks were authored from the actual model. No generated image or inferred photographic illumination is used as roughness.

`tools/blender/character_material_finish.py` is the initializer and provenance for these masks. Running it again intentionally resets its masks/controls and stages a new candidate. Routine artist rebakes should use the preserving commands below instead.

## Source-to-game workflow

Export saved geometry and all four packed PNGs to a clean staging directory:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-characters.py -- --export-only --source assets/blender/characters.blend --output /tmp/character-export
```

Rebake only edited material response, preserving the exact packed normal maps:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build-characters.py -- --bake-only --roughness-only --source assets/blender/characters.blend --output /tmp/character-export
```

This command saves the updated packed roughness back into the specified source. To review changes without changing the accepted source, copy the `.blend` and pass that copy to `--source`. If sculpt geometry changes, use `--bake-only` without `--roughness-only` so the normal map reflects the edited geometry.

The exporter now writes all four PNGs directly from the saved packed images. It rejects missing/unpacked images and incorrect size/color space; it does not silently rely on old delivery PNGs. The gunman's `finish.textures` manifest records include each file's actual byte length, SHA-256, 512-square dimensions and linear data color space. New bakes pack the exact saved PNG bytes into the `.blend`.

## Verified budgets and material values

The **entire 5,719,764-byte character catalog binary** is unchanged (SHA-256 `6c91a6532823fc1dfbdb61d9cd0b3a7a5bf6ba1112a943f8879eaf7f09d8a064`). That includes all eight roles, the gunman's 14,698 triangles, every UV, vertex color, normal attribute and binding weight. The two tangent-normal PNGs are also byte-identical. Four 512² normal/roughness maps, four character draws and 17 bones are retained.

The two roughness PNGs shrink from **427,848 to 170,040 bytes**, a reduction of **257,808 bytes (251.8 KiB)**. Their resolution and GPU texture allocation remain the same. The saved `.blend` grows from 35,735,165 to 40,753,632 bytes because its offline masters retain the editable masks and controls.

Actual decoded roughness samples, before → after:

| Region | Mean roughness | Reliable samples |
| --- | ---: | ---: |
| Woven shirt | 0.8695 → 0.8929 | 376 |
| Trousers | 0.8692 → 0.8425 | 282 |
| Boot leather | 0.8734 → 0.6408 | 10 |
| Rubber soles | 0.8692 → 0.9541 | 16 |
| Cheek | 0.6328 → 0.7135 | 51 |
| Nose | 0.6371 → 0.6016 | 13 |
| Central forehead | 0.6201 → 0.6186 | 13 |

These are triangle-centroid samples of the actual PNG green channel, bilinearly filtered using the runtime UV orientation. A reliable sample has at least 1.5 texels of clearance from every triangle UV edge. They establish response differences, not visual quality or physical calibration. Full distributions and all excluded samples remain in [the material validation report](../artifacts/blender-material-realism-2026-09-04/character-candidate/material-validation.json).

The existing atlas has **28 tiny garment triangle centroids with zero roughness before and after**; no new zero samples are introduced. None occur among reliable interiors, and no head centroid samples are zero. Small button triangles and the sparse painted belt lack sufficient reliable interior samples for a statistical material-separation claim. Their source masks are editable, but this pass does not claim that all tiny atlas islands are resolved perfectly.

## Validation

- Clean export and a separate saved-source roughness-only rebake both reproduce the binary, manifest and all four PNGs **byte-for-byte**: [roundtrip evidence](../artifacts/blender-material-realism-2026-09-04/character-candidate/roundtrip-validation.json).
- A preserving artist-edit check set head base roughness to 0.77 with other controls disabled. The actual 64-sample median was 0.7686; the saved material was used, the normal PNG remained exact, and the candidate source file was untouched: [edit validation](../artifacts/blender-material-realism-2026-09-04/character-candidate/material-edit-validation.log).
- The independent actual-PNG verifier passed 14 assertions, including material separation, unchanged binary/normals and no new reliable-interior holes. It reports all zero samples rather than excluding them silently.
- The scoped character suites passed **23/23 tests**, including three new package-integrity/material-response tests: [test output](../artifacts/blender-material-realism-2026-09-04/character-candidate/unit-tests.txt).
- The coordinated game review captured matched body, portrait, quarter, face and boot views and found no new seam or inappropriate gloss. Whole-game checks and timing belong to the root follow-up report; this source validation alone does not establish FPS.

The accepted input, candidate and exact authoring controls are preserved under `artifacts/blender-material-realism-2026-09-04/character-baseline` and `character-candidate`.
