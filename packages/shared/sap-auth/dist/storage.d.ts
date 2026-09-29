/**
 * Storage layer for auth.json
 * Handles reading/writing auth data to ~/.sap-mcp/auth.json
 */
import type { AuthStorage, StoredAuth } from './types.js';
/** Base directory for all sap-auth data (auth.json, browser-profile, logs) */
export declare const SAP_MCP_DIR: string;
/**
 * Storage singleton for auth data
 */
export declare class Storage {
    private static instance;
    private cache;
    private cacheTimestamp;
    private readonly CACHE_TTL_MS;
    private constructor();
    /**
     * Get the singleton instance
     */
    static getInstance(): Storage;
    /**
     * Get the auth file path
     */
    getAuthFilePath(): string;
    /**
     * Ensure the auth directory exists
     */
    private ensureDir;
    /**
     * Load auth data from file
     */
    private load;
    /**
     * Save auth data to file
     */
    private save;
    /**
     * Get auth data for a specific provider
     */
    get<T extends StoredAuth>(providerId: string): Promise<T | null>;
    /**
     * Set auth data for a specific provider
     */
    set(providerId: string, auth: StoredAuth): Promise<void>;
    /**
     * Delete auth data for a specific provider
     */
    delete(providerId: string): Promise<void>;
    /**
     * Check if provider has stored auth
     */
    has(providerId: string): Promise<boolean>;
    /**
     * List all configured provider IDs
     */
    listProviders(): Promise<string[]>;
    /**
     * Clear all auth data
     */
    clearAll(): Promise<void>;
    /**
     * Invalidate cache (forces reload on next access)
     */
    invalidateCache(): void;
    /**
     * Get raw storage data (for debugging)
     */
    getAll(): Promise<AuthStorage>;
}
//# sourceMappingURL=storage.d.ts.map