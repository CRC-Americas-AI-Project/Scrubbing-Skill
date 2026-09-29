/**
 * Shared Logger module for MCP servers
 *
 * Supports verbose mode via VERBOSE=true environment variable.
 * When verbose mode is enabled, logs are written to ~/.sap-mcp/logs/{serviceName}.log
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// ============================================================================
// Configuration
// ============================================================================
const LOG_DIR = path.join(os.homedir(), ".sap-mcp", "logs");
function isVerboseEnabled() {
    const verbose = process.env.VERBOSE?.toLowerCase();
    return verbose === "true" || verbose === "1";
}
// ============================================================================
// Log File Setup
// ============================================================================
const logStreams = new Map();
function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}
function getLogStream(serviceName) {
    if (!logStreams.has(serviceName)) {
        ensureLogDir();
        const logFile = path.join(LOG_DIR, `${serviceName}.log`);
        const stream = fs.createWriteStream(logFile, { flags: "a" });
        logStreams.set(serviceName, stream);
    }
    return logStreams.get(serviceName);
}
function formatTimestamp() {
    return new Date().toISOString();
}
function formatArgs(args) {
    if (args.length === 0)
        return "";
    return " " + args.map(a => typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)).join(" ");
}
function formatMessage(level, prefix, message, ...args) {
    return `[${formatTimestamp()}] [${level}] [${prefix}] ${message}${formatArgs(args)}`;
}
const sharedSummaries = new Map();
function getSharedSummary(serviceName) {
    if (!sharedSummaries.has(serviceName)) {
        sharedSummaries.set(serviceName, { entries: [], start: Date.now() });
    }
    return sharedSummaries.get(serviceName);
}
// ============================================================================
// Logger Class
// ============================================================================
export class Logger {
    serviceName;
    prefix;
    _verbose;
    constructor(serviceName, prefix) {
        this.serviceName = serviceName;
        this.prefix = prefix || serviceName;
        this._verbose = isVerboseEnabled();
    }
    /**
     * Write to log file (only in verbose mode)
     */
    writeToFile(message) {
        if (this._verbose) {
            const stream = getLogStream(this.serviceName);
            stream.write(message + "\n");
        }
    }
    /**
     * Debug level - only in verbose mode (both stderr and file)
     */
    debug(message, ...args) {
        if (this._verbose) {
            const formatted = formatMessage("DEBUG", this.prefix, message, ...args);
            console.error(formatted);
            this.writeToFile(formatted);
        }
    }
    /**
     * Info level - always output to stderr, write to file in verbose mode
     */
    info(message, ...args) {
        const formatted = formatMessage("INFO", this.prefix, message, ...args);
        this.addSummaryEntry("INFO", message, args);
        console.error(formatted);
        this.writeToFile(formatted);
    }
    /**
     * Warn level - always output to stderr, write to file in verbose mode
     */
    warn(message, ...args) {
        const formatted = formatMessage("WARN", this.prefix, message, ...args);
        this.addSummaryEntry("WARN", message, args);
        console.error(formatted);
        this.writeToFile(formatted);
    }
    /**
     * Error level - always output to stderr, write to file in verbose mode
     */
    error(message, ...args) {
        const formatted = formatMessage("ERROR", this.prefix, message, ...args);
        this.addSummaryEntry("ERROR", message, args);
        console.error(formatted);
        this.writeToFile(formatted);
    }
    /**
     * Verbose level - only in verbose mode, only to file (not stderr)
     */
    verbose(message, ...args) {
        if (this._verbose) {
            const formatted = formatMessage("VERBOSE", this.prefix, message, ...args);
            this.writeToFile(formatted);
        }
    }
    // ============================================================================
    // Summary (for attaching to error diagnostics)
    // ============================================================================
    addSummaryEntry(level, message, args) {
        const shared = getSharedSummary(this.serviceName);
        const elapsed = (Date.now() - shared.start) / 1000;
        shared.entries.push({ elapsed, level, prefix: this.prefix, message: `${message}${formatArgs(args)}` });
    }
    /**
     * Get accumulated log entries as a summary with relative timestamps.
     * Includes entries from ALL loggers with the same serviceName.
     * Use for attaching to error diagnostics.
     */
    getSummary() {
        const shared = getSharedSummary(this.serviceName);
        return shared.entries
            .map(e => `[+${e.elapsed.toFixed(1)}s] [${e.level}] [${e.prefix}] ${e.message}`)
            .join('\n');
    }
    /**
     * Clear accumulated entries and reset the timer for this service.
     * Affects ALL loggers with the same serviceName.
     * Call at the start of a new operation/flow.
     */
    clearSummary() {
        const shared = getSharedSummary(this.serviceName);
        shared.entries = [];
        shared.start = Date.now();
    }
    /**
     * Get the log file path for this service
     */
    getLogFile() {
        return path.join(LOG_DIR, `${this.serviceName}.log`);
    }
    /**
     * Check if verbose mode is enabled
     */
    isVerboseMode() {
        return this._verbose;
    }
}
// ============================================================================
// Factory Function
// ============================================================================
/**
 * Create a logger instance for a service
 * @param serviceName - The service name (used for log file naming)
 * @param prefix - Optional prefix for log messages (defaults to serviceName)
 */
export function createLogger(serviceName, prefix) {
    return new Logger(serviceName, prefix);
}
/**
 * Check if verbose mode is enabled globally
 */
export function isVerbose() {
    return isVerboseEnabled();
}
/**
 * Get the log directory path
 */
export function getLogDir() {
    return LOG_DIR;
}
/**
 * Get the log file path for a service
 */
export function getLogFilePath(serviceName) {
    return path.join(LOG_DIR, `${serviceName}.log`);
}
export default Logger;
//# sourceMappingURL=index.js.map