# Build 42's world generator as a modding surface

Everything in this file was read out of the shipped install at
`steamapps/common/ProjectZomboid` on **42.20.2** — the Lua under
`media/lua/server/WorldGen/`, and the class constant pools inside
`projectzomboid.jar`.

## What exists

```
zombie/iso/WorldGenerate                 the driver
zombie/iso/WorldGenerate$WorldGenerateThread
zombie/iso/worldgen/ChunksCache          caches generated chunks
zombie/iso/worldgen/WorldGenChunk        applyPrefab, loadStaticModules,
                                         setRoomID, getWorldGenZoneAt
zombie/iso/worldgen/WorldGenReader       reads the Lua tables
zombie/iso/worldgen/PrefabStructure
zombie/iso/worldgen/StaticModule
zombie/iso/worldgen/WorldGenSimplexGenerator
zombie/iso/worldgen/biomes/*             Biome, BiomeRegistry, BiomeType, …
```

and on the Lua side:

```
media/lua/server/WorldGen/
    WorldGen.lua        declares worldgen.{biomes,features,selection,prefabs,
                        veins,roads,attachments,similar,priorities}
    Biomes.lua          loads biomes/subbiomes, biomes/map, biomes/worldgen
    Features.lua        ground, plant, bush, tree, ore feature definitions
    Selection.lua       the ranges that map noise to landscape/temperature/…
    Roads.lua           procedural road hints
    Veins.lua           ore veins
    prefabs/            highway_NS_00.lua, normal_road_WE_00.lua
```

It is generated **at runtime, on a thread, per chunk, and cached**. That is what
makes "the world assembles itself on first load" literally true.

## The three things a mod supplies

### 1. Prefabs

`media/lua/server/WorldGen/prefabs/*.lua`. `PrefabStructure`'s constant pool
gives the whole contract:

```
categories = [ "Floor", "FloorFurniture", "FloorOverlay", "Furniture" ]
dimensions : int[]
tiles      : List<String>
schematic  : Map<String,int[][]>
zombies    : float
```

Four layers, one z-level, one tile per layer per square. The shipped example:

```lua
local highway_NS_00 = {
    dimensions = { 20, 3 },
    zombies = 0.01,
    tiles = {
        "blends_street_01_86",
        "floors_exterior_tilesandstone_01_3",
        "street_curbs_01_9",
        ...
        "walls_garage_02_20"
    },
    schematic = {
        Floor = {
            "2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,0",
            ...
        },
        FloorFurniture = { ... },
        FloorOverlay   = { ... },
        Furniture      = { ... }
    }
}
worldgen.prefabs["highway_NS_00"] = highway_NS_00
```

Indices are 1-based into `tiles`; 0 is empty. Rows are strings of
comma-separated indices, `height` rows of `width` entries.

Note where things go: the road surface is `Floor`, kerbs are `FloorFurniture`,
traffic lines are `FloorOverlay`, and **a wall (`walls_garage_02_20`) is
`Furniture`**. That last one is the only direct evidence of where the game
expects walls, and this project follows it.

There is no rotation field, which is why `src/prefab/schematic.js` generates
rotated variants itself.

### 2. Static modules

`media/maps/<Name>/WorldGenOverride.lua`. `StaticModule` is a record of
`{biome, prefab, xmin, xmax, ymin, ymax}` — so a module places either a prefab
or a biome over a rectangle of world coordinates.

```lua
worldgen["static_modules"] = {
    {
        position = { xmax = 0, ymin = 4800, ymax = 5119 },
        biome = worldgen.biomes.water
    }, {
        position = { xmin = 12590, xmax = 12609, ymax = 900 },
        prefab = worldgen.prefabs.highway_NS_00
    }
}
```

Bounds are **inclusive** — `12609 − 12590 + 1 = 20`, the prefab's width — and a
rect larger than the prefab **tiles it repeatedly**, which is how that example
draws 900 squares of highway from a 20 × 3 prefab. To place something exactly
once, `xmax = xmin + width − 1`. Omitted bounds default open.

#### Modules compete; they do not layer

`WorldGenChunk.genRandomSquare` does this, once per square:

```java
List<StaticModule> hits = staticModules.stream()
    .filter(m -> x >= m.xmin() && x <= m.xmax() &&
                 y >= m.ymin() && y <= m.ymax())
    .collect(Collectors.toList());
if (!hits.isEmpty()) { StaticModule m = hits.get(0); /* ... */ }
```

**`get(0)`.** The first module in the list wins the square outright and every
other module covering it is thrown away. There is no z-order, no blending and no
"the more specific one wins" — only list order.

So the order of `worldgen.static_modules` is a priority list, most specific
first. Ordering is safe to depend on: `J2SEPlatform.newTable` backs every Kahlua
table with a `LinkedHashMap` and `KahluaTableImpl.iterator` walks its
`keySet()`, so an array table reaches `WorldGenReader.loadStaticModules` in
insertion order.

Two corollaries that are easy to get wrong:

- **A biome module placed over a prefab deletes the prefab.** Not tints it.
- **A module whose box is bigger than the thing it draws still claims the whole
  box.** A prefab cut from a bounding box of painted squares owns every square
  in that box, including the empty ones.

