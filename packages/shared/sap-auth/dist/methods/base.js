/**
 * Base class for authentication methods
 *
 * Methods are stateless building blocks — they define HOW to validate,
 * convert, refresh, and authenticate for a given auth type.
 * AuthManager handles WHEN and in what order to call them,
 * and owns all storage I/O.
 */
/**
 * Abstract base class for authentication methods
 * Each auth method (sap-sso, oauth, api-token) extends this
 */
export class AuthMethod {
}
//# sourceMappingURL=base.js.map