/**
 * Debug snapshot utilities
 * Saves screenshots and HTML dumps when SSO authentication fails,
 * providing diagnostic artifacts for troubleshooting.
 */
import type { Page } from 'puppeteer';
/**
 * Save a debug snapshot (PNG screenshot + HTML dump) of the current page.
 *
 * This is a best-effort diagnostic helper -- it never throws so it can be
 * safely called from any error/fallback path without disrupting the flow.
 */
export declare function saveDebugSnapshot(page: Page, label: string): Promise<void>;
//# sourceMappingURL=debug-snapshot.d.ts.map