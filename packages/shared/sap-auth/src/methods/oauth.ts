/**
 * OAuth authentication method (token-based)
 * Used for Teams, Graph API, and other OAuth2 systems
 *
 * Supports silent token refresh using MSAL-compatible refresh tokens
 */

import type {
  Credentials,
  ProviderConfig,
  StoredOAuthAuth,
  StoredToken,
} from '../types.js';
import { AuthExpiredError, AuthError } from '../types.js';
import { AuthMethod } from './base.js';
import { BrowserAuthenticator } from '../browser/authenticator.js';
import { runDeviceCodeFlow } from './device-code.js';
import { parseJwt } from '../utils/jwt.js';

// Token expiry threshold (refresh if less than this remaining)
const TOKEN_EXPIRY_BUFFER_S = 5 * 60; // 5 minutes in seconds

// Microsoft OAuth token endpoint
const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/**
 * OAuth authentication using tokens
 */
export class OAuthMethod extends AuthMethod<StoredOAuthAuth> {
  /**
   * Validate stored tokens
   */
  async validate(stored: StoredOAuthAuth | null): Promise<boolean> {
    if (!stored || stored.method !== 'oauth') {
      return false;
    }

    if (!stored.tokens || stored.tokens.length === 0) {
      return false;
    }

    // Check if at least one token is still valid
    const now = Math.floor(Date.now() / 1000);
    return stored.tokens.some(
      (token) => token.expiresAt > now + TOKEN_EXPIRY_BUFFER_S,
    );
  }

  /**
   * Convert tokens to credentials
   * Returns the first valid token as a bearer credential
   */
  toCredentials(stored: StoredOAuthAuth): Credentials {
    const now = Math.floor(Date.now() / 1000);

    // Find first valid token
    const validToken = stored.tokens.find(
      (t) => t.expiresAt > now + TOKEN_EXPIRY_BUFFER_S,
    );

    if (!validToken) {
      throw new AuthExpiredError('oauth');
    }

    return {
      type: 'bearer',
      value: validToken.token,
      expiresAt: new Date(validToken.expiresAt * 1000),
    };
  }

  /**
   * Get token for a specific audience
   */
  getTokenForAudience(
    stored: StoredOAuthAuth,
    audience: string,
  ): Credentials | null {
    const now = Math.floor(Date.now() / 1000);

    const token = stored.tokens.find(
      (t) =>
        t.audience.toLowerCase().includes(audience.toLowerCase()) &&
        t.expiresAt > now + TOKEN_EXPIRY_BUFFER_S,
    );

    if (!token) {
      return null;
    }

    return {
      type: 'bearer',
      value: token.token,
      expiresAt: new Date(token.expiresAt * 1000),
    };
  }

  /**
   * Try to silently refresh tokens using stored refresh token.
   * Returns null if refresh fails (caller should fall back to browser auth).
   */
  async refresh(
    stored: StoredOAuthAuth | null,
    config: ProviderConfig,
  ): Promise<StoredOAuthAuth | null> {
    if (!stored?.refreshToken?.secret) {
      return null;
    }

    const refreshToken = stored.refreshToken;

    // Check if refresh token itself is expired
    if (refreshToken.expiresOn) {
      const now = Math.floor(Date.now() / 1000);
      if (refreshToken.expiresOn <= now) {
        return null;
      }
    }

    // Collect all audiences we need tokens for
    const audiences = [
      config.tokenAudience,
      ...(config.additionalAudiences || []),
    ].filter(Boolean) as string[];

    const newTokens: StoredToken[] = [];
    let latestRefreshToken: string | undefined;

    // Request new access token for each audience
    for (const audience of audiences) {
      try {
        const result = await this.requestAccessToken(
          refreshToken.clientId,
          refreshToken.secret,
          audience,
        );

        if (result) {
          newTokens.push(result.accessToken);
          if (result.newRefreshToken) {
            latestRefreshToken = result.newRefreshToken;
          }
        }
      } catch {
        // Continue trying other audiences
      }
    }

    if (newTokens.length === 0) {
      return null;
    }

    // Update refresh token if Microsoft rotated it
    const updatedRefreshToken = latestRefreshToken
      ? {
          ...refreshToken,
          secret: latestRefreshToken,
          expiresOn: Math.floor(Date.now() / 1000) + 86400,
        }
      : stored.refreshToken;

    return {
      method: 'oauth',
      tokens: newTokens,
      cookies: stored.cookies,
      refreshToken: updatedRefreshToken,
      account: stored.account,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Request a new access token using the refresh token
   */
  private async requestAccessToken(
    clientId: string,
    refreshToken: string,
    audience: string,
  ): Promise<{ accessToken: StoredToken; newRefreshToken?: string } | null> {
    const scope = `${audience}/.default offline_access`;

    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scope,
    });

    const response = await fetch(MICROSOFT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Headers to mimic browser CORS request (required for SPA tokens)
        'Origin': 'https://teams.microsoft.com',
        'Referer': 'https://teams.microsoft.com/',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();

    if (!data.access_token) {
      throw new Error('No access_token in response');
    }

    const tokenInfo = parseJwt(data.access_token);

    return {
      accessToken: {
        token: data.access_token,
        audience: tokenInfo?.audience || audience,
        expiresAt: data.expires_in
          ? Math.floor(Date.now() / 1000) + data.expires_in
          : tokenInfo?.expiresAt || Math.floor(Date.now() / 1000) + 3600,
        scopes: data.scope ? data.scope.split(' ') : [],
      },
      newRefreshToken: data.refresh_token,
    };
  }

  /**
   * Authenticate using browser token extraction, falling back to device code flow
   * if the browser cannot extract MSAL tokens (e.g., teams.cloud.microsoft uses
   * encrypted MSAL cache that Puppeteer cannot read).
   */
  async authenticate(config: ProviderConfig): Promise<StoredOAuthAuth> {
    const authenticator = new BrowserAuthenticator();

    const audiences = [config.tokenAudience, ...(config.additionalAudiences || [])].filter(
      Boolean,
    ) as string[];

    try {
      const result = await authenticator.authenticateOAuth(
        config.entryUrl || `https://${config.domain}/`,
        config.domain,
        audiences,
      );

      if (result.tokens && result.tokens.length > 0) {
        return {
          method: 'oauth',
          tokens: result.tokens,
          cookies: result.cookies,
          refreshToken: result.refreshToken,
          account: result.account,
          updatedAt: new Date().toISOString(),
        };
      }
    } catch {
      // Browser auth failed — fall through to device code
    } finally {
      await authenticator.close();
    }

    // Browser token extraction failed — use device code flow
    const dcResult = await runDeviceCodeFlow(audiences);

    if (!dcResult.tokens || dcResult.tokens.length === 0) {
      throw new AuthError(
        `Authentication failed: no tokens obtained via browser or device code for ${config.domain}`,
        'TOKEN_EXTRACTION_FAILED',
        config.domain,
      );
    }

    return {
      method: 'oauth',
      tokens: dcResult.tokens,
      cookies: [],
      refreshToken: dcResult.refreshToken,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get earliest expiration time from all tokens
   */
  getExpiresAt(stored: StoredOAuthAuth): Date | null {
    if (!stored.tokens || stored.tokens.length === 0) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const validTokens = stored.tokens.filter((t) => t.expiresAt > now);

    if (validTokens.length === 0) {
      return null;
    }

    const earliestExpiry = Math.min(...validTokens.map((t) => t.expiresAt));
    return new Date(earliestExpiry * 1000);
  }
}
