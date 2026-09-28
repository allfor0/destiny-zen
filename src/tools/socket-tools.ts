/**
 * set_sockets: insert free and reversible plugs into any socket of the user's own items
 * (armour mods incl. stat and tuning mods, subclass super/abilities/aspects/fragments,
 * artifact perks if Bungie allows, weapon perks). Uses InsertSocketPlugFree.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BungieOAuth } from '../auth/oauth.js';
import { authedGet, authedPost } from './auth-tools.js';
import type { InventoryService } from '../zen/inventory.js';
import type { ZenDefs, ZenDefsData } from '../zen/defs.js';
import { mergePlugSets, type SocketResolver } from '../zen/sockets.js';
import { cleanId, describeError, errorResult, itemName, norm, sleep, text } from '../zen/common.js';

/** Bungie limits socket actions to 2 per second per user. */
const SOCKET_ACTION_GAP_MS = 600;
const MAX_ACTIONS = 30;

interface PlannedPlug {
  itemId: string;
  itemName: string;
  characterId: string;
  socketIndex: number;
  from: string;
  to: string;
  /** candidate hashes with this name, tried in order */
  hashes: number[];
}

interface ItemRead {
  characterId?: string;
  item?: { data?: { itemHash: number } };
  sockets?: { data?: { sockets: Array<{ plugHash?: number }> } };
  reusablePlugs?: {
    data?: { plugs: Record<string, Array<{ plugItemHash: number; canInsert?: boolean }>> };
  };
}

function plugName(d: ZenDefsData, h?: number): string {
  return h ? itemName(d, h) : '(empty)';
}

