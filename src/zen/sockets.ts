/**
 * Resolves which plugs a socket can take, using live item data (sockets, reusable plugs)
 * plus manifest definitions (socket entries and plug sets), fetched on demand and cached.
 */
import type { BungieOAuth } from '../auth/oauth.js';
import { authedGet } from '../tools/auth-tools.js';

export interface SocketEntryDef {
  socketTypeHash: number;
  singleInitialItemHash: number;
  reusablePlugSetHash?: number;
  randomizedPlugSetHash?: number;
  reusablePlugItems?: Array<{ plugItemHash: number }>;
}

export interface ItemDefLite {
  name: string;
  itemType: number;
  classType: number;
  bucketHash: number;
  tierName: string;
  socketEntries: SocketEntryDef[];
  socketCategories: Array<{ socketCategoryHash: number; socketIndexes: number[] }>;
}

interface RawDef {
  displayProperties?: { name?: string };
  itemType?: number;
  classType?: number;
  inventory?: { bucketTypeHash?: number; tierTypeName?: string };
  sockets?: {
    socketEntries?: SocketEntryDef[];
    socketCategories?: Array<{ socketCategoryHash: number; socketIndexes: number[] }>;
  };
}

/** Live plug set contents: plugSetHash -> plugs (from profilePlugSets/characterPlugSets). */
export type PlugSetStates = Record<string, Array<{ plugItemHash: number; canInsert?: boolean }>>;

interface PlugSetProfile {
  profilePlugSets?: { data?: { plugs: PlugSetStates } };
  characterPlugSets?: { data?: Record<string, { plugs: PlugSetStates }> };
}

/** Merge profile-wide and one character's live plug sets. */
export function mergePlugSets(p: PlugSetProfile, characterId?: string | null): PlugSetStates {
  const out: PlugSetStates = {};
  const add = (src?: PlugSetStates) => {
    for (const [k, v] of Object.entries(src ?? {})) out[k] = [...(out[k] ?? []), ...v];
  };
  add(p.profilePlugSets?.data?.plugs);
  if (characterId) add(p.characterPlugSets?.data?.[characterId]?.plugs);
  return out;
}

export class SocketResolver {
  private items = new Map<number, ItemDefLite>();
  private plugSets = new Map<number, number[]>();

  constructor(
    private readonly oauth: BungieOAuth,
    private readonly apiKey: string
  ) {}

  async itemDef(hash: number): Promise<ItemDefLite> {
    const hit = this.items.get(hash);
    if (hit) return hit;
    const d = await authedGet<RawDef>(
      this.oauth,
      this.apiKey,
      `/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`
    );
    const def: ItemDefLite = {
      name: d.displayProperties?.name ?? `#${hash}`,
      itemType: d.itemType ?? 0,
      classType: d.classType ?? 3,
      bucketHash: d.inventory?.bucketTypeHash ?? 0,
      tierName: d.inventory?.tierTypeName ?? '',
      socketEntries: d.sockets?.socketEntries ?? [],
      socketCategories: d.sockets?.socketCategories ?? [],
    };
    this.items.set(hash, def);
    return def;
  }

  async plugSet(hash: number): Promise<number[]> {
    const hit = this.plugSets.get(hash);
    if (hit) return hit;
    const d = await authedGet<{ reusablePlugItems?: Array<{ plugItemHash: number }> }>(
      this.oauth,
      this.apiKey,
      `/Destiny2/Manifest/DestinyPlugSetDefinition/${hash}/`
    );
    const list = [...new Set((d.reusablePlugItems ?? []).map((p) => p.plugItemHash))];
    this.plugSets.set(hash, list);
    return list;
  }

  /**
   * Candidate plug hashes per socket index: live reusable plugs for the instance first,
   * then the definition's plug sets and fixed reusable plugs.
   */
  async candidates(
    itemHash: number,
    reusable: Record<string, Array<{ plugItemHash: number; canInsert?: boolean }>> | undefined,
    liveSets?: PlugSetStates
  ): Promise<Map<number, number[]>> {
    const def = await this.itemDef(itemHash);
    const out = new Map<number, number[]>();
    for (let i = 0; i < def.socketEntries.length; i++) {
      const e = def.socketEntries[i];
      const list: number[] = [];
      for (const p of reusable?.[String(i)] ?? []) list.push(p.plugItemHash);
      for (const ps of [e.reusablePlugSetHash, e.randomizedPlugSetHash]) {
        if (!ps) continue;
        // Unlock-based plug sets (artifact perks, some subclass/armour sets) are only
        // populated live, per profile or character.
        for (const p of liveSets?.[String(ps)] ?? [])
          if (p.canInsert !== false) list.push(p.plugItemHash);
        list.push(...(await this.plugSet(ps)));
      }
      for (const p of e.reusablePlugItems ?? []) list.push(p.plugItemHash);
      if (e.singleInitialItemHash) list.push(e.singleInitialItemHash);
      out.set(i, [...new Set(list.filter(Boolean))]);
    }
    return out;
  }
}
