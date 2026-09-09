/**
 * API Token authentication method (static tokens)
 * Used for services that support API tokens/PAT (Personal Access Tokens)
 */

import type {
  Credentials,
  ProviderConfig,
  StoredApiTokenAuth,
} from '../types.js';
import { ApiTokenRequiredError } from '../types.js';
import { AuthMethod } from './base.js';

/**
 * API Token authentication
 * Tokens are provided by the user and don't expire (or expire very far in future)
 */
export class ApiTokenMethod extends AuthMethod<StoredApiTokenAuth> {
  /**
   * Validate stored API token
   * Just checks if token exists - API tokens don't typically expire
   */
  async validate(stored: StoredApiTokenAuth | null): Promise<boolean> {
    if (!stored || stored.method !== 'api-token') {
      return false;
    }

    return !!stored.token && stored.token.length > 0;
  }

  /**
   * Convert API token to credentials
   */
  toCredentials(stored: StoredApiTokenAuth): Credentials {
    return {
      type: 'api-token',
      value: stored.token,
      expiresAt: null, // API tokens don't expire
    };
  }

  /**
   * API tokens can't be refreshed - they're static
   */
  async refresh(
    _stored: StoredApiTokenAuth | null,
    _config: ProviderConfig,
  ): Promise<StoredApiTokenAuth | null> {
    return null;
  }

  /**
   * "Authenticate" for API tokens means telling the user to provide one via sap_add_pat
   */
  async authenticate(config: ProviderConfig): Promise<StoredApiTokenAuth> {
    const instructions = `No PAT found for ${config.domain}. Store one with: sap_add_pat(domain="${config.domain}", token="YOUR_TOKEN")`;
    const extra = config.setupInstructions ? `\n${config.setupInstructions}` : '';
    throw new ApiTokenRequiredError(config.domain, instructions + extra);
  }

  /**
   * API tokens don't expire
   */
  getExpiresAt(_stored: StoredApiTokenAuth): Date | null {
    return null;
  }
}
