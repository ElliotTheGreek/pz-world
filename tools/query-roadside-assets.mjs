import fs from 'node:fs';

const inventory = JSON.parse(fs.readFileSync('library/asset-inventory.json', 'utf8'));
const catalogue = JSON.parse(fs.readFileSync('library/vanilla-tiles.json', 'utf8'));
const context = JSON.parse(fs.readFileSync('library/vanilla-tile-context.json', 'utf8'));
const byAsset = new Map(inventory.assets.map((asset) => [asset.name, asset]));
const byContext = new Map(context.tiles.map((tile) => [tile.name, tile]));
const pattern = /^(?:street_decoration_01_(?:0|1|2|3|12|22)|lighting_outdoor_01_(?:0|1|2|3)|street_roadsigns_01_(?:4|8|9|16|17))$/i;
for (const tile of catalogue.tiles) {
  const label = Object.entries(tile.properties ?? {})
    .filter(([key]) => key !== 'streetlight')
    .map(([key, value]) => `${key}=${value}`).join(' ');
  if (!pattern.test(tile.name) && !pattern.test(label)) continue;
  const asset = byAsset.get(tile.name);
  const usage = byContext.get(tile.name);
  console.log(JSON.stringify({
    name: tile.name, placements: asset?.observed?.contextualPlacements ?? 0,
    orientation: asset?.orientation, status: `${asset?.supportStatus}/${asset?.safetyStatus}`,
    layers: asset?.layerSuitability ?? [],
    properties: tile.properties ?? {}, roadContext: usage?.roadContext ?? [],
  }));
}
