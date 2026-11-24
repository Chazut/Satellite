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
- REC in the top bar of the live map: red while raids are recorded (blinking while the raid shown is), grey ("REC off") when recording is stopped. Pressed, it stops recording, the raid going on and every one after, until pressed again; a server restart keeps it stopped. The raid history says so, with a way to start it again (also under Manage recordings, which is where it is on a phone).
- The replay's timeline is red over each fight, from its first shot to the kill, with a line down the bar at each kill (gold for your own). Along its foot, loot sprees: somebody picking up five things or more in a short while (a bot clearing a marked room), pointed at for who and how much, pressed to go there following them (cog > Loot sprees).
- On the replay's timeline, kills close together share a pin only when one killer made them near each other; other kills that close each keep their own pin, side by side.
- Dragging along a replay's timeline shows the pick-ups of the moments before where it stops, rising and fading as when it plays.
- ORBIT's zones (Raid > ORBIT field) are drawn where ORBIT has them, each at its own size: they were all in one spot near the middle of the map.
- Pointing at a bot, following it or picking it in the Raid list shows its ORBIT squad's goal now on the map, with a line to it, whatever the ORBIT switches; the bot's card says it too ("ORBIT goal").
- Action icons: a small badge by each bot for what it's doing this moment, as SAIN or COMET has it: pushing, falling back, reloading, healing, throwing a grenade, getting to cover. Map > People and bots > Action icons.
- Squad tactic words: over each bot while its squad carries out a COMET tactic, its part in it (Support, Flank, Rear, Crossfire, Storm...), for every squad. Map > People and bots > Squad tactic words.
- Team number by names: after the name of each player and PMC who came in with others, on the map and in the Raid list (#2). Map > People and bots > Team number by names.
- Team colours: each PMC team drawn in its own colour, the colour of its team number. Off to begin with: Map > People and bots > Team colours.
- Doors opened, shut and unlocked are said on the map where the door is, with who did it (the one nearest it), and listed in the raid's events (Doors) and the raid history's timeline. Map > People and bots > Doors on the map.
- A pick-up from an airdrop's crate says so ("from the airdrop"), on the map and in the lists.
- Loot > Filters > Prices: Flea market or Handbook, for a game played without the flea. Set for the whole server, so every page shows the same.
- Grey round a floor: while a floor of a building is shown, the rest of the map and the building's other floors are grey as well as darker, so the floor shown, in colour, stands out. Map > View > Grey round a floor.
- COMET's grenade suppression (one throws, the rest hold angles) and siege (the squad watches the ways out of the building the enemy is in) are shown like its other squad tactics: in the Raid list, the raid's events, the bot's card and over the bot. Only with a COMET that has them; without COMET, or with an older one, nothing changes.
- A floor of a building shows only where it is: on Labs, the basement no longer has the glass roof over its halls. What isn't the floor shown is dimmed like the other floors, and Map > View > Hide other floors leaves only the floor shown drawn.
- Along a replay's bar: Performance, Normal or Debug. Performance draws the same replay at most 15 times a second (markers a moment behind, far less of the computer); Debug shows what's going on under the timeline. Debug moved there from the cog.
- A bot's level is only said where it means something: a player's, a PMC's, or a bot above level 1 (a mod such as PBT can level bots). Scavs, bosses and the rest are all level 1, so it's left out for them.
- The floor shown has one colour however it was picked; the Auto button is lit while Auto picks the floor.
- A raid's outcome fits its tile on the raid history's Overview ("Ended abruptly" was cut short).
- A replay's trails start where somebody was put down: bots the game moves in as they arrive (RUAF) no longer trail a long line from where they were held.
- The player's own colour can't turn black: a colour is kept only once picked (Firefox says black as its colour window opens), and the player is never kept black, however it was saved.
- Team numbers sit in the middle of their circles.
- The replay's side panel fills a fold as soon as it's opened (Switches, Ghost hearing, Bot objectives...), saying when there's nothing; it waited until something else was pressed.
- Beside a replay, a Settings fold: prices (flea or handbook), the switches for people and floors (team numbers and colours, action icons, tactic words, doors, how dark and grey round a floor, hiding other floors) and every colour, the same settings as the live map's menu.
- Zooming is smoother: while the map zooms its pictures are only stretched, and drawn again sharp a moment after it stops.
- Presets, a tab of the menu: All info (everything Satellite can show), Minimal (everybody in the raid without what each is up to, loot worth 50,000 ₽ or more, your quests, extracts and the airdrop) and Fair play (only what you'd know in the game: you, your friends, the kills you make, your extracts, quest places, power switches and the airdrop; no bots, no loot, no quest items, no alerts). No preset puts on what's for looking into a mod (ORBIT's and Phobos's fields, hearing circles, ghost fights). One press sets the switches of the other tabs; colours, layout and the map's view stay. The settings from before can be put back with one press. Your own presets too: the switches as they are now, saved under a name you pick, kept with the page's settings (Export and Import take them along, Reset keeps them). Reset, Export and Import settings moved here from Settings.
- The raid history's Most loot extracted counts what the raid gained you: what you got out with less what you went in with, item by item, so your kit and what's in your secure container aren't counted. Your kit's worth is said under it. Raids recorded before this count what was picked up.
- Extracts are named in the raid history as the game names them (Courtyard, not E8_yard), raids recorded before this too.
- Beside a replay, Raid events has Whole raid (to begin with) and So far: the whole raid's events of the kind picked, in order, each with its time in the raid (Tactic: every move COMET had a squad make). Pressing one goes to that moment.
- Pressing a tab of the menu while searching the settings puts the search away and shows that tab.
- A raid history page left open keeps to the switches it changed itself: what was changed on the live map since (a preset, say) stays.
- What a button, switch or mark says when pointed at shows at once in a box of the page's own, everywhere on both pages, not the browser's slow plain one.
- On a replay's timeline the red of a fight stops over the loot sprees' lane, and the time pointed at is shown over both.
- An extract or transit on another floor than you is drawn like loot there: fainter, with ▲ or ▼, and its floor said after its name (Stylobate Building Elevator · 3rd floor). The arrows at the screen's edge pointing to extracts give each one's name over how far it is, with ▲▼ and its floor when it's on another.
- The raid's events (Squads, ORBIT, Doors, Loot) follow Raid > Who's shown: what a bot did isn't listed while its kind is switched off, and a door is said on the map only when whoever opened it is shown.
- Left Alt + H in the game opens the raid history in the browser, as Left Alt + M opens the map (BepInEx config: "Open the raid history").
- Extracts off the screen are pointed to at its edge, as quests and people are: the extract's diamond in its colour, with how far. Map > View > Who gets an arrow > Point to extracts off screen.
- Loot is read a little at a time while a page is open (at most 1.5 ms of a frame), not all at once: on Streets that held the game up 6 to 50 ms every few seconds.
- The game plugin lets go of a raid's containers, locks, switches and doors as soon as the raid is over, not when the next one begins.
- Settings > Screen > Performance mode: the map is drawn at most 15 times a second, for a slow computer or a replay watched while playing.
- The map is drawn again only when something on it moves: a paused replay, a map with no raid and the raid history's other tabs take next to nothing of the computer's time (a paused replay of Woods went from about half of one core to 2%).
- With Raid Review installed too, the raid history says every raid is recorded twice, and how to import its raids before removing it.
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
