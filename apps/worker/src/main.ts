/**
 * Worker entrypoint: migrate, wire BullMQ when REDIS_URL is set, and run the
 * dispatcher, consumers and sweeps until told to stop. Boot logs name what
 * is enabled without printing any secret or URL credentials.
 */
import { closeDb, createDb, loadRootEnv, migrate, rlsEnforcementState } from '@permitzero/db';
import { createBullmqHandles, createBullmqWorkerFactory } from '@permitzero/queue';
import { loadWorkerConfig, RETENTION_DEFAULTS } from './config.js';
import { buildWorker } from './worker.js';
import { startRetentionSweep } from './retention.js';

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadWorkerConfig();
  const db = createDb(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.applied.length > 0) {
    console.log(`[worker] applied migrations: ${applied.applied.join(', ')}`);
  }

  const bullmq = config.redisUrl ? createBullmqHandles(config.redisUrl) : null;
  const workers = config.redisUrl ? createBullmqWorkerFactory(config.redisUrl) : null;
  const runtime = createDb(config.databaseRuntimeUrl, { max: config.runtimePoolMax });
  const isolation = await rlsEnforcementState(runtime);
  if (isolation.enforced) {
    console.log(
      `[worker] tenant isolation: enforced (role ${isolation.role}, ${isolation.tablesEnforced}/${isolation.tablesTotal} tables)`,
    );
  } else {
    console.warn(
      `[worker] tenant isolation: NOT enforced — role ${isolation.role} is ${
        isolation.subjectToRls
          ? `missing coverage (${isolation.unenforcedTables.join(', ') || 'unknown'})`
          : 'exempt from row-level security'
      }. Set DATABASE_URL_RUNTIME to the pz_app role.`,
    );
  }

  const built = buildWorker({
    db,
    dbRuntime: runtime,
    config,
    ...(bullmq && workers
      ? { queues: { factory: bullmq.factory, workerFactory: workers.factory, redis: bullmq.redis } }
      : {}),
  });
  built.start();
  console.log(`[worker] started (env=${config.appEnv})`);
  console.log(
    `[worker] dispatcher + consumers ${built.dispatcher ? 'running' : 'disabled (no REDIS_URL; sweeps only)'}`,
  );
  console.log(`[worker] sweeps every ${config.sweepIntervalMs}ms (reconcile grace ${config.reconcileGraceMs}ms)`);

  // The retention sweep.
  //
  // It runs on the MANAGEMENT pool (`db`), not the restricted runtime pool,
  // and that is the point rather than an accident: `pz_app` must never be
  // able to remove or rewrite an audit row, so the append-only trigger stays
  // shut for it and the sweep has to be a platform operation. See
  // apps/worker/src/retention.ts for what that costs and why the chain is
  // re-anchored rather than broken.
  //
  // It is started here rather than inside buildWorker because it is not a
  // database sweep in the same sense as the other two: it is a destructive,
  // audited, platform-level operation with its own configuration, and mixing
  // it into the sweep report would hide it behind the expiry numbers.
  const retentionEnabled = config.retentionEnabled ?? RETENTION_DEFAULTS.enabled;
  const retention = retentionEnabled
    ? startRetentionSweep(
        {
          db,
          config: {
            auditRetentionDays: config.auditRetentionDays ?? RETENTION_DEFAULTS.auditRetentionDays,
            outboxRetentionDays: config.outboxRetentionDays ?? RETENTION_DEFAULTS.outboxRetentionDays,
            auditHmacKey: config.auditHmacKey,
            operatorId: 'system:worker',
          },
        },
        { intervalMs: config.retentionSweepIntervalMs ?? RETENTION_DEFAULTS.sweepIntervalMs },
      )
    : null;
  retention?.start();
  console.log(
    retentionEnabled
      ? `[worker] retention every ${config.retentionSweepIntervalMs ?? RETENTION_DEFAULTS.sweepIntervalMs}ms ` +
          `(audit ${config.auditRetentionDays ?? RETENTION_DEFAULTS.auditRetentionDays}d, ` +
          `outbox ${config.outboxRetentionDays ?? RETENTION_DEFAULTS.outboxRetentionDays}d)`
      : '[worker] retention sweep disabled (RETENTION_ENABLED)',
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal}; shutting down`);
    // Bounded like the API's drain: a consumer that will not settle must not
    // become the reason the pools never close and the outbox lease is held open.
    const stopped = built.stop().catch(() => undefined);
    const deadline = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), config.shutdownGraceMs));
    const outcome = await Promise.race([stopped.then(() => 'clean' as const), deadline]);
    console.log(
      `[worker] consumers and dispatcher ${outcome === 'clean' ? 'stopped' : 'stopped forcibly after the grace window'} (${config.shutdownGraceMs}ms allowed)`,
    );
    await workers?.close().catch(() => undefined);
    await bullmq?.close().catch(() => undefined);
    retention?.stop();
    await closeDb(runtime).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(`[worker] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
