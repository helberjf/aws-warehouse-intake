import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { createClients } from '../src/clients.ts';

const { values } = parseArgs({
  options: {
    report: { type: 'string' },
    output: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
  },
});
if (!values.report || !values.output)
  throw new Error('Use --report <completed-run.json> --output <audit.json>');
const sourcePath = resolve(values.report),
  outputPath = resolve(values.output);
if (sourcePath === outputPath) throw new Error('The audit output must not replace the load report');
const concurrency = z.coerce.number().int().min(4).max(8).parse(values.concurrency);
const endpoint = process.env.AWS_ENDPOINT_URL;
if (
  process.env.ENVIRONMENT !== 'local' ||
  !endpoint ||
  !['http:', 'https:'].includes(new URL(endpoint).protocol) ||
  !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname) ||
  new URL(endpoint).username ||
  new URL(endpoint).password
)
  throw new Error('Audit requires explicit local mode and a local AWS emulator endpoint');
if ((await stat(sourcePath)).size > 10 * 1024 * 1024)
  throw new Error('Load report exceeds the 10 MiB input limit');
const sourceText = await readFile(sourcePath, 'utf8');
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const source = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    organizationId: identifier,
    skuId: identifier,
    producerId: identifier,
    warehouseIds: z.array(identifier).min(1).max(100),
    environment: z.object({ localOnly: z.literal(true), tableName: z.string().min(3), awsEndpoint: z.url() }),
    profile: z.object({
      count: z.number().int().min(1).max(1_000_000),
      warehouses: z.number().int().min(1).max(100),
      distribution: z.enum(['even', 'hot']),
      physicalUnitsPerMovement: z.literal(1),
      trackingMode: z.literal('SERIALIZED'),
    }),
    counts: z.object({
      target: z.number().int().positive(),
      launched: z.number().int().nonnegative(),
      accepted: z.number().int().nonnegative(),
      failed: z.literal(0),
      notLaunched: z.literal(0),
      droppedCapacity: z.literal(0),
      droppedSchedule: z.literal(0),
      verifiedApplied: z.number().int().nonnegative(),
      rejected: z.literal(0),
      verificationErrors: z.literal(0),
    }),
    outcome: z.object({
      complete: z.literal(true),
      targetMet: z.literal(true),
      allApplied: z.literal(true),
      interrupted: z.literal(false),
    }),
  })
  .parse(JSON.parse(sourceText));
const count = source.counts.target;
if (
  source.counts.accepted !== count ||
  source.counts.launched !== count ||
  source.counts.verifiedApplied !== count ||
  source.profile.count !== count ||
  source.warehouseIds.length !== source.profile.warehouses ||
  new Set(source.warehouseIds).size !== source.warehouseIds.length
)
  throw new Error(
    'Source report must show every target receipt accepted and verified in distinct warehouses',
  );
if (source.environment.tableName !== process.env.TABLE_NAME || source.environment.awsEndpoint !== endpoint)
  throw new Error('The current local table and emulator must match the source report');

const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
const tableName = source.environment.tableName;
const startedAt = new Date().toISOString(),
  start = performance.now();
