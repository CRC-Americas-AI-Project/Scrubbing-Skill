/**
 * Browser module exports
 * Re-exports the BrowserAuthenticator and related utilities
 */
export { BrowserAuthenticator } from './authenticator.js';
// Browser-based HTTP request (fallback for unknown providers)
export { makeBrowserRequest } from './browser-request.js';
// Re-export utility functions for advanced usage
export { isTeamsUrl, isLoginUrl } from './auth-flows.js';
//# sourceMappingURL=index.js.map