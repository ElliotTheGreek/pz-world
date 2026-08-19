# Using the artwork: what was wrong and the tasks that fix it

## The finding that explains the screenshots

There are **two road renderers in this repository and the world is built by the wrong one.**

```
src/plan/roads.js        1,467 lines: curbs, sidewalk topology, grass fringes,
src/plan/roadside.js       intersections, lane lines, highway/rural/bridge
src/plan/index.js          cross-sections, street signs, lamps
        │
        └──▶ buildPlan()  ──▶  src/cli.js generate  ──▶  emit/worldgen.js
                                (the legacy runtime-worldgen mod route)

src/plan/surfaces.js     buildSurfaces(): one flat band of `road`, one square
        │                of `pavement`. No curb. No line. No junction.
        └──▶ src/emit/generate.js ──▶ emit/world.js ──▶ THE CELLS THE GAME LOADS
                                (`npm run world`, what the mod ships)
```

`generateWorld` never calls `buildPlan`. Every test in `test/curbs.test.js`,
`test/intersections.test.js`, `test/sidewalk-transitions.test.js`,
`test/highway-rendering.test.js`, `test/rural-road-rendering.test.js` and
`test/roadside.test.js` passes against code that writes nothing to disk.

Measured on the shipped Plattsburgh 2,500 m build (`tools/audit-tile-usage.mjs`):

```
                        before
street_curbs_01         15,105   — all of it inside extracted building prefabs
street_trafficlines_01       0   — no lane markings anywhere
blends_natural_01_21    11.4 M   grass variant 1 of 4
blends_natural_01_22     6.7 M   grass variant 2 of 4
blends_natural_01_16         0   grass variant 3 of 4  ← never selected
blends_natural_01_23         0   grass variant 4 of 4  ← never selected
```

The grass half has its own cause: `baseTile` in `src/plan/blends.js` selects a
variant with `Math.floor(fbm(x, y) * 4)`, and fBm's distribution is
0.354–0.673 with σ ≈ 0.02. Two of the four indices are unreachable and the two
that remain change every ~110 squares, which is why a whole screen is one
texture.

## Tasks

| # | Task | Files | State |
|---|---|---|---|
| 1 | Gap-free cross-section rasteriser; drop the O(bbox × segments) scans | `src/plan/polyline.js`, `src/plan/roads.js` | done |
| 2 | `planRoadworks()` — run the real road renderer for the authored route | `src/plan/roadworks.js` | done |
| 3 | Surfaces derived from the roadworks canvas, not a second naive band pass | `src/plan/surfaces.js` | done |
| 4 | `emitWorld` writes the canvas: base, overlay, furniture, signs | `src/emit/world.js`, `src/emit/generate.js` | done |
| 5 | Grass/ground variation: use all four variants, at a visible scale | `src/plan/blends.js`, `src/plan/surfaces.js` | done |
| 6 | Road wear in patches rather than a uniform 13 % speckle | `src/plan/decay.js` | done |
| 7 | In-game map and minimap: ship the name the game looks up | `tools/make-canvas.js`, `tools/build-world.js`, `mod-src/client/PZWorld_Map.lua` | done |
| 8 | Builder panel waits to be asked instead of opening at launch | `mod-src/client/PZWorld_Boot.lua` | done |
| 9 | Measurement: tile-usage audit, before/after, regression test | `tools/audit-tile-usage.mjs`, `test/authored-artwork.test.js` | done |
| 10 | Two east–west mappings pointed at north–south sprites; the verifier could not see it | `config/semantic-mappings.jsonc`, `src/catalogue/semantic-registry.js` | done |
| 11 | Red brick paviors were 27% of pavement; vanilla uses them on 1% | `config/semantic-mappings.jsonc` | done |
| 12 | Pavement two squares wide everywhere; vanilla's is one | `config/roads.jsonc` | done |
| 13 | Carriageway material shares remeasured inside the kerbs | `src/plan/decay.js` | done |
| 14 | Kerb squares sat on grass, so kerbside parking failed its paved test | `src/plan/roadworks.js`, `src/plan/surfaces.js` | done |
| 15 | Highway hard shoulder was tan gravel, and met itself in the median | `config/semantic-mappings.jsonc`, `src/plan/roadworks.js` | done |
| 16 | Centre line dashed; vanilla's is unbroken, and the dash broke off-axis | `config/roads.jsonc`, `src/plan/roads.js` | done |
| 17 | Zombie intensity stamped on buildings only, so no street had any | `src/emit/population.js`, `src/emit/lotpack.js`, `src/emit/world.js` | done |

