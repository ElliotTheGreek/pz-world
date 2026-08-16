--[[
    Client entry point.

    The prompt has to appear before the world is generated, and the only moment
    the mod reliably owns is the main menu — `NewGameScreen:clickPlay` hands
    straight to the vanilla screens and wrapping it is fragile across builds. So
    the panel opens once when the menu is first reached, the player picks a place
    and watches it build, and then continues into the normal new-game flow with
    `worldgen.static_modules` already populated on the server side.

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

safe("menuHook", function()
    if Events.OnMainMenuEnter then
        Events.OnMainMenuEnter.Add(openOnce)
    end
end)

--- F7 reopens the builder without restarting the game.
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

print("PZWORLD: client loaded (F7 = world builder, F8 = reveal map)")
