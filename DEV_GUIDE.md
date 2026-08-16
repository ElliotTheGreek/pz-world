# pz-world developer guide

Everything here cost real time to find. Most of it is undocumented anywhere —
not on PZwiki, not on the forums, not in any existing mod — and several items
are outright bugs in Project Zomboid that you must work around rather than fix.

Read this before changing anything structural. Target is **Build 42.20.2**.

---

## 1. The traps that will waste your day

### 1.1 A mod's maps are invisible unless `common/media/maps/` exists

**This is a bug in `zombie.MapGroups.createGroups`, and it is the single most
expensive thing in this project.**

The method scans a mod's map directories in two passes — `common/` first, then
the version directory. The common pass is compiled as:

```
 66: mod.getCommonDir() + "/media/maps/"
 81: File.exists()
 84: ifne -> 90        // exists: scan it
 87: goto -> 23        // does NOT exist: jump to the next mod
164: mod.getVersionDir() + "/media/maps/"   // ← never reached
```

There is no branch to the version-directory pass when `common/media/maps/` is
missing. **A mod that puts its map only in `42/media/maps/` has that map
silently ignored by world grouping.**

Everything else still works, which is what makes it so hard to diagnose: the
mod loads, its Lua runs, `fileExists("media/maps/<Name>/map.info")` returns
true, and `getMapInfo("<Name>")` returns a populated object. Only the world
grouping skips it.

**Rule: put map data in `common/media/maps/<Name>/`.** `mod.info` and Lua can
stay in the version directory.

Confirmed in-game: with vanilla excluded, `createGroups` found exactly one mod
map across nine active mods — `RV_B`, which lives in
`FifthWheel/common/media/maps/`.

### 1.2 B42 mods live in a version subfolder

`mods/<id>/mod.info` + `mods/<id>/media/` is a **Build 41** mod. Build 42 reads
`mods/<id>/42/mod.info` and `mods/<id>/42/media/`. A mod in the old layout does
not appear in B42's mod list at all.

Of the mods installed on this machine, 35 ship both layouts and 26 are 42-only
with no root `mod.info` whatsoever, so the 42-only layout is valid and normal.

```
mods/pzworld/
  42/
    mod.info          pzversion=42, versionMin=42.0.0
    media/lua/...
  common/
    media/maps/...    ← see 1.1
```

### 1.3 `map.info` must exist and must contain `lots=`

`MapGroups.getLotDirectories(path)` returns **null** when `<path>/map.info` is
absent, and `handleMapDirectory` treats null as "discard this map entirely".

`lots=` lines become the map's lot-directory list, and grouping is by shared lot
directories:

- **Standalone world:** `lots=<your own map folder name>`. Nothing else shares
  that name, so the map lands in a group of its own.
- **Add-on to Knox County:** `lots=Muldraugh, KY`, which is what every vanilla
  town and every existing map mod does.

Muldraugh itself declares no `lots=` and survives only because vanilla
directories are injected separately by `getVanillaMapDirectories`. Do not copy
Muldraugh's `map.info` as a template for a mod.

### 1.4 The world picker only appears with more than one group

`WorldSelect:hasChoices()` is exactly `MapGroups:getNumberOfGroups() > 1`. With
only vanilla installed there is one group, the screen is skipped, and you go
straight to the spawn-location list.

A group holding a single map directory is **named after that map's `title`**, so
a standalone map shows up under its own name.

Both the Sandbox and non-Sandbox branches of `NewGameScreen:clickPlay()` call
`hasChoices()` first — the picker is not mode-dependent. What *is*
mode-dependent is `only_for_game_mode=Sandbox` in `map.info`, which seven of the
eleven vanilla towns set; that is why a normal new game lists only four.

### 1.5 Editing mod files while the game is running does nothing

`ChooseGameInfo.Mods` and `ZomboidFileSystem.modDirToMod` are static maps, and
`readModInfoAux` early-returns on a `read` flag. A mod is parsed once per
process. **Fully quit the game before reinstalling a mod**, or you will spend an
afternoon testing a build the game never loaded.

### 1.6 Project Zomboid Lua cannot fetch a URL

Verified four ways:

| Route | Result |
|---|---|
| `luajava.bindClass` | the string does not appear anywhere in `projectzomboid.jar` |
| exposed `java.net.URL` / sockets | not exposed; the `java` Lua namespace is a curated whitelist |
| the one `URLConnection` in Lua globals | `PublicServerUtil`, hardcoded to TIS's server-list URL |
| `openUrl` | gated by `isIndieStoneUrl`, and only opens a browser |

