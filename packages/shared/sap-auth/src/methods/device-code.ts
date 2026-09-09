/**
 * Microsoft device code flow for OAuth authentication.
 *
 * Used as fallback when browser token extraction fails (e.g., teams.cloud.microsoft
 * uses encrypted MSAL cache that Puppeteer cannot read).
 *
 * Flow:
 *  1. POST to /devicecode endpoint → get user_code + verification_uri
 *  2. Print code to stdout (visible in Claude conversation)
 *  3. Poll /token endpoint until user completes login or timeout
 */

import { createLogger } from 'mcp-logger';
import type { StoredToken, StoredRefreshToken } from '../types.js';
import { parseJwt } from '../utils/jwt.js';

const log = createLogger('sap-auth', 'device-code');

// Microsoft's Teams SPA client ID (public client, no secret needed)
const TEAMS_CLIENT_ID = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346';
const DEVICE_CODE_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

// Poll every 5 seconds, timeout after 5 minutes
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 5 * 60 * 1000;

export interface DeviceCodeResult {
  tokens: StoredToken[];
  refreshToken?: StoredRefreshToken;
}

/**
 * Run the device code flow for the given audiences.
 * Prints the user code to stdout and polls until the user completes login.
 *
 * Uses only Graph scope for the initial device code request to avoid the
 * "static scope limit exceeded" error — the refresh token can later be used
 * to get tokens for other audiences (Teams, ic3, etc.).
 */
export async function runDeviceCodeFlow(audiences: string[]): Promise<DeviceCodeResult> {
  // Request only Graph scope initially — avoids "static scope limit exceeded".
  // Other audiences are obtained later via refresh token.
  const scopes = 'https://graph.microsoft.com/.default offline_access';

  const dcResponse = await fetch(DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TEAMS_CLIENT_ID,
      scope: scopes,
    }).toString(),
  });

  if (!dcResponse.ok) {
    const body = await dcResponse.text();
    throw new Error(`Device code request failed: ${dcResponse.status} - ${body}`);
  }

  const dcData = await dcResponse.json();
  const { device_code, user_code, verification_uri, expires_in, interval } = dcData;

  const pollInterval = (interval || 5) * 1000;
  const deadline = Date.now() + Math.min(expires_in * 1000, TIMEOUT_MS);

  // Print the auth prompt — this appears in Claude's conversation output
  log.info(`\n${'='.repeat(60)}`);
  log.info(`Microsoft Authentication Required`);
  log.info(`${'='.repeat(60)}`);
  log.info(`1. Open: ${verification_uri}`);
  log.info(`2. Enter code: ${user_code}`);
  log.info(`3. Sign in with your SAP Microsoft account`);
  log.info(`${'='.repeat(60)}\n`);

  // Also write directly to stderr so it's visible regardless of log level
  process.stderr.write(`\n[SAP Auth] Open ${verification_uri} and enter code: ${user_code}\n\n`);

  // Poll for token
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval || POLL_INTERVAL_MS));

    const tokenResponse = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TEAMS_CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error === 'authorization_pending') {
      continue;
    }

    if (tokenData.error === 'slow_down') {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (tokenData.error) {
      throw new Error(`Device code auth failed: ${tokenData.error} - ${tokenData.error_description}`);
    }

    if (tokenData.access_token) {
      log.info('Device code authentication succeeded');
      return parseTokenResponse(tokenData, audiences);
    }
  }

  throw new Error('Device code authentication timed out after 5 minutes');
}

function parseTokenResponse(data: any, audiences: string[]): DeviceCodeResult {
  const tokens: StoredToken[] = [];

  // Parse the primary access token
  if (data.access_token) {
    const info = parseJwt(data.access_token);
    tokens.push({
      token: data.access_token,
      audience: info?.audience || audiences[0] || '',
      expiresAt: data.expires_in
        ? Math.floor(Date.now() / 1000) + data.expires_in
        : info?.expiresAt || Math.floor(Date.now() / 1000) + 3600,
      scopes: data.scope ? data.scope.split(' ') : [],
    });
  }

  let refreshToken: StoredRefreshToken | undefined;
  if (data.refresh_token) {
    // Device code flow uses a public client — clientId is TEAMS_CLIENT_ID
    refreshToken = {
      secret: data.refresh_token,
      clientId: TEAMS_CLIENT_ID,
      homeAccountId: '',
      environment: 'login.windows.net',
      expiresOn: Math.floor(Date.now() / 1000) + 90 * 24 * 3600, // ~90 days
    };
  }

  return { tokens, refreshToken };
}
