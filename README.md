# pz-world

Start a new game in **Project Zomboid Build 42**, type in coordinates, and watch
the world build itself from the real place at those coordinates — roads on their
real bearings, real building footprints, shops where the shops are and hospitals
where the hospitals are.

One mod. Not tied to any city. Its own world, not a district bolted onto Knox
County.

```
New Game → pz-world panel
  Latitude   44.6995        Longitude  -73.4529
  Radius     2500 m         Seed       (auto)

  [ Plattsburgh, NY ] [ Burlington, VT ] [ Manhattan, NY ]
  [ New Orleans, LA ] [ Paris ] [ Tokyo ]

  ████████████████░░░░░░░░  63%
  Laying roads  (241 of 370)
```

---

## Setup

**Requirements:** Node 22+, Project Zomboid Build 42 installed. No npm
dependencies.

```bash
npm run setup
```

That runs three steps, and you only need it once:

| step | what it does |
|---|---|
| `extract` | indexes ~9,100 buildings in **your own** Project Zomboid install |
| `canvas` | builds the blank 16.4 km world the mod ships |
| `build` | assembles the mod, block-checks every Lua file, installs it |

Then, whenever you want to play:

```bash
npm run helper
```

Leave that running. It is the part that does what Lua cannot: Project Zomboid's
Lua sandbox cannot open a socket **and cannot write a byte above 0x7F**, and a
map cell is binary. So when you press **Build this world** the helper fetches
OpenStreetMap and writes the cells, while the game holds a progress screen in
front of you until they are on disk.

Launch Project Zomboid, enable **pz-world**, and start a **new** game. The panel
opens at the main menu — type coordinates, pick a radius, watch it build. **F7**
reopens it.

You can also build a city straight from the command line, which is the same
build the panel orders:

```bash
npm run world -- --lat 44.6995 --lon -73.4529 --radius 2500 --name "Plattsburgh, NY"
```

Three things that matter and are easy to get wrong:

- **`npm run build` wipes the map directory**, blank canvas and all. Install the
  mod first, build a city into it second.
- **Quit the game before running `npm run world`.** The game keeps file handles open
  on map cells it has read, and on Windows rewriting an open file fails outright.
  The in-game panel does not have this problem: it builds at the main menu,
  before any cell has been opened.
- **Start a new save.** A chunk you have already walked through is served from the
  save, not from the map, so an old save keeps the old world.

---

## How it works

The world is **authored**: the build writes real Project Zomboid map cells over
the blank canvas the mod ships, and the game loads them the way it loads
Muldraugh.

The panel and the command line are two front doors onto the same build. The
panel writes an order to a file in `Zomboid/Lua/`, the helper picks it up and
runs it, and the build screen blocks the game until the last cell is written —
which is the moment that matters, because `MapFiles.load()` re-lists the map
directory at world init but `IsoLot.pool` holds cell files open once the world
starts streaming.

```
you type coordinates  ─────▶  build order file  ─────▶  helper
        ▲                                                  │
        │  progress file, read every frame                 │
        └──────────────────────────────────────────────────┤
                                                           ▼
   fetch Overpass, classify, project, clip
        │
        ▼
   find the city's dominant street bearing, rotate the world onto the grid
        │
        ▼
   place buildings by class and size, out of your own install
        │
        ▼
   lay roads at their true bearings; kerbs, pavements, car parks
        │
        ▼
   paint ground, then the blend and corner tiles between surfaces
        │
   ┌────┴──────────────────────────────────────────────┐
   │ write into the installed mod                      │
   │   <cx>_<cy>.lotheader     tiles, rooms, buildings │
   │   world_<cx>_<cy>.lotpack 8 levels of tile data   │
   │   chunkdata_<cx>_<cy>.bin collision summary       │
   │   maps/biomemap_*.png     so the game keeps it    │
   │   worldmap.xml.bin        the map you see on M    │
   │   streets.xml             street names on it      │
   │   objects.lua             parking zones → cars    │
   │   spawnpoints.lua         where you start         │
   └───────────────────────────────────────────────────┘
        │
        ▼
   launch the game; it streams the cells as you explore
```

Build 42 also ships a **runtime world generator** — `WorldGenerateThread`,
`ChunksCache`, `PrefabStructure`, `StaticModule` — driven from two plain Lua
tables, and this mod used to build the city that way. It cannot express an
upstairs, a roof, or a room definition: `PrefabStructure` hard-codes four tile
layers and has no z axis. So that route is retired for the city and kept for the
countryside outside the requested radius, where none of its limits bite and free
procedural terrain beats authored flat grass. See
[docs/WORLDGEN.md](docs/WORLDGEN.md).

Running both at once is the one thing that must not happen: they are two
different worlds over the same ground, and the mod no longer populates
`worldgen.static_modules` at all.

### Roads keep their bearing; buildings cannot

