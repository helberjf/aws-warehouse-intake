import { z } from 'zod';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { IntakeStore } from '../application/ports.ts';
import type { OutboxRecord } from '../storage/dynamo-store.ts';

export const queueMessageSchema = z
  .object({ version: z.literal(1), entryId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export interface OutboxStore {
  claimOutbox(limit?: number, leaseSeconds?: number): Promise<OutboxRecord[]>;
  markPublished(record: OutboxRecord): Promise<void>;
  releaseOutbox(record: OutboxRecord, delaySeconds?: number): Promise<void>;
}
export type ProcessingOptions = {
  batchSize?: number;
  visibilitySeconds?: number;
  waitSeconds?: number;
  signal?: AbortSignal;
  logger?: (event: Record<string, unknown>) => void;
};
const log = (options: ProcessingOptions, event: Record<string, unknown>) =>
  (options.logger ?? ((record) => console.log(JSON.stringify(record))))(event);

function batchSize(options: ProcessingOptions): number {
  const value = options.batchSize ?? 10;
  if (!Number.isInteger(value) || value < 1 || value > 10)
    throw new RangeError('Batch size must be between 1 and 10');
  return value;
}

export async function publishOnce(
  store: OutboxStore,
  sqs: SQSClient,
  queueUrl: string,
  options: ProcessingOptions = {},
) {
  const records = await store.claimOutbox(batchSize(options), 60);
  let published = 0;
  let failed = 0;
  await Promise.all(
    records.map(async (record) => {
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({ version: 1, entryId: record.entryId }),
            MessageGroupId: record.messageGroupId,
          }),
        );
        await store.markPublished(record);
        published++;
      } catch (error) {
        failed++;
        log(options, {
          event: 'outbox_publish_failed',
          entryId: record.entryId,
          error: (error as Error).name,
        });
        // A successful send followed by a failed acknowledgement deliberately produces a safe replay.
        try {
          await store.releaseOutbox(record);
        } catch (releaseError) {
          log(options, {
            event: 'outbox_release_failed',
            entryId: record.entryId,
            error: (releaseError as Error).name,
          });
        }
      }
    }),
  );
  if (records.length) log(options, { event: 'outbox_batch', claimed: records.length, published, failed });
  return { claimed: records.length, published, failed };
}

export async function consumeOnce(
  store: Pick<IntakeStore, 'apply'>,
  sqs: SQSClient,
  queueUrl: string,
  options: ProcessingOptions = {},
) {
  const visibility = options.visibilitySeconds ?? 60;
  const wait = options.waitSeconds ?? 20;
  if (!Number.isInteger(visibility) || visibility < 3 || visibility > 43200)
    throw new RangeError('Invalid visibility timeout');
  if (!Number.isInteger(wait) || wait < 0 || wait > 20) throw new RangeError('Invalid SQS wait time');
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: batchSize(options),
      WaitTimeSeconds: wait,
      VisibilityTimeout: visibility,
    }),
  );
  let applied = 0;
  let failed = 0;
  await Promise.all(
    (response.Messages ?? []).map(async (message) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let inFlightHeartbeat: Promise<void> | undefined;
      let heartbeatFailed = false;
      try {
        if (!message.ReceiptHandle || !message.Body) throw new Error('MalformedSqsMessage');
        const reference = queueMessageSchema.parse(JSON.parse(message.Body));
        heartbeat = setInterval(
          () => {
            if (inFlightHeartbeat) return;
            inFlightHeartbeat = sqs
              .send(
                new ChangeMessageVisibilityCommand({
                  QueueUrl: queueUrl,
                  ReceiptHandle: message.ReceiptHandle,
                  VisibilityTimeout: visibility,
                }),
              )
              .then(
                () => undefined,
                () => {
                  heartbeatFailed = true;
                },
              )
              .finally(() => {
                inFlightHeartbeat = undefined;
              });
          },
          Math.floor((visibility * 1000) / 3),
        );
        heartbeat.unref();
        await store.apply(reference.entryId);
        clearInterval(heartbeat);
        if (inFlightHeartbeat) await inFlightHeartbeat;
        if (heartbeatFailed) throw new Error('VisibilityExtensionFailed');
        // apply resolves only after the persisted entry is terminal; duplicates are therefore harmless.
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
        applied++;
      } catch (error) {
        failed++;
        log(options, {
          event: 'queue_message_failed',
          messageId: message.MessageId,
          error: (error as Error).name,
        });
        // Leave the message on the queue. SQS redrive policy bounds retries and sends poison messages to DLQ.
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (inFlightHeartbeat) await inFlightHeartbeat;
      }
    }),
  );
  if (response.Messages?.length)
    log(options, { event: 'worker_batch', received: response.Messages.length, applied, failed });
  return { received: response.Messages?.length ?? 0, applied, failed };
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runPublisher(
  store: OutboxStore,
  sqs: SQSClient,
  queueUrl: string,
  options: ProcessingOptions = {},
): Promise<void> {
  while (!options.signal?.aborted) {
    try {
      const result = await publishOnce(store, sqs, queueUrl, options);
      if (!result.claimed) await pause(1000, options.signal);
    } catch (error) {
      log(options, { event: 'publisher_poll_failed', error: (error as Error).name });
      await pause(5000, options.signal);
    }
  }
}

export async function runWorker(
  store: Pick<IntakeStore, 'apply'>,
  sqs: SQSClient,
  queueUrl: string,
  options: ProcessingOptions = {},
): Promise<void> {
  while (!options.signal?.aborted) {
    try {
      await consumeOnce(store, sqs, queueUrl, options);
    } catch (error) {
      log(options, { event: 'worker_poll_failed', error: (error as Error).name });
      await pause(5000, options.signal);
    }
  }
}
