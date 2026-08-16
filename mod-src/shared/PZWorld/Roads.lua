--[[
    Laying roads on a square grid at their true bearing.

    A road is a centreline with bands stacked outward from it — carriageway,
    kerb, pavement — which is Terrula's signed distance method (PREMISE.md 6.2)
    reduced to whole squares, all a fixed grid can express.

    ## Two things this file got wrong, and what replaced them

    **1. The bands were sampled, not filled.** The first version walked the
    centreline square by square and, at each step, stepped an integer number of
    squares along the unit normal:

        for d = -maxOut, maxOut do
            local x = floor(cx + nx * d + 0.5)
            local y = floor(cy + ny * d + 0.5)

    On an axis-aligned road the normal is (1,0) or (0,1) and that is exact. On
    any other bearing it is a **point sample of a continuous band**, and the
    samples land on the same square twice in some places and skip a square in
    others. The skips are what produced the dashed light-grey stripes running
    diagonally across the junctions — those were not road markings, they were a
    pavement with holes in it.

    So a band is now *filled*, not sampled. The set of squares within `r` of a
    segment is a capsule, a capsule is convex, and a convex region meets any
    horizontal line in exactly one interval — so for each row of squares the
    interval is computed in closed form and every integer square inside it is
    emitted, once. Exact, no gaps, no double writes, and the round caps close
    the notch that used to open on the outside of every corner.

    **2. Every road was painted alone.** Each road laid its carriageway, kerb
    and pavement in one pass, so at a junction whichever road came second put
    its *pavement* across the other's carriageway. That is the light-grey band
    cutting across the middle of the crossroads.

    Painting is now three passes over the whole road network:

        1. every carriageway
        2. every pavement, only where no carriageway already claimed the square
        3. every kerb, only where this road's own pavement actually landed

    A pavement can no longer cross a road, and a kerb can no longer appear in
    the middle of a junction, because by the time either is laid the entire
    road surface of the city is already on the canvas.

    ## Kerb facing was measured, not assumed

    The kerbs were all `street_curbs_01_9`, on both sides of every road. The
    tile definitions declare nothing but `FloorOverlay` for the whole sheet, so
    facing had to be measured: for every square in 60 Muldraugh cells carrying a
    curb tile, which neighbour is road surface and which is pavement.

        tile   road lies   so the kerb square is on the road's
        _9        E                 west side
        _11       W                 east side
        _8        S                 north side
        _10       N                 south side

    (n ≈ 7,000 squares each, 93-95% agreement. `_9` at the west edge and `_11`
    at the east edge is also exactly what the shipped `highway_NS_00` prefab
    does, which is the independent check.)

    ## The diagonal kerb sheets are not used

    `street_curbs_01_diag` and `street_curbs_01_diag_2` exist and vanilla does
    use them. The previous code laid `street_curbs_01_diag_0` on every diagonal
    kerb square whatever direction the road ran, which is the right artwork in
    at most one of the four diagonal directions.

    The same measurement says why one tile cannot stand in for the sheet: the
    diagonal curbs appear in runs of six consecutive indices (0-5, 40-45 in each
    sheet) with road on three or four sides, i.e. they are a *sequence* laid
    along a 1:1 run inside the carriageway, not a single edge tile. Doing that
    properly means tracking position along the run and its parity. Until that
    exists, the measured axis-aligned kerbs are used on the stairstep, which is
    right-facing artwork in the wrong shape rather than wrong-facing artwork.
]]

require "PZWorld/Config"

local Roads = {}
PZWorld.Roads = Roads

--[[
    Tiles per class.

    Every name is one the game ships; the surface, pavement and kerbs come from
    the vanilla `highway_NS_00` prefab, and the kerb facings from the Muldraugh
    measurement above.
]]
local KERBS = {
    -- The kerb square lies on this side of the carriageway.
    west = "street_curbs_01_9",
    east = "street_curbs_01_11",
    north = "street_curbs_01_8",
    south = "street_curbs_01_10",
}

local ASPHALT = "blends_street_01_86"
local PAVEMENT = "floors_exterior_tilesandstone_01_3"

local function street(extra)
    local art = { surface = ASPHALT, sidewalk = PAVEMENT, kerbs = KERBS }
    if extra then
        for k, v in pairs(extra) do art[k] = v end
    end
    return art
