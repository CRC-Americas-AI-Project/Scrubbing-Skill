/**
 * Authentication flow utilities
 * Handles SAP SSO, OAuth flows, and cookie extraction
 */
import { createLogger } from 'mcp-logger';
import { extractErrorMessage, delay } from 'mcp-utils';
const log = createLogger('sap-auth', 'auth-flows');
// ============================================================================
// Constants
// ============================================================================
const MAX_AUTH_ATTEMPTS = 72; // 6 minutes at 5 second intervals
const POLL_INTERVAL_MS = 5000;
const PROGRESS_LOG_INTERVAL = 6;
const CONFIRMATION_DELAY_MS = 3000;
const AUTHENTICATOR_CHECK_DELAY_MS = 2000;
const PROMPT_CLICK_DELAY_MS = 2000;
/**
 * Known SSO/IDP domains that handle authentication redirects.
 * Add new SSO providers here — all SSO detection uses this list.
 */
export const SSO_DOMAINS = ['microsoftonline.com', 'accounts.sap.com'];
/**
 * Check if URL is on a known SSO domain
 */
export function isSsoDomain(url) {
    return SSO_DOMAINS.some((d) => url.includes(d));
}
/**
 * Teams URL patterns
 */
const TEAMS_PATTERNS = [
    'teams.microsoft.com',
    'teams.cloud.microsoft',
    'teams.live.com',
    'teams.office.com',
];
/**
 * Teams domains for cookie extraction
 */
export const TEAMS_COOKIE_DOMAINS = [
    'https://teams.microsoft.com',
    'https://teams.cloud.microsoft',
    'https://teams.live.com',
    'https://teams.office.com',
    'https://login.microsoftonline.com',
    'https://login.live.com',
];
/**
 * Check if URL is a Teams URL
 */
export function isTeamsUrl(url) {
    return TEAMS_PATTERNS.some((pattern) => url.includes(pattern));
}
/**
 * Check if URL is a login page
 */
export function isLoginUrl(url) {
    return url.includes('login') || isSsoDomain(url);
}
/**
 * Extract cookies from browser page
 */
export async function extractCookies(page, domain) {
    let cookies = await page.cookies();
    // Fallback: if page.cookies() returns nothing, the session cookie may have
    // been set during a cross-origin SAML POST (Network.getCookies URL-filter
    // misses it). Use Network.getAllCookies via CDP and filter by target domain.
    if (cookies.length === 0) {
        try {
            const client = await page.createCDPSession();
            const { cookies: allCookies } = await client.send('Network.getAllCookies');
            await client.detach();
            cookies = allCookies.filter((c) => {
                const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
                return domain === d || domain.endsWith('.' + d);
            });
            if (cookies.length > 0) {
                log.info(`Recovered ${cookies.length} cookies via Network.getAllCookies fallback`);
            }
        }
        catch (cdpErr) {
            log.warn(`CDP getAllCookies fallback failed: ${extractErrorMessage(cdpErr)}`);
        }
    }
    return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
    }));
}
/**
 * Extract cookies from multiple Teams domains
 */