#### An empty `Floor` is not "leave this alone"

`WorldGenChunk.applyPrefab` resolves each category with
`getTileRef(cat, lx, ly)` and branches on zero:

```java
if (tileRef == 0) {
    if (!cat.equals("Floor")) continue;      // other layers: nothing happens
    wgTile.setTiles(biome, FeatureType.GROUND, ...);   // Floor: paint ground
}
```

A `Floor` entry of 0 **actively paints the biome's bare ground**. Combined with
the rule above, a mostly-empty prefab does not politely let the world show
through — it erases whatever else wanted that square and lays grass.

That pair of facts is the whole explanation for pz-world's buildings arriving
with three walls missing: road patches were emitted before buildings, a patch is
the bounding box of whatever a street painted inside a 32 × 32 lattice cell, and
65% of that box is zeroes.

#### Indexing inside the prefab wraps

```java
int lx = Math.abs(worldX - xmin) % prefab.getX();
int ly = Math.abs(worldY - ymin) % prefab.getY();
```

`Math.abs` before the modulo, not after, and the modulo is what makes an
oversized box tile. A box *smaller* than the prefab is fine and simply shows the
top-left part of it.

### 3. Biome maps

`media/maps/<Name>/maps/biomemap_<cx>_<cy>.png`, one 256 × 256 indexed PNG per
cell, one pixel per square. `media/lua/server/metazones/BiomeMapConfig.lua`
gives each grey a biome and a zone:

```lua
biome_map_config = {
    { pixel = 0,   zone = "Water" },
    { pixel = 64,  zone = "ForagingNav" },
    { pixel = 96,  biome = "$random",       zone = "DeepForest" },
    { pixel = 102, biome = "townhouse",     zone = "TrailerPark" },
    { pixel = 115, biome = "townhouse",     zone = "TownZone" },
    { pixel = 128, biome = "farmmix_forest",zone = "Farm" },
    { pixel = 141, biome = "farmmix_forest",zone = "FarmLand" },
    { pixel = 254, biome = "dirt",          zone = "ForagingNav" },
    { pixel = 255, biome = "primary_forest",zone = "DeepForest" },
}
```

The value the game reads is the **grey level**, not the palette index — vanilla
files are palette-optimised to as few as one entry, and `biomemap_51_7.png` has
`palette[0] = rgb(115,115,115)`. Writing a full greyscale ramp makes the two
identical.

**`biome_map_config` names are not `worldgen.biomes` names.** The table above
names `townhouse`, `dirt`, `farmmix_forest`, `primary_forest`; those live in
`worldgen.biomes_map`, which is what the shipped biome-map PNGs resolve
against. A *static module* carries a biome table straight to
`WorldGenReader.loadBiome`, and the table you want there is one of
`worldgen.biomes`, which is a different and much shorter list:

```
birch_forest  flower_plain  grass_plain  light_birch_forest
light_oak_forest  light_pine_forest  oak_forest  pine_forest
sand_bank  water
```

Using a biome-map name for a static module is not an error — `worldgen.biomes[name]`
is simply nil and the module is never built. Six of pz-world's nine land-cover
values were named that way, so every forest, field and park in the payload
produced nothing at all and only water and birch scrub ever appeared.

**These exist for cells with no lotpack**: Muldraugh ships 4,914 biome maps
against 4,065 authored cells, covering the full 78 × 63 rectangle. Worldgen
fills what the map does not.

## Biomes, if you want to go further

A biome is a table of weighted features per category, plus parameters that say
which noise conditions select it:

```lua
local pine_forest = {
    features = {
        GROUND = { { f = worldgen.features.GROUND.dark_grass, p = 1.0 } },
        PLANT  = { { f = worldgen.features.PLANT.grass_medium, p = 0.3 }, ... },
        TREE   = { { f = worldgen.features.TREE.pine_jumbo_xxl, p = 0.035415 }, ... }
    },
    params = {
        landscape   = { "FOREST" },
        temperature = { "COLD" },
        hygrometry  = { "DRY", "RAIN" },
        zombies     = 0.001,
        generate    = false
    }
}
worldgen.biomes["pine_forest"] = pine_forest
```

`Selection.lua` maps noise output onto those parameter bands. pz-world does not
define its own biomes — it paints vanilla ones through the biome map, which is
enough to get ground and vegetation that matches the rest of the world.

## What this route cannot do

- **More than one storey.** No level axis in `PrefabStructure`.
- **Room definitions.** Prefabs produce no `RoomDef`, so vanilla loot
  distribution by room name does not apply. `WorldGenChunk.setRoomID` exists and
  may be a route; unexplored.
- **Rotation.** No rotation field; generate the variants yourself.
- **More than four tiles per square**, in fixed layer roles.

The escape hatch for all four is the binary cell route, and the city is built
that way now — see `docs/PZ-FORMATS.md`, `src/emit/lotpack.js` and
`src/emit/world.js`. This route is kept for the countryside outside the
requested radius, where none of the four limits bites and free procedural
terrain looks better than authored flat grass.
