--[[
    The build driver.

    This is the part the player watches. It runs as a state machine stepped from
    OnTick, doing a bounded amount of work per frame, so the world is assembled
    visibly rather than behind a frozen window. Every stage reports progress and
    a line of text saying what it is doing.

    The output is two Lua tables the game's own generator consumes:

        worldgen.prefabs[name]     a PrefabStructure
        worldgen.static_modules    { {position = {...}, prefab = ...}, ... }

    `zombie/iso/worldgen/WorldGenChunk` reads those as it generates each chunk on
    the WorldGenerateThread, which is why no map file has to be written and why
    the same shipped canvas can become any city on Earth.
]]

require "PZWorld/Config"
require "PZWorld/Bridge"
require "PZWorld/Geo"
require "PZWorld/Canvas"
require "PZWorld/Roads"
require "PZWorld/Buildings"
require "PZWorld/Ground"
require "PZWorld/WorldMap"
require "PZWorld/Vehicles"

local Config = PZWorld.Config
local Bridge = PZWorld.Bridge
local Geo = PZWorld.Geo
local Canvas = PZWorld.Canvas
local Roads = PZWorld.Roads
local Buildings = PZWorld.Buildings
local WorldMap = PZWorld.WorldMap
local Vehicles = PZWorld.Vehicles

local Build = {}
PZWorld.Build = Build

Build.state = nil

--- Weight of each stage in the overall progress bar, roughly by cost.
local STAGES = {
    { id = "request",   label = "Asking the helper for map data",   weight = 0.02 },
    { id = "waiting",   label = "Downloading OpenStreetMap data",   weight = 0.20 },
    { id = "loading",   label = "Reading map data",                 weight = 0.18 },
    { id = "orienting", label = "Finding which way the city faces", weight = 0.04 },
    { id = "buildings", label = "Placing buildings",                weight = 0.20 },
    { id = "roads",     label = "Laying roads",                     weight = 0.22 },
    { id = "ground",    label = "Painting ground and vegetation",   weight = 0.06 },
    { id = "parking",   label = "Paving car parks and parking cars", weight = 0.04 },
    { id = "mapping",   label = "Drawing the map",                  weight = 0.06 },
    { id = "emitting",  label = "Handing the world to the game",    weight = 0.04 },
}

local function stageIndex(id)
    for i, s in ipairs(STAGES) do
        if s.id == id then return i end
    end
    return 1
end

--- Overall progress: everything before this stage, plus this stage's share.
local function overall(stageId, frac)
    local idx = stageIndex(stageId)
    local base = 0
    for i = 1, idx - 1 do base = base + STAGES[i].weight end
    return base + STAGES[idx].weight * math.max(0, math.min(1, frac or 0))
end

function Build.isRunning()
    return Build.state ~= nil and not Build.state.finished
end

function Build.progress()
    local s = Build.state
    if not s then return 0, "" end
    return s.progress or 0, s.message or ""
end

function Build.error()
    return Build.state and Build.state.err or nil
end

--- Begin a build. `params` = {lat, lon, radius, seed, name}
function Build.start(params)
    Build.state = {
        params = params,
        stage = "request",
        progress = 0,
        message = STAGES[1].label,
        started = getTimestampMs and getTimestampMs() or 0,
        canvas = Canvas.new(),
        placements = {},
        occupancy = Buildings.newOccupancy(),
        stats = { placed = 0, skipped = 0, noProto = 0, overlapped = 0, residual = {} },
        waited = 0,
        cursor = 1,
        finished = false,
    }
    -- Empty the map file now rather than leave the last city's on disk to be
    -- read if this build never reaches the mapping stage.
    local threw, ok, why = pcall(WorldMap.reset)
    if not threw or not ok then
        print("PZWORLD: could not reset the map file: " .. tostring(why or ok))
    end
    Bridge.clearData()
    local ok, err = Bridge.writeRequest(params)
    if not ok then
        Build.state.err = err
        Build.state.finished = true
    end
    Build.state.stage = "waiting"
    return Build.state
end

function Build.cancel()
    Build.state = nil
end

local function fail(s, msg)
    s.err = msg
    s.finished = true
    s.message = msg
end

-- ------------------------------------------------------------------- stages

