/**
 * Armour and item reads: get_armor, export_armor, get_item, get_equipped.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BungieOAuth } from '../auth/oauth.js';
import { authedGet } from './auth-tools.js';
import type { InventoryService } from '../zen/inventory.js';
import type { ZenDefs, ZenDefsData } from '../zen/defs.js';
import { mergePlugSets, type SocketResolver } from '../zen/sockets.js';
import {
  SUBCLASS_BUCKET,
  ARMOR_BUCKETS,
  CLASS_NAME,
  CharacterEnum,
  CLASS_TYPE,
  POSTMASTER_BUCKET,
  cleanId,
  errorResult,
  isCosmeticPlug,
  itemName,
  text,
} from '../zen/common.js';

const ARMOR_STATS = ['Weapons', 'Health', 'Class', 'Grenade', 'Super', 'Melee'];
const ITEM_STATE_LOCKED = 1;
const ITEM_STATE_MASTERWORK = 4;

interface PItem {
  itemHash: number;
  itemInstanceId?: string;
  bucketHash?: number;
  state?: number;
  quantity?: number;
}

interface Instance {
  primaryStat?: { value: number };
  gearTier?: number;
  isEquipped?: boolean;
  energy?: { energyCapacity: number; energyUsed: number; energyUnused: number };
}

export interface GearProfile {
  profileInventory?: { data?: { items: PItem[] } };
  characters?: { data?: Record<string, { classType: number; light?: number }> };
  characterInventories?: { data?: Record<string, { items: PItem[] }> };
  characterEquipment?: { data?: Record<string, { items: PItem[] }> };
  profileProgression?: {
    data?: {
      seasonalArtifact?: { artifactHash: number; pointsAcquired: number; powerBonus: number };
    };
  };
  characterProgressions?: {
    data?: Record<
      string,
      {
        seasonalArtifact?: {
          artifactHash: number;
          pointsUsed: number;
          tiers: Array<{
            isUnlocked: boolean;
            items: Array<{ itemHash: number; isActive: boolean }>;
          }>;
        };
      }
    >;
  };
  itemComponents?: {
    instances?: { data?: Record<string, Instance> };
    stats?: {
      data?: Record<string, { stats: Record<string, { statHash: number; value: number }> }>;
    };
    sockets?: {
      data?: Record<
        string,
        { sockets: Array<{ plugHash?: number; isEnabled?: boolean; isVisible?: boolean }> }
      >;
    };
  };
}

export interface ArmorRow {
  itemId: string;
  itemHash: number;
  name: string;
  slot: string;
  classType: string;
  rarity: string;
  location: string;
  characterId: string | null;
  equipped: boolean;
  locked: boolean;
  masterworked: boolean;
  power: number;
  gearTier: number | null;
  energy: string;
  stats: Record<string, number>;
  total: number;
  /** Non-cosmetic plugs as "Type: Name" */
  plugs: string[];
}

function statMap(d: ZenDefsData, raw?: Record<string, { statHash: number; value: number }>) {
  const out: Record<string, number> = {};
  for (const s of Object.values(raw ?? {})) {
    const n = d.stats[String(s.statHash)];
    if (n) out[n] = s.value;
  }
  return out;
}

function plugList(
  d: ZenDefsData,
  sockets?: Array<{ plugHash?: number; isEnabled?: boolean; isVisible?: boolean }>
): string[] {
  const out: string[] = [];
  for (const s of sockets ?? []) {
    if (!s.plugHash) continue;
    const p = d.plugs[String(s.plugHash)];
    if (!p || /^(Empty|Default)/i.test(p.n) || isCosmeticPlug(p.p, p.t)) continue;
    out.push(p.t ? `${p.t}: ${p.n}` : p.n);
  }
  return out;
}

