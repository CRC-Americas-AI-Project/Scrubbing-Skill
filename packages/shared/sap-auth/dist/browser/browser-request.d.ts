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
export interface BrowserRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    /**
     * When true, the response body is returned base64-encoded (set
     * `response.bodyEncoding = 'base64'`) instead of as UTF-8 text. Use for binary
     * downloads (PDF/DOC/images) that `res.text()` would corrupt. The SPA-shell and
     * auth-redirect fallbacks are skipped in binary mode.
     */
    binary?: boolean;
}
export interface BrowserRequestResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    /** 'base64' when the caller requested binary; otherwise undefined (text). */
    bodyEncoding?: 'base64';
}
/**
 * Make an HTTP request via a browser.
 *
 * Navigates to the URL's origin (triggering SSO), then runs fetch()
 * from the authenticated page context.
 */
export declare function makeBrowserRequest(url: string, options?: BrowserRequestOptions): Promise<BrowserRequestResponse>;
/**
 * Detect OAuth/SAML redirect pages returned instead of real content.
 * These are small HTML pages with JS that sets cookies and redirects to an
 * identity provider (IAS, Azure AD, etc.).
 */
export declare function isAuthRedirect(body: string): boolean;
/**
 * Detect unrendered SPA shell: an HTML response whose visible text (after
 * stripping <script> and <style> blocks and HTML tags) is under 200 chars.
 * Non-HTML responses (JSON, XML, etc.) are never SPA shells.
 */
export declare function isSpaShell(body: string, contentType: string): boolean;
//# sourceMappingURL=browser-request.d.ts.map