--[[
    The tile canvas and the biome grid.

    Roads are painted square by square into a sparse canvas and only turned into
    prefabs at the end, cut into fixed patches. One prefab per road *segment*
    would be tens of thousands of static modules; one prefab for the whole city
    would be a single array the size of the map. Patches bound both, and empty
    patches cost nothing because they are never emitted.

    Patches are also trimmed to what they actually contain. A diagonal street
    crossing a 32x32 patch touches a few hundred of its 1024 squares, and an
    untrimmed prefab writes the rest as literal zeroes — which was most of the
    emitted data before trimming was added.
]]

require "PZWorld/Config"

local Config = PZWorld.Config
local Canvas = {}
Canvas.__index = Canvas
PZWorld.Canvas = Canvas

Canvas.PATCH = 32

--- The four layers PrefabStructure declares, in its order. There are no others.
Canvas.LAYERS = { "Floor", "FloorFurniture", "FloorOverlay", "Furniture" }

function Canvas.new()
    return setmetatable({
        -- Patches are built as tiles arrive, not collected and swept later.
        -- The earlier design kept every painted square in one table and turned
        -- it into patches at the end; a city paints on the order of a million
        -- squares, which exhausted the heap, and resuming that traversal across
        -- frames is impossible anyway because Kahlua has no `next`.
        patches = {},
        order = {},
        count = 0,
        -- Biomes live on a coarse block lattice, never per square: a land-cover
        -- polygon can span millions of squares. See PZWorld/Ground.lua.
        biomeBlocks = {},
        biomeCount = 0,
    }, Canvas)
end

local PATCH = Canvas.PATCH