Lua also writes **text only** — `getFileWriter` and `getModFileWriter` return an
`OutputStreamWriter`, so no binary map data can be authored at runtime.

This is why pz-world uses a helper process for the network fetch, and why the
world is described through `worldgen` Lua tables rather than written as cells.

### 1.7 Kahlua's `%` keeps the sign of the dividend

Project Zomboid's Lua is Kahlua, and its modulo follows C `fmod`, **not** Lua
5.1's floor-modulo. So `(-1) % 180` is `-1` here, where real Lua gives `179`.

Any index built by wrapping with `%` therefore lands out of range:

```lua
local j = ((i - 1 + d) % bins) + 1   -- d can be negative
sum = sum + hist[j]                  -- hist[0] is nil
```

which surfaces as the deeply unhelpful `__add not defined for operands`. It cost
a full build cycle. Normalise every wrap:

```lua
local function wrapIndex(i, n)
    i = i % n
    if i < 0 then i = i + n end
    return i + 1
end
```

Audit every `%` in a port from another Lua. The same applies to hashes — a
negative hash feeding `% #list` produces a zero or negative index.

`math.atan2` **does** exist in Kahlua, so that is not a related worry.

### 1.8 UI widgets need `instantiate()` as well as `initialise()`

Vanilla's pattern is always both, in that order, before any method is called:

```lua
self.entry = ISTextEntryBox:new(text, x, y, w, h)
self.entry:initialise()
self.entry:instantiate()
self.entry:setOnlyNumbers(true)
```

Skip `instantiate()` and the next method call hits a half-built object —
`attempted index: setOnlyNumbers of non-table: null` — which throws out of
`createChildren` and leaves a panel with **no children at all**. It renders, so
it looks like a layout bug rather than an exception.

Also: `ISTickBox` has no `setSelected`. Vanilla assigns `.selected[1]` directly.

### 1.9 Progress bars require stepped work, not a blocking loop

A blocking build renders no frames, so any bar drawn around one never moves. If
the player is meant to watch the work, the work has to advance one slice per
`update()` call from a UI element that is on screen.

### 1.10 `getMapInfo()` returns fields, not methods

Vanilla reads `info.title` and `info.only_for_game_mode` directly.
`info:getTitle()` fails. Easy to miss because a `pcall`-guarded probe reports
nothing rather than erroring.

### 1.11 A file created at runtime is invisible by name until the next launch

`ZomboidFileSystem.getString(path)` answers from `activeFileMap`, a `HashMap`
built when the mods are scanned, and **returns its argument unchanged when the
key is missing**. So for a file that did not exist at startup:

```lua
fileExists('media/maps/PZWorld/worldmap.xml')  --> false
```

because the unresolved relative path is then interpreted against the game's
install directory. The file is plainly there on disk; it resolves perfectly on
the next launch, which is a memorable way to conclude that the code is fine and
the machine is haunted.

Two consequences:

- **Write it anyway** — `getModFileWriter(id, path, create, append)` resolves to
  `mod.getCommonDir() + "/" + path` and creates the parent directories, so a mod
  can write inside itself. Lua writes text only (§1.6), which is enough for
  `worldmap.xml` and not enough for a map cell.
- **Load it by absolute path.** `getString` cannot relativise a path outside the
  game folder, so it hands an absolute one straight back and the parser opens
  it. `getModInfoByID(id):getCommonDir()` gives the prefix.

### 1.12 `getRenderer():render(nil, ...)` does not exist, and it will eat your log

There is no `SpriteRenderer.render` overload taking a null texture, so a Lua
call like

```lua
getRenderer():render(nil, x, y, w, h, r, g, b, a)   -- no such method
```

raises `No implementation found for function: render(...)`. On its own that is
an ordinary mistake. Registered on `OnPostUIDraw` it is raised out of
`UIManager.render` sixty times a second, and each one prints a thirty-line Java
stack trace **and** a Lua stack trace.

Three and a half megabytes of `console.txt` later there was nothing else left in
it — every line the mod had logged about the actual build had been pushed out.
A silent failure would have been better; this one destroys the evidence for
every other bug you are trying to find.

Filled rectangles belong to `ISUIElement`, which owns a Java UI object:
`self:drawRect(x, y, w, h, a, r, g, b)` from inside a panel added to the UI
manager. Note the alpha-first argument order, which is the opposite of
`drawText`.

