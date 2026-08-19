# Architecture

## The shape of the problem

Project Zomboid B42 ships a **runtime world generator**. `zombie/iso/WorldGenerate`
runs a `WorldGenerateThread`, `zombie/iso/worldgen/ChunksCache` caches its
output, and what it generates from is *data a mod can supply*: Lua prefabs,
Lua static modules, and a PNG per cell. That single fact is why this project is
tractable, and it is what makes "the world assembles itself on first load"
literally true rather than a figure of speech.

The one thing that cannot happen in-game is the **download**. Project Zomboid's
Lua sandbox has no HTTP client and cannot write map data. So the split is:

```
    outside the game                        inside the game
 ┌──────────────────────┐              ┌──────────────────────┐
 │ fetch OpenStreetMap  │   a mod      │ WorldGenerateThread  │
 │ decide the plan      │ ──────────▶  │ reads the prefabs,   │
 │ write prefabs + PNGs │   folder     │ modules and biome    │
 └──────────────────────┘              │ maps and builds the  │
                                       │ world, chunk by chunk│
                                       └──────────────────────┘
```

## Pipeline

There are two of them, and only one ships. `npm run world` writes **authored map
cells** and is the whole world a player sees. `pz-world generate` writes the
older **runtime-worldgen** mod, which is bounded by what `PrefabStructure` can
express — four tile layers, one storey, no roof — and survives as a second
consumer of the same planner.

```
Overpass  (src/sources/osm.js)
   │  buildings, roads, land cover — cached on disk
   ▼
normalise  →  { kind, fid, points, tags, levels }
   │  fid is a hash of the geometry, never an OSM way id
   ▼
orientation solver  (src/geo/orient.js)
   │  one world bearing, chosen so the commonest street lands on an axis
   ▼
project  (src/geo/project.js)
   │  local tangent plane → world squares, north = −y
   │
   ├────────────── the authored route, `npm run world` ──────────────┐
   │                                                                 │
   │  emit/generate.js                                               │
   │    plan/place.js       footprint → OBB → snap → class → prefab   │
   │    plan/roadworks.js   runs plan/roads.js and plan/roadside.js:  │
   │                        carriageway, kerb, pavement with corners  │
   │                        and grass fringes, lane lines, junction   │
   │                        conflict areas, highway and rural cross-  │
   │                        sections, bridge decks, signs and lamps.  │
   │                        Returns a TileCanvas *and* a band per     │
   │                        square, so the next step cannot disagree  │
   │                        with what was painted.                    │
   │    plan/surfaces.js    one material per square, from those bands │
   │                        and from land cover                       │
   │    emit/world.js       buildings, ground, blends, road artwork,  │
   │                        vegetation, biome maps                    │
   │      emit/lotpack.js     lotheader + lotpack (8 levels)          │
   │      emit/chunkdata.js   chunkdata_*.bin                         │
   │      emit/worldmap.js    worldmap.xml.bin                        │
   │      emit/streets.js     streets.xml                             │
   │      emit/objects.js     objects.lua — ParkingStall zones        │
   │                                                                  │
   └────────────── the legacy route, `pz-world generate` ─────────────┘
      plan/index.js  buildPlan → PlacementPlan → emit/worldgen.js
   ▼
verify  (src/verify.js)  — re-read everything with the readers that wrote it
```

### The two routes were not connected, and that was the bug

`src/plan/roads.js` is 1,500 lines of kerb topology, sidewalk corners, junction
design and cross-section rendering, and for a long time **none of it reached the
world**. It was written against `buildPlan`, which only the legacy emitter
consumes; the authored route rasterised its own roads as one flat band of tarmac
with a square of pavement beside it. Every test passed. The shipped world had no
kerb, no lane line and no junction anywhere in it.

`src/plan/roadworks.js` is the join, and `test/authored-artwork.test.js` is what
stops it coming apart again: it generates a town, reads the emitted `.lotpack`
files back off disk, and fails if the kerb, marking or pavement families are
missing from them. A test that stops at the `TileCanvas` cannot see this class
of defect at all.

