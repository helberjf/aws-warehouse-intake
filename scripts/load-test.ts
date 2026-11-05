import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SignJWT } from 'jose';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '1000' },
    concurrency: { type: 'string', default: '10' },
    url: { type: 'string', default: 'http://localhost:3000' },
    'allow-remote': { type: 'boolean', default: false },
    output: { type: 'string' },
  },
});
const count = Number(values.count),
  concurrency = Number(values.concurrency);
if (
  !Number.isSafeInteger(count) ||
  count < 2 ||
  count > 1_000_000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 200
)
  throw new Error('Use count2..1000000 and concurrency1..200');
const url = new URL(values.url!);
if (!['localhost', '127.0.0.1'].includes(url.hostname) && !values['allow-remote'])
  throw new Error('Remote load requires explicit --allow-remote and an isolated test environment');
let token = process.env.LOAD_TEST_TOKEN;
if (!token) {
  if (process.env.ENVIRONMENT !== 'local' || !process.env.LOCAL_JWT_SECRET)
    throw new Error('Supply LOAD_TEST_TOKEN for an isolated environment or explicit local JWT configuration');
  token = await new SignJWT({
    organizationId: 'DEMO',
    producerId: 'load-test',
    warehouseIds: ['WH-01', 'WH-02'],
    roles: ['receiving'],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('load-runner')
    .setIssuer(process.env.JWT_ISSUER ?? 'warehouse-local')
    .setAudience(process.env.JWT_AUDIENCE ?? 'warehouse-api')
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(process.env.LOCAL_JWT_SECRET));
}
const runId = randomUUID();
const started = performance.now();
const latencies: number[] = [];
const accepted: { entryId: string; warehouseId: string }[] = [];
const expected: Record<string, number> = { 'WH-01': 0, 'WH-02': 0 };
const serialBaselines: Record<string, number> = {};
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP${response.status}: ${await response.text()}`);
  return response.json();
}
for (const warehouse of Object.keys(expected)) {
  const stocks = await request(`/warehouses/${warehouse}/stock/SERIAL-001`);
  serialBaselines[warehouse] = stocks.items.reduce(
    (sum: number, item: { quantity: number }) => sum + item.quantity,
    0,
  );
}
let next = 0,
  replayCount = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const index = next++,
        warehouseId = index % 5 === 0 ? 'WH-02' : 'WH-01';
      const serialized = index % 2 === 0;
      const entry = {
        mode: serialized ? 'SERIALIZED' : 'BULK',
        skuId: serialized ? 'SERIAL-001' : 'BULK-001',
        externalReference: `${runId}-${index}`,
        occurredAt: new Date().toISOString(),
        ...(serialized ? { serialNumber: `${runId}-${index}` } : { quantity: 100, lotCode: runId }),
      };
      const begin = performance.now();
      const result = await request(`/warehouses/${warehouseId}/receiving-entries`, {
        method: 'POST',
        headers: { 'idempotency-key': `${runId}-${index}` },
        body: JSON.stringify(entry),
      });
      latencies.push(performance.now() - begin);
      accepted.push({ entryId: result.entryId, warehouseId });
      expected[warehouseId] += serialized ? 1 : 100;
      if (index % 10 === 0) {
        const replay = await request(`/warehouses/${warehouseId}/receiving-entries`, {
          method: 'POST',
          headers: { 'idempotency-key': `retry-${runId}-${index}` },
          body: JSON.stringify(entry),
        });
        if (replay.entryId !== result.entryId) throw new Error('Replay returned a different movement');
        replayCount++;
      }
    }
  }),
);
const acceptedMs = performance.now() - started;
const pending = new Map(accepted.map((entry) => [entry.entryId, entry]));
const deadline = Date.now() + 600000;
while (pending.size) {
  const entries = [...pending.values()];
  let statusIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (statusIndex < entries.length) {
        const entry = entries[statusIndex++];
        const state = await request(`/warehouses/${entry.warehouseId}/receiving-entries/${entry.entryId}`);
        if (state.status === 'REJECTED') throw new Error(`Unexpected rejection ${entry.entryId}`);
        if (state.status === 'APPLIED') pending.delete(entry.entryId);
      }
    }),
  );
  if (Date.now() > deadline)
    throw new Error(`Drain deadline exceeded with ${pending.size} movements pending`);
  if (pending.size) await new Promise((resolve) => setTimeout(resolve, 1000));
}
const actual: Record<string, number> = {};
for (const warehouse of Object.keys(expected)) {
  const serialized = await request(`/warehouses/${warehouse}/stock/SERIAL-001`);
  let bulkQuantity = 0,
    cursor: string | undefined;
  do {
    const bulk = await request(
      `/warehouses/${warehouse}/stock/BULK-001?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    bulkQuantity += bulk.items
      .filter((item: { lotCode?: string }) => item.lotCode === runId)
      .reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);
    cursor = bulk.cursor;
  } while (cursor);
  actual[warehouse] =
    serialized.items.reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0) -
    serialBaselines[warehouse] +
    bulkQuantity;
  if (actual[warehouse] !== expected[warehouse])
    throw new Error(`Stock mismatch ${warehouse}: expected${expected[warehouse]} actual${actual[warehouse]}`);
}
latencies.sort((a, b) => a - b);
const report = {
  runId,
  environment: url.origin,
  recordedAt: new Date().toISOString(),
  movements: count,
  physicalUnits: Object.values(expected).reduce((a, b) => a + b, 0),
  httpReplays: replayCount,
  concurrency,
  acceptedSeconds: acceptedMs / 1000,
  totalSeconds: (performance.now() - started) / 1000,
  acceptedMovementsPerSecond: count / (acceptedMs / 1000),
  acceptanceLatencyMs: {
    p50: latencies[Math.ceil(count * 0.5) - 1],
    p95: latencies[Math.ceil(count * 0.95) - 1],
    p99: latencies[Math.ceil(count * 0.99) - 1],
  },
  allApplied: true,
  expectedStock: expected,
  actualStock: actual,
  note: 'Synthetic test against the named endpoint; local emulation does not establish AWS production capacity or cost. Use an isolated DEMO catalog without concurrent unrelated serialized receipts.',
};
if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
