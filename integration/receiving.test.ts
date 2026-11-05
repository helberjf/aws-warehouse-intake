import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { SignJWT } from 'jose';
import { setupLocal } from '../scripts/local-resources.ts';
import { DynamoIntakeStore, keys } from '../src/storage/dynamo-store.ts';
import { prepareReceivingEntry } from '../src/domain/receiving.ts';
import { ConflictError, EligibilityError } from '../src/application/ports.ts';
import { publishOnce, consumeOnce } from '../src/processing/queue.ts';
import { createApp } from '../src/http/app.ts';
import { createAuthenticator } from '../src/http/auth.ts';

process.env.ENVIRONMENT = 'local';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
let resources: Awaited<ReturnType<typeof setupLocal>>;
let store: DynamoIntakeStore;
const scope = { organizationId: 'TEST', warehouseId: 'WH-01', producerId: 'erp' };
const bulk = { skuId: 'BULK', trackingMode: 'BULK' as const, active: true };
const serial = { skuId: 'SERIAL', trackingMode: 'SERIALIZED' as const, active: true };
const body = (ref: string, quantity = 10, lotCode?: string) => ({
  mode: 'BULK',
  skuId: 'BULK',
  quantity,
  lotCode,
  externalReference: ref,
  occurredAt: '2026-11-05T12:00:00Z',
});
const command = (ref: string, quantity = 10, key = ref, lotCode?: string) =>
  prepareReceivingEntry(body(ref, quantity, lotCode), scope, key, {
    skuId: bulk.skuId,
    trackingMode: bulk.trackingMode,
  });
before(async () => {
  const name = `warehouse-test-${randomUUID()}`;
  resources = await setupLocal(name, name);
  store = new DynamoIntakeStore(resources.document, resources.tableName);
  for (const warehouseId of ['WH-01', 'WH-02'])
    await store.putWarehouse('TEST', { warehouseId, name: warehouseId, active: true });
  await store.putProduct('TEST', bulk);
  await store.putProduct('TEST', serial);
});
after(async () => {
  if (!resources) return;
  await resources.dynamo.send(new DeleteTableCommand({ TableName: resources.tableName }));
  for (const QueueUrl of [resources.queueUrl, resources.dlqUrl])
    await resources.sqs.send(new DeleteQueueCommand({ QueueUrl }));
  resources.dynamo.destroy();
  resources.sqs.destroy();
});