## How each visual complaint maps to a task

| Screenshot | Cause | Task |
|---|---|---|
| road meets sidewalk with no curb | curb pass not in the emit path | 2, 4 |
| no lines on the road | marking pass not in the emit path | 2, 4 |
| flat grass everywhere | `baseTile` reaches 2 of 4 variants, patch scale 110 | 5 |
| road does not decay in patches | wear thresholds tuned against an un-normalised field | 6 |
| voxelised roads, no transitions | sidewalk/curb topology classifier not in the emit path | 2, 4 |
| highways look like streets | `paintHighway` not in the emit path | 2 |
| no four-way junction artwork | `renderIntersections` not in the emit path | 2 |
| no street signs | `planRoadsideFeatures` not in the emit path | 2 |
| roof tiles on the sidewalk | `road.sidewalk.concrete` gave red brick paviors 27% of the weight | 11 |
| sidewalk twice as big as it should be | `bands.sidewalk` was 2; vanilla's is 1 square 63% of the time | 12 |
| tan patchwork on town roads | material shares measured over driveways and aprons as well as carriageway | 13 |
| not many cars | kerb squares kept their land-cover surface, so kerbside stalls failed the paved test | 14 |
| the highway is not correct | tan gravel shoulders on each carriageway of a divided road met and filled the median | 15 |
| fewer zombies | every chunk outside a building footprint had intensity zero | 17 |

## Measured result

A 2,500 m Plattsburgh build, `npm run audit-tile-usage`, before and after:

```
                            before        after     vanilla Muldraugh
street_curbs_01             15,105      182,610     12.01% of road squares
street_trafficlines_01           0       44,110      7.36%
street_curbs_01_diag*            0        5,000      first use of either sheet
floors_exterior_tilesandstone  278,970  442,754     pavement, three variants not one
blends_natural_01_16             0    3,759,743     grass variant 3 of 4
blends_natural_01_23             0    3,761,375     grass variant 4 of 4
blends_street_01_80          2,642      154,079     asphalt variant 1 of 4
blends_street_01_87            831      152,159     asphalt variant 4 of 4
d_streetcracks_1            79,140       21,000     vanilla uses none at all
```

Grass variants now land at 25.0 / 25.0 / 25.0 / 25.0 %, against vanilla's measured
25.2 / 25.0 / 24.8 / 25.1.

Cost: the build went from 2 m 31 s to 5 m 39 s and from 451 MB to 472 MB.

### Second round, after the first in-game test

Six defects were reported from a walk through the built world. Each was
diagnosed by measuring Muldraugh rather than by adjusting until the screenshot
looked better, and the numbers moved as follows:

```
                              before        after     vanilla
pavement, red brick paviors    27.3%         1.2%        1.0%
pavement width                 2 sq          1 sq        1 sq (63%), 2 sq (13%)
carriageway Road_06/07/04   46/34/20     69/29/2     68.8/28.6/2.4  (inside the kerbs)
kerbside parking stalls        2,761        5,596       —
highway hard shoulder        gravel_54   asphalt_86   asphalt_86 (highway_NS_00)
centre line                  5 on/5 off  continuous   continuous
zombie intensity, roofed        8 / 16    1.03-1.30   0.99-1.45  (by roof coverage)
zombie intensity, outdoors        0.00        0.21    0.06 (over a map that is mostly forest)
populated chunks               28,111      64,796      —
```

The highway cross-section is not a guess: `highway_NS_00.lua`, vanilla's own
worldgen prefab, lays `blends_street_01_86` across all fifteen of its paved
columns and marks where the running lanes stop with a solid edge line. There is
no gravel shoulder in it at all.

## What is still open

- Runtime acceptance. Nothing here has been walked in game; see
  `docs/LIMITATIONS.md` §0 and the validation gate above it.
- Crossing artwork at junction mouths is identified by placement context rather than by
  looking at the sprite (`docs/LIMITATIONS.md` §16).
- Lane markings cover 4.2% of road squares against vanilla's 7.4% (§17).
- The zombie intensity byte is consumed by `PZPopMan64.dll` and its numeric
  meaning is not visible from Java, so "matches Muldraugh's distribution" is the
  strongest claim available without walking the world. `INTENSITY_SCALE` in
  `src/emit/population.js` is the dial if a generated town wants to be busier
  than Knox County.
