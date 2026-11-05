import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { createClients } from '../src/clients.ts';
import { DynamoIntakeStore } from '../src/storage/dynamo-store.ts';
import { prepareReceivingEntry, receivingEntrySchema } from '../src/domain/receiving.ts';
import { IdentityService, identityKeys } from '../src/identity/service.ts';
import { verifyPassword, type PasswordHash } from '../src/identity/password.ts';
import { ConflictError } from '../src/application/ports.ts';

const actor = { subject: 'system:demo-seed', displayName: 'Carga de demonstração' };
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const credentialFile = '.tokens/demo-logins.json';
const textFile = '.tokens/dados-de-teste.txt';
type Credential = {
  username: string;
  password?: string;
  displayName: string;
  warehouseIds: string[];
  roles: ('admin' | 'receiving')[];
  passwordVerified: boolean;
  status: string;
};

async function writePrivateFile(path: string, content: string) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function main() {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (
    process.env.ENVIRONMENT !== 'local' ||
    !endpoint ||
    !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname)
  )
    throw new Error('Demo data requires an explicit local emulator');
  const tableName = z.string().min(3).parse(process.env.TABLE_NAME);
  const products = z
    .object({
      synthetic: z.literal(true),
      products: z.array(
        z.object({
          skuId: id,
          name: z.string().min(1),
          barcode: z.string().regex(/^\d{13}$/),
          trackingMode: z.enum(['BULK', 'SERIALIZED']),
          active: z.boolean(),
        }),
      ),
    })
    .parse(
      JSON.parse(await readFile(new URL('../examples/demo-products.json', import.meta.url), 'utf8')),
    ).products;
  const fixture = z
    .object({
      synthetic: z.literal(true),
      organizationId: z.literal('DEMO'),
      producerId: z.literal('demo-seed-v1'),
      warehouses: z.array(z.object({ warehouseId: id, name: z.string(), active: z.boolean() })),
      entries: z.array(
        z.object({ warehouseId: id, idempotencyKey: z.string(), entry: receivingEntrySchema }),
      ),
    })
    .parse(JSON.parse(await readFile(new URL('../examples/demo-receiving.json', import.meta.url), 'utf8')));
  const savedSchema = z.object({
    organizationId: z.literal('DEMO'),
    users: z.array(
      z.object({ username: z.string(), password: z.string().min(12).max(128).optional() }).passthrough(),
    ),
  });
  let saved: z.infer<typeof savedSchema> = { organizationId: 'DEMO', users: [] };
  try {
    saved = savedSchema.parse(JSON.parse(await readFile(credentialFile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
  const credentials: Credential[] = [];
  const warnings: string[] = [];
  async function saveCredentials() {
    await mkdir('.tokens', { recursive: true, mode: 0o700 });
    await chmod('.tokens', 0o700);
    const storedUsers = [
      ...credentials,
      ...saved.users.filter((entry) => !credentials.some((user) => user.username === entry.username)),
    ];
    await writePrivateFile(
      credentialFile,
      JSON.stringify({ organizationId: 'DEMO', url: 'http://localhost:3000', users: storedUsers }, null, 2) +
        '\n',
    );
    const body = [
      'DADOS LOCAIS PARA TESTE DO ARMAZÉM',
      'Uso exclusivo no ambiente de demonstração.',
      'Endereço: http://localhost:3000',
      'Organização: DEMO',
      '',
      ...credentials.flatMap((user) => [
        `Usuário: ${user.username}`,
        `Nome: ${user.displayName}`,
        `Senha: ${user.passwordVerified ? user.password : 'não disponível ou alterada; conta existente preservada'}`,
        `Galpões: ${user.warehouseIds.join(', ')}`,
        `Perfil: ${user.roles.includes('admin') ? 'Gestor: cadastra produtos e consulta/recebe nos galpões autorizados' : 'Operador: consulta e recebe; não cadastra produtos'}`,
        `Estado: ${user.status}`,
        '',
      ]),
      'ETIQUETAS PARA LEITURA',
      'http://localhost:3000/demo-barcodes.html',
      'Produtos DEMO-* e códigos sintéticos; não são registros GS1.',
      '16 galpões, 8 produtos e 48 recebimentos de exemplo.',
      'Após o processamento:16 unidades de demonstração por galpão (256 no total).',
      'As senhas deste arquivo não devem ser publicadas. Este arquivo é ignorado pelo Git.',
    ];
    await writePrivateFile(textFile, body.join('\n') + '\n');
  }
  try {
    await clients.dynamo.send(new DescribeTableCommand({ TableName: tableName }));
    const store = new DynamoIntakeStore(clients.document, tableName);
    const identity = new IdentityService(clients.document, tableName);
    for (const warehouse of fixture.warehouses) {
      if (!(await store.getWarehouse('DEMO', warehouse.warehouseId)))
        await store.putWarehouse('DEMO', warehouse);
    }
    for (const product of products) {
      const previous = await store.getProduct('DEMO', product.skuId);
      if (
        previous &&
        (previous.trackingMode !== product.trackingMode || previous.barcode !== product.barcode)
      )
        throw new ConflictError(
          `Demo SKU ${product.skuId} was edited; it was preserved. Resolve the fixture conflict before re-running.`,
        );
      if (!previous) await store.putProduct('DEMO', product, actor);
    }
    const users = [
      {
        username: 'gestor.teste',
        displayName: 'Gestor de testes',
        warehouseIds: fixture.warehouses.map((w) => w.warehouseId),
        roles: ['admin', 'receiving'] as ('admin' | 'receiving')[],
      },
      {
        username: 'operador.teste',
        displayName: 'Operador de testes',
        warehouseIds: ['WH-01', 'WH-02'],
        roles: ['receiving'] as ('admin' | 'receiving')[],
      },
    ];
    for (const user of users) {
      const prior = (
        await clients.document.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: identityKeys.user('DEMO', user.username), sk: 'META' },
            ConsistentRead: true,
          }),
        )
      ).Item;
      const savedPassword = saved.users.find((entry) => entry.username === user.username)?.password;
      const password = savedPassword ?? (!prior ? randomBytes(24).toString('base64url') : undefined);
      const credential: Credential = {
        ...user,
        password,
        passwordVerified: false,
        status: 'Aguardando criação',
      };
      credentials.push(credential);
      // Persist generated secrets before creation so an interrupted seed can reuse them safely.
      await saveCredentials();
      if (!prior) {
        await identity.provisionUser({
          organizationId: 'DEMO',
          producerId: 'warehouse-ui',
          ...user,
          password: password!,
        });
        credential.passwordVerified = true;
        credential.status = 'Conta criada';
      } else {
        credential.warehouseIds = prior.principal.warehouseIds as string[];
        credential.roles = prior.principal.roles as ('admin' | 'receiving')[];
        credential.displayName = prior.principal.displayName as string;
        credential.passwordVerified = Boolean(
          password && prior.active && (await verifyPassword(password, prior.passwordHash as PasswordHash)),
        );
        credential.status = credential.passwordVerified
          ? 'Conta existente preservada'
          : 'Conta existente preservada; senha salva indisponível ou alterada';
        if (!credential.passwordVerified)
          warnings.push(
            `Existing account ${user.username} was preserved; recover credentials through an explicit administrator reset.`,
          );
      }
      await saveCredentials();
    }
    const statusCounts: Record<string, number> = {};
    let units = 0;
    for (const sample of fixture.entries) {
      const product = products.find((product) => product.skuId === sample.entry.skuId);
      if (!product) throw new Error('Unknown fixture SKU');
      const prepared = prepareReceivingEntry(
        sample.entry,
        { organizationId: 'DEMO', warehouseId: sample.warehouseId, producerId: fixture.producerId },
        sample.idempotencyKey,
        { skuId: product.skuId, trackingMode: product.trackingMode },
      );
      const entry = await store.accept({ ...prepared, recordedBy: actor });
      statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
      units += entry.quantity;
    }
    console.log(
      JSON.stringify(
        {
          message: 'Synthetic demo data accepted; publisher and worker complete inventory asynchronously.',
          organizationId: 'DEMO',
          warehouses: fixture.warehouses.length,
          products: products.length,
          movements: fixture.entries.length,
          physicalUnits: units,
          statusCounts,
          credentialsFile: credentialFile,
          instructionsFile: textFile,
          barcodeSheet: 'http://localhost:3000/demo-barcodes.html',
          warnings,
        },
        null,
        2,
      ),
    );
  } finally {
    clients.dynamo.destroy();
    clients.sqs.destroy();
  }
}
main().catch((error) => {
  console.error(
    error instanceof ConflictError
      ? error.message
      : 'Demo seeding failed. Verify the local emulator, existing table, fixtures and private credentials file.',
  );
  process.exitCode = 1;
});
