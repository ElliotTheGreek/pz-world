# Limitations

Stated rather than hidden. Each of these is real, most are measured, and the
ones that are guesses say so.

---

## Validation status for the upgraded asset pipeline

The automated evidence is current and reproducible with
`npm run benchmark-asset-pipeline`: five pinned real-world builds, zero curb/carriageway,
sidewalk/carriageway, or bridge-edge ownership conflicts, and zero gaps at Build 42's
256-square cell seams. The semantic registry validates 120 mappings and 119 referenced
assets with no errors or warnings. `npm run verify -- <mod>` parses all 6,400 cells of a
built world and `node tools/audit-cells.js` finds no structural problems in it.

Those numbers do **not** certify native runtime behavior. The upgraded pipeline still
requires a dated Build 42 run that traverses at least 20 chunk and two cell boundaries,
visually checks the documented urban/rural/highway/bridge route, and retains the
`PZWORLD_VALIDATION` console summary. Until that is performed, collision response,
blank/incorrect artwork, frame pacing, native stability, and live streaming are pending.
This is intentionally reported as an open manual gate rather than converted into an
unverifiable automated claim.

---

## 0. The road artwork existed and was not connected to the world

This is the largest defect the project has had, and it hid behind a green test suite for
as long as it existed.

`src/plan/roads.js` and `src/plan/roadside.js` are about 1,800 lines that know how to
draw a road: kerbs with corners and ends, pavement with grass feathering onto its outer
edge, lane lines, junction conflict areas, limited-access cross-sections, rural verges
and ditches, bridge decks and barriers, stop signs, street lamps. They were written
against `buildPlan`, which only the **legacy** worldgen emitter consumes. The route that
actually writes the cells a player loads — `emit/generate.js` — rasterised its own roads
as one flat band of tarmac with one square of pavement beside it, and called none of it.

Measured on a shipped 2,500 m Plattsburgh build with `npm run audit-tile-usage`:

```
                          before        after
street_curbs_01           15,105      182,610    (before: all inside building prefabs)
street_trafficlines_01         0       44,110
street_curbs_01_diag*          0        5,000     the diagonal sheets, first use ever
blends_natural_01_16           0    3,759,743     grass variant 3 of 4
blends_natural_01_23           0    3,761,375     grass variant 4 of 4
```

Every one of `test/curbs.test.js`, `test/intersections.test.js`,
`test/sidewalk-transitions.test.js`, `test/highway-rendering.test.js`,
`test/rural-road-rendering.test.js` and `test/roadside.test.js` passed throughout. They
assert against the `TileCanvas`, and nothing read the canvas.

`src/plan/roadworks.js` connects the two, and `test/authored-artwork.test.js` reads the
emitted `.lotpack` files back off disk so the same thing cannot happen quietly again.

