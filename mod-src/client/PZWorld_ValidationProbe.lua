--[[
    Observational runtime probe for authored-map streaming validation.

    It never mutates squares or teleports the player. It samples the player's loaded
    square, records chunk/cell transitions and frame stalls, and prints one bounded
    summary to console.txt. Run a new save, walk or drive across the generated map for
    at least five minutes, and retain the PZWORLD_VALIDATION lines as manual evidence.
]]

local PROBE_VERSION = 2

local Probe = {
    started = false,
    complete = false,
    startMs = 0,
    lastMs = 0,
    samples = 0,
    missingSquares = 0,
    chunkTransitions = 0,
    cellTransitions = 0,
    stalls = 0,
    maxGapMs = 0,
    lastChunk = nil,
    lastCell = nil,
}

local function nowMs()
    if getTimestampMs then return getTimestampMs() end
    return math.floor(os.clock() * 1000)
end

local function key(x, y, size)
    return tostring(math.floor(x / size)) .. "," .. tostring(math.floor(y / size))
end

local function finish(reason)
    if Probe.complete then return end
    Probe.complete = true
    local elapsed = nowMs() - Probe.startMs
    print(string.format(
        "PZWORLD_VALIDATION complete probeVersion=%d chunkSize=8 cellSize=256 reason=%s elapsedMs=%d samples=%d missingSquares=%d chunkTransitions=%d cellTransitions=%d stalls=%d maxGapMs=%d",
        PROBE_VERSION, tostring(reason), elapsed, Probe.samples, Probe.missingSquares,
        Probe.chunkTransitions, Probe.cellTransitions, Probe.stalls, Probe.maxGapMs
    ))
end

local function sample()
    if Probe.complete then return end
    local ok, err = pcall(function()
        local player = getPlayer()
        if not player then return end
        local ms = nowMs()
        if not Probe.started then
            Probe.started = true
            Probe.startMs = ms
            Probe.lastMs = ms
            print(string.format(
                "PZWORLD_VALIDATION begin x=%.1f y=%.1f z=%.1f",
                player:getX(), player:getY(), player:getZ()
            ))
        end

        local gap = ms - Probe.lastMs
        Probe.lastMs = ms
        if gap > Probe.maxGapMs then Probe.maxGapMs = gap end
        -- EveryOneSecond naturally samples near 1,000 ms. Count only a delay large
        -- enough to represent at least one missed callback, not normal scheduler jitter.
        if gap >= 2500 then Probe.stalls = Probe.stalls + 1 end
        Probe.samples = Probe.samples + 1

        local x, y = player:getX(), player:getY()
        local square = player:getSquare()
        if not square then Probe.missingSquares = Probe.missingSquares + 1 end

        local chunk = key(x, y, 8)
        local cell = key(x, y, 256)
        if Probe.lastChunk and chunk ~= Probe.lastChunk then
            Probe.chunkTransitions = Probe.chunkTransitions + 1
        end
        if Probe.lastCell and cell ~= Probe.lastCell then
            Probe.cellTransitions = Probe.cellTransitions + 1
            print("PZWORLD_VALIDATION cellTransition " .. Probe.lastCell .. " -> " .. cell)
        end
        Probe.lastChunk = chunk
        Probe.lastCell = cell

        if ms - Probe.startMs >= 300000 then finish("five-minutes") end
    end)
    if not ok then
        print("PZWORLD_VALIDATION error " .. tostring(err))
        finish("probe-error")
    end
end

local function start()
    local ok, err = pcall(function()
        print("PZWORLD_VALIDATION armed; observational probe runs for five minutes")
        Events.EveryOneSecond.Add(sample)
    end)
    if not ok then print("PZWORLD_VALIDATION arm-error " .. tostring(err)) end
end

Events.OnGameStart.Add(start)
Events.OnPlayerDeath.Add(function() finish("player-death") end)
