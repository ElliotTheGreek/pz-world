--[[
    The build driver, in the server Lua state.

    Two constraints decide where this runs, and both were learned the hard way:

      1. `worldgen` is declared in media/lua/server/WorldGen/WorldGen.lua, so it
         exists **only in the server Lua state**. A client script that writes
         `worldgen.static_modules` fills a fresh global of its own and the real
         generator never sees it — that produced an empty forest.

      2. Server scripts are not loaded at the main menu. They come up when a
         world starts. So the build cannot happen when the player clicks a
         button on the menu; at that moment this file does not exist yet.

    Hence the split. The menu panel fetches the map data over the bridge, which
    is the slow part and the part worth watching. This assembles the world
    during the loading screen, which is where the server state is finally alive
    and, conveniently, where the player already expects to wait.

    Assembly is a blocking loop rather than one step per tick: during loading
    there is no frame to be polite to, and finishing before the first chunks
    generate is the whole point.
]]

require "PZWorld/Config"
require "PZWorld/Bridge"
require "PZWorld/Build"
require "PZWorld/Prototypes/init"

local Config = PZWorld.Config
local Bridge = PZWorld.Bridge
local Build = PZWorld.Build

local Server = {}
PZWorld.Server = Server

local function log(msg)
    print("PZWORLD/server: " .. tostring(msg))
end

local function safe(label, fn)
    local ok, err = pcall(fn)
    if not ok then log("error in " .. label .. ": " .. tostring(err)) end
    return ok
end

local function publish(done, err)
    local progress, message = Build.progress()
    safe("publish", function()
        Bridge.writeProgress({ progress = progress, message = message, done = done, err = err })
    end)
end

--[[
    Run the whole build to completion.

    Progress is written to the bridge and logged every so often, so a build that
    stalls says where. The step cap is a runaway guard, not a budget: each step
    already does a bounded slice of work.
]]
function Server.runBuild(order)
    log(string.format("building %s at %.4f, %.4f radius %d",
        order.name or "?", order.lat, order.lon, order.radius))

    if worldgen == nil then
        log("FATAL: worldgen is nil in this state; the world cannot be populated")
        publish(true, "worldgen unavailable")
        return false
    end

    Build.start(order)

    local steps = 0
    local lastStage = nil
    while Build.isRunning() and steps < 2000000 do
        Build.step()
        steps = steps + 1
        local s = Build.state
        if s and s.stage ~= lastStage then
            lastStage = s.stage
            log(string.format("  %s ... %d%%", tostring(s.stage), math.floor((s.progress or 0) * 100)))
            publish(false, nil)
        elseif steps % 500 == 0 then
            publish(false, nil)
        end
    end

    local s = Build.state
    if not s then
        log("build produced no state")
        return false
    end
    if s.err then
        log("failed: " .. tostring(s.err))
        publish(true, s.err)
        return false
    end

    local prefabs = 0
    if worldgen.prefabs then
        for _ in pairs(worldgen.prefabs) do prefabs = prefabs + 1 end
    end
    local modules = worldgen.static_modules and #worldgen.static_modules or 0

    log(string.format("done in %d steps: %d buildings, %d prefabs, %d static modules, %d biome modules",
        steps, s.stats.placed, prefabs, modules, s.biomeCount or 0))
    log(string.format("median snap residual %.1f deg; %d footprints had no prototype; "
        .. "%d too small; %d dropped for overlapping a neighbour",
        Build.medianResidual(), s.stats.noProto, s.stats.skipped, s.stats.overlapped or 0))
    log(string.format("map written with %d features; %d parking stalls planned",
        s.mapFeatures or 0, s.stalls and #s.stalls or 0))
    log(string.format("world bearing %.2f deg; street alignment %d%% -> %d%%",
        s.bearing or 0, math.floor((s.alignBefore or 0) * 100), math.floor((s.alignAfter or 0) * 100)))

    Server.built = {
        lat = order.lat, lon = order.lon, radius = order.radius,
        reveal = order.reveal, placed = s.stats.placed, modules = modules,
    }
    Server.stalls = s.stalls
    publish(true, nil)
    return true
end

--[[
    Hand the parking stalls to the game.

    Not during the build. `registerVehiclesZone` lives on the metagrid, and the
    moment vanilla itself uses it is `OnLoadMapZones` — where
    `media/lua/server/metazones/metazoneHandler.lua` walks every map's
    `objects.lua` and registers the zones it finds. Measured on this machine the
    build finishes at `OnPreMapLoad` and `OnLoadMapZones` fires seven seconds
    later, so by the time this runs the stalls have been planned and the zones
    go in beside vanilla's own.
]]
function Server.registerVehicles()
    local stalls = Server.stalls
    if not stalls then return end
    Server.stalls = nil

    local placed, err = PZWorld.Vehicles.register(stalls)
    if err then
        log(string.format("parked %d of %d cars; %s", placed, #stalls, err))
    else
        log(string.format("parked %d cars in %d stalls", placed, #stalls))
    end
end

--[[
    When to build.

    This has been wrong three times, so it is no longer a guess. The mod's
    server file loads at boot (proven: "driver loaded" appears at start-up), but
    `OnGameBoot` has already fired by then, so a handler added here never runs.

    So every plausible world-lifecycle event is registered, each one logs that it
    fired, and the **first** one to arrive with `worldgen` available runs the
    build. That both fixes the timing and records the real order for next time —
    the log will show exactly which event won.

    Earliest first: the modules must be in place before WorldGenChunk asks for
    them, because chunks already generated are never revisited.
]]
Server.done = false

local CANDIDATES = {
    "OnPreMapLoad",
    "OnInitWorld",
    "OnLoadMapZones",
    "OnPreGameStart",
    "OnPostMapLoad",
    "OnGameStart",
    "OnNewGame",
}

local function attempt(eventName)
    log("event " .. eventName .. " fired; worldgen is " .. (worldgen and "available" or "NIL"))
    if Server.done then return end
    if worldgen == nil then
        log("  worldgen not ready at " .. eventName .. "; waiting for a later event")
        return
    end
    local order
    safe("readOrder", function() order = Bridge.readBuildOrder() end)
    if not order then
        log("  no build order; leaving the world as shipped")
        Server.done = true
        return
    end
    Server.done = true
    log("  building at " .. eventName)
    Server.runBuild(order)
end

for _, name in ipairs(CANDIDATES) do
    safe("hook " .. name, function()
        local ev = Events[name]
        if ev then
            ev.Add(function() safe(name, function() attempt(name) end) end)
        else
            log("event " .. name .. " does not exist in this build")
        end
    end)
end

--- Vehicle zones go in where vanilla puts its own, and again at the start in
--- case a build ran late enough to miss it.
safe("vehicleHooks", function()
    if Events.OnLoadMapZones then
        Events.OnLoadMapZones.Add(function()
            safe("registerVehicles", Server.registerVehicles)
        end)
    end
    Events.OnGameStart.Add(function()
        safe("registerVehicles", Server.registerVehicles)
    end)
end)

--- Report once the game is actually running, so the log shows what was applied.
safe("startHook", function()
    Events.OnGameStart.Add(function()
        if Server.built then
            log(string.format("world in play: %d buildings from %.4f, %.4f",
                Server.built.placed, Server.built.lat, Server.built.lon))
        end
    end)
end)

log("driver loaded")
