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
import { AuthError, AuthExpiredError, AuthNotConfiguredError, ApiTokenRequiredError, } from './types.js';
import { Storage } from './storage.js';
import { SapSsoMethod } from './methods/sap-sso.js';
import { OAuthMethod } from './methods/oauth.js';
import { ApiTokenMethod } from './methods/api-token.js';
import { extractErrorMessage } from 'mcp-utils';
import { createLogger } from 'mcp-logger';
const log = createLogger('sap-auth', 'auth-manager');
/**
 * Main AuthManager singleton
 */
export class AuthManager {
    static instance;
    storage;
    sapSsoMethod;
    oauthMethod;
    apiTokenMethod;
    /** Provider configs registered by MCPs via createAuthClient */
    providers = new Map();
    /** Dedup concurrent auth calls per domain (prevents double browser launches) */
    pendingAuth = new Map();
    pendingReauth = new Map();
    constructor() {
        this.storage = Storage.getInstance();
        this.sapSsoMethod = new SapSsoMethod();
        this.oauthMethod = new OAuthMethod();
        this.apiTokenMethod = new ApiTokenMethod();
    }
    /**
     * Get the singleton instance
     */
    static getInstance() {
        if (!AuthManager.instance) {
            AuthManager.instance = new AuthManager();
        }
        return AuthManager.instance;
    }
    // ============================================================================
    // Provider Registry (inlined — no separate class)
    // ============================================================================
    /**
     * Register a provider config (called by createAuthClient)
     */
    registerProvider(config) {
        this.providers.set(config.domain, config);
    }
    /**
     * Get a registered provider config by domain
     */
    getProvider(domain) {
        return this.providers.get(domain);
    }
    /**
     * List all registered domain keys
     */
    listRegisteredDomains() {
        return Array.from(this.providers.keys());
    }
    // ============================================================================
    // Public API
    // ============================================================================
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
    async getCredentials(domain) {
        const inflight = this.pendingAuth.get(domain);
        if (inflight)
            return inflight;
        const promise = this._getCredentials(domain).finally(() => this.pendingAuth.delete(domain));
        this.pendingAuth.set(domain, promise);
        return promise;
    }
    async _getCredentials(domain) {
        log.clearSummary();
        const config = this.requireConfig(domain);
        const stored = await this.storage.get(domain);
        // Try existing credentials (method from stored auth, not config)
        if (stored) {
            const method = this.methodFor(stored.method);
            if (await method.validate(stored)) {
                log.info(`Stored auth valid: method=${stored.method}`);
                try {
                    return method.toCredentials(stored);
                }
                catch (e) {
                    // Race: token expired between validate() and toCredentials() — fall through
                    if (!(e instanceof AuthExpiredError))
                        throw e;
                    log.warn('Token expired between validate and toCredentials');
                }
            }
            else {
                log.warn(`Stored auth invalid: method=${stored.method}`);
            }
            // Try refresh
            const refreshed = await method.refresh(stored, config);
            if (refreshed && (await method.validate(refreshed))) {
                log.info('Token refresh succeeded');
                await this.storage.set(domain, refreshed);
                try {
                    return method.toCredentials(refreshed);
                }
                catch (e) {
                    // Fall through to fresh browser auth
                    if (!(e instanceof AuthExpiredError))
                        throw e;
                    log.warn('Refreshed token expired immediately');
                }
            }
            else {
                log.warn(refreshed ? 'Token refresh returned invalid auth' : 'Token refresh skipped or failed');
            }
        }
        else {
            log.info('No stored credentials found');
        }
        // Fresh auth
        const method = this.methodFor(config.method);
        try {
            log.info(`Launching browser auth to ${config.entryUrl || config.domain}`);
            let newAuth = await method.authenticate(config);
            // OAuth: browser only captures partial audiences from localStorage.
            // Use refresh token to get tokens for ALL configured audiences.
            if (newAuth.method === 'oauth') {
                const oauthAuth = newAuth;
                const audiences = oauthAuth.tokens.map(t => t.audience).join(', ');
                log.info(`Browser auth captured ${oauthAuth.tokens.length} token(s) for: ${audiences}`);
                if (oauthAuth.refreshToken?.secret) {
                    const enriched = await this.oauthMethod.refresh(oauthAuth, config);
                    if (enriched && enriched.tokens.length > oauthAuth.tokens.length) {
                        const enrichedAudiences = enriched.tokens.map(t => t.audience).join(', ');
                        log.info(`Refresh enriched to ${enriched.tokens.length} token(s) for: ${enrichedAudiences}`);
                        newAuth = enriched;
                    }
                }
            }
            await this.storage.set(domain, newAuth);
            return method.toCredentials(newAuth);
        }
        catch (error) {
            log.error(`Browser auth failed: ${extractErrorMessage(error)}`);
            const authError = error instanceof AuthError
                ? error
                : new AuthError(`Failed to get credentials for ${domain}: ${extractErrorMessage(error)}`, 'AUTH_FAILED', domain, { cause: error });
            authError.flowSummary = log.getSummary();
            throw authError;
        }
    }
    /**
     * Get credentials for a specific token audience (OAuth only).
     * Used when a provider has multiple token audiences (e.g., Teams vs Graph).
     *
     * Delegates lifecycle (validate → refresh → browser auth) to getCredentials(),
     * then extracts the audience-specific token. If the audience token is missing
     * after fresh auth, forces full re-auth once.
     */
    async getCredentialsForAudience(domain, audience) {
        this.requireConfig(domain);
        log.clearSummary();
        // Ensure we have valid stored OAuth auth (handles full lifecycle)
        await this.getCredentials(domain);
        log.info('Base credentials obtained');
        // Extract the specific audience token
        const stored = await this.storage.get(domain);
        if (stored?.method === 'oauth') {
            const token = this.oauthMethod.getTokenForAudience(stored, audience);
            if (token)
                return token;
            const storedAudiences = stored.tokens.map(t => t.audience).join(', ');
            log.warn(`Audience token "${audience}" not found among ${stored.tokens.length} stored token(s): ${storedAudiences}`);
        }
        else {
            log.warn(`Expected OAuth auth but got: ${stored?.method ?? 'nothing'}`);
        }
        // Audience token missing — force full re-auth (browser) and try once more
        log.info('Forcing re-auth for missing audience token');
        await this.forceReauth(domain);
        const refreshed = await this.storage.get(domain);
        if (refreshed?.method === 'oauth') {
            const token = this.oauthMethod.getTokenForAudience(refreshed, audience);
            if (token)
                return token;
            const capturedAudiences = refreshed.tokens.map(t => t.audience).join(', ');
            log.warn(`After re-auth: "${audience}" still not captured. Have: ${capturedAudiences}`);
        }
        else {
            log.error('No OAuth auth after re-auth');
        }
        const error = new AuthError(`Token for audience "${audience}" not obtained after authentication for ${domain}`, 'AUTH_FAILED', domain);
        error.flowSummary = log.getSummary();
        throw error;
    }
    /**
     * Get auth status for a provider without triggering authentication
     */
    async getStatus(domain) {
        const config = this.providers.get(domain);
        const stored = await this.storage.get(domain);
        if (!config && !stored) {
            return {
                domain,
                configured: false,
                valid: false,
                method: null,
                expiresAt: null,
                expiresInMinutes: null,
            };
        }
        if (!stored) {
            return {
                domain,
                configured: false,
                valid: false,
                method: config.method,
                expiresAt: null,
                expiresInMinutes: null,
            };
        }
        const method = this.methodFor(stored.method);
        const valid = await method.validate(stored);
        const expiresAt = method.getExpiresAt(stored);
        let expiresInMinutes = null;
        if (expiresAt) {
            const remaining = expiresAt.getTime() - Date.now();
            expiresInMinutes = Math.max(0, Math.round(remaining / 60000));
        }
        return {
            domain,
            configured: true,
            valid,
            method: stored.method,
            expiresAt,
            expiresInMinutes,
        };
    }
    /**
     * Set an API token for a provider
     * Used when provider requires API token and user provides it
     */
    async setApiToken(domain, token) {
        const auth = {
            method: 'api-token',
            token,
            updatedAt: new Date().toISOString(),
        };
        await this.storage.set(domain, auth);
    }
    /**
     * Force re-authentication for a provider.
     *
     * Deduplicates concurrent calls per domain.
     *
     * For api-token providers, throws without deleting stored auth —
     * PATs can't be auto-replaced, so deleting them forces the user
     * to re-add manually.
     */
    async forceReauth(domain) {
        const inflight = this.pendingReauth.get(domain);
        if (inflight)
            return inflight;
        const promise = this._forceReauth(domain).finally(() => this.pendingReauth.delete(domain));
        this.pendingReauth.set(domain, promise);
        return promise;
    }
    async _forceReauth(domain) {
        const config = this.requireConfig(domain);
        // api-token providers: throw without deleting — PAT can't be auto-replaced
        if (config.method === 'api-token') {
            const instructions = `PAT required for ${config.domain}. Store one with: sap_add_pat(domain="${config.domain}", token="YOUR_TOKEN")`;
            const extra = config.setupInstructions ? `\n${config.setupInstructions}` : '';
            throw new ApiTokenRequiredError(config.domain, instructions + extra);
        }
        await this.storage.delete(domain);
        return await this._getCredentials(domain);
    }
    /**
     * Clear auth for a specific provider
     */
    async clearAuth(domain) {
        await this.storage.delete(domain);
    }
    /**
     * Clear all stored auth data
     */
    async clearAll() {
        await this.storage.clearAll();
    }
    /**
     * List all providers (registered + stored) with their status
     */
    async listProviders() {
        const registeredDomains = this.listRegisteredDomains();
        const storedDomains = await this.storage.listProviders();
        const allDomains = [...new Set([...registeredDomains, ...storedDomains])];
        return Promise.all(allDomains.map(d => this.getStatus(d)));
    }
    /**
     * Get the storage file path (for debugging)
     */
    getStoragePath() {
        return this.storage.getAuthFilePath();
    }
    // ============================================================================
    // Private helpers
    // ============================================================================
    /**
     * Resolve method instance by auth type
     */
    methodFor(type) {
        switch (type) {
            case 'sap-sso':
                return this.sapSsoMethod;
            case 'oauth':
                return this.oauthMethod;
            case 'api-token':
                return this.apiTokenMethod;
        }
    }
    /**
     * Get provider config or throw
     */
    requireConfig(domain) {
        const config = this.providers.get(domain);
        if (!config) {
            throw new AuthNotConfiguredError(domain, `Unknown provider: ${domain}. Available: ${this.listRegisteredDomains().join(', ')}`);
        }
        return config;
    }
}
//# sourceMappingURL=auth-manager.js.map