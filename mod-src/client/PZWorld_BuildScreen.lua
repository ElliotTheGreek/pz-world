--[[
    The build screen.

    A hard, full-screen, input-blocking modal. While the world is being built
    nothing else is reachable and nothing about it is implicit: it says what it
    is doing, which stage it is on, how far through it is, and how long it has
    taken. Earlier versions did the work with no visible indication at all,
    which is indistinguishable from being broken.

    It also does the work. Stepping the build from this screen's `update` is
    what makes a progress bar possible at all — a blocking loop renders no
    frames, so any bar drawn around one is a lie.

    Doing it here, at the menu, also puts `worldgen.static_modules` in place
    before a single chunk is generated. Building later means the chunks around
    the player are already made and never revisited.
]]

require "ISUI/ISPanelJoypad"
require "PZWorld/Config"
require "PZWorld/Bridge"
require "PZWorld/Build"

local Config = PZWorld.Config
local Bridge = PZWorld.Bridge
local Build = PZWorld.Build

PZWorldBuildScreen = ISPanelJoypad:derive("PZWorldBuildScreen")

local FONT_SMALL = getTextManager():getFontHeight(UIFont.Small)
local FONT_MED = getTextManager():getFontHeight(UIFont.Medium)
local FONT_LARGE = getTextManager():getFontHeight(UIFont.Large)

--- The stages the player is shown, in order. Mirrors PZWorld.Build.
local STAGE_LABELS = {
    { id = "waiting",   text = "Downloading map data from OpenStreetMap" },
    { id = "loading",   text = "Reading map data" },
    { id = "orienting", text = "Working out which way the city faces" },
    { id = "buildings", text = "Placing buildings" },
    { id = "roads",     text = "Laying roads" },
    { id = "ground",    text = "Painting ground and vegetation" },
    { id = "mapping",   text = "Drawing the in-game map" },
    { id = "emitting",  text = "Handing the world to the game" },
}

function PZWorldBuildScreen:new(params)
    local o = ISPanelJoypad.new(self, 0, 0,
        getCore():getScreenWidth(), getCore():getScreenHeight())
    o.params = params
    o.startedAt = getTimestampMs and getTimestampMs() or 0
    o.elapsed = 0
    o.finished = false
    o.failed = nil
    return o
end

function PZWorldBuildScreen:createChildren()
    ISPanelJoypad.createChildren(self)
    local bw, bh = 200, FONT_SMALL + 14
    local by = self.height / 2 + 160

    self.actionButton = ISButton:new(
        self.width / 2 - bw - 8, by, bw, bh,
        "Cancel", self, PZWorldBuildScreen.onAction)
    self.actionButton:initialise()
    self.actionButton:instantiate()
    self:addChild(self.actionButton)

    -- A build can fail for reasons that clear on their own — the helper not up
    -- yet, a file briefly locked by the game, Overpass refusing a request. A
    -- retry that does not cost a game restart is worth a button.
    self.retryButton = ISButton:new(
        self.width / 2 + 8, by, bw, bh,
        "Restart build", self, PZWorldBuildScreen.onRetry)
    self.retryButton:initialise()
    self.retryButton:instantiate()
    self:addChild(self.retryButton)
end

--- Throw away all state and run the whole thing again from the request.
function PZWorldBuildScreen:onRetry()
    PZWorld.Build.cancel()
    self.started = false
    self.finished = false
    self.failed = nil
    self.summary = nil
    self.startedAt = getTimestampMs and getTimestampMs() or 0
    self.elapsed = 0
    self.actionButton:setTitle("Cancel")
    pcall(function() PZWorld.Bridge.clearData() end)
    print("PZWORLD: restarting build")
end

function PZWorldBuildScreen:onAction()
    if self.finished or self.failed then
        self:close()
    else
        Build.cancel()
        self:close()
    end
end

function PZWorldBuildScreen:close()
    self:setVisible(false)
    self:removeFromUIManager()
    PZWorldBuildScreen.instance = nil
end

--- Swallow every click and key so nothing behind this screen can be reached.
function PZWorldBuildScreen:onMouseDown() return true end
function PZWorldBuildScreen:onMouseUp() return true end
function PZWorldBuildScreen:onMouseMove() return true end
function PZWorldBuildScreen:onRightMouseDown() return true end
function PZWorldBuildScreen:onMouseWheel() return true end
function PZWorldBuildScreen:isMouseOver() return true end

