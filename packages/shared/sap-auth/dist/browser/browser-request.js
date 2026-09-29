/**
 * Browser-based HTTP request
 *
 * Makes authenticated requests via the hybrid browser flow. Used as the
 * fallback path when a URL doesn't match any known provider — the browser's
 * system credentials (Kerberos/keychain) and SSO automation handle
 * authentication automatically.
 *
 * Strategy:
 *  1. Navigate to the URL's origin (triggers SSO / Kerberos).
 *  2. Extract a CSRF token from the authenticated page (best-effort).
 *  3. Clear the heavy SPA DOM to free the JS event loop.
 *  4. Run fetch() from the page context — uses session cookies + CSRF.
 *  5. If the response is an OAuth/SAML redirect (origin-only auth wasn't
 *     enough for this path), complete auth via page.goto(targetUrl), then
 *     retry fetch().
 *
 * We use fetch() instead of page.goto() for the target URL because some
 * servers (e.g. ServiceNow REST APIs) respond with a WWW-Authenticate:
 * Basic challenge that Chrome can't handle — it throws
 * ERR_INVALID_AUTH_CREDENTIALS in headless or shows a native auth dialog
 * in visible mode. fetch() with credentials: 'include' avoids this.
 */
import { join } from 'path';
import { createLogger } from 'mcp-logger';
import { runHybridBrowserFlow } from './hybrid-flow.js';
import { SAP_MCP_DIR } from '../storage.js';
const log = createLogger('sap-auth', 'browser-request');
const CSRF_EXTRACT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const GOTO_TIMEOUT_MS = 60_000;
/**
 * Make an HTTP request via a browser.
 *
 * Navigates to the URL's origin (triggering SSO), then runs fetch()
 * from the authenticated page context.
 */
export async function makeBrowserRequest(url, options = {}) {
    const origin = new URL(url).origin;
    const domain = new URL(url).hostname;
    const method = (options.method || 'GET').toUpperCase();
    const binary = options.binary === true;
    return runHybridBrowserFlow({
        entryUrl: origin,
        domain,
        userDataDir: join(SAP_MCP_DIR, 'browser-profile'),
        onAuthenticated: async (page) => {
            log.info(`[browser-request] fetch() ${method} ${url}${binary ? ' (binary)' : ''}`);
            const csrfToken = await extractCsrfToken(page);
            const headers = { ...(options.headers || {}) };
            if (csrfToken) {
                headers['X-UserToken'] = csrfToken;
            }
            await clearPage(page);
            let result = await browserFetch(page, url, method, headers, options.body, binary);
            // Some sites (e.g. me.sap.com) require path-specific OAuth that
            // origin-only auth doesn't cover. Detect the redirect and complete
            // auth via page.goto(), then retry. (Auth-redirect bodies are always
            // small HTML, so this applies in binary mode too — a base64 body whose
            // decoded head is an auth page is still worth completing.)
            if (result.ok && isAuthRedirect(binary ? decodeHead(result.body) : result.body)) {
                log.info('[browser-request] OAuth/SAML redirect detected, completing auth via goto()');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: GOTO_TIMEOUT_MS });
                // SPA routers may trigger additional navigations after networkidle2,
                // destroying the execution context. Retry clearPage + fetch until stable.
                result = await retryAfterNavigation(page, async () => {
                    await clearPage(page);
                    return browserFetch(page, url, method, headers, options.body, binary);
                });
            }
            // Binary mode: skip the SPA-shell text heuristic (it only applies to HTML)
            // and return the base64 body directly.
            if (binary) {
                if (!result.ok) {
                    throw new Error(`fetch() failed inside browser: ${result.error}. Browser was at: ${result.pageUrl}`);
                }
                return {
                    status: result.status,
                    statusText: result.statusText,
                    headers: result.headers,
                    body: result.body,
                    bodyEncoding: 'base64',
                };
            }
            // SPA shell: fetch() returned a tiny HTML bootstrap with <script> tags
            // but no visible content. Navigate the browser to render the SPA, then
            // extract deep text (including Shadow DOM).
            const ct = result.ok ? (result.headers['content-type'] ?? '') : '';
            if (result.ok && isSpaShell(result.body, ct)) {
                log.info('[browser-request] SPA shell detected, navigating for rendered content');
                // Open a fresh tab to avoid stale state from clearPage() which
                // prevents iframes from loading on the original page.
                const spaPage = await page.browser().newPage();
                try {
                    // Tall viewport puts all content "above the fold", triggering
                    // intersection-observer lazy loading without scrolling.
                    await spaPage.setViewport({ width: 1920, height: 20_000 });
                    await spaPage.goto(url, { waitUntil: 'networkidle2', timeout: GOTO_TIMEOUT_MS });
                    await waitForSpaRender(spaPage);
                    const text = await getDeepText(spaPage);
                    return { status: 200, statusText: 'OK', headers: {}, body: text };
                }
                finally {
                    await spaPage.close().catch(() => { });
                }
            }
            if (!result.ok) {
                throw new Error(`fetch() failed inside browser: ${result.error}. Browser was at: ${result.pageUrl}`);
            }
            return {
                status: result.status,
                statusText: result.statusText,
                headers: result.headers,
                body: result.body,
            };
        },
    });
}
/** Clear the heavy SPA DOM — preserves cookies & origin but frees the JS event loop. */
async function clearPage(page) {
    await page.evaluate(() => {
        document.open();
        document.write('<html><body></body></html>');
        document.close();
    });
}
/**
 * Retry an async operation that may fail due to SPA navigation destroying
 * the execution context. Waits between retries for the page to settle.
 */
