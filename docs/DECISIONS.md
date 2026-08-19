# Decisions

Numbered, dated, and with the reasoning kept — the format Terrula uses, for the
same purpose: so that a choice can be revisited on its merits rather than
rediscovered by accident.

Locked 2026-08-16 unless noted.

---

### D1 — OpenStreetMap, accepting ODbL

Terrula rules OSM out (its PREMISE.md decision D1): it plans a commercially
closed world, and ODbL's share-alike obligation on derived *databases* is a real
risk there.

That reasoning does not carry over. pz-world generates a free mod, and OSM is
the only source that answers the question this project actually asks — *what
kind of building is this?* The public-domain US stack Terrula settled on gives
FEMA USA Structures, whose `OCC_CLS` has eight values and no shop types, so
"stores where stores go" would degrade to "commercial buildings where commercial
buildings go".

Attribution is written into the generated `mod.info` and `README.txt` rather
than left implied.

**Revisit if** this ever ships as something sold, or if a permissive source with
POI semantics appears.

---

### D2 — Node, not Rust

Terrula's baker is Rust and its shapefile reader would have been reusable. But
the target machine has Node 22 and Python 3.14 and **no Rust or Go toolchain**,
and the deliverable is something a player runs once before launching the game.
A `npm install`-free, build-step-free CLI is worth more here than raw speed;
the whole Burlington run is a few seconds of compute against a network fetch.

Zero runtime dependencies. `zlib` for PNG comes from Node's standard library,
and the binary formats, the PNG codec and the tile-definition parser are all
hand-written — the same posture as Terrula's decision D17.

---

### D3 — Two emitters behind one plan

`PlacementPlan` is a plain data structure. Both emitters exist and both are
wired: the worldgen emitter for the countryside outside the requested radius,
and the binary cell emitter (`src/emit/lotpack.js`, driven by
`src/emit/world.js` and `tools/build-world.js`) for the city itself.

Keeping the plan free of emitter concerns is what made the second one a matter
of writing files rather than re-deriving the city. It was also the escape hatch
when worldgen turned out to have a limit we could not live with: `PrefabStructure`
declares four tile layers and no z axis, so multi-storey buildings and roofs are
reachable *only* through the cell route. That is why the city is authored now.

---

### D4 — Roads follow their true bearing; buildings snap

Project Zomboid ships two diagonal kerb tilesets, declared `FloorOverlay`, used
in about one in six vanilla kerb cells. Because they are overlays painted on
square ground, a road's *visible* edge can run at an angle while the walkable
grid stays axis-aligned.

Walls have no equivalent. So roads keep their bearing and stairstep; buildings
are snapped to a quarter-turn. Measured cost on Burlington: median snap residual
0.7°, 90th percentile 2.7°.

See `docs/ORIENTATION.md`.

---

### D5 — One world rotation, chosen from the street network

Rotating the entire city so its commonest street bearing lands on an axis is one
number and it does more than any per-building cleverness. It is computed from
length-weighted, 90°-folded, smoothed segment bearings, and the generator
reports the before/after grid alignment so the benefit is visible rather than
asserted.

`--bearing` overrides it, for a city where the solver picks badly.

---

### D6 — The prefab library is harvested locally and never redistributed

`pz-world extract` lifts ~7,900 buildings out of the player's own Project
Zomboid install. That data is The Indie Stone's. It is written to
`library/extracted/`, which `.gitignore` excludes, and nothing in the pipeline
copies it anywhere else.

A generated map mod references vanilla **tile names**, which is what every
Project Zomboid map mod does and is not redistribution. It does contain building
*layouts* derived from the vanilla map, so a generated mod is fine to keep and
play but should not be published to the Workshop without thinking about it. The
generated `README.txt` says so.

The built-in starter set in `src/prefab/starter.js` is generated from rules and
carries no vanilla layout, so it is unencumbered.

---

### D7 — The biome map is the ground and vegetation channel

