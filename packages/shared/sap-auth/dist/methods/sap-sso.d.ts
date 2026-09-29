/**
 * SAP SSO authentication method (cookie-based)
 * Used for Wiki, Jira, and other SAP systems using SAP SSO
 */
import type { Credentials, ProviderConfig, StoredSapSsoAuth } from '../types.js';
import { AuthMethod } from './base.js';
/**
 * SAP SSO authentication using cookies
 */
export declare class SapSsoMethod extends AuthMethod<StoredSapSsoAuth> {
    /**
     * Validate stored cookies
     * Checks if cookies exist and aren't too old
     */
    validate(stored: StoredSapSsoAuth | null): Promise<boolean>;
    /**
     * Convert cookies to credentials
     */
    toCredentials(stored: StoredSapSsoAuth): Credentials;
    /**
     * Refresh by re-authenticating with browser
     * SAP SSO doesn't have a refresh mechanism - we just re-auth
     */
    refresh(stored: StoredSapSsoAuth | null, config: ProviderConfig): Promise<StoredSapSsoAuth | null>;
    /**
     * Authenticate using browser
     */
    authenticate(config: ProviderConfig): Promise<StoredSapSsoAuth>;
    /**
     * Get expiration time
     */
    getExpiresAt(stored: StoredSapSsoAuth): Date | null;
}
//# sourceMappingURL=sap-sso.d.ts.map