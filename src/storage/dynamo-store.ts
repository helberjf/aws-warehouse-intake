import { createHash, randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  ConflictError,
  EligibilityError,
  type Balance,
  type Actor,
  type IntakeStore,
  type LedgerEntry,
  type Page,
  type PreparedEntry,
  type Product,
  type Warehouse,
} from '../application/ports.ts';

export const OUTBOX_SHARDS = 16;
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const singleton = (pk: string) => ({ pk, sk: 'META' });
export const keys = {
  entry: (id: string) => singleton(`ENTRY#${id}`),
  idempotency: (id: string) => singleton(`IDEMPOTENCY#${id}`),
  outbox: (id: string) => singleton(`OUTBOX#${id}`),
  product: (org: string, sku: string) => singleton(`PRODUCT#${hash([org, sku])}`),
  code: (org: string, code: string) => singleton(`CODE#${hash([org, code])}`),
  catalog: (org: string) => `CATALOG#${hash([org])}`,
  stock: (org: string, warehouse: string) => `STOCK#${hash([org, warehouse])}`,
  warehouse: (org: string, warehouse: string) => singleton(`WAREHOUSE#${hash([org, warehouse])}`),
  unit: (id: string) => singleton(`UNIT#${id}`),
  balance: (org: string, warehouse: string, sku: string, lot?: string) => ({
    pk: `BALANCE#${hash([org, warehouse, sku])}`,
    sk: `LOT#${hash(lot === undefined ? ['NO_LOT'] : ['LOT', lot])}`,
  }),
  history: (org: string, warehouse: string) => `HISTORY#${hash([org, warehouse])}`,
};
const dueKey = (time: number, id: string) => `${Math.trunc(time).toString().padStart(13, '0')}#${id}`;
const duePartition = (shard: number) => `OUTBOX#v1#${shard.toString().padStart(2, '0')}`;
const conditionalFailure = (error: unknown) => (error as Error)?.name === 'ConditionalCheckFailedException';
const transactionFailure = (error: unknown) => (error as Error)?.name === 'TransactionCanceledException';
const retryDelay = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.random() * 30));

export type OutboxRecord = {
  entryId: string;
  messageGroupId: string;
  leaseToken: string;
};

function pageCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key && Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
  partition: string,
  index: boolean | 'catalog' | 'stock',
): Record<string, string> | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const key = value as Record<string, unknown>;
    const prefix = index === true ? 'history' : index === false ? undefined : index;
    const fields = prefix ? ['pk', 'sk', `${prefix}PK`, `${prefix}SK`] : ['pk', 'sk'];
    if (Object.keys(key).length !== fields.length || fields.some((field) => typeof key[field] !== 'string'))
      throw new Error();
    if (key[prefix ? `${prefix}PK` : 'pk'] !== partition) throw new Error();
    return key as Record<string, string>;
  } catch {
    throw new RangeError('Invalid pagination cursor');
  }
}

