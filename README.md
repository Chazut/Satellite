# Satellite

A live map of your raid in the browser, for SPT 4.1. Use it on a second monitor, a tablet or a phone.

## Features

- Top-down scans of every base game map. Modded maps come as add-ons.
- You, your friends and every bot, live.
- Extracts: green open, yellow needs something, red closed.
- Loose loot and container contents, coloured by worth. Better Flea prices if you run it.
- Locked doors and the key that opens them.
- Quest places and quest items.
- Building floors: walk inside and the map shows your floor.
- Minefields, claymores and sniper zones.
- Raid list, kill feed and raid events.
- What bots are doing, with SAIN, ORBIT or COMET installed.
- Arrows to who's off the screen.
- Search for loot, keys and quests.
- Works on a phone. Settings > About has a QR code.
- 10 languages.
- Every marker and feature has its own switch.
- Export and import your settings.

It only reads. Nothing on the page changes anyone's game.

## Install

1. Close the game and the server.
2. Extract the zip into your SPT folder.
3. Start the server, then open `https://127.0.0.1:6969/satellite/`. It's also under Mod Pages in the launcher, and
   Left Alt + M opens it in game.

The browser warns about the certificate the first time. That's SPT's own. Click Advanced, then Continue.

## On your phone

1. Close the server. In `SPT_Runtime/SPT_Data/configs/http.json`, set `"ip"` to `"0.0.0.0"`. Leave `"backendIp"` alone.
2. Start the server. Let SPT.Server.exe through the Windows firewall on Private networks.
3. Make sure your Wi-Fi is set to Private in Windows.
4. Open the map on the PC, go to Settings > About and scan the code.

This opens the whole SPT server to your network, not just the map. Only do it on your home network. If port 6969 is
forwarded for Fika, anyone with your address can open the map too. Change the default `spt` / `spt` password in
`http.json`.

## Controls

| | |
|---|---|
| Drag | Move the map |
| Wheel, pinch, `+` `-` | Zoom |
| `;` | Follow the player |
| `0` | Whole map |
| `M` | Menu |
| `P` | Raid list |
| `L` | Loot tab |
| `Q` | Quests tab |
| `/` | Search |
| `B` | Outline buildings |
| `[` `]` | Floor down / up |
| `F` | Full screen |
| `H` | Hide the controls |

## Settings

- Page settings are in the menu, saved in each viewer's browser.
- `SPT_Runtime/user/mods/Satellite/config.jsonc`: the server owner can turn off any kind of marker or loot for every
  page. Made on first start. Updates don't overwrite it. Restart the server after a change.
- F12 > Fums-Satellite: the key that opens the map, and how often it updates.

## Build

```powershell
.\build.ps1 -SPTPath D:\SPT
```

Needs the .NET 10 SDK and an SPT 4.1 folder.

## Credits

- Made by Fums.
- The mod and its map scans are [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): use, share and change
  them with credit, but don't sell them. See `LICENSE` and `LICENSE-MAPS.md`.
- QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, MIT. "QR Code"
  is a registered trademark of DENSO WAVE INCORPORATED.
- Cursors: [Cursor Pack](https://kenney.nl/assets/cursor-pack) by Kenney, CC0.
- Escape from Tarkov belongs to Battlestate Games. Satellite is a fan mod, not made or backed by them.
