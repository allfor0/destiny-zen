/** Small helpers shared by the Destiny Zen write/read tools. */
import { z } from 'zod';
import { NotSignedInError } from '../auth/oauth.js';
import type { ZenDefsData } from './defs.js';

export const CharacterEnum = z.enum(['hunter', 'titan', 'warlock']);
export type CharacterName = z.infer<typeof CharacterEnum>;
export const CLASS_TYPE: Record<string, number> = { titan: 0, hunter: 1, warlock: 2 };
export const CLASS_NAME: Record<number, string> = {
  0: 'Titan',
  1: 'Hunter',
  2: 'Warlock',
  3: 'Any',
};

export const VAULT_BUCKET = 138197802;
export const POSTMASTER_BUCKET = 215593132;
export const CONSUMABLES_BUCKET = 1469714392;
export const ARMOR_BUCKETS: Record<number, string> = {
  3448274439: 'Helmet',
  3551918588: 'Gauntlets',
  14239492: 'Chest',
  20886954: 'Legs',
  1585787867: 'Class Item',
};
export const SUBCLASS_BUCKET = 3284755031;

/** Bungie PlatformErrorCodes most likely to come back from item actions. */
export const ERROR_NAMES: Record<number, string> = {
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
  1676: 'plug insertion rules failed (e.g. not enough armour energy, or fragment slots not unlocked by aspects)',
  1677: 'socket not found',
  1678: 'socket action not allowed',
  1679: 'socket already has this plug (or it is used in another socket)',
  1680: 'plug not available (not unlocked on this account)',
};

export function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

export function errorResult(err: unknown) {
  return text(
    err instanceof NotSignedInError
      ? err.message
      : `Error: ${err instanceof Error ? err.message : String(err)}`,
    true
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function bungieCode(err: unknown): number | null {
  const m = /Bungie API error (\d+)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

export function describeError(err: unknown): string {
  const code = bungieCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  return code && ERROR_NAMES[code] ? `${ERROR_NAMES[code]} (${msg})` : msg;
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function cleanId(id: string): string {
  return id.replace(/["'\s]/g, '');
}

/** Best display name for any item hash using the cached definitions. */
export function itemName(d: ZenDefsData, hash: number): string {
  const h = String(hash);
  return d.weapons[h]?.n ?? d.gear[h]?.[0] ?? d.plugs[h]?.n ?? d.misc?.[h] ?? `#${hash}`;
}

/** Plug categories that are cosmetic and not worth listing. */
export function isCosmeticPlug(category: string, type: string): boolean {
  return /shader|skins|ornament|transmog|armor_skins|emote|v400\.empty|tracker/i.test(
    `${category} ${type}`
  );
}
