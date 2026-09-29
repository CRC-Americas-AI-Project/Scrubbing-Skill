/**
 * MCP Utils - Shared utilities for MCP servers
 *
 * Provides:
 * - Response formatting helpers (jsonResponse, textResponse, textError, jsonError)
 * - Error message extraction
 * - Parameter extraction helpers (getParam, getRequiredParam)
 * - Server factory utilities (createMcpServer, setupGracefulShutdown, runWithStdio)
 * - Tool handler wrapper for consistent error handling
 * - Async utilities (delay)
 * - Common MCP patterns
 *
 * Usage:
 *   import { jsonResponse, textError, getParam, getRequiredParam, delay } from 'mcp-utils';
 *
 *   // Success response with JSON data
 *   return jsonResponse({ items, count: items.length });
 *
 *   // Error response with text
 *   return textError(`Failed to fetch: ${error.message}`);
 *
 *   // Extract parameters from tool arguments
 *   const limit = getParam<number>(args, "limit") ?? 20;
 *   const id = getRequiredParam<string>(args, "id");
 *
 *   // Create and run MCP server
 *   const server = createMcpServer({ name: "my-server", version: "1.0.0" });
 *   setupGracefulShutdown(server);
 *   await runWithStdio(server, "My Server");
 *
 *   // Async delay
 *   await delay(3000); // Wait 3 seconds
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * Standard MCP response format
 * Index signature allows compatibility with MCP SDK's ServerResult type
 */
