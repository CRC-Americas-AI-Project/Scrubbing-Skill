/**
 * Base class for authentication methods
 *
 * Methods are stateless building blocks — they define HOW to validate,
 * convert, refresh, and authenticate for a given auth type.
 * AuthManager handles WHEN and in what order to call them,
 * and owns all storage I/O.
 */

import type {
  Credentials,
  ProviderConfig,
  StoredAuth,
} from '../types.js';

/**
 * Abstract base class for authentication methods
 * Each auth method (sap-sso, oauth, api-token) extends this
 */
export abstract class AuthMethod<T extends StoredAuth = StoredAuth> {
  /**
   * Check if stored auth data is still valid
   */
  abstract validate(stored: T | null): Promise<boolean>;

  /**
   * Convert stored auth to credentials for HTTP requests
   */
  abstract toCredentials(stored: T): Credentials;

  /**
   * Attempt to refresh auth without user interaction
   * Returns new auth data if successful, null if refresh failed
   */
  abstract refresh(
    stored: T | null,
    config: ProviderConfig,
  ): Promise<T | null>;

  /**
   * Perform full authentication (may launch browser)
   * Called when refresh fails or no stored auth exists
   */
  abstract authenticate(config: ProviderConfig): Promise<T>;

  /**
   * Get expiration date from stored auth
   */
  abstract getExpiresAt(stored: T): Date | null;
}
