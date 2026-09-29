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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// ============================================================================
// Response Helpers
// ============================================================================
/**
 * Create a successful MCP response with JSON-formatted data
 *
 * @example
 * return jsonResponse({ users, count: users.length });
 */
export function jsonResponse(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
/**
 * Create a successful MCP response with plain text
 *
 * @example
 * return textResponse(`Created issue ${issueKey}`);
 */
export function textResponse(text) {
    return {
        content: [{ type: "text", text }],
    };
}
/**
 * Create an error MCP response with plain text
 *
 * @example
 * return textError(`Failed to create issue: ${error.message}`);
 */
export function textError(text) {
    return {
        content: [{ type: "text", text }],
        isError: true,
    };
}
/**
 * Create an error MCP response with JSON-formatted data
 *
 * @example
 * return jsonError({ error: "NOT_FOUND", message: "Issue not found" });
 */
export function jsonError(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: true,
    };
}
// ============================================================================
// Error Helpers
// ============================================================================
/**
 * Extract error message from unknown error type
 *
 * @example
 * const message = extractErrorMessage(error);
 */
export function extractErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
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
export function formatError(error, operation) {
    if (error instanceof Error) {
        const axiosError = error;
        const response = axiosError.response;
        if (response?.data?.message) {
            return textError(`Failed to ${operation}: ${response.data.message}`);
        }
        if (response?.status) {
            const status = response.status;
            const statusMessages = {
                401: "Authentication failed. Please check your credentials.",
                403: "Access forbidden. You may not have permission for this action.",
                404: "Resource not found.",
                422: "Invalid request parameters.",
            };
            const statusMsg = statusMessages[status] ?? `HTTP ${status} error.`;
            return textError(`Failed to ${operation}: ${statusMsg}`);
        }
        return textError(`Failed to ${operation}: ${error.message}`);
    }
    return textError(`Failed to ${operation}: ${String(error)}`);
}
// ============================================================================
// Date Formatting Utilities
// ============================================================================
/**
 * Format a date string to a human-readable format
 *
 * @example
 * formatDate("2024-01-15T10:30:00Z")
 * // Returns: "Jan 15, 2024"
 */
export function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}
/**
 * Format a date string to a human-readable format with time
 *
 * @example
 * formatDateTime("2024-01-15T10:30:00Z")
 * // Returns: "Jan 15, 2024, 10:30 AM"
 */
export function formatDateTime(dateString) {
    return new Date(dateString).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}
// ============================================================================
// HTML Utilities
// ============================================================================
/**
 * Decode HTML entities to their corresponding characters
 *
 * @example
 * decodeHtmlEntities("&lt;div&gt;Hello&amp;World&lt;/div&gt;")
 * // Returns: "<div>Hello&World</div>"
 */
export function decodeHtmlEntities(text) {
    if (!text)
        return "";
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&hellip;/g, "...")
        .replace(/&ndash;/g, "-")
        .replace(/&mdash;/g, "—");
}
/**
 * Strip HTML tags and decode HTML entities from a string
 *
 * @example
 * stripHtml("<p>Hello &amp; <b>World</b></p>")
 * // Returns: "Hello & World"
 */
export function stripHtml(html) {
    if (!html)
        return "";
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, "")).trim();
}
/**
 * Escape special characters for safe HTML output
 *
 * @example
 * escapeHtml("<script>alert('xss')</script>")
 * // Returns: "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
 */
export function escapeHtml(text) {
    if (!text)
        return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
// ============================================================================
// Async Utilities
// ============================================================================
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
export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ============================================================================
// Parameter Helpers
// ============================================================================
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
export function getParam(args, key) {
    if (!args)
        return undefined;
    return args[key];
}
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
export function getRequiredParam(args, key) {
    if (!args || args[key] === undefined) {
        throw new Error(`Missing required parameter: ${key}`);
    }
    return args[key];
}
/**
 * Create a new MCP server with the specified options
 *
 * @example
 * const server = createMcpServer({ name: "my-server", version: "1.0.0" });
 */
export function createMcpServer(options) {
    return new McpServer({
        name: options.name,
        version: options.version,
    });
}
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
export function setupGracefulShutdown(server) {
    process.on("SIGINT", async () => {
        await server.close();
        process.exit(0);
    });
}
/**
 * Run an MCP server using stdio transport
 *
 * @example
 * const server = createMcpServer({ name: "my-server", version: "1.0.0" });
 * await runWithStdio(server, "My Server");
 */
export async function runWithStdio(server, serverName) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${serverName} MCP server running on stdio`);
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
export function wrapToolHandler(handler, options) {
    return async (args) => {
        try {
            return await handler(args);
        }
        catch (error) {
            if (options?.isAuthError && options.isAuthError(error) && options.onAuthError) {
                return options.onAuthError(error);
            }
            if (options?.onError) {
                return options.onError(error);
            }
            return jsonError({ error: extractErrorMessage(error) });
        }
    };
}
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
export function createAuthHandlerOptions(isAuthError, providerId, formatAuthError) {
    return {
        isAuthError,
        onAuthError: (error) => formatAuthError(error, providerId),
        onError: (error) => jsonError({ error: extractErrorMessage(error) }),
    };
}
// ============================================================================
// Bin Launcher (re-exported)
// ============================================================================
export { launchMcpServer } from "./bin-launcher.js";
//# sourceMappingURL=index.js.map