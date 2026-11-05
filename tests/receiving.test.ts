import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareReceivingEntry, receivingEntrySchema } from '../src/domain/receiving.ts';

const serialized = JSON.parse(
  readFileSync(new URL('../examples/serialized-entry.json', import.meta.url), 'utf8'),
);
const bulk = JSON.parse(readFileSync(new URL('../examples/bulk-entry.json', import.meta.url), 'utf8'));
const scope = { organizationId: 'demo-org', warehouseId: 'WH-01', producerId: 'scanner-client' };
const bulkProduct = { skuId: String(bulk.skuId), trackingMode: 'BULK' as const };
const serializedProduct = { skuId: String(serialized.skuId), trackingMode: 'SERIALIZED' as const };
const prepare = (body: unknown) => {
  const parsed = receivingEntrySchema.parse(body);
  return prepareReceivingEntry(
    body,
    scope,
    'retry-key-1',
    parsed.skuId === bulkProduct.skuId ? bulkProduct : serializedProduct,
  );
};

test('one serialized entry represents exactly one physical unit', () => {
  const command = prepare(serialized);
  assert.equal(command.quantity, 1);
  assert.match(command.unitKey!, /^[a-f0-9]{64}$/);
});
test('one bulk movement carries its entire quantity and lot', () => {
  const command = prepare(bulk);
  assert.equal(command.quantity, 100);
  assert.equal(command.unitKey, undefined);
  assert.deepEqual(command.entry, bulk);
});
test('a repeated request produces stable business, request and payload identifiers', () => {
  assert.deepEqual(prepare(bulk), prepare({ ...bulk }));
});
test('changing an HTTP retry key does not create a new business movement identity', () => {
  const first = prepare(bulk);
  const second = prepareReceivingEntry(bulk, scope, 'different-retry-key', bulkProduct);
  assert.equal(first.entryId, second.entryId);
  assert.notEqual(first.idempotencyRecordId, second.idempotencyRecordId);
});
test('a reused business reference with different quantity can be detected as a conflict', () => {
  const first = prepare(bulk);
  const changed = prepare({ ...bulk, quantity: 101 });
  assert.equal(first.entryId, changed.entryId);
  assert.notEqual(first.payloadHash, changed.payloadHash);
});
test('warehouse scopes isolate requests but preserve global serialized-unit uniqueness', () => {
  const first = prepare(serialized);
  const other = prepareReceivingEntry(
    serialized,
    { ...scope, warehouseId: 'WH-02' },
    'retry-key-1',
    serializedProduct,
  );
  assert.notEqual(first.entryId, other.entryId);
  assert.notEqual(first.idempotencyRecordId, other.idempotencyRecordId);
  assert.equal(first.unitKey, other.unitKey);
  assert.notEqual(first.messageGroupId, other.messageGroupId);
});
test('organization scopes isolate unit registries', () => {
  const first = prepare(serialized);
  const other = prepareReceivingEntry(
    serialized,
    { ...scope, organizationId: 'other-org' },
    'retry-key-1',
    serializedProduct,
  );
  assert.notEqual(first.unitKey, other.unitKey);
});
test('trimmed fields produce the same normalized payload hash', () => {
  assert.equal(prepare(bulk).payloadHash, prepare({ ...bulk, skuId: '  ' + bulk.skuId + '  ' }).payloadHash);
});
for (const [description, body] of [
  ['fractional bulk quantity', { ...bulk, quantity: 1.5 }],
  ['negative bulk quantity', { ...bulk, quantity: -1 }],
  ['empty SKU', { ...bulk, skuId: ' ' }],
  ['serialized entries with bulk quantity', { ...serialized, quantity: 10 }],
  ['bulk entries with serial numbers', { ...bulk, serialNumber: 'unexpected' }],
  ['body ownership injection', { ...bulk, organizationId: 'other-org' }],
  ['invalid timestamps', { ...bulk, occurredAt: 'yesterday' }],
] as const) {
  test(`rejects ${description}`, () => assert.equal(receivingEntrySchema.safeParse(body).success, false));
}
test('an idempotency header is mandatory and bounded', () => {
  assert.throws(() => prepareReceivingEntry(bulk, scope, '', bulkProduct));
  assert.throws(() => prepareReceivingEntry(bulk, scope, 'x'.repeat(129), bulkProduct));
});
test('a serialized SKU cannot bypass unit tracking by declaring bulk mode', () => {
  assert.throws(() =>
    prepareReceivingEntry({ ...bulk, skuId: serialized.skuId }, scope, 'key', serializedProduct),
  );
});
test('the catalog lookup must match the requested SKU', () => {
  assert.throws(() => prepareReceivingEntry(bulk, scope, 'key', { ...bulkProduct, skuId: 'OTHER-SKU' }));
});
test('all producers in one warehouse share its queue fairness group', () => {
  const first = prepare(bulk);
  const other = prepareReceivingEntry(bulk, { ...scope, producerId: 'erp-client' }, 'key', bulkProduct);
  assert.equal(first.messageGroupId, other.messageGroupId);
  assert.notEqual(first.entryId, other.entryId);
});