Order inside `plan` is not arbitrary. Buildings go first because everything
else needs to know where the town is: a sidewalk is drawn where there are
houses, not where a landuse polygon claims there ought to be. Ground goes last
so that roads and footprints can stamp `dirt` over whatever land cover said, and
worldgen does not grow a tree through a kitchen.

## Road hierarchy and cross-sections

`deriveRoadCrossSection` in `src/plan/roads.js` is the single boundary between a
retained OSM road and geometry consumed by renderers. It separates the existing
artwork class (`motorway`, `trunk`, `primary`, `secondary`, `residential`,
`service`, `track`, `footway`, or `cycleway`) from the functional hierarchy:

| OSM source | Functional hierarchy |
|---|---|
| `motorway`, `trunk`, and links | highway |
| `primary`, `secondary`, and links | arterial |
| `tertiary` and links | collector |
| `residential`, `living_street` | residential |
| `service` | service; `service=alley` becomes alley |
| `unclassified` | rural |
| `track` | track |
| `footway`, `path`, `pedestrian`, `cycleway`, `steps` | path |

The derived object records lane count and source, lane and core widths, surface and
source, one-way state, median, and independent left/right shoulder, cycleway, parking,
and sidewalk bands. Each facility records `presence`, width, surface where applicable,
and whether it came from a tagged width, tagged presence, hierarchy fallback, or
built-up-context (`implicit`) fallback. The rounded `width` remains compatible with
existing square-band renderers; the unrounded `coreWidth`, `carriagewayWidth`,
`explicitOuterWidth`, and `builtUpWidth` preserve geometry for later specialized road
passes. `projectAll` carries this object as `road.crossSection`, so downstream marking,
parking, furniture, and edge renderers do not reinterpret source tags independently.

OSM values take precedence in this order: total `lanes`, summed directional lane tags,
subtype/link defaults, then hierarchy lane defaults. A tagged `width` controls the road
core and derives lane width; metric values and feet are accepted. Directional
`*:left`, `*:right`, and `*:both` facilities override undirected tags. Explicit `no` or
`separate` suppresses a band. Physical divider/median tags create a median, but one-way
roads never receive an inferred median.

Sparse data is intentional rather than exceptional. `config/roads.jsonc` defines a
complete fallback cross-section for every hierarchy, including lane count/width,
surface, shoulders, sidewalks, cycleways, parking, and median. Highway defaults are
four lanes with shoulders and a median; urban arterial/collector/residential sidewalks
are marked `implicit` and therefore depend on built-up context; rural roads receive
shoulders but no inferred sidewalk; service/alley, track, and path profiles remain
narrow and do not invent roadside facilities. Link ways default to one lane and no
median. These rules keep sparse rural OSM from looking urban and sparse urban OSM from
collapsing to a path.

### Limited-access highway renderer

`paintHighway` is selected whenever the functional hierarchy is `highway`; motorway,
trunk, and their link ways therefore never enter the urban kerb/sidewalk pass. It
rasterizes an explicit lateral cross-section: planted median, asphalt carriageways,
independent shoulders, and soft verges. Half-square lateral coordinates keep even-width
bands exact on the square grid. Mainline sparse-data defaults produce four broad lanes,
a two-square median, two-square shoulders, and two-square verges; links retain the
same visual language but default to one lane and no median, so they read as ramps.

Highway edge lines are continuous and lane separators use a configured repeating dash.
The line sprite follows each segment's dominant cardinal axis, keeping bends legible;
unsupported diagonal line artwork is not guessed. OSM `markings=no` suppresses lines.
All band and marking assets resolve through `road.highway.band` and
`road.highway.marking` semantic mappings. Overlapping ramp/mainline and crossing-road
writes intentionally remain paved and connected; full topology-aware conflict-area
suppression belongs to the later intersection task. `test/highway-rendering.test.js`
pins straights, bends, ramps, merges, crossings, and distinction from built-up streets.

### Urban sidewalk and verge transitions

