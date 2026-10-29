/**
 * API configuration. Everything comes from the environment with safe
 * defaults; missing secrets fail fast with a message that names the variable
 * but never prints a value.
 */
export interface ApiConfig {
  host: string;
  port: number;
  appEnv: string;
  version: string;
  databaseUrl: string;
  /**
   * The restricted `pz_app` role created by
   * `infra/migrations/0006_row_level_security.sql`, used for every tenant read
   * and write. Falls back to `databaseUrl` when unset, which means the
   * application is connected as a role that row-level security cannot bind —
   * `tenantIsolationEnforced` reports that rather than assuming it.
   */
  databaseRuntimeUrl: string;
  /** Pool ceiling for the runtime pool; each tenant transaction holds one connection. */
  runtimePoolMax: number;
  redisUrl: string | null;
  permitSigningKey: string;
  permitSigningKeyId: string;
  permitTtlSeconds: number;
  modelProvider: 'disabled' | 'static' | 'meta';
  auditHmacKey: string | null;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /**
   * Budget for state-changing calls (intake, approvals, permit collection), per
   * window. Declared in `.env.example` as RATE_LIMIT_MUTATIONS_PER_MIN long before
   * anything read it; a limit that is configured but not applied is worse than no
   * limit, because it is the kind of control an auditor marks as present.
   */
  rateLimitMutations: number;
  /** Budget for credential-bearing requests, the brute-force surface. */
  rateLimitAuth: number;
  /**
   * Browser origins allowed to call this API. Empty means no cross-origin access
   * at all: the console reaches the API same-origin through the edge rewrite, so
   * an empty list is the correct default rather than a misconfiguration, and
   * `origin: true` — which reflects whatever the caller sent — is not a policy.
   */
  corsOrigins: readonly string[];
  /**
   * Proxy hops whose `X-Forwarded-For` may be believed. Behind Caddy this must
   * name the loopback address, because with `trustProxy: false` every request
   * presents the proxy's IP and the rate limiter shares one bucket across all
   * customers — one noisy tenant exhausts the allowance for everyone.
   */
  trustedProxies: readonly string[];
  maxBodyBytes: number;
  /**
   * Operational log level. `LOG_LEVEL` sat in `.env.example` unread for most of
   * this project's life, which is the specific kind of false assurance an auditor
   * cannot see from outside: the app accepted the variable, Fastify logged nothing,
   * and the only `request.log.error` call in the codebase wrote into a no-op logger.
   */
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /**
   * Bearer token for `GET /metrics`. Unset means the endpoint is not registered
   * at all — there is no route to probe and no default to forget to change,
   * which is the safer failure than serving operational data to anyone who asks.
   */
  metricsToken: string | null;
  /**
   * How long SIGTERM lets in-flight requests finish before connections are closed
   * forcibly. Must stay below whatever `stop_grace_period` the orchestrator uses,
   * or the container is SIGKILLed mid-shutdown and the pools never close cleanly.
   */
  shutdownGraceMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

/** Comma-separated list, trimmed, blanks dropped. */
function csvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * `LOG_LEVEL`, validated rather than coerced. An unrecognised level is a
 * misconfiguration that hides the logs it was meant to turn on, so it fails boot
 * naming the variable and the accepted values — same rule as every other setting
 * here: never let a control be configured into a no-op.
 */
function logLevelOf(env: NodeJS.ProcessEnv): (typeof LOG_LEVELS)[number] {
  const raw = env['LOG_LEVEL']?.trim().toLowerCase();
  if (!raw) return 'info';
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as (typeof LOG_LEVELS)[number];
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${raw}").`);
}

function intIn(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer within ${min}..${max}.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const permitSigningKey = required(env, 'PERMIT_SIGNING_KEY');
  if (permitSigningKey.length < 16) {
    throw new Error('PERMIT_SIGNING_KEY must be at least 16 characters.');
  }
  const explicitOff = (env['MODEL_ENABLED'] ?? '').toLowerCase() === 'false';
  const requested = env['MODEL_PROVIDER'] ?? 'disabled';
  if (requested !== 'disabled' && requested !== 'static' && requested !== 'meta') {
    throw new Error("MODEL_PROVIDER must be 'disabled', 'static' or 'meta'.");
  }
  // MODEL_ENABLED=false is an explicit deterministic-only deployment choice
  // and wins over the provider selection. The runtime check above makes the
  // cast total.
  const modelProvider: ApiConfig['modelProvider'] = explicitOff
    ? 'disabled'
    : (requested as ApiConfig['modelProvider']);
  const appEnv = env['APP_ENV'] ?? 'development';
  return {
    host: env['HOST'] ?? '127.0.0.1',
    port: intIn(env, 'PORT', 3000, 1, 65535),
    appEnv,
    version: env['APP_VERSION'] ?? '0.1.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    databaseRuntimeUrl: env['DATABASE_URL_RUNTIME'] ?? env['DATABASE_URL'] ?? '',
    runtimePoolMax: intIn(env, 'RUNTIME_POOL_MAX', 10, 1, 200),
    redisUrl: env['REDIS_URL'] ?? null,
    permitSigningKey,
    permitSigningKeyId: env['PERMIT_SIGNING_KEY_ID'] ?? 'k1',
    permitTtlSeconds: intIn(env, 'PERMIT_TTL_SECONDS', 300, 1, 3600),
    modelProvider,
    // AUDIT_HMAC_KEY is required outside development and test: without it the
    // audit chain is a plain unkeyed SHA-256 and the tamper-evidence property
    // is downgraded to a hash anybody with database access can recompute.
    // Development and test are exempt so the suite needs no secret to run.
    auditHmacKey:
      env['AUDIT_HMAC_KEY']?.trim() ||
      (appEnv === 'development' || appEnv === 'test' ? null : required(env, 'AUDIT_HMAC_KEY')),
    rateLimitMax: intIn(env, 'RATE_LIMIT_MAX', 500, 1, 100000),
    rateLimitWindowMs: intIn(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    rateLimitMutations: intIn(env, 'RATE_LIMIT_MUTATIONS_PER_MIN', 120, 1, 100000),
    rateLimitAuth: intIn(env, 'RATE_LIMIT_AUTH_PER_MIN', 20, 1, 100000),
    corsOrigins: csvList(env['CORS_ORIGINS']),
    trustedProxies: csvList(env['TRUSTED_PROXIES']).length ? csvList(env['TRUSTED_PROXIES']) : ['127.0.0.1', '::1'],
    maxBodyBytes: intIn(env, 'MAX_BODY_BYTES', 1_048_576, 1024, 50_000_000),
    logLevel: logLevelOf(env),
    metricsToken: env['METRICS_TOKEN']?.trim() ? env['METRICS_TOKEN'].trim() : null,
    shutdownGraceMs: intIn(env, 'SHUTDOWN_GRACE_MS', 10_000, 100, 120_000),
  };
}