export interface McpResponse {
    [x: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
}
/**
 * Standard MCP error response format
 * Index signature allows compatibility with MCP SDK's ServerResult type
 */
export interface McpErrorResponse {
    [x: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: true;
}
/**
 * Create a successful MCP response with JSON-formatted data
 *
 * @example
 * return jsonResponse({ users, count: users.length });
 */
export declare function jsonResponse(data: unknown): McpResponse;
/**
 * Create a successful MCP response with plain text
 *
 * @example
 * return textResponse(`Created issue ${issueKey}`);
 */
export declare function textResponse(text: string): McpResponse;
/**
 * Create an error MCP response with plain text
 *
 * @example
 * return textError(`Failed to create issue: ${error.message}`);
 */
export declare function textError(text: string): McpErrorResponse;
/**
 * Create an error MCP response with JSON-formatted data
 *
 * @example
 * return jsonError({ error: "NOT_FOUND", message: "Issue not found" });
 */
export declare function jsonError(data: unknown): McpErrorResponse;
/**
 * Extract error message from unknown error type
 *
 * @example
 * const message = extractErrorMessage(error);
 */
export declare function extractErrorMessage(error: unknown): string;
/**
 * Format an error for MCP response
 *
 * Handles Axios-style errors with HTTP status codes, providing
 * user-friendly messages for common HTTP errors (401, 403, 404, 422).
 *
 * @example
 * return formatError(error, "fetch users");
 * // Returns: textError("Failed to fetch users: Connection refused")
 * // For HTTP 404: textError("Failed to fetch users: Resource not found.")
 */
export declare function formatError(error: unknown, operation: string): McpErrorResponse;
/**
 * Format a date string to a human-readable format
 *
 * @example
 * formatDate("2024-01-15T10:30:00Z")
 * // Returns: "Jan 15, 2024"
 */
export declare function formatDate(dateString: string): string;
/**
 * Format a date string to a human-readable format with time
 *
 * @example
 * formatDateTime("2024-01-15T10:30:00Z")
 * // Returns: "Jan 15, 2024, 10:30 AM"
 */
export declare function formatDateTime(dateString: string): string;
/**
 * Decode HTML entities to their corresponding characters
 *
 * @example
 * decodeHtmlEntities("&lt;div&gt;Hello&amp;World&lt;/div&gt;")
 * // Returns: "<div>Hello&World</div>"
 */
export declare function decodeHtmlEntities(text: string): string;
/**
 * Strip HTML tags and decode HTML entities from a string
 *
 * @example
 * stripHtml("<p>Hello &amp; <b>World</b></p>")
 * // Returns: "Hello & World"
 */
export declare function stripHtml(html: string): string;
/**
 * Escape special characters for safe HTML output
 *
 * @example
 * escapeHtml("<script>alert('xss')</script>")
 * // Returns: "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
 */
export declare function escapeHtml(text: string): string;
/**
 * Create a promise that resolves after a specified delay
 *
 * @param ms - The delay in milliseconds
 * @returns A promise that resolves after the delay
 *
 * @example
 * await delay(3000); // Wait 3 seconds
 * await delay(AUTH_RETRY_DELAY_MS);
 */
export declare function delay(ms: number): Promise<void>;
/**
 * Get an optional parameter from MCP tool arguments with type safety
 *
 * @param args - The arguments object from an MCP tool call
 * @param key - The parameter name to retrieve
 * @returns The parameter value cast to type T, or undefined if not present
 *
 * @example
 * const limit = getParam<number>(args, "limit") ?? 20;
 * const search = getParam<string>(args, "search");
 */
export declare function getParam<T>(args: Record<string, unknown> | undefined, key: string): T | undefined;
/**
 * Get a required parameter from MCP tool arguments with type safety
 *
 * @param args - The arguments object from an MCP tool call
 * @param key - The parameter name to retrieve
 * @returns The parameter value cast to type T
 * @throws Error if the parameter is missing or undefined
 *
 * @example
 * const conversationId = getRequiredParam<string>(args, "conversationId");
 * const issueKey = getRequiredParam<string>(args, "issue_key");
 */
export declare function getRequiredParam<T>(args: Record<string, unknown> | undefined, key: string): T;
/**
 * Options for creating an MCP server
 */
export interface ServerOptions {
    name: string;
    version: string;
}
/**
 * Create a new MCP server with the specified options
 *
 * @example
 * const server = createMcpServer({ name: "my-server", version: "1.0.0" });
 */
export declare function createMcpServer(options: ServerOptions): McpServer;
/**
 * Setup graceful shutdown handler for an MCP server
 *
 * Registers a SIGINT handler that closes the server gracefully
 * before exiting the process.
 *
 * @example
 * const server = createMcpServer({ name: "my-server", version: "1.0.0" });
 * setupGracefulShutdown(server);
 */
export declare function setupGracefulShutdown(server: McpServer): void;
/**
 * Run an MCP server using stdio transport
 *
 * @example
 * const server = createMcpServer({ name: "my-server", version: "1.0.0" });
 * await runWithStdio(server, "My Server");
 */
export declare function runWithStdio(server: McpServer, serverName: string): Promise<void>;
/**
 * Type for async tool handler functions
 */
export type ToolHandler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;
/**
 * Type guard function to check if an error is auth-related
 */
export type AuthErrorChecker = (error: unknown) => boolean;
/**
 * Options for wrapping a tool handler
 */
export interface WrapToolHandlerOptions {
    /**
     * Custom handler for authentication errors
     * If provided, will be called when isAuthError returns true
     */
    onAuthError?: (error: unknown) => McpResponse;
    /**
     * Custom handler for general errors
     * If provided, will be called for non-auth errors
     */
    onError?: (error: unknown) => McpResponse;
    /**
     * Function to check if an error is auth-related
     * Import from 'sap-auth': import { isAuthError } from 'sap-auth';
     */
    isAuthError?: AuthErrorChecker;
}
/**
 * Wrap a tool handler with consistent error handling
 *
 * Eliminates boilerplate try-catch blocks by providing
 * standardized error handling for MCP tools.
 *
 * @example
 * import { isAuthError, formatAuthError } from 'sap-auth';
 *
 * const wrappedHandler = wrapToolHandler(
 *   async (args) => {
 *     const result = await fetchData(args.id);
 *     return jsonResponse(result);
 *   },
 *   {
 *     isAuthError,
 *     onAuthError: (error) => formatAuthError(error, 'wiki'),
 *     onError: (error) => jsonError({ error: extractErrorMessage(error) }),
 *   }
 * );
 */
export declare function wrapToolHandler<TArgs, TResult>(handler: ToolHandler<TArgs, TResult>, options?: WrapToolHandlerOptions): ToolHandler<TArgs, TResult | McpResponse>;
/**
 * Create default tool handler options with auth error handling
 *
 * Convenience function to create standard options for tools that
 * interact with authenticated APIs.
 *
 * @example
 * import { isAuthError, formatAuthError } from 'sap-auth';
 *
 * const options = createAuthHandlerOptions(isAuthError, 'wiki');
 * const wrappedHandler = wrapToolHandler(myHandler, options);
 */
export declare function createAuthHandlerOptions(isAuthError: AuthErrorChecker, providerId: string, formatAuthError: (error: unknown, providerId: string) => McpErrorResponse): WrapToolHandlerOptions;
export { launchMcpServer } from "./bin-launcher.js";
export type { LaunchOptions } from "./bin-launcher.js";
//# sourceMappingURL=index.d.ts.map