test('concurrent acceptance and application have exactly one inventory effect', async () => {
  const entry = command('concurrent', 17, 'concurrent', 'concurrency');
  const accepted = await Promise.all(Array.from({ length: 20 }, () => store.accept(entry)));
  assert.equal(new Set(accepted.map((e) => e.entryId)).size, 1);
  await Promise.all(Array.from({ length: 20 }, () => store.apply(entry.entryId)));
  assert.equal((await store.getEntry(entry.entryId))?.status, 'APPLIED');
  const balances = await store.getBalances('TEST', 'WH-01', 'BULK', 100);
  assert.equal(balances.items.find((b) => b.lotCode === 'concurrency')?.quantity, 17);
});
test('HTTP key and business reference conflicts cannot mutate existing movement', async () => {
  const entry = command('reference', 12, 'original', 'reference');
  await store.accept(entry);
  const replay = await store.accept(command('reference', 12, 'new-key', 'reference'));
  assert.equal(replay.entryId, entry.entryId);
  await assert.rejects(store.accept(command('reference', 13, 'third-key', 'reference')), ConflictError);
  await assert.rejects(store.accept(command('other-reference', 12, 'new-key', 'reference')), ConflictError);
});
test('serial uniqueness spans warehouses, rejection never adds stock', async () => {
  const entries = ['WH-01', 'WH-02'].map((warehouseId) =>
    prepareReceivingEntry(
      {
        mode: 'SERIALIZED',
        skuId: 'SERIAL',
        serialNumber: 'S-1',
        externalReference: `serial-${warehouseId}`,
        occurredAt: '2026-11-05T12:00:00Z',
      },
      { ...scope, warehouseId },
      `serial-${warehouseId}`,
      { skuId: serial.skuId, trackingMode: serial.trackingMode },
    ),
  );
  for (const entry of entries) await store.accept(entry);
  await Promise.all(entries.map((entry) => store.apply(entry.entryId)));
  const statuses = await Promise.all(entries.map((entry) => store.getEntry(entry.entryId)));
  assert.deepEqual(statuses.map((e) => e?.status).sort(), ['APPLIED', 'REJECTED']);
  const balances = await Promise.all(
    ['WH-01', 'WH-02'].map((w) => store.getBalances('TEST', w, 'SERIAL', 100)),
  );
  assert.equal(
    balances.flatMap((p) => p.items).reduce((n, b) => n + b.quantity, 0),
    1,
  );
});
test('deactivation blocks new movements but permits accepted replay and completion', async () => {
  const entry = command('before-deactivate', 3, 'before-deactivate', 'deactivation');
  await store.accept(entry);
  await store.putProduct('TEST', { ...bulk, active: false });
  await assert.rejects(store.accept(command('after-deactivate')), EligibilityError);
  assert.equal((await store.accept(entry)).entryId, entry.entryId);
  await store.apply(entry.entryId);
  await store.putProduct('TEST', bulk);
  await assert.rejects(store.putProduct('TEST', { ...bulk, trackingMode: 'SERIALIZED' }), ConflictError);
});
test('outbox lease survives a publisher crash and rejects stale completion', async () => {
  const entry = command('lease-crash', 1, 'lease-crash', 'lease');
  await store.accept(entry);
  const records = await store.claimOutbox(10, 60);
  // Simulate time advancing past the crashed publisher's lease, without a slow wall-clock wait.
  assert.ok(records.length > 0);
  for (const record of records)
    await resources.document.send(
      new UpdateCommand({
        TableName: resources.tableName,
        Key: keys.outbox(record.entryId),
        UpdateExpression: 'SET leaseUntil = :zero, dueSK = :due',
        ExpressionAttributeValues: { ':zero': 0, ':due': `0000000000000#${record.entryId}` },
      }),
    );
  const reclaimed = await store.claimOutbox(10, 60);
  assert.ok(reclaimed.some((record) => record.entryId === entry.entryId));
  for (const record of records) await store.markPublished(record);
  for (const record of reclaimed) {
    const current = await resources.document.send(
      new GetCommand({
        TableName: resources.tableName,
        Key: keys.outbox(record.entryId),
        ConsistentRead: true,
      }),
    );
    assert.equal(current.Item?.state, 'PENDING');
    assert.equal(current.Item?.leaseToken, record.leaseToken);
  }
  for (const record of reclaimed) await store.releaseOutbox(record, 0);
});
test('real SQS publication and repeated delivery preserve stock exactly once', async () => {
  const entry = command('queue-flow', 21, 'queue-flow', 'queue-flow');
  await store.accept(entry);
  for (let i = 0; i < 20; i++) {
    await publishOnce(store, resources.sqs, resources.queueUrl, { batchSize: 10 });
    await consumeOnce(store, resources.sqs, resources.queueUrl, { batchSize: 10, waitSeconds: 0 });
    if ((await store.getEntry(entry.entryId))?.status === 'APPLIED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await store.getEntry(entry.entryId))?.status, 'APPLIED');
  const outbox = await resources.document.send(
    new GetCommand({ TableName: resources.tableName, Key: keys.outbox(entry.entryId), ConsistentRead: true }),
  );
  assert.equal(outbox.Item?.duePK, undefined);
  assert.equal(typeof outbox.Item?.expiresAt, 'number');
  for (let i = 0; i < 3; i++)
    await resources.sqs.send(
      new SendMessageCommand({
        QueueUrl: resources.queueUrl,
        MessageBody: JSON.stringify({ version: 1, entryId: entry.entryId }),
        MessageGroupId: entry.messageGroupId,
      }),
    );
  for (let i = 0; i < 3; i++)
    await consumeOnce(store, resources.sqs, resources.queueUrl, { batchSize: 10, waitSeconds: 0 });
  assert.equal(
    (await store.getBalances('TEST', 'WH-01', 'BULK', 100)).items.find((b) => b.lotCode === 'queue-flow')
      ?.quantity,
    21,
  );
});
test('history and balances paginate with warehouse-bound cursors', async () => {
  let cursor: string | undefined;
  const ids = new Set<string>();
  do {
    const page = await store.listEntries('TEST', 'WH-01', 2, cursor);
    for (const e of page.items) {
      assert.equal(ids.has(e.entryId), false);
      ids.add(e.entryId);
    }
    cursor = page.cursor;
  } while (cursor);
  assert.ok(ids.size >= 6);
  const page = await store.listEntries('TEST', 'WH-01', 1);
  assert.ok(page.cursor);
  await assert.rejects(store.listEntries('TEST', 'WH-02', 1, page.cursor), RangeError);
  const balances = await store.getBalances('TEST', 'WH-01', 'BULK', 1);
  assert.ok(balances.cursor);
  await assert.rejects(store.getBalances('TEST', 'WH-02', 'BULK', 1, balances.cursor), RangeError);
});
test('authenticated HTTP acceptance reaches committed stock through real adapters', async () => {
  const secret = 'integration-local-secret-123456789012345';
  const token = await new SignJWT({ ...scope, warehouseIds: ['WH-01'], roles: ['receiving'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('test')
    .setAudience('api')
    .setSubject('operator')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
  const app = await createApp({
    store,
    auth: createAuthenticator({ environment: 'local', issuer: 'test', audience: 'api', localSecret: secret }),
    logger: false,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/warehouses/WH-01/receiving-entries',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'http-integration' },
      payload: body('http-integration', 31, 'http'),
    });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().entryId;
    for (let i = 0; i < 10; i++) {
      await publishOnce(store, resources.sqs, resources.queueUrl);
      await consumeOnce(store, resources.sqs, resources.queueUrl, { waitSeconds: 0 });
      if ((await store.getEntry(id))?.status === 'APPLIED') break;
    }
    const status = await app.inject({
      url: `/warehouses/WH-01/receiving-entries/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(status.json().status, 'APPLIED');
    const stock = await app.inject({
      url: '/warehouses/WH-01/stock/BULK',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(stock.json().items.find((b: { lotCode?: string }) => b.lotCode === 'http').quantity, 31);
    assert.equal(
      (
        await app.inject({
          url: `/warehouses/WH-02/receiving-entries/${id}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test('a lost transaction acknowledgement is recovered without adding stock twice', async () => {
  const entry = command('ambiguous-commit', 19, 'ambiguous-commit', 'ambiguous');
  await store.accept(entry);
  const faultClient = {
    send: async (command: unknown) => {
      const result = await resources.document.send(command as GetCommand);
      if (command instanceof TransactWriteCommand) throw new Error('Simulated connection loss after commit');
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const unreliableStore = new DynamoIntakeStore(faultClient, resources.tableName);
  await assert.rejects(unreliableStore.apply(entry.entryId), /connection loss/);
  assert.equal((await store.getEntry(entry.entryId))?.status, 'APPLIED');
  await store.apply(entry.entryId);
  assert.equal(
    (await store.getBalances('TEST', 'WH-01', 'BULK', 100)).items.find((b) => b.lotCode === 'ambiguous')
      ?.quantity,
    19,
  );
});

test('poison messages reach the real SQS dead-letter queue after bounded delivery attempts', async () => {
  const attrs = await resources.sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: resources.dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const poisonQueue = await resources.sqs.send(
    new CreateQueueCommand({
      QueueName: `poison-${randomUUID()}`,
      Attributes: {
        VisibilityTimeout: '3',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes?.QueueArn,
          maxReceiveCount: 2,
        }),
      },
    }),
  );
  const QueueUrl = poisonQueue.QueueUrl!;
  const poisonBody = JSON.stringify({ version: 999, entryId: 'a'.repeat(64) });
  let applies = 0;
  let receipt: string | undefined;
  const trackedClient = {
    send: async (command: unknown) => {
      const result = await resources.sqs.send(command as ReceiveMessageCommand);
      if (command instanceof ReceiveMessageCommand) receipt = result.Messages?.[0]?.ReceiptHandle;
      return result;
    },
  } as unknown as SQSClient;
  try {
    await resources.sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: poisonBody }));
    for (let i = 0; i < 3; i++) {
      receipt = undefined;
      await consumeOnce(
        {
          apply: async () => {
            applies++;
          },
        },
        trackedClient,
        QueueUrl,
        { waitSeconds: 0, visibilitySeconds: 3, logger: () => {} },
      );
      // Simulate the visibility deadline expiring, so retries do not slow the test.
      if (receipt)
        await resources.sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: receipt, VisibilityTimeout: 0 }),
        );
    }
    const dead = await resources.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: resources.dlqUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 10 }),
    );
    assert.equal(applies, 0);
    assert.ok(dead.Messages?.some((message) => message.Body === poisonBody));
  } finally {
    await resources.sqs.send(new DeleteQueueCommand({ QueueUrl }));
  }
});

