/**
 * App composition: plugins, error mapping, auth-aware routes and the broker.
 * `buildApp` takes every integration as a parameter so tests inject fakes
 * (static model, disabled queue) while server.ts wires the real ones.
 */
import Fastify from 'fastify';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { NotFoundError, newId } from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import type { Broker } from '@permitzero/broker';
import { createBroker } from '@permitzero/db';
import type { Db } from '@permitzero/db';
import { adaptDbOutbox, createOutboxDispatcher } from '@permitzero/queue';
import type { OutboxDispatcher, QueueFactory, RedisLike } from '@permitzero/queue';
import type { ApiConfig } from './config.js';
import { toHttpError } from './errors.js';
import type { ModelAdapter } from './model.js';
import type { IntakeDeps } from './intake.js';
import type { ApprovalDeps } from './approvals.js';
import type { CollectDeps } from './permits.js';
import type { ExecuteDeps } from './execute.js';
import { actionRoutes } from './routes/actions.js';
import { auditRoutes } from './routes/audit.js';
import { evidenceRoutes } from './routes/evidence.js';
import { healthRoutes } from './routes/health.js';
import { statusRoutes } from './routes/status.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
    traceId: string;
  }
}

/** Route modules take this so request bodies stay zod-inferred. */
export type ZodFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface QueueWiring {
  factory: QueueFactory | null;
  redis: RedisLike | null;
  probeOutboxDepth: (() => Promise<{ depth: number; oldestJobAgeMs: number | null }>) | null;
  dispatcher: OutboxDispatcher | null;
}

export interface AppContext {
  db: Db;
  config: ApiConfig;
  model: ModelAdapter;
  broker: Broker;
  queues: QueueWiring;
  intake: IntakeDeps;
  approvals: ApprovalDeps;
  collect: CollectDeps;
  execute: ExecuteDeps;
}

export interface BuildAppDeps {
  db: Db;
  config: ApiConfig;
  model: ModelAdapter;
  clock?: () => Date;
  queues?: {
    factory: QueueFactory;
    redis: RedisLike;
    probeOutboxDepth: () => Promise<{ depth: number; oldestJobAgeMs: number | null }>;
  };
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(deps: BuildAppDeps): Promise<BuiltApp> {
  const clock = deps.clock ?? (() => new Date());
  const { broker, stores } = createBroker(deps.db, {
    signingKey: deps.config.permitSigningKey,
    signingKeyId: deps.config.permitSigningKeyId,
    auditHmacKey: deps.config.auditHmacKey,
    clock,
  });

  let queues: QueueWiring = { factory: null, redis: null, probeOutboxDepth: null, dispatcher: null };
  if (deps.queues) {
    const dispatcher = createOutboxDispatcher({
      store: adaptDbOutbox(stores.outbox, clock),
      queues: deps.queues.factory,
      now: clock,
    });
    queues = {
      factory: deps.queues.factory,
      redis: deps.queues.redis,
      probeOutboxDepth: deps.queues.probeOutboxDepth,
      dispatcher,
    };
  }

  const shared = {
    db: deps.db,
    permitSigningKey: deps.config.permitSigningKey,
    permitSigningKeyId: deps.config.permitSigningKeyId,
    permitTtlSeconds: deps.config.permitTtlSeconds,
    auditHmacKey: deps.config.auditHmacKey,
    clock,
  };
  const ctx: AppContext = {
    db: deps.db,
    config: deps.config,
    model: deps.model,
    broker,
    queues,
    intake: { ...shared, model: deps.model },
    approvals: { db: deps.db, auditHmacKey: deps.config.auditHmacKey, clock },
    collect: { ...shared },
    execute: { db: deps.db, broker, clock },
  };

  const app = Fastify({
    bodyLimit: deps.config.maxBodyBytes,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);
  await app.register(rateLimit, {
    max: deps.config.rateLimitMax,
    timeWindow: deps.config.rateLimitWindowMs,
  });

  app.addHook('onRequest', async (request) => {
    request.traceId = newId('trace');
  });

  app.setErrorHandler((err, request, reply) => {
    const traceId = (request as { traceId?: string }).traceId ?? null;
    const { status, envelope } = toHttpError(err, traceId);
    if (status >= 500) {
      request.log.error({ err, traceId }, 'unhandled error');
    }
    return reply.status(status).send(envelope);
  });
  app.setNotFoundHandler((request, reply) => {
    const traceId = (request as { traceId?: string }).traceId ?? null;
    const { status, envelope } = toHttpError(new NotFoundRouteError(request), traceId);
    return reply.status(status).send(envelope);
  });

  await app.register(async (v1) => {
    await v1.register((scope) => actionRoutes(scope, ctx), { prefix: '/v1' });
    await v1.register((scope) => auditRoutes(scope, ctx), { prefix: '/v1' });
    await v1.register((scope) => evidenceRoutes(scope, ctx), { prefix: '/v1' });
    await v1.register((scope) => statusRoutes(scope, ctx), { prefix: '/v1' });
  });
  await app.register((scope) => healthRoutes(scope, ctx));

  return { app, ctx };
}

class NotFoundRouteError extends NotFoundError {
  constructor(request: { method?: string; url?: string }) {
    super(`No route for ${request.method ?? '?'} ${request.url ?? '?'}.`);
    this.name = 'NotFoundRouteError';
  }
}
