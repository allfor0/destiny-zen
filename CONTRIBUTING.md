# Contributing to Destiny Zen

Destiny Zen is a personal project, developed in the open. Issues and pull requests are welcome; changes that touch a user's gear get extra scrutiny because they act on real Bungie accounts.

## Development setup

### Prerequisites

- Node.js 18 or later, npm 8 or later
- A Bungie application (see the README, "Register a Bungie application"): API key, plus OAuth client id and secret for the signed-in tools
- A Destiny 2 account to test against. Use characters and items you don't mind changing.

### Getting started

```bash
git clone https://github.com/allfor0/destiny-zen.git
cd destiny-zen
npm install
cp .env.example .env      # then add BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET
npm run build
npm run auth              # one-off Bungie sign-in; tokens go to ~/.destiny-zen/tokens.json
```

Point your MCP client at `dist/index.js` (see the README) and restart it after every rebuild so it loads the new code. `npm run dev` runs the server in watch mode for quick checks outside a client.

## Commands

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run auth` | Bungie sign-in (renew every 90 days) |
| `npm run dev` / `npm run dev:once` | Run from source with / without watch |
| `npm test` | Unit tests (no API key needed) |
| `npm run test:watch` / `npm run test:coverage` | Watch mode / coverage |
| `npm run test:integration` | Public API integration tests (needs `BUNGIE_API_KEY` in `.env`) |
| `npm run test:all` | Unit and integration tests |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run typecheck` | TypeScript type check |
| `npm run audit:security` | npm audit |

### Before committing

```bash
npm run typecheck
npm run lint
npm test
npm run format
```

Husky pre-commit hooks run some of these automatically.

## Project structure

```
src/
├── index.ts              # Entry point: config, tool and prompt registration
├── config.ts             # Environment configuration (zod)
├── auth/
│   ├── oauth.ts          # Token exchange and refresh, token file
│   └── cli.ts            # `npm run auth`: local HTTPS callback sign-in
├── zen/                  # Signed-in (Destiny Zen) core
│   ├── defs.ts           # Compact manifest definitions, cached per manifest version
│   ├── inventory.ts      # Profile reads: weapons, loadouts, raw components
│   ├── sockets.ts        # Socket and plug-set resolution (incl. live plug sets)
│   └── common.ts         # Shared helpers, Bungie error-code names
├── tools/
│   ├── auth-tools.ts     # auth_status, get_my_account; authedGet/authedPost helpers
│   ├── inventory-tools.ts# get_weapons, get_weapon, export_weapons
│   ├── perk-tools.ts     # set_perks
│   ├── armor-tools.ts    # get_armor, export_armor, get_item, get_equipped
│   ├── socket-tools.ts   # set_sockets
│   ├── item-tools.ts     # equip_items, transfer_items, set_lock, pull_from_postmaster
│   ├── loadout-tools.ts  # get/equip/snapshot/rename/clear loadouts
│   ├── account-tools.ts  # currencies, crafted, artifact, collectibles, vendors, weapon history
│   ├── destiny-tools.ts  # Public lookup tools (API key only)
│   ├── leaderboard-tools.ts, raidhub-tools.ts
│   └── index.ts
├── api/                  # Public Bungie and RaidHub API clients
├── services/             # Logger, public manifest and RaidHub caches (~/.destiny-zen/cache)
├── data/                 # Static data (day-one triumphs, season watermarks)
└── types/
tests/                    # Vitest unit tests; integration/ needs a real API key
leaderboard-data/         # Bundled World's First data
docs/                     # API, Docker and troubleshooting notes (public tools)
```

## Adding a tool

1. Put it in the file for its area (see above), or a new `src/tools/*-tools.ts` exported from `src/tools/index.ts` and registered in `src/index.ts`. Signed-in tools register inside the `BUNGIE_CLIENT_ID && BUNGIE_CLIENT_SECRET` block.
2. Register with `server.tool(name, description, zodSchema, handler)`. The description is what the AI reads to decide when and how to use the tool: say what it returns, what it changes, and its preconditions.
3. Use `authedGet` / `authedPost` for signed-in calls, and the helpers in `src/zen/common.ts` (`text`, `errorResult`, `describeError`, `cleanId`, `itemName`).
4. Return plain, compact text. Include item names and instance ids so results can feed the next call.

### Rules for tools that change gear

- Only Bungie's free and reversible actions (scope `MoveEquipDestinyItems`). Never anything that spends currency.
- Offer `dryRun` wherever a batch is possible, and report per-item results rather than one success line.
- Respect Bungie's limits: 2 socket actions per second (Destiny Zen spaces them 600 ms apart), and keep batches small enough to finish inside an MCP client's timeout (about 30 socket changes).
- Say what an overwrite replaced (e.g. `snapshot_loadout` reports what the slot held).
- Expect the profile read to lag 1-2 minutes behind a change; don't build logic that assumes an immediate re-read is current.
- Int64 ids (item, character, membership) go to Bungie as strings.
- Add Bungie error codes you meet to `ERROR_NAMES` in `src/zen/common.ts` with a plain-English explanation.

## Testing

Unit tests mock API responses and need no key. Integration tests hit the public API and need `BUNGIE_API_KEY` in `.env`. There are no automated tests against a signed-in account; for signed-in tools, test with `dryRun` first, then one real, reversible change, and record findings in the pull request.

`vitest` uses native rollup binaries, so run tests on the same OS the dependencies were installed on (e.g. install and test on Windows, not from a Linux VM sharing the folder).

## Pull requests

1. Branch from `master` (`git checkout -b feature/short-name`).
2. Make the change, with tests where practical.
3. Run the checks above.
4. Commit with a conventional prefix: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:` (e.g. `feat: add vendor stock filter by slot`).
5. Push and open a pull request describing what changed and how you tested it.

## Security

- Never commit `.env`, API keys, client secrets or `tokens.json`.
- Keep error messages free of keys and tokens.
- Report vulnerabilities privately (see SECURITY.md).
