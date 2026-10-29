/**
 * App composition: plugins, error mapping, auth-aware routes and the broker.
 * `buildApp` takes every integration as a parameter so tests inject fakes
 * (static model, disabled queue) while server.ts wires the real ones.
 */
import Fastify from 'fastify';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import IORedis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { NotFoundError, RateLimitedError } from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import type { Broker } from '@permitzero/broker';
import { createBroker } from '@permitzero/db';
import type { Db, DbStores } from '@permitzero/db';
import { rlsEnforcementState } from '@permitzero/db';
import { createMetrics, type MetricsBundle } from '@permitzero/observability';
import { createSharedCounter, credentialFingerprint, SharedRateLimiter } from '@permitzero/observability';
import {
  AuditChainMonitor,
  installRequestObservability,
  metricsRoute,
  oldestUnpublishedOutboxAgeSeconds,
} from './observability.js';
import { adaptDbOutbox, createOutboxDispatcher } from '@permitzero/queue';
import type { OutboxDispatcher, QueueFactory, RedisLike } from '@permitzero/queue';
import type { ApiConfig } from './config.js';
import { toHttpError } from './errors.js';
import { breakerStateValue, type ModelAdapter } from './model.js';
import type { IntakeDeps } from './intake.js';
import type { ApprovalDeps } from './approvals.js';
import type { CollectDeps } from './permits.js';
import type { ExecuteDeps } from './execute.js';
import { actionRoutes } from './routes/actions.js';
import { alertSinkRoutes } from './routes/alerts.js';
import { auditRoutes } from './routes/audit.js';
import { evidenceRoutes } from './routes/evidence.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
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
    logger: loggerOptions(deps.config),
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

  // The model adapter reports its screening activity to this registry. The
  // adapter is built before the app — the provider client belongs to
  // server.ts — so the two are joined here rather than injected.
  deps.model.attachMetrics?.({
    modelScreenings: metrics.modelScreenings,
    modelLatency: metrics.modelLatency,
  });

  // The credential budget, charged on top of whatever the route's own limiter
  // charged.
  //
  // `createRateLimit` rather than a second `config.rateLimit` on the route,
  // because @fastify/rate-limit marks a request as already limited the first
  // time any limiter runs on it: a second limiter in the same chain is skipped
  // outright, and the one that would be skipped is the route's own mutation
  // budget. `createRateLimit` applies a limiter without setting that flag, so
  // both budgets are charged — which is the point of having two.
  //
  // Keyed on the CREDENTIAL rather than on the client address. Behind the
  // edge proxy every tenant of every customer shares one address, so an
  // address-keyed budget is a budget one tenant can exhaust on behalf of all
  // the others — an availability hole wearing the clothes of a security
  // control — and the address is also the part of a request an attacker most
  // wants to change. The credential's hash is the key: the same credential is
  // the same caller from every address, and two credentials never share a
  // budget.
  //
  // Two budgets, and the order matters. The LOCAL one is a floor: it is
  // per-process, so with N replicas it allows N times the intended rate, and
  // it is the only budget left when the shared counter cannot be reached. The
  // SHARED one is the control — the same allowance, counted in Redis, so
  // every replica spends from the same pot.
  const presets = rateLimitPresets(deps.config);
  const authBudget = presets.auth;
  const sharedBudgets = await createSharedBudgets(deps.config, presets, metrics, app.log);
  let authLimiter: ReturnType<FastifyInstance['createRateLimit']> | null = null;
  app.addHook('onRequest', async (request, reply) => {
    // The alert sink presents the alerting secret rather than a tenant
    // credential, so it is not a credential-bearing request and must not be
    // charged against the credential budget. It stays in the global limit.
    if (request.routeOptions?.config?.exemptFromAuthBudget) return;
    const header = request.headers.authorization;
    if (!header) return;
    const credential = bearerCredential(header);
    if (!credential) return;

    // Created on first use: @fastify/rate-limit decorates the instance when it
    // loads, and plugins load at ready() — after this hook is registered.
    //
    // The key is computed per request rather than captured from the first one:
    // a closure over the first request's credential would put every later
    // caller in the first caller's bucket, which is the opposite of charging
    // the credential that was actually presented.
    const limiter = (authLimiter ??= app.createRateLimit({
      max: authBudget.max,
      timeWindow: authBudget.timeWindow,
      // The credential, not the address: the same reasoning as the shared
      // budget below, applied to the local floor so the two count the same
      // thing.
      keyGenerator: (req) => {
        const presented = req.headers.authorization;
        const value = bearerCredential(typeof presented === 'string' ? presented : '');
        return credentialFingerprint(value ?? '');
      },
    }));
    const local = await limiter(request);
    if (local.isAllowed || !local.isExceeded) {
      // The shared budget: the same allowance, counted across every replica.
      const auth = await sharedBudgets.auth?.charge(credential);
      if (auth) {
        if (auth.unavailable) {
          // Fail open, and count it. An outage of the limiter must not take the
          // authorization API down with it — the limiter is a defence against
          // abuse, not the control that decides whether an action is allowed —
          // so the local budget above stands as the floor. The counter is how a
          // limiter that is quietly not enforcing anything becomes visible.
          metrics.sharedRateLimitFailures.inc();
          metrics.sharedRateLimitCharges.inc({ scope: 'auth', outcome: 'unavailable' });
        } else if (!auth.allowed) {
          metrics.sharedRateLimitCharges.inc({ scope: 'auth', outcome: 'refused' });
          reply.header('retry-after', String(auth.retryAfterSeconds));
          throw new RateLimitedError(auth.retryAfterSeconds);
        } else {
          metrics.sharedRateLimitCharges.inc({ scope: 'auth', outcome: 'allowed' });
        }
      }

      // The mutation budget, for the routes that declare one. The declaration
      // lives in the route's own rate-limit config, so the route table stays
      // the single place that says what a mutation is and what it costs.
      if (routeRateLimitScope(request) === 'mutation') {
        const mutation = await sharedBudgets.mutation?.charge(credential);
        if (mutation) {
          if (mutation.unavailable) {
            metrics.sharedRateLimitFailures.inc();
            metrics.sharedRateLimitCharges.inc({ scope: 'mutation', outcome: 'unavailable' });
          } else if (!mutation.allowed) {
            metrics.sharedRateLimitCharges.inc({ scope: 'mutation', outcome: 'refused' });
            reply.header('retry-after', String(mutation.retryAfterSeconds));
            throw new RateLimitedError(mutation.retryAfterSeconds);
          } else {
            metrics.sharedRateLimitCharges.inc({ scope: 'mutation', outcome: 'allowed' });
          }
        }
      }
      return;
    }
    reply.header('retry-after', String(local.ttlInSeconds));
    throw new RateLimitedError(local.ttlInSeconds);
  });

  // The limiter's own Redis connection, closed with the app. A process that
  // exits holding an open socket to Redis is a process that keeps the
  // connection's slot open after it is gone.
  app.addHook('onClose', async () => {
    await sharedBudgets.close();
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
    // The MFA routes. Registered inside the versioned scope because that is
    // where their paths belong (/v1/me/mfa/*) — they are the account's own
    // second factor, not a tenant resource.
    await v1.register((scope) => meRoutes(scope, ctx), { prefix: '/v1' });
    // The alert sink. Registered inside the versioned scope because that is
    // where its path belongs (/v1/internal/alerts), and it declares itself
    // exempt from the credential budget — it presents the alerting secret, not
    // a tenant credential.
    await v1.register((scope) => alertSinkRoutes(scope, ctx), { prefix: '/v1' });
  });
  await app.register((scope) => healthRoutes(scope, ctx));

  // Operational gauges are refreshed at scrape time rather than on a timer: an
  // idle process then costs no database traffic, and a scrape never reports a
  // number that is stale by a whole poll interval.
  //
  // The audit chain is verified on an interval instead of on every scrape: a
  // full verification recomputes every hash of every tenant's trail, which is
  // unbounded work in the number of events, and a scrape that outlasts
  // Prometheus's timeout takes the target down instead of reporting a slow
  // gauge. The monitor caches the answer for a minute.
  const auditChain = new AuditChainMonitor(runtime, { hmacKey: deps.config.auditHmacKey });
  await app.register(async (scope) =>
    metricsRoute(scope, {
      metrics,
      token: deps.config.metricsToken,
      refresh: async () => {
        const counts = await stores.outbox.countByStatus();
        for (const [status, n] of Object.entries(counts)) {
          metrics.outboxByStatus.set({ status }, n);
        }
        // Delivery lag is a property of the DATABASE, not of the queue. A
        // wedged dispatcher leaves unpublished rows behind and an empty queue,
        // so the queue's age would read zero while the delivery is hours late.
        metrics.outboxOldestAgeSeconds.set(await oldestUnpublishedOutboxAgeSeconds(runtime));
        const probe = ctx.queues.probeOutboxDepth;
        if (probe) {
          const depth = await probe().catch(() => null);
          // The queue's own backlog age, published under its own name. Zero is
          // the honest answer for an empty queue: there is no job to be late.
          if (depth) metrics.outboxOldestJobAgeSeconds.set((depth.oldestJobAgeMs ?? 0) / 1000);
        }
        // One probe, not two: this asked the database the same question twice per
        // scrape on the first pass, and the answer is a single row.
        const isolation = await rlsEnforcementState(runtime);
        metrics.tenantIsolationEnforced.set({ role: isolation.role }, isolation.enforced ? 1 : 0);
        // The provider's circuit breaker, read from the client that owns the
        // state machine. `status()` advances the breaker's cooldown clock, but
        // `analyze()` does the same before it refuses a call, so a scrape
        // cannot change which requests are attempted.
        const provider = ctx.model.status();
        metrics.breakerState.set({ dependency: ctx.model.providerName }, breakerStateValue(provider.breaker));
        try {
          const sweep = await auditChain.refresh();
          if (sweep) metrics.auditChainBreaks.set(sweep.breaks);
        } catch (err) {
          // A verification that could not run leaves the previous value in
          // place. Publishing zero here would claim a clean chain that nobody
          // checked, which is the one thing this gauge must never say.
          app.log.error({ err }, 'audit chain verification failed');
        }
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
 * Paths redacted from every log line, at the serializer rather than per call
 * site. A credential that has to be remembered is a credential that will one day
 * be logged: bearer tokens, cookies and the signing secrets all appear in requests
 * on this API's hot paths.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-alert-token"]',
  '*.authorization',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.permitSigningKey',
  '*.auditHmacKey',
] as const;

/**
 * Fastify's logger is disabled unless options are passed, and this app had been
 * running with it disabled: `LOG_LEVEL` was in `.env.example`, nothing read it, and
 * the single `request.log.error` call in the error handler wrote into a no-op
 * logger. An operator who sets `LOG_LEVEL=info` and gets no logs is worse off than
 * one who never set it, so the level is wired here and validated in config instead
 * of being ignored.
 */
export function loggerOptions(config: ApiConfig): {
  level: string;
  redact: { paths: string[]; censor: string };
} {
  return {
    level: config.logLevel,
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' },
  };
}

/**
 * Per-route rate-limit presets. Fastify applies `config.rateLimit` on top of the
 * global ceiling, so a route that declares a tighter budget gets it.
 *
 * The `scope` on each preset is not decoration: it travels with the route's
 * rate-limit config, and it is how the shared (cross-replica) budget knows
 * which budget a route spends. Without it the shared budget would have to
 * guess from the request method, and a POST that is not a mutation — a
 * read-shaped POST, an approval — would be charged as one.
 */
export function rateLimitPresets(config: ApiConfig): {
  mutation: { max: number; timeWindow: number; scope: 'mutation' };
  auth: { max: number; timeWindow: number; scope: 'auth' };
} {
  return {
    mutation: { max: config.rateLimitMutations, timeWindow: 60_000, scope: 'mutation' },
    auth: { max: config.rateLimitAuth, timeWindow: 60_000, scope: 'auth' },
  };
}

/**
 * The credential presented on a request, or null when there is none.
 *
 * The scheme is stripped: the budget is charged against the credential, and
 * `Bearer` is not part of it. A header that is not a bearer token at all is
 * still a credential as far as the limiter is concerned — an attacker
 * guessing tokens must not be able to step outside the budget by writing
 * `Basic` instead.
 */
export function bearerCredential(header: string): string | null {
  const value = header.trim();
  if (!value) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  const credential = (bearer?.[1] ?? value).trim();
  return credential.length > 0 ? credential : null;
}

/**
 * The scope a route's own rate-limit config declares, if any.
 *
 * Read from the route rather than guessed from the method: the route table is
 * where this repository says what a mutation is, and a second guess here would
 * be a second answer to the same question.
 */
export function routeRateLimitScope(request: FastifyRequest): string | undefined {
  const limit = request.routeOptions?.config?.rateLimit;
  if (!limit || typeof limit !== 'object') return undefined;
  return (limit as { scope?: string }).scope;
}

/** How long the limiter waits for a socket to come up. */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long one counter command may take.
 *
 * Shorter than the queue's deadline, because this one is on the request path:
 * a limiter that waits five seconds for a counter is a limiter that has
 * stopped protecting anything. A command that misses the deadline is treated
 * as a counter that could not be read, which fails open onto the local limit.
 */
const REDIS_COMMAND_DEADLINE_MS = 1_000;

/**
 * How long the boot waits for the limiter's Redis connection.
 *
 * Long enough for a healthy Redis to answer, short enough that an absent one
 * does not hold the API's startup hostage.
 */
const REDIS_READY_WAIT_MS = 1_000;

/**
 * The limiter's Redis connection.
 *
 * Deliberately NOT the queue's connection: the queue's client is a BullMQ
 * producer whose retry policy is tuned for a background dispatcher, and a
 * limiter must not inherit a policy that waits for a reconnecting server.
 * `enableOfflineQueue: false` and `maxRetriesPerRequest: 1` mean a command
 * issued while Redis is unreachable fails immediately rather than queueing
 * behind the reconnection — the budget is then simply not charged, and the
 * local limit stands.
 */
function limiterRedisOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_DEADLINE_MS,
    // Reconnect, but back off: a Redis that is down should not be hammered
    // once per request by every replica.
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  };
}

/**
 * The namespace for the shared counter keys.
 *
 * Read from the environment rather than from `config.ts`, which does not carry
 * the field yet — the coordinator owns that file. Two deployments pointed at
 * one Redis would otherwise spend each other's allowance, and the only defence
 * against that is a prefix that differs.
 */
export function sharedRateLimitPrefix(): string {
  const prefix = process.env['RATE_LIMIT_REDIS_PREFIX']?.trim();
  return prefix && prefix.length > 0 ? prefix : 'permitzero:rate-limit';
}

export interface SharedBudgets {
  /** The credential budget, shared across replicas. Null when there is no Redis. */
  auth: SharedRateLimiter | null;
  /** The mutation budget, shared across replicas. Null when there is no Redis. */
  mutation: SharedRateLimiter | null;
  close: () => Promise<void>;
}

/**
 * Wait, briefly, for the limiter's Redis connection.
 *
 * Until the connection is up the counter cannot be charged, and a request that
 * arrives in that window is answered under the local limit alone — so the
 * wait is worth a moment of boot time. It is bounded, because a Redis that is
 * down must not stop the API from booting: the limiter fails open by design,
 * and a boot that waits for a limiter is a boot that turns a degraded control
 * into an outage.
 */
async function waitForRedis(client: IORedis, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return true;
  return new Promise((resolve) => {
    const finish = (ready: boolean): void => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ready);
    };
    const onReady = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.once('ready', onReady);
  });
}

