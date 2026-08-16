--[[
    Ground and vegetation.

    Build 42 does most of this for us. Its world generator populates ground,
    plants, bushes and trees from a biome selected per area, so we place no
    trees at all — we say what kind of place each patch is and let the game fill
    it. The result matches everything else in the world.

    ## Everything here works in blocks, never in squares

    The first version rasterised land cover one square at a time into a Lua
    table. That is fine for roads, which are sparse, and catastrophic for area
    fills: a single OSM `landuse=forest` polygon at a 2.5 km radius can cover
    millions of squares, and a table with one entry per square both takes
    minutes to fill and exhausts the heap. It hung and crashed exactly there.

    So the whole stage runs at BLOCK resolution — 16x16 squares per cell of the
    grid, 256 times less work and memory — which is all the output needs anyway,
    because biomes are emitted as rectangles, not per square.

    Polygons arrive largest-first from the helper, so last-write-wins gives the
    right answer: a park inside a residential district overwrites the district.
]]

require "PZWorld/Config"
require "PZWorld/Canvas"

local Config = PZWorld.Config
local Ground = {}
PZWorld.Ground = Ground

--[[
    Biome pixel values to entries of `worldgen.biomes`.

    **These have to be worldgen biome names, not biome-map names.** The pixel
    values are the ones `config/osm-tags.jsonc` assigns, and they were named for
    `media/lua/server/metazones/BiomeMapConfig.lua` — `townhouse`, `dirt`,
    `farm_forest`, `primary_forest`. Those names exist, but in
    `worldgen.biomes_map`, which is the table the *shipped map cells* use.
    Static modules go through `worldgen.biomes`, and that table holds a
    different and much shorter list:

        birch_forest  flower_plain  grass_plain  light_birch_forest
        light_oak_forest  light_pine_forest  oak_forest  pine_forest
        sand_bank  water

    Six of the nine old names were not in it, so `worldgen.biomes[name]` was nil
    and `toModules` quietly emitted nothing for them: every forest, every field
    and every park in the payload produced no module at all. Only water and
    birch scrub ever worked. And pixel 64 — `landuse=grass`, `leisure=park`,
    every playing field — had no entry here in the first place.
]]
Ground.BIOME_FOR_PIXEL = {
    [0] = "water",
    [64] = "grass_plain",         -- grass, parks, pitches
    [115] = "grass_plain",        -- residential / commercial / retail / industrial
    [128] = "flower_plain",       -- farmyard, meadow
    [141] = "grass_plain",        -- farmland
    [204] = "light_oak_forest",   -- orchard
    [217] = "light_birch_forest", -- scrub
    [254] = "grass_plain",        -- construction, quarry
    [255] = "pine_forest",        -- wood, forest
    -- 200 (car park) is deliberately absent: it is paved square by square, so
    -- its blocks are excluded from the biome pass anyway, and a biome there
    -- would only be a chance to grow a tree through the tarmac.
}

--- A car park is not vegetation. This is what it is surfaced with.
Ground.PARKING_PIXEL = 200
Ground.PARKING_TILE = "blends_street_01_86"

--- Squares per block edge. Finer costs modules and memory; coarser and a park
--- stops being park-shaped. 16 keeps a city's blocks recognisable.
Ground.BLOCK = 16

local function blockKey(bx, by)
    return bx * 65536 + by
end

Ground.blockKey = blockKey