A Project Zomboid wall is drawn on the north or west edge of a square, so a
building gets one of four orientations and nothing between.

Roads are different. Nothing about a road has to sit on an edge, so a street
keeps its true bearing and is drawn as a stairstep — carriageway, kerb and
pavement filled outward from the real centreline — while buildings are snapped.
The cost of that snap is made small by rotating the whole city once first, onto
its own commonest street direction. The build reports what it cost.

The game also ships two *diagonal* kerb sheets declared as `FloorOverlay`,
painted on top of square ground, which vanilla uses on 1:1 runs so the visible
road edge can run at an angle while the walkable grid stays square. pz-world does
not use them yet: measurement shows they are laid as runs of six consecutive
tiles along a diagonal, not as a single edge tile, and substituting one tile for
the sheet draws the wrong facing three times out of four. The four axis-aligned
kerbs it does use were measured against 30,000 Muldraugh squares, as was the
pavement's width — one square, which is what 82.6% of Muldraugh's are
([DEV_GUIDE §2.14](DEV_GUIDE.md)).

### The buildings are whole buildings

Nothing here invents a building. The shipped map is a labelled corpus: **9,089**
hand-authored buildings, each a list of **named rooms** (`kitchen`,
`grocerystorage`, `prisoncells`) because the game's own loot system keys off
those names. That classification is what lets an OSM `shop=supermarket` become
an actual shop rather than a shop-shaped box.

What arrives in the world is that building, **all of it** — every storey, the
roof and the ceilings, all twelve tiles a square can carry, the doors, the
windows, the light switches, and the room definitions the loot and alarm systems
read. It is copied square for square out of your own installation and turned to
face the street.

That needs the world to be written as real map cells rather than as instructions
for the game's runtime generator, because `PrefabStructure` declares four tile
layers and no level axis — the runtime route *cannot* express an upstairs or a
roof, whatever it is handed. Cells are binary and Project Zomboid's Lua writes
UTF-8 text only, so `npm run world` writes them before the game starts.

The extracted data is derived from The Indie Stone's files on your own machine.
Only an index of *where* each building is gets stored; the tiles are read from
your install at generate time and never redistributed.

---

## Documentation

| | |
|---|---|
| **[DEV_GUIDE.md](DEV_GUIDE.md)** | **Read this first.** Every pitfall, including the `MapGroups` bug that makes a mod's map invisible, and the tools built to work without a debugger. |
| [docs/PZ-FORMATS.md](docs/PZ-FORMATS.md) | The reverse-engineered B42 map formats, with the evidence for each claim. |
| [docs/WORLDGEN.md](docs/WORLDGEN.md) | B42's runtime world generator as a modding surface. |
| [docs/ORIENTATION.md](docs/ORIENTATION.md) | Bearings, oriented bounding boxes, rotating walls as lattice edges. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The pipeline and module map. |
| [docs/PROTOTYPES.md](docs/PROTOTYPES.md) | Extraction, classification, fitting. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Numbered decision log. |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | What does not work, measured. |
| [helper/protocol.md](helper/protocol.md) | The file protocol between mod and helper. |

## Tools

Built because there is no JDK, decompiler or Lua interpreter on a modding
machine — and guessing without them cost days.

```bash
node tools/classdump.js <file.class> [method]   # read the game's bytecode
node tools/mapgroups.js pzworld                 # will PZ list my map? (offline)
node tools/luacheck.js <file.lua>               # catch a missing `end`
node tools/simulate.js                          # replay a build, offline
```

`simulate.js` re-runs the geometry against the last payload the helper fetched
and answers the questions that decide whether the world looks right — how many
buildings overlapped, how many pavements crossed a road, whether any static
module hides another's tiles — without launching the game.

## Tests

```bash
npm test
```

72 tests against your own install: all 4,065 vanilla cells parse, both binary
writers round-trip byte for byte, all six shipped `worldmap.xml.bin` files
re-encode byte for byte, the cell coordinate convention is re-measured rather
than asserted, rotation is exact on synthetic cases and measured on real
buildings, the road bands are checked square for square against a brute-force
rasteriser at eleven bearings, and the map-grouping rules are pinned.

## World size

The canvas is **64 × 64 cells = 16.4 km square**. For scale, vanilla Knox County
is 78 × 63 cells (19.9 × 16.1 km), so this is the same order as the whole base
game and holds a city plus the country around it. Change `CANVAS_CELLS` in
`tools/make-canvas.js` and `Config.lua` together if you want more; an empty cell
costs 19.6 kB.

## Licensing

Map data from OpenStreetMap, © OpenStreetMap contributors, under the
[ODbL 1.0](https://www.openstreetmap.org/copyright), with attribution in the
generated `mod.info`.

Building prototypes are generated on your own machine from your own copy of
Project Zomboid and are not redistributed by this project.

pz-world itself is MIT.
