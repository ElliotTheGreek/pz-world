# Visual-quality baselines

This directory is the visual-quality contract for generated Project Zomboid maps.
It contains paired **generated** and **vanilla Build 42** 96×96-square captures for
nine representative situations:

- urban
- suburban
- rural
- highway
- bridge
- T-junction
- four-way junction
- curved road
- degraded road

Open `generated-contact-sheet.svg` and `vanilla-contact-sheet.svg` for the quick
comparison. `manifest.json` records the exact source, crop, tile names, topology,
and square counts behind every image. The individual SVGs are deliberately
lossless and diffable: one map square is rendered as one 4×4-pixel block.

## Reproducing the baseline

Run from the repository root with Project Zomboid Build 42 installed:

```sh
node tools/capture-visual-baselines.mjs
```

The generated side uses the best cached Overpass response, preferring one with
bridges, and runs it through the current road painter. The vanilla side scans the
installed `media/maps/Muldraugh, KY` lotheaders and lotpacks. Source OSM way IDs,
tags, vanilla cells, crop coordinates, build number, and generation time are
stored in the manifest. A review must not accept an image whose source semantics
do not match its label merely because the image looks plausible.

The SVG colours are semantic classes, not approximations of the game's tile
art. They make geometry and transitions inspectable without redistributing game
textures. Asset variety is measured from the actual tile names in each square.

## Acceptance procedure

Every renderer change that affects terrain or roads must regenerate this
folder, compare both contact sheets, and apply the criteria below. A sample
passes only when all applicable **geometry**, **transition**, **asset-variety**,
and **semantic-correctness** checks pass. Intentional changes update the
baseline and explain the reason in the commit; unexplained raster movement is a
regression.

Metrics are evaluated inside the 96×96 crop. “Road square” includes carriageway,
curb, marking, and degraded-road classes unless a criterion names one class
specifically. Counts and booleans come from `manifest.json`; connectivity,
edge continuity, and abrupt-width checks are measured on the semantic raster
represented by the SVG.

## Global measurable criteria

### Geometry

1. **Connected carriageway:** all road pixels belonging to the sampled feature
   form one 8-connected component. Isolated road islands are not allowed.
2. **No internal holes:** no background or natural component of 1–2 squares is
   completely enclosed by carriageway. Such holes are rasterisation defects,
   not medians; a real median must be at least 3 squares long and be supported
   by source semantics.
3. **Width stability:** on non-junction sections, the measured perpendicular
   carriageway width stays within `nominalWidth ± 2` squares for at least 90% of
   sampled cross-sections. A source lane-count or class change may define a new
   nominal section.
4. **Topology:** the T-junction has exactly 3 arms and the four-way junction has
   exactly 4 arms, each reaching at least 30 squares from the junction centre.
   No other sample may gain a disconnected or unexplained arm.
5. **Curvature:** the curved-road source has `curveRadians >= 0.35` and its
   rendered centreline changes heading in at least two occupied 8-square bands;
   a straight or single right-angle substitute fails.

### Transitions

1. **Surface continuity:** carriageway remains connected through every bend,
   junction, bridge approach, and crop-visible class transition; there are zero
   one-square gaps across the travel path.
2. **Edge continuity:** each road edge may move laterally by at most 1 square per
   square of forward travel, except within 3 squares of a junction corner. This
   permits raster stairs but rejects spikes and abrupt notches.
3. **Width transitions:** a width change greater than 2 squares must taper over
   at least 4 forward squares. An instantaneous wide-to-narrow seam fails.
4. **Curb/sidewalk exclusion:** curb and sidewalk pixels inside the carriageway
   intersection polygon are zero. At junctions they must terminate or turn the
   corner rather than cross another carriageway.
5. **Bridge approaches:** the carriageway must connect to both approaches with
   zero gaps and no width jump greater than 2 squares. Bridge-edge or railing
   treatment must begin and end within 2 squares of the bridge-tagged extent
   once those assets are supported.
6. **Natural-road edge:** rural and degraded roads must show a visible boundary
   against natural terrain; no sidewalk is permitted unless the OSM source has
   `sidewalk`, `footway`, or equivalent semantics.

### Asset variety

