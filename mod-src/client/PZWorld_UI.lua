--[[
    The coordinate prompt and the progress screen.

    This is the front of the mod: you start a new game, it asks where on Earth
    you want to be, and then builds that place in front of you.

    It does not do the building, and neither does anything else in Lua. The
    panel writes **one** build order; the helper sees it and runs
    `tools/build-world.js`, which is the only world generator there is; the
    build screen watches the progress file it writes.

    It used to write two orders — a data request that drove a Lua
    reimplementation of the generator, and a build order that the helper *and* a
    server-side Lua driver both acted on. One click, three world generators,
    writing over each other's output. The Lua ones are deleted.
]]

require "ISUI/ISPanelJoypad"
require "PZWorld/Config"
require "PZWorld/Bridge"
require "PZWorld_BuildScreen"
require "PZWorld_Overlay"

local Config = PZWorld.Config
local Bridge = PZWorld.Bridge

PZWorldUI = ISPanelJoypad:derive("PZWorldUI")

local FONT_SMALL = getTextManager():getFontHeight(UIFont.Small)
local FONT_LARGE = getTextManager():getFontHeight(UIFont.Large)
local PAD = 16
local ROW = FONT_SMALL + 10

--[[
    Somewhere to start, and a spread of places to test against. Deliberately
    varied: a gridiron town, a dense organic core, a sprawl and two non-US
    street plans all stress the orientation solver differently.
]]
PZWorldUI.PRESETS = {
    { name = "Plattsburgh, NY", lat = 44.6995, lon = -73.4529 },
    { name = "Burlington, VT",  lat = 44.4759, lon = -73.2121 },
    { name = "Manhattan, NY",   lat = 40.7580, lon = -73.9855 },
    { name = "New Orleans, LA", lat = 29.9584, lon = -90.0644 },
    { name = "Paris, France",   lat = 48.8566, lon = 2.3522 },
    { name = "Tokyo, Japan",    lat = 35.6762, lon = 139.6503 },
}

function PZWorldUI:createChildren()
    ISPanelJoypad.createChildren(self)

    local x = PAD
    local y = PAD * 2 + FONT_LARGE
    local w = self.width - PAD * 2
    local half = (w - PAD) / 2

    self.latEntry = ISTextEntryBox:new(tostring(self.lat), x, y + FONT_SMALL + 4, half, ROW)
    self.latEntry:initialise()
    self.latEntry:instantiate()
    self:addChild(self.latEntry)

    self.lonEntry = ISTextEntryBox:new(tostring(self.lon), x + half + PAD, y + FONT_SMALL + 4, half, ROW)
    self.lonEntry:initialise()
    self.lonEntry:instantiate()
    self:addChild(self.lonEntry)

    y = y + FONT_SMALL + ROW + PAD
    self.radiusLabelY = y

    self.radiusEntry = ISTextEntryBox:new(tostring(self.radius), x, y + FONT_SMALL + 4, half, ROW)
    self.radiusEntry:initialise()
    self.radiusEntry:instantiate()
    self.radiusEntry:setOnlyNumbers(true)
    self:addChild(self.radiusEntry)

    self.seedEntry = ISTextEntryBox:new(tostring(self.seed), x + half + PAD, y + FONT_SMALL + 4, half, ROW)
    self.seedEntry:initialise()
    self.seedEntry:instantiate()
    self:addChild(self.seedEntry)

    y = y + FONT_SMALL + ROW + PAD

    self.revealTick = ISTickBox:new(x, y, ROW, ROW, "", self, PZWorldUI.onTick)
    self.revealTick:initialise()
    self.revealTick:instantiate()
    self.revealTick:addOption("Reveal the whole map (no fog of war)")
    -- Vanilla sets this field directly; there is no setSelected on ISTickBox.
    self.revealTick.selected[1] = self.reveal and true or false
    self:addChild(self.revealTick)

    y = y + ROW + PAD
    self.presetY = y

    self.presetList = ISScrollingListBox:new(x, y + FONT_SMALL + 4, w, ROW * 5)
    self.presetList:initialise()
    self.presetList:instantiate()
    self.presetList.itemheight = ROW
    self.presetList.selected = 1
    self.presetList.drawBorder = true
    self.presetList.onmousedown = function(_, item) self:usePreset(item) end
    for _, p in ipairs(PZWorldUI.PRESETS) do
        self.presetList:addItem(string.format("%s   (%.4f, %.4f)", p.name, p.lat, p.lon), p)
    end
    self:addChild(self.presetList)

    local by = self.height - PAD - ROW
    self.backButton = ISButton:new(PAD, by, 120, ROW, "Close", self, PZWorldUI.onBack)
    self.backButton:initialise()
    self.backButton:instantiate()
    self:addChild(self.backButton)

    self.buildButton = ISButton:new(self.width - PAD - 190, by, 190, ROW,
        "Build this world", self, PZWorldUI.onBuild)
    self.buildButton:initialise()
    self.buildButton:instantiate()
    self:addChild(self.buildButton)
end

function PZWorldUI:onTick(index, selected)
    self.reveal = selected
end

function PZWorldUI:usePreset(item)
    if not item then return end
    self.latEntry:setText(tostring(item.lat))
    self.lonEntry:setText(tostring(item.lon))
    self.cityName = item.name
end

function PZWorldUI:onBack()
    self:setVisible(false)
    self:removeFromUIManager()
