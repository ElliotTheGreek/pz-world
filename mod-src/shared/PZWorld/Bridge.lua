--[[
    The file bridge between the mod and the helper process.

    Project Zomboid's Lua sandbox cannot open a socket (DEV_GUIDE.md §1.6), so
    the helper does the fetching and the two sides exchange plain text files.
    `getFileWriter` and `getFileReader` resolve relative to **Zomboid/Lua**, not
    Zomboid — verified by finding the probe's output at Zomboid/Lua/.

    There is one thing to say and one thing to hear: the UI writes a build
    order, and the build writes its progress. Nothing else crosses this bridge.

    It used to carry a second channel as well — a request that made the helper
    fetch OSM and write a payload for a Lua reimplementation of the world
    generator. That generator is gone, so the channel is too.
]]

require "PZWorld/Config"

local Config = PZWorld.Config
local Bridge = {}
PZWorld.Bridge = Bridge

-- ------------------------------------------------- client <-> server handoff

--[[
    The order, and the answer.

    `pzworld_build.txt` is read by the helper, which spawns `tools/build-world.js`
    for it. That build writes `pzworld_progress.txt` as it goes and the build
    screen polls it.

    A server-side Lua driver used to read this same file and generate its own
    world from it, so one order ran two generators over the same map directory.
    It is deleted; this file has one reader now.
]]

function Bridge.writeBuildOrder(params)
    local w = getFileWriter(Config.BUILD_FILE, true, false)
    if not w then return false end
    w:write("lat " .. tostring(params.lat) .. "\r\n")
    w:write("lon " .. tostring(params.lon) .. "\r\n")
    w:write("radius " .. tostring(params.radius) .. "\r\n")
    w:write("seed " .. tostring(params.seed or 0) .. "\r\n")
    w:write("reveal " .. tostring(params.reveal and 1 or 0) .. "\r\n")
    w:write("name " .. tostring(params.name or "") .. "\r\n")
    w:write("end\r\n")
    w:close()
    return true
end

--- Progress, written by `tools/build-world.js` and read by the build screen.
--- Also written by the UI once, to clear the last build's result before this
--- one starts — a stale `done 1` would end the new build the moment it opened.
function Bridge.writeProgress(p)
    local w = getFileWriter(Config.PROGRESS_FILE, true, false)
    if not w then return end
    w:write("progress " .. string.format("%.4f", p.progress or 0) .. "\r\n")
    w:write("done " .. (p.done and "1" or "0") .. "\r\n")
    w:write("error " .. tostring(p.err or "") .. "\r\n")
    w:write("message " .. tostring(p.message or "") .. "\r\n")
    w:write("end\r\n")
    w:close()
end

function Bridge.readProgress()
    local r = getFileReader(Config.PROGRESS_FILE, false)
    if not r then return nil end
    local out = {}
    local line = r:readLine()
    while line do
        local key, value = string.match(line, "^(%a+)%s*(.*)$")
        if key then out[key] = value end
        line = r:readLine()
    end
    r:close()
    return {
        progress = tonumber(out.progress) or 0,
        done = out.done == "1",
        err = (out.error ~= nil and out.error ~= "") and out.error or nil,
        message = out.message or "",
        -- The stage drives the checklist on the build screen. Absent means "do
        -- not move the checklist", not "stage zero".
        stage = (out.stage ~= nil and out.stage ~= "") and out.stage or nil,
    }
end

-- ------------------------------------------------------------------ settings

--- Remember the last coordinates entered, so the prompt reopens where the
--- player left off rather than at the default every time.
function Bridge.saveSettings(s)
    local w = getFileWriter(Config.SETTINGS_FILE, true, false)
    if not w then return end
    w:write("lat " .. tostring(s.lat) .. "\r\n")
    w:write("lon " .. tostring(s.lon) .. "\r\n")
    w:write("radius " .. tostring(s.radius) .. "\r\n")
    w:write("name " .. tostring(s.name or "") .. "\r\n")
    w:close()
end

function Bridge.loadSettings()
    local r = getFileReader(Config.SETTINGS_FILE, false)
    if not r then return nil end
    local out = {}
    local line = r:readLine()
    while line do
        local key, value = string.match(line, "^(%a+)%s*(.*)$")
        if key then out[key] = value end
        line = r:readLine()
    end
    r:close()
    if not Config.validCoords(out.lat, out.lon) then return nil end
    return {
        lat = tonumber(out.lat),
        lon = tonumber(out.lon),
        radius = Config.clampRadius(out.radius),
        name = out.name,
    }
end

return Bridge
