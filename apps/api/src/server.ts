/**
 * Production wiring: configuration, migrations, BullMQ (when REDIS_URL is
 * set), the outbox dispatcher and graceful shutdown. Boot logs name what is
 * enabled without printing any secret or URL credentials.
 */
import { closeDb, createDb, loadRootEnv, migrate, rlsEnforcementState, type RlsEnforcementState } from '@permitzero/db';
import { MetaProviderClient, loadMetaConfig } from '@permitzero/provider-meta';
import { createBullmqHandles } from '@permitzero/queue';
import { loadConfig } from './config.js';
import { createModelAdapter } from './model.js';
import { buildApp } from './app.js';
import { closeWithinDeadline } from './shutdown.js';

function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * One line an operator can act on. `enforced` is the only state in which the
 * database is doing the tenant filtering; the other two say which half is
 * missing, because "RLS is configured" and "RLS applies to this connection" are
 * different claims and the first one is worthless on its own.
 */
function describeIsolation(isolation: RlsEnforcementState): string {
  if (isolation.enforced) {
    return `enforced (role ${isolation.role}, ${isolation.tablesEnforced}/${isolation.tablesTotal} tables)`;
  }
  if (!isolation.subjectToRls) {
    return `NOT enforced — role ${isolation.role} is ${isolation.superuser ? 'a superuser' : 'marked BYPASSRLS'}, so row-level security does not apply to it. Set DATABASE_URL_RUNTIME to the pz_app role.`;
  }
  if (!isolation.coverageReadable) {
    return `NOT enforced — role ${isolation.role} cannot read pz_rls_coverage; run npm run db:migrate.`;
  }
  return `NOT enforced — role ${isolation.role} is bound, but ${isolation.unenforcedTables.length} table(s) lack a policy or the tenant-id trigger: ${isolation.unenforcedTables.join(', ')}`;
}

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.applied.length > 0) {
    console.log(`[api] applied migrations: ${applied.applied.join(', ')}`);
  }

  // The runtime pool is the one that touches tenant rows, and it is a different
  // role from the migration pool on purpose: migrations need DDL rights, tenant
  // traffic needs a role the database can bind with row-level security. Asking
  // the database which of those it is, rather than reading a config flag, is
  // what keeps the claim honest after a deployment changes the URL.
  const runtime = createDb(config.databaseRuntimeUrl, { max: config.runtimePoolMax });
  const isolation = await rlsEnforcementState(runtime);

  // Meta selection loads its own config here so a missing key or model id
  // fails boot with the variable name, never a value.
  const meta = config.modelProvider === 'meta' ? new MetaProviderClient(loadMetaConfig()) : undefined;
  const model = createModelAdapter(config.modelProvider, meta ? { meta } : undefined);
  const bullmq = config.redisUrl ? createBullmqHandles(config.redisUrl) : null;
  const { app, ctx } = await buildApp({
    db,
    dbRuntime: runtime,
    config,
    model,
    ...(bullmq
      ? {
          queues: {
            factory: bullmq.factory,
            redis: bullmq.redis,
            probeOutboxDepth: bullmq.probeOutboxDepth,
          },
        }
      : {}),
  });

  ctx.queues.dispatcher?.start();
  await app.listen({ host: config.host, port: config.port });
  console.log(`[api] listening on http://${config.host}:${config.port} (env=${config.appEnv})`);
  console.log(`[api] database ${describeDatabase(config.databaseUrl)}`);
  console.log(`[api] tenant isolation: ${describeIsolation(isolation)}`);
  console.log(`[api] outbox dispatcher ${ctx.queues.dispatcher ? 'running' : 'disabled (no REDIS_URL)'}`);
  console.log(`[api] model provider ${model.providerName} (${model.enabled ? 'enabled' : 'disabled'})`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[api] ${signal}; shutting down`);
    await ctx.queues.dispatcher?.stop().catch(() => undefined);
    const report = await closeWithinDeadline(app, config.shutdownGraceMs);
    console.log(
      `[api] drained in ${report.tookMs}ms (grace ${report.graceMs}ms${report.forced ? ', connections forced closed' : ''})`,
    );
    await bullmq?.close().catch(() => undefined);
    await closeDb(runtime).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(`[api] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
