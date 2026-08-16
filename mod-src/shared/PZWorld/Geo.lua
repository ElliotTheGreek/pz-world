--[[
    Geometry: which way the city faces, and which way each building faces.

    This is the heart of the port, and the two halves are not symmetric.

    A Project Zomboid wall is drawn on the north or west edge of a square, so a
    building has four possible orientations and nothing between. Roads are not
    so constrained: the game ships two diagonal kerb sheets declared as
    FloorOverlay, painted *on top of* square ground, so a road's visible edge can
    run at an angle while the walkable grid stays square.

    So roads keep their true bearing and stairstep; buildings are snapped. What
    makes the snap cheap is doing it once for the whole city first — rotating
    the world so its commonest street direction lands on an axis. In a gridiron
    town that single number leaves almost every building already square to its
    street.

    Ported from src/geo/orient.js, which is covered by test/plan.test.js.
]]

require "PZWorld/Config"

local Geo = {}
PZWorld.Geo = Geo

local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end
local DEG = 180 / math.pi

--[[
    Wrap an index into 1..n, without relying on `%`.

    Kahlua's modulo follows C fmod and keeps the sign of the dividend, unlike
    Lua 5.1's floor-modulo which is always non-negative for a positive divisor.
    So `(-1) % 180` is -1 here, not 179, and an index built that way lands on
    hist[0] — nil — which surfaces as "__add not defined for operands".

    Every wrap in this file goes through here for that reason.
]]
local function wrapIndex(i, n)
    i = i % n
    if i < 0 then i = i + n end
    return i + 1
end

--- Bearing of a segment in degrees; 0 is +x, increasing clockwise on screen.
function Geo.bearing(x1, y1, x2, y2)
    return atan2(y2 - y1, x2 - x1) * DEG
end

--- Fold into [0, 90). The grid is 90-degree periodic, so a street and the one
--- crossing it are evidence for the same grid rather than opposite evidence.
--- Kahlua's `%` keeps the dividend's sign, so the correction is not optional.
function Geo.foldQuarter(deg)
    local d = deg % 90
    if d < 0 then d = d + 90 end
    return d
end

--[[
    The dominant street bearing of the road network.

    Segments vote weighted by length, so an arterial counts for more than a
    cul-de-sac. The histogram is smoothed before the peak is taken so one long
    straight cannot decide the rotation of a whole city, and the winner is
    refined by a length-weighted circular mean computed on the angle times four
    — the space is 90-degree periodic, and multiplying by four maps it onto a
    full circle where a circular mean is meaningful. Without that the answer
    would be quantised to the bin width.

    @param roads array of {pts = flat {x1,y1,x2,y2,...}, n = count}
]]
function Geo.dominantBearing(roads, bins)
    bins = bins or 180
    local hist = {}
    for i = 1, bins do hist[i] = 0 end
    local total = 0

    for _, road in ipairs(roads) do
        local p, n = road.pts, road.n
        for i = 3, n, 2 do
            local x1, y1 = p[i - 2], p[i - 1]
            local x2, y2 = p[i], p[i + 1]
            local dx, dy = x2 - x1, y2 - y1
            local len = math.sqrt(dx * dx + dy * dy)
            if len >= 1 then
                local a = Geo.foldQuarter(Geo.bearing(x1, y1, x2, y2))
                -- Clamp both ends: a NaN or an exact 90 must not index off the
                -- array, because hist[nil] is nil and the add would fail.
                local bin = math.floor((a / 90) * bins) + 1
                if not (bin >= 1) then bin = 1 end
                if bin > bins then bin = bins end
                hist[bin] = hist[bin] + len
                total = total + len
            end
        end
    end
    if total <= 0 then return 0, 0 end

    local window = math.max(1, math.floor(bins / 60))
    local smooth = {}
    for i = 1, bins do
        local sum = 0
        for d = -window, window do
            sum = sum + hist[wrapIndex(i - 1 + d, bins)]
        end
        smooth[i] = sum
    end

    local best = 1
    for i = 2, bins do
        if smooth[i] > smooth[best] then best = i end
    end

    local sx, sy = 0, 0
    for d = -window, window do
        local i = wrapIndex(best - 1 + d, bins)
        local a = ((i - 0.5) / bins) * 90
        sx = sx + smooth[i] * math.cos(a * 4 / DEG)
        sy = sy + smooth[i] * math.sin(a * 4 / DEG)
    end
    return Geo.foldQuarter(atan2(sy, sx) * DEG / 4), total
end

--- Length-weighted fraction of road within `tol` degrees of an axis after
--- rotating by `bearing`. Reported to the player so the rotation's benefit is
--- visible rather than asserted.
function Geo.gridAlignment(roads, bearing, tol)
    tol = tol or 8
    local aligned, total = 0, 0
    for _, road in ipairs(roads) do
        local p, n = road.pts, road.n
        for i = 3, n, 2 do
            local x1, y1 = p[i - 2], p[i - 1]
            local x2, y2 = p[i], p[i + 1]
            local dx, dy = x2 - x1, y2 - y1
            local len = math.sqrt(dx * dx + dy * dy)
            if len >= 1 then
                local off = Geo.foldQuarter(Geo.bearing(x1, y1, x2, y2) - bearing)
                local dev = math.min(off, 90 - off)
                total = total + len
                if dev <= tol then aligned = aligned + len end
            end
        end
    end
    if total <= 0 then return 0 end
    return aligned / total