--[[
    Fill a polygon into the block grid.

    Scanlines run at block resolution: one row per BLOCK squares, and each span
    marks whole blocks. The cost is proportional to the polygon's area in
    blocks, so a forest covering a quarter of the map is a few thousand writes
    rather than a few million.
]]
function Ground.fillPolygon(canvas, pts, n, pixel)
    if n < 6 then return 0 end
    local B = Ground.BLOCK

    local minY, maxY = math.huge, -math.huge
    for i = 2, n, 2 do
        local y = pts[i]
        if y < minY then minY = y end
        if y > maxY then maxY = y end
    end

    -- Clamp to the world before converting, so a polygon stretching far outside
    -- the canvas costs nothing.
    if minY < 0 then minY = 0 end
    if maxY > Config.WORLD_SQUARES - 1 then maxY = Config.WORLD_SQUARES - 1 end
    if minY > maxY then return 0 end

    local byMin = math.floor(minY / B)
    local byMax = math.floor(maxY / B)
    local painted = 0
    local xs = {}

    for by = byMin, byMax do
        -- Sample at the middle of the block row.
        local y = by * B + B * 0.5
        local count = 0
        local j = n - 1
        for i = 1, n, 2 do
            local xi, yi = pts[i], pts[i + 1]
            local xj, yj = pts[j], pts[j + 1]
            if yi ~= yj then
                local lower = yi < yj and yi or yj
                local upper = yi < yj and yj or yi
                if y >= lower and y < upper then
                    count = count + 1
                    xs[count] = xj + ((y - yj) / (yi - yj)) * (xi - xj)
                end
            end
            j = i
        end

        if count >= 2 then
            -- Insertion sort: these lists are tiny and table.sort allocates.
            for a = 2, count do
                local v = xs[a]
                local b = a - 1
                while b >= 1 and xs[b] > v do
                    xs[b + 1] = xs[b]
                    b = b - 1
                end
                xs[b + 1] = v
            end
            for k = 1, count - 1, 2 do
                local x1 = xs[k]
                local x2 = xs[k + 1]
                if x1 < 0 then x1 = 0 end
                if x2 > Config.WORLD_SQUARES - 1 then x2 = Config.WORLD_SQUARES - 1 end
                if x2 >= x1 then
                    for bx = math.floor(x1 / B), math.floor(x2 / B) do
                        canvas:setBiomeBlock(bx, by, pixel)
                        painted = painted + 1
                    end
                end
            end
        end
    end
    return painted
end

--[[
    Pave a car park, square by square.

    Land cover is rasterised at block resolution because a forest can span
    millions of squares and a biome only needs a rectangle. A car park is
    different on both counts: it is small, and it is a *surface*, so it has to
    go on the canvas as tiles like a road does.

    Anything already painted is left alone — a road crossing the lot stays a
    road — and so is anything a building stands on.
]]
function Ground.paveArea(canvas, pts, n, tile, ctx)
    if n < 6 then return 0 end

    local minY, maxY = math.huge, -math.huge
    for i = 2, n, 2 do
        local y = pts[i]
        if y < minY then minY = y end
        if y > maxY then maxY = y end
    end
    if minY < 0 then minY = 0 end
    if maxY > Config.WORLD_SQUARES - 1 then maxY = Config.WORLD_SQUARES - 1 end
    if minY > maxY then return 0 end

    local painted = 0
    local xs = {}
    local occupied = ctx and ctx.occupied

    for y = math.ceil(minY), math.floor(maxY) do
        local count = 0
        local j = n - 1
        for i = 1, n, 2 do
            local xi, yi = pts[i], pts[i + 1]
            local xj, yj = pts[j], pts[j + 1]
            if yi ~= yj then
                local lower = yi < yj and yi or yj
                local upper = yi < yj and yj or yi
                if y >= lower and y < upper then
                    count = count + 1
                    xs[count] = xj + ((y - yj) / (yi - yj)) * (xi - xj)
                end
            end
            j = i
        end

        if count >= 2 then
            for a = 2, count do
                local v = xs[a]
                local b = a - 1
                while b >= 1 and xs[b] > v do
                    xs[b + 1] = xs[b]
                    b = b - 1
                end
                xs[b + 1] = v
            end
            for k = 1, count - 1, 2 do
                local x1 = math.ceil(xs[k])
                local x2 = math.floor(xs[k + 1])
                if x1 < 0 then x1 = 0 end
                if x2 > Config.WORLD_SQUARES - 1 then x2 = Config.WORLD_SQUARES - 1 end
                for x = x1, x2 do
                    if not canvas:get(x, y, "Floor")
                        and not (occupied and occupied(x, y)) then
                        canvas:set(x, y, "Floor", tile)
                        painted = painted + 1
                    end
                end
            end
        end
    end
    return painted
end

