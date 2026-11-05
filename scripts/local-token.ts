import { SignJWT } from 'jose';

if (
  process.env.ENVIRONMENT !== 'local' ||
  !process.env.LOCAL_JWT_SECRET ||
  process.env.LOCAL_JWT_SECRET.length < 32
) {
  throw new Error('Token generation is available only with explicit local configuration');
}
const token = await new SignJWT({
  organizationId: 'DEMO',
  producerId: 'demo-erp',
  warehouseIds: ['WH-01', 'WH-02'],
  roles: ['receiving', 'admin'],
})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('local-operator')
  .setIssuer(process.env.JWT_ISSUER ?? 'warehouse-local')
  .setAudience(process.env.JWT_AUDIENCE ?? 'warehouse-api')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.LOCAL_JWT_SECRET));
console.log(token);
