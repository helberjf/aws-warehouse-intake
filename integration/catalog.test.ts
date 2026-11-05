import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { setupLocal } from '../scripts/local-resources.ts';
import { DynamoIntakeStore, keys } from '../src/storage/dynamo-store.ts';
import { ConflictError, type Product } from '../src/application/ports.ts';
import { prepareReceivingEntry } from '../src/domain/receiving.ts';
import { backfillIndexes } from '../scripts/backfill-indexes.ts';

process.env.ENVIRONMENT = 'local';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
let resources: Awaited<ReturnType<typeof setupLocal>>;
let store: DynamoIntakeStore;
const alice = { subject: 'user-alice', displayName: 'Alice Ferreira' };
const bob = { subject: 'user-bob', displayName: 'Bruno Souza' };
const bulk = (skuId: string, barcode?: string): Product => ({
  skuId,
  barcode,
  name: `Product ${skuId}`,
  active: true,
  trackingMode: 'BULK',
});
before(async () => {
  const name = `catalog-test-${randomUUID()}`;
  resources = await setupLocal(name, name);
  store = new DynamoIntakeStore(resources.document, resources.tableName);
});
after(async () => {
  if (!resources) return;
  await resources.dynamo.send(new DeleteTableCommand({ TableName: resources.tableName }));
  for (const QueueUrl of [resources.queueUrl, resources.dlqUrl])
    await resources.sqs.send(new DeleteQueueCommand({ QueueUrl }));
  resources.dynamo.destroy();
  resources.sqs.destroy();
});

test('catalog preserves the verified original creator after edits and ignores caller audit values', async () => {
  await store.putProduct(
    'ORG',
    { ...bulk('AUDIT', '789000000001'), createdBy: bob, createdAt: '1900-01-01T00:00:00Z' },
    alice,
  );
  const original = await store.getProduct('ORG', 'AUDIT');
  assert.deepEqual(original?.createdBy, alice);
  assert.notEqual(original?.createdAt, '1900-01-01T00:00:00Z');
  await store.putProduct(
    'ORG',
    { ...bulk('AUDIT', '789000000001'), name: 'Renamed', createdBy: bob, createdAt: '2000-01-01T00:00:00Z' },
    bob,
  );
  const updated = await store.getProduct('ORG', 'AUDIT');
  assert.equal(updated?.name, 'Renamed');
  assert.deepEqual(updated?.createdBy, alice);
  assert.equal(updated?.createdAt, original?.createdAt);
  assert.deepEqual(updated?.updatedBy, bob);
  assert.ok(updated?.updatedAt);
});

test('barcode aliases are organization-scoped and cannot overlap another SKU', async () => {
  await store.putProduct('ORG', bulk('CODE-ONE', 'shared-barcode'), alice);
  await assert.rejects(store.putProduct('ORG', bulk('CODE-TWO', 'shared-barcode'), bob), ConflictError);
  await assert.rejects(store.putProduct('ORG', bulk('shared-barcode'), bob), ConflictError);
  await assert.rejects(store.putProduct('ORG', bulk('CODE-THREE', 'CODE-ONE'), bob), ConflictError);
  assert.equal(await store.getProduct('ORG', 'CODE-TWO'), undefined);
  await store.putProduct('OTHER', bulk('CODE-TWO', 'shared-barcode'), bob);
  assert.equal((await store.findProductByCode('ORG', 'shared-barcode'))?.skuId, 'CODE-ONE');
  assert.equal((await store.findProductByCode('OTHER', 'shared-barcode'))?.skuId, 'CODE-TWO');
  assert.equal((await store.findProductByCode('ORG', 'CODE-ONE'))?.skuId, 'CODE-ONE');
  assert.equal(await store.findProductByCode('ORG', 'unknown'), undefined);
});

