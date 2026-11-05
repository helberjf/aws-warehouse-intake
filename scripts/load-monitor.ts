import { appendFile, access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { createClients } from '../src/clients.ts';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'stop-file': { type: 'string' },
    interval: { type: 'string', default: '30' },
  },
});
const interval = Number(values.interval);
const endpoint = process.env.AWS_ENDPOINT_URL;
if (
  process.env.ENVIRONMENT !== 'local' ||
  !endpoint ||
  !['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname) ||
  !values.output ||
  !values['stop-file'] ||
  !Number.isInteger(interval) ||
  interval < 10 ||
  interval > 300
)
  throw new Error('Use a localhost environment, --output, --stop-file and interval10..300 seconds');
const run = promisify(execFile);
const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
const queueUrl = process.env.QUEUE_URL;
if (
  !queueUrl ||
  !['localhost', '127.0.0.1', 'sqs.us-east-1.localhost.localstack.cloud'].includes(new URL(queueUrl).hostname)
)
  throw new Error('A local queue URL is required');
await mkdir(dirname(values.output), { recursive: true });
await writeFile(values.output, '', { flag: 'wx' });
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
let dlqUrl: string | undefined;
const names = [
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
] as const;
try {
  const attributes = await clients.sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['RedrivePolicy'] }),
  );
  if (attributes.Attributes?.RedrivePolicy) {
    const arn = JSON.parse(attributes.Attributes.RedrivePolicy).deadLetterTargetArn as string;
    dlqUrl = (await clients.sqs.send(new GetQueueUrlCommand({ QueueName: arn.split(':').at(-1)! }))).QueueUrl;
  }
  async function queue(url: string) {
    const result = await clients.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [...names] }),
    );
    return Object.fromEntries(names.map((name) => [name, Number(result.Attributes?.[name] ?? 0)]));
  }
  while (!stopping) {
    try {
      await access(values['stop-file']);
      stopping = true;
    } catch {
      /* The absent sentinel keeps monitoring active. */
    }
    const recordedAt = new Date().toISOString();
    const results = await Promise.allSettled([
      run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      }),
      queue(queueUrl),
      dlqUrl ? queue(dlqUrl) : Promise.resolve(undefined),
    ]);
    const docker = results[0];
    const sample = {
      recordedAt,
      containers:
        docker.status === 'fulfilled'
          ? docker.value.stdout
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .filter((row) => String(row.Name).startsWith('warehouse-intake-'))
          : undefined,
      queue: results[1].status === 'fulfilled' ? results[1].value : undefined,
      dlq: results[2].status === 'fulfilled' ? results[2].value : undefined,
      errors: results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{ source: index, error: result.reason instanceof Error ? result.reason.name : 'UnknownError' }]
          : [],
      ),
    };
    await appendFile(values.output, JSON.stringify(sample) + '\n');
    console.log(
      JSON.stringify({
        event: 'load_monitor',
        ...sample,
        containers: sample.containers?.map((row) => ({
          name: row.Name,
          cpu: row.CPUPerc,
          memory: row.MemUsage,
        })),
      }),
    );
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
} finally {
  clients.dynamo.destroy();
  clients.sqs.destroy();
}
