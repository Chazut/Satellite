# Changelog

## 1.0.3

- In a Fika raid, the quest items and places of the friends in it show too, each saying whose quest it is, and their quests are in the Quests list. The "Friends' quests" switch turns it off.
- Loot a started quest wants found in raid is marked with an F in a colour of its own wherever it lies, whatever it's worth, and a container holding some has a ring in that colour. The "Found-in-raid needs" switch turns it off.
- The map's own `[Client Request]` lines are left out of the server window: opening the map no longer writes a line for every tile. Other requests (the game's, other mods') are logged as SPT always does, and SPT's settings aren't changed. `"server": { "quietLogs": false }` in `config.jsonc` brings the map's lines back.
- Power switches, levers and the like are on the map, green once switched (Map filters > Switches; light switches have a switch of their own). Search finds them.
- The search has tabs: All, Items, Objects, Spawns, Quests and Extracts.
- Shown live: who each bullet hit (a red flash, Map > "Hit flashes"), and ORBIT's squad objectives and field.
- What somebody picks up is written on the map where they stood, for a few seconds. Loot > "Pick-ups on the map" turns it off.
- Map > "Selected floor only" leaves out people, kills and pick-ups on other floors.
- On the map: grenades going off (Map > "Grenades"), team numbers by players and PMCs who came in together ("Team numbers"), a ring round a player who is down (Fika), and Phobos's field ("Phobos field").
- ISB's White Tusks are a kind of their own (`markers.isbWhiteTusks`). A raid a Fika headless ran says so in the list.
- Bloodhounds (the arena's fighters), mercenaries and Manimal's Combine are kinds of their own (`markers.bloodhounds`, `markers.mercenaries`, `markers.combine`).
- Raid > Who's shown is one list: each kind has Off, Area (only a rough circle) and On beside its name, in place of two lists of switches. "All as areas" sets every kind that can be one.
- ORBIT squad objectives and ghost fights start off, and pages that had them on have them off once. ORBIT rush points have a switch of their own (Map > "ORBIT rush points", off unless turned on), and each ring is named with what it's for and the squad.
- Loot > Explorer: every item on the map, once each with how many there are, from this raid or from what can spawn. Filter it by name, kind and wishlist (or one wishlist group: Tasks, Hideout, Barter, Equipment, Other), and sort it by worth, total worth, name, places or chance. Press an item to find it on the map and go to the nearest; press again for the next.
- Season maps come in add-ons of their own: a map under snow (`<map>@snow`) is shown only in Winter raids, and maps with patches of snow, late in autumn (`<map>@lateautumn`) and early in spring (`<map>@earlyspring`), only in those seasons. The map picker names them ("Customs · snow", "Customs · late autumn").
- On a season map, everything of the map itself shows: quest places, loot, containers, extracts and switches.
- The map picker on a wide screen is a short list of locations: point at one to pick its version or season map beside it. On a phone, each location is a heading with its versions under it.
- The options panel has a search box: it finds a setting in any tab by what it does, and words that go together find each other (PMC also finds players, USEC and BEAR). The × in the box or Escape clears it.
- The message at the top of the map has a × that hides it until it says something new.
- An airdrop shows on the map once it has dropped, where it lands.
- Loot spawns and containers leave out the items of an event that isn't on (Halloween's pumpkins in November), as SPT leaves them out of the raid.
- The maps' pictures are WebP: the download and every add-on are about half the size they were, and look the same. Add-ons made before this still work.

## 1.0.2

- Kills show on the map: for a few seconds, a line from the killer and a mark where they died, with who it was. Map > "Kill lines" turns it off. A killer whose kind isn't shown on the map gets no line, and the kill feed and a body's tip don't name them or say how far they were, so nothing gives away where they are. Your own kills always show.
- Bodies have a ring when a person killed them: gold for your own kills, white for another player's. Corpses > "Only my kills" shows only yours. A PMC a bot killed has a red ring (Corpses > "PMCs killed by bots"), and pointing at a body says who killed it, with corpse loot shown or not.
- The kill feed says when somebody killed themselves (their own grenade, a fall), and what did it when nobody else did. A kill's names on the map sit above its mark, clear of the body's own name.
- "Point to who's off the screen" has a switch for every kind (Map > View > "Who gets an arrow"), scavs and the rest too. PMCs, friends, bosses, Goons and airdrops are on to begin with.
- With the controls hidden (H), a faint "Show controls" button in the corner brings them back, on a phone too.
- New default colours, so no two kinds look alike: you are green, ISB special forces blue, Black Division charcoal, PMC spawns red like PMCs, and quest markers, airdrops, minefields, locked doors, corpses and a few bots have their own. Colours you picked yourself are kept.
- Pressing the map off a building that's open because it's in the middle of the screen shuts it. It opens again once the middle moves onto another building and back, or when it's pressed.
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
