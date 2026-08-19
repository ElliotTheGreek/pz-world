# Vanilla Build 42 tile catalogue

`library/vanilla-tiles.json` is the reproducible, machine-readable inventory of
vanilla tiles available to the asset pipeline. Generate it from the installed
game with:

```sh
npm run catalogue-tiles
npm run verify-catalogue-tiles
# or for a non-default install/output:
node tools/catalogue-vanilla-tiles.mjs --install "/path/to/ProjectZomboid" --out library/vanilla-tiles.json
node tools/verify-vanilla-tiles.mjs library/vanilla-tiles.json
```

The committed inventory was generated from installed Build 42.20.3 data. Its
verified baseline is 59,149 unique names across 483 declared sheets, with 33,568
property-bearing definitions and 26,063 names observed in 4,065 lotheaders. Of
the observed names, 175 are absent from both property definitions and declared
sheet slots. The known omission `jumbo_tree_01_0` is represented and was
observed in 1,804 cells.

## Why two sources are required

Build 42's `media/*.tiles.txt` files are property catalogues, not complete tile
registers. Each tileset declares a width and height, but only sprites with
properties receive a `tile` block. The generator therefore materialises every
index in every declared sheet, including unannotated sprites.

Shipped map lotheaders are an independent source of truth. Their per-cell tile
dictionaries contain valid names absent from `.tiles.txt`, including separately
loaded and irregular sheets. The generator scans every numeric `.lotheader` in
every vanilla map directory and unions those names with the declared sheet
slots and property definitions.

## Record fields

Each `tiles[]` entry contains:

- `name`, `tileset`, and numeric `index` where the conventional suffix is
  available;
- declared sheet `width`, `height`, and `size`;
- source flags for a declared sheet slot, property definition, and observed
  lotheader use;
- `absentFromTileDefinitions` and `outsideDeclaredSheet`, making omissions
  explicit instead of treating them as invalid assets;
- the complete merged property map (later patch definitions win per property);
- `declaredRoles`, the role-bearing property keys;
- exclusive visual `family` and one or more `layerSuitability` values;
- observed lotheader map names and distinct cell count.

The top-level `tilesets[]` table supports sheet-level audits, while `summary`
contains source and family coverage totals.

## Families

The catalogue distinguishes all asset groups required by world generation:

- `structural`: walls, windows, doors, stairs, railings, fencing, and roofs;
- `floor`: interior/exterior floors and natural ground;
- `overlay`: grime, blood, cracks, vines, and floor/wall overlays;
- `vegetation`: trees, bushes, crops, foliage, and ground cover;
- `signage`: road signs, business signs, notices, and advertising;
- `road`: street surfaces and street surface overlays;
- `curb`: straight, blended, and diagonal curb artwork;
- `marking`: traffic lines and curb paint;
- `decorative`: remaining furniture, fixtures, appliances, and props.

Classification is deterministic and intentionally broad. The original name and
all properties remain present, so later semantic registries can refine a family
without rescanning the install.

## Meaning of lotheader usage

`lotheaderUsage.cellCount` counts cells whose tile dictionary mentions the
asset, not actual square placements. It is sufficient to distinguish observed
from unobserved assets and measure geographic spread. Reading lotpacks to count
placements and neighbourhood context is a separate contextual-usage task.
