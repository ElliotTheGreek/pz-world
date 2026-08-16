--[[
    Cars.

    There were none. Not a few, none — and the reason is that Project Zomboid
    does not put vehicles anywhere by itself. It spawns them from **zones**:
    rectangles of type `ParkingStall` declared in a map's `objects.lua`, one per
    parking space, each naming a distribution to draw the car from. Muldraugh
    declares 9,693 of them. pz-world declared nothing, so a 269 km road network
    came out with an empty kerb from one end to the other.

    ## Registered at runtime, not written to objects.lua

    `objects.lua` is read once, per lot directory, by
    `media/lua/server/metazones/metazoneHandler.lua` on `OnLoadMapZones`, and a
    file the mod creates during the build would not resolve by name for the rest
    of the session anyway (DEV_GUIDE §1.11). But that handler does nothing
    clever with the file — for a `ParkingStall` it ends up at

        getWorld():registerVehiclesZone(name, type, x, y, z, w, h, properties)

    which is a plain Lua call. So the stalls are planned during the build and
    registered on the same event, a few seconds later. Measured on this machine:
    the build finishes at `OnPreMapLoad`, and `OnLoadMapZones` fires seven
    seconds after that.

    ## Where the cars go

    Two sources, because they are the two places cars actually are:

      * **At the kerb.** A stall every `STALL_SPACING` squares along a built-up
        street, tucked against the kerb on alternating sides, aligned with the
        road.
      * **In car parks.** `amenity=parking` from OpenStreetMap, filled with a
        grid of stalls.

    Nothing is placed on a footpath, inside a building, or out in the country:
    an empty road through farmland with a car parked on it every forty metres
    looks far stranger than an empty road.
]]

require "PZWorld/Config"

local Config = PZWorld.Config
local Vehicles = {}
PZWorld.Vehicles = Vehicles

--- Squares of street between one kerbside stall and the next.
Vehicles.STALL_SPACING = 44
--- A car is about this big. The game fits the vehicle inside the zone.
Vehicles.STALL_LONG = 6
Vehicles.STALL_SHORT = 3
--- Stalls in a car park, centre to centre.
Vehicles.LOT_PITCH_LONG = 8
Vehicles.LOT_PITCH_SHORT = 5

--[[
    Distributions to draw from, by name, as `objects.lua` spells them.

    An empty name is the default mix and is what 7,663 of Muldraugh's 9,693
    stalls use; the rest are weighted towards it in the same spirit. `burnt` and
    `bad` exist so a street is not a showroom.
]]
Vehicles.NAMES = { "", "", "", "", "", "", "bad", "good", "medium", "burnt" }

--- Which road classes get parked cars along them.
Vehicles.STREET_CLASSES = {
    motorway = false, trunk = false,
    primary = true, secondary = true, residential = true, service = true,
}

--- Deterministic, so the same city always parks the same cars in the same places.
local function pick(list, x, y)
    local h = (x * 73856093) + (y * 19349663)
    h = h % #list
    if h < 0 then h = h + #list end
    return list[h + 1]
end

