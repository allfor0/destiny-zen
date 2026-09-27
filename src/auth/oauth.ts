/**
 * Bungie.net OAuth 2.0 (confidential client) for Destiny Zen.
 *
 * Flow (per https://github.com/Bungie-net/api/wiki/OAuth-Documentation):
 *  1. Send the user to https://www.bungie.net/en/oauth/authorize?client_id=..&response_type=code&state=..
 *  2. Bungie redirects to the app's registered Redirect URL with ?code=..&state=..
 *  3. POST the code to https://www.bungie.net/platform/app/oauth/token/ (Basic auth with client id/secret)
 *  4. Use `Authorization: Bearer <access_token>` plus `X-API-Key` on API calls.
 *  5. Refresh with grant_type=refresh_token before the access token expires (~1 hour).
 *
 * Tokens are stored in a JSON file shared by the sign-in command and the MCP server.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URLSearchParams } from 'node:url';

export const AUTHORIZE_URL = 'https://www.bungie.net/en/oauth/authorize';
export const TOKEN_URL = 'https://www.bungie.net/platform/app/oauth/token/';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when the access token expires */
  access_expires_at: number;
  /** Epoch ms when the refresh token expires */
  refresh_expires_at: number;
  /** Bungie.net membership id of the signed-in user */
  membership_id: string;
  /** Epoch ms of the last successful token write */
  updated_at: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  membership_id: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Optional override for where tokens are stored */
  tokenFile?: string;
}

export function defaultTokenFile(): string {
  return path.join(os.homedir(), '.destiny-zen', 'tokens.json');
}

export class NotSignedInError extends Error {
  constructor(message = 'Not signed in to Bungie. Run `npm run auth` in the destiny-zen folder.') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

export class BungieOAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  readonly tokenFile: string;
  private cache: StoredTokens | null = null;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(config: OAuthConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('BUNGIE_CLIENT_ID and BUNGIE_CLIENT_SECRET are required for sign-in');
    }
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.tokenFile = config.tokenFile || defaultTokenFile();
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  private basicAuthHeader(): string {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  private async requestToken(body: URLSearchParams): Promise<StoredTokens> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Bungie token request failed: ${res.status} ${res.statusText} ${text}`);
    }
    const data = JSON.parse(text) as TokenResponse;
    if (!data.refresh_token || !data.refresh_expires_in) {
      throw new Error(
        'Bungie returned no refresh token. Check the app is set to OAuth Client Type "Confidential".'
      );
    }
    const now = Date.now();
    const tokens: StoredTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      access_expires_at: now + data.expires_in * 1000,
      refresh_expires_at: now + data.refresh_expires_in * 1000,
      membership_id: data.membership_id,
      updated_at: now,
    };
    await this.save(tokens);
    return tokens;
  }

  /** Exchange an authorization code (from the redirect) for tokens and store them. */
  async exchangeCode(code: string): Promise<StoredTokens> {
    return this.requestToken(new URLSearchParams({ grant_type: 'authorization_code', code }));
  }

  /** Use the refresh token to get a new access token (and a new refresh token). */
  async refresh(): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const current = await this.load();
        if (!current) throw new NotSignedInError();
        if (Date.now() >= current.refresh_expires_at) {
          throw new NotSignedInError(
            'Bungie sign-in has expired. Run `npm run auth` in the destiny-zen folder again.'
          );
        }
        return await this.requestToken(
          new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh_token })
        );
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Returns a valid access token, refreshing it if it expires within 2 minutes. */
  async getAccessToken(): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new NotSignedInError();
    if (Date.now() < tokens.access_expires_at - 120_000) return tokens.access_token;
    const fresh = await this.refresh();
    return fresh.access_token;
  }

  async load(): Promise<StoredTokens | null> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.tokenFile, 'utf8');
      this.cache = JSON.parse(raw) as StoredTokens;
      return this.cache;
    } catch {
      return null;
    }
  }

  private async save(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
    await fs.writeFile(this.tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    this.cache = tokens;
  }

  async status(): Promise<{
    signedIn: boolean;
    membershipId?: string;
    accessExpiresAt?: string;
    refreshExpiresAt?: string;
    tokenFile: string;
  }> {
    this.cache = null; // always re-read so a fresh `npm run auth` is picked up
    const t = await this.load();
    if (!t) return { signedIn: false, tokenFile: this.tokenFile };
    return {
      signedIn: Date.now() < t.refresh_expires_at,
      membershipId: t.membership_id,
      accessExpiresAt: new Date(t.access_expires_at).toISOString(),
      refreshExpiresAt: new Date(t.refresh_expires_at).toISOString(),
      tokenFile: this.tokenFile,
    };
  }
}
