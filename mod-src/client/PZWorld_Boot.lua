--[[
    Client entry point.

    ## When the panel opens, and why it used to open too early

    It opened on `OnMainMenuEnter`, which is the first frame of the main menu.
    That is wrong twice over: it lands in front of a player who has not said they
    want to build anything, and it lands before they have chosen which world they
    are playing — so a player loading an existing save got a build prompt for a
    world they were not about to enter.

    The moment that actually means "I am starting a new game in the pz-world
    map" is `WorldSelect:clickNext`. `WorldSelect` is the screen `MapGroups`
    drives; the mod ships `lots=PZWorld` in its own `map.info` so it forms its
    own group and is listed there by name, and `clickNext` fires once, after the
    player has picked a group and pressed on. So the panel is hooked there and
    opens only when the group they picked contains our map directory.

    F7 still opens it from anywhere, which is what to use for a second world, or
    if the world-select screen never appears because no other map is installed.

    Everything is pcall-wrapped. A mod that throws here takes the main menu with
    it and the player has no way back.
]]

require "PZWorld/Config"
require "PZWorld_UI"
require "PZWorld_BuildScreen"
require "PZWorld_Overlay"
require "PZWorld_Map"

local shown = false

local function safe(label, fn)
    local ok, err = pcall(fn)
    if not ok then print("PZWORLD: error in " .. label .. ": " .. tostring(err)) end
end

local function openOnce()
    if shown then return end
    shown = true
    safe("open", function() PZWorldUI.open() end)
end

--- Does the world group the player just chose contain our map directory?
local function groupIsOurs(screen)
    local items = screen and screen.listbox and screen.listbox.items
    local selected = items and screen.listbox.selected
    local entry = selected and items[selected]
    local dirs = entry and entry.item and entry.item.mapDirs
    if not dirs then return false end
    for i = 1, dirs:size() do
        if dirs:get(i - 1) == PZWorld.Config.MAP_NAME then return true end
    end
    return false
end

--[[
    Open when — and only when — the player starts a new game in our world.

    `clickNext` is called after the selection is made and before the next screen
    appears, so the group is still readable off the list box. The original runs
    first: whatever it does to screen visibility should happen with or without
    this mod loaded.
]]
safe("worldSelectHook", function()
    if not WorldSelect or not WorldSelect.clickNext then
        print("PZWORLD: no WorldSelect screen in this build — press F7 to open the builder")
        return
    end
    local original = WorldSelect.clickNext
    function WorldSelect:clickNext()
        local ours = false
        local ok, result = pcall(groupIsOurs, self)
        if ok then ours = result end
        original(self)
        if ours then
            shown = false
            openOnce()
        end
    end
end)

--- F7 opens the builder from anywhere, at any time.
safe("keybind", function()
    Events.OnCustomUIKey.Add(function(key)
        if key == Keyboard.KEY_F7 then
            shown = false
            openOnce()
        end
    end)
end)

--[[
    Bring the progress banner back once the world is running.

    The real assembly happens in the server Lua state during the load, which is
    a different game state from the menu the banner was opened on, so it may not
    survive the transition. Re-opening it here costs nothing if the build has
    already finished — it reads the progress file, sees `done`, and closes
    itself after a moment.

    Guarded on a build having been ordered *this session*. The progress file
    outlives the game, and a build that once died leaves it saying `done 0` for
    ever; without the guard every future launch would show a banner for a city
    nobody asked for.
]]
safe("resumeOverlay", function()
    Events.OnGameStart.Add(function()
        if PZWorld and PZWorld.buildRequested and not PZWorldOverlay.instance then
            pcall(PZWorldOverlay.open)
        end
    end)
end)

safe("revealHooks", function()
    Events.OnGameStart.Add(function()
        if PZWorld and PZWorld.pendingReveal then
            PZWorldUI.revealAll()
        end
    end)
    Events.OnCustomUIKey.Add(function(key)
        if key == Keyboard.KEY_F8 then
            PZWorldUI.revealAll()
        end
    end)
end)

--[[
    F9 — put me back in the town.

    Anything that teleports the player somewhere it then fails to build leaves them in an
    unlit void with no context menu and no way out, and without debug mode there is nothing
    they can do about it.

    This reads nothing from any other mod and changes nothing about how any other mod
    behaves. It moves *our* player to the middle of *our* town, which is the centre of the
    canvas because that is where the generator puts the city.
]]
safe("rescueKey", function()
    Events.OnCustomUIKey.Add(function(key)
        if key ~= Keyboard.KEY_F9 then return end
        local ok, err = pcall(function()
            local player = getPlayer()
            if not player then return end
            local x, y = PZWorld.Config.ORIGIN_X, PZWorld.Config.ORIGIN_Y
            player:setX(x); player:setY(y); player:setZ(0)
            player:setLastX(x); player:setLastY(y); player:setLastZ(0)
            print(string.format("PZWORLD: moved you to the town centre at %d, %d", x, y))
        end)
        if not ok then print("PZWORLD: could not move you: " .. tostring(err)) end
    end)
end)

print("PZWORLD: client loaded. The builder opens when you start a new game in the")
print("PZWORLD:   pz-world world; F7 opens it anywhere, F8 reveals the map, F9 rescues you.")
