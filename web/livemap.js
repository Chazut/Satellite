'use strict';
// The live map of a raid. The map is a picture of the location from above, which the game plugin took in the game and
// the server keeps in tiles; the markers are what the plugin reports from the raid. A place is [east, north] in
// metres, the game's own, and every tile covers a known square of ground, so markers land where they are. The page
// only looks: it sends nothing to the game, and its options are its own (kept in this browser).
(() => {
  const $ = id => document.getElementById(id);
  // the page's own words, in the language picked (see lang.js), before anything else is written
  window.fumsLangs.translatePage(document.body);
  const stage = $('stage');
  const layersEl = $('layers');
  const canvas = $('markers');
  const ctx = canvas.getContext('2d');
  const RAD = Math.PI / 180;
  const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif';

  // the page's address ending in ?debug: a line at the bottom left says what the floor display goes by
  const DEBUG = new URLSearchParams(location.search).has('debug');
  // ?fake=team: three made-up friends walk about near the player (two people and a bot), to see how a team looks.
  // Only on this page, only while the address says so; nothing is sent anywhere.
  const FAKE_TEAM = new URLSearchParams(location.search).get('fake') === 'team';
  function fakeTeam(at, now) {
    const who = [['Tester_Anna', 34, 9, 0], ['Tester_Borys', 51, 16, 2.1], ['Tester_Bot', 12, 26, 4.2]];
    return who.map(([name, level, far, phase], i) => {
      const turn = now / 9000 * (i % 2 ? -1 : 1) + phase;
      return { id: -9001 - i, c: 'Friendly Player', t: name, p: [at[0] + Math.cos(turn) * far, at[1] + Math.sin(turn) * far, at[2]],
        r: ((i % 2 ? -1 : 1) * -turn * 180 / Math.PI + (i % 2 ? 180 : 0)) % 360, dyn: 1, lv: level, g: 'fake-team', pid: 'fake' + i,
        df: i === 2 ? 'hard' : undefined, ly: i === 2 ? 'FollowerLayer' : undefined };
    });
  }
  let debugAt = 0;

  const ZOOM_MIN_DIVIDER = 1.1;
  // as close as it goes: screen pixels to a metre
  const ZOOM_CLOSEST = 48;

  // a lock, by its kind (KeycardDoor: "Keycard door")
  const lockName = kind => T({ Door: 'Door', Trunk: 'Trunk', KeycardDoor: 'Keycard door', Switch: 'lock|Switch', DoorSwitch: 'Door switch' }[kind] || 'Lock');
  // the game's names for its locations
  const PLACES = {
    bigmap: T('Customs'), factory4_day: T('Factory'), factory4_night: T('Factory (night)'), Woods: T('Woods'), Shoreline: T('Shoreline'),
    Interchange: T('Interchange'), RezervBase: T('Reserve'), laboratory: T('The Lab'), Lighthouse: T('Lighthouse'),
    TarkovStreets: T('Streets of Tarkov'), Sandbox: T('Ground Zero'), Sandbox_high: T('Ground Zero (21+)'), Labyrinth: T('The Labyrinth')
  };
  // A map is kept by its location id; when a mod swapped in another version of the location, the version follows a
  // "~" ("Interchange~backport"). The location alone is what quests and the map's turn go by.
  // A map can also come with snow on the ground, as "<map>@snow" (the snow add-on): shown in place of the map in a raid
  // whose season has snow ("sea" in the report), when it's installed.
  const SNOW = '@snow', SNOWY_SEASONS = ['Winter', 'AutumnLate', 'SpringEarly', 'Storm'];
  const isSnow = loc => String(loc || '').endsWith(SNOW);
  const noSnow = loc => isSnow(loc) ? String(loc).slice(0, -SNOW.length) : String(loc || '');
  const baseOf = loc => noSnow(loc).split('~')[0];
  const sameLoc = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  // The map shown for a location: its snow map in a snowy raid, when there is one; its own; or, for a version of it
  // (Interchange~backport) that isn't here, the location's own map, so the raid is still shown (maps come in add-ons,
  // and one may not be installed); null: none.
  const snowyRaid = () => !!report && !!report.raid && SNOWY_SEASONS.includes(report.sea);
  const plainMapFor = loc => maps.find(m => m.loc === loc) || (String(loc || '').includes('~') && maps.find(m => m.loc === baseOf(loc))) || null;
  const mapFor = loc => {
    const plain = plainMapFor(loc);
    if (plain && snowyRaid() && !isSnow(loc)) return maps.find(m => m.loc === plain.loc + SNOW) || plain;
    return plain;
  };
  // the location a raid's things are shown on: its map's (see mapFor)
  const shownLoc = loc => (mapFor(loc) || { loc }).loc;
  // the add-on a location's map comes in, when it's one there is but isn't installed (the server tells these apart
  // by the raid's scenes); null: none
  const addonFor = loc => addons.find(a => a.loc === loc) || null;
  // a version told only by its scenes, which no map or add-on has: kept by their hash (8 hex digits)
  const unknownVersion = loc => /^[0-9a-f]{8}$/.test(noSnow(loc).split('~')[1] || '');
  // a map's name: as captured (the game's name for a mod's own location, the version's name), or else as known here
  const placeName = loc => {
    const known = maps.find(m => m.loc === loc);
    if (known) return known.name;
    const addon = addonFor(loc);
    if (addon) return (PLACES[addon.base] || addon.name || addon.base || baseOf(loc)) + (addon.vname ? ' (' + addon.vname + ')' : '');
    const base = baseOf(loc), version = noSnow(loc).split('~')[1];
    return locationName(base) + (version ? ' (' + (/^[0-9a-f]{8}$/.test(version) ? T('another version') : version) + ')' : '');
  };
  // a location's name, whichever version: for quests, which go by the location
  const locationName = base => {
    const captured = maps.find(m => sameLoc(m.base, base));
    return PLACES[base] || (captured && captured.title) || base;
  };

  // how each kind of marker is drawn; a later one is drawn over an earlier one
  const KINDS = {
    'Extract': { name: T('Extracts'), col: '#3ddc5a', shape: 'exit', size: 1, label: true, order: 0 },
    'Corpse': { name: T('Corpses'), col: '#aab4c0', shape: 'cross', size: 0.8, order: 1 },
    'Other AI': { name: T('Other AI'), col: '#8d96a2', shape: 'arrow', size: 0.95, order: 2 },
    'Scav': { name: T('Scavs'), col: '#f2e24a', shape: 'arrow', size: 1, order: 2 },
    'Smuggler': { name: T('Smugglers'), col: '#5b9bf0', shape: 'arrow', size: 1, order: 3 },
    'Raider': { name: T('Raiders'), col: '#ff7a45', shape: 'arrow', size: 1.05, order: 4 },
    'Rogue': { name: T('Rogues'), col: '#b8e04a', shape: 'arrow', size: 1.05, order: 4 },
    'Black Division': { name: T('Black Division'), col: '#ececec', shape: 'arrow', size: 1.05, order: 5 },
    'RUAF': { name: 'RUAF', col: '#7da35f', shape: 'arrow', size: 1.05, order: 5 },
    'RUAF Remnant': { name: T('RUAF remnant'), col: '#b08a5a', shape: 'arrow', size: 1.05, order: 5 },
    'Civilian': { name: T('Civilians'), col: '#b9d6ee', shape: 'arrow', size: 0.9, order: 2 },
    'Infected': { name: T('Infected'), col: '#b84a32', shape: 'arrow', size: 1, order: 3 },
    'Sniper': { name: T('Sniper scavs'), col: '#fff3a8', shape: 'arrow', size: 1, order: 3 },
    'Enemy Player': { name: T('Enemy PMCs'), col: '#ff5148', shape: 'arrow', size: 1, order: 4 },
    'Guard': { name: T('Guards'), col: '#ff7fbf', shape: 'arrow', size: 1.05, label: true, order: 5 },
    'Cultist': { name: T('Cultists'), col: '#b06fa8', shape: 'arrow', size: 1.05, order: 5 },
    'Goon': { name: T('Goons'), col: '#33d6c0', shape: 'arrow', size: 1.15, label: true, order: 6 },
    'Boss': { name: T('Bosses'), col: '#c77dff', shape: 'arrow', size: 1.15, label: true, order: 7 },
    'Friendly Player': { name: T('Friendly players'), col: '#ffdcab', shape: 'arrow', size: 1.1, label: true, order: 8 },
    'BTR': { name: T('BTR'), col: '#a3c45c', shape: 'btr', size: 1, label: true, order: 8.5 },
    'Airdrop': { name: T('Airdrops'), col: '#ff6fb5', shape: 'drop', size: 1.15, label: true, order: 8.4 },
    'Main Player': { name: T('Player'), col: '#ffb253', shape: 'arrow', size: 1.3, order: 9 }
  };
  const OTHER = { col: '#ccd5df', shape: 'dot', size: 0.8, order: 1 };
  // the deadly ground at a location's edge, drawn on the map itself; claymores that lie together make a minefield
  const MINE_REACH = 2.5;       // metres around a claymore drawn as dangerous
  const MINE_TOGETHER = 40;     // claymores this close are one field
  const ZONES = {
    mine: { name: T('Minefields'), col: '#ff3b30', label: T('Mines') },
    sniper: { name: T('Sniper zones'), col: '#ffd23d', label: T('zone|Sniper'), hatch: true }
  };
  // an extract: closed, wants something of you first, open
  const EXIT_COL = ['#d8504a', '#e8c547', '#3ddc5a'];
  // What lies about and where things stand: each a layer that can be turned off on the page. server: the layer of
  // the server's config.jsonc that holds it.
  const LAYERS = {
    quest: { name: T('Quest items'), col: '#ffe14d', server: 'loose' },
    questZones: { name: T('Quest places'), col: '#ffe14d', server: null },
    btrRoad: { name: T('BTR road and stops'), col: '#a3c45c', server: null },
    loose: { name: T('Loose loot'), col: '#7fd36b', server: 'loose' },
    lootSpawns: { name: T('Loot spawn points'), col: '#e6d38a', server: 'loose' },
    boxes: { name: T('Containers'), col: '#c9a86a', server: 'contents' },
    bodies: { name: T('Corpse loot'), col: '#949ca8', server: 'contents' },
    locks: { name: T('Locked doors'), col: '#ff8a3d', server: 'locks' },
    spawnPmc: { name: T('PMC spawns'), col: '#4aa8ff', server: 'spawns' },
    spawnScav: { name: T('Scav spawns'), col: '#f2e24a', server: 'spawns' },
    spawnBoss: { name: T('Boss spawns'), col: '#c77dff', server: 'spawns' }
  };
  // worth, in roubles, and the colour it's drawn in: the first one it's under
  const WORTH = [[10000, '#aab4c0'], [30000, '#7fd36b'], [70000, '#4aa8ff'], [150000, '#c77dff'], [Infinity, '#ffb13d']];
  const worthCol = v => WORTH.find(w => v < w[0])[1];
  // (grouped by hand: toLocaleString takes a hundred times as long, and this is asked for a lot)
  const roubles = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' ₽';
  // a worth in short ("394k", "1.2M"), and only roughly ("~400k"): to the nearest thousand, ten thousand, fifty
  // thousand or hundred thousand, as it grows
  const shortWorth = v => v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v));
  const rough = v => {
    const step = v < 10000 ? 1000 : v < 100000 ? 10000 : v < 1000000 ? 50000 : 100000;
    return '~' + shortWorth(Math.max(step, Math.round(v / step) * step));
  };
  // what a container is drawn with, by its sort (the server's "c" for its template)
  const BOX_GLYPH = {
    safe: 'i:boxSafe', register: 'i:boxRegister', drawer: 'i:boxDrawer', bag: 'i:boxBag', jacket: 'i:boxJacket',
    tools: 'i:boxTools', pc: 'i:boxPc', grenade: 'i:boxGrenade', weapon: 'i:boxWeapon', med: 'i:boxMed',
    food: 'i:boxFood', cache: 'i:boxCache', body: 'i:boxBody', crate: 'i:boxCrate'
  };
  // a lock, by what it's on
  const LOCK_GLYPH = { Door: 'i:lock', Trunk: 'i:trunk', KeycardDoor: 'i:keycard' };
  const SPAWN_LETTER = { spawnPmc: 'P', spawnScav: 'S', spawnBoss: 'B' };

  // ---- what the page remembers ---------------------------------------------------------------------------------
  // spanIn, spanOut: how close auto zoom goes indoors and outdoors, as metres across the screen's short side
  // hide, show: marker kinds turned off and on here. player: whose game to show, { sid, name }; none: whoever is playing
  // floor: 'auto' (the one the player is on), 0 (the view from above) or a floor's number
  const SPAN_IN = [10, 120], SPAN_OUT = [40, 900];
  // worth: loose loot and containers worth less than this many roubles are left off (quest items never are)
  // itemNames: loose loot named up close. allNames: every player and bot named.
  // myQuests: only quest items and places of the quests the player has started
  // (what a page starts with, the first time it's opened, is how the mod ships: the author's own page as of 1.0.0)
  const prefs = Object.assign({ follow: true, autoZoom: false, spanIn: 120, spanOut: 400, scale: 1, zoom: 0.32, map: '',
    hide: [], show: [], player: null, floor: 'auto', worth: 0, itemNames: true, names: 'all', closeSpan: 250, myExits: true, goneExits: false, allCorpses: true,
    myQuests: true, otherLoot: 30, insideMine: true, insideLook: true, lookSpan: 220, pressOpen: true, squadParts: true, edge: true, corpseKind: true, botDetails: true, botDiff: true, botSAIN: true, botORBIT: true, botCOMET: true, botLoot: true, edgeQuests: true, myName: true, shots: true, health: true, eventsKind: 'tactic', feed: true, feedMine: true, feedPmc: true, feedBoss: true, feedAi: true, orbitLines: false, areaPmc: false, lootArea: false, squadPane: true,
    rosterShut: [], rosterGhosts: 'in', rosterHp: true, rosterDoing: true, rosterSlim: false, mapDoing: false, healthAll: true,
    orbitNames: false, orbitHear: false, orbitFights: true, lootCell: 60, areaR: 70, roofLoot: true, roofTotals: true, roofTotalsUnder: false, feedNames: 'all', feedBg: 70, feedRows: 5,
    feedPos: 'free', feedAt: { l: false, t: false, x: 0.143, y: 0.0064 }, eventsPos: { x: 0.135, y: 0.039, v: 2 }, keepZoom: true, feedKeep: true, feedFolded: false, feedBox: true, textScale: 0.9, mapLight: 100, alertSound: false, seenDead: true,
    alerts: [], has: null, seenInfected: false, rosterNear: false, bestMore: false, lootOff: [], boxOff: [], peek: true, rosterFog: false,
    latin: true,
    // the menu's groups, open or folded
    groups: { labels: true, show: true, key: true, quests: true, view: true, loot: true, alerts: true, roster: true, lootKinds: true, lootMore: true, lootKey: true,
      rosterMore: true, who: true, layout: true, spawnKinds: false, rosterRows: true, bots: true, orbitMap: false, feed: true, areas: false, boxKinds: true,
      lootRoofs: true, colors: true, phone: true, screen: true } }, read());
  // lootOff: the kinds of loot left off (see LOOT_KINDS). peek: what's in containers, bodies, airdrops and on bots is
  // shown. rosterFog: the Raid list names everyone seen this raid but not who's still alive. latin: names written in
  // Cyrillic are shown in Latin letters (bosses by their English names)
  if (!Array.isArray(prefs.lootOff)) prefs.lootOff = [];
  // boxOff: the sorts of container left off the map (see BOX_GLYPH)
  if (!Array.isArray(prefs.boxOff)) prefs.boxOff = [];
  // rosterShut: the groups of the Raid list folded away (a kind, or 'Ghosts'). rosterGhosts: ORBIT's ghosts in a group
  // of their own ('own'), with their kind ('in') or not listed ('hide'). lootCell, areaR: how big a rough area of loot
  // and of a PMC is, in metres. feedNames: whose names the kill feed gives. feedBg: how dark its background is, percent
  if (!Array.isArray(prefs.rosterShut)) prefs.rosterShut = ['Ghosts'];
  // areaKinds: the kinds shown only as a rough area (before this: PMCs alone, areaPmc)
  if (!Array.isArray(prefs.areaKinds)) prefs.areaKinds = prefs.areaPmc ? ['Enemy Player'] : [];
  delete prefs.areaPmc;
  if (!['own', 'in', 'hide'].includes(prefs.rosterGhosts)) prefs.rosterGhosts = 'in';
  // ghosts are listed with their kind, like any bot, unless asked otherwise (a page from the hour they weren't: put back once)
  if (!prefs.ghostsIn) { prefs.ghostsIn = true; prefs.rosterGhosts = 'in'; prefs.rosterShut = prefs.rosterShut.filter(k => k !== 'Ghosts'); }
  if (!['all', 'victim', 'kinds'].includes(prefs.feedNames)) prefs.feedNames = 'all';
  prefs.lootCell = Math.min(150, Math.max(20, +prefs.lootCell || 60));
  prefs.areaR = Math.min(200, Math.max(30, +prefs.areaR || 70));
  // (a page from the evening it started at 30, which was too dark: put to 15 once)
  if (prefs.feedBgSet !== 2) { prefs.feedBgSet = 2; if (+prefs.feedBg === 15) prefs.feedBg = 30; }
  prefs.feedBg = Math.min(100, Math.max(0, Number.isFinite(+prefs.feedBg) ? +prefs.feedBg : 30));
  // feedRows: how many kills the feed shows at once, at most. (feedOnlyMine and rosterTags: switches before 1.0.0,
  // dropped: the four kill feed switches and One line each say the same)
  delete prefs.feedOnlyMine;
  delete prefs.rosterTags;
  // textScale: the names and words on the map, apart from the markers. mapLight: how bright the map picture is, percent.
  // alertSound: a sound with each alert
  prefs.textScale = Math.min(2.4, Math.max(0.6, +prefs.textScale || 1));
  prefs.mapLight = Math.min(100, Math.max(30, +prefs.mapLight || 100));
  prefs.alertSound = prefs.alertSound === true;
  prefs.feedRows = [3, 5, 8, 12].includes(+prefs.feedRows) ? +prefs.feedRows : 5;
  // feedPos: the corner the feed sits in (auto: the bottom one on the menu's side)
  // ('free': where it was dragged to, feedAt: { l, t, x, y }: grows from its left or right, top or bottom edge, that
  // edge x and y of the window's width and height in from it)
  if (!['auto', 'bl', 'br', 'tl', 'tr', 'free'].includes(prefs.feedPos)) prefs.feedPos = 'auto';
  if (!prefs.feedAt || !Number.isFinite(prefs.feedAt.x) || !Number.isFinite(prefs.feedAt.y)) { prefs.feedAt = null; if (prefs.feedPos === 'free') prefs.feedPos = 'auto'; }
  if (prefs.phoneLight === undefined) prefs.phoneLight = true;
  // awake: the screen is asked to stay on while the page is in front. speed: the speed numbers are shown
  if (prefs.awake === undefined) prefs.awake = true;
  // rosterNear: the Raid list is in order of distance from the player. bestMore: its best loot lists 30, not 12
  // otherLoot: how strongly loot on another floor than the player is drawn, in percent (0: not at all)
  // insideMine: the inside of the building the player is in is shown. insideLook: and of the one in the middle of the
  // screen while looking about.
  // Extracts shows every extract of the location; in a raid, the player's own by their state and the rest hollow.
  // myExits: only the player's own, in a raid. goneExits: the ones that are no longer there (a car that never came,
  // or that left with someone) are still shown, in red. (Before 1.0.0: allExits and openExits, read once.)
  if (prefs.openExits === true && prefs.exitsOnce !== 1) prefs.goneExits = false;
  prefs.exitsOnce = 1;
  delete prefs.allExits;
  delete prefs.openExits;
  delete prefs.refollow;
  if (typeof prefs.myExits !== 'boolean') prefs.myExits = true;
  if (typeof prefs.goneExits !== 'boolean') prefs.goneExits = false;
  // corpseKind: a body says what it was
  // alerts: the kinds that are announced once seen. has: the kinds only a mod brings that this game has
  // (1.0.0: a building opens by zooming in on it again, as well as when pressed; a page from the days it was put off
  // gets it back, once, and can put it off in Map > View). lookSpan: how close that is, the screen's short side in
  // metres. pressOpen: a building pressed opens
  if (prefs.lookBack !== 1) { prefs.insideLook = true; prefs.lookBack = 1; }
  delete prefs.lookOnce;
  const LOOK_SPAN = [60, 500];
  prefs.lookSpan = Math.min(LOOK_SPAN[1], Math.max(LOOK_SPAN[0], +prefs.lookSpan || 220));
  if (typeof prefs.pressOpen !== 'boolean') prefs.pressOpen = true;
  prefs.otherLoot = Math.min(100, Math.max(0, Number.isFinite(+prefs.otherLoot) ? +prefs.otherLoot : 30));
  if (typeof prefs.myQuestItems !== 'boolean') prefs.myQuestItems = prefs.myQuests !== false;
  if (typeof prefs.myQuestPlaces !== 'boolean') prefs.myQuestPlaces = prefs.myQuests !== false;
  if (!Array.isArray(prefs.alerts)) prefs.alerts = [];
  if (!Array.isArray(prefs.has)) prefs.has = null;
  if (!Array.isArray(prefs.brains)) prefs.brains = null;
  delete prefs.zin;
  delete prefs.zout;
  // names: 'some' (friends, the Goons, bosses), 'players' (every PMC too, bots or not) or 'all' (the bots too)
  if (prefs.allNames) prefs.names = 'all';
  delete prefs.allNames;
  if (!['some', 'players', 'all'].includes(prefs.names)) prefs.names = 'all';
  // closeSpan: item names, and every container, show once the screen's short side is this many metres or fewer
  const CLOSE_SPAN = [20, 400];
  prefs.closeSpan = Math.min(CLOSE_SPAN[1], Math.max(CLOSE_SPAN[0], +prefs.closeSpan || 250));
  const clampSpan = (v, range, fallback) => Math.min(range[1], Math.max(range[0], +v || fallback));
  prefs.spanIn = clampSpan(prefs.spanIn, SPAN_IN, 120);
  prefs.spanOut = clampSpan(prefs.spanOut, SPAN_OUT, 400);
  if (!Array.isArray(prefs.hide)) prefs.hide = [];
  if (!Array.isArray(prefs.show)) prefs.show = [];
  if (!prefs.player || typeof prefs.player.sid !== 'string') prefs.player = null;
  const hidden = new Set(prefs.hide);
  // cols: the marker colours picked in Settings, Colours, over the usual ones ({ 'Scav': '#rrggbb', 'Layer quest': ... })
  if (!prefs.cols || typeof prefs.cols !== 'object' || Array.isArray(prefs.cols)) prefs.cols = {};
  // the page's own two colours, picked there too: its highlights (switches, buttons, the tab shown) and what's behind
  // everything; as 'Page primary' and 'Page secondary' in cols
  const PAGE = { primary: { name: T('Highlights'), col: '#7b9cff' }, secondary: { name: T('Background'), col: '#0c0c12' } };
  const COL_HOME = { 'Page primary': PAGE.primary.col, 'Page secondary': PAGE.secondary.col };
  for (const k of Object.keys(KINDS)) COL_HOME[k] = KINDS[k].col;
  for (const k of Object.keys(LAYERS)) COL_HOME['Layer ' + k] = LAYERS[k].col;
  for (const k of Object.keys(ZONES)) COL_HOME['Zone ' + k] = ZONES[k].col;
  for (const key of Object.keys(prefs.cols)) {
    const look = colLook(key), col = hex6(prefs.cols[key]);
    if (look && col) look.col = col;
    else delete prefs.cols[key];
  }
  // what a colour key is drawn by: a kind, 'Layer <name>' or 'Zone <name>'
  function colLook(key) {
    return key.startsWith('Page ') ? PAGE[key.slice(5)] : key.startsWith('Layer ') ? LAYERS[key.slice(6)] : key.startsWith('Zone ') ? ZONES[key.slice(5)] : KINDS[key];
  }
  // '#abc', 'abc', '#AABBCC' or 'aabbcc' as '#aabbcc'; anything else null
  function hex6(v) {
    let s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s.startsWith('#')) s = '#' + s;
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }
  // The page's colours, as picked: the highlight and its tints; the background, the panels a shade off it, and on a
  // light one dark words. Neither picked: the stylesheet's own.
  function paintPage() {
    const root = document.documentElement.style;
    const set = (k, v) => v ? root.setProperty(k, v) : root.removeProperty(k);
    const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const lum = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const a = prefs.cols['Page primary'], b = prefs.cols['Page secondary'];
    const back = rgb(b || PAGE.secondary.col), light = lum(back) > 0.5;
    set('--accent', a);
    set('--accent-soft', a && 'rgba(' + rgb(a).join(', ') + ', 0.15)');
    set('--line-strong', a && 'rgba(' + rgb(a).join(', ') + ', 0.55)');
    // the words on a highlight: dark on a light one, light on a dark one
    const ink = lum(rgb(a || PAGE.primary.col)) > 0.5 ? (light ? '#0c0c12' : b || null) : '#ffffff';
    set('--ink', a || b ? ink : null);
    const panel = b && back.map(c => Math.round(light ? c * 0.95 : c + (255 - c) * 0.05)).join(', ');
    set('--bg', b);
    set('--panel', b && 'rgba(' + panel + ', 0.86)');
    set('--panel-solid', b && 'rgba(' + panel + ', 0.97)');
    set('--text', b && light ? '#16171c' : null);
    set('--bright', b && light ? '#000000' : null);
    set('--dim', b && light ? '#4f5562' : null);
    set('--line', b && light ? 'rgba(0, 0, 0, 0.14)' : null);
    set('--hover', b && light ? 'rgba(0, 0, 0, 0.06)' : null);
  }
  paintPage();
  function read() {
    try { return JSON.parse(localStorage.getItem('livemap') || '{}') || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem('livemap', JSON.stringify(prefs)); } catch (e) { /* private window */ }
  }

  // ---- state ---------------------------------------------------------------------------------------------------
  let maps = [];
  // the add-ons there are that aren't installed: [{ loc, base, name, vname, zip }]
  let addons = [];
  let mapsPrint = '';
  let mapsAsked = false;
  let map = null;
  let vw = 1, vh = 1;
  let zoom = 1, zoomTarget = 1, zoomMin = 1, zoomMax = 10;
  let panX = 0, panY = 0;
  let zoomAt = null;            // the screen point a zoom holds still
  let dirty = true;

  let sid = '';                 // whose game
  let streamFor = null;         // the game the server is asked to pass on ('' : every game)
  const sessions = new Map();   // id -> { heard, raid }
  let games = [];               // the games the server hears from: { sid, name, raid }
  let report = null;            // that game's last full report
  let heard = 0;                // when it was last heard from
  let live = [];                // its markers, in drawing order
  let liveById = new Map();
  let me = null;                // the player: { x, y, z } wanted, { cx, cy, cz } drawn, in: under a roof
  let raidKey = '';
  let pointed = null;
  let drawn = [];
  let serverLost = false;
  let zoomState = null;         // auto zoom: true indoors, false outdoors, null not applied yet
  let stateWanted = null, stateSince = 0;
  let tiles = [];               // the map's tiles: { img, col, row, at, want }
  let tilesPrint = '';
  // the floor shown: of one building (place), over the view from above; place 0 is none
  let floorShown = { place: 0, n: 0 };
  let floorWantKey = '0:0', floorSince = 0;
  let floorEl = null;           // that floor's own tiles, cut to the building's shape
  let floorTiles = [];
  let floorEdge = [];           // the outline of where that floor is: [east, north, east, north] lines
  let period = 100;             // milliseconds between the game's reports, about
  let told = 0;
  let places = null;            // where things stand on the map shown: { loc, boxes, locks, spawns, names }
  let lootTable = null;         // where loot can spawn on it and what, from the server's loot tables (see readSpawns)
  let lootAsked = '', lootAskedAt = -1e9;
  let placesAsked = '', placesAskedAt = 0;
  let things = null;            // what lies about in the raid shown: { loc, loose, inside, open, names }
  let thingsWanted = 0, thingsHave = -1, thingsAsking = false, thingsTriedAt = 0;
  let thingsDrawn = [];         // what of it is on the screen, to point at: { x, y, r, tip }
  let thingsPut = [];
  let corpsesNow = null;        // the corpses, each marker with the body it left (see drawThings); null: markers only
  let tipFor = null;
  // the player's started quests: { sid, list: [{ id, name, trader, loc, goals }], zones: { zone id: quest name }, names }
  let quests = null;
  let questsAsking = false, questsAskedAt = -1e9, questsFor = '';
  let questsPrint = null;
  let find = '';                // what the search box asks for, lower case; '' for nothing
  // The menu: one panel with a tab each for the raid, its loot, the quests, the map and the settings.
  const TABS = ['raid', 'loot', 'quests', 'map', 'settings'];
  let tab = TABS.includes(prefs.tab) ? prefs.tab : 'raid';
  // A phone, upright or on its side: the menu is a sheet (from the bottom, or down the right), and the map and
  // player lists and the buttons that aren't needed all the time are in it (see placeQuick).
  const phone = window.matchMedia('(max-width: 700px), (max-height: 520px)');
  // how many pixels are drawn to a point of the screen. A phone's has three or four, and drawing every one each
  // frame is slow there: two at most, unless "Lighter drawing on a phone" is off
  const pixelRatio = () => {
    const real = window.devicePixelRatio || 1;
    return phone.matches && prefs.phoneLight !== false ? Math.min(2, real) : real;
  };
  // how much of the screen that sheet covers, in pixels: what's followed is kept in the middle of the rest
  let cover = { r: 0, b: 0 };
  let flash = null;             // a spot just gone to, ringed for a moment: { x, y, at }
  // Following is what the player asked for (prefs.follow) and is kept; dragging the map, or going to look at
  // something, only sets it aside (roaming) until Follow is pressed again or the player has walked on.
  let roaming = false, roamFrom = null;
  const following = () => prefs.follow && !roaming;
  function roam() {
    if (!prefs.follow || roaming) return;
    keepFollowZoom();
    roaming = true;
    roamFrom = me ? [me.x, me.y] : null;
    dirty = true;
  }
  // Somebody else followed: a bot pressed on the map or in the Raid list. Kept until the map is dragged, something
  // else is pressed, or they're gone from the raid; then the map goes back to following the player (when it does).
  let chased = null;
  // A building pressed on the map: looked inside (its floors shown) until somewhere off it is pressed or the map goes
  // back to the player. hovered: the building under the pointer that a press would open; both as places (BUILDING+i).
  let opened = 0, hovered = 0;
  // the building the player is in, when its inside was pressed away: not shown again until they leave it
  let insideShut = 0, insideShutAt = null;
  // a floor stepped to with the badge's arrows: { place, n }, kept while that building is the one shown
  let floorPick = null;
  // every building outlined (see drawHovered): while the button or B is held; a quick press leaves them outlined
  // until a building is pressed, or the button (or B) again
  let revealHeld = false, revealOn = false, revealDownAt = 0;
  const revealing = () => revealHeld || revealOn;
  const revealSet = on => { revealOn = on; $('reveal').classList.toggle('on', on); dirty = true; };
  function revealDown() {
    if (revealHeld) return;
    revealHeld = true;
    revealDownAt = performance.now();
    dirty = true;
  }
  // let go: a quick press switches the outlines on (or off again), a long hold is over
  function revealUp() {
    if (!revealHeld) return;
    revealHeld = false;
    revealSet(performance.now() - revealDownAt < 400 ? !revealOn : false);
  }
  // how far (metres) the player walks before a look about ends and the map is back on them
  const WALK_BACK = 1.5;
  function chase(id) {
    if (chased === id) return;
    if (chased === null && id !== null) keepFollowZoom();
    chased = id;
    rosterPrint = null;
    dirty = true;
    if (id === null) backToPlayer();
  }
  // The zoom the player was being followed at, before the map was taken off them (a drag, a look at something,
  // somebody else followed): put back when it returns to them. Without auto zoom only; with it, the zoom is the one
  // for indoors or outdoors, as ever.
  let followZoom = null;
  function keepFollowZoom() {
    if (followZoom === null && prefs.follow && !roaming && chased === null) followZoom = zoomTarget;
  }
  function backToPlayer() {
    if (!prefs.follow || roaming || chased !== null) return;
    if (followZoom !== null && !prefs.autoZoom && !prefs.keepZoom) { zoomTarget = followZoom; zoomAt = null; }
    if (prefs.autoZoom && !prefs.keepZoom) zoomState = null;
    followZoom = null;
    dirty = true;
  }

  // ---- places --------------------------------------------------------------------------------------------------
  // The map can be turned a quarter at a time (turn: degrees anticlockwise), so it's the way up the maps people know
  // have it. The game's own x runs east and its z north; each location is turned as tarkov.dev turns it.
  const TURNS = {
    bigmap: 180, factory4_day: 90, factory4_night: 90, Interchange: 180, laboratory: 270, Labyrinth: 270, Lighthouse: 180,
    RezervBase: 180, Sandbox: 180, Sandbox_high: 180, Shoreline: 180, TarkovStreets: 180, Woods: 180
  };
  let turn = 0;
  const turnFor = loc => {
    const picked = prefs.turns && prefs.turns[loc];
    return [0, 90, 180, 270].includes(picked) ? picked : TURNS[baseOf(loc)] || 0;
  };
  // the game's [east, north] as the screen has it, turned, and back
  function spin(x, y) {
    return turn === 90 ? [-y, x] : turn === 180 ? [-x, -y] : turn === 270 ? [y, -x] : [x, y];
  }
  function unspin(a, b) {
    return turn === 90 ? [b, -a] : turn === 180 ? [-a, -b] : turn === 270 ? [-b, a] : [a, b];
  }
  // the map's edges, turned: { min: { x, y }, max: { x, y } }
  function view() {
    const a = spin(map.min.x, map.min.y), b = spin(map.max.x, map.max.y);
    return { min: { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]) }, max: { x: Math.max(a[0], b[0]), y: Math.max(a[1], b[1]) } };
  }
  function toScreen(x, y) {
    const [a, b] = spin(x, y);
    return [vw / 2 + panX + zoom * a, vh / 2 + panY - zoom * b];
  }
  function toMap(sx, sy) {
    return unspin((sx - vw / 2 - panX) / zoom, -(sy - vh / 2 - panY) / zoom);
  }
  function centreOn(x, y) {
    const [a, b] = spin(x, y);
    panX = -zoom * a - cover.r / 2;
    panY = zoom * b - cover.b / 2;
    dirty = true;
  }
  function setZoomLimits() {
    if (!map) return;
    const v = view();
    zoomMin = Math.min(vw / (v.max.x - v.min.x), vh / (v.max.y - v.min.y)) / ZOOM_MIN_DIVIDER;
    zoomMax = Math.max(zoomMin * 10, ZOOM_CLOSEST);
  }
  // The map can't be moved off the screen: no more than a thin strip of nothing shows past its edge, and a map
  // smaller than the screen sits in the middle.
  function keepOnMap() {
    if (!map) return;
    const slack = 48;
    const v = view();
    // the menu covers one side of the screen while it's open: the right, or the left when it's swapped with the
    // Raid list (on a phone it's a sheet: see cover)
    const covered = $('panel').hidden || phone.matches ? 0 : Math.min($('panel').offsetWidth, vw / 2);
    const left = prefs.swap ? covered : 0, right = covered - left;
    const wide = (v.max.x - v.min.x) * zoom, tall = (v.max.y - v.min.y) * zoom;
    if (wide + 2 * slack <= vw - covered) panX = -zoom * (v.min.x + v.max.x) / 2 + (left - right) / 2;
    else panX = Math.min(Math.max(panX, vw / 2 - slack - right - zoom * v.max.x), slack - vw / 2 + left - zoom * v.min.x);
    if (tall + 2 * slack <= vh) panY = zoom * (v.min.y + v.max.y) / 2;
    else panY = Math.min(Math.max(panY, vh / 2 - slack + zoom * v.min.y), slack - vh / 2 + zoom * v.max.y);
  }
  // the part of the map that's on the screen, in screen pixels
  function mapBox() {
    const v = view();
    const left = vw / 2 + panX + zoom * v.min.x, right = vw / 2 + panX + zoom * v.max.x;
    const top = vh / 2 + panY - zoom * v.max.y, bottom = vh / 2 + panY - zoom * v.min.y;
    return { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(vw, right), bottom: Math.min(vh, bottom) };
  }
  // turns the map, keeping what's in the middle of the screen there
  function setTurn(next) {
    if (!map || next === turn) return;
    const mid = toMap(vw / 2, vh / 2);
    turn = next;
    setZoomLimits();
    zoom = zoomTarget = Math.min(Math.max(zoomTarget, zoomMin), zoomMax);
    centreOn(mid[0], mid[1]);
    tilesPrint = '';
  }
  function wholeMap() {
    if (!map) return;
    roam();
    zoom = zoomTarget = zoomMin;
    centreOn((map.min.x + map.max.x) / 2, (map.min.y + map.max.y) / 2);
  }
  function zoomBy(times, sx, sy) {
    zoomTarget = Math.min(Math.max(zoomTarget * times, zoomMin), zoomMax);
    zoomAt = following() && inRaidHere() ? null : [sx, sy];
    // with auto zoom on, zooming by hand while the player is followed says how close "indoors" or "outdoors" is;
    // zooming while looking about doesn't
    if (autoZooming() && zoomState !== null && chased === null) {
      const key = zoomState ? 'spanIn' : 'spanOut';
      prefs[key] = clampSpan(Math.min(vw, vh) / zoomTarget, zoomState ? SPAN_IN : SPAN_OUT, prefs[key]);
      showSpans();
    } else prefs.zoom = (zoomTarget - zoomMin) / (zoomMax - zoomMin);
    save();
  }
  // the zoom sliders: closer to the right
  function showSpans() {
    $('optSpanIn').value = -prefs.spanIn;
    $('optSpanOut').value = -prefs.spanOut;
    $('spanInText').textContent = Math.round(prefs.spanIn) + ' m';
    $('spanOutText').textContent = Math.round(prefs.spanOut) + ' m';
  }
  function autoZooming() {
    return prefs.autoZoom && !prefs.keepZoom && following() && chased === null && !!me && me.in !== undefined && inRaidHere();
  }
  // so many metres across the screen's short side: 30 indoors and 180 outdoors, until set otherwise
  function stateZoom(inside) {
    const z = Math.min(vw, vh) / (inside ? prefs.spanIn : prefs.spanOut);
    return Math.min(Math.max(z, zoomMin), zoomMax);
  }

  // ---- the maps ------------------------------------------------------------------------------------------------
  // {"loc","v","min":[east,north],"tile","px","cols","rows"}: tile is a tile's side in metres; column 0 is the
  // westernmost, row 0 the southernmost
  // "small": every tile is there a second time, small ("_s"). "floors": what's under the roofs, see readFloors.
  function readMap(raw) {
    const ok = raw && typeof raw.loc === 'string' && Array.isArray(raw.min) && raw.tile > 0 && raw.cols > 0 && raw.rows > 0;
    if (!ok) return null;
    const zones = (Array.isArray(raw.zones) ? raw.zones : []).filter(z => z && Array.isArray(z.p) && z.p.length);
    // "base": the location; "name": the game's name for it; "vname": the version's, when a mod swapped one in
    const base = typeof raw.base === 'string' && raw.base ? raw.base : baseOf(raw.loc);
    const version = noSnow(raw.loc).split('~')[1];
    // a version known only by its scenes is kept by their hash (8 hex digits)
    const vname = typeof raw.vname === 'string' && raw.vname ? raw.vname
      : /^[0-9a-f]{8}$/.test(version || '') ? T('another version') : version || '';
    const title = PLACES[base] || (typeof raw.name === 'string' && raw.name ? T(raw.name) : base);
    return {
      loc: raw.loc, v: raw.v, base, title, name: title + (vname ? ' (' + vname + ')' : ''), tile: raw.tile, cols: raw.cols, rows: raw.rows,
      small: !!raw.small, floors: readFloors(raw.floors),
      rawZones: zones.filter(z => z.k !== 'claymore' && !z.off),
      zones: zoneAreas(zones.filter(z => z.k !== 'claymore' && !z.off)),
      fields: mineFields(zones.filter(z => z.k === 'claymore').map(z => z.p[0])),
      min: { x: raw.min[0], y: raw.min[1] },
      max: { x: raw.min[0] + raw.cols * raw.tile, y: raw.min[1] + raw.rows * raw.tile }
    };
  }

  // Zones of one kind that overlap, as one area: { k, flare, zones: [{ p, q }], x, y } (x, y: the middle of where
  // it kills). A zone the game had switched off isn't one.
  function zoneAreas(zones) {
    const box = z => {
      const xs = z.p.map(p => p[0]), ys = z.p.map(p => p[1]);
      return [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2];
    };
    const boxes = zones.map(box);
    const group = zones.map((z, i) => i);
    const root = i => { while (group[i] !== i) i = group[i] = group[group[i]]; return i; };
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = boxes[i], b = boxes[j];
        const same = zones[i].k === zones[j].k && !!zones[i].flare === !!zones[j].flare;
        if (same && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) group[root(i)] = root(j);
      }
    }
    const areas = new Map();
    zones.forEach((z, i) => {
      const r = root(i);
      if (!areas.has(r)) areas.set(r, { k: z.k, flare: !!z.flare, zones: [] });
      // where it kills: outlines the game decided spot by spot (newer captures; none: nowhere), else a rectangle
      const kill = Array.isArray(z.kill) ? z.kill.filter(loop => Array.isArray(loop) && loop.length > 2)
        : [Array.isArray(z.q) && z.q.length ? z.q : z.p];
      areas.get(r).zones.push({ p: z.p, kill });
    });
    return [...areas.values()].map(area => {
      const killing = area.zones.flatMap(z => z.kill).flat();
      const all = killing.length ? killing : area.zones.flatMap(z => z.p);
      const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
      return Object.assign(area, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
    });
  }

  // Claymores that lie near one another, as fields: { mines: [[east, north], ..], x, y } (x, y: the middle)
  function mineFields(points) {
    const group = points.map((p, i) => i);
    const root = i => { while (group[i] !== i) i = group[i] = group[group[i]]; return i; };
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) < MINE_TOGETHER) group[root(i)] = root(j);
      }
    }
    const fields = new Map();
    points.forEach((p, i) => {
      const r = root(i);
      if (!fields.has(r)) fields.set(r, []);
      fields.get(r).push(p);
    });
    return [...fields.values()].map(mines => ({
      mines, x: mines.reduce((s, p) => s + p[0], 0) / mines.length, y: mines.reduce((s, p) => s + p[1], 0) / mines.length
    }));
  }

  // {"n","cell","min":[east,north],"wide","tall","grid":[place,squares,..],"levels":[[height,..],..],"tiles":[[tile,..],..]}
  // The ground is cut into squares of "cell" metres, row by row from the south-west; grid says which roofed place
  // each is in (0: out in the open) as runs of the same place. levels: each place's floors' heights, lowest first.
  // tiles: for each floor, the tiles that have a picture of it ("_f<floor>"). has (newer captures): which floors each
  // square has ground on, one bit each, as runs like grid's.
  function readFloors(raw) {
    const ok = raw && raw.n > 0 && raw.cell > 0 && raw.wide > 0 && raw.tall > 0 && raw.wide * raw.tall < 5e7
      && Array.isArray(raw.min) && Array.isArray(raw.grid) && Array.isArray(raw.levels) && Array.isArray(raw.tiles);
    if (!ok) return null;
    const unpack = runs => {
      const squares = new Uint32Array(raw.wide * raw.tall);
      let at = 0;
      for (let i = 0; i + 1 < runs.length && at < squares.length; i += 2) {
        const run = Math.max(0, runs[i + 1] | 0);
        if (runs[i]) squares.fill(runs[i], at, at + run);
        at += run;
      }
      return squares;
    };
    return {
      n: raw.n, cell: raw.cell, x: raw.min[0], y: raw.min[1], wide: raw.wide, tall: raw.tall, grid: unpack(raw.grid),
      squares: Array.isArray(raw.has) ? unpack(raw.has) : null, levels: raw.levels, boxes: new Map(), buildings: readBuildings(raw.buildings),
      has: raw.tiles.map(list => new Set(Array.isArray(list) ? list : []))
    };
  }
  // "buildings" (newer maps): [{"l":[loop,..],"parts":[{"n","h","t","a","l":[loop,..]},..]},..]. Each building's
  // footprint, and each floor's part of it: the floor's number (as its pictures are numbered), the floor's height,
  // its ceiling's, its size in square metres. A loop is [east, north, east, north, ..]. Where a map has them they're
  // gone by instead of the squares: they follow the walls, keep two buildings side by side apart, and leave out what
  // is only a roof (a canopy, a gantry).
  function readBuildings(raw) {
    if (!Array.isArray(raw)) return null;
    const loops = l => (Array.isArray(l) ? l : []).filter(p => Array.isArray(p) && p.length >= 6 && p.every(Number.isFinite));
    const boxOf = l => {
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const loop of l) {
        for (let i = 0; i + 1 < loop.length; i += 2) {
          box.x0 = Math.min(box.x0, loop[i]); box.x1 = Math.max(box.x1, loop[i]);
          box.y0 = Math.min(box.y0, loop[i + 1]); box.y1 = Math.max(box.y1, loop[i + 1]);
        }
      }
      return box;
    };
    const out = [];
    for (const b of raw) {
      const l = loops(b && b.l), parts = [];
      for (const p of (b && Array.isArray(b.parts) ? b.parts : [])) {
        const pl = loops(p && p.l);
        if (pl.length && p.n > 0 && Number.isFinite(p.h)) parts.push({ n: p.n | 0, h: p.h, t: Number.isFinite(p.t) ? p.t : p.h + 3, a: +p.a || 0, l: pl, box: boxOf(pl) });
      }
      if (l.length && parts.length) out.push({ l, parts, box: boxOf(l), size: loopsArea(l), floors: [...new Set(parts.map(p => p.n))].sort((a, b) => a - b) });
    }
    return out.length ? out : null;
  }
  // a building's number as a "place" (see floorShown): this and up, so it's never taken for a place of the squares
  const BUILDING = 1000000;
  // whether a spot is within loops (a loop within a loop is a hole)
  function inLoops(loops, x, y) {
    let inside = false;
    for (const loop of loops) {
      for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
        const ay = loop[i + 1], by = loop[j + 1];
        if ((ay > y) !== (by > y) && x < loop[i] + (loop[j] - loop[i]) * (y - ay) / (by - ay)) inside = !inside;
      }
    }
    return inside;
  }
  const inBox = (box, x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  // the ground loops cover, in square metres (a hole's loop runs the other way round, so it takes its area off)
  function loopsArea(loops) {
    let a = 0;
    for (const loop of loops) for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) a += loop[j] * loop[i + 1] - loop[i] * loop[j + 1];
    return Math.abs(a / 2);
  }
  // The building a spot is within the walls of, as a place; 0: none. Buildings can lie over one another (Ground
  // Zero's car park is one of its own, under the towers round its plaza): the smallest there is taken, or, given a
  // height (somebody's), the smallest with a floor they're on.
  function buildingAt(x, y, z) {
    const list = map && map.floors && map.floors.buildings;
    if (!list) return 0;
    // best: any; near: one with a floor they're taken to be on; on: one with a floor right under their feet there
    let best = 0, near = 0, on = 0;
    const smaller = (i, than) => !than || list[i].size < list[than - BUILDING].size;
    for (let i = 0; i < list.length; i++) {
      if (!inBox(list[i].box, x, y) || !inLoops(list[i].l, x, y)) continue;
      if (smaller(i, best)) best = BUILDING + i;
      if (z === undefined || !buildingFloor(BUILDING + i, x, y, z)) continue;
      if (smaller(i, near)) near = BUILDING + i;
      if (smaller(i, on) && list[i].parts.some(p => p.h <= z + 1 && z < p.t - 0.1 && inBox(p.box, x, y) && inLoops(p.l, x, y))) on = BUILDING + i;
    }
    return on || near || best;
  }
  // The floor of a building that somebody at a spot in it, at a height, is on; 0: not in it (on its roof, under it).
  // Of the floors with a part at that spot, the highest whose floor is under their feet, or no more than a step
  // over them (on the stairs up, the floor above takes over a metre under it).
  function buildingFloor(place, x, y, z) {
    const b = map && map.floors && map.floors.buildings && map.floors.buildings[place - BUILDING];
    if (!b) return 0;
    const under = list => list.reduce((best, p) => p.h <= z + 1 && (!best || p.h > best.h) ? p : best, null);
    const here = under(b.parts.filter(p => inBox(p.box, x, y) && inLoops(p.l, x, y)));
    // over its ceiling is on the roof
    if (here) return z >= here.t - 0.1 ? 0 : here.n;
    // on no floor's part: in a doorway, on the stairs, on a ledge over a hall
    const near = under(b.parts);
    if (near) return z >= Math.max(...b.parts.map(p => p.t)) - 0.1 ? 0 : near.n;
    const lowest = b.parts.reduce((low, p) => p.h < low.h ? p : low);
    return z > lowest.h - 1.5 ? lowest.n : 0;
  }
  // the floor a building is looked at on when nobody's in it: its biggest
  function mainFloor(place) {
    const b = map.floors.buildings[place - BUILDING];
    return b.parts.reduce((big, p) => p.a > big.a ? p : big).n;
  }

  // ---- kinds of loot, names ------------------------------------------------------------------------------------
  // The kinds loot can be switched by, as the server sorts items by the game's handbook ("g" in an item's names entry).
  const LOOT_KINDS = [['weapons', T('Weapons')], ['mods', T('Weapon parts')], ['ammo', T('Ammo')], ['gear', T('Gear')], ['meds', T('Medical')],
    ['food', T('Provisions')], ['keys', T('Keys')], ['valuables', T('Valuables')], ['electronics', T('Electronics')], ['tools', T('Tools, materials')],
    ['household', T('Household, other')], ['info', T('Info, maps')], ['money', T('Money')], ['special', T('Special')], ['other', T('Anything else')]];
  // whether an item is of a kind that's shown (quest items always are; an item the server hasn't sorted counts as
  // "anything else")
  const kindOn = (names, tpl) => {
    if (!prefs.lootOff.length) return true;
    const entry = names[tpl] || {};
    return !!entry.q || !prefs.lootOff.includes(entry.g || 'other');
  };

  // Names in Cyrillic, in Latin letters: the bosses by the names players know them by, everyone else letter by letter.
  const BOSS_NAMES = { 'решала': 'Reshala', 'килла': 'Killa', 'глухарь': 'Glukhar', 'штурман': 'Shturman', 'санитар': 'Sanitar',
    'тагилла': 'Tagilla', 'зрячий': 'Zryachiy', 'кабан': 'Kaban', 'коллонтай': 'Kollontay', 'рыцарь': 'Knight', 'птичий глаз': 'Birdeye',
    'биг пайп': 'Big Pipe', 'партизан': 'Partisan', 'дед мороз': 'Ded Moroz' };
  const LATIN = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
    ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
  function latin(text) {
    if (!prefs.latin || !text || !/[\u0400-\u04ff]/.test(text)) return text;
    const boss = BOSS_NAMES[text.trim().toLowerCase()];
    if (boss) return boss;
    let out = '';
    for (const ch of text) {
      const low = ch.toLowerCase();
      const to = LATIN[low];
      if (to === undefined) { out += ch; continue; }
      out += ch !== low && to ? to[0].toUpperCase() + to.slice(1) : to;
    }
    return out;
  }

  // the roofed place a spot is in; 0 out in the open
  function placeAt(x, y) {
    const f = map && map.floors;
    if (!f) return 0;
    const cx = Math.floor((x - f.x) / f.cell), cy = Math.floor((y - f.y) / f.cell);
    if (cx < 0 || cy < 0 || cx >= f.wide || cy >= f.tall) return 0;
    return f.grid[cy * f.wide + cx];
  }
  // the squares a place covers, first to last column and row
  function placeBox(place) {
    const f = map.floors;
    if (f.boxes.has(place)) return f.boxes.get(place);
    const box = { c0: Infinity, c1: -1, r0: Infinity, r1: -1 };
    for (let i = 0; i < f.grid.length; i++) {
      if (f.grid[i] !== place) continue;
      const cx = i % f.wide, cy = (i - cx) / f.wide;
      box.c0 = Math.min(box.c0, cx); box.c1 = Math.max(box.c1, cx);
      box.r0 = Math.min(box.r0, cy); box.r1 = Math.max(box.r1, cy);
    }
    f.boxes.set(place, box);
    return box;
  }
  // the roofed place somebody indoors is in: the one their square is in, else the nearest within a few metres (the
  // squares are coarse, and a doorway may fall just outside)
  function placeNear(x, y) {
    const f = map && map.floors;
    if (!f) return 0;
    const here = placeAt(x, y);
    if (here) return here;
    let best = 0, bestFar = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const p = placeAt(x + dx * f.cell, y + dy * f.cell);
        const far = dx * dx + dy * dy;
        if (p && far < bestFar) { best = p; bestFar = far; }
      }
    }
    return best;
  }
  // The building the player is inside; 0 in the open. Where the game says indoors, the nearest roofed place. The game
  // says outdoors in some buildings (the dorms on Customs), so a building with more than one floor also counts when
  // the player stands on a square that has ground on the floor their height makes: that leaves out awnings and
  // arcades, which have one floor, and roofs, which are above the top floor. Either way the player has to be standing
  // on that floor: within a square of ground it has, at about its height. Under a train wagon by a warehouse on
  // Customs the game says indoors, and the warehouse a few metres off was shown, floor 1, with the player outside it.
  function placeInside() {
    const f = map && map.floors;
    if (!f || !me) return 0;
    if (f.buildings) {
      // within a building's walls, on one of its floors: the game's word isn't needed, a shelter isn't a building
      const b = buildingAt(me.x, me.y, me.z);
      return b && buildingFloor(b, me.x, me.y, me.z) ? b : 0;
    }
    const indoors = me.in !== false;
    // where the game says indoors, a doorway may fall a square outside the building's squares
    const place = placeAt(me.x, me.y) || (indoors ? placeNear(me.x, me.y) : 0);
    const levels = place ? f.levels[place - 1] : null;
    if (!Array.isArray(levels) || !levels.length || (!indoors && levels.length < 2)) return 0;
    const n = floorOf(place, me.z);
    if (!n) return 0;
    // on the floor: not a metre under it (a cellar's floor is the lowest there is), nor far above it (on the stairs
    // up, the floor above takes over at a metre under it). Outdoors under a wagon is well under a building's ground floor.
    if (!indoors && me.z < levels[n - 1] - 1) return 0;
    // Nor, outdoors, well above the top floor: on a bridge's deck, 2.4 m over the road under it (Customs), the road's
    // "floor" was shown. Between two floors is the stairs, and stays.
    if (!indoors && n === levels.length && me.z > levels[n - 1] + 1.2) return 0;
    if (f.squares) {
      const cx = Math.floor((me.x - f.x) / f.cell), cy = Math.floor((me.y - f.y) / f.cell);
      const bit = 1 << (n - 1);
      const has = (x, y) => x >= 0 && y >= 0 && x < f.wide && y < f.tall && f.grid[y * f.wide + x] === place && !!(f.squares[y * f.wide + x] & bit);
      let near = has(cx, cy);
      // indoors: a square beside one with that floor will do (2 m, a doorway); outdoors only the square itself
      for (let dy = -1; indoors && !near && dy <= 1; dy++) for (let dx = -1; !near && dx <= 1; dx++) near = has(cx + dx, cy + dy);
      if (!near) return 0;
      if (indoors && me.z < levels[n - 1] - 1.5) return 0;
    }
    return place;
  }
  // Whether something is on another floor than the player: 1 above, -1 below, 0 not. Inside a building with floors,
  // its floor against the player's; out in the open it's the same level however the ground rises and falls, unless
  // the player is up a building's floors (or down in its cellar).
  function otherFloor(x, y, z) {
    const f = map && map.floors;
    if (!f) return 0;
    // A floor of a building is shown (the player's, one stepped to, or of a building looked into): what's in that
    // building goes by the floor shown, in a raid or out of one.
    const b = f.buildings && floorShown.place >= BUILDING && floorShown.n > 0 ? f.buildings[floorShown.place - BUILDING] : null;
    if (b && inBox(b.box, x, y) && inLoops(b.l, x, y)) {
      if (buildingFloor(floorShown.place, x, y, z) === floorShown.n) return 0;
      const shown = b.parts.filter(p => p.n === floorShown.n);
      return shown.length && z < Math.min(...shown.map(p => p.h)) ? -1 : 1;
    }
    if (!me || !inRaidHere()) return 0;
    const many = p => p && Array.isArray(f.levels[p - 1]) && f.levels[p - 1].length > 1;
    const there = placeAt(x, y);
    if (many(there)) {
      const a = floorOf(there, z), b = floorOf(there, me.cz);
      return a === b ? 0 : z > me.cz ? 1 : -1;
    }
    const mine = placeNear(me.cx, me.cy);
    if (many(mine) && (me.in !== false || (f.buildings ? !!placeInside() : placeInside() === mine)) && floorOf(mine, me.cz) !== 1 && Math.abs(z - me.cz) > 2.5) return z > me.cz ? 1 : -1;
    return 0;
  }
  function floorOf(place, height) {
    const f = map && map.floors;
    if (!f || !place) return 0;
    const levels = f.levels[place - 1];
    if (!Array.isArray(levels) || !levels.length || height > levels[levels.length - 1] + 2.6) return 0;
    let on = 1;
    for (let i = 1; i < levels.length; i++) if (levels[i] <= height + 1) on = i + 1;
    return on;
  }
  function listFloors() {
    const f = map && map.floors;
    $('floorRow').hidden = !f;
    const pick = $('optFloor');
    pick.textContent = '';
    if (!f) return;
    const rows = [['auto', T('Auto: the player\'s')], ['0', T('From above')]];
    for (let n = f.n; n >= 1; n--) rows.push([String(n), T('Floor {n}', { n })]);
    for (const [value, text] of rows) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      pick.appendChild(o);
    }
    pick.value = String(prefs.floor);
    if (pick.value !== String(prefs.floor)) pick.value = 'auto';
  }

  // A tile's picture: of floor n (0: the view from above), where the tile has one; small unless asked for big.
  function tileSrc(t, big, n) {
    const f = map.floors;
    const of = n > 0 && f && f.has[n - 1] && f.has[n - 1].has(t.at) ? '_f' + n : '';
    return 'map/' + encodeURIComponent(map.loc) + '/' + map.v + '/' + t.col + '_' + t.row + of + (big || !map.small ? '' : '_s') + '.jpg';
  }
  // A tile is laid a little over its square, so no line shows between two: by two pixels of the screen, however far
  // the map is zoomed. It's stretched about its middle, so nothing on it is more than a pixel from where it belongs.
  // It's put there and sized by a transform, its own box being TILE_BOX pixels square (see livemap.css): the browser
  // rounds a picture's box to whole pixels before the map's zoom is applied, and a pixel there is a metre, so an
  // overlap given as left, top and width was rounded away and the ground behind showed through between the tiles.
  const TILE_BOX = 1024;
  let lapShown = 0;
  const lapNow = () => Math.min(map.tile / 8, 2 / zoom);
  function layTile(img) {
    const lap = lapShown || lapNow();
    img.style.transform = 'translate(' + (img.bx - lap / 2) + 'px,' + (img.by - lap / 2) + 'px) scale(' + (map.tile + lap) / TILE_BOX + ')';
  }
  // laid again once the zoom has changed enough to tell
  function layTiles() {
    const lap = lapNow();
    if (lapShown && Math.abs(lap - lapShown) < lapShown * 0.2) return;
    lapShown = lap;
    for (const t of tiles) layTile(t.img);
    for (const t of floorTiles) layTile(t.img);
  }
  // Every tile shows its small picture; the ones in view show the big one once the map is close enough to tell.
  // A picture is swapped once the new one has arrived, so nothing flickers.
  function refreshTiles() {
    if (!map) return;
    const big = !map.small || zoom * map.tile * (pixelRatio()) > 330;
    // the ground the screen's corners show, whichever way the map is turned
    const corners = [toMap(0, 0), toMap(vw, 0), toMap(0, vh), toMap(vw, vh)];
    const a = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1]))];
    const b = [Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
    const col0 = Math.floor((a[0] - map.min.x) / map.tile - 0.5), col1 = Math.floor((b[0] - map.min.x) / map.tile + 0.5);
    const row0 = Math.floor((a[1] - map.min.y) / map.tile - 0.5), row1 = Math.floor((b[1] - map.min.y) / map.tile + 0.5);
    const print = [map.loc, map.v, big, col0, col1, row0, row1, floorShown.place, floorShown.n].join();
    if (print === tilesPrint) return;
    tilesPrint = print;
    const all = tiles.map(t => [t, 0]).concat(floorTiles.map(t => [t, t.n || floorShown.n]));
    for (const [t, n] of all) {
      const near = t.col >= col0 && t.col <= col1 && t.row >= row0 && t.row <= row1;
      const want = tileSrc(t, !map.small || (big && near), n);
      if (t.want === want) continue;
      const first = !t.want;
      t.want = want;
      if (first) { t.img.src = want; continue; }
      const next = new Image();
      next.onload = () => { if (t.want === want) t.img.src = want; };
      next.src = want;
    }
  }

  // Shows floor n of one roofed place: that floor's pictures, cut to the place's shape, over the rest of the map
  // dimmed, with the floor's own outline drawn round it. Place 0: the plain view from above.
  // the badge: which of the floors (lowest first) is shown, and arrows to the next one up or down
  // (counted among the floors that look different; a floor shown that isn't one of them, the player's on a landing,
  // counts as the one under it)
  function floorLabel(n, floors) {
    const i = Math.max(1, floors.filter(k => k <= n).length);
    const picked = prefs.floor !== 'auto' || (floorPick && floorPick.n === n);
    $('floorText').textContent = T('Floor {n} of {of}', { n: i, of: Math.max(1, floors.length) });
    // picked by hand: shown by its colour, not by more words, so the arrows either side never move
    $('floorText').classList.toggle('picked', picked);
    $('floorDown').disabled = !floors.some(k => k < n);
    $('floorUp').disabled = !floors.some(k => k > n);
  }
  // The floors of a place worth stepping to, lowest first. Of a building, the ones that look different: not a scrap
  // (a landing, a split level's step: under 15 m2, or under 4% of its biggest floor), and, once its pictures have been
  // compared (see compareFloors), not the same picture as the floor under it. Its biggest floor always counts.
  function floorsOf(place) {
    const f = map && map.floors;
    if (!f || !place) return [];
    if (place < BUILDING) return (f.levels[place - 1] || []).map((_, i) => i + 1);
    const b = f.buildings && f.buildings[place - BUILDING];
    if (!b) return [];
    if (b.seen && b.seen.v === map.v) return b.seen.list;
    const area = new Map();
    for (const p of b.parts) area.set(p.n, (area.get(p.n) || 0) + p.a);
    const most = Math.max(...area.values());
    const big = mainFloor(place);
    const list = b.floors.filter(m => m === big || area.get(m) >= Math.max(15, most * 0.04));
    if (!b.comparing || b.comparing !== map.v) {
      b.comparing = map.v;
      compareFloors(place, b, list, big);
    }
    return list;
  }
  // How alike two floors' pictures are, within the upper one's own floor: the mean difference of red, green and blue
  // (0 to 255). The storeys of a stairwell or a tower, captured alike, come to under 1 (Streets: 0.0 to 0.9 against
  // 1.1 and up for a floor with anything new on it).
  const SAME_FLOOR = 1;
  // Compares each floor's small pictures with the last different floor's under it, and keeps the floors that differ;
  // the badge counts those once it's done.
  async function compareFloors(place, b, list, big) {
    const v = map.v, loc = map.loc;
    const { x0, y0, x1, y1 } = b.box;
    const K = Math.min(2, 1024 / Math.max(x1 - x0, y1 - y0, 1));
    const W = Math.max(1, Math.ceil((x1 - x0) * K)), H = Math.max(1, Math.ceil((y1 - y0) * K));
    const c0 = Math.max(0, Math.floor((x0 - map.min.x) / map.tile)), c1 = Math.min(map.cols - 1, Math.floor((x1 - map.min.x) / map.tile));
    const r0 = Math.max(0, Math.floor((y0 - map.min.y) / map.tile)), r1 = Math.min(map.rows - 1, Math.floor((y1 - map.min.y) / map.tile));
    const load = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
    const canvas = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c.getContext('2d', { willReadFrequently: true }); };
    const picture = async m => {
      const g = canvas();
      for (let r = r0; r <= r1; r++) {
        for (let col = c0; col <= c1; col++) {
          const img = await load(tileSrc({ col, row: r, at: r * map.cols + col }, false, m));
          if (img) g.drawImage(img, (map.min.x + col * map.tile - x0) * K, (y1 - (map.min.y + (r + 1) * map.tile)) * K, map.tile * K, map.tile * K);
        }
      }
      return g.getImageData(0, 0, W, H).data;
    };
    const ownFloor = m => {
      const g = canvas();
      g.fillStyle = '#fff';
      g.beginPath();
      for (const p of b.parts) {
        if (p.n !== m) continue;
        for (const l of p.l) {
          for (let i = 0; i + 1 < l.length; i += 2) {
            const px = (l[i] - x0) * K, py = (y1 - l[i + 1]) * K;
            if (i) g.lineTo(px, py); else g.moveTo(px, py);
          }
          g.closePath();
        }
      }
      g.fill('evenodd');
      return g.getImageData(0, 0, W, H).data;
    };
    try {
      const kept = [];
      let under = null;
      for (const m of list) {
        const pic = await picture(m);
        if (!map || map.loc !== loc || map.v !== v) return;
        let same = false;
        if (under && m !== big) {
          const mask = ownFloor(m);
          let sum = 0, n = 0;
          for (let i = 0; i < mask.length; i += 4) {
            if (mask[i + 3] < 128) continue;
            n++;
            sum += (Math.abs(pic[i] - under[i]) + Math.abs(pic[i + 1] - under[i + 1]) + Math.abs(pic[i + 2] - under[i + 2])) / 3;
          }
          same = n > 0 && sum / n < SAME_FLOOR;
        }
        if (same) continue;
        kept.push(m);
        under = pic;
      }
      b.seen = { v, list: kept };
      if (floorShown.place === place) floorLabel(floorShown.n, kept);
    } catch (e) {
      // (pictures that can't be read: every floor that isn't a scrap counts)
      b.seen = { v, list };
    }
  }
  // a floor up (1) or down (-1) in the building shown, of the ones that look different; kept until another building
  // is shown
  function stepFloor(d) {
    const place = floorShown.place, has = floorsOf(place), n = floorShown.n;
    const to = d > 0 ? has.find(k => k > n) : [...has].reverse().find(k => k < n);
    if (to === undefined) return;
    floorPick = { place, n: to };
    setFloor(place, to);
  }

  function setFloor(place, n) {
    const f = map && map.floors;
    floorShown = { place, n };
    tilesPrint = '';
    floorTiles = [];
    floorEdge = [];
    floorEl.textContent = '';
    const on = !!(f && place > 0 && n > 0);
    floorEl.hidden = !on;
    layersEl.classList.toggle('dim', on);
    dirty = true;
    const badge = $('floorBadge');
    badge.hidden = !on;
    if (!on) return;
    if (place >= BUILDING) {
      showBuilding(f.buildings[place - BUILDING], n);
      return;
    }
    const levels = f.levels[place - 1] || [];
    floorLabel(n, levels.map((_, i) => i + 1));

    const box = placeBox(place);
    const left = f.x + box.c0 * f.cell, right = f.x + (box.c1 + 1) * f.cell;
    const bottom = f.y + box.r0 * f.cell, top = f.y + (box.r1 + 1) * f.cell;
    Object.assign(floorEl.style, { left: left + 'px', top: -top + 'px', width: (right - left) + 'px', height: (top - bottom) + 'px' });

    // the squares that have this floor (all of the place's, when the capture doesn't say), as tidy outlines
    const bit = 1 << (n - 1);
    let byFloor = !!f.squares;
    if (byFloor) {
      let any = false;
      for (let cy = box.r0; cy <= box.r1 && !any; cy++) {
        for (let cx = box.c0; cx <= box.c1 && !any; cx++) any = f.grid[cy * f.wide + cx] === place && !!(f.squares[cy * f.wide + cx] & bit);
      }
      byFloor = any;
    }
    const inside = (cx, cy) => cx >= 0 && cy >= 0 && cx < f.wide && cy < f.tall && f.grid[cy * f.wide + cx] === place
      && (!byFloor || !!(f.squares[cy * f.wide + cx] & bit));
    const loops = tidyLoops(squareOutline(inside, box), f.cell);

    // that shape, eight pixels to a square so its edge stays sharp: the floor's pictures show through it only, so
    // what's lit and what's outlined are the same
    const S = 8, w = box.c1 - box.c0 + 1, h = box.r1 - box.r0 + 1;
    const shape = document.createElement('canvas');
    shape.width = w * S;
    shape.height = h * S;
    const g = shape.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath();
    for (const loop of loops) {
      loop.forEach((p, i) => {
        const px = (p[0] - box.c0) * S, py = (box.r1 + 1 - p[1]) * S;
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      });
      g.closePath();
    }
    g.fill('nonzero');
    const url = 'url(' + shape.toDataURL() + ')';
    floorEl.style.webkitMaskImage = url;
    floorEl.style.maskImage = url;

    // the map's tiles under it, again, placed within it
    const col0 = Math.max(0, Math.floor((left - map.min.x) / map.tile)), col1 = Math.min(map.cols - 1, Math.floor((right - map.min.x - 1e-6) / map.tile));
    const row0 = Math.max(0, Math.floor((bottom - map.min.y) / map.tile)), row1 = Math.min(map.rows - 1, Math.floor((top - map.min.y - 1e-6) / map.tile));
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const img = new Image();
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        img.bx = (map.min.x + col * map.tile - left);
        img.by = (top - (map.min.y + (row + 1) * map.tile));
        layTile(img);
        floorEl.appendChild(img);
        floorTiles.push({ img, col, row, at: row * map.cols + col, want: '' });
      }
    }

    floorEdge = loops.map(loop => loop.map(p => [f.x + p[0] * f.cell, f.y + p[1] * f.cell]));
  }

  // A building on floor n: within its footprint, each spot shows the picture of the floor that's seen there. That's
  // floor n where the building has it; where it hasn't (the building is on split levels, or a hall is two floors
  // high) the nearest floor under it, looked down on, else the nearest over it. The other floors' pictures are a
  // little darker. The footprint is what's outlined.
  function showBuilding(b, n) {
    floorLabel(n, floorsOf(floorShown.place));
    const left = b.box.x0, right = b.box.x1, bottom = b.box.y0, top = b.box.y1;
    Object.assign(floorEl.style, { left: left + 'px', top: -top + 'px', width: (right - left) + 'px', height: (top - bottom) + 'px' });
    floorEl.style.webkitMaskImage = 'none';
    floorEl.style.maskImage = 'none';
    // the shapes are drawn eight pixels to a metre (fewer for a very big building), so their edges stay sharp
    const S = Math.min(8, 2048 / Math.max(right - left, top - bottom, 1));
    const w = Math.max(1, Math.ceil((right - left) * S)), h = Math.max(1, Math.ceil((top - bottom) * S));
    const fill = (g, loops) => {
      g.beginPath();
      for (const loop of loops) {
        for (let i = 0; i + 1 < loop.length; i += 2) {
          const px = (loop[i] - left) * S, py = (top - loop[i + 1]) * S;
          if (i) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.closePath();
      }
      g.fill('evenodd');
    };
    const col0 = Math.max(0, Math.floor((left - map.min.x) / map.tile)), col1 = Math.min(map.cols - 1, Math.floor((right - map.min.x - 1e-6) / map.tile));
    const row0 = Math.max(0, Math.floor((bottom - map.min.y) / map.tile)), row1 = Math.min(map.rows - 1, Math.floor((top - map.min.y - 1e-6) / map.tile));
    // floor m's pictures, showing through the loops given but not through the ones already shown
    const layer = (m, show, shown) => {
      const shape = document.createElement('canvas');
      shape.width = w;
      shape.height = h;
      const g = shape.getContext('2d');
      g.fillStyle = '#fff';
      fill(g, show);
      g.globalCompositeOperation = 'destination-out';
      for (const loops of shown) fill(g, loops);
      const el = document.createElement('div');
      el.className = m === n ? 'floorPart' : 'floorPart other';
      const url = 'url(' + shape.toDataURL() + ')';
      el.style.webkitMaskImage = url;
      el.style.maskImage = url;
      for (let row = row0; row <= row1; row++) {
        for (let col = col0; col <= col1; col++) {
          const img = new Image();
          img.alt = '';
          img.draggable = false;
          img.decoding = 'async';
          img.bx = (map.min.x + col * map.tile - left);
          img.by = (top - (map.min.y + (row + 1) * map.tile));
          layTile(img);
          el.appendChild(img);
          floorTiles.push({ img, col, row, at: row * map.cols + col, want: '', n: m });
        }
      }
      floorEl.appendChild(el);
    };
    // under everything, floor n over the whole footprint: what shows in the walls and between two floors' parts
    layer(n, b.l, []);
    const shown = [];
    for (const m of [n, ...b.floors.filter(k => k < n).reverse(), ...b.floors.filter(k => k > n)]) {
      const loops = b.parts.filter(p => p.n === m).flatMap(p => p.l);
      if (!loops.length) continue;
      layer(m, loops, shown);
      shown.push(loops);
    }
    floorEdge = b.l.map(loop => {
      const points = [];
      for (let i = 0; i + 1 < loop.length; i += 2) points.push([loop[i], loop[i + 1]]);
      return points;
    });
  }

  // A floor's outlines without the bits that only look like noise: a scrap of floor under 40 m2 (a porch, a pipe
  // bridge's foot) and a hole in the floor under 400 m2 (a stairwell, a gap the capture left). A loop's area is
  // positive round floor and negative round a hole. Everything is kept when nothing else would be left.
  function tidyLoops(loops, cell) {
    const area = loop => {
      let a = 0;
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return a / 2 * cell * cell;
    };
    const kept = loops.filter(loop => { const a = area(loop); return a >= 40 || a <= -400; });
    return kept.some(loop => area(loop) > 0) ? kept : loops;
  }

  // A floor's outline, square cornered. The capture's 2 m squares turn a wall into stairs and leave stray squares
  // as nubs and notches, and straightening the stairs gave slanting edges where the building has none. So the
  // squares are looked at turned the way the building stands (the turn that fits its edge in the smallest box), a
  // lone square sticking out or cut in is smoothed away, and the outline is traced along those turned axes: every
  // edge runs along or across the building and meets the next one square. Loops of [column, row] corners (not whole
  // numbers when turned), the inside on the left.
  function squareOutline(inside, box) {
    const edge = [];
    for (let cy = box.r0; cy <= box.r1; cy++) {
      for (let cx = box.c0; cx <= box.c1; cx++) {
        if (inside(cx, cy) && !(inside(cx - 1, cy) && inside(cx + 1, cy) && inside(cx, cy - 1) && inside(cx, cy + 1))) {
          edge.push([cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]);
        }
      }
    }
    if (!edge.length) return [];
    const spread = deg => {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, y] of edge) {
        const u = x * c + y * s, v = y * c - x * s;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      return { area: (u1 - u0) * (v1 - v0), u0, u1, v0, v1, c, s };
    };
    // which way the building stands: the way of its long walls, found from its outline straightened (the 2 m
    // squares make a slanting wall into stairs, straightening makes them a slant again), each wall counting by its
    // length squared. The map's own axes when that's within three degrees (a lean that small is the squares' noise),
    // or they hold most of the walls.
    const ow = box.c1 - box.c0 + 3, oh = box.r1 - box.r0 + 3;
    const walls = [];
    for (const loop of traceSquares((i, j) => inside(box.c0 - 1 + i, box.r0 - 1 + j), ow, oh)) {
      const l = straighten(loop, 1);
      for (let k = 0; k < l.length; k++) {
        const p = l[k], q = l[(k + 1) % l.length], dx = q[0] - p[0], dy = q[1] - p[1], size = Math.hypot(dx, dy);
        if (size >= 3) walls.push([((Math.atan2(dy, dx) * 180 / Math.PI) % 90 + 90) % 90, size * size]);
      }
    }
    const apart = (x, y) => ((x - y + 45) % 90 + 90) % 90 - 45;
    let deg = 0;
    if (walls.length) {
      let top = -1, peak = 0;
      for (let t = 0; t < 90; t += 0.5) {
        let sum = 0;
        for (const [w, n] of walls) if (Math.abs(apart(w, t)) <= 1.5) sum += n;
        if (sum > top) { top = sum; peak = t; }
      }
      let sum = 0, n = 0, square = 0;
      for (const [w, m] of walls) {
        const d = apart(w, peak);
        if (Math.abs(d) <= 1) { sum += d * m; n += m; }
        if (Math.abs(apart(w, 0)) <= 1.5) square += m;
      }
      deg = peak + (n ? sum / n : 0);
      if (deg > 45) deg -= 90;
      if (Math.abs(deg) < 3 || square >= top * 0.6) deg = 0;
    }
    const turn = spread(deg);
    const { c, s } = turn;

    // the squares again, on a grid turned that way: u along, v across
    const U0 = Math.floor(turn.u0) - 1, V0 = Math.floor(turn.v0) - 1;
    const W = Math.ceil(turn.u1) - U0 + 2, H = Math.ceil(turn.v1) - V0 + 2;
    let on = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const u = U0 + i + 0.5, v = V0 + j + 0.5;
        on[j * W + i] = inside(Math.floor(u * c - v * s), Math.floor(u * s + v * c)) ? 1 : 0;
      }
    }
    const at = (i, j) => i >= 0 && j >= 0 && i < W && j < H && on[j * W + i] === 1 ? 1 : 0;

    // a square with one side or none on the floor goes, a gap with three or four sides on it is filled
    for (let pass = 0; pass < 6; pass++) {
      const next = on.slice();
      let changed = false;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const n = at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1);
          const k = j * W + i;
          if (on[k] && n <= 1) { next[k] = 0; changed = true; }
          else if (!on[k] && n >= 3) { next[k] = 1; changed = true; }
        }
      }
      on = next;
      if (!changed) break;
    }

    // trace it, keep only the corners, and turn them back
    const back = (i, j) => {
      const u = U0 + i, v = V0 + j;
      return [u * c - v * s, u * s + v * c];
    };
    return traceSquares(at, W, H).map(flatten).map(unstair).filter(loop => loop.length > 2).map(loop => loop.map(p => back(p[0], p[1])));
  }

  // A loop of corners straightened (Douglas-Peucker) where it strays less than `most` from a straight line.
  function straighten(loop, most) {
    if (loop.length < 5) return loop;
    // split the loop at the corner farthest from its first, and straighten each half
    let far = 0, best = -1;
    for (let i = 1; i < loop.length; i++) {
      const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    const half = pts => {
      const keep = new Uint8Array(pts.length);
      keep[0] = keep[pts.length - 1] = 1;
      const todo = [[0, pts.length - 1]];
      while (todo.length) {
        const [i, j] = todo.pop();
        const [ax, ay] = pts[i], dx = pts[j][0] - ax, dy = pts[j][1] - ay, len = Math.hypot(dx, dy) || 1;
        let worst = -1, at = -1;
        for (let k = i + 1; k < j; k++) {
          const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / len;
          if (d > worst) { worst = d; at = k; }
        }
        if (worst > most) { keep[at] = 1; todo.push([i, at], [at, j]); }
      }
      return pts.filter((p, k) => keep[k]);
    };
    const a = half(loop.slice(0, far + 1)), b = half(loop.slice(far).concat([loop[0]]));
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  // A square-cornered loop with its stairs made slants again: five or more short edges in a row turning left,
  // right, left and so on, every other one a single square (the risers) and the rest four squares or less (the
  // treads), are a wall at a slant to the building, and go straight from the first corner to the last. A
  // crenellated edge (left, left, right, right) and a real corner of the building (no run of single squares) stay.
  function unstair(pts) {
    const n = pts.length;
    if (n < 6) return pts;
    const size = e => Math.abs(pts[(e + 1) % n][0] - pts[e][0]) + Math.abs(pts[(e + 1) % n][1] - pts[e][1]);
    const short = e => size(e) <= 4;
    const turn = k => {
      const a = pts[(k + n - 1) % n], p = pts[k], b = pts[(k + 1) % n];
      return Math.sign((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]));
    };
    let s = -1;
    for (let e = 0; e < n && s < 0; e++) if (!short(e)) s = e;
    if (s < 0) return pts;
    const keep = new Uint8Array(n).fill(1);
    let start = 0, count = 0, last = 0;
    const end = () => {
      let odd = true, even = true;
      for (let q = 0; q < count; q++) {
        if (size((start + q) % n) !== 1) { if (q % 2) odd = false; else even = false; }
      }
      if (count >= 5 && (odd || even)) for (let q = 1; q < count; q++) keep[(start + q) % n] = 0;
      count = 0;
      last = 0;
    };
    for (let m = 1; m <= n; m++) {
      const e = (s + m) % n;
      if (!short(e)) { end(); continue; }
      if (count) {
        const t = turn(e);
        if (last && t === last) end();
        else { last = t; count++; continue; }
      }
      start = e;
      count = 1;
    }
    end();
    return pts.filter((p, k) => keep[k]);
  }

  // A square-cornered loop without its shallow nubs and dents: where the edge steps out (or in) by one square and
  // back again within five, it's straightened through. Stairs, which step the same way twice, are left alone.
  function flatten(loop) {
    const len = (p, q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
    const corner = (a, p, b) => (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
    let pts = loop.slice();
    for (let changed = true, guard = 0; changed && guard < 1000; guard++) {
      changed = false;
      const n = pts.length;
      if (n < 6) break;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n], d = pts[(i + 3) % n];
        if (len(a, b) !== 1 || len(c, d) !== 1 || len(b, c) > 5) continue;
        // out by one and back by one: a to b and c to d point opposite ways
        if ((b[0] - a[0]) !== -(d[0] - c[0]) || (b[1] - a[1]) !== -(d[1] - c[1])) continue;
        const drop = new Set([(i + 1) % n, (i + 2) % n]);
        pts = pts.filter((p, k) => !drop.has(k));
        pts = pts.filter((p, k) => corner(pts[(k + pts.length - 1) % pts.length], p, pts[(k + 1) % pts.length]));
        changed = true;
        break;
      }
    }
    return pts;
  }

  // The outline of a set of squares (inside(column, row), 0 to wide and tall), as closed loops of square corners
  // [column, row] with the inside on the left, a corner kept only where the edge turns.
  function traceSquares(inside, wide, tall) {
    const from = new Map();
    const id = (x, y) => x * 65536 + y;
    const add = (x0, y0, x1, y1) => {
      const k = id(x0, y0);
      if (!from.has(k)) from.set(k, []);
      from.get(k).push([x1, y1]);
    };
    for (let cy = 0; cy < tall; cy++) {
      for (let cx = 0; cx < wide; cx++) {
        if (!inside(cx, cy)) continue;
        if (!inside(cx, cy - 1)) add(cx, cy, cx + 1, cy);
        if (!inside(cx + 1, cy)) add(cx + 1, cy, cx + 1, cy + 1);
        if (!inside(cx, cy + 1)) add(cx + 1, cy + 1, cx, cy + 1);
        if (!inside(cx - 1, cy)) add(cx, cy + 1, cx, cy);
      }
    }
    const loops = [];
    for (const [start, outs] of from) {
      while (outs.length) {
        const loop = [];
        let k = start;
        for (let guard = 0; guard < 1e6; guard++) {
          const list = from.get(k);
          if (!list || !list.length) break;
          loop.push([Math.floor(k / 65536), k % 65536]);
          const to = list.pop();
          k = id(to[0], to[1]);
          if (k === start) break;
        }
        const corners = loop.filter((p, i) => {
          const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
          return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
        });
        if (corners.length > 2) loops.push(corners);
      }
    }
    return loops;
  }

  function drawFloorEdge() {
    if (!floorEdge.length) return;
    ctx.save();
    ctx.beginPath();
    for (const loop of floorEdge) {
      loop.forEach((p, i) => {
        const s = toScreen(p[0], p[1]);
        if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      });
      ctx.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = '#5fd4ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // the building under the pointer that can be pressed open: greyed over, with a solid outline (a dashed one crawls as the map zooms)
  function drawHovered() {
    const list = map.floors && map.floors.buildings;
    if (list && revealing()) {
      ctx.save();
      ctx.beginPath();
      list.forEach((b, i) => {
        if (BUILDING + i === floorShown.place) return;
        for (const loop of b.l) {
          for (let k = 0; k + 1 < loop.length; k += 2) {
            const s = toScreen(loop[k], loop[k + 1]);
            if (k) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
          }
          ctx.closePath();
        }
      });
      ctx.fillStyle = 'rgba(160,166,172,0.2)';
      ctx.fill('evenodd');
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(240,242,244,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
    const b = hovered && list ? list[hovered - BUILDING] : null;
    if (!b) return;
    ctx.save();
    ctx.beginPath();
    for (const loop of b.l) {
      for (let i = 0; i + 1 < loop.length; i += 2) {
        const s = toScreen(loop[i], loop[i + 1]);
        if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      }
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(160,166,172,0.32)';
    ctx.fill('evenodd');
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,242,244,0.95)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  function showMap(next, keepPlace) {
    if (!next || next === map) return;
    map = next;
    layersEl.textContent = '';
    tiles = [];
    tilesPrint = '';
    lapShown = 0;
    for (let row = 0; row < map.rows; row++) {
      for (let col = 0; col < map.cols; col++) {
        const img = new Image();
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        img.bx = (map.min.x + col * map.tile);
        img.by = -(map.min.y + (row + 1) * map.tile);
        layTile(img);
        layersEl.appendChild(img);
        tiles.push({ img, col, row, at: row * map.cols + col, want: '' });
      }
    }
    floorEl = document.createElement('div');
    floorEl.id = 'floorLayer';
    floorEl.hidden = true;
    layersEl.appendChild(floorEl);
    floorShown = { place: 0, n: 0 };
    floorWantKey = '0:0';
    floorTiles = [];
    floorEdge = [];
    opened = 0;
    hovered = 0;
    floorPick = null;
    stage.classList.remove('canOpen');
    $('reveal').hidden = !(prefs.pressOpen && map.floors && map.floors.buildings);
    layersEl.classList.remove('dim');
    $('floorBadge').hidden = true;
    places = null;
    lootTable = null;
    lootAsked = '';
    loadPlaces(true);
    loadSpawns();
    listFloors();
    turn = turnFor(map.loc);
    $('optTurn').value = prefs.turns && prefs.turns[map.loc] !== undefined ? String(prefs.turns[map.loc]) : 'auto';
    setZoomLimits();
    $('map').value = map.loc;
    if (!keepPlace) {
      zoom = zoomTarget = zoomMin;
      centreOn((map.min.x + map.max.x) / 2, (map.min.y + map.max.y) / 2);
    }
    pointed = null;
    dirty = true;
  }

  // ---- what lies about, and where things stand -------------------------------------------------------------------
  // The places on a location (containers, locks, spawn points), kept by the server since a raid there; asked for
  // when a map is shown, and again now and then while there are none.
  async function loadPlaces(force) {
    if (!map) return;
    const loc = map.loc, now = performance.now();
    if (!force && placesAsked === loc && (places || now - placesAskedAt < 15000)) return;
    placesAsked = loc;
    placesAskedAt = now;
    try {
      const answer = await (await fetch('api/places?loc=' + encodeURIComponent(loc))).json();
      if (!map || map.loc !== loc) return;
      places = answer && !answer.none ? readPlaces(answer) : null;
      placeZones();
      dirty = true;
    } catch (e) { /* asked again in a while */ }
  }
  const list = v => Array.isArray(v) ? v : [];
  // a container of a sort switched off under Loot > Filters > Kinds of container
  const boxHidden = b => prefs.boxOff.length > 0 && prefs.boxOff.includes(((places && places.names || {})[b.tpl] || {}).c || 'crate');
  // what one of a thing that can spawn is worth; money comes in stacks of no set size, so its price is said to be for one
  const canWorth = (tn, tpl) => roubles((tn[tpl] || {}).p || 0) + ((tn[tpl] || {}).g === 'money' ? ' ' + T('each') : '');
  const at3 = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  // Where loot can spawn on the map shown, and what: asked for once the layer is switched on. Nothing to do with a
  // raid: it's what the server rolls each raid's loot from.
  async function loadSpawns() {
    if (!map || isHidden('Layer lootSpawns')) return;
    const loc = map.loc, now = performance.now();
    if (lootAsked === loc && (lootTable || now - lootAskedAt < 15000)) return;
    lootAsked = loc;
    lootAskedAt = now;
    try {
      const answer = await (await fetch('api/spawns?loc=' + encodeURIComponent(loc))).json();
      if (!map || map.loc !== loc) return;
      lootTable = answer && !answer.none ? readSpawns(answer) : null;
      bestPrint = bestCanPrint = null;
      dirty = true;
    } catch (e) { /* asked again in a while */ }
  }
  // {loc, loose:[[east,north,height,chance,[[tpl,share],..]],..], boxes:{containerTpl:[[tpl,chance],..]},
  //  boxChance:{containerId:chance}, names}: each point with what it can spawn, its dearest first ("best": that one's worth)
  function readSpawns(raw) {
    const names = raw.names || {};
    const worth = tpl => (names[tpl] || {}).p || 0;
    const points = list(raw.loose).filter(p => Array.isArray(p) && p.length >= 5 && [p[0], p[1], p[2], p[3]].every(Number.isFinite) && Array.isArray(p[4]))
      // (a point at 0 never spawns: one the server can't reach, as a second point under another's id)
      .filter(p => !(p[3] <= 0))
      .map(p => ({ x: p[0], y: p[1], z: p[2], chance: p[3], items: p[4].filter(i => Array.isArray(i) && typeof i[0] === 'string').sort((a, b) => worth(b[0]) - worth(a[0])) }));
    // each point's kind: the kind of loot that's at least half of what it spawns, else "mixed"; and of each kind, how
    // many points and what they spawn most (each item's shares added up)
    const kinds = new Map();
    for (const pt of points) {
      const by = new Map();
      for (const i of pt.items) {
        const g = (names[i[0]] || {}).g || 'other';
        by.set(g, (by.get(g) || 0) + (+i[1] || 0));
      }
      let top = 'mixed', most = 0;
      for (const [g, share] of by) if (share > most) { most = share; top = g; }
      pt.kind = most >= 0.5 && SPAWN_KINDS[top] ? top : 'mixed';
      // a point that spawns nothing but quest items is a quest item's: drawn and switched as those are
      pt.quest = pt.items.length > 0 && pt.items.every(i => !!(names[i[0]] || {}).q);
      if (pt.quest) pt.kind = 'quest';
      let k = kinds.get(pt.kind);
      if (!k) kinds.set(pt.kind, k = { kind: pt.kind, count: 0, items: new Map() });
      k.count++;
      for (const i of pt.items) k.items.set(i[0], (k.items.get(i[0]) || 0) + (+i[1] || 0));
    }
    return { loc: raw.loc, names, points, kinds, boxes: raw.boxes || {}, boxChance: raw.boxChance || {} };
  }
  // A loot spawn point's kind, by what it mostly spawns (the kinds of loot, see LOOT_KINDS): a name, and what it is
  const SPAWN_KINDS = {
    electronics: [T('Tech'), T('Electronics: wires, circuit boards, drives, graphics cards, batteries and the like.')],
    meds: [T('Medical'), T('Medicine and medical supplies: kits, injectors, LEDX and the like.')],
    valuables: [T('Valuables'), T('Gold, figurines, watches, bitcoin and other things worth selling.')],
    keys: [T('Key'), T('Keys and keycards.')],
    info: [T('Intel'), T('Intelligence folders, diaries, flash drives, maps.')],
    mods: [T('Weapon parts'), T('Sights, grips, magazines, barrels and other attachments.')],
    ammo: [T('Ammo'), T('Rounds and ammo packs.')],
    food: [T('Provisions'), T('Food and drink.')],
    weapons: [T('Weapon'), T('Guns and melee weapons.')],
    gear: [T('Gear'), T('Armour, helmets, rigs, bags, headsets and clothing.')],
    tools: [T('Tools, materials'), T('Tools, screws, tape, hoses, building materials.')],
    household: [T('Household junk'), T('Cleaning supplies, fuel, flammables and other household barter items.')],
    money: [T('Money'), T('Roubles, dollars, euros.')],
    special: [T('Special'), T('Special equipment: markers, signal jammers, radios.')],
    quest: [T('Quest item'), T('Things quests send you for: they lie in the same place every raid.')],
    other: [T('Other'), T('Things the server has no kind for.')],
    mixed: [T('Mixed'), T('No one kind: a bit of everything.')],
  };
  // What a spawn point of each kind is drawn with, once zoomed in: a picture of our own, in lines, so it's told
  // from a container (a solid picture on a square). Each is drawn in a box 24 across: [path, 'f' filled, 'e' filled
  // with its inner shapes cut out, or 's' in outline].
  const ring = (x, y, r) => 'M' + (x - r) + ' ' + y + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0z';
  const ICONS = {
    // a cross
    meds: [['M9 3h6v6h6v6h-6v6H9v-6H3V9h6z', 'f']],
    // a cartridge, stood up
    // three rounds side by side
    ammo: [['M6 4c1.6 1.6 2 3.6 2 6h-4c0-2.4 .4-4.4 2-6zM4 11.5h4V20h-4zM12 4c1.6 1.6 2 3.6 2 6h-4c0-2.4 .4-4.4 2-6zM10 11.5h4V20h-4zM18 4c1.6 1.6 2 3.6 2 6h-4c0-2.4 .4-4.4 2-6zM16 11.5h4V20h-4z', 'f']],
    // a pistol
    weapons: [['M2.500 6h18.500v4.500h-7.500l-1.200 2.500H9.800L8.500 19.500H4l1.600-9H2.500z', 'f']],
    // a nut
    mods: [['M12 2.500l8.200 4.750v9.500L12 21.500l-8.200-4.750v-9.500z', 's'], [ring(12, 12, 3.200), 's']],
    // a helmet
    // an armoured vest: shoulder straps, a scooped neck, two pouches cut out of the front
    gear: [['M6.5 3h3c0 1.700 1 2.800 2.500 2.800S14.500 4.700 14.500 3h3l2 5.500-2 1.500V21h-11V10l-2-1.500zM8.300 13.200h3v4h-3zM12.700 13.200h3v4h-3z', 'f']],
    // a chip
    electronics: [['M7 7h10v10H7z', 's'], ['M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4', 's']],
    // a cut stone
    valuables: [['M6.500 4h11l4.500 6L12 21 2 10z', 's'], ['M2 10h20M9 4l3 6 3-6', 's']],
    // a key
    keys: [[ring(8, 8, 4.500), 's'], ['M11.200 11.200l9.300 9.300M16 16l2.500-2.500M19 19l2.500-2.500', 's']],
    // a folder
    info: [['M2.500 5.500h6.500l2 2.500h10.500v11.500h-19z', 's'], ['M2.500 11h19', 's']],
    // a tin
    food: [['M5.500 6.500c0-1.700 2.900-3 6.500-3s6.500 1.300 6.500 3v11c0 1.700-2.900 3-6.500 3s-6.500-1.300-6.500-3z', 's'], ['M5.500 6.500c0 1.700 2.900 3 6.500 3s6.500-1.300 6.500-3', 's']],
    // a hammer
    tools: [['M4 3.500h10.500l4 3.500h-4v1.500H4z', 'f'], ['M8.500 8.500h3.500v12.500H8.500z', 'f']],
    // a bottle
    household: [['M9.500 2.500h5v3l2.500 3.500v12h-10V9l2.500-3.500z', 's'], ['M7 13.500h10', 's']],
    // a banknote
    money: [['M2 6.500h20v11H2z', 's'], [ring(12, 12, 2.700), 's'], ['M5.500 10v4M18.500 10v4', 's']],
    // a radio
    special: [['M7 9.500h10v11.500H7z', 's'], ['M10 9.500V3M10.500 13.500h3M14.500 3.500c2 .800 3.500 2.300 4 4.500', 's']],
    // containers: a safe, a till, a filing cabinet, a holdall, a jacket, a toolbox, a computer, a grenade, a long
    // box with a rifle in it, a medical case, a ration box, a barrel's lid from above (a buried cache), a skull, a
    // crate: solid shapes with the detail cut out of them
    boxSafe: [['M3 2.5h18v16.5h-18zM5.9 10.7a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0zM8.2 10.7a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0zM17 7.7h1.7v6h-1.7z','e'],['M4.5 19h4v2.3h-4zM15.5 19h4v2.3h-4z','f']],
    boxRegister: [['M2.5 15h19v6.5h-19zM9.5 17.6h5v1.4h-5z','e'],['M4.800 14l2.400-7.800h9.600l2.400 7.800zM8.6 8h1.5v1.5h-1.5zM11.25 8h1.5v1.5h-1.5zM13.9 8h1.5v1.5h-1.5zM8 10.8h1.5v1.5h-1.5zM11.25 10.8h1.5v1.5h-1.5zM14.5 10.8h1.5v1.5h-1.5z','e'],['M12 1.8h7.5v3.4h-7.5z','f']],
    boxDrawer: [['M4.5 2.5h15v17h-15zM4.5 10.4h15v1.200h-15zM9.500 5.800h5v1.600h-5zM9.500 14.500h5v1.600h-5z','e'],['M5.500 19.500h2.800v2.200H5.500zM15.700 19.500h2.800v2.200h-2.800z','f']],
    boxBag: [['M1.800 13a4 4 0 0 1 4-4h12.400a4 4 0 0 1 4 4v3.500a4 4 0 0 1-4 4H5.800a4 4 0 0 1-4-4zM5.6 9h1.4v11.5h-1.4zM17 9h1.4v11.5h-1.4z','e'],['M8.500 9C8.500 4 15.500 4 15.500 9','s']],
    boxJacket: [['M8.500 2.300l3.500 3 3.500-3 5 2.700 2.200 8.500-3.200 1.200-1-3.700v10.700h-13V11l-1 3.700-3.200-1.200L3.500 5zM11.4 7h1.2v14.7h-1.2z','e']],
    boxTools: [['M2.3 10.3h19.4v10.4h-19.4zM10.2 12.6h3.6v3.4h-3.6z','e'],['M3.6 8h16.8v1.5h-16.8z','f'],['M8.500 8V5.300h7V8','s']],
    boxPc: [['M6 1.8h12v20.4h-12zM8.3 4.2h7.4v1.6h-7.4zM8.3 7.2h7.4v1.6h-7.4zM10 16.6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0z','e']],
    boxGrenade: [['M5.5 15.200a6.500 6.500 0 1 0 13 0a6.500 6.500 0 1 0-13 0z','f'],['M9.800 4.800h4.400v4.400H9.800z','f'],['M14 4.800h5v7.200h-1.900V6.700H14z','f'],['M4.800 6.800a2.200 2.200 0 1 0 4.400 0a2.200 2.200 0 1 0-4.400 0z','s']],
    boxWeapon: [['M2 4.500h20v15H2zM4 6.500h16v11H4z','e'],['M6 8.800h12v3.200h-5l-.900 1.600h-1.900l-.800 2.900H6.600l1-4.500H6z','f']],
    boxMed: [['M3.500 7h17a1.500 1.500 0 0 1 1.500 1.500v11a1.500 1.500 0 0 1-1.500 1.500h-17A1.500 1.500 0 0 1 2 19.500v-11A1.500 1.500 0 0 1 3.500 7zM10.500 9.700h3v3h3v3h-3v3h-3v-3h-3v-3h3z','e'],['M9 7V4.300h6V7','s']],
    boxFood: [['M3 11.2h18v10h-18zM8 14.4h8v3h-8z','e'],['M11.300 10L9.500 5.500H1.800L3.300 10zM12.700 10l1.800-4.500h7.700L20.700 10z','f']],
    boxCache: [['M2.5999999999999996 12a9.4 9.4 0 1 0 18.8 0a9.4 9.4 0 1 0 -18.8 0zM4.6 12a7.4 7.4 0 1 0 14.8 0a7.4 7.4 0 1 0 -14.8 0z','e'],['M6.2 12a5.8 5.8 0 1 0 11.6 0a5.8 5.8 0 1 0 -11.6 0zM12.8 9.9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0z','e']],
    boxBody: [['M7.800 7.300a4.200 4.200 0 1 0 8.400 0a4.200 4.200 0 1 0-8.400 0z','f'],['M3.500 21.500c0-5.200 3.600-8.300 8.500-8.300s8.500 3.100 8.500 8.300z','f']],
    // a wooden crate: a square frame braced corner to corner both ways
    boxCrate: [['M2.500 2.500h19v19h-19zM5.200 5.200h13.600v13.600H5.200z','e'],['M4.600 6.300L6.300 4.600 19.400 17.700 17.700 19.400z','f'],['M17.700 4.600L19.400 6.300 6.300 19.400 4.600 17.700z','f']],
    // a padlock, shut and open; a car (a locked trunk); a keycard; the BTR's stop, a sign on a post
    lock: [['M5.500 11h13v9.500h-13z', 's'], ['M8.500 11V8a3.500 3.500 0 0 1 7 0v3', 's'], [ring(12, 15.500, 1.500), 'f']],
    unlocked: [['M5.500 11h13v9.500h-13z', 's'], ['M8.500 11V7.500a3.500 3.500 0 0 1 6.800-1.200', 's'], [ring(12, 15.500, 1.500), 'f']],
    trunk: [['M2.500 16.500v-4l2.500-1 2.500-4.500h8l3 4.500 3 1v4z', 's'], [ring(7.500, 17, 2) + ring(16.500, 17, 2), 'f'], ['M8.500 11.500h7', 's']],
    keycard: [['M2.500 5.500h19v13h-19z', 's'], ['M2.500 8.500h19v3h-19z', 'f'], ['M5.500 15h5', 's']],
    stop: [['M12 21.500V10.500', 's'], ['M6.500 3h11v7.500h-11z', 's'], ['M9 6.800h6', 's']],
    // a die
    // a die showing five: a solid rounded face, its pips cut out
    mixed: [['M6.5 3.5h11a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3z' + ring(8.2, 8.2, 1.5) + ring(15.8, 8.2, 1.5) + ring(12, 12, 1.5) + ring(8.2, 15.8, 1.5) + ring(15.8, 15.8, 1.5), 'f']],
  };
  const SPAWN_GLYPH = {
    electronics: 'i:electronics', meds: 'i:meds', valuables: 'i:valuables', keys: 'i:keys', info: 'i:info', mods: 'i:mods', ammo: 'i:ammo',
    food: 'i:food', weapons: 'i:weapons', gear: 'i:gear', tools: 'i:tools', household: 'i:household', money: 'i:money', special: 'i:special',
    other: '?', mixed: 'i:mixed'
  };
  const SPAWN_INK = '#f4f5f6';
  // from how far out they have their pictures: the screen's short side this many metres across, or fewer
  const SPAWN_PICTURES = 320;
  const spawnKindName = kind => (SPAWN_KINDS[kind] || SPAWN_KINDS.mixed)[0];
  // the box of the map's spawn kinds: while the spawn points are shown
  let spawnIndexFor = null;
  function showSpawnIndex() {
    const table = lootTable && map && lootTable.loc === map.loc && !isHidden('Layer lootSpawns') ? lootTable : null;
    const box = $('spawnIndex');
    if (table === spawnIndexFor) return;
    spawnIndexFor = table;
    box.hidden = !table;
    if (!table) return;
    const list = $('spawnKinds');
    list.textContent = '';
    const tn = table.names;
    for (const k of [...table.kinds.values()].sort((a, b) => b.count - a.count)) {
      const row = document.createElement('div');
      row.className = 'kind';
      const name = document.createElement('b');
      name.textContent = T('{kind} spawn', { kind: spawnKindName(k.kind) });
      const count = document.createElement('em');
      count.textContent = '×' + k.count;
      const about = document.createElement('p');
      about.textContent = (SPAWN_KINDS[k.kind] || SPAWN_KINDS.mixed)[1];
      const usual = document.createElement('p');
      // of a kind's points, only what is of that kind: a money point can also spawn a few rounds, which aren't money
      const own = [...k.items].filter(([tpl]) => !SPAWN_KINDS[k.kind] || k.kind === 'mixed' || ((tn[tpl] || {}).g || 'other') === k.kind);
      usual.textContent = T('Here mostly:') + ' ' + (own.length ? own : [...k.items]).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([tpl]) => (tn[tpl] || {}).s || (tn[tpl] || {}).n || tpl).join(', ');
      row.append(count, name, about, usual);
      list.appendChild(row);
    }
  }
  // ---- search ----
  // What players call things, to what the game calls them (lower case; any of them will do)
  const FIND_SLANG = {
    btc: ['bitcoin'], bitcoin: ['bitcoin'], gpu: ['graphics card'], vpx: ['vpx flash storage'], usb: ['flash drive'], hdd: ['hard drive', 'hdd'],
    ssd: ['ssd'], intel: ['intelligence'], folder: ['intelligence folder'], lion: ['bronze lion'], horse: ['horse figurine'],
    cat: ['cat figurine'], rolex: ['roler'], skull: ['skull ring'], chain: ['gold chain'], tg: ['terragroup'], nvg: ['night vision'],
    mag: ['magazine'], mags: ['magazine'], defib: ['defibrillator'], aesa: ['phased array'], phase: ['phased array'], tp: ['toilet paper'],
    rr: ['red rebel'], wd40: ['wd-40'], gp: ['gp coin'], gpcoin: ['gp coin'], tushonka: ['beef stew'], tush: ['beef stew'], beef: ['beef stew'],
    labs: ['labs', 'laboratory'], keycard: ['keycard', 'access card'], card: ['keycard', 'card'], cms: ['cms surgical'], surv: ['surv12'],
    ifak: ['ifak'], afak: ['afak'], meds: ['medical'], ammo: ['ammo', 'cartridge', 'round'], m4: ['m4a1'], ak: ['ak-'], moonshine: ['moonshine'],
    bolts: ['bolts'], nuts: ['nuts'], fuel: ['fuel conditioner', 'fuel'], tank: ['tank battery'], ofz: ['ofz'], lvndmark: ['lvndmark'],
    sicc: ['sicc'], kappa: ['kappa'], gas: ['gas analyzer'], vase: ['vase'], dvd: ['dvd'], cpu: ['cpu fan', 'pc cpu'], ram: ['ram'],
    eagle: ['eagle'], prokill: ['prokill'], mule: ['mule'], propital: ['propital'], etg: ['etg'], salewa: ['salewa'], grizzly: ['grizzly'],
  };
  // a name made plain: lower case, in words of letters or of numbers (0.2BTC: 0 2 btc)
  const plain = text => String(text || '').toLowerCase().replace(/([0-9])([a-zа-яё])|([a-zа-яё])([0-9])/g, '$1$3 $2$4').replace(/[^a-z0-9а-яё]+/g, ' ').trim();
  // how many letters apart two words are (a letter changed, added, dropped, or two swapped), up to most (more: most + 1)
  function apart(a, b, most) {
    if (Math.abs(a.length - b.length) > most) return most + 1;
    let before = null, row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      let low = i;
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], before[j - 2] + 1);
        low = Math.min(low, next[j]);
      }
      if (low > most) return most + 1;
      before = row;
      row = next;
    }
    return row[b.length];
  }
  // Whether a name is what's searched for: every word searched for is in it, in any order: at the start of one of its
  // words (a short one: gpu isn't in Magpul) or, five letters or more, anywhere; as players call it (btc: bitcoin); run
  // over its words (m4: M4A1); or a letter off (two from ten letters) in a longer word (bitcion). Kept per name.
  // findExact: a name picked from the list, found by that name only
  let findWords = [], findMemo = new Map(), findExact = '';
  function setFind(text, exact) {
    find = text.trim().toLowerCase();
    findMemo = new Map();
    findExact = exact ? plain(find) : '';
    // (its words as typed: m4 stays one word, to be found run over a name's words)
    const typed = find.replace(/[^a-z0-9а-яё]+/g, ' ').trim();
    findWords = typed.split(' ').filter(Boolean).map(w => ({ w, also: (FIND_SLANG[w] || []).map(plain) }));
  }
  function findHits(text) {
    if (!text || !findWords.length) return false;
    let yes = findMemo.get(text);
    if (yes !== undefined) return yes;
    const name = plain(text), words = name.split(' ');
    if (findExact) {
      findMemo.set(text, yes = name === findExact);
      return yes;
    }
    // the name run together from each word on
    const runs = words.map((_, i) => words.slice(i).join(''));
    const starts = t => (' ' + name).includes(' ' + t) || runs.some(r => r.startsWith(t.replace(/ /g, '')));
    yes = findWords.every(({ w, also }) => {
      if (starts(w) || (w.length >= 5 && name.replace(/ /g, '').includes(w)) || also.some(starts)) return true;
      if (w.length < 5) return false;
      const most = w.length >= 10 ? 2 : 1;
      return words.some(n => apart(w, n.slice(0, w.length + most), most) <= most);
    });
    findMemo.set(text, yes);
    return yes;
  }
  // what was found, by name and kind, under the box: { label, kind, spots: [[east, north],..] }
  let findShown = '', findNext = new Map();
  function showFindList(results, looking) {
    const list = $('findList');
    const open = looking && findOpen;
    const rows = !open ? [] : [...results.values()].sort((a, b) => b.spots.length - a.spots.length || a.label.localeCompare(b.label)).slice(0, 40);
    const print = open ? find + '|' + rows.map(r => r.kind + r.label + r.spots.length).join('|') : '';
    if (print === findShown) return;
    findShown = print;
    list.hidden = !open;
    if (!open) return;
    const box = $('findBox').getBoundingClientRect();
    list.style.left = Math.max(8, box.left) + 'px';
    list.style.top = (box.bottom + 6) + 'px';
    list.style.width = Math.min(window.innerWidth - 16, Math.max(box.width, 320)) + 'px';
    list.textContent = '';
    if (!rows.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = map ? T('Nothing found for "{find}" on this map', { find }) : T('Nothing found for "{find}"', { find });
      list.appendChild(none);
      return;
    }
    for (const r of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hit';
      const name = document.createElement('b');
      name.textContent = r.label;
      const kind = document.createElement('small');
      kind.textContent = r.kind;
      const count = document.createElement('em');
      count.textContent = r.spots.length > 1 ? '×' + r.spots.length : '';
      row.append(name, kind, count);
      row.title = r.spots.length > 1 ? T('Go to the nearest; press again for the next') : T('Go there');
      // the box keeps the keyboard
      row.onpointerdown = e => e.preventDefault();
      row.onclick = () => {
        // that one, by its whole name, is what's searched for now: nothing else is drawn
        if (!findExact) {
          $('find').value = r.label;
          setFind(r.label, true);
          dirty = true;
        }
        // the nearest to the middle of the screen first, then on round them nearest first
        const key = r.kind + '|' + r.label;
        const mid = toMap(vw / 2, vh / 2);
        const order = r.spots.slice().sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]));
        const was = findNext.get(key);
        const step = was && was.n === r.spots.length ? was : { n: r.spots.length, seen: new Set() };
        let spot = order.find(p => !step.seen.has(p[0] + ',' + p[1]));
        if (!spot) { step.seen.clear(); spot = order[0]; }
        step.seen.add(spot[0] + ',' + spot[1]);
        findNext.set(key, step);
        goTo(spot[0], spot[1]);
      };
      list.appendChild(row);
    }
  }
  let findOpen = false;

  // a chance, as people say it
  // the boss waves' roles, as players know them (the bosses by name, the rest by their kind); one not here, by its role
  const ROLE_NAMES = { bossBully: 'Reshala', bossKilla: 'Killa', bossKillaAgro: 'Killa', bossKojaniy: 'Shturman', bossGluhar: 'Glukhar',
    bossSanitar: 'Sanitar', bossTagilla: 'Tagilla', bossTagillaAgro: 'Tagilla', bossKnight: 'Knight, Big Pipe, Birdeye', bossZryachiy: 'Zryachiy',
    bossBoar: 'Kaban', bossKolontay: 'Kollontay', bossPartisan: 'Partisan', gifter: 'Ded Moroz', sectantPriest: T('Cultists'),
    pmcBot: T('Raiders'), exUsec: T('Rogues'), arenaFighterEvent: 'Bloodhounds', ravangeZryachiyEvent: 'Zryachiy' };
  // a role the page leaves out of a spawn point's list: the waves of PMCs and scavs, and the infected
  const ROLE_SKIP = /^(pmc(BEAR|USEC)|assault|marksman|cursedAssault|infected)/i;
  // a zone's name, said plainly: "ZoneSubCommand" is "Sub command"
  const zoneName = z => String(z).replace(/^Zone_?/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
    .replace(/^(.)(.*)$/, (m, a, b) => a.toUpperCase() + b.toLowerCase());
  // who can spawn at a boss spawn point (in its zone), likeliest first, as "name · chance" lines
  const bossesAt = (bosses, zone) => {
    const seen = new Map();
    for (const [role, chance, zones] of bosses || []) {
      if (!zone || !zones.includes(zone) || ROLE_SKIP.test(role)) continue;
      const name = ROLE_NAMES[role] || role;
      seen.set(name, Math.max(seen.get(name) || 0, chance));
    }
    return [...seen].sort((a, b) => b[1] - a[1]).map(([name, chance]) => '   ' + name + ' · ' + percent(chance));
  };
  const percent = p => p >= 0.995 ? '100%' : p >= 0.1 ? Math.round(p * 100) + '%' : p >= 0.001 ? (p * 100).toFixed(1) + '%' : '<0.1%';
  function readPlaces(raw) {
    // who the location's boss waves can bring, how likely, and at which zones: [[role, chance, [zone, ..]], ..]
    const bosses = list(raw.bosses).filter(b => Array.isArray(b) && typeof b[0] === 'string' && Array.isArray(b[2]));
    // A boss spawn: a point the game marks for bosses, in a zone a boss wave of this location uses. The game marks
    // many more (Customs has them at the customs sheds, where no boss is sent): those are what else they're marked as.
    const bossZones = new Set(bosses.filter(b => !ROLE_SKIP.test(b[0])).flatMap(b => b[2]));
    const spawnKind = s => /Boss/.test(s.cat || '') && bossZones.has(s.zone) ? 'spawnBoss'
      : /Player/.test(s.cat || '') && !/^Savage$/.test(s.sides || '') ? 'spawnPmc' : 'spawnScav';
    return {
      loc: raw.loc, names: raw.names || {},
      boxes: list(raw.boxes).filter(b => at3(b.p) && b.id),
      locks: list(raw.locks).filter(l => at3(l.p) && l.key),
      spawns: list(raw.spawns).filter(s => at3(s.p)).map(s => Object.assign(s, { kind: spawnKind(s) })),
      zones: list(raw.zones).filter(z => at3(z.p) && typeof z.id === 'string'),
      exits: list(raw.exits).filter(e => at3(e.p) && typeof e.name === 'string'),
      stops: list(raw.stops).filter(s => at3(s.p)),
      route: oneRoad(list(raw.route).filter(line => Array.isArray(line) && line.length > 1)),
      bosses
    };
  }

  // The game keeps the BTR's road as one path per trip between two stops, so most stretches of road come several
  // times over, and their dashes, not lined up, draw as a solid line. This keeps each stretch once: every path is
  // cut into points a metre and a half apart, and only the runs that don't lie on a path already kept are added.
  function oneRoad(lines) {
    const STEP = 1.5, NEAR = 3, CELL = 4;
    const kept = new Map();
    const key = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
    const taken = p => {
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const q of kept.get((cx + dx) + ',' + (cy + dy)) || []) {
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < NEAR) return true;
        }
      }
      return false;
    };
    const keep = p => { const k = key(p[0], p[1]); if (!kept.has(k)) kept.set(k, []); kept.get(k).push(p); };
    const road = [];
    for (const line of lines) {
      const pts = [];
      line.forEach((p, i) => {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
        const last = pts[pts.length - 1];
        if (last) {
          const n = Math.ceil(Math.hypot(p[0] - last[0], p[1] - last[1]) / STEP);
          for (let j = 1; j < n; j++) pts.push([last[0] + (p[0] - last[0]) * j / n, last[1] + (p[1] - last[1]) * j / n]);
        }
        pts.push([p[0], p[1]]);
      });
      // decide first, then remember, so a path doesn't count as lying on itself
      const free = pts.map(p => !taken(p));
      let run = null;
      pts.forEach((p, i) => {
        if (free[i]) {
          if (!run) { run = i ? [pts[i - 1]] : []; road.push(run); }
          run.push(p);
        } else if (run) { run.push(p); run = null; }
      });
      pts.forEach((p, i) => { if (free[i]) keep(p); });
    }
    return road.filter(run => run.length > 1);
  }

  // Where the BTR stops inside a sniper's ground (the train depot on Woods), the yard it brings you to is free to walk
  // about, while the roads in through the minefields stay covered. So, near a stop, a sniper zone isn't drawn when it
  // holds the stop or the yard's containers (two or more); the ones over the roads in, with nothing to loot, are.
  // The map's zones are sorted again once its places (with the stops and containers) are in.
  function placeZones() {
    if (!map) return;
    const here = places && places.loc === map.loc ? places : null;
    const stops = here ? here.stops : [];
    const boxes = here ? here.boxes : [];
    const near = (p, z, by) => {
      const xs = z.p.map(q => q[0]), ys = z.p.map(q => q[1]);
      return p[0] > Math.min(...xs) - by && p[0] < Math.max(...xs) + by && p[1] > Math.min(...ys) - by && p[1] < Math.max(...ys) + by;
    };
    const inside = (p, poly) => {
      let yes = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
      }
      return yes;
    };
    const kills = z => Array.isArray(z.kill) && z.kill.length ? z.kill : [z.p];
    const within = (p, z) => kills(z).some(loop => inside(p, loop));
    const yard = z => z.k === 'sniper' && stops.some(s => near(s.p, z, 120))
      && (stops.some(s => within(s.p, z)) || boxes.filter(b => within(b.p, z)).length >= 2);
    map.zones = zoneAreas(map.rawZones.filter(z => !yard(z)));
    dirty = true;
  }

  // The player's started quests, and where every quest sends you: asked for when the game shown changes, and again
  // every little while (the profile changes after each raid).
  async function loadQuests(force) {
    const now = performance.now();
    // a few seconds apart at the most, and every twenty while nothing changed
    const gap = force || questsFor !== sid ? 3000 : 20000;
    if (questsAsking || now - questsAskedAt < gap) return;
    questsAsking = true;
    questsAskedAt = now;
    const whose = sid;
    try {
      const answer = await (await fetch('api/quests' + (whose ? '?session=' + encodeURIComponent(whose) : ''))).json();
      if (whose === sid) {
        questsFor = whose;
        quests = answer && !answer.none ? {
          sid: answer.sid,
          // Only true quest items count (the ones that exist for a quest alone, picked up where the quest says).
          // Ordinary items a quest wants found in raid or handed over are loot like any other: never marked, and a
          // goal that is only about them isn't listed.
          list: list(answer.quests).filter(q => q && typeof q.name === 'string').map(q => Object.assign(q, {
            goals: list(q.goals).map(g => {
              const asked = list(g.items);
              const items = asked.filter(tpl => ((answer.names || {})[tpl] || {}).q);
              return Object.assign(g, { items, plain: asked.length > 0 && !items.length && !list(g.zones).length });
            }).filter(g => !g.plain)
          })).filter(q => q.goals.length),
          zones: answer.zones || {}, names: answer.names || {}
        } : null;
        dirty = true;
      }
    } catch (e) { /* asked again in a while */ } finally {
      questsAsking = false;
    }
  }
  // what the started quests want: { items: tpl -> [quest, goal], zones: zone id -> [quest, goal] }
  function questWants() {
    const items = new Map(), zones = new Map();
    for (const q of quests ? quests.list : []) {
      for (const goal of q.goals) {
        for (const tpl of list(goal.items)) if (!items.has(tpl)) items.set(tpl, [q, goal]);
        for (const z of list(goal.zones)) if (!zones.has(z)) zones.set(z, [q, goal]);
      }
    }
    return { items, zones };
  }

  // What lies about in the raid: asked for when the game says it changed, one question at a time.
  async function loadThings() {
    if (thingsAsking || !sid) return;
    thingsAsking = true;
    thingsTriedAt = performance.now();
    const want = thingsWanted, whose = sid;
    try {
      const answer = await (await fetch('api/things?session=' + encodeURIComponent(whose))).json();
      if (whose === sid && answer && !answer.none) {
        things = readThings(answer);
        dirty = true;
        if (!places || places.loc !== things.loc) loadPlaces(false);
      }
      thingsHave = want;
    } catch (e) { /* asked again at the next change */ } finally {
      thingsAsking = false;
      if (thingsHave !== thingsWanted) setTimeout(loadThings, 300);
    }
  }
  function readThings(raw) {
    const names = raw.names || {};
    const loose = list(raw.loose).filter(r => Array.isArray(r) && r.length >= 7).map(r => ({
      id: r[0], tpl: r[1], x: r[2], y: r[3], z: r[4], n: r[5] || 1,
      q: !!r[6] || !!(names[r[1]] || {}).q, worth: ((names[r[1]] || {}).p || 0) * (r[5] || 1)
    }));
    // the bodies, each a container of what it wears and carries: [id, east, north, height, name, side, kp, profile];
    // kp is 1 for a body a person playing killed; profile is whose it was, as its corpse marker's "pid" (an older
    // plugin sends neither: the marker is then found by name or nearness, and says who killed it)
    const bodies = list(raw.bodies).filter(r => Array.isArray(r) && r.length >= 4 && [r[1], r[2], r[3]].every(Number.isFinite))
      .map(r => ({ id: r[0], p: [r[1], r[2], r[3]], who: latin(r[4] || ''), whoRaw: r[4] || '', side: r[5] || '', kp: r[6] === 1, pid: r[7] || '', was: r[8] || '' }));
    // have: the containers this raid has (an older plugin doesn't say: null, and every one is drawn)
    return { loc: shownLoc(raw.loc), loose, inside: raw.inside || {}, carried: raw.carried || {}, open: new Set(list(raw.open)), names, bodies,
      have: Array.isArray(raw.have) ? new Set(raw.have) : null };
  }

  // A small picture, drawn once and kept: a glyph (an emoji, a letter or one of our pictures) on a badge, round,
  // square, a diamond or a hexagon ('hex'), with a black halo so it stands out on any ground.
  const badges = new Map();
  function badge(glyph, fill, rim, ink, form, size) {
    const ratio = pixelRatio();
    const px = Math.max(6, Math.round(size * ratio));
    const key = [glyph, fill, rim, ink, form, px].join('|');
    let c = badges.get(key);
    if (c) return c;
    if (badges.size > 600) badges.clear();
    const m = Math.ceil(px * 0.3) + 2;
    c = document.createElement('canvas');
    c.width = c.height = px + 2 * m;
    const g = c.getContext('2d');
    const mid = c.width / 2, half = px / 2;
    g.beginPath();
    if (form === 'round') g.arc(mid, mid, half, 0, Math.PI * 2);
    else if (form === 'diamond') {
      g.moveTo(mid, mid - half * 1.25); g.lineTo(mid + half * 1.25, mid); g.lineTo(mid, mid + half * 1.25); g.lineTo(mid - half * 1.25, mid);
      g.closePath();
    } else if (form === 'hex') {
      const d = half * 1.14;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        if (i) g.lineTo(mid + d * Math.cos(a), mid + d * Math.sin(a)); else g.moveTo(mid + d * Math.cos(a), mid + d * Math.sin(a));
      }
      g.closePath();
    } else if (g.roundRect) g.roundRect(mid - half, mid - half, px, px, px * 0.24);
    else g.rect(mid - half, mid - half, px, px);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(3, px * 0.3);
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.stroke();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = Math.max(1.5, px * 0.13);
    g.strokeStyle = rim;
    g.stroke();
    const icon = typeof glyph === 'string' && glyph.startsWith('i:') ? ICONS[glyph.slice(2)] : null;
    if (icon) {
      // one of our own pictures (see ICONS), in the ink's colour
      const k = px * (form === 'diamond' ? 0.6 : form === 'hex' ? 0.68 : 0.76) / 24;
      g.save();
      g.translate(mid - 12 * k, mid - 12 * k);
      g.scale(k, k);
      g.lineWidth = 2.2;
      g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = g.fillStyle = ink;
      for (const [d, how] of icon) { const p = new Path2D(d); if (how === 'e') g.fill(p, 'evenodd'); else if (how === 'f') g.fill(p); else g.stroke(p); }
      g.restore();
    } else if (glyph) {
      const letter = /^[A-Za-z!?★]$/.test(glyph);
      g.font = (letter ? 'bold ' : '') + Math.round(px * (letter ? 0.7 : 0.62)) + 'px '
        + (letter ? FONT : '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif');
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = ink;
      g.fillText(glyph, mid, mid + px * 0.05);
    }
    badges.set(key, c);
    return c;
  }

  // Draws the layers, under the markers: spawn points, every extract, locks, containers, quest places, loose loot.
  // What's on another floor than the player is fainter. Each is kept in thingsDrawn, so pointing at it says what it
  // is. While the search box has something in it, only what it finds is drawn, ringed.
  let holdMemo = { key: null, by: new Map() };
  // the places and items of the player's started quests that are off the screen (see drawEdge)
  let questOff = [];
  function drawThings(scale) {
    const LOOT_CELL = prefs.lootCell;
    thingsDrawn = [];
    thingsPut = [];
    questOff = [];
    corpsesNow = null;
    showSpawnIndex();
    let found = 0;
    const looking = find.length >= 2;
    const results = new Map();
    // something found: by its name and what it is, with where it is
    const note = (label, kind, p) => {
      if (!looking || !label) return;
      const key = kind + '|' + label;
      let r = results.get(key);
      if (!r) results.set(key, r = { label, kind, spots: [] });
      r.spots.push([p[0], p[1]]);
    };
    const tell = () => {
      const text = looking ? (found ? T('{n} found', { n: found }) : T('Nothing found')) : '';
      if ($('findCount').textContent !== text) $('findCount').textContent = text;
      $('findClear').hidden = !find;
      $('findBox').classList.toggle('has', !!find);
      showFindList(results, looking);
    };
    if (!map) return tell();
    const raidHere = inRaidHere();
    const loot = raidHere && things && things.loc === map.loc ? things : null;
    const shown = places && places.loc === map.loc ? places : null;
    if (!shown && !loot) return tell();
    const names = Object.assign({}, quests ? quests.names : {}, shown ? shown.names : {}, loot ? loot.names : {});
    const nameOf = tpl => (names[tpl] || {}).n || tpl;
    const worthOf = (tpl, n) => ((names[tpl] || {}).p || 0) * (n || 1);
    const hits = findHits;
    // what a kind of container can hold that's searched for, by name (kept while the search stays as it is)
    const holdKey = find + '|' + findExact + '|' + prefs.lootOff.join(',') + '|' + (lootTable ? lootTable.loc : '');
    if (holdMemo.key !== holdKey) holdMemo = { key: holdKey, by: new Map() };
    const canHold = (table, tpl) => {
      let names = holdMemo.by.get(tpl);
      if (names) return names;
      const tn = table.names;
      names = (table.boxes[tpl] || []).filter(i => kindOn(tn, i[0]) && (hits((tn[i[0]] || {}).n) || hits((tn[i[0]] || {}).s))).map(i => (tn[i[0]] || {}).n || i[0]);
      holdMemo.by.set(tpl, names);
      return names;
    };
    const itemHits = tpl => hits((names[tpl] || {}).n) || hits((names[tpl] || {}).s);
    const wants = questWants();
    // only the quests the player has started (once they're known): their items, and the places they send you
    const mine = prefs.myQuestItems && !!quests;
    const minePlaces = prefs.myQuestPlaces && !!quests;
    // loot on another floor than the player: fainter, or not drawn at all (a search still finds it)
    const faint = prefs.otherLoot / 100;
    const onScreen = (x, y) => {
      const s = toScreen(x, y);
      return s[0] > -30 && s[1] > -30 && s[0] < vw + 30 && s[1] < vh + 30 ? s : null;
    };
    // on another floor than the player (a place [east, north, height])
    // The building (or roofed place) whose floor is shown. With "Loot under roofs at full strength", only what's in
    // it goes by floors; everything else is seen from above, and drawn as strongly as what lies in the open.
    const shownIn = floorShown.n > 0 ? floorShown.place : 0;
    const shownB = shownIn >= BUILDING && map.floors && map.floors.buildings ? map.floors.buildings[shownIn - BUILDING] : null;
    const inShown = p => shownB ? inBox(shownB.box, p[0], p[1]) && inLoops(shownB.l, p[0], p[1]) : shownIn > 0 && placeAt(p[0], p[1]) === shownIn;
    const away = p => (prefs.roofLoot === false || inShown(p)) && otherFloor(p[0], p[1], p[2]) !== 0;
    // What the loot in each building seen from above is worth, of what's shown: written over it, so a building needn't
    // be looked into to know it's worth going in. (Which building a thing is in is worked out once.)
    const roofs = new Map();
    const blds = prefs.roofTotals !== false && map.floors && map.floors.buildings ? map.floors.buildings : null;
    const inBuilding = (thing, p, worth, box) => {
      if (!blds || !(worth > 0)) return;
      if (thing.bFor !== blds) { thing.bFor = blds; thing.bAt = buildingAt(p[0], p[1], p[2]); }
      if (!thing.bAt || thing.bAt === shownIn) return;
      let t = roofs.get(thing.bAt);
      if (!t) roofs.set(thing.bAt, t = { worth: 0, best: 0, loose: 0, boxes: 0 });
      t.worth += worth;
      t.best = Math.max(t.best, worth);
      if (box) t.boxes++; else t.loose++;
    };
    const gone = p => !looking && faint <= 0 && away(p);
    const close = Math.min(vw, vh) / zoom <= prefs.closeSpan;
    const size = Math.min(22, Math.max(12, 6 + zoom * 2.2)) * scale;
    const r = Math.max(2.5, 3.6 * scale);
    const ratio = pixelRatio();
    const put = (s, p, picture) => {
      const w = picture.width / ratio;
      ctx.globalAlpha = away(p) ? Math.max(0.15, faint) : 1;
      ctx.drawImage(picture, s[0] - w / 2, s[1] - w / 2, w, w);
      ctx.globalAlpha = 1;
      // where it is, for a press on it (see pressed: one on another floor of the building shown goes to that floor)
      thingsPut.push({ x: s[0], y: s[1], r: w / 2, p });
    };
    const ring = (s, radius) => {
      ctx.beginPath();
      ctx.arc(s[0], s[1], radius, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = LAYERS.quest.col;
      ctx.stroke();
    };
    ctx.save();
    ctx.lineJoin = 'round';

    if (shown) {
      // the BTR's road, a solid line (dashes crawl as the map zooms), and its stops
      if (!looking && !isHidden('Layer btrRoad') && (shown.route.length || shown.stops.length)) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const line of shown.route) {
          line.forEach((p, i) => {
            const s = toScreen(p[0], p[1]);
            if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
          });
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = LAYERS.btrRoad.col;
        ctx.lineWidth = 2.4;
        ctx.stroke();
        ctx.restore();
        for (const stop of shown.stops) {
          const s = onScreen(stop.p[0], stop.p[1]);
          if (!s) continue;
          put(s, stop.p, badge('i:stop', '#1a1a24', LAYERS.btrRoad.col, SPAWN_INK, 'round', size));
          thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: T('BTR stop'), lines: [] } });
        }
      }

      if (!looking) {
        for (const sp of shown.spawns) {
          if (isHidden('Layer ' + sp.kind)) continue;
          const s = onScreen(sp.p[0], sp.p[1]);
          if (!s) continue;
          put(s, sp.p, badge(SPAWN_LETTER[sp.kind], LAYERS[sp.kind].col, '#0c0c12', '#0c0c12', 'round', size * 0.95));
          // what spawns there (the bosses of the zone, with their chances), where it is and, for a PMC, the entry
          const who = sp.kind === 'spawnBoss' ? bossesAt(shown.bosses, sp.zone) : [];
          thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: (sp.kind === 'spawnPmc' ? T('PMC spawn') : sp.kind === 'spawnScav' ? T('Scav spawn') : sp.kind === 'spawnBoss' ? T('Boss spawn') : T('Spawn')),
            lines: [...(who.length ? [T('Who can spawn here:'), ...who] : []), sp.zone ? T('Zone:') + ' ' + zoneName(sp.zone) : '', sp.infil ? T('Entry:') + ' ' + sp.infil : ''] } });
        }
      }

      // every extract of the location: the ones that aren't the player's this raid hollow, by name
      if (!(prefs.myExits && raidHere) && !looking && !isHidden('Extract')) {
        const theirs = new Set(raidHere ? live.filter(m => m.c === 'Extract').map(m => m.t) : []);
        const seen = new Set();
        const mine = raidHere ? live.filter(m => m.c === 'Extract' && Number.isFinite(m.cx)) : [];
        const merged = [];
        for (const e of shown.exits) {
          const key = e.name + '|' + e.scav;
          if (seen.has(key) || theirs.has(e.text)) continue;
          seen.add(key);
          // under one of the player's own: that one says it
          if (mine.some(m => Math.hypot(m.cx - e.p[0], m.cy - e.p[1]) < 12)) continue;
          // the PMCs' and the scavs' way out at the same place: one marker for both
          const twin = merged.find(o => (o.text || o.name) === (e.text || e.name) && Math.hypot(o.p[0] - e.p[0], o.p[1] - e.p[1]) < 30);
          if (twin) { if (twin.scav !== e.scav) twin.both = true; continue; }
          merged.push(Object.assign({}, e));
        }
        // the scavs' ones first, so a PMC one at the same place is drawn over it
        merged.sort((a, c) => (c.scav && !c.both ? 1 : 0) - (a.scav && !a.both ? 1 : 0));
        const pmcAt = merged.filter(o => !o.scav || o.both).map(o => toScreen(o.p[0], o.p[1]));
        for (const e of merged) {
          const s = onScreen(e.p[0], e.p[1]);
          if (!s) continue;
          // a scav one under a PMC one: its name over the marker, the PMC one's under it, so both can be read
          const crowded = e.scav && !e.both && pmcAt.some(q => Math.hypot(q[0] - s[0], q[1] - s[1]) < size * 2.2);
          const col = e.scav && !e.both ? KINDS.Scav.col : '#8fe3a0';
          put(s, e.p, badge('', 'rgba(12,12,18,0.75)', col, col, 'diamond', size * 0.8));
          label((e.text || e.name) + (e.both ? ' (PMC + scav)' : e.scav ? ' (scav)' : ''), 11 * scale, s[0], crowded ? s[1] - size * 0.6 - 11 * scale * 1.3 : s[1] + size * 0.6, s[1] - size * 0.6, col);
          thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: e.text || e.name, lines: [e.both ? T('PMC and scav extract') : e.scav ? T('Scav extract') : T('PMC extract'), raidHere ? T('Not one of yours this raid') : ''] } });
        }
      }

      for (const l of shown.locks) {
        // a search for loot leaves the locks as they are (is what was found behind one?); a lock it finds is ringed
        const match = looking && (hits(nameOf(l.key)) || hits(l.kind));
        if (!match && (isHidden('Layer locks') || gone(l.p))) continue;
        if (match) found++;
        if (match) note(hits(nameOf(l.key)) ? nameOf(l.key) : lockName(l.kind), T('Lock'), l.p);
        const s = onScreen(l.p[0], l.p[1]);
        if (!s) continue;
        const open = loot && loot.open.has(l.id);
        const rim = open ? '#3ddc5a' : LAYERS.locks.col;
        put(s, l.p, badge(open ? 'i:unlocked' : LOCK_GLYPH[l.kind] || 'i:lock', '#1a1a24', rim, SPAWN_INK, 'hex', size));
        if (match) ring(s, size * 0.85);
        thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: lockName(l.kind) + ' · ' + (open ? T('open now') : T('locked')), lines: [T('Key:') + ' ' + nameOf(l.key)] } });
      }

      for (const b of shown.boxes) {
        if (boxHidden(b)) continue;
        if (prefs.loot === 'off') continue;
        // in a raid, only the containers the raid has (not while only what can be there is shown: every one, then)
        if (loot && lootReal() && loot.have && !loot.have.has(b.id)) continue;
        if (gone(b.p)) continue;
        // what's in it: only when it may be known (prefs.peek), and only of the kinds of loot shown
        const items = loot && peeking() ? loot.inside[b.id] || [] : null;
        // not known what's in it now (no raid here, or it's not shown): what one can hold, from the loot tables
        const table = !items && lootTable && lootTable.loc === map.loc && !isHidden('Layer lootSpawns') ? lootTable : null;
        const canHits = looking && table ? canHold(table, b.tpl) : [];
        const counted = items ? items.filter(i => kindOn(names, i[0])) : null;
        const total = counted ? counted.reduce((sum, i) => sum + worthOf(i[0], i[1]), 0) : 0;
        const forQuest = !!items && mine && items.some(i => wants.items.has(i[0]));
        const match = looking && ((items || []).some(i => itemHits(i[0])) || itemHits(b.tpl) || canHits.length > 0);
        // in a raid: the ones worth looking in, and every one up close; out of a raid, where they stand, up close
        const worth = !!items && total >= prefs.worth && total > 0;
        if (looking ? !match : isHidden('Layer boxes') || !(worth || close || forQuest)) continue;
        found++;
        if (worth && !looking) inBuilding(b, b.p, total, true);
        if (match) {
          for (const i of items || []) if (itemHits(i[0])) note(nameOf(i[0]), T('In a container'), b.p);
          if (itemHits(b.tpl)) note(nameOf(b.tpl), T('Container'), b.p);
          for (const name of canHits) note(name, T('Can be in a container'), b.p);
        }
        const s = onScreen(b.p[0], b.p[1]);
        if (!s) continue;
        const rim = forQuest ? LAYERS.quest.col : worth ? worthCol(total) : '#7c7f8f';
        put(s, b.p, badge(BOX_GLYPH[(names[b.tpl] || {}).c] || 'i:boxCrate', '#1a1a24', rim, SPAWN_INK, 'square', size));
        if (match || forQuest) ring(s, size * 0.85);
        // (what the box by the pointer lists: worked out only when the container is pointed at)
        const listed = () => {
          const lines = (counted || []).slice().sort((a, c) => worthOf(c[0], c[1]) - worthOf(a[0], a[1])).slice(0, 10)
            .map(i => nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + ' · ' + roubles(worthOf(i[0], i[1])) + (mine && wants.items.has(i[0]) ? ' · ' + T('quest') : ''));
          if (counted && counted.length > 10) lines.push(T('…and {n} more', { n: counted.length - 10 }));
          if (items && !items.length) lines.push(T('Empty'));
          else if (items && items.length > counted.length) lines.push(T('{n} of kinds not shown', { n: items.length - counted.length }));
          if (b.key) lines.push(T('Key:') + ' ' + nameOf(b.key));
          if (table && table.boxes[b.tpl]) {
            const tn = table.names, all = table.boxes[b.tpl], can = all.filter(i => kindOn(tn, i[0]))
              .sort((a, c) => ((tn[c[0]] || {}).p || 0) - ((tn[a[0]] || {}).p || 0));
            const there = table.boxChance[b.id];
            if (there !== undefined && there < 1) lines.push(T('There in {p} of raids', { p: percent(there) }));
            // (the kinds of loot left off in Options leave out what it can hold of them: say so, not an empty list)
            if (can.length) lines.push(T('Can hold:'));
            for (const i of can.slice(0, 12)) lines.push('   ' + ((tn[i[0]] || {}).s || (tn[i[0]] || {}).n || i[0]) + ' · ' + percent(i[1]) + ' · ' + canWorth(tn, i[0]));
            if (can.length > 12) lines.push('   ' + T('…and {n} more', { n: can.length - 12 }));
            if (all.length > can.length) lines.push(T('{n} of kinds not shown', { n: all.length - can.length }));
          }
          return lines;
        };
        thingsDrawn.push({ x: s[0], y: s[1], r: size / 2, tip: { title: nameOf(b.tpl) + (total ? ' · ' + roubles(total) : ''), get lines() { return listed(); } } });
      }

      // Where loose loot can spawn: a hollow ring each, in the colour of the dearest thing it can spawn of the kinds
      // shown, worth at least what's asked (any, up close); a search rings the points that can spawn what's searched for.
      if (lootTable && lootTable.loc === map.loc && !isHidden('Layer lootSpawns')) {
        const tn = lootTable.names;
        const pictures = Math.min(vw, vh) / zoom <= Math.max(prefs.closeSpan, SPAWN_PICTURES);
        const tnHits = tpl => hits((tn[tpl] || {}).n) || hits((tn[tpl] || {}).s);
        for (const pt of lootTable.points) {
          const can = pt.items.filter(i => kindOn(tn, i[0]));
          if (!can.length) continue;
          const best = (tn[can[0][0]] || {}).p || 0;
          const match = looking && can.some(i => tnHits(i[0]));
          // a quest item's: with the quest items' switch, whatever it's worth; only the player's quests' while those are asked for
          const wanted = pt.quest && mine ? can.map(i => wants.items.get(i[0])).find(Boolean) : null;
          if (pt.quest && !looking && (isHidden('Layer quest') || (mine && !wanted))) continue;
          if (looking ? !match : (!pt.quest && best < prefs.worth && !close) || gone([pt.x, pt.y, pt.z])) continue;
          found++;
          if (match) for (const i of can) if (tnHits(i[0])) note((tn[i[0]] || {}).n || i[0], T('Can spawn'), [pt.x, pt.y]);
          const s = onScreen(pt.x, pt.y);
          if (!s) continue;
          // zoomed in: its kind's picture, rimmed in its worth's colour; from further out a ring of that colour
          const pictured = pt.quest || (pictures && !!SPAWN_GLYPH[pt.kind]);
          const mark = Math.max(size, 20 * scale);
          if (pictured) {
            // (a quest item's: the quest items' diamond, dark, since it's where one can be and not one seen there)
            if (pt.quest) put(s, [pt.x, pt.y, pt.z], badge('!', '#1a1a24', LAYERS.quest.col, LAYERS.quest.col, 'diamond', size));
            else put(s, [pt.x, pt.y, pt.z], badge(SPAWN_GLYPH[pt.kind], '#1a1a24', worthCol(best), SPAWN_INK, 'round', mark));
          } else {
            ctx.globalAlpha = away([pt.x, pt.y, pt.z]) ? Math.max(0.15, faint) : 0.9;
            ctx.beginPath();
            ctx.arc(s[0], s[1], r * 0.95, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(16,17,18,0.55)';
            ctx.fill();
            ctx.lineWidth = 3.2;
            ctx.strokeStyle = '#000';
            ctx.stroke();
            ctx.lineWidth = 1.8;
            ctx.strokeStyle = worthCol(best);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          if (match) ring(s, pictured ? mark * 0.9 : r + 5);
          // what the box by the pointer says of it: worked out only when it's pointed at (there are thousands of
          // these, drawn again every frame in a raid)
          thingsDrawn.push({
            x: s[0], y: s[1], r: pictured ? mark * 0.55 : r * 1.3, tip: {
              get title() { return T('{kind} spawn', { kind: spawnKindName(pt.kind) }) + ' · ' + T('spawns in {p} of raids', { p: percent(pt.chance) }); },
              get lines() {
                const lines = can.slice(0, 12).map(i => ((tn[i[0]] || {}).s || (tn[i[0]] || {}).n || i[0]) + ' · ' + percent(i[1]) + ' · ' + canWorth(tn, i[0]));
                if (can.length > 12) lines.push(T('…and {n} more', { n: can.length - 12 }));
                if (can.length < pt.items.length) lines.push(T('{n} of kinds not shown', { n: pt.items.length - can.length }));
                return [wanted ? T('For {quest}', { quest: wanted[0].name }) : ''].concat([T('If it spawns, one of:')], lines);
              }
            }
          });
        }
      }

      // the places quests send you: the player's quests', or every quest's
      if (!isHidden('Layer questZones') && quests) {
        for (const z of shown.zones) {
          const want = wants.zones.get(z.id);
          const quest = want ? want[0].name : minePlaces ? null : quests.zones[z.id];
          if (!quest) continue;
          const goal = want ? want[1].text : '';
          if (looking && !hits(quest) && !hits(goal)) continue;
          found++;
          note(quest, T('Quest'), z.p);
          const s = onScreen(z.p[0], z.p[1]);
          if (!s) { if (want) questOff.push({ p: z.p, t: quest }); continue; }
          put(s, z.p, badge('★', LAYERS.quest.col, '#0c0c12', '#0c0c12', 'round', size * 1.1));
          if (want || zoom >= 3) label(quest, 11 * scale, s[0], s[1] + size * 0.7, s[1] - size * 0.7, LAYERS.quest.col, away(z.p) ? 0.5 : 1);
          thingsDrawn.push({ x: s[0], y: s[1], r: size * 0.6, tip: { title: quest, lines: [goal, want && want[0].trader ? T('From {trader}', { trader: want[0].trader }) : '', want ? '' : T('Not a quest you have started')] } });
        }
      }
    }

    if (loot) {
      // The corpses: each one ✕, the game's marker and the body it left (what it wears and carries) as one. What a
      // body carries shows when the ✕ is pointed at, only with "Corpse loot" on; a search finds it either way.
      const tipOn = !isHidden('Layer bodies');
      const free = new Set(loot.bodies);
      // the body a corpse marker left: the same person, or else the nearest within a few metres
      const linkOf = m => {
        let best = null, far = 4;
        for (const b of free) {
          if (m.pid && b.pid) { if (m.pid === b.pid) return b; continue; }
          if (m.t && b.who) { if (m.t === b.who) return b; continue; }
          const d = Math.hypot(m.p[0] - b.p[0], m.p[1] - b.p[1]);
          if (d < far) { far = d; best = b; }
        }
        return best;
      };
      const dress = (mark, b, kp) => {
        mark.body = b;
        mark.kp = !!kp || bodySeen(mark);
        if (!b) return mark;
        const items = peeking() ? loot.inside[b.id] || [] : [];
        const counted = items.filter(i => kindOn(names, i[0]));
        const total = counted.reduce((sum, i) => sum + worthOf(i[0], i[1]), 0);
        const shownHere = !isHidden('Corpse') && (mark.kp || prefs.allCorpses);
        if (looking && shownHere && (items.some(i => itemHits(i[0])) || hits(b.who))) {
          mark.ring = true;
          found++;
          for (const i of items) if (itemHits(i[0])) note(nameOf(i[0]), T('On a body'), b.p);
          if (hits(b.who)) note(latin(b.who), T('Body'), b.p);
        }
        if (tipOn) {
          const lines = counted.slice().sort((a, c) => worthOf(c[0], c[1]) - worthOf(a[0], a[1])).slice(0, 12)
            .map(i => nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + ' · ' + roubles(worthOf(i[0], i[1])) + (mine && wants.items.has(i[0]) ? ' · ' + T('quest') : ''));
          if (counted.length > 12) lines.push(T('…and {n} more', { n: counted.length - 12 }));
          if (peeking() && !items.length) lines.push(T('Nothing on it'));
          else if (items.length > counted.length) lines.push(T('{n} of kinds not shown', { n: items.length - counted.length }));
          if (!mark.was && b.was) mark.was = b.was;
          const who = markerText(mark) || b.who || (b.side === 'Savage' ? T('A scav') : b.side ? T('A {side}', { side: b.side.toUpperCase() }) : T('A body'));
          mark.tip = { title: who + (total ? ' · ' + roubles(total) : ''), lines };
        }
        return mark;
      };
      corpsesNow = [];
      for (const m of live) {
        if (m.c !== 'Corpse') continue;
        const b = linkOf(m);
        if (b) free.delete(b);
        corpsesNow.push(dress(Object.assign({}, m, b ? { cx: b.p[0], cy: b.p[1], cz: b.p[2] } : {}), b, m.kp || (b && b.kp)));
      }
      // bodies with no marker (they died while no page was open)
      for (const b of free) {
        corpsesNow.push(dress({ id: 'body:' + b.id, c: 'Corpse', t: b.who, was: b.was, p: b.p, cx: b.p[0], cy: b.p[1], cz: b.p[2], r: 0 }, b, b.kp));
      }

      // "Rough areas only": loose loot isn't drawn where it lies; what a square of LOOT_CELL metres holds is added up
      // and drawn as one circle in the square's middle (quest items, and what a search finds, are still shown)
      const cells = new Map();
      // quest items over the rest
      const order = loot.loose.slice().sort((a, b) => (a.q ? 1 : 0) - (b.q ? 1 : 0));
      for (const it of order) {
        const want = mine ? wants.items.get(it.tpl) : null;
        // a quest item of a quest the player hasn't started is left off, while only theirs are shown
        if (it.q && mine && !want) continue;
        const quest = it.q || !!want;
        if (!quest && !lootReal()) continue;
        const match = looking && itemHits(it.tpl);
        if (looking ? !match : quest ? isHidden('Layer quest') : isHidden('Layer loose') || it.worth < prefs.worth || !kindOn(names, it.tpl) || gone([it.x, it.y, it.z])) continue;
        found++;
        note(nameOf(it.tpl), T('Loose'), [it.x, it.y]);
        if (!quest && !looking) inBuilding(it, [it.x, it.y, it.z], it.worth, false);
        if (!quest && !match && prefs.lootArea) {
          const cx = Math.floor(it.x / LOOT_CELL), cy = Math.floor(it.y / LOOT_CELL), key = cx + ':' + cy;
          let cell = cells.get(key);
          if (!cell) cells.set(key, cell = { x: (cx + 0.5) * LOOT_CELL, y: (cy + 0.5) * LOOT_CELL, n: 0, worth: 0, best: 0 });
          cell.n++;
          cell.worth += it.worth;
          cell.best = Math.max(cell.best, it.worth);
          continue;
        }
        const s = onScreen(it.x, it.y);
        if (!s) { if (want) questOff.push({ p: [it.x, it.y], t: nameOf(it.tpl) }); continue; }
        if (quest) {
          put(s, [it.x, it.y, it.z], badge('!', LAYERS.quest.col, '#0c0c12', '#0c0c12', 'diamond', size * 1.05));
        } else {
          ctx.globalAlpha = away([it.x, it.y, it.z]) ? Math.max(0.15, faint) : 1;
          ctx.beginPath();
          ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
          ctx.fillStyle = worthCol(it.worth);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.4;
          ctx.fill();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (match) ring(s, quest ? size * 0.9 : r + 4);
        const short = (names[it.tpl] || {}).s || nameOf(it.tpl);
        const named = match || (quest && zoom >= 3) || (prefs.itemNames && close);
        if (named) write(short, 10 * scale, s[0], s[1] + (quest ? size * 0.7 : r * 1.3), quest ? LAYERS.quest.col : '#e8e9eb', away([it.x, it.y, it.z]) ? 0.5 : 0.95);
        // its worth beside its name, in its colour as a container's is (a quest item says whose quest instead)
        const why = want ? want[0].name + (want[1].text ? ': ' + want[1].text : '') : it.q ? T('Quest item') : '';
        thingsDrawn.push({ x: s[0], y: s[1], r: quest ? size / 2 : r * 1.2, tip: { title: nameOf(it.tpl) + (it.n > 1 ? ' ×' + it.n : '') + (why ? '' : ' · ' + roubles(it.worth)), lines: [why] } });
      }
      for (const cell of cells.values()) {
        const s = toScreen(cell.x, cell.y), across = LOOT_CELL * 0.62 * zoom;
        if (s[0] < -across || s[1] < -across || s[0] > vw + across || s[1] > vh + across) continue;
        const col = worthCol(cell.best);
        ctx.save();
        ctx.beginPath();
        ctx.arc(s[0], s[1], across, 0, Math.PI * 2);
        ctx.globalAlpha = 0.13;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([5 * scale, 5 * scale]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.restore();
        write(rough(cell.worth), 10 * scale, s[0], s[1] - 5 * scale, col, 0.95);
        thingsDrawn.push({ x: s[0], y: s[1], r: Math.min(across, 26 * scale), tip: { title: T('Loot somewhere here') + ' · ' + rough(cell.worth),
          lines: [cell.n <= 2 ? T('One or two things lying about in this area') : cell.n <= 6 ? T('A few things lying about in this area') : T('A lot of things lying about in this area')] } });
      }
      for (const [place, t] of roofs) {
        const bl = blds[place - BUILDING], bx = bl.box;
        // a bunker under the ground isn't a building to glance at from above: left out unless asked for
        if (!prefs.roofTotalsUnder && underOf(bl)) continue;
        const pts = [toScreen(bx.x0, bx.y0), toScreen(bx.x1, bx.y0), toScreen(bx.x1, bx.y1), toScreen(bx.x0, bx.y1)];
        const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
        const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
        // too small on the screen to write over, or off it
        if (x1 - x0 < 44 || x1 < 0 || y1 < 0 || x0 > vw || y0 > vh) continue;
        const said = prefs.lootArea ? rough(t.worth) : shortWorth(t.worth);
        // written over the middle of the building; where that's outside its walls (an L, a ring), at its topmost
        // corner, just inside
        let cx = (x0 + x1) / 2, top = y0 + 2, high = Infinity;
        const mx = (bx.x0 + bx.x1) / 2, my = (bx.y0 + bx.y1) / 2;
        if (inLoops(bl.l, mx, my)) {
          const s = toScreen(mx, my);
          cx = s[0];
          top = s[1] - 7 * scale;
        } else {
          for (const loop of bl.l) {
            for (let i = 0; i + 1 < loop.length; i += 2) {
              const s = toScreen(loop[i], loop[i + 1]);
              if (s[1] < high) { high = s[1]; cx = Math.min(x1 - 24, Math.max(x0 + 24, s[0])); top = s[1] + 4; }
            }
          }
        }
        write('⌂ ' + said, 11 * scale, cx, top, worthCol(t.best), 0.95);
        thingsDrawn.push({ x: cx, y: top + 7 * scale, r: 13 * scale, tip: { title: (underOf(bl) ? T('Under the ground here') : T('In this building')) + ' · ' + (prefs.lootArea ? rough(t.worth) : roubles(t.worth)),
          lines: prefs.lootArea ? [T('Press inside it to look in')] : [t.loose ? TP(t.loose, '{n} thing lying about', '{n} things lying about') : '',
            t.boxes ? TP(t.boxes, '{n} container worth looking in', '{n} containers worth looking in') : '', T('Press inside it to look in')] } });
      }
    }
    ctx.restore();
    tell();
  }

  // the name and worth of what's pointed at, by the pointer
  function showTip(found, sx, sy) {
    const tip = $('tip');
    if (!found) { if (!tip.hidden) tip.hidden = true; tipFor = null; return; }
    if (tipFor !== found.tip) {
      tipFor = found.tip;
      tip.textContent = '';
      // What it says comes as words with " · " between their parts ("Bitcoin ×2 · 1,520,000 ₽ · quest"). Set out
      // here: the name on the left, then a column each for a chance and a worth, the worth in its colour.
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
      const isWorth = t => /^[\d,]+ ₽$/.test(t), isChance = t => /^<?[\d.]+%$/.test(t);
      const worthOf = t => +t.replace(/[^\d]/g, '') || 0;
      const cells = (row, parts) => {
        for (const part of parts) {
          if (isWorth(part)) { const c = el('span', 'worth', part); c.style.color = worthCol(worthOf(part)); row.appendChild(c); }
          else if (isChance(part)) row.appendChild(el('span', 'chance', part));
          else if (part === 'quest') row.appendChild(el('span', 'tag', T('Quest')));
          else row.appendChild(el('span', 'more', part));
        }
      };
      const head = found.tip.title.split(' · ');
      const title = el('div', 'tipHead');
      title.appendChild(el('strong', '', head[0]));
      cells(title, head.slice(1));
      tip.appendChild(title);
      let list = null;
      for (const line of found.tip.lines) {
        if (!line) continue;
        const text = line.trim(), parts = text.split(' · ');
        const item = parts.length > 1 && parts.slice(1).some(p => isWorth(p) || isChance(p));
        if (!item) {
          list = null;
          // a heading ("Can hold:"), a key, or a line of plain words
          const cls = /[:：]$/.test(text) ? 'tipSub' : text.startsWith(T('Key:') + ' ') ? 'tipNote key' : 'tipNote';
          tip.appendChild(el('div', cls, cls === 'tipSub' ? text.slice(0, -1) : text));
          continue;
        }
        if (!list) tip.appendChild(list = el('div', 'tipList'));
        const row = el('div', 'tipRow');
        const price = parts.find(isWorth);
        const dot = el('i', 'dot');
        dot.style.background = price ? worthCol(worthOf(price)) : 'transparent';
        // how many of it, apart from its name
        const many = /^(.*?)( ×\d+)$/.exec(parts[0]);
        const name = el('span', 'name', many ? many[1] : parts[0]);
        if (many) name.appendChild(el('em', '', many[2]));
        row.append(dot, name);
        cells(row, parts.slice(1));
        list.appendChild(row);
      }
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(sx + 14, vw - w - 8) + 'px';
    tip.style.top = (sy + 14 + h > vh - 8 ? Math.max(8, sy - h - 10) : sy + 14) + 'px';
  }

  // ---- drawing -------------------------------------------------------------------------------------------------
  function write(text, px, x, y, col, alpha) {
    px *= prefs.textScale;
    ctx.font = 'bold ' + px + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, px * 0.28);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = col;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  // What a marker is called: a body says what it was ("Scav · name") when asked to, a PMC their level.
  const ONE = { 'Enemy Player': T('PMC'), 'Friendly Player': T('Player'), 'Main Player': T('Player'), 'Sniper': T('Sniper scav'), 'Other AI': T('Bot'),
    Scav: T('Scav'), Smuggler: T('Smuggler'), Raider: T('Raider'), Rogue: T('Rogue'), 'Black Division': T('Black Division'), RUAF: T('RUAF'),
    'RUAF Remnant': T('RUAF remnant'), Civilian: T('Civilian'), Infected: T('Infected'), Guard: T('Guard'), Cultist: T('Cultist'), Goon: T('Goon'),
    Boss: T('Boss'), Corpse: T('Body'), Extract: T('Extract'), Airdrop: T('Airdrop'), BTR: T('BTR') };
  const DROPS = { Common: T('Airdrop'), Supply: T('Supply airdrop'), Medical: T('Medical airdrop'), Weapon: T('Weapon airdrop') };
  // an airdrop's crate: what's in it and its worth, once the game tells (when container contents are shown)
  function dropTip(m) {
    if (m.c !== 'Airdrop') return null;
    const loot = inRaidHere() && things ? things : null;
    const items = loot && m.box && peeking() && !isHidden('Layer boxes') ? (loot.inside[m.box] || []).filter(i => kindOn(loot.names, i[0])) : [];
    const worthOf = i => ((loot.names[i[0]] || {}).p || 0) * (i[1] || 1);
    const nameOf = tpl => (loot.names[tpl] || {}).s || (loot.names[tpl] || {}).n || tpl;
    const sorted = items.slice().sort((a, b) => worthOf(b) - worthOf(a));
    const lines = sorted.slice(0, 14).map(i => nameOf(i[0]) + (i[1] > 1 ? ' ×' + i[1] : '') + ' · ' + roubles(worthOf(i)));
    if (sorted.length > 14) lines.push(T('…and {n} more', { n: sorted.length - 14 }));
    if (m.fall) lines.unshift(T('Coming down'));
    const total = items.reduce((sum, i) => sum + worthOf(i), 0);
    return { title: (DROPS[m.t] || T('Airdrop')) + (total ? ' · ' + roubles(total) : ''), lines };
  }
  function markerText(m) {
    if (m.c === 'Airdrop') return (DROPS[m.t] || T('Airdrop')) + (m.fall ? ' · ' + T('coming down') : '');
    if (m.c === 'Corpse') return prefs.corpseKind && m.was ? (ONE[m.was] || m.was) + (m.t ? ' · ' + m.t : '') : m.t || '';
    return m.t ? m.t + (m.lv ? ' · ' + T('Lv {n}', { n: m.lv }) : '') : '';
  }

  // What a bot is like and is up to, as the game's plugin tells it (when the server lets it): how hard it is, the
  // personality SAIN gave it, and who is deciding for it now: SAIN (it's in a fight), COMET (the move it's making in
  // that fight, or just after it), ORBIT (it's going about the map, or parked far from every player as a "ghost"),
  // or the game's own brain. Each only when that mod is in the game.
  const DIFFICULTY = { easy: T('difficulty|Easy'), normal: T('difficulty|Normal'), hard: T('difficulty|Hard'), impossible: T('difficulty|Impossible') };
  const SAIN_LAYERS = { 'Combat Layer': T('In a fight'), 'Squad Layer': T('In a fight, with its squad'), 'Extract': T('Leaving the raid'),
    'Avoid Threat': T('Getting away from a threat'), 'Flashed': T('Blinded'), 'SAIN Debug': T('Debug') };
  const COMET_MOVES = { Push: T('Pushing'), Hold: T('Holding'), KeepAngle: T('Holding an angle'), Search: T('Searching'), FallBack: T('Falling back'),
    Cover: T('Moving to cover'), Shoot: T('Shooting'), Flank: T('Flanking'), Crossfire: T('Crossfire'), PostCombat: T('After the fight') };
  const words = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  // "CrossfireMoving": "Crossfire · moving"; "Push": "Pushing"; one it doesn't know: as COMET has it, in words
  function cometMove(cm) {
    if (COMET_MOVES[cm]) return COMET_MOVES[cm];
    const part = /^(Crossfire|PostCombat)(.+)$/.exec(cm);
    if (part) return COMET_MOVES[part[1]] + ' · ' + words(part[2]);
    const said = words(cm);
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  // What COMET has a bot doing with its squad ("sq" on its marker, and each "comet.squad" event): the squad's tactic,
  // the bot's part in it, and whether COMET has it doing that yet or only means to.
  const SQUAD_TACTICS = { S01: T('Crossfire angles'), S02: T('Second way in'), S03: T('Support and flank'), S04: T('Covering a teammate'),
    S05: T("Answering a teammate's death"), S06: T('Squad assault') };
  const SQUAD_ANGLE = { planning: T('Planning'), ready: T('Ready'), moving: T('Moving to an angle'), holding: T('Holding an angle') };
  const SQUAD_DOOR = { planning: T('Planning'), moving: T('Moving to it'), watching: T('Watching it'), 'preparing-entry': T('About to go in'),
    opening: T('Opening it'), entering: T('Going in') };
  const squadTactic = q => SQUAD_TACTICS[q.f] || T('Squad tactic');
  const squadOver = q => q.s === 'ended' || q.u === 'ended';
  function squadPart(q) {
    if (squadOver(q)) return T('Over');
    if (q.f === 'S03') return q.r === 'support' ? (q.x ? T('Suppressing') : T('Supporting')) : q.r === 'rear' ? T('Watching the rear') : q.s === 'moving' ? T('Flanking') : T('Holding the flank');
    if (q.f === 'S06') return q.a ? T('Going in') : T('Getting ready');
    if (q.f === 'S05') return q.r === 'push' ? T('Pushing the killer') : q.s === 'moving' ? T('Moving to watch') : T('Watching where they fell');
    if (q.f === 'S04') return q.s === 'moving' ? T('Going to cover {who}', { who: q.m ? latin(q.m) : T('a teammate') }) : T('Covering {who}', { who: q.m ? latin(q.m) : T('a teammate') });
    if (q.f === 'S02') return SQUAD_DOOR[q.u] || SQUAD_ANGLE[q.s] || T('Second way in');
    return SQUAD_ANGLE[q.s] || T('Crossfire');
  }
  const squadSaid = q => squadTactic(q) + ' · ' + squadPart(q) + (q.a || squadOver(q) ? '' : ' (preparing)');
  // who a squad's tactic is against, by name, when that one is on the map
  function squadFoe(q) {
    if (!q.c) return '';
    const foe = live.find(x => x.pid === q.c);
    return foe ? (foe.t || ONE[foe.c] || foe.c) : me && me.pid === q.c ? 'you' : '';
  }
  // the bots acting together: the plan they share, else the group or band they go about in
  const squadKey = m => (m.sq && m.sq.p) || m.g || (m.bg ? 'bot:' + m.bg : 'solo:' + m.id);
  function brainOf(m) {
    if (m.gh) return { by: 'ORBIT', text: T('Ghost') + (m.ob ? ' · ' + m.ob : ''), ghost: true };
    const layer = m.ly || '';
    // COMET makes its moves through SAIN's layers and two of its own, so only then is the move still the bot's
    if (/^COMET/i.test(layer) && !modOn('COMET')) return null;
    if (/^SAIN/i.test(layer) && !m.cm && !modOn('SAIN')) return null;
    if (/^Orbit/i.test(layer) && !modOn('ORBIT')) return null;
    if (/^COMET/i.test(layer) || (m.cm && /^SAIN/i.test(layer))) {
      const after = /Post-combat/i.test(layer) || /^PostCombat/.test(m.cm || '');
      return { by: 'COMET', text: m.cm ? cometMove(m.cm) : layer.replace(/^COMET\s*:\s*/i, ''), fight: !after };
    }
    if (/^SAIN/i.test(layer)) {
      const name = layer.replace(/^SAIN\s*:\s*/i, '');
      return { by: 'SAIN', text: SAIN_LAYERS[name] || name, fight: name === 'Combat Layer' || name === 'Squad Layer' };
    }
    if (/^Orbit/i.test(layer)) return { by: 'ORBIT', text: m.ob || T('Going about the map') };
    // QuestingBots or Phobos sending it somewhere ("os": which)
    if (m.os && m.ob) return { by: m.os, text: m.ob };
    return layer ? { by: 'EFT', text: gameLayer(layer) } : null;
  }
  // The game's own brain layers, in plain words: the usual ones by name, the rest by what their name says (each
  // boss's has its own: PtrlBirdEye, KnightFight...), else the name split into words ("Loot patrol").
  const EFT_LAYERS = { LootPatrol: 'Patrolling, looking for loot', PatrolAssault: 'Patrolling', PatrolFollower: 'Following its leader',
    PmcBear: 'Going about the raid', PmcUsec: 'Going about the raid', StandBy: 'Standing by', AssaultHaveEnemy: 'Fighting',
    AssaultBuilding: 'Clearing a building', Pursuit: 'Chasing' };
  const EFT_LIKE = [[/Follow/i, 'Following its leader'], [/Fight|HaveEnemy|Attack|Combat/i, 'Fighting'], [/Pursuit|Chase/i, 'Chasing'],
    [/Heal/i, 'Healing'], [/Exfil|Leave/i, 'Leaving the raid'], [/Loot/i, 'Looting'], [/Sniper/i, 'Watching for targets'],
    [/^Ptrl|Patrol/i, 'Patrolling'], [/Stand|Wait|Idle/i, 'Standing by'], [/^Pmc/i, 'Going about the raid']];
  function gameLayer(name) {
    if (EFT_LAYERS[name]) return T(EFT_LAYERS[name]);
    for (const [test, said] of EFT_LIKE) if (test.test(name)) return T(said);
    const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }
  const likeOf = m => [DIFFICULTY[m.df] || m.df, m.ps].filter(Boolean).join(' · ');
  const hasDetails = m => prefs.botDetails && !!(m.df || m.ps || m.ly || m.gh);
  // What bots are like and are up to has a switch for each mod that says it: SAIN (personality, and that it's in a
  // fight), ORBIT (going about the map, or parked as a ghost), COMET (its move in a fight, and what its squad is doing
  // together). A switch is greyed, and can't be pressed, while the game hasn't that mod (remembered, so it's right
  // out of a raid too). With any of them on, a bot's difficulty and the game's own brain are shown as well.
  const BOT_MODS = { SAIN: "Each bot's SAIN personality, and when SAIN has it in a fight (a red ring round its marker).",
    ORBIT: 'What ORBIT has each bot heading for, and the bots it has parked as ghosts, far from every player.',
    COMET: "The move COMET has each bot making in a fight, and what its squad is doing together: tags in the Raid list, lines on the map to where each is sent, and the squad's events under the list." };
  const MOD_OPTIONS = [['optOrbitLines', 'ORBIT'], ['optOrbitNames', 'ORBIT'], ['optOrbitFights', 'ORBIT'], ['optOrbitHear', 'ORBIT'],
    ['optRosterGhosts', 'ORBIT'], ['optSquadParts', 'COMET']];
  const modHere = n => (prefs.brains || []).includes(n);
  const modOn = n => modHere(n) && prefs['bot' + n] !== false;
  function nameBotDetails() {
    for (const n of Object.keys(BOT_MODS)) {
      const box = $('optBot' + n), row = $('optBot' + n + 'Row'), here = modHere(n);
      box.disabled = !here;
      box.checked = here && prefs['bot' + n] !== false;
      row.classList.toggle('unavailable', !here);
      row.title = here ? T(BOT_MODS[n]) + ' ' + T("With the bot's difficulty, in the Raid list and by the pointer.")
        : prefs.brains ? T("{mod} isn't loaded in this game.", { mod: n }) : T('No game has said which mods it has yet.');
    }
    // every other switch that only does something with one of these mods: greyed the same way while it's missing (or
    // switched off above), saying why
    for (const [id, n] of MOD_OPTIONS) {
      const box = $(id), row = box.closest('label');
      if (row.dataset.tip === undefined) row.dataset.tip = row.title;
      const on = modOn(n);
      box.disabled = !on;
      row.classList.toggle('unavailable', !on);
      row.title = on ? row.dataset.tip : !modHere(n) && prefs.brains ? T("{mod} isn't loaded in this game.", { mod: n })
        : !modHere(n) ? T('No game has said which mods it has yet.') : row.dataset.tip;
    }
    squadPanePrint = '';
    if ($('squadPane')) showSquadPane();
    $('optBotDiff').checked = prefs.botDiff !== false;
    const on = prefs.botDiff !== false || Object.keys(BOT_MODS).some(modOn);
    if (prefs.botDetails !== on) { prefs.botDetails = on; save(); }
    dirty = true;
    rosterPrint = bestPrint = null;
    tipFor = null;
  }
  // a marker as the switches have it: what a mod says is left off while its switch is off
  function trimBrains(m) {
    if (prefs.botDiff === false) delete m.df;
    if (!modOn('SAIN')) delete m.ps;
    if (!modOn('ORBIT') && !m.os) { delete m.gh; delete m.ob; delete m.og; }
    if (!modOn('COMET')) { delete m.cm; delete m.sq; }
  }
  // what a living bot wears and carries, when asked for (off unless switched on): its worth, and the dearest first
  // Each thing is [template, how many, slot]: the slot it's worn in ("Headwear", "Backpack"), when the game's plugin
  // says (a newer one does); nothing for what lies in the pockets, rig and bags. worn: its guns and what it has on,
  // in the order below. held: the rest, the dearest first. lines: all of it as text, for the pointer.
  const WORN = [['FirstPrimaryWeapon', T('Primary')], ['SecondPrimaryWeapon', T('Secondary')], ['Holster', T('Sidearm')], ['Headwear', T('Helmet')],
    ['Earpiece', T('Headset')], ['FaceCover', T('Face')], ['Eyewear', T('Eyes')], ['ArmorVest', T('Armour')], ['TacticalVest', T('Rig')],
    ['Backpack', T('Backpack')], ['Scabbard', T('Melee')]];
  function carriedBy(m) {
    // its own switch (Raid > Bot loot), with Show what's inside things: whatever the Loot tab shows on the map, which
    // is about loot lying about, not what bots carry
    const loot = prefs.botLoot && prefs.peek && m.pid && m.c !== 'Corpse' && inRaidHere() && things ? things : null;
    const items = loot ? loot.carried[m.pid] : null;
    if (!items || !items.length) return null;
    const worthOf = i => ((loot.names[i[0]] || {}).p || 0) * (i[1] || 1);
    const said = i => ((loot.names[i[0]] || {}).s || (loot.names[i[0]] || {}).n || i[0]) + (i[1] > 1 ? ' ×' + i[1] : '');
    const worn = [];
    for (const [slot, label] of WORN) for (const i of items) if (i[2] === slot) worn.push({ label, text: said(i), worth: worthOf(i) });
    const rest = items.filter(i => !i[2]).sort((a, b) => worthOf(b) - worthOf(a));
    const held = rest.slice(0, 12).map(i => ({ text: said(i), worth: worthOf(i) }));
    const more = rest.length - held.length;
    const lines = worn.map(g => g.label + ': ' + g.text + (g.worth ? ' · ' + roubles(g.worth) : ''));
    if (worn.length && held.length) lines.push(T('Carrying:'));
    for (const h of held) lines.push((worn.length ? '   ' : '') + h.text + ' · ' + roubles(h.worth));
    if (more > 0) lines.push((worn.length ? '   ' : '') + T('…and {n} more', { n: more }));
    return { total: items.reduce((sum, i) => sum + worthOf(i), 0), lines, worn, held, more };
  }
  // said by the pointer; made once for each report of a marker
  function botTip(m) {
    const carried = carriedBy(m);
    if (!hasDetails(m) && !carried) return null;
    if (!m.botTip) {
      const brain = hasDetails(m) ? brainOf(m) : null, like = hasDetails(m) ? likeOf(m) : '';
      m.botTip = { title: (m.t || ONE[m.c] || m.c) + (carried && carried.total ? ' · ' + roubles(carried.total) : ''),
        lines: [(ONE[m.c] || m.c) + (like ? ' · ' + like : ''), brain ? brain.by + ': ' + brain.text : '',
          m.ch ? T('PBT cheater') : '', prefs.health && Array.isArray(m.hp) ? T('Health {hp} / {max}', { hp: m.hp[0], max: m.hp[1] }) : '',
          hasDetails(m) && m.sq ? T('Squad:') + ' ' + squadSaid(m.sq) + (squadFoe(m.sq) ? ' · ' + T('against {who}', { who: squadFoe(m.sq) }) : '') : ''].concat(carried ? carried.lines : []) };
    }
    return m.botTip;
  }

  // a name by a marker: always centred under it, fixed to it like the map itself, so it goes off the screen with its
  // marker (over: where it'd go above the marker, kept for the callers; no longer used)
  // (alpha: fainter for what's on another floor than the player)
  function label(text, px, x, under, over, col, alpha = 1) {
    write(text, px, x, under, col, alpha);
  }

  const DOING_COL = { SAIN: '#ff8d84', COMET: '#ffc56e', ORBIT: '#9fd8ff', QuestingBots: '#b7e3a1', Phobos: '#b7e3a1' };
  function drawMarker(m, strong, scale) {
    const kind = KINDS[m.c] || OTHER;
    const at = toScreen(m.cx, m.cy);
    const x = at[0], y = at[1];
    if (x < -150 || y < -150 || x > vw + 150 || y > vh + 150) return;
    const r = 8 * scale * kind.size * (strong ? 1.2 : 1);
    const col = m.c === 'Extract' && m.st !== undefined ? EXIT_COL[m.st] || kind.col
      : m.c === 'Corpse' && prefs.corpseKind && m.was && KINDS[m.was] ? KINDS[m.was].col : kind.col;
    // on another floor than the player: fainter, with an arrow up or down
    const apart = m.c !== 'Main Player' && m.c !== 'Extract' && m.c !== 'BTR' && m.c !== 'Airdrop' ? otherFloor(m.cx, m.cy, m.cz) : 0;
    const away = apart !== 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = away && !strong ? 0.6 : 1;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, r * 0.22);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = col;
    ctx.beginPath();
    const brain = kind.shape === 'arrow' && hasDetails(m) ? brainOf(m) : null;
    if (brain && brain.ghost) {
      // parked by ORBIT: a ghost, not an arrow (it has no body to face any way)
      ctx.globalAlpha *= 0.8;
      ctx.moveTo(-r * 0.8, r * 0.95);
      ctx.lineTo(-r * 0.8, -r * 0.15);
      ctx.arc(0, -r * 0.15, r * 0.8, Math.PI, 0);
      ctx.lineTo(r * 0.8, r * 0.95);
      ctx.lineTo(r * 0.4, r * 0.6);
      ctx.lineTo(0, r * 0.95);
      ctx.lineTo(-r * 0.4, r * 0.6);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(-r * 0.3, -r * 0.2, r * 0.17, 0, Math.PI * 2);
      ctx.arc(r * 0.3, -r * 0.2, r * 0.17, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind.shape === 'arrow') {
      // in a fight (SAIN deciding for it): a red ring round it
      if (brain && brain.fight) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.55, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.5, r * 0.2);
        ctx.strokeStyle = '#ff3b30';
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
      }

      // headings are from the game's north, which the map may have turned
      ctx.rotate(((m.cr || 0) - turn) * RAD);
      ctx.moveTo(0, -r * 1.25);
      ctx.lineTo(r * 0.85, r * 0.9);
      ctx.lineTo(0, r * 0.4);
      ctx.lineTo(-r * 0.85, r * 0.9);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    } else if (kind.shape === 'cross') {
      ctx.lineCap = 'round';
      ctx.moveTo(-r * 0.7, -r * 0.7); ctx.lineTo(r * 0.7, r * 0.7);
      ctx.moveTo(r * 0.7, -r * 0.7); ctx.lineTo(-r * 0.7, r * 0.7);
      ctx.lineWidth = r * 0.7;
      ctx.stroke();
      ctx.lineWidth = r * 0.36;
      ctx.strokeStyle = col;
      ctx.stroke();
    } else if (kind.shape === 'btr') {
      // from above: an armoured hull on eight wheels, its turret and gun pointing the way it drives; true to its
      // size once zoomed in, never smaller than a marker
      ctx.rotate(((m.cr || 0) - turn) * RAD);
      const len = Math.max(r * 3.2, 7.6 * zoom), wide = len * 0.38;
      ctx.fillStyle = '#111';
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const y = -len * 0.36 + k * len * 0.22;
          ctx.fillRect(side * wide / 2 - (side > 0 ? 0 : wide * 0.16), y, wide * 0.16, len * 0.13);
        }
      }
      ctx.beginPath();
      ctx.moveTo(0, -len / 2);
      ctx.lineTo(wide / 2, -len * 0.34);
      ctx.lineTo(wide / 2, len / 2);
      ctx.lineTo(-wide / 2, len / 2);
      ctx.lineTo(-wide / 2, -len * 0.34);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -len * 0.05);
      ctx.lineTo(0, -len * 0.62);
      ctx.lineWidth = Math.max(2, wide * 0.1);
      ctx.strokeStyle = '#111';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -len * 0.05, wide * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#6f8a3c';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.stroke();
    } else if (kind.shape === 'drop') {
      // a crate with its straps; under a parachute while it's coming down
      if (m.fall) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, -r * 1.5, r * 1.1, Math.PI, 0);
        ctx.closePath();
        ctx.moveTo(-r * 1.1, -r * 1.5); ctx.lineTo(-r * 0.6, -r * 0.7);
        ctx.moveTo(r * 1.1, -r * 1.5); ctx.lineTo(r * 0.6, -r * 0.7);
        ctx.fillStyle = '#f2f3f4';
        ctx.stroke();
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
      }
      ctx.rect(-r * 0.8, -r * 0.7, r * 1.6, r * 1.4);
      ctx.stroke();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, 0); ctx.lineTo(r * 0.8, 0);
      ctx.moveTo(0, -r * 0.7); ctx.lineTo(0, r * 0.7);
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.stroke();
    } else if (kind.shape === 'exit') {
      ctx.rotate(45 * RAD);
      ctx.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
      ctx.stroke();
      ctx.fill();
    } else {
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }
    ctx.restore();

    // the health bar: under the marker, over its name (above it, the rings round the marker cover it)
    let under = 0;
    if (prefs.health && Array.isArray(m.hp) && m.hp[1] > 0 && kind.shape === 'arrow' && (strong || prefs.healthAll || m.hp[0] < m.hp[1] * 0.98)) {
      const part = Math.max(0, Math.min(1, m.hp[0] / m.hp[1])), wide = r * 2.4, high = Math.max(3, 3 * scale), top = y + r * 1.3;
      under = high + 4;
      ctx.save();
      ctx.globalAlpha = away && !strong ? 0.6 : 1;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x - wide / 2 - 1, top - 1, wide + 2, high + 2);
      ctx.fillStyle = part > 0.6 ? '#4cd964' : part > 0.3 ? '#ffb13d' : '#ff5148';
      ctx.fillRect(x - wide / 2, top, wide * part, high);
      ctx.restore();
    }
    if (away) write(apart > 0 ? '▲' : '▼', 9 * scale, x + r * 1.5, y - r * 0.9, col, strong ? 1 : 0.6);
    const person = m.c === 'Enemy Player' || m.c === 'Friendly Player';
    const named = kind.label || strong || (prefs.names === 'players' && person)
      || (m.c === 'Main Player' && (prefs.myName || live.some(o => o.c === 'Friendly Player')))
      || (prefs.names === 'all' && m.c !== 'Corpse' && m.c !== 'Main Player' && m.c !== 'Extract');
    if (named && m.t) label(markerText(m), 12 * scale, x, y + r * 1.35 + under, y - r * 1.35, col, away && !strong ? 0.6 : 1);
    // what it's doing, under its name ("What each bot is doing"): as a mod has it, not the game's own brain
    if (prefs.mapDoing && brain && !inArea(m)) {
      const said = brain.ghost ? m.ob || '' : brain.by === 'EFT' ? '' : brain.text;
      if (said) write(said.length > 30 ? said.slice(0, 29) + '…' : said, 9.5 * scale, x, y + r * 1.35 + under + (named && m.t ? 14 * scale : 0),
        brain.ghost ? '#c2c5ca' : DOING_COL[brain.by] || '#dadcdf', away && !strong ? 0.55 : 0.95);
    }
    drawn.push({ m, x, y, w: r * 2.6, h: r * 2.6 });
  }

  // slanting stripes in a colour, to fill a shape with
  const stripes = {};
  // A minefield's mines, as small red crosses strewn over where it kills. Each cross has its own spot on the ground
  // (a grid of metres, nudged a little by where it is) and its own size in metres, so the same crosses stay put and
  // grow with the map as it zooms in (up to a point). Zoomed out they'd be a noisy speckle, so they fade in only once
  // they're big enough to read; until then the field is a plain red.
  function drawMines(g, area, kill, trace) {
    if (!area.box) {
      const all = kill.flat();
      area.box = all.length ? [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])),
        Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))] : null;
    }
    const box = area.box;
    if (!box) return;
    // half a cross, in pixels: 0.9 m on the ground
    const arm = Math.min(12, zoom * 0.9);
    const fade = Math.min(1, Math.max(0, (arm - 3) / 3));
    if (fade <= 0) return;
    let gap = 7;
    while ((box[2] - box[0]) / gap * ((box[3] - box[1]) / gap) > 5000) gap *= 2;
    const nudge = (x, y, k) => {
      const v = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453;
      return (v - Math.floor(v) - 0.5) * 2.4;
    };
    g.save();
    g.globalAlpha = fade;
    trace(kill);
    g.clip('nonzero');
    g.beginPath();
    for (let gx = Math.floor(box[0] / gap) * gap; gx <= box[2]; gx += gap) {
      for (let gy = Math.floor(box[1] / gap) * gap; gy <= box[3]; gy += gap) {
        const s = toScreen(gx + nudge(gx, gy, 1), gy + nudge(gx, gy, 2));
        if (s[0] < -arm || s[1] < -arm || s[0] > vw + arm || s[1] > vh + arm) continue;
        g.moveTo(s[0] - arm, s[1] - arm); g.lineTo(s[0] + arm, s[1] + arm);
        g.moveTo(s[0] + arm, s[1] - arm); g.lineTo(s[0] - arm, s[1] + arm);
      }
    }
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(20,0,0,0.7)';
    g.lineWidth = arm * 0.32 + 1.5;
    g.stroke();
    g.strokeStyle = '#ff5a4e';
    g.lineWidth = arm * 0.32;
    g.stroke();
    g.restore();
  }
  // Stripes laid on the ground, so they zoom with the map instead of sliding over it: a whole number of metres apart
  // (doubled or halved as the map zooms, so they stay 10 to 20 pixels apart), from a spot on the ground.
  function groundStripes(pattern, pin) {
    if (!pattern.setTransform) return;
    const metres = Math.pow(2, Math.ceil(Math.log2(10 / zoom)));
    const k = metres * zoom / 12;
    pattern.setTransform(new DOMMatrix([k, 0, 0, k, pin[0], pin[1]]));
  }
  function striped(col) {
    if (!stripes[col]) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 12;
      const t = tile.getContext('2d');
      t.strokeStyle = col;
      t.lineWidth = 3;
      t.beginPath();
      for (const shift of [-12, 0, 12]) { t.moveTo(shift - 2, 14); t.lineTo(shift + 14, -2); }
      t.stroke();
      stripes[col] = ctx.createPattern(tile, 'repeat');
    }
    return stripes[col];
  }

  // Each field of claymores as one danger area: the ground within reach of any of its mines, striped red with a rim,
  // named in the middle. Drawn first, on the empty canvas (the rim is cut out of it).
  function drawMineFields(scale, edge) {
    const look = ZONES.mine;
    const reach = Math.max(3, MINE_REACH * zoom);
    const rim = Math.min(3, Math.max(1.5, 0.5 * zoom));
    const circles = (field, r) => {
      ctx.beginPath();
      for (const p of field.mines) {
        const s = toScreen(p[0], p[1]);
        ctx.moveTo(s[0] + r, s[1]);
        ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      }
    };
    for (const field of map.fields) {
      const mid = toScreen(field.x, field.y);
      const far = reach + MINE_TOGETHER * field.mines.length * zoom;
      if (mid[0] < -far || mid[1] < -far || mid[0] > vw + far || mid[1] > vh + far) continue;
      // the rim: the area a little wider, with the area itself cut out of it
      circles(field, reach + rim);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = look.col;
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      circles(field, reach);
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // the area: a red tint under red stripes that lie still on the ground
      ctx.globalAlpha = 0.22;
      ctx.fill();
      const pattern = striped(look.col);
      groundStripes(pattern, mid);
      ctx.fillStyle = pattern;
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      // each mine, once close enough to tell them apart
      if (zoom > 2.5) {
        ctx.fillStyle = '#000';
        for (const p of field.mines) {
          const s = toScreen(p[0], p[1]);
          ctx.beginPath();
          ctx.arc(s[0], s[1], Math.max(2, 0.35 * zoom), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const px = 11 * scale;
      if (mid[0] > edge.left && mid[0] < edge.right && mid[1] > edge.top && mid[1] < edge.bottom) {
        write(look.label, px, mid[0], mid[1] - px * 0.55, look.col, 0.95);
      }
    }
  }

  // Minefields and sniper zones, each area of overlapping zones as one: the whole of it, where the game warns, faint
  // with a dashed rim; the part where it kills stronger, with a rim of its own. Drawn on a canvas of their own, so
  // the lines inside an area (where its zones overlap) can be cut out and only its outline is left.
  let zoneCanvas = null;
  function drawZones(scale) {
    const ratio = pixelRatio();
    if (!zoneCanvas) zoneCanvas = document.createElement('canvas');
    if (zoneCanvas.width !== canvas.width || zoneCanvas.height !== canvas.height) {
      zoneCanvas.width = canvas.width;
      zoneCanvas.height = canvas.height;
    }
    const g = zoneCanvas.getContext('2d');
    const trace = loops => {
      g.beginPath();
      for (const loop of loops) {
        loop.forEach((p, i) => {
          const s = toScreen(p[0], p[1]);
          if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]);
        });
        g.closePath();
      }
    };
    // a rim round the outside of a path only: stroked, then everything inside the path taken away again
    const rim = (col, width, dash) => {
      g.globalCompositeOperation = 'source-over';
      g.setLineDash(dash || []);
      g.strokeStyle = col;
      g.lineWidth = width * 2;
      g.globalAlpha = 0.95;
      g.stroke();
      g.setLineDash([]);
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = 1;
      g.fill('nonzero');
      g.globalCompositeOperation = 'source-over';
    };

    ctx.save();
    // nothing of a zone is drawn past the picture's edge
    const edge = mapBox();
    ctx.beginPath();
    ctx.rect(edge.left, edge.top, edge.right - edge.left, edge.bottom - edge.top);
    ctx.clip();
    ctx.lineJoin = 'round';
    if (!isHidden('Zone mine')) drawMineFields(scale, edge);
    const px = 11 * scale;
    for (const area of map.zones) {
      const look = ZONES[area.k];
      if (!look || isHidden('Zone ' + area.k)) continue;
      // only what's on the screen
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const z of area.zones) {
        for (const p of z.p) {
          const s = toScreen(p[0], p[1]);
          left = Math.min(left, s[0]); right = Math.max(right, s[0]);
          top = Math.min(top, s[1]); bottom = Math.max(bottom, s[1]);
        }
      }
      if (right < 0 || bottom < 0 || left > vw || top > vh) continue;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, vw, vh);
      g.lineJoin = 'round';
      // a sniper the flare at an extract keeps quiet: lighter, its rim thinner (solid: dashes crawl as the map zooms)
      const soft = area.flare;
      // the whole zone: a sniper who has started on you fires anywhere in it; a mine only goes off where it kills
      const kill = area.zones.flatMap(z => z.kill);
      if (area.k === 'mine' && !kill.length) continue;
      if (area.k !== 'mine') {
        trace(area.zones.map(z => z.p));
        rim(look.col, 1, null);
        g.fillStyle = look.col;
        g.globalAlpha = soft ? 0.05 : 0.08;
        g.fill('nonzero');
        g.globalAlpha = 1;
      }
      trace(kill);
      rim(look.col, soft ? 1.2 : 1.6, null);
      if (look.hatch) {
        // the stripes lie still on the ground as the map moves
        const pin = toScreen(area.x, area.y);
        const pattern = striped(look.col, g);
        groundStripes(pattern, pin);
        g.fillStyle = pattern;
        g.globalAlpha = soft ? 0.3 : 0.55;
      } else {
        g.fillStyle = look.col;
        g.globalAlpha = 0.22;
      }
      g.fill('nonzero');
      g.globalAlpha = 1;
      // its name: in the middle of where it kills, or the nearest spot to that inside it (an area of zones that
      // overlap can have its middle outside all of them)
      let mid = toScreen(area.x, area.y);
      if (kill.length) {
        trace(kill);
        const inside = (x, y) => g.isPointInPath(x * ratio, y * ratio, 'nonzero');
        if (!inside(mid[0], mid[1])) {
          let best = null;
          for (let r = 12; r <= 400 && !best; r += 12) {
            for (let a = 0; a < 16 && !best; a++) {
              const x = mid[0] + r * Math.cos(a * Math.PI / 8), y = mid[1] + r * Math.sin(a * Math.PI / 8);
              if (!inside(x, y)) continue;
              // on along the same way to the field's far side, and the label halfway across
              let far = r;
              while (far < r + 300 && inside(mid[0] + (far + 6) * Math.cos(a * Math.PI / 8), mid[1] + (far + 6) * Math.sin(a * Math.PI / 8))) far += 6;
              const half = (r + far) / 2;
              best = [mid[0] + half * Math.cos(a * Math.PI / 8), mid[1] + half * Math.sin(a * Math.PI / 8)];
            }
          }
          if (best) mid = best;
        }
      }
      if (area.k === 'mine') drawMines(g, area, kill, trace);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(zoneCanvas, 0, 0);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (mid[0] > edge.left && mid[0] < edge.right && mid[1] > edge.top && mid[1] < edge.bottom) {
        write(look.label + (soft ? ' · ' + T('flare') : ''), px, mid[0], mid[1] - px * 0.55, look.col, 0.95);
      }
    }
    ctx.restore();
  }

  // the scale, bottom left: a round number of metres and a bar as long as they are on the screen now
  let scalePrint = '';
  function showScale() {
    const bar = $('scaleBar');
    const want = map && zoom > 0 ? 120 / zoom : 0;
    let print = '';
    if (want > 0) {
      const pow = Math.pow(10, Math.floor(Math.log10(want)));
      const nice = [5, 2, 1].map(k => k * pow).find(v => v <= want) || pow;
      print = nice + ':' + Math.round(nice * zoom);
    }
    if (print === scalePrint) return;
    scalePrint = print;
    bar.hidden = !print;
    if (!print) return;
    const [nice, px] = print.split(':').map(Number);
    bar.style.width = px + 'px';
    bar.textContent = nice >= 1000 ? nice / 1000 + ' km' : nice + ' m';
  }

  // Who matters and is off the screen: an arrow at the edge of what can be seen of the map (clear of the bar, the
  // menu and the Raid list) points to each, in its kind's colour, with how far it is from the player. It can be
  // pointed at and pressed like the marker itself.
  const EDGE = ['Enemy Player', 'Friendly Player', 'Boss', 'Goon', 'Airdrop'];
  function seen() {
    const open = el => !phone.matches && !el.hidden ? el.offsetWidth + 8 : 0;
    const menu = open($('panel')), list = open($('side'));
    const bare = document.body.classList.contains('bare');
    const l = bare ? 0 : prefs.swap ? menu : list, r = bare ? 0 : phone.matches ? cover.r : prefs.swap ? list : menu;
    return { l: l + 8, t: bare ? 8 : 50, r: vw - r - 8, b: vh - (phone.matches ? cover.b : 0) - 8 };
  }
  // Where COMET sends the bots of a squad acting together: a dashed line from each to its place, amber once it's
  // doing it and pale while it only means to. Faint for all that are doing it; plain, and with the ones still
  // preparing, for the squad of whoever is pointed at, followed, or under the pointer in the Raid list.
  // ---- rough areas ----
  // Between showing where a PMC is and not showing them at all ("Rough area, not the exact place", under Enemy PMCs):
  // no marker, name, pointer or line; only a circle AREA_R metres across its middle that the PMC is somewhere in.
  // The circle's middle is not the PMC (it's put off to one side at random) and stays put until they near its edge,
  // so it can't be followed to them. It shows only for one that has been moving: it fades over AREA_FADE once they
  // stop, so somebody sitting still isn't given away. (The page still gets where they are; it only doesn't draw it.)
  const AREA_STEP = 4, AREA_FADE = 30000;
  const areas = new Map();
  // ---- bodies come across ----
  // A body the player has been right by (to look at it, or to loot it) is known to be dead, like one a player killed:
  // its ✕ is shown without "All corpses", and the Raid list says Dead of it while it hides who's alive. Kept for the
  // raid, in this browser tab. (Only while a page is open: a body passed with no page open isn't noticed.)
  const BODY_NEAR = 7;
  // ---- under the ground ----
  // The map's "buildings" are every roofed place, bunkers and tunnels under the ground among them, and nothing says
  // which is which. One is taken to be under the ground when things known to be in the open lie well over its top,
  // within its walls: spawn points, containers, extracts, where loot can spawn (two or more of them), or anybody
  // seen walking there this visit.
  const UNDER_BY = 1.5;
  const topOf = b => b.top === undefined ? (b.top = Math.max(...b.parts.map(p => p.t))) : b.top;
  const overIt = (b, x, y, z) => Number.isFinite(z) && z > topOf(b) + UNDER_BY && inBox(b.box, x, y) && inLoops(b.l, x, y);
  function underOf(b) {
    const shown = places && map && places.loc === map.loc ? places : null, table = lootTable && map && lootTable.loc === map.loc ? lootTable : null;
    const key = (shown ? 1 : 0) + ':' + (table ? table.points.length : 0);
    if (b.underKey !== key) {
      b.underKey = key;
      let n = 0;
      if (shown) for (const list of [shown.spawns, shown.boxes, shown.exits]) for (const o of list || []) if (Array.isArray(o.p) && overIt(b, o.p[0], o.p[1], o.p[2])) n++;
      if (table) for (const pt of table.points) if (overIt(b, pt.x, pt.y, pt.z)) n++;
      b.underSaid = n >= 2;
    }
    return b.underSaid || !!b.underSeen;
  }
  function trackUnder() {
    const list = map && map.floors && map.floors.buildings;
    if (!list || !inRaidHere()) return;
    for (const m of live) {
      if (m.c === 'Corpse' || !Array.isArray(m.p) || (KINDS[m.c] || OTHER).shape !== 'arrow') continue;
      for (const b of list) if (!b.underSeen && overIt(b, m.p[0], m.p[1], m.p[2])) { b.underSeen = true; dirty = true; }
    }
  }
  let seenBodies = new Set(), seenBodiesFor = null;
  const bodyKey = m => m.pid || (m.body && m.body.pid) || String(m.id);
  const bodySeen = m => prefs.seenDead !== false && seenBodies.has(bodyKey(m));
  function trackBodies() {
    if (!me || !inRaidHere()) return;
    const rid = report.rid || '';
    if (rid !== seenBodiesFor) {
      seenBodiesFor = rid;
      seenBodies = new Set();
      try { seenBodies = new Set(JSON.parse(sessionStorage.getItem('fumsBodies:' + rid) || '[]')); } catch (e) { /* none kept */ }
    }
    let added = false;
    const look = (key, p) => {
      if (!key || seenBodies.has(key) || !Array.isArray(p)) return;
      if (Math.hypot(p[0] - me.cx, p[1] - me.cy) > BODY_NEAR || Math.abs((p[2] || 0) - (me.cz || 0)) > 3.5) return;
      seenBodies.add(key);
      added = true;
    };
    for (const m of live) if (m.c === 'Corpse') look(bodyKey(m), m.p);
    if (things && Array.isArray(things.bodies)) for (const b of things.bodies) look(b.pid || 'body:' + b.id, b.p);
    if (!added) return;
    try { sessionStorage.setItem('fumsBodies:' + rid, JSON.stringify([...seenBodies])); } catch (e) { /* private window */ }
    rosterPrint = null;
    dirty = true;
  }
  const inArea = m => prefs.areaKinds.includes(m.c);
  function trackAreas(now) {
    const seen = new Set(), AREA_R = prefs.areaR;
    for (const m of live) {
      if (!inArea(m) || m.gh) continue;
      seen.add(m.id);
      let a = areas.get(m.id);
      if (!a) areas.set(m.id, a = { x: null, y: 0, lx: m.p[0], ly: m.p[1], moved: -1e9 });
      a.c = m.c;
      if (Math.hypot(m.p[0] - a.lx, m.p[1] - a.ly) > AREA_STEP) { a.lx = m.p[0]; a.ly = m.p[1]; a.moved = now; }
      // Never on it: the circle is put somewhere round it, and stays put while it moves about inside, until it's three
      // quarters of the way out. Where in the circle it is is even all over (the square root: as likely near the rim
      // as near the middle), so the middle doesn't give it away.
      if (a.x === null || Math.hypot(m.p[0] - a.x, m.p[1] - a.y) > AREA_R * 0.75) {
        const turn = Math.random() * Math.PI * 2, off = Math.sqrt(Math.random()) * AREA_R * 0.7;
        a.x = m.p[0] + Math.cos(turn) * off;
        a.y = m.p[1] + Math.sin(turn) * off;
      }
    }
    for (const id of areas.keys()) if (!seen.has(id)) areas.delete(id);
  }
  function drawAreas(scale) {
    if (!prefs.areaKinds.length) return;
    const now = performance.now(), AREA_R = prefs.areaR;
    for (const a of areas.values()) {
      const age = now - a.moved;
      if (a.x === null || age >= AREA_FADE || !prefs.areaKinds.includes(a.c) || isHidden(a.c)) continue;
      const col = (KINDS[a.c] || OTHER).col;
      const s = toScreen(a.x, a.y), r = AREA_R * zoom;
      if (s[0] < -r || s[1] < -r || s[0] > vw + r || s[1] > vh + r) continue;
      const strength = Math.min(1, 1.25 - age / AREA_FADE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.globalAlpha = strength * 0.13;
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = strength;
      ctx.setLineDash([8 * scale, 6 * scale]);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.restore();
      write(T('{kind} about', { kind: ONE[a.c] || a.c }), 11 * scale, s[0], s[1] - 6 * scale, col, strength * 0.9);
      dirty = dirty || age > AREA_FADE * 0.25;
    }
  }

  // Where ORBIT has a bot heading ("og" on its marker): a thin blue line to the place, and a circle there. For the
  // one pointed at, followed or under the pointer in the Raid list; for every bot with "Lines to where all are heading".
  function drawHeadings(scale) {
    drawGhostEvents(scale);
    const focus = [pointed, rosterOver, chased];
    for (const m of live) {
      if (!(m.os ? prefs.botDetails : modOn('ORBIT'))) continue;
      if (!Array.isArray(m.og) || m.c === 'Corpse' || inArea(m) || isHidden(m.c || 'None') || !Number.isFinite(m.cx)) continue;
      const strong = focus.includes(m.id);
      if (!strong && !prefs.orbitLines) continue;
      const a = toScreen(m.cx, m.cy), b = toScreen(m.og[0], m.og[1]);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 14 * scale) continue;
      const r = Math.max(5 * scale, 4 * zoom);
      ctx.save();
      ctx.globalAlpha = strong ? 1 : 0.5;
      ctx.lineCap = 'round';
      ctx.setLineDash([2 * scale, 6 * scale]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineWidth = strong ? 4 : 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = strong ? 2 : 1.3;
      ctx.strokeStyle = '#6fbcff';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(b[0], b[1], r, 0, Math.PI * 2);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#6fbcff';
      ctx.stroke();
      ctx.fillStyle = 'rgba(111, 188, 255, 0.18)';
      ctx.fill();
      ctx.restore();
      if ((strong || prefs.orbitNames) && m.ob) write(m.ob, 10 * scale, b[0], b[1] + r + 3 * scale, '#9fd8ff', strong ? 0.95 : 0.7);
    }
  }

  // ---- shots ----
  // Each bullet ("sh" on a report: [the shooter's marker, east, north, east, north]): a thin line from the gun to
  // where it went, for SHOT_MS, in the shooter's colour.
  const SHOT_MS = 900;
  let tracers = [];
  function takeShots(list, now) {
    if (!Array.isArray(list) || !prefs.shots) return;
    for (const s of list) if (Array.isArray(s) && s.length >= 5) tracers.push({ who: s[0], a: [s[1], s[2]], b: [s[3], s[4]], at: now });
    if (tracers.length > 400) tracers.splice(0, tracers.length - 400);
    dirty = true;
  }
  function drawShots() {
    if (!tracers.length) return;
    const now = performance.now();
    tracers = tracers.filter(t => now - t.at < SHOT_MS);
    if (!prefs.shots) { tracers = []; return; }
    ctx.save();
    ctx.lineCap = 'round';
    for (const t of tracers) {
      const m = t.who ? liveById.get(t.who) : null;
      if (m && (isHidden(m.c || 'None') || inArea(m))) continue;
      const a = toScreen(t.a[0], t.a[1]), b = toScreen(t.b[0], t.b[1]);
      ctx.globalAlpha = 0.85 * (1 - (now - t.at) / SHOT_MS);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = m ? (KINDS[m.c] || OTHER).col : '#ffe9a8';
      ctx.stroke();
    }
    ctx.restore();
    if (tracers.length) dirty = true;
  }
  // ---- the airdrop's plane ----
  // "plane" on a full report: where it is, its heading and the way it has come. Shown with the airdrops.
  let plane = null, planeV = null, planeAt = 0;
  function drawPlane(scale) {
    if (!plane || !Array.isArray(plane.p) || isHidden('Airdrop')) return;
    const path = plane.path || [];
    // where it is by now: on from where it was last told to be, at the speed it had, for a second and a half at most
    const flown = Math.min(1.5, (performance.now() - planeAt) / 1000);
    const pos = planeV ? [plane.p[0] + planeV[0] * flown, plane.p[1] + planeV[1] * flown] : plane.p;
    dirty = true;
    ctx.save();
    ctx.lineJoin = 'round';
    if (path.length >= 4) {
      ctx.beginPath();
      for (let k = 0; k + 1 < path.length; k += 2) {
        const s = toScreen(path[k], path[k + 1]);
        if (k) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      }
      const end = toScreen(pos[0], pos[1]);
      ctx.lineTo(end[0], end[1]);
      ctx.setLineDash([10 * scale, 7 * scale]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#f2f3f4';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const at = toScreen(pos[0], pos[1]), r = 11 * scale;
    ctx.translate(at[0], at[1]);
    ctx.rotate(((plane.r || 0) - turn) * RAD);
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.3);
    ctx.lineTo(r * 0.28, -r * 0.3);
    ctx.lineTo(r * 1.25, r * 0.35);
    ctx.lineTo(r * 0.28, r * 0.25);
    ctx.lineTo(r * 0.2, r * 0.95);
    ctx.lineTo(r * 0.6, r * 1.3);
    ctx.lineTo(-r * 0.6, r * 1.3);
    ctx.lineTo(-r * 0.2, r * 0.95);
    ctx.lineTo(-r * 0.28, r * 0.25);
    ctx.lineTo(-r * 1.25, r * 0.35);
    ctx.lineTo(-r * 0.28, -r * 0.3);
    ctx.closePath();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fillStyle = '#f2f3f4';
    ctx.fill();
    ctx.restore();
    write(T('Airdrop plane'), 10 * scale, at[0], at[1] + r * 1.6, '#f2f3f4', 0.95);
  }
  // ---- what ORBIT's ghosts do ----
  // A fight ORBIT worked out between ghosts: crossed marks where it was, for FIGHT_MS. What a ghost heard: a ring
  // as wide as it hears, round where it was, and a line to the noise, for HEAR_MS.
  const FIGHT_MS = 30000, HEAR_MS = 5000;
  let ghostMarks = [];
  function drawGhostEvents(scale) {
    if (!ghostMarks.length) return;
    const now = performance.now();
    ghostMarks = ghostMarks.filter(g => now < g.until);
    if (!modOn('ORBIT')) return;
    for (const g of ghostMarks) {
      // each has its switch: the fights, and the (big) circles of what a ghost could hear
      if (g.k === 'fight' ? prefs.orbitFights === false : !prefs.orbitHear) continue;
      const left = Math.min(1, (g.until - now) / 1500);
      ctx.save();
      ctx.globalAlpha = left;
      if (g.k === 'fight') {
        const a = toScreen(g.a[0], g.a[1]), b = toScreen(g.b[0], g.b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, r = 9 * scale;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.setLineDash([3 * scale, 5 * scale]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ff8d84';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(214, 58, 50, 0.85)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.restore();
        write('⚔', 12 * scale, mx, my - 7 * scale, '#fff', left);
        write(T('Ghost fight') + (g.n ? ' · ' + T('{n} dead', { n: g.n }) : ''), 10 * scale, mx, my + r + 2 * scale, '#ff8d84', left);
        continue;
      }
      const l = toScreen(g.l[0], g.l[1]), s = toScreen(g.s[0], g.s[1]);
      ctx.beginPath();
      ctx.arc(l[0], l[1], Math.max(6 * scale, g.r * zoom), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(111, 188, 255, 0.06)';
      ctx.fill();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(111, 188, 255, 0.8)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(l[0], l[1]);
      ctx.lineTo(s[0], s[1]);
      ctx.setLineDash([2 * scale, 5 * scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 3.5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe9a8';
      ctx.fill();
      ctx.restore();
      write(T('Heard shots'), 9 * scale, l[0], l[1] + 7 * scale, '#9fd8ff', left * 0.9);
    }
    dirty = true;
  }

  function drawSquads(scale) {
    if (!modOn('COMET')) return;
    const focus = new Set();
    for (const id of [pointed, rosterOver, chased]) {
      const m = id !== null && id !== undefined ? liveById.get(id) : null;
      if (m && m.sq) focus.add(squadKey(m));
    }
    for (const m of live) {
      const q = m.sq;
      if (!q || !Array.isArray(q.g) || m.gh || m.c === 'Corpse' || inArea(m) || isHidden(m.c || 'None') || !Number.isFinite(m.cx)) continue;
      const strong = focus.has(squadKey(m));
      if (!strong && !q.a) continue;
      const a = toScreen(m.cx, m.cy), b = toScreen(q.g[0], q.g[1]);
      const r = (strong ? 5 : 4) * scale;
      ctx.save();
      ctx.globalAlpha = strong ? 1 : 0.6;
      ctx.lineCap = 'round';
      ctx.setLineDash([6 * scale, 5 * scale]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineWidth = strong ? 4.5 : 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.lineWidth = strong ? 2 : 1.5;
      ctx.strokeStyle = q.a ? '#ffb13d' : '#ffe2a8';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(b[0], b[1] - r);
      ctx.lineTo(b[0] + r, b[1]);
      ctx.lineTo(b[0], b[1] + r);
      ctx.lineTo(b[0] - r, b[1]);
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      ctx.fillStyle = q.a ? '#ffb13d' : '#ffe2a8';
      ctx.fill();
      ctx.restore();
      // its part in it, at the place it's sent to
      if (strong && prefs.squadParts) label(squadPart(q), 11 * scale, b[0], b[1] + r + 3, b[1] - r - 3, q.a ? '#ffb13d' : '#ffe2a8');
    }
  }

  function drawEdge(scale) {
    const box = seen();
    if (box.r - box.l < 120 || box.b - box.t < 120) return;
    const pad = 16 * scale;
    const cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2;
    const hw = (box.r - box.l) / 2 - pad, hh = (box.b - box.t) / 2 - pad;
    // The player's quests: off the screen, the quest's own sign at the edge (a yellow star in a round badge, not an
    // arrow, so it isn't taken for a player), with a small tip on the edge's side showing which way.
    if (prefs.edgeQuests && inRaidHere()) {
      const col = LAYERS.quest.col, r = 7.5 * scale;
      for (const q of questOff) {
        const at = toScreen(q.p[0], q.p[1]);
        if (at[0] >= box.l && at[0] <= box.r && at[1] >= box.t && at[1] <= box.b) continue;
        const dx = at[0] - cx, dy = at[1] - cy;
        const k = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
        const x = cx + dx * k, y = cy + dy * k, turn = Math.atan2(dy, dx);
        ctx.save();
        ctx.translate(x, y);
        ctx.lineJoin = 'round';
        // the tip, pointing out past the edge
        ctx.save();
        ctx.rotate(turn);
        ctx.beginPath();
        ctx.moveTo(r * 1.75, 0);
        ctx.lineTo(r * 0.7, -r * 0.62);
        ctx.lineTo(r * 0.7, r * 0.62);
        ctx.closePath();
        ctx.lineWidth = Math.max(2, r * 0.3);
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.restore();
        // the badge, with the star in it
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = '#14151b';
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, r * 0.26);
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.font = 'bold ' + Math.round(r * 1.3) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', 0, r * 0.06);
        ctx.restore();
        const far = me ? Math.hypot(q.p[0] - me.cx, q.p[1] - me.cy) : NaN;
        if (Number.isFinite(far)) {
          // on the inner side, clear of the badge however long the number is
          const said = far >= 1000 ? (far / 1000).toFixed(1) + ' km' : Math.round(far) + ' m', px = 10 * scale;
          ctx.font = 'bold ' + px * prefs.textScale + 'px ' + FONT;
          const half = ctx.measureText(said).width / 2 + 4;
          const tx = x - Math.cos(turn) * (r * 1.4 + half), ty = y - Math.sin(turn) * (r * 1.4 + px * 0.9);
          write(said, px, tx, ty - px * 0.55, col, 1);
        }
        thingsDrawn.push({ x, y, r: r * 1.6, tip: { title: q.t, lines: [T('One of your quests, off the screen')] } });
      }
    }
    if (!prefs.edge) return;
    for (const m of live) {
      if (!EDGE.includes(m.c) && m.id !== chased) continue;
      if (m.c === 'Corpse' || m.c === 'Main Player' || inArea(m) || isHidden(m.c || 'None') || !Number.isFinite(m.cx)) continue;
      const at = toScreen(m.cx, m.cy);
      if (at[0] >= box.l && at[0] <= box.r && at[1] >= box.t && at[1] <= box.b) continue;
      // where the line from the middle of what's seen to it crosses the edge
      const dx = at[0] - cx, dy = at[1] - cy;
      const k = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
      const x = cx + dx * k, y = cy + dy * k, turn = Math.atan2(dy, dx);
      const kind = KINDS[m.c] || OTHER, r = 7 * scale * kind.size;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(turn);
      ctx.beginPath();
      ctx.moveTo(r * 1.35, 0);
      ctx.lineTo(-r * 0.75, -r * 0.95);
      ctx.lineTo(-r * 0.3, 0);
      ctx.lineTo(-r * 0.75, r * 0.95);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, r * 0.4);
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.fillStyle = m.id === chased ? '#5fd4ff' : kind.col;
      ctx.fill();
      ctx.restore();
      // how far, written on the arrow's inner side
      const far = farOf(m);
      if (Number.isFinite(far)) {
        const tx = x - Math.cos(turn) * r * 2.9, ty = y - Math.sin(turn) * r * 2.2;
        write(far >= 1000 ? (far / 1000).toFixed(1) + ' km' : Math.round(far) + ' m', 10 * scale, tx, ty - 5 * scale, kind.col, 1);
      }
      drawn.push({ m, x, y, w: r * 3.2, h: r * 3.2 });
    }
  }

  function draw() {
    const ratio = pixelRatio();
    if (canvas.width !== Math.round(vw * ratio) || canvas.height !== Math.round(vh * ratio)) {
      canvas.width = Math.round(vw * ratio);
      canvas.height = Math.round(vh * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    drawn = [];
    showScale();
    if (!map) return;
    const scale = prefs.scale;
    drawZones(scale);
    drawFloorEdge();
    drawHovered();
    drawThings(scale);
    // the spot just gone to: rings widening from it, a few times over
    if (flash) {
      const age = performance.now() - flash.at;
      if (age > 2400) flash = null;
      else {
        const s = toScreen(flash.x, flash.y);
        ctx.save();
        for (let k = 0; k < 2; k++) {
          const t = ((age / 800) + k * 0.5) % 1;
          ctx.globalAlpha = 1 - t;
          ctx.beginPath();
          ctx.arc(s[0], s[1], 8 + t * 40, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = LAYERS.quest.col;
          ctx.stroke();
        }
        ctx.restore();
        dirty = true;
      }
    }
    if (!inRaidHere()) return;
    let top = null;
    // the corpses first, under everyone: the ones a player killed, or every one when asked
    if (!isHidden('Corpse')) {
      for (const m of corpsesNow || live.filter(k => k.c === 'Corpse')) {
        if (!m.kp && !prefs.allCorpses && !bodySeen(m)) continue;
        if (pointed === m.id) { top = m; continue; }
        drawMarker(m, false, scale);
        if (m.ring) {
          const s = toScreen(m.cx, m.cy);
          ctx.beginPath();
          ctx.arc(s[0], s[1], 14 * scale, 0, Math.PI * 2);
          ctx.lineWidth = 4;
          ctx.strokeStyle = '#000';
          ctx.stroke();
          ctx.lineWidth = 2;
          ctx.strokeStyle = LAYERS.quest.col;
          ctx.stroke();
        }
      }
    }
    for (const m of live) {
      if (m.c === 'Corpse' || isHidden(m.c || 'None')) continue;
      // an extract that isn't there this raid (a car that never came), when only the ones to be had are wanted
      if (m.c === 'Extract' && !prefs.goneExits && m.st === 0) continue;
      if (inArea(m)) continue;
      if (pointed === m.id) { top = m; continue; }
      drawMarker(m, false, scale);
    }
    drawAreas(scale);
    drawShots();
    drawPlane(scale);
    drawHeadings(scale);
    drawSquads(scale);
    if (prefs.edge || prefs.edgeQuests) drawEdge(scale);
    // the one pointed at: bigger, named, over the others
    if (top) drawMarker(top, true, scale);
    // the one the pointer is over in the Raid list: ringed; and the one followed, in blue
    for (const id of chased !== null && chased !== rosterOver ? [rosterOver, chased] : [rosterOver]) {
      const over = id !== null ? liveById.get(id) : null;
      if (!over || !Number.isFinite(over.cx)) continue;
      const s = toScreen(over.cx, over.cy);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 17 * scale, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = id === chased ? '#5fd4ff' : '#fff';
      ctx.stroke();
    }
  }

  // ---- what the game says --------------------------------------------------------------------------------------
  const connected = () => performance.now() - heard < 4500 && !!report;
  const inRaid = () => connected() && !!report.raid;
  const inRaidHere = () => inRaid() && !!map && map.loc === shownLoc(report.loc);

  function take(message) {
    const now = performance.now();
    const d = message.d;
    if (!d || message.age > 5000) return;
    const known = sessions.get(message.sid) || {};
    known.heard = now;
    if (d.raid !== undefined) known.raid = d.raid;
    sessions.set(message.sid, known);
    if (prefs.player) {
      // a player was picked: theirs and nobody else's, whenever they play
      if (message.sid !== prefs.player.sid) return;
      if (sid !== message.sid) { forget(); sid = message.sid; }
      if (message.name && message.name !== prefs.player.name) { prefs.player.name = message.name; save(); }
    } else if (!sid || (sid !== message.sid && known.raid && !(sessions.get(sid) || {}).raid)) {
      // nobody picked: the first game heard from, or one that's in a raid when the one shown isn't
      forget();
      sid = message.sid;
    }
    // from here on only that game is listened to: the others then needn't report at all
    if (streamFor !== (prefs.player ? prefs.player.sid : sid)) listen();
    if (message.sid !== sid) return;
    heard = now;
    if (d.t === 'fast' || d.t === 'full') speedHeard(now);

    // what lies about in the raid changed: asked for
    if (d.t === 'things') {
      if (d.v !== thingsWanted) { thingsWanted = d.v; loadThings(); }
      return;
    }

    if (d.t === 'fast') {
      if (!report) return;
      // how often the game reports: things are moved from one report's place to the next's in that time
      if (now - told > 20 && now - told < 1000) period += (now - told - period) * 0.2;
      told = now;
      if (d.me) wantMe(d.me);
      takeShots(d.sh, now);
      for (const row of d.m || []) {
        const m = liveById.get(row[0]);
        if (m) { m.p[0] = row[1]; m.p[1] = row[2]; m.p[2] = row[3]; m.r = row[4]; m.fx = m.cx; m.fy = m.cy; m.t0 = now; }
      }
      return;
    }

    // "idle" is the game saying it's there before it knows a page is open: everything follows in a moment
    const was = report;
    report = d.t === 'idle' ? Object.assign({}, was && was.raid === d.raid ? was : {}, { raid: d.raid, loc: d.loc }) : d;
    if (d.t === 'full') {
      if (FAKE_TEAM && d.raid && Array.isArray(d.me)) d.markers = (d.markers || []).concat(fakeTeam(d.me, now));
      const before = liveById;
      liveById = new Map();
      live = (d.markers || []).map(m => {
        const old = before.get(m.id);
        // a marker that moves glides from where it was drawn
        const glide = old && m.dyn;
        m.cx = glide ? old.cx : m.p[0];
        m.cy = glide ? old.cy : m.p[1];
        m.cz = glide ? old.cz : m.p[2];
        m.cr = glide ? old.cr : m.r;
        m.fx = m.cx;
        m.fy = m.cy;
        m.t0 = now;
        if (m.t) { m.tn = m.t; m.t = latin(m.t); }
        trimBrains(m);
        liveById.set(m.id, m);
        return m;
      });
      const order = m => (KINDS[m.c] || OTHER).order;
      live.sort((a, b) => order(a) - order(b));
      if (d.me) wantMe(d.me); else me = null;
      takeEvents(d);
      takeShots(d.sh, now);
      // the plane is told of once a second: how fast it flies is worked out from the last two, and it's drawn on from
      // where it was told to be (see drawPlane), so it glides
      if (d.raid && d.plane && Array.isArray(d.plane.p)) {
        const since = (now - planeAt) / 1000;
        planeV = plane && Array.isArray(plane.p) && since > 0.2 && since < 4 ? [(d.plane.p[0] - plane.p[0]) / since, (d.plane.p[1] - plane.p[1]) / since] : planeV;
        plane = d.plane;
        planeAt = now;
      } else { plane = null; planeV = null; }
      trackAreas(now);
      trackBodies();
      trackUnder();
      // the kinds only a mod brings, for the mods this game has: remembered, so the switches are right out of a raid too
      if (Array.isArray(d.has) && d.has.join('|') !== (prefs.has || ['?']).join('|')) { prefs.has = d.has; save(); }
      if (Array.isArray(d.brains) && d.brains.join('|') !== (prefs.brains || ['?']).join('|')) { prefs.brains = d.brains; save(); nameBotDetails(); }
      if (!prefs.seenInfected && live.some(m => m.c === 'Infected')) { prefs.seenInfected = true; save(); }
      announce();
      remember();
      // a page opened in the middle of a raid: what lies about is there already
      if (d.raid && !things && performance.now() - thingsTriedAt > 5000) loadThings();
      if (!d.raid && things) things = null;
    }
    raidChanged();
    dirty = true;
  }

  // "The Goons have been spotted on the map": said once a raid for each kind asked for (each boss by name), whether
  // or not its markers are shown. Where they are isn't said.
  const ALERTS = ['Goon', 'Boss', 'Cultist', 'Black Division', 'RUAF', 'RUAF Remnant', 'Raider', 'Rogue', 'Enemy Player', 'Infected', 'Airdrop'];
  const spotted = new Set();
  let alertRaid = '';
  // a short two-note chime, made in the page (no sound file): only for alerts, and only when switched on
  let chimeAudio = null;
  function chime() {
    try {
      chimeAudio = chimeAudio || new (window.AudioContext || window.webkitAudioContext)();
      const now = chimeAudio.currentTime;
      for (const [freq, at] of [[880, 0], [1320, 0.14]]) {
        const osc = chimeAudio.createOscillator(), gain = chimeAudio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.32);
        osc.connect(gain).connect(chimeAudio.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.35);
      }
    } catch (e) { /* no sound here */ }
  }
  function announce() {
    const raid = report && report.raid ? sid + '|' + report.loc : '';
    if (raid !== alertRaid) { alertRaid = raid; spotted.clear(); }
    if (!raid) return;
    let rang = false;
    for (const m of live) {
      if (!prefs.alerts.includes(m.c) || !KINDS[m.c]) continue;
      const key = m.c === 'Boss' ? 'Boss:' + m.t : m.c === 'Airdrop' ? 'Airdrop:' + m.id : m.c;
      if (spotted.has(key)) continue;
      spotted.add(key);
      toast(m.c === 'Boss' && m.t ? T('{who} has been spotted on the map', { who: m.t })
        : m.c === 'Goon' ? T('The Goons have been spotted on the map')
        : m.c === 'Enemy Player' ? T('Enemy PMCs have been spotted on the map')
        : m.c === 'Airdrop' ? T('An airdrop is coming in')
        : T('{kind} have been spotted on the map', { kind: KINDS[m.c].name }), KINDS[m.c].col);
      rang = true;
    }
    if (rang && prefs.alertSound) chime();
  }
  // Everyone the Raid list could name, as first seen this raid: kept after they die or go, for "who was in the raid"
  // without saying who's still alive (prefs.rosterFog).
  const seenRoster = new Map();
  let seenRaid = '';
  function remember() {
    const raid = report && report.raid ? sid + '|' + report.loc + '|' + report.raid : '';
    if (raid !== seenRaid) { seenRaid = raid; seenRoster.clear(); }
    if (!raid) return;
    for (const m of live) {
      if (!ROSTER.includes(m.c) || seenRoster.has(m.id)) continue;
      seenRoster.set(m.id, { id: m.id, c: m.c, t: m.t, lv: m.lv, g: m.g, df: m.df, ps: m.ps, pid: m.pid });
    }
  }
  function toast(text, col) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'toast';
    item.style.borderColor = col;
    item.textContent = text;
    item.title = T('Press to dismiss');
    const gone = () => item.remove();
    item.onclick = gone;
    setTimeout(gone, 12000);
    $('toasts').appendChild(item);
    while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  }

  function wantMe(at) {
    if (!me) me = { cx: at[0], cy: at[1], cz: at[2] };
    me.x = at[0]; me.y = at[1]; me.z = at[2];
    me.fx = me.cx; me.fy = me.cy; me.t0 = performance.now();
    me.in = at.length > 4 ? !!at[4] : undefined;
  }
  // another game is shown from here on
  function forget() {
    report = null;
    live = [];
    liveById = new Map();
    me = null;
    raidKey = '';
    zoomState = null;
    things = null;
    thingsWanted = 0;
    thingsHave = -1;
    quests = null;
    questsFor = '';
    questsAskedAt = -1e9;
    squadEvents = [];
    otherEvents = [];
    killEvents = [];
    eventsSeen = new Set();
    eventsRaid = '';
  }

  // a raid began, ended or moved on, or its location's map arrived: show that map
  function raidChanged() {
    const there = report && report.raid ? mapFor(report.loc) : null;
    const key = there ? there.loc + '|' + there.v : '';
    if (key === raidKey) return;
    const began = !raidKey;
    raidKey = key;
    // a raid began or ended: the quests may have moved on
    loadQuests(true);
    if (!there) return;
    const same = there === map;
    showMap(there, false);
    zoomState = null;
    if (began || !same) {
      zoom = zoomTarget = zoomMin + Math.min(1, Math.max(0, prefs.zoom)) * (zoomMax - zoomMin);
      if (me) centreOn(me.x, me.y);
    }
  }

  // Whose game: "whoever is playing", or one player by name, remembered here and shown whenever they play.
  const gameName = g => g.name || T('Game') + ' …' + g.sid.slice(-4);
  function listGames() {
    const pick = $('session');
    const rows = games.map(g => ({ sid: g.sid, text: gameName(g) + (g.raid ? ' · ' + T('in raid') : '') }));
    if (prefs.player && !games.some(g => g.sid === prefs.player.sid)) {
      rows.push({ sid: prefs.player.sid, text: gameName(prefs.player) + ' · ' + T('not playing') });
    }
    pick.hidden = !rows.length;
    const wanted = prefs.player ? prefs.player.sid : '';
    const print = rows.map(r => r.sid + r.text).join('|');
    if (pick.dataset.print === print && pick.value === wanted) return;
    pick.dataset.print = print;
    pick.textContent = '';
    const anyone = document.createElement('option');
    anyone.value = '';
    anyone.textContent = T('Whoever is playing');
    pick.appendChild(anyone);
    for (const r of rows) {
      const o = document.createElement('option');
      o.value = r.sid;
      o.textContent = r.text;
      pick.appendChild(o);
    }
    pick.value = wanted;
  }
  async function askGames() {
    try {
      const answer = await (await fetch('api/games')).json();
      games = (answer.games || []).filter(g => g && typeof g.sid === 'string');
      const mine = prefs.player && games.find(g => g.sid === prefs.player.sid);
      if (mine && mine.name && mine.name !== prefs.player.name) { prefs.player.name = mine.name; save(); }
      // Nobody picked, and the game shown isn't in a raid (or has gone): another that is in one is shown instead.
      // (Told here, since only the game shown is listened to.)
      if (!prefs.player && games.length) {
        const shownGame = games.find(g => g.sid === sid);
        const better = shownGame && shownGame.raid ? null : games.find(g => g.raid) || (shownGame ? null : games[0]);
        if (better && better.sid !== sid) { forget(); sid = better.sid; listen(); }
      }
    } catch (e) { /* asked again in a moment */ }
    listGames();
  }

  // ---- what's shown here: marker kinds, on or off for this page only ---------------------------------------------
  // these start off on a page, and are on only where somebody ticked them (show); the rest start on (hide)
  const startOff = ['Layer spawnPmc', 'Layer spawnScav', 'Layer spawnBoss', 'Layer lootSpawns'];
  const shown = new Set(prefs.show);
  // as its switch has it
  const switchedOff = c => hidden.has(c) || (startOff.includes(c) && !shown.has(c));
  // The loot shown (prefs.loot): 'real', what's in this raid; 'can', where loot can spawn and what, never what's
  // there; 'both'; 'off'. A page from before this goes by the switches it had.
  if (!['real', 'can', 'both', 'off'].includes(prefs.loot)) {
    prefs.loot = !switchedOff('Layer lootSpawns') ? (hidden.has('Layer loose') ? 'can' : 'both') : 'real';
  }
  const lootReal = () => prefs.loot === 'real' || prefs.loot === 'both';
  // (out of a raid nothing is really there: what can spawn is shown then, whichever of the two is picked)
  const lootCan = () => prefs.loot === 'can' || prefs.loot === 'both' || (prefs.loot === 'real' && !inRaidHere());
  // what's in containers, on bodies and on bots may be shown
  const peeking = () => !!prefs.peek && lootReal();
  const isHidden = c => c === 'Layer lootSpawns' ? !lootCan()
    : (c === 'Layer loose' || c === 'Layer bodies') && !lootReal() ? true
    : c === 'Layer boxes' && prefs.loot === 'off' ? true
    : switchedOff(c);
  function setHidden(category, hide) {
    if (hide) { hidden.add(category); shown.delete(category); } else { hidden.delete(category); shown.add(category); }
    prefs.hide = [...hidden];
    prefs.show = [...shown];
    save();
    dirty = true;
    rosterPrint = bestPrint = null;
    showModes();
  }
  // A kind only a mod brings has a switch only where that mod is installed (the game says which: "has"), and the
  // infected once they've been met. Never by who is in the raid: a switch that came and went would give them away.
  const MOD_KINDS = ['Black Division', 'RUAF', 'RUAF Remnant', 'Civilian'];
  const available = c => MOD_KINDS.includes(c) ? !prefs.has || prefs.has.includes(c) : c === 'Infected' ? !!prefs.seenInfected : true;
  let filtersPrint = null;      // nothing drawn yet: the first look always draws the list
  // the switches, in groups; a few have a switch of their own under them (a prefs key, and what it says)
  // who's shown, in sections with a title each: a section none of whose kinds this game has isn't listed
  const PEOPLE_SECTIONS = [
    [T('PMC'), ['Main Player', 'Friendly Player', 'Enemy Player']],
    [T('Scavs'), ['Scav', 'Sniper']],
    [T('Bosses'), ['Boss', 'Guard', 'Goon', 'Cultist']],
    // the rest of the game's own: raiders, rogues, smugglers, the infected (an event), and every bot not named
    // (event and arena bots, a mod's own)
    [T('Other'), ['Raider', 'Rogue', 'Smuggler', 'Infected', 'Other AI']],
    [T('Modded bots'), ['Black Division', 'RUAF', 'RUAF Remnant', 'Civilian']],
    [T('Corpses'), ['Corpse']]
  ];
  const SECTION_OF = {};
  for (const [title, kinds] of PEOPLE_SECTIONS) for (const k of kinds) SECTION_OF[k] = title;
  // a section's title, across the grid, before the first of its kinds that is listed
  const sectionHead = (grid, kind, last) => {
    const title = SECTION_OF[kind];
    if (!title || title === last) return last;
    const head = document.createElement('div');
    head.className = 'filterHead sect';
    head.textContent = title;
    grid.appendChild(head);
    return title;
  };
  const FILTER_GROUPS = [
    ['filtersPeople', PEOPLE_SECTIONS.flatMap(s => s[1])],
    ['filtersMap', ['BTR', 'Airdrop', 'Layer btrRoad', 'Zone mine', 'Zone sniper', 'Layer locks', 'Layer spawnPmc', 'Layer spawnScav', 'Layer spawnBoss', 'Extract']],
    ['filtersLoot', ['Layer loose', 'Layer boxes', 'Layer bodies']]
  ];
  // the switches under another one that start on
  const SUB_ON = ['seenDead', 'corpseKind', 'allCorpses', 'myExits'];
  const FILTER_SUBS = {
    'Corpse': [['allCorpses', T('All corpses, not only player kills')], ['seenDead', T('Corpses I\'ve been close to')], ['corpseKind', T('Show what each corpse was')]],
    'Layer loose': [['lootArea', T('Rough areas only')]],
    'Extract': [['myExits', T('Mine only'), T('In a raid: only the extracts you can take this raid.')], ['goneExits', T('Closed ones'), T('Extracts that are no longer there this raid, such as a vehicle that has left, are shown in red. Off: they are hidden.')]]
  };
  function listFilters(keepColors) {
    const all = Object.keys(KINDS).sort((a, b) => KINDS[b].order - KINDS[a].order);
    // kinds and layers the server's config.jsonc keeps off every page
    const layersOff = (report && Array.isArray(report.layersOff)) ? report.layersOff : [];
    const off = ((report && Array.isArray(report.off)) ? report.off : [])
      .concat(Object.keys(LAYERS).filter(k => layersOff.includes(LAYERS[k].server)).map(k => 'Layer ' + k));
    const print = off.join('|') + '#' + (prefs.has || ['?']).join('|') + '#' + prefs.seenInfected;
    if (print === filtersPrint) return;
    filtersPrint = print;
    const looks = {};
    for (const k of all) looks[k] = KINDS[k];
    for (const zone of Object.keys(ZONES)) looks['Zone ' + zone] = ZONES[zone];
    for (const layer of Object.keys(LAYERS)) looks['Layer ' + layer] = LAYERS[layer];
    listAlerts(off);
    if (!keepColors) listColors();
    // "Rough area only": a switch for each kind that can be shown so
    {
      const grid = $('areaKinds');
      grid.textContent = '';
      let section = '';
      for (const kind of FILTER_GROUPS[0][1].filter(k => AREA_ABLE.includes(k))) {
        if (!available(kind) || off.includes(kind)) continue;
        section = sectionHead(grid, kind, section);
        const row = document.createElement('label'), input = document.createElement('input'), swatch = document.createElement('i'), span = document.createElement('span');
        row.className = 'row';
        input.type = 'checkbox';
        input.checked = prefs.areaKinds.includes(kind);
        input.onchange = () => {
          prefs.areaKinds = prefs.areaKinds.filter(k => k !== kind).concat(input.checked ? [kind] : []);
          save();
          dirty = true;
          rosterPrint = null;
          tipFor = null;
          squadPanePrint = '';
          const now = chased !== null ? liveById.get(chased) : null;
          if (now && inArea(now)) chase(null);
          listRoster();
        };
        swatch.className = 'swatch';
        swatch.style.background = KINDS[kind].col;
        span.textContent = KINDS[kind].name;
        row.append(input, swatch, span);
        grid.appendChild(row);
      }
    }
    for (const [box, members] of FILTER_GROUPS) {
      const grid = $(box);
      grid.textContent = '';
      let section = '';
      for (const category of members) {
        const look = looks[category];
        if (!look || !available(category)) continue;
        section = sectionHead(grid, category, section);
        const main = grid.appendChild(filterRow(category, look.name, look.col, off.includes(category)));
        // one or two short switches under another: on one line beside each other, under a row of its own
        const subs = FILTER_SUBS[category] || [];
        let line = grid;
        if (subs.length && subs.length <= 2) {
          main.classList.add('wide');
          line = document.createElement('div');
          line.className = 'subLine';
          grid.appendChild(line);
        }
        for (const sub of subs) {
          const row = document.createElement('label');
          row.className = 'row sub';
          if (sub[2]) row.title = sub[2];
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = !!prefs[sub[0]];
          input.dataset.def = SUB_ON.includes(sub[0]) ? '1' : '0';
          input.onchange = () => { prefs[sub[0]] = input.checked; save(); dirty = true; rosterPrint = null; tipFor = null; listRoster(); };
          const span = document.createElement('span');
          span.textContent = sub[1];
          row.append(input, span);
          line.appendChild(row);
        }
      }
    }
  }
  // Settings, Colours: each kind of marker with its colour, picked or typed as a hex code, and a way back to the usual
  // one. Extracts aren't here: their colour says whether they can be taken.
  function colorGroups() {
    return [[T('The page'), ['Page primary', 'Page secondary']], [T('People and bots'), FILTER_GROUPS[0][1]],
      [T('On the map'), FILTER_GROUPS[1][1].filter(k => k !== 'Extract')],
      [T('Loot'), ['Layer quest', 'Layer questZones'].concat(FILTER_GROUPS[2][1])]];
  }
  function setCol(key, col) {
    const look = colLook(key);
    if (!look) return;
    if (!col || col === COL_HOME[key]) delete prefs.cols[key];
    else prefs.cols[key] = col;
    look.col = prefs.cols[key] || COL_HOME[key];
    save();
    recolored();
  }
  // everything that shows a marker colour drawn again (the map, the switches' swatches, the Raid list)
  function recolored() {
    paintPage();
    dirty = true;
    tipFor = null;
    rosterPrint = null;
    squadPanePrint = '';
    filtersPrint = null;
    listFilters(true);
    listRoster();
    feedPrint = '';
    showKills();
  }
  function listColors() {
    const box = $('colorList');
    box.textContent = '';
    for (const [head, keys] of colorGroups()) {
      const title = document.createElement('div');
      title.className = 'filterHead';
      title.textContent = head;
      box.appendChild(title);
      for (const key of keys) {
        const look = colLook(key);
        if (!look || !available(key)) continue;
        const row = document.createElement('div'), pick = document.createElement('input'), name = document.createElement('span');
        // the square of colour is ours, with the browser's picker unseen over it: drawn by the browser, a dark colour got a light rim
        const sw = document.createElement('i');
        sw.className = 'sw';
        sw.appendChild(pick);
        const text = document.createElement('input'), back = document.createElement('button');
        row.className = 'row colRow';
        pick.type = 'color';
        pick.setAttribute('aria-label', look.name);
        name.textContent = look.name;
        text.type = 'text';
        text.className = 'hex';
        text.maxLength = 7;
        text.spellcheck = false;
        text.autocomplete = 'off';
        text.setAttribute('aria-label', T('Hex code') + ': ' + look.name);
        back.type = 'button';
        back.className = 'linkBtn';
        back.textContent = '↺';
        back.title = T('Back to the usual colour');
        const show = typed => {
          pick.value = look.col;
          sw.style.background = look.col;
          if (!typed) { text.value = look.col; text.classList.remove('bad'); }
          back.hidden = !prefs.cols[key];
          row.classList.toggle('changed', !!prefs.cols[key]);
        };
        pick.oninput = () => { setCol(key, hex6(pick.value)); show(); };
        text.oninput = () => {
          const col = hex6(text.value);
          text.classList.toggle('bad', !col);
          if (col) { setCol(key, col); show(true); }
        };
        text.onchange = () => show();
        text.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') text.blur(); };
        back.onclick = () => { setCol(key, null); show(); };
        show();
        row.append(sw, name, text, back);
        box.appendChild(row);
      }
    }
  }
  // the page starting again by itself: it fades out, and the new one stays unseen until it's whole (see index.html),
  // so nothing is seen falling apart and coming back piece by piece
  function again(go) {
    try { sessionStorage.setItem('swap', '1'); } catch (e) { /* private window */ }
    document.body.style.opacity = '0';
    setTimeout(go, 170);
  }
  // everything the page remembers, forgotten: it starts again as a page opened for the first time
  $('resetAll').onclick = () => {
    if (!confirm(T('Put every setting on this page back to its default? Switches, colours and layout are all reset.'))) return;
    try { localStorage.removeItem('livemap'); } catch (e) { /* private window */ }
    again(() => location.reload());
  };
  // every setting to a file, and back from one: the page then starts again with them, read the way they always are
  // (anything out of range is put right on the way in). Only the settings this page has are taken; not who's followed.
  $('prefsExport').onclick = () => {
    save();
    const kept = Object.assign({}, prefs);
    delete kept.player;
    const blob = new Blob([JSON.stringify({ satellite: 1, prefs: kept }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'satellite-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('prefsImport').onclick = () => { $('prefsPick').value = ''; $('prefsPick').click(); };
  $('prefsPick').onchange = () => {
    const file = $('prefsPick').files && $('prefsPick').files[0];
    if (!file) return;
    const wrong = () => alert(T("That file isn't settings saved by Satellite."));
    file.text().then(text => {
      let got;
      try { got = JSON.parse(text); } catch (e) { wrong(); return; }
      const from = got && typeof got === 'object' && got.satellite === 1 ? got.prefs : null;
      if (!from || typeof from !== 'object' || Array.isArray(from)) { wrong(); return; }
      // every key the file has (some, like the language, are only kept once picked), if it's this page's at all
      const next = {};
      for (const key of Object.keys(from)) if (key !== 'player') next[key] = from[key];
      if (!Object.keys(next).some(key => key in prefs)) { wrong(); return; }
      if (prefs.player) next.player = prefs.player;
      try { localStorage.setItem('livemap', JSON.stringify(next)); } catch (e) { /* private window */ }
      again(() => location.reload());
    }, wrong);
  };
  $('colorReset').onclick = () => {
    for (const key of Object.keys(prefs.cols)) { const look = colLook(key); if (look) look.col = COL_HOME[key]; }
    prefs.cols = {};
    save();
    recolored();
    listColors();
  };
  // the kinds that can be announced, each with its switch
  function listAlerts(off) {
    const box = $('alerts');
    box.textContent = '';
    for (const kind of ALERTS) {
      if (!available(kind) || off.includes(kind)) continue;
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = prefs.alerts.includes(kind);
      input.onchange = () => {
        prefs.alerts = prefs.alerts.filter(k => k !== kind).concat(input.checked ? [kind] : []);
        save();
        announce();
      };
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      swatch.style.background = KINDS[kind].col;
      const span = document.createElement('span');
      span.textContent = kind === 'Boss' ? T('Bosses, by name') : KINDS[kind].name;
      row.append(input, swatch, span);
      box.appendChild(row);
    }
  }
  function filterRow(category, name, col, barred) {
    {
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !barred && !switchedOff(category);
      input.disabled = barred;
      if (barred) {
        row.classList.add('blocked');
        row.title = T('Turned off on the server, for every page: config.jsonc in the mod\'s folder');
      }
      input.onchange = () => setHidden(category, !input.checked);
      input.dataset.def = startOff.includes(category) ? '0' : '1';
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      swatch.style.background = col;
      const span = document.createElement('span');
      span.textContent = name + (barred ? ' ' + T('(off on the server)') : '');
      row.append(input, swatch, span);
      return row;
    }
  }

  // The player's started quests, in the options: each goal not done yet, and a button to the places on this map it
  // sends them to (the quest's place, or where an item it wants lies now).
  function listQuests() {
    const shownPlaces = map && places && places.loc === map.loc ? places : null;
    const loot = inRaidHere() && things && things.loc === map.loc ? things : null;
    const where = goal => {
      const at = [];
      for (const z of shownPlaces ? shownPlaces.zones : []) if (list(goal.zones).includes(z.id)) at.push(z.p);
      for (const it of loot ? loot.loose : []) if (list(goal.items).includes(it.tpl)) at.push([it.x, it.y, it.z]);
      for (const b of shownPlaces && loot ? shownPlaces.boxes : []) {
        if (boxHidden(b)) continue;
        if ((loot.inside[b.id] || []).some(i => list(goal.items).includes(i[0]))) at.push(b.p);
      }
      return at;
    };
    const rows = (quests ? quests.list : []).map(q => {
      const goals = q.goals.map(g => ({ g, at: where(g) }));
      const here = goals.some(x => x.at.length) || sameLoc(q.loc, map && map.base)
        || q.goals.some(g => list(g.locs).some(l => sameLoc(l, map && map.base)));
      return { q, goals, here };
    }).sort((a, b) => (b.here ? 1 : 0) - (a.here ? 1 : 0) || a.q.name.localeCompare(b.q.name));
    const print = JSON.stringify([!!quests, map && map.loc, inRaidHere(), rows.map(r => [r.q.id, r.goals.map(x => x.g.id + ':' + x.at.length)])]);
    if (print === questsPrint) return;
    questsPrint = print;
    const box = $('questList');
    box.textContent = '';
    if (!quests) { box.textContent = T('No quests: the game shown hasn\'t been heard from.'); return; }
    if (!rows.length) { box.textContent = T('No quests started.'); return; }
    for (const { q, goals, here } of rows) {
      const item = document.createElement('details');
      item.className = 'quest' + (here ? ' here' : '');
      item.open = here;
      const head = document.createElement('summary');
      const elsewhere = !here && q.loc ? locationName(q.loc) : '';
      head.textContent = q.name + (q.trader ? ' · ' + q.trader : '') + (here ? ' · ' + T('on this map') : elsewhere ? ' · ' + elsewhere : '');
      item.appendChild(head);
      for (const { g, at } of goals) {
        const row = document.createElement('div');
        row.className = 'goal';
        const text = document.createElement('span');
        text.textContent = g.text || T('A goal');
        row.appendChild(text);
        if (at.length) {
          const go = document.createElement('button');
          go.type = 'button';
          go.textContent = at.length > 1 ? T('Go to') + ' (' + at.length + ')' : T('Go to');
          go.title = at.length > 1 ? T('Each press goes to the next of them') : '';
          let next = 0;
          go.onclick = () => {
            const p = at[next++ % at.length];
            goTo(p[0], p[1]);
          };
          row.appendChild(go);
        } else {
          // why there's nowhere to go: another map, a place not seen yet, or an item not lying about
          const locs = list(g.locs).filter(l => PLACES[l] || maps.some(m => sameLoc(m.base, l)));
          const other = q.loc && map && !sameLoc(q.loc, map.base) ? q.loc : locs.find(l => !map || !sameLoc(l, map.base));
          const note = document.createElement('small');
          note.className = 'goalNote';
          note.textContent = other ? T('On {map}', { map: locationName(other) })
        : list(g.zones).length ? T('Place not found on this map')
        : list(g.items).length ? (inRaidHere() ? T('None lying about') : T('In a raid')) : '';
          if (note.textContent) row.appendChild(note);
        }
        item.appendChild(row);
      }
      box.appendChild(item);
    }
  }

  // ---- this raid, on the left: who is in it, and its best loot ---------------------------------------------------
  // Who is in the raid, of the kinds shown on this page only (the list tells no more than the map does): the people
  // playing, then bosses and their like, the PMCs by the group they came in with, and the scavs last.
  // the Raid list's order: friends, then bosses (and the Goons), their guards, Black Division, PMCs, Rogues, the
  // kinds mods bring and the cultists, Raiders, and the scavs last
  const ROSTER = ['Friendly Player', 'Boss', 'Goon', 'Guard', 'Black Division', 'Enemy Player', 'Rogue', 'RUAF', 'RUAF Remnant', 'Cultist',
    'Smuggler', 'Civilian', 'Infected', 'Other AI', 'Raider', 'Scav', 'Sniper'];
  // the kinds that can be shown as a rough area only, each with its switch
  const AREA_ABLE = ROSTER.filter(k => k !== 'Friendly Player');
  let rosterPrint = null, bestPrint = null;
  const sideRow = (text, note, col, go) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sideRow';
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = col;
    const name = document.createElement('span');
    name.textContent = text;
    row.append(swatch, name);
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      row.appendChild(small);
    }
    row.onclick = go;
    return row;
  };
  // A bot's row, with what it's like and is up to under its name, each as a tag of its own colour: how hard it is,
  // its SAIN personality (the bold ones warm, the timid ones cool), who decides for it now (SAIN red, solid while it
  // fights; COMET amber, likewise; ORBIT blue; an ORBIT ghost dashed grey; the game's own brain plain) and what it
  // carries, in its worth's colour.
  const PS_HOT = ['wreckless', 'gigachad', 'chad', 'snappingturtle'], PS_MEEK = ['timmy', 'coward', 'rat'];
  const chip = (text, cls, title) => {
    const c = document.createElement('i');
    c.className = 'chip ' + cls;
    c.textContent = text;
    if (title) c.title = title;
    return c;
  };
  const hpBar = (row, m) => {
    if (!prefs.rosterHp || !prefs.health || !Array.isArray(m.hp) || !(m.hp[1] > 0)) return;
    const part = Math.max(0, Math.min(1, m.hp[0] / m.hp[1]));
    const bar = document.createElement('u'), fill = document.createElement('b');
    bar.className = 'hpBar';
    fill.style.width = Math.round(part * 100) + '%';
    fill.style.background = part > 0.6 ? '#4cd964' : part > 0.3 ? '#ffb13d' : '#ff5148';
    if (part >= 0.98) fill.style.opacity = '0.35';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.title = (row.title ? row.title + '\n' : '') + T('Health {hp} / {max}', { hp: m.hp[0], max: m.hp[1] });
  };
  const botLine = (row, m) => {
    hpBar(row, m);
    const carried = carriedBy(m);
    if (!hasDetails(m) && !carried) return row;
    const details = hasDetails(m), brain = details ? brainOf(m) : null;
    if (brain && brain.fight) row.classList.add('fight');
    // what it's doing now, and its squad's part in what COMET has the squad doing
    const doingTags = () => {
      const tags = [];
      if (!details || prefs.rosterDoing === false) return tags;
      if (m.ch) tags.push(chip(T('Cheater'), 'cheat', T('One of PBT\'s cheaters')));
      if (brain) {
        // who decides for it is the tag's colour (and in its hint): the room is for what it's doing
        const text = brain.ghost ? m.ob || T('Idle') : brain.text;
        tags.push(chip(text, 'by' + brain.by + (brain.fight ? ' fight' : ''),
          (brain.ghost || brain.by === 'EFT' ? text : brain.by + ' · ' + text) + '\n' + (brain.ghost ? T('ORBIT has this bot parked, far from every player') : brain.by === 'EFT' ? T('The game\'s own brain decides for it now') : T('{mod} decides for it now', { mod: brain.by }))));
      }
      if (m.sq && !(brain && brain.ghost)) {
        const q = m.sq, foe = squadFoe(q);
        tags.push(chip('⚑ ' + squadPart(q), 'bySquad' + (q.a ? ' fight' : ''),
          squadTactic(q) + '\n' + squadPart(q) + (q.a ? '' : ' ' + T('(preparing: COMET has not got it doing this yet)')) + (foe ? '\n' + T('Against {who}', { who: foe }) : '')
            + (q.m && q.f !== 'S04' ? '\n' + T('With {who}', { who: latin(q.m) }) : '') + '\n' + T('COMET has its squad acting together')));
      }
      return tags;
    };
    if (prefs.rosterSlim) {
      // one line: the name, then what it's doing
      row.classList.add('slim');
      const before = row.querySelector('small');
      const tags = doingTags(), told = tags.find(t => !t.classList.contains('cheat'));
      for (const tag of [tags.find(t => t.classList.contains('cheat')), told]) if (tag) row.insertBefore(tag, before);
    } else {
      const chips = document.createElement('span');
      chips.className = 'chips';
      if (details) {
        if (m.df) chips.appendChild(chip(DIFFICULTY[m.df] || m.df, 'df df-' + String(m.df).toLowerCase(), T('Difficulty')));
        if (m.ps) {
          const key = String(m.ps).toLowerCase().replace(/[^a-z]/g, '');
          chips.appendChild(chip(m.ps, 'ps' + (PS_HOT.includes(key) ? ' hot' : PS_MEEK.includes(key) ? ' meek' : ''), T('SAIN personality')));
        }
        if (!modOn('SAIN')) chips.classList.add('noPs');
        if (prefs.rosterDoing !== false) {
          // there for every bot, so the rows don't change as what they do comes and goes
          const doing = document.createElement('span');
          doing.className = 'doing';
          for (const tag of doingTags()) doing.appendChild(tag);
          chips.appendChild(doing);
        }
      }
      if (carried && carried.total) {
        const loot = chip(shortWorth(carried.total), 'loot', T('What it wears and carries is worth {worth}. Press the row for the list.', { worth: roubles(carried.total) }));
        loot.style.color = worthCol(carried.total);
        chips.appendChild(loot);
      }
      if (chips.childNodes.length) {
        row.classList.add('two');
        row.appendChild(chips);
      }
    }
    // the one pressed: what it has on and carries, set out under it
    if (carried && rosterOpen === m.id) {
      const gear = document.createElement('span');
      gear.className = 'gear';
      const line = (label, text, worth) => {
        const a = document.createElement('i'), b = document.createElement('span'), c = document.createElement('em');
        a.textContent = label;
        b.textContent = text;
        b.title = text;
        c.textContent = worth ? roubles(worth) : '';
        c.style.color = worth ? worthCol(worth) : '';
        gear.append(a, b, c);
      };
      for (const g of carried.worn) line(g.label, g.text, g.worth);
      carried.held.forEach((h, i) => line(i ? '' : carried.worn.length ? T('Carrying') : T('Has'), h.text, h.worth));
      if (carried.more > 0) line('', T('…and {n} more', { n: carried.more }), 0);
      row.appendChild(gear);
    }
    return row;
  };
  // the one in the Raid list whose gear is set out
  let rosterOpen = null;
  // how far each one listed is from the player, kept up to date without making the list again
  let rosterFar = new Map();
  const farText = d => (d < 100 ? Math.round(d / 5) * 5 : Math.round(d / 10) * 10) + ' m';
  const farOf = m => me && inRaidHere() && Number.isFinite(m.cx) ? Math.hypot(m.cx - me.cx, m.cy - me.cy) : NaN;
  function showFar() {
    for (const [id, el] of rosterFar) {
      const m = liveById.get(id);
      const d = m ? farOf(m) : NaN;
      const text = Number.isFinite(d) ? farText(d) : '';
      if (el.textContent !== text) el.textContent = text;
    }
  }
  // the one in the Raid list the pointer is over: ringed on the map
  let rosterOver = null;
  // a group's title in the Raid list: pressed, the group is folded away (and kept so)
  const rosterIsShut = key => prefs.rosterShut.includes(key);
  const foldRoster = key => {
    prefs.rosterShut = rosterIsShut(key) ? prefs.rosterShut.filter(k => k !== key) : prefs.rosterShut.concat([key]);
    save();
    rosterPrint = null;
    listRoster();
  };
  const sideHead = (text, key) => {
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'filterHead fold' + (rosterIsShut(key) ? ' shut' : '');
    head.textContent = text;
    head.title = rosterIsShut(key) ? T('Show these') : T('Fold these away');
    head.onclick = () => foldRoster(key);
    return head;
  };
  // The Raid list is a panel of its own beside the map; on a phone it's in the menu's Raid tab
  const rosterShown = () => phone.matches ? !$('panel').hidden && tab === 'raid' : !$('side').hidden;
  function listRoster() {
    if (!rosterShown()) { showSquadPane(); return; }
    const raid = inRaid();
    // Without who's alive: everyone seen this raid, as first seen, and only the dead a player killed (their bodies
    // say so) are known to be dead; nothing that changes while they live is shown (where, how far, what they do).
    const fog = prefs.rosterFog && raid;
    const known = new Set();
    if (fog) {
      for (const c of corpsesNow || live.filter(k => k.c === 'Corpse')) {
        const pid = c.pid || (c.body && c.body.pid);
        if (pid && (c.kp || bodySeen(c))) known.add(pid);
      }
    }
    const rows = !raid ? [] : fog ? [...seenRoster.values()].filter(m => !isHidden(m.c)).map(m => Object.assign({}, m, { fogDead: !!m.pid && known.has(m.pid) }))
      : live.filter(m => ROSTER.includes(m.c) && !isHidden(m.c));
    // nearest first, when asked: the order is then part of what the list is
    const near = prefs.rosterNear && !!me && inRaidHere() && !fog;
    // ORBIT's ghosts (parked far from every player): with their kind, in a group of their own at the end, or left out
    const apart = !fog && prefs.rosterGhosts !== 'in';
    const ghosts = apart && prefs.rosterGhosts === 'own' ? rows.filter(m => m.gh) : [];
    const main = apart ? rows.filter(m => !m.gh) : rows;
    const hpOf = m => prefs.rosterHp && prefs.health && Array.isArray(m.hp) && m.hp[1] > 0 ? Math.round(m.hp[0] / m.hp[1] * 25) : '';
    if (near) for (const list of apart ? [rows, main] : [rows]) list.sort((a, b) => (inArea(a) ? 1e9 : farOf(a) || 0) - (inArea(b) ? 1e9 : farOf(b) || 0));
    const print = raid + '|' + near + '|' + fog + '|' + peeking() + '|' + prefs.botDetails + (prefs.botDiff !== false) + prefs.areaKinds.join('.') + Object.keys(BOT_MODS).map(n => modOn(n) ? 1 : 0).join('') + '|' + prefs.botLoot + thingsHave + '|' + rosterOpen + '|' + chased + '|' + prefs.rosterShut.join('.') + prefs.rosterGhosts + [prefs.rosterSlim, prefs.rosterDoing].join('') + '|' + rows.map(m => [m.id, hpOf(m), m.c, m.t, m.lv || 0, m.g || '', m.df || '', m.ps || '', m.ly || '', m.gh || 0, m.ob || '', m.cm || '', m.bg || '', m.os || '', m.ch || 0, m.sq ? [m.sq.f, m.sq.s, m.sq.a || 0, m.sq.r || '', m.sq.u || '', m.sq.x || 0, m.sq.p || '', m.sq.c || ''].join('~') : '', m.fogDead ? 1 : 0].join(':')).join(',')
      + '|' + squadLogOpen + '|' + (squadEvents.length ? squadEvents[squadEvents.length - 1].n : 0);
    if (print === rosterPrint) { showFar(); return; }
    rosterPrint = print;
    const box = $('roster');
    box.textContent = '';
    rosterFar = new Map();
    // how many of each kind, at the top
    const sum = $('rosterSum');
    sum.textContent = '';
    for (const kind of ROSTER) {
      const count = rows.filter(m => m.c === kind).length;
      if (!count) continue;
      const tag = chip((ONE[kind] || kind) + ' ' + count, 'count' + (rosterIsShut(kind) && !near ? ' shut' : ''), KINDS[kind].name + (near ? '' : '. ' + T('Press to fold these away, or show them')));
      if (!near) tag.onclick = () => foldRoster(kind);
      const swatch = document.createElement('b');
      swatch.style.background = KINDS[kind].col;
      tag.prepend(swatch);
      sum.appendChild(tag);
    }
    if (!raid) { box.textContent = T('Not in a raid.'); showSquadPane(); return; }
    if (!rows.length) { box.textContent = phone.matches ? T('Nobody to list. Who is listed is set under Who\'s shown, below.') : T('Nobody to list. Who is listed is set under Who\'s shown, in the menu\'s Raid tab.'); showSquadPane(); return; }
    // Pressing somebody: the map goes to them and stays on them, and their gear is set out under their name (pressed
    // again: put away). A drag, or a press anywhere else, lets them go.
    const go = m => () => {
      const now = liveById.get(m.id);
      rosterOpen = rosterOpen === m.id ? null : m.id;
      rosterPrint = null;
      if (now && inRaidHere()) {
        goTo(now.cx, now.cy);
        chase(m.id);
      }
      listRoster();
    };
    // beside the name: the level, and the kind too when the list isn't in groups (nearest first)
    const sub = m => near ? (ONE[m.c] || m.c) + (m.lv ? ' · ' + T('Lv {n}', { n: m.lv }) : '') : m.lv ? T('Lv {n}', { n: m.lv }) : ' ';
    const one = m => {
      if (fog || inArea(m)) {
        // a name, its kind's colour, its level, and alive or not as far as anyone can tell
        const row = sideRow(m.t || (ONE[m.c] || m.c), sub(m), KINDS[m.c].col, () => {});
        // not pressed, and not ringed on the map when pointed at: that would say where they are
        row.disabled = true;
        const state = document.createElement('small');
        state.className = 'far fog' + (m.fogDead ? ' dead' : '');
        state.textContent = m.fogDead ? T('Dead') : '?';
        state.title = m.fogDead ? T('Killed by a player, or you have been by its body') : T('Not known whether still alive');
        row.insertBefore(state, row.children[2] || null);
        if (prefs.botDetails && (m.df || m.ps)) {
          const chips = document.createElement('span');
          chips.className = 'chips';
          if (m.df) chips.appendChild(chip(DIFFICULTY[m.df] || m.df, 'df df-' + String(m.df).toLowerCase(), T('Difficulty')));
          if (m.ps) chips.appendChild(chip(m.ps, 'ps', T('SAIN personality')));
          row.classList.add('two');
          row.appendChild(chips);
        }
        return row;
      }
      const row = sideRow(m.t || (ONE[m.c] || m.c), sub(m), KINDS[m.c].col, go(m));
      row.dataset.id = m.id;
      if (chased === m.id) row.classList.add('chased');
      if (rosterOpen === m.id) row.classList.add('open');
      const far = document.createElement('small');
      far.className = 'far';
      row.insertBefore(far, row.children[2] || null);
      rosterFar.set(m.id, far);
      return botLine(row, m);
    };
    const listGhosts = () => {
      if (!ghosts.length) return;
      box.appendChild(sideHead(T('ORBIT ghosts') + ' · ' + ghosts.length, 'Ghosts'));
      if (rosterIsShut('Ghosts')) return;
      const order = m => (KINDS[m.c] || OTHER).order;
      for (const m of ghosts.slice().sort((a, b) => order(b) - order(a) || (a.t || '').localeCompare(b.t || ''))) box.appendChild(one(m));
    };
    if (near) {
      for (const m of main) { const row = one(m); row.title = (ONE[m.c] || m.c) + (row.title ? '\n' + row.title : ''); box.appendChild(row); }
      listGhosts();
      squadLog(box);
      showFar();
      return;
    }
    for (const kind of ROSTER) {
      const of = main.filter(m => m.c === kind).sort((a, b) => (a.t || '').localeCompare(b.t || ''));
      if (!of.length) continue;
      box.appendChild(sideHead(KINDS[kind].name + ' · ' + of.length, kind));
      if (rosterIsShut(kind)) continue;
      if (kind !== 'Enemy Player') { for (const m of of) box.appendChild(one(m)); continue; }
      // PMCs: each group that came in together, the biggest first, then the ones on their own
      const groups = new Map();
      for (const m of of) {
        const key = m.g || (m.bg ? 'bot:' + m.bg : 'solo:' + m.id);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const sets = [...groups.values()].sort((a, b) => b.length - a.length);
      for (const set of sets.filter(g => g.length > 1)) {
        const group = document.createElement('div');
        group.className = 'sideGroup';
        const title = document.createElement('small');
        title.textContent = T('Group of {n}', { n: set.length });
        group.appendChild(title);
        // what COMET has them doing together: each plan once
        const plans = new Map();
        for (const m of set) if (m.sq && hasDetails(m) && !inArea(m) && !plans.has(m.sq.p || m.sq.f)) plans.set(m.sq.p || m.sq.f, set.filter(o => o.sq && (o.sq.p || o.sq.f) === (m.sq.p || m.sq.f)));
        for (const of of plans.values()) {
          const going = of.some(o => o.sq.a), foe = squadFoe(of[0].sq);
          const plan = document.createElement('small');
          plan.className = 'tactic' + (going ? ' going' : '');
          plan.textContent = squadTactic(of[0].sq) + ' · ' + (going ? T('in progress') : T('preparing'));
          plan.title = T('{n} of {of} in it', { n: of.length, of: set.length }) + (foe ? ', ' + T('against {who}', { who: foe }) : '') + (going ? '' : '. ' + T('Preparing: COMET has not got them doing it yet'));
          group.appendChild(plan);
          group.classList.add('acting');
        }
        for (const m of set) group.appendChild(one(m));
        box.appendChild(group);
      }
      for (const set of sets.filter(g => g.length === 1)) box.appendChild(one(set[0]));
    }
    listGhosts();
    squadLog(box);
    showFar();
  }
  // ---- what happened in the raid ----
  // Beside where everybody is now, the game says what happened, each thing once: {"n","t","k","p","nm","d"} (its
  // number in the raid, when on the raid's clock in ms, its kind, whose, their name, the rest). They come with the
  // full reports ("rid" the raid, "ev" the new ones); a page opened later asks the server for the raid so far.
  // So far only "comet.squad": what COMET has a bot doing with its squad, whenever that changes.
  let squadEvents = [], eventsRaid = '', eventsSeen = new Set(), squadLogOpen = false;
  function addEvents(list, fresh) {
    let added = false, killed = false, others = false;
    for (const e of list || []) {
      if (!e || !Number.isFinite(e.n) || eventsSeen.has(e.n) || !e.d) continue;
      if (e.k === 'kill') {
        eventsSeen.add(e.n);
        // heard as it happened (not asked for afterwards): shown at the top of the map for a few seconds
        e.at = fresh ? performance.now() : -1e9;
        killEvents.push(e);
        killed = true;
        continue;
      }
      if (e.k === 'loot' || e.k === 'orbit.wake' || e.k === 'orbit.fight' || e.k === 'orbit.hear') {
        eventsSeen.add(e.n);
        otherEvents.push(e);
        if (otherEvents.length > 600) otherEvents.splice(0, otherEvents.length - 600);
        if (fresh && e.k === 'orbit.fight' && Array.isArray(e.d.a) && Array.isArray(e.d.b)) ghostMarks.push({ k: 'fight', a: e.d.a, b: e.d.b, n: e.d.n, until: performance.now() + FIGHT_MS });
        if (fresh && e.k === 'orbit.hear' && Array.isArray(e.d.l) && Array.isArray(e.d.s)) ghostMarks.push({ k: 'hear', l: e.d.l, s: e.d.s, r: e.d.r || 0, until: performance.now() + HEAR_MS });
        others = true;
        continue;
      }
      if (e.k !== 'comet.squad') continue;
      eventsSeen.add(e.n);
      squadEvents.push(e);
      added = true;
    }
    if (killed) {
      killEvents.sort((a, b) => a.n - b.n);
      if (killEvents.length > 400) killEvents.splice(0, killEvents.length - 400);
      showKills();
    }
    if (others) { otherEvents.sort((a, b) => a.n - b.n); squadPanePrint = ''; showSquadPane(); dirty = true; }
    if (!added) return;
    squadEvents.sort((a, b) => a.n - b.n);
    if (squadEvents.length > 300) squadEvents.splice(0, squadEvents.length - 300);
    listRoster();
  }
  function takeEvents(d) {
    const rid = d.raid && d.rid ? d.rid : '';
    if (rid !== eventsRaid) {
      eventsRaid = rid;
      squadEvents = [];
      otherEvents = [];
      ghostMarks = [];
      killEvents = [];
      eventsSeen = new Set();
      showKills();
      if (rid) {
        fetch('api/events?after=0' + (sid ? '&session=' + encodeURIComponent(sid) : '')).then(r => r.json())
          .then(j => { if (j && j.rid === eventsRaid) addEvents(j.ev); }).catch(() => {});
      }
    }
    addEvents(d.ev, true);
  }
  // ---- the kill feed ----
  // Who killed whom ("kill" events), in a corner of the map as it happens: the latest few (or each for FEED_MS). Its
  // count, pressed, folds the kills away and back (prefs.feedFolded); its × turns the feed off (Map > Kill feed turns
  // it back on). Which kills are told is chosen in the options: by who died, and whether it was the player's or a
  // friend's doing.
  let killEvents = [], feedPrint = '';
  const FEED_MS = 9000, FEED_BIG = ['Boss', 'Goon', 'Guard', 'Cultist'], FEED_OURS = ['Main Player', 'Friendly Player'];
  function killTold(e) {
    const d = e.d;
    if (FEED_OURS.includes(d.kk) || FEED_OURS.includes(d.vk)) return prefs.feedMine !== false;
    if (d.vk === 'Enemy Player') return prefs.feedPmc !== false;
    if (FEED_BIG.includes(d.vk)) return prefs.feedBoss !== false;
    return !!prefs.feedAi;
  }
  const PARTS = { Head: T('head'), Chest: T('chest'), Stomach: T('stomach'), LeftArm: T('arm'), RightArm: T('arm'), LeftLeg: T('leg'), RightLeg: T('leg') };
  function killRow(e, clock) {
    const d = e.d, row = document.createElement('div');
    row.className = 'kill';
    const name = (text, kind) => {
      const b = document.createElement('b');
      b.textContent = text;
      b.style.color = (KINDS[kind] || OTHER).col;
      b.title = ONE[kind] || kind || '';
      return b;
    };
    if (clock) { const t = document.createElement('time'); t.textContent = raidClock(e.t || 0); row.appendChild(t); }
    // whose names are given: everyone's, not the killer's, or nobody's (the player and their friends always)
    const bare = (kind, hide) => hide && !FEED_OURS.includes(kind);
    const victim = name(e.nm && !bare(d.vk, prefs.feedNames === 'kinds') ? latin(e.nm) : ONE[d.vk] || d.vk || T('Somebody'), d.vk);
    if (d.k) {
      row.appendChild(name(d.kn && !bare(d.kk, prefs.feedNames !== 'all') ? latin(d.kn) : ONE[d.kk] || d.kk || T('Somebody'), d.kk));
      const how = document.createElement('i');
      how.textContent = d.w || T('killed');
      row.append(how, victim);
    } else {
      const how = document.createElement('i');
      how.textContent = T('died');
      row.append(victim, how);
    }
    const more = [PARTS[d.bp] || '', Number.isFinite(d.m) && d.k ? d.m + ' m' : ''].filter(Boolean).join(' · ');
    if (more) { const s = document.createElement('small'); s.textContent = more; row.appendChild(s); }
    return row;
  }
  // in the bottom corner on the menu's side, beside the menu when it's open; on a phone, at the top (the stylesheet)
  function placeFeed(box) {
    document.body.style.setProperty('--feed-bg', String(prefs.feedBg / 100));
    if (phone.matches) { box.style.left = box.style.right = box.style.bottom = box.style.top = ''; box.classList.remove('toLeft', 'toTop', 'free'); return; }
    const swap = !!prefs.swap, panel = $('panel'), open = !panel.hidden && !document.body.classList.contains('bare');
    // where it was dragged to: kept to its edges, so it grows away from them as kills come in
    const at = prefs.feedPos === 'free' ? prefs.feedAt : null;
    box.classList.toggle('free', !!at);
    if (at) {
      const W = window.innerWidth, H = window.innerHeight;
      box.classList.toggle('toLeft', !!at.l);
      box.classList.toggle('toTop', !!at.t);
      const ax = Math.max(4, Math.round(at.x * W)), ay = Math.max(4, Math.round(at.y * H));
      box.style.left = at.l ? ax + 'px' : 'auto';
      box.style.right = at.l ? 'auto' : ax + 'px';
      box.style.top = at.t ? ay + 'px' : 'auto';
      box.style.bottom = at.t ? 'auto' : ay + 'px';
      return;
    }
    // the corner asked for (Map > Kill feed > Position), or the bottom one on the menu's side
    const pos = prefs.feedPos === 'auto' ? (swap ? 'bl' : 'br') : prefs.feedPos;
    const left = pos[1] === 'l', top = pos[0] === 't';
    // beside whatever panel is open on that side: the menu (the screen's whole height), the Raid list (the top only)
    let gap = 10;
    for (const el of [panel, $('side')]) {
      if (el.hidden || (el === panel && !open) || (el !== panel && (!top || document.body.classList.contains('bare')))) continue;
      const r = el.getBoundingClientRect();
      if (r.width && (r.left + r.width / 2 < window.innerWidth / 2) === left) gap = Math.max(gap, (left ? r.right : window.innerWidth - r.left) + 8);
    }
    box.classList.toggle('toLeft', left);
    box.classList.toggle('toTop', top);
    box.style.left = left ? gap + 'px' : 'auto';
    box.style.right = left ? 'auto' : gap + 'px';
    // clear of what else is in that corner: the bar (top), the scale and the pointer's place (bottom left), the keys' hint (bottom right)
    box.style.top = top ? Math.round($('bar').getBoundingClientRect().bottom + 8) + 'px' : 'auto';
    box.style.bottom = top ? 'auto' : (left ? $('readout').offsetHeight + 18 : gap > 10 ? 10 : 34) + 'px';
  }
  function showKills() {
    let box = $('killFeed');
    if (!box) {
      box = document.createElement('div');
      box.id = 'killFeed';
      box.innerHTML = '<div id="killList"></div><div id="killHead"><button id="killCount" type="button"></button><button id="killClose" type="button">×</button></div>';
      document.body.appendChild(box);
      $('killCount').onclick = () => { prefs.feedFolded = !prefs.feedFolded; save(); feedPrint = ''; showKills(); };
      $('killClose').onclick = () => { prefs.feed = false; $('optFeed').checked = false; save(); dirty = true; feedPrint = ''; showKills(); };
      // picked up anywhere and put down anywhere, on the grid (Map > Kill feed > Position: "Where I put it"); it then
      // grows away from the window's nearer edges
      draggable(box, box, (x, y, start) => {
        const s = snapPanel(box, x, y), W = window.innerWidth, H = window.innerHeight;
        const l = s[0] + start.width / 2 < W / 2, t = s[1] + start.height / 2 < H / 2;
        prefs.feedAt = { l, t, x: (l ? s[0] : W - s[0] - start.width) / W, y: (t ? s[1] : H - s[1] - start.height) / H };
        prefs.feedPos = 'free';
        $('optFeedPos').value = 'free';
        save(); feedPrint = ''; showKills();
      }, (x, y) => snapPanel(box, x, y));
    }
    const told = prefs.feed !== false && inRaid() ? killEvents.filter(killTold) : [];
    const now = performance.now();
    const folded = !!prefs.feedFolded;
    const rows = folded ? [] : told.filter(e => prefs.feedKeep || now - e.at < FEED_MS).slice(-prefs.feedRows);
    const print = folded + '|' + prefs.feedBox + '|' + prefs.feedNames + '|' + told.length + '|' + rows.map(e => e.n).join(',');
    box.hidden = !told.length;
    placeFeed(box);
    if (print === feedPrint) return;
    feedPrint = print;
    $('killCount').textContent = (folded ? '▸ ' : '▾ ') + T('Kills') + ' · ' + told.length;
    $('killCount').title = folded ? T('Show the kills') : T('Fold the kills away');
    $('killClose').title = T('Turn the kill feed off (Map > Kill feed turns it back on)');
    const list = $('killList');
    list.textContent = '';
    list.hidden = !rows.length;
    // a bubble round each kill, or all in one box with the raid time of each (Map > Kill feed > All in one box)
    list.classList.toggle('box', !!prefs.feedBox);
    for (const e of rows) list.appendChild(killRow(e, !!prefs.feedBox));
  }
  setInterval(() => { showKills(); sidesNow(); }, 1000);
  const raidClock = ms => Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  // the last dozen, the newest first, shut until asked for; pressing one goes to that bot, when it's still on the map
  // what's picked up, and what ORBIT's ghosts do: the other events the panel lists
  let otherEvents = [];
  const EVENT_KINDS = [['tactic', 'Tactic', 'What each squad is doing together (COMET). Press one, or a bot in one, to see its members.'], ['all', 'All'], ['squad', 'Squads'], ['loot', 'Loot'], ['orbit', 'ORBIT']];
  const eventKind = e => e.k === 'comet.squad' ? 'squad' : e.k === 'loot' ? 'loot' : 'orbit';
  const lootWorth = d => { const n = things && things.names ? things.names[d.tpl] : null; return n && n.p ? n.p * (d.q || 1) : NaN; };
  function eventListed(e, tab) {
    const kind = eventKind(e);
    if (tab !== 'all' && tab !== kind) return false;
    if (kind === 'squad') return modOn('COMET') && !prefs.areaKinds.includes('Enemy Player');
    if (kind === 'orbit') return modOn('ORBIT');
    if (prefs.areaKinds.includes(e.d.wk)) return false;
    if (e.d.wk && isHidden(e.d.wk)) return false;
    // what isn't worth showing as loot isn't worth telling of either (a quest item always is)
    const worth = lootWorth(e.d);
    return !!e.d.qi || !Number.isFinite(worth) || worth >= prefs.worth;
  }
  function eventSaid(e) {
    const d = e.d;
    if (e.k === 'comet.squad') return ['', squadSaid(d), '#ffc56e'];
    if (e.k === 'loot') {
      const worth = lootWorth(d);
      return ['', T('Picked up {item}', { item: d.i }) + (d.q > 1 ? ' ×' + d.q : '') + (Number.isFinite(worth) ? ' · ' + roubles(worth) : '') + (d.qi ? ' · ' + T('quest item') : ''),
        Number.isFinite(worth) ? worthCol(worth) : '#e8e9eb'];
    }
    if (e.k === 'orbit.wake') return ['', T('Woke') + ' · ' + words(d.c || 'woken') + (d.by ? ' · ' + T('by {who}', { who: latin(d.by) }) : '') + (d.m ? ' · ' + d.m + ' m' : ''), '#9fd8ff'];
    if (e.k === 'orbit.fight') return [T('Ghost fight'), T('{n} dead', { n: d.n || 0 }) + ' · ' + (d.s || 0) + ' s', '#ff8d84'];
    return [e.nm ? '' : T('A ghost'), (d.sh ? TP(d.sh, 'Heard {n} shot', 'Heard {n} shots') : T('Heard a noise')) + (d.m ? ' · ' + T('{n} m off', { n: d.m }) : '') + (d.inv ? ' · ' + T('going to look') : ''), '#9fd8ff'];
  }
  const squadRow = e => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'squadEvent';
    const when = document.createElement('time'), who = document.createElement('b'), what = document.createElement('span');
    const said = eventSaid(e);
    when.textContent = raidClock(e.t || 0);
    who.textContent = said[0] || (e.nm ? latin(e.nm) : T('A bot'));
    what.textContent = said[1];
    what.style.color = said[2];
    row.append(when, who, what);
    row.title = who.textContent + '\n' + what.textContent;
    row.onclick = () => {
      if (!inRaidHere()) return;
      const m = e.p ? live.find(x => x.pid === e.p && x.c !== 'Corpse') : null;
      if (m && !inArea(m)) { goTo(m.cx, m.cy); chase(m.id); return; }
      // nobody to follow: the place it happened
      const at = Array.isArray(e.d.l) ? e.d.l : Array.isArray(e.d.a) && Array.isArray(e.d.b) ? [(e.d.a[0] + e.d.b[0]) / 2, (e.d.a[1] + e.d.b[1]) / 2] : null;
      if (at) { chase(null); roam(); goTo(at[0], at[1]); }
    };
    return row;
  };
  let squadPanePrint = '';
  // The squad tactic view (after Chazut's in Raid Review): the squad of the bot followed, pointed at or under the
  // pointer in the Raid list, kept until another is picked. Its tactics, each with how far along it is; then every
  // member with its part, who decides for it and what it's doing; then the squad's latest events.
  let tacticOf = null;
  // the bots followed, pointed at and under the pointer when one was last taken up: a squad is only taken from them
  // again once that changes, so "All squads" stays put while a bot is still followed
  let tacticFrom = '';
  const bandKey = m => m.g || (m.bg ? 'bot:' + m.bg : (m.sq && m.sq.p) || 'solo:' + m.id);
  function showTactic() {
    const body = $('squadBody');
    for (const b of $('squadKinds').children) b.classList.toggle('on', b.dataset.v === 'tactic');
    const from = [chased, pointed, rosterOver].join(',');
    if (from !== tacticFrom) {
      tacticFrom = from;
      for (const id of [chased, pointed, rosterOver]) {
        const m = id !== null && id !== undefined ? liveById.get(id) : null;
        if (m && m.c !== 'Corpse' && m.c !== 'Main Player' && (m.sq || m.g || m.bg)) { tacticOf = { key: bandKey(m), id: m.id }; break; }
      }
    }
    const shownOk = m => m.c !== 'Corpse' && !inArea(m) && !isHidden(m.c || 'None');
    const set = tacticOf && modOn('COMET') ? live.filter(m => shownOk(m) && bandKey(m) === tacticOf.key) : [];
    const pids = new Set(set.map(m => m.pid).filter(Boolean));
    const events = squadEvents.filter(e => pids.has(e.p)).slice(-8).reverse();
    const sqPrint = m => m.sq ? [m.sq.f, m.sq.s, m.sq.u, m.sq.r, m.sq.a, m.sq.x, m.sq.c].join('.') : '';
    // none picked: every squad with a tactic going, each a card that opens it
    const squads = new Map();
    if (!set.length && modOn('COMET')) {
      for (const m of live) {
        if (!shownOk(m) || m.c === 'Main Player' || !(m.sq || m.g || m.bg)) continue;
        const k = bandKey(m);
        if (!squads.has(k)) squads.set(k, []);
        squads.get(k).push(m);
      }
      // a squad is two or more; one alone counts only while COMET has it in a tactic
      for (const [k, of] of squads) if (of.length < 2 && !of.some(m => m.sq)) squads.delete(k);
    }
    const print = 'tactic|' + set.map(m => [m.id, m.t, m.ly, m.cm, sqPrint(m)].join(':')).join(',')
      + '|' + [...squads.values()].map(of => of.map(m => m.id + ':' + sqPrint(m)).join(',')).join(';')
      + '|' + (events.length ? events[0].n : 0) + '|' + (tacticOf ? tacticOf.id : '');
    if (print === squadPanePrint) return;
    squadPanePrint = print;
    body.textContent = '';
    const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
    const nameOfBot = m => m.t ? latin(m.t) : ONE[m.c] || m.c;
    if (!set.length) {
      if (!squads.size) { body.appendChild(el('p', 'tacticNone', T('No squad tactic running.'))); return; }
      body.appendChild(el('div', 'filterHead', T('Squads in this raid')));
      // the ones with a tactic going first, then the ones with one over, then the rest
      const rank = of => of.some(m => m.sq && m.sq.a && !squadOver(m.sq)) ? 0 : of.some(m => m.sq) ? 1 : 2;
      for (const of of [...squads.values()].sort((a, b) => rank(a) - rank(b))) {
        const lead = of.find(m => m.sq) || of[0], q = lead.sq;
        // what the squad is: a boss's, by the boss's name; otherwise by the kind most of it is
        const boss = of.find(m => m.c === 'Boss' && m.t);
        const kinds = {};
        for (const m of of) kinds[m.c] = (kinds[m.c] || 0) + 1;
        const kind = Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a])[0];
        const title = boss ? T("{name}'s squad", { name: nameOfBot(boss) }) : T('{kind} squad', { kind: ONE[kind] || kind });
        // who's in it: the first three by name, then how many more
        if (boss) of.sort((a, b) => (b === boss) - (a === boss));
        const names = of.slice(0, 3).map(nameOfBot).join(', ') + (of.length > 3 ? ' ' + T('+{n} more', { n: of.length - 3 }) : '');
        const card = el('button', 'tacticCard tacticSquad');
        card.type = 'button';
        card.title = of.map(nameOfBot).join('\n');
        if (q) {
          const over = of.filter(m => m.sq).every(m => squadOver(m.sq)), going = of.some(m => m.sq && m.sq.a), foe = squadFoe(q);
          if (going && !over) card.classList.add('going');
          card.append(el('b', '', title), el('span', '', over ? T('Over') : going ? T('in progress') : T('preparing')),
            el('small', '', names), el('small', 'plan', squadTactic(q) + (foe ? ' · ' + T('against {who}', { who: foe }) : '')));
        } else {
          card.append(el('b', '', title), el('span', '', ''), el('small', '', names), el('small', 'plan', T('No squad tactic running.')));
        }
        card.onclick = () => { tacticOf = { key: bandKey(lead), id: lead.id }; squadPanePrint = ''; showTactic(); };
        body.appendChild(card);
      }
      return;
    }
    const back = el('button', 'linkBtn tacticBack', '‹ ' + T('All squads'));
    back.type = 'button';
    back.onclick = () => { tacticOf = null; squadPanePrint = ''; showTactic(); };
    body.appendChild(back);
    const first = set.find(m => m.id === tacticOf.id) || set[0];
    body.appendChild(el('div', 'tacticWho', nameOfBot(first)));
    body.appendChild(el('div', 'tacticSum', TP(set.length, 'Squad · {n} member', 'Squad · {n} members')));
    // each tactic the squad has going, once
    const plans = new Map();
    for (const m of set) if (m.sq) { const k = m.sq.p || m.sq.f; if (!plans.has(k)) plans.set(k, []); plans.get(k).push(m); }
    if (!plans.size) body.appendChild(el('p', 'tacticNone', T('No squad tactic running.')));
    for (const of of plans.values()) {
      const q = of[0].sq, over = of.every(o => squadOver(o.sq)), going = of.some(o => o.sq.a), foe = squadFoe(q);
      const card = el('div', 'tacticCard' + (going && !over ? ' going' : ''));
      card.append(el('b', '', squadTactic(q)), el('span', '', over ? T('Over') : going ? T('in progress') : T('preparing')),
        el('small', '', T('{n} of {of} in it', { n: of.length, of: set.length }) + (foe ? ' · ' + T('against {who}', { who: foe }) : '')));
      body.appendChild(card);
    }
    // each member: its part, who decides for it, what it's doing
    for (const m of set) {
      const brain = brainOf(m), card = el('button', 'tacticBot' + (m.id === tacticOf.id ? ' on' : ''));
      card.type = 'button';
      const head = el('div', 'head');
      head.append(el('b', '', nameOfBot(m)), el('i', '', brain ? brain.by : ''));
      card.appendChild(head);
      if (m.sq) card.appendChild(el('span', 'part', '➚ ' + squadSaid(m.sq)));
      if (brain) card.appendChild(el('small', '', brain.text));
      const like = likeOf(m);
      if (like && prefs.botDiff) card.appendChild(el('small', '', like));
      card.onclick = () => { if (inRaidHere() && !inArea(m)) { goTo(m.cx, m.cy); chase(m.id); } };
      body.appendChild(card);
    }
    if (events.length) {
      body.appendChild(el('div', 'filterHead', T('Recent squad events')));
      for (const e of events) body.appendChild(squadRow(e));
    }
  }
  // Where the Raid events panel may stand (prefs.eventsPos): beside the Raid list ('auto', on the side of it the map
  // is), beside the menu ('menu'), or a corner of the map ('tl', 'tr', 'bl', 'br'), clear of the panels open there.
  // Each as [left, top] in pixels, for a panel of this size.
  function eventsSpots(pane) {
    const w = pane.offsetWidth, h = pane.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    const bar = Math.round($('bar').getBoundingClientRect().bottom + 8);
    const open = el => !el.hidden && !document.body.classList.contains('bare') && el.getBoundingClientRect().width > 0;
    const side = $('side'), menu = $('panel');
    // how far in from each edge a corner spot starts: past the panel open on that side
    let inL = 10, inR = 10;
    for (const el of [side, menu]) {
      if (!open(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left + r.width / 2 < W / 2) inL = Math.max(inL, r.right + 8); else inR = Math.max(inR, W - r.left + 8);
    }
    const spots = {};
    const beside = el => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2 < W / 2 ? r.right + 8 : r.left - 8 - w, r.top];
    };
    if (open(side)) spots.auto = beside(side);
    if (open(menu)) spots.menu = beside(menu);
    spots.tl = [inL, bar];
    spots.tr = [W - inR - w, bar];
    // above the kill feed when that's in the same bottom corner
    const feed = $('killFeed'), fr = feed && !feed.hidden ? feed.getBoundingClientRect() : null;
    const floor = (left, low) => fr && fr.height && (fr.left + fr.width / 2 < W / 2) === left && fr.top > H / 2 ? Math.min(low, fr.top - 8) : low;
    spots.bl = [inL, floor(true, H - 46) - h];
    spots.br = [W - inR - w, floor(false, H - 34) - h];
    for (const k of Object.keys(spots)) spots[k] = [Math.max(4, Math.min(W - w - 4, spots[k][0])), Math.max(4, Math.min(H - h - 4, spots[k][1]))];
    return spots;
  }
  // Put down anywhere: on a grid of GRID pixels, or on the edge of the screen or of a panel when let go within PULL of
  // one. Kept as where its top left corner is, as a share of the window's width and height (0 to 1, v: 2): it stays
  // put when what's in it makes it taller or shorter, and moves with the window when that changes size.
  const GRID = 20, PULL = 14;
  function snapPanel(pane, x, y) {
    const w = pane.offsetWidth, h = pane.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    const xs = [8, W - w - 8], ys = [Math.round($('bar').getBoundingClientRect().bottom + 8), H - h - 34];
    for (const el of [$('side'), $('panel'), $('killFeed'), $('squadPane')]) {
      if (!el || el === pane || el.hidden || document.body.classList.contains('bare')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      xs.push(r.right + 8, r.left - 8 - w, r.left, r.right - w);
      ys.push(r.top, r.bottom - h, r.top - 8 - h, r.bottom + 8);
    }
    const pick = (v, lines) => {
      let best = null;
      for (const l of lines) if (Math.abs(l - v) <= PULL && (best === null || Math.abs(l - v) < Math.abs(best - v))) best = l;
      return best !== null ? best : Math.round(v / GRID) * GRID;
    };
    return [Math.max(4, Math.min(W - w - 4, pick(x, xs))), Math.max(4, Math.min(H - h - 4, pick(y, ys)))];
  }
  function placeEvents(pane) {
    const p = prefs.eventsPos;
    if (p && typeof p === 'object' && p.v === 2 && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const w = pane.offsetWidth, W = window.innerWidth, H = window.innerHeight;
      // its top stays where it was put; when there's not room below for all of it, its list scrolls instead
      const top = Math.round(Math.max(4, Math.min(H - 120, p.y * H)));
      pane.style.left = Math.round(Math.max(4, Math.min(W - w - 4, p.x * W))) + 'px';
      pane.style.top = top + 'px';
      pane.style.right = 'auto';
      pane.style.maxHeight = Math.min(480, H - top - 8) + 'px';
      return;
    }
    pane.style.maxHeight = '';
    const spots = eventsSpots(pane);
    const at = spots[p] || spots.auto || spots.tl;
    pane.style.left = Math.round(at[0]) + 'px';
    pane.style.top = Math.round(at[1]) + 'px';
    pane.style.right = 'auto';
  }
  // A panel picked up by its head and put down somewhere else: it follows the pointer once moved a few pixels (less is
  // a press, left alone), and on letting go drop(x, y) is told where its top left corner was let go, to snap it into a
  // place of its own. A press that moved it isn't also taken as a press of what's under it. Not on a phone, where every
  // panel has its one place.
  // snap(x, y), when given: where the panel would stand for a top left corner there, shown while it's moved (on a grid
  // drawn faintly over the map meanwhile)
  function draggable(handle, box, drop, snap) {
    handle.classList.add('dragHandle');
    handle.addEventListener('pointerdown', e => {
      if (phone.matches || e.button !== 0 || e.target.closest('input, select, #sideClose, #squadClose, #panelClose, #killClose')) return;
      const start = box.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      let moved = false;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) {
          moved = true;
          box.classList.add('panelMoving');
          if (snap) document.body.classList.add('gridOn');
          try { window.getSelection().removeAllRanges(); } catch (err) { /* none */ }
          try { handle.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
        }
        const at = snap ? snap(start.left + dx, start.top + dy) : null;
        box.style.transform = 'translate(' + (at ? at[0] - start.left : dx) + 'px, ' + (at ? at[1] - start.top : dy) + 'px)';
      };
      const up = ev => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!moved) return;
        box.classList.remove('panelMoving');
        document.body.classList.remove('gridOn');
        box.style.transform = '';
        // the click that follows letting go is the drag's, not a press
        const eat = c => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
        drop(start.left + ev.clientX - x0, start.top + ev.clientY - y0, start);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }
  // The Raid list and the menu: let go on the other half of the screen, the two swap sides (as Settings > Layout does)
  function swapByDrag(box) {
    return (x, y, start) => {
      const W = window.innerWidth, was = start.left + start.width / 2 < W / 2, now = x + start.width / 2 < W / 2;
      if (was === now) return;
      prefs.swap = !prefs.swap;
      $('optSwap').checked = prefs.swap;
      save(); sidesNow(); keepOnMap(); dirty = true;
      squadPanePrint = ''; showSquadPane();
    };
  }
  draggable($('sideHead'), $('side'), swapByDrag($('side')));
  draggable($('panelHead'), $('panel'), swapByDrag($('panel')));
  function showSquadPane() {
    let pane = $('squadPane'), button = $('squadBtn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'squadBtn';
      button.type = 'button';
      button.textContent = T('Events');
      button.title = T('What has happened in the raid, in a panel beside this list: what squads did together (COMET), what was picked up, and what ORBIT\'s ghosts did.');
      button.onclick = () => { prefs.squadPane = !prefs.squadPane; save(); squadPanePrint = ''; showSquadPane(); };
      $('sideSort').before(button);
      pane = document.createElement('aside');
      pane.id = 'squadPane';
      pane.className = 'ui';
      pane.innerHTML = '<div id="squadHead"><b>' + T('Raid events') + '</b><button id="squadClose" type="button" aria-label="' + T('Close') + '">×</button></div><div class="seg" id="squadKinds"></div><div id="squadBody"></div>';
      document.body.appendChild(pane);
      segment($('squadKinds'), EVENT_KINDS, kind => { prefs.eventsKind = kind; save(); squadPanePrint = ''; showSquadPane(); });
      $('squadClose').onclick = () => { prefs.squadPane = false; save(); squadPanePrint = ''; showSquadPane(); };
      // picked up by its title: put down in the nearest of its places; its title pressed twice, back beside the Raid list
      draggable($('squadHead'), pane, (x, y) => {
        const at = snapPanel(pane, x, y), W = window.innerWidth, H = window.innerHeight;
        prefs.eventsPos = { x: at[0] / W, y: at[1] / H, v: 2 };
        save(); placeEvents(pane);
      }, (x, y) => snapPanel(pane, x, y));
      $('squadHead').ondblclick = e => { if (e.target.closest('button')) return; prefs.eventsPos = 'auto'; save(); placeEvents(pane); };
    }
    // there in every raid, so it's always where it was, though nothing may have happened yet
    const can = !phone.matches && inRaid();
    button.hidden = !can;
    button.classList.toggle('on', can && !!prefs.squadPane);
    // only beside a Raid list that lists somebody (a group folded away still counts): with nobody in it, nor is this
    const open = can && !!prefs.squadPane && !$('side').hidden && !!$('roster').querySelector('.sideRow, .filterHead.fold');
    pane.hidden = !open;
    if (!open) return;
    // the tabs of a mod this game hasn't (or that's switched off) are left out; one left on such a tab sees All
    const tabOk = v => v === 'tactic' || v === 'squad' ? modOn('COMET') : v === 'orbit' ? modOn('ORBIT') : true;
    for (const b of $('squadKinds').children) b.hidden = !tabOk(b.dataset.v);
    // (the tab picked is kept, so it's back once the mod is: before the game has said which mods it has, say)
    const kind = tabOk(prefs.eventsKind) ? prefs.eventsKind : 'all';
    placeEvents(pane);
    if (kind === 'tactic') { showTactic(); return; }
    const listed = squadEvents.concat(otherEvents).filter(e => eventListed(e, kind)).sort((a, b) => a.n - b.n).slice(-80).reverse();
    const print = kind + '|' + listed.length + '|' + (listed.length ? listed[0].n : 0) + '|' + (things ? 1 : 0);
    if (print === squadPanePrint) return;
    squadPanePrint = print;
    for (const b of $('squadKinds').children) b.classList.toggle('on', b.dataset.v === kind);
    const body = $('squadBody');
    body.textContent = '';
    for (const e of listed) body.appendChild(squadRow(e));
    if (!listed.length) body.textContent = T('Nothing of this kind yet.');
  }
  function squadLog(box) {
    showSquadPane();
    if (!phone.matches || prefs.areaKinds.includes('Enemy Player')) return;
    if (!modOn('COMET') || !squadEvents.length) return;
    const log = document.createElement('details');
    log.className = 'squadLog';
    log.open = squadLogOpen;
    log.ontoggle = () => { squadLogOpen = log.open; };
    const head = document.createElement('summary');
    head.textContent = T('Squad events') + ' · ' + squadEvents.length;
    head.title = T('What COMET had squads doing together, as it changed. Time is since the raid was first seen.');
    log.appendChild(head);
    for (const e of squadEvents.slice(-12).reverse()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'squadEvent';
      const when = document.createElement('time'), who = document.createElement('b'), what = document.createElement('span');
      when.textContent = raidClock(e.t || 0);
      who.textContent = e.nm ? latin(e.nm) : T('A bot');
      what.textContent = squadSaid(e.d);
      row.append(when, who, what);
      row.title = who.textContent + '\n' + what.textContent;
      row.onclick = () => {
        const m = live.find(x => x.pid === e.p && x.c !== 'Corpse');
        if (m && inRaidHere()) { goTo(m.cx, m.cy); chase(m.id); }
      };
      log.appendChild(row);
    }
    box.appendChild(log);
  }
  // The raid's best loot: the dozen things worth the most, of what the page shows (loose loot, containers, and the
  // bodies whose loot it shows). Pressing one goes there.
  function listBest() {
    $('bestRealBox').hidden = !lootReal() || !inRaidHere();
    $('bestCanBox').hidden = !lootCan();
    $('bestNone').hidden = !($('bestRealBox').hidden && $('bestCanBox').hidden);
    if ($('panel').hidden || tab !== 'loot') return;
    listBestCan();
    if (!lootReal()) return;
    const loot = inRaidHere() && things && things.loc === map.loc ? things : null;
    const shownPlaces = map && places && places.loc === map.loc ? places : null;
    const flags = ['Layer loose', 'Layer boxes', 'Layer bodies', 'Corpse'].map(isHidden).join('') + prefs.allCorpses;
    const print = [!!loot, thingsHave, !!shownPlaces, map && map.loc, flags, live.filter(m => m.c === 'Corpse').length, prefs.bestMore, peeking(), prefs.loot, prefs.lootOff.join(',')].join('|');
    if (print === bestPrint) return;
    bestPrint = print;
    const box = $('bestLoot');
    box.textContent = '';
    if (!loot) { box.textContent = inRaid() ? T('Nothing known of this raid\'s loot yet.') : T('Not in a raid.'); return; }
    const names = Object.assign({}, quests ? quests.names : {}, shownPlaces ? shownPlaces.names : {}, loot.names);
    const nameOf = tpl => (names[tpl] || {}).s || (names[tpl] || {}).n || tpl;
    const worthOf = (tpl, n) => ((names[tpl] || {}).p || 0) * (n || 1);
    // what a container or a body holds: its worth, and the dearest thing in it
    const held = id => {
      const items = (loot.inside[id] || []).filter(i => kindOn(names, i[0]));
      let total = 0, top = null, most = -1;
      for (const i of items) {
        const w = worthOf(i[0], i[1]);
        total += w;
        if (w > most) { most = w; top = i[0]; }
      }
      return { total, top, more: items.length - 1 };
    };
    const found = [];
    if (!isHidden('Layer loose')) {
      for (const it of loot.loose) if (!it.q && it.worth > 0 && kindOn(names, it.tpl)) found.push({ worth: it.worth, text: nameOf(it.tpl) + (it.n > 1 ? ' ×' + it.n : ''), note: T('Loose'), p: [it.x, it.y] });
    }
    // what's in containers and on bodies, only when it may be known
    if (!isHidden('Layer boxes') && shownPlaces && peeking()) {
      for (const b of shownPlaces.boxes) {
        if (boxHidden(b)) continue;
        if (loot.have && !loot.have.has(b.id)) continue;
        const h = held(b.id);
        if (h.total > 0) found.push({ worth: h.total, text: nameOf(h.top) + (h.more > 0 ? ' +' + h.more : ''), note: (names[b.tpl] || {}).n || T('Container'), p: b.p });
      }
    }
    if (!isHidden('Layer bodies') && !isHidden('Corpse') && peeking()) {
      for (const b of loot.bodies) {
        if (!b.kp && !prefs.allCorpses) continue;
        const h = held(b.id);
        if (h.total > 0) found.push({ worth: h.total, text: nameOf(h.top) + (h.more > 0 ? ' +' + h.more : ''), note: b.who || T('A body'), p: b.p });
      }
    }
    found.sort((a, b) => b.worth - a.worth);
    if (!found.length) { box.textContent = T('Nothing of worth is shown. See Kinds of loot and More, below.'); return; }
    const most = prefs.bestMore ? 30 : 12;
    for (const it of found.slice(0, most)) {
      const row = sideRow(it.text, roubles(it.worth), worthCol(it.worth), () => goTo(it.p[0], it.p[1]));
      row.title = it.note;
      row.querySelector('small').style.color = worthCol(it.worth);
      box.appendChild(row);
    }
    if (found.length > 12) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'moreBtn';
      more.textContent = prefs.bestMore ? T('Show fewer') : T('Show more') + ' (' + Math.min(30, found.length) + ')';
      more.onclick = () => { prefs.bestMore = !prefs.bestMore; save(); listBest(); };
      box.appendChild(more);
    }
  }
  // The best that can spawn on this map: the dearest things its spawn points can have, of the kinds shown. Pressing
  // one searches for it (every point that can spawn it is ringed) and goes to the nearest; again: the next.
  let bestCanPrint = null;
  const canNext = new Map();
  function listBestCan() {
    if (!lootCan()) return;
    const table = lootTable && map && lootTable.loc === map.loc ? lootTable : null;
    const print = [!!table, map && map.loc, prefs.lootOff.join(','), prefs.bestMore].join('|');
    if (print === bestCanPrint) return;
    bestCanPrint = print;
    const box = $('bestCan');
    box.textContent = '';
    if (!table) { box.textContent = map ? T('Nothing known yet of what can spawn on this map.') : T('No map.'); return; }
    const tn = table.names, by = new Map();
    for (const pt of table.points) {
      for (const i of pt.items) {
        if (!kindOn(tn, i[0])) continue;
        let e = by.get(i[0]);
        if (!e) by.set(i[0], e = { tpl: i[0], worth: (tn[i[0]] || {}).p || 0, spots: [], chance: 0 });
        e.spots.push([pt.x, pt.y]);
        e.chance = Math.max(e.chance, pt.chance * (+i[1] || 0));
      }
    }
    const found = [...by.values()].filter(e => e.worth > 0).sort((a, b) => b.worth - a.worth);
    if (!found.length) { box.textContent = T('Nothing of the kinds shown can spawn here. See Kinds of loot, below.'); return; }
    const most = prefs.bestMore ? 30 : 12;
    for (const e of found.slice(0, most)) {
      const full = (tn[e.tpl] || {}).n || e.tpl;
      const row = sideRow(((tn[e.tpl] || {}).s || full) + ' ×' + e.spots.length, roubles(e.worth), worthCol(e.worth), () => {
        $('find').value = full;
        setFind(full, true);
        findOpen = false;
        const mid = toMap(vw / 2, vh / 2);
        const order = e.spots.slice().sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]));
        let seen = canNext.get(e.tpl);
        if (!seen) canNext.set(e.tpl, seen = new Set());
        let spot = order.find(p => !seen.has(p[0] + ',' + p[1]));
        if (!spot) { seen.clear(); spot = order[0]; }
        seen.add(spot[0] + ',' + spot[1]);
        goTo(spot[0], spot[1]);
      });
      row.title = full + ': ' + TP(e.spots.length, 'can spawn at {n} point, at best in {p} of raids. Press: the nearest; again: the next.', 'can spawn at {n} points, at best in {p} of raids. Press: the nearest; again: the next.', { p: percent(e.chance) });
      row.querySelector('small').style.color = worthCol(e.worth);
      box.appendChild(row);
    }
    if (found.length > 12) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'moreBtn';
      more.textContent = prefs.bestMore ? T('Show fewer') : T('Show more') + ' (' + Math.min(30, found.length) + ')';
      more.onclick = () => { prefs.bestMore = !prefs.bestMore; save(); bestPrint = null; listBest(); };
      box.appendChild(more);
    }
  }
  // ---- the menu's tabs ----
  // Settings > On your phone: this PC's address on its network, as a code to scan and as text, asked of the server
  // each time the tab is opened (a router may have handed out another since). The QR code library (qrcode.js, MIT,
  // Kazuhiko Arase) is only loaded then.
  let phoneLib = null;
  function needQr() {
    if (window.qrcode) return Promise.resolve();
    return phoneLib || (phoneLib = new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'qrcode.js';
      s.onload = ok;
      s.onerror = () => { phoneLib = null; no(); };
      document.head.appendChild(s);
    }));
  }
  function drawPhoneCode(url) {
    $('phoneUrl').textContent = url;
    $('phoneCopy').textContent = T('Copy');
    needQr().then(() => {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      // dark squares on white, with the quiet border round it that phones need to find it
      const n = qr.getModuleCount(), cell = Math.max(3, Math.floor(168 / (n + 8)));
      const c = document.createElement('canvas');
      c.width = c.height = (n + 8) * cell;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + 4) * cell, (r + 4) * cell, cell, cell);
      $('phoneCode').textContent = '';
      $('phoneCode').appendChild(c);
    }, () => { $('phoneCode').textContent = ''; });
  }
  async function showPhone() {
    // on a phone already: nothing to show
    $('phoneBox').closest('details').hidden = phone.matches;
    if (phone.matches) return;
    let lan;
    try { lan = await (await fetch('api/lan')).json(); } catch (e) { return; }
    const page = location.pathname.replace(/[^/]*$/, '');
    const addrs = Array.isArray(lan.addrs) ? lan.addrs.slice() : [];
    // Opened at an address other than this PC's own (a friend's game, playing with Fika over the internet, opens it at
    // the host's address): that address first, since it's the one that reaches the server from where they are.
    const here = location.hostname;
    const local = /^(127\.|localhost$|::1$|\[::1\]$)/i.test(here);
    if (!local) { const k = addrs.indexOf(here); if (k >= 0) addrs.splice(k, 1); addrs.unshift(here); }
    const open = lan.open || !local;
    // blurred until pressed, every time: an address isn't left showing on a stream or a screenshot
    $('phoneBox').classList.add('veiled');
    $('phoneShut').hidden = open;
    $('phoneNone').hidden = !open || addrs.length > 0;
    $('phoneBox').hidden = !open || !addrs.length;
    if (!open || !addrs.length) return;
    const urlOf = a => 'https://' + (a.includes(':') && !a.startsWith('[') ? '[' + a + ']' : a) + ':' + (location.port || lan.port || 6969) + page;
    drawPhoneCode(urlOf(addrs[0]));
    // more than one network (wired and Wi-Fi, say): each can be picked
    const others = $('phoneOthers');
    others.textContent = '';
    if (addrs.length > 1) {
      for (const a of addrs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linkBtn';
        b.textContent = a;
        b.onclick = () => drawPhoneCode(urlOf(a));
        others.appendChild(b);
      }
    }
  }
  $('phoneVeil').onclick = () => $('phoneBox').classList.remove('veiled');
  $('phoneCopy').onclick = () => {
    const text = $('phoneUrl').textContent;
    const done = () => { $('phoneCopy').textContent = T('Copied'); };
    try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) { /* not allowed here */ }
  };
  function showTab(name, remember) {
    tab = TABS.includes(name) ? name : 'raid';
    if (tab === 'settings') showPhone();
    for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
    for (const part of $('panelBody').children) part.hidden = part.dataset.tab !== tab;
    $('panelBody').scrollTop = 0;
    rosterPrint = bestPrint = bestCanPrint = null;
    if (remember !== false) { prefs.tab = tab; save(); }
    listRoster();
    listBest();
  }
  // The Raid list beside the map: shown or not, and remembered
  function toggleSide(on, remember) {
    $('side').hidden = on === undefined ? !$('side').hidden : !on;
    $('listBtn').classList.toggle('on', !$('side').hidden);
    rosterPrint = null;
    if (remember !== false) { prefs.side = !$('side').hidden; save(); }
    sidesNow();
    listRoster();
  }
  // Which side has something open, for what sits in the bottom corners: the Raid list is on the left and the menu
  // on the right, or the other way round when they're swapped
  function sidesNow() {
    const menu = !$('panel').hidden, list = !phone.matches && !$('side').hidden, swap = !!prefs.swap && !phone.matches;
    const left = swap ? (menu ? $('panel') : null) : (list ? $('side') : null);
    document.body.classList.toggle('swap', !!prefs.swap);
    document.body.classList.toggle('rightOn', swap ? list : menu);
    // the scale and the pointer's place stand in the bottom left corner, moved clear of the panel on that side only
    // when the panel comes down that far (a short Raid list doesn't)
    const low = left && left.getBoundingClientRect().bottom > window.innerHeight - 70;
    document.body.style.setProperty('--left-cover', (low ? left.offsetWidth + 8 : 0) + 'px');
  }
  // a tab's key: opens the menu on it; pressed again, shuts the menu
  function openTab(name) {
    if (!$('panel').hidden && tab === name) { togglePanel(false); return; }
    showTab(name);
    togglePanel(true);
  }
  // what the menu covers of a phone's screen (it's beside the map on a bigger one)
  function measureCover() {
    const p = $('panel');
    const next = p.hidden || !phone.matches ? { r: 0, b: 0 }
      : window.innerWidth <= 700 ? { r: 0, b: Math.min(p.offsetHeight, vh * 0.6) } : { r: Math.min(p.offsetWidth, vw * 0.6), b: 0 };
    if (next.r === cover.r && next.b === cover.b) return;
    cover = next;
    document.body.style.setProperty('--cover-b', next.b + 'px');
    document.body.style.setProperty('--cover-r', next.r + 'px');
    dirty = true;
  }
  // On a phone the lists of maps and players, and the buttons not needed all the time, are in the menu's Map tab;
  // otherwise along the top.
  function placeQuick() {
    const bar = $('bar'), quick = $('quick');
    // the Raid list: in the menu's Raid tab on a phone, otherwise in its own panel beside the map
    const home = phone.matches ? $('panelBody').querySelector('section[data-tab="raid"]') : $('sideBody');
    if ($('roster').parentNode !== home) { home.prepend($('rosterTools'), $('roster')); rosterPrint = null; }
    // its buttons (Events, Nearest): in the panel's title bar beside the map, so the counts have the whole width;
    // on a phone, beside the counts in the menu
    const tools = phone.matches ? $('rosterTools') : $('sideHead');
    for (const id of ['squadBtn', 'sideSort']) {
      const el = $(id);
      if (!el || el.parentNode === tools) continue;
      if (phone.matches) tools.appendChild(el); else tools.insertBefore(el, $('sideClose'));
    }
    for (const id of ['session', 'map', 'fit', 'reveal', 'full', 'langBox']) {
      const el = $(id);
      if (phone.matches) { if (el.parentNode !== quick) quick.appendChild(el); }
      else if (el.parentNode !== bar) bar.insertBefore(el, id === 'session' || id === 'map' ? $('findBox') : $('options'));
    }
  }
  // The language picker: each language by its own name. Picking one keeps it and starts the page again in it (every
  // word the page has written so far was written in the old one).
  {
    const pick = $('lang');
    for (const [value, name] of window.fumsLangs.list) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = name;
      pick.appendChild(o);
    }
    pick.value = window.fumsLangs.code;
    $('langCode').textContent = '🌐 ' + window.fumsLangs.code.toUpperCase();
    pick.onchange = () => {
      prefs.lang = pick.value;
      save();
      const url = new URL(location.href);
      url.searchParams.delete('lang');
      again(() => location.replace(url.href));
    };
  }
  // The menu's tabs, on one line whatever the language: their words a little smaller while they don't fit (looked at
  // whenever the row changes size, so also when the menu is first opened)
  {
    const nav = $('tabs');
    const fit = () => {
      if (!nav.clientWidth) return;
      for (const b of nav.children) b.style.fontSize = b.style.letterSpacing = '';
      let px = 11.5;
      while (nav.scrollWidth > nav.clientWidth + 1 && px > 8) {
        px -= 0.5;
        for (const b of nav.children) { b.style.fontSize = px + 'px'; b.style.letterSpacing = '0.02em'; }
      }
    };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(nav);
  }
  // a row of buttons of which one is on: [[value, words, what it means]]
  function segment(box, options, pick) {
    box.textContent = '';
    for (const [value, text, title] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = T(text);
      b.title = title ? T(title) : '';
      b.dataset.v = value;
      b.onclick = () => pick(value);
      box.appendChild(b);
    }
  }
  const LOOT_MODES = [
    ['real', 'What\'s there', 'In a raid: the loot that\'s really there, loose, in containers and on bodies. No spawn points, no chances.'],
    ['can', 'What can spawn', 'In a raid: where loot can spawn and what, with its chances. Never what\'s really there.'],
    ['both', 'Both', 'In a raid: what\'s really there, and every point loot can spawn at.'],
    ['off', 'None', 'No loot on the map, in a raid or out of one.']];
  const LOOT_IDLE = T('Not in a raid on this map, so it shows what can spawn here.') + ' ';
  function setLoot(mode) {
    prefs.loot = mode;
    save();
    rosterPrint = bestPrint = bestCanPrint = null;
    tipFor = null;
    dirty = true;
    loadSpawns();
    showModes();
    listBest();
  }
  function showModes() {
    for (const b of $('lootMode').children) b.classList.toggle('on', b.dataset.v === prefs.loot);
    const says = (prefs.loot !== 'off' && !inRaidHere() ? LOOT_IDLE : '') + T((LOOT_MODES.find(m => m[0] === prefs.loot) || [])[2] || '');
    if ($('lootModeSays').textContent !== says) $('lootModeSays').textContent = says;
  }

  function showStatus() {
    const box = $('status'), text = $('statusText');
    const who = prefs.player ? gameName(prefs.player) : (games.find(g => g.sid === sid) || {}).name || '';
    let kind = 'gone', says = prefs.player ? T('{who} isn\'t playing', { who }) : T('Game not connected');
    if (serverLost) says = T('Server not reachable');
    else if (connected()) {
      kind = report.raid ? 'raid' : 'menu';
      says = report.raid ? T('In raid') + ' · ' + placeName(report.loc) : T('Not in a raid');
      if (who) says = who + ' · ' + says;
    }
    if (text.textContent !== says) text.textContent = says;
    box.className = kind;
    // looking at another map than the raid's: a way straight back (the status pressed does the same)
    const away = awayFromRaid();
    $('backRaid').hidden = !away;
    box.classList.toggle('away', away);

    // what stands in the way of a map, if anything
    const notice = $('notice');
    let message = '', soft = true;
    const raidMap = inRaid() ? mapFor(report.loc) : null;
    const capturing = !!(report && report.cap && report.cap[1] > 0);
    // (the maps come with the mod and in add-ons: one that isn't installed is on the Forge, or can be asked for there)
    // An add-on there is but isn't installed is named, with its zip; a map no add-on has is said to be unknown.
    // warn: the notice is about an add-on (or a version) the player can do something about, and is drawn so
    let missing = '', warn = false, warned = false;
    if (inRaid()) {
      const addon = addonFor(report.loc), here = placeName(report.loc);
      if (addon) {
        warn = true;
        missing = T('Add-on needed for {map}: get "{zip}" from the Satellite page on the Forge and extract it into your SPT folder. The map shows within a few seconds, no restart needed.', { map: here, zip: addon.zip || 'Satellite add-on' });
      } else if (unknownVersion(report.loc)) {
        warn = true;
        missing = T('This version of {map} (from another mod) has no Satellite map yet, and no add-on has one. Ask for it on the Satellite page on the Forge.', { map: locationName(baseOf(report.loc)) });
      } else {
        missing = T('Map not detected for {map}. Check the Forge for a Satellite add-on with it, or ask for it there if there isn\'t one.', { map: here });
      }
    }
    if (inRaid() && !raidMap) {
      soft = false;
      message = capturing ? T('Capturing the map of {map}…', { map: placeName(report.loc) }) + ' ' + Math.round(100 * report.cap[0] / report.cap[1]) + '%' : missing;
      warned = warn && !capturing;
    } else if (raidMap && raidMap.loc !== report.loc && !capturing) {
      message = missing + ' ' + (addonFor(report.loc) ? T('Showing {map} until then: markers may not line up with it.', { map: raidMap.name }) : T('Showing {map} instead: markers may not line up with it.', { map: raidMap.name }));
      warned = warn;
    } else if (inRaid() && report.cap && report.cap[1] > 0) {
      message = T('Capturing the map again…') + ' ' + Math.round(100 * report.cap[0] / report.cap[1]) + '%';
    } else if (!maps.length && mapsAsked) {
      soft = false;
      message = T('No maps yet. Start a raid with the game plugin installed: it captures the location\'s map a few seconds in, and the map shows here.');
    }
    notice.hidden = !message;
    notice.className = [soft ? 'soft' : '', warned ? 'warn' : ''].filter(Boolean).join(' ');
    if (notice.textContent !== message) notice.textContent = message;

    const player = me && inRaidHere() ? T('Player:') + ' ' + me.x.toFixed(1) + ' ' + me.y.toFixed(1) + ' · ' + T('height') + ' ' + me.z.toFixed(1) : '';
    if ($('playerAt').textContent !== player) $('playerAt').textContent = player;
    $('follow').classList.toggle('on', following() && inRaidHere());
    $('follow').classList.toggle('paused', prefs.follow && roaming && inRaidHere());
    $('follow').disabled = !inRaidHere();
    $('follow').title = inRaidHere() ? (prefs.follow && roaming ? T('Set aside while you look about: it follows the player again once they move on, or press (;)') : T('Keep the player in the middle (;)')) : T('Follows the player once they\'re in a raid on this map');
    $('map').hidden = !maps.length;
    listFilters();
    loadQuests(false);
    listQuests();
    listRoster();
    listBest();
    showModes();
  }

  // ---- the page's own switches ---------------------------------------------------------------------------------
  function setFollow(on) {
    roaming = false;
    chase(null);
    roamFrom = null;
    dirty = true;
    if (prefs.follow === on) return;
    prefs.follow = on;
    $('optFollow').checked = on;
    save();
  }
  // shows a spot: the map moves there, close enough to see it, and the spot is ringed for a moment
  function goTo(x, y) {
    chase(null);
    roam();
    // gone to on purpose: the player moving on doesn't take the map back by itself
    roamFrom = null;
    zoom = zoomTarget = Math.min(zoomMax, Math.max(zoomTarget, Math.min(vw, vh) / 60));
    zoomAt = null;
    centreOn(x, y);
    flash = { x, y, at: performance.now() };
  }
  function togglePanel(on, remember) {
    $('panel').hidden = on === undefined ? !$('panel').hidden : !on;
    $('options').classList.toggle('on', !$('panel').hidden);
    document.body.classList.toggle('menu', !$('panel').hidden);
    rosterPrint = bestPrint = bestCanPrint = null;
    if (remember !== false) { prefs.panel = !$('panel').hidden; save(); }
    sidesNow();
    measureCover();
    dirty = true;
  }
  function fullScreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => { });
  }

  // ---- every frame ---------------------------------------------------------------------------------------------
  // ---- keeping the screen on ------------------------------------------------------------------------------------
  // The browser is asked for it while the page is in front and "Keep the screen on" is set; it takes it back by
  // itself when the page is put away, so it's asked for again when the page comes back.
  let awake = null, awakeSays = 'no', awakeAsking = false;
  async function keepAwake() {
    if (!prefs.awake || document.visibilityState !== 'visible') {
      const held = awake;
      awake = null;
      awakeSays = prefs.awake ? 'no' : 'switched off';
      if (held) { try { await held.release(); } catch (e) { /* gone already */ } }
      return;
    }
    if (awake || awakeAsking) return;
    if (!navigator.wakeLock) { awakeSays = 'this browser can\'t' + (window.isSecureContext ? '' : ' (page not secure)'); return; }
    awakeAsking = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (awake === lock) { awake = null; awakeSays = 'no'; } });
      awake = lock;
      awakeSays = 'yes';
      // (put away, or switched off, while it was being asked for)
      if (!prefs.awake || document.visibilityState !== 'visible') keepAwake();
    } catch (e) {
      awakeSays = 'refused (' + e.name + ')';
    }
    awakeAsking = false;
  }
  document.addEventListener('visibilitychange', keepAwake);
  // (a browser that wants the page touched first: asked again at the first press, and after any refusal)
  window.addEventListener('pointerdown', keepAwake, { passive: true });
  keepAwake();

  // ---- speed numbers ("Show speed numbers") ---------------------------------------------------------------------
  // Once a second: frames drawn, the longest wait between two, how long the page worked on a frame (mean and most),
  // and the game's reports: how many came and the longest wait between two.
  const speed = { el: null, at: 0, lastFrame: 0, frames: 0, worst: 0, work: 0, workMost: 0, drawn: 0, heardAt: 0, gaps: 0, gapMost: 0 };
  function speedHeard(now) {
    if (speed.heardAt) {
      speed.gaps++;
      speed.gapMost = Math.max(speed.gapMost, now - speed.heardAt);
    }
    speed.heardAt = now;
  }
  function speedFrame(now, began, drew) {
    if (!prefs.speed) {
      if (speed.el && !speed.el.hidden) speed.el.hidden = true;
      speed.at = 0;
      return;
    }
    const worked = performance.now() - began;
    if (speed.lastFrame) speed.worst = Math.max(speed.worst, now - speed.lastFrame);
    speed.lastFrame = now;
    speed.frames++;
    speed.work += worked;
    speed.workMost = Math.max(speed.workMost, worked);
    if (drew) speed.drawn++;
    if (!speed.at) speed.at = now;
    if (now - speed.at < 1000) return;
    const secs = (now - speed.at) / 1000;
    if (!speed.el) {
      speed.el = document.createElement('div');
      speed.el.id = 'speedLine';
      document.body.appendChild(speed.el);
    }
    speed.el.hidden = false;
    speed.el.textContent = Math.round(speed.frames / secs) + ' frames/s (' + Math.round(speed.drawn / secs) + ' redrawn) · slowest ' + Math.round(speed.worst) + ' ms'
      + '\npage work ' + (speed.work / speed.frames).toFixed(1) + ' ms a frame · most ' + speed.workMost.toFixed(1) + ' ms'
      + '\nreports ' + Math.round(speed.gaps / secs) + '/s · longest wait ' + Math.round(speed.gapMost) + ' ms'
      + '\nscreen ' + vw + '×' + vh + ' ×' + (window.devicePixelRatio || 1).toFixed(2) + ' · drawn ×' + pixelRatio().toFixed(2)
      + '\n' + (live ? live.length : 0) + ' markers · ' + tiles.length + ' tiles · screen kept on: ' + awakeSays;
    speed.at = now;
    speed.frames = speed.drawn = speed.gaps = 0;
    speed.worst = speed.work = speed.workMost = speed.gapMost = 0;
  }

  let last = performance.now();
  let sinceStatus = 1;
  function frame(now) {
    const began = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (map) {
      const raidHere = inRaidHere();
      // Markers that move, and the player, go at a steady pace from where they were drawn when the game last
      // reported to where it said they are, and get there as the next report is due.
      const ease = 1 - Math.exp(-dt / 0.07);
      const clock = performance.now();
      const glide = (o, x, y) => {
        const far = Math.abs(x - o.fx) + Math.abs(y - o.fy) > 40;
        // (past 1: the next report is late, which a phone on Wi-Fi gets often; it goes on the way it went for up to
        // one more report's time, instead of standing still until it comes)
        const k = far ? 1 : Math.min(2, Math.max(0, (clock - o.t0) / (period * 1.1)));
        if (k > 1) dirty = true;
        o.cx = o.fx + (x - o.fx) * k;
        o.cy = o.fy + (y - o.fy) * k;
      };
      if (raidHere) {
        for (const m of live) {
          if (!m.dyn) continue;
          if (m.cx !== m.p[0] || m.cy !== m.p[1] || m.cr !== m.r) dirty = true;
          glide(m, m.p[0], m.p[1]);
          m.cz = m.p[2];
          m.cr += ((((m.r - m.cr) % 360) + 540) % 360 - 180) * ease;
        }
      }
      if (me && raidHere) {
        glide(me, me.x, me.y);
        me.cz = me.z;
      }

      // The floor shown, of one building: the one the player has been on for a moment; or the floor picked, of the
      // building the player is in (or, out of a raid, the one in the middle of the screen).
      const f = map.floors;
      let wantPlace = 0, wantN = 0;
      if (f) {
        const here = me && raidHere ? [me.x, me.y] : null;
        const shut = opened && !(f.buildings && f.buildings[opened - BUILDING]);
        if (shut) opened = 0;
        if (opened) {
          // pressed on: the floor picked, else the player's floor when they're in it, else its biggest
          const has = floorsOf(opened);
          const mine = here ? placeInside() : 0;
          wantPlace = opened;
          wantN = +prefs.floor > 0 ? has[Math.min(+prefs.floor, has.length) - 1]
            : (opened === mine ? buildingFloor(opened, me.x, me.y, me.z) : 0) || mainFloor(opened);
        } else if (prefs.floor === 'auto') {
          // only where the player is indoors (not under an awning or an arcade), see placeInside
          const mine = here ? placeInside() : 0;
          // a map with buildings goes by them, one without by its squares
          const myFloor = place => f.buildings ? buildingFloor(place, me.x, me.y, me.z) : floorOf(place, me.z);
          // looking about (not following, or no raid here): the building in the middle of the screen, once close
          // enough to make it out; on the player's floor when it's the one they're in, else its ground floor
          if (prefs.insideLook && (!here || !following()) && Math.min(vw, vh) / zoom <= prefs.lookSpan) {
            const mid = toMap(vw / 2, vh / 2);
            const place = f.buildings ? buildingAt(mid[0], mid[1]) : placeAt(mid[0], mid[1]);
            if (place) {
              wantPlace = place;
              wantN = (place === mine ? myFloor(place) : 0) || (f.buildings ? mainFloor(place) : 1);
            }
          }
          // the player's building pressed away (see pressed): the whole map until they leave it or press it again
          if (insideShut && insideShut !== mine) insideShut = 0;
          // or walk on: a few steps from where they stood when it was pressed away, and the inside is back
          if (insideShut && here && insideShutAt && Math.hypot(here[0] - insideShutAt[0], here[1] - insideShutAt[1]) > WALK_BACK) insideShut = 0;
          if (!wantPlace && mine && prefs.insideMine && insideShut !== mine) {
            wantN = myFloor(mine);
            wantPlace = wantN ? mine : 0;
          }
        } else if (+prefs.floor > 0) {
          const at = here || toMap(vw / 2, vh / 2);
          wantPlace = f.buildings ? buildingAt(at[0], at[1], here ? me.z : undefined) : placeAt(at[0], at[1]);
          // the floors it has, lowest first: the one picked, or its top one
          const has = !wantPlace ? null : floorsOf(wantPlace);
          wantN = has && has.length ? has[Math.min(+prefs.floor, has.length) - 1] : 0;
          if (!wantN) wantPlace = 0;
        }
      }
      // a floor stepped to with the arrows, while it's that building that's shown
      if (floorPick && floorPick.place !== wantPlace) floorPick = null;
      if (floorPick) wantN = floorPick.n;
      const key = wantPlace + ':' + wantN;
      if (key !== floorWantKey) { floorWantKey = key; floorSince = now; }
      if (key !== floorShown.place + ':' + floorShown.n && (prefs.floor !== 'auto' || now - floorSince > 150)) setFloor(wantPlace, wantN);
      if (DEBUG && now - debugAt > 250) {
        debugAt = now;
        const line = $('debugLine');
        line.hidden = false;
        if (!me || !raidHere || !f) {
          line.textContent = !f ? 'no floors grid for this map' : 'no player in a raid on this map';
        } else {
          const at = placeAt(me.x, me.y), near = placeNear(me.x, me.y);
          const levels = near ? f.levels[near - 1] : null;
          line.textContent = 'at ' + me.x.toFixed(1) + ', ' + me.y.toFixed(1) + '  height ' + me.z.toFixed(2)
            + '\ngame says: ' + (me.in === undefined ? '?' : me.in ? 'indoor' : 'OUTDOOR')
            + '   place here ' + at + '   near ' + near + '   levels ' + JSON.stringify(levels)
            + '\nfloor by height ' + floorOf(near, me.z) + '   wanted ' + key + '   shown ' + floorShown.place + ':' + floorShown.n
            + '   option ' + prefs.floor + (prefs.insideMine ? '' : '   ("show the inside of the building I\'m in" is off)');
          if (f.buildings) {
            const b = buildingAt(me.x, me.y, me.z);
            line.textContent += '\nbuilding ' + (b ? (b - BUILDING) + '   its floors ' + JSON.stringify(f.buildings[b - BUILDING].parts.map(p => [p.n, p.h, p.t]))
              + '   on floor ' + buildingFloor(b, me.x, me.y, me.z) : 'none here') + '   (' + f.buildings.length + ' on this map)';
          } else {
            line.textContent += '\nthis map has no buildings worked out; the squares are gone by';
          }
        }
      }

      // auto zoom: closer under a roof, wider in the open, once the player has been there a moment
      if (autoZooming()) {
        const under = !!me.in || !!placeInside();
        if (under !== stateWanted) { stateWanted = under; stateSince = now; }
        if (zoomState !== stateWanted && (zoomState === null || now - stateSince > 200)) {
          zoomState = stateWanted;
          zoomTarget = stateZoom(zoomState);
          zoomAt = null;
        }
      } else {
        zoomState = null;
      }

      const zooming = Math.abs(zoomTarget - zoom) > zoom * 0.0005;
      if (zooming) {
        const hold = zoomAt || [vw / 2, vh / 2];
        const under = toMap(hold[0], hold[1]);
        zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 10));
        const moved = toScreen(under[0], under[1]);
        panX += hold[0] - moved[0];
        panY += hold[1] - moved[1];
        dirty = true;
      } else if (zoom !== zoomTarget) {
        zoom = zoomTarget;
        dirty = true;
      }

      // set aside by a drag or by going to look at something, the map follows the player again once they have
      // walked on; somebody else being followed is kept in the middle instead
      // (walked: the player has gone on from where they were when the map was taken off them; a building pressed open
      // stays open until then, however long it's looked at)
      const walked = roamFrom && me && raidHere && Math.hypot(me.x - roamFrom[0], me.y - roamFrom[1]) > WALK_BACK;
      // (not by itself after a pause: standing still to look about the map, it kept being taken back)
      if (roaming && !dragging && walked) { roaming = false; roamFrom = null; zoomAt = null; opened = 0; dirty = true; backToPlayer(); }
      if (chased !== null) {
        const them = raidHere ? liveById.get(chased) : null;
        if (!them || !Number.isFinite(them.cx)) chase(null);
        else if (!dragging) centreOn(them.cx, them.cy);
      } else if (following() && me && raidHere && !dragging) centreOn(me.cx, me.cy);
      keepOnMap();
      // on whole screen pixels: a map moved by fractions of one shimmers as it goes. Not while it zooms: snapped to
      // a pixel at every size on the way, the picture would shake until the zoom settled.
      if (!zooming) {
        const pixel = pixelRatio();
        panX = Math.round(panX * pixel) / pixel;
        panY = Math.round(panY * pixel) / pixel;
      }
      layTiles();
      refreshTiles();
      layersEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')' + (turn ? ' rotate(' + -turn + 'deg)' : '');
    }

    sinceStatus += dt;
    if (sinceStatus > 0.25) {
      sinceStatus = 0;
      showStatus();
      dirty = true;
    }
    const drew = dirty;
    if (dirty) {
      dirty = false;
      draw();
    }
    speedFrame(now, began, drew);
    requestAnimationFrame(frame);
  }

  // ---- hands ---------------------------------------------------------------------------------------------------
  // A mouse drags the map and points by hovering. A finger drags it too, two fingers pinch it closer or further and
  // move it as they go, a tap points at what's under it (and the tip stays up until the next tap or drag), and a
  // double tap zooms in there.
  const fingers = new Map();
  let dragging = false;
  let pinch = 0;
  let pinchMid = null;
  let touching = false;
  let lastTap = null;
  // a finger has to move this far (pixels) before it's a drag rather than a tap
  const TAP_SLOP = 8;
  // and a mouse this far: a hand twitches as it presses, and a press isn't a drag
  const CLICK_SLOP = 4;
  let downAt = null;
  stage.addEventListener('pointerdown', e => {
    touching = e.pointerType !== 'mouse';
    stage.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size === 1) downAt = [e.clientX, e.clientY];
    pinch = 0;
    pinchMid = null;
  });
  const startDrag = () => {
    if (dragging) return;
    dragging = true;
    stage.classList.add('dragging');
    // set aside first, so letting somebody else go doesn't take the map straight back to the player
    roam();
    chase(null);
    roamFrom = me ? [me.x, me.y] : null;
    zoomTarget = zoom;
    showTip(null);
    setHovered(0);
  };
  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') touching = false;
    const was = fingers.get(e.pointerId);
    if (!was) {
      // only pointing: not a hand on the map, which would keep it from going back to the player
      if (!touching) point(e.clientX, e.clientY);
      return;
    }
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size === 1) {
      // a finger wobbles: not a drag until it has gone a little way
      if (!dragging && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < (touching ? TAP_SLOP : CLICK_SLOP)) return;
      const dx = e.clientX - was[0], dy = e.clientY - was[1];
      startDrag();
      panX += dx;
      panY += dy;
      dirty = true;
    } else if (fingers.size === 2) {
      const [a, b] = [...fingers.values()];
      const apart = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      startDrag();
      if (pinch && pinchMid) {
        // The map grows or shrinks about the fingers' middle and follows it: the ground that was under the middle
        // is under it still, wherever the fingers have got to.
        const under = toMap(pinchMid[0], pinchMid[1]);
        zoomBy(apart / pinch, mid[0], mid[1]);
        zoom = zoomTarget;
        const moved = toScreen(under[0], under[1]);
        panX += mid[0] - moved[0];
        panY += mid[1] - moved[1];
        zoomAt = null;
        // A pinch also says how close the player is followed from now on (a mouse has Shift and the wheel for that):
        // the map comes back to them at this zoom, not the one before.
        if (prefs.follow && chased === null && me && inRaidHere()) {
          if (prefs.autoZoom && !prefs.keepZoom) {
            const inside = stateWanted !== null ? !!stateWanted : !!me.in;
            const key = inside ? 'spanIn' : 'spanOut';
            prefs[key] = clampSpan(Math.min(vw, vh) / zoomTarget, inside ? SPAN_IN : SPAN_OUT, prefs[key]);
            showSpans();
          } else followZoom = zoomTarget;
        }
        dirty = true;
      }
      pinch = apart;
      pinchMid = mid;
    }
  });
  // A press on the map that wasn't a drag. On the player's own marker: follow the player. On somebody else's, while
  // the player isn't being followed: follow them. On nothing: nobody else is followed any more.
  // a press on loot, a container or a lock that is on another floor of the building shown: that floor is shown
  const floorTo = (sx, sy) => {
    const place = floorShown.place;
    if (!(place >= BUILDING) || !floorShown.n) return false;
    const slack = touching ? 10 : 2;
    for (let i = thingsPut.length - 1; i >= 0; i--) {
      const t = thingsPut[i];
      if (Math.hypot(sx - t.x, sy - t.y) > t.r + slack || !Array.isArray(t.p)) continue;
      const n = buildingFloor(place, t.p[0], t.p[1], t.p[2]);
      if (!n || n === floorShown.n) return false;
      floorPick = { place, n };
      setFloor(place, n);
      return true;
    }
    return false;
  };
  const pressed = (sx, sy) => {
    const slack = touching ? 10 : 0;
    let mark = null;
    for (let i = drawn.length - 1; i >= 0 && !mark; i--) {
      const d = drawn[i];
      if (Math.abs(sx - d.x) <= d.w / 2 + slack && Math.abs(sy - d.y) <= d.h / 2 + slack) mark = d.m;
    }
    if (mark && mark.c === 'Main Player') setFollow(true);
    else if (mark && ROSTER.includes(mark.c)) chase(mark.id);
    else if (floorTo(sx, sy)) dirty = true;
    else {
      chase(null);
      // on a building: look inside it (pressed inside the one open, or the one shown anyway, nothing changes); off
      // every building: the one open is shut
      const at = toMap(sx, sy);
      const b = buildingAt(at[0], at[1]);
      // where there are no buildings to press, the roofed place of the map's squares
      const spot = b || (map && map.floors && !map.floors.buildings ? placeAt(at[0], at[1]) : 0);
      if (spot && spot === insideShut) insideShut = 0;
      else if (b && prefs.pressOpen && b !== opened && b !== floorShown.place) { opened = b; revealSet(false); roam(); roamFrom = me && inRaidHere() ? [me.x, me.y] : null; }
      else if (!b && opened) opened = 0;
      // off the building the player is in, while its inside is shown: the whole map again, not dimmed
      else if (spot !== floorShown.place && floorShown.place && floorShown.n && prefs.floor === 'auto') { insideShut = floorShown.place; insideShutAt = me && inRaidHere() ? [me.x, me.y] : null; }
      setHovered(0);
      dirty = true;
    }
  };
  // the building under the pointer that a press would open, outlined and greyed over (see drawHovered)
  function setHovered(b) {
    if (b === hovered) return;
    hovered = b;
    stage.classList.toggle('canOpen', !!b && prefs.pressOpen);
    dirty = true;
  }
  const lift = e => {
    if (!fingers.delete(e.pointerId)) return;
    if (!dragging && e.pointerType === 'mouse' && e.type === 'pointerup') pressed(e.clientX, e.clientY);
    if (!dragging && e.pointerType !== 'mouse') {
      const now = performance.now();
      if (lastTap && now - lastTap.at < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        // a double tap: in, about where it was
        lastTap = null;
        roam();
        zoomBy(2, e.clientX, e.clientY);
      } else {
        lastTap = { at: now, x: e.clientX, y: e.clientY };
        // a tap: point at what's under it, as a mouse does by hovering
        point(e.clientX, e.clientY);
        if (e.type === 'pointerup') pressed(e.clientX, e.clientY);
      }
    }
    // (one finger of two lifted: the other carries on dragging from where it is)
    if (!fingers.size) {
      dragging = false;
      stage.classList.remove('dragging');
    }
    pinch = 0;
    pinchMid = null;
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('pointerleave', e => {
    // a finger leaves when it lifts: what it tapped stays pointed at
    if (e.pointerType !== 'mouse') return;
    if (pointed !== null) { pointed = null; dirty = true; }
    setHovered(0);
    $('cursorAt').textContent = '';
    showTip(null);
  });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (!map) return;
    // the zoom the player is followed at is kept: zooming takes the map off them, about the pointer, and it goes back
    // to them (and that zoom) as they walk on. With Shift held (or + and -), it's that zoom that changes.
    if (!e.shiftKey && following() && chased === null && inRaidHere()) roam();
    const notches = (e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100) || (e.deltaMode === 1 ? e.deltaX / 3 : e.deltaX / 100);
    zoomBy(Math.pow(1.175, -notches), e.clientX, e.clientY);
  }, { passive: false });

  function point(sx, sy) {
    if (!map) return;
    const at = toMap(sx, sy);
    $('cursorAt').textContent = T('Cursor:') + ' ' + at[0].toFixed(1) + ' ' + at[1].toFixed(1);
    let found = null, mark = null;
    // a finger is wider than a mouse pointer: markers are found a little further off by touch
    const slack = touching ? 10 : 0;
    for (let i = drawn.length - 1; i >= 0; i--) {
      const d = drawn[i];
      if (Math.abs(sx - d.x) <= d.w / 2 + slack && Math.abs(sy - d.y) <= d.h / 2 + slack) { found = d.m.id; mark = d.m; break; }
    }
    if (found !== pointed) { pointed = found; dirty = true; }
    // a building (not on a marker): outlined, to be pressed open, unless it's the one shown
    const b = found === null && !dragging ? buildingAt(at[0], at[1]) : 0;
    setHovered(b && b !== floorShown.place ? b : 0);
    // a marker with something to say (a corpse's loot) says it; not a marker: the nearest container, lock, item or
    // spawn point under the pointer says what it is
    const says = mark ? mark.tip || dropTip(mark) || botTip(mark) : null;
    let near = says ? { tip: says } : null, best = Infinity;
    if (found === null) {
      for (const t of thingsDrawn) {
        const far = Math.hypot(sx - t.x, sy - t.y);
        if (far <= t.r + 4 + slack && far < best) { best = far; near = t; }
      }
    }
    showTip(near, sx, sy);
  }

  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 80;
    switch (e.key) {
      case ';': setFollow(true); break;
      case 'f': case 'F': fullScreen(); break;
      case 'h': case 'H': document.body.classList.toggle('bare'); break;
      case 'm': case 'M': togglePanel(); break;
      case 'p': case 'P': if (phone.matches) openTab('raid'); else toggleSide(); break;
      case 'l': case 'L': openTab('loot'); break;
      case 'q': case 'Q': openTab('quests'); break;
      case 'n': case 'N': setRosterNear(!prefs.rosterNear); break;
      case '/': $('find').focus(); $('find').select(); break;
      case '0': wholeMap(); break;
      case '=': case '+': zoomBy(1.4, vw / 2, vh / 2); break;
      case '-': case '_': zoomBy(1 / 1.4, vw / 2, vh / 2); break;
      case 'ArrowLeft': roam(); panX += step; dirty = true; break;
      case 'ArrowRight': roam(); panX -= step; dirty = true; break;
      case 'ArrowUp': roam(); panY += step; dirty = true; break;
      case 'ArrowDown': roam(); panY -= step; dirty = true; break;
      case 'b': case 'B': if (!e.repeat) revealDown(); break;
      case ']': case 'PageUp': stepFloor(1); break;
      case '[': case 'PageDown': stepFloor(-1); break;
      case 'Escape': if (opened) { opened = 0; dirty = true; } else if (find) { $('findClear').click(); } else togglePanel(false); break;
      default: return;
    }
    e.preventDefault();
  });

  function resized() {
    vw = stage.clientWidth || 1;
    vh = stage.clientHeight || 1;
    // the same share of the way between fully out and fully in
    const share = zoomMax > zoomMin ? (zoomTarget - zoomMin) / (zoomMax - zoomMin) : 0;
    setZoomLimits();
    zoom = zoomTarget = zoomMin + Math.min(1, Math.max(0, share)) * (zoomMax - zoomMin);
    dirty = true;
  }
  window.addEventListener('resize', resized);

  $('follow').onclick = () => setFollow(roaming ? true : !prefs.follow);
  $('fit').onclick = wholeMap;
  $('options').onclick = () => togglePanel();
  // the name in the top bar: opens Settings at its foot, where the version, credits and map licence are
  // (and the maker's line under the scale, bottom left)
  $('brand').onclick = $('credit').onclick = () => {
    showTab('settings');
    togglePanel(true);
    // Settings > About, where the credits are
    const about = document.querySelector('section[data-tab="settings"] nav.subTabs button[data-view="about"]');
    if (about) about.click();
    requestAnimationFrame(() => { const b = $('panelBody'); b.scrollTop = b.scrollHeight; });
  };
  $('panelClose').onclick = () => togglePanel(false);
  $('sideClose').onclick = () => toggleSide(false);
  $('listBtn').onclick = () => toggleSide();
  $('optSwap').checked = !!prefs.swap;
  $('optSwap').onchange = e => { prefs.swap = e.target.checked; save(); sidesNow(); keepOnMap(); dirty = true; };
  for (const b of $('tabs').children) b.onclick = () => showTab(b.dataset.tab);
  // a tab in parts (Loot: filters, best loot, legend): one part shown at a time, the one left open remembered
  for (const nav of document.querySelectorAll('nav.subTabs')) {
    const part = nav.parentNode, name = part.dataset.tab;
    const views = [...nav.children].map(b => b.dataset.view);
    const show = (view, remember) => {
      if (!views.includes(view)) view = views[0];
      for (const b of nav.children) b.classList.toggle('on', b.dataset.view === view);
      for (const v of part.querySelectorAll(':scope > .view')) v.hidden = v.dataset.view !== view;
      if (remember) { prefs.views = Object.assign({}, prefs.views, { [name]: view }); save(); $('panelBody').scrollTop = 0; }
    };
    for (const b of nav.children) b.onclick = () => show(b.dataset.view, true);
    show((prefs.views || {})[name]);
  }
  // the Loot tab's key: made from what the map is drawn by, so the two can't differ
  {
    const entry = (box, mark, text) => {
      const row = document.createElement('span');
      row.append(mark, document.createTextNode(text));
      box.appendChild(row);
    };
    const mark = (text, cls, col) => {
      const b = document.createElement('b');
      b.textContent = text;
      if (cls) b.className = cls;
      if (col) b.style.setProperty('--col', col);
      return b;
    };
    entry($('keyForms'), mark('', 'dot', '#7fd36b'), T('Loot lying there now'));
    entry($('keyForms'), mark('', 'ring', '#7fd36b'), T('Loot can spawn here'));
    // one of the map's pictures on its badge, for a key
    const picture = (glyph, form, rim) => {
      const c = badge(glyph, '#1a1a24', rim, SPAWN_INK, form, 22);
      const b = mark('', 'pic'), img = document.createElement('img');
      img.src = c.toDataURL();
      img.width = img.height = Math.round(c.width / (pixelRatio()));
      img.alt = '';
      b.appendChild(img);
      return b;
    };
    entry($('keyForms'), picture('i:boxCrate', 'square', '#7c7f8f'), T('Container'));
    entry($('keyForms'), picture('i:lock', 'hex', LAYERS.locks.col), T('Lock'));
    // the Map tab's key was written with emoji: each is swapped for the picture the map draws (an emoji may or may
    // not carry a variation selector, U+FE0F, so they're matched without it)
    const plain = text => text.replace(/️/g, '');
    const drawn = {};
    for (const [emoji, glyph, form, rim] of [
      ['💰', 'i:boxSafe'], ['💵', 'i:boxRegister'], ['🗄️', 'i:boxDrawer'], ['👜', 'i:boxBag'], ['🧥', 'i:boxJacket'],
      ['🔧', 'i:boxTools'], ['💻', 'i:boxPc'], ['💊', 'i:boxMed'], ['🔫', 'i:boxWeapon'], ['💣', 'i:boxGrenade'],
      ['🥫', 'i:boxFood'], ['⛏️', 'i:boxCache'], ['💀', 'i:boxBody'], ['📦', 'i:boxCrate'],
      ['🔒', 'i:lock', 'hex', LAYERS.locks.col], ['🚙', 'i:trunk', 'hex', LAYERS.locks.col], ['💳', 'i:keycard', 'hex', LAYERS.locks.col],
      ['🚏', 'i:stop', 'round', LAYERS.btrRoad.col]
    ]) drawn[plain(emoji)] = [glyph, form || 'square', rim || '#7c7f8f'];
    for (const b of document.querySelectorAll('.legend b')) {
      const d = drawn[plain(b.textContent)];
      if (d) b.replaceWith(picture(d[0], d[1], d[2]));
    }
    entry($('keyForms'), mark('!', 'quest'), T('Quest item'));
    entry($('keyForms'), mark('!', 'quest can'), T('Quest item can spawn'));
    const k = v => v >= 1000 ? (v / 1000) + 'k' : String(v);
    WORTH.forEach(([under, col], i) => {
      const from = i ? WORTH[i - 1][0] : 0;
      entry($('keyWorth'), mark('', 'dot', col), (under === Infinity ? T('Over {a}', { a: k(from) }) : !from ? T('Under {a}', { a: k(under) }) : T('{a} to {b}', { a: k(from), b: k(under) })) + ' ₽');
    });
    for (const kind of Object.keys(SPAWN_GLYPH)) {
      const b = picture(SPAWN_GLYPH[kind], 'round', '#8a8c9a');
      entry($('keyKinds'), b, spawnKindName(kind));
    }
  }
  segment($('lootMode'), LOOT_MODES, setLoot);
  // every list of switches has "All on", "All off" and "Default" over it. All on and All off leave the switches
  // under another one as they are; Default puts those back too (a switch starts off unless it says otherwise)
  {
    const both = (before, inputs, every) => {
      const head = document.createElement('div');
      head.className = 'filterHead';
      head.append(T('Switch') + ' ');
      for (const [text, on] of [[T('All on'), true], [T('All off'), false]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'linkBtn';
        button.textContent = text;
        button.onclick = () => { for (const input of inputs()) if (!input.disabled && input.checked !== on) input.click(); };
        head.append(button, ' ');
      }
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'linkBtn';
      back.textContent = T('Default');
      back.title = T('These switches back as they were the first time the page was opened');
      back.onclick = () => { for (const input of (every || inputs)()) if (!input.disabled && input.checked !== (input.dataset.def === '1')) input.click(); };
      head.append(back);
      before.before(head);
    };
    for (const id of ['boxKinds', 'filtersPeople', 'areaKinds', 'filtersMap', 'filtersLoot', 'alerts']) {
      both($(id), () => $(id).querySelectorAll(':scope > label.row:not(.sub) > input[type="checkbox"]'),
        () => $(id).querySelectorAll('label.row > input[type="checkbox"]'));
    }
    const feed = ['optFeedMine', 'optFeedPmc', 'optFeedBoss', 'optFeedAi'];
    for (const id of feed) $(id).dataset.def = '1';
    both($(feed[0]).closest('label'), () => feed.map(id => $(id)));
  }
  function setRosterNear(on) {
    prefs.rosterNear = on;
    $('sideSort').classList.toggle('on', on);
    save();
    rosterPrint = null;
    listRoster();
  }
  $('sideSort').classList.toggle('on', !!prefs.rosterNear);
  $('sideSort').onclick = () => setRosterNear(!prefs.rosterNear);
  // the one in the Raid list under the pointer (the rows are made again as the raid goes on, so the list is asked)
  $('roster').addEventListener('pointermove', e => {
    const row = e.target instanceof Element ? e.target.closest('.sideRow') : null;
    const id = row && row.dataset.id ? row.dataset.id : null;
    const found = id === null ? null : liveById.has(id) ? id : liveById.has(+id) ? +id : null;
    if (found !== rosterOver) { rosterOver = found; dirty = true; }
  });
  $('roster').addEventListener('pointerleave', () => { if (rosterOver !== null) { rosterOver = null; dirty = true; } });
  $('full').onclick = fullScreen;
  $('optFollow').checked = prefs.follow;
  $('optFollow').onchange = e => setFollow(e.target.checked);
  // one choice of three: auto zoom (autoZoom), the zoom put back after a look elsewhere, or never touched (keepZoom)
  {
    const sliders = () => { for (const id of ['optSpanIn', 'optSpanOut']) { const off = prefs.keepZoom || !prefs.autoZoom; $(id).disabled = off; $(id).closest('label').classList.toggle('unavailable', off); } };
    $('optZoomMode').value = prefs.keepZoom ? 'keep' : prefs.autoZoom ? 'auto' : 'back';
    $('optZoomMode').onchange = e => {
      prefs.keepZoom = e.target.value === 'keep';
      prefs.autoZoom = e.target.value === 'auto';
      followZoom = null;
      zoomState = null;
      save();
      sliders();
      dirty = true;
    };
    sliders();
  }
  $('optSpanIn').min = -SPAN_IN[1]; $('optSpanIn').max = -SPAN_IN[0];
  $('optSpanOut').min = -SPAN_OUT[1]; $('optSpanOut').max = -SPAN_OUT[0];
  showSpans();
  const spanChanged = (key, inside) => e => {
    prefs[key] = -e.target.value;
    showSpans();
    save();
    // seen at once while following in that state
    if (autoZooming() && zoomState === inside) { zoomTarget = stateZoom(inside); zoomAt = null; }
  };
  $('optSpanIn').oninput = spanChanged('spanIn', true);
  $('optSpanOut').oninput = spanChanged('spanOut', false);
  $('optWorth').value = String(prefs.worth);
  if ($('optWorth').value !== String(prefs.worth)) $('optWorth').value = '20000';
  $('optWorth').onchange = e => { prefs.worth = +e.target.value || 0; save(); dirty = true; };
  // which way up this map is: as the maps people know have it, or turned by hand (kept for each map)
  $('optTurn').onchange = e => {
    if (!map) return;
    prefs.turns = Object.assign({}, prefs.turns);
    if (e.target.value === 'auto') delete prefs.turns[map.loc]; else prefs.turns[map.loc] = +e.target.value;
    save();
    setTurn(turnFor(map.loc));
  };
  $('optNames').value = prefs.names;
  $('optNames').onchange = e => { prefs.names = e.target.value; save(); dirty = true; };
  // the slider runs from far to near, like the zoom ones
  $('optClose').min = -CLOSE_SPAN[1];
  $('optClose').max = -CLOSE_SPAN[0];
  const showClose = () => { $('optClose').value = -prefs.closeSpan; $('closeText').textContent = Math.round(prefs.closeSpan) + ' m'; };
  showClose();
  $('optClose').oninput = e => { prefs.closeSpan = -e.target.value; showClose(); save(); dirty = true; };
  // the options' groups open or shut as they were left
  for (const group of document.querySelectorAll('details.group[data-group]')) {
    const name = group.dataset.group;
    if (prefs.groups && typeof prefs.groups[name] === 'boolean') group.open = prefs.groups[name];
    group.addEventListener('toggle', () => { prefs.groups = Object.assign({}, prefs.groups, { [name]: group.open }); save(); });
  }
  for (const [id, key] of [['optItemNames', 'itemNames'], ['optMyQuestItems', 'myQuestItems'], ['optMyQuestPlaces', 'myQuestPlaces'],
    ['optInsideMine', 'insideMine'], ['optInsideLook', 'insideLook'], ['optPressOpen', 'pressOpen'], ['optEdge', 'edge'], ['optEdgeQuests', 'edgeQuests'], ['optMyName', 'myName'], ['optShots', 'shots'], ['optHealth', 'health'], ['optFeed', 'feed'], ['optPhoneLight', 'phoneLight'], ['optAwake', 'awake'], ['optSpeed', 'speed'], ['optFeedMine', 'feedMine'], ['optFeedPmc', 'feedPmc'], ['optFeedBoss', 'feedBoss'], ['optFeedAi', 'feedAi'], ['optOrbitLines', 'orbitLines'], ['optBotLoot', 'botLoot'],
    ['optPeek', 'peek'], ['optFog', 'rosterFog'], ['optRosterDoing', 'rosterDoing'], ['optRosterHp', 'rosterHp'],
    ['optRosterSlim', 'rosterSlim'], ['optHealthAll', 'healthAll'], ['optMapDoing', 'mapDoing'], ['optSquadParts', 'squadParts'], ['optOrbitNames', 'orbitNames'],
    ['optOrbitFights', 'orbitFights'], ['optOrbitHear', 'orbitHear'], ['optRoofLoot', 'roofLoot'], ['optRoofTotals', 'roofTotals'], ['optRoofTotalsUnder', 'roofTotalsUnder'], ['optAlertSound', 'alertSound'], ['optFeedKeep', 'feedKeep'], ['optFeedBox', 'feedBox']]) {
    $(id).checked = !!prefs[key];
    $(id).onchange = e => { prefs[key] = e.target.checked; save(); dirty = true; rosterPrint = bestPrint = null; tipFor = null; feedPrint = ''; listRoster(); showKills(); };
  }
  $('optAwake').addEventListener('change', keepAwake);
  // the Raid list's health bars need the map's: greyed while those are off
  const healthDeps = () => { const off = !prefs.health; $('optRosterHp').disabled = off; $('optRosterHp').closest('label').classList.toggle('unavailable', off); };
  $('optHealth').addEventListener('change', healthDeps);
  healthDeps();
  // text size and map brightness
  $('optTextScale').value = prefs.textScale;
  $('optTextScale').oninput = e => { prefs.textScale = +e.target.value || 1; save(); sizesSaid(); dirty = true; };
  const mapLight = () => { $('layers').style.filter = prefs.mapLight < 100 ? 'brightness(' + prefs.mapLight / 100 + ')' : ''; $('mapLightText').textContent = prefs.mapLight + '%'; };
  $('optMapLight').value = prefs.mapLight;
  $('optMapLight').oninput = e => { prefs.mapLight = +e.target.value || 100; save(); mapLight(); };
  mapLight();
  // how close a building opens by itself: far to near, like the zoom sliders; put away while that's switched off
  $('optLookSpan').min = -LOOK_SPAN[1];
  $('optLookSpan').max = -LOOK_SPAN[0];
  const showLookSpan = () => {
    $('optLookSpan').value = -prefs.lookSpan;
    $('lookSpanText').textContent = Math.round(prefs.lookSpan) + ' m';
    $('lookSpanRow').hidden = !prefs.insideLook;
  };
  showLookSpan();
  $('optLookSpan').oninput = e => { prefs.lookSpan = -e.target.value; showLookSpan(); save(); dirty = true; };
  $('optInsideLook').addEventListener('change', showLookSpan);
  // pressing buildings switched off: the one open is shut, and the Buildings button goes
  $('optPressOpen').addEventListener('change', () => {
    if (!prefs.pressOpen) opened = 0;
    $('reveal').hidden = !(prefs.pressOpen && map && map.floors && map.floors.buildings);
  });
  for (const [id, key] of [['optRosterGhosts', 'rosterGhosts'], ['optFeedNames', 'feedNames'], ['optFeedRows', 'feedRows'], ['optFeedPos', 'feedPos']]) {
    $(id).value = prefs[key];
    $(id).onchange = e => { prefs[key] = key === 'feedRows' ? +e.target.value : e.target.value; save(); dirty = true; rosterPrint = null; feedPrint = ''; listRoster(); showKills(); };
  }
  for (const [id, key, text, unit] of [['optAreaR', 'areaR', 'areaRText', ' m'], ['optLootCell', 'lootCell', 'lootCellText', ' m'], ['optFeedBg', 'feedBg', 'feedBgText', '%']]) {
    const show = () => { $(id).value = prefs[key]; $(text).textContent = Math.round(prefs[key]) + unit; };
    show();
    $(id).oninput = e => {
      prefs[key] = +e.target.value || 0;
      show();
      save();
      dirty = true;
      if (key === 'areaR') areas.clear();
      if (key === 'feedBg') document.body.style.setProperty('--feed-bg', String(prefs.feedBg / 100));
    };
  }
  for (const n of Object.keys(BOT_MODS)) $('optBot' + n).onchange = e => { prefs['bot' + n] = e.target.checked; save(); nameBotDetails(); };
  $('optBotDiff').onchange = e => { prefs.botDiff = e.target.checked; save(); nameBotDetails(); };
  nameBotDetails();
  // names in Latin letters: the markers' names are put back as the game has them, or written again
  $('optLatin').checked = !!prefs.latin;
  $('optLatin').onchange = e => {
    prefs.latin = e.target.checked;
    save();
    for (const m of live) if (m.tn) m.t = latin(m.tn);
    if (things) for (const b of things.bodies) b.who = latin(b.whoRaw);
    for (const m of seenRoster.values()) { const now = liveById.get(m.id); if (now) m.t = now.t; }
    rosterPrint = bestPrint = null;
    dirty = true;
  };
  // the sorts of container: one switch each with its picture, all on to start with
  {
    const box = $('boxKinds');
    const SORTS = [['safe', T('Safe')], ['register', T('Cash register')], ['drawer', T('Drawer')], ['bag', T('Bag')], ['jacket', T('Jacket')],
      ['tools', T('Toolbox')], ['pc', T('PC block')], ['med', T('Medical')], ['weapon', T('Weapon box')], ['grenade', T('Grenade box')],
      ['food', T('Ration box')], ['cache', T('Buried cache')], ['body', T('Dead body')], ['crate', T('Crate')]];
    for (const [sort, text] of SORTS) {
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !prefs.boxOff.includes(sort);
      input.dataset.def = '1';
      input.onchange = () => {
        prefs.boxOff = SORTS.map(k => k[0]).filter(k => k === sort ? !input.checked : prefs.boxOff.includes(k));
        save();
        dirty = true;
        rosterPrint = bestPrint = bestCanPrint = null;
        listBest();
      };
      const img = document.createElement('img'), name = document.createElement('span');
      img.src = badge(BOX_GLYPH[sort], '#1a1a24', '#7c7f8f', SPAWN_INK, 'square', 48).toDataURL();
      img.width = img.height = 24;
      img.alt = '';
      name.textContent = text;
      row.append(input, img, name);
      box.appendChild(row);
    }
  }
  // the kinds of loot: one switch each, all on to start with
  {
    const box = $('lootKinds');
    for (const [kind, text] of LOOT_KINDS) {
      const row = document.createElement('label');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !prefs.lootOff.includes(kind);
      input.onchange = () => {
        prefs.lootOff = LOOT_KINDS.map(k => k[0]).filter(k => k === kind ? !input.checked : prefs.lootOff.includes(k));
        save();
        dirty = true;
        rosterPrint = bestPrint = null;
      };
      // its picture, as on the map's spawn points
      const img = document.createElement('img'), name = document.createElement('span');
      img.src = badge(SPAWN_GLYPH[kind] || '?', '#1a1a24', '#7c7f8f', SPAWN_INK, 'round', 48).toDataURL();
      img.width = img.height = 24;
      img.alt = '';
      name.textContent = text;
      row.append(input, img, name);
      box.appendChild(row);
    }
    const all = on => () => {
      prefs.lootOff = on ? [] : LOOT_KINDS.map(k => k[0]);
      for (const input of box.querySelectorAll('input')) input.checked = on;
      save();
      dirty = true;
      bestPrint = null;
    };
    $('lootKindsAll').onclick = all(true);
    $('lootKindsNone').onclick = all(false);
  }
  // quest items and quest places: each on or off, as the switches under "Show on this page" are
  for (const [id, category] of [['optQuestItems', 'Layer quest'], ['optQuestPlaces', 'Layer questZones']]) {
    $(id).checked = !isHidden(category);
    $(id).onchange = e => setHidden(category, !e.target.checked);
  }
  const showOther = () => { $('optOtherLoot').value = prefs.otherLoot; $('otherLootText').textContent = prefs.otherLoot > 0 ? Math.round(prefs.otherLoot) + '%' : 'hidden'; };
  showOther();
  $('optOtherLoot').oninput = e => { prefs.otherLoot = +e.target.value || 0; showOther(); save(); dirty = true; };
  // the search box: loot, keys and quests by name, as you type
  $('find').oninput = e => { setFind(e.target.value); findOpen = true; findNext.clear(); loadSpawns(); dirty = true; };
  $('find').onfocus = () => { findOpen = true; dirty = true; };
  const clearFind = () => { $('find').value = ''; setFind(''); findOpen = false; dirty = true; };
  $('findClear').onpointerdown = e => e.preventDefault();
  $('findClear').onclick = e => { e.preventDefault(); clearFind(); };
  $('find').onkeydown = e => {
    if (e.key === 'Escape') { clearFind(); e.target.blur(); }
    // Enter: the first one found
    if (e.key === 'Enter') { const first = $('findList').querySelector('.hit'); if (first) first.click(); }
  };
  // the list goes when the map is pressed (what was searched for stays ringed); the box brings it back
  stage.addEventListener('pointerdown', () => { if (findOpen) { findOpen = false; dirty = true; } });
  window.addEventListener('resize', () => { findShown = ''; dirty = true; });
  $('optScale').value = prefs.scale;
  // marker and text size, each with its size in percent beside it (100%: as usual)
  const sizesSaid = () => { $('scaleText').textContent = Math.round(prefs.scale * 100) + '%'; $('textScaleText').textContent = Math.round(prefs.textScale * 100) + '%'; };
  $('optScale').oninput = e => { prefs.scale = +e.target.value || 1; save(); sizesSaid(); dirty = true; };
  sizesSaid();
  window.addEventListener('keyup', e => { if (e.key === 'b' || e.key === 'B') revealUp(); });
  window.addEventListener('blur', revealUp);
  $('reveal').addEventListener('pointerdown', e => { e.preventDefault(); $('reveal').setPointerCapture(e.pointerId); revealDown(); });
  $('reveal').addEventListener('pointerup', revealUp);
  $('reveal').addEventListener('pointercancel', revealUp);
  $('floorUp').onclick = () => stepFloor(1);
  $('floorDown').onclick = () => stepFloor(-1);
  // the floor it would show by itself again
  $('floorText').onclick = () => { if (floorPick) { floorPick = null; floorWantKey = ''; floorLabel(floorShown.n, floorsOf(floorShown.place)); dirty = true; } };
  $('optFloor').onchange = e => {
    prefs.floor = e.target.value === 'auto' ? 'auto' : +e.target.value || 0;
    save();
    // drawn again next frame, badge and all
    floorShown = { place: -1, n: -1 };
  };
  // in a raid, with another map picked to look at
  function awayFromRaid() {
    const there = inRaid() ? mapFor(report.loc) : null;
    return !!there && there !== map;
  }
  function backToRaid() {
    const there = inRaid() ? mapFor(report.loc) : null;
    if (!there) return;
    prefs.map = there.loc;
    save();
    showMap(there, false);
    zoomState = null;
    zoom = zoomTarget = zoomMin + Math.min(1, Math.max(0, prefs.zoom)) * (zoomMax - zoomMin);
    if (me) centreOn(me.x, me.y);
    setFollow(true);
    showStatus();
  }
  $('backRaid').onclick = backToRaid;
  $('status').onclick = () => { if (awayFromRaid()) backToRaid(); };
  $('map').onchange = e => {
    const next = maps.find(m => m.loc === e.target.value);
    if (next) { prefs.map = next.loc; save(); showMap(next, false); showStatus(); }
  };
  $('session').onchange = e => {
    const game = games.find(g => g.sid === e.target.value);
    prefs.player = e.target.value ? { sid: e.target.value, name: game ? game.name : (prefs.player || {}).name || '' } : null;
    save();
    forget();
    sid = prefs.player ? prefs.player.sid : '';
    listen();
    listGames();
  };

  // ---- start ---------------------------------------------------------------------------------------------------
  // The maps the server has. Asked again every few seconds: a location is captured during its first raid.
  async function loadMaps() {
    let answer;
    try {
      // (with the mark of the ones had already: the server then only says they're the same. They run to over a
      // megabyte, which was fetched and read through every few seconds.)
      answer = await (await fetch('api/maps' + (mapsPrint ? '?have=' + encodeURIComponent(mapsPrint) : ''))).json();
    } catch (e) {
      return;
    }
    mapsAsked = true;
    if (answer.same) return;
    const print = answer.print || '';
    if (print === mapsPrint) return;
    mapsPrint = print;
    addons = (Array.isArray(answer.addons) ? answer.addons : []).filter(a => a && typeof a.loc === 'string' && a.loc);
    maps = (answer.maps || []).map(readMap).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const pick = $('map');
    pick.textContent = '';
    for (const m of maps) {
      const o = document.createElement('option');
      o.value = m.loc;
      // a snow map: the same name, said to be with snow
      o.textContent = m.name + (isSnow(m.loc) ? ' · ' + T('snow') : '');
      pick.appendChild(o);
    }
    if (!maps.length) return;
    // the one shown, as it is now (it may have been captured again); else the raid's; else the one last looked at
    const shownNow = map && maps.find(m => m.loc === map.loc);
    if (shownNow) {
      const fresh = shownNow.v !== map.v;
      if (fresh) showMap(shownNow, true); else { map = shownNow; placeZones(); }
      $('map').value = map.loc;
    }
    raidKey = '';
    if (report) raidChanged();
    if (!map) showMap(maps.find(m => m.loc === prefs.map) || maps[0], false);
  }

  // ?debug: made-up reports can be given to the page from the browser's console (fumsTake), to try things
  if (DEBUG) window.fumsTake = m => take(m);
  // every building of the map shown, with a spot inside its biggest part (debug only)
  if (DEBUG) window.fumsAll = () => (map && map.floors && map.floors.buildings || []).map(b => {
    const p = b.parts.reduce((big, q) => q.a > big.a ? q : big);
    let spot = [(p.box.x0 + p.box.x1) / 2, (p.box.y0 + p.box.y1) / 2];
    for (let k = 0; k < 400 && !inLoops(p.l, spot[0], spot[1]); k++) spot = [p.box.x0 + Math.random() * (p.box.x1 - p.box.x0), p.box.y0 + Math.random() * (p.box.y1 - p.box.y0)];
    return { in: spot, h: p.h, w: b.box.x1 - b.box.x0, d: b.box.y1 - b.box.y0 };
  });
  if (DEBUG) window.fumsState = () => ({ shown: floorShown, insideShut, insideShutAt, opened, mine: me && map ? placeInside() : 0, roaming, me, pan: [panX, panY, zoom],
    spots: map && map.floors && map.floors.buildings ? map.floors.buildings.slice(0, 40).map(b => ({ x: (b.box.x0 + b.box.x1) / 2, y: (b.box.y0 + b.box.y1) / 2, h: b.parts[0].h, w: b.box.x1 - b.box.x0, d: b.box.y1 - b.box.y0 })) : [], at: toScreen(me ? me.cx : 0, me ? me.cy : 0) });
  let source = null;
  function listen() {
    if (source) source.close();
    // One game's reports only: the player picked, or with nobody picked the game being shown. The other games on
    // the server then aren't asked for their markers. (Every game, only until the first is heard from.)
    streamFor = prefs.player ? prefs.player.sid : sid;
    source = new EventSource('api/stream' + (streamFor ? '?session=' + encodeURIComponent(streamFor) : ''));
    source.onopen = () => { serverLost = false; };
    source.onerror = () => { serverLost = true; };
    source.onmessage = e => {
      serverLost = false;
      try { take(JSON.parse(e.data)); } catch (err) { console.warn(err); }
    };
  }

  resized();
  // the options are open to begin with where there's room for them beside the map
  // on a phone the panel would cover the map: it starts shut there whatever it was left as
  placeQuick();
  showTab(tab, false);
  showModes();
  togglePanel(phone.matches ? false : prefs.panel !== undefined ? !!prefs.panel : window.innerWidth >= 900, false);
  toggleSide(prefs.side !== undefined ? !!prefs.side : window.innerWidth >= 900, false);
  // the page's address ending in ?menu=loot (or raid, quests, map, settings): the menu starts open on that tab
  const asked = new URLSearchParams(location.search).get('menu');
  if (TABS.includes(asked)) { showTab(asked, false); togglePanel(true, false); }
  phone.addEventListener('change', () => { placeQuick(); sidesNow(); measureCover(); findShown = ''; listRoster(); });
  // started again by itself (see again): whole now, so it's shown
  // (the bar is whole once the list of maps has come and one is shown: until then it would be seen shuffling about)
  {
    const from = performance.now();
    const look = () => {
      if (!$('map').hidden && map || performance.now() - from > 2500) requestAnimationFrame(() => window.swapDone && window.swapDone());
      else requestAnimationFrame(look);
    };
    if (document.documentElement.classList.contains('swap')) requestAnimationFrame(look);
  }
  // the sheet is as tall as what's in it: measured again whenever that changes
  if (window.ResizeObserver) new ResizeObserver(measureCover).observe($('panel'));
  // full screen can't be had on some phones (an iPhone's browser): no button for it there
  if (!document.documentElement.requestFullscreen) $('full').hidden = true;
  loadMaps();
  setInterval(() => { loadMaps(); loadPlaces(false); loadSpawns(); }, 4000);
  listen();
  askGames();
  setInterval(askGames, 3000);
  requestAnimationFrame(frame);
})();
