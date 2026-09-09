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

function isVerboseEnabled(): boolean {
  const verbose = process.env.VERBOSE?.toLowerCase();
  return verbose === "true" || verbose === "1";
}

// ============================================================================
// Log File Setup
// ============================================================================

const logStreams: Map<string, fs.WriteStream> = new Map();

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogStream(serviceName: string): fs.WriteStream {
  if (!logStreams.has(serviceName)) {
    ensureLogDir();
    const logFile = path.join(LOG_DIR, `${serviceName}.log`);
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    logStreams.set(serviceName, stream);
  }
  return logStreams.get(serviceName)!;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return " " + args.map(a =>
    typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
  ).join(" ");
}

function formatMessage(level: string, prefix: string, message: string, ...args: unknown[]): string {
  return `[${formatTimestamp()}] [${level}] [${prefix}] ${message}${formatArgs(args)}`;
}

// ============================================================================
// Shared summary storage (per service name, so all loggers for a service
// contribute to one summary — e.g. auth-manager + browser + sso all appear)
// ============================================================================

interface SummaryEntry { elapsed: number; level: string; prefix: string; message: string }
interface SharedSummary { entries: SummaryEntry[]; start: number }
const sharedSummaries: Map<string, SharedSummary> = new Map();

function getSharedSummary(serviceName: string): SharedSummary {
  if (!sharedSummaries.has(serviceName)) {
    sharedSummaries.set(serviceName, { entries: [], start: Date.now() });
  }
  return sharedSummaries.get(serviceName)!;
}

// ============================================================================
// Logger Class
// ============================================================================

export class Logger {
  private serviceName: string;
  private prefix: string;
  private _verbose: boolean;

  constructor(serviceName: string, prefix?: string) {
    this.serviceName = serviceName;
    this.prefix = prefix || serviceName;
    this._verbose = isVerboseEnabled();
  }

  /**
   * Write to log file (only in verbose mode)
   */
  private writeToFile(message: string): void {
    if (this._verbose) {
      const stream = getLogStream(this.serviceName);
      stream.write(message + "\n");
    }
  }

  /**
   * Debug level - only in verbose mode (both stderr and file)
   */
  debug(message: string, ...args: unknown[]): void {
    if (this._verbose) {
      const formatted = formatMessage("DEBUG", this.prefix, message, ...args);
      console.error(formatted);
      this.writeToFile(formatted);
    }
  }

  /**
   * Info level - always output to stderr, write to file in verbose mode
   */
  info(message: string, ...args: unknown[]): void {
    const formatted = formatMessage("INFO", this.prefix, message, ...args);
    this.addSummaryEntry("INFO", message, args);
    console.error(formatted);
    this.writeToFile(formatted);
  }

  /**
   * Warn level - always output to stderr, write to file in verbose mode
   */
  warn(message: string, ...args: unknown[]): void {
    const formatted = formatMessage("WARN", this.prefix, message, ...args);
    this.addSummaryEntry("WARN", message, args);
    console.error(formatted);
    this.writeToFile(formatted);
  }

  /**
   * Error level - always output to stderr, write to file in verbose mode
   */
  error(message: string, ...args: unknown[]): void {
    const formatted = formatMessage("ERROR", this.prefix, message, ...args);
    this.addSummaryEntry("ERROR", message, args);
    console.error(formatted);
    this.writeToFile(formatted);
  }

  /**
   * Verbose level - only in verbose mode, only to file (not stderr)
   */
  verbose(message: string, ...args: unknown[]): void {
    if (this._verbose) {
      const formatted = formatMessage("VERBOSE", this.prefix, message, ...args);
      this.writeToFile(formatted);
    }
  }

  // ============================================================================
  // Summary (for attaching to error diagnostics)
  // ============================================================================

  private addSummaryEntry(level: string, message: string, args: unknown[]): void {
    const shared = getSharedSummary(this.serviceName);
    const elapsed = (Date.now() - shared.start) / 1000;
    shared.entries.push({ elapsed, level, prefix: this.prefix, message: `${message}${formatArgs(args)}` });
  }

  /**
   * Get accumulated log entries as a summary with relative timestamps.
   * Includes entries from ALL loggers with the same serviceName.
   * Use for attaching to error diagnostics.
   */
  getSummary(): string {
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
  clearSummary(): void {
    const shared = getSharedSummary(this.serviceName);
    shared.entries = [];
    shared.start = Date.now();
  }

  /**
   * Get the log file path for this service
   */
  getLogFile(): string {
    return path.join(LOG_DIR, `${this.serviceName}.log`);
  }

  /**
   * Check if verbose mode is enabled
   */
  isVerboseMode(): boolean {
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
export function createLogger(serviceName: string, prefix?: string): Logger {
  return new Logger(serviceName, prefix);
}

/**
 * Check if verbose mode is enabled globally
 */
export function isVerbose(): boolean {
  return isVerboseEnabled();
}

/**
 * Get the log directory path
 */
export function getLogDir(): string {
  return LOG_DIR;
}

/**
 * Get the log file path for a service
 */
export function getLogFilePath(serviceName: string): string {
  return path.join(LOG_DIR, `${serviceName}.log`);
}

export default Logger;