end

Roads.ART = {
    motorway = street({ marking = "street_trafficlines_01_4" }),
    trunk = street({ marking = "street_trafficlines_01_4" }),
    primary = street({ marking = "street_trafficlines_01_4" }),
    secondary = street(),
    residential = street(),
    service = { surface = ASPHALT },
    track = { surface = "blends_natural_01_64" },
    footway = { surface = PAVEMENT },
    cycleway = { surface = ASPHALT },
}

--- Which classes get a pavement, and only where the surroundings are built up.
Roads.SIDEWALK_CLASSES = {
    motorway = true, trunk = true, primary = true,
    secondary = true, residential = true,
}

--[[
    How many squares of pavement sit outside the carriageway.

    Measured, because the first guess — a kerb band of 1 plus a pavement band of
    2 — gave every street a three-square pavement, which is wider than the
    footpath in a real town and looked it.

    From 25,705 kerb squares across 50 Muldraugh cells, walking away from the
    road and counting consecutive pavement:

        1 square   82.6%      4 squares   1.1%
        2 squares  11.1%      5 squares   1.2%
        3 squares   2.4%      6+          1.6%

    So one, overwhelmingly, and the kerb sits on it. The wide cases are car
    parks and plazas, which are a different thing that happens to be paved.

    The kerb always goes on the innermost square, so at 1 the pavement and the
    kerb are the same ring.
]]
Roads.PAVEMENT_BAND = 1
Roads.KERB_BAND = 1

--[[
    The two passes, in the order they must run over the whole road list.

    The kerb is laid in the same pass as the pavement, on the square the
    pavement was just written to. It used to be a third pass keyed on "the floor
    here is the pavement tile", which also matched every footpath — footways are
    surfaced with the same `floors_exterior_tilesandstone_01_3` — so kerbs
    appeared along park paths that happened to run near a road. Writing the two
    together makes "this is my own pavement" a fact rather than a guess.
]]
Roads.PHASE_SURFACE = 1
Roads.PHASE_PAVEMENT = 2
Roads.PHASES = 2

-- ------------------------------------------------------------ rasterisation

--[[
    Every row of squares a capsule of radius `r` about segment AB touches, and
    the exact x-interval it covers in that row.

    The capsule is the union of the offset rectangle and the two end discs. It
    is convex, so its intersection with a horizontal line is a single interval
    and taking the widest crossing of any of the three pieces gives it exactly.

    `rowFn(y, lo, hi)` is called once per row with real-valued bounds.
]]
function Roads.capsuleRows(x0, y0, x1, y1, r, rowFn)
    local dx, dy = x1 - x0, y1 - y0
    local len = math.sqrt(dx * dx + dy * dy)

    local minY = (y0 < y1 and y0 or y1) - r
    local maxY = (y0 > y1 and y0 or y1) + r

    local cx, cy
    if len > 1e-9 then
        local nx, ny = -dy / len, dx / len
        cx = { x0 + nx * r, x1 + nx * r, x1 - nx * r, x0 - nx * r }
        cy = { y0 + ny * r, y1 + ny * r, y1 - ny * r, y0 - ny * r }
    end

    for y = math.ceil(minY), math.floor(maxY) do
        local lo, hi = math.huge, -math.huge

        if cx then
            local j = 4
            for i = 1, 4 do
                local yi, yj = cy[i], cy[j]
                -- Half-open crossing rule: an edge lying exactly on the row
                -- contributes nothing, and the end discs cover that case.
                if (yi <= y and yj > y) or (yj <= y and yi > y) then
                    local t = (y - yi) / (yj - yi)
                    local x = cx[i] + t * (cx[j] - cx[i])
                    if x < lo then lo = x end
                    if x > hi then hi = x end
                end
                j = i
            end
        end

        for k = 1, 2 do
            local ex = (k == 1) and x0 or x1
            local ey = (k == 1) and y0 or y1
            local d = y - ey
            local inside = r * r - d * d
            if inside >= 0 then
                local hw = math.sqrt(inside)
                if ex - hw < lo then lo = ex - hw end
                if ex + hw > hi then hi = ex + hw end
            end
        end

        if lo <= hi then rowFn(y, lo, hi) end
    end
