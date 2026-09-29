/**
 * Microsoft device code flow for OAuth authentication.
 *
 * Used as fallback when browser token extraction fails (e.g., teams.cloud.microsoft
 * uses encrypted MSAL cache that Puppeteer cannot read).
 *
 * Flow:
 *  1. POST to /devicecode endpoint → get user_code + verification_uri
 *  2. Print code to stdout (visible in Claude conversation)
 *  3. Poll /token endpoint until user completes login or timeout
 */
import type { StoredToken, StoredRefreshToken } from '../types.js';
export interface DeviceCodeResult {
    tokens: StoredToken[];
    refreshToken?: StoredRefreshToken;
}
/**
 * Run the device code flow for the given audiences.
 * Prints the user code to stdout and polls until the user completes login.
 *
 * Uses only Graph scope for the initial device code request to avoid the
 * "static scope limit exceeded" error — the refresh token can later be used
 * to get tokens for other audiences (Teams, ic3, etc.).
 */
export declare function runDeviceCodeFlow(audiences: string[]): Promise<DeviceCodeResult>;
//# sourceMappingURL=device-code.d.ts.map