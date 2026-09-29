/**
 * OAuth authentication method (token-based)
 * Used for Teams, Graph API, and other OAuth2 systems
 *
 * Supports silent token refresh using MSAL-compatible refresh tokens
 */
import type { Credentials, ProviderConfig, StoredOAuthAuth } from '../types.js';
import { AuthMethod } from './base.js';
/**
 * OAuth authentication using tokens
 */
export declare class OAuthMethod extends AuthMethod<StoredOAuthAuth> {
    /**
     * Validate stored tokens
     */
    validate(stored: StoredOAuthAuth | null): Promise<boolean>;
    /**
     * Convert tokens to credentials
     * Returns the first valid token as a bearer credential
     */
    toCredentials(stored: StoredOAuthAuth): Credentials;
    /**
     * Get token for a specific audience
     */
    getTokenForAudience(stored: StoredOAuthAuth, audience: string): Credentials | null;
    /**
     * Try to silently refresh tokens using stored refresh token.
     * Returns null if refresh fails (caller should fall back to browser auth).
     */
    refresh(stored: StoredOAuthAuth | null, config: ProviderConfig): Promise<StoredOAuthAuth | null>;
    /**
     * Request a new access token using the refresh token
     */
    private requestAccessToken;
    /**
     * Authenticate using browser token extraction, falling back to device code flow
     * if the browser cannot extract MSAL tokens (e.g., teams.cloud.microsoft uses
     * encrypted MSAL cache that Puppeteer cannot read).
     */
    authenticate(config: ProviderConfig): Promise<StoredOAuthAuth>;
    /**
     * Get earliest expiration time from all tokens
     */
    getExpiresAt(stored: StoredOAuthAuth): Date | null;
}
//# sourceMappingURL=oauth.d.ts.map