--[[
    The in-game map and the minimap.

    Both were blank. Not broken — blank. Project Zomboid does not draw the world
    map from the world; it draws it from `media/maps/<map>/worldmap.xml`, a
    vector file of polygons tagged `building`, `highway`, `natural` and `water`.
    Muldraugh ships six megabytes of it. pz-world shipped none, so `M` opened an
    empty sheet of paper and the minimap had nothing to put in its corner.

    A city that does not exist until the player names it cannot ship that file,
    so it has to be written during the build. Three things make that possible:

      1. **The file is text.** Project Zomboid's Lua writes text and only text
         (DEV_GUIDE §1.6), which rules out writing map cells but not this.

      2. **A mod can write inside itself.** `getModFileWriter(id, path, ...)`
         resolves to `<mod>/common/<path>` — traced through
         `LuaManager$GlobalObject.getModFileWriter`, which concatenates
         `getCommonDir()` and creates the parent directories. `common/` is
         exactly where the map has to live anyway (DEV_GUIDE §1.1), so
         `media/maps/PZWorld/worldmap.xml` lands where `MapUtils` looks for it.

      3. **The geometry is already here.** By the time this runs the roads have
         been rotated onto the world grid, the buildings have been placed, and
         the land cover has been rasterised. The map is a second rendering of
         the same three things.

    ## Coordinates are cell-local

    Each `<cell x= y=>` holds features whose points are relative to that cell's
    origin. They may overrun it — the shipped `challengemaps/Studio` map has a
    road running from 0 to 300 in a 300-square cell — but not far, because
    `WorldMapData` stores and culls features per cell. So every feature is
    assigned to the cell holding its centre and long roads are cut into pieces
    first.

    ## Only these tags draw anything

    `ISMapDefinitions.lua` builds the style from a fixed set of filters, and a
    feature carrying anything else is parsed and then never drawn:

        natural=forest   water=river   railway=*
        highway=primary|secondary|tertiary|trail
        building=yes|Residential|CommunityServices|Hospitality|
                 Industrial|Medical|RestaurantsAndEntertainment|
                 RetailAndCommercial

    Note that roads are **polygon** layers, not lines: a road on the map is a
    quad as wide as the road, not a stroked centreline.
]]

require "PZWorld/Config"
require "PZWorld/Ground"

local Config = PZWorld.Config
local WorldMap = {}
PZWorld.WorldMap = WorldMap

WorldMap.FILE = "media/maps/" .. Config.MAP_NAME .. "/worldmap.xml"

local CELL = Config.CELL_SIZE

--- Our building classes to the seven the map style knows how to colour.
WorldMap.BUILDING_CLASS = {
    house = "Residential",
    apartment = "Residential",
    retail = "RetailAndCommercial",
    grocery = "RetailAndCommercial",
    office = "RetailAndCommercial",
    gas_station = "RetailAndCommercial",
    restaurant = "RestaurantsAndEntertainment",
    bar = "RestaurantsAndEntertainment",
    medical = "Medical",
    civic = "CommunityServices",
    education = "CommunityServices",
    church = "CommunityServices",
    police = "CommunityServices",
    fire = "CommunityServices",
    industrial = "Industrial",
    warehouse = "Industrial",
    garage = "Industrial",
    farm = "Industrial",
    shed = "Industrial",
}

--- Our road classes to the four the map style knows how to colour.
WorldMap.HIGHWAY_CLASS = {
    motorway = "primary",
    trunk = "primary",
    primary = "primary",
    secondary = "secondary",
    residential = "tertiary",
    service = "tertiary",
    cycleway = "trail",
    footway = "trail",
    track = "trail",
}

--- Land-cover pixels to the two area layers that exist. Everything else — town
--- ground, farmland, grass — has no map layer at all, so it is left out rather
--- than tagged with something that would not draw.
WorldMap.COVER_CLASS = {
    [0] = { "water", "river" },
    [204] = { "natural", "forest" },
    [217] = { "natural", "forest" },
    [255] = { "natural", "forest" },
}

--- A road drawn on the map is this many squares wide, by class.
WorldMap.MAP_WIDTH = {
    primary = 10,
    secondary = 8,
    tertiary = 6,
    trail = 3,
}

--- Longer than this and a road is cut, so no feature strays far outside the
--- cell that owns it.
WorldMap.MAX_SEGMENT = 96
--- A vertex closer than this to the line through its neighbours is dropped.
WorldMap.SIMPLIFY_TOLERANCE = 2.0

-- --------------------------------------------------------------- accumulation

function WorldMap.new()
    return { cells = {}, order = {}, features = 0 }
