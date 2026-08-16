# Project Zomboid B42 map formats

Everything here was reverse-engineered against **Build 42.20.2** and is
validated by `test/formats.test.js`, which parses all 4,065 cells of
`media/maps/Muldraugh, KY` and re-emits a sample byte for byte. Where a claim
rests on a measurement, the measurement is given — this document is meant to
outlive the code in this repository.

Everything is **little-endian**. Strings are **newline-terminated**, never
length-prefixed.

---

## Geometry

| Unit | B42 | B41 |
|---|---|---|
| Cell | 256 × 256 squares | 300 × 300 |
| Chunk | 8 × 8 squares | 10 × 10 |
| Chunks per cell | 32 × 32 = 1024 | 30 × 30 = 900 |

Confirmed by `map.info`, which states it in prose: `Chunk size is 8x8, Cell
size is 256x256`.

A square is taken as **one metre** throughout this project. That is a
convention, not something the format states.

### Coordinate convention — the one that fails silently

Both the chunk index in the lotpack offset table and the square index inside a
chunk are **x-major**:

```
chunkIndex  = cx * 32 + cy
squareIndex = level * 64 + sx * 8 + sy
```

This is the opposite of the row-major order most raster code assumes, and
getting it wrong transposes the entire cell without producing an error.

It was settled by content rather than by guessing. Every square in a shipped
lotpack has `roomId = -1` (rooms are bound at runtime from the lotheader — that
is what `WorldGenChunk.setRoomID` is for), so the discriminator is what the
tiles *are*: sample the squares covered by every ground-floor room rectangle in
cell 51_7 and count how many carry an interior floor tile.

| chunk order | square order | interior floor | outdoor ground |
|---|---|---|---|
| **x-major** | **x-major** | **91.1 %** | **0.5 %** |
| x-major | y-major | 64.8 % | 22.2 % |
| y-major | x-major | 40.6 % | 27.2 % |
| y-major | y-major | 39.5 % | 30.8 % |

`test/formats.test.js` re-runs that measurement, so a regression shows up as a
number rather than a crash.

---

## `<cellX>_<cellY>.lotheader`

The tile dictionary and room graph for one cell.

```
char[4]  "LOTH"
i32      version                 always 1
i32      tileCount
string[] tileNames               newline-terminated; the lotpack indexes these
i32      chunkW                  8
i32      chunkH                  8
i32      minLevel                0
i32      maxLevel                highest occupied z-level in this cell
i32      roomCount
room[roomCount]:
    string  name                 "kitchen", "bank", "prisoncells"
    i32     level
    i32     rectCount
    rect[rectCount]:  i32 x, i32 y, i32 w, i32 h     cell-local
    i32     objectCount
    object[objectCount]:  i32 type, i32 x, i32 y
i32      buildingCount
building[buildingCount]:
    i32     roomCount
    i32[]   roomIds              indices into the room array above
u8[1024] density                 one byte per chunk, 32 × 32
```

The trailing 1,024-byte block is what proves a parse: every one of the 4,065
Muldraugh cells lands on exactly 1,024 bytes remaining, which it could not do
if the room graph had been mis-read.

`maxLevel` reaches 28 in cell 49_6, so B42 supports far more than the eight
z-levels B41 had.

### Why the room graph matters

A room carries a **semantic name**, and Project Zomboid's loot distribution
keys off it. A building is a list of room ids. Together that means the shipped
map is a labelled corpus of ~9,500 buildings, which is what
`src/extract/harvest.js` mines. Measured across every shipped map:

```
9,546 buildings   586 distinct room names
bathroom 16126   bedroom 11375   livingroom 11222   kitchen 7725
office 3976      garagestorage 1496   prisoncells 540   grocery 79
```

### Rooms cover interiors, not walls

A wall is drawn on the **north or west edge of a square**. So a building's
south wall lives on the row *below* its last interior row, and its east wall on
the column *right* of its last interior column — both outside the bounding box
of its room rectangles.

Measured on Muldraugh cell 51_7, building 5 (bounds x=121 y=71 w=11 h=36):

```
west   column x=121   36/36 wall tiles
north  row    y=71    11/11
south  row    y=106    5/11      <- last interior row
south  row    y=107   11/11      <- OUTSIDE the room bounds
```