test('warehouse deactivation is transactional and organizations keep independent identities and stock', async () => {
  const before = command('warehouse-active', 2, 'warehouse-active', 'warehouse-active');
  await store.accept(before);
  await store.putWarehouse('TEST', { warehouseId: 'WH-01', name: 'Paused', active: false });
  await assert.rejects(store.accept(command('warehouse-inactive')), EligibilityError);
  assert.equal((await store.accept(before)).entryId, before.entryId);
  await store.apply(before.entryId);
  await store.putWarehouse('TEST', { warehouseId: 'WH-01', name: 'Restored', active: true });
  await store.putWarehouse('OTHER', { warehouseId: 'WH-01', name: 'Other organization', active: true });
  await store.putProduct('OTHER', bulk);
  const isolated = prepareReceivingEntry(
    body('warehouse-active', 9, 'warehouse-active'),
    { ...scope, organizationId: 'OTHER' },
    'warehouse-active',
    { skuId: bulk.skuId, trackingMode: bulk.trackingMode },
  );
  assert.notEqual(isolated.entryId, before.entryId);
  await store.accept(isolated);
  await store.apply(isolated.entryId);
  const other = await store.getBalances('OTHER', 'WH-01', 'BULK', 100);
  assert.equal(other.items.find((balance) => balance.lotCode === 'warehouse-active')?.quantity, 9);
  const original = await store.getBalances('TEST', 'WH-01', 'BULK', 100);
  assert.equal(original.items.find((balance) => balance.lotCode === 'warehouse-active')?.quantity, 2);
  assert.equal((await store.listEntries('OTHER', 'WH-01', 100)).items.length, 1);
});