const digest = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const counters = {
  expectedReceipts: count,
  expectedRecords: count * 2,
  checked: 0,
  outboxChecked: 0,
  unitChecked: 0,
  missing: 0,
  mismatched: 0,
  unprocessedExhausted: 0,
  batchRequests: 0,
  batchRetries: 0,
};
const examples: { index: number; type: string; reason: string }[] = [];
let errorCode: string | undefined;
let globalState: Awaited<ReturnType<typeof observeGlobalState>> | undefined;
type Expected = {
  index: number;
  type: 'outbox' | 'unit';
  pk: string;
  entryId: string;
  warehouseId: string;
  messageGroupId: string;
};
function example(expected: Expected, reason: string) {
  if (examples.length < 50) examples.push({ index: expected.index, type: expected.type, reason });
}
function warehouseFor(index: number): string {
  if (source.profile.distribution === 'even' || source.warehouseIds.length === 1)
    return source.warehouseIds[index % source.warehouseIds.length];
  return source.warehouseIds[
    index % 5 !== 4 ? 0 : 1 + (Math.floor(index / 5) % (source.warehouseIds.length - 1))
  ];
}
function expectedRecords(index: number): Expected[] {
  const warehouseId = warehouseFor(index);
  const reference = `${source.runId}-${index}`;
  const entryId = digest([source.organizationId, warehouseId, source.producerId, reference]);
  const unitKey = digest([source.organizationId, source.skuId, `PKG-${reference}`]);
  const common = {
    index,
    entryId,
    warehouseId,
    messageGroupId: digest([source.organizationId, warehouseId]),
  };
  return [
    { ...common, type: 'outbox', pk: `OUTBOX#${entryId}` },
    { ...common, type: 'unit', pk: `UNIT#${unitKey}` },
  ];
}
function validateRecord(expected: Expected, row: Record<string, unknown>) {
  counters.checked++;
  if (expected.type === 'outbox') counters.outboxChecked++;
  else counters.unitChecked++;
  let reason: string | undefined;
  if (row.pk !== expected.pk || row.sk !== 'META' || row.entryId !== expected.entryId)
    reason = 'IDENTITY_MISMATCH';
  else if (expected.type === 'unit' && row.warehouseId !== expected.warehouseId)
    reason = 'UNIT_WAREHOUSE_MISMATCH';
  else if (
    expected.type === 'outbox' &&
    (row.state !== 'PUBLISHED' || row.messageGroupId !== expected.messageGroupId)
  )
    reason = 'OUTBOX_NOT_PUBLISHED_OR_GROUP_MISMATCH';
  else if (
    expected.type === 'outbox' &&
    ['duePK', 'dueSK', 'leaseToken', 'leaseUntil'].some((key) => row[key] !== undefined)
  )
    reason = 'PUBLISHED_OUTBOX_RETAINS_PENDING_ATTRIBUTES';
  if (reason) {
    counters.mismatched++;
    example(expected, reason);
  }
}
async function auditBatch(expected: Expected[]) {
  const requested = new Map(expected.map((record) => [record.pk, record]));
  const found = new Set<string>();
  let pending = expected.map((record) => ({ pk: record.pk, sk: 'META' }));
  for (let attempt = 0; pending.length && attempt < 8; attempt++) {
    counters.batchRequests++;
    const response = await clients.document.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            ConsistentRead: true,
            ProjectionExpression:
              'pk, sk, entryId, warehouseId, #state, messageGroupId, duePK, dueSK, leaseToken, leaseUntil',
            ExpressionAttributeNames: { '#state': 'state' },
          },
        },
      }),
    );
    for (const row of response.Responses?.[tableName] ?? []) {
      const record = requested.get(row.pk as string);
      if (!record || found.has(record.pk)) throw new Error('UNEXPECTED_BATCH_RESPONSE');
      found.add(record.pk);
      validateRecord(record, row);
    }
    pending = (response.UnprocessedKeys?.[tableName]?.Keys ?? []) as typeof pending;
    if (pending.some((key) => !requested.has(key.pk) || found.has(key.pk)))
      throw new Error('INVALID_UNPROCESSED_KEYS');
    if (pending.length && attempt < 7) {
      counters.batchRetries++;
      await sleep(Math.min(2000, 50 * 2 ** attempt) + Math.random() * 40);
    }
  }
  const unprocessed = new Set(pending.map((key) => key.pk));
  for (const record of expected) {
    if (found.has(record.pk)) continue;
    if (unprocessed.has(record.pk)) {
      counters.unprocessedExhausted++;
      example(record, 'UNPROCESSED_RETRY_EXHAUSTED');
    } else {
      counters.missing++;
      example(record, 'RECORD_MISSING');
    }
  }
}
function localQueueUrl(raw: string): string {
  const received = new URL(raw);
  // QueueUrl returned by the emulator can name its internal Docker hostname.
  // Preserve its resource path while forcing the already-validated local endpoint.
  return new URL(received.pathname, endpoint).href;
}
async function queueDepth(queueUrl: string) {
  const response = await clients.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
        'RedrivePolicy',
      ],
    }),
  );
  const attributes = response.Attributes ?? {};
  const numeric = (
    name:
      | 'ApproximateNumberOfMessages'
      | 'ApproximateNumberOfMessagesNotVisible'
      | 'ApproximateNumberOfMessagesDelayed',
  ) => z.coerce.number().int().min(0).parse(attributes[name]);
  return {
    visible: numeric('ApproximateNumberOfMessages'),
    inFlight: numeric('ApproximateNumberOfMessagesNotVisible'),
    delayed: numeric('ApproximateNumberOfMessagesDelayed'),
    redrivePolicy: attributes.RedrivePolicy,
  };
}
async function observeGlobalState() {
  const queueName =
    process.env.QUEUE_NAME ??
    new URL(z.url().parse(process.env.QUEUE_URL)).pathname.split('/').filter(Boolean).at(-1);
  if (!queueName || !/^[A-Za-z0-9_-]{1,80}$/.test(queueName)) throw new Error('INVALID_LOCAL_QUEUE_NAME');
  const primaryUrlResponse = await clients.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const primaryUrl = localQueueUrl(z.url().parse(primaryUrlResponse.QueueUrl));
  let primary = await queueDepth(primaryUrl);
  const redrive = z
    .object({
      deadLetterTargetArn: z.string().regex(/^arn:aws[^:]*:sqs:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$/),
    })
    .parse(JSON.parse(primary.redrivePolicy ?? '{}'));
  const dlqName = redrive.deadLetterTargetArn.split(':').at(-1)!;
  const dlqResponse = await clients.sqs.send(new GetQueueUrlCommand({ QueueName: dlqName }));
  const dlqUrl = localQueueUrl(z.url().parse(dlqResponse.QueueUrl));
  let dlq = await queueDepth(dlqUrl);
  let pendingShards: number[] = [];
  let observations = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) {
      await sleep(2000);
      [primary, dlq] = await Promise.all([queueDepth(primaryUrl), queueDepth(dlqUrl)]);
    }
    const shards: number[] = [];
    let nextShard = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (nextShard < 16) {
          const shard = nextShard++;
          const response = await clients.document.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'due-index',
              KeyConditionExpression: 'duePK = :pk',
              ExpressionAttributeValues: { ':pk': `OUTBOX#v1#${String(shard).padStart(2, '0')}` },
              Select: 'COUNT',
              Limit: 1,
            }),
          );
          if ((response.Count ?? 0) > 0) shards.push(shard);
        }
      }),
    );
    pendingShards = shards.sort((a, b) => a - b);
    observations++;
    if (
      !pendingShards.length &&
      primary.visible + primary.inFlight + primary.delayed + dlq.visible + dlq.inFlight + dlq.delayed === 0
    )
      break;
  }
  const { redrivePolicy: ignoredPrimary, ...primaryDepth } = primary;
  const { redrivePolicy: ignoredDlq, ...dlqDepth } = dlq;
  return {
    observations,
    primary: primaryDepth,
    deadLetter: dlqDepth,
    pendingOutbox: {
      checkedShards: 16,
      limitPerShard: 1,
      nonemptyShards: pendingShards,
      minimumRecords: pendingShards.length,
      exactCount: pendingShards.length === 0,
    },
    observedIdle:
      pendingShards.length === 0 &&
      Object.values(primaryDepth).every((value) => value === 0) &&
      Object.values(dlqDepth).every((value) => value === 0),
    scope: 'Global shared queue, DLQ and outbox-index observations; not attributed solely to this run.',
  };
}

