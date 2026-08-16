# Orientation: fitting a real city onto a square grid

This is the problem the whole port turns on, and it has two halves that are not
symmetric. Buildings are hard-constrained. Roads are not.

## Roads can face any way; buildings cannot

A Project Zomboid wall is drawn on the **north or west edge of a square**.
There is no diagonal wall and no diagonal wall tile. So a building occupies one
of four orientations and nothing in between.

Roads are different, and the reason is worth stating precisely because it is
easy to get wrong from memory. Project Zomboid ships **two diagonal kerb
tilesets** — `street_curbs_01_diag` (78 tiles) and `street_curbs_01_diag_2`
(79) — and vanilla uses them in roughly one in six of the Muldraugh cells that
have kerbs at all. Both are declared `FloorOverlay` in
`media/newtiledefinitions.tiles.txt`.

`FloorOverlay` is the important word. The kerbs are painted *on top of* square
ground tiles. The walkable, buildable grid stays axis-aligned while the visible
road edge runs at an angle.

So:

- **roads keep their true bearing**, laid as a stairstep, with diagonal kerb
  artwork wherever the stairstep runs close to 1:1;
- **buildings are snapped** to a quarter-turn, because nothing lets them be
  otherwise.

## The world bearing

Before any building is snapped, the whole city is rotated once so that its
commonest street direction lands on the grid axes. This is one number and it
buys more than anything else in this document: in a gridiron town almost every
building ends up square to its street for free.

`dominantBearing` in `src/geo/orient.js`:

1. Every road segment votes, **weighted by its length**, so an arterial counts
   for more than a cul-de-sac.
2. Angles are folded into `[0°, 90°)`. The space is 90°-periodic — a street and
   the street crossing it are evidence for the *same* grid, and folding makes
   them reinforce rather than cancel.
3. The histogram is smoothed before the peak is taken, so one long straight
   cannot decide the rotation of a city on its own.
4. The peak is refined by a length-weighted circular mean over the winning
   window, computed on the angle ×4 so that the 90°-periodic space maps onto a
   full circle where a circular mean is well defined. Without that the answer
   would be quantised to the bin width.

`gridAlignment` reports the payoff as the length-weighted fraction of road
within 8° of an axis, before and after. The generator prints both:

```
world bearing 2.83° — road alignment to the grid 85.0% → 87.3%
```

Burlington is already close to axis-aligned, so the gain is small. A city laid
at 30° would show something much more dramatic, and a city with no grid at all
would show almost no gain — which is itself the useful signal.

## Snapping a building

`snapFootprint`:

1. **Oriented bounding box.** Rotating callipers over the convex hull finds the
   minimum-area rectangle. A footprint is not a rectangle, but the prefab that
   replaces it is, so what we need from the footprint is *which rectangle, at
   which angle, best stands in for this shape*.
2. **Fold to a quarter.** An OBB's angle and that angle plus 90° describe the
   same rectangle, so only the quarter matters. The residual is the signed
   distance to the nearest axis, always within ±45°.
3. **Extent.** If the box was nearer 90° than 0°, its width and height exchange
   roles.

The prototype is then chosen to fit that extent, at whichever of its two
aspects fits better — a quarter-turn of a prefab is free, so a 12 × 8 prototype
can serve an 8 × 12 plot.

### What the snap actually costs

Measured on Burlington VT, 1,487 buildings placed at a 700 m radius:

| | residual |
|---|---|
| median | **0.7°** |
| 90th percentile | **2.7°** |
| worst | 37.1° |

That is the honest measure of how well a city suits this port, and the
generator prints it every run. A median under a degree means that after the
world rotation, most buildings were already square to the grid. A city with a
median of 15° would come out looking noticeably unlike itself, and the number
tells you before you play.

## Rotating a prefab

Rotating the grid is trivial. Rotating the **walls** is not, because a wall is
not a property of a square — it is a property of a square's north or west
**edge**, and those are the only two edges that exist.

Treating walls as *lattice edges* is what makes the transform exactly closed.
For an interior of `iw × ih` squares the lattice has `(iw+1) × (ih+1)` points.
A north wall stored at cell `(x, y)` is the horizontal edge at lattice point
`(x, y)`; a west wall is the vertical edge there. A quarter-turn clockwise
sends lattice point `(x, y)` to `(ih − y, x)`, and carrying the two edge
orientations through that gives:

```
north wall at (x, y)  →  west  wall at (ih − y,     x)
west  wall at (x, y)  →  north wall at (ih − y − 1, x)
```

with the artwork swapped to its opposite facing in both cases, via the
north/west pairing derived in `src/formats/tiledefs.js`.

### The margin is load-bearing

Every destination above lands inside the `(ih+1) × (iw+1)` grid — including the
padded east column and south row. That is precisely **why the margin has to
exist**. A prefab's grid is its interior plus one square on the east and south,
because that is where Project Zomboid stores those two walls. Pivot about the
padded grid instead of the interior and the north wall lands outside and is
lost.

`Schematic#margin` makes this explicit; road patches, which have no walls, set
it to 0.

### Corners

A square carrying both a north and a west wall needs two wall tiles, and a
prefab has one `Furniture` slot per square. The single tile that draws both is
recovered from the corner tile's own `CornerNorthWall` / `CornerWestWall`
properties.

Real buildings put different wall sheets on adjoining faces — an interior
partition meeting an exterior wall — and no corner tile joins two different
sheets. When that happens the corner is taken from the **north wall's own
sheet**. The result draws a proper corner in the north wall's style, which is a
far better failure than the alternatives: dropping the west wall leaves a hole a
survivor walks through, and putting it on a floor layer draws a wall flat on the
ground.

### Verification

`test/prefab.test.js` checks the maths on synthetic closed boxes, where four
quarter-turns are an exact identity, and then measures what survives contact
with 120 real vanilla buildings:

- all 120 transpose to the correct dimensions;
- **zero** walls end up on a floor layer;
- wall-tile retention:

  | min | p10 | median | p90 | max | mean |
  |---|---|---|---|---|---|
  | 0.667 | 0.970 | **0.993** | 1.037 | 1.083 | **0.994** |

Retention does not land exactly on 1.0 in either direction, and both are
expected. It exceeds 1 because a corner tile is *one* tile carrying *two*
walls, and a quarter-turn sends its halves to different squares, so the pair is
drawn as two tiles afterwards. It falls below 1 because a prefab square holds
one `Furniture` tile, so where a rotation brings a wall and a table onto the
same square, one of them goes.

One building of the 120 falls below 0.9; none falls below 0.5.

## What is genuinely lost

Four-layer prefabs cannot express everything a vanilla square holds. Measured
on cell 51_7, a square carries up to 12 tiles across 8 z-levels; a prefab holds
4 on one level. `config/tile-layers.jsonc` decides what survives, on the
principle that **structure beats decoration** — losing a grime overlay costs
nothing, losing a wall leaves a hole.