Urban roads collect sidewalk geometry during carriageway rasterization but defer its
artwork until all roads and point openings are known. `finalizeSidewalks` removes any
candidate occupied by another carriageway or by an exact placed-building footprint,
then classifies the surviving mask as straight, inner/outer corner, end, fill, or
diagonal. Driveways, entrances, and crossings retain walkable pavement through the
cut while suppressing curb and grass-fringe overlays; junction conflict areas suppress
the sidewalk entirely.

The pavement body resolves through `road.sidewalk` with the normalized OSM sidewalk
surface. Concrete, paving-stone, asphalt, and gravel contexts use deterministic
validated variants. Outer squares receive measured `Grass_Medium` blend edges and
inner-corner overlays, producing a fuzzy verge boundary without replacing the walkable
floor. The same cardinal attachment artwork follows diagonal stairsteps one square at
a time. `test/sidewalk-transitions.test.js` pins variants, ends, diagonal continuity,
driveway/crossing cuts, fuzzy boundaries, and carriageway/building collision exclusion.

### Street signs and supported roadside furniture

`src/plan/roadside.js` runs after intersection, sidewalk, and curb geometry is complete.
It maps retained OSM stop/give-way nodes, traffic signals, crossings, generic traffic
signs, motorway junctions, route references, street lamps, and intersecting street names
to validated `object.sign` and `object.furniture` mappings. Tagged major road ways with a
`ref`, `route`, or `destination` receive one deterministic route-context sign. Planned
records retain source and road feature IDs, route references, street names, whether the
control was inferred, and the selected tile/layer for auditability.

OSM control nodes commonly lie on the road centreline, but furniture must not. The pass
finds the nearest rendered road, derives its local tangent and outward normal, then
searches from the outer carriageway edge toward the verge. A candidate is accepted only
when it is inside the world and outside the completed carriageway and building masks;
occupied roadside squares are also excluded. Sign facings point toward approaching
traffic, including `traffic_sign:direction=forward|backward` handling. Selection and side
choice are coordinate/feature-key deterministic.

Inference is deliberately narrow. Roundabout entries may receive give-way signs, while
a T-junction receives an inferred stop only when its single terminating arm has a lower
functional hierarchy than the through road. Equal-class local streets, four-way
junctions, ambiguous skewed junctions, and any junction with a nearby explicit control
remain uninferred. Unsupported barriers such as bollards remain in `sourceFeatures` and
are not replaced by an unrelated loose object. `test/roadside.test.js` pins semantic
classification, facing, lane exclusion, deterministic route signs, street-name signs,
and conservative inference.

## Semantic asset registry

`config/semantic-mappings.jsonc` is the authoritative boundary between normalized
OSM/procedural meaning and loose Project Zomboid artwork. Emitters resolve a semantic
key (for example `road.curb` or `procedural.road-wear`) with context such as road class,
cardinal orientation, topology, built-up state, surface, and condition. Rules declare:

- validated variants and relative weights;
- the exact prefab layer and expected catalogue role/family;
- optional deterministic placement probability;
- explicit exclusions where substitution would be unsafe;
- named, cycle-checked fallbacks.

`src/catalogue/semantic-registry.js` owns matching and deterministic weighted selection.
Specific context and explicit priority decide rule precedence; emit code does not carry
parallel tile pools. `npm run verify-semantic-registry` checks every referenced tile
against `library/asset-inventory.json`, including existence, family, role, layer and
orientation requirements, support status, and whether context-required artwork is
guarded.

A world build performs a second, installation-specific check against the dimensions of
the installed tile sheets. Vanilla lotheader observations are accepted as evidence for
the small set of real Build 42 sprites absent from tile definitions. Unavailable variants
are removed without reordering the remaining weighted pool; an empty pool follows its
named fallback, so the same installation, seed, and placement key always make the same
choice. A mapping marked `mandatory` aborts the build with its complete fallback chain
when no compatible variant remains. Structural building assets remain inside complete
prefabs, because selecting their loose component tiles would destroy adjacency and room
semantics.