end

function PZWorldUI:onBuild()
    if self.building then return end

    local lat = tonumber(self.latEntry:getText())
    local lon = tonumber(self.lonEntry:getText())
    local radius = Config.clampRadius(self.radiusEntry:getText())

    if not Config.validCoords(lat, lon) then
        self.errorText = "Those coordinates are not on Earth. Latitude -90..90, longitude -180..180."
        return
    end
    self.errorText = nil

    local seed = tonumber(self.seedEntry:getText())
    if not seed then
        -- A stable seed from the place itself, so the same coordinates rebuild
        -- the same city unless the player asks for something else.
        seed = math.floor(math.abs(lat * 10000) + math.abs(lon * 10000))
    end

    local params = {
        lat = lat, lon = lon, radius = radius, seed = seed,
        reveal = self.reveal and true or false,
        name = self.cityName or "",
    }

    Bridge.saveSettings(params)

    -- Clear the progress file before ordering, not after: the screen polls it
    -- immediately, and a stale `done 1` from the last build would make this one
    -- look finished the moment it opened.
    Bridge.writeProgress({ progress = 0, message = "Starting", done = false })
    if not Bridge.writeBuildOrder(params) then
        self.errorText = "could not write the build order. Is the helper running?"
        return
    end

    -- The banner is opened from an explicit build order and never from a poll:
    -- polling would resurrect it on the next launch from a stale progress file,
    -- which is a file that says `done 0` for ever if a build once died.
    PZWorld.buildRequested = true
    pcall(PZWorldOverlay.open)

    PZWorld.pendingReveal = params.reveal
    self:setVisible(false)
    self:removeFromUIManager()
    PZWorldBuildScreen.open(params)
end

function PZWorldUI:prerender()
    self:drawRect(0, 0, self.width, self.height, 0.92, 0, 0, 0)
    self:drawRectBorder(0, 0, self.width, self.height, 0.4, 1, 1, 1)
    self:drawTextCentre("pz-world", self.width / 2, PAD, 1, 1, 1, 1, UIFont.Large)

    self:renderForm()
end

function PZWorldUI:renderForm()
    local x = PAD
    local y = PAD * 2 + FONT_LARGE
    local half = (self.width - PAD * 3) / 2

    self:drawText("Latitude", x, y, 0.8, 0.8, 0.8, 1, UIFont.Small)
    self:drawText("Longitude", x + half + PAD, y, 0.8, 0.8, 0.8, 1, UIFont.Small)

    self:drawText("Radius (metres)", x, self.radiusLabelY, 0.8, 0.8, 0.8, 1, UIFont.Small)
    self:drawText("Seed (blank = from the place)", x + half + PAD, self.radiusLabelY,
        0.8, 0.8, 0.8, 1, UIFont.Small)

    self:drawText("Or pick a place", x, self.presetY, 0.8, 0.8, 0.8, 1, UIFont.Small)

    local note = string.format(
        "World is %.1f km square. Radius %d-%d m. Run the helper first:  npm run helper",
        Config.WORLD_SQUARES / 1000, Config.MIN_RADIUS, Config.MAX_RADIUS
    )
    self:drawText(note, PAD, self.height - PAD - ROW - FONT_SMALL - 6, 0.6, 0.6, 0.6, 1, UIFont.Small)

    if self.errorText then
        self:drawText(self.errorText, PAD, self.height - PAD - ROW - FONT_SMALL * 2 - 12,
            1, 0.5, 0.4, 1, UIFont.Small)
    end
end

function PZWorldUI:new()
    local width = 580
    local height = 560
    local x = (getCore():getScreenWidth() - width) / 2
    local y = (getCore():getScreenHeight() - height) / 2

    local o = ISPanelJoypad.new(self, x, y, width, height)
    o.moveWithMouse = true

    local saved = Bridge.loadSettings()
    o.lat = saved and saved.lat or Config.DEFAULT_LAT
    o.lon = saved and saved.lon or Config.DEFAULT_LON
    o.radius = saved and saved.radius or Config.DEFAULT_RADIUS
    o.cityName = saved and saved.name or Config.DEFAULT_NAME
    o.reveal = true
    o.seed = ""
    o.building = false
    return o
end

function PZWorldUI.open()
    if PZWorldUI.instance then
        PZWorldUI.instance:removeFromUIManager()
    end
    local ui = PZWorldUI:new()
    ui:initialise()
    ui:instantiate()
    ui:addToUIManager()
    PZWorldUI.instance = ui
    return ui
end

--[[
    Lift the fog of war.

    `WorldMapVisited.getInstance():setKnownInSquares(x1, y1, x2, y2)` is what
    vanilla calls when a map item is read. Applying it to the whole canvas turns
    the in-game map into a way to confirm the city really was generated, without
    walking every street to find out.

    This is client-side because WorldMapVisited is; the server has its own
    WorldMapVisitedServer for multiplayer, which singleplayer does not need.
]]
function PZWorldUI.revealAll()
    local ok, err = pcall(function()
        local w = Config.WORLD_SQUARES - 1
        WorldMapVisited.getInstance():setKnownInSquares(0, 0, w, w)
    end)
    if ok then
        print("PZWORLD: revealed the whole map")
    else
        print("PZWORLD: could not reveal the map: " .. tostring(err))
    end
    return ok
end

return PZWorldUI
