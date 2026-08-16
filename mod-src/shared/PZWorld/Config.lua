--[[
    pz-world configuration and shared state.

    The mod is generic: nothing here names a city except the default the prompt
    starts on, which is only a convenience. Any coordinates on Earth work.
]]

PZWorld = PZWorld or {}
local Config = {}
PZWorld.Config = Config

--- The map directory the mod ships. Must match tools/make-canvas.js.
Config.MAP_NAME = "PZWorld"
Config.MOD_ID = "pzworld"

--- Canvas size, in cells and squares. Must match tools/make-canvas.js.
---
--- 64 cells is 16.4 km square. For scale, vanilla Knox County is 78 × 63 cells
--- (19.9 × 16.1 km), so this is the same order as the whole base game and holds
--- a real city plus the country around it — Plattsburgh's built-up area is
--- roughly 4 × 3 km. There is no cap in the format; cell indices are only
--- filenames. The cost is disk: an empty cell is 19.6 kB, so 64 × 64 is ~80 MB.
Config.CANVAS_CELLS = 64
Config.CELL_SIZE = 256
Config.WORLD_SQUARES = Config.CANVAS_CELLS * Config.CELL_SIZE

--- Where the generated city is centred inside the canvas.
Config.ORIGIN_X = math.floor(Config.WORLD_SQUARES / 2)
Config.ORIGIN_Y = math.floor(Config.WORLD_SQUARES / 2)

--- One square is one metre. Changing this rescales the whole city.
Config.METRES_PER_SQUARE = 1.0

--- Plattsburgh, New York. The default the prompt opens on; freely editable.
Config.DEFAULT_LAT = 44.6995
Config.DEFAULT_LON = -73.4529
Config.DEFAULT_NAME = "Plattsburgh, NY"

--- How much of the world to build, in metres from the centre. 2500 m is a 5 km
--- square, which covers a small city's built-up area; raise it to pull in the
--- surrounding country at the cost of a longer build.
Config.DEFAULT_RADIUS = 2500
Config.MIN_RADIUS = 200
--- Two limits, whichever is tighter: the canvas edge, and the point where a
--- single Overpass query stops coming back (see MAX_RADIUS_M in
--- src/sources/osm.js).
Config.MAX_RADIUS = math.min(8000, math.floor((Config.WORLD_SQUARES / 2) - 128))

--- Ground values, from media/lua/server/metazones/BiomeMapConfig.lua. These are
--- the pixel numbers `config/osm-tags.jsonc` assigns; PZWorld/Ground.lua turns
--- them into biome *names*, and those have to come from `worldgen.biomes`
--- rather than from BiomeMapConfig — see the note there.
---
--- Nothing is painted "built" any more. Keeping roads and houses free of trees
--- used to mean marking their blocks `dirt`; it is now done by dropping those
--- blocks from the biome pass entirely, which is both correct and cheaper.
Config.BIOME_DEFAULT = 96   -- $random / DeepForest
Config.BIOME_TOWN = 115     -- townhouse / TownZone

--- Exchange files. getFileWriter resolves relative to Zomboid/Lua.
Config.REQUEST_FILE = "pzworld_request.txt"
Config.STATUS_FILE = "pzworld_status.txt"
Config.DATA_FILE = "pzworld_data.txt"
Config.SETTINGS_FILE = "pzworld_settings.txt"
--- Client writes the order here; the server-side driver picks it up, because
--- `worldgen` only exists in the server Lua state.
Config.BUILD_FILE = "pzworld_build.txt"
Config.PROGRESS_FILE = "pzworld_progress.txt"

--- How much work to do per frame. Tuned in Build.lua against the progress bar:
--- too low and generation crawls, too high and the game visibly stalls.
Config.WORK_PER_FRAME = 250

function Config.clampRadius(r)
    r = tonumber(r) or Config.DEFAULT_RADIUS
    if r < Config.MIN_RADIUS then return Config.MIN_RADIUS end
    if r > Config.MAX_RADIUS then return Config.MAX_RADIUS end
    return math.floor(r)
end

function Config.validCoords(lat, lon)
    lat, lon = tonumber(lat), tonumber(lon)
    if not lat or not lon then return false end
    if lat < -90 or lat > 90 then return false end
    if lon < -180 or lon > 180 then return false end
    return true
end

return Config
