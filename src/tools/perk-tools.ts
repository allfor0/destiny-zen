import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BungieOAuth } from '../auth/oauth.js';
import { NotSignedInError } from '../auth/oauth.js';
import { authedPost } from './auth-tools.js';
import type { InventoryService, WeaponRow } from '../zen/inventory.js';

/** Bungie limits InsertSocketPlugFree to 2 socket actions per second per user. */
const SOCKET_ACTION_GAP_MS = 600;

interface PlannedChange {
  itemId: string;
  weapon: string;
  column: string;
  socketIndex: number;
  from: string;
  to: string;
  plugHash: number;
}

interface PlanResult {
  changes: PlannedChange[];
  notes: string[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Work out which socket/plug each requested perk name refers to on one weapon. */
function planForWeapon(w: WeaponRow, wanted: string[]): PlanResult {
  const changes: PlannedChange[] = [];
  const notes: string[] = [];
  const label = `${w.name} (${w.itemId})`;
  const usedSockets = new Set<number>();

  for (const name of wanted) {
    const key = norm(name);
    const hits = w.columns.flatMap((c) =>
      c.options.filter((o) => norm(o.name) === key).map((o) => ({ c, o }))
    );
    if (!hits.length) {
      notes.push(`${label}: "${name}" is not one of its rolled options; skipped.`);
      continue;
    }
    const columns = new Set(hits.map((h) => h.c.socketIndex));
    if (columns.size > 1) {
      notes.push(`${label}: "${name}" appears in more than one column; skipped.`);
      continue;
    }
    // Prefer the enhanced version if the weapon rolled both
    const pick = hits.find((h) => h.o.enhanced) ?? hits[0];
    const { c, o } = pick;
    if (usedSockets.has(c.socketIndex)) {
      notes.push(`${label}: two requested perks share the ${c.label} column; "${name}" skipped.`);
      continue;
    }
    usedSockets.add(c.socketIndex);
    if (o.hash === c.selectedHash) {
      notes.push(`${label}: ${o.name} already selected.`);
      continue;
    }
    if (!o.canInsert) {
      notes.push(`${label}: Bungie reports ${o.name} can't be selected right now; skipped.`);
      continue;
    }
    changes.push({
      itemId: w.itemId,
      weapon: w.name,
      column: c.label,
      socketIndex: c.socketIndex,
      from: c.selected,
      to: o.name,
      plugHash: o.hash,
    });
  }
  return { changes, notes };
}

export function registerPerkTools(
  server: McpServer,
  oauth: BungieOAuth,
  apiKey: string,
  inventory: InventoryService
): void {
  server.tool(
    'set_perks',
    "Change selected perks on the user's own weapons (vault or characters) to other options the weapon already rolled, e.g. switch to a PvP or PvE perk set. Accepts perk, barrel, magazine or other column option names. Free and reversible. The character must be in orbit, in a social space or offline. Use dryRun to preview without changing anything.",
    {
      changes: z
        .array(
          z.object({
            itemId: z.string().describe('Weapon item instance id'),
            select: z
              .array(z.string())
              .min(1)
              .describe(
                'Names of the options to select, e.g. ["Dynamic Sway Reduction", "Kill Clip", "Arrowhead Brake"]'
              ),
          })
        )
        .min(1)
        .max(50),
      dryRun: z.boolean().optional().describe('Only show what would change (default false)'),
    },
    async ({ changes, dryRun }) => {
      try {
        const [rows, m, charIds] = await Promise.all([
          inventory.getWeapons(true),
          inventory.getMembership(),
          inventory.getCharacterIds(),
        ]);
        const byId = new Map(rows.map((r) => [r.itemId, r]));
        const planned: PlannedChange[] = [];
        const notes: string[] = [];
        const charFor = new Map<string, string>();

        for (const req of changes) {
          const id = req.itemId.replace(/"/g, '');
          const w = byId.get(id);
          if (!w) {
            notes.push(`No weapon with id ${id} in your inventory; skipped.`);
            continue;
          }
          charFor.set(id, w.characterId ?? charIds[0]);
          const p = planForWeapon(w, req.select);
          planned.push(...p.changes);
          notes.push(...p.notes);
        }

        const lines: string[] = [];
        if (dryRun || !planned.length) {
          lines.push(
            dryRun ? `Preview: ${planned.length} change(s), nothing applied.` : 'Nothing to change.'
          );
          for (const c of planned) lines.push(`- ${c.weapon}: ${c.column} ${c.from} → ${c.to}`);
          if (notes.length) lines.push('', ...notes.map((n) => `- ${n}`));
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        let ok = 0;
        const failures: string[] = [];
        for (let i = 0; i < planned.length; i++) {
          const c = planned[i];
          if (i > 0) await new Promise((r) => setTimeout(r, SOCKET_ACTION_GAP_MS));
          try {
            await authedPost(oauth, apiKey, '/Destiny2/Actions/Items/InsertSocketPlugFree/', {
              plug: { socketIndex: c.socketIndex, socketArrayType: 0, plugItemHash: c.plugHash },
              itemId: c.itemId,
              characterId: charFor.get(c.itemId),
              membershipType: m.membershipType,
            });
            ok++;
            lines.push(`✓ ${c.weapon}: ${c.column} ${c.from} → ${c.to}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failures.push(`✗ ${c.weapon}: ${c.column} → ${c.to}: ${msg}`);
            if (
              /DestinyCharacterNotInTower|InActivity|NotInOrbit|CharacterNotInSocialSpace/i.test(
                msg
              )
            ) {
              failures.push(
                'Stopped: go to orbit, the Tower or another social space (or log out), then retry.'
              );
              break;
            }
          }
        }
        inventory.invalidate();
        const summary = `Applied ${ok} of ${planned.length} change(s).`;
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                summary,
                ...lines,
                ...failures,
                ...(notes.length ? ['', ...notes.map((n) => `- ${n}`)] : []),
              ].join('\n'),
            },
          ],
          isError: ok === 0 && failures.length > 0,
        };
      } catch (err) {
        const text =
          err instanceof NotSignedInError
            ? err.message
            : `Error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
    }
  );
}
