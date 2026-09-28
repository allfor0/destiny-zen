# Destiny Zen

A personal Model Context Protocol (MCP) server for Destiny 2. It signs in to your own Bungie account and lets an AI assistant such as Claude read your vault, armour and loadouts, and change your gear: equip items, set weapon perks, fit armour mods, configure subclasses and artifact perks, and save in-game loadouts. A complete build can be applied without DIM.

It also keeps a set of public lookup tools (players, activities, items, clans, World's First leaderboards) that need only an API key.

Destiny Zen started as a fork of [Nadiar/destiny2-mcp-server](https://github.com/Nadiar/destiny2-mcp-server) and is developed as its own project.

## What it can do

| Area | Tools |
|---|---|
| Sign-in | `auth_status`, `get_my_account` |
| Weapons | `get_weapons`, `get_weapon`, `export_weapons`, `set_perks` |
| Armour and items | `get_armor`, `export_armor`, `get_item`, `get_equipped` |
| Builds | `set_sockets` (armour mods, subclass abilities, aspects, fragments, artifact perks), `equip_items` |
| Inventory | `transfer_items`, `pull_from_postmaster`, `set_lock` |
| In-game loadouts | `get_loadouts`, `equip_loadout`, `snapshot_loadout`, `rename_loadout`, `clear_loadout` |
| Account | `get_currencies`, `get_crafted`, `get_artifact`, `get_collectibles`, `get_vendors`, `get_weapon_history` |
| Public lookups | Player search, profiles, activity history and stats, PGCRs, manifest items and plug sets, clan rosters, World's First and RaidHub leaderboards |

All write actions are "free and reversible" changes that Bungie allows third-party apps to make (the same class of action DIM uses). Nothing spends currency.

## Setup

### 1. Register a Bungie application

At [bungie.net/en/Application](https://www.bungie.net/en/Application) create an application with:

| Setting | Value |
|---|---|
| Application status | Private |
| OAuth client type | **Confidential** |
| Redirect URL | `https://localhost:7777/callback` |
| Scopes | Read your Destiny 2 information (vault, inventory, vendors); Move or equip your Destiny gear |
| Origin header | Leave empty |

Note the **API key**, **OAuth client_id** and **OAuth client_secret**.

### 2. Install and build

Requires Node.js 18 or later.

```bash
git clone https://github.com/allfor0/destiny-zen.git
cd destiny-zen
npm install
npm run build
```

### 3. Create `.env`

In the project folder:

```env
BUNGIE_API_KEY=your-32-character-api-key
BUNGIE_CLIENT_ID=your-client-id
BUNGIE_CLIENT_SECRET=your-client-secret
```

Without the client id and secret the server still runs, but only the public tools are registered.

### 4. Sign in

```bash
npm run auth
```

This opens the Bungie authorisation page and starts a local HTTPS listener on `https://localhost:7777/callback` with a self-signed certificate. Approve the app on Bungie, then accept the browser's certificate warning (Advanced > Continue). Tokens are saved to `~/.destiny-zen/tokens.json` and refreshed automatically.

**Sign-in lasts 90 days.** `auth_status` shows the expiry date and warns 14 days before it. To renew, run `npm run auth` again and restart your MCP client.

### 5. Add it to Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "DestinyZen": {
      "command": "node",
      "args": ["C:\\path\\to\\destiny-zen\\dist\\index.js"],
      "env": {
        "BUNGIE_API_KEY": "your-api-key",
        "BUNGIE_CLIENT_ID": "your-client-id",
        "BUNGIE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

Quit Claude fully (system tray) and reopen it. Run `auth_status` to confirm the sign-in.

The first signed-in call downloads the parts of the Destiny 2 manifest Destiny Zen needs (about a minute) and caches them in `~/.destiny-zen/`. It downloads again only when Bungie publishes a new manifest or the cache format changes.

## Signed-in tools

### Reading

| Tool | Returns |
|---|---|
| `auth_status` | Sign-in state and expiry |
| `get_my_account` | Bungie name and memberships, marking the cross-save primary |
| `get_weapons` | Every weapon (vault and characters) with each rolled option per perk column, selected option marked, frame, masterwork, mod, element, tier, lock state, stats. Filters: name, type, perk, location; paged |
| `get_weapon` | One weapon in full, with socket indexes and plug hashes |
| `export_weapons` | CSV and JSON of all weapons, for scripts |
| `get_armor` | Every armour piece with live stats (masterwork and mods included), total, energy, tier, archetype, set bonus, mods and tuning. Filters: class, slot, name, rarity, location, plug, minimum stat; sort by stat |
| `export_armor` | CSV and JSON of all armour |
| `get_item` | Any item by instance id: stats, energy and every socket with its index. `options: true` lists what each socket can take |
| `get_equipped` | Everything on a character: weapons, armour with stats and mods, subclass setup, artifact, armour stat totals, and the ids of the character's other subclasses |
| `get_artifact` | The equipped artifact's perk in each slot; `options: true` lists the perks each slot can take |
| `get_loadouts` | In-game loadouts per character; `detail: true` includes mods, aspects and fragments |
| `get_currencies` | Glimmer, Bright Dust, Enhancement Cores and Prisms, Ascendant materials and other consumables |
| `get_crafted` | Crafted weapons with weapon level, level progress and shaping date |
| `get_collectibles` | Exotic armour or weapons (or everything) acquired or missing, with source |
| `get_vendors` | What vendors sell a character now (weapons and armour by default, with armour stats and costs) |
| `get_weapon_history` | Kills, precision kills and precision % per weapon (Bungie tracks mainly exotics here) |

### Changing

| Tool | Does |
|---|---|
| `equip_items` | Moves items to a character (from the vault or another character) and equips them, subclass included. Makes room if a slot is full. Retries once if an exotic clash blocked an item |
| `transfer_items` | Moves items to the vault or a character without equipping |
| `pull_from_postmaster` | Lists, pulls chosen, or pulls all Postmaster items |
| `set_lock` | Locks or unlocks items |
| `set_perks` | Switches weapons between perks, barrels and magazines they already rolled. Works on vault items |
| `set_sockets` | Inserts plugs by name into any free socket: armour stat, tuning and utility mods, subclass super, abilities, aspects and fragments, artifact perks, weapon perks. Picks the socket automatically unless `socketIndex` is given |
| `equip_loadout` | Equips a saved in-game loadout |
| `snapshot_loadout` | Saves the character's current gear into a loadout slot (overwrites it) |
| `rename_loadout` | Changes a loadout's name, colour or icon |
| `clear_loadout` | Empties a loadout slot |

`set_perks` and `set_sockets` take up to 30 changes per call. Most write tools support `dryRun: true` to preview.

## Behaviour to know

- **Character location.** Equipping and socket changes need the character in orbit, in a social space or offline (Bungie error 1634 otherwise).
- **Read lag.** After a change, Bungie's profile read can show old data for one to two minutes, while the game and DIM update at once. Trust the tool's success result. If `set_sockets` reports a plug "already" fitted straight after a change, wait or pass `force: true`.
- **`set_sockets` socket choice.** A socket holding a plug you didn't list counts as free. List every plug you want to keep on that item, or give `socketIndex`. Removals ("Empty ... Socket") run first, then plugs in the order given, so set aspects before fragments.
- **Fragment sockets.** Sockets beyond what the equipped aspects unlock look empty but reject plugs. Give `socketIndex` to replace an existing fragment instead.
- **Artifact perks** live in the equipped artifact item's sockets (0-6; socket 7 resets the artifact). Bungie's older seasonal-artifact progression data is stale and is not used.
- **Unlock-based options** (artifact perks and some subclass and armour plugs) come from live plug sets on your profile and character, which `get_item`, `get_artifact` and `set_sockets` read.
- **Loadout names** must be one of Bungie's presets (Alpha ... Strike, PvE, PvP, Crucible, Trials and so on). Colours and icons accept a number or a name, following the order in the in-game picker:
  - Colours: black, light grey, dark grey, cyan, steel blue, light blue, blue, navy, gold, brown, green, teal, lime, orange, pink, plum, lilac, indigo, red, maroon, hot pink, wine
  - Icons: tree, guardian, crucible, solar, void, arc, strand, spider, stasis, swords, iron banner, sword, chevrons, serpent, eye, skull, traveler, wolves, bull, hexagon, wings (descriptive labels; Bungie doesn't name them)
- **Empty loadout slots** are saved with the first preset name, colour and icon unless you give them. Sending blank values makes Bungie reject the save with error 1622.
- **In-game loadouts store their own mods and subclass setup**, so changing a shared armour piece or subclass doesn't break other saved loadouts.
- **Rate limits.** Socket changes are spaced 600 ms apart (Bungie allows 2 per second); transfers 250 ms.
- **DIM data.** DIM loadouts, tags and notes are stored by DIM, not Bungie, so Destiny Zen can't see them.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BUNGIE_API_KEY` | Yes | | Bungie API key (32 hex characters) |
| `BUNGIE_CLIENT_ID` | For signed-in tools | | OAuth client id |
| `BUNGIE_CLIENT_SECRET` | For signed-in tools | | OAuth client secret |
| `BUNGIE_REDIRECT_URL` | No | `https://localhost:7777/callback` | Used by `npm run auth`; must match the Bungie app |
| `DESTINY_ZEN_TOKEN_FILE` | No | `~/.destiny-zen/tokens.json` | Where sign-in tokens are stored |
| `DESTINY_ZEN_EXPORT_DIR` | No | `~/.destiny-zen/exports` | Folder for `export_weapons` and `export_armor` |
| `LOG_LEVEL` | No | `info` | debug, info, warn, error |
| `CACHE_TTL_HOURS` | No | 24 | Public manifest cache lifetime (1-168) |
| `CACHE_MAX_SIZE_MB` | No | 100 | Public manifest cache size (50-500) |
| `API_RATE_LIMIT_MS` | No | 150 | Minimum gap between public API requests (50-1000) |
| `API_MAX_RETRIES` | No | 3 | Public API retries (0-5) |
| `API_TIMEOUT_MS` | No | 30000 | Public API timeout (5000-60000) |
| `RAIDHUB_API_KEY` | No | | Enables live RaidHub data |
| `USE_RAIDHUB` | No | false | Turns on the RaidHub integration (needs the key) |

## Public tools

These need only `BUNGIE_API_KEY`.

| Tool | Description |
|---|---|
| `search_player` | Exact Bungie name lookup (with #code) |
| `find_players` | Fuzzy name search with confidence scores and cross-save primary detection |
| `get_profile`, `get_character` | Profile, characters, clan, triumph score, equipped gear |
| `get_activity_history`, `get_activity_stats` | Activity history with names; aggregated stats over up to 1000 activities |
| `get_pgcr`, `get_historical_stats` | Post-game carnage reports; lifetime stats |
| `get_manifest`, `get_item_definition`, `search_items`, `get_item_details`, `get_item_image`, `get_plug_set`, `get_activity_definition` | Manifest lookups: items, perks, plug sets, activities, images |
| `search_clan_members` | Clan roster by name or via a known member |
| `list_leaderboards`, `get_leaderboard`, `get_worlds_first`, `search_leaderboard_player`, `get_leaderboard_pgcr`, `compare_leaderboard_players`, `get_leaderboard_stats`, `filter_leaderboard_entries` | World's First contest leaderboards (bundled data in `leaderboard-data/`) |
| `raidhub_public_leaderboard` (+ live `raidhub_*` tools with a RaidHub key) | RaidHub leaderboards, player search, PGCRs |

Prompts: `weapon_perk_lookup`, `activity_count_lookup`, `player_lookup`, `weapon_image_lookup`, `destiny_hash_system`, `pantheon_helper`.

More detail on the public tools: [docs/API.md](docs/API.md), [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Docker notes in [docs/DOCKER.md](docs/DOCKER.md) cover the public tools only; the sign-in flow needs a local token file.

## Development

```bash
npm run build      # TypeScript to dist/
npm test           # unit tests (Vitest)
npm run lint
npm run dev        # watch mode with tsx
```

After a rebuild, restart the MCP client so it loads the new `dist/`.

### Code layout (Destiny Zen parts)

| Path | Contents |
|---|---|
| `src/auth/oauth.ts`, `src/auth/cli.ts` | OAuth token exchange and refresh; `npm run auth` sign-in |
| `src/zen/defs.ts` | Compact manifest definitions cached per manifest version (`~/.destiny-zen/defs-v7-*.json`) |
| `src/zen/inventory.ts` | Profile reads: weapons, loadouts, raw component reads |
| `src/zen/sockets.ts` | Socket resolution from item and plug-set definitions plus live plug sets |
| `src/zen/common.ts` | Shared helpers, Bungie error-code names |
| `src/tools/auth-tools.ts` | Sign-in tools; `authedGet` / `authedPost` helpers |
| `src/tools/inventory-tools.ts` | Weapon reads and export |
| `src/tools/perk-tools.ts` | `set_perks` |
| `src/tools/armor-tools.ts` | Armour, item and equipped reads |
| `src/tools/socket-tools.ts` | `set_sockets` |
| `src/tools/item-tools.ts` | Equip, transfer, lock, Postmaster |
| `src/tools/loadout-tools.ts` | In-game loadouts |
| `src/tools/account-tools.ts` | Currencies, crafted, artifact, collectibles, vendors, weapon history |

Bungie API reference: [bungie-net.github.io](https://bungie-net.github.io/) and the OpenAPI spec at [github.com/Bungie-net/api](https://github.com/Bungie-net/api). Write actions use the `MoveEquipDestinyItems` scope; paid socket changes (`InsertSocketPlug`) are not available to third-party apps.

## History

| Phase | Added |
|---|---|
| 0 | Fork, build, Claude Desktop registration |
| 1 | Bungie OAuth sign-in (`npm run auth`), `auth_status`, `get_my_account` |
| 2 | Live weapon inventory: `get_weapons`, `get_weapon`, `export_weapons` |
| 3 | `set_perks`; in-game loadout tools |
| 4 | `equip_items` |
| 5 | Armour, item and equipped reads; `set_sockets`; transfer, lock, Postmaster, clear loadout; currencies, crafted, artifact, collectibles, vendors, weapon history; `snapshot_loadout` fix for empty slots; loadout colour and icon names |
| 6 | Renamed from destiny2-mcp-server to destiny-zen throughout (package, MCP server name, docs, Docker labels); all local data now under `~/.destiny-zen/` (the public manifest cache moved from `~/.destiny2-mcp/cache`); README rewritten |

## Licence

MIT. See [LICENSE](LICENSE). Includes code from Nadiar/destiny2-mcp-server (MIT).
