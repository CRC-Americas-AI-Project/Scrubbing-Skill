/**
 * Core types for the SAP Auth package
 */

// ============================================================================
// Auth Method Types
// ============================================================================

/**
 * The authentication method/strategy type
 */
export type AuthMethodType = 'sap-sso' | 'oauth' | 'api-token';

/**
 * Credential types returned to MCPs
 */
export type CredentialType = 'cookie' | 'bearer' | 'api-token';

/**
 * Credentials object returned to MCPs for making authenticated requests
 */
export interface Credentials {
  /** The type of credential */
  type: CredentialType;
  /** The credential value (cookie string, bearer token, or api token) */
  value: string;
  /** When the credential expires (null for api-token) */
  expiresAt: Date | null;
}

// ============================================================================
// Provider Configuration
// ============================================================================

/**
 * Configuration for an auth provider (wiki, jira, teams, etc.)
 * Domain is the storage key — no separate id field.
 */
export interface ProviderConfig {
  /** Domain — also used as storage key */
  domain: string;
  /** Auth method: 'sap-sso' (browser→cookies), 'oauth' (browser→tokens), 'api-token' (PAT required) */
  method: AuthMethodType;
  /** Entry URL for browser auth. Defaults to https://${domain}/ */
  entryUrl?: string;
  /** Token audience for OAuth providers (e.g., 'https://graph.microsoft.com') */
  tokenAudience?: string;
  /** Additional token audiences to extract */
  additionalAudiences?: string[];
  /** Instructions appended to PAT error (e.g., "Create at: https://...") */
  setupInstructions?: string;
  /**
   * Custom auth failure detection for `authClient.fetch()`.
   * Receives a cloned Response — safe to read body without consuming the original.
   * Default: `response.status === 401`.
   */
  isAuthFailure?: (response: Response) => Promise<boolean>;
}

// ============================================================================
// Storage Types
// ============================================================================

/**
 * Cookie as stored in auth.json
 */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * OAuth token as stored in auth.json
 */
export interface StoredToken {
  token: string;
  audience: string;
  expiresAt: number; // Unix timestamp in seconds
  scopes: string[];
}

/**
 * MSAL-style refresh token data
 * Refresh tokens are scoped per client ID, not per audience
 */
export interface StoredRefreshToken {
  /** The refresh token secret */
  secret: string;
  /** The OAuth client ID this token is for */
  clientId: string;
  /** Home account ID (user identifier) */
  homeAccountId: string;
  /** Azure AD environment (e.g., login.windows.net) */
  environment: string;
  /** When the refresh token expires (Unix timestamp in seconds, typically ~24h) */
  expiresOn?: number;
}

/**
 * Base stored auth data
 */
export interface StoredAuthBase {
  method: AuthMethodType;
  updatedAt: string; // ISO date string
}

/**
 * SAP SSO auth data (cookie-based)
 */
export interface StoredSapSsoAuth extends StoredAuthBase {
  method: 'sap-sso';
  cookies: StoredCookie[];
}

/**
 * OAuth auth data (token-based with optional refresh)
 * Also stores cookies from the auth session (useful for Teams)
 */
export interface StoredOAuthAuth extends StoredAuthBase {
  method: 'oauth';
  tokens: StoredToken[];
  cookies?: StoredCookie[];
  /** MSAL-style refresh token for silent token renewal */
  refreshToken?: StoredRefreshToken;
  /** MSAL account info for token refresh */
  account?: {
    homeAccountId: string;
    environment: string;
    tenantId: string;
    username: string;
    name?: string;
  };
}

/**
 * API Token auth data (static token)
 */
export interface StoredApiTokenAuth extends StoredAuthBase {
  method: 'api-token';
  token: string;
}

/**
 * Union type for all stored auth data
 */
export type StoredAuth = StoredSapSsoAuth | StoredOAuthAuth | StoredApiTokenAuth;

/**
 * The complete auth.json file structure
 */
export interface AuthStorage {
  version: number;
  providers: Record<string, StoredAuth>;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base auth error
 */
export class AuthError extends Error {
  /** Diagnostic trace of auth flow steps, attached on failure */
  public flowSummary?: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly providerId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AuthError';
  }
}

/**
 * Thrown when auth is not configured for a provider
 */
export class AuthNotConfiguredError extends AuthError {
  constructor(
    providerId: string,
    public readonly instructions?: string,
  ) {
    super(
      `Authentication not configured for provider: ${providerId}`,
      'AUTH_NOT_CONFIGURED',
      providerId,
    );
    this.name = 'AuthNotConfiguredError';
  }
}

/**
 * Thrown when stored auth is expired and refresh failed
 */
export class AuthExpiredError extends AuthError {
  constructor(providerId: string) {
    super(
      `Authentication expired for provider: ${providerId}`,
      'AUTH_EXPIRED',
      providerId,
    );
    this.name = 'AuthExpiredError';
  }
}

/**
 * Thrown when browser auth fails
 */
export class AuthBrowserError extends AuthError {
  constructor(providerId: string, reason: string, options?: { cause?: unknown }) {
    super(
      `Browser authentication failed for ${providerId}: ${reason}`,
      'AUTH_BROWSER_FAILED',
      providerId,
      options,
    );
    this.name = 'AuthBrowserError';
  }
}

/**
 * Thrown when API token needs to be provided by user
 */
export class ApiTokenRequiredError extends AuthError {
  constructor(
    providerId: string,
    public readonly instructions: string,
  ) {
    super(
      `API token required for provider: ${providerId}. ${instructions}`,
      'API_TOKEN_REQUIRED',
      providerId,
    );
    this.name = 'ApiTokenRequiredError';
  }
}

// ============================================================================
// Status Types
// ============================================================================

/**
 * Auth status for a provider
 */
export interface AuthStatus {
  domain: string;
  configured: boolean;
  valid: boolean;
  method: AuthMethodType | null;
  expiresAt: Date | null;
  expiresInMinutes: number | null;
}
