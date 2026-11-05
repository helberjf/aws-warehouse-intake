import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { createClients } from '../src/clients.ts';
import { DynamoIntakeStore } from '../src/storage/dynamo-store.ts';
import { IdentityService } from '../src/identity/service.ts';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '100000' },
    concurrency: { type: 'string', default: '32' },
    rate: { type: 'string', default: '0' },
    warehouses: { type: 'string', default: '16' },
    distribution: { type: 'string', default: 'even' },
    workflow: { type: 'string', default: 'receiving' },
    'drain-timeout-seconds': { type: 'string', default: '14400' },
    url: { type: 'string', default: process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000' },
    output: { type: 'string' },
  },
});
const config = z
  .object({
    count: z.coerce.number().int().min(1).max(1_000_000),
    concurrency: z.coerce.number().int().min(1).max(256),
    rate: z.coerce.number().min(0).max(10000),
    warehouses: z.coerce.number().int().min(1).max(100),
    distribution: z.enum(['even', 'hot']),
    workflow: z.enum(['receiving', 'browser']),
    drainTimeout: z.coerce.number().int().min(5).max(86400),
  })
  .parse({ ...values, drainTimeout: values['drain-timeout-seconds'] });
if (config.count > 10000 && !values.output)
  throw new Error('--output is required for runs above10000 receipts');
const endpoint = process.env.AWS_ENDPOINT_URL;
const origin = new URL(values.url!);
if (
  process.env.ENVIRONMENT !== 'local' ||
  !endpoint ||
  !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname) ||
  !['localhost', '127.0.0.1'].includes(origin.hostname) ||
  origin.origin !== values.url
)
  throw new Error('This runner only operates against explicitly configured local API and AWS emulation');
if (process.env.PUBLIC_ORIGIN && origin.origin !== process.env.PUBLIC_ORIGIN)
  throw new Error('--url must match PUBLIC_ORIGIN exactly for session authentication');
const tableName = z.string().min(3).parse(process.env.TABLE_NAME);
const runId = randomUUID();
const organizationId = `LOAD-${runId}`;
const skuId = `PACKAGE-${runId.slice(0, 8)}`;
const barcode = `LOAD-${runId}`;
const producerId = 'warehouse-load';
const warehouseIds = Array.from(
  { length: config.warehouses },
  (_, i) => `WH-${String(i + 1).padStart(2, '0')}`,
);
const output = resolve(values.output ?? `.tokens/warehouse-load-${runId}.json`);
const startedAt = new Date().toISOString();
const clockStart = performance.now();
const abort = new AbortController();
let phase = 'setup',
  interrupted = false,
  fatal: string | undefined;
let cookie = '',
  csrf = '',
  sessionSubject = '';
let refreshPromise: Promise<void> | undefined;
let launchStart = 0,
  launchWall = 0,
  submissionEnded = 0,
  drainObserved = 0,
  verificationEnded = 0;
let launched = 0,
  accepted = 0,
  failed = 0,
  completedTasks = 0,
  duplicates = 0,
  retries = 0;
let droppedCapacity = 0,
  droppedSchedule = 0,
  observedStock = 0,
  historyPages = 0,
  verified = 0,
  rejected = 0;
let latestCompletion = 0,
  verificationErrors = 0;
let failureEvents = 0;
const failures: { stage: string; index?: number; code: string }[] = [];
const attemptStatuses: Record<string, number> = {};
const requestCounts: Record<string, number> = {};
const acceptanceLatencies: number[] = [],
  workflowLatencies: number[] = [],
  scheduleLags: number[] = [],
  completionLatencies: number[] = [];
