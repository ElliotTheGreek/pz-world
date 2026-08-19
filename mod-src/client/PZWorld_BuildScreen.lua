--[[
    The build screen.

    A hard, full-screen, input-blocking modal. While the world is being built
    nothing else is reachable and nothing about it is implicit: it says what it
    is doing, which stage it is on, how far through it is, and how long it has
    taken. Earlier versions did the work with no visible indication at all,
    which is indistinguishable from being broken.

    It does **not** do the work. There is one engine, `tools/build-world.js`,
    run as a child process by the helper when it sees a build order; this screen
    reads the progress file that build writes and draws it. Nothing else.

    It used to step a second, Lua implementation of the whole generator from its
    own `update`, while the server state ran a third copy and the helper ran the
    real one — three world generators from one click, writing over each other's
    output. All of that is deleted. If this screen ever grows a `Build.step()`
    again, that is the bug.
]]

require "ISUI/ISPanelJoypad"
require "PZWorld/Config"
require "PZWorld/Bridge"

local Config = PZWorld.Config
local Bridge = PZWorld.Bridge

PZWorldBuildScreen = ISPanelJoypad:derive("PZWorldBuildScreen")

local FONT_SMALL = getTextManager():getFontHeight(UIFont.Small)
local FONT_MED = getTextManager():getFontHeight(UIFont.Medium)
local FONT_LARGE = getTextManager():getFontHeight(UIFont.Large)

--- The stages the player is shown, in order.
--- These are the `stage` values `tools/build-world.js` reports, and nothing
--- else — if a stage here never lights up, that name is wrong, not the build.
local STAGE_LABELS = {
    { id = "fetching", text = "Downloading map data from OpenStreetMap" },
    { id = "reading",  text = "Reading buildings from your install" },
    { id = "placing",  text = "Choosing a real building for every footprint" },
    { id = "surfaces", text = "Laying roads, kerbs and pavements" },
    { id = "stamping", text = "Painting ground and planting vegetation" },
    { id = "cells",    text = "Writing the map cells" },
    { id = "extras",   text = "Drawing the in-game map" },
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

--- Order the build again from the top.
function PZWorldBuildScreen:onRetry()
    self.finished = false
    self.failed = nil
    self.summary = nil
    self.startedAt = getTimestampMs and getTimestampMs() or 0
    self.elapsed = 0
    self.stage = nil
    self.actionButton:setTitle("Cancel")
    Bridge.writeProgress({ progress = 0, message = "Starting", done = false })
    pcall(function() Bridge.writeBuildOrder(self.params) end)
    print("PZWORLD: restarting build")
end

function PZWorldBuildScreen:onAction()
    -- Closing does not stop the build. It is a separate process and it owns the
    -- files it is writing; killing it half way through would leave a map
    -- directory in a state nothing else knows how to finish.
    self:close()
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
    local progress = self.progress or 0
    local message = self.message or "Waiting for the helper"
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
    local current = self.stage or "fetching"
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

--[[
    Watch the one build.

    The build runs in `tools/build-world.js`, spawned by the helper, and reports
    through the progress file. So this polls; it does no work of its own. A
    build that dies without writing anything is the one case the file cannot
    describe, which is what the timeout below is for — otherwise the screen
    would sit at 0% for ever with nothing to say.
]]
local NO_NEWS_TIMEOUT_MS = 90000

function PZWorldBuildScreen:update()
    ISPanelJoypad.update(self)
    if getTimestampMs then self.elapsed = getTimestampMs() - self.startedAt end
    if self.finished or self.failed then return end

    local p
    pcall(function() p = Bridge.readProgress() end)
    if not p then
        if self.elapsed > NO_NEWS_TIMEOUT_MS then
            self.failed = "No progress file. Is the helper running?"
            self.actionButton:setTitle("Close")
        end
        return
    end

    self.progress = p.progress
    self.message = p.message
    -- Absent means "do not move the checklist", not "back to stage one".
    if p.stage then self.stage = p.stage end

    if p.progress > 0 or p.stage then self.sawProgress = true end
    if not self.sawProgress and self.elapsed > NO_NEWS_TIMEOUT_MS then
        self.failed = "The helper has not started the build. Is it running?"
        self.actionButton:setTitle("Close")
        return
    end

    if not p.done then return end

    if p.err and p.err ~= "" then
        self.failed = p.err
        self.actionButton:setTitle("Close")
        print("PZWORLD: build failed: " .. tostring(p.err))
        return
    end

    self.finished = true
    self.progress = 1
    self.actionButton:setTitle("Continue")
    self.summary = p.message or "World built"
    print("PZWORLD: build finished — " .. tostring(self.summary))
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