--[[
    One stall, as an axis-aligned box.

    `ux, uy` is the direction of the street, so the long axis of the car follows
    it. Project Zomboid turns the vehicle to fit; the box only has to be the
    right shape and in the right place.
]]
local function addStall(out, cx, cy, ux, uy, ctx)
    local horizontal = math.abs(ux) >= math.abs(uy)
    local w = horizontal and Vehicles.STALL_LONG or Vehicles.STALL_SHORT
    local h = horizontal and Vehicles.STALL_SHORT or Vehicles.STALL_LONG

    local x = math.floor(cx - w / 2 + 0.5)
    local y = math.floor(cy - h / 2 + 0.5)

    if x < 1 or y < 1 then return end
    if x + w >= Config.WORLD_SQUARES or y + h >= Config.WORLD_SQUARES then return end
    -- Never inside a building: the car would be in somebody's living room.
    if ctx and ctx.occupied and ctx.occupied(math.floor(cx), math.floor(cy)) then return end

    out[#out + 1] = { name = pick(Vehicles.NAMES, x, y), x = x, y = y, w = w, h = h }
end

--[[
    Kerbside parking along one street.

    Walks the centreline accumulating distance and drops a stall each time
    `STALL_SPACING` is passed, offset to just inside the kerb so the car sits
    against it rather than in the middle of the carriageway. Sides alternate,
    which is both what a real street looks like and what stops a narrow road
    being blocked end to end.
]]
function Vehicles.planStreet(out, road, ctx)
    if Vehicles.STREET_CLASSES[road.cls] ~= true then return end

    local half = road.width / 2
    -- Just inside the kerb. On a narrow lane this is the middle of the road,
    -- which is where an abandoned car ends up anyway.
    local offset = math.max(1, half - 1.5)

    local p, n = road.pts, road.n
    local travelled = 0
    local side = 1

    for i = 3, n, 2 do
        local ax, ay = p[i - 2], p[i - 1]
        local bx, by = p[i], p[i + 1]
        local dx, dy = bx - ax, by - ay
        local len = math.sqrt(dx * dx + dy * dy)
        if len >= 1e-6 then
            local ux, uy = dx / len, dy / len
            local nx, ny = -uy, ux
            local along = Vehicles.STALL_SPACING - travelled

            while along <= len do
                local cx = ax + ux * along + nx * side * offset
                local cy = ay + uy * along + ny * side * offset
                if not ctx or not ctx.builtUp or ctx.builtUp(math.floor(cx), math.floor(cy)) then
                    addStall(out, cx, cy, ux, uy, ctx)
                end
                side = -side
                along = along + Vehicles.STALL_SPACING
            end
            travelled = (travelled + len) % Vehicles.STALL_SPACING
            if travelled < 0 then travelled = travelled + Vehicles.STALL_SPACING end
        end
    end
end

--[[
    A car park: a grid of stalls inside an OpenStreetMap `amenity=parking` area.

    Same scanline as PZWorld/Ground.lua, but stepped at the pitch of a parking
    space rather than at block resolution, and laying a stall along each span
    instead of filling it.
]]
function Vehicles.planArea(out, pts, n, ctx)
    if n < 6 then return end

    local minY, maxY = math.huge, -math.huge
    for i = 2, n, 2 do
        local y = pts[i]
        if y < minY then minY = y end
        if y > maxY then maxY = y end
    end
    if minY < 0 then minY = 0 end
    if maxY > Config.WORLD_SQUARES - 1 then maxY = Config.WORLD_SQUARES - 1 end
    if minY > maxY then return end

    local pitchY = Vehicles.LOT_PITCH_SHORT
    local pitchX = Vehicles.LOT_PITCH_LONG
    local xs = {}

    local y = math.floor(minY / pitchY) * pitchY + pitchY * 0.5
    while y <= maxY do
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
                local x1, x2 = xs[k], xs[k + 1]
                if x1 < 0 then x1 = 0 end
                if x2 > Config.WORLD_SQUARES - 1 then x2 = Config.WORLD_SQUARES - 1 end
                local x = math.floor(x1 / pitchX) * pitchX + pitchX * 0.5
                while x <= x2 do
                    -- Cars in a lot face the same way as the lot is long.
                    addStall(out, x, y, 1, 0, ctx)
                    x = x + pitchX
                end
            end
        end
        y = y + pitchY
    end
end

--[[
    Hand the stalls to the game.

    `registerVehiclesZone` is what `metazoneHandler` calls for every
    `ParkingStall` in a shipped map, so this is the same road in, not a side
    door. It returns nil if the zone type is not a vehicle one, which is the
    only failure worth reporting.
]]
function Vehicles.register(stalls)
    if not stalls or #stalls == 0 then return 0, "no stalls planned" end
    -- No probing for the method first: a Java object reached through Kahlua
    -- answers a missing member with nil rather than an error, so a probe that
    -- is itself wrong looks exactly like a method that is not there
    -- (DEV_GUIDE §1.10). The pcall below is the honest test.
    local world = getWorld()
    if not world then return 0, "getWorld() returned nothing" end

    local placed, refused = 0, 0
    for i = 1, #stalls do
        local s = stalls[i]
        local ok, zone = pcall(function()
            return world:registerVehiclesZone(s.name, "ParkingStall", s.x, s.y, 0, s.w, s.h, nil)
        end)
        if ok and zone then
            placed = placed + 1
        else
            refused = refused + 1
            -- One bad call is a mistake; thousands is a wrong API, and the
            -- first message is the one worth having.
            if refused == 1 then
                return placed, "registerVehiclesZone refused a stall: " .. tostring(zone)
            end
        end
    end
    return placed
end

return Vehicles