end

--[[
    Project a point from metres-east/north into world squares.

    Two things happen beyond the scale change: the world is rotated by `bearing`
    so an angled street grid can still lie on the square grid, and **north
    becomes -y**, because Project Zomboid's y axis increases southward.
    Forgetting the flip mirrors the whole city, which looks plausible until you
    compare it against a map.
]]
function Geo.makeProjector(bearing, originX, originY, metresPerSquare)
    local b = bearing / DEG
    local cosB, sinB = math.cos(b), math.sin(b)
    local scale = 1 / (metresPerSquare or 1)
    return function(e, n)
        local rx = e * cosB + n * sinB
        local ry = -e * sinB + n * cosB
        return originX + rx * scale, originY - ry * scale
    end
end

-- ------------------------------------------------------------- bounding boxes

--- Andrew's monotone chain, on a flat coordinate array.
--- @return array of {x, y} on the hull
function Geo.convexHull(pts, n)
    local points = {}
    for i = 1, n, 2 do points[#points + 1] = { pts[i], pts[i + 1] } end
    table.sort(points, function(a, b)
        if a[1] == b[1] then return a[2] < b[2] end
        return a[1] < b[1]
    end)
    if #points < 3 then return points end

    local function cross(o, a, b)
        return (a[1] - o[1]) * (b[2] - o[2]) - (a[2] - o[2]) * (b[1] - o[1])
    end

    local lower = {}
    for _, p in ipairs(points) do
        while #lower >= 2 and cross(lower[#lower - 1], lower[#lower], p) <= 0 do
            table.remove(lower)
        end
        lower[#lower + 1] = p
    end
    local upper = {}
    for i = #points, 1, -1 do
        local p = points[i]
        while #upper >= 2 and cross(upper[#upper - 1], upper[#upper], p) <= 0 do
            table.remove(upper)
        end
        upper[#upper + 1] = p
    end
    table.remove(lower)
    table.remove(upper)
    for _, p in ipairs(upper) do lower[#lower + 1] = p end
    return lower
end

--[[
    Minimum-area oriented bounding box, by rotating callipers over the hull.

    A footprint is not a rectangle but the prefab replacing it is, so what we
    actually need is "which rectangle, at which angle, best stands in for this
    shape".
]]
function Geo.orientedBounds(pts, n)
    local hull = Geo.convexHull(pts, n)
    if #hull < 3 then
        local minX, minY, maxX, maxY = math.huge, math.huge, -math.huge, -math.huge
        for i = 1, n, 2 do
            if pts[i] < minX then minX = pts[i] end
            if pts[i] > maxX then maxX = pts[i] end
            if pts[i + 1] < minY then minY = pts[i + 1] end
            if pts[i + 1] > maxY then maxY = pts[i + 1] end
        end
        return {
            cx = (minX + maxX) / 2, cy = (minY + maxY) / 2,
            w = maxX - minX, h = maxY - minY, angle = 0,
        }
    end

    local best
    for i = 1, #hull do
        local a = hull[i]
        local b = hull[(i % #hull) + 1]
        local ex, ey = b[1] - a[1], b[2] - a[2]
        local edge = math.sqrt(ex * ex + ey * ey)
        if edge > 1e-9 then
            local ux, uy = ex / edge, ey / edge
            local minU, maxU = math.huge, -math.huge
            local minV, maxV = math.huge, -math.huge
            for _, p in ipairs(hull) do
                local u = p[1] * ux + p[2] * uy
                local v = -p[1] * uy + p[2] * ux
                if u < minU then minU = u end
                if u > maxU then maxU = u end
                if v < minV then minV = v end
                if v > maxV then maxV = v end
            end
            local w, h = maxU - minU, maxV - minV
            local area = w * h
            if not best or area < best.area then
                local cu, cv = (minU + maxU) / 2, (minV + maxV) / 2
                best = {
                    area = area, w = w, h = h,
                    cx = cu * ux - cv * uy,
                    cy = cu * uy + cv * ux,
                    angle = atan2(uy, ux) * DEG,
                }
            end
        end
    end
    return best
end

--[[
    Snap a footprint to the grid.

    Returns the axis-aligned extent the building will occupy and the residual —
    how far it had to twist. The residual distribution is the honest measure of
    how well a city suits this port, so the build reports it.
]]
function Geo.snapFootprint(pts, n)
    local obb = Geo.orientedBounds(pts, n)
    local folded = Geo.foldQuarter(obb.angle)
    local residual = folded <= 45 and folded or folded - 90
    -- If the box sat nearer 90 than 0, its width and height exchange roles.
    local swap = folded > 45
    return {
        cx = obb.cx,
        cy = obb.cy,
        w = swap and obb.h or obb.w,
        h = swap and obb.w or obb.h,
        residual = residual,
        angle = obb.angle,
    }
end

return Geo