**If a per-frame handler can throw, it will throw every frame.** Anything drawn
from `OnPostUIDraw` or `OnTick` should be inside a `pcall` that latches off
after the first failure, or should not be a raw event handler at all.

---

## 2. Build 42 map formats

Full annotated layouts are in `docs/PZ-FORMATS.md`. The parts that bite:

### 2.1 Geometry

| Unit | B42 | B41 |
|---|---|---|
| Cell | 256 × 256 squares | 300 × 300 |
| Chunk | 8 × 8 squares | 10 × 10 |
| Chunks per cell | 1024 | 900 |

### 2.2 Cell indexing is x-major

```
chunkIndex  = cx * 32 + cy
squareIndex = level * 64 + sx * 8 + sy
```

The opposite of the row-major convention most raster code assumes. Getting it
wrong transposes the cell **without any error**. It was settled by measurement:
sample the squares covered by every ground-floor room rectangle in Muldraugh
cell 51_7 and count interior floor tiles.

| chunk order | square order | interior floor | outdoor ground |
|---|---|---|---|
| **x-major** | **x-major** | **91.1 %** | **0.5 %** |
| x-major | y-major | 64.8 % | 22.2 % |
| y-major | x-major | 40.6 % | 27.2 % |
| y-major | y-major | 39.5 % | 30.8 % |

### 2.3 The lotpack's third header field is not a dimension

Current maps write `1024` (the chunk count); the older `challengemaps/Challenge1`
files write `8` (the chunk edge). Both have a 1024-entry offset table. Treating
it as `chunkSize` makes `levels * chunkSize²` come out at a million squares per
chunk and exhausts the heap. **Take geometry from the lotheader.**

### 2.4 Room rectangles exclude the south and east walls

A wall is drawn on the **north or west edge** of a square, so a building's south
wall lives on the row below its last interior row and its east wall on the column
right of its last interior column — both outside the bounding box of its room
rectangles. Extraction that trusts room bounds loses two of every building's
four walls.

Measured on cell 51_7 building 5: the row at `y+h` carries 11 wall tiles of 11.

Hence `Schematic#margin`: a prefab's grid is its interior **plus one square east
and south**, and rotation must pivot about the interior box.

### 2.5 A square holds up to 12 tiles; a prefab holds 4

`PrefabStructure` declares exactly `Floor`, `FloorFurniture`, `FloorOverlay`,
`Furniture`, one z-level, one tile per layer per square. Lifting a vanilla
building into a prefab is lossy by construction. `config/tile-layers.jsonc`
decides what survives, on the principle that structure beats decoration.

### 2.6 Biome maps store a grey value, not a palette index

256 × 256 indexed PNG per cell, one pixel per square. Vanilla files are
palette-optimised to as few as one entry, and `biomemap_51_7.png` has
`palette[0] = rgb(115,115,115)` — 115 being `TownZone`. Write a full 256-entry
greyscale ramp so index and grey are identical and the distinction stops
mattering.

Biome maps exist for cells with **no** lotpack (4,914 against 4,065 in
Muldraugh); worldgen fills what the map does not.

### 2.7 Tile definitions are not a complete register

`.tiles.txt` lists only tiles that declare *properties*. `walls_detailing_02`
starts at index 4, and `jumbo_tree_01_0` is used by 1,804 of Muldraugh's 4,065
cells while appearing in no definition file at all.

Validate a tile name against **either** its tileset's declared `size` **or** the
tile tables of the shipped lotheaders.

### 2.8 Wall sheets do not share a layout

`walls_exterior_house_01` has west wall at 0, north at 1, corner at 2.
`walls_commercial_01` has *windows* at 0 and 1 and doors at 8 and 9.
`walls_garage_01`'s corner is at 34. Hard-coding one layout across kits builds
walls out of windows, silently.

**Derive kits from the catalogue by declared role.** Corner tiles name their own
partners via `CornerNorthWall` / `CornerWestWall`, which is authoritative.

### 2.9 `WallType` does not identify a wall

Some sheets declare it, some do not (`walls_exterior_house_01` carries only
`WallN` and a lowercase `wall`). Facing is the property every wall sheet has —
but facing alone over-counts, because `overlay_grime_wall_01_*` are dirt decals
with wall-ish properties. The test is: **has a facing role and is not a
`WallOverlay`.**

