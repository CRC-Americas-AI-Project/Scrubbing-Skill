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
export function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Decode base64url to base64
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad) base64 += '='.repeat(4 - pad);

    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

    return {
      audience: payload.aud || '',
      expiresAt: payload.exp || 0,
      scopes: payload.scp ? payload.scp.split(' ') : undefined,
    };
  } catch {
    return null;
  }
}