Extraction that trusts the room bounds loses two of every building's four
walls. `harvestCell` adds one square of margin on the east and south for
exactly this reason.

---

## `world_<cellX>_<cellY>.lotpack`

The tile data.

```
char[4]  "LOTP"
i32      version                 always 1
i32      headerField             see below — NOT a dimension
i64[1024] chunkOffsets           absolute file offsets, ascending
<chunk blobs>
```

The offset table always has 1,024 entries and always begins at byte 12, so the
first chunk offset is always `12 + 1024*8 = 8204`.

### `headerField` is not trustworthy

| file | value |
|---|---|
| `Muldraugh, KY/world_0_18.lotpack` | 1024 |
| `Muldraugh, KY/world_51_7.lotpack` | 1024 |
| `challengemaps/Kingsmouth/world_117_117.lotpack` | 1024 |
| `challengemaps/Challenge1/world_0_0.lotpack` | **8** |
| `challengemaps/Challenge1/world_1_1.lotpack` | **8** |

Current maps write the chunk count; the older Challenge files write the chunk
edge. Both have a 1,024-entry table. Treating this field as `chunkSize` makes
`levels * chunkSize²` come out as 1,048,576 squares per chunk and exhausts the
heap — which is exactly what happened while writing this. **Take the geometry
from the lotheader**, which reliably reports `chunkW = chunkH = 8`, and
preserve this field verbatim only so a re-emitted file is byte-identical.

### Chunk blob

A flat stream of `levels × 64` square records, level-major, where `levels`
comes from the lotheader as `maxLevel - minLevel + 1`.

```
i32 n
  n >= 1 :  i32 roomId          -1 in every shipped file
            i32 tileIndex[n-1]  indices into the lotheader tile table
  n == -1:  i32 skipCount       that many squares are empty
```

`n` counts the ints that follow, of which the first is the room id. The skip
run is what keeps wilderness cheap: an entirely empty chunk is eight bytes.

A square carries up to **12 tiles** (measured on cell 51_7), stacked in draw
order with the floor first.

---

## `chunkdata_<cellX>_<cellY>.bin`

Accompanies every shipped cell. Two header bytes `00 01` then per-chunk data.
A wilderness cell is 1,026 bytes — `00 01` then 1,024 bytes of a constant —
while cell 51_7 is 46,658 bytes, so it is variable-length and only partly
understood. Generated cells emit the 1,026-byte wilderness shape.

This is the one format here that is **understood by shape rather than
decoded**; see `docs/LIMITATIONS.md`.

---

## `maps/biomemap_<cellX>_<cellY>.png`

A **256 × 256 8-bit indexed PNG**, one pixel per world square, mapping ground,
vegetation and zone through `media/lua/server/metazones/BiomeMapConfig.lua`.

The pixel value the game reads is the **grey level**, not the palette index.
Vanilla files are palette-optimised down to as few as one entry, and
`biomemap_51_7.png` has `palette[0] = rgb(115,115,115)` — 115 being
`townhouse` / `TownZone`. So writing a full 256-entry greyscale ramp, where
entry *i* is `rgb(i,i,i)`, makes index and grey identical and the distinction
moot. That is what `src/formats/png.js` does.

Selected values from `BiomeMapConfig.lua`:

| grey | biome | zone |
|---|---|---|
| 0 | — | Water |
| 64 | — | ForagingNav |
| 96 | `$random` | DeepForest |
| 115 | `townhouse` | TownZone |
| 128 | `farmmix_forest` | Farm |
| 141 | `farmmix_forest` | FarmLand |
| 254 | `dirt` | ForagingNav — spawns nothing |
| 255 | `primary_forest` | DeepForest |

**Biome maps exist for cells that have no lotpack**: Muldraugh ships 4,914 of
them against 4,065 cells, covering the full 78 × 63 rectangle. Worldgen fills
what the authored cells do not.

---

## Worldgen prefabs

`media/lua/server/WorldGen/prefabs/*.lua`. The class
`zombie/iso/worldgen/PrefabStructure` declares the whole contract:

```
categories = [ "Floor", "FloorFurniture", "FloorOverlay", "Furniture" ]
dimensions : int[]                    { width, height }
tiles      : List<String>             the palette
schematic  : Map<String,int[][]>      1-based indices into tiles, 0 = empty
zombies    : float
```