export async function extractTeamsCookies(page) {
    const cookies = [];
    for (const teamsDomain of TEAMS_COOKIE_DOMAINS) {
        try {
            const domainCookies = await page.cookies(teamsDomain);
            for (const c of domainCookies) {
                cookies.push({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path,
                    expires: c.expires,
                    httpOnly: c.httpOnly,
                    secure: c.secure,
                    sameSite: c.sameSite,
                });
            }
        }
        catch {
            // Some domains may not have cookies
        }
    }
    // Also get current page cookies
    let pageCookies = await page.cookies();
    // CDP fallback when URL-filtered page.cookies() misses cross-origin SAML cookies.
    if (pageCookies.length === 0) {
        try {
            const client = await page.createCDPSession();
            const { cookies: allCookies } = await client.send('Network.getAllCookies');
            await client.detach();
            pageCookies = allCookies;
            if (pageCookies.length > 0) {
                log.info(`Recovered ${pageCookies.length} Teams cookies via Network.getAllCookies fallback`);
            }
        }
        catch (cdpErr) {
            log.warn(`CDP getAllCookies fallback failed: ${extractErrorMessage(cdpErr)}`);
        }
    }
    for (const c of pageCookies) {
        cookies.push({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
        });
    }
    // Remove duplicates by name+domain
    const seen = new Set();
    return cookies.filter((c) => {
        const key = `${c.name}:${c.domain}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/**
 * Check for Microsoft Authenticator number matching display
 */
export async function checkForAuthenticatorNumber(page) {
    try {
        await delay(AUTHENTICATOR_CHECK_DELAY_MS);
        // Look for the specific ID
        const numberElement = await page.$('#idRemoteNGC_DisplaySign');
        if (numberElement) {
            const numberText = await numberElement.evaluate((el) => el.textContent?.trim() || '');
            if (numberText && /^\d+$/.test(numberText)) {
                return numberText;
            }
        }
        // Also check for other common selectors
        const alternativeSelectors = [
            '.ms-TextField-field',
            '.ms-Label',
            '[data-testid*="number"]',
            '.number-display',
            '.auth-number',
        ];
        for (const selector of alternativeSelectors) {
            try {
                const elements = await page.$$(selector);
                for (const element of elements) {
                    const text = await element.evaluate((el) => el.textContent?.trim() || '');
                    if (text && /^\d{2,3}$/.test(text)) {
                        return text;
                    }
                }
            }
            catch {
                // Continue
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Try CSS selectors in order, click the first match. Returns true if clicked.
 */
export async function tryClickFirst(page, selectors) {
    for (const selector of selectors) {
        try {
            const el = await page.$(selector);
            if (el) {
                log.info(`Auto-clicking: ${selector}`);
                await el.click();
                await delay(PROMPT_CLICK_DELAY_MS);
                return true;
            }
        }
        catch {
            // Continue to next selector
        }
    }
    return false;
}
/**
 * Handle automatic prompts (Stay signed in, etc.)
 */
export async function handleAutomaticPrompts(page) {
    await tryClickFirst(page, [
        '#idSIButton9', // Stay signed in - Yes
        'input[value="Yes"]',
        'input[value="Accept"]',
    ]);
}
/**
 * Wait for authentication to complete
 */
export async function waitForAuthenticationCompletion(page, domain, isTeams = false) {
    log.info('Waiting for authentication to complete...');
    for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt++) {
        await delay(POLL_INTERVAL_MS);
        const currentUrl = page.url();
        const isOnTarget = isTeams
            ? isTeamsUrl(currentUrl) && !isLoginUrl(currentUrl)
            : currentUrl.includes(domain) && !isLoginUrl(currentUrl);
        if (isOnTarget) {
            // Confirm no redirect
            await delay(CONFIRMATION_DELAY_MS);
            const confirmedUrl = page.url();
            const stillOnTarget = isTeams
                ? isTeamsUrl(confirmedUrl) && !isLoginUrl(confirmedUrl)
                : confirmedUrl.includes(domain) && !isLoginUrl(confirmedUrl);
            if (stillOnTarget) {
                log.info('Authentication completed');
                return true;
            }
        }
        if (attempt % PROGRESS_LOG_INTERVAL === 0) {
            log.info(`Waiting for authentication... (${Math.round((attempt * POLL_INTERVAL_MS / 1000) / 60)}m)`);
        }
    }
    log.warn('Authentication timeout after 6 minutes');
    return false;
}
/**
 * Show authentication alert to user
 */
export async function showAuthAlert(page) {
    await page.evaluate(() => {
        alert('Please authenticate to use the SAP MCP servers.\n\nComplete the login process in this browser window.');
    });
}
//# sourceMappingURL=auth-flows.js.map