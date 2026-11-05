import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
const base = {
  TABLE_NAME: 'test',
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/test',
  SERVICE_ROLE: 'worker',
};
test('configuration defaults to production and blocks local bypasses', () => {
  assert.equal(loadConfig(base).ENVIRONMENT, 'production');
  assert.throws(() => loadConfig({ ...base, AWS_ENDPOINT_URL: 'http://localhost:4566' }));
  assert.throws(() => loadConfig({ ...base, LOCAL_JWT_SECRET: 'a'.repeat(32) }));
});
test('API requires explicit authentication configuration', () => {
  assert.throws(() => loadConfig({ ...base, SERVICE_ROLE: 'api' }));
  assert.throws(() => loadConfig({ ...base, PORT: '0' }));
});
test('browser-only production uses a trusted HTTPS origin without requiring an external JWT provider', () => {
  assert.equal(
    loadConfig({ ...base, SERVICE_ROLE: 'api', PUBLIC_ORIGIN: 'https://warehouse.example.com' })
      .PUBLIC_ORIGIN,
    'https://warehouse.example.com',
  );
  assert.throws(() =>
    loadConfig({ ...base, SERVICE_ROLE: 'api', PUBLIC_ORIGIN: 'http://warehouse.example.com' }),
  );
  assert.throws(() =>
    loadConfig({ ...base, SERVICE_ROLE: 'api', PUBLIC_ORIGIN: 'https://warehouse.example.com/path' }),
  );
  assert.throws(() =>
    loadConfig({
      ...base,
      SERVICE_ROLE: 'api',
      PUBLIC_ORIGIN: 'https://warehouse.example.com',
      JWT_ISSUER: 'https://issuer.example.com',
    }),
  );
});