const warehouseStats = warehouseIds.map((warehouseId) => ({
  warehouseId,
  launched: 0,
  accepted: 0,
  failed: 0,
  dropped: 0,
  verified: 0,
  actualStock: 0,
  expectedStock: 0,
  acceptanceLatencies: [] as number[],
  completionLatencies: [] as number[],
}));
type Receipt = { index: number; warehouse: number; entryId: string; confirmed: boolean; verified: boolean };
const receipts = new Map<string, Receipt>();
let reportChain = Promise.resolve();
let clients: ReturnType<typeof createClients> | undefined;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
const pct = (samples: number[]) => {
  if (!samples.length) return { samples: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
};
function warehouseFor(index: number) {
  if (config.distribution === 'even' || config.warehouses === 1) return index % config.warehouses;
  return index % 5 !== 4 ? 0 : 1 + (Math.floor(index / 5) % (config.warehouses - 1));
}
function safeCode(error: unknown) {
  if (error instanceof HttpFailure) return `HTTP_${error.status}`;
  if (error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name))
    return error.name;
  return 'REQUEST_OR_VALIDATION_FAILED';
}
function fail(stage: string, error: unknown, index?: number) {
  failureEvents++;
  if (failures.length < 100) failures.push({ stage, index, code: safeCode(error) });
}
function report(final = false) {
  const elapsed = (performance.now() - clockStart) / 1000;
  const acceptanceSeconds = launchStart ? ((submissionEnded || performance.now()) - launchStart) / 1000 : 0;
  const allApplied =
    launched > 0 &&
    verified === accepted &&
    accepted === launched &&
    rejected === 0 &&
    verificationErrors === 0 &&
    Boolean(verificationEnded);
  return {
    schemaVersion: 1,
    runId,
    organizationId,
    skuId,
    producerId,
    warehouseIds,
    startedAt,
    updatedAt: new Date().toISOString(),
    phase,
    environment: { api: origin.origin, awsEndpoint: endpoint, tableName, localOnly: true },
    profile: {
      ...config,
      physicalUnitsPerMovement: 1,
      trackingMode: 'SERIALIZED',
      oneSkuPerRun: true,
      auth: 'real HTTP password login, HttpOnly session cookie and CSRF',
      workflowDetail:
        config.workflow === 'receiving'
          ? 'Authenticated receiving POST plus one exact HTTP replay per100 scheduled receipts'
          : 'HTTP approximation of browser: barcode lookup, POST, history20, up to2 status reads spaced250ms, second history20 and stock read. The UI polls every2s; no DOM rendering or physical camera is exercised.',
      scheduler:
        config.rate === 0
          ? 'Closed-loop bounded concurrency'
          : 'Open-loop scheduled arrivals; slots drop when concurrency is exhausted or scheduler lag exceeds1 second; no waiting request queue',
    },
    counts: {
      target: config.count,
      launched,
      accepted,
      failed,
      failureEvents,
      completedTasks,
      duplicateProbes: duplicates,
      httpRetries: retries,
      droppedCapacity,
      droppedSchedule,
      notLaunched: config.count - launched,
      observedStock,
      verifiedApplied: verified,
      rejected,
      verificationErrors,
      historyPages,
    },
    timing: {
      elapsedSeconds: elapsed,
      acceptanceSeconds,
      acceptanceRate: acceptanceSeconds ? accepted / acceptanceSeconds : 0,
      submissionEndedAt: submissionEnded
        ? new Date(launchWall + submissionEnded - launchStart).toISOString()
        : null,
      processingFinishedAt: latestCompletion ? new Date(latestCompletion).toISOString() : null,
      processingSeconds: latestCompletion && launchWall ? (latestCompletion - launchWall) / 1000 : null,
      drainObservedSeconds: drainObserved && launchStart ? (drainObserved - launchStart) / 1000 : null,
      verificationSeconds:
        verificationEnded && drainObserved ? (verificationEnded - drainObserved) / 1000 : null,
    },
    ...(final
      ? {
          latencyMs: {
            acceptanceIncludingRetries: pct(acceptanceLatencies),
            workflow: pct(workflowLatencies),
            scheduledStartLag: pct(scheduleLags),
            serverAcceptanceToCompletion: pct(completionLatencies),
          },
        }
      : {}),
    perWarehouse: warehouseStats.map(
      ({ acceptanceLatencies: acceptance, completionLatencies: completion, ...rest }) => ({
        ...rest,
        ...(final ? { acceptanceLatencyMs: pct(acceptance), completionLatencyMs: pct(completion) } : {}),
      }),
    ),
    requestCounts,
    attemptStatuses,
    failures,
    failureSamplesTruncated: failureEvents > failures.length,
    outcome: {
      complete: final && !fatal && !interrupted,
      allApplied,
      targetMet: allApplied && accepted === config.count && failed === 0 && !fatal && !interrupted,
      interrupted,
      fatal,
    },
    limitations: [
      'Local emulation and a load driver on the same host do not establish AWS production capacity or cost.',
      'GSI history is checked after consistent stock reaches the expected total; missing/stale entries receive bounded consistent status reads.',
      'HTTP failures are retried with the exact original body, reference and idempotency key; exhausted retries stop new submissions and leave a partial report.',
    ],
  };
}
async function checkpoint(final = false) {
  const snapshot = JSON.stringify(report(final), null, 2) + '\n';
  reportChain = reportChain.then(async () => {
    await mkdir(dirname(output), { recursive: true });
    const temp = `${output}.tmp`;
    await writeFile(temp, snapshot);
    await rename(temp, output);
  });
  await reportChain;
}
function progress() {
  console.log(
    JSON.stringify({
      event: 'warehouse_load_progress',
      runId,
      organizationId,
      phase,
      elapsedSeconds: Math.round((performance.now() - clockStart) / 1000),
      launched,
      accepted,
      failed,
      duplicates,
      dropped: droppedCapacity + droppedSchedule,
      observedStock,
      verified,
      output,
    }),
  );
}
class HttpFailure extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}
async function login() {
  const response = await fetch(`${origin.origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origin.origin },
    body: JSON.stringify({ organizationId, username: 'load.runner', password }),
    signal: AbortSignal.timeout(30000),
  });
  requestCounts.login = (requestCounts.login ?? 0) + 1;
  if (!response.ok) throw new HttpFailure(response.status);
  const header = response.headers.getSetCookie().find((value) => value.startsWith('warehouse_session='));
  const body = (await response.json()) as { csrfToken: string; user: { subject: string } };
  if (!header || !body.csrfToken || !body.user?.subject) throw new Error('Invalid login response');
  cookie = header.split(';')[0];
  csrf = body.csrfToken;
  sessionSubject = body.user.subject;
}
async function request<T = Record<string, unknown>>(
  stage: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (abort.signal.aborted) throw new DOMException('Interrupted', 'AbortError');
    requestCounts[stage] = (requestCounts[stage] ?? 0) + 1;
    try {
      const response = await fetch(new URL(path, origin), {
        ...init,
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: origin.origin,
          'x-csrf-token': csrf,
          ...init.headers,
        },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      });
      attemptStatuses[String(response.status)] = (attemptStatuses[String(response.status)] ?? 0) + 1;
      if (response.status === 401 && !refreshed) {
        await response.arrayBuffer();
        refreshed = true;
        refreshPromise ??= login().finally(() => {
          refreshPromise = undefined;
        });
        await refreshPromise;
        retries++;
        continue;
      }
      if (!response.ok) {
        await response.arrayBuffer();
        throw new HttpFailure(response.status);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      const transient = !(error instanceof HttpFailure) || error.status === 429 || error.status >= 500;
      if (!transient || attempt === 3 || abort.signal.aborted) throw error;
      retries++;
      await sleep(200 * 2 ** attempt + Math.random() * 100);
    }
  }
  throw new Error('HTTP retry budget exhausted');
}
const password = randomBytes(32).toString('base64url');
async function submit(index: number, warehouse: number) {
  const start = performance.now();
  const warehouseId = warehouseIds[warehouse];
  const reference = `${runId}-${index}`;
  const entryId = createHash('sha256')
    .update(JSON.stringify([organizationId, warehouseId, producerId, reference]))
    .digest('hex');
  const receipt: Receipt = { index, warehouse, entryId, confirmed: false, verified: false };
  receipts.set(entryId, receipt);
  const body = JSON.stringify({
    mode: 'SERIALIZED',
    skuId,
    serialNumber: `PKG-${reference}`,
    externalReference: reference,
    occurredAt: new Date().toISOString(),
  });
  const path = `/warehouses/${warehouseId}/receiving-entries`;
  const init = { method: 'POST', headers: { 'idempotency-key': reference }, body };
  launched++;
  warehouseStats[warehouse].launched++;
  try {
    if (config.workflow === 'browser') {
      const lookup = await request<{ skuId: string }>('lookup', `/products/lookup?code=${barcode}`);
      if (lookup.skuId !== skuId) throw new Error('Barcode resolved to unexpected SKU');
    }
    const acceptanceStart = performance.now();
    const acceptedEntry = await request<{ entryId: string }>('receiving', path, init);
    if (acceptedEntry.entryId !== entryId) throw new Error('Unexpected acceptance identity');
    receipt.confirmed = true;
    accepted++;
    warehouseStats[warehouse].accepted++;
    warehouseStats[warehouse].expectedStock++;
    const duration = performance.now() - acceptanceStart;
    acceptanceLatencies.push(duration);
    warehouseStats[warehouse].acceptanceLatencies.push(duration);
    if (index % 100 === 0) {
      const replay = await request<{ entryId: string }>('duplicate', path, init);
      if (replay.entryId !== entryId) throw new Error('Replay changed entry identity');
      duplicates++;
    }
    if (config.workflow === 'browser') {
      await request('browser-history', `${path}?limit=20`);
      for (let poll = 0; poll < 2; poll++) {
        const status = await request<{ status: string }>('browser-status', `${path}/${entryId}`);
        if (status.status === 'REJECTED') throw new Error('Unexpected business rejection');
        if (status.status === 'APPLIED') break;
        if (poll === 0) await sleep(250);
      }
      await request('browser-history', `${path}?limit=20`);
      await request('browser-stock', `/warehouses/${warehouseId}/stock/${skuId}?limit=100`);
    }
    workflowLatencies.push(performance.now() - start);
  } catch (error) {
    failed++;
    warehouseStats[warehouse].failed++;
    fail('submission', error, index);
    fatal ??= `Submission failed at index ${index}; inspect counters and the retained isolated dataset.`;
    abort.abort();
  } finally {
    completedTasks++;
  }
}
async function submitAll() {
  launchStart = performance.now();
  launchWall = Date.now();
  phase = 'submitting';
  if (config.rate === 0) {
    let index = 0;
    await Promise.all(
      Array.from({ length: config.concurrency }, async () => {
        while (index < config.count && !abort.signal.aborted) {
          const next = index++;
          scheduleLags.push(0);
          await submit(next, warehouseFor(next));
        }
      }),
    );
  } else {
    const active = new Set<Promise<void>>();
    for (let index = 0; index < config.count && !abort.signal.aborted; index++) {
      const due = launchStart + (index * 1000) / config.rate;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      if (abort.signal.aborted) break;
      const lag = Math.max(0, performance.now() - due);
      scheduleLags.push(lag);
      const warehouse = warehouseFor(index);
      if (lag > 1000) {
        droppedSchedule++;
        warehouseStats[warehouse].dropped++;
        continue;
      }
      if (active.size >= config.concurrency) {
        droppedCapacity++;
        warehouseStats[warehouse].dropped++;
        continue;
      }
      const task = submit(index, warehouse).finally(() => {
        active.delete(task);
      });
      active.add(task);
    }
    await Promise.all(active);
  }
  submissionEnded = performance.now();
  progress();
  await checkpoint();
}
type BalancePage = { items: { skuId: string; quantity: number; lotCode?: string }[]; cursor?: string };
async function readStock() {
  let next = 0;
  const totals = new Array<number>(warehouseIds.length).fill(0);
  await Promise.all(
    Array.from({ length: Math.min(4, warehouseIds.length) }, async () => {
      while (next < warehouseIds.length) {
        const position = next++;
        let cursor: string | undefined;
        do {
          const page = await request<BalancePage>(
            'verification-stock',
            `/warehouses/${warehouseIds[position]}/stock/${skuId}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          for (const row of page.items) {
            if (row.skuId !== skuId || row.lotCode !== undefined || !Number.isSafeInteger(row.quantity))
              throw new Error('Unexpected stock shape');
            totals[position] += row.quantity;
          }
          cursor = page.cursor;
        } while (cursor);
        warehouseStats[position].actualStock = totals[position];
        if (totals[position] > warehouseStats[position].expectedStock)
          throw new Error('Stock exceeds accepted units');
      }
    }),
  );
  observedStock = totals.reduce((sum, n) => sum + n, 0);
  return totals.every((n, index) => n === warehouseStats[index].expectedStock);
}
type Ledger = {
  entryId: string;
  warehouseId: string;
  quantity: number;
  status: string;
  acceptedAt: string;
  completedAt?: string;
  recordedBy?: { subject: string };
  entry: { skuId: string; mode: string; serialNumber: string; externalReference: string };
};
function observe(entry: Ledger, warehouse: number) {
  const expected = receipts.get(entry.entryId);
  if (
    !expected ||
    expected.warehouse !== warehouse ||
    entry.warehouseId !== warehouseIds[warehouse] ||
    entry.quantity !== 1 ||
    entry.entry.skuId !== skuId ||
    entry.entry.mode !== 'SERIALIZED' ||
    entry.entry.serialNumber !== `PKG-${runId}-${expected.index}` ||
    entry.entry.externalReference !== `${runId}-${expected.index}` ||
    entry.recordedBy?.subject !== sessionSubject
  ) {
    verificationErrors++;
    throw new Error('Ledger verification mismatch');
  }
  if (entry.status === 'REJECTED') {
    rejected++;
    throw new Error('Unexpected rejected ledger entry');
  }
  if (entry.status !== 'APPLIED' || expected.verified) return;
  const completed = Date.parse(entry.completedAt ?? ''),
    acceptedAt = Date.parse(entry.acceptedAt);
  if (!Number.isFinite(completed) || !Number.isFinite(acceptedAt) || completed < acceptedAt) {
    verificationErrors++;
    throw new Error('Invalid ledger completion timestamp');
  }
  expected.verified = true;
  verified++;
  warehouseStats[warehouse].verified++;
  completionLatencies.push(completed - acceptedAt);
  warehouseStats[warehouse].completionLatencies.push(completed - acceptedAt);
  latestCompletion = Math.max(latestCompletion, completed);
}
async function verifyLedger() {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, warehouseIds.length) }, async () => {
      while (next < warehouseIds.length) {
        const warehouse = next++;
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await request<{ items: Ledger[]; cursor?: string }>(
            'verification-history',
            `/warehouses/${warehouseIds[warehouse]}/receiving-entries?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          historyPages++;
          for (const entry of page.items) {
            if (seen.has(entry.entryId)) {
              verificationErrors++;
              throw new Error('Duplicate entry in paginated history');
            }
            seen.add(entry.entryId);
            observe(entry, warehouse);
          }
          cursor = page.cursor;
        } while (cursor);
      }
    }),
  );
  // Only entries absent or stale in the GSI need consistent direct reads, never repeated100k-ID polling.
  const missing = [...receipts.values()].filter((entry) => entry.confirmed && !entry.verified);
  let position = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, missing.length) }, async () => {
      while (position < missing.length) {
        const expected = missing[position++];
        const entry = await request<Ledger>(
          'verification-status',
          `/warehouses/${warehouseIds[expected.warehouse]}/receiving-entries/${expected.entryId}`,
        );
        observe(entry, expected.warehouse);
      }
    }),
  );
  if (verified !== accepted) throw new Error('Not every accepted entry was verified APPLIED');
}
async function run() {
  const stop = () => {
    interrupted = true;
    fatal ??= 'Interrupted before complete verification';
    abort.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  progress();
  await checkpoint();
  const timer = setInterval(() => {
    progress();
    void checkpoint().catch(() => {
      fatal = 'Unable to persist progress report';
      abort.abort();
    });
  }, 15000);
  timer.unref();
  try {
    clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
    await clients.dynamo.send(new DescribeTableCommand({ TableName: tableName }));
    const store = new DynamoIntakeStore(clients.document, tableName);
    for (const warehouseId of warehouseIds)
      await store.putWarehouse(organizationId, {
        warehouseId,
        name: `Load test ${warehouseId}`,
        active: true,
      });
    await store.putProduct(
      organizationId,
      { skuId, barcode, name: 'Synthetic serialized package', trackingMode: 'SERIALIZED', active: true },
      { subject: 'system:warehouse-load', displayName: 'Load test setup' },
    );
    await new IdentityService(clients.document, tableName).provisionUser({
      organizationId,
      username: 'load.runner',
      password,
      displayName: 'Isolated load operator',
      producerId,
      warehouseIds,
      roles: ['receiving'],
    });
    await login();
    await submitAll();
    if (fatal || abort.signal.aborted) throw new Error('Submission stopped');
    phase = 'draining';
    progress();
    await checkpoint();
    const deadline = Date.now() + config.drainTimeout * 1000;
    while (!(await readStock())) {
      if (Date.now() > deadline) throw new Error('Drain timeout exceeded');
      if (abort.signal.aborted) throw new Error('Interrupted');
      await sleep(15000);
    }
    drainObserved = performance.now();
    phase = 'verifying';
    progress();
    await checkpoint();
    await verifyLedger();
    if (!(await readStock())) throw new Error('Stock changed during final verification');
    verificationEnded = performance.now();
    phase = droppedCapacity || droppedSchedule ? 'completed_with_dropped_arrivals' : 'completed';
  } catch (error) {
    fail(phase, error);
    fatal ??=
      error instanceof Error &&
      ['Drain timeout exceeded', 'Not every accepted entry was verified APPLIED'].includes(error.message)
        ? error.message
        : 'Run failed before complete reconciliation; inspect retained dataset and failure counters';
    phase = interrupted ? 'interrupted' : 'failed';
  } finally {
    clearInterval(timer);
    // Revoke the runner session without exposing its cookie; leave synthetic rows for independent audit.
    if (cookie)
      try {
        await fetch(`${origin.origin}/auth/logout`, {
          method: 'POST',
          headers: { cookie, origin: origin.origin, 'x-csrf-token': csrf },
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* Logical expiry still applies if the API is unavailable. */
      }
    clients?.dynamo.destroy();
    clients?.sqs.destroy();
    await checkpoint(true);
    progress();
    console.log(JSON.stringify(report(true), null, 2));
    if (!report(true).outcome.targetMet) process.exitCode = 1;
  }
}
await run();
