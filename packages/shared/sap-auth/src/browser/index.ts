/**
 * Browser module exports
 * Re-exports the BrowserAuthenticator and related utilities
 */

export { BrowserAuthenticator } from './authenticator.js';

// Re-export types and utilities that may be useful for consumers
export type { BrowserMode, BrowserLaunchResult } from './browser-launcher.js';
export type { ChromeProcess } from './process-manager.js';
export type { AuthAttemptResult } from './sso-automation.js';
export type { MsalData } from './token-extraction.js';
export type { BrowserSessionConfig, BrowserSessionState } from './browser-session.js';

// Browser-based HTTP request (fallback for unknown providers)
export { makeBrowserRequest } from './browser-request.js';
export type { BrowserRequestOptions, BrowserRequestResponse } from './browser-request.js';

// Re-export utility functions for advanced usage
export { isTeamsUrl, isLoginUrl } from './auth-flows.js';