B42 reads a 256 × 256 indexed PNG per cell and populates ground, plants, trees
and zones from it. Painting the right grey and letting the game's own generator
fill it produces forests that match everything else in the world, and costs one
small PNG per cell instead of tens of thousands of tile placements.

Everything defaults to forest (grey 96) so the edge of a generated area fades
into wilderness rather than ending at a line, and every footprint and road is
painted `dirt` (254) so worldgen does not grow a tree through a house.

---

### D8 — Determinism is a contract

Nothing calls `Math.random()`. Every choice is drawn from
`streamFor(seed, label, fid)`, and `fid` is a **hash of the feature's geometry**
— never an OSM way id, because a way id changes when a mapper splits a way and a
building whose identity moved would be handed a different prototype for no
visible reason. This is Terrula's decision D16, adopted wholesale.

The practical payoff: two players with the same seed and bounding box get the
same map, and re-running after tuning one config value does not reshuffle the
town.

---

### D9 — Class tables live in config, not code

`config/roads.jsonc`, `config/osm-tags.jsonc`, `config/building-classes.jsonc`,
`config/tile-layers.jsonc`. Adding a shop type or retuning a road width is a
data edit.

JSONC rather than YAML or JSON: these tables need annotating — the reasoning
behind a priority or a width is worth more than the number — and a YAML parser
is a dependency and a footgun. `src/lib/jsonc.js` is 60 lines.

---

### D10 — A prefab's grid carries a one-square east/south margin

Project Zomboid stores a building's south wall on the row *below* its interior
and its east wall on the column *right* of it. A `w × h` interior therefore
needs a `(w+1) × (h+1)` grid to hold all four walls, and rotation must pivot
about the **interior** box or the north wall lands outside the grid.

Discovered the hard way: extraction that trusted the room bounds was losing two
of every building's four walls, verified against Muldraugh 51_7 building 5 where
the row below the interior carries 11 wall tiles out of 11.

---

### D11 — Structure beats decoration when a square is over-full

A vanilla square carries up to 12 tiles; a prefab holds 4. The priority table in
`config/tile-layers.jsonc` resolves the conflict: walls 100, doors 95, windows
90, counters and appliances ~68 (they hold loot), lighting 20, wall grime 10.

Losing a grime overlay costs nothing. Losing a wall leaves a hole a survivor
walks through.

---

### D12 — Two independent registers of "is this a real tile"

A `.tiles.txt` lists only tiles that declare properties, and the shipped maps
reference tiles that appear in no definition file at all — `jumbo_tree_01_0` is
used by 1,804 of Muldraugh's 4,065 cells and is declared nowhere.

So validation accepts a tile if **either** its tileset's declared `size` covers
its index, **or** it appears in a shipped lotheader's tile table. Trusting only
the first produces false alarms on tiles the game itself uses.

---

### D13 — Verify without the game

`pz-world verify` re-reads a generated mod with the same readers that wrote it:
every cell parses, every biome-map grey is one `BiomeMapConfig.lua` gives
meaning to, every prefab's schematic matches its declared dimensions, every tile
name resolves, every static module points at a prefab that exists and sits at
non-negative coordinates.

A wrong prefab does not crash Project Zomboid — it renders a blank square, or a
wall lying flat, and you find out twenty minutes into a save. What verify cannot
check is whether the game *likes* the result; that still needs a play test.

---

### D14 — Validation is layered; loose assets fail closed

An asset is not considered supported merely because its tile name exists. Loose semantic
mappings must pass inventory role, layer, facing, and installed-sheet checks; fixture
builds must preserve topology and ownership; authored files must read back; and runtime
behavior requires a separate in-game observation. The reproducible evidence is generated
by `npm run benchmark-asset-pipeline` and documented in
`docs/ASSET-PIPELINE-VALIDATION.md`.

