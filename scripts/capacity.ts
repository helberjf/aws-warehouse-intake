import { parseArgs } from 'node:util';
import { planCapacity } from '../src/planning/capacity.ts';

const { values } = parseArgs({
  options: {
    'daily-units': { type: 'string', default: '100000' },
    'serialized-share': { type: 'string', default: '0.5' },
    'avg-bulk-units': { type: 'string', default: '100' },
    'active-hours': { type: 'string', default: '8' },
    'peak-factor': { type: 'string', default: '30' },
    warehouses: { type: 'string', default: '5' },
  },
});
const result = planCapacity({
  dailyUnits: Number(values['daily-units']),
  serializedShare: Number(values['serialized-share']),
  averageBulkUnits: Number(values['avg-bulk-units']),
  activeHours: Number(values['active-hours']),
  peakFactor: Number(values['peak-factor']),
  warehouses: Number(values.warehouses),
});
console.log(JSON.stringify(result, null, 2));
