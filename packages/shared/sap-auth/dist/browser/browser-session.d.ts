/**
 * Browser session management
 * Handles browser lifecycle, process cleanup, and state management
 */
import { Browser, Page } from 'puppeteer';
import { type BrowserMode } from './browser-launcher.js';
/**
 * Browser session configuration
 */
export interface BrowserSessionConfig {
    userEmail?: string;
    inPrivate: boolean;
    visibleMode: boolean;
    forceVisible: boolean;
    forceManualFallback: boolean;
    silentFailure: boolean;
    userDataDir?: string;
}
/**
 * Build session config from environment
 */
export declare function buildSessionConfig(): BrowserSessionConfig;
/**
 * Browser session state
 */
export interface BrowserSessionState {
    browser: Browser | null;
    page: Page | null;
    currentMode: BrowserMode | null;
    isRemote: boolean;
    isInitialized: boolean;
}
/**
 * Create initial session state
 */
export declare function createSessionState(): BrowserSessionState;
/**
 * Safe browser close method - prevents hanging Chrome instances
 */
export declare function safeBrowserClose(state: BrowserSessionState): Promise<BrowserSessionState>;
/**
 * Launch browser with proper mode handling
 */
export declare function launchBrowserSession(state: BrowserSessionState, headless: boolean, config: BrowserSessionConfig): Promise<BrowserSessionState>;
/**
 * Check if navigation error should trigger fallback to visible mode
 */
export declare function shouldFallbackToVisible(errorMessage: string): boolean;
/**
 * Navigate to URL with timeout handling
 */
export declare function navigateWithTimeout(page: Page, url: string, timeout?: number): Promise<void>;
//# sourceMappingURL=browser-session.d.ts.map