Unknown or incompatible loose artwork is excluded rather than guessed. Structural and
decorative context-required tiles are only retained inside complete prefabs because a
wall, roof, door, fixture, or container detached from its adjacency and room semantics
can be visually wrong, non-colliding, or lose loot behavior despite resolving as a valid
tile name. Malformed blend blocks and measured contradictory edge declarations are also
excluded; each inventory record preserves the exact reason.

Offline seam, collision-ownership, and format checks are acceptance gates, but they are
not renamed “in-game validation.” Native chunk streaming, collision response, artwork,
and frame pacing pass only when the observational probe and visual route are completed
in a real Build 42 session.

**Revisit if** the catalogue gains measured topology/rotation metadata for an excluded
family, or Project Zomboid exposes a headless runtime capable of loading and walking map
chunks with native collision enabled.

---

### D15 — Vanilla is measured, not imitated from memory

When a question is "what does Project Zomboid's ground look like", the
answer comes from reading the shipped cells, not from reasoning about what would look
good.

Three separate passes were built on plausible reasoning that turned out to be
backwards, and each one is visible from orbit once it is wrong:

- `baseTile` chose ground variants from a low-frequency field, on the reasoning that a
  per-square hash would read as a uniform dither over a whole city. Vanilla uses a
  per-square choice: 25.2 / 25.0 / 24.8 / 25.1 % across Grass_Dark's four variants, mean
  run 1.30 squares. The field reached two of the four and changed them once a screen.
- The patches a player sees are the *material* changing, at a median run of 3 squares and
  a p90 of 19 — an order of magnitude finer than the 110-square field that was meant to
  produce them.
- Road wear was a `d_streetcracks` overlay. Vanilla places **zero** of those in the
  sample and gets its worn look from three asphalt materials in patches, 46 / 34 / 20 %.

Each of these is a twenty-line probe against the install (`tools/audit-tile-usage.mjs`
and the same readers the extractor uses) and each overturned a design decision that had
survived review, tests and a shipped build.

The cost is that a probe is slower to write than an assumption, and that the
measurements are of Muldraugh — a hand-authored Kentucky town, not every place on Earth.
Where a share is a choice rather than a measurement (`REGIONAL_TILT`, `CLASS_AGE`, the
managed-ground profiles) it says so in the code.

**Revisit if** a Build 42 update reshuffles the blend sheets, which would move every
share here at once and is exactly what re-running the probes is for.

---

## Still open

1. **A native crash a few seconds into play.** The first authored build with
   real collision bits stopped mid-frame with no Java exception and no stack
   trace. `chunkdata_*.bin` is the only thing the generator writes that native
   code reads, so it is the first suspect and `WRITE_COLLISION_BITS` is off
   while that is tested. **Unproven** — see `src/emit/chunkdata.js`.
2. **Rotation of roofs and fixtures.** A roof tile declares `WestRoofT/B/M` with
   no north counterpart and a light switch declares no facing at all, so a
   rotated building turned its walls correctly and left its roof and its
   fixtures 90° out. `MAX_TURNS = 1` until a measured rotation table for those
   sheets exists, derived from the shipped maps the way the kerb facings were.
   Costs nothing measurable in fit (`src/plan/place.js`).
3. **Static module count**, for the countryside route that remains.
   `genRandomSquare` scans the whole `static_modules` list per square, so the
   cost is per-square rather than per-load. Not profiled in-game.
4. **`chunkdata` type 5.** Vanilla emits a chunk type `POTChunkData` never
   writes, whose meaning lives only in `PZPopMan64.dll`. Read as "no bits".
5. **Thin library classes.** 5,570 houses against 31 medical and 28 education
   buildings, so a generated city repeats its hospital. Mitigated by the
   fallback chain in `src/plan/place.js`, not solved.
6. **Whether the build screen's timing holds in practice.** The panel writes an
   order, the helper runs the authored build, and the screen blocks the game
   until the progress file says done. That window is the right one — cells must
   be on disk before `IsoWorld.init()`, and `IsoLot.pool` holds handles open
   after — but it has not been played through yet.
