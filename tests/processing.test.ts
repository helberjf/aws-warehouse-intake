import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  consumeOnce,
  publishOnce,
  runPublisher,
  runWorker,
  type OutboxStore,
} from '../src/processing/queue.ts';

const entryId = 'a'.repeat(64);
const message = {
  MessageId: 'message-1',
  ReceiptHandle: 'receipt-1',
  Body: JSON.stringify({ version: 1, entryId }),
};
const quiet = { logger: () => {}, waitSeconds: 0 };
const client = (send: (command: unknown) => Promise<unknown>) => ({ send }) as unknown as SQSClient;

test('worker acknowledges only after durable application resolves', async () => {
  const order: string[] = [];
  const sqs = client(async (command) => {
    if (command instanceof ReceiveMessageCommand) return { Messages: [message] };
    if (command instanceof DeleteMessageCommand) order.push('acknowledged');
    return {};
  });
  const result = await consumeOnce(
    {
      apply: async (id) => {
        assert.equal(id, entryId);
        order.push('committed');
      },
    },
    sqs,
    'queue',
    quiet,
  );
  assert.deepEqual(order, ['committed', 'acknowledged']);
  assert.deepEqual(result, { received: 1, applied: 1, failed: 0 });
});

test('worker leaves transient storage failures available for redelivery', async () => {
  let deletes = 0;
  const sqs = client(async (command) => {
    if (command instanceof ReceiveMessageCommand) return { Messages: [message] };
    if (command instanceof DeleteMessageCommand) deletes++;
    return {};
  });
  const result = await consumeOnce(
    {
      apply: async () => {
        throw new Error('Unavailable');
      },
    },
    sqs,
    'queue',
    quiet,
  );
  assert.equal(deletes, 0);
  assert.equal(result.failed, 1);
});

test('worker refuses unversioned, malformed and expanded queue payloads', async () => {
  let applies = 0;
  let deletes = 0;
  const sqs = client(async (command) => {
    if (command instanceof ReceiveMessageCommand)
      return {
        Messages: [
          { ...message, Body: 'not-json' },
          { ...message, Body: JSON.stringify({ entryId }) },
          { ...message, Body: JSON.stringify({ version: 1, entryId, quantity: 1000 }) },
          { ...message, Body: JSON.stringify({ version: 2, entryId }) },
        ],
      };
    if (command instanceof DeleteMessageCommand) deletes++;
    return {};
  });
  const result = await consumeOnce(
    {
      apply: async () => {
        applies++;
      },
    },
    sqs,
    'queue',
    quiet,
  );
  assert.equal(applies, 0);
  assert.equal(deletes, 0);
  assert.equal(result.failed, 4);
});

test('worker extends visibility while an application transaction is pending', async () => {
  let extensions = 0;
  const sqs = client(async (command) => {
    if (command instanceof ReceiveMessageCommand) return { Messages: [message] };
    if (command instanceof ChangeMessageVisibilityCommand) extensions++;
    return {};
  });
  await consumeOnce(
    {
      apply: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1150));
      },
    },
    sqs,
    'queue',
    { ...quiet, visibilitySeconds: 3 },
  );
  assert.ok(extensions >= 1);
});

test('failed heartbeat prevents deletion even when the database committed', async () => {
  let deletes = 0;
  const sqs = client(async (command) => {
    if (command instanceof ReceiveMessageCommand) return { Messages: [message] };
    if (command instanceof ChangeMessageVisibilityCommand) throw new Error('VisibilityFailed');
    if (command instanceof DeleteMessageCommand) deletes++;
    return {};
  });
  const result = await consumeOnce(
    {
      apply: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1150));
      },
    },
    sqs,
    'queue',
    { ...quiet, visibilitySeconds: 3 },
  );
  assert.equal(deletes, 0);
  assert.equal(result.failed, 1);
});

test('publisher marks only successful sends and preserves tenant fairness grouping', async () => {
  const record = { entryId, messageGroupId: 'warehouse-group', leaseToken: 'lease' };
  const events: string[] = [];
  const store: OutboxStore = {
    claimOutbox: async () => [record],
    markPublished: async (value) => {
      assert.equal(value, record);
      events.push('published');
    },
    releaseOutbox: async () => {
      events.push('released');
    },
  };
  const sqs = client(async (command) => {
    assert.ok(command instanceof SendMessageCommand);
    assert.equal(command.input.MessageGroupId, 'warehouse-group');
    assert.deepEqual(JSON.parse(command.input.MessageBody!), { version: 1, entryId });
    events.push('sent');
    return {};
  });
  assert.deepEqual(await publishOnce(store, sqs, 'queue', quiet), { claimed: 1, published: 1, failed: 0 });
  assert.deepEqual(events, ['sent', 'published']);
});

test('publisher retries an ambiguous send/acknowledgement without losing the outbox intent', async () => {
  let released = 0;
  const store: OutboxStore = {
    claimOutbox: async () => [{ entryId, messageGroupId: 'warehouse-group', leaseToken: 'lease' }],
    markPublished: async () => {
      throw new Error('DatabaseUnavailable');
    },
    releaseOutbox: async () => {
      released++;
    },
  };
  const result = await publishOnce(
    store,
    client(async () => ({})),
    'queue',
    quiet,
  );
  assert.equal(released, 1);
  assert.deepEqual(result, { claimed: 1, published: 0, failed: 1 });
});

test('already aborted loops do not claim new work', async () => {
  const controller = new AbortController();
  controller.abort();
  const unexpected = async () => {
    throw new Error('Unexpected call after shutdown');
  };
  await runWorker({ apply: unexpected }, client(unexpected), 'queue', {
    ...quiet,
    signal: controller.signal,
  });
  await runPublisher(
    { claimOutbox: unexpected, markPublished: unexpected, releaseOutbox: unexpected },
    client(unexpected),
    'queue',
    { ...quiet, signal: controller.signal },
  );
});
