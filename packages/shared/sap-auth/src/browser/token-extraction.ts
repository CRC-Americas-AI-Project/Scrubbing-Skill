/**
 * Token extraction utilities
 * Handles OAuth token and MSAL data extraction from browser localStorage
 */

import { Page } from 'puppeteer';
import { createLogger } from 'mcp-logger';
import { delay } from 'mcp-utils';
import type { StoredToken, StoredRefreshToken } from '../types.js';
import { parseJwt } from '../utils/jwt.js';

// Timeout for waiting for MSAL to populate localStorage (adapts to machine speed)
const MSAL_WAIT_TIMEOUT_MS = 90_000;
const MSAL_POLL_INTERVAL_MS = 1_000;

// ============================================================================
// MSAL localStorage key patterns (serializable — passed into page.evaluate)
// ============================================================================

/**
 * Substrings that identify MSAL access-token or id-token entries.
 * MSAL v1 uses hyphens: "uid-accesstoken-audience"
 * MSAL v2 uses pipes:   "uid|accesstoken|audience"
 * Append here to support future MSAL versions.
 */
const MSAL_TOKEN_KEY_PATTERNS: readonly string[] = [
  '-accesstoken-', '-idtoken-',   // MSAL v1
  '|accesstoken|', '|idtoken|',   // MSAL v2
];

/** Substrings that identify MSAL refresh-token entries. */
const MSAL_REFRESH_TOKEN_KEY_PATTERNS: readonly string[] = [
  '-refreshtoken-',                // MSAL v1
  '|refreshtoken|',                // MSAL v2
];

/** Known localStorage keys that hold MSAL account key lists. */
const MSAL_ACCOUNT_KEYS: readonly string[] = [
  'msal.account.keys',            // MSAL v1
  'msal.2.account.keys',          // MSAL v2
];

const log = createLogger('sap-auth', 'token-extraction');

/**
 * MSAL data extracted from localStorage
 */
export interface MsalData {
  refreshToken?: StoredRefreshToken;
  account?: {
    homeAccountId: string;
    environment: string;
    tenantId: string;
    username: string;
    name?: string;
  };
}

/**
 * Poll localStorage from Node.js until a condition is met.
 *
 * Unlike page.waitForFunction (which installs a long-lived JS function in
 * the browser context), this runs short-lived page.evaluate() calls from
 * Node. Each call is atomic, so SPA navigations that destroy the execution
 * context only cause a single retry rather than a fatal error.
 */
async function pollLocalStorage(
  page: Page,
  check: (patterns: string[]) => boolean,
  patterns: readonly string[],
  timeoutMs = MSAL_WAIT_TIMEOUT_MS,
  intervalMs = MSAL_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(check, [...patterns])) return true;
    } catch {
      // Execution context destroyed by SPA navigation — retry
    }
    await delay(intervalMs);
  }
  return false;
}

/**
 * Extract OAuth tokens from localStorage
 */
export async function extractTokens(
  page: Page,
  targetAudiences: string[],
): Promise<StoredToken[]> {
  // Get all localStorage items
  const localStorageData = await page.evaluate(() => {
    const result: { key: string; value: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const value = localStorage.getItem(key);
        if (value) {
          result.push({ key, value });
        }
      }
    }
    return result;
  });

  const tokens: StoredToken[] = [];
  const jwtPattern = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

  for (const item of localStorageData) {
    const matches = item.value.match(jwtPattern);
    if (matches) {
      for (const jwt of matches) {
        const tokenInfo = parseJwt(jwt);
        if (tokenInfo) {
          // Check if audience matches any target
          const isTargetAudience = targetAudiences.some(
            (aud) =>
              tokenInfo.audience.includes(aud) || aud.includes(tokenInfo.audience),
          );

          if (isTargetAudience && tokenInfo.expiresAt > Date.now() / 1000) {
            tokens.push({
              token: jwt,
              audience: tokenInfo.audience,
              expiresAt: tokenInfo.expiresAt,
              scopes: tokenInfo.scopes || [],
            });
          }
        }
      }
    }
  }

  // Deduplicate by token prefix
  const uniqueTokens = new Map<string, StoredToken>();
  for (const token of tokens) {
    const key = token.token.substring(0, 50);
    const existing = uniqueTokens.get(key);
    if (!existing || token.expiresAt > existing.expiresAt) {
      uniqueTokens.set(key, token);
    }
  }

  return Array.from(uniqueTokens.values());
}

