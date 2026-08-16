# The prefab library

## Where buildings come from

Two sources, and the good one requires a Project Zomboid install.

### Harvested (`pz-world extract`)

The shipped map is a labelled corpus. Every building in it is a list of rooms,
and every room has a **semantic name** — `kitchen`, `grocerystorage`,
`prisoncells` — because Project Zomboid's own loot system keys off those names.
That makes classification nearly free and gives prototypes that were drawn by
hand rather than generated.

Measured on 42.20.2, across every shipped map:

```
9,546 buildings   586 distinct room names
bathroom 16126   bedroom 11375   livingroom 11222   kitchen 7725
empty 5704       closet 5397     office 3976        garagestorage 1496
motelroom 715    prisoncells 540 grocery 79         medclinic 70
```

Extraction keeps 7,879 of the 9,546:

```
4974 house    1365 garage    353 shed     315 office   292 farm
 170 retail     85 industrial  70 restaurant  63 grocery  31 warehouse
  30 police     29 bar         28 gas_station 26 church   18 medical
  17 apartment  11 education    2 civic
```

The rest are rejected for being off the ground floor, smaller than 3 squares,
larger than 60, straddling a cell edge, or coming out less than a quarter full
(a bounding box that caught a courtyard rather than a building).

**This output is not redistributable.** It is derived from The Indie Stone's
shipped map data, so it goes to `library/extracted/`, which `.gitignore`
excludes. See `docs/DECISIONS.md` D6.

### Built in (`--library starter`)

`src/prefab/starter.js` generates 20 plain buildings from rules — four walls, a
door on the south face, windows on a rhythm, a floor, at several sizes across
eight classes. Every tile name it uses is checked against the install's
catalogue by the test suite.

They exist so the pipeline runs end to end on a fresh clone, not to compete with
Knox County. `Library.open` prefers a harvested library and falls back to these.

## Classification

Two ends of the same vocabulary, which have to agree:

```
vanilla rooms ──▶ config/building-classes.jsonc ──▶ class ──▶ library bucket
                                                      ▲
OSM tags ──────▶ config/osm-tags.jsonc ───────────────┘
```

**From rooms** (`src/prefab/classify.js`): every room name is scored against
every class and the highest total wins. `grocery` + `grocerystorage` scores 12
for grocery; `bedroom` + `livingroom` + `kitchen` scores 7 for house. Weak
evidence — a couple of generic rooms like `hall` and `kitchen` — falls through
to footprint area, the same way Terrula's feature profile falls back when FEMA's
occupancy class is `Unclassified`.

**From OSM tags** (`src/plan/buildings.js`): first match wins, so specific
`amenity` and `shop` tags are listed before generic `building` ones.
`amenity=hospital` → medical, `shop=supermarket` → grocery, bare `shop=*` →
retail. `building=yes` is both extremely common and completely uninformative,
so it falls through to area.

## Fitting a prototype to a plot

`Library#fit(cls, w, h, rng)`:

1. Every prototype in the class is considered at **both aspects** — a
   quarter-turn is free, so a 12 × 8 prototype can serve an 8 × 12 plot.
2. It must fit **inside** the snapped footprint. A building spilling past its
   own plot would overwrite the pavement and its neighbour.
3. Candidates are sorted by wasted area, and the choice is drawn randomly from
   everything within a slack band of the best — otherwise a street of identical
   plots becomes a street of identical houses.

The draw comes from `streamFor(seed, 'building', fid)`, so it is stable across
regenerations.

### When nothing fits

`fallbackClasses` in `src/plan/buildings.js` orders substitutions by how little
they lie about the place:

```
medical  → office, civic          grocery → retail
education→ office, civic          restaurant → retail, bar
fire     → garage, industrial     gas_station → retail, garage
police   → office, civic          apartment → office, house
church   → civic, house           warehouse → industrial, garage
```

A clinic standing in for a hospital is a smaller untruth than a house standing
in for one. On Burlington at 700 m, 47 of 1,534 buildings found nothing at all
and were skipped — mostly sheds too small for any prototype.

## The on-disk form

JSON, not Lua. The library is an intermediate the generator reads and filters;
only the handful of prototypes a city actually uses is ever emitted as Lua.

```
library/extracted/
  index.json                 { count, buildings: [{name, cls, w, h, fill, file}] }
  house/pzw_Muldraugh_51_7_3.json
  grocery/…
```

Each file is `{ name, cls, w, h, rooms, roomNames, layers }` where `layers` maps
a layer name to a flat row-major array of tile names.

Rotations are **not** stored. Four copies of every building would quadruple a
library that is already 94 MB; they are generated at placement time by
`rotate()`.

## Adding your own

Drop a JSON file in the right bucket and add it to `index.json`. The invariants
that matter:

- **`margin`.** The grid is the interior plus one square on the east and south,
  because that is where Project Zomboid stores those two walls. Get this wrong
  and rotation loses walls. See `docs/ORIENTATION.md`.
- **Four layers only**, one tile per layer per square.
- **Walls go in `Furniture`.**
- **Nothing but walls in the margin.** Anything else there is ground outside the
  footprint, and stamping it would paint over the pavement the planner laid.

`pz-world verify` checks tile names, dimensions and index ranges on the emitted
result.
