import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { IntakeStore } from '../src/application/ports.ts';
import { createClients } from '../src/clients.ts';
import { DynamoIntakeStore } from '../src/storage/dynamo-store.ts';

type ReadStore = Pick<IntakeStore, 'listEntries' | 'getBalances'>;
type Aggregate = { skuId: string; lotCode?: string; quantity: number };
const identity = (skuId: string, lotCode?: string) =>
  JSON.stringify([skuId, lotCode === undefined ? ['NO_LOT'] : ['LOT', lotCode]]);

/** Bounded operational comparison; GSI history is eventually consistent and is not a snapshot. */
export async function reconcileWarehouse(
  store: ReadStore,
  organizationId: string,
  warehouseId: string,
  maxEntries = 100_000,
) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000)
    throw new RangeError('Max entries must be between 1 and 1000000');
  const expected = new Map<string, Aggregate>();
  const seen = new Set<string>();
  const skus = new Set<string>();
  const statuses = { ACCEPTED: 0, APPLIED: 0, REJECTED: 0 };
  let incomplete = false;
  let cursor: string | undefined;
  do {
    const page = await store.listEntries(
      organizationId,
      warehouseId,
      Math.min(100, maxEntries - seen.size),
      cursor,
    );
    for (const ledger of page.items) {
      if (
        ledger.organizationId !== organizationId ||
        ledger.warehouseId !== warehouseId ||
        seen.has(ledger.entryId)
      ) {
        throw new Error(
          'History scope or pagination invariant failed; retry after writes and index replication settle',
        );
      }
      seen.add(ledger.entryId);
      skus.add(ledger.entry.skuId);
      if (
        !['ACCEPTED', 'APPLIED', 'REJECTED'].includes(ledger.status) ||
        ledger.quantity !== (ledger.entry.mode === 'SERIALIZED' ? 1 : ledger.entry.quantity)
      ) {
        throw new Error('Ledger status or quantity invariant failed; manual investigation required');
      }
      statuses[ledger.status]++;
      if (ledger.status !== 'APPLIED') continue;
      const lotCode = ledger.entry.mode === 'BULK' ? ledger.entry.lotCode : undefined;
      const id = identity(ledger.entry.skuId, lotCode);
      const aggregate = expected.get(id) ?? { skuId: ledger.entry.skuId, lotCode, quantity: 0 };
      aggregate.quantity += ledger.quantity;
      if (!Number.isSafeInteger(aggregate.quantity) || aggregate.quantity < 1)
        throw new Error('Unsafe ledger quantity; manual investigation required');
      expected.set(id, aggregate);
    }
    cursor = page.cursor;
    if (seen.size >= maxEntries && cursor) {
      incomplete = true;
      break;
    }
  } while (cursor);

  let balanceCount = 0;
  let mismatchCount = 0;
  const mismatches: { skuId: string; lotCode?: string; expected: number; actual: number }[] = [];
  function recordMismatch(value: { skuId: string; lotCode?: string; expected: number; actual: number }) {
    mismatchCount++;
    if (mismatches.length < 100) mismatches.push(value);
  }
  let processedSkus = 0;
  for (const skuId of skus) {
    processedSkus++;
    let balanceCursor: string | undefined;
    do {
      const page = await store.getBalances(
        organizationId,
        warehouseId,
        skuId,
        Math.min(100, maxEntries - balanceCount),
        balanceCursor,
      );
      for (const balance of page.items) {
        balanceCount++;
        const id = identity(balance.skuId, balance.lotCode);
        const quantity = expected.get(id)?.quantity ?? 0;
        if (balance.skuId !== skuId || !Number.isSafeInteger(balance.quantity) || balance.quantity < 0)
          throw new Error('Invalid stored balance; manual investigation required');
        if (quantity !== balance.quantity)
          recordMismatch({ skuId, lotCode: balance.lotCode, expected: quantity, actual: balance.quantity });
        expected.delete(id);
      }
      balanceCursor = page.cursor;
      if (balanceCount >= maxEntries) {
        if (balanceCursor) incomplete = true;
        break;
      }
    } while (balanceCursor);
    if (balanceCount >= maxEntries && processedSkus < skus.size) {
      incomplete = true;
      break;
    }
  }
  if (!incomplete)
    for (const value of expected.values())
      recordMismatch({ skuId: value.skuId, lotCode: value.lotCode, expected: value.quantity, actual: 0 });
  if (statuses.ACCEPTED > 0) incomplete = true;
  return {
    organizationId,
    warehouseId,
    recordedAt: new Date().toISOString(),
    maxEntries,
    entries: seen.size,
    statuses,
    observedSkus: skus.size,
    balances: balanceCount,
    complete: !incomplete,
    matches: !incomplete && mismatchCount === 0,
    mismatchCount,
    mismatches,
    mismatchesTruncated: mismatchCount > mismatches.length,
    scope:
      'SKUs observed in this warehouse history; stock-only orphan SKUs are not enumerated. No global table scans.',
    consistency:
      'Requires paused intake and drained processing, then time for history index replication. This read-only comparison is not an authoritative point-in-time snapshot.',
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      organization: { type: 'string' },
      warehouse: { type: 'string' },
      'max-entries': { type: 'string', default: '100000' },
      quiescent: { type: 'boolean', default: false },
    },
  });
  const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  const organization = id.parse(values.organization),
    warehouse = id.parse(values.warehouse);
  if (!values.quiescent)
    throw new Error(
      'Pause intake, drain processing and allow history replication before passing --quiescent. This command only reads data.',
    );
  const environment = z.enum(['local', 'production']).default('production').parse(process.env.ENVIRONMENT);
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (
    endpoint &&
    (environment !== 'local' ||
      !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname))
  )
    throw new Error('Custom endpoints require local mode and a local emulator hostname');
  const table = z.string().min(3).parse(process.env.TABLE_NAME);
  const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
  try {
    const report = await reconcileWarehouse(
      new DynamoIntakeStore(clients.document, table),
      organization,
      warehouse,
      Number(values['max-entries']),
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.matches) process.exitCode = 1;
  } finally {
    clients.dynamo.destroy();
    clients.sqs.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Reconciliation failed');
    process.exitCode = 1;
  });
}
