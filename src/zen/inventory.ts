/**
 * Reads the signed-in user's weapons (vault + all characters) and describes each one:
 * perk columns with every rolled option and the selected one, masterwork, mod, stats,
 * power, element, gear tier, lock state and location.
 */
import type { BungieOAuth } from '../auth/oauth.js';
import { authedGet } from '../tools/auth-tools.js';
import type { ZenDefs, ZenDefsData } from './defs.js';

const PROFILE_COMPONENTS = [102, 200, 201, 205, 206, 300, 304, 305, 310].join(',');
const CACHE_MS = 60_000;

const ELEMENT: Record<number, string> = {
  1: 'Kinetic',
  2: 'Arc',
  3: 'Solar',
  4: 'Void',
  6: 'Stasis',
  7: 'Strand',
};
const CLASS: Record<number, string> = { 0: 'Titan', 1: 'Hunter', 2: 'Warlock' };
const AMMO: Record<number, string> = { 1: 'Primary', 2: 'Special', 3: 'Heavy' };
const SLOT: Record<number, string> = {
  1498876634: 'Kinetic',
  2465295065: 'Energy',
  953998645: 'Power',
};
const ITEM_STATE_LOCKED = 1;
const ITEM_STATE_CRAFTED = 8;

/** Stats worth reporting on a weapon (others such as Attack/Power are skipped). */
const SKIP_STATS = new Set(['Attack', 'Power', 'Defense', '']);

export interface PerkColumn {
  socketIndex: number;
  /** Column label from the plugs' type, e.g. "Barrel", "Magazine", "Trait", "Origin Trait" */
  label: string;
  selected: string;
  selectedHash: number;
  /** Every option the weapon rolled in this column (names), selected one included */
  options: Array<{ name: string; hash: number; enhanced: boolean; canInsert: boolean }>;
}

export interface WeaponRow {
  itemId: string;
  itemHash: number;
  name: string;
  type: string;
  rarity: string;
  element: string;
  slot: string;
  ammo: string;
  power: number;
  gearTier: number | null;
  locked: boolean;
  crafted: boolean;
  equipped: boolean;
  /** "Vault" or the class name of the character holding it */
  location: string;
  characterId: string | null;
  frame: string;
  columns: PerkColumn[];
  masterwork: string;
  mod: string;
  stats: Record<string, number>;
}

interface ProfileItem {
  itemHash: number;
  itemInstanceId?: string;
  state?: number;
}

interface ProfileResponse {
  profileInventory?: { data?: { items: ProfileItem[] } };
  characters?: { data?: Record<string, { classType: number }> };
  characterInventories?: { data?: Record<string, { items: ProfileItem[] }> };
  characterEquipment?: { data?: Record<string, { items: ProfileItem[] }> };
  characterLoadouts?: {
    data?: Record<
      string,
      {
        loadouts: Array<{
          colorHash: number;
          iconHash: number;
          nameHash: number;
          items: Array<{ itemInstanceId: string; plugItemHashes: number[] }>;
        }>;
      }
    >;
  };
  itemComponents?: {
    instances?: {
      data?: Record<
        string,
        {
          damageType?: number;
          primaryStat?: { value: number };
          gearTier?: number;
          isEquipped?: boolean;
        }
      >;
    };
    stats?: {
      data?: Record<string, { stats: Record<string, { statHash: number; value: number }> }>;
    };
    sockets?: {
      data?: Record<
        string,
        { sockets: Array<{ plugHash?: number; isEnabled?: boolean; isVisible?: boolean }> }
      >;
    };
    reusablePlugs?: {
      data?: Record<
        string,
        { plugs: Record<string, Array<{ plugItemHash: number; canInsert?: boolean }>> }
      >;
    };
  };
}

interface Membership {
  membershipType: number;
  membershipId: string;
}

export class InventoryService {
  private membership: Membership | null = null;
  private cache: { at: number; rows: WeaponRow[] } | null = null;
  private characterIds: string[] = [];
  private loadouts: LoadoutView[] = [];
  private defsData: ZenDefsData | null = null;

  constructor(
    private readonly oauth: BungieOAuth,
    private readonly apiKey: string,
    private readonly defs: ZenDefs
  ) {}

