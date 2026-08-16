--[[
    Getting the freshly written map in front of the player *this* session.

    `PZWorld/WorldMap.lua` writes `common/media/maps/PZWorld/worldmap.xml`
    during the build. Both the world map and the minimap look for exactly that
    file — and neither of them finds it, because of when they look it up rather
    than where.

    Both do the same thing:

        local file = 'media/maps/'..dir..'/worldmap.xml'
        if fileExists(file) then mapAPI:addData(file) end

    and `fileExists` is `new File(ZomboidFileSystem.getString(path)).exists()`.
    `getString` answers from `activeFileMap`, a `HashMap` built once when the
    mods are scanned, and returns its argument unchanged when the key is
    missing — at which point the path is relative to the game's install
    directory and of course does not exist. Our file is created several minutes
    after that map was built, so for the rest of the session it is invisible by
    name. It resolves fine on the *next* launch, which is a memorable way to
    conclude the code is fine and the machine is haunted.

    An absolute path sidesteps it: `getString` cannot relativise a path outside
    the game folder, so it hands it straight back — which also means
    `fileExists` on an absolute path is a plain `File.exists()` and can be
    trusted. So each map screen is wrapped, and after vanilla has done its pass
    we add the same file again by its absolute name.

    The guard is `fileExists` on the relative path: if that answers true then
    the file was there at startup, vanilla has already loaded it, and adding it
    a second time would draw every building twice.

    ## Nothing is added until the helper has compiled it

    The game reads `worldmap.xml` only when there is no `worldmap.xml.bin`
    beside it, and its XML reader is broken — `WorldMapXML` hands
    `WorldMapPoints.setPoints` a count of shorts where the binary reader hands a
    count of points, so it reads twice as far as it wrote and throws
    `IndexOutOfBoundsException` out of every single feature. That is a blank map
    and 32,670 stack traces, which is worse than a blank map on its own.

    The helper compiles the XML to `.bin` within a second of the build finishing
    (see helper/serve.js). Until that file exists there is nothing worth adding,
    so this says so once and leaves the map alone.
]]

require "PZWorld/Config"
require "PZWorld/WorldMap"

local WorldMap = PZWorld.WorldMap

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
            log("the map has not been compiled yet (" .. path .. ".bin is missing).")
            log("  the helper does that a second after the build finishes: npm run helper")
            log("  adding the .xml instead would throw once per feature, so it is left alone")
        end
        return false
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