export class DynamoIntakeStore implements IntakeStore {
  private readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  constructor(client: DynamoDBDocumentClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  private async get(key: { pk: string; sk: string }) {
    return (
      await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))
    ).Item;
  }

  async getProduct(org: string, sku: string): Promise<Product | undefined> {
    return (await this.get(keys.product(org, sku)))?.data as Product | undefined;
  }

  async putProduct(org: string, product: Product, actor?: Actor): Promise<void> {
    const productKey = keys.product(org, product.skuId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const previous = await this.get(productKey);
      const existing = previous?.data as Product | undefined;
      if (existing && existing.trackingMode !== product.trackingMode)
        throw new ConflictError('Tracking mode is immutable; create a new SKU for a new tracking model');
      const now = new Date().toISOString();
      const data: Product = {
        skuId: product.skuId,
        trackingMode: product.trackingMode,
        active: product.active,
        name: product.name,
        barcode: product.barcode,
        createdAt: existing ? existing.createdAt : now,
        createdBy: existing ? existing.createdBy : actor,
        updatedAt: now,
        updatedBy: actor,
      };
      const codes = [...new Set([product.skuId, ...(product.barcode ? [product.barcode] : [])])];
      // The alias transaction and legacy SKU condition preserve one meaning for every scanned code.
      const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
        {
          Put: {
            TableName: this.tableName,
            Item: {
              ...productKey,
              data,
              active: product.active,
              trackingMode: product.trackingMode,
              catalogPK: keys.catalog(org),
              catalogSK: product.skuId,
              revision: randomUUID(),
            },
            ConditionExpression: !previous
              ? 'attribute_not_exists(pk)'
              : previous.revision
                ? 'revision = :revision'
                : 'attribute_exists(pk) AND attribute_not_exists(revision)',
            ...(previous?.revision ? { ExpressionAttributeValues: { ':revision': previous.revision } } : {}),
          },
        },
        ...codes.map((code) => ({
          Put: {
            TableName: this.tableName,
            Item: { ...keys.code(org, code), skuId: product.skuId },
            ConditionExpression: 'attribute_not_exists(pk) OR skuId = :sku',
            ExpressionAttributeValues: { ':sku': product.skuId },
          },
        })),
      ];
      if (product.barcode && product.barcode !== product.skuId)
        writes.push({
          ConditionCheck: {
            TableName: this.tableName,
            Key: keys.product(org, product.barcode),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        });
      if (existing?.barcode && !codes.includes(existing.barcode))
        writes.push({
          Delete: {
            TableName: this.tableName,
            Key: keys.code(org, existing.barcode),
            ConditionExpression: 'attribute_not_exists(pk) OR skuId = :sku',
            ExpressionAttributeValues: { ':sku': product.skuId },
          },
        });
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: writes, ClientRequestToken: randomUUID() }),
        );
        return;
      } catch (error) {
        if (!transactionFailure(error)) throw error;
        const aliases = await Promise.all(codes.map((code) => this.get(keys.code(org, code))));
        const legacy =
          product.barcode && product.barcode !== product.skuId
            ? await this.getProduct(org, product.barcode)
            : undefined;
        if (aliases.some((alias) => alias && alias.skuId !== product.skuId) || legacy)
          throw new ConflictError('Product code or barcode is already assigned to another SKU');
        if (attempt === 5) throw error;
        await retryDelay(attempt);
      }
    }
  }

  async findProductByCode(org: string, code: string): Promise<Product | undefined> {
    const alias = await this.get(keys.code(org, code));
    const product = await this.getProduct(org, (alias?.skuId as string | undefined) ?? code);
    return product && (product.skuId === code || product.barcode === code) ? product : undefined;
  }

  async listProducts(org: string, limit: number, cursor?: string): Promise<Page<Product>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Limit must be between 1 and 100');
    const partition = keys.catalog(org);
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'catalog-index',
        KeyConditionExpression: 'catalogPK = :pk',
        ExpressionAttributeValues: { ':pk': partition },
        Limit: limit,
        ExclusiveStartKey: decodeCursor(cursor, partition, 'catalog'),
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => item.data as Product),
      cursor: pageCursor(result.LastEvaluatedKey),
    };
  }

  async getWarehouse(org: string, warehouse: string): Promise<Warehouse | undefined> {
    return (await this.get(keys.warehouse(org, warehouse)))?.data as Warehouse | undefined;
  }

  async putWarehouse(org: string, warehouse: Warehouse): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.warehouse(org, warehouse.warehouseId), data: warehouse, active: warehouse.active },
      }),
    );
  }

  async getEntry(id: string): Promise<LedgerEntry | undefined> {
    return (await this.get(keys.entry(id)))?.data as LedgerEntry | undefined;
  }

  async accept(command: PreparedEntry): Promise<LedgerEntry> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const [replay, existing] = await Promise.all([
        this.get(keys.idempotency(command.idempotencyRecordId)),
        this.getEntry(command.entryId),
      ]);
      if (replay && (replay.entryId !== command.entryId || replay.payloadHash !== command.payloadHash)) {
        throw new ConflictError('Idempotency key was already used with a different request');
      }
      if (existing && existing.payloadHash !== command.payloadHash) {
        throw new ConflictError('Business reference was already used with a different request');
      }
      if (existing && replay) return existing;
      const replayItem = {
        ...keys.idempotency(command.idempotencyRecordId),
        entryId: command.entryId,
        payloadHash: command.payloadHash,
      };
      if (existing) {
        try {
          await this.client.send(
            new PutCommand({
              TableName: this.tableName,
              Item: replayItem,
              ConditionExpression: 'attribute_not_exists(pk)',
            }),
          );
          return existing;
        } catch (error) {
          if (!conditionalFailure(error)) throw error;
          continue;
        }
      }
      if (replay) throw new Error('Idempotency record refers to a missing ledger entry');
      const now = Date.now();
      const ledger: LedgerEntry = { ...command, status: 'ACCEPTED', acceptedAt: new Date(now).toISOString() };
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    ...keys.entry(command.entryId),
                    data: ledger,
                    historyPK: keys.history(command.organizationId, command.warehouseId),
                    historySK: `${ledger.acceptedAt}#${command.entryId}`,
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: replayItem,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    ...keys.outbox(command.entryId),
                    entryId: command.entryId,
                    messageGroupId: command.messageGroupId,
                    state: 'PENDING',
                    duePK: duePartition(parseInt(command.entryId.slice(0, 2), 16) % OUTBOX_SHARDS),
                    dueSK: dueKey(now, command.entryId),
                    leaseUntil: 0,
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: keys.product(command.organizationId, command.entry.skuId),
                  ConditionExpression: 'active = :true AND trackingMode = :mode',
                  ExpressionAttributeValues: { ':true': true, ':mode': command.entry.mode },
                },
              },
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: keys.warehouse(command.organizationId, command.warehouseId),
                  ConditionExpression: 'active = :true',
                  ExpressionAttributeValues: { ':true': true },
                },
              },
            ],
          }),
        );
        return ledger;
      } catch (error) {
        if (!transactionFailure(error)) throw error;
        const [product, warehouse, committed] = await Promise.all([
          this.getProduct(command.organizationId, command.entry.skuId),
          this.getWarehouse(command.organizationId, command.warehouseId),
          this.getEntry(command.entryId),
        ]);
        // A racing acceptance can succeed just before deactivation. Replay its durable result.
        if (
          !committed &&
          (!product?.active || product.trackingMode !== command.entry.mode || !warehouse?.active)
        ) {
          throw new EligibilityError('Product and warehouse must be active and tracking mode must match');
        }
        if (attempt === 5) throw error;
        await retryDelay(attempt);
      }
    }
    throw new Error('Acceptance contention exceeded retry budget');
  }

  async listEntries(
    org: string,
    warehouse: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<LedgerEntry>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Limit must be between 1 and 100');
    const partition = keys.history(org, warehouse);
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'history-index',
        KeyConditionExpression: 'historyPK = :pk',
        ExpressionAttributeValues: { ':pk': partition },
        Limit: limit,
        ScanIndexForward: false,
        ExclusiveStartKey: decodeCursor(cursor, partition, true),
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => item.data as LedgerEntry),
      cursor: pageCursor(result.LastEvaluatedKey),
    };
  }

  async getBalances(
    org: string,
    warehouse: string,
    sku: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<Balance>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Limit must be between 1 and 100');
    const partition = keys.balance(org, warehouse, sku).pk;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': partition },
        ConsistentRead: true,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(cursor, partition, false),
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => ({
        skuId: item.skuId as string,
        quantity: item.quantity as number,
        ...(item.lotCode === undefined ? {} : { lotCode: item.lotCode as string }),
      })),
      cursor: pageCursor(result.LastEvaluatedKey),
    };
  }

  async listStock(org: string, warehouse: string, limit: number, cursor?: string): Promise<Page<Balance>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Limit must be between 1 and 100');
    const partition = keys.stock(org, warehouse);
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'stock-index',
        KeyConditionExpression: 'stockPK = :pk',
        ExpressionAttributeValues: { ':pk': partition },
        Limit: limit,
        ExclusiveStartKey: decodeCursor(cursor, partition, 'stock'),
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => ({
        skuId: item.skuId as string,
        quantity: item.quantity as number,
        ...(item.lotCode === undefined ? {} : { lotCode: item.lotCode as string }),
      })),
      cursor: pageCursor(result.LastEvaluatedKey),
    };
  }

  private async reject(id: string, reason: string): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.entry(id),
          UpdateExpression:
            'SET #data.#status = :rejected, #data.completedAt = :now, #data.rejectionReason = :reason',
          ConditionExpression: '#data.#status = :accepted',
          ExpressionAttributeNames: { '#data': 'data', '#status': 'status' },
          ExpressionAttributeValues: {
            ':rejected': 'REJECTED',
            ':accepted': 'ACCEPTED',
            ':now': new Date().toISOString(),
            ':reason': reason,
          },
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const committed = await this.getEntry(id);
      if (!committed || committed.status === 'ACCEPTED') throw error;
    }
  }

  async apply(id: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ledger = await this.getEntry(id);
      if (!ledger) throw new Error('Queue message refers to a missing ledger entry');
      if (ledger.status !== 'ACCEPTED') return;
      const lot = ledger.entry.mode === 'BULK' ? ledger.entry.lotCode : undefined;
      const balanceKey = keys.balance(ledger.organizationId, ledger.warehouseId, ledger.entry.skuId, lot);
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: keys.entry(id),
                  UpdateExpression: 'SET #data.#status = :applied, #data.completedAt = :now',
                  ConditionExpression: '#data.#status = :accepted',
                  ExpressionAttributeNames: { '#data': 'data', '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':accepted': 'ACCEPTED',
                    ':applied': 'APPLIED',
                    ':now': new Date().toISOString(),
                  },
                },
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: balanceKey,
                  UpdateExpression: `SET skuId = :sku, stockPK = :stockPK, stockSK = :stockSK${lot === undefined ? '' : ', lotCode = :lot'} ADD #quantity :quantity`,
                  ConditionExpression: 'attribute_not_exists(#quantity) OR #quantity <= :maximum',
                  ExpressionAttributeNames: { '#quantity': 'quantity' },
                  ExpressionAttributeValues: {
                    ':sku': ledger.entry.skuId,
                    ':stockPK': keys.stock(ledger.organizationId, ledger.warehouseId),
                    ':stockSK': `${ledger.entry.skuId}#${balanceKey.sk}`,
                    ':quantity': ledger.quantity,
                    ':maximum': Number.MAX_SAFE_INTEGER - ledger.quantity,
                    ...(lot === undefined ? {} : { ':lot': lot }),
                  },
                },
              },
              ...(ledger.unitKey
                ? [
                    {
                      Put: {
                        TableName: this.tableName,
                        Item: { ...keys.unit(ledger.unitKey), entryId: id, warehouseId: ledger.warehouseId },
                        ConditionExpression: 'attribute_not_exists(pk)',
                      },
                    },
                  ]
                : []),
            ],
          }),
        );
        return;
      } catch (error) {
        if (!transactionFailure(error)) throw error;
        const latest = await this.getEntry(id);
        if (latest && latest.status !== 'ACCEPTED') return;
        if (ledger.unitKey) {
          const unit = await this.get(keys.unit(ledger.unitKey));
          if (unit && unit.entryId !== id) return this.reject(id, 'SERIAL_ALREADY_RECEIVED');
        }
        const balance = await this.get(balanceKey);
        if (balance && (balance.quantity as number) > Number.MAX_SAFE_INTEGER - ledger.quantity)
          return this.reject(id, 'BALANCE_LIMIT_EXCEEDED');
        if (attempt === 5) throw error;
        await retryDelay(attempt);
      }
    }
  }

  async claimOutbox(limit = 10, leaseSeconds = 60): Promise<OutboxRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || leaseSeconds < 10 || leaseSeconds > 900)
      throw new RangeError('Invalid outbox claim limits');
    const claimed: OutboxRecord[] = [];
    const startShard = Math.floor(Math.random() * OUTBOX_SHARDS);
    for (let offset = 0; offset < OUTBOX_SHARDS && claimed.length < limit; offset++) {
      const now = Date.now();
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'due-index',
          KeyConditionExpression: 'duePK = :pk AND dueSK <= :now',
          ExpressionAttributeValues: {
            ':pk': duePartition((startShard + offset) % OUTBOX_SHARDS),
            ':now': dueKey(now, '~'),
          },
          Limit: limit - claimed.length,
        }),
      );
      for (const item of result.Items ?? []) {
        const token = randomUUID();
        try {
          await this.client.send(
            new UpdateCommand({
              TableName: this.tableName,
              Key: keys.outbox(item.entryId as string),
              UpdateExpression: 'SET leaseToken = :token, leaseUntil = :until, dueSK = :due',
              ConditionExpression: '#state = :pending AND leaseUntil <= :now AND dueSK <= :cutoff',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':token': token,
                ':until': now + leaseSeconds * 1000,
                ':due': dueKey(now + leaseSeconds * 1000, item.entryId as string),
                ':pending': 'PENDING',
                ':now': now,
                ':cutoff': dueKey(now, '~'),
              },
            }),
          );
          claimed.push({
            entryId: item.entryId as string,
            messageGroupId: item.messageGroupId as string,
            leaseToken: token,
          });
        } catch (error) {
          if (!conditionalFailure(error)) throw error;
        }
      }
    }
    return claimed;
  }

  async markPublished(record: OutboxRecord): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.outbox(record.entryId),
          UpdateExpression:
            'SET #state = :published, publishedAt = :now, expiresAt = :ttl REMOVE duePK, dueSK, leaseToken, leaseUntil',
          ConditionExpression: 'leaseToken = :token AND #state = :pending',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':published': 'PUBLISHED',
            ':pending': 'PENDING',
            ':token': record.leaseToken,
            ':now': new Date().toISOString(),
            ':ttl': Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async releaseOutbox(record: OutboxRecord, delaySeconds = 5): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.outbox(record.entryId),
          UpdateExpression: 'SET leaseUntil = :zero, dueSK = :due REMOVE leaseToken',
          ConditionExpression: 'leaseToken = :token AND #state = :pending',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':zero': 0,
            ':due': dueKey(Date.now() + delaySeconds * 1000, record.entryId),
            ':token': record.leaseToken,
            ':pending': 'PENDING',
          },
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }
}