1. Count distinct tile names separately for carriageway, curb, sidewalk,
   markings, and degradation overlays; do not use whole-cell vanilla
   `uniqueTiles` as a direct road-variety comparison because it includes
   buildings and furniture.
2. Every category must use at least **2 road-related tile names**. Urban,
   suburban, highway, bridge, curved-road, and both junction samples must use at
   least **4**. A single repeated surface tile is a failure.
3. Where a layer occupies at least 32 squares, it must contain at least:
   **2 carriageway variants**, **2 edge/transition variants**, and, when
   semantically applicable, **2 marking variants** or **2 degradation variants**.
4. Repetition guard: no one non-structural overlay/variant may cover more than
   80% of the squares in its layer. Base pavement is exempt; cracks, grime,
   grass overlays, and decorative variants are not.
5. Generated road-related variety should reach at least **25% of the matched
   vanilla sample’s road-related tile count**, capped at a required maximum of
   24 names so dense vanilla interiors do not distort the target. The future
   asset catalogue should calculate this automatically from tile families.

### Semantic correctness

1. Source evidence in the manifest must satisfy the category rules in the table
   below. Fallback selection may preserve capture completeness but is marked a
   failed semantic baseline until corrected.
2. Road class, nominal width, lane markings, curb/sidewalk treatment, bridge
   treatment, and degradation must agree with retained OSM tags. Decorative
   inference may add variety but may not contradict explicit tags.
3. Markings must remain on carriageway squares. Curbs must remain on road edges.
   Sidewalks must remain outside curbs. Any layer-order violation fails.
4. A generated category must remain deterministic for identical source, config,
   and seed: source/crop metrics and SVG content must be byte-identical except
   for `generatedAt` in the manifest.

## Category-specific criteria

| Sample | Required source/scene evidence | Additional measurable acceptance |
|---|---|---|
| Urban | `nearbyBuildings >= 20`; drivable road | Curbs and sidewalks on applicable built-up edges; at least 1 marking type on a road of 2+ lanes; no road through building pixels. |
| Suburban | `3 <= nearbyBuildings < 20`; residential/service drivable road | Carriageway, verge/sidewalk, and plots remain distinct; road-related variety >= 4. |
| Rural | `nearbyBuildings <= 2`; not motorway/link or pedestrian-only | Natural/vegetation pixels exceed building pixels; no inferred urban sidewalk; road width matches class within global tolerance. |
| Highway | arterial class or widest retained multi-lane way; nominal width >= 10 or `lanes >= 4` | At least 2 longitudinal marking variants; markings are continuous for >= 80% of eligible straight carriageway; no residential-style sidewalk unless tagged. |
| Bridge | explicit `bridge` tag on a drivable way | `isBridge=true`; two connected approaches; bridge edge/railing assets when available; underlying water/rail/road is not painted over as ordinary ground. |
| T-junction | topology anchor degree 3 | `branches=3`; no sidewalk/curb stripe crosses the junction; all three arms connect. |
| Four-way junction | topology anchor degree 4 | `branches=4`; all four arms connect; opposite arms do not terminate inside the junction; no sidewalk/curb stripe crosses it. |
| Curved road | drivable source with `curveRadians >= 0.35` | Connected bend with at least two heading changes; both edges obey the 1-square lateral-step rule; diagonal/curve transition assets appear where applicable. |
| Degraded road | drivable way with `surface=gravel/dirt/ground/unpaved/compacted`, or explicit procedural decay input | `isDegradedSurface=true` for this source baseline; degradation occupies 10–60% of carriageway, uses >= 2 degradation variants, and does not spill more than 1 square beyond the road edge. |

## Baseline interpretation

These captures describe both the target and the current gap. They are not a
claim that the current generated renderer passes. The initial manifest, for
example, exposes very low generated asset variety and lacks category-specific
bridge, marking, decay, and transition artwork. Those failures are useful:
subsequent pipeline work can be judged against fixed sources, crops, and numeric
criteria rather than subjective screenshots.

Vanilla references are comparison exemplars, not pixel-perfect golden targets.
Generated geography comes from OSM and therefore must preserve its own topology
and semantics; copying a vanilla crop’s exact road area or building density is
neither required nor correct. The vanilla samples establish the expected visual
vocabulary, transition quality, and order of magnitude of contextual variety.
