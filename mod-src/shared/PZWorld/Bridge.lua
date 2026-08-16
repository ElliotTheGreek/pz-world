--[[
    The file bridge between the mod and the helper process.

    Project Zomboid's Lua sandbox cannot open a socket (DEV_GUIDE.md §1.6), so
    the helper does the fetching and the two sides exchange plain text files.
    `getFileWriter` and `getFileReader` resolve relative to **Zomboid/Lua**, not
    Zomboid — verified by finding the probe's output at Zomboid/Lua/.

    Reading is incremental on purpose. A city payload is a couple of hundred
    kilobytes and several thousand lines; parsing it in one call would freeze
    the game for exactly as long as it takes, which is the opposite of watching
    a world being built. `Reader:step()` consumes a bounded number of lines and
    returns, so the caller stays in control of the frame.
]]

require "PZWorld/Config"

local Config = PZWorld.Config
local Bridge = {}
PZWorld.Bridge = Bridge

-- ------------------------------------------------------------------ requests

--- Ask the helper for an area. The trailing `end` marks the file complete, so
--- the helper never reads a request that is still being written.
function Bridge.writeRequest(req)
    local w = getFileWriter(Config.REQUEST_FILE, true, false)
    if not w then return false, "could not open " .. Config.REQUEST_FILE end
    w:write("version 1\r\n")
    w:write("lat " .. tostring(req.lat) .. "\r\n")
    w:write("lon " .. tostring(req.lon) .. "\r\n")
    w:write("radius " .. tostring(req.radius) .. "\r\n")
    w:write("seed " .. tostring(req.seed or 0) .. "\r\n")
    w:write("name " .. tostring(req.name or "") .. "\r\n")
    w:write("end\r\n")
    w:close()
    return true
end

--- Delete a stale payload so a previous run's data is never mistaken for this
--- one's. There is no remove API, so it is truncated instead.
function Bridge.clearData()
    local w = getFileWriter(Config.DATA_FILE, true, false)
    if w then
        w:write("")
        w:close()
    end
    local s = getFileWriter(Config.STATUS_FILE, true, false)
    if s then
        s:write("version 1\r\nstage idle\r\nprogress 0\r\nmessage \r\nend\r\n")
        s:close()
    end
end

-- ------------------------------------------------------------------- status

--- @return table|nil {stage, progress, message}
function Bridge.readStatus()
    local r = getFileReader(Config.STATUS_FILE, false)
    if not r then return nil end
    local out = {}
    local line = r:readLine()
    while line do
        local key, value = string.match(line, "^(%a+)%s*(.*)$")
        if key then out[key] = value end
        line = r:readLine()
    end
    r:close()
    if out.progress then out.progress = tonumber(out.progress) or 0 end
    return out
end

-- --------------------------------------------------------------- the payload

--- Split "x,y x,y ..." into a flat array {x1,y1,x2,y2,...}.
--- Flat rather than nested: a city is tens of thousands of points and one table
--- per point is a lot of garbage for the collector to walk.
local function parsePoints(line, out)
    local n = 0
    for xs, ys in string.gmatch(line, "(-?[%d%.]+),(-?[%d%.]+)") do
        out[n + 1] = tonumber(xs)
        out[n + 2] = tonumber(ys)
        n = n + 2
    end
    return n
end

Bridge.Reader = {}
Bridge.Reader.__index = Bridge.Reader

