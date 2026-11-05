import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';

export function createClients(region: string, endpoint?: string) {
  const options = {
    region,
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
    maxAttempts: 5,
  };
  const dynamo = new DynamoDBClient(options);
  const document = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sqs = new SQSClient(options);
  return { dynamo, document, sqs };
}
