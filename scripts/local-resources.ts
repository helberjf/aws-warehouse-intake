import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  UpdateTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createClients } from '../src/clients.ts';

const browseIndexes = ['catalog', 'stock'].map((prefix) => ({
  IndexName: `${prefix}-index`,
  KeySchema: [
    { AttributeName: `${prefix}PK`, KeyType: 'HASH' as const },
    { AttributeName: `${prefix}SK`, KeyType: 'RANGE' as const },
  ],
  Projection: { ProjectionType: 'ALL' as const },
}));

export async function setupLocal(tableName: string, queueName: string) {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (
    process.env.ENVIRONMENT !== 'local' ||
    !endpoint ||
    !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname)
  ) {
    throw new Error('Local setup requires ENVIRONMENT=local and a localhost/localstack emulator endpoint');
  }
  const clients = createClients('us-east-1', endpoint);
  try {
    const existing = await clients.dynamo.send(new DescribeTableCommand({ TableName: tableName }));
    for (const index of browseIndexes) {
      if (existing.Table?.GlobalSecondaryIndexes?.some((item) => item.IndexName === index.IndexName))
        continue;
      await clients.dynamo.send(
        new UpdateTableCommand({
          TableName: tableName,
          AttributeDefinitions: index.KeySchema.map((key) => ({
            AttributeName: key.AttributeName,
            AttributeType: 'S',
          })),
          GlobalSecondaryIndexUpdates: [{ Create: index }],
        }),
      );
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await clients.dynamo.send(new DescribeTableCommand({ TableName: tableName }));
        ready =
          state.Table?.GlobalSecondaryIndexes?.find((item) => item.IndexName === index.IndexName)
            ?.IndexStatus === 'ACTIVE';
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error('Local index creation exceeded wait limit');
    }
  } catch (error) {
    if ((error as Error).name !== 'ResourceNotFoundException') throw error;
    await clients.dynamo.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          'pk',
          'sk',
          'duePK',
          'dueSK',
          'historyPK',
          'historySK',
          'catalogPK',
          'catalogSK',
          'stockPK',
          'stockSK',
        ].map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          ...browseIndexes,
          {
            IndexName: 'due-index',
            KeySchema: [
              { AttributeName: 'duePK', KeyType: 'HASH' },
              { AttributeName: 'dueSK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'history-index',
            KeySchema: [
              { AttributeName: 'historyPK', KeyType: 'HASH' },
              { AttributeName: 'historySK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    await waitUntilTableExists(
      { client: clients.dynamo, maxWaitTime: 30, minDelay: 1, maxDelay: 2 },
      { TableName: tableName },
    );
    await clients.dynamo.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
      }),
    );
  }
  const dlq = await clients.sqs.send(
    new CreateQueueCommand({
      QueueName: `${queueName}-dlq`,
      Attributes: { MessageRetentionPeriod: '1209600' },
    }),
  );
  const attrs = await clients.sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const queue = await clients.sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        VisibilityTimeout: '60',
        ReceiveMessageWaitTimeSeconds: '20',
        MessageRetentionPeriod: '345600',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes?.QueueArn,
          maxReceiveCount: 5,
        }),
      },
    }),
  );
  return { ...clients, tableName, queueUrl: queue.QueueUrl!, dlqUrl: dlq.QueueUrl! };
}
