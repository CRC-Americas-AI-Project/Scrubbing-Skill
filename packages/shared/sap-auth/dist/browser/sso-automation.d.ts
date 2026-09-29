/**
 * SSO automation utilities
 * Handles automated Microsoft SSO authentication flow
 */
import { Page } from 'puppeteer';
/**
 * Authentication attempt result
 */
export interface AuthAttemptResult {
    success: boolean;
    needsUserInteraction: boolean;
}
/**
 * Attempt headless authentication (email clicking, etc.)
 * Detects when user interaction is needed, including certificate selection dialogs
 */
export declare function attemptHeadlessAuth(page: Page, domain: string, userEmail: string | undefined, forceManualFallback: boolean): Promise<AuthAttemptResult>;
//# sourceMappingURL=sso-automation.d.ts.map