/**
 * The shared budgets, backed by one Redis counter per credential and window.
 *
 * Without a Redis there is no shared budget and each replica enforces its
 * own — which is published as a metric rather than left to be discovered,
 * because a deployment that believes it has a shared budget and does not is
 * invisible from the outside and allows N times the intended rate.
 */
export async function createSharedBudgets(
  config: ApiConfig,
  presets: ReturnType<typeof rateLimitPresets>,
  metrics: MetricsBundle,
  log: FastifyBaseLogger,
): Promise<SharedBudgets> {
  const redisUrl = config.redisUrl;
  if (!redisUrl) {
    metrics.sharedRateLimitEnabled.set(0);
    return { auth: null, mutation: null, close: async () => undefined };
  }
  const client = new IORedis(redisUrl, limiterRedisOptions());
  // ioredis emits 'error' on every failed reconnect, and an unhandled 'error'
  // event on an EventEmitter is thrown. Without this listener a Redis outage
  // would take the API process down — turning a fail-open design into the
  // outage it was designed to avoid.
  client.on('error', (err) => {
    log.warn({ err }, 'shared rate limit: redis unavailable, budgets fall back to the local limit');
  });
  const ready = await waitForRedis(client, REDIS_READY_WAIT_MS);
  if (!ready) {
    log.warn('shared rate limit: redis did not answer at boot, budgets fall back to the local limit');
  }
  const store = createSharedCounter(client);
  const prefix = sharedRateLimitPrefix();
  metrics.sharedRateLimitEnabled.set(1);
  return {
    auth: new SharedRateLimiter({
      store,
      prefix,
      scope: 'auth',
      max: presets.auth.max,
      timeWindowMs: presets.auth.timeWindow,
    }),
    mutation: new SharedRateLimiter({
      store,
      prefix,
      scope: 'mutation',
      max: presets.mutation.max,
      timeWindowMs: presets.mutation.timeWindow,
    }),
    close: async () => {
      client.disconnect();
    },
  };
}

class NotFoundRouteError extends NotFoundError {
  constructor(request: { method?: string; url?: string }) {
    super(`No route for ${request.method ?? '?'} ${request.url ?? '?'}.`);
    this.name = 'NotFoundRouteError';
  }
}
