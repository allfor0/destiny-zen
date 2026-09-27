import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BungieOAuth, NotSignedInError } from '../auth/oauth.js';

const API_BASE = 'https://www.bungie.net/Platform';

interface BungieEnvelope<T> {
  Response: T;
  ErrorCode: number;
  ErrorStatus: string;
  Message: string;
}

/**
 * Authenticated GET against the Bungie API using the stored OAuth token.
 * Exported for the vault/inventory tools added in later phases.
 */
export async function authedGet<T>(
  oauth: BungieOAuth,
  apiKey: string,
  endpoint: string
): Promise<T> {
  const token = await oauth.getAccessToken();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'X-API-Key': apiKey, Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: BungieEnvelope<T>;
  try {
    body = JSON.parse(text) as BungieEnvelope<T>;
  } catch {
    throw new Error(`Bungie API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  if (body.ErrorCode !== 1) {
    throw new Error(`Bungie API error ${body.ErrorCode} ${body.ErrorStatus}: ${body.Message}`);
  }
  return body.Response;
}

interface UserMembershipData {
  destinyMemberships: Array<{
    membershipType: number;
    membershipId: string;
    displayName: string;
    crossSaveOverride: number;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
  }>;
  primaryMembershipId?: string;
  bungieNetUser: { membershipId: string; uniqueName?: string; displayName?: string };
}

const PLATFORM: Record<number, string> = {
  1: 'Xbox',
  2: 'PlayStation',
  3: 'Steam',
  5: 'Stadia',
  6: 'Epic',
};

function errorResult(err: unknown) {
  const text =
    err instanceof NotSignedInError
      ? err.message
      : `Error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerAuthTools(server: McpServer, oauth: BungieOAuth, apiKey: string): void {
  server.tool(
    'auth_status',
    "Check whether Destiny Zen is signed in to the user's Bungie account (OAuth), and when the sign-in expires.",
    {},
    async () => {
      const s = await oauth.status();
      const lines = s.signedIn
        ? [
            'Signed in to Bungie.',
            `- Bungie.net member id: ${s.membershipId}`,
            `- Access token expires: ${s.accessExpiresAt} (refreshed automatically)`,
            `- Sign-in expires: ${s.refreshExpiresAt}`,
            `- Token file: ${s.tokenFile}`,
          ]
        : [
            'Not signed in to Bungie (or the sign-in has expired).',
            'Run `npm run auth` in the destiny-zen folder, then restart the Claude desktop app.',
            `- Token file checked: ${s.tokenFile}`,
          ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  server.tool(
    'get_my_account',
    "Get the signed-in user's own Bungie account: Bungie Name and all Destiny memberships, marking the cross-save primary one (the membership to use for vault and inventory calls). Requires sign-in.",
    {},
    async () => {
      try {
        const data = await authedGet<UserMembershipData>(
          oauth,
          apiKey,
          '/User/GetMembershipsForCurrentUser/'
        );
        const primary = data.primaryMembershipId;
        const first = data.destinyMemberships[0];
        const name = first?.bungieGlobalDisplayName
          ? `${first.bungieGlobalDisplayName}#${String(first.bungieGlobalDisplayNameCode ?? '').padStart(4, '0')}`
          : (data.bungieNetUser.displayName ?? data.bungieNetUser.uniqueName ?? 'unknown');
        const lines = [
          `# ${name}`,
          `Bungie.net member id: ${data.bungieNetUser.membershipId}`,
          '',
          '## Destiny memberships',
          ...data.destinyMemberships.map((m) => {
            const tag = m.membershipId === primary ? ' ⚡ CROSS-SAVE PRIMARY (use this one)' : '';
            return `- ${PLATFORM[m.membershipType] ?? `type ${m.membershipType}`} (type ${m.membershipType}): ${m.membershipId}, platform name "${m.displayName}"${tag}`;
          }),
        ];
        if (!primary) lines.push('', 'No cross-save primary reported; single-platform account.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
