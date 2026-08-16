--[[
    A progress banner that is not tied to the builder panel.

    The panel can only be seen while it is open, and the world is assembled
    later — during the load into the game, in the server Lua state. Without
    something drawn outside the panel there is a stretch where the mod is
    working and the player has no indication of it at all, which is exactly how
    the first builds felt.

    It reads the progress file rather than talking to the builder, because the
    builder runs in the other Lua state and the two share nothing.

    ## Why this is a UI element and not an OnPostUIDraw handler

    The first version drew straight onto the UI layer with

        getRenderer():render(nil, x, y, w, h, r, g, b, a)

    which does not exist. `SpriteRenderer.render` has no overload taking a null
    texture, so Kahlua threw `No implementation found for function: render(...)`
    **every frame**, and because the handler was registered on `OnPostUIDraw`
    the exception was raised from `UIManager.render` sixty times a second. Three
    and a half megabytes of stack traces later, `console.txt` contained nothing
    else — every other line the mod had logged was gone. A silent bug would have
    been better; this one ate the evidence for all the others.

    Filled rectangles belong to `ISUIElement`, which owns a Java UI object and
    calls `DrawTextureScaledColor` on it. So this is an `ISPanel` added to the UI
    manager, drawn with `self:drawRect` and `self:drawText`, exactly as every
    vanilla panel does it.
]]

require "ISUI/ISPanel"
require "PZWorld/Config"
require "PZWorld/Bridge"

local Bridge = PZWorld.Bridge

PZWorldOverlay = ISPanel:derive("PZWorldOverlay")

--- Polling every frame would re-read a file 60 times a second for no benefit.
local POLL_TICKS = 20
--- Once the build is finished, linger this long so the result is readable.
local LINGER_TICKS = 300

local WIDTH = 520
local HEIGHT = 58

function PZWorldOverlay:new()
    local sw = getCore():getScreenWidth()
    local w = math.min(WIDTH, sw - 80)
    local o = ISPanel.new(self, (sw - w) / 2, 40, w, HEIGHT)
    o.backgroundColor = { r = 0, g = 0, b = 0, a = 0.82 }
    o.borderColor = { r = 1, g = 1, b = 1, a = 0.25 }
    o.moveWithMouse = false
    o.ticks = POLL_TICKS
    -- -1 means "not finished yet". Once the build reports done this counts
    -- down to zero exactly once and the banner closes for good.
    o.linger = -1
    o.state = nil
    return o
end

function PZWorldOverlay:update()
    self.ticks = self.ticks + 1
    if self.ticks >= POLL_TICKS then
        self.ticks = 0
        local ok, p = pcall(Bridge.readProgress)
        if ok and p then self.state = p end
    end

    local p = self.state
    if not p then return end

    if p.done or p.err then
        -- Arm once. The first version re-armed whenever the countdown reached
        -- zero and the poll still said `done`, so the banner never went away.
        if self.linger < 0 then self.linger = LINGER_TICKS end
        self.linger = self.linger - 1
        if self.linger <= 0 then PZWorldOverlay.close() end
    else
        self.linger = -1
    end
end

function PZWorldOverlay:render()
    local p = self.state
    if not p then return end

    local text = p.err and ("pz-world: " .. tostring(p.err))
        or ("pz-world - " .. tostring(p.message or ""))
    self:drawText(text, 14, 10, 1, 1, 1, 1, UIFont.Small)

    local barX, barY = 14, 32
    local barW, barH = self.width - 28, 14
    self:drawRect(barX, barY, barW, barH, 1, 0.15, 0.15, 0.15)

    if not p.err then
        local frac = math.max(0, math.min(1, p.progress or 0))
        if frac > 0 then
            self:drawRect(barX + 1, barY + 1, (barW - 2) * frac, barH - 2, 1, 0.35, 0.7, 0.35)
        end
        self:drawText(string.format("%d%%", math.floor(frac * 100)),
            barX + barW - 40, barY - 1, 0.8, 0.8, 0.8, 1, UIFont.Small)
    end
end

--[[
    Show the banner.

    Only ever called from the moment a build is ordered. Opening it from a poll
    would resurrect it on the next launch from a stale progress file, which is a
    worse failure than not showing it at all.
]]
function PZWorldOverlay.open()
    PZWorldOverlay.close()
    local ui = PZWorldOverlay:new()
    ui:initialise()
    ui:instantiate()
    ui:addToUIManager()
    PZWorldOverlay.instance = ui
    return ui
end

function PZWorldOverlay.close()
    local ui = PZWorldOverlay.instance
    PZWorldOverlay.instance = nil
    if ui then
        pcall(function()
            ui:setVisible(false)
            ui:removeFromUIManager()
        end)
    end
end

--- Backwards-compatible alias; Boot and the build screen both refer to this.
PZWorld.Overlay = PZWorldOverlay

return PZWorldOverlay