test('barcode replacement is atomic and releases its previous alias', async () => {
  await store.putProduct('ORG', bulk('CHANGE', 'before-change'), alice);
  await store.putProduct('ORG', bulk('CHANGE', 'after-change'), bob);
  assert.equal(await store.findProductByCode('ORG', 'before-change'), undefined);
  assert.equal((await store.findProductByCode('ORG', 'after-change'))?.skuId, 'CHANGE');
  await store.putProduct('ORG', bulk('REUSE', 'before-change'), bob);
  assert.equal((await store.findProductByCode('ORG', 'before-change'))?.skuId, 'REUSE');
  await assert.rejects(store.putProduct('ORG', bulk('CHANGE', 'before-change'), bob), ConflictError);
  assert.equal((await store.getProduct('ORG', 'CHANGE'))?.barcode, 'after-change');
});

test('concurrent registrations sharing one barcode have one winner and no orphan product', async () => {
  const products = [bulk('RACE-ONE', 'racing-code'), bulk('RACE-TWO', 'racing-code')];
  const results = await Promise.allSettled(products.map((p) => store.putProduct('ORG', p, alice)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof ConflictError).length, 1);
  const persisted = await Promise.all(products.map((p) => store.getProduct('ORG', p.skuId)));
  assert.equal(persisted.filter(Boolean).length, 1);
  assert.equal((await store.findProductByCode('ORG', 'racing-code'))?.skuId, persisted.find(Boolean)?.skuId);
});

test('legacy catalog records retain unknown attribution and their SKU cannot become another barcode', async () => {
  const product = bulk('LEGACY');
  await resources.document.send(
    new PutCommand({
      TableName: resources.tableName,
      Item: { ...keys.product('ORG', product.skuId), data: product, active: true, trackingMode: 'BULK' },
    }),
  );
  await assert.rejects(store.putProduct('ORG', bulk('NOT-LEGACY', 'LEGACY'), alice), ConflictError);
  assert.equal((await store.findProductByCode('ORG', 'LEGACY'))?.skuId, 'LEGACY');
  await store.putProduct('ORG', { ...product, name: 'Legacy updated' }, bob);
  const updated = await store.getProduct('ORG', 'LEGACY');
  assert.equal(updated?.createdBy, undefined);
  assert.equal(updated?.createdAt, undefined);
  assert.deepEqual(updated?.updatedBy, bob);
});

test('catalog pagination is bounded and cursors cannot cross organizations', async () => {
  let cursor: string | undefined;
  const ids = new Set<string>();
  do {
    const page = await store.listProducts('ORG', 2, cursor);
    for (const p of page.items) {
      assert.equal(ids.has(p.skuId), false);
      ids.add(p.skuId);
    }
    cursor = page.cursor;
  } while (cursor);
  assert.ok(ids.has('AUDIT'));
  assert.ok(ids.has('LEGACY'));
  assert.equal(ids.size, 6);
  const page = await store.listProducts('ORG', 1);
  assert.ok(page.cursor);
  await assert.rejects(store.listProducts('OTHER', 1, page.cursor), RangeError);
});

test('stock browsing is warehouse-scoped and receipt replay preserves the original operator', async () => {
  await store.putWarehouse('ORG', { warehouseId: 'WH-01', name: 'One', active: true });
  await store.putWarehouse('ORG', { warehouseId: 'WH-02', name: 'Two', active: true });
  await store.putProduct('ORG', bulk('STOCK'), alice);
  for (const warehouseId of ['WH-01', 'WH-02'])
    for (const lotCode of ['LOT-A', 'LOT-B']) {
      const prepared = prepareReceivingEntry(
        {
          mode: 'BULK',
          skuId: 'STOCK',
          quantity: warehouseId === 'WH-01' ? 10 : 20,
          lotCode,
          externalReference: `${warehouseId}-${lotCode}`,
          occurredAt: '2026-11-05T12:00:00Z',
        },
        { organizationId: 'ORG', warehouseId, producerId: 'erp' },
        `${warehouseId}-${lotCode}`,
        { skuId: 'STOCK', trackingMode: 'BULK' },
      );
      const entry = await store.accept({ ...prepared, recordedBy: alice });
      await store.apply(entry.entryId);
      const replay = await store.accept({ ...prepared, recordedBy: bob });
      assert.deepEqual(replay.recordedBy, alice);
    }
  const first = await store.listStock('ORG', 'WH-01', 1);
  assert.equal(first.items[0].quantity, 10);
  assert.ok(first.cursor);
  const second = await store.listStock('ORG', 'WH-01', 1, first.cursor);
  assert.equal(second.items[0].quantity, 10);
  assert.notEqual(second.items[0].lotCode, first.items[0].lotCode);
  await assert.rejects(store.listStock('ORG', 'WH-02', 1, first.cursor), RangeError);
  const other = await store.listStock('ORG', 'WH-02', 100);
  assert.equal(
    other.items.reduce((n, b) => n + b.quantity, 0),
    40,
  );
  assert.deepEqual((await store.listStock('OTHER', 'WH-01', 100)).items, []);
});