end

local function cellBuffer(w, cx, cy)
    if cx < 0 or cy < 0 or cx >= Config.CANVAS_CELLS or cy >= Config.CANVAS_CELLS then return nil end
    local k = cx * 1000 + cy
    local buf = w.cells[k]
    if not buf then
        buf = { cx = cx, cy = cy, parts = {} }
        w.cells[k] = buf
        w.order[#w.order + 1] = k
    end
    return buf
end

--[[
    Add one closed polygon, in world squares.

    @param pts flat {x1,y1,...} — at least three points
    @param n   number of entries in pts
]]
function WorldMap.addPolygon(w, pts, n, propName, propValue)
    if n < 6 then return end

    local sx, sy = 0, 0
    for i = 1, n, 2 do
        sx = sx + pts[i]
        sy = sy + pts[i + 1]
    end
    local count = n / 2
    local cx = math.floor((sx / count) / CELL)
    local cy = math.floor((sy / count) / CELL)

    local buf = cellBuffer(w, cx, cy)
    if not buf then return end

    local ox, oy = cx * CELL, cy * CELL
    local parts = buf.parts
    parts[#parts + 1] = "  <feature>\r\n   <geometry type=\"Polygon\">\r\n    <coordinates>\r\n"
    for i = 1, n, 2 do
        parts[#parts + 1] = string.format("     <point x=\"%d\" y=\"%d\"/>\r\n",
            math.floor(pts[i] - ox + 0.5), math.floor(pts[i + 1] - oy + 0.5))
    end
    parts[#parts + 1] = string.format(
        "    </coordinates>\r\n   </geometry>\r\n   <properties>\r\n" ..
        "    <property name=\"%s\" value=\"%s\"/>\r\n   </properties>\r\n  </feature>\r\n",
        propName, propValue)
    w.features = w.features + 1
end

--- An axis-aligned rectangle, which is what a building and a land-cover run are.
function WorldMap.addRect(w, x, y, rw, rh, propName, propValue)
    WorldMap.addPolygon(w, { x, y, x + rw, y, x + rw, y + rh, x, y + rh }, 8, propName, propValue)
end

-- ------------------------------------------------------------------ features

function WorldMap.addBuilding(w, p)
    local cls = WorldMap.BUILDING_CLASS[p.requested] or WorldMap.BUILDING_CLASS[p.cls] or "yes"
    WorldMap.addRect(w, p.x, p.y, p.w, p.h, "building", cls)
end

--[[
    Drop vertices that say nothing.

    OpenStreetMap ways carry a vertex every few metres along a curve. Every one
    of them would become its own quad on the map, so a vertex is kept only if it
    is more than `tol` off the line through its neighbours, or if the run since
    the last kept vertex has grown longer than `maxLen`.
]]
function WorldMap.simplify(pts, n, tol, maxLen)
    if n <= 4 then return pts, n end
    local out = { pts[1], pts[2] }
    local ax, ay = pts[1], pts[2]

    for i = 3, n - 2, 2 do
        local x, y = pts[i], pts[i + 1]
        local bx, by = pts[i + 2], pts[i + 3]
        local dx, dy = bx - ax, by - ay
        local len = math.sqrt(dx * dx + dy * dy)
        local dev
        if len < 1e-6 then
            dev = math.sqrt((x - ax) * (x - ax) + (y - ay) * (y - ay))
        else
            dev = math.abs((x - ax) * dy - (y - ay) * dx) / len
        end
        local run = math.sqrt((x - ax) * (x - ax) + (y - ay) * (y - ay))
        if dev > tol or run > maxLen then
            out[#out + 1] = x
            out[#out + 1] = y
            ax, ay = x, y
        end
    end

    out[#out + 1] = pts[n - 1]
    out[#out + 1] = pts[n]
    return out, #out
end

--- One road, as a run of quads of its map width.
function WorldMap.addRoad(w, road)
    local cls = WorldMap.HIGHWAY_CLASS[road.cls]
    if not cls then return end
    local half = (WorldMap.MAP_WIDTH[cls] or 4) / 2

    local pts, n = WorldMap.simplify(road.pts, road.n,
        WorldMap.SIMPLIFY_TOLERANCE, WorldMap.MAX_SEGMENT)

    for i = 3, n, 2 do
        local ax, ay = pts[i - 2], pts[i - 1]
        local bx, by = pts[i], pts[i + 1]
        local dx, dy = bx - ax, by - ay
        local len = math.sqrt(dx * dx + dy * dy)
        if len >= 1 then
            -- Cut long runs so no quad strays far outside its own cell.
            local pieces = math.ceil(len / WorldMap.MAX_SEGMENT)
            local nx, ny = -dy / len * half, dx / len * half
            for k = 1, pieces do
                local t0 = (k - 1) / pieces
                local t1 = k / pieces
                local x0, y0 = ax + dx * t0, ay + dy * t0
                local x1, y1 = ax + dx * t1, ay + dy * t1
                WorldMap.addPolygon(w, {
                    x0 + nx, y0 + ny,
                    x1 + nx, y1 + ny,
                    x1 - nx, y1 - ny,
                    x0 - nx, y0 - ny,
                }, 8, "highway", cls)
            end
        end
    end
end

--[[
    Land cover, taken from the biome block grid rather than from the source
    polygons.

    It is already a rasterisation of exactly the right thing at 16-square
    resolution, the runs merge into rectangles, and a rectangle can be cut on a
    cell boundary — which an arbitrary polygon cannot, without clipping code
    that would exist only for this.
]]
function WorldMap.addCover(w, canvas)
    local B = PZWorld.Ground.BLOCK
    local blocks = canvas.biomeBlocks
    if not blocks then return end

    local rows, rowOrder = {}, {}
    for k, pixel in pairs(blocks) do
        if WorldMap.COVER_CLASS[pixel] then
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

    for _, by in ipairs(rowOrder) do
        local row = rows[by]
        local xs = {}
        for bx in pairs(row) do xs[#xs + 1] = bx end
        table.sort(xs)

        local i = 1
        while i <= #xs do
            local startBx = xs[i]
            local pixel = row[startBx]
            local endBx = startBx
            -- Stop a run at the cell boundary as well as at a change of value,
            -- so every rectangle belongs wholly to one cell.
            local cellLimit = (math.floor((startBx * B) / CELL) + 1) * CELL
            while i + 1 <= #xs
                and xs[i + 1] == endBx + 1
                and row[xs[i + 1]] == pixel
                and (xs[i + 1] * B + B) <= cellLimit do
                i = i + 1
                endBx = xs[i]
            end
            i = i + 1

            local tag = WorldMap.COVER_CLASS[pixel]
            WorldMap.addRect(w, startBx * B, by * B, (endBx - startBx + 1) * B, B, tag[1], tag[2])
        end
    end
end

-- ------------------------------------------------------------------- writing

local function openWriter()
    if not getModFileWriter then return nil, "getModFileWriter is not available" end
    local wr = getModFileWriter(Config.MOD_ID, WorldMap.FILE, true, false)
    if not wr then return nil, "could not open " .. WorldMap.FILE end
    return wr
end

--[[
    Leave a valid but empty document behind at the start of a build.

    A half-written file is worse than no file: `PZXmlUtil.parseXml` throws on
    it, and that throw comes out of the map screen rather than out of the build.
    So the file is emptied when the build begins and only filled in once every
    feature has been generated.
]]
function WorldMap.reset()
    local wr, err = openWriter()
    if not wr then return false, err end
    wr:write("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<world version=\"1.0\">\r\n</world>\r\n")
    wr:close()
    return true
end

function WorldMap.write(w)
    local wr, err = openWriter()
    if not wr then return false, err end

    wr:write("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<world version=\"1.0\">\r\n")
    for _, k in ipairs(w.order) do
        local buf = w.cells[k]
        wr:write(string.format(" <cell x=\"%d\" y=\"%d\">\r\n", buf.cx, buf.cy))
        -- One write per feature, not per line: the writer is unbuffered and a
        -- city is a couple of hundred thousand lines.
        wr:write(table.concat(buf.parts))
        wr:write(" </cell>\r\n")
    end
    wr:write("</world>\r\n")
    wr:close()
    return true
end

--[[
    The absolute path the file was written to.

    The client needs it because `ZomboidFileSystem.activeFileMap` is built when
    the mods are loaded and never again, so a file created during the build does
    not resolve by its relative name for the rest of the session — `fileExists`
    returns false and the vanilla map skips it. `getString` passes an
    unrecognised path through unchanged, so an absolute one reaches the parser.
]]
function WorldMap.absolutePath()
    if not getModInfoByID then return nil end
    -- Guarded because this is a Java object reached through Kahlua: a method
    -- that is not exposed reads as a nil index rather than as an error, and a
    -- probe that fails silently is the trap DEV_GUIDE §1.10 is about.
    local ok, common = pcall(function()
        local info = getModInfoByID(Config.MOD_ID)
        if not info then return nil end
        return info:getCommonDir()
    end)
    if not ok or not common or common == "" then return nil end
    return common .. "/" .. WorldMap.FILE
end

return WorldMap