--[[
    Every block a prefab module covers, which is every block a biome module must
    keep off.

    `WorldGenChunk.genRandomSquare` collects the static modules whose box
    contains the square and then uses `get(0)` — the **first** one — so modules
    do not layer, they compete. A biome module overlapping a road or a building
    does not tint it, it deletes it.

    The blocks come from the patch boxes and the placement rectangles rather
    than from marks made while painting: land cover is painted after the roads
    and used to overwrite those marks, which is how a `landuse=forest` polygon
    came to sit on top of a street.
]]
function Ground.builtBlocks(canvas, placements)
    local B = Ground.BLOCK
    local blocks = canvas:coveredBlocks(B)
    for _, p in ipairs(placements) do
        for by = math.floor(p.y / B), math.floor((p.y + p.h - 1) / B) do
            for bx = math.floor(p.x / B), math.floor((p.x + p.w - 1) / B) do
                blocks[bx * 65536 + by] = true
            end
        end
    end
    return blocks
end

--[[
    Reduce the block grid to rectangular static modules.

    Every module here is one more thing `WorldGenChunk.genRandomSquare` streams
    over for **every square of every chunk the game ever generates** — 64 squares
    a chunk, each doing a full linear scan of the list. So the merge is not
    tidiness, it is the difference between a world that streams and one that
    stutters.

    Two passes: blocks become horizontal runs, then runs of identical extent and
    value stack into rectangles. A forest is a rectangle; a row-only merge would
    make it one module per sixteen-square row. On a 2,500 m payload of
    Plattsburgh the second pass turns 4,897 modules into 3,285 — less than it
    sounds like it should, because in town the runs are punctured row by row by
    the blocks the roads and buildings already own, and only open country merges
    into tall rectangles.

    @param excluded  set of block keys a prefab already owns; see builtBlocks
]]
function Ground.toModules(canvas, excluded)
    local B = Ground.BLOCK
    local blocks = canvas.biomeBlocks
    if not blocks then return {} end

    -- Group by row so runs can be found along x.
    local rows = {}
    local rowOrder = {}
    for k, pixel in pairs(blocks) do
        if pixel ~= Config.BIOME_DEFAULT and not (excluded and excluded[k]) then
            local by = k % 65536
            local bx = (k - by) / 65536
            local row = rows[by]
            if not row then
                row = {}
                rows[by] = row
                rowOrder[#rowOrder + 1] = by
            end
            row[bx] = pixel
        end
    end

    table.sort(rowOrder)

    -- Horizontal runs, kept in row order and keyed by extent so the vertical
    -- pass can find the run directly above.
    local runs = {}
    local open = {}

    for _, by in ipairs(rowOrder) do
        local row = rows[by]
        local xsList = {}
        for bx in pairs(row) do xsList[#xsList + 1] = bx end
        table.sort(xsList)

        local seen = {}
        local i = 1
        while i <= #xsList do
            local startBx = xsList[i]
            local pixel = row[startBx]
            local endBx = startBx
            -- Extend while the next block is adjacent and the same value.
            while i + 1 <= #xsList
                and xsList[i + 1] == endBx + 1
                and row[xsList[i + 1]] == pixel do
                i = i + 1
                endBx = xsList[i]
            end
            i = i + 1

            local key = startBx .. ":" .. endBx .. ":" .. pixel
            seen[key] = true
            local run = open[key]
            if run and run.endBy == by - 1 then
                -- Same extent, same value, directly below: grow it downward.
                run.endBy = by
            else
                run = { bx0 = startBx, bx1 = endBx, by0 = by, endBy = by, pixel = pixel }
                open[key] = run
                runs[#runs + 1] = run
            end
        end

        -- A run not repeated on this row can never grow again.
        for key, run in pairs(open) do
            if not seen[key] and run.endBy < by then open[key] = nil end
        end
    end

    local modules = {}
    for _, run in ipairs(runs) do
        local name = Ground.BIOME_FOR_PIXEL[run.pixel]
        local biome = name and worldgen and worldgen.biomes and worldgen.biomes[name]
        if biome then
            modules[#modules + 1] = {
                position = {
                    xmin = run.bx0 * B,
                    xmax = run.bx1 * B + B - 1,
                    ymin = run.by0 * B,
                    ymax = run.endBy * B + B - 1,
                },
                biome = biome,
            }
        end
    end
    return modules
end

return Ground
