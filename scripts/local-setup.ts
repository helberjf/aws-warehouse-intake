import { setupLocal } from './local-resources.ts';
import { DynamoIntakeStore } from '../src/storage/dynamo-store.ts';
import { IdentityService } from '../src/identity/service.ts';
import { ConflictError } from '../src/application/ports.ts';

const resources = await setupLocal(
  process.env.TABLE_NAME ?? 'warehouse-local',
  process.env.QUEUE_NAME ?? 'warehouse-local',
);
const store = new DynamoIntakeStore(resources.document, resources.tableName);
await store.putWarehouse('DEMO', { warehouseId: 'WH-01', name: 'Galpão São Paulo', active: true });
await store.putWarehouse('DEMO', { warehouseId: 'WH-02', name: 'Galpão Campinas', active: true });
const seedActor = { subject: 'system:seed', displayName: 'Sistema de demonstração' };
await store.putProduct(
  'DEMO',
  {
    skuId: 'BULK-001',
    name: 'Caixa organizadora',
    barcode: '7891234567895',
    trackingMode: 'BULK',
    active: true,
  },
  seedActor,
);
await store.putProduct(
  'DEMO',
  {
    skuId: 'SERIAL-001',
    name: 'Coletor de dados',
    barcode: '7891234567802',
    trackingMode: 'SERIALIZED',
    active: true,
  },
  seedActor,
);
if (!process.env.LOCAL_ADMIN_PASSWORD)
  throw new Error('Run npm run local:configure to create private local login credentials');
try {
  await new IdentityService(resources.document, resources.tableName).provisionUser({
    organizationId: 'DEMO',
    username: process.env.LOCAL_ADMIN_USERNAME ?? 'admin',
    password: process.env.LOCAL_ADMIN_PASSWORD,
    displayName: 'Administrador local',
    producerId: 'warehouse-ui',
    warehouseIds: ['WH-01', 'WH-02'],
    roles: ['admin', 'receiving'],
  });
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
}
console.log(
  JSON.stringify({
    message: 'Local resources and synthetic catalog ready',
    tableName: resources.tableName,
    queueUrl: resources.queueUrl,
  }),
);
resources.dynamo.destroy();
resources.sqs.destroy();