async function retryAfterNavigation(page, fn, maxRetries = 5, delayMs = 1_000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : '';
            if (attempt === maxRetries || !msg.includes('Execution context was destroyed'))
                throw err;
            log.info(`[browser-request] Page still navigating, retrying (${attempt}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw new Error('unreachable');
}
/** Run fetch() inside the browser page context with session cookies. */
async function browserFetch(page, url, method, headers, body, binary = false) {
    return page.evaluate(async (fetchUrl, fetchOpts, timeoutMs, wantBinary) => {
        const init = {
            method: fetchOpts.method,
            credentials: 'include',
            headers: fetchOpts.headers,
        };
        if (fetchOpts.body) {
            init.body = fetchOpts.body;
            init.headers['Content-Type'] =
                init.headers['Content-Type'] || 'application/json';
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        init.signal = controller.signal;
        try {
            const res = await fetch(fetchUrl, init);
            clearTimeout(timer);
            const hdrs = {};
            res.headers.forEach((v, k) => { hdrs[k] = v; });
            let respBody;
            if (wantBinary) {
                // Encode bytes → base64 in the page context (binary-safe, unlike text()).
                const buf = new Uint8Array(await res.arrayBuffer());
                let bin = '';
                const CHUNK = 0x8000;
                for (let i = 0; i < buf.length; i += CHUNK) {
                    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
                }
                respBody = btoa(bin);
            }
            else {
                respBody = await res.text();
            }
            return {
                ok: true,
                status: res.status,
                statusText: res.statusText,
                headers: hdrs,
                body: respBody,
            };
        }
        catch (err) {
            clearTimeout(timer);
            const msg = err instanceof Error && err.name === 'AbortError'
                ? `Request timed out after ${timeoutMs / 1000}s`
                : (err instanceof Error ? err.message : String(err));
            return {
                ok: false,
                error: msg,
                pageUrl: window.location.href,
            };
        }
    }, url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    }, REQUEST_TIMEOUT_MS, binary);
}
/** Best-effort decode of the head of a (possibly base64) body, for auth-redirect sniffing. */
function decodeHead(body) {
    try {
        return Buffer.from(body, 'base64').toString('latin1').slice(0, 2000);
    }
    catch {
        return body.slice(0, 2000);
    }
}
/**
 * Detect OAuth/SAML redirect pages returned instead of real content.
 * These are small HTML pages with JS that sets cookies and redirects to an
 * identity provider (IAS, Azure AD, etc.).
 */
export function isAuthRedirect(body) {
    if (body.length > 2000)
        return false;
    return (body.includes('oauth/authorize') ||
        body.includes('saml/login') ||
        body.includes('locationAfterLogin') ||
        (body.includes('location=') && body.includes('authentication')));
}
/**
 * Try to extract a CSRF token from the current page (best-effort).
 *
 * Currently covers:
 *  - ServiceNow: window.g_ck
 *  - Rails / Django / generic: <meta name="csrf-token">, <meta name="_csrf">,
 *    <meta name="X-CSRF-Token">
 *
 * Other CSRF patterns (e.g. SAP's fetch-based X-CSRF-Token header, cookie-to-header
 * tokens) are not handled — add them here as needed.
 *
 * Returns empty string if nothing is found or the page is unresponsive.
 */
async function extractCsrfToken(page) {
    try {
        return await Promise.race([
            page.evaluate(() => {
                if (window.g_ck)
                    return window.g_ck;
                const meta = document.querySelector('meta[name="csrf-token"]') ||
                    document.querySelector('meta[name="_csrf"]') ||
                    document.querySelector('meta[name="X-CSRF-Token"]');
                return meta?.getAttribute('content') || '';
            }),
            new Promise((resolve) => setTimeout(() => resolve(''), CSRF_EXTRACT_TIMEOUT_MS)),
        ]);
    }
    catch {
        return '';
    }
}
/**
 * Detect unrendered SPA shell: an HTML response whose visible text (after
 * stripping <script> and <style> blocks and HTML tags) is under 200 chars.
 * Non-HTML responses (JSON, XML, etc.) are never SPA shells.
 */
export function isSpaShell(body, contentType) {
    if (!contentType.includes('text/html'))
        return false;
    const noScripts = body.replace(/<script[\s\S]*?<\/script>/gi, '');
    const noStyle = noScripts.replace(/<style[\s\S]*?<\/style>/gi, '');
    const visibleText = noStyle.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return visibleText.length < 200;
}
/**
 * Recursively extract visible text from all frames (including cross-origin
 * iframes), traversing into Shadow DOM roots and skipping <script>/<style>.
 * Puppeteer can access cross-origin frames that page.evaluate() cannot.
 */
async function getDeepText(page) {
    const walkFn = () => {
        function walk(node) {
            let text = '';
            if (node.nodeType === 3)
                return node.textContent || '';
            if (node.nodeType === 1) {
                const el = node;
                const tag = el.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE')
                    return '';
                if (el.shadowRoot)
                    text += walk(el.shadowRoot);
                if (tag === 'A') {
                    const href = el.href;
                    const linkText = el.textContent?.trim();
                    if (href && linkText && !href.startsWith('javascript:'))
                        return ` [${linkText}](${href}) `;
                }
            }
            const children = node.childNodes;
            for (let i = 0; i < children.length; i++)
                text += walk(children[i]);
            return text;
        }
        return document.body ? walk(document.body).replace(/\s+/g, ' ').trim() : '';
    };
    const parts = [];
    for (const frame of page.frames()) {
        try {
            const text = await frame.evaluate(walkFn);
            if (text)
                parts.push(text);
        }
        catch {
            // Frame may have been detached or navigated away
        }
    }
    return parts.join(' ');
}
/**
 * Wait for SPA content to stabilize by polling getDeepText().
 * Considers the page stable after 3 consecutive readings of equal length
 * (polled every 1s). Gives up after `timeout` ms.
 */
async function waitForSpaRender(page, timeout = 30_000) {
    try {
        await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 15_000 });
    }
    catch {
        // Network didn't fully idle — continue to text stabilization
    }
    const deadline = Date.now() + timeout;
    let prevLen = 0;
    let stableCount = 0;
    while (Date.now() < deadline) {
        const len = await getDeepText(page).then((t) => t.length).catch(() => 0);
        if (len > 0 && len === prevLen) {
            stableCount++;
            if (stableCount >= 3)
                return;
        }
        else {
            stableCount = 0;
        }
        prevLen = len;
        await new Promise((r) => setTimeout(r, 1_000));
    }
}
//# sourceMappingURL=browser-request.js.map