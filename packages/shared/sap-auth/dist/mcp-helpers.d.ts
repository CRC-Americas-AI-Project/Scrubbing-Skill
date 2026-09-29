/**
 * Auth-specific MCP helper utilities
 *
 * These helpers allow MCPs to:
 * - Format auth errors in a consistent way
 * - Check if an error is auth-related
 * - Convert credentials to HTTP headers
 */
import { Credentials } from './types.js';
import type { McpErrorResponse, WrapToolHandlerOptions } from 'mcp-utils';
/**
 * Convert credentials to HTTP headers
 *
 * @example
 * const headers = credentialsToHeaders(creds);
 * // { Cookie: "..." } or { Authorization: "Bearer ..." }
 */
export declare function credentialsToHeaders(creds: Credentials): Record<string, string>;
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
export declare function formatAuthError(error: unknown, domain?: string): McpErrorResponse;
/**
 * Check if an error is an auth-related error
 *
 * Handles:
 * - AuthError and its subclasses
 * - Legacy errors with message "AUTHENTICATION_REQUIRED"
 * - Errors with name "AuthRedirectError"
 */
export declare function isAuthError(error: unknown): boolean;
/**
 * Create standard wrapToolHandler error options for auth-aware tools.
 *
 * @example
 *   import { defaultAuthErrorOptions } from 'sap-auth';
 *   const errorOptions = defaultAuthErrorOptions('wiki.one.int.sap');
 *   server.registerTool("my_tool", schema, wrapToolHandler(handler, errorOptions));
 */
export declare function defaultAuthErrorOptions(domain?: string): WrapToolHandlerOptions;
//# sourceMappingURL=mcp-helpers.d.ts.map