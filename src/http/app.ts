import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { ConflictError, EligibilityError } from '../application/ports.ts';
import type { IntakeStore, LedgerEntry } from '../application/ports.ts';
import { prepareReceivingEntry, receivingEntrySchema } from '../domain/receiving.ts';
import {
  AuthenticationError,
  AuthorizationError,
  authorizeAdmin,
  authorizeWarehouse,
  principalSchema,
} from './auth.ts';
import type { Authenticator, Principal } from './auth.ts';
import { registerFrontend } from './frontend.ts';
import { registerSessionRoutes } from '../identity/http.ts';
import type { IdentityService } from '../identity/service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const warehouseParams = z.object({ warehouseId: identifier });
const paging = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
class NotFoundError extends Error {}

function representation(entry: LedgerEntry) {
  return {
    entryId: entry.entryId,
    warehouseId: entry.warehouseId,
    producerId: entry.producerId,
    entry: entry.entry,
    quantity: entry.quantity,
    status: entry.status,
    acceptedAt: entry.acceptedAt,
    completedAt: entry.completedAt,
    rejectionReason: entry.rejectionReason,
    recordedBy: entry.recordedBy,
  };
}

export async function createApp(options: {
  store: IntakeStore;
  auth: Authenticator;
  ready?: () => Promise<void>;
  logger?: boolean;
  sessions?: { service: IdentityService; environment: 'local' | 'production'; publicOrigin: string };
}) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.headers["idempotency-key"]',
            ],
          },
    bodyLimit: 16 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    trustProxy:
      options.sessions?.environment === 'production' ? (_address: string, hop: number) => hop === 0 : false,
  });
  app.decorateRequest('principal');
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An internal error occurred';
    if (error instanceof AuthenticationError) {
      status = 401;
      code = 'UNAUTHENTICATED';
      message = 'A valid bearer token is required';
      reply.header('WWW-Authenticate', 'Bearer');
    } else if (error instanceof AuthorizationError) {
      status = 403;
      code = 'FORBIDDEN';
      message = 'Access denied';
    } else if (error instanceof NotFoundError) {
      status = 404;
      code = 'NOT_FOUND';
      message = 'Resource not found';
    } else if (error instanceof ConflictError || error instanceof EligibilityError) {
      status = 409;
      code = 'CONFLICT';
      message = 'Request conflicts with existing data or resource eligibility';
    } else if (error.statusCode === 413) {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body exceeds 16 KiB';
    } else if (error instanceof z.ZodError || error instanceof RangeError || error.statusCode === 400) {
      status = 400;
      code = 'INVALID_REQUEST';
      message = 'Invalid request fields, pagination or JSON';
    } else if (error.statusCode === 415) {
      status = 415;
      code = 'UNSUPPORTED_MEDIA_TYPE';
      message = 'Use application/json';
    }
    if (status === 500) request.log.error({ err: error }, 'Request failed');
    reply.code(status).send({ error: { code, message }, requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
      requestId: request.id,
    }),
  );
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (request, reply) => {
    try {
      await options.ready?.();
      return { status: 'ready' };
    } catch (error) {
      request.log.error({ err: error }, 'Readiness failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/openapi.json', async () =>
    JSON.parse(await readFile(new URL('../../schemas/openapi.json', import.meta.url), 'utf8')),
  );
  registerFrontend(app);
  const browser = options.sessions
    ? await registerSessionRoutes(app, options.sessions.service, options.sessions)
    : undefined;
  await app.register(async (api) => {
    api.addHook('onRequest', async (request) => {
      // Revalidate even injected adapters: tests cannot accidentally relax the principal shape.
      try {
        request.principal = principalSchema.parse(
          browser?.hasSessionCookie(request)
            ? await browser.authenticateBrowser(request)
            : await options.auth(request.headers.authorization),
        );
      } catch (error) {
        if (error instanceof AuthorizationError || error instanceof AuthenticationError) throw error;
        if (error instanceof z.ZodError) throw new AuthenticationError('Invalid credentials');
        throw error;
      }
    });
    function warehouse(request: FastifyRequest): string {
      const { warehouseId } = warehouseParams.parse(request.params);
      authorizeWarehouse(request.principal, warehouseId);
      return warehouseId;
    }
    api.post('/warehouses/:warehouseId/receiving-entries', async (request, reply) => {
      const warehouseId = warehouse(request);
      const body = receivingEntrySchema.parse(request.body);
      const idempotencyKey = z
        .string()
        .regex(/^[A-Za-z0-9._:-]{1,128}$/)
        .parse(request.headers['idempotency-key']);
      const principal = request.principal;
      const product = await options.store.getProduct(principal.organizationId, body.skuId);
      if (!product) throw new NotFoundError();
      // Active state is enforced atomically by accept; retries of accepted movements remain replayable.
      const prepared = prepareReceivingEntry(
        body,
        {
          organizationId: principal.organizationId,
          warehouseId,
          producerId: principal.producerId,
        },
        idempotencyKey,
        { skuId: product.skuId, trackingMode: product.trackingMode },
      );
      const entry = await options.store.accept({
        ...prepared,
        recordedBy: { subject: principal.subject, displayName: principal.displayName },
      });
      return reply
        .code(202)
        .header('Location', `/warehouses/${warehouseId}/receiving-entries/${entry.entryId}`)
        .send(representation(entry));
    });
    api.get('/warehouses/:warehouseId/receiving-entries/:entryId', async (request) => {
      const warehouseId = warehouse(request);
      const { entryId } = z.object({ entryId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
      const entry = await options.store.getEntry(entryId);
      if (
        !entry ||
        entry.organizationId !== request.principal.organizationId ||
        entry.warehouseId !== warehouseId
      )
        throw new NotFoundError();
      return representation(entry);
    });
    api.get('/warehouses/:warehouseId/receiving-entries', async (request) => {
      const warehouseId = warehouse(request);
      const { limit, cursor } = paging.parse(request.query);
      const page = await options.store.listEntries(
        request.principal.organizationId,
        warehouseId,
        limit,
        cursor,
      );
      return { ...page, items: page.items.map(representation) };
    });
    api.get('/warehouses/:warehouseId/stock/:skuId', async (request) => {
      const warehouseId = warehouse(request);
      const { skuId } = z.object({ skuId: identifier }).parse(request.params);
      const { limit, cursor } = paging.parse(request.query);
      return options.store.getBalances(request.principal.organizationId, warehouseId, skuId, limit, cursor);
    });
    api.get('/warehouses', async (request) => {
      const records = await Promise.all(
        request.principal.warehouseIds.map((id) =>
          options.store.getWarehouse(request.principal.organizationId, id),
        ),
      );
      return { items: records.filter((record) => record !== undefined) };
    });
    api.get('/products', async (request) => {
      const { limit, cursor } = paging.parse(request.query);
      return options.store.listProducts(request.principal.organizationId, limit, cursor);
    });
    api.get('/products/lookup', async (request) => {
      const { code } = z
        .object({ code: z.string().trim().min(1).max(128) })
        .strict()
        .parse(request.query);
      const product = await options.store.findProductByCode(request.principal.organizationId, code);
      if (!product) throw new NotFoundError();
      return product;
    });
    api.get('/warehouses/:warehouseId/stock', async (request) => {
      const id = warehouse(request);
      const { limit, cursor } = paging.parse(request.query);
      return options.store.listStock(request.principal.organizationId, id, limit, cursor);
    });
    api.put('/products/:skuId', async (request) => {
      authorizeAdmin(request.principal);
      const { skuId } = z.object({ skuId: identifier }).parse(request.params);
      const body = z
        .object({
          trackingMode: z.enum(['SERIALIZED', 'BULK']),
          active: z.boolean(),
          name: z.string().trim().min(1).max(128).optional(),
          barcode: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .regex(/^[\x21-\x7E]+$/)
            .optional(),
        })
        .strict()
        .parse(request.body);
      const product = { skuId, ...body };
      await options.store.putProduct(request.principal.organizationId, product, {
        subject: request.principal.subject,
        displayName: request.principal.displayName,
      });
      return options.store.getProduct(request.principal.organizationId, skuId);
    });
    api.put('/warehouses/:warehouseId', async (request) => {
      authorizeAdmin(request.principal);
      const warehouseId = warehouse(request);
      const body = z
        .object({ name: z.string().trim().min(1).max(128), active: z.boolean() })
        .strict()
        .parse(request.body);
      const record = { warehouseId, ...body };
      await options.store.putWarehouse(request.principal.organizationId, record);
      return record;
    });
  });
  return app;
}