export function registerSocketTools(
  server: McpServer,
  oauth: BungieOAuth,
  apiKey: string,
  inventory: InventoryService,
  defs: ZenDefs,
  sockets: SocketResolver
): void {
  server.tool(
    'set_sockets',
    'Insert plugs by name into sockets of the user\'s own items: armour mods (stat, tuning, utility), subclass super/class ability/jump/melee/grenade/aspects/fragments, weapon perks, and artifact perks if Bungie allows it. Free and reversible changes only (InsertSocketPlugFree). Names are matched against what each socket can take; the socket is picked automatically unless socketIndex is given (see get_item with options). Removals ("Empty ... Socket") run first, then plugs in the order given, so set aspects before fragments. The character must be in orbit, in a social space or offline. Use dryRun to preview. Requires sign-in.',
    {
      changes: z
        .array(
          z.object({
            itemId: z
              .string()
              .describe('Item instance id (armour piece, subclass, weapon, artifact)'),
            plugs: z
              .array(
                z.union([
                  z.string(),
                  z.object({ name: z.string(), socketIndex: z.number().int().min(0) }),
                ])
              )
              .min(1)
              .describe(
                'Plug names, e.g. ["Winter\'s Shroud", "Whisper of Durance", "Health Mod"], or {name, socketIndex}'
              ),
          })
        )
        .min(1)
        .max(10),
      dryRun: z.boolean().optional(),
      force: z
        .boolean()
        .optional()
        .describe(
          "Insert even if Bungie's read says the plug is already there (its read lags 1-2 min after a change)"
        ),
    },
    async ({ changes, dryRun, force }) => {
      try {
        const [d, m, charIds] = await Promise.all([
          defs.get(),
          inventory.getMembership(),
          inventory.getCharacterIds(),
        ]);
        const planned: PlannedPlug[] = [];
        const notes: string[] = [];
        const plugSetProfile = await inventory.getProfileRaw<Parameters<typeof mergePlugSets>[0]>([
          305,
        ]);

        for (const req of changes) {
          const id = cleanId(req.itemId);
          const r = await authedGet<ItemRead>(
            oauth,
            apiKey,
            `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Item/${id}/?components=305,307,310`
          );
          const hash = r.item?.data?.itemHash;
          if (!hash) {
            notes.push(`${id}: item not found; skipped.`);
            continue;
          }
          const def = await sockets.itemDef(hash);
          const label = `${def.name} (${id})`;
          const live = r.sockets?.data?.sockets ?? [];
          const characterId = r.characterId ? String(r.characterId) : charIds[0];
          const cands = await sockets.candidates(
            hash,
            r.reusablePlugs?.data?.plugs,
            mergePlugSets(plugSetProfile, characterId)
          );
          const current = live.map((s) => s.plugHash ?? 0);
          const wanted: Array<{ name: string; socketIndex?: number }> = req.plugs.map((p) =>
            typeof p === 'string' ? { name: p } : p
          );
          const wantedKeys = new Set(wanted.map((w) => norm(w.name)));
          const taken = new Set<number>();
          const itemPlans: PlannedPlug[] = [];

          for (const w of wanted) {
            const key = norm(w.name);
            const socketsWith: Array<{ idx: number; hashes: number[] }> = [];
            for (const [idx, list] of cands) {
              const hashes = list.filter((h) => norm(itemName(d, h)) === key);
              if (hashes.length) socketsWith.push({ idx, hashes });
            }
            if (w.socketIndex !== undefined) {
              const hit = socketsWith.find((s) => s.idx === w.socketIndex);
              if (!hit) {
                notes.push(`${label}: socket ${w.socketIndex} can't take "${w.name}"; skipped.`);
                continue;
              }
              socketsWith.splice(0, socketsWith.length, hit);
            }
            if (!socketsWith.length) {
              notes.push(
                `${label}: no socket takes "${w.name}" (check spelling or unlocks); skipped.`
              );
              continue;
            }
            const isEmpty = /^empty/i.test(w.name);
            // Already there (and not a removal request)? keep it.
            const already =
              !isEmpty &&
              !force &&
              socketsWith.find((s) => s.hashes.includes(current[s.idx]) && !taken.has(s.idx));
            if (already) {
              taken.add(already.idx);
              notes.push(`${label}: ${w.name} already in socket ${already.idx}.`);
              continue;
            }
            // Prefer a socket that is empty or holds a plug not requested in this batch.
            const free = socketsWith.filter((s) => !taken.has(s.idx));
            const pick =
              free.find(
                (s) => /^(empty|default)/i.test(plugName(d, current[s.idx])) || !current[s.idx]
              ) ??
              free.find((s) => !wantedKeys.has(norm(plugName(d, current[s.idx])))) ??
              (isEmpty ? free[0] : undefined);
            if (!pick) {
              notes.push(`${label}: no free socket left for "${w.name}"; skipped.`);
              continue;
            }
            taken.add(pick.idx);
            // Prefer the hash the live reusable plugs offer, and ones marked canInsert.
            const liveOpts = r.reusablePlugs?.data?.plugs?.[String(pick.idx)] ?? [];
            const ordered = [
              ...pick.hashes.filter((h) =>
                liveOpts.some((o) => o.plugItemHash === h && o.canInsert !== false)
              ),
              ...pick.hashes,
            ];
            itemPlans.push({
              itemId: id,
              itemName: def.name,
              characterId,
              socketIndex: pick.idx,
              from: plugName(d, current[pick.idx]),
              to: itemName(d, pick.hashes[0]),
              hashes: [...new Set(ordered)],
            });
          }
          // Removals first, then the rest in request order
          itemPlans.sort((a, b) => Number(/^empty/i.test(b.to)) - Number(/^empty/i.test(a.to)));
          planned.push(...itemPlans);
        }

        if (planned.length > MAX_ACTIONS)
          return text(
            `That is ${planned.length} socket changes; split it into batches of ${MAX_ACTIONS} or fewer.`,
            true
          );
        const summary = planned.map(
          (p) => `- ${p.itemName} [${p.socketIndex}]: ${p.from} -> ${p.to}`
        );
        if (dryRun || !planned.length) {
          return text(
            [
              dryRun ? `Dry run: ${planned.length} socket change(s).` : 'Nothing to change.',
              ...summary,
              ...(notes.length ? ['', 'Notes:', ...notes.map((n) => `- ${n}`)] : []),
            ].join('\n')
          );
        }

        const done: string[] = [];
        const failed: string[] = [];
        for (const p of planned) {
          let ok = false;
          let lastErr: unknown = null;
          for (const h of p.hashes) {
            try {
              await authedPost(oauth, apiKey, '/Destiny2/Actions/Items/InsertSocketPlugFree/', {
                plug: { socketIndex: p.socketIndex, socketArrayType: 0, plugItemHash: h },
                itemId: p.itemId,
                characterId: p.characterId,
                membershipType: m.membershipType,
              });
              ok = true;
              break;
            } catch (err) {
              lastErr = err;
              await sleep(SOCKET_ACTION_GAP_MS);
              if (!/1680|1676|PlugItemNotAvailable|InsertionRules/.test(String(err))) break;
            }
          }
          await sleep(SOCKET_ACTION_GAP_MS);
          if (ok) done.push(`- ${p.itemName} [${p.socketIndex}]: ${p.from} -> ${p.to}`);
          else failed.push(`- ${p.itemName} [${p.socketIndex}] ${p.to}: ${describeError(lastErr)}`);
        }
        inventory.invalidate();
        return text(
          [
            `Applied ${done.length} of ${planned.length} socket change(s).`,
            ...done,
            ...(failed.length ? ['', 'Failed:', ...failed] : []),
            ...(notes.length ? ['', 'Notes:', ...notes.map((n) => `- ${n}`)] : []),
          ].join('\n'),
          done.length === 0 && failed.length > 0
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
