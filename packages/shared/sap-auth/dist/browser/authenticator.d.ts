/**
 * Browser-based authenticator using Puppeteer
 *
 * Thin wrapper around `runHybridBrowserFlow` that provides the appropriate
 * `onAuthenticated` callback for each auth type (SAP SSO vs OAuth).
 */
import type { StoredCookie, StoredToken, StoredRefreshToken } from '../types.js';
/**
 * Browser authenticator for SAP systems
 * Hybrid mode: starts headless, switches to visible if user interaction needed
 */
export declare class BrowserAuthenticator {
    /**
     * No-op — the hybrid flow manages its own browser lifecycle.
     * Kept for backward compatibility.
     */
    close(): Promise<void>;
    /**
     * Authenticate with SAP SSO and return cookies
     */
    authenticateSapSso(entryUrl: string, domain: string): Promise<StoredCookie[]>;
    /**
     * Authenticate with OAuth and extract tokens
     */
    authenticateOAuth(entryUrl: string, domain: string, targetAudiences: string[]): Promise<{
        cookies: StoredCookie[];
        tokens: StoredToken[];
        refreshToken?: StoredRefreshToken;
        account?: {
            homeAccountId: string;
            environment: string;
            tenantId: string;
            username: string;
            name?: string;
        };
    }>;
    private resolveDomain;
    private logAuthStart;
}
//# sourceMappingURL=authenticator.d.ts.map