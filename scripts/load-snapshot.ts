import { readFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { createClients } from '../src/clients.ts';
import { keys } from '../src/storage/dynamo-store.ts';

const { values } = parseArgs({ options: { report: { type: 'string' }, output: { type: 'string' } } });
const endpoint = process.env.AWS_ENDPOINT_URL;
if (
  !values.report ||
  process.env.ENVIRONMENT !== 'local' ||
  !endpoint ||
  !['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname)
)
  throw new Error('Use --report with explicit localhost configuration');
const report = JSON.parse(await readFile(values.report, 'utf8')) as {
  runId: string;
  organizationId: string;
  skuId: string;
  startedAt: string;
  updatedAt: string;
  warehouseIds: string[];
  environment: { tableName: string; awsEndpoint: string; localOnly: boolean };
  counts: { target: number; accepted: number; failed: number };
};
if (
  !report.environment.localOnly ||
  report.environment.tableName !== process.env.TABLE_NAME ||
  report.environment.awsEndpoint !== endpoint ||
  report.warehouseIds.length > 100
)
  throw new Error('Report does not match the current local environment');
const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
try {
  const result = await clients.document.send(
    new BatchGetCommand({
      RequestItems: {
        [report.environment.tableName]: {
          Keys: report.warehouseIds.map((warehouse) =>
            keys.balance(report.organizationId, warehouse, report.skuId),
          ),
          ConsistentRead: true,
        },
      },
    }),
  );
  if (result.UnprocessedKeys?.[report.environment.tableName]?.Keys?.length)
    throw new Error('Incomplete stock observation');
  const stock = (result.Responses?.[report.environment.tableName] ?? []).reduce(
    (sum, row) => sum + Number(row.quantity),
    0,
  );
  const sample = {
    recordedAt: new Date().toISOString(),
    runId: report.runId,
    elapsedSeconds: (Date.now() - Date.parse(report.startedAt)) / 1000,
    target: report.counts.target,
    checkpointAt: report.updatedAt,
    checkpointAccepted: report.counts.accepted,
    stockAppliedAtObservation: stock,
    minimumOutstandingAccepted: Math.max(0, report.counts.accepted - stock),
    failed: report.counts.failed,
    note: 'Stock read is newer than the producer checkpoint; this is a non-atomic progress observation, not final reconciliation.',
  };
  if (values.output) await appendFile(values.output, JSON.stringify(sample) + '\n');
  console.log(JSON.stringify(sample));
} finally {
  clients.dynamo.destroy();
  clients.sqs.destroy();
}
