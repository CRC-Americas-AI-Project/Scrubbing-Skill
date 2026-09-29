/**
 * Shared Logger module for MCP servers
 *
 * Supports verbose mode via VERBOSE=true environment variable.
 * When verbose mode is enabled, logs are written to ~/.sap-mcp/logs/{serviceName}.log
 */
export declare class Logger {
    private serviceName;
    private prefix;
    private _verbose;
    constructor(serviceName: string, prefix?: string);
    /**
     * Write to log file (only in verbose mode)
     */
    private writeToFile;
    /**
     * Debug level - only in verbose mode (both stderr and file)
     */
    debug(message: string, ...args: unknown[]): void;
    /**
     * Info level - always output to stderr, write to file in verbose mode
     */
    info(message: string, ...args: unknown[]): void;
    /**
     * Warn level - always output to stderr, write to file in verbose mode
     */
    warn(message: string, ...args: unknown[]): void;
    /**
     * Error level - always output to stderr, write to file in verbose mode
     */
    error(message: string, ...args: unknown[]): void;
    /**
     * Verbose level - only in verbose mode, only to file (not stderr)
     */
    verbose(message: string, ...args: unknown[]): void;
    private addSummaryEntry;
    /**
     * Get accumulated log entries as a summary with relative timestamps.
     * Includes entries from ALL loggers with the same serviceName.
     * Use for attaching to error diagnostics.
     */
    getSummary(): string;
    /**
     * Clear accumulated entries and reset the timer for this service.
     * Affects ALL loggers with the same serviceName.
     * Call at the start of a new operation/flow.
     */
    clearSummary(): void;
    /**
     * Get the log file path for this service
     */
    getLogFile(): string;
    /**
     * Check if verbose mode is enabled
     */
    isVerboseMode(): boolean;
}
/**
 * Create a logger instance for a service
 * @param serviceName - The service name (used for log file naming)
 * @param prefix - Optional prefix for log messages (defaults to serviceName)
 */
export declare function createLogger(serviceName: string, prefix?: string): Logger;
/**
 * Check if verbose mode is enabled globally
 */
export declare function isVerbose(): boolean;
/**
 * Get the log directory path
 */
export declare function getLogDir(): string;
/**
 * Get the log file path for a service
 */
export declare function getLogFilePath(serviceName: string): string;
export default Logger;
//# sourceMappingURL=index.d.ts.map