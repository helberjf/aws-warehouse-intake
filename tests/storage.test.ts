import assert from 'node:assert/strict';
import test from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoIntakeStore, keys } from '../src/storage/dynamo-store.ts';
import { backfillIndexes } from '../scripts/backfill-indexes.ts';

test('balance identities isolate organizations, warehouses, SKUs and tagged absent lots', () => {
  const absent = keys.balance('org', 'warehouse', 'sku');
  const named = keys.balance('org', 'warehouse', 'sku', 'NO_LOT');
  assert.notEqual(absent.sk, named.sk);
  assert.equal(absent.pk, named.pk);
  assert.notEqual(absent.pk, keys.balance('org2', 'warehouse', 'sku').pk);
  assert.notEqual(absent.pk, keys.balance('org', 'warehouse2', 'sku').pk);
  assert.notEqual(absent.pk, keys.balance('org', 'warehouse', 'sku2').pk);
});

test('pagination rejects cursors from another warehouse before querying storage', async () => {
  let queries = 0;
  const client = {
    send: async () => {
      queries++;
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoIntakeStore(client, 'table');
  const cursor = Buffer.from(
    JSON.stringify({
      pk: 'entry',
      sk: 'META',
      historyPK: keys.history('org', 'other-warehouse'),
      historySK: 'date',
    }),
  ).toString('base64url');
  await assert.rejects(() => store.listEntries('org', 'warehouse', 10, cursor), RangeError);
  await assert.rejects(() => store.getBalances('org', 'warehouse', 'sku', 10, 'not-json'), RangeError);
  await assert.rejects(() => store.listEntries('org', 'warehouse', 101), RangeError);
  assert.equal(queries, 0);
});

test('catalog and warehouse stock index cursors stay inside their authorized partitions', async () => {
  let queries = 0;
  const client = {
    send: async () => {
      queries++;
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoIntakeStore(client, 'table');
  const encode = (key: Record<string, string>) => Buffer.from(JSON.stringify(key)).toString('base64url');
  await assert.rejects(
    store.listProducts(
      'org',
      10,
      encode({ pk: 'product', sk: 'META', catalogPK: keys.catalog('other'), catalogSK: 'sku' }),
    ),
    RangeError,
  );
  await assert.rejects(
    store.listStock(
      'org',
      'warehouse',
      10,
      encode({ pk: 'balance', sk: 'lot', stockPK: keys.stock('org', 'other'), stockSK: 'sku#lot' }),
    ),
    RangeError,
  );
  await assert.rejects(store.listProducts('org', 101), RangeError);
  await assert.rejects(store.listStock('org', 'warehouse', 0), RangeError);
  assert.equal(queries, 0);
});

test('migration dry-run only scans metadata and ignores records outside the requested scope', async () => {
  const commands: string[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      commands.push(command.constructor.name);
      assert.equal(command.input.ProjectionExpression, 'pk, sk, #data.skuId, #data.barcode, skuId, lotCode');
      return {
        ScannedCount: 4,
        Items: [
          { ...keys.product('org', 'sku'), data: { skuId: 'sku' } },
          { ...keys.product('other', 'sku'), data: { skuId: 'sku' } },
          { ...keys.balance('org', 'warehouse', 'sku'), skuId: 'sku' },
          { ...keys.balance('org', 'unlisted', 'sku'), skuId: 'sku' },
        ],
      };
    },
  } as unknown as DynamoDBDocumentClient;
  const report = await backfillIndexes(client, 'table', {
    organizationId: 'org',
    warehouseIds: ['warehouse'],
  });
  assert.deepEqual(commands, ['ScanCommand']);
  assert.equal(report.dryRun, true);
  assert.equal(report.products, 1);
  assert.equal(report.balances, 1);
  assert.equal(report.complete, true);
});
