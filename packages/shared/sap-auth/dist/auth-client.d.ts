/**
 * Auth client factory — lightweight facade over AuthManager
 *
 * Provides a simple interface for MCPs to get auth headers/tokens
 * without importing and wiring AuthManager + credentialsToHeaders directly.
 *
 * Each MCP passes its ProviderConfig inline — no registry lookup.
 *
 * Contract:
 * - getHeaders(), getToken(), getTokenForAudience() always return valid credentials.
 * - fetch() makes authenticated HTTP requests with automatic retry on auth failure.
 * - The auth package handles the full lifecycle (validate → refresh → browser auth)
 *   transparently.
 */
import type { ProviderConfig } from './types.js';
/**
 * Options for authClient.fetch() — extends RequestInit with auth-specific fields.
 */
export interface AuthFetchOptions extends RequestInit {
    /** OAuth audience to use for this request (default: primary audience) */
    audience?: string;
}
export interface AuthClient {
    getHeaders(): Promise<Record<string, string>>;
    getToken(): Promise<string>;
    getTokenForAudience(audience: string): Promise<string>;
    /**
     * Authenticated fetch — injects auth headers, detects server-side auth failure,
     * retries once with fresh credentials. MCPs should use this instead of
     * global fetch() + manual token management.
     */
    fetch(url: string | URL, init?: AuthFetchOptions): Promise<Response>;
    readonly domain: string;
}
/**
 * Create an auth client from a provider config.
 * Registers the provider with AuthManager so credentials can be resolved.
 *
 * @example
 *   const client = createAuthClient({ domain: 'wiki.one.int.sap', method: 'sap-sso' });
 *   const response = await client.fetch('https://wiki.one.int.sap/rest/api/search?cql=...');
 */
export declare function createAuthClient(config: ProviderConfig): AuthClient;
//# sourceMappingURL=auth-client.d.ts.map