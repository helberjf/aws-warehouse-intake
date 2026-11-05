import assert from 'node:assert/strict';
import test from 'node:test';
import { planCapacity } from '../src/planning/capacity.ts';

const base = {
  dailyUnits: 100000,
  serializedShare: 1,
  averageBulkUnits: 100,
  activeHours: 8,
  peakFactor: 30,
  warehouses: 5,
};
test('100,000 serialized units produce 100,000 receiving movements', () => {
  const result = planCapacity(base);
  assert.equal(result.movementsPerDay, 100000);
  assert.equal(result.unitsPerSecondOver24Hours, 100000 / 86400);
  assert.equal(result.operatingMovementsPerSecond, 100000 / 28800);
  assert.equal(result.peakMovementsPerSecond, (100000 / 28800) * 30);
});
test('mixed receiving counts bulk movements rather than individual bulk units', () => {
  const result = planCapacity({ ...base, serializedShare: 0.4 });
  assert.equal(result.serializedUnits, 40000);
  assert.equal(result.bulkUnits, 60000);
  assert.equal(result.bulkMovements, 600);
  assert.equal(result.movementsPerDay, 40600);
});
test('bulk-only receipts group units into receiving movements', () => {
  assert.equal(planCapacity({ ...base, serializedShare: 0 }).movementsPerDay, 1000);
});
test('a partial final bulk movement is counted', () => {
  assert.equal(planCapacity({ ...base, dailyUnits: 100050, serializedShare: 0 }).bulkMovements, 1001);
});
test('warehouse count does not divide away system-wide peak traffic', () => {
  const first = planCapacity(base);
  const second = planCapacity({ ...base, warehouses: 20 });
  assert.equal(first.peakMovementsPerSecond, second.peakMovementsPerSecond);
  assert.equal(second.evenlyDistributedMovementsPerWarehouse, 5000);
});
test('invalid capacity assumptions fail instead of producing a misleading estimate', () => {
  for (const invalid of [
    { activeHours: 0 },
    { activeHours: 25 },
    { dailyUnits: -1 },
    { serializedShare: 1.5 },
    { averageBulkUnits: 0 },
    { warehouses: 0 },
    { peakFactor: Infinity },
  ])
    assert.throws(() => planCapacity({ ...base, ...invalid }));
});
