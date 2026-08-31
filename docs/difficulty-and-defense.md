# Difficulty and tower defense

## Implementation plan and behavior

1. Require a difficulty selection before the initial briefing. Store difficulty, mode, arena and wave count separately from saved presentation preferences. Lock that snapshot on confirmation and retain it through pauses, campaign checkpoints and defense retries. A new run requires a fresh selection.
2. Derive difficulty encounters from immutable mission data. Change enemy counts, the mix of already available weapons, recovery time, damage and supplies while retaining the authored stage gates, spawn anchors and first weapon appearances.
3. Run health regeneration on the gameplay clock below Average. Record player attacks and credited results by weapon, and show the selected difficulty and those results on the victory screen.
4. Reuse the finite encounter scheduler for rooftop or street defense. Require every wave to clear, issue one adaptive supply budget for the next wave, and win after the selected 10, 20, 50 or 100 waves.

The implementation separates pure rules (`difficulty.js`, `run-settings.js`, `defense-rules.js`, `health-regeneration.js`, `combat-stats.js`) from mission, input, HUD and pickup integration. Average returns the original campaign encounter object, preserving its exact authored roster and timing values.

## Balance factors

Multipliers apply to existing values. Enemy counts round to whole contacts and retain required introductions. The weapon pressure offset favors weaker or stronger enemy types already available in that wave; it is not an unlock adjustment.

| Factor | Very easy | Easy | Average | Hard | Very hard |
| --- | ---: | ---: | ---: | ---: | ---: |
| Enemy count | 0.65× | 0.8× | 1× | 1.2× | 1.4× |
| Enemy weapon pressure | −2 | −1 | 0 | +1 | +2 |
| Time between waves | 1.5× | 1.25× | 1× | 0.85× | 0.7× |
| Player weapon damage | 1.35× | 1.15× | 1× | 0.95× | 0.9× |
| Enemy attack damage | 0.55× | 0.75× | 1× | 1.2× | 1.45× |
| Ammo availability | 1.6× | 1.3× | 1× | 0.85× | 0.7× |
| Health supplies | 1.5× | 1.25× | 1× | 0.8× | 0.6× |
| Armor strength | 1.5× | 1.25× | 1× | 0.85× | 0.7× |
| Duplicate weapon drop rate | 100% | 100% | 100% | 82% | 65% |
| Automatic healing | 5 HP/s | 2 HP/s | None | None | None |
| Damage-free delay before healing | 3 s | 5 s | — | — | — |

Regeneration stops at 100 HP; damage restarts its delay, even when armor absorbs the hit. Pause, death and the victory screen stop gameplay time. Fire retains its authored 20 HP/s hazard damage and bypasses armor on every difficulty.

Weapon drops use deterministic spacing for duplicate carriers. The first copy of each weapon is guaranteed on every difficulty, and checkpoint retries restore the drop ledger with the checkpoint. Ammo caches and dropped ammunition scale independently of weapon unlocks. Armor retains its headshot/body-hit condition, then applies the selected multiplier and the 100% cap. Health and ammo remain finite pickups.

Across the eight campaign zone rosters, totals are **65 / 68 / 82 / 97 / 111 contacts** from Very easy through Very hard. Small geometry-sensitive encounters keep their required structure: the balcony retains three front pairs and its authored rear slots, the stairs retain front/rear indices, and the rooftop opens with the same two sentries. Campaign live caps, the rooftop's single machine-gun carrier, stage boundaries and spawn safety checks remain intact. Larger rosters queue behind those caps. Difficulty never moves a first weapon appearance forward or removes its introducing carrier; it also never exceeds an individual authored wave's weapon ceiling.

## Existing weapon strengths

These are the base values from `weapon-data.js`, before hit-location and difficulty multipliers. Difficulty applies one common outgoing multiplier, preserving each weapon's relative damage, pellet count, reach and firing cadence.

| Weapon | Base damage | Pellets per attack | Range | Attack interval |
| --- | ---: | ---: | ---: | ---: |
| Fists | 28 | — | 2 m | 0.34 s |
| Bat | 55 | — | 2.6 m | 0.55 s |
| Knife | 42 | — | 1.9 m | 0.28 s |
| Pistol | 24 | 1 | 80 m | 0.18 s |
| Shotgun | 12 per pellet; up to 96 total | 8 | 35 m | 0.85 s |
| SMG | 13 | 1 | 60 m | 0.075 s |
| Machine gun | 19 | 1 | 110 m | 0.095 s |

