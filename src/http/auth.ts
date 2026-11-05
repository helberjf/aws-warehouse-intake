import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const principalSchema = z
  .object({
    subject: z.string().min(1).max(256),
    organizationId: identifier,
    producerId: identifier,
    warehouseIds: z.array(identifier).max(1000),
    roles: z
      .array(z.enum(['receiving', 'admin']))
      .min(1)
      .max(2),
  })
  .strict();
export type Principal = z.infer<typeof principalSchema>;
export type Authenticator = (authorization: string | undefined) => Promise<Principal>;
export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}
export type AuthConfig = {
  environment: 'local' | 'production';
  issuer: string;
  audience: string;
  jwksUrl?: string;
  localSecret?: string;
};

/** Only trusted deployment configuration selects keys; JWT headers cannot choose a key URL. */
export function createAuthenticator(config: AuthConfig): Authenticator {
  if (!config.issuer || !config.audience) throw new Error('JWT issuer and audience are required');
  if (config.environment !== 'local' && config.environment !== 'production') {
    throw new Error('Unknown authentication environment');
  }
  let key;
  let algorithms: string[];
  if (config.environment === 'local') {
    if (!config.localSecret || Buffer.byteLength(config.localSecret) < 32) {
      throw new Error('Local JWT secret must contain at least 32 bytes');
    }
    key = new TextEncoder().encode(config.localSecret);
    algorithms = ['HS256'];
  } else {
    if (config.localSecret) throw new Error('Local JWT secrets are forbidden in production');
    if (!config.jwksUrl) throw new Error('Production JWT JWKS URL is required');
    const url = new URL(config.jwksUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Production JWKS URL must use HTTPS without embedded credentials');
    }
    key = createRemoteJWKSet(url, { timeoutDuration: 5000 });
    algorithms = ['RS256'];
  }
  return async (authorization) => {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
    if (!match) throw new AuthenticationError('Invalid credentials');
    try {
      const { payload } = await jwtVerify(match[1], key, {
        algorithms,
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['exp', 'sub', 'iat'],
        clockTolerance: 5,
      });
      if (typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 5) {
        throw new AuthenticationError('Invalid issue time');
      }
      return principalSchema.parse({
        subject: payload.sub,
        organizationId: payload.organizationId,
        producerId: payload.producerId,
        warehouseIds: payload.warehouseIds,
        roles: payload.roles,
      });
    } catch {
      throw new AuthenticationError('Invalid credentials');
    }
  };
}

export function authorizeWarehouse(principal: Principal, warehouseId: string): void {
  if (!principal.warehouseIds.includes(warehouseId)) throw new AuthorizationError('Warehouse access denied');
}

export function authorizeAdmin(principal: Principal): void {
  if (!principal.roles.includes('admin')) throw new AuthorizationError('Administrator access required');
}
