/**
 * JWT parsing utility
 * Extracts claims from JWT tokens without verification
 */
export interface JwtPayload {
    audience: string;
    expiresAt: number;
    scopes?: string[];
}
/**
 * Parse a JWT token and extract common claims
 * @param token - JWT token string
 * @returns Parsed payload or null if invalid
 */
export declare function parseJwt(token: string): JwtPayload | null;
//# sourceMappingURL=jwt.d.ts.map