let next = 0;
let readFailed = false;
const timer = setInterval(
  () => console.log(JSON.stringify({ event: 'warehouse_audit_progress', runId: source.runId, ...counters })),
  15000,
);
timer.unref();
try {
  const reads = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      try {
        while (next < count && !readFailed) {
          const begin = next;
          next += 50;
          const batch: Expected[] = [];
          for (let index = begin; index < Math.min(count, begin + 50); index++)
            batch.push(...expectedRecords(index));
          await auditBatch(batch);
        }
      } catch (error) {
        readFailed = true;
        throw error;
      }
    }),
  );
  const failedRead = reads.find((result) => result.status === 'rejected');
  if (failedRead?.status === 'rejected') throw failedRead.reason;
  globalState = await observeGlobalState();
} catch (error) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  errorCode = [
    'ValidationException',
    'ResourceNotFoundException',
    'CredentialsProviderError',
    'TimeoutError',
  ].includes(name)
    ? name
    : 'AUDIT_READ_OR_VALIDATION_FAILED';
} finally {
  clearInterval(timer);
  clients.dynamo.destroy();
  clients.sqs.destroy();
  const recordsValid =
    counters.checked === count * 2 &&
    counters.outboxChecked === count &&
    counters.unitChecked === count &&
    counters.missing === 0 &&
    counters.mismatched === 0 &&
    counters.unprocessedExhausted === 0;
  const passed = !errorCode && recordsValid && globalState?.observedIdle === true;
  const result = {
    schemaVersion: 1,
    audit: 'Independent read-only post-run outbox and unit registry audit',
    runId: source.runId,
    sourceReportSha256: createHash('sha256').update(sourceText).digest('hex'),
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds: (performance.now() - start) / 1000,
    readConsistency: 'Strongly consistent BatchGet for outbox and unit records',
    concurrency,
    counters,
    examples,
    examplesTruncated:
      counters.missing + counters.mismatched + counters.unprocessedExhausted > examples.length,
    globalState,
    outcome: { passed, recordsValid, errorCode },
    limitations: [
      'Queue attributes are approximate and the due-index is eventually consistent; an idle observation is not an atomic snapshot.',
      'Global queue/DLQ/index activity can belong to other runs. Per-record identity and warehouse checks belong to this run.',
      'Published outbox records expire after seven days; perform this audit before their TTL removal.',
      'This read-only local emulator audit supplements API ledger/stock verification and does not establish AWS production performance.',
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(`${outputPath}.tmp`, JSON.stringify(result, null, 2) + '\n');
  await rename(`${outputPath}.tmp`, outputPath);
  console.log(JSON.stringify(result, null, 2));
  if (!passed) process.exitCode = 1;
}