### 2.10 Static modules compete; the first one in the list wins

`WorldGenChunk.genRandomSquare` filters `worldgen.static_modules` for every
module covering the square and then takes **`get(0)`**. There is no z-order and
no blending: every other module covering that square is discarded. And
`applyPrefab` treats a `Floor` entry of `0` not as "leave this square alone" but
as "paint the biome's bare ground here".

Together those two sentences are worth more than anything else in this section.
They mean a prefab emitted from a *bounding box* claims every square in the box,
including the empty ones, and blanks whatever else wanted them.

pz-world emitted biomes, then road patches, then buildings. A road patch is the
bounding box of whatever a street painted inside a 32 × 32 lattice cell — for a
diagonal street, most of the cell, 65% of it zeroes. Measured on a 2,500 m
payload of Plattsburgh: **1,331 of 5,306 buildings (one in four) sat at least
partly inside a road-patch box, 272 of them entirely, and 14% of every building
square in the city was being replaced with grass.** That is the shop with three
walls missing and a lawn growing through the floor.

The order is a priority list, most specific first: buildings, then roads, then
biomes. It is safe to depend on — `J2SEPlatform.newTable` backs Kahlua tables
with a `LinkedHashMap` and `KahluaTableImpl.iterator` walks `keySet()`, so array
order survives into `WorldGenReader.loadStaticModules`.

Better still, do not rely on it alone: `tools/simulate.js` asserts that no
module's real tiles ever fall inside an earlier module's box. Full detail in
[docs/WORLDGEN.md](docs/WORLDGEN.md).

Every module is also a **per-square cost**, not a load-time one: that stream
runs once for each of the 64 squares in every chunk the game ever generates. A
2,500 m city is about 17,000 modules. Cut them where you can — road patches on a
32-square lattice rather than per segment, biome blocks merged into runs and
then stacked into rectangles.

### 2.11 The world map is read from `worldmap.xml.bin`, and the XML reader is broken

`WorldMapDataAssetManager.startLoading` chooses like this:

```java
if (Files.exists(path + ".bin")) new FileTask_LoadWorldMapBinary(...)
else                             new FileTask_LoadWorldMapXML(...)
```

Every shipped map has a `.bin`. The XML reader is therefore never exercised,
and it does not work. Compare the two where they hand a ring of points to
`WorldMapPoints.setPoints(short firstPoint, short pointCount)`:

```java
// WorldMapBinary — correct
short n = readShort();                       // a POINT count
setPoints((short)buffer.position(), (short)n);

// WorldMapXML — wrong
int before = buffer.position();
...write 2 shorts per point...
setPoints((short)before, (short)(buffer.position() - before));   // 2n
```

`getX(i)` reads `buffer.get(firstPoint + i * 2)` and `calculateBounds` loops to
`numPoints()`, so the XML path walks twice as far as it wrote and falls off the
end of the cell's point buffer. Every feature throws
`IndexOutOfBoundsException` out of `WorldMapXML.parseFeature` — 32,670 of them
in one session here — and the map comes up blank with no error the player can
see. **No arrangement of XML avoids it**: the over-read is exactly proportional
to the data, so padding cannot outrun it.

So a generated map has to ship a `.bin`, and Lua cannot write one:
`getModFileWriter` returns an `OutputStreamWriter` over **UTF-8**, so every byte
above 0x7F becomes two and a coordinate of 200 is 0xC8. The mod writes the XML;
the helper compiles it. `src/formats/worldmap.js` has the format, and the
writer reproduces all six shipped binaries byte for byte.

Two traps inside the format itself:

- **`widthInCells`/`heightInCells` are a record count, not a coordinate range.**
  The `cellX`, `cellY` in each record are absolute, and the grid starts at the
  map's own origin: Kingsmouth is 5 × 5 records covering cells 117-121.
- **The origin is not stored.** It is recoverable from the position of the first
  non-empty record, and it is *not* the lowest cell present — Muldraugh's forest
  map declares 78 × 63 and has no cell above y = 3 because its first four rows
  are empty. Guessing the minimum slides the whole map four cells north, and
  still round-trips, because every cell carries its own coordinates.

### 2.12 Nothing puts a vehicle in the world but a zone

Project Zomboid does not scatter cars. Every vehicle comes from a `ParkingStall`
zone — a rectangle in a map's `objects.lua`, one per parking space, named after
the distribution to draw from. Muldraugh declares **9,693** of them, 7,663 with
an empty name (the default mix) and the rest picking `good`, `bad`, `burnt`,
`police`, `trafficjamn` and so on.

