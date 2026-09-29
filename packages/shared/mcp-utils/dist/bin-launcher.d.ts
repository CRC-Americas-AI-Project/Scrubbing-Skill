/**
 * Shared bin launcher for MCP servers
 *
 * Replaces copy-pasted bin entry point scripts with a single reusable function.
 * Handles --help, --version, auto-build, ESM dynamic import, and process error handlers.
 */
export interface LaunchOptions {
    /** Display name shown in startup messages, e.g. "SAP Wiki MCP Server" */
    displayName: string;
    /** Binary name for usage text, e.g. "sap-wiki-mcp" */
    binaryName: string;
    /** Extra environment variable docs for --help output */
    envVarsHelp?: string;
    /** The import.meta.url of the calling bin script (used to resolve paths) */
    importMetaUrl: string;
}
/**
 * Launch an MCP server with standardized CLI handling.
 *
 * Provides: --help, --version, auto-build on missing dist/, ESM import,
 * and unhandled rejection/exception handlers.
 *
 * @example
 * // In bin/sap-wiki-mcp.js:
 * import { launchMcpServer } from "mcp-utils";
 * launchMcpServer({
 *   displayName: "SAP Wiki MCP Server",
 *   binaryName: "sap-wiki-mcp",
 *   importMetaUrl: import.meta.url,
 *   envVarsHelp: "  WIKI_DOMAIN    Custom wiki domain",
 * });
 */
export declare function launchMcpServer(options: LaunchOptions): Promise<void>;
//# sourceMappingURL=bin-launcher.d.ts.map