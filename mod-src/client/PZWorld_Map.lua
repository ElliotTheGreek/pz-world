--[[
    Making sure the freshly written map is in front of the player.

    ## How the game finds a map, and why it used not to find ours

    Both `ISWorldMap:initDataAndStyle` and `ISMiniMap.InitPlayer` do the same
    thing, and neither of them looks at the world:

        local file = 'media/maps/'..dir..'/worldmap.xml'
        if fileExists(file) then mapAPI:addData(file) end

    `fileExists` is `new File(ZomboidFileSystem.getString(path)).exists()`, and
    `getString` answers from `activeFileMap` — a table built once while the mods
    are scanned. A file created after that is invisible **by name** for the rest
    of the session, and `getString` returns its argument unchanged when the key
    is missing, at which point the path is relative to the install directory and
    of course does not exist. That is why a city built minutes ago drew a blank
    map, and why it drew correctly on the *next* launch: a memorable way to
    conclude the code is fine and the machine is haunted.

    So the fix is not here. `tools/make-canvas.js` now ships the name —
    a stub `worldmap.xml` and an empty `worldmap.xml.bin` — so the lookup
    succeeds at startup and `npm run world` only ever rewrites the `.bin`.
    `WorldMapDataAssetManager.startLoading` prefers a `.bin` sibling whenever
    one is present:

        Files.exists(path + ".bin") ? FileTask_LoadWorldMapBinary
                                    : FileTask_LoadWorldMapXML

    and the XML reader is broken — `WorldMapXML` hands `WorldMapPoints.setPoints`
    a count of shorts where the binary reader hands a count of points, so it
    reads twice as far as it wrote and throws `IndexOutOfBoundsException` out of
    every single feature. The stub therefore exists to be found and never to be
    read.

    ## What is left for this file to do

    Two things, both fallbacks:

      1. A mod installed before the canvas shipped that stub has no name to find.
         An absolute path sidesteps `activeFileMap` entirely — `getString`
         cannot relativise a path outside the game folder, so it hands it back
         unchanged — and that is what this adds.

      2. Saying so, once, when there is nothing to add. A blank map with no
         message in the log is the hardest kind of bug to be told about.

    The guard is `fileExists` on the relative path. If that answers true then
    vanilla has already loaded the file and adding it again would draw every
    building twice.
]]

require "PZWorld/Config"

local Config = PZWorld.Config

-- The two facts this hook needs about the map file. They used to live in a
-- module that also generated a whole world; that module is gone.
local WorldMap = {}
WorldMap.FILE = "media/maps/" .. Config.MAP_NAME .. "/worldmap.xml"

--[[
    The absolute path the map was written to.

    Needed because `ZomboidFileSystem.activeFileMap` is built when the mods are
    scanned and never again, so a file created during a build does not resolve
    by its relative name for the rest of the session — `fileExists` returns
    false and the vanilla map skips it. `getString` passes an unrecognised path
    through unchanged, so an absolute one reaches the parser.
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

local PZWorldMap = {}
PZWorld.MapHook = PZWorldMap

local function log(msg)
    print("PZWORLD/map: " .. tostring(msg))
end

--- True when vanilla's own lookup will already have found the file.
local function vanillaFoundIt()
    local ok, found = pcall(fileExists, WorldMap.FILE)
    return ok and found == true
end

--[[
    Add our data to one map API, once.

    `endDirectoryData()` afterwards closes the batch, which is what vanilla does
    after every directory it adds.
]]
function PZWorldMap.attach(mapAPI, who)
    if not mapAPI then return false end
    if vanillaFoundIt() then return false end

    local path = WorldMap.absolutePath()
    if not path then
        log("cannot resolve the mod's common directory; the map will be blank")
        return false
    end

    -- An absolute path goes through ZomboidFileSystem.getString unchanged, so
    -- this is a straight File.exists() and is answered from disk rather than
    -- from the startup file map.
    local compiled = false
    pcall(function() compiled = fileExists(path .. ".bin") == true end)
    if not compiled then
        if not PZWorldMap.warned then
            PZWorldMap.warned = true
            log("no map data yet: " .. path .. ".bin is missing.")
            log("  build a world first (F7), or run: npm run world -- --lat .. --lon ..")
            log("  the .xml beside it is a stub and is never parsed, so it is left alone")
        end
        return false
    end

    if not PZWorldMap.warned then
        PZWorldMap.warned = true
        log("this install predates the shipped worldmap.xml stub, so vanilla could not")
        log("  find the map by name. Adding it by absolute path instead; re-running")
        log("  `npm run canvas && npm run build` makes this unnecessary.")
    end

    local ok, err = pcall(function()
        mapAPI:addData(path)
        mapAPI:endDirectoryData()
    end)
    if ok then
        log("added " .. path .. " to " .. tostring(who))
    else
        log("could not add map data to " .. tostring(who) .. ": " .. tostring(err))
    end
    return ok
end

local function hook(label, fn)
    local ok, err = pcall(fn)
    if not ok then log("could not hook " .. label .. ": " .. tostring(err)) end
end

hook("ISWorldMap", function()
    if not ISWorldMap or not ISWorldMap.initDataAndStyle then return end
    local original = ISWorldMap.initDataAndStyle
    function ISWorldMap:initDataAndStyle()
        original(self)
        PZWorldMap.attach(self.mapAPI, "world map")
    end
end)

hook("ISMiniMap", function()
    if not ISMiniMap or not ISMiniMap.InitPlayer then return end
    local original = ISMiniMap.InitPlayer
    ISMiniMap.InitPlayer = function(playerNum)
        local outer = original(playerNum)
        -- The minimap does not go through MapUtils; it repeats the lookup
        -- inline on its own inner panel.
        if outer and outer.inner then
            PZWorldMap.attach(outer.inner.mapAPI, "minimap")
        end
        return outer
    end
end)

return PZWorldMap
