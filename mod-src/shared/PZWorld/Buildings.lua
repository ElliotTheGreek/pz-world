--[[
    Choosing a building for a footprint, and putting it on the grid.

    Two things have to be true at once for the map to feel like the real place:
    a footprint gets a building of the right *type* — the supermarket on the
    corner becomes a shop, not a bungalow — and one of roughly the right size
    and orientation, so the street still reads as the street.

    Type arrives from the helper, already decided from OpenStreetMap tags
    (shop=supermarket, amenity=hospital, building=house). Size and orientation
    come from the oriented bounding box in Geo.lua, snapped to a quarter turn
    because Project Zomboid has no other option for a wall.

    The choice is drawn from a stream keyed by the footprint's own position, so
    the same building in the same city always gets the same prototype however
    many times the world is regenerated.
]]

require "PZWorld/Config"
require "PZWorld/Geo"

local Geo = PZWorld.Geo
local Buildings = {}
PZWorld.Buildings = Buildings

--[[
    Where to look when a class has no prototype that fits, ordered by how little
    the substitution lies about the place. A clinic standing in for a hospital
    is a smaller untruth than a house standing in for one.
]]
Buildings.FALLBACK = {
    medical = { "office", "civic", "house" },
    education = { "office", "civic" },
    civic = { "office", "church" },
    fire = { "garage", "industrial" },
    police = { "office", "civic" },
    church = { "civic", "house" },
    grocery = { "retail" },
    restaurant = { "retail", "bar" },
    bar = { "restaurant", "retail" },
    gas_station = { "retail", "garage" },
    apartment = { "office", "house" },
    warehouse = { "industrial", "garage" },
    industrial = { "warehouse", "garage" },
    retail = { "office" },
    office = { "retail" },
    farm = { "shed", "garage" },
    garage = { "shed" },
    house = { "shed" },
    shed = {},
    unknown = { "house", "shed" },
}

--- A small deterministic hash, so placement does not depend on iteration order.
local function hash(x, y, salt)
    local h = (x * 73856093) + (y * 19349663) + ((salt or 0) * 83492791)
    h = h % 2147483647
    if h < 0 then h = h + 2147483647 end
    return h
end

--[[
    Best prototype for a footprint of w x h squares.

    A prototype may be used at any of its four rotations, so both aspects are
    considered. It must fit *inside* the footprint — a building spilling past
    its own plot overwrites the pavement and its neighbour — but the choice is
    drawn randomly from everything near the snuggest fit, otherwise a street of
    identical plots becomes a street of identical houses.
]]
function Buildings.fit(cls, w, h, salt)
    local pool = PZWorld.Prototypes and PZWorld.Prototypes[cls]
    if not pool or #pool == 0 then return nil end

    local best, bestWaste = nil, math.huge
    local candidates = {}

    for i = 1, #pool do
        local proto = pool[i]
        for r = 1, 4 do
            local rot = proto.rot[r]
            if rot then
                local pw, ph = rot.dimensions[1], rot.dimensions[2]
                if pw <= w and ph <= h then
                    local waste = (w * h) - (pw * ph)
                    candidates[#candidates + 1] = { proto = proto, rot = r, w = pw, h = ph, waste = waste }
                    if waste < bestWaste then bestWaste = waste end
                end
            end
        end
    end
    if #candidates == 0 then return nil end

    local slack = math.max(16, bestWaste * 0.35)
    local shortlist = {}
    for _, c in ipairs(candidates) do
        if c.waste <= bestWaste + slack then shortlist[#shortlist + 1] = c end
    end

    local pick = (hash(w, h, salt) % #shortlist) + 1
    best = shortlist[pick]
    return best
end

--[[
    Decide a placement for one footprint.

    @param b   {cls, pts (flat, in world squares), n}
    @param salt deterministic seed contribution
    @return table|nil placement, string|nil reason
]]
function Buildings.place(b, salt)
    local snap = Geo.snapFootprint(b.pts, b.n)
    local w = math.floor(snap.w + 0.5)
    local h = math.floor(snap.h + 0.5)

    -- Below this a footprint is source noise — a bin store, a map error —
    -- rather than a building.
    if w < 4 or h < 4 then return nil, "tooSmall" end

    local chain = { b.cls }
    for _, alt in ipairs(Buildings.FALLBACK[b.cls] or { "house", "shed" }) do
        chain[#chain + 1] = alt
    end

    for _, cls in ipairs(chain) do
        local fitted = Buildings.fit(cls, w, h, salt)
        if fitted then
            -- Centre the prototype on the footprint's own centre so it sits
            -- where the real building sits, not in a corner of its box.
            return {
                cls = cls,
                requested = b.cls,
                x = math.floor(snap.cx - fitted.w / 2 + 0.5),
                y = math.floor(snap.cy - fitted.h / 2 + 0.5),
                w = fitted.w,
                h = fitted.h,
                rot = fitted.rot,
                proto = fitted.proto,
                residual = snap.residual,
            }
        end
    end
    return nil, "noPrototype"
end

--- Keep a placement inside the canvas; Project Zomboid indexes cells from zero
--- and a negative coordinate has nowhere to live.
function Buildings.inWorld(p)
    return p.x >= 0 and p.y >= 0
        and (p.x + p.w) < PZWorld.Config.WORLD_SQUARES
        and (p.y + p.h) < PZWorld.Config.WORLD_SQUARES
end

--[[
    Somewhere to record what ground is already spoken for.

    Two buildings may not share a square. This is not a matter of taste: each
    placement becomes a `StaticModule`, and `WorldGenChunk.genRandomSquare`
    collects every module whose box contains the square and then takes
    `get(0)` — the first one — so overlapping placements do not merge, they
    interleave. Where A wins you get A's wall and where B wins you get B's
    floor, and the result is one building with holes in it standing in another.

    Measured on a 2,500 m payload of Plattsburgh: 458 of 5,306 footprints, 8.6%,
    overlapped at least one neighbour. OSM has terraces sharing a party wall,
    buildings mapped twice, and courtyards drawn as separate ways; snapping each
    one to its own axis-aligned box then widens the overlap further.

    Buckets on a coarse lattice, so the test costs a lookup and a few rectangle
    comparisons rather than a scan of everything placed so far.
]]
Buildings.OCCUPANCY_CELL = 32

function Buildings.newOccupancy()
    return { cell = Buildings.OCCUPANCY_CELL, buckets = {} }
end

local function bucketRange(occ, p)
    local C = occ.cell
    return math.floor(p.x / C), math.floor((p.x + p.w - 1) / C),
        math.floor(p.y / C), math.floor((p.y + p.h - 1) / C)
end

--- True if `p` would overlap anything already claimed.
function Buildings.collides(occ, p)
    local gx0, gx1, gy0, gy1 = bucketRange(occ, p)
    for gx = gx0, gx1 do
        for gy = gy0, gy1 do
            local list = occ.buckets[gx * 100000 + gy]
            if list then
                for i = 1, #list do
                    local q = list[i]
                    if p.x < q.x + q.w and q.x < p.x + p.w
                        and p.y < q.y + q.h and q.y < p.y + p.h then
                        return true
                    end
                end
            end
        end
    end
    return false
end

function Buildings.claim(occ, p)
    local gx0, gx1, gy0, gy1 = bucketRange(occ, p)
    for gx = gx0, gx1 do
        for gy = gy0, gy1 do
            local k = gx * 100000 + gy
            local list = occ.buckets[k]
            if not list then
                list = {}
                occ.buckets[k] = list
            end
            list[#list + 1] = p
        end
    end
end

return Buildings