local function patchAt(self, x, y)
    local px = math.floor(x / PATCH)
    local py = math.floor(y / PATCH)
    local pk = px * 100000 + py
    local patch = self.patches[pk]
    if not patch then
        patch = {
            ox = px * PATCH, oy = py * PATCH,
            minX = x, minY = y, maxX = x, maxY = y,
            palette = {}, index = {}, layers = {},
        }
        self.patches[pk] = patch
        self.order[#self.order + 1] = pk
    end
    if x < patch.minX then patch.minX = x end
    if y < patch.minY then patch.minY = y end
    if x > patch.maxX then patch.maxX = x end
    if y > patch.maxY then patch.maxY = y end
    return patch
end

--[[
    Place a tile.

    Writes straight into the owning patch's grid. Nothing else happens here: an
    earlier version also marked the square's biome block on every call, which is
    three million table writes for a city and produced the wrong answer anyway,
    because the land-cover polygons are painted *afterwards* and overwrote the
    marks. Blocks that a prefab covers are now excluded once, at emit time, from
    the patch extents themselves — see Ground.toModules.
]]
function Canvas:set(x, y, layer, tile)
    if not tile then return end
    if x < 0 or y < 0 or x >= Config.WORLD_SQUARES or y >= Config.WORLD_SQUARES then return end

    local patch = patchAt(self, x, y)
    local id = patch.index[tile]
    if not id then
        patch.palette[#patch.palette + 1] = tile
        id = #patch.palette
        patch.index[tile] = id
    end
    local grid = patch.layers[layer]
    if not grid then
        grid = {}
        patch.layers[layer] = grid
    end
    local slot = (y - patch.oy) * PATCH + (x - patch.ox)
    if grid[slot] == nil then self.count = self.count + 1 end
    grid[slot] = id
end

--[[
    The tile on a square, or nil.

    Roads need this to know whether a square is already somebody's carriageway
    before laying a pavement over it, which is the whole of the fix for
    pavements running across junctions.
]]
function Canvas:get(x, y, layer)
    local px = math.floor(x / PATCH)
    local py = math.floor(y / PATCH)
    local patch = self.patches[px * 100000 + py]
    if not patch then return nil end
    local grid = patch.layers[layer]
    if not grid then return nil end
    local id = grid[(y - patch.oy) * PATCH + (x - patch.ox)]
    if not id then return nil end
    return patch.palette[id]
end

--[[
    Biome values live on a coarse block lattice, applied through static modules
    rather than tiles.
]]
function Canvas:setBiomeBlock(bx, by, pixel)
    if bx < 0 or by < 0 then return end
    local k = bx * 65536 + by
    if self.biomeBlocks[k] == nil then self.biomeCount = self.biomeCount + 1 end
    self.biomeBlocks[k] = pixel
end

function Canvas:getBiomeBlock(bx, by)
    return self.biomeBlocks[bx * 65536 + by]
end

function Canvas:patchCount()
    return #self.order
end

--[[
    Turn one patch into a prefab, trimmed to the extent it actually used.

    A diagonal street crossing a 32x32 patch touches a few hundred of its 1024
    squares; without trimming the rest would be written out as literal zeroes.

    @param i 1-based index into the patch order
    @return table|nil {x, y, prefab}
]]
function Canvas:patchToPrefab(i)
    local patch = self.patches[self.order[i]]
    if not patch or #patch.palette == 0 then return nil end

    local w = patch.maxX - patch.minX + 1
    local h = patch.maxY - patch.minY + 1
    local offX = patch.minX - patch.ox
    local offY = patch.minY - patch.oy

    local schematic = {}
    for li = 1, #Canvas.LAYERS do
        local layer = Canvas.LAYERS[li]
        local grid = patch.layers[layer]
        if grid then
            local rows = {}
            for ly = 0, h - 1 do
                local row = {}
                for lx = 0, w - 1 do
                    row[lx + 1] = grid[(ly + offY) * PATCH + (lx + offX)] or 0
                end
                rows[ly + 1] = table.concat(row, ",")
            end
            schematic[layer] = rows
        end
    end

    return {
        x = patch.minX,
        y = patch.minY,
        prefab = {
            dimensions = { w, h },
            zombies = 0.0,
            tiles = patch.palette,
            schematic = schematic,
        },
    }
end

--[[
    A cheap "is this square in town" test, built from where buildings actually
    landed rather than from land-use polygons. A town is where the houses are,
    whatever the tags claim. Used to gate pavements the way Terrula gates them
    on built-up landcover fraction.
]]
function Canvas.builtUpMask(placements, radius)
    radius = radius or 24
    local cells = {}
    for _, p in ipairs(placements) do
        local cx = math.floor((p.x + p.w / 2) / radius)
        local cy = math.floor((p.y + p.h / 2) / radius)
        for dx = -1, 1 do
            for dy = -1, 1 do
                cells[(cx + dx) * 100000 + (cy + dy)] = true
            end
        end
    end
    return function(x, y)
        return cells[math.floor(x / radius) * 100000 + math.floor(y / radius)] == true
    end
end

--[[
    "Is this square inside a placed building?"

    A per-square set would be about 1.8 million entries for a city, so the
    rectangles are bucketed on a coarse lattice instead and the test is a bucket
    lookup plus a handful of rectangle comparisons.

    Roads use it to stop laying pavement inside a house. The building would win
    as a static module regardless of what is painted there — this only avoids
    paying for tiles nothing will ever draw.
]]
Canvas.MASK_CELL = 32

function Canvas.footprintMask(placements)
    local C = Canvas.MASK_CELL
    local buckets = {}
    for _, p in ipairs(placements) do
        for gx = math.floor(p.x / C), math.floor((p.x + p.w - 1) / C) do
            for gy = math.floor(p.y / C), math.floor((p.y + p.h - 1) / C) do
                local k = gx * 100000 + gy
                local list = buckets[k]
                if not list then
                    list = {}
                    buckets[k] = list
                end
                list[#list + 1] = p
            end
        end
    end

    return function(x, y)
        local list = buckets[math.floor(x / C) * 100000 + math.floor(y / C)]
        if not list then return false end
        for i = 1, #list do
            local p = list[i]
            if x >= p.x and y >= p.y and x < p.x + p.w and y < p.y + p.h then return true end
        end
        return false
    end
end

--[[
    Every biome block a patch prefab covers.

    `WorldGenChunk.genRandomSquare` takes the **first** static module whose box
    contains the square and ignores the rest, so a biome module overlapping a
    road patch does not blend with it — it replaces it. Blocks reported here are
    dropped from the biome pass so the two sets of modules never overlap.

    The patch's *box* matters, not the squares it actually painted: the module
    the game sees is the box.
]]
function Canvas:coveredBlocks(block, out)
    out = out or {}
    for i = 1, #self.order do
        local patch = self.patches[self.order[i]]
        if patch and #patch.palette > 0 then
            for by = math.floor(patch.minY / block), math.floor(patch.maxY / block) do
                for bx = math.floor(patch.minX / block), math.floor(patch.maxX / block) do
                    out[bx * 65536 + by] = true
                end
            end
        end
    end
    return out
end

return Canvas