end

--[[
    Every square within `r` of the road's centreline.

    `emit(x, y, dist, sx, sy)` receives the square, its true distance to the
    centreline, and the unit vector pointing from the square *towards* the
    centreline — which is what decides a kerb's facing.
]]
function Roads.forEachInBand(road, r, emit)
    local p, n = road.pts, road.n
    for i = 3, n, 2 do
        local ax, ay = p[i - 2], p[i - 1]
        local bx, by = p[i], p[i + 1]
        local dx, dy = bx - ax, by - ay
        local len = math.sqrt(dx * dx + dy * dy)
        if len >= 1e-6 then
            local ux, uy = dx / len, dy / len
            Roads.capsuleRows(ax, ay, bx, by, r, function(y, lo, hi)
                for x = math.ceil(lo), math.floor(hi) do
                    -- Nearest point on the segment, with the ends clamped so the
                    -- caps are discs rather than infinite half-planes.
                    local px, py = x - ax, y - ay
                    local t = px * ux + py * uy
                    if t < 0 then t = 0 elseif t > len then t = len end
                    local qx, qy = ax + ux * t, ay + uy * t
                    local vx, vy = qx - x, qy - y
                    local dist = math.sqrt(vx * vx + vy * vy)
                    if dist <= r then
                        if dist > 1e-9 then
                            emit(x, y, dist, vx / dist, vy / dist)
                        else
                            emit(x, y, 0, 0, 0)
                        end
                    end
                end
            end)
        end
    end
end

--[[
    The kerb tile for a square, from the direction the carriageway lies in.

    `sx, sy` points from the kerb square towards the road. Project Zomboid's y
    increases southward, so a negative y component means the road is north.
]]
function Roads.kerbFor(kerbs, sx, sy)
    if not kerbs then return nil end
    if math.abs(sx) >= math.abs(sy) then
        return sx >= 0 and kerbs.west or kerbs.east
    end
    return sy < 0 and kerbs.south or kerbs.north
end

-- ------------------------------------------------------------------ painting

--[[
    Paint one road onto the canvas, for one pass.

    @param canvas  PZWorld.Canvas
    @param road    {cls, width, pts (flat, in squares), n}
    @param phase   Roads.PHASE_*
    @param ctx     {builtUp = f(x,y), occupied = f(x,y)}
    @return number squares written
]]
function Roads.paint(canvas, road, phase, ctx)
    local art = Roads.ART[road.cls]
    if not art then return 0 end

    local half = road.width / 2
    local wantsSidewalk = Roads.SIDEWALK_CLASSES[road.cls] and art.sidewalk
    if phase ~= Roads.PHASE_SURFACE and not wantsSidewalk then return 0 end

    local builtUp = ctx and ctx.builtUp
    local occupied = ctx and ctx.occupied
    local painted = 0

    if phase == Roads.PHASE_SURFACE then
        Roads.forEachInBand(road, half, function(x, y)
            -- A building placed here wins as a static module anyway, so paying
            -- for the tile would only cost memory.
            if occupied and occupied(x, y) then return end
            canvas:set(x, y, "Floor", art.surface)
            painted = painted + 1
        end)
        return painted
    end

    local outer = half + Roads.PAVEMENT_BAND
    local kerbEdge = half + Roads.KERB_BAND

    Roads.forEachInBand(road, outer, function(x, y, dist, sx, sy)
        if dist <= half then return end
        if occupied and occupied(x, y) then return end
        if builtUp and not builtUp(x, y) then return end

        -- Never over a carriageway: every road surface in the city is already
        -- on the canvas by the time this pass runs, so an occupied Floor here
        -- means this square belongs to a road and the pavement stops.
        if canvas:get(x, y, "Floor") then return end
        canvas:set(x, y, "Floor", art.sidewalk)
        painted = painted + 1

        if dist <= kerbEdge then
            local kerb = Roads.kerbFor(art.kerbs, sx, sy)
            if kerb then
                -- The shipped highway prefab puts its kerbs on FloorFurniture,
                -- over the pavement floor, and so do we.
                canvas:set(x, y, "FloorFurniture", kerb)
            end
        end
    end)

    return painted
end

return Roads
