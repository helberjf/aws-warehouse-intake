import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthenticationError, AuthorizationError } from '../src/http/auth.ts';
import { hashPassword, verifyPassword } from '../src/identity/password.ts';
import { registerSessionRoutes } from '../src/identity/http.ts';
import { LoginRateLimitError, type IdentityService } from '../src/identity/service.ts';

test('passwords use independent salts and verification rejects wrong or unknown users', async () => {
  const first = await hashPassword('a-strong-test-password'),
    second = await hashPassword('a-strong-test-password');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.digest, second.digest);
  assert.equal(await verifyPassword('a-strong-test-password', first), true);
  assert.equal(await verifyPassword('incorrect-password', first), false);
  assert.equal(await verifyPassword('a-strong-test-password'), false);
  assert.equal(JSON.stringify(first).includes('a-strong-test-password'), false);
  await assert.rejects(hashPassword('short'));
});

async function fixture(environment: 'local' | 'production' = 'production') {
  const principal = {
    subject: 'user-1',
    displayName: 'Warehouse Operator',
    organizationId: 'ORG',
    producerId: 'web',
    warehouseIds: ['WH-01'],
    roles: ['receiving'] as ('receiving' | 'admin')[],
  };
  const token = 'a'.repeat(43),
    csrf = 'b'.repeat(43);
  const state = { loggedOut: false, rateLimited: false, changed: false };
  const session = {
    user: principal,
    csrfToken: csrf,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    userKey: 'USER#test',
    credentialVersion: 'version',
  };
  const service = {
    login: async () => {
      if (state.rateLimited) throw new LoginRateLimitError();
      return { token, session };
    },
    authenticate: async (value: string) => {
      if (value !== token || state.loggedOut) throw new AuthenticationError();
      return session;
    },
    logout: async () => {
      state.loggedOut = true;
    },
    changePassword: async () => {
      state.changed = true;
      state.loggedOut = true;
    },
  } as unknown as IdentityService;
  const app = Fastify();
  app.setErrorHandler((error, request, reply) =>
    reply
      .code(error instanceof AuthorizationError ? 403 : error instanceof AuthenticationError ? 401 : 400)
      .send({ error: 'rejected' }),
  );
  const origin = environment === 'production' ? 'https://warehouse.example' : 'http://localhost:3000';
  const browser = await registerSessionRoutes(app, service, { environment, publicOrigin: origin });
  app.post('/private', async (request) => browser.authenticateBrowser(request));
  return {
    app,
    state,
    origin,
    token,
    csrf,
    cookie: `${environment === 'production' ? '__Host-warehouse_session' : 'warehouse_session'}=${token}`,
  };
}

test('production login uses opaque secure HttpOnly cookie and never exposes session token in JSON', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const response = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: f.origin },
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['set-cookie'] as string, /^__Host-warehouse_session=/);
  assert.match(response.headers['set-cookie'] as string, /HttpOnly/);
  assert.match(response.headers['set-cookie'] as string, /SameSite=Strict/);
  assert.match(response.headers['set-cookie'] as string, /; Secure/);
  assert.equal(response.body.includes(f.token), false);
  assert.equal(response.json().csrfToken, f.csrf);
});
test('login blocks missing, foreign and sibling-site origins; rate limiting returns429', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  for (const headers of [
    {},
    { origin: 'https://attacker.example' },
    { origin: f.origin, 'sec-fetch-site': 'same-site' },
  ]) {
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/auth/login', headers, payload: {} })).statusCode,
      403,
    );
  }
  f.state.rateLimited = true;
  const response = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: f.origin },
    payload: {},
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '900');
});
test('cookie mutations need exact origin and synchronizer CSRF token', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  for (const headers of [
    { cookie: f.cookie },
    { cookie: f.cookie, origin: f.origin },
    { cookie: f.cookie, origin: f.origin, 'x-csrf-token': 'wrong' },
    { cookie: f.cookie, origin: 'https://attacker.example', 'x-csrf-token': f.csrf },
  ]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/private', headers })).statusCode, 403);
  }
  const valid = await f.app.inject({
    method: 'POST',
    url: '/private',
    headers: { cookie: f.cookie, origin: f.origin, 'x-csrf-token': f.csrf },
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().subject, 'user-1');
  const duplicate = await f.app.inject({
    url: '/auth/session',
    headers: { cookie: `${f.cookie}; ${f.cookie}` },
  });
  assert.equal(duplicate.statusCode, 401);
});
test('logout revokes the session and clears the same cookie scope', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const headers = { cookie: f.cookie, origin: f.origin, 'x-csrf-token': f.csrf };
  assert.equal((await f.app.inject({ url: '/auth/session', headers })).statusCode, 200);
  const logout = await f.app.inject({ method: 'POST', url: '/auth/logout', headers });
  assert.equal(logout.statusCode, 204);
  assert.match(logout.headers['set-cookie'] as string, /Max-Age=0/);
  assert.equal((await f.app.inject({ url: '/auth/session', headers })).statusCode, 401);
});
test('production sessions refuse insecure or non-origin configuration', async () => {
  for (const publicOrigin of [
    'http://warehouse.example',
    'https://warehouse.example/path',
    'https://warehouse.example/',
  ]) {
    const app = Fastify();
    try {
      await assert.rejects(
        registerSessionRoutes(app, {} as IdentityService, { environment: 'production', publicOrigin }),
      );
    } finally {
      await app.close();
    }
  }
});
