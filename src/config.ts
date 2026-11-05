import { z } from 'zod';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z
    .object({
      ENVIRONMENT: z.enum(['local', 'production']).default('production'),
      SERVICE_ROLE: z.enum(['api', 'publisher', 'worker']).default('api'),
      AWS_REGION: z.string().min(1).default('us-east-1'),
      AWS_ENDPOINT_URL: z.url().optional(),
      TABLE_NAME: z.string().min(3),
      QUEUE_URL: z.url(),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      JWT_ISSUER: z.string().min(1).optional(),
      JWT_AUDIENCE: z.string().min(1).optional(),
      JWT_JWKS_URL: z.url().optional(),
      LOCAL_JWT_SECRET: z.string().min(32).optional(),
      PUBLIC_ORIGIN: z.url().optional(),
    })
    .parse(env);
  if (config.ENVIRONMENT === 'production' && (config.AWS_ENDPOINT_URL || config.LOCAL_JWT_SECRET)) {
    throw new Error('Local endpoints and local signing secrets are forbidden in production');
  }
  if (config.SERVICE_ROLE === 'api') {
    if (!config.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required for browser authentication');
    const origin = new URL(config.PUBLIC_ORIGIN);
    if (
      origin.origin !== config.PUBLIC_ORIGIN ||
      (config.ENVIRONMENT === 'production' && origin.protocol !== 'https:')
    )
      throw new Error('PUBLIC_ORIGIN must be an exact origin, using HTTPS in production');
    if (Boolean(config.JWT_ISSUER) !== Boolean(config.JWT_AUDIENCE))
      throw new Error('Configure both JWT issuer and audience or neither');
  }
  return config;
}
