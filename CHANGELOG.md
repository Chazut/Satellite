# Changelog

## 1.1.0

- Raid history: the server records every raid, whether the page is open or not, and keeps it. **Live map | Raid history** at the top of the page leads to it, at `/satellite/raids/`, laid out as Raid Review's. Raid Review (by ekky and Chazut) is merged into Satellite: everything it showed of a raid is here.
  - **Recent raids**: every raid as a table (player, type, map, how it went, time in raid, when, kills), with Refresh and Import raid. Records at the top (raids, time in raid, survived, kills, what was looted, the most played map, best loot, most kills and more), for all players together or one at a time: each game with Satellite records its own raids.
  - **A raid**: Overview (the raid at a glance, every kill in order, teams and a leaderboard), Stats (charts over the raid, your health among them), Timeline (every kill, pick-up, drop, grenade, extraction and switch, filtered by sort), Behaviour (what every bot was doing, a bar each) and Map. Every view has its own address, so it can be bookmarked or opened in another tab. Export raid and Delete raid in its head.
  - **The map of a raid**: a replay with a timeline (the kills along it as pins, the fights as red bands), play at ½× to 16×, a heat map, trails, a minimap, and beside it, as of the moment shown: raid events, loot, switches, ghost hearing, bot objectives, fields, ORBIT's objectives, QuestingBots' quests, airdrops and every bot's inventory. Pressing a kill plays its fight.
  - **What's kept** (Manage recordings): the newest so many raids and/or so many MB, for everyone or each player's own. A raid that holds a record is kept until another beats it; imported raids are never deleted to make room. `config.jsonc` has `history.record` and `history.keep`.
  - Raids Raid Review recorded can be imported: from a Raid Review folder beside Satellite, or from a zip Raid Review exported. Raids can be exported as a zip and imported on another Satellite.
  - Recorded: who was where, kills, shots, what each bot had decided (SAIN's or the game's), pick-ups, drops, grenades, bot levels and sides, downed players, Fika's other players, Phobos's field, and the loot of the time.
- The game's own maps and the backport add-ons are about a quarter of the size to download (the main zip from about 410 MB to about 125 MB). The pictures are 12 pixels to a metre instead of 16, which looks the same, and each building floor's pictures keep only the buildings: the rest was never shown. The snow and late autumn maps and the other add-ons are as before.
- The bar at the top is one slim row across the screen, not a line of separate buttons over the map: Satellite's logo, whose game and the map, the search, the Raid list and Follow, then Whole map, Buildings and Full screen as icons (named when pointed at), the language and the menu. The Raid list and the menu start under it. Its boxes keep their size while the page loads and the game connects.
- The map's own pointer shows from the moment the page opens, not the computer's busy pointer while it loads: its pictures are part of the page.
- The player list at the top has every profile on the server, playing or not, so the page can be kept on one player while a friend plays.
- Only a player's kills have a ring round the body to begin with. The red ring round a PMC a bot killed is off until Corpses > "PMCs killed by bots" is turned on.
- The map can be dragged until its edge is clear of the menu, the Raid list and the bar along the top.
- The map stays where it was dragged to when a map is captured again or updated during a raid: it no longer goes back to the player and the starting zoom.
- An extract's marker is in the middle of the ground that counts as it, not where the game keeps its object: Woods' RUAF Gate was 30 m off the road.
- A MapVariants version is named once: Customs (Classic), not Customs (Customs - Classic).
- Opening the menu no longer moves the map: it stays in the middle of the screen.
- You are in the Raid list too, first, with your health and level; pressing your row follows you again.
- Tutorial-Backport's tutorial (SageSPT) is named Tutorial on the map once a map of it has been captured.
- Settings > Screen > Cursor: pick the mouse pointer. Satellite (as before), Arrow, Sharp, Small, Cartoon, Gauntlet and Large, all from Kenney's Cursor Pack (CC0), or System for the computer's own.
- Loot spawn points off the map's picture are left out: Factory's loot table has over a hundred of them, drawn as rings on nothing at the map's edge.
- The REC sign is in the status at the top ("In raid · Customs ● REC"), not over the map.
- Containers that only spawn in some raids (hidden caches, buried barrels) and quest places that trader and quest mods add (Lotus and others) are on the map now: once a page is open, the game sends where its raid's containers and quest places stand, once a raid, and the ones the map didn't have are added. Quest goals that send you to such a place get their marker.
- A colour picked in Settings > Colours in Firefox on Windows is the one kept, not black.
- An item a mod gave no name goes by its short name, else its template's own name, not its id.
- A building with a few floors has a button for each by name (Ground floor, 2nd floor, 3rd floor..., and what's underground on that map: Tunnels on Factory, Bunker on Reserve and Woods, Parking on Interchange, Underground on Ground Zero, Basement elsewhere), with Auto first. Many floors keep the arrows. Floors are counted by the building's own storey height, so a building with tall storeys has no numbers missing (Interchange's mall: Ground floor, 2nd floor, 3rd floor), no two floors share a name, and three or more levels underground are numbered (Bunker, Bunker 2, Bunker 3). The ground floor is the one you walk into from the ground outside, as the map's capture measured the ground by the walls: what's under it is underground, what's over it the 2nd floor and up. So a building on low ground (Lighthouse's water treatment, by the sea) or down a slope starts at its ground floor, a bunker under a hill (Woods) is a bunker, and a ramp or a pit by a cellar doesn't make the cellar the ground floor. Labs, the Labyrinth and Terminal are named from the level they're played on; the Icebreaker has decks. Every building has a button for each floor by name, however many (the row scrolls past what fits), and one with a single floor shows its name.
- While a floor of a building is shown, the rest of the map is darker, so the floor stands out. Settings > View > "Map round a floor" sets how dark, or not at all. Within the building, what's another floor (the ground floor round Factory's tunnels) is as dark, and the floor shown has a gold outline where it covers less than the building.
- A floor a map's capture saw under the whole map (one of Factory's has one, 15 m under the tunnels) has no button: it isn't a floor anybody walks on.
- In the Raid list, how much health somebody has left is a number by their name (in amber or red once hurt) and a clearer bar along the row. Pointed at, it says what each part of the body has left, and a player's energy and water.
- Somebody followed or in a fight is marked by a short bar inside their row in the Raid list, not by its edge.
- What somebody wears or carries counts towards what they're worth only if it can be looted, as the game has it: not a PMC's melee, an armband, a special slot's tool (the multitool and the like) or the pockets themselves. It's still listed, marked "can't be looted".
- Pressing somebody in the Raid list follows them on the map; what they wear and carry is set out from the worth beside their name.
- Somebody killed by a gas explosion is marked with an orange burst and "Gas explosion".
- Magazines a bot drops in a quick reload lie on the map until picked up, with a ring while a bot goes back for one (COMET).
- One of PBT's cheaters says what PBT made of it (its personality and its cheats) when pointed at, and in the Raid list.
- COMET squad moves that were declined, cut short or had no role assigned say so.
- Loose loot a quest wants found in raid is a hexagon with a tick (as the game marks found-in-raid items), not an F. In a container's list it has a FIR tag beside its name, and its worth stays in line with the others.

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
