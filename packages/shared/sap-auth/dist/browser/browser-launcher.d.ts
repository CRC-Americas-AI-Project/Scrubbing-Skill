/**
 * Browser launcher utilities
 * Handles Puppeteer browser setup, configuration, and lifecycle
 */
import { Browser, Page } from 'puppeteer';
/**
 * Browser mode type
 */
export type BrowserMode = 'headless' | 'visible';
/**
 * Browser launch result
 */
export interface BrowserLaunchResult {
    browser: Browser;
    page: Page;
    mode: BrowserMode;
    isRemote: boolean;
}
/**
 * Resolve browser executable path.
 *
 * Cascade: BROWSER_PATH env → Edge (Windows) / Chrome (other) → Chrome (Windows) / Edge (other) → PATH lookup.
 * On Windows, Edge is preferred because it uses the system certificate store and Kerberos/NTLM
 * credentials shared with the OS, which is required for SAP SSO.
 */
export declare function resolveBrowserPath(): string | undefined;
/**
 * Launch a Puppeteer browser instance
 */
export declare function launchBrowser(headless: boolean, inPrivate: boolean, forceVisible: boolean, userDataDir?: string): Promise<BrowserLaunchResult>;
/**
 * Configure default page settings
 */
export declare function configurePageDefaults(page: Page, userAgent: string, inPrivate: boolean): Promise<void>;
//# sourceMappingURL=browser-launcher.d.ts.map