/**
 * Wait for MSAL to populate localStorage, then extract tokens.
 *
 * SPAs like Teams load asynchronously — MSAL may not have stored tokens yet
 * when the page URL already shows the target domain. Uses Node-side polling
 * (via pollLocalStorage) to detect MSAL key patterns, adapting to any machine
 * speed and surviving execution context destruction from SPA navigation.
 */
export async function waitForTokens(
  page: Page,
  targetAudiences: string[],
): Promise<StoredToken[]> {
  // Fast path: tokens already in localStorage
  const immediate = await extractTokens(page, targetAudiences);
  if (immediate.length > 0) return immediate;

  // Wait for MSAL to store tokens
  log.info('Waiting for MSAL to populate localStorage...');

  const found = await pollLocalStorage(
    page,
    (patterns: string[]) => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && patterns.some((p) => key.includes(p))) return true;
      }
      return false;
    },
    MSAL_TOKEN_KEY_PATTERNS,
  );

  if (!found) {
    log.warn('Timed out waiting for MSAL tokens in localStorage');
    return [];
  }

  const tokens = await extractTokens(page, targetAudiences);
  log.info(`Found ${tokens.length} token(s) after waiting for MSAL`);
  return tokens;
}

/**
 * Extract MSAL refresh token and account info from localStorage
 */
export async function extractMsalRefreshToken(page: Page): Promise<MsalData> {
  try {
    const msalData = await page.evaluate(
      (refreshPatterns: string[], accountKeyNames: string[]) => {
        const result: {
          refreshToken?: {
            secret: string;
            clientId: string;
            homeAccountId: string;
            environment: string;
            expiresOn?: number;
          };
          account?: {
            homeAccountId: string;
            environment: string;
            tenantId: string;
            username: string;
            name?: string;
          };
        } = {};

        // Find refresh token entries (key matches any refresh pattern)
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && refreshPatterns.some((p) => key.includes(p))) {
            try {
              const value = localStorage.getItem(key);
              if (value) {
                const parsed = JSON.parse(value);
                if (parsed.credentialType === 'RefreshToken' && parsed.secret) {
                  result.refreshToken = {
                    secret: parsed.secret,
                    clientId: parsed.clientId,
                    homeAccountId: parsed.homeAccountId,
                    environment: parsed.environment,
                    expiresOn: parsed.expiresOn ? parseInt(parsed.expiresOn, 10) : undefined,
                  };
                  break; // Take the first refresh token found
                }
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }

        // Find account info — try each known account-keys key
        for (const accountKeysKey of accountKeyNames) {
          const accountKeysStr = localStorage.getItem(accountKeysKey);
          if (!accountKeysStr) continue;
          try {
            const accountKeys = JSON.parse(accountKeysStr);
            if (Array.isArray(accountKeys) && accountKeys.length > 0) {
              const accountData = localStorage.getItem(accountKeys[0]);
              if (accountData) {
                const parsed = JSON.parse(accountData);
                result.account = {
                  homeAccountId: parsed.homeAccountId,
                  environment: parsed.environment,
                  tenantId: parsed.realm || parsed.tenantId,
                  username: parsed.username,
                  name: parsed.name,
                };
                break; // Found account, stop searching
              }
            }
          } catch {
            // Skip invalid JSON
          }
        }

        return result;
      },
      [...MSAL_REFRESH_TOKEN_KEY_PATTERNS],
      [...MSAL_ACCOUNT_KEYS],
    );

    return msalData;
  } catch (error) {
    log.warn('Warning: Failed to extract MSAL refresh token:', error);
    return {};
  }
}