--- Poll the helper's status file until the payload is ready.
local function stepWaiting(s)
    s.waited = s.waited + 1
    local st = Bridge.readStatus()
    if st then
        if st.stage == "error" then
            return fail(s, "Helper: " .. tostring(st.message))
        end
        s.message = st.message ~= "" and st.message or STAGES[2].label
        s.progress = overall("waiting", st.progress or 0)
        if st.stage == "done" then
            local reader, err = Bridge.openData()
            if not reader then
                -- The status said done but the payload is not readable yet;
                -- give the rename a frame to land before giving up.
                if s.waited > 1200 then return fail(s, err or "no map data") end
                return
            end
            s.reader = reader
            s.stage = "loading"
            s.message = STAGES[3].label
            return
        end
    end
    -- The helper is not running at all if nothing appears for a long time.
    if s.waited > 3600 then
        fail(s, "No response from the pz-world helper. Is it running?")
    end
end

local function stepLoading(s)
    local done = s.reader:step(120)
    s.progress = overall("loading", s.reader:progress())
    s.message = string.format(
        "Reading map data  (%d roads, %d buildings)",
        #s.reader.roads, #s.reader.buildings
    )
    if done then
        if #s.reader.roads == 0 and #s.reader.buildings == 0 then
            return fail(s, "Nothing to build here. Try different coordinates or a larger radius.")
        end
        s.stage = "orienting"
    end
end

--[[
    Choose the world bearing, then convert every feature from metres into world
    squares. Rotating the whole city so its commonest street lands on an axis is
    one number, and it buys more than any per-building cleverness.
]]
local function stepOrienting(s)
    local bearing = Geo.dominantBearing(s.reader.roads)
    local before = Geo.gridAlignment(s.reader.roads, 0)
    local after = Geo.gridAlignment(s.reader.roads, bearing)

    s.bearing = bearing
    s.alignBefore = before
    s.alignAfter = after

    local project = Geo.makeProjector(bearing, Config.ORIGIN_X, Config.ORIGIN_Y, Config.METRES_PER_SQUARE)
    for _, group in ipairs({ s.reader.roads, s.reader.buildings, s.reader.ground }) do
        for _, f in ipairs(group) do
            local p, n = f.pts, f.n
            for i = 1, n, 2 do
                local x, y = project(p[i], p[i + 1])
                p[i], p[i + 1] = x, y
            end
        end
    end

    s.message = string.format(
        "Rotated the city %.1f degrees  (streets on the grid: %d%% to %d%%)",
        bearing, math.floor(before * 100), math.floor(after * 100)
    )
    s.stage = "buildings"
    s.cursor = 1
end