  async getMembership(): Promise<Membership> {
    if (this.membership) return this.membership;
    const data = await authedGet<{
      destinyMemberships: Array<{ membershipType: number; membershipId: string }>;
      primaryMembershipId?: string;
    }>(this.oauth, this.apiKey, '/User/GetMembershipsForCurrentUser/');
    const m =
      data.destinyMemberships.find((x) => x.membershipId === data.primaryMembershipId) ??
      data.destinyMemberships[0];
    if (!m) throw new Error('No Destiny membership found on this Bungie account');
    this.membership = { membershipType: m.membershipType, membershipId: m.membershipId };
    return this.membership;
  }

  /** Returns all weapons, cached for 60 s unless `refresh` is true. */
  async getWeapons(refresh = false): Promise<WeaponRow[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const [defs, m] = await Promise.all([this.defs.get(), this.getMembership()]);
    const profile = await authedGet<ProfileResponse>(
      this.oauth,
      this.apiKey,
      `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=${PROFILE_COMPONENTS}`
    );
    const rows = buildRows(profile, defs);
    this.characterIds = Object.keys(profile.characters?.data ?? {});
    this.defsData = defs;
    this.loadouts = buildLoadouts(profile, defs);
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  /** In-game loadouts for every character (read with the same profile call). */
  async getLoadouts(refresh = false): Promise<LoadoutView[]> {
    await this.getWeapons(refresh);
    return this.loadouts;
  }

  /** Loadout name/colour/icon definitions. */
  async getLoadoutDefs(): Promise<
    Pick<ZenDefsData, 'loadoutNames' | 'loadoutColors' | 'loadoutIcons'>
  > {
    const d = this.defsData ?? (await this.defs.get());
    return {
      loadoutNames: d.loadoutNames,
      loadoutColors: d.loadoutColors,
      loadoutIcons: d.loadoutIcons,
    };
  }

  /** Character ids on the account (read after the first getWeapons call). */
  async getCharacterIds(): Promise<string[]> {
    if (!this.characterIds.length) await this.getWeapons();
    return this.characterIds;
  }

  /** Drop the cache so the next read is fresh (after a write action). */
  invalidate(): void {
    this.cache = null;
  }
}

function isMasterworkName(name: string): boolean {
  return /^(Tier \d+: |Masterworked: )/.test(name);
}

export function buildRows(profile: ProfileResponse, defs: ZenDefsData): WeaponRow[] {
  const comps = profile.itemComponents ?? {};
  const instances = comps.instances?.data ?? {};
  const statsData = comps.stats?.data ?? {};
  const socketsData = comps.sockets?.data ?? {};
  const reusable = comps.reusablePlugs?.data ?? {};
  const chars = profile.characters?.data ?? {};

  const catsNamed = (label: string, fallback: number): Set<number> => {
    const hashes = Object.entries(defs.socketCategories)
      .filter(([, n]) => n.toUpperCase() === label)
      .map(([h]) => Number(h));
    return new Set(hashes.length ? hashes : [fallback]);
  };
  const perksCats = catsNamed('WEAPON PERKS', 4241085061);
  const intrinsicCats = catsNamed('INTRINSIC TRAITS', 3956125808);

  const holdings: Array<{
    item: ProfileItem;
    location: string;
    characterId: string | null;
    equipped: boolean;
  }> = [];
  for (const item of profile.profileInventory?.data?.items ?? []) {
    holdings.push({ item, location: 'Vault', characterId: null, equipped: false });
  }
  for (const [charId, inv] of Object.entries(profile.characterInventories?.data ?? {})) {
    const cls = CLASS[chars[charId]?.classType ?? -1] ?? charId;
    for (const item of inv.items)
      holdings.push({ item, location: cls, characterId: charId, equipped: false });
  }
  for (const [charId, inv] of Object.entries(profile.characterEquipment?.data ?? {})) {
    const cls = CLASS[chars[charId]?.classType ?? -1] ?? charId;
    for (const item of inv.items)
      holdings.push({ item, location: cls, characterId: charId, equipped: true });
  }

  const rows: WeaponRow[] = [];
  for (const { item, location, characterId, equipped } of holdings) {
    const def = defs.weapons[String(item.itemHash)];
    const id = item.itemInstanceId;
    if (!def || !id) continue;

    const inst = instances[id] ?? {};
    const sockets = socketsData[id]?.sockets ?? [];
    const plugOptions = reusable[id]?.plugs ?? {};
    const plugName = (h?: number) => (h ? (defs.plugs[String(h)]?.n ?? `#${h}`) : '');
    const plugType = (h?: number) => (h ? (defs.plugs[String(h)]?.t ?? '') : '');

    const catIndexes = (cats: Set<number>) =>
      def.sc.filter(([h]) => cats.has(h)).flatMap(([, idx]) => idx);

    const frame = catIndexes(intrinsicCats)
      .map((i) => plugName(sockets[i]?.plugHash))
      .filter(Boolean)
      .join(', ');

    const columns: PerkColumn[] = [];
    for (const i of catIndexes(perksCats)) {
      const sel = sockets[i]?.plugHash;
      if (!sel) continue;
      const optionList = plugOptions[String(i)] ?? [];
      const optionHashes = optionList.map((p) => p.plugItemHash);
      const insertable = new Map(optionList.map((p) => [p.plugItemHash, p.canInsert !== false]));
      const all = optionHashes.length ? optionHashes : [sel];
      if (!all.includes(sel)) all.unshift(sel);
      const selName = plugName(sel);
      if (/tracker/i.test(selName)) continue;
      columns.push({
        socketIndex: i,
        label: (plugType(sel) || 'Perk').replace(/^Enhanced /, ''),
        selected: selName,
        selectedHash: sel,
        options: all.map((h) => ({
          name: plugName(h),
          hash: h,
          enhanced: /enhanced/i.test(plugType(h)),
          canInsert: h === sel || (insertable.get(h) ?? false),
        })),
      });
    }

    let masterwork = '';
    let mod = '';
    sockets.forEach((s) => {
      const n = plugName(s.plugHash);
      const t = plugType(s.plugHash);
      if (!n) return;
      if (isMasterworkName(n)) masterwork = n;
      else if (/weapon mod/i.test(t) && !/empty/i.test(n)) mod = n;
    });

    const stats: Record<string, number> = {};
    for (const s of Object.values(statsData[id]?.stats ?? {})) {
      const name = defs.stats[String(s.statHash)] ?? '';
      if (!SKIP_STATS.has(name)) stats[name] = s.value;
    }

    rows.push({
      itemId: id,
      itemHash: item.itemHash,
      name: def.n,
      type: def.t,
      rarity: def.r,
      element: ELEMENT[inst.damageType ?? 0] ?? 'None',
      slot: SLOT[def.b] ?? '',
      ammo: AMMO[def.a] ?? '',
      power: inst.primaryStat?.value ?? 0,
      gearTier: inst.gearTier ?? null,
      locked: ((item.state ?? 0) & ITEM_STATE_LOCKED) !== 0,
      crafted: ((item.state ?? 0) & ITEM_STATE_CRAFTED) !== 0,
      equipped: equipped || inst.isEquipped === true,
      location,
      characterId,
      frame,
      columns,
      masterwork,
      mod,
      stats,
    });
  }
  return rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/** One weapon in compact text, e.g. for tool output. */
export function formatWeapon(w: WeaponRow, withIds = false): string {
  const flags = [w.locked ? 'locked' : '', w.crafted ? 'crafted' : '', w.equipped ? 'equipped' : '']
    .filter(Boolean)
    .join(', ');
  const tier = w.gearTier !== null ? `T${w.gearTier}, ` : '';
  const head = `**${w.name}** (${w.type}, ${w.element}, ${tier}${w.power}) ${w.location}${flags ? `, ${flags}` : ''}${withIds ? ` · id ${w.itemId}` : ''}`;
  const cols = w.columns
    .map((c) => {
      const opts = c.options
        .map((o) => (o.hash === c.selectedHash ? `*${o.name}*` : o.name))
        .join(' / ');
      return `${c.label}${withIds ? ` [${c.socketIndex}]` : ''}: ${opts}`;
    })
    .join(' | ');
  const extra = [w.frame, w.masterwork, w.mod].filter(Boolean).join(' · ');
  const stats = Object.entries(w.stats)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return `${head}\n  ${cols}\n  ${extra}\n  ${stats}`;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with one row per weapon; perk columns keep their socket order, options joined by "|", selected marked with "*". */
export function toCsv(rows: WeaponRow[]): string {
  const statNames = [...new Set(rows.flatMap((r) => Object.keys(r.stats)))].sort();
  const maxCols = Math.max(0, ...rows.map((r) => r.columns.length));
  const header = [
    'Id',
    'Hash',
    'Name',
    'Type',
    'Rarity',
    'Element',
    'Slot',
    'Ammo',
    'Power',
    'GearTier',
    'Locked',
    'Crafted',
    'Equipped',
    'Location',
    'Frame',
    ...Array.from({ length: maxCols }, (_, i) => [
      `Col${i + 1}Label`,
      `Col${i + 1}Socket`,
      `Col${i + 1}`,
    ]).flat(),
    'Masterwork',
    'Mod',
    ...statNames,
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cols = Array.from({ length: maxCols }, (_, i) => {
      const c = r.columns[i];
      if (!c) return ['', '', ''];
      return [
        c.label,
        c.socketIndex,
        c.options.map((o) => (o.hash === c.selectedHash ? `*${o.name}` : o.name)).join('|'),
      ];
    }).flat();
    lines.push(
      [
        r.itemId,
        r.itemHash,
        r.name,
        r.type,
        r.rarity,
        r.element,
        r.slot,
        r.ammo,
        r.power,
        r.gearTier ?? '',
        r.locked,
        r.crafted,
        r.equipped,
        r.location,
        r.frame,
        ...cols,
        r.masterwork,
        r.mod,
        ...statNames.map((s) => r.stats[s] ?? ''),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

export interface LoadoutView {
  characterId: string;
  className: string;
  index: number;
  empty: boolean;
  name: string;
  nameHash: number;
  colorHash: number;
  iconHash: number;
  items: Array<{ itemId: string; name: string; type: string; plugs: string[] }>;
}

export function buildLoadouts(profile: ProfileResponse, defs: ZenDefsData): LoadoutView[] {
  const chars = profile.characters?.data ?? {};
  const hashById = new Map<string, number>();
  const all = [
    ...(profile.profileInventory?.data?.items ?? []),
    ...Object.values(profile.characterInventories?.data ?? {}).flatMap((c) => c.items),
    ...Object.values(profile.characterEquipment?.data ?? {}).flatMap((c) => c.items),
  ];
  for (const it of all) if (it.itemInstanceId) hashById.set(it.itemInstanceId, it.itemHash);

  const out: LoadoutView[] = [];
  for (const [charId, data] of Object.entries(profile.characterLoadouts?.data ?? {})) {
    const cls = CLASS[chars[charId]?.classType ?? -1] ?? charId;
    data.loadouts.forEach((lo, index) => {
      const items = lo.items
        .filter((i) => i.itemInstanceId && i.itemInstanceId !== '0')
        .map((i) => {
          const h = hashById.get(String(i.itemInstanceId));
          const w = h ? defs.weapons[String(h)] : undefined;
          const g = h ? defs.gear[String(h)] : undefined;
          const plugs = (i.plugItemHashes ?? [])
            .filter((p) => p && p !== 2166136261)
            .map((p) => defs.plugs[String(p)]?.n ?? '')
            .filter((n) => n && !/^(Empty|Default)/i.test(n));
          return {
            itemId: String(i.itemInstanceId),
            name:
              w?.n ??
              g?.[0] ??
              (h ? (defs.plugs[String(h)]?.n ?? `#${h}`) : 'item no longer owned'),
            type: w?.t ?? g?.[1] ?? (h ? (defs.plugs[String(h)]?.t ?? '') : ''),
            plugs,
          };
        });
      out.push({
        characterId: charId,
        className: cls,
        index,
        empty: items.length === 0,
        name: defs.loadoutNames[String(lo.nameHash)] ?? '',
        nameHash: lo.nameHash,
        colorHash: lo.colorHash,
        iconHash: lo.iconHash,
        items,
      });
    });
  }
  return out;
}