Four layers, **one z-level**, one tile per layer per square. Walls go in
`Furniture` — the shipped `highway_NS_00` prefab puts `walls_garage_02_20`
there, which is the only direct evidence of where the game expects them.

Rows in the schematic are strings of comma-separated indices, one row per
`height`, each with `width` entries.

## Static modules

`media/maps/<Name>/WorldGenOverride.lua`. `zombie/iso/worldgen/StaticModule` is
a record of `{biome, prefab, xmin, xmax, ymin, ymax}`:

```lua
worldgen["static_modules"] = {
    {
        position = { xmin = 12590, xmax = 12609, ymax = 900 },
        prefab = worldgen.prefabs.highway_NS_00
    }
}
```

`12609 - 12590 + 1 = 20`, which is that prefab's width, so the bounds are
**inclusive**. A rect larger than the prefab **tiles it repeatedly** — that
example draws 900 squares of highway from a 20 × 3 prefab. To place a prefab
exactly once, set `xmax = xmin + width - 1`.

---

## Tile definitions

`media/*.tiles.txt` is a brace-delimited key/value tree. A tileset declares
`file` and `size = w,h`; each tile block is preceded by a `// <name>` comment
and its index is `y * w + x` from its `xy` property.

**It is not a complete register of tiles.** Only tiles that carry *properties*
appear: `walls_detailing_02` starts at index 4 because indices 0–3 are plain
sprites with nothing to declare. And `jumbo_tree_01_0` is referenced by 1,804 of
Muldraugh's 4,065 cells while appearing in no `.tiles` or `.tiles.txt` at all.

So there are two independent registers of what a real tile is, and
`src/verify.js` uses both:

1. a tileset's declared `size` — every index below `w × h` exists;
2. the tile tables of the shipped lotheaders — whatever Knox County draws with.

### Wall facing

Walls are declared by property, and the layout is regular:

```
walls_interior_house_01_0   WallW      WallType = wall
walls_interior_house_01_1   WallN      WallType = wall
walls_interior_house_01_2   WallNW     CornerNorthWall = ..._1
                                       CornerWestWall  = ..._0
walls_interior_house_01_3   WallSE
..._8  WindowW    ..._9  WindowN
..._10 DoorWallW  ..._11 DoorWallN
```

The corner tile **names its own north and west partners**, which is an
authoritative north/west pairing straight from the data — and the inverse gives
the single tile that draws both walls on one square, which is what rotation
needs.

Where a corner is absent, pairing the *k*-th west tile with the *k*-th north
tile of the same kind within a sheet is correct for both layouts in use:
walls interleave (`W, N, corner, corner, …`) while roof sheets block them
(`W, W, W, W, N, N, N, N`). Together these pair 7,062 of 7,100 directional
tiles — 99.5 % — and the result is a strict bijection, so mirroring twice
returns the original tile.

**Sheets do not share a layout.** `walls_exterior_house_01` has the west wall
at index 0, the north wall at 1 and the corner at 2, but `walls_commercial_01`
has *windows* at 0 and 1 and doors at 8 and 9, and `walls_garage_01`'s corner is
at index 34. Anything that needs "the north wall of this sheet" must look it up
by role, not by index — assuming the house layout builds walls out of windows,
silently, because a wrong tile still renders.

Telling a *structural* wall from a decal is also not as simple as it looks.
`WallType` is **not** a reliable marker: `walls_interior_house_01` declares it
and `walls_exterior_house_01` does not, carrying only `WallN` and a lowercase
`wall`. Facing is the property every wall sheet has. But facing alone
over-counts, because `overlay_grime_wall_01_*` are dirt decals painted onto
walls and carry wall-ish properties — those are distinguished by `WallOverlay`.
So: has a facing role, and is not a `WallOverlay`.

### Diagonal road art is real

`street_curbs_01_diag` (78 tiles) and `street_curbs_01_diag_2` (79) exist, and
are used in about one in six of the Muldraugh cells that have kerbs at all.
Both are declared `FloorOverlay` — they are painted *on top of* square ground,
so the walkable grid stays axis-aligned while the visible road edge runs at an
angle. This is why roads in this project keep their true bearing while
buildings must be snapped.
