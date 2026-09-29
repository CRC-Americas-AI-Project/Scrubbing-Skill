/**
 * Authentication flow utilities
 * Handles SAP SSO, OAuth flows, and cookie extraction
 */
import { Page } from 'puppeteer';
import type { StoredCookie } from '../types.js';
/**
 * Known SSO/IDP domains that handle authentication redirects.
 * Add new SSO providers here — all SSO detection uses this list.
 */
export declare const SSO_DOMAINS: readonly ["microsoftonline.com", "accounts.sap.com"];
/**
 * Check if URL is on a known SSO domain
 */
export declare function isSsoDomain(url: string): boolean;
/**
 * Teams domains for cookie extraction
 */
export declare const TEAMS_COOKIE_DOMAINS: string[];
/**
 * Check if URL is a Teams URL
 */
export declare function isTeamsUrl(url: string): boolean;
/**
 * Check if URL is a login page
 */
export declare function isLoginUrl(url: string): boolean;
/**
 * Authentication attempt result
 */
export interface AuthAttemptResult {
    success: boolean;
    needsUserInteraction: boolean;
}
/**
 * Extract cookies from browser page
 */
export declare function extractCookies(page: Page, domain: string): Promise<StoredCookie[]>;
/**
 * Extract cookies from multiple Teams domains
 */
export declare function extractTeamsCookies(page: Page): Promise<StoredCookie[]>;
/**
 * Check for Microsoft Authenticator number matching display
 */
export declare function checkForAuthenticatorNumber(page: Page): Promise<string | null>;
/**
 * Try CSS selectors in order, click the first match. Returns true if clicked.
 */
export declare function tryClickFirst(page: Page, selectors: string[]): Promise<boolean>;
/**
 * Handle automatic prompts (Stay signed in, etc.)
 */
export declare function handleAutomaticPrompts(page: Page): Promise<void>;
/**
 * Wait for authentication to complete
 */
export declare function waitForAuthenticationCompletion(page: Page, domain: string, isTeams?: boolean): Promise<boolean>;
/**
 * Show authentication alert to user
 */
export declare function showAuthAlert(page: Page): Promise<void>;
//# sourceMappingURL=auth-flows.d.ts.map