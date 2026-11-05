import { parseArgs } from 'node:util';
import { createClients } from '../src/clients.ts';
import { IdentityService, provisionSchema } from '../src/identity/service.ts';
import { ConflictError } from '../src/application/ports.ts';

async function main() {
  const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
  if (process.stdin.isTTY)
    throw new Error('Provide one user JSON object on stdin; passwords must never be command-line arguments');
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (
    endpoint &&
    (process.env.ENVIRONMENT !== 'local' ||
      !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname))
  )
    throw new Error('Custom endpoints require explicit local mode');
  if (!process.env.TABLE_NAME) throw new Error('TABLE_NAME is required');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024) throw new Error('User input too large');
  }
  const user = provisionSchema.parse(JSON.parse(input));
  const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
  try {
    const principal = await new IdentityService(clients.document, process.env.TABLE_NAME).provisionUser(
      user,
      {
        reset: values.reset,
      },
    );
    console.log(
      JSON.stringify({
        message: values.reset ? 'User credentials replaced; previous sessions revoked' : 'User created',
        user: principal,
      }),
    );
  } finally {
    clients.dynamo.destroy();
    clients.sqs.destroy();
  }
}

main().catch((error: unknown) => {
  // JSON parse errors can include input snippets; never print raw provisioning errors.
  console.error(
    error instanceof ConflictError
      ? error.message
      : 'User provisioning failed. Check input, environment and operator permissions.',
  );
  process.exitCode = 1;
});