## Ground: what vanilla actually does, measured

Three passes decide what a square of ground looks like, and all three were built
on an assumption that turned out to be wrong. Sampling every base tile at level 0
across 24 Muldraugh cells — 1,386,631 natural squares and 361,635 road squares —
settles each of them.

**Variants are a per-square dither.** The four interchangeable tiles inside a
blend block are chosen uniformly per square: Grass_Dark's offsets 0/5/6/7 land at
25.2, 25.0, 24.8 and 25.1 %, and a run of one variant along a row averages 1.30
squares. `baseTile` in `src/plan/blends.js` used to pick from a 110-square noise
field on the reasoning that a hash would read as a uniform dither. The reasoning
was sound and the premise was wrong: fBm's distribution is 0.35–0.67 with σ ≈
0.03, so two of the four indices were unreachable and the other two changed once
a screen. That is the flat grass.

**Materials are the patches.** A run of one *material* averages 11.02 squares
with a median of 3 and a 90th percentile of 19, and the shares are

```
Grass_Dark   66.29%      Dirt_Grass   4.48%
Grass_Medium 20.71%      Dirt         1.12%
Grass_Light   6.97%      Sand         0.44%
```

`naturalSurfaceAt` in `src/plan/surfaces.js` reproduces both: a dedicated
16-square `material` field decides which, and a broad moisture field tilts a whole
neighbourhood lighter or darker without either becoming uniform. Measured back
out of the generator, runs come to a median of 3 and a p90 of 18 at 69/20/6/4 %.

**Tarmac is three materials, not one.** *Which* squares you sample decides the
answer, and the first attempt got it wrong: taking every square on the street
sheet mixes the carriageway in with driveways, forecourts and parking aprons,
which are a different material entirely. Walking three squares inward from each
of 67,254 kerb squares separates them:

```
inside the kerbs          no kerb or line within 3 squares
Road_06  68.76%           Road_04  49.39%
Road_07  28.64%           Road_07  42.07%
Road_04   2.38%           Road_06   8.02%
```

Road_04 is the pale tan of a driveway, and the undifferentiated 19.95% figure put
it on a fifth of every carriageway in the world — a whole city's tarmac came out
mottled tan and grey, which is not what a road looks like from above. The
patches have a median run of 4 along a row; that patchwork is what "the road
decays" looks like. On top of it sits one overlay
family on about a tenth of road squares (`overlay_grime_floor_01`, 10.70%);
`d_streetcracks` appears **zero** times in the sample. `src/plan/decay.js` owns
both halves: `roadMaterialAt` lays the three asphalts from a coherent stress
field biased by hierarchy, OSM condition, edge position and distance to a
junction, and the cracked artwork is gated to roads OSM or their class say are
actually failing.

## Deterministic terrain fields

`src/plan/terrain-fields.js` owns the world-space procedural fields used by authored
terrain. A `TerrainFields` instance derives independent seeded namespaces for grass,
dirt, vegetation density, moisture, wear, material and local patch structure. Each field
combines a broad fBm signal with finer detail; local patch noise is mixed in without
introducing mutable random state.

Fields are sampled with absolute world-square coordinates. Their result therefore does
not depend on scan order, chunk origin, cell origin, or which neighboring region was
built first. Reconstructing a field with the same seed produces identical values on both
sides of Build 42's 8-square chunk and 256-square cell boundaries.

**Every consumer takes a field's rank, not its value.** Summing octaves narrows the
distribution — the central limit theorem applies to fBm like anything else — so a raw
field sits in a band about 0.5, and comparing it against cumulative shares selects one
outcome for the whole world. `FIELD_SIGMA` records each field's measured standard
deviation over five seeds and `fieldPercentile` converts a value to a uniform 0..1 rank,
which is what lets a measured share be read straight off as a threshold. Mixing two
ranks is avoided: averaging uniforms narrows the result back toward 0.5, so where two
fields must combine they are mixed *before* the rank and the mixture's own sigma is
derived from theirs.

