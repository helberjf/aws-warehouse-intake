import { setupLocal } from './local-resources.ts';
import { DynamoIntakeStore } from '../src/storage/dynamo-store.ts';

const resources = await setupLocal(
  process.env.TABLE_NAME ?? 'warehouse-local',
  process.env.QUEUE_NAME ?? 'warehouse-local',
);
const store = new DynamoIntakeStore(resources.document, resources.tableName);
await store.putWarehouse('DEMO', { warehouseId: 'WH-01', name: 'Demo warehouse 1', active: true });
await store.putWarehouse('DEMO', { warehouseId: 'WH-02', name: 'Demo warehouse 2', active: true });
await store.putProduct('DEMO', { skuId: 'BULK-001', trackingMode: 'BULK', active: true });
await store.putProduct('DEMO', { skuId: 'SERIAL-001', trackingMode: 'SERIALIZED', active: true });
console.log(
  JSON.stringify({
    message: 'Local resources and synthetic catalog ready',
    tableName: resources.tableName,
    queueUrl: resources.queueUrl,
  }),
);
resources.dynamo.destroy();
resources.sqs.destroy();
