/**
 * Browser-based authenticator using Puppeteer
 *
 * Thin wrapper around `runHybridBrowserFlow` that provides the appropriate
 * `onAuthenticated` callback for each auth type (SAP SSO vs OAuth).
 */
import { createLogger } from 'mcp-logger';
const log = createLogger('sap-auth', 'authenticator');
import { runHybridBrowserFlow } from './hybrid-flow.js';
import { isTeamsUrl, isLoginUrl, extractCookies, extractTeamsCookies, } from './auth-flows.js';
import { waitForTokens, extractMsalRefreshToken } from './token-extraction.js';
/**
 * Browser authenticator for SAP systems
 * Hybrid mode: starts headless, switches to visible if user interaction needed
 */
export class BrowserAuthenticator {
    /**
     * No-op — the hybrid flow manages its own browser lifecycle.
     * Kept for backward compatibility.
     */
    async close() { }
    /**
     * Authenticate with SAP SSO and return cookies
     */
    async authenticateSapSso(entryUrl, domain) {
        domain = this.resolveDomain(entryUrl, domain, 'wiki.one.int.sap');
        this.logAuthStart(domain, entryUrl);
        return runHybridBrowserFlow({
            entryUrl,
            domain,
            onAuthenticated: (page) => extractCookies(page, domain),
        });
    }
    /**
     * Authenticate with OAuth and extract tokens
     */
    async authenticateOAuth(entryUrl, domain, targetAudiences) {
        const isTeams = isTeamsUrl(entryUrl);
        domain = this.resolveDomain(entryUrl, domain, 'teams.microsoft.com');
        this.logAuthStart(isTeams ? 'Microsoft Teams' : domain, entryUrl);
        return runHybridBrowserFlow({
            entryUrl,
            domain,
            isTeams,
            isAuthenticated: (url) => isTeams
                ? isTeamsUrl(url) && !isLoginUrl(url)
                : url.includes(domain) && !isLoginUrl(url),
            onAuthenticated: async (page) => {
                const cookies = isTeams
                    ? await extractTeamsCookies(page)
                    : await extractCookies(page, domain);
                log.info(`Retrieved ${cookies.length} cookies`);
                const tokens = await waitForTokens(page, targetAudiences);
                log.info(`Extracted ${tokens.length} token(s)`);
                const msalData = await extractMsalRefreshToken(page);
                if (msalData.refreshToken) {
                    log.info(`Extracted refresh token for client ${msalData.refreshToken.clientId}`);
                }
                if (msalData.account) {
                    log.info(`Extracted account info for ${msalData.account.username}`);
                }
                return {
                    cookies,
                    tokens,
                    refreshToken: msalData.refreshToken,
                    account: msalData.account,
                };
            },
        });
    }
    // ============================================================================
    // Private helpers
    // ============================================================================
    resolveDomain(entryUrl, domain, fallback) {
        if (domain)
            return domain;
        try {
            return new URL(entryUrl).hostname;
        }
        catch {
            return fallback;
        }
    }
    logAuthStart(target, entryUrl) {
        log.info(`Authenticating with ${target}...`);
        log.info(`Entry URL: ${entryUrl}`);
    }
}
//# sourceMappingURL=authenticator.js.map