/**
 * Production wiring: configuration, migrations, BullMQ (when REDIS_URL is
 * set), the outbox dispatcher and graceful shutdown. Boot logs name what is
 * enabled without printing any secret or URL credentials.
 */
import { closeDb, createDb, migrate } from '@permitzero/db';
import { createBullmqHandles } from '@permitzero/queue';
import { loadConfig } from './config.js';
import { createModelAdapter } from './model.js';
import { buildApp } from './app.js';

function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.applied.length > 0) {
    console.log(`[api] applied migrations: ${applied.applied.join(', ')}`);
  }

  const model = createModelAdapter(config.modelProvider);
  const bullmq = config.redisUrl ? createBullmqHandles(config.redisUrl) : null;
  const { app, ctx } = await buildApp({
    db,
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
  console.log(`[api] outbox dispatcher ${ctx.queues.dispatcher ? 'running' : 'disabled (no REDIS_URL)'}`);
  console.log(`[api] model provider ${model.providerName} (${model.enabled ? 'enabled' : 'disabled'})`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[api] ${signal}; shutting down`);
    await ctx.queues.dispatcher?.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await bullmq?.close().catch(() => undefined);
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
