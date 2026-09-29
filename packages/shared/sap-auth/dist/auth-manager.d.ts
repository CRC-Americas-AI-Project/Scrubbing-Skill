/**
 * AuthManager - Main entry point for SAP auth
 *
 * Single orchestrator pattern: AuthManager owns the full auth flow
 * (storage I/O, method dispatch, provider config).
 * Auth methods are stateless building blocks.
 *
 * Usage:
 *   import { createAuthClient } from 'sap-auth';
 *
 *   const client = createAuthClient({ domain: 'wiki.one.int.sap', method: 'sap-sso' });
 *   const headers = await client.getHeaders();
 */
import type { Credentials, AuthStatus, ProviderConfig } from './types.js';
/**
 * Main AuthManager singleton
 */
export declare class AuthManager {
    private static instance;
    private storage;
    private sapSsoMethod;
    private oauthMethod;
    private apiTokenMethod;
    /** Provider configs registered by MCPs via createAuthClient */
    private providers;
    /** Dedup concurrent auth calls per domain (prevents double browser launches) */
    private pendingAuth;
    private pendingReauth;
    private constructor();
    /**
     * Get the singleton instance
     */
    static getInstance(): AuthManager;
    /**
     * Register a provider config (called by createAuthClient)
     */
    registerProvider(config: ProviderConfig): void;
    /**
     * Get a registered provider config by domain
     */
    getProvider(domain: string): ProviderConfig | undefined;
    /**
     * List all registered domain keys
     */
    listRegisteredDomains(): string[];
    /**
     * Get credentials for a provider.
     * This is the main method MCPs use (via AuthClient).
     *
     * Deduplicates concurrent calls per domain to prevent double browser launches.
     *
     * Flow:
     * 1. Load stored auth (once)
     * 2. If stored: validate → return, or refresh → return
     * 3. If no valid auth: authenticate fresh (browser)
     *
     * Method resolution uses stored.method (not config.method) — if a PAT was
     * stored for an SSO provider, we use ApiTokenMethod, not SapSsoMethod.
     */
    getCredentials(domain: string): Promise<Credentials>;
    private _getCredentials;
    /**
     * Get credentials for a specific token audience (OAuth only).
     * Used when a provider has multiple token audiences (e.g., Teams vs Graph).
     *
     * Delegates lifecycle (validate → refresh → browser auth) to getCredentials(),
     * then extracts the audience-specific token. If the audience token is missing
     * after fresh auth, forces full re-auth once.
     */
    getCredentialsForAudience(domain: string, audience: string): Promise<Credentials>;
    /**
     * Get auth status for a provider without triggering authentication
     */
    getStatus(domain: string): Promise<AuthStatus>;
    /**
     * Set an API token for a provider
     * Used when provider requires API token and user provides it
     */
    setApiToken(domain: string, token: string): Promise<void>;
    /**
     * Force re-authentication for a provider.
     *
     * Deduplicates concurrent calls per domain.
     *
     * For api-token providers, throws without deleting stored auth —
     * PATs can't be auto-replaced, so deleting them forces the user
     * to re-add manually.
     */
    forceReauth(domain: string): Promise<Credentials>;
    private _forceReauth;
    /**
     * Clear auth for a specific provider
     */
    clearAuth(domain: string): Promise<void>;
    /**
     * Clear all stored auth data
     */
    clearAll(): Promise<void>;
    /**
     * List all providers (registered + stored) with their status
     */
    listProviders(): Promise<AuthStatus[]>;
    /**
     * Get the storage file path (for debugging)
     */
    getStoragePath(): string;
    /**
     * Resolve method instance by auth type
     */
    private methodFor;
    /**
     * Get provider config or throw
     */
    private requireConfig;
}
//# sourceMappingURL=auth-manager.d.ts.map