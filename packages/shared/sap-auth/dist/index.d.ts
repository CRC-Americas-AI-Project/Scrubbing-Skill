/**
 * SAP Auth - Shared authentication package for SAP MCP servers
 *
 * Usage:
 *   import { createAuthClient } from 'sap-auth';
 *
 *   const client = createAuthClient({ domain: 'wiki.one.int.sap', method: 'sap-sso' });
 *   const headers = await client.getHeaders();
 */
export { AuthManager } from './auth-manager.js';
export { createAuthClient } from './auth-client.js';
export type { AuthClient, AuthFetchOptions } from './auth-client.js';
export type { AuthMethodType, CredentialType, Credentials, ProviderConfig, StoredCookie, AuthStatus, } from './types.js';
export { AuthError, AuthExpiredError, AuthBrowserError, ApiTokenRequiredError, } from './types.js';
export { formatAuthError, isAuthError, credentialsToHeaders, defaultAuthErrorOptions, } from './mcp-helpers.js';
export { makeBrowserRequest } from './browser/index.js';
export { buildUserAgent, buildSecChPlatform } from './utils/index.js';
//# sourceMappingURL=index.d.ts.map