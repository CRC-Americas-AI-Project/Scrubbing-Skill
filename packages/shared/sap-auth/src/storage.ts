/**
 * Storage layer for auth.json
 * Handles reading/writing auth data to ~/.sap-mcp/auth.json
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AuthStorage, StoredAuth } from './types.js';
import {
  decryptBuffer,
  encryptString,
  getEncryptKey,
  isPlainJson,
} from './utils/secure-store.js';

/** Base directory for all sap-auth data (auth.json, browser-profile, logs) */
export const SAP_MCP_DIR = join(homedir(), '.sap-mcp');

const AUTH_FILE = join(SAP_MCP_DIR, 'auth.json');
const CURRENT_VERSION = 2;

/**
 * Storage singleton for auth data
 */
export class Storage {
  private static instance: Storage;
  private cache: AuthStorage | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 seconds

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): Storage {
    if (!Storage.instance) {
      Storage.instance = new Storage();
    }
    return Storage.instance;
  }

  /**
   * Get the auth file path
   */
  getAuthFilePath(): string {
    return AUTH_FILE;
  }

  /**
   * Ensure the auth directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      // 0700: auth data (SSO cookies, OAuth refresh tokens, PATs) must not be
      // readable/traversable by other users on shared hosts.
      await fs.mkdir(SAP_MCP_DIR, { recursive: true, mode: 0o700 });
    } catch (error) {
      // Directory might already exist
    }
  }

  /**
   * Load auth data from file
   */
  private async load(): Promise<AuthStorage> {
    // Check cache
    const now = Date.now();
    if (this.cache && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      const key = getEncryptKey();
      let text: string;
      if (key) {
        const buf = await fs.readFile(AUTH_FILE);
        text = isPlainJson(buf) ? buf.toString('utf8') : decryptBuffer(buf, key);
      } else {
        text = await fs.readFile(AUTH_FILE, 'utf8');
      }
      const storage = JSON.parse(text) as AuthStorage;

      this.cache = storage;
      this.cacheTimestamp = now;
      return storage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, return empty storage
        const empty: AuthStorage = {
          version: CURRENT_VERSION,
          providers: {},
        };
        this.cache = empty;
        this.cacheTimestamp = now;
        return empty;
      }
      throw error;
    }
  }

  /**
   * Save auth data to file
   */
  private async save(storage: AuthStorage): Promise<void> {
    await this.ensureDir();
    const json = JSON.stringify(storage, null, 2);
    const key = getEncryptKey();
    if (key) {
      await fs.writeFile(AUTH_FILE, encryptString(json, key), { mode: 0o600 });
    } else {
      await fs.writeFile(AUTH_FILE, json, { encoding: 'utf8', mode: 0o600 });
    }
    // writeFile's `mode` only applies when it CREATES the file; on an existing
    // file the perms are untouched. chmod unconditionally so a pre-existing
    // 0644 auth.json is tightened to owner-only.
    await fs.chmod(AUTH_FILE, 0o600);
    this.cache = storage;
    this.cacheTimestamp = Date.now();
  }

  /**
   * Get auth data for a specific provider
   */
  async get<T extends StoredAuth>(providerId: string): Promise<T | null> {
    const storage = await this.load();
    const auth = storage.providers[providerId];
    return (auth as T) || null;
  }

  /**
   * Set auth data for a specific provider
   */
  async set(providerId: string, auth: StoredAuth): Promise<void> {
    // Invalidate cache before writes to get fresh state from disk,
    // reducing the window for cross-process overwrites
    this.invalidateCache();
    const storage = await this.load();
    storage.providers[providerId] = {
      ...auth,
      updatedAt: new Date().toISOString(),
    };
    await this.save(storage);
  }

  /**
   * Delete auth data for a specific provider
   */
  async delete(providerId: string): Promise<void> {
    this.invalidateCache();
    const storage = await this.load();
    delete storage.providers[providerId];
    await this.save(storage);
  }

  /**
   * Check if provider has stored auth
   */
  async has(providerId: string): Promise<boolean> {
    const storage = await this.load();
    return providerId in storage.providers;
  }

  /**
   * List all configured provider IDs
   */
  async listProviders(): Promise<string[]> {
    const storage = await this.load();
    return Object.keys(storage.providers);
  }

  /**
   * Clear all auth data
   */
  async clearAll(): Promise<void> {
    await this.save({
      version: CURRENT_VERSION,
      providers: {},
    });
  }

  /**
   * Invalidate cache (forces reload on next access)
   */
  invalidateCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Get raw storage data (for debugging)
   */
  async getAll(): Promise<AuthStorage> {
    return await this.load();
  }

}
