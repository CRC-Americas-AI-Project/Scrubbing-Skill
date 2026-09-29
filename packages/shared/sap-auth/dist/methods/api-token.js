/**
 * API Token authentication method (static tokens)
 * Used for services that support API tokens/PAT (Personal Access Tokens)
 */
import { ApiTokenRequiredError } from '../types.js';
import { AuthMethod } from './base.js';
/**
 * API Token authentication
 * Tokens are provided by the user and don't expire (or expire very far in future)
 */
export class ApiTokenMethod extends AuthMethod {
    /**
     * Validate stored API token
     * Just checks if token exists - API tokens don't typically expire
     */
    async validate(stored) {
        if (!stored || stored.method !== 'api-token') {
            return false;
        }
        return !!stored.token && stored.token.length > 0;
    }
    /**
     * Convert API token to credentials
     */
    toCredentials(stored) {
        return {
            type: 'api-token',
            value: stored.token,
            expiresAt: null, // API tokens don't expire
        };
    }
    /**
     * API tokens can't be refreshed - they're static
     */
    async refresh(_stored, _config) {
        return null;
    }
    /**
     * "Authenticate" for API tokens means telling the user to provide one via sap_add_pat
     */
    async authenticate(config) {
        const instructions = `No PAT found for ${config.domain}. Store one with: sap_add_pat(domain="${config.domain}", token="YOUR_TOKEN")`;
        const extra = config.setupInstructions ? `\n${config.setupInstructions}` : '';
        throw new ApiTokenRequiredError(config.domain, instructions + extra);
    }
    /**
     * API tokens don't expire
     */
    getExpiresAt(_stored) {
        return null;
    }
}
//# sourceMappingURL=api-token.js.map