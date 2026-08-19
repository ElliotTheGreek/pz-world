# The bridge protocol

Project Zomboid's Lua sandbox cannot fetch a URL (see DEV_GUIDE.md §1.6) **and
cannot write a byte above 0x7F** — `getFileWriter` and `getModFileWriter` both
return an `OutputStreamWriter` over UTF-8. So the two things the game cannot do
for itself, the network and the bytes, both live in the helper, and the two
halves talk through files.

`getFileWriter` / `getFileReader` resolve relative to **`Zomboid/Lua/`** — not
`Zomboid/` — so that is the exchange directory.

```
Zomboid/Lua/
  pzworld_build.txt      the build order: written by the mod, watched by the helper
  pzworld_progress.txt   written during a build, polled every frame by the build screen
  pzworld_settings.txt   the last coordinates entered, so the panel reopens where it was
```

Three files, and that is the whole protocol.

There used to be three more — `pzworld_request.txt`, `pzworld_status.txt` and
`pzworld_data.txt` — a second channel that handed the mod an OSM payload to build
a world from *in Lua*. That Lua world generator existed alongside this one and
wrote to the same map directory, so a single click ran two generators over each
other's output. It is deleted, and the channel with it.

## Build order — mod → helper, and the progress back

This is the whole of the current protocol. The player types coordinates, the build
screen writes `pzworld_build.txt`, and the helper runs the same build `npm run world`
runs — real map cells, biome maps, `worldmap.xml.bin`, `streets.xml`, `objects.lua`,
`spawnpoints.lua` — writing `pzworld_progress.txt` as it goes.

```
lat 44.6995
lon -73.4529
radius 2500
seed 0
reveal 0
name Plattsburgh, NY
end
```

```
progress 0.6470
done 0
error
stage reading
message Reading building 4850 of 5043 out of your install
end
```

Three details that are load-bearing rather than tidy:

- **`end` terminates both files.** A reader can catch a writer mid-write, and a
  truncated read has to be recognisable as one rather than parsed as a short record.
- **The helper empties the order before running it**, not after. A build that throws
  is then not retried for ever, and the mod's `getFileReader` on a missing file is a
  different code path from an empty one.
- **The helper runs the build in a child process** with `--max-old-space-size=8192`.
  A 2,500 m city holds 33 million squares at once; run in-process it exhausted the
  helper's own heap and killed it, leaving the player watching a bar that would never
  move again. The child writes the progress file itself, so even a build that dies
  outright reports rather than hanging.

The timing is the reason it happens at the menu at all: `MapFiles.load()` re-lists the
map directory at world init, so a cell written while the build screen is up is picked
up — but `IsoLot.pool` keeps handles open once the world starts streaming, and on
Windows rewriting an open file fails outright. Every cell has to be on disk before the
player clicks through.

Every file is plain text, one `key value` or record per line. Nothing is JSON:
Kahlua has no JSON parser and hand-rolling one for a multi-megabyte payload
inside the game would show up as a stall in the middle of world generation.

## Why the helper emits the finished world

It used to stop short of this on purpose: the helper fetched, and the mod built the
world in Lua in front of the player, so the game was doing the interesting part rather
than copying files.

That is no longer possible, and the reason is not preference. A world worth building is
made of map cells — eight z-levels, twelve tiles a square, room definitions the loot
system keys off — and `getModFileWriter` returns an `OutputStreamWriter` over UTF-8, so
Lua turns every byte above 0x7F into two. Lua cannot write a cell. The only route Lua
*can* drive is `worldgen.static_modules`, and `PrefabStructure` hard-codes four tile
layers with no z axis: no upstairs, no roof, no rooms.

So the split moved. The helper does the work, and the game does what it is uniquely
placed to do — ask the player where on Earth they want to wake up, and hold a screen in
front of them until the world is there.
