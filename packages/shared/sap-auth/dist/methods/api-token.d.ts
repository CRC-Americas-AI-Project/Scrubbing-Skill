/**
 * API Token authentication method (static tokens)
 * Used for services that support API tokens/PAT (Personal Access Tokens)
 */
import type { Credentials, ProviderConfig, StoredApiTokenAuth } from '../types.js';
import { AuthMethod } from './base.js';
/**
 * API Token authentication
 * Tokens are provided by the user and don't expire (or expire very far in future)
 */
export declare class ApiTokenMethod extends AuthMethod<StoredApiTokenAuth> {
    /**
     * Validate stored API token
     * Just checks if token exists - API tokens don't typically expire
     */
    validate(stored: StoredApiTokenAuth | null): Promise<boolean>;
    /**
     * Convert API token to credentials
     */
    toCredentials(stored: StoredApiTokenAuth): Credentials;
    /**
     * API tokens can't be refreshed - they're static
     */
    refresh(_stored: StoredApiTokenAuth | null, _config: ProviderConfig): Promise<StoredApiTokenAuth | null>;
    /**
     * "Authenticate" for API tokens means telling the user to provide one via sap_add_pat
     */
    authenticate(config: ProviderConfig): Promise<StoredApiTokenAuth>;
    /**
     * API tokens don't expire
     */
    getExpiresAt(_stored: StoredApiTokenAuth): Date | null;
}
//# sourceMappingURL=api-token.d.ts.map