Surface provenance is retained alongside material. Water, farmland, car parks,
construction, carriageways, pavements, and building occupancy keep exclusive ownership;
generic foliage cannot overwrite them. Natural, town, and managed-ground foliage pools
preserve the contextual inventory's per-asset weights while excluding farm artwork and
boulders where their semantics are incompatible.

## Validation and performance evidence

The asset boundary is validated at four different levels rather than treating one test
as proof of all behavior:

1. `npm run verify-semantic-registry` checks every loose semantic mapping against the
   complete inventory and its role, layer, orientation, support, and fallback rules.
   Where a mapping and the inventory both speak the run-direction vocabulary they must
   *agree*, not merely both be present: `road.marking.ew` declared east-west over
   `street_trafficlines_01_16`, a tile the inventory measured north-south across 32,596
   vanilla placements at 0.98 confidence, and every east-west street in a generated city
   therefore carried a line running the wrong way. Nothing caught it, because the check
   compared the declaration against itself.
2. `npm run audit-real-world-fixtures` builds five pinned urban, suburban, rural,
   highway, and bridge extracts. It asserts required feature classes, ownership
   collisions, asset-family coverage, and continuity at Build 42's 256-square cell seams.
3. `npm run audit-tile-usage` reads the emitted cells and counts placements per asset
   family and per tile. It is the only check that answers the question this project kept
   getting wrong — *which sprites are actually on the ground* — and running it before and
   after a change and diffing the two is how the flat-grass and missing-kerb defects were
   found. `test/authored-artwork.test.js` pins the same thing as a test.
4. `npm run benchmark-asset-pipeline` repeats those builds while recording wall time,
   heap delta, visual-repetition indicators, occupied-cell workload, and the size and
   completeness of authored cell companions. Its machine-readable result is
   `library/asset-pipeline-benchmark.json`; the evidence and regeneration procedure are
   in `docs/ASSET-PIPELINE-VALIDATION.md`.

`pz-world verify` understands both legacy single-root mods and the Build 42 split layout:
metadata and Lua live under `42/`, while `MapGroups` requires authored maps under
`common/media/maps/`. Authored-cell maps do not need worldgen prefabs or a
`WorldGenOverride.lua`; those checks become mandatory only when the override exists.
The verifier re-reads lotheaders, lotpacks and biome PNGs, but it cannot execute native
streaming or observe artwork. `PZWorld_ValidationProbe.lua` therefore records loaded
player-square availability, chunk/cell transitions, and stalls during a five-minute
manual game run. Runtime acceptance remains separate and must never be inferred from
an offline pass.

## What came from Terrula, and what did not

`C:\Users\Arcade\terrula` is a planet-scale tile server. Its *engine* solves
problems Project Zomboid does not have; its *methodology* transfers almost
intact.

| Terrula idea | Here |
|---|---|
| Vector ingest normalised to one fixed attribute schema (§11.4) | `src/sources/osm.js` — a second adapter drops in without the planner knowing |
| Class tables live in config, never in code (§5.4) | `config/*.jsonc` — road widths, OSM tags, tile layers, building classes |
| Feature identity is a hash of geometry, never a source id (D16) | `hashGeometry` in `src/lib/rng.js` |
| Determinism as a contract (§2) | every choice comes from `streamFor(seed, label, fid)`; nothing calls `Math.random()` |
| Road bands: carriageway, kerb, sidewalk, verge (§6.2) | `src/plan/roads.js`, in whole squares rather than metres |
| Sidewalks gated on built-up surroundings | `builtUpMask` in `src/plan/zones.js` |
| Permissive-source posture (D1) | **deliberately reversed** — see `docs/DECISIONS.md` D1 |
| Seam-free coordinate noise | `src/plan/terrain-fields.js` — finite and flat, but stable across chunk/cell boundaries |
| Spherical grid, tile pyramid, roll-up, edit journal | not applicable — the map is finite, flat and offline |
| DEM and elevation | not applicable — Project Zomboid has no terrain height |

