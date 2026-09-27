import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotSignedInError } from '../auth/oauth.js';
import { InventoryService, formatWeapon, toCsv, type WeaponRow } from '../zen/inventory.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function errorResult(err: unknown) {
  const msg =
    err instanceof NotSignedInError
      ? err.message
      : `Error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

const Filters = {
  name: z.string().optional().describe('Case-insensitive part of the weapon name, e.g. "chroma"'),
  type: z
    .string()
    .optional()
    .describe(
      'Weapon type, e.g. "Auto Rifle", "Submachine Gun", "Hand Cannon" (case-insensitive, partial ok)'
    ),
  perk: z
    .string()
    .optional()
    .describe('Only weapons that rolled this perk in any column, e.g. "Kill Clip" (partial ok)'),
  location: z
    .enum(['vault', 'hunter', 'titan', 'warlock', 'any'])
    .optional()
    .describe('Where the weapon is (default any)'),
};

function applyFilters(
  rows: WeaponRow[],
  f: { name?: string; type?: string; perk?: string; location?: string }
): WeaponRow[] {
  const has = (hay: string, needle?: string) =>
    !needle || hay.toLowerCase().includes(needle.toLowerCase());
  return rows.filter(
    (r) =>
      has(r.name, f.name) &&
      has(r.type, f.type) &&
      (!f.location || f.location === 'any' || r.location.toLowerCase() === f.location) &&
      (!f.perk || r.columns.some((c) => c.options.some((o) => has(o.name, f.perk))))
  );
}

export function registerInventoryTools(
  server: McpServer,
  inventory: InventoryService,
  exportDir: string | undefined
): void {
  server.tool(
    'get_weapons',
    "List the signed-in user's own weapons (vault + all characters) with every rolled perk option per column (selected option in *asterisks*), frame, masterwork, mod, element, gear tier, power, lock state and stats. Filter by name, type, perk or location; paged. Requires sign-in.",
    {
      ...Filters,
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max weapons to return (default 25)'),
      offset: z.number().int().min(0).optional().describe('Skip this many matches (paging)'),
      refresh: z
        .boolean()
        .optional()
        .describe('Force a fresh read from Bungie (default uses a 60 s cache)'),
    },
    async ({ limit = 25, offset = 0, refresh, ...filters }) => {
      try {
        const all = await inventory.getWeapons(refresh);
        const rows = applyFilters(all, filters);
        const page = rows.slice(offset, offset + limit);
        const lines = [
          `${rows.length} matching weapon(s) of ${all.length}; showing ${page.length} from ${offset + 1}.`,
          '',
          ...page.map((w) => formatWeapon(w)),
        ];
        if (offset + limit < rows.length)
          lines.push('', `More available: call again with offset ${offset + limit}.`);
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_weapon',
    "Full detail for one of the user's weapons by item instance id, including socket indexes and perk hashes needed to change perks. Requires sign-in.",
    { itemId: z.string().describe('Item instance id (from get_weapons, export_weapons or DIM)') },
    async ({ itemId }) => {
      try {
        const id = itemId.replace(/"/g, '');
        const w = (await inventory.getWeapons()).find((r) => r.itemId === id);
        if (!w) return errorResult(new Error(`No weapon with id ${id} found in your inventory`));
        const cols = w.columns
          .map(
            (c) =>
              `- ${c.label} (socket ${c.socketIndex}): ` +
              c.options
                .map(
                  (o) =>
                    `${o.hash === c.selectedHash ? '**' : ''}${o.name}${o.enhanced ? ' (enhanced)' : ''} [${o.hash}]${o.hash === c.selectedHash ? '**' : ''}`
                )
                .join(', ')
          )
          .join('\n');
        return text(
          [
            formatWeapon(w, true),
            '',
            `Item hash ${w.itemHash}; slot ${w.slot}; ammo ${w.ammo}; rarity ${w.rarity}; character ${w.characterId ?? 'none (vault)'}`,
            '',
            '## Perk columns (selected in bold)',
            cols,
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'export_weapons',
    "Write the user's full weapon inventory to a CSV and a JSON file (perk columns in socket order, all rolled options, selected marked with *), for triage scripts. Returns the file paths. Requires sign-in.",
    { refresh: z.boolean().optional().describe('Force a fresh read from Bungie') },
    async ({ refresh }) => {
      try {
        const rows = await inventory.getWeapons(refresh);
        const dir = exportDir || path.join(os.homedir(), '.destiny-zen', 'exports');
        await fs.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        const csvPath = path.join(dir, `zen-weapons-${stamp}.csv`);
        const jsonPath = path.join(dir, `zen-weapons-${stamp}.json`);
        await fs.writeFile(csvPath, toCsv(rows), 'utf8');
        await fs.writeFile(jsonPath, JSON.stringify(rows, null, 1), 'utf8');
        const byType = rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.type] = (acc[r.type] ?? 0) + 1;
          return acc;
        }, {});
        return text(
          [
            `Exported ${rows.length} weapons.`,
            `- CSV: ${csvPath}`,
            `- JSON: ${jsonPath}`,
            '',
            Object.entries(byType)
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => `${t}: ${n}`)
              .join(', '),
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
