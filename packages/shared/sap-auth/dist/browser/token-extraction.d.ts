/**
 * Token extraction utilities
 * Handles OAuth token and MSAL data extraction from browser localStorage
 */
import { Page } from 'puppeteer';
import type { StoredToken, StoredRefreshToken } from '../types.js';
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
 * Extract OAuth tokens from localStorage
 */
export declare function extractTokens(page: Page, targetAudiences: string[]): Promise<StoredToken[]>;
/**
 * Wait for MSAL to populate localStorage, then extract tokens.
 *
 * SPAs like Teams load asynchronously — MSAL may not have stored tokens yet
 * when the page URL already shows the target domain. Uses Node-side polling
 * (via pollLocalStorage) to detect MSAL key patterns, adapting to any machine
 * speed and surviving execution context destruction from SPA navigation.
 */
export declare function waitForTokens(page: Page, targetAudiences: string[]): Promise<StoredToken[]>;
/**
 * Extract MSAL refresh token and account info from localStorage
 */
export declare function extractMsalRefreshToken(page: Page): Promise<MsalData>;
//# sourceMappingURL=token-extraction.d.ts.map