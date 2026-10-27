/**
 * Worker entrypoint: migrate, wire BullMQ when REDIS_URL is set, and run the
 * dispatcher, consumers and sweeps until told to stop. Boot logs name what
 * is enabled without printing any secret or URL credentials.
 */
import { closeDb, createDb, loadRootEnv, migrate, rlsEnforcementState } from '@permitzero/db';
import { createBullmqHandles, createBullmqWorkerFactory } from '@permitzero/queue';
import { loadWorkerConfig } from './config.js';
import { buildWorker } from './worker.js';

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
