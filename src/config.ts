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
    })
    .parse(env);
  if (config.ENVIRONMENT === 'production' && (config.AWS_ENDPOINT_URL || config.LOCAL_JWT_SECRET)) {
    throw new Error('Local endpoints and local signing secrets are forbidden in production');
  }
  if (config.SERVICE_ROLE === 'api' && (!config.JWT_ISSUER || !config.JWT_AUDIENCE)) {
    throw new Error('JWT_ISSUER and JWT_AUDIENCE are required for API authentication');
  }
  return config;
}
