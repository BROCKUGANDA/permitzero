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
    // Which hops may be believed for the client address. `false` was the original
    // setting, and behind Caddy it silently collapses every customer into a single
    // rate-limit bucket keyed on the proxy's IP — so one tenant can exhaust the
    // allowance for all the others, which is an availability hole wearing the
    // clothes of a security control. Naming only the loopback hop means a caller
    // that is not the proxy cannot forge `X-Forwarded-For` to get a fresh bucket
    // or to frame another tenant.
    trustProxy: deps.config.trustedProxies.length > 0 ? [...deps.config.trustedProxies] : false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // `origin: true` reflects whatever the caller sent, so it is not a policy —
  // `.env.example` already named CORS_ORIGINS as the allowlist, and nothing read
  // it. An empty list now means "no cross-origin caller", which is the correct
  // default rather than a gap: the console reaches this API same-origin through
  // the edge rewrite, so the browser never needs a CORS grant in production.
  await app.register(cors, {
    origin: buildCorsOriginCheck(deps.config.corsOrigins),
  });
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
    // helmet's default is SAMEORIGIN, which still lets a page on this origin
    // frame the console. `frame-ancestors 'none'` in the CSP is the modern
    // control and is set below; this is aligned with it rather than being a
    // weaker second opinion, so a browser that honours only X-Frame-Options gets
    // the same policy. A clickjacked console can approve a payment.
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
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

/**
 * Fastify's `origin` option as a function: return true to allow (and echo) the
 * caller's origin, false to withhold the header so the browser blocks the read.
 *
 * Exact-match only. A prefix or wildcard match on `http://localhost` would also
 * accept `http://localhost.evil.example`, which is the classic way an allowlist
 * becomes a bypass.
 */
export function buildCorsOriginCheck(
  allowed: readonly string[],
): (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => void {
  const set = new Set(allowed);
  return (origin, callback) => {
    if (!origin) return callback(null, false); // same-origin / non-browser: no CORS grant needed
    callback(null, set.has(origin));
  };
}

/**
 * Per-route rate-limit presets. Fastify applies `config.rateLimit` on top of the
 * global ceiling, so a route that declares a tighter budget gets it.
 */
export function rateLimitPresets(config: ApiConfig): {
  mutation: { max: number; timeWindow: number };
  auth: { max: number; timeWindow: number };
} {
  return {
    mutation: { max: config.rateLimitMutations, timeWindow: 60_000 },
    auth: { max: config.rateLimitAuth, timeWindow: 60_000 },
  };
}

class NotFoundRouteError extends NotFoundError {
  constructor(request: { method?: string; url?: string }) {
    super(`No route for ${request.method ?? '?'} ${request.url ?? '?'}.`);
    this.name = 'NotFoundRouteError';
  }
}
