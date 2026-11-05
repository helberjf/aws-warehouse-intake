import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const common = {
  skuId: identifier,
  externalReference: z.string().trim().min(1).max(128),
  occurredAt: z.iso.datetime(),
};

export const receivingEntrySchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...common,
      mode: z.literal('SERIALIZED'),
      serialNumber: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal('BULK'),
      quantity: z.number().int().min(1).max(1_000_000),
      lotCode: z.string().trim().min(1).max(128).optional(),
    })
    .strict(),
]);

const contextSchema = z
  .object({
    organizationId: identifier,
    warehouseId: identifier,
    producerId: identifier,
  })
  .strict();
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const productSchema = z
  .object({
    skuId: identifier,
    trackingMode: z.enum(['SERIALIZED', 'BULK']),
  })
  .strict();
export type ReceivingContext = z.infer<typeof contextSchema>;
export type ReceivingEntry = z.infer<typeof receivingEntrySchema>;
export type ReceivingProduct = z.infer<typeof productSchema>;

const digest = (values: unknown): string => createHash('sha256').update(JSON.stringify(values)).digest('hex');

/** Identity/warehouse access and the product catalog are trusted inputs, not request body fields. */
export function prepareReceivingEntry(
  body: unknown,
  context: ReceivingContext,
  idempotencyKey: string,
  product: ReceivingProduct,
) {
  const entry = receivingEntrySchema.parse(body);
  const scope = contextSchema.parse(context);
  const requestKey = keySchema.parse(idempotencyKey);
  const catalog = productSchema.parse(product);
  if (catalog.skuId !== entry.skuId || catalog.trackingMode !== entry.mode) {
    throw new z.ZodError([
      { code: 'custom', path: ['mode'], message: 'SKU and tracking mode must match the product catalog' },
    ]);
  }
  const namespace = [scope.organizationId, scope.warehouseId, scope.producerId];
  return {
    ...scope,
    entry,
    quantity: entry.mode === 'SERIALIZED' ? 1 : entry.quantity,
    // Stable across HTTP keys: one producer reference represents one physical receiving movement.
    entryId: digest([...namespace, entry.externalReference]),
    idempotencyRecordId: digest([...namespace, requestKey]),
    payloadHash: digest(entry),
    messageGroupId: digest([scope.organizationId, scope.warehouseId]),
    // A serialized unit cannot be received into two warehouses in the same organization.
    unitKey:
      entry.mode === 'SERIALIZED'
        ? digest([scope.organizationId, entry.skuId, entry.serialNumber])
        : undefined,
  };
}
