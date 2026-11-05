import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { loadConfig } from './config.ts';
import { createClients } from './clients.ts';
import { DynamoIntakeStore } from './storage/dynamo-store.ts';
import { createApp } from './http/app.ts';
import { createAuthenticator } from './http/auth.ts';
import { runPublisher, runWorker } from './processing/queue.ts';

const config = loadConfig();
const clients = createClients(config.AWS_REGION, config.AWS_ENDPOINT_URL);
const store = new DynamoIntakeStore(clients.document, config.TABLE_NAME);
const controller = new AbortController();
let closing = false;
let closeApi: (() => Promise<void>) | undefined;
let deadline: NodeJS.Timeout | undefined;
function stop() {
  if (closing) return;
  closing = true;
  controller.abort();
  // ECS stopTimeout is 120s; allow in-flight transactions and queue acknowledgement to drain.
  deadline = setTimeout(() => process.exit(1), 110_000);
  deadline.unref();
  void closeApi?.().catch((error: Error) => {
    console.error(JSON.stringify({ event: 'shutdown_failed', message: error.message }));
    process.exitCode = 1;
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  if (config.SERVICE_ROLE === 'api') {
    const app = await createApp({
      store,
      auth: createAuthenticator({
        environment: config.ENVIRONMENT,
        issuer: config.JWT_ISSUER!,
        audience: config.JWT_AUDIENCE!,
        jwksUrl: config.JWT_JWKS_URL,
        localSecret: config.LOCAL_JWT_SECRET,
      }),
      ready: async () => {
        await clients.dynamo.send(new DescribeTableCommand({ TableName: config.TABLE_NAME }));
      },
    });
    if (controller.signal.aborted) {
      await app.close();
    } else {
      await app.listen({ host: '0.0.0.0', port: config.PORT });
      const closed = new Promise<void>((resolve) => {
        app.server.once('close', resolve);
      });
      closeApi = () => app.close();
      if (controller.signal.aborted) await app.close();
      await closed;
    }
  } else {
    console.log(JSON.stringify({ event: 'service_started', role: config.SERVICE_ROLE }));
    const run = config.SERVICE_ROLE === 'publisher' ? runPublisher : runWorker;
    await run(store, clients.sqs, config.QUEUE_URL, { signal: controller.signal });
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'service_failed',
      message: error instanceof Error ? error.message : 'Unknown failure',
    }),
  );
  process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  clients.dynamo.destroy();
  clients.sqs.destroy();
}
