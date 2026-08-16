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
   ▼
plan  (src/plan/index.js)
   ├── buildings   footprint → OBB → snap → class → prototype → placement
   ├── roads       true bearing, stairstepped, diagonal kerbs on 1:1 runs
   └── ground      biome-map raster, dirt under everything built
   ▼
PlacementPlan  ──┬──▶  emit/worldgen.js   prefabs + static modules + PNGs
                 │                        the countryside, outside the radius
                 └──▶  emit/world.js      the city, as authored cells:
                        emit/lotpack.js     lotheader + lotpack (8 levels)
                        emit/chunkdata.js   chunkdata_*.bin
                        emit/worldmap.js    worldmap.xml.bin
                        emit/streets.js     streets.xml
   ▼
verify  (src/verify.js)  — re-read everything with the readers that wrote it
```

Order inside `plan` is not arbitrary. Buildings go first because everything
else needs to know where the town is: a sidewalk is drawn where there are
houses, not where a landuse polygon claims there ought to be. Ground goes last
so that roads and footprints can stamp `dirt` over whatever land cover said, and
worldgen does not grow a tree through a kitchen.

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
| Spherical grid, seam-free noise, tile pyramid, roll-up, edit journal | not applicable — the map is finite, flat and offline |
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
    index.js              the planner
    roads.js              stairstep router and bands
    buildings.js          prototype fitting and placement
    zones.js              biome-map raster
    grid.js               sparse rasters
  emit/worldgen.js      the mod writer
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