A generated map that declares none has an empty kerb from one end of the county
to the other, which is exactly how pz-world looked.

`objects.lua` is read once per lot directory by
`media/lua/server/metazones/metazoneHandler.lua` on `OnLoadMapZones`, and a file
created during the build would not resolve by name anyway (§1.11) — but that
handler does nothing a mod cannot do itself. For a `ParkingStall` it ends at

```lua
getWorld():registerVehiclesZone(name, type, x, y, z, width, height, properties)
```

which is a plain Lua call, and `properties` is nil for every stall vanilla
registers. Measured here: the build finishes at `OnPreMapLoad` and
`OnLoadMapZones` fires seven seconds later, so planning during the build and
registering on that event lands the zones beside vanilla's own.

### 2.13 A worldgen prefab is one storey and has no roof, by declaration

`PrefabStructure.<init>` opens with

```java
this.categories = List.of("Floor", "FloorFurniture", "FloorOverlay", "Furniture");
```

Four categories, hard-coded, and `dimensions` is `int[2]`. `StaticModule` has no
z field and `genRandomSquare` calls `applyPrefab` with a literal `0` for the
level. There is no roof layer and no second storey to put one on, and no
argument about it: buildings from this route are ground floors.

Walls themselves are real. `WorldGenTile.applyTile` routes through
`CellLoader.DoTileObjectCreation` — the same call the map loader uses for an
authored cell — so a wall tile becomes the same `IsoObject` it would in
Muldraugh. Measured over 66,967 tile references in the generated prototypes:
13,106 walls, 3,679 doorframes, 2,388 windows and 578 hoppable tiles, almost all
of the last being `fixtures_railings_01`. Rotation does not turn walls into
windows either — the four rotations of the house set carry 258/254/249/246 wall
tiles.

### 2.14 Kerb facing is not in the tile definitions

`street_curbs_01` declares nothing but `FloorOverlay` and `attachedFloor` for
all 80 tiles — no `WallN`, no facing, nothing to key off. So it was measured
instead: every square in 60 Muldraugh cells carrying a curb tile, against which
of its four neighbours is road surface and which is pavement.

| tile | road lies | so the kerb square is on the | n |
|---|---|---|---|
| `street_curbs_01_9`  | east  | **west** side  | 7,441 |
| `street_curbs_01_11` | west  | **east** side  | 6,863 |
| `street_curbs_01_10` | north | **south** side | 7,228 |
| `street_curbs_01_8`  | south | **north** side | 7,174 |

93–95% agreement in each case. The independent check is `highway_NS_00`, which
puts `_9` at its west edge and `_11` at its east edge.

**The diagonal sheets are a sequence, not a tile.** `street_curbs_01_diag` and
`street_curbs_01_diag_2` appear in runs of six consecutive indices (0–5, 40–45)
with road on three or four sides — they are laid *along* a 1:1 run inside the
carriageway, in order. Substituting `..._diag_0` for the whole sheet, as pz-world
did, is the right artwork in at most one of the four diagonal directions.

### 2.15 Spawn points are absolute world coordinates

B42 `spawnpoints.lua` uses `{ posX = 411, posY = 9761, posZ = 0 }`. The B41 form
with `worldX`/`worldY` cell indices plus an offset is not what the shipped files
use.

---

## 3. Working without a debugger

There is no JDK, no decompiler and no Lua interpreter on a typical modding
machine. Three tools in `tools/` replace them.

### 3.1 `classdump.js` — read the game's actual logic

A class-file reader and bytecode tracer. It resolves the constant pool and
prints every method call, field access and branch in order, which is enough to
follow control flow.

```bash
node tools/classdump.js <file.class>                 # list methods
node tools/classdump.js <file.class> createGroups    # trace one method
```

Extract classes first: `unzip projectzomboid.jar "zombie/MapGroups*"`.

This is how the `common/media/maps` bug in 1.1 was found. Guessing had already
failed three times.

### 3.2 `mapgroups.js` — answer "will my map be listed?" offline

Reimplements `createGroups` against the filesystem, so world grouping can be
checked without launching the game.

```bash
node tools/mapgroups.js pzworld
```

Its rules are pinned by `test/mapgroups.test.js`. **Note its limitation:** it
originally reproduced the *intended* algorithm rather than the shipped one, so it
reported success while the game failed. It now models the `common/` gate. If the
simulator and the game ever disagree again, the simulator is wrong.