export function buildArmorRows(p: GearProfile, d: ZenDefsData): ArmorRow[] {
  const chars = p.characters?.data ?? {};
  const rows: ArmorRow[] = [];
  const add = (it: PItem, location: string, characterId: string | null, equipped: boolean) => {
    if (!it.itemInstanceId) return;
    const g = d.gear[String(it.itemHash)];
    if (!g || !ARMOR_BUCKETS[g[3]]) return;
    const id = it.itemInstanceId;
    const inst = p.itemComponents?.instances?.data?.[id] ?? {};
    const stats = statMap(d, p.itemComponents?.stats?.data?.[id]?.stats);
    const armorStats: Record<string, number> = {};
    for (const s of ARMOR_STATS) if (stats[s] !== undefined) armorStats[s] = stats[s];
    const e = inst.energy;
    rows.push({
      itemId: id,
      itemHash: it.itemHash,
      name: g[0],
      slot: ARMOR_BUCKETS[g[3]],
      classType: CLASS_NAME[g[2]] ?? 'Any',
      rarity: g[4],
      location,
      characterId,
      equipped,
      locked: ((it.state ?? 0) & ITEM_STATE_LOCKED) !== 0,
      masterworked: ((it.state ?? 0) & ITEM_STATE_MASTERWORK) !== 0,
      power: inst.primaryStat?.value ?? 0,
      gearTier: inst.gearTier ?? null,
      energy: e ? `${e.energyUsed}/${e.energyCapacity}` : '',
      stats: armorStats,
      total: Object.values(armorStats).reduce((a, b) => a + b, 0),
      plugs: plugList(d, p.itemComponents?.sockets?.data?.[id]?.sockets),
    });
  };
  for (const it of p.profileInventory?.data?.items ?? []) add(it, 'Vault', null, false);
  for (const [cid, inv] of Object.entries(p.characterInventories?.data ?? {})) {
    const cls = CLASS_NAME[chars[cid]?.classType ?? 3] ?? cid;
    for (const it of inv.items)
      add(it, it.bucketHash === POSTMASTER_BUCKET ? `${cls} (Postmaster)` : cls, cid, false);
  }
  for (const [cid, eq] of Object.entries(p.characterEquipment?.data ?? {})) {
    const cls = CLASS_NAME[chars[cid]?.classType ?? 3] ?? cid;
    for (const it of eq.items) add(it, cls, cid, true);
  }
  return rows;
}

