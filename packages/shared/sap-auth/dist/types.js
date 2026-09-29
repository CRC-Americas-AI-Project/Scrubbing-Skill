/**
 * Core types for the SAP Auth package
 */
// ============================================================================
// Error Types
// ============================================================================
/**
 * Base auth error
 */
export class AuthError extends Error {
    code;
    providerId;
    /** Diagnostic trace of auth flow steps, attached on failure */
    flowSummary;
    constructor(message, code, providerId, options) {
        super(message, options);
        this.code = code;
        this.providerId = providerId;
        this.name = 'AuthError';
    }
}
/**
 * Thrown when auth is not configured for a provider
 */
export class AuthNotConfiguredError extends AuthError {
    instructions;
    constructor(providerId, instructions) {
        super(`Authentication not configured for provider: ${providerId}`, 'AUTH_NOT_CONFIGURED', providerId);
        this.instructions = instructions;
        this.name = 'AuthNotConfiguredError';
    }
}
/**
 * Thrown when stored auth is expired and refresh failed
 */
export class AuthExpiredError extends AuthError {
    constructor(providerId) {
        super(`Authentication expired for provider: ${providerId}`, 'AUTH_EXPIRED', providerId);
        this.name = 'AuthExpiredError';
    }
}
/**
 * Thrown when browser auth fails
 */
export class AuthBrowserError extends AuthError {
    constructor(providerId, reason, options) {
        super(`Browser authentication failed for ${providerId}: ${reason}`, 'AUTH_BROWSER_FAILED', providerId, options);
        this.name = 'AuthBrowserError';
    }
}
/**
 * Thrown when API token needs to be provided by user
 */
export class ApiTokenRequiredError extends AuthError {
    instructions;
    constructor(providerId, instructions) {
        super(`API token required for provider: ${providerId}. ${instructions}`, 'API_TOKEN_REQUIRED', providerId);
        this.instructions = instructions;
        this.name = 'ApiTokenRequiredError';
    }
}
//# sourceMappingURL=types.js.map