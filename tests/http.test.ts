import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createApp } from '../src/http/app.ts';
import { createAuthenticator } from '../src/http/auth.ts';
import type { Principal } from '../src/http/auth.ts';
import { ConflictError, EligibilityError } from '../src/application/ports.ts';
import type { IntakeStore, LedgerEntry, Product, Warehouse } from '../src/application/ports.ts';
import type { IdentityService } from '../src/identity/service.ts';

const secret = 'local-test-signing-secret-at-least-32-bytes';
const principal: Principal = {
  subject: 'operator-1',
  organizationId: 'ORG-A',
  producerId: 'ERP',
  warehouseIds: ['WH-A'],
  roles: ['receiving'],
};
const body = {
  mode: 'BULK',
  skuId: 'BOX',
  quantity: 20,
  externalReference: 'DELIVERY-1',
  occurredAt: '2026-11-05T12:00:00Z',
};
const auth = createAuthenticator({
  environment: 'local',
  issuer: 'local-test',
  audience: 'warehouse',
  localSecret: secret,
});
async function token(overrides: Record<string, unknown> = {}, signingSecret = secret) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    organizationId: principal.organizationId,
    producerId: principal.producerId,
    warehouseIds: principal.warehouseIds,
    roles: principal.roles,
    sub: principal.subject,
    iat: now,
    exp: now + 600,
    iss: 'local-test',
    aud: 'warehouse',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(signingSecret));
}
function store() {
  const ledger = new Map<string, LedgerEntry>();
  const products = new Map<string, Product>([['BOX', { skuId: 'BOX', trackingMode: 'BULK', active: true }]]);
  const warehouses = new Map<string, Warehouse>();
  const calls: unknown[][] = [];
  const implementation: IntakeStore = {
    getProduct: async (_org, sku) => products.get(sku),
    listProducts: async () => ({ items: [...products.values()] }),
    findProductByCode: async (_org, code) =>
      products.get(code) ?? [...products.values()].find((product) => product.barcode === code),
    listStock: async () => ({ items: [{ skuId: 'BOX', quantity: 20 }] }),
    putProduct: async (org, product) => {
      calls.push(['product', org, product]);
      products.set(product.skuId, product);
    },
    getWarehouse: async (_org, id) => warehouses.get(id),
    putWarehouse: async (org, warehouse) => {
      calls.push(['warehouse', org, warehouse]);
      warehouses.set(warehouse.warehouseId, warehouse);
    },
    accept: async (command) => {
      const previous = ledger.get(command.entryId);
      if (previous && previous.payloadHash !== command.payloadHash) throw new ConflictError();
      const record = previous ?? {
        ...command,
        status: 'ACCEPTED' as const,
        acceptedAt: new Date().toISOString(),
      };
      ledger.set(record.entryId, record);
      return record;
    },
    getEntry: async (id) => ledger.get(id),
    listEntries: async (org, warehouse, limit, cursor) => {
      calls.push(['history', org, warehouse, limit, cursor]);
      return { items: [...ledger.values()] };
    },
    getBalances: async (org, warehouse, sku, limit, cursor) => {
      calls.push(['balance', org, warehouse, sku, limit, cursor]);
      return { items: [{ skuId: sku, quantity: 20 }] };
    },
    apply: async () => {},
  };
  return { implementation, ledger, calls };
}
async function fixture(t: test.TestContext) {
  const data = store();
  const app = await createApp({ store: data.implementation, auth, logger: false });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${await token()}`, 'idempotency-key': 'attempt-1' };
  return { ...data, app, headers };
}
test('product and receiving attribution comes from verified identity, never caller audit fields', async (t) => {
  const { app, implementation } = await fixture(t);
  const headers = {
    authorization: `Bearer ${await token({ roles: ['admin'], name: 'Ana Operadora' })}`,
    'idempotency-key': 'actor-test',
  };
  let actor: unknown;
  const original = implementation.putProduct;
  implementation.putProduct = async (org, product, verified) => {
    actor = verified;
    await original(org, product, verified);
  };
  const product = await app.inject({
    method: 'PUT',
    url: '/products/AUDIT',
    headers,
    payload: { name: 'Produto auditado', barcode: '12345678', trackingMode: 'BULK', active: true },
  });
  assert.equal(product.statusCode, 200);
  assert.deepEqual(actor, { subject: 'operator-1', displayName: 'Ana Operadora' });
  const entry = await app.inject({
    method: 'POST',
    url: '/warehouses/WH-A/receiving-entries',
    headers,
    payload: body,
  });
  assert.deepEqual(entry.json().recordedBy, { subject: 'operator-1', displayName: 'Ana Operadora' });
  const forged = await app.inject({
    method: 'PUT',
    url: '/products/AUDIT',
    headers,
    payload: { trackingMode: 'BULK', active: true, createdBy: { subject: 'someone-else' } },
  });
  assert.equal(forged.statusCode, 400);
});
test('session persistence outages return server errors rather than expiring valid browser credentials', async (t) => {
  const app = await createApp({
    store: store().implementation,
    auth,
    logger: false,
    sessions: {
      environment: 'local',
      publicOrigin: 'http://localhost:3000',
      service: {
        authenticate: async () => {
          throw new Error('storage unavailable');
        },
      } as unknown as IdentityService,
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    url: '/products',
    headers: { cookie: 'warehouse_session=opaque-session' },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('storage unavailable'), false);
});

test('acceptance derives ownership from verified JWT and exposes status URL without internal hashes', async (t) => {
  const { app, headers, ledger } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/warehouses/WH-A/receiving-entries',
    headers,
    payload: body,
  });
  assert.equal(response.statusCode, 202);
  const result = response.json();
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(result.quantity, 20);
  assert.equal(result.payloadHash, undefined);
  assert.equal(result.idempotencyRecordId, undefined);
  assert.equal(ledger.get(result.entryId)?.organizationId, 'ORG-A');
  const status = await app.inject({ url: response.headers.location!, headers });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().entryId, result.entryId);
  assert.equal(status.headers['cache-control'], 'no-store');
});

test('same business reference with changed quantity returns409, exact retry replays same ID', async (t) => {
  const { app, headers } = await fixture(t);
  const send = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/warehouses/WH-A/receiving-entries', headers, payload });
  const first = await send(body);
  const repeat = await send(body);
  assert.equal(first.json().entryId, repeat.json().entryId);
  assert.equal((await send({ ...body, quantity: 21 })).statusCode, 409);
});

test('untrusted ownership fields and missing idempotency key fail before acceptance', async (t) => {
  const { app, headers, ledger } = await fixture(t);
  for (const payload of [
    { ...body, organizationId: 'ORG-B' },
    { ...body, quantity: 1.5 },
    { ...body, serialNumber: 'unexpected' },
  ]) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/warehouses/WH-A/receiving-entries', headers, payload }))
        .statusCode,
      400,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/warehouses/WH-A/receiving-entries',
        headers: { authorization: headers.authorization },
        payload: body,
      })
    ).statusCode,
    400,
  );
  assert.equal(ledger.size, 0);
});

test('unauthenticated, forged, expired and wrong-scope JWTs fail closed', async (t) => {
  const { app } = await fixture(t);
  const invalid = [
    undefined,
    'Basic abc',
    `Bearer ${await token({}, 'a-different-signing-key-with-enough-bytes')}`,
  ];
  for (const claims of [
    { exp: Math.floor(Date.now() / 1000) - 30 },
    { iss: 'other' },
    { aud: 'other' },
    { organizationId: undefined },
    { warehouseIds: 'WH-A' },
    { roles: ['owner'] },
    { sub: undefined },
    { iat: undefined },
    { iat: Math.floor(Date.now() / 1000) + 300 },
    { nbf: Math.floor(Date.now() / 1000) + 300 },
  ]) {
    invalid.push(`Bearer ${await token(claims)}`);
  }
  for (const authorization of invalid) {
    const response = await app.inject({
      url: '/warehouses/WH-A/receiving-entries',
      headers: authorization ? { authorization } : {},
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
});

test('warehouse membership limits receiving, querying and administrative modifications', async (t) => {
  const { app, headers } = await fixture(t);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/warehouses/WH-B/receiving-entries', headers, payload: body }))
      .statusCode,
    403,
  );
  assert.equal((await app.inject({ url: '/warehouses/WH-B/stock/BOX', headers })).statusCode, 403);
  const admin = { authorization: `Bearer ${await token({ roles: ['admin'] })}` };
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/warehouses/WH-B',
        headers: admin,
        payload: { name: 'B', active: true },
      })
    ).statusCode,
    403,
  );
});

test('entry status hides entries owned by another organization or warehouse', async (t) => {
  const { app, headers, ledger } = await fixture(t);
  const first = await app.inject({
    method: 'POST',
    url: '/warehouses/WH-A/receiving-entries',
    headers,
    payload: body,
  });
  const entry = ledger.get(first.json().entryId)!;
  ledger.set(entry.entryId, { ...entry, organizationId: 'ORG-B' });
  assert.equal((await app.inject({ url: first.headers.location!, headers })).statusCode, 404);
  ledger.set(entry.entryId, { ...entry, warehouseId: 'WH-B' });
  assert.equal((await app.inject({ url: first.headers.location!, headers })).statusCode, 404);
});

test('catalog writes need administrator role; immutable-mode conflicts return409', async (t) => {
  const { app, headers, implementation, calls } = await fixture(t);
  const payload = { trackingMode: 'SERIALIZED', active: true };
  assert.equal(
    (await app.inject({ method: 'PUT', url: '/products/SCANNER', headers, payload })).statusCode,
    403,
  );
  const admin = { authorization: `Bearer ${await token({ roles: ['admin'] })}` };
  assert.equal(
    (await app.inject({ method: 'PUT', url: '/products/SCANNER', headers: admin, payload })).statusCode,
    200,
  );
  assert.deepEqual(calls[0], ['product', 'ORG-A', { skuId: 'SCANNER', ...payload }]);
  implementation.putProduct = async () => {
    throw new ConflictError();
  };
  assert.equal(
    (await app.inject({ method: 'PUT', url: '/products/SCANNER', headers: admin, payload })).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/warehouses/WH-A',
        headers: admin,
        payload: { name: ' Warehouse A ', active: true },
      })
    ).json().name,
    'Warehouse A',
  );
});

test('pagination is bounded and every query receives verified ownership scope', async (t) => {
  const { app, headers, calls } = await fixture(t);
  assert.equal(
    (await app.inject({ url: '/warehouses/WH-A/receiving-entries?limit=2&cursor=abc', headers })).statusCode,
    200,
  );
  assert.deepEqual(calls[0], ['history', 'ORG-A', 'WH-A', 2, 'abc']);
  assert.equal((await app.inject({ url: '/warehouses/WH-A/stock/BOX?limit=3', headers })).statusCode, 200);
  assert.deepEqual(calls[1], ['balance', 'ORG-A', 'WH-A', 'BOX', 3, undefined]);
  for (const query of ['limit=0', 'limit=101', 'limit=1.2', 'limit=no', 'cursor=%25', 'unknown=x']) {
    assert.equal(
      (await app.inject({ url: `/warehouses/WH-A/receiving-entries?${query}`, headers })).statusCode,
      400,
    );
  }
});

test('catalog eligibility and invalid storage cursors have stable client errors', async (t) => {
  const { app, headers, implementation } = await fixture(t);
  implementation.accept = async () => {
    throw new EligibilityError();
  };
  assert.equal(
    (await app.inject({ method: 'POST', url: '/warehouses/WH-A/receiving-entries', headers, payload: body }))
      .statusCode,
    409,
  );
  implementation.listEntries = async () => {
    throw new RangeError('Invalid pagination cursor');
  };
  assert.equal(
    (await app.inject({ url: '/warehouses/WH-A/receiving-entries?cursor=abc', headers })).statusCode,
    400,
  );
});

test('request size and parse limits are enforced; unexpected errors do not leak details', async (t) => {
  const { app, headers, implementation } = await fixture(t);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/warehouses/WH-A/receiving-entries',
        headers,
        payload: { ...body, externalReference: 'a'.repeat(17000) },
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/warehouses/WH-A/receiving-entries',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: '{broken',
      })
    ).statusCode,
    400,
  );
  implementation.getBalances = async () => {
    throw new Error('private AWS error / key details');
  };
  const response = await app.inject({ url: '/warehouses/WH-A/stock/BOX', headers });
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /private AWS/);
});

test('public health and specification work without credentials; readiness reports dependency failure', async (t) => {
  const app = await createApp({
    store: store().implementation,
    auth,
    logger: false,
    ready: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => app.close());
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/ready')).statusCode, 503);
  const spec = await app.inject('/openapi.json');
  assert.equal(spec.statusCode, 200);
  assert.equal(spec.json().openapi, '3.1.0');
  assert.ok(spec.json().paths['/warehouses/{warehouseId}/receiving-entries']);
  const receivingSchema = JSON.parse(
    await readFile(new URL('../schemas/receiving-entry.schema.json', import.meta.url), 'utf8'),
  );
  delete receivingSchema.$schema;
  assert.deepEqual(spec.json().components.schemas.ReceivingEntry, receivingSchema);
});

test('production configuration cannot silently enable local signing or insecure key endpoints', async () => {
  assert.throws(() =>
    createAuthenticator({
      environment: 'production',
      issuer: 'x',
      audience: 'x',
      localSecret: secret,
      jwksUrl: 'https://example.com/keys',
    }),
  );
  assert.throws(() => createAuthenticator({ environment: 'production', issuer: 'x', audience: 'x' }));
  assert.throws(() =>
    createAuthenticator({
      environment: 'production',
      issuer: 'x',
      audience: 'x',
      jwksUrl: 'http://example.com/keys',
    }),
  );
  assert.throws(() =>
    createAuthenticator({ environment: 'local', issuer: 'x', audience: 'x', localSecret: 'short' }),
  );
  assert.throws(() =>
    createAuthenticator({ environment: 'local', issuer: '', audience: 'x', localSecret: secret }),
  );
});

test('production verifies RS256 using only the configured JWKS and rejects algorithm substitution', async (t) => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-rsa-key', alg: 'RS256', use: 'sig' };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const verify = createAuthenticator({
    environment: 'production',
    issuer: 'https://id.example.test',
    audience: 'warehouse',
    jwksUrl: 'https://id.example.test/keys',
  });
  const signed = await new SignJWT({
    organizationId: principal.organizationId,
    producerId: principal.producerId,
    warehouseIds: principal.warehouseIds,
    roles: principal.roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-rsa-key', jku: 'https://attacker.example.test/keys' })
    .setSubject(principal.subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .setIssuer('https://id.example.test')
    .setAudience('warehouse')
    .sign(privateKey);
  assert.deepEqual(await verify(`Bearer ${signed}`), principal);
  assert.deepEqual(requests, ['https://id.example.test/keys']);
  const substituted = await token({ iss: 'https://id.example.test' });
  await assert.rejects(verify(`Bearer ${substituted}`), /Invalid credentials/);
  const { privateKey: attackerKey } = await generateKeyPair('RS256');
  const forged = await new SignJWT({
    organizationId: principal.organizationId,
    producerId: principal.producerId,
    warehouseIds: principal.warehouseIds,
    roles: principal.roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-rsa-key' })
    .setSubject(principal.subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .setIssuer('https://id.example.test')
    .setAudience('warehouse')
    .sign(attackerKey);
  await assert.rejects(verify(`Bearer ${forged}`), /Invalid credentials/);
});
