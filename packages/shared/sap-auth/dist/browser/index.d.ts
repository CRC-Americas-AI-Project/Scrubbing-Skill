/**
 * Browser module exports
 * Re-exports the BrowserAuthenticator and related utilities
 */
export { BrowserAuthenticator } from './authenticator.js';
export type { BrowserMode, BrowserLaunchResult } from './browser-launcher.js';
export type { ChromeProcess } from './process-manager.js';
export type { AuthAttemptResult } from './sso-automation.js';
export type { MsalData } from './token-extraction.js';
export type { BrowserSessionConfig, BrowserSessionState } from './browser-session.js';
export { makeBrowserRequest } from './browser-request.js';
export type { BrowserRequestOptions, BrowserRequestResponse } from './browser-request.js';
export { isTeamsUrl, isLoginUrl } from './auth-flows.js';
//# sourceMappingURL=index.d.ts.map