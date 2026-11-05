import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { createClients } from '../src/clients.ts';
import { keys } from '../src/storage/dynamo-store.ts';

type Scope = { organizationId: string; warehouseIds: string[] };
type Checkpoint = Scope & { key: Record<string, string> };
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const checkpointSchema = z
  .object({
    organizationId: identifier,
    warehouseIds: z.array(identifier),
    key: z.object({ pk: z.string(), sk: z.string() }).strict(),
  })
  .strict();

export async function backfillIndexes(
  client: DynamoDBDocumentClient,
  tableName: string,
  options: Scope & { apply?: boolean; maxItems?: number; cursor?: string },
) {
  const organizationId = identifier.parse(options.organizationId);
  const warehouseIds = z.array(identifier).min(1).max(100).parse(options.warehouseIds).sort();
  const maxItems = z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .parse(options.maxItems ?? 1000);
  let key: Record<string, string> | undefined;
  if (options.cursor) {
    try {
      if (options.cursor.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error();
      const checkpoint = checkpointSchema.parse(
        JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')),
      );
      if (
        checkpoint.organizationId !== organizationId ||
        JSON.stringify(checkpoint.warehouseIds) !== JSON.stringify(warehouseIds)
      )
        throw new Error();
      key = checkpoint.key;
    } catch {
      throw new RangeError('Migration cursor does not match the organization and warehouse scope');
    }
  }
  let scanned = 0,
    products = 0,
    balances = 0;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        Limit: Math.min(100, maxItems - scanned),
        ExclusiveStartKey: key,
        ProjectionExpression: 'pk, sk, #data.skuId, #data.barcode, skuId, lotCode',
        ExpressionAttributeNames: { '#data': 'data' },
      }),
    );
    scanned += page.ScannedCount ?? page.Items?.length ?? 0;
    for (const row of page.Items ?? []) {
      const sku = row.data?.skuId as string | undefined;
      if (sku && row.pk === keys.product(organizationId, sku).pk && row.sk === 'META') {
        products++;
        if (options.apply) {
          const barcode = row.data?.barcode as string | undefined;
          const codes = [...new Set([sku, ...(barcode ? [barcode] : [])])];
          const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
            {
              Update: {
                TableName: tableName,
                Key: { pk: row.pk, sk: row.sk },
                UpdateExpression: 'SET catalogPK = :catalog, catalogSK = :sku',
                ConditionExpression: `attribute_exists(pk) AND #data.skuId = :sku AND ${barcode ? '#data.barcode = :barcode' : 'attribute_not_exists(#data.barcode)'}`,
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: {
                  ':catalog': keys.catalog(organizationId),
                  ':sku': sku,
                  ...(barcode ? { ':barcode': barcode } : {}),
                },
              },
            },
            ...codes.map((code) => ({
              Put: {
                TableName: tableName,
                Item: { ...keys.code(organizationId, code), skuId: sku },
                ConditionExpression: 'attribute_not_exists(pk) OR skuId = :sku',
                ExpressionAttributeValues: { ':sku': sku },
              },
            })),
          ];
          if (barcode && barcode !== sku)
            items.push({
              ConditionCheck: {
                TableName: tableName,
                Key: keys.product(organizationId, barcode),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            });
          try {
            await client.send(new TransactWriteCommand({ TransactItems: items }));
          } catch (error) {
            if ((error as Error).name === 'TransactionCanceledException')
              throw new Error(
                `Migration stopped at SKU ${sku}: code conflict or concurrent catalog edit. Resolve it and resume; existing records were not overwritten.`,
              );
            throw error;
          }
        }
        continue;
      }
      const stockSku = row.skuId as string | undefined;
      if (!stockSku) continue;
      for (const warehouseId of warehouseIds) {
        const balanceKey = keys.balance(
          organizationId,
          warehouseId,
          stockSku,
          row.lotCode as string | undefined,
        );
        if (row.pk !== balanceKey.pk || row.sk !== balanceKey.sk) continue;
        balances++;
        if (options.apply)
          await client.send(
            new UpdateCommand({
              TableName: tableName,
              Key: balanceKey,
              UpdateExpression: 'SET stockPK = :stock, stockSK = :sort',
              ConditionExpression: 'attribute_exists(pk) AND skuId = :sku',
              ExpressionAttributeValues: {
                ':stock': keys.stock(organizationId, warehouseId),
                ':sort': `${stockSku}#${balanceKey.sk}`,
                ':sku': stockSku,
              },
            }),
          );
        break;
      }
    }
    key = page.LastEvaluatedKey as Record<string, string> | undefined;
  } while (key && scanned < maxItems);
  const checkpoint: Checkpoint | undefined = key ? { organizationId, warehouseIds, key } : undefined;
  return {
    organizationId,
    warehouseIds,
    dryRun: !options.apply,
    scanned,
    products,
    balances,
    complete: !key,
    nextCursor: checkpoint ? Buffer.from(JSON.stringify(checkpoint)).toString('base64url') : undefined,
    note: 'Administrative bounded table scan of identity/index metadata. Only matching explicit scope is changed; stock quantities, creator attribution and business identities are never rewritten. Dry-run counts candidates; code conflicts are transaction-checked only with --apply.',
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      organization: { type: 'string' },
      warehouses: { type: 'string' },
      'max-items': { type: 'string', default: '1000' },
      cursor: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const environment = z.enum(['local', 'production']).default('production').parse(process.env.ENVIRONMENT);
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (
    endpoint &&
    (environment !== 'local' ||
      !['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname))
  )
    throw new Error('Custom endpoints require explicit local mode and a local emulator host');
  const tableName = z.string().min(3).parse(process.env.TABLE_NAME);
  const clients = createClients(process.env.AWS_REGION ?? 'us-east-1', endpoint);
  try {
    const report = await backfillIndexes(clients.document, tableName, {
      organizationId: identifier.parse(values.organization),
      warehouseIds: (values.warehouses ?? '').split(',').map((value) => value.trim()),
      maxItems: Number(values['max-items']),
      cursor: values.cursor,
      apply: values.apply,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 2;
  } finally {
    clients.dynamo.destroy();
    clients.sqs.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Migration failed');
    process.exitCode = 1;
  });
}
