# Changelog

## 1.0.1

- Secret extracts show on the map once you've picked up their note. A new switch under Extracts, "Secret ones not found yet", shows the rest too, in purple.
- Transits to other maps show on the map, with where each one goes. Red until it opens. They have their own switch, and the server's `config.jsonc` has `markers.transits`.
- Loot > "Only my wishlist" shows only the loot on your wishlist, whatever it's worth or its kind. Quest items still show.
- UNTAR (UNTAR Go Home) and ISB Special Forces bots have their own markers and switches, as Black Division and the RUAF do. The server's `config.jsonc` has `markers.untar` and `markers.isb`. Scourge (Manimal's boss) shows as a boss, its followers as guards.
- The server window no longer fills with `[Client Request]` lines while the map is open. SPT's request lines are now left out by default; set `server.quietLogs` to `false` in `config.jsonc` to have them back (apart from the map's own).
- Buildings with a small walkable bit of roof over them now show their floor when you go in, not the roof (Reshala's bunkhouse on Customs, and a few buildings on Reserve, Shoreline, Streets and Terminal). These maps were scanned again.
- Factory Classic, Factory Halloween 2026 and Labs Halloween 2026 are new add-ons. Factory's day and night maps come in one zip.

## 1.0.0

First release.
