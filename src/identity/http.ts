import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthenticationError, AuthorizationError } from '../http/auth.ts';
import { LoginRateLimitError, type IdentityService, type AuthenticatedSession } from './service.ts';

type Options = { environment: 'local' | 'production'; publicOrigin: string };
const unsafe = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
function publicSession(session: AuthenticatedSession) {
  return {
    user: session.user,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  };
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  service: IdentityService,
  options: Options,
) {
  const origin = new URL(options.publicOrigin);
  if (
    origin.origin !== options.publicOrigin ||
    origin.username ||
    origin.password ||
    !['http:', 'https:'].includes(origin.protocol)
  )
    throw new Error('PUBLIC_ORIGIN must be an exact HTTP(S) origin without path');
  if (options.environment === 'production' && origin.protocol !== 'https:')
    throw new Error('Production sessions require HTTPS');
  const cookieName = options.environment === 'production' ? '__Host-warehouse_session' : 'warehouse_session';
  const suffix = `Path=/; HttpOnly; SameSite=Strict${options.environment === 'production' ? '; Secure' : ''}`;
  function cookie(request: FastifyRequest): string | undefined {
    const matches = (request.headers.cookie ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    if (matches.length > 1) throw new AuthenticationError('Invalid session');
    return matches[0]?.slice(cookieName.length + 1);
  }
  function checkOrigin(request: FastifyRequest) {
    if (request.headers.origin !== options.publicOrigin)
      throw new AuthorizationError('Untrusted request origin');
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none')
      throw new AuthorizationError('Untrusted request origin');
  }
  async function sessionFor(request: FastifyRequest) {
    const token = cookie(request);
    if (!token) throw new AuthenticationError('A session is required');
    const session = await service.authenticate(token);
    if (unsafe(request.method)) {
      checkOrigin(request);
      const supplied = request.headers['x-csrf-token'];
      const expected = Buffer.from(session.csrfToken);
      if (
        typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), expected)
      )
        throw new AuthorizationError('Invalid CSRF token');
    }
    return { token, session };
  }
  app.post('/auth/login', async (request, reply) => {
    checkOrigin(request);
    try {
      const { token, session } = await service.login(request.body, request.ip);
      reply.header('Set-Cookie', `${cookieName}=${token}; Max-Age=28800; ${suffix}`);
      return publicSession(session);
    } catch (error) {
      if (error instanceof LoginRateLimitError)
        return reply
          .code(429)
          .header('Retry-After', '900')
          .send({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } });
      throw error;
    }
  });
  app.get('/auth/session', async (request) => publicSession((await sessionFor(request)).session));
  app.post('/auth/logout', async (request, reply) => {
    const { token } = await sessionFor(request);
    await service.logout(token);
    return reply.header('Set-Cookie', `${cookieName}=; Max-Age=0; ${suffix}`).code(204).send();
  });
  app.post('/auth/password', async (request, reply) => {
    const { token } = await sessionFor(request);
    const body = z
      .object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) })
      .strict()
      .parse(request.body);
    try {
      await service.changePassword(token, body.currentPassword, body.newPassword);
    } catch (error) {
      if (error instanceof LoginRateLimitError)
        return reply
          .code(429)
          .header('Retry-After', '900')
          .send({ error: { code: 'RATE_LIMITED', message: 'Too many password attempts. Try again later.' } });
      throw error;
    }
    return reply.header('Set-Cookie', `${cookieName}=; Max-Age=0; ${suffix}`).code(204).send();
  });
  return {
    authenticateBrowser: async (request: FastifyRequest) => (await sessionFor(request)).session.user,
    hasSessionCookie: (request: FastifyRequest) => cookie(request) !== undefined,
  };
}
