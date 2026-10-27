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
import { NotFoundError } from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import type { Broker } from '@permitzero/broker';
import { createBroker } from '@permitzero/db';
import type { Db, DbStores } from '@permitzero/db';
import { rlsEnforcementState } from '@permitzero/db';
import { createMetrics, type MetricsBundle } from '@permitzero/observability';
import { installRequestObservability, metricsRoute } from './observability.js';
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
  /**
   * The management pool (`DATABASE_URL`). Used for the migration-coverage
   * readiness probe only. It is usually a superuser and therefore exempt from
   * row-level security, so nothing that reads tenant rows goes through here.
   */
  db: Db;
  /**
   * The pool every tenant read and write goes through. When it is the restricted
   * `pz_app` role the database enforces isolation; when it is the same exempt
   * role as `db` it is not, and `probeTenantIsolation()` says so.
   */
  runtime: Db;
  config: ApiConfig;
  model: ModelAdapter;
  broker: Broker;
  queues: QueueWiring;
  /** Prometheus series for this process. One registry per app, so tests cannot read each other's counters. */
  metrics: MetricsBundle;
  /** Durable port adapters, shared by the broker, the dispatcher and the scrape refresh. */
  stores: DbStores;
  intake: IntakeDeps;
  approvals: ApprovalDeps;
  collect: CollectDeps;
  execute: ExecuteDeps;
}

export interface BuildAppDeps {
  db: Db;
  /** Restricted runtime role. Defaults to `db`, which disables RLS enforcement. */
  dbRuntime?: Db;
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
  const runtime = deps.dbRuntime ?? deps.db;
  const { broker, stores } = createBroker(runtime, {
    signingKey: deps.config.permitSigningKey,
    signingKeyId: deps.config.permitSigningKeyId,
    auditHmacKey: deps.config.auditHmacKey,
    clock,
  });
  const metrics = createMetrics({
    constLabels: { service: 'permitzero-api', environment: deps.config.appEnv },
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
    db: runtime,
    permitSigningKey: deps.config.permitSigningKey,
    permitSigningKeyId: deps.config.permitSigningKeyId,
    permitTtlSeconds: deps.config.permitTtlSeconds,
    auditHmacKey: deps.config.auditHmacKey,
    clock,
  };
  const ctx: AppContext = {
    db: deps.db,
    runtime,
    config: deps.config,
    model: deps.model,
    broker,
    queues,
    metrics,
    stores,
    intake: { ...shared, model: deps.model, metrics },
    approvals: { db: runtime, auditHmacKey: deps.config.auditHmacKey, clock, metrics },
    collect: { ...shared, metrics },
    execute: { db: runtime, broker, clock, metrics },
  };

  const app = Fastify({
    bodyLimit: deps.config.maxBodyBytes,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(sensible);
  await app.register(rateLimit, {
    max: deps.config.rateLimitMax,
    timeWindow: deps.config.rateLimitWindowMs,
  });

  // Replaces the previous `onRequest` hook that minted a fresh trace id per
  // request: an id generated here and never sent to anybody is a correlation key
  // that correlates nothing. The installed hook adopts a valid incoming
  // `traceparent` so an agent's own trace and our audit chain become one query.
  installRequestObservability(app, { metrics });

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

  // Operational gauges are refreshed at scrape time rather than on a timer: an
  // idle process then costs no database traffic, and a scrape never reports a
  // number that is stale by a whole poll interval.
  await app.register(async (scope) =>
    metricsRoute(scope, {
      metrics,
      token: deps.config.metricsToken,
      refresh: async () => {
        const counts = await stores.outbox.countByStatus();
        for (const [status, n] of Object.entries(counts)) {
          metrics.outboxByStatus.set({ status }, n);
        }
        const probe = ctx.queues.probeOutboxDepth;
        if (probe) {
          const depth = await probe().catch(() => null);
          if (depth) metrics.outboxOldestAgeSeconds.set((depth.oldestJobAgeMs ?? 0) / 1000);
        }
        // One probe, not two: this asked the database the same question twice per
        // scrape on the first pass, and the answer is a single row.
        const isolation = await rlsEnforcementState(runtime);
        metrics.tenantIsolationEnforced.set({ role: isolation.role }, isolation.enforced ? 1 : 0);
      },
    }),
  );

  return { app, ctx };
}

class NotFoundRouteError extends NotFoundError {
  constructor(request: { method?: string; url?: string }) {
    super(`No route for ${request.method ?? '?'} ${request.url ?? '?'}.`);
    this.name = 'NotFoundRouteError';
  }
}
