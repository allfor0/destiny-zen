#!/usr/bin/env node
/**
 * One-off Bungie sign-in for Destiny Zen.
 *
 *   npm run auth
 *
 * Reads BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET and BUNGIE_REDIRECT_URL (default
 * https://localhost:7777/callback) from the environment or a .env file in this folder,
 * starts a local HTTPS listener with a self-signed certificate, opens the Bungie
 * authorisation page, and stores the resulting tokens for the MCP server to use.
 */
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import selfsigned from 'selfsigned';
import { BungieOAuth } from './oauth.js';

dotenv.config();

const clientId = process.env.BUNGIE_CLIENT_ID ?? '';
const clientSecret = process.env.BUNGIE_CLIENT_SECRET ?? '';
const redirect = new URL(process.env.BUNGIE_REDIRECT_URL || 'https://localhost:7777/callback');

if (!clientId || !clientSecret) {
  console.error(
    'Missing BUNGIE_CLIENT_ID or BUNGIE_CLIENT_SECRET. Add them to a .env file in this folder.'
  );
  process.exit(1);
}
if (redirect.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) {
  console.error(`BUNGIE_REDIRECT_URL must be https://localhost:<port>/<path>, got ${redirect}`);
  process.exit(1);
}

const oauth = new BungieOAuth({
  clientId,
  clientSecret,
  tokenFile: process.env.DESTINY_ZEN_TOKEN_FILE,
});
const state = crypto.randomBytes(16).toString('hex');
const port = Number(redirect.port || 443);

function openBrowser(url: string): void {
  const opener =
    process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
          detached: true,
          stdio: 'ignore',
        });
  opener.on('error', () => undefined);
  opener.unref();
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#111;color:#eee;padding:3rem;max-width:40rem">
<h1>${title}</h1><p>${body}</p></body>`;
}

async function main(): Promise<void> {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    notAfterDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });

  const timeout = setTimeout(() => {
    console.error('No sign-in received within 5 minutes. Run `npm run auth` again.');
    process.exit(1);
  }, 5 * 60_000);

  const server = https.createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
    const url = new URL(req.url ?? '/', `https://localhost:${port}`);
    if (url.pathname !== redirect.pathname) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error || !code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(
        page(
          'Sign-in failed',
          `Bungie returned: ${error ?? 'no code'}. Close this tab and try again.`
        )
      );
      console.error(`Sign-in failed: ${error ?? 'no code returned'}`);
      return;
    }
    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(page('Sign-in failed', 'State mismatch. Close this tab and run npm run auth again.'));
      console.error('Sign-in failed: state mismatch');
      return;
    }

    try {
      const tokens = await oauth.exchangeCode(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        page(
          'Destiny Zen is signed in',
          'You can close this tab. Restart the Claude desktop app so the DestinyZen server picks up the sign-in.'
        )
      );
      console.log(`Signed in as Bungie.net member ${tokens.membership_id}.`);
      console.log(`Tokens saved to ${oauth.tokenFile}`);
      console.log(`Sign-in lasts until ${new Date(tokens.refresh_expires_at).toLocaleString()}.`);
      clearTimeout(timeout);
      setTimeout(() => server.close(() => process.exit(0)), 500);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(page('Sign-in failed', String(err)));
      console.error(String(err));
    }
  });

  server.on('error', (err) => {
    console.error(`Could not listen on port ${port}: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const authUrl = oauth.authorizeUrl(state);
    console.log(`Listening on ${redirect.origin}${redirect.pathname}`);
    console.log('Opening Bungie sign-in in your browser. If it does not open, visit:');
    console.log(authUrl);
    console.log(
      '\nAfter you approve, your browser will warn that the localhost certificate is not trusted.'
    );
    console.log(
      'That is expected (it is a certificate made on your PC just now): choose Advanced > Continue.\n'
    );
    openBrowser(authUrl);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
