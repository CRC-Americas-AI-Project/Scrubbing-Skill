/**
 * SAP SSO authentication method (cookie-based)
 * Used for Wiki, Jira, and other SAP systems using SAP SSO
 */
import { AuthExpiredError } from '../types.js';
import { AuthMethod } from './base.js';
import { BrowserAuthenticator } from '../browser/authenticator.js';
// Cookie expiry threshold (refresh if less than this remaining)
const COOKIE_EXPIRY_BUFFER_MS = 30 * 60 * 1000; // 30 minutes
// SSO token validity period
const SSO_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
/**
 * SAP SSO authentication using cookies
 */
export class SapSsoMethod extends AuthMethod {
    /**
     * Validate stored cookies
     * Checks if cookies exist and aren't too old
     */
    async validate(stored) {
        if (!stored || stored.method !== 'sap-sso') {
            return false;
        }
        if (!stored.cookies || stored.cookies.length === 0) {
            return false;
        }
        // Check if updatedAt is recent enough (cookies typically valid 24h)
        const updatedAt = new Date(stored.updatedAt).getTime();
        const now = Date.now();
        if (now - updatedAt > SSO_TOKEN_TTL_MS - COOKIE_EXPIRY_BUFFER_MS) {
            return false;
        }
        // Check if any essential cookies have expires set and are expired
        const hasExpiredCookie = stored.cookies.some((cookie) => {
            if (cookie.expires && cookie.expires > 0) {
                // expires is in seconds (Unix timestamp)
                return cookie.expires * 1000 < now;
            }
            return false;
        });
        return !hasExpiredCookie;
    }
    /**
     * Convert cookies to credentials
     */
    toCredentials(stored) {
        const cookieString = stored.cookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
        // Estimate expiry from updatedAt (assume 24h validity)
        const updatedAt = new Date(stored.updatedAt).getTime();
        const expiresAt = new Date(updatedAt + SSO_TOKEN_TTL_MS);
        return {
            type: 'cookie',
            value: cookieString,
            expiresAt,
        };
    }
    /**
     * Refresh by re-authenticating with browser
     * SAP SSO doesn't have a refresh mechanism - we just re-auth
     */
    async refresh(stored, config) {
        // For SAP SSO, "refresh" means re-authenticate
        // The browser auth will use stored credentials (certificates, etc.)
        try {
            return await this.authenticate(config);
        }
        catch {
            return null;
        }
    }
    /**
     * Authenticate using browser
     */
    async authenticate(config) {
        const authenticator = new BrowserAuthenticator();
        try {
            const cookies = await authenticator.authenticateSapSso(config.entryUrl || `https://${config.domain}/`, config.domain);
            if (!cookies || cookies.length === 0) {
                throw new AuthExpiredError(config.domain);
            }
            return {
                method: 'sap-sso',
                cookies,
                updatedAt: new Date().toISOString(),
            };
        }
        finally {
            await authenticator.close();
        }
    }
    /**
     * Get expiration time
     */
    getExpiresAt(stored) {
        if (!stored.updatedAt)
            return null;
        const updatedAt = new Date(stored.updatedAt).getTime();
        return new Date(updatedAt + SSO_TOKEN_TTL_MS);
    }
}
//# sourceMappingURL=sap-sso.js.map