--- Open the payload for incremental reading.
--- @return table|nil reader, string|nil err
function Bridge.openData()
    local r = getFileReader(Config.DATA_FILE, false)
    if not r then return nil, "no data file" end

    local self = setmetatable({
        file = r,
        roads = {},
        buildings = {},
        ground = {},
        expected = { roads = 0, buildings = 0, ground = 0 },
        done = false,
        pending = nil,
    }, Bridge.Reader)

    -- Header first: it is short, and `count` sizes the progress bar.
    while true do
        local line = r:readLine()
        if not line then
            r:close()
            return nil, "payload ended inside its header"
        end
        if line == "" then break end
        local key, rest = string.match(line, "^(%a+)%s*(.*)$")
        if key == "status" and rest ~= "ok" then
            r:close()
            return nil, "helper reported: " .. tostring(rest)
        elseif key == "count" then
            local a, b, c = string.match(rest, "(%d+)%s+(%d+)%s+(%d+)")
            self.expected.roads = tonumber(a) or 0
            self.expected.buildings = tonumber(b) or 0
            self.expected.ground = tonumber(c) or 0
        elseif key == "center" then
            local lon, lat = string.match(rest, "(-?[%d%.]+)%s+(-?[%d%.]+)")
            self.centerLon, self.centerLat = tonumber(lon), tonumber(lat)
        elseif key == "radius" then
            self.radius = tonumber(rest)
        end
    end

    self.total = self.expected.roads + self.expected.buildings + self.expected.ground
    return self
end

--- Read up to `budget` records. Returns true when the payload is exhausted.
function Bridge.Reader:step(budget)
    local read = 0
    while read < budget do
        local header = self.file:readLine()
        if not header or header == "end" then
            self.done = true
            self.file:close()
            return true
        end
        if header ~= "" then
            local kind, a, b = string.match(header, "^(%a)%s+(%S+)%s+(%S+)")
            if kind then
                local points = self.file:readLine()
                if not points then
                    self.done = true
                    self.file:close()
                    return true
                end
                local coords = {}
                local n = parsePoints(points, coords)
                if n >= 4 then
                    if kind == "R" then
                        self.roads[#self.roads + 1] =
                            { cls = a, width = tonumber(b) or 4, pts = coords, n = n }
                    elseif kind == "B" then
                        self.buildings[#self.buildings + 1] =
                            { cls = a, levels = tonumber(b) or 1, pts = coords, n = n }
                    elseif kind == "G" then
                        self.ground[#self.ground + 1] =
                            { pixel = tonumber(a) or Config.BIOME_DEFAULT, pts = coords, n = n }
                    end
                end
                read = read + 1
            end
        end
    end
    return false
end

function Bridge.Reader:progress()
    if self.total <= 0 then return 0 end
    local got = #self.roads + #self.buildings + #self.ground
    return math.min(1, got / self.total)
end

-- ------------------------------------------------- client <-> server handoff

--[[
    The build cannot run where the player clicks the button.

    `worldgen` is declared in media/lua/server/WorldGen/WorldGen.lua, so it only
    exists in the **server** Lua state. A client script that writes
    `worldgen.static_modules` creates a fresh global in its own state and the
    real generator never sees it — which is exactly why the first build produced
    an empty forest despite every earlier stage succeeding.

    So the UI writes a build order here, the server-side driver picks it up and
    does the work, and progress comes back the same way. Files rather than
    Events because the two states do not share tables and this needs no
    marshalling.
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

--- @return table|nil the order, once it is complete on disk
function Bridge.readBuildOrder()
    local r = getFileReader(Config.BUILD_FILE, false)
    if not r then return nil end
    local out, sawEnd = {}, false
    local line = r:readLine()
    while line do
        if line == "end" then sawEnd = true end
        local key, value = string.match(line, "^(%a+)%s*(.*)$")
        if key then out[key] = value end
        line = r:readLine()
    end
    r:close()
    if not sawEnd then return nil end
    if not Config.validCoords(out.lat, out.lon) then return nil end
    return {
        lat = tonumber(out.lat),
        lon = tonumber(out.lon),
        radius = Config.clampRadius(out.radius),
        seed = tonumber(out.seed) or 0,
        reveal = out.reveal == "1",
        name = out.name,
    }
end

function Bridge.clearBuildOrder()
    local w = getFileWriter(Config.BUILD_FILE, true, false)
    if w then
        w:write("")
        w:close()
    end
end

--- Progress, written by the server driver and read by the UI every frame.
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
        -- Written by the helper only; the stage drives the checklist on the build
        -- screen. Absent means "do not move the checklist", not "stage zero".
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
