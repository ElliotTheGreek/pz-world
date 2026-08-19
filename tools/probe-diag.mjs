import fs from 'node:fs';

const inventory = JSON.parse(fs.readFileSync('library/asset-inventory.json', 'utf8'));
const wanted = new Set([
  'street_curbs_01_diag_0', 'street_curbs_01_diag_1',
  'street_curbs_01_diag_2', 'street_curbs_01_diag_3',
  'street_curbs_01_diag_2_0', 'street_curbs_01_diag_2_1',
  'street_curbs_01_diag_2_2', 'street_curbs_01_diag_2_3',
]);
const assets = inventory.assets.filter((asset) => wanted.has(asset.name));
for (const asset of assets) {
  console.log(JSON.stringify({
    name: asset.name,
    orientation: asset.orientation,
    variant: asset.variant,
    supportStatus: asset.supportStatus,
    observed: asset.observed,
    evidence: asset.evidence,
  }));
}
