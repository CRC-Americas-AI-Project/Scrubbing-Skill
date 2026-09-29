/**
 * Shared bin launcher for MCP servers
 *
 * Replaces copy-pasted bin entry point scripts with a single reusable function.
 * Handles --help, --version, auto-build, ESM dynamic import, and process error handlers.
 */
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
function showHelp(options, packageJson) {
    const envSection = options.envVarsHelp
        ? `\nEnvironment Variables:\n${options.envVarsHelp}\n`
        : "";
    console.log(`
${options.displayName} v${packageJson.version}
${packageJson.description}

Usage:
  ${options.binaryName} [options]

Options:
  --help, -h           Show this help message
  --version, -v        Show version information

Examples:
  # Start the MCP server
  ${options.binaryName}

  # Use with Claude Desktop via stdio
  echo '{"method":"tools/list"}' | ${options.binaryName}
${envSection}
For more information:
  GitHub: https://github.tools.sap/GC-CA-AI-Incubation/sap-mcp-combo
  Issues: https://github.tools.sap/GC-CA-AI-Incubation/sap-mcp-combo/issues
`);
}
async function buildProject(packageDir) {
    console.error("Building TypeScript project...");
    return new Promise((resolve, reject) => {
        const buildProcess = spawn("npm", ["run", "build"], {
            cwd: packageDir,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        buildProcess.on("close", (code) => {
            if (code === 0) {
                console.error("Build completed successfully");
                resolve();
            }
            else {
                reject(new Error(`Build failed with exit code ${code}`));
            }
        });
        buildProcess.on("error", (error) => {
            reject(new Error(`Build process error: ${error.message}`));
        });
    });
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
export async function launchMcpServer(options) {
    // Register process error handlers first, before any work that could throw.
    process.on("unhandledRejection", (reason, promise) => {
        console.error("Unhandled Rejection at:", promise, "reason:", reason);
        process.exit(1);
    });
    process.on("uncaughtException", (error) => {
        console.error("Uncaught Exception:", error);
        process.exit(1);
    });
    try {
        const binDir = dirname(fileURLToPath(options.importMetaUrl));
        const packageDir = join(binDir, "..");
        const packageJsonPath = join(packageDir, "package.json");
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        // Handle CLI args
        const args = process.argv.slice(2);
        if (args.includes("--help") || args.includes("-h")) {
            showHelp(options, packageJson);
            process.exit(0);
        }
        if (args.includes("--version") || args.includes("-v")) {
            console.log(packageJson.version);
            process.exit(0);
        }
        // Auto-build if dist is missing
        const serverPath = join(packageDir, "dist", "index.js");
        if (!existsSync(serverPath)) {
            console.error("Compiled files not found. Building project...");
            try {
                await buildProject(packageDir);
            }
            catch (buildError) {
                const msg = buildError instanceof Error ? buildError.message : String(buildError);
                console.error(`Auto-build failed: ${msg}`);
                console.error("\nTry running manually:");
                console.error("  npm install");
                console.error("  npm run build");
                process.exit(1);
            }
        }
        // Import and run the server
        console.error(`Starting ${options.displayName}...`);
        const serverPathUrl = pathToFileURL(serverPath).href;
        await import(serverPathUrl);
    }
    catch (error) {
        const err = error;
        console.error(`Fatal error in ${options.displayName}:`, err.message);
        if (err.code === "MODULE_NOT_FOUND") {
            console.error("\nThis might be a dependency issue. Try:");
            console.error("  npm install");
            console.error("  npm run build");
        }
        process.exit(1);
    }
}
//# sourceMappingURL=bin-launcher.js.map