The shotgun's damage depends on how many pellets connect. The SMG and machine gun trade individual bullet damage against automatic fire and ammunition use. The knife remains defined for the existing weapon system; this change does not introduce a new campaign knife source.

## Defense progression and supplies

Both arenas support **10, 20, 50 or 100 waves**, with one difficulty fixed for the entire defense. Enemy budgets grow as the wave number rises; stronger unlocked types become more common. Each wave is finite, and the next wave waits for all pending and living contacts to be defeated. The selected difficulty sets the break duration and live budget, with at most six enemies active. Leaving the arena returns the player to their last safe grounded position.

Weapon unlocks follow absolute campaign wave numbers at every duration and difficulty:

| First wave | Available weapons | Campaign source |
| ---: | --- | --- |
| 1 | Fists, bat | Apartment |
| 3 | Pistol | Neighbor, second wave |
| 9 | SMG | Stairwell, third wave |
| 12 | Shotgun, machine gun | Rooftop, second wave |

A ten-wave defense therefore ends with SMGs as its highest unlocked tier. Longer runs retain the same unlock timing.

The opening and each completed wave issue a finite supply budget for the next wave. It considers missing health, current armor, carried ammunition, recent damage taken, kills and firearm hit rate, then applies the difficulty factors. Newly unlocked weapons receive their first supply at the appropriate wave; later replacement firearms are less frequent on harder settings.

Supplies use nearby grounded positions with clearance, visibility and walking-path checks. Placement waits when the player is airborne or no safe nearby position exists. Each distribution has at most one ammo case, health pack and vest, plus any eligible weapons. Walk over resource cases to collect them; dropped weapons still require the usual pickup action. A case is consumed once, unclaimed field supplies expire at the next restock, and revisiting a wave cannot request another budget. The system does not accumulate an unlimited stockpile.

Death restarts defense from wave 1 with fists, full health, no armor and fresh attempt statistics. Difficulty, arena and the wave target remain locked. Campaign death retains checkpoint behavior and restores credited statistics to that checkpoint.

## Victory statistics

The end screen displays difficulty and mode, plus completed/target waves for defense. Every weapon has attacks, hits, hit percentage, kills, headshot kills and damage dealt.

- **Favorite weapon:** most recorded attacks; kills break ties, then the stable weapon-data order. No attacks displays “No weapon used.”
- **Weapon hit percentage:** successful attacks divided by attacks. One firearm trigger pull or resolved melee swing counts once. Any connecting shotgun pellet makes that blast a single successful attack, so accuracy cannot exceed 100%. Canceled melee windups do not count.
- **Overall firearm hit percentage:** successful firearm trigger pulls divided by firearm shots; melee has its own weapon rows.
- **Damage dealt:** health actually removed from enemies, capped at remaining health to avoid overkill inflation. Kills are attributed to the weapon that caused them, including melee while carrying a firearm. Headshot counts are headshot kills.
- **Retries:** campaign snapshots restore credited results; a defense retry starts a fresh attempt. Unused weapons display zero counts and a dash for hit percentage.

## Validation

- `npm run check`: ESLint, all 1,684 unit/integration tests, and the production build pass. Vite retains the existing large-bundle advisory.
- Silent browser checks covered required selection, Easy rooftop defense startup, locked pause settings, and the setup/results layouts at 1280 × 720 and 390 × 844. The mobile weapon table scrolls within the page without horizontal page overflow.
- The visible **Run defense regression** QA action completed real scene simulation for both rooftop and street on Average: 10/10 waves, 32 enemy arrivals, and ten finite supply distributions per arena. These checks used scripted defeats through the actual damage/death path, completing in 61.1 and 61.2 simulated seconds respectively; they are not human playthroughs or performance measurements.
- Pure and runtime tests cover all four wave targets through 100 waves, every difficulty, exact campaign weapon first appearances, queued enemies and final-contact victory, checkpoint rollback, regeneration, controller-only setup, supply deferral/anti-duplication, and defense pursuit without attacks through cover.
- **Inspect defense results** displays an explicitly labeled sample using the real statistics recorder and victory UI. This preview is a layout fixture, not an earned result. Both QA controls require the development build with `qa=1&mute=1` and are absent from production.

The balance factors are an initial tuning pass. Extended human play and hardware performance benchmarking were not part of this validation.
