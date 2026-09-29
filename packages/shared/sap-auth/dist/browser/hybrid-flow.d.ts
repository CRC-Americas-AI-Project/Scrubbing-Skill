/**
 * Unified hybrid browser flow
 *
 * Single source of truth for the headless → SSO automation → visible fallback
 * pattern used by both authentication and browser-based requests.
 *
 * Callers provide an `onAuthenticated` callback that runs once the browser
 * has reached an authenticated state on the target domain.
 */
import type { Page } from 'puppeteer';
export interface HybridFlowOptions<T> {
    /** URL to navigate to initially (triggers SSO redirects). */
    entryUrl: string;
    /** Domain used for "are we authenticated?" checks. */
    domain: string;
    /**
     * Custom predicate: given the current URL, are we authenticated?
     * Defaults to: `url.includes(domain) && !isLoginUrl(url)`
     */
    isAuthenticated?: (url: string) => boolean;
    /** Pass `true` when authenticating against Teams (affects `waitForAuthenticationCompletion`). */
    isTeams?: boolean;
    /** Persistent Chrome profile directory. When set, cookies survive across browser launches. */
    userDataDir?: string;
    /**
     * Called once the browser is on an authenticated page.
     * The browser is closed **after** this callback returns.
     */
    onAuthenticated: (page: Page) => Promise<T>;
}
/**
 * Run the hybrid browser flow:
 *
 * 1. Launch headless browser
 * 2. Navigate to `entryUrl`
 * 3. If already authenticated → call `onAuthenticated(page)`
 * 4. Otherwise → try SSO automation (up to 3 retries)
 * 5. If SSO fails → switch to visible browser, wait for user
 * 6. Call `onAuthenticated(page)`, close browser, return result
 */
export declare function runHybridBrowserFlow<T>(options: HybridFlowOptions<T>): Promise<T>;
//# sourceMappingURL=hybrid-flow.d.ts.map