import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { setupLocal } from '../scripts/local-resources.ts';
import { IdentityService, identityKeys, LoginRateLimitError } from '../src/identity/service.ts';
import { AuthenticationError } from '../src/http/auth.ts';
import { ConflictError } from '../src/application/ports.ts';

process.env.ENVIRONMENT = 'local';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
let resources: Awaited<ReturnType<typeof setupLocal>>, service: IdentityService;
const password = 'test-only-password-with-entropy-123';
const user = (username: string) => ({
  organizationId: 'AUTH',
  username,
  password,
  displayName: 'Test Operator',
  producerId: 'web-receiving',
  warehouseIds: ['WH-01'],
  roles: ['receiving'] as ('receiving' | 'admin')[],
});
before(async () => {
  const name = `warehouse-auth-${randomUUID()}`;
  resources = await setupLocal(name, name);
  service = new IdentityService(resources.document, resources.tableName);
});
after(async () => {
  if (!resources) return;
  await resources.dynamo.send(new DeleteTableCommand({ TableName: resources.tableName }));
  for (const QueueUrl of [resources.queueUrl, resources.dlqUrl])
    await resources.sqs.send(new DeleteQueueCommand({ QueueUrl }));
  resources.dynamo.destroy();
  resources.sqs.destroy();
});

test('user provisioning stores only salted hashes and sessions store only opaque-token digests', async () => {
  const profile = await service.provisionUser(user('operator'));
  assert.equal(profile.displayName, 'Test Operator');
  const record = await resources.document.send(
    new GetCommand({
      TableName: resources.tableName,
      Key: { pk: identityKeys.user('AUTH', 'operator'), sk: 'META' },
      ConsistentRead: true,
    }),
  );
  assert.equal(JSON.stringify(record.Item).includes(password), false);
  assert.equal(record.Item?.passwordHash.algorithm, 'scrypt-v1');
  await assert.rejects(service.provisionUser(user('operator')), ConflictError);
  const login = await service.login({ organizationId: 'AUTH', username: 'OPERATOR', password }, '127.0.0.1');
  const stored = await resources.document.send(
    new GetCommand({
      TableName: resources.tableName,
      Key: { pk: identityKeys.session(login.token), sk: 'META' },
      ConsistentRead: true,
    }),
  );
  assert.equal(JSON.stringify(stored.Item).includes(login.token), false);
  assert.equal((await service.authenticate(login.token)).user.subject, profile.subject);
  await service.logout(login.token);
  await assert.rejects(service.authenticate(login.token), AuthenticationError);
});
test('logical session expiry applies immediately even before DynamoDB TTL removal', async () => {
  await service.provisionUser(user('expired'));
  const login = await service.login({ organizationId: 'AUTH', username: 'expired', password }, '127.0.0.2');
  await resources.document.send(
    new UpdateCommand({
      TableName: resources.tableName,
      Key: { pk: identityKeys.session(login.token), sk: 'META' },
      UpdateExpression: 'SET expiresAt = :expired',
      ExpressionAttributeValues: { ':expired': 1 },
    }),
  );
  await assert.rejects(service.authenticate(login.token), AuthenticationError);
});
test('credential reset retains user identity and revokes all existing sessions', async () => {
  const original = await service.provisionUser(user('reset'));
  const login = await service.login({ organizationId: 'AUTH', username: 'reset', password }, '127.0.0.3');
  const next = await service.provisionUser(
    { ...user('reset'), password: 'replacement-password-123456' },
    { reset: true },
  );
  assert.equal(next.subject, original.subject);
  await assert.rejects(service.authenticate(login.token), AuthenticationError);
  await assert.rejects(
    service.login({ organizationId: 'AUTH', username: 'reset', password }, '127.0.0.3'),
    AuthenticationError,
  );
  assert.equal(
    (
      await service.login(
        { organizationId: 'AUTH', username: 'reset', password: 'replacement-password-123456' },
        '127.0.0.3',
      )
    ).session.user.subject,
    original.subject,
  );
});
test('password change verifies old secret and revokes prior browser sessions', async () => {
  await service.provisionUser(user('change'));
  const login = await service.login({ organizationId: 'AUTH', username: 'change', password }, '127.0.0.4');
  await assert.rejects(
    service.changePassword(login.token, 'incorrect-password', 'new-password-12345678'),
    AuthenticationError,
  );
  await service.changePassword(login.token, password, 'new-password-12345678');
  await assert.rejects(service.authenticate(login.token), AuthenticationError);
  assert.ok(
    (
      await service.login(
        { organizationId: 'AUTH', username: 'change', password: 'new-password-12345678' },
        '127.0.0.4',
      )
    ).token,
  );
});
test('distributed login limits cover unknown users and concurrent attempts', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 7 }, () =>
      service.login({ organizationId: 'AUTH', username: 'unknown', password }, '127.0.0.5'),
    ),
  );
  assert.equal(
    results.filter((r) => r.status === 'rejected' && r.reason instanceof AuthenticationError).length,
    5,
  );
  assert.equal(
    results.filter((r) => r.status === 'rejected' && r.reason instanceof LoginRateLimitError).length,
    2,
  );
  const secondReplica = new IdentityService(resources.document, resources.tableName);
  await assert.rejects(
    secondReplica.login({ organizationId: 'AUTH', username: 'unknown', password }, '127.0.0.6'),
    LoginRateLimitError,
  );
});
test('deactivated accounts and organization mismatch never authenticate', async () => {
  await service.provisionUser(user('inactive'));
  const login = await service.login({ organizationId: 'AUTH', username: 'inactive', password }, '127.0.0.7');
  await service.provisionUser({ ...user('inactive'), active: false }, { reset: true });
  await assert.rejects(service.authenticate(login.token), AuthenticationError);
  await assert.rejects(
    service.login({ organizationId: 'OTHER', username: 'operator', password }, '127.0.0.7'),
    AuthenticationError,
  );
});

test('IP limits apply across usernames and logically expired windows reset before TTL deletion', async () => {
  await service.provisionUser(user('ip-limited'));
  const ip = '192.0.2.20';
  const pk = identityKeys.throttle('ip', ip);
  await resources.document.send(
    new UpdateCommand({
      TableName: resources.tableName,
      Key: { pk, sk: 'META' },
      UpdateExpression: 'SET attempts = :limit, expiresAt = :expiry',
      ExpressionAttributeValues: { ':limit': 30, ':expiry': Math.floor(Date.now() / 1000) + 900 },
    }),
  );
  await assert.rejects(
    service.login({ organizationId: 'AUTH', username: 'ip-limited', password }, ip),
    LoginRateLimitError,
  );
  await assert.rejects(
    service.login({ organizationId: 'AUTH', username: 'other-username', password }, ip),
    LoginRateLimitError,
  );
  await resources.document.send(
    new UpdateCommand({
      TableName: resources.tableName,
      Key: { pk, sk: 'META' },
      UpdateExpression: 'SET expiresAt = :past',
      ExpressionAttributeValues: { ':past': 1 },
    }),
  );
  assert.ok((await service.login({ organizationId: 'AUTH', username: 'ip-limited', password }, ip)).token);
  const reset = await resources.document.send(
    new GetCommand({ TableName: resources.tableName, Key: { pk, sk: 'META' }, ConsistentRead: true }),
  );
  assert.equal(reset.Item?.attempts, 1);
});