function formatArmor(r: ArmorRow): string {
  const stats = ARMOR_STATS.map((s) => `${s} ${r.stats[s] ?? 0}`).join(', ');
  const flags = [
    r.equipped ? 'equipped' : '',
    r.locked ? 'locked' : '',
    r.masterworked ? 'masterworked' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return [
    `**${r.name}** (${r.rarity} ${r.classType} ${r.slot}, T${r.gearTier ?? '?'}, ${r.power}) ${r.location}${flags ? `, ${flags}` : ''} · id:${r.itemId}`,
    `  ${stats} · Total ${r.total}${r.energy ? ` · Energy ${r.energy}` : ''}`,
    r.plugs.length ? `  ${r.plugs.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const GEAR_COMPONENTS = [102, 200, 201, 205, 300, 304, 305];

export function registerArmorTools(
  server: McpServer,
  oauth: BungieOAuth,
  apiKey: string,
  inventory: InventoryService,
  defs: ZenDefs,
  sockets: SocketResolver,
  exportDir: string | undefined
): void {
  let cache: { at: number; rows: ArmorRow[] } | null = null;
  async function armor(refresh = false): Promise<ArmorRow[]> {
    if (!refresh && cache && Date.now() - cache.at < 60_000) return cache.rows;
    const [d, p] = await Promise.all([
      defs.get(),
      inventory.getProfileRaw<GearProfile>(GEAR_COMPONENTS),
    ]);
    cache = { at: Date.now(), rows: buildArmorRows(p, d) };
    return cache.rows;
  }

  server.tool(
    'get_armor',
    "List the user's armour (vault + characters) with live stats (Weapons, Health, Class, Grenade, Super, Melee incl. masterwork and mods), total, energy, gear tier, archetype/set/mod/tuning plugs, lock and location. Filter by class, slot, name, rarity, location or a minimum stat; sort by a stat. Requires sign-in.",
    {
      character: CharacterEnum.optional().describe('Armour usable by this class'),
      slot: z.enum(['Helmet', 'Gauntlets', 'Chest', 'Legs', 'Class Item']).optional(),
      name: z.string().optional().describe('Part of the item name, e.g. "Bakris"'),
      rarity: z.enum(['Exotic', 'Legendary', 'Rare', 'Uncommon', 'Common']).optional(),
      location: z.enum(['vault', 'hunter', 'titan', 'warlock', 'any']).optional(),
      plug: z
        .string()
        .optional()
        .describe('Only items with this plug (archetype, set bonus, mod, tuning), partial ok'),
      minStat: z
        .object({
          stat: z.enum(['Weapons', 'Health', 'Class', 'Grenade', 'Super', 'Melee']),
          value: z.number(),
        })
        .optional(),
      sortBy: z
        .enum(['Weapons', 'Health', 'Class', 'Grenade', 'Super', 'Melee', 'Total'])
        .optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      offset: z.number().int().min(0).optional(),
      refresh: z.boolean().optional(),
    },
    async (a) => {
      try {
        let rows = await armor(a.refresh ?? false);
        if (a.character) {
          const ct = CLASS_NAME[CLASS_TYPE[a.character]];
          rows = rows.filter((r) => r.classType === ct || r.classType === 'Any');
        }
        if (a.slot) rows = rows.filter((r) => r.slot === a.slot);
        if (a.rarity) rows = rows.filter((r) => r.rarity === a.rarity);
        const nameQ = a.name?.toLowerCase();
        const plugQ = a.plug?.toLowerCase();
        const locQ = a.location && a.location !== 'any' ? a.location : undefined;
        const minStat = a.minStat;
        if (nameQ) rows = rows.filter((r) => r.name.toLowerCase().includes(nameQ));
        if (plugQ) rows = rows.filter((r) => r.plugs.some((p) => p.toLowerCase().includes(plugQ)));
        if (locQ) rows = rows.filter((r) => r.location.toLowerCase().startsWith(locQ));
        if (minStat) rows = rows.filter((r) => (r.stats[minStat.stat] ?? 0) >= minStat.value);
        if (a.sortBy) {
          const k = a.sortBy;
          rows = [...rows].sort((x, y) =>
            k === 'Total' ? y.total - x.total : (y.stats[k] ?? 0) - (x.stats[k] ?? 0)
          );
        }
        const off = a.offset ?? 0;
        const lim = a.limit ?? 25;
        const page = rows.slice(off, off + lim);
        return text(
          [
            `${rows.length} matching armour piece(s); showing ${page.length} from ${off + 1}.`,
            '',
            ...page.map(formatArmor),
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'export_armor',
    "Write the user's full armour inventory to CSV and JSON (stats, total, energy, tier, plugs, location) for optimiser scripts. Returns the file paths. Requires sign-in.",
    { refresh: z.boolean().optional() },
    async ({ refresh }) => {
      try {
        const rows = await armor(refresh ?? true);
        const dir = exportDir || path.join(os.homedir(), '.destiny-zen', 'exports');
        await fs.mkdir(dir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const base = path.join(dir, `zen-armor-${day}`);
        const header = [
          'Id',
          'Hash',
          'Name',
          'Slot',
          'Class',
          'Rarity',
          'Tier',
          'Power',
          'Location',
          'Equipped',
          'Locked',
          'Masterworked',
          'Energy',
          ...ARMOR_STATS,
          'Total',
          'Plugs',
        ];
        const lines = [header.join(',')];
        for (const r of rows) {
          lines.push(
            [
              r.itemId,
              r.itemHash,
              r.name,
              r.slot,
              r.classType,
              r.rarity,
              r.gearTier ?? '',
              r.power,
              r.location,
              r.equipped,
              r.locked,
              r.masterworked,
              r.energy,
              ...ARMOR_STATS.map((s) => r.stats[s] ?? 0),
              r.total,
              r.plugs.join(' | '),
            ]
              .map(csvCell)
              .join(',')
          );
        }
        await fs.writeFile(`${base}.csv`, lines.join('\n') + '\n');
        await fs.writeFile(`${base}.json`, JSON.stringify(rows, null, 1));
        return text(
          `Exported ${rows.length} armour pieces.\n- CSV: ${base}.csv\n- JSON: ${base}.json`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_item',
    "Full detail for any one of the user's items by instance id (armour, weapon, subclass, artifact, ghost): location, stats, energy, and every socket with its index and current plug. Set options to also list the plugs each socket can take (for set_sockets). Requires sign-in.",
    {
      itemId: z.string(),
      options: z.boolean().optional().describe('List allowed plugs per socket (can be long)'),
      socketIndex: z.number().int().optional().describe('Only show this socket'),
    },
    async ({ itemId, options, socketIndex }) => {
      try {
        const id = cleanId(itemId);
        const [d, m] = await Promise.all([defs.get(), inventory.getMembership()]);
        const r = await authedGet<{
          characterId?: string;
          item?: {
            data?: { itemHash: number; bucketHash?: number; state?: number; location?: number };
          };
          instance?: { data?: Instance };
          stats?: { data?: { stats: Record<string, { statHash: number; value: number }> } };
          sockets?: {
            data?: {
              sockets: Array<{ plugHash?: number; isEnabled?: boolean; isVisible?: boolean }>;
            };
          };
          reusablePlugs?: {
            data?: { plugs: Record<string, Array<{ plugItemHash: number; canInsert?: boolean }>> };
          };
        }>(
          oauth,
          apiKey,
          `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Item/${id}/?components=300,304,305,307,310`
        );
        const hash = r.item?.data?.itemHash;
        if (!hash) return text(`Item ${id} not found.`, true);
        const def = await sockets.itemDef(hash);
        const chars = await inventory.getCharacters();
        const inst = r.instance?.data ?? {};
        const stats = statMap(d, r.stats?.data?.stats);
        const lines = [
          `**${def.name}** (${def.tierName} ${d.gear[String(hash)]?.[1] ?? d.weapons[String(hash)]?.t ?? ''}) id:${id} hash:${hash}`,
          `Location: ${r.characterId ? (chars.get(String(r.characterId)) ?? r.characterId) : 'Vault'}${inst.isEquipped ? ' (equipped)' : ''}${inst.gearTier ? ` · Tier ${inst.gearTier}` : ''}${inst.primaryStat ? ` · Power ${inst.primaryStat.value}` : ''}${inst.energy ? ` · Energy ${inst.energy.energyUsed}/${inst.energy.energyCapacity}` : ''}`,
        ];
        if (Object.keys(stats).length)
          lines.push(
            `Stats: ${Object.entries(stats)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}`
          );
        const socketsLive = r.sockets?.data?.sockets ?? [];
        let cands: Map<number, number[]> | null = null;
        if (options) {
          const ps = await inventory.getProfileRaw<Parameters<typeof mergePlugSets>[0]>([305]);
          const owner = r.characterId ? String(r.characterId) : [...chars.keys()][0];
          cands = await sockets.candidates(
            hash,
            r.reusablePlugs?.data?.plugs,
            mergePlugSets(ps, owner)
          );
        }
        lines.push('', 'Sockets:');
        socketsLive.forEach((s, i) => {
          if (socketIndex !== undefined && i !== socketIndex) return;
          const p = s.plugHash ? d.plugs[String(s.plugHash)] : undefined;
          if (!options && p && isCosmeticPlug(p.p, p.t)) return;
          const cur = p
            ? `${p.t ? `${p.t}: ` : ''}${p.n}`
            : s.plugHash
              ? itemName(d, s.plugHash)
              : '(empty)';
          lines.push(`- [${i}] ${cur}${s.isEnabled === false ? ' (disabled)' : ''}`);
          if (cands) {
            const names = (cands.get(i) ?? [])
              .map((h) => d.plugs[String(h)]?.n)
              .filter((n): n is string => !!n);
            const uniq = [...new Set(names)];
            if (uniq.length)
              lines.push(
                `    options (${uniq.length}): ${uniq.slice(0, 60).join(', ')}${uniq.length > 60 ? ', ...' : ''}`
              );
          }
        });
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'get_equipped',
    "Everything currently equipped on a character: weapons, armour with stats and mods, subclass (super, abilities, aspects, fragments), artifact and its active perks, plus the character's total armour stats. Requires sign-in.",
    { character: CharacterEnum },
    async ({ character }) => {
      try {
        const [d, p] = await Promise.all([
          defs.get(),
          inventory.getProfileRaw<GearProfile>([200, 201, 205, 300, 304, 305]),
        ]);
        const cid = Object.entries(p.characters?.data ?? {}).find(
          ([, c]) => c.classType === CLASS_TYPE[character]
        )?.[0];
        if (!cid) return text(`No ${character} on this account.`, true);
        const items = p.characterEquipment?.data?.[cid]?.items ?? [];
        const lines: string[] = [`**${character}** equipped (character id ${cid}):`, ''];
        const totals: Record<string, number> = {};
        for (const it of items) {
          if (!it.itemInstanceId) continue;
          const id = it.itemInstanceId;
          const h = String(it.itemHash);
          const w = d.weapons[h];
          const g = d.gear[h];
          if (!w && !g) continue;
          const type = w?.t ?? g?.[1] ?? '';
          if (/emblem|ship|sparrow|vehicle|finisher|emote|clan banner|ghost/i.test(type)) continue;
          const stats = statMap(d, p.itemComponents?.stats?.data?.[id]?.stats);
          let plugs = plugList(d, p.itemComponents?.sockets?.data?.[id]?.sockets);
          if (/artifact/i.test(type) && !plugs.length) {
            const m = await inventory.getMembership();
            const a = await authedGet<{
              sockets?: { data?: { sockets: Array<{ plugHash?: number; isEnabled?: boolean }> } };
            }>(
              oauth,
              apiKey,
              `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Item/${id}/?components=305`
            );
            plugs = (a.sockets?.data?.sockets ?? [])
              .map((x) => (x.plugHash ? itemName(d, x.plugHash) : ''))
              .filter((n) => n && !/^(empty|#)/i.test(n));
          }
          let line = `- **${w?.n ?? g?.[0]}** (${type}${g?.[4] === 'Exotic' || w?.r === 'Exotic' ? ', Exotic' : ''}) id:${id}`;
          if (g && ARMOR_BUCKETS[g[3]]) {
            const s = ARMOR_STATS.map((k) => `${k} ${stats[k] ?? 0}`).join(', ');
            for (const k of ARMOR_STATS) totals[k] = (totals[k] ?? 0) + (stats[k] ?? 0);
            line += `\n    ${s}`;
          }
          if (plugs.length) line += `\n    ${plugs.join(' | ')}`;
          lines.push(line);
        }
        lines.push(
          '',
          `Armour stat totals (armour pieces only; fragments and subclass not included): ${ARMOR_STATS.map((k) => `${k} ${totals[k] ?? 0}`).join(', ')}`
        );
        // Other subclasses on the character (ids for equip_items / set_sockets)
        const others = (p.characterInventories?.data?.[cid]?.items ?? []).filter(
          (it) => it.itemInstanceId && d.gear[String(it.itemHash)]?.[3] === SUBCLASS_BUCKET
        );
        if (others.length)
          lines.push(
            '',
            `Other subclasses: ${others.map((o) => `${itemName(d, o.itemHash)} id:${o.itemInstanceId}`).join(' · ')}`
          );
        return text(lines.filter((l) => l !== '').join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
