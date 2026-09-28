/**
 * Item movement and equipping for the signed-in user's own gear.
 *
 * equip_items: moves each requested item to the chosen character (vault -> character, or
 * other character -> vault -> character) with TransferItem, then equips them all in one
 * EquipItems call. Bungie scope: MoveEquipDestinyItems (already granted to Destiny Zen).
 * The character must be in orbit, a social space or offline.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BungieOAuth } from '../auth/oauth.js';
import { NotSignedInError } from '../auth/oauth.js';
import { authedGet, authedPost } from './auth-tools.js';
import type { InventoryService } from '../zen/inventory.js';
import type { ZenDefs } from '../zen/defs.js';
import { itemName } from '../zen/common.js';

const CharacterEnum = z.enum(['hunter', 'titan', 'warlock']);
const CLASS_TYPE: Record<string, number> = { titan: 0, hunter: 1, warlock: 2 };
const VAULT_BUCKET = 138197802;
const POSTMASTER_BUCKET = 215593132;
const ACTION_GAP_MS = 250;

/** Bungie PlatformErrorCodes most likely to come back from transfer/equip. */
const ERROR_NAMES: Record<number, string> = {
  1: 'Success',
  1620: 'character not found',
  1623: 'item not found',
  1634: 'character is not in orbit, a social space or offline',
  1641: 'only one exotic of this kind can be equipped (unique equip restriction)',
  1642: 'no room in destination',
  1645: 'transfer failed',
  1648: 'uniqueness violation',
  1655: 'can only equip in game',
  1656: 'cannot act on an equipped item',
  1660: 'item not transferable',
  1672: 'throttled by the game server, try again shortly',
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RawItem {
  itemHash: number;
  itemInstanceId?: string;
  bucketHash?: number;
  quantity?: number;
  state?: number;
}

interface LocationProfile {
  profileInventory?: { data?: { items: RawItem[] } };
  characters?: { data?: Record<string, { classType: number }> };
  characterInventories?: { data?: Record<string, { items: RawItem[] }> };
  characterEquipment?: { data?: Record<string, { items: RawItem[] }> };
}

export interface ItemLocation {
  itemId: string;
  itemHash: number;
  bucketHash: number;
  /** vault, inventory (on a character, not equipped), equipped, postmaster */
  where: 'vault' | 'inventory' | 'equipped' | 'postmaster';
  characterId: string | null;
  quantity: number;
  locked: boolean;
}

interface Snapshot {
  items: Map<string, ItemLocation>;
  classOf: Map<string, number>;
}

function readLocations(p: LocationProfile): Snapshot {
  const items = new Map<string, ItemLocation>();
  const classOf = new Map<string, number>();
  for (const [cid, c] of Object.entries(p.characters?.data ?? {})) classOf.set(cid, c.classType);
  for (const it of p.profileInventory?.data?.items ?? []) {
    if (!it.itemInstanceId) continue;
    items.set(it.itemInstanceId, {
      itemId: it.itemInstanceId,
      itemHash: it.itemHash,
      bucketHash: it.bucketHash ?? VAULT_BUCKET,
      where: 'vault',
      characterId: null,
      quantity: it.quantity ?? 1,
      locked: ((it.state ?? 0) & 1) !== 0,
    });
  }
  for (const [cid, inv] of Object.entries(p.characterInventories?.data ?? {})) {
    inv.items.forEach((it, n) => {
      if (!it.itemInstanceId && it.bucketHash === POSTMASTER_BUCKET) {
        const key = `pm:${cid}:${it.itemHash}:${n}`;
        items.set(key, {
          itemId: key,
          itemHash: it.itemHash,
          bucketHash: POSTMASTER_BUCKET,
          where: 'postmaster',
          characterId: cid,
          quantity: it.quantity ?? 1,
          locked: false,
        });
      }
    });
    for (const it of inv.items) {
      if (!it.itemInstanceId) continue;
      items.set(it.itemInstanceId, {
        itemId: it.itemInstanceId,
        itemHash: it.itemHash,
        bucketHash: it.bucketHash ?? 0,
        where: it.bucketHash === POSTMASTER_BUCKET ? 'postmaster' : 'inventory',
        characterId: cid,
        quantity: it.quantity ?? 1,
        locked: ((it.state ?? 0) & 1) !== 0,
      });
    }
  }
  for (const [cid, eq] of Object.entries(p.characterEquipment?.data ?? {})) {
    for (const it of eq.items) {
      if (!it.itemInstanceId) continue;
      items.set(it.itemInstanceId, {
        itemId: it.itemInstanceId,
        itemHash: it.itemHash,
        bucketHash: it.bucketHash ?? 0,
        where: 'equipped',
        characterId: cid,
        quantity: it.quantity ?? 1,
        locked: ((it.state ?? 0) & 1) !== 0,
      });
    }
  }
  return { items, classOf };
}

function bungieCode(err: unknown): number | null {
  const m = /Bungie API error (\d+)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

export function registerItemTools(
  server: McpServer,
  oauth: BungieOAuth,
  apiKey: string,
  inventory: InventoryService,
  defs: ZenDefs
): void {
  async function snapshot(): Promise<Snapshot> {
    const m = await inventory.getMembership();
    const p = await authedGet<LocationProfile>(
      oauth,
      apiKey,
      `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=102,200,201,205`
    );
    return readLocations(p);
  }

  async function nameOf(hash: number): Promise<string> {
    return itemName(await defs.get(), hash);
  }

  /** Inventory bucket an item definition belongs to (its equipment slot). */
  const bucketCache = new Map<number, number>();
  async function defBucket(hash: number): Promise<number> {
    const d = await defs.get();
    const w = d.weapons[String(hash)];
    if (w?.b) return w.b;
    const cached = bucketCache.get(hash);
    if (cached !== undefined) return cached;
    const def = await authedGet<{ inventory?: { bucketTypeHash?: number } }>(
      oauth,
      apiKey,
      `/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`
    );
    const b = def.inventory?.bucketTypeHash ?? 0;
    bucketCache.set(hash, b);
    return b;
  }

  async function transfer(
    loc: ItemLocation,
    characterId: string,
    toVault: boolean,
    membershipType: number
  ): Promise<void> {
    await authedPost(oauth, apiKey, '/Destiny2/Actions/Items/TransferItem/', {
      itemReferenceHash: loc.itemHash,
      stackSize: 1,
      transferToVault: toVault,
      itemId: loc.itemId,
      characterId,
      membershipType,
    });
    await sleep(ACTION_GAP_MS);
  }

  server.tool(
    'equip_items',
    "Equip specific items (weapons, armour, subclass, ghost...) by item instance id on a character. Items in the vault or on another character are moved first (another character's equipped items can't be moved). If the character's slot is full, one unequipped item from that slot (not one of the requested items) is sent to the vault to make room. The character must be in orbit, in a social space or offline. Use dryRun to preview. Requires sign-in.",
    {
      character: CharacterEnum,
      itemIds: z
        .array(z.string())
        .min(1)
        .max(12)
        .describe('Item instance ids (from get_weapons, get_loadouts, DIM exports)'),
      dryRun: z.boolean().optional().describe('Only show what would happen (default false)'),
    },
    async ({ character, itemIds, dryRun }) => {
      try {
        const m = await inventory.getMembership();
        const snap = await snapshot();
        const targetId = [...snap.classOf.entries()].find(
          ([, c]) => c === CLASS_TYPE[character]
        )?.[0];
        if (!targetId) return text(`No ${character} on this account.`, true);

        const ids = [...new Set(itemIds.map((i) => i.replace(/["\s]/g, '')))];
        const lines: string[] = [];
        const toEquip: string[] = [];
        const requested = new Set(ids);

        for (const id of ids) {
          const loc = snap.items.get(id);
          if (!loc) {
            lines.push(`- ${id}: not found on the account; skipped.`);
            continue;
          }
          const name = `${await nameOf(loc.itemHash)} (${id})`;
          if (loc.where === 'postmaster') {
            lines.push(`- ${name}: in the Postmaster; pull it out first. Skipped.`);
            continue;
          }
          if (loc.characterId === targetId) {
            lines.push(
              `- ${name}: already on ${character}${loc.where === 'equipped' ? ' (equipped)' : ''}.`
            );
            toEquip.push(id);
            continue;
          }
          if (loc.where === 'equipped') {
            lines.push(
              `- ${name}: equipped on another character, which Bungie won't move. Unequip it there first. Skipped.`
            );
            continue;
          }
          const route =
            loc.where === 'vault'
              ? 'vault -> ' + character
              : 'other character -> vault -> ' + character;
          if (dryRun) {
            lines.push(`- ${name}: would move ${route}.`);
            toEquip.push(id);
            continue;
          }
          let roomNote = '';
          try {
            if (loc.where === 'inventory' && loc.characterId) {
              await transfer(loc, loc.characterId, true, m.membershipType);
            }
            try {
              await transfer(loc, targetId, false, m.membershipType);
            } catch (err) {
              if (bungieCode(err) !== 1642) throw err;
              // Slot full on the target character: send one unrequested item from that slot to the vault.
              const bucket = await defBucket(loc.itemHash);
              const victim = [...snap.items.values()].find(
                (x) =>
                  x.characterId === targetId &&
                  x.where === 'inventory' &&
                  x.bucketHash === bucket &&
                  !requested.has(x.itemId)
              );
              if (!victim) throw err;
              await transfer(victim, targetId, true, m.membershipType);
              snap.items.set(victim.itemId, { ...victim, where: 'vault', characterId: null });
              roomNote = `  (made room: sent ${await nameOf(victim.itemHash)} to the vault)`;
              await transfer(loc, targetId, false, m.membershipType);
            }
            lines.push(`- ${name}: moved ${route}.`);
            if (roomNote) lines.push(roomNote);
            toEquip.push(id);
          } catch (err) {
            const code = bungieCode(err);
            lines.push(
              `- ${name}: move failed${code ? ` (${ERROR_NAMES[code] ?? `error ${code}`})` : ''}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        if (!toEquip.length) {
          return text(['Nothing to equip.', ...lines].join('\n'), true);
        }
        if (dryRun) {
          return text(
            [`Dry run for ${character}: would equip ${toEquip.length} item(s).`, ...lines].join(
              '\n'
            )
          );
        }

        const res = await authedPost<{
          equipResults: Array<{ itemInstanceId: string | number; equipStatus: number }>;
        }>(oauth, apiKey, '/Destiny2/Actions/Items/EquipItems/', {
          itemIds: toEquip,
          characterId: targetId,
          membershipType: m.membershipType,
        });
        // Exotic clashes (1641) happen when the old exotic was still on while the new one
        // was processed; once the rest of the set is equipped, retry those items once.
        const retry = (res.equipResults ?? []).filter((r) => r.equipStatus === 1641);
        if (retry.length) {
          await sleep(ACTION_GAP_MS);
          const again = await authedPost<typeof res>(
            oauth,
            apiKey,
            '/Destiny2/Actions/Items/EquipItems/',
            {
              itemIds: retry.map((r) => String(r.itemInstanceId)),
              characterId: targetId,
              membershipType: m.membershipType,
            }
          );
          for (const r2 of again.equipResults ?? []) {
            const hit = res.equipResults.find(
              (r) => String(r.itemInstanceId) === String(r2.itemInstanceId)
            );
            if (hit) hit.equipStatus = r2.equipStatus;
          }
        }
        inventory.invalidate();
        const results: string[] = [];
        let ok = 0;
        for (const r of res.equipResults ?? []) {
          const id = String(r.itemInstanceId);
          const loc = snap.items.get(id);
          const name = loc ? await nameOf(loc.itemHash) : id;
          if (r.equipStatus === 1) {
            ok++;
            results.push(`- ${name}: equipped.`);
          } else {
            results.push(
              `- ${name}: not equipped (${ERROR_NAMES[r.equipStatus] ?? `error ${r.equipStatus}`}).`
            );
          }
        }
        return text(
          [
            `Equipped ${ok} of ${toEquip.length} item(s) on ${character}.`,
            '',
            'Moves:',
            ...lines,
            '',
            'Equip results:',
            ...results,
          ].join('\n'),
          ok === 0
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'transfer_items',
    "Move the user's own items (by instance id) to the vault or to a character without equipping them. Items equipped on a character can't be moved. If the destination slot on a character is full, one unrequested item from that slot goes to the vault first. Use dryRun to preview. Requires sign-in.",
    {
      itemIds: z.array(z.string()).min(1).max(25),
      to: z.enum(['vault', 'hunter', 'titan', 'warlock']),
      dryRun: z.boolean().optional(),
    },
    async ({ itemIds, to, dryRun }) => {
      try {
        const m = await inventory.getMembership();
        const snap = await snapshot();
        const targetId =
          to === 'vault'
            ? null
            : ([...snap.classOf.entries()].find(([, c]) => c === CLASS_TYPE[to])?.[0] ?? null);
        if (to !== 'vault' && !targetId) return text(`No ${to} on this account.`, true);
        const ids = [...new Set(itemIds.map((i) => i.replace(/["\s]/g, '')))];
        const requested = new Set(ids);
        const lines: string[] = [];
        let moved = 0;
        for (const id of ids) {
          const loc = snap.items.get(id);
          if (!loc) {
            lines.push(`- ${id}: not found; skipped.`);
            continue;
          }
          const name = `${await nameOf(loc.itemHash)} (${id})`;
          if (loc.where === 'equipped') {
            lines.push(`- ${name}: equipped; unequip it first. Skipped.`);
            continue;
          }
          if (loc.where === 'postmaster') {
            lines.push(`- ${name}: in the Postmaster; use pull_from_postmaster. Skipped.`);
            continue;
          }
          if (
            (to === 'vault' && loc.where === 'vault') ||
            (targetId && loc.characterId === targetId)
          ) {
            lines.push(`- ${name}: already there.`);
            continue;
          }
          if (dryRun) {
            lines.push(`- ${name}: would move to ${to}.`);
            continue;
          }
          try {
            if (loc.where === 'inventory' && loc.characterId) {
              await transfer(loc, loc.characterId, true, m.membershipType);
            }
            if (targetId) {
              try {
                await transfer(loc, targetId, false, m.membershipType);
              } catch (err) {
                if (bungieCode(err) !== 1642) throw err;
                const bucket = await defBucket(loc.itemHash);
                const victim = [...snap.items.values()].find(
                  (x) =>
                    x.characterId === targetId &&
                    x.where === 'inventory' &&
                    x.bucketHash === bucket &&
                    !requested.has(x.itemId)
                );
                if (!victim) throw err;
                await transfer(victim, targetId, true, m.membershipType);
                snap.items.set(victim.itemId, { ...victim, where: 'vault', characterId: null });
                lines.push(`  (made room: sent ${await nameOf(victim.itemHash)} to the vault)`);
                await transfer(loc, targetId, false, m.membershipType);
              }
            }
            moved++;
            lines.push(`- ${name}: moved to ${to}.`);
          } catch (err) {
            const code = bungieCode(err);
            lines.push(
              `- ${name}: failed${code ? ` (${ERROR_NAMES[code] ?? `error ${code}`})` : ''}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        inventory.invalidate();
        return text(
          [
            dryRun
              ? `Dry run: move to ${to}.`
              : `Moved ${moved} of ${ids.length} item(s) to ${to}.`,
            ...lines,
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'set_lock',
    "Lock or unlock the user's own items by instance id (vault or characters). Requires sign-in.",
    {
      itemIds: z.array(z.string()).min(1).max(50),
      locked: z.boolean(),
      dryRun: z.boolean().optional(),
    },
    async ({ itemIds, locked, dryRun }) => {
      try {
        const m = await inventory.getMembership();
        const snap = await snapshot();
        const anyChar = [...snap.classOf.keys()][0];
        const lines: string[] = [];
        let changed = 0;
        for (const raw of [...new Set(itemIds)]) {
          const id = raw.replace(/["\s]/g, '');
          const loc = snap.items.get(id);
          if (!loc) {
            lines.push(`- ${id}: not found; skipped.`);
            continue;
          }
          const name = `${await nameOf(loc.itemHash)} (${id})`;
          if (loc.locked === locked) {
            lines.push(`- ${name}: already ${locked ? 'locked' : 'unlocked'}.`);
            continue;
          }
          if (dryRun) {
            lines.push(`- ${name}: would ${locked ? 'lock' : 'unlock'}.`);
            continue;
          }
          try {
            await authedPost(oauth, apiKey, '/Destiny2/Actions/Items/SetLockState/', {
              state: locked,
              itemId: id,
              characterId: loc.characterId ?? anyChar,
              membershipType: m.membershipType,
            });
            changed++;
            lines.push(`- ${name}: ${locked ? 'locked' : 'unlocked'}.`);
            await sleep(ACTION_GAP_MS);
          } catch (err) {
            const code = bungieCode(err);
            lines.push(
              `- ${name}: failed${code ? ` (${ERROR_NAMES[code] ?? `error ${code}`})` : ''}.`
            );
          }
        }
        inventory.invalidate();
        return text([dryRun ? 'Dry run:' : `Changed ${changed} item(s).`, ...lines].join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'pull_from_postmaster',
    "List or pull items from a character's Postmaster. With no itemIds it lists what is there (and pulls everything if pullAll is true). Uninstanced items (materials) are listed with ids like pm:... that can be passed back. Requires sign-in.",
    {
      character: CharacterEnum,
      itemIds: z.array(z.string()).optional(),
      pullAll: z.boolean().optional(),
    },
    async ({ character, itemIds, pullAll }) => {
      try {
        const m = await inventory.getMembership();
        const snap = await snapshot();
        const cid = [...snap.classOf.entries()].find(([, c]) => c === CLASS_TYPE[character])?.[0];
        if (!cid) return text(`No ${character} on this account.`, true);
        const pm = [...snap.items.values()].filter(
          (x) => x.where === 'postmaster' && x.characterId === cid
        );
        if (!pm.length) return text(`${character}'s Postmaster is empty.`);
        const wanted = itemIds?.length
          ? pm.filter((x) => itemIds.map((i) => i.replace(/["\s]/g, '')).includes(x.itemId))
          : pullAll
            ? pm
            : [];
        if (!wanted.length) {
          const list = await Promise.all(
            pm.map(
              async (x) =>
                `- ${await nameOf(x.itemHash)}${x.quantity > 1 ? ` x${x.quantity}` : ''} · id:${x.itemId}`
            )
          );
          return text([`${character}'s Postmaster (${pm.length}):`, ...list].join('\n'));
        }
        const lines: string[] = [];
        let pulled = 0;
        for (const x of wanted) {
          const name = await nameOf(x.itemHash);
          try {
            await authedPost(oauth, apiKey, '/Destiny2/Actions/Items/PullFromPostmaster/', {
              itemReferenceHash: x.itemHash,
              stackSize: x.quantity,
              itemId: x.itemId.startsWith('pm:') ? '0' : x.itemId,
              characterId: cid,
              membershipType: m.membershipType,
            });
            pulled++;
            lines.push(`- ${name}${x.quantity > 1 ? ` x${x.quantity}` : ''}: pulled.`);
            await sleep(ACTION_GAP_MS);
          } catch (err) {
            const code = bungieCode(err);
            lines.push(
              `- ${name}: failed${code ? ` (${ERROR_NAMES[code] ?? `error ${code}`})` : ''}.`
            );
          }
        }
        inventory.invalidate();
        return text([`Pulled ${pulled} of ${wanted.length} item(s).`, ...lines].join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
