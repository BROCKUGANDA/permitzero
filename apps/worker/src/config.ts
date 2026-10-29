/**
 * Worker configuration. REDIS_URL is optional: without it the dispatcher and
 * queue consumers stay home and the process runs the database sweeps only —
 * degraded but honest, and exactly what the API reports on /v1/status.
 */
export interface WorkerConfig {
  appEnv: string;
  databaseUrl: string;
  /**
   * The restricted `pz_app` runtime role used for all tenant row access.
   * Defaults to `databaseUrl`; when it does, row-level security cannot bind this
   * process and boot says so.
   */
  databaseRuntimeUrl: string;
  runtimePoolMax: number;
  redisUrl: string | null;
  permitSigningKey: string;
  permitSigningKeyId: string;
  auditHmacKey: string | null;
  /** Milliseconds between outbox claim batches. */
  dispatchPollMs: number;
  /** Milliseconds between sweep passes. */
  sweepIntervalMs: number;
  /** Rows claimed per dispatcher batch. */
  dispatchBatchSize: number;
  /** Rows settled per sweep pass. */
  sweepBatchSize: number;
  /** BullMQ deliveries per job; paired with the consumer retry budget. */
  jobAttempts: number;
  /** Consumer concurrency per queue. */
  workerConcurrency: number;
  /** Age before an unknown execution is reconciled (in-flight calls settle first). */
  reconcileGraceMs: number;
  /** Bounded drain on SIGTERM; keep below the orchestrator's kill timeout. */
  shutdownGraceMs: number;
  /**
   * Retention: whether the sweep runs at all.
   *
   * Optional on the interface only because the worker test harness builds a
   * `WorkerConfig` literal of its own; `loadWorkerConfig` always sets all four
   * retention fields, so a running worker never sees an undefined value.
   */
  retentionEnabled?: boolean;
  /** Milliseconds between retention passes. */
  retentionSweepIntervalMs?: number;
  /** Days an audit event is kept before the sweep may remove it. */
  auditRetentionDays?: number;
  /** Days a delivery record is kept before the sweep may remove it. */
  outboxRetentionDays?: number;
}

/**
 * The retention defaults.
 *
 * Exported so `loadWorkerConfig` and the call site that starts the sweep read
 * the same numbers: a default that is written down twice is a default that
 * will be changed in one place.
 *
 * The audit window is a year because an audit trail that disappears on a
 * shorter horizon stops being evidence for most of the disputes it exists
 * for. The outbox window is a month because an outbox row is a delivery
 * record, not a record of what was decided.
 */
export const RETENTION_DEFAULTS = {
  enabled: true,
  sweepIntervalMs: 3_600_000,
  auditRetentionDays: 365,
  outboxRetentionDays: 30,
} as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
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

/**
 * A boolean from the environment, validated rather than coerced.
 *
 * `Boolean('false')` is true, so a configuration written as `RETENTION_ENABLED=false`
 * that reached a naive parser would ENABLE the thing the operator was trying
 * to turn off — and the thing it turns off is the deletion of their own audit
 * trail. A control that can only be enabled, never disabled, is not a control.
 */
function boolIn(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const lowered = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  throw new Error(`${name} must be a boolean (true/false), got "${raw}".`);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const permitSigningKey = required(env, 'PERMIT_SIGNING_KEY');
  if (permitSigningKey.length < 16) {
    throw new Error('PERMIT_SIGNING_KEY must be at least 16 characters.');
  }
  const appEnv = env['APP_ENV'] ?? 'development';
  return {
    appEnv,
    databaseUrl: required(env, 'DATABASE_URL'),
    databaseRuntimeUrl: env['DATABASE_URL_RUNTIME'] ?? env['DATABASE_URL'] ?? '',
    runtimePoolMax: intIn(env, 'RUNTIME_POOL_MAX', 10, 1, 200),
    redisUrl: env['REDIS_URL'] ?? null,
    permitSigningKey,
    permitSigningKeyId: env['PERMIT_SIGNING_KEY_ID'] ?? 'k1',
    // AUDIT_HMAC_KEY is required outside development and test.
    //
    // The worker appends to the same audit chain the API writes, and a chain
    // keyed with one key and appended to with another is two chains. Without
    // the key the append falls back to a plain unkeyed hash, which verifies
    // against the keyed rows as a break — so a worker that booted without the
    // key would corrupt the evidence product rather than merely omit it.
    auditHmacKey:
      env['AUDIT_HMAC_KEY']?.trim() ||
      (appEnv === 'development' || appEnv === 'test' ? null : required(env, 'AUDIT_HMAC_KEY')),
    shutdownGraceMs: intIn(env, 'SHUTDOWN_GRACE_MS', 10_000, 100, 120_000),
    dispatchPollMs: intIn(env, 'DISPATCH_POLL_MS', 500, 50, 60_000),
    sweepIntervalMs: intIn(env, 'SWEEP_INTERVAL_MS', 30_000, 1_000, 3_600_000),
    dispatchBatchSize: intIn(env, 'DISPATCH_BATCH_SIZE', 50, 1, 500),
    sweepBatchSize: intIn(env, 'SWEEP_BATCH_SIZE', 100, 1, 1000),
    jobAttempts: intIn(env, 'JOB_ATTEMPTS', 5, 1, 25),
    workerConcurrency: intIn(env, 'WORKER_CONCURRENCY', 5, 1, 100),
    reconcileGraceMs: intIn(env, 'RECONCILE_GRACE_MS', 30_000, 0, 3_600_000),
    // The retention window is bounded below by a day (a window shorter than
    // that is a mistake, not a policy) and above by ten years (past that the
    // "audit trail" is a storage decision rather than a retention one).
    retentionEnabled: boolIn(env, 'RETENTION_ENABLED', RETENTION_DEFAULTS.enabled),
    retentionSweepIntervalMs: intIn(
      env,
      'RETENTION_SWEEP_INTERVAL_MS',
      RETENTION_DEFAULTS.sweepIntervalMs,
      60_000,
      86_400_000,
    ),
    auditRetentionDays: intIn(env, 'AUDIT_RETENTION_DAYS', RETENTION_DEFAULTS.auditRetentionDays, 1, 3650),
    outboxRetentionDays: intIn(env, 'OUTBOX_RETENTION_DAYS', RETENTION_DEFAULTS.outboxRetentionDays, 1, 3650),
  };
}
