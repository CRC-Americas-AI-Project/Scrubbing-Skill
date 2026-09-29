/**
 * SAP Auth - Shared authentication package for SAP MCP servers
 *
 * Usage:
 *   import { createAuthClient } from 'sap-auth';
 *
 *   const client = createAuthClient({ domain: 'wiki.one.int.sap', method: 'sap-sso' });
 *   const headers = await client.getHeaders();
 */
// Main entry points
export { AuthManager } from './auth-manager.js';
export { createAuthClient } from './auth-client.js';
// Errors
export { AuthError, AuthExpiredError, AuthBrowserError, ApiTokenRequiredError, } from './types.js';
// MCP auth helpers (for consistent auth error handling)
export { formatAuthError, isAuthError, credentialsToHeaders, defaultAuthErrorOptions, } from './mcp-helpers.js';
// Browser request (for sap_make_request)
export { makeBrowserRequest } from './browser/index.js';
// HTTP utilities (for cross-platform compatibility)
export { buildUserAgent, buildSecChPlatform } from './utils/index.js';
//# sourceMappingURL=index.js.map