The last two rows are most of Terrula's engineering, and none of it comes
across. That is the honest summary: this is a second consumer of the same
methodology, not a port.

## Module map

```
src/
  cli.js                generate | extract | verify
  verify.js             re-reads a generated mod, no game required

  formats/              the reverse-engineered file formats
    lotheader.js          read + write, incl. the room graph
    lotpack.js            read + write, incl. the Cell accessor
    cell.js               the two together, plus empty-cell construction
    png.js                indexed PNG for biome maps
    tiledefs.js           the game's tile catalogue: existence and facing

  prefab/
    schematic.js          the four-layer prefab, and rotation
    layers.js             which layer a tile belongs to
    classify.js           room names → building class
    starter.js            the built-in prototype set

  extract/
    harvest.js            lift buildings out of vanilla cells
    run.js                the extract command

  sources/osm.js        Overpass fetch, cache, normalise
  geo/project.js        lon/lat → world squares
  geo/orient.js         bearing solver, OBB, snapping
  plan/
    polyline.js           gap-free capsule rasteriser, once per square
    roads.js              cross-section renderers, kerb and pavement topology
    roadside.js           signs, supported furniture, and control inference
    roadworks.js          runs both for the authored route, and reports bands
    surfaces.js           one material per square, from those bands
    blends.js             the autotiler between materials
    decay.js              road materials and the grime overlay
    terrain-fields.js     seeded, seam-stable fields and their ranks
    vegetation.js         trees, shrubs, groundcover, boulders
    buildings.js          prototype fitting and placement
    place.js              authored-route placement and materialisation
    zones.js              biome-map raster
    index.js              buildPlan — the legacy planner
    grid.js               sparse rasters
  emit/generate.js      the authored route, coordinates to cells
  emit/world.js         buildings, ground, blends, road artwork, vegetation
  emit/worldgen.js      the legacy mod writer
  lib/                  binary cursors, seeded RNG, JSONC, install discovery
```

## The PlacementPlan

The intermediate both emitters consume:

```js
{
  meta: { name, lat, lon, radiusM, seed, bearing, metresPerTile,
          originTileX, originTileY, bounds, alignment },
  projection,                    // a Projection, for mapping back to lon/lat
  placements: [{ fid, cls, x, y, w, h, turns, schematic, residualDeg }],
  roads:  TileCanvas,            // sparse, layer per square
  ground: SparseGrid,            // one biome grey per square, cell-allocated
  stats:  { buildings, roads, residual }
}
```

Keeping this a plain data structure — rather than letting the emitter reach
back into OSM — is what makes the second emitter a matter of writing files
rather than re-deriving the city.

## Memory

A city is too big to raster densely: at one square per metre a 12 km radius is
576 million squares. Two structures avoid it.

- `SparseGrid` allocates a 65,536-byte array per **256 × 256 cell** on first
  touch — the same unit the biome map is written in, so the emitter walks the
  cells that exist rather than working out which would have been empty.
- `TileCanvas` is a hash map keyed by packed square coordinate, because roads
  cover a small fraction of a city and a dense array would be mostly empty.

Measured on Burlington VT at a 900 m radius: 64 cells, 745,432 road squares,
3,894 distinct prefabs, 4,767 placements.

## Clipping to the requested area

The world's extent comes from the **request**, never from the features.
Overpass's `out geom` returns a way's entire geometry whenever any part of it
falls in the bounding box, so one river or one interstate that clips a corner
arrives stretching tens of kilometres beyond the area asked for. Taking the
extent from the features let a 900 m request produce a 9,431 × 28,327 world of
4,256 mostly-empty cells.

Buildings and land cover outside the world are dropped; roads are **clipped**
with a vertex of slack on each side, so a road crossing the map is still drawn
across it rather than vanishing. Painting is clamped at the boundary as well,
because a road's bands stack outward from its centreline and can round to a
square just outside — and Project Zomboid indexes cells from zero, so a single
stray negative square would allocate a cell that cannot exist.