### 3.3 `luacheck.js` — catch a missing `end` before it costs a launch

Strips comments and strings and balances Lua block openers against `end` /
`until`. Not a parser, but it catches the mistake that actually happens.

```bash
node tools/luacheck.js mod-src/client/PZWorld_Probe.lua
```

Validate the checker against known-good vanilla files when you change it.

### 3.4 `simulate.js` — see the world without launching the game

The geometry half of the build — orientation, footprint snapping, occupancy,
the road bands, the patch lattice, the map file — is transcribed into
`tools/simulate.js` and run against a real helper payload:

```bash
node tools/simulate.js                       # uses Zomboid/Lua/pzworld_data.txt
PZW_MAP_OUT=out.xml node tools/simulate.js   # also writes the worldmap.xml
```

It reports what actually decides whether the world looks right: how many
buildings were dropped for overlapping a neighbour, how many pavement squares
were refused because a carriageway already owned them, and — the one that
matters — whether any module's tiles fall inside an earlier module's box.

Before this existed, the only way to see the effect of a one-line change to
`Roads.lua` was to quit the game, reinstall the mod, start a new world and walk
to a junction. Three wrong theories about the road bands cost an afternoon each
that way. `test/roads.test.js` pins the same code against a brute-force
rasteriser.

The §6.2 rule still applies: this is a model of the Lua, not the Lua, and a
passing model is a hypothesis until the game agrees. It catches the failures
that are geometric, which is most of them.

### 3.5 The in-game probe — measure, do not infer

`MapGroups`, `ActiveMods`, `getMapInfo` and `getModInfoByID` are all exposed to
Lua. When offline reasoning disagrees with the game, ship a `pcall`-guarded
probe that prints the game's own answers to `console.txt`.

The probe that cracked 1.1 reported, in one launch: active mod sets, resolved
mod directories, `fileExists` on our files, `getMapInfo` for our map and two
vanilla controls, three `createGroups` overloads with full group contents, and
`hasChoices()`.

**Lesson worth keeping:** every hypothesis before that probe was wrong, and the
probe was cheaper than any one of them.

---

## 4. Source data

### 4.1 Overpass returns whole ways

`out geom` returns a way's **entire** geometry whenever any part of it touches
the bounding box. One river clipping a corner once turned a 900 m request into a
9,431 × 28,327 world of 4,256 mostly-empty cells.

Take the extent from the **request**, never from the features. Drop buildings and
land cover outside it; **clip** roads with a vertex of slack so a road crossing
the map still reaches both edges.

### 4.2 Clamp painting at the world boundary

A road's bands stack outward from its centreline and can round to a square just
outside the world. Project Zomboid indexes cells from zero, so one stray negative
square allocates a cell that cannot exist.

### 4.3 OSM is what makes types work

`shop=supermarket`, `amenity=hospital`, `building=house` are the reason
"stores where stores go" is possible. FEMA USA Structures has eight occupancy
classes and no shop types. The cost is ODbL attribution, which is written into
the generated `mod.info`.

---

## 5. Node and Windows

- **`import.meta.url` comparison.** On Windows it is `file:///C:/...` with three
  slashes. Hand-building `file://${process.argv[1]}` never matches, so the script
  silently does nothing and exits 0. Use `pathToFileURL(process.argv[1]).href`.
- **ESM absolute paths.** `import('C:/...')` fails with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Keep scripts inside the project and use
  relative specifiers.
- **Bound every parsed length.** A mis-parsed binary record with an absurd length
  will allocate gigabytes before failing. Reject implausible values at the read
  and report the byte offset.

---

## 6. Rules of engagement

Learned the hard way on this project:

1. **Measure before changing.** Three consecutive fixes to `map.info` were
   reasoned from bytecode and all three were wrong, because the failure was two
   layers away. One probe settled it.
2. **A passing offline test is not proof.** `mapgroups.js` passed while the game
   failed. An offline model is a hypothesis until the game agrees.
3. **Quit the game before reinstalling.** See 1.5.
4. **Silent failures dominate here.** A wrong tile renders blank, a transposed
   cell parses cleanly, an unscanned map still answers `fileExists`. Assert on
   content, not on absence of errors.
5. **Keep the vanilla control.** Probe your map *and* a vanilla map. A field that
   is nil for both means your API assumption is wrong, not your data.
