/**
 * Account reads: currencies and materials, crafted weapon levels, seasonal artifact,
 * collectibles (exotics owned), vendor stock, and per-weapon kill history.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BungieOAuth } from '../auth/oauth.js';
import { authedGet } from './auth-tools.js';
import type { InventoryService } from '../zen/inventory.js';
import type { ZenDefs } from '../zen/defs.js';
import { mergePlugSets, type SocketResolver } from '../zen/sockets.js';
import {
  ARMOR_BUCKETS,
  CLASS_NAME,
  CLASS_TYPE,
  CONSUMABLES_BUCKET,
  CharacterEnum,
  errorResult,
  itemName,
  text,
} from '../zen/common.js';

const ITEM_STATE_CRAFTED = 8;
const COLLECTIBLE_NOT_ACQUIRED = 1;

interface Item {
  itemHash: number;
  itemInstanceId?: string;
  bucketHash?: number;
  quantity?: number;
  state?: number;
}

export function registerAccountTools(
  server: McpServer,
  oauth: BungieOAuth,
  apiKey: string,
  inventory: InventoryService,
  defs: ZenDefs,
  sockets: SocketResolver
): void {
  async function charId(character: string): Promise<string | null> {
    const p = await inventory.getProfileRaw<{
      characters?: { data?: Record<string, { classType: number }> };
    }>([200]);
    return (
      Object.entries(p.characters?.data ?? {}).find(
        ([, c]) => c.classType === CLASS_TYPE[character]
      )?.[0] ?? null
    );
  }

  server.tool(
    'get_currencies',
    'Currencies and materials held by the user: Glimmer, Bright Dust, Enhancement Cores, Enhancement Prisms, Ascendant Alloys/Shards and other consumables, with quantities. Filter by name. Requires sign-in.',
    { name: z.string().optional().describe('Part of the name, e.g. "Enhancement"') },
    async ({ name }) => {
      try {
        const [d, p] = await Promise.all([
          defs.get(),
          inventory.getProfileRaw<{
            profileCurrencies?: { data?: { items: Item[] } };
            profileInventory?: { data?: { items: Item[] } };
            characterInventories?: { data?: Record<string, { items: Item[] }> };
          }>([102, 103, 201]),
        ]);
        const totals = new Map<number, number>();
        const add = (it: Item) =>
          totals.set(it.itemHash, (totals.get(it.itemHash) ?? 0) + (it.quantity ?? 0));
        for (const it of p.profileCurrencies?.data?.items ?? []) add(it);
        for (const it of p.profileInventory?.data?.items ?? [])
          if (
            !it.itemInstanceId &&
            (it.bucketHash === CONSUMABLES_BUCKET || d.misc[String(it.itemHash)])
          )
            add(it);
        for (const inv of Object.values(p.characterInventories?.data ?? {}))
          for (const it of inv.items)
            if (!it.itemInstanceId && d.misc[String(it.itemHash)]) add(it);
        let rows = [...totals.entries()].map(([h, q]) => ({ name: itemName(d, h), q }));
        if (name) rows = rows.filter((r) => r.name.toLowerCase().includes(name.toLowerCase()));
        rows.sort((a, b) => a.name.localeCompare(b.name));
        return text(
          [
            `${rows.length} currency/material type(s):`,
            ...rows.map((r) => `- ${r.name}: ${r.q.toLocaleString('en-GB')}`),
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_crafted',
    "The user's crafted weapons with their plug objectives (weapon level, level progress, kills, crafted date where Bungie exposes them). Filter by name. Requires sign-in.",
    { name: z.string().optional() },
    async ({ name }) => {
      try {
        const [d, p] = await Promise.all([
          defs.get(),
          inventory.getProfileRaw<{
            profileInventory?: { data?: { items: Item[] } };
            characterInventories?: { data?: Record<string, { items: Item[] }> };
            characterEquipment?: { data?: Record<string, { items: Item[] }> };
            itemComponents?: {
              plugObjectives?: {
                data?: Record<
                  string,
                  {
                    objectivesPerPlug: Record<
                      string,
                      Array<{ objectiveHash: number; progress?: number; completionValue?: number }>
                    >;
                  }
                >;
              };
            };
          }>([102, 201, 205, 309]),
        ]);
        const all = [
          ...(p.profileInventory?.data?.items ?? []),
          ...Object.values(p.characterInventories?.data ?? {}).flatMap((c) => c.items),
          ...Object.values(p.characterEquipment?.data ?? {}).flatMap((c) => c.items),
        ].filter(
          (i) =>
            i.itemInstanceId && (i.state ?? 0) & ITEM_STATE_CRAFTED && d.weapons[String(i.itemHash)]
        );
        const lines: string[] = [];
        for (const it of all) {
          const n = d.weapons[String(it.itemHash)].n;
          if (name && !n.toLowerCase().includes(name.toLowerCase())) continue;
          const per =
            p.itemComponents?.plugObjectives?.data?.[it.itemInstanceId ?? '']?.objectivesPerPlug ??
            {};
          const objs = Object.values(per)
            .flat()
            .map((o) => ({ desc: d.objectives[String(o.objectiveHash)] ?? '', o }))
            .filter((x) => x.desc);
          const shown = objs
            .filter((x) => /level|kill|date|craft/i.test(x.desc))
            .map((x) =>
              /date/i.test(x.desc) && (x.o.progress ?? 0) > 1_000_000_000
                ? `Shaped ${new Date((x.o.progress ?? 0) * 1000).toLocaleDateString('en-GB')}`
                : `${x.desc} ${x.o.progress ?? 0}${x.o.completionValue && x.o.completionValue > 1 && /progress/i.test(x.desc) ? `/${x.o.completionValue}` : ''}`
            );
          lines.push(
            `- **${n}** id:${it.itemInstanceId}${shown.length ? ` · ${[...new Set(shown)].join(' · ')}` : ''}`
          );
        }
        lines.sort();
        return text([`${lines.length} crafted weapon(s):`, ...lines].join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_artifact',
    "The artifact equipped on a character: its perk in each slot (socket index) and, with options, the perks each slot can take. Artifact perks live in the artifact item's sockets (change them with set_sockets on the artifact id). Requires sign-in.",
    { character: CharacterEnum, options: z.boolean().optional() },
    async ({ character, options }) => {
      try {
        const [d, m, p] = await Promise.all([
          defs.get(),
          inventory.getMembership(),
          inventory.getProfileRaw<{
            characters?: { data?: Record<string, { classType: number }> };
            characterEquipment?: { data?: Record<string, { items: Item[] }> };
          }>([200, 205]),
        ]);
        const cid = Object.entries(p.characters?.data ?? {}).find(
          ([, c]) => c.classType === CLASS_TYPE[character]
        )?.[0];
        if (!cid) return text(`No ${character} on this account.`, true);
        const art = (p.characterEquipment?.data?.[cid]?.items ?? []).find((i) =>
          /artifact/i.test(d.gear[String(i.itemHash)]?.[1] ?? '')
        );
        if (!art?.itemInstanceId) return text(`No artifact equipped on ${character}.`, true);
        const r = await authedGet<{
          sockets?: { data?: { sockets: Array<{ plugHash?: number }> } };
          reusablePlugs?: {
            data?: { plugs: Record<string, Array<{ plugItemHash: number; canInsert?: boolean }>> };
          };
        }>(
          oauth,
          apiKey,
          `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Item/${art.itemInstanceId}/?components=305,310`
        );
        let cands: Map<number, number[]> | null = null;
        if (options) {
          const ps = await inventory.getProfileRaw<Parameters<typeof mergePlugSets>[0]>([305]);
          cands = await sockets.candidates(
            art.itemHash,
            r.reusablePlugs?.data?.plugs,
            mergePlugSets(ps, cid)
          );
        }
        const lines = [
          `**${itemName(d, art.itemHash)}** on ${character} · id:${art.itemInstanceId}`,
        ];
        (r.sockets?.data?.sockets ?? []).forEach((s, i) => {
          lines.push(`- [${i}] ${s.plugHash ? itemName(d, s.plugHash) : '(empty)'}`);
          if (cands) {
            const names = [...new Set((cands.get(i) ?? []).map((h) => itemName(d, h)))].filter(
              (n) => !/^#/.test(n)
            );
            if (names.length) lines.push(`    options (${names.length}): ${names.join(', ')}`);
          }
        });
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_collectibles',
    'Collections: which exotic armour or exotic weapons (or anything) the user has acquired, filtered by class, name or missing only. Requires sign-in.',
    {
      kind: z
        .enum(['exotic-armor', 'exotic-weapons', 'all'])
        .optional()
        .describe('Default exotic-armor'),
      character: CharacterEnum.optional().describe('Class for armour'),
      name: z.string().optional(),
      missingOnly: z.boolean().optional(),
    },
    async ({ kind, character, name, missingOnly }) => {
      try {
        const [d, p] = await Promise.all([
          defs.get(),
          inventory.getProfileRaw<{
            profileCollectibles?: { data?: { collectibles: Record<string, { state: number }> } };
            characterCollectibles?: {
              data?: Record<string, { collectibles: Record<string, { state: number }> }>;
            };
          }>([800]),
        ]);
        const state = new Map<string, boolean>(); // acquired?
        for (const [h, c] of Object.entries(p.profileCollectibles?.data?.collectibles ?? {}))
          state.set(h, (c.state & COLLECTIBLE_NOT_ACQUIRED) === 0);
        for (const ch of Object.values(p.characterCollectibles?.data ?? {}))
          for (const [h, c] of Object.entries(ch.collectibles)) {
            const got = (c.state & COLLECTIBLE_NOT_ACQUIRED) === 0;
            state.set(h, (state.get(h) ?? false) || got);
          }
        const k = kind ?? 'exotic-armor';
        const weaponNames = new Set(Object.values(d.weapons).map((w) => w.n));
        const rows: Array<{ n: string; got: boolean; cls: string; src: string }> = [];
        const seen = new Set<string>();
        for (const [h, got] of state) {
          const c = d.collectibles[h];
          if (!c) continue;
          const [n, , src, itemType, tier, cls, isPlug] = c;
          // Collectibles often point at a dummy copy of the item (itemType 0, no bucket), so
          // classify by class (armour is class-bound) and by known weapon names.
          // Exotic ornaments are class-bound too, but they are plugs (itemType 19): exclude them.
          const isArmor = !isPlug && itemType !== 19 && (itemType === 2 || (cls >= 0 && cls <= 2));
          const isWeapon = !isPlug && itemType !== 19 && (itemType === 3 || weaponNames.has(n));
          if (k === 'exotic-armor' && !(isArmor && tier === 'Exotic')) continue;
          if (k === 'exotic-weapons' && !(isWeapon && !isArmor && tier === 'Exotic')) continue;
          if (character && isArmor && cls !== CLASS_TYPE[character]) continue;
          if (name && !n.toLowerCase().includes(name.toLowerCase())) continue;
          if (missingOnly && got) continue;
          const key = `${n}|${cls}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ n, got, cls: CLASS_NAME[cls] ?? '', src });
        }
        rows.sort((a, b) => a.n.localeCompare(b.n));
        const have = rows.filter((r) => r.got).length;
        return text(
          [
            `${rows.length} collectible(s) (${k}${character ? `, ${character}` : ''}); acquired ${have}, missing ${rows.length - have}.`,
            ...rows.map(
              (r) =>
                `- ${r.got ? '[x]' : '[ ]'} ${r.n}${r.cls && k !== 'exotic-weapons' ? ` (${r.cls})` : ''}${!r.got && r.src ? ` · ${r.src}` : ''}`
            ),
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_vendors',
    'What vendors are selling to a character right now (Xûr, Ada-1, Banshee-44, faction and seasonal vendors...). By default only weapons and armour are listed, with armour stats where Bungie provides them. Filter by vendor name. Requires sign-in.',
    {
      character: CharacterEnum,
      vendor: z.string().optional().describe('Part of the vendor name, e.g. "Xûr" or "Ada"'),
      includeAll: z
        .boolean()
        .optional()
        .describe('Also list non-gear items (materials, bounties...)'),
    },
    async ({ character, vendor, includeAll }) => {
      try {
        const cid = await charId(character);
        if (!cid) return text(`No ${character} on this account.`, true);
        const [d, m] = await Promise.all([defs.get(), inventory.getMembership()]);
        const r = await authedGet<{
          vendors?: { data?: Record<string, { enabled?: boolean; nextRefreshDate?: string }> };
          sales?: {
            data?: Record<
              string,
              {
                saleItems: Record<
                  string,
                  { itemHash: number; costs?: Array<{ itemHash: number; quantity: number }> }
                >;
              }
            >;
          };
          itemComponents?: Record<
            string,
            {
              stats?: {
                data?: Record<
                  string,
                  { stats: Record<string, { statHash: number; value: number }> }
                >;
              };
            }
          >;
        }>(
          oauth,
          apiKey,
          `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Character/${cid}/Vendors/?components=400,402,304`
        );
        const lines: string[] = [];
        for (const [vh, v] of Object.entries(r.vendors?.data ?? {})) {
          const vname = d.vendors[vh] ?? `Vendor ${vh}`;
          if (vendor && !vname.toLowerCase().includes(vendor.toLowerCase())) continue;
          if (v.enabled === false) continue;
          const sales = r.sales?.data?.[vh]?.saleItems ?? {};
          const out: string[] = [];
          for (const [idx, s] of Object.entries(sales)) {
            const h = String(s.itemHash);
            const w = d.weapons[h];
            const g = d.gear[h];
            const isGear = !!w || (!!g && !!ARMOR_BUCKETS[g[3]]);
            if (!includeAll && !isGear) continue;
            let line = `  - ${itemName(d, s.itemHash)}${w ? ` (${w.r} ${w.t})` : g ? ` (${g[4]} ${CLASS_NAME[g[2]] ?? ''} ${g[1]})` : ''}`;
            const st = r.itemComponents?.[vh]?.stats?.data?.[idx]?.stats;
            if (g && ARMOR_BUCKETS[g[3]] && st) {
              const named = Object.values(st)
                .map((x) => [d.stats[String(x.statHash)], x.value] as const)
                .filter(([n]) =>
                  ['Weapons', 'Health', 'Class', 'Grenade', 'Super', 'Melee'].includes(n ?? '')
                );
              if (named.length) line += ` · ${named.map(([n, val]) => `${n} ${val}`).join(', ')}`;
            }
            if (s.costs?.length)
              line += ` · cost ${s.costs.map((c) => `${c.quantity} ${itemName(d, c.itemHash)}`).join(' + ')}`;
            out.push(line);
          }
          if (out.length)
            lines.push(
              `**${vname}**${v.nextRefreshDate ? ` (refreshes ${v.nextRefreshDate.slice(0, 10)})` : ''}`,
              ...out
            );
        }
        return text(lines.length ? lines.join('\n') : 'No matching vendor stock.');
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_weapon_history',
    "Per-weapon kill stats for a character from Bungie's unique weapon history (Bungie tracks exotic weapons here): kills, precision kills and precision percentage. Requires sign-in.",
    { character: CharacterEnum },
    async ({ character }) => {
      try {
        const cid = await charId(character);
        if (!cid) return text(`No ${character} on this account.`, true);
        const [d, m] = await Promise.all([defs.get(), inventory.getMembership()]);
        const r = await authedGet<{
          weapons?: Array<{
            referenceId: number;
            values: Record<string, { basic?: { value: number; displayValue?: string } }>;
          }>;
        }>(
          oauth,
          apiKey,
          `/Destiny2/${m.membershipType}/Account/${m.membershipId}/Character/${cid}/Stats/UniqueWeapons/`
        );
        const rows = (r.weapons ?? [])
          .map((w) => ({
            n: itemName(d, w.referenceId),
            kills: w.values.uniqueWeaponKills?.basic?.value ?? 0,
            prec: w.values.uniqueWeaponPrecisionKills?.basic?.value ?? 0,
            pct: w.values.uniqueWeaponKillsPrecisionKills?.basic?.displayValue ?? '',
          }))
          .sort((a, b) => b.kills - a.kills);
        return text(
          [
            `${rows.length} weapon(s) for ${character}:`,
            ...rows.map(
              (x) =>
                `- ${x.n}: ${x.kills.toLocaleString('en-GB')} kills, ${x.prec.toLocaleString('en-GB')} precision${x.pct ? ` (${x.pct})` : ''}`
            ),
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
