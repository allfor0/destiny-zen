/**
 * Compact manifest definitions for Destiny Zen's inventory tools.
 *
 * Downloads (once per manifest version) the parts of the Destiny 2 manifest needed to
 * describe a weapon instance: weapon definitions with their socket categories, plug
 * definitions (perk names and types), stat names and socket category names. Stored as
 * one compact JSON file in ~/.destiny-zen/defs-<version>.json.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://www.bungie.net';

export interface WeaponDef {
  /** name */
  n: string;
  /** item type display name, e.g. "Auto Rifle" */
  t: string;
  /** rarity, e.g. "Legendary" */
  r: string;
  /** ammo type: 1 primary, 2 special, 3 heavy */
  a: number;
  /** inventory bucket hash (slot) */
  b: number;
  /** socket categories: [categoryHash, socketIndexes[]] */
  sc: Array<[number, number[]]>;
}

export interface PlugDef {
  /** name */
  n: string;
  /** item type display name, e.g. "Barrel", "Trait", "Enhanced Trait" */
  t: string;
  /** plug category identifier */
  p: string;
}

export interface ZenDefsData {
  version: string;
  weapons: Record<string, WeaponDef>;
  plugs: Record<string, PlugDef>;
  stats: Record<string, string>;
  socketCategories: Record<string, string>;
  /** Names of other equippable items (armour, subclasses, ghosts...): hash -> [name, type] */
  gear: Record<string, [string, string]>;
  /** In-game loadout names, colours and icons */
  loadoutNames: Record<string, string>;
  loadoutColors: number[];
  loadoutIcons: number[];
}

interface RawItem {
  displayProperties?: { name?: string };
  itemType?: number;
  itemTypeDisplayName?: string;
  inventory?: { tierTypeName?: string; bucketTypeHash?: number };
  equippingBlock?: { ammoType?: number };
  plug?: { plugCategoryIdentifier?: string };
  sockets?: { socketCategories?: Array<{ socketCategoryHash: number; socketIndexes: number[] }> };
}

export class ZenDefs {
  private data: ZenDefsData | null = null;
  private loading: Promise<ZenDefsData> | null = null;
  private readonly dir: string;

  constructor(
    private readonly apiKey: string,
    dir?: string
  ) {
    this.dir = dir || path.join(os.homedir(), '.destiny-zen');
  }

  private async getJson<T>(url: string, withKey = false): Promise<T> {
    const res = await fetch(url, withKey ? { headers: { 'X-API-Key': this.apiKey } } : undefined);
    if (!res.ok)
      throw new Error(`Manifest download failed: ${res.status} ${res.statusText} (${url})`);
    return (await res.json()) as T;
  }

  /** Loads definitions, downloading them if the manifest version changed. */
  async get(): Promise<ZenDefsData> {
    if (this.data) return this.data;
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<ZenDefsData> {
    const manifest = await this.getJson<{
      Response: {
        version: string;
        jsonWorldComponentContentPaths: { en: Record<string, string> };
      };
    }>(`${BASE}/Platform/Destiny2/Manifest/`, true);
    const version = manifest.Response.version;
    const file = path.join(this.dir, `defs-v2-${version.replace(/[^\w.-]/g, '_')}.json`);

    try {
      this.data = JSON.parse(await fs.readFile(file, 'utf8')) as ZenDefsData;
      return this.data;
    } catch {
      // not cached yet
    }

    const paths = manifest.Response.jsonWorldComponentContentPaths.en;
    console.error('[ZenDefs] Downloading manifest definitions (first run, may take a minute)...');
    const [items, stats, socketCats, loNames, loColors, loIcons] = await Promise.all([
      this.getJson<Record<string, RawItem>>(`${BASE}${paths.DestinyInventoryItemDefinition}`),
      this.getJson<Record<string, { displayProperties?: { name?: string } }>>(
        `${BASE}${paths.DestinyStatDefinition}`
      ),
      this.getJson<Record<string, { displayProperties?: { name?: string } }>>(
        `${BASE}${paths.DestinySocketCategoryDefinition}`
      ),
      this.getJson<Record<string, { name?: string }>>(
        `${BASE}${paths.DestinyLoadoutNameDefinition}`
      ),
      this.getJson<Record<string, { index?: number }>>(
        `${BASE}${paths.DestinyLoadoutColorDefinition}`
      ),
      this.getJson<Record<string, { index?: number }>>(
        `${BASE}${paths.DestinyLoadoutIconDefinition}`
      ),
    ]);

    const weapons: Record<string, WeaponDef> = {};
    const plugs: Record<string, PlugDef> = {};
    const gear: Record<string, [string, string]> = {};
    for (const [hash, it] of Object.entries(items)) {
      const name = it.displayProperties?.name ?? '';
      if (it.itemType === 3 && name) {
        weapons[hash] = {
          n: name,
          t: it.itemTypeDisplayName ?? '',
          r: it.inventory?.tierTypeName ?? '',
          a: it.equippingBlock?.ammoType ?? 0,
          b: it.inventory?.bucketTypeHash ?? 0,
          sc: (it.sockets?.socketCategories ?? []).map((c) => [
            c.socketCategoryHash,
            c.socketIndexes,
          ]),
        };
      } else if (name && [2, 14, 16, 21, 22, 24].includes(it.itemType ?? -1) && !it.plug) {
        gear[hash] = [name, it.itemTypeDisplayName ?? ''];
      } else if (it.plug && name) {
        plugs[hash] = {
          n: name,
          t: it.itemTypeDisplayName ?? '',
          p: it.plug.plugCategoryIdentifier ?? '',
        };
      }
    }
    const statNames: Record<string, string> = {};
    for (const [hash, s] of Object.entries(stats)) {
      if (s.displayProperties?.name) statNames[hash] = s.displayProperties.name;
    }
    const catNames: Record<string, string> = {};
    for (const [hash, c] of Object.entries(socketCats)) {
      if (c.displayProperties?.name) catNames[hash] = c.displayProperties.name;
    }

    const loadoutNames: Record<string, string> = {};
    for (const [hash, n] of Object.entries(loNames)) if (n.name) loadoutNames[hash] = n.name;
    const byIndex = (o: Record<string, { index?: number }>) =>
      Object.entries(o)
        .sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0))
        .map(([h]) => Number(h));

    this.data = {
      version,
      weapons,
      plugs,
      stats: statNames,
      socketCategories: catNames,
      gear,
      loadoutNames,
      loadoutColors: byIndex(loColors),
      loadoutIcons: byIndex(loIcons),
    };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(this.data));
    console.error(
      `[ZenDefs] Cached ${Object.keys(weapons).length} weapons and ${Object.keys(plugs).length} plugs (manifest ${version})`
    );
    return this.data;
  }
}
