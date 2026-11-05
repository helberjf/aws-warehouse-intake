import { z } from 'zod';

const capacityInput = z
  .object({
    dailyUnits: z.number().int().min(1).max(1_000_000_000),
    serializedShare: z.number().min(0).max(1),
    averageBulkUnits: z.number().int().min(1).max(1_000_000),
    activeHours: z
      .number()
      .min(1 / 3600)
      .max(24),
    peakFactor: z.number().min(1).max(1000),
    warehouses: z.number().int().min(1).max(100_000),
  })
  .strict();
export type CapacityInput = z.infer<typeof capacityInput>;

export function planCapacity(input: CapacityInput) {
  const assumptions = capacityInput.parse(input);
  const serializedUnits = Math.round(assumptions.dailyUnits * assumptions.serializedShare);
  const bulkUnits = assumptions.dailyUnits - serializedUnits;
  const bulkMovements = Math.ceil(bulkUnits / assumptions.averageBulkUnits);
  const movementsPerDay = serializedUnits + bulkMovements;
  const operatingSeconds = assumptions.activeHours * 3600;
  return {
    assumptions,
    serializedUnits,
    bulkUnits,
    bulkMovements,
    movementsPerDay,
    unitsPerSecondOver24Hours: assumptions.dailyUnits / 86400,
    movementsPerSecondOver24Hours: movementsPerDay / 86400,
    operatingMovementsPerSecond: movementsPerDay / operatingSeconds,
    peakMovementsPerSecond: (movementsPerDay / operatingSeconds) * assumptions.peakFactor,
    evenlyDistributedMovementsPerWarehouse: movementsPerDay / assumptions.warehouses,
    interpretation: 'Arrival-rate estimate only; not a throughput benchmark or an AWS task/cost estimate.',
  };
}
