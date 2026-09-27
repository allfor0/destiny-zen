import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BungieOAuth } from '../auth/oauth.js';
import { NotSignedInError } from '../auth/oauth.js';
import { authedPost } from './auth-tools.js';
import type { InventoryService, LoadoutView } from '../zen/inventory.js';

const CharacterEnum = z.enum(['hunter', 'titan', 'warlock']);

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function errorResult(err: unknown) {
  return text(
    err instanceof NotSignedInError
      ? err.message
      : `Error: ${err instanceof Error ? err.message : String(err)}`,
    true
  );
}

function describe(lo: LoadoutView, detail: boolean): string {
  const title = `${lo.className} slot ${lo.index + 1}: ${lo.empty ? '(empty)' : lo.name || '(unnamed)'}`;
  if (lo.empty) return title;
  const lines = lo.items.map((i) => {
    const plugs = detail && i.plugs.length ? `: ${i.plugs.join(', ')}` : '';
    return `  - ${i.name}${i.type ? ` (${i.type})` : ''}${plugs}`;
  });
  return [title, ...lines].join('\n');
}

export function registerLoadoutTools(
  server: McpServer,
  oauth: BungieOAuth,
  apiKey: string,
  inventory: InventoryService
): void {
  async function findSlot(character: string, slot: number): Promise<LoadoutView> {
    const all = await inventory.getLoadouts(true);
    const lo = all.find((l) => l.className.toLowerCase() === character && l.index === slot - 1);
    if (!lo) throw new Error(`No loadout slot ${slot} on ${character}`);
    return lo;
  }

  async function resolveIdentifiers(
    current: LoadoutView,
    name?: string,
    color?: number,
    icon?: number
  ): Promise<{ nameHash: number; colorHash: number; iconHash: number }> {
    const defs = await inventory.getLoadoutDefs();
    let nameHash = current.nameHash;
    if (name) {
      const hit = Object.entries(defs.loadoutNames).find(
        ([, n]) => n.toLowerCase() === name.toLowerCase()
      );
      if (!hit) {
        throw new Error(
          `"${name}" is not an in-game loadout name. Available: ${[...new Set(Object.values(defs.loadoutNames))].sort().join(', ')}`
        );
      }
      nameHash = Number(hit[0]);
    }
    const pick = (list: number[], n: number | undefined, fallback: number, what: string) => {
      if (n === undefined) return fallback;
      if (n < 1 || n > list.length) throw new Error(`${what} must be 1 to ${list.length}`);
      return list[n - 1];
    };
    return {
      nameHash,
      colorHash: pick(defs.loadoutColors, color, current.colorHash, 'color'),
      iconHash: pick(defs.loadoutIcons, icon, current.iconHash, 'icon'),
    };
  }

  server.tool(
    'get_loadouts',
    "List the user's in-game (Bungie) loadouts for each character: slot, name and items. Set detail to include subclass aspects/fragments and armour mods. Requires sign-in. (DIM loadouts are stored by DIM and are not visible here.)",
    {
      character: CharacterEnum.optional().describe('Only this character'),
      detail: z.boolean().optional().describe('Include plugs (aspects, fragments, mods) per item'),
      includeEmpty: z.boolean().optional().describe('Also list empty slots (default false)'),
    },
    async ({ character, detail, includeEmpty }) => {
      try {
        const all = await inventory.getLoadouts(true);
        const rows = all.filter(
          (l) =>
            (!character || l.className.toLowerCase() === character) && (includeEmpty || !l.empty)
        );
        const empty = all.filter(
          (l) => l.empty && (!character || l.className.toLowerCase() === character)
        ).length;
        return text(
          [
            `${rows.length} loadout(s) shown; ${empty} empty slot(s)${includeEmpty ? '' : ' hidden'}.`,
            '',
            ...rows.map((l) => describe(l, detail ?? false)),
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'equip_loadout',
    "Equip one of the user's in-game loadouts on a character. The character must be in orbit, in a social space or offline. Requires sign-in.",
    {
      character: CharacterEnum,
      slot: z
        .number()
        .int()
        .min(1)
        .max(12)
        .describe('Loadout slot number as shown by get_loadouts (1-based)'),
    },
    async ({ character, slot }) => {
      try {
        const lo = await findSlot(character, slot);
        if (lo.empty) return text(`${character} slot ${slot} is empty; nothing to equip.`, true);
        const m = await inventory.getMembership();
        await authedPost(oauth, apiKey, '/Destiny2/Actions/Loadouts/EquipLoadout/', {
          loadoutIndex: lo.index,
          characterId: lo.characterId,
          membershipType: m.membershipType,
        });
        inventory.invalidate();
        return text(`Equipped ${lo.className} slot ${slot}: ${lo.name || '(unnamed)'}.`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'snapshot_loadout',
    "Save the character's currently equipped gear (weapons, armour, subclass setup) into an in-game loadout slot, overwriting whatever the slot held. Optionally set the slot's name (one of Bungie's preset names), colour and icon (1-based index). Requires sign-in.",
    {
      character: CharacterEnum,
      slot: z.number().int().min(1).max(12),
      name: z
        .string()
        .optional()
        .describe('Preset loadout name, e.g. "Crucible"; get the list from an error if unsure'),
      color: z.number().int().optional().describe('Colour number (1-based)'),
      icon: z.number().int().optional().describe('Icon number (1-based)'),
    },
    async ({ character, slot, name, color, icon }) => {
      try {
        const lo = await findSlot(character, slot);
        const ids = await resolveIdentifiers(lo, name, color, icon);
        const m = await inventory.getMembership();
        await authedPost(oauth, apiKey, '/Destiny2/Actions/Loadouts/SnapshotLoadout/', {
          loadoutIndex: lo.index,
          characterId: lo.characterId,
          membershipType: m.membershipType,
          ...ids,
        });
        inventory.invalidate();
        const was = lo.empty
          ? 'an empty slot'
          : `"${lo.name || 'unnamed'}" (${lo.items.map((i) => i.name).join(', ')})`;
        return text(
          `Saved current ${lo.className} gear to slot ${slot}. It previously held ${was}.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'rename_loadout',
    "Change an in-game loadout's name (one of Bungie's preset names), colour or icon without changing its items. Requires sign-in.",
    {
      character: CharacterEnum,
      slot: z.number().int().min(1).max(12),
      name: z.string().optional(),
      color: z.number().int().optional(),
      icon: z.number().int().optional(),
    },
    async ({ character, slot, name, color, icon }) => {
      try {
        const lo = await findSlot(character, slot);
        if (lo.empty)
          return text(`${character} slot ${slot} is empty; snapshot gear into it first.`, true);
        const ids = await resolveIdentifiers(lo, name, color, icon);
        const m = await inventory.getMembership();
        await authedPost(oauth, apiKey, '/Destiny2/Actions/Loadouts/UpdateLoadoutIdentifiers/', {
          loadoutIndex: lo.index,
          characterId: lo.characterId,
          membershipType: m.membershipType,
          ...ids,
        });
        inventory.invalidate();
        return text(`Updated ${lo.className} slot ${slot}.`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
