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

import { AuthManager } from './auth-manager.js';
import { credentialsToHeaders } from './mcp-helpers.js';
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
 * Merge user-provided headers with auth headers.
 * Auth headers go first; user headers can override.
 */
function mergeHeaders(
  existing: HeadersInit | undefined,
  auth: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  if (existing) {
    if (existing instanceof Headers) {
      existing.forEach((v, k) => { base[k] = v; });
    } else if (Array.isArray(existing)) {
      existing.forEach(([k, v]) => { base[k] = v; });
    } else {
      Object.assign(base, existing);
    }
  }
  return { ...auth, ...base };
}

/**
 * Create an auth client from a provider config.
 * Registers the provider with AuthManager so credentials can be resolved.
 *
 * @example
 *   const client = createAuthClient({ domain: 'wiki.one.int.sap', method: 'sap-sso' });
 *   const response = await client.fetch('https://wiki.one.int.sap/rest/api/search?cql=...');
 */
export function createAuthClient(config: ProviderConfig): AuthClient {
  const auth = AuthManager.getInstance();
  auth.registerProvider(config);

  /** Get auth headers, optionally for a specific audience */
  async function getAuthHeaders(audience?: string): Promise<Record<string, string>> {
    const creds = audience
      ? await auth.getCredentialsForAudience(config.domain, audience)
      : await auth.getCredentials(config.domain);
    return credentialsToHeaders(creds);
  }

  /** Force re-auth and return fresh headers */
  async function forceReauth(audience?: string): Promise<Record<string, string>> {
    await auth.forceReauth(config.domain);
    return getAuthHeaders(audience);
  }

  return {
    domain: config.domain,

    async getHeaders() {
      return getAuthHeaders();
    },

    async getToken() {
      const creds = await auth.getCredentials(config.domain);
      return creds.value;
    },

    async getTokenForAudience(audience: string) {
      const creds = await auth.getCredentialsForAudience(config.domain, audience);
      return creds.value;
    },

    async fetch(url: string | URL, init?: AuthFetchOptions): Promise<Response> {
      const { audience, ...fetchInit } = init ?? {};

      // Get auth headers and make the request
      const headers = await getAuthHeaders(audience);
      const merged = mergeHeaders(fetchInit.headers, headers);
      const response = await globalThis.fetch(url, { ...fetchInit, headers: merged });

      // Check for auth failure (clone so isAuthFailure can read body without consuming it)
      const isFailure = config.isAuthFailure
        ? await config.isAuthFailure(response.clone())
        : response.status === 401;

      if (!isFailure) return response;

      // Auth failure detected — force reauth and retry once
      const freshHeaders = await forceReauth(audience);
      const retryMerged = mergeHeaders(fetchInit.headers, freshHeaders);
      return globalThis.fetch(url, { ...fetchInit, headers: retryMerged });
    },
  };
}