function PZWorldBuildScreen:prerender()
    -- Opaque, full screen: this is the hard block.
    self:drawRect(0, 0, self.width, self.height, 1.0, 0.03, 0.04, 0.05)

    local cx = self.width / 2
    local y = self.height / 2 - 210

    self:drawTextCentre("BUILDING YOUR WORLD", cx, y, 1, 1, 1, 1, UIFont.Large)
    y = y + FONT_LARGE + 10

    local where = self.params and self.params.name or ""
    if where == "" and self.params then
        where = string.format("%.4f, %.4f", self.params.lat, self.params.lon)
    end
    self:drawTextCentre(where, cx, y, 0.75, 0.85, 0.95, 1, UIFont.Medium)
    y = y + FONT_MED + 6
    if self.params then
        self:drawTextCentre(
            string.format("radius %d m   seed %s", self.params.radius, tostring(self.params.seed)),
            cx, y, 0.5, 0.5, 0.55, 1, UIFont.Small)
    end
    y = y + FONT_SMALL + 26

    self:drawTextCentre("Do not close the game. This can take a few minutes.",
        cx, y, 0.8, 0.75, 0.5, 1, UIFont.Small)
    y = y + FONT_SMALL + 22

    -- The bar
    local progress, message = Build.progress()
    if self.failed then progress = 0 end
    local barW = math.min(760, self.width - 160)
    local barX = cx - barW / 2
    self:drawRect(barX, y, barW, 26, 1, 0.10, 0.11, 0.12)
    self:drawRectBorder(barX, y, barW, 26, 0.8, 0.5, 0.5, 0.55)
    if not self.failed then
        local frac = math.max(0, math.min(1, progress))
        self:drawRect(barX + 3, y + 3, (barW - 6) * frac, 20, 1, 0.35, 0.72, 0.38)
    end
    self:drawTextCentre(string.format("%d%%", math.floor(progress * 100)),
        cx, y + 4, 1, 1, 1, 1, UIFont.Small)
    y = y + 40

    self:drawTextCentre(self.failed and "FAILED" or (message or ""),
        cx, y, self.failed and 1 or 0.9, self.failed and 0.45 or 0.9,
        self.failed and 0.4 or 0.9, 1, UIFont.Small)
    y = y + FONT_SMALL + 20

    -- Stage checklist, so it is obvious what has happened and what has not.
    local s = Build.state
    local current = s and s.stage or "waiting"
    local reached = false
    for _, stage in ipairs(STAGE_LABELS) do
        local isCurrent = (stage.id == current)
        if isCurrent then reached = true end
        local mark, r, g, b
        if isCurrent and not self.finished then
            mark, r, g, b = ">", 1, 1, 0.6
        elseif reached and not isCurrent then
            mark, r, g, b = " ", 0.4, 0.4, 0.45
        else
            mark, r, g, b = "+", 0.45, 0.75, 0.45
        end
        if self.finished then mark, r, g, b = "+", 0.45, 0.75, 0.45 end
        self:drawText(mark .. "  " .. stage.text, cx - 200, y, r, g, b, 1, UIFont.Small)
        y = y + FONT_SMALL + 5
    end

    y = y + 12
    self:drawTextCentre(string.format("elapsed %ds", math.floor(self.elapsed / 1000)),
        cx, y, 0.45, 0.45, 0.5, 1, UIFont.Small)

    if self.failed then
        y = y + FONT_SMALL + 10
        self:drawTextCentre(tostring(self.failed), cx, y, 0.95, 0.65, 0.6, 1, UIFont.Small)
        self:drawTextCentre("Is the helper running?   npm run helper",
            cx, y + FONT_SMALL + 6, 0.7, 0.7, 0.7, 1, UIFont.Small)
    end

    if self.finished then
        y = y + FONT_SMALL + 12
        self:drawTextCentre(self.summary or "", cx, y, 0.6, 0.9, 0.6, 1, UIFont.Small)
    end
end

--- One slice of work per frame. This is why the bar can move at all.
function PZWorldBuildScreen:update()
    ISPanelJoypad.update(self)
    if getTimestampMs then self.elapsed = getTimestampMs() - self.startedAt end
    if self.finished or self.failed then return end

    if not self.started then
        self.started = true
        Build.start(self.params)
        return
    end

    Build.step()

    local s = Build.state
    if not s then return end

    -- Mirror progress out for anything else that wants it (and for the log).
    pcall(function()
        local p, m = Build.progress()
        Bridge.writeProgress({ progress = p, message = m, done = s.finished, err = s.err })
    end)

    if s.finished then
        if s.err then
            self.failed = s.err
            self.actionButton:setTitle("Close")
            print("PZWORLD: build failed: " .. tostring(s.err))
        else
            self.finished = true
            self.actionButton:setTitle("Continue")
            local prefabs = 0
            if worldgen and worldgen.prefabs then
                for _ in pairs(worldgen.prefabs) do prefabs = prefabs + 1 end
            end
            local modules = (worldgen and worldgen.static_modules) and #worldgen.static_modules or 0
            self.summary = string.format(
                "%d buildings, %d prefabs, %d placements, median twist %.1f deg",
                s.stats.placed, prefabs, modules, Build.medianResidual())
            print("PZWORLD: " .. self.summary)
            print(string.format("PZWORLD: worldgen is %s, bearing %.2f, alignment %d%% -> %d%%",
                worldgen and "available" or "NIL", s.bearing or 0,
                math.floor((s.alignBefore or 0) * 100), math.floor((s.alignAfter or 0) * 100)))
        end
    end
end

function PZWorldBuildScreen.open(params)
    if PZWorldBuildScreen.instance then
        PZWorldBuildScreen.instance:removeFromUIManager()
    end
    local ui = PZWorldBuildScreen:new(params)
    ui:initialise()
    ui:instantiate()
    ui:addToUIManager()
    ui:setAlwaysOnTop(true)
    ui:setCapture(true)
    PZWorldBuildScreen.instance = ui
    return ui
end

return PZWorldBuildScreen
