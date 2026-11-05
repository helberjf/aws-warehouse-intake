import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileWarehouse } from '../scripts/reconcile.ts';
import { prepareReceivingEntry } from '../src/domain/receiving.ts';
import type { Balance, LedgerEntry } from '../src/application/ports.ts';

function entry(
  ref: string,
  quantity: number,
  lotCode?: string,
  status: LedgerEntry['status'] = 'APPLIED',
): LedgerEntry {
  return {
    ...prepareReceivingEntry(
      {
        mode: 'BULK',
        skuId: 'SKU',
        quantity,
        lotCode,
        externalReference: ref,
        occurredAt: '2026-11-05T12:00:00Z',
      },
      { organizationId: 'ORG', warehouseId: 'WH', producerId: 'erp' },
      ref,
      { skuId: 'SKU', trackingMode: 'BULK' },
    ),
    status,
    acceptedAt: '2026-11-05T12:00:01Z',
  };
}

function store(entries: LedgerEntry[], balances: Balance[]) {
  return {
    listEntries: async (_org: string, _warehouse: string, limit: number, cursor?: string) => {
      const start = Number(cursor ?? 0),
        end = start + limit;
      return { items: entries.slice(start, end), cursor: end < entries.length ? String(end) : undefined };
    },
    getBalances: async (_org: string, _warehouse: string, _sku: string, limit: number, cursor?: string) => {
      const start = Number(cursor ?? 0),
        end = start + limit;
      return { items: balances.slice(start, end), cursor: end < balances.length ? String(end) : undefined };
    },
  };
}

test('reconciliation matches applied quantities while excluding business rejections', async () => {
  const report = await reconcileWarehouse(
    store(
      [
        entry('one', 5),
        entry('two', 7),
        entry('three', 8, 'NO_LOT'),
        entry('rejected', 100, undefined, 'REJECTED'),
      ],
      [
        { skuId: 'SKU', quantity: 12 },
        { skuId: 'SKU', lotCode: 'NO_LOT', quantity: 8 },
      ],
    ),
    'ORG',
    'WH',
  );
  assert.equal(report.matches, true);
  assert.equal(report.statuses.APPLIED, 3);
  assert.equal(report.statuses.REJECTED, 1);
});

test('reconciliation reports missing, wrong and unexpected lot balances', async () => {
  const report = await reconcileWarehouse(
    store(
      [entry('one', 5, 'missing'), entry('two', 7, 'wrong')],
      [
        { skuId: 'SKU', lotCode: 'wrong', quantity: 3 },
        { skuId: 'SKU', lotCode: 'extra', quantity: 8 },
      ],
    ),
    'ORG',
    'WH',
  );
  assert.equal(report.complete, true);
  assert.equal(report.matches, false);
  assert.equal(report.mismatchCount, 3);
});

test('bounded or undrained reconciliation never reports a complete match', async () => {
  const bounded = await reconcileWarehouse(
    store([entry('one', 1), entry('two', 1)], [{ skuId: 'SKU', quantity: 2 }]),
    'ORG',
    'WH',
    1,
  );
  assert.equal(bounded.complete, false);
  const pending = await reconcileWarehouse(store([entry('one', 1, undefined, 'ACCEPTED')], []), 'ORG', 'WH');
  assert.equal(pending.complete, false);
  assert.equal(pending.matches, false);
});

test('reconciliation refuses cross-warehouse records and unsafe bounds', async () => {
  const invalid = { ...entry('one', 1), warehouseId: 'OTHER' };
  await assert.rejects(() => reconcileWarehouse(store([invalid], []), 'ORG', 'WH'), /scope/);
  await assert.rejects(() => reconcileWarehouse(store([], []), 'ORG', 'WH', 1_000_001), RangeError);
  await assert.rejects(
    () => reconcileWarehouse(store([{ ...entry('broken', 1), quantity: 2 }], []), 'ORG', 'WH'),
    /invariant/,
  );
});
