/**
 * Auth-specific MCP helper utilities
 *
 * These helpers allow MCPs to:
 * - Format auth errors in a consistent way
 * - Check if an error is auth-related
 * - Convert credentials to HTTP headers
 */
import { AuthError, AuthExpiredError, AuthNotConfiguredError, AuthBrowserError, ApiTokenRequiredError } from './types.js';
// ============================================================================
// Credential Helpers
// ============================================================================
/**
 * Convert credentials to HTTP headers
 *
 * @example
 * const headers = credentialsToHeaders(creds);
 * // { Cookie: "..." } or { Authorization: "Bearer ..." }
 */
export function credentialsToHeaders(creds) {
    if (creds.type === "cookie") {
        return { Cookie: creds.value };
    }
    // bearer or api-token
    return { Authorization: `Bearer ${creds.value}` };
}
// ============================================================================
// Auth Error Helpers
// ============================================================================
/**
 * Try to look up a registered provider config by domain.
 * Uses lazy import to avoid circular dependency with auth-manager.
 * Returns null if AuthManager isn't available (e.g., in tests).
 */
function lookupProvider(domain) {
    try {
        // Dynamic import to break circular dependency: mcp-helpers → auth-manager → mcp-helpers
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AuthManager } = require('./auth-manager.js');
        return AuthManager.getInstance().getProvider(domain) ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Get resolution hint based on error type
 */
function getResolutionHint(error) {
    const domain = error.providerId || 'unknown';
    const msg = error.message.toLowerCase();
    if (error instanceof AuthBrowserError) {
        if (msg.includes('session closed') || msg.includes('target closed') || msg.includes('closed')) {
            return 'The authentication browser closed before login completed. Try again. Set VISIBLE_MODE=true to see and interact with the browser window.';
        }
        if (msg.includes('timeout')) {
            return 'Browser authentication timed out. This can happen when certificate selection is required. Set VISIBLE_MODE=true to select your certificate manually.';
        }
        if (msg.includes('certificate')) {
            return 'Browser authentication failed during certificate selection. Set VISIBLE_MODE=true to see the browser and choose the correct certificate.';
        }
        return `Browser authentication failed. Steps to try:\n1) Run the operation again\n2) Use sap_clear_auths to reset credentials\n3) Set VISIBLE_MODE=true to watch the authentication process`;
    }
    if (error instanceof AuthExpiredError) {
        return 'Authentication has expired. The system will re-authenticate automatically on the next request.';
    }
    if (error instanceof AuthNotConfiguredError) {
        const config = domain !== 'unknown' ? lookupProvider(domain) : null;
        const entryUrl = config?.entryUrl || (config?.domain ? `https://${config.domain}/` : '');
        if (entryUrl) {
            return `No stored credentials for ${domain}. The system will authenticate automatically on the next request.`;
        }
        return `No stored credentials for ${domain}. Try running the operation again — the system will attempt to authenticate automatically.`;
    }
    if (error instanceof ApiTokenRequiredError) {
        return error.instructions || `API token required for ${domain}. Please configure the appropriate environment variable.`;
    }
    // Base AuthError — check for audience-specific failure
    if (msg.includes('token for audience')) {
        return `Could not get the required access token. Try sap_clear_auths to reset credentials, then retry. Set VISIBLE_MODE=true if prompted for certificates.`;
    }
    return `Authentication failed for ${domain}. Try sap_clear_auths to reset credentials, then retry. Set VISIBLE_MODE=true if you need to interact with the browser.`;
}
/**
 * Format an auth error into a standard MCP error response
 *
 * @example
 * } catch (error) {
 *   if (isAuthError(error)) {
 *     return formatAuthError(error, 'wiki.one.int.sap');
 *   }
 * }
 */
export function formatAuthError(error, domain) {
    if (error instanceof AuthError) {
        const resolvedDomain = error.providerId || domain || 'unknown';
        const config = resolvedDomain !== 'unknown' ? lookupProvider(resolvedDomain) : null;
        const lines = [];
        lines.push(error.message);
        lines.push('');
        lines.push(getResolutionHint(error));
        // Show cause chain if present
        if (error.cause instanceof Error) {
            lines.push('');
            lines.push(`Caused by: ${error.cause.message}`);
        }
        // Include auth flow diagnostics when available
        if (error.flowSummary) {
            lines.push('');
            lines.push('Auth flow:');
            lines.push(error.flowSummary);
        }
        // Compact details for debugging
        const details = [`provider=${resolvedDomain}`, `code=${error.code}`];
        if (config?.entryUrl) {
            details.push(`url=${config.entryUrl}`);
        }
        else if (config?.domain) {
            details.push(`url=https://${config.domain}/`);
        }
        lines.push('');
        lines.push(`[${details.join(', ')}]`);
        return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: true,
        };
    }
    // Legacy non-AuthError path
    const resolvedDomain = domain || 'unknown';
    return {
        content: [{ type: 'text', text: `Authentication required for ${resolvedDomain}. The system will re-authenticate on the next request.` }],
        isError: true,
    };
}
/**
 * Check if an error is an auth-related error
 *
 * Handles:
 * - AuthError and its subclasses
 * - Legacy errors with message "AUTHENTICATION_REQUIRED"
 * - Errors with name "AuthRedirectError"
 */
export function isAuthError(error) {
    if (error instanceof AuthError) {
        return true;
    }
    if (error instanceof Error) {
        if (error.message === 'AUTHENTICATION_REQUIRED') {
            return true;
        }
        if (error.name === 'AuthRedirectError') {
            return true;
        }
    }
    return false;
}
// ============================================================================
// Default Error Options
// ============================================================================
/**
 * Create standard wrapToolHandler error options for auth-aware tools.
 *
 * @example
 *   import { defaultAuthErrorOptions } from 'sap-auth';
 *   const errorOptions = defaultAuthErrorOptions('wiki.one.int.sap');
 *   server.registerTool("my_tool", schema, wrapToolHandler(handler, errorOptions));
 */
export function defaultAuthErrorOptions(domain) {
    return {
        isAuthError,
        onAuthError: (error) => formatAuthError(error, domain),
    };
}
//# sourceMappingURL=mcp-helpers.js.map