test('concurrent catalog edits preserve the creator and cannot change tracking mode', async () => {
  await store.putProduct('ORG', bulk('CONCURRENT-EDITS', 'edit-code'), alice);
  const original = await store.getProduct('ORG', 'CONCURRENT-EDITS');
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      store.putProduct('ORG', { ...bulk('CONCURRENT-EDITS', 'edit-code'), name: `Edit ${index}` }, bob),
    ),
  );
  const result = await store.getProduct('ORG', 'CONCURRENT-EDITS');
  assert.deepEqual(result?.createdBy, alice);
  assert.equal(result?.createdAt, original?.createdAt);
  assert.deepEqual(result?.updatedBy, bob);
  await assert.rejects(
    store.putProduct('ORG', { ...bulk('CONCURRENT-EDITS', 'edit-code'), trackingMode: 'SERIALIZED' }, alice),
    ConflictError,
  );
  assert.equal((await store.getProduct('ORG', 'CONCURRENT-EDITS'))?.trackingMode, 'BULK');
});

test('legacy index migration is opt-in, scoped, resumable and preserves attribution and balances', async () => {
  const org = 'MIGRATION',
    sku = 'OLD-SKU';
  const product = bulk(sku, 'old-barcode');
  await resources.document.send(
    new PutCommand({
      TableName: resources.tableName,
      Item: { ...keys.product(org, sku), data: product, active: true, trackingMode: 'BULK' },
    }),
  );
  await resources.document.send(
    new PutCommand({
      TableName: resources.tableName,
      Item: { ...keys.balance(org, 'WH-01', sku), skuId: sku, quantity: 42 },
    }),
  );
  const dry = await backfillIndexes(resources.document, resources.tableName, {
    organizationId: org,
    warehouseIds: ['WH-01'],
    maxItems: 1000,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.products, 1);
  assert.equal(dry.balances, 1);
  assert.deepEqual((await store.listProducts(org, 100)).items, []);
  const first = await backfillIndexes(resources.document, resources.tableName, {
    organizationId: org,
    warehouseIds: ['WH-01'],
    maxItems: 1,
  });
  assert.ok(first.nextCursor);
  await assert.rejects(
    backfillIndexes(resources.document, resources.tableName, {
      organizationId: 'OTHER',
      warehouseIds: ['WH-01'],
      cursor: first.nextCursor,
    }),
    RangeError,
  );
  let cursor: string | undefined;
  do {
    const report = await backfillIndexes(resources.document, resources.tableName, {
      organizationId: org,
      warehouseIds: ['WH-01'],
      apply: true,
      maxItems: 10,
      cursor,
    });
    cursor = report.nextCursor;
  } while (cursor);
  assert.equal((await store.listProducts(org, 100)).items[0].skuId, sku);
  assert.equal((await store.findProductByCode(org, 'old-barcode'))?.skuId, sku);
  assert.equal((await store.getProduct(org, sku))?.createdBy, undefined);
  assert.equal((await store.listStock(org, 'WH-01', 100)).items[0].quantity, 42);
  assert.deepEqual((await store.listStock(org, 'WH-02', 100)).items, []);
});