**What this cost.** A 2,500 m build went from 2 m 31 s to 5 m 39 s and from 451 MB to
472 MB, because the world now carries about five times as many blend overlays
(0.184 per square against vanilla's measured 0.121) and 375,000 kerb, marking and sign
tiles that were not there before.

---

---

## 1. It has been played, and that is where the real bugs were

This entry used to say no generated map had ever been loaded. It has been now,
and the offline validation had missed four things — every one of which needed a
person standing in the world to see:

- **Buildings arrived with most of their walls gone.** Static modules do not
  layer; `genRandomSquare` keeps the first module covering a square and discards
  the rest, and an empty `Floor` in the winner paints bare ground. Road patches
  were emitted before buildings and ate a quarter of them. See
  [DEV_GUIDE §2.10](../DEV_GUIDE.md).
- **Pavements ran across the middle of junctions**, because each road laid its
  own carriageway, kerb and pavement in one pass, and the road painted second
  put paving over the first road's tarmac. 137,463 squares of it in one 2,500 m
  city.
- **The bands were dotted on any road not on an axis**, because they were point
  sampled along the unit normal instead of filled.
- **The map and the minimap were blank**, because Project Zomboid draws them
  from a vector file the mod did not ship and could not have shipped.

All four are fixed. The lesson is the one already in
[DEV_GUIDE §6](../DEV_GUIDE.md): a passing offline test is a hypothesis. What
remains unverified in-game is load time at full city scale (limitation 8) and
whether the biome greys produce the vegetation intended.

---

## 2. Buildings were one storey with no roof — fixed by changing route

This used to be the worst thing about the mod, and it was real: `PrefabStructure.<init>`
opens with

```java
this.categories = List.of("Floor", "FloorFurniture", "FloorOverlay", "Furniture");
```

Four categories, hard-coded, `dimensions` is `int[2]`, `StaticModule` has no z
field, and `genRandomSquare` calls `applyPrefab` with a literal `0` for the
level. There is no roof layer and no storey above to carry one.

**But that constrains the runtime worldgen route, not the game.** Authored map
cells hold 8 z-levels and up to 12 tiles a square, and `npm run world` writes
those — so a building now arrives whole: every storey, the roof, the ceilings,
the doors and windows, and the `RoomDef`s the loot system keys off.

The roofs were never missing from the corpus, only unread. A Muldraugh bungalow
whose room graph says `maxLevel = 0` carries `ceilings_01_0`, `roofs_02_80..83`
and `roofs_accents_01_18` at **level 1**; the old harvester read level 0 only
(`harvest.js:108`) and took its range from `RoomDef.level`, and a roof is not a
room. 45% of the corpus is multi-storey besides.

What this costs is in limitation 14: the world is written before the game starts
rather than while it loads.

---

## 3a. Vegetation and zombie population were switched off by two wrong numbers

Both were single values, both were wrong, and both are fixed and pinned by tests.

**Nothing grew, anywhere.** `BiomeMapConfig.lua` is the whole table, and grass was
being written as pixel **115** across the entire authored footprint — `townhouse`
planting in a `TownZone`. So a 5,632-square-wide area, town and countryside
alike, was one continuous town: no trees, no shrubs, no rocks, and the zombie
distribution smeared over 31 million squares instead of over the town. Light
grass and meadow were worse: pixel **64** carries no `biome` key at all and
grows nothing. Now the built-up mask picks — town stays 115, everything outside
is `primary_forest` (255) or `organic_forest` (243).

This works because `WorldGenChunk.genMapSquare` reads the biome entry for
authored squares too: it calls `getMapBiome` for both `biome()` and `ore()` and
plants through `doPending`, with a `getRocks()` branch beside it. The biome value
is the only lever, and it was set to the one that does nothing.

**The city had almost no zombies.** The lotheader's per-chunk `zombieIntensity`
array — 1,024 bytes, read only by native code through
`ZombiePopulationManager.n_loadChunk` — was **all zeros**, which means "no
zombies belong here" for every chunk in the world.

The first fix stamped a value on chunks containing a room and left the rest at
zero, which is the reading you get from counting Muldraugh one way:

```
chunks containing a room      45,147   mean 1.20
chunks containing no room  4,117,413   mean 0.06
```

That reading is wrong, and it took a second report of "there seem to be fewer
zombies" to find out why. Count the other way — over the 148,819 chunks that
carry *any* intensity — and **only about a fifth of them contain a room**. The
rest are streets, yards, car parks and the edge of the woods. Intensity is not a
building stamp; it is a field that decays outward from built-up land:

```
chunks with no room, by distance in chunks to the nearest roofed chunk
  1 chunk away      65,851   47.94% non-zero   mean 0.953
  2                 54,988   35.29%            mean 0.704
  3-4               96,054   22.15%            mean 0.442
  5-8              190,575   11.60%            mean 0.232
  9-12             190,161    6.33%            mean 0.124
  further        4,389,160    0.38%            mean 0.008

and inside built-up land it rises with how much of the chunk is roofed:
  0-25%  51.7% non-zero   25-50%  53.8%   50-75%  59.1%   75-100%  64.5%
```

Divide mean by non-zero rate in either table and every band lands on **2.0**. So
vanilla's field is one probability that decays with distance from buildings, and
a single fixed value distribution wherever it fires (1: 31.8%, 2: 48.9%, 3:
12.1%, 4: 5.0%, 5-10: 2.2%). Nothing in the whole map exceeds 10.

`src/emit/population.js` reproduces exactly that, and `CellGrid.applyPopulation`
lays it over the finished cells rather than stamping it per building — the decay
runs for twelve chunks and has to cross cell boundaries to work at all. The old
values of 8 and 16 are gone: they were outside anything vanilla writes, so they
were being handed to native code that has never seen them, and they could not
have helped anyway because the streets the player actually walks down were not in
the field at all. `INTENSITY_SCALE` is the dial, and it scales the probability
rather than the value so the byte stays in range.

---

## 3. Loot and zombie spawning do not follow room names

Project Zomboid distributes loot by room name and container type. Worldgen
prefabs carry no `RoomDef`, so a generated shop's shelves are not "a shop's
shelves" as far as the loot system is concerned.

Partially mitigated: prefabs keep their furniture, so containers exist, and the
biome map paints `TownZone` over built-up ground, which drives some spawning.
`WorldGenChunk` exposes `setRoomID` and `getWorldGenZoneAt`, so a route may
exist; it has not been explored.

The room names *are* preserved through extraction and rotation
(`Schematic#rooms`), so the data is ready when a mechanism is found.

---

## 4. Diagonal kerbs are used, and the cadence is inferred rather than measured

They used to be laid as one repeated sprite whatever direction the road ran, which is the
right artwork in at most one of the four diagonal directions — and then they were not laid
at all, because the pass that chose them never reached the world (limitation 0). A 2,500 m
Plattsburgh build now places about 5,000 of them across both sheets.

What remains a judgement rather than a measurement is the **order**. The diagonal curbs
appear in runs of six consecutive indices (0–5 and 40–45 in each of the two sheets) with
road on three or four sides, so they are a sequence laid along a 1:1 run rather than a
single edge tile. `selectCurbSequenceVariant` walks that run at `along / √2` and uses a
mirrored six-piece cadence — `0 1 3 2 4 5` forward, `0 2 3 1 5 4` on the opposite edge —
which is derived from vanilla adjacency evidence for the first four slots and extended to
six by symmetry. If a diagonal kerb reads as stepped rather than continuous in game, this
cadence is where to look.

Vanilla has no artwork for a road at 20° either, so a street on an arbitrary bearing is
still a staircase with axis-aligned kerbs on it. That is a property of the target.

---

## 5. The library is thin in the classes that matter most

Indexed from every shipped map (9,089 buildings — more than the old harvester's
7,879, because buildings straddling a cell boundary are no longer dropped):

```
5570 house    1419 garage   632 shed        397 office    313 farm
 213 retail    100 industrial  81 restaurant  80 grocery   51 warehouse
  41 bar        38 police      32 church      31 medical   31 gas_station
  29 apartment  28 education    3 civic
```

A city with three hospitals gets the same hospital three times. The fallback
chain in `src/plan/buildings.js` keeps the plot occupied by something plausible
rather than leaving a hole — a clinic standing in for a hospital is a smaller
untruth than a house standing in for one — but it is a mitigation, not a fix.

---

## 6. Extraction is lossy by construction

A vanilla square carries up to 12 tiles across 8 z-levels (measured on cell
51_7). A prefab square holds 4, on one level. `config/tile-layers.jsonc` decides
what survives.

In practice what is lost is grime overlays, secondary furniture and lighting.
What is kept is floors, walls, doors, windows and the furniture that holds loot.

---

## 7. `chunkdata_*.bin` is decoded, but the bits are turned off

The format is read out of `zombie.pot.POTChunkData` and confirmed by parsing all
4,065 Muldraugh files with no leftover bytes (`src/emit/chunkdata.js`,
DEV_GUIDE §2.10). The encoder computes real collision bits and is tested.

**`WRITE_COLLISION_BITS` is `false`.** The first authored world shipped with
real bits crashed a few seconds after the player started walking — no Java
exception, no stack trace, the log simply stopping mid-frame, which is the
signature of a native fault. This file is the only thing the generator writes
that native code reads: `MapCollisionData` hands each cell's path to
`PZPopMan64.dll`. That is a suspect, not a diagnosis, and turning the bits off
is the cheapest way to test it.

While off, cells ship the all-zero wilderness form, which tells the native
population layer that a street of houses is open unobstructed ground: off-screen
zombie distribution and coarse navigation ignore walls and water. Nothing on
screen changes.

One thing is still unknown either way: vanilla emits a chunk **type 5** that
`POTChunkData` never writes and whose meaning lives only in `PZPopMan64.dll`. We
do not write it, and we read it as "no bits".

---

## 8. Sizeable output

Burlington VT at a 900 m radius:

```
2,523 OSM buildings → 2,463 placed
3,825 distinct prefabs, 4,767 placements, 12.8 MB of Lua, 25 MB on disk
64 cells (biome map + empty lotheader/lotpack/chunkdata each)
```

Road patches dominate the prefab count — 2,304 of the 3,825. `ROAD_PATCH` in
`src/emit/worldgen.js` trades prefab count against prefab size; 32 is a guess
that has not been tuned against in-game load time. Patches are trimmed to their
used extent, which is worth about 19 % of the emitted Lua, because a diagonal
street crossing a 32 × 32 patch touches a few hundred of its 1,024 squares and
the rest would be written out as literal zeroes.

A whole mid-size city at 5 km would be roughly thirty times that, and whether
`WorldGenChunk.loadStaticModules` copes with ~150,000 modules is unknown.

**The module count is a per-square cost, not a load-time cost.**
`genRandomSquare` streams the entire `static_modules` list looking for the ones
covering the square, for every one of the 64 squares in every chunk the game
ever generates. Plattsburgh at 2,500 m comes to 16,774 modules — 4,896
buildings, 8,593 road patches, 3,285 land-cover rectangles — so a chunk costs
about a million predicate evaluations on the worldgen thread.

`tools/simulate.js` reports the figure. Two things hold it down: road patches are
cut on a 32-square lattice rather than per road segment, and biome blocks are
merged into runs and then stacked into rectangles. It has not been profiled
in-game.

---

## 9. Overpass is a shared free service, and returns whole ways

Requests are capped at a 12 km radius (`MAX_RADIUS_M` in `src/sources/osm.js`)
because a larger area simply times out. Responses are cached on disk keyed by
the query, so tuning a config file and regenerating does not re-ask.

A city beyond that radius needs the query splitting, which is not implemented.

`out geom` returns a way's **entire** geometry whenever any part of it falls in
the bounding box. One river or one interstate that merely clips a corner will
therefore arrive stretching tens of kilometres past the requested area. The
planner takes its extent from the *request*, not from the features, and clips
everything to it — a 900 m request that once produced a 9,431 × 28,327 world of
4,256 mostly-empty cells now produces 2,015 × 2,015 and 64. Roads are clipped
rather than dropped, with a vertex of slack, so an interstate crossing the map
is still drawn across it.

---

## 10. One tangent-plane projection, no terrain

The projection is a local tangent plane through the map centre. Error at 15 km
is under a metre — under one square — so nothing downstream can see it.

There is no elevation at all, because Project Zomboid has none: the game stacks
storeys and fakes hills with retaining walls. A city built on a steep hillside
comes out flat, and that is a property of the target, not of this code.

---

## 11. Spawn points are a single location

`spawnpoints.lua` puts every profession at the centre of the generated area.
Proper spawn regions want zones the worldgen route has no way to declare yet.

---

## 12. Buildings win over roads, and 8% of footprints are dropped

Placement centres a prototype on its footprint's centre. Two things then happen
that are worth stating plainly.

**A building beats a road.** Buildings are the first group in
`static_modules` and roads refuse to paint inside a placed footprint, so where
OSM has a building closer to the kerb than its prototype is wide, the pavement —
and if it is close enough, the carriageway — stops at the wall. The alternative
was a street running through somebody's kitchen.

**Overlapping footprints are dropped, not merged.** Two placements may not share
a square (see limitation 1), so the second one is discarded. On a 2,500 m
payload of Plattsburgh that is 410 of 5,306 footprints, about 8%: terraces
sharing a party wall, buildings mapped twice, and courtyards drawn as separate
ways, each made worse by snapping every footprint to its own axis-aligned box.

A denser city will lose more. The real fix is to shrink or re-fit the loser
rather than drop it, which needs a placement pass that can back-track.

---

## 13. The in-game map is a second rendering, and it is found by name

`M` and the minimap read `worldmap.xml.bin`, and `npm run world` writes it directly.

**The name has to exist before the game starts.** Both screens look the file up as
`fileExists('media/maps/PZWorld/worldmap.xml')`, and `fileExists` is
`new File(ZomboidFileSystem.getString(path)).exists()` — `getString` answers from
`activeFileMap`, a table built once while the mods are scanned, and returns its argument
unchanged when the key is missing, at which point the path is relative to the install
directory and of course does not exist. A file created minutes later is invisible by name
for the rest of the session, which is why a freshly built city had a blank map and a blank
minimap and then drew correctly on the *next* launch.

So the canvas ships the name: a stub `worldmap.xml` that exists to be found and never to
be read, and an empty `worldmap.xml.bin` beside it. `WorldMapDataAssetManager.startLoading`
prefers a `.bin` sibling whenever one is present, and the game's own XML reader is broken
(DEV_GUIDE §2.11) — it passes `WorldMapPoints.setPoints` a count of shorts where the binary
reader passes a count of points and throws `IndexOutOfBounds` on every feature — so the
stub must never be parsed. `npm run world` overwrites the `.bin` and leaves the stub alone,
and `tools/build-mod.js` copies any map companion the installed world does not already have
without touching one it does.

**A world built from inside the game is one launch behind.** If the stub was already
present when the session started, vanilla loaded the `.bin` as it was then, and rebuilding
mid-session does not reload it. `PZWorld_Map.lua` covers only the first-ever build, where
the name was genuinely absent at startup and an absolute path sidesteps `activeFileMap`.

It is a second rendering of the same source data, so it can disagree with the world: road
widths on the map are per class rather than per way, polylines are simplified to a 2-square
tolerance, and only the tags `ISMapDefinitions.lua` filters on draw anything — town ground,
farmland and grass have no map layer and are left blank.

Street names come from a separate `streets.xml`, generated the same way and found by the
same mechanism — 430 records for 277 named streets in Plattsburgh. They fade in at
zoom ≥ 13.5 and never appear on the minimap, which is vanilla behaviour: `ISMiniMap` does
not call `initDefaultStreetData` for any map, including Knox County.

---

## 14. Cars come from zones, and the zones are guessed at

Project Zomboid spawns vehicles only from `ParkingStall` zones, so the mod
plans its own: one every 44 squares along a built-up street, tucked against the
kerb on alternating sides, plus a grid inside every `amenity=parking` area.
About 4,000 for a 2,500 m city, against Muldraugh's 9,693 for a far larger map.

That spacing is a guess, not a measurement. Vanilla's stalls were placed by hand
where cars would actually be — outside a shop, in a driveway, jammed at a
junction — and this cannot tell a driveway from a verge.

Detached garages are mostly absent for a different reason: OpenStreetMap simply
does not tag them. Plattsburgh at 2,500 m yields 4,734 `building=house` and
**4** `building=garage`, so a suburb of houses arrives without the garage beside
each one. Nothing downstream can invent what the source does not record.

`src/emit/objects.js` writes them now. Vanilla's stall is one car — 3×5 or 5×3,
7,037 of Muldraugh's 9,693 — so that is the unit, and every candidate is checked
square by square against the surface grid and the building footprints so a car
never lands on grass or in a wall.

The kerbside *spacing* is now measured too, and the first value was badly wrong:
across Muldraugh's 9,693 stalls the mean distance from one to its nearest
neighbour is **12.5 squares**, and this was set to 44. Three and a half times too
sparse, which is why a generated city had almost no cars in it.

What remains a guess is *where* along a street, not how often. Vanilla's stalls
were placed by hand where a car would actually be — a driveway, a shop front, a
junction — and nothing here can tell a driveway from a verge.

---

## 15. Buildings are placed unrotated

`rotateBlock` is exact — `test/building.test.js` proves a building rotated four
times is the building it started as, tile for tile, on 626 real buildings. The
problem is not the algebra, it is that most artwork does not declare a facing to
rotate.

A wall does: the catalogue names its north/west counterpart, so walls turn
correctly. A **roof** carries `WestRoofT`, `WestRoofB` or `WestRoofM` and there
is no north equivalent anywhere in `tiledefinitions`. A **wall-mounted fixture**
— a light switch, a sign — carries no facing at all. Both were therefore carried
as plain content and moved without being re-faced, which is exactly what a
rotated building looked like in game: walls right, roof and switches 90° out.

Not rotating costs almost nothing, measured on the Plattsburgh footprint:

```
rotations allowed   footprints with no fit   mean waste
four                0                        108.2 squares
one                 0                        117.3 squares
```

Every footprint still finds a building and the fit is 8% looser. What is lost is
variety: a street of similar plots draws from a shortlist of similar buildings
rather than four times as many. Lifting it needs a measured rotation table for
the roof and fixture sheets, derived from the shipped maps the same way the kerb
facings and the blend layout were. `MAX_TURNS` in `src/plan/place.js`.

---

## 16. Two line sprites are identified by context, not by looking at them

There is no way to see a sprite from here, so which of `street_trafficlines_01`'s 64 tiles
is a centre line, a lane divider or a stop bar is inferred from where vanilla places them.
Three choices rest on that inference and each is one line of
`config/semantic-mappings.jsonc` to change:

| mapping | tiles | evidence |
|---|---|---|
| `road.marking.centre` | `_4` / `_6` | 50,253 and 40,572 placements, both dominated by the middle of a straight |
| `road.highway.marking` | `_20` / `_22` | the busiest pair in the shipped maps, 44,134 and 58,065, almost entirely on-road |
| `road.marking.junction` | `_34` / `_32` | the only pair whose context is dominated by junctions — 903 cross and 705 corner placements out of 4,616 |

The orientations are measured and now enforced: `npm run verify-semantic-registry` fails
if a mapping declares a run direction the inventory contradicts at high confidence. What
is *not* verifiable offline is whether a stop bar is a stop bar. If a junction mouth reads
wrong in game, `road.marking.junction` is the mapping to remove.

---

## 17. Lane markings cover less road than vanilla

Vanilla's town roads carry a `street_trafficlines_01` tile on 7.4% of their squares. A
generated city reaches about 3.2%, because only the arterial and collector hierarchies are
marked — the same list the rural renderer uses — and a US residential street genuinely has
no centre line. The rest of vanilla's 7.4% is crossings, stop bars, parking bay lines and
arrows, of which only the stop bar is currently drawn.

`markedHierarchies` in `config/roads.jsonc` is the dial if that reads as too plain.
