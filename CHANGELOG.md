# Changelog

## 1.0.2

- Kills show on the map: for a few seconds, a line from the killer and a mark where they died, with who it was. Map > "Kill lines" turns it off.
- Bodies have a ring when a person killed them: gold for your own kills, white for another player's. Corpses > "Only my kills" shows only yours. A PMC a bot killed has a red ring (Corpses > "PMCs killed by bots"), and pointing at a body says who killed it.
- A quest goal's markers leave the map as soon as the goal is done in the raid.
- Locked doors can show whether you have their key: bright when it's with you, gold when it's in your stash, dim when you don't have it. Turn it on under Map filters > Locked doors > "My keys" (off by default).
- Following a bot shows the floor it's on, as the map does for the player.
- Far fewer of the map's `[Client Request]` lines in the server window. The game reports over one connection that stays open, the page gets the list of games, the maps, the loot and the quests down its stream, and Better Flea's prices are asked inside the server. A game and a page open now make a few lines, not one for every report.
- `server.quietLogs` is gone from `config.jsonc`: the map makes few requests now, so there's nothing to leave out. SPT's request logging is left as SPT has it.

## 1.0.1

- Secret extracts show on the map once you've picked up their note. A new switch under Extracts, "Secret ones not found yet", shows the rest too, in purple.
- Transits to other maps show on the map, with where each one goes. Red until it opens. They have their own switch, and the server's `config.jsonc` has `markers.transits`.
- Loot > "Only my wishlist" shows only the loot on your wishlist, whatever it's worth or its kind. Quest items still show.
- UNTAR (UNTAR Go Home) and ISB Special Forces bots have their own markers and switches, as Black Division and the RUAF do. The server's `config.jsonc` has `markers.untar` and `markers.isb`. Scourge (Manimal's boss) shows as a boss, its followers as guards.
- The server window no longer fills with `[Client Request]` lines while the map is open. SPT's request lines are now left out by default; set `server.quietLogs` to `false` in `config.jsonc` to have them back (apart from the map's own).
- Buildings with a small walkable bit of roof over them now show their floor when you go in, not the roof (a few buildings on Customs, Reserve, Shoreline, Streets and Terminal). These maps were scanned again.
- Factory Classic, Factory Halloween 2026 and Labs Halloween 2026 are new add-ons. Factory's day and night maps come in one zip.

## 1.0.0

First release.