local function stepBuildings(s)
    local list = s.reader.buildings
    local budget = Config.WORK_PER_FRAME
    local i = s.cursor
    local last = math.min(#list, i + budget - 1)

    while i <= last do
        local b = list[i]
        local p, reason = Buildings.place(b, i)
        if p and Buildings.inWorld(p) then
            -- Two buildings may not share a square. `genRandomSquare` takes the
            -- first module covering a square and drops the rest, so overlapping
            -- placements interleave into one building with holes in it rather
            -- than merging. See Buildings.collides.
            if Buildings.collides(s.occupancy, p) then
                s.stats.overlapped = s.stats.overlapped + 1
            else
                Buildings.claim(s.occupancy, p)
                s.placements[#s.placements + 1] = p
                s.stats.placed = s.stats.placed + 1
                s.stats.residual[#s.stats.residual + 1] = math.abs(p.residual)
            end
        elseif reason == "noPrototype" then
            s.stats.noProto = s.stats.noProto + 1
        else
            s.stats.skipped = s.stats.skipped + 1
        end
        i = i + 1
    end
    s.cursor = i

    s.progress = overall("buildings", #list > 0 and (i - 1) / #list or 1)
    s.message = string.format("Placing buildings  (%d of %d)", s.stats.placed, #list)

    if i > #list then
        s.roadCtx = {
            builtUp = Canvas.builtUpMask(s.placements),
            occupied = Canvas.footprintMask(s.placements),
        }
        s.stage = "roads"
        s.roadPhase = Roads.PHASE_SURFACE
        s.cursor = 1
    end
end

--[[
    Roads, in three passes over the whole network.

    Not once per road. A road laying its carriageway, kerb and pavement in one
    go means that at every junction the road painted second puts its *pavement*
    across the road painted first — which is the light band cutting straight
    through the middle of the crossroads. Doing every carriageway before any
    pavement makes that impossible, because the entire road surface of the city
    is on the canvas before a single paving slab is laid.
]]
local PHASE_LABEL = { "surfaces", "pavements", "kerbs" }

local function stepRoads(s)
    local list = s.reader.roads
    -- Roads are far heavier per item than buildings, so a smaller slice.
    local budget = math.max(4, math.floor(Config.WORK_PER_FRAME / 24))
    local i = s.cursor
    local last = math.min(#list, i + budget - 1)

    while i <= last do
        Roads.paint(s.canvas, list[i], s.roadPhase, s.roadCtx)
        i = i + 1
    end
    s.cursor = i

    local total = #list * Roads.PHASES
    local done = (s.roadPhase - 1) * #list + (i - 1)
    s.progress = overall("roads", total > 0 and done / total or 1)
    s.message = string.format("Laying roads  (%s, %d of %d)",
        PHASE_LABEL[s.roadPhase] or "?", i - 1, #list)

    if i > #list then
        if s.roadPhase < Roads.PHASES then
            s.roadPhase = s.roadPhase + 1
            s.cursor = 1
        else
            s.stage = "ground"
            s.cursor = 1
        end
    end
end

--[[
    Ground and vegetation.

    Build 42 populates plants and trees from a biome value per area, so painting
    the right value and letting the game's own generator fill it produces
    forests that match the rest of the world.

    Nothing built gets a biome at all. A biome module and a prefab module
    competing for the same square is a fight the prefab can lose, so every block
    a road patch or a building covers is dropped from the biome pass instead
    (Ground.builtBlocks) — which is also what stops worldgen growing a tree
    through the middle of a house.
]]
local function stepGround(s)
    local list = s.reader.ground
    -- Polygons rasterise at block resolution now, so each one is a few thousand
    -- writes rather than a few million and several fit comfortably in a frame.
    local budget = math.max(2, math.floor(Config.WORK_PER_FRAME / 16))
    local i = s.cursor
    local last = math.min(#list, i + budget - 1)

    while i <= last do
        local g = list[i]
        PZWorld.Ground.fillPolygon(s.canvas, g.pts, g.n, g.pixel)
        i = i + 1
    end
    s.cursor = i
    s.progress = overall("ground", #list > 0 and (i - 1) / #list or 1)
    s.message = string.format("Painting ground  (%d of %d areas)", i - 1, #list)

    if i > #list then
        s.stage = "parking"
        s.cursor = 1
    end
end

--[[
    Car parks, and the cars.

    Project Zomboid puts no vehicles anywhere by itself — it spawns them from
    `ParkingStall` zones, and a map that declares none has an empty kerb from
    one end of the county to the other. See PZWorld/Vehicles.lua.

    A car park is also the one piece of land cover that is a *surface* rather
    than a biome, so it is paved on the canvas at square resolution instead of
    being handed to worldgen as a rectangle of vegetation.
]]
local function stepParking(s)
    local list = s.reader.ground
    s.stalls = s.stalls or {}

    if s.cursor <= #list then
        local budget = math.max(1, math.floor(Config.WORK_PER_FRAME / 32))
        local i = s.cursor
        local last = math.min(#list, i + budget - 1)
        while i <= last do
            local g = list[i]
            if g.pixel == PZWorld.Ground.PARKING_PIXEL then
                PZWorld.Ground.paveArea(s.canvas, g.pts, g.n, PZWorld.Ground.PARKING_TILE, s.roadCtx)
                Vehicles.planArea(s.stalls, g.pts, g.n, s.roadCtx)
            end
            i = i + 1
        end
        s.cursor = i
        s.progress = overall("parking", 0.4 * (i - 1) / math.max(1, #list))
        s.message = string.format("Paving car parks  (%d of %d areas)", i - 1, #list)
        return
    end

    local roads = s.reader.roads
    local i = s.cursor - #list + 1
    if i <= #roads then
        local budget = Config.WORK_PER_FRAME
        local last = math.min(#roads, i + budget - 1)
        while i <= last do
            Vehicles.planStreet(s.stalls, roads[i], s.roadCtx)
            i = i + 1
        end
        s.cursor = #list + i - 1
        s.progress = overall("parking", 0.4 + 0.6 * (i - 1) / math.max(1, #roads))
        s.message = string.format("Parking cars  (%d of %d streets, %d so far)", i - 1, #roads, #s.stalls)
        return
    end

    -- Which blocks a prefab already owns, so the biome pass can keep off them.
    -- Done here rather than while painting, because land cover and car parks are
    -- both laid after the roads: a `landuse=forest` polygon would have
    -- overwritten the mark, and then the forest module would erase the street
    -- underneath it.
    s.message = "Marking built ground"
    s.builtBlocks = PZWorld.Ground.builtBlocks(s.canvas, s.placements)
    s.stage = "mapping"
    s.cursor = 1
end

--[[
    Draw the in-game map.

    Project Zomboid renders the map from a vector file, not from the world, so
    a world that did not exist until a minute ago has to write one. See
    PZWorld/WorldMap.lua for why this can be done from Lua at all.
]]
local function stepMapping(s)
    if not s.map then
        s.map = WorldMap.new()
        s.mapPhase = "buildings"
        s.cursor = 1
    end

    local budget = Config.WORK_PER_FRAME

    if s.mapPhase == "buildings" then
        local list = s.placements
        local i = s.cursor
        local last = math.min(#list, i + budget - 1)
        while i <= last do
            WorldMap.addBuilding(s.map, list[i])
            i = i + 1
        end
        s.cursor = i
        s.progress = overall("mapping", 0.4 * (i - 1) / math.max(1, #list))
        s.message = string.format("Drawing the map  (%d of %d buildings)", i - 1, #list)
        if i > #list then
            s.mapPhase = "roads"
            s.cursor = 1
        end
        return
    end

    if s.mapPhase == "roads" then
        local list = s.reader.roads
        local i = s.cursor
        local last = math.min(#list, i + math.max(4, math.floor(budget / 8)) - 1)
        while i <= last do
            WorldMap.addRoad(s.map, list[i])
            i = i + 1
        end
        s.cursor = i
        s.progress = overall("mapping", 0.4 + 0.4 * (i - 1) / math.max(1, #list))
        s.message = string.format("Drawing the map  (%d of %d roads)", i - 1, #list)
        if i > #list then
            s.mapPhase = "cover"
            s.cursor = 1
        end
        return
    end

    if s.mapPhase == "cover" then
        s.message = "Drawing the map  (land cover)"
        WorldMap.addCover(s.map, s.canvas)
        s.mapPhase = "write"
        s.progress = overall("mapping", 0.9)
        return
    end

    s.message = string.format("Writing the map  (%d features)", s.map.features)
    local ok, err = pcall(WorldMap.write, s.map)
    if not ok then
        -- A missing map is a disappointment, not a reason to throw away a
        -- world that is otherwise finished.
        print("PZWORLD: could not write the map: " .. tostring(err))
    end
    s.mapFeatures = s.map.features
    s.map = nil
    s.stage = "emitting"
    s.cursor = 1
end

--[[
    Hand the finished world to the game.

    Road patches and building prototypes both become entries in
    `worldgen.prefabs`, and every placement becomes a StaticModule. The same
    prototype at the same rotation is registered once however many times the
    city uses it, so a street of forty identical houses costs one prefab and
    forty modules.

    ## The order of `static_modules` decides which one you see

    `WorldGenChunk.genRandomSquare` does this, per square:

        List<StaticModule> hits = staticModules.stream()
            .filter(m -> x >= m.xmin() && x <= m.xmax() &&
                         y >= m.ymin() && y <= m.ymax())
            .collect(toList());
        if (!hits.isEmpty()) { StaticModule m = hits.get(0); ... }

    **`get(0)`.** Modules do not layer and they do not blend: the first one in
    the list wins the square outright and every other module covering it is
    discarded. And `applyPrefab` treats a `Floor` entry of 0 not as "leave this
    alone" but as "paint the biome's bare ground here".

    Those two facts together are what wrecked the buildings. The list was built
    biomes, then road patches, then buildings. A road patch is the *bounding
    box* of whatever a road painted inside a 32x32 lattice cell, which for a
    diagonal street is most of the cell, and 65% of that box is zeroes. So every
    building standing near a street was covered by a road patch that beat it to
    the square and then wrote grass over it.

    Measured on a 2,500 m payload of Plattsburgh: 1,331 of 5,306 buildings —
    one in four — sat at least partly inside a road patch box, 272 of them
    entirely, and 14% of all building squares in the city were being replaced by
    bare ground. That is the building with three walls missing and grass growing
    through the shop floor.

    So the order is now **buildings, then roads, then biomes**: the most
    specific claim on a square first, the vaguest last. Ordering is safe to rely
    on — `worldgen.static_modules` is an array table, `J2SEPlatform.newTable`
    backs Kahlua tables with a `LinkedHashMap`, and `KahluaTableImpl.iterator`
    walks `keySet()`, so insertion order survives into the Java list.

    The biome pass has already dropped every block a prefab covers
    (Ground.builtBlocks), so in practice the third group no longer competes with
    the first two at all. Both defences are kept: the ordering is what makes it
    correct, the exclusion is what makes it cheap.
]]
local function stepEmitting(s)
    worldgen = worldgen or {}
    worldgen.prefabs = worldgen.prefabs or {}

    if not s.emit then
        s.emit = {
            total = s.canvas:patchCount(),
            emitted = 0,
            modules = {},
            i = 1,
            phase = "buildings",
            registered = {},
        }
    end
    local e = s.emit
    local budget = math.max(8, math.floor(Config.WORK_PER_FRAME / 4))

    if e.phase == "buildings" then
        local last = math.min(#s.placements, e.i + budget - 1)
        while e.i <= last do
            local p = s.placements[e.i]
            -- One prefab per prototype and rotation, however many times the
            -- city uses it: a street of forty identical houses is one prefab
            -- and forty placements.
            local name = "pzw_b_" .. p.proto.name .. "_" .. p.rot
            if not e.registered[name] then
                worldgen.prefabs[name] = p.proto.rot[p.rot]
                e.registered[name] = true
            end
            e.modules[#e.modules + 1] = {
                position = { xmin = p.x, xmax = p.x + p.w - 1, ymin = p.y, ymax = p.y + p.h - 1 },
                prefab = worldgen.prefabs[name],
            }
            e.i = e.i + 1
        end
        s.progress = overall("emitting", 0.35 * (e.i - 1) / math.max(1, #s.placements))
        s.message = string.format("Handing buildings to the game  (%d of %d)",
            e.i - 1, #s.placements)
        if e.i > #s.placements then
            e.phase = "patches"
            e.i = 1
        end
        return
    end

    if e.phase == "patches" then
        -- Patches were built as the roads were painted, so this only converts
        -- them to prefabs, a few per frame.
        local last = math.min(e.total, e.i + budget - 1)
        while e.i <= last do
            local patch = s.canvas:patchToPrefab(e.i)
            if patch then
                local name = "pzw_road_" .. patch.x .. "_" .. patch.y
                worldgen.prefabs[name] = patch.prefab
                e.modules[#e.modules + 1] = {
                    position = {
                        xmin = patch.x,
                        xmax = patch.x + patch.prefab.dimensions[1] - 1,
                        ymin = patch.y,
                        ymax = patch.y + patch.prefab.dimensions[2] - 1,
                    },
                    prefab = worldgen.prefabs[name],
                }
                e.emitted = e.emitted + 1
            end
            e.i = e.i + 1
        end
        s.progress = overall("emitting", 0.35 + 0.6 * (e.i - 1) / math.max(1, e.total))
        s.message = string.format("Handing roads to the game  (%d of %d pieces)", e.i - 1, e.total)
        if e.i > e.total then
            e.phase = "biomes"
            e.i = 1
        end
        return
    end

    -- Biomes last, because they are the weakest claim on a square: a module
    -- earlier in the list beats them outright.
    s.message = "Adding ground and vegetation areas"
    local biomeModules = PZWorld.Ground.toModules(s.canvas, s.builtBlocks)
    for _, m in ipairs(biomeModules) do e.modules[#e.modules + 1] = m end
    worldgen.static_modules = e.modules

    s.biomeCount = #biomeModules
    s.patchCount = e.emitted
    s.moduleCount = #e.modules
    s.prefabCount = 0
    for _ in pairs(worldgen.prefabs) do s.prefabCount = s.prefabCount + 1 end

    s.finished = true
    s.progress = 1
    s.message = string.format(
        "World ready: %d buildings, %d road pieces, %d placements",
        s.stats.placed, e.emitted, #e.modules
    )
end

local STEP = {
    waiting = stepWaiting,
    loading = stepLoading,
    orienting = stepOrienting,
    buildings = stepBuildings,
    roads = stepRoads,
    ground = stepGround,
    parking = stepParking,
    mapping = stepMapping,
    emitting = stepEmitting,
}

--- One frame of work. Safe to call when nothing is running.
function Build.step()
    local s = Build.state
    if not s or s.finished then return end
    local fn = STEP[s.stage]
    if not fn then return fail(s, "unknown stage " .. tostring(s.stage)) end
    local ok, err = pcall(fn, s)
    if not ok then fail(s, tostring(err)) end
end

--- Median snap residual, the honest measure of how well this city suited the
--- square grid. Reported when the build finishes.
function Build.medianResidual()
    local s = Build.state
    if not s or #s.stats.residual == 0 then return 0 end
    local r = {}
    for i, v in ipairs(s.stats.residual) do r[i] = v end
    table.sort(r)
    return r[math.ceil(#r / 2)]
end

return Build
