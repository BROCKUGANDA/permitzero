/**
 * Authenticated tenant status. Unlike /health/ready this names the tenant's
 * enforcement posture, the model provider's honest state and connector
 * health — the three things an operator asks about first.
 */
import { statusSchema } from '@permitzero/schemas';
import {
  countOutboxByStatus,
  getEnforcementMode,
  getTenantById,
  healthCheck,
  listConnectors,
} from '@permitzero/db';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

const DEGRADED_QUEUE_DEPTH = 100;

export async function statusRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.db.db, request.headers.authorization, new Date());
  });

  app.get('/status', { schema: { response: { 200: statusSchema } } }, async (request) => {
    const tenantId = request.principal.tenantId;
    const [databaseUp, tenant, modeRow, connectors, outboxCounts] = await Promise.all([
      healthCheck(ctx.db),
      getTenantById(ctx.db.db, tenantId),
      getEnforcementMode(ctx.db.db, tenantId),
      listConnectors(ctx.db.db, tenantId),
      countOutboxByStatus(ctx.db.db).catch(() => ({}) as Record<string, number>),
    ]);

    let redis: 'up' | 'down' | 'disabled' = 'disabled';
    let queueStatus: 'ok' | 'degraded' | 'down' | 'disabled' = 'disabled';
    let depth = 0;
    let oldestJobAgeMs: number | null = null;
    if (ctx.queues.redis) {
      try {
        await ctx.queues.redis.ping();
        redis = 'up';
      } catch {
        redis = 'down';
      }
    }
    if (ctx.queues.probeOutboxDepth) {
      try {
        const probed = await ctx.queues.probeOutboxDepth();
        depth = probed.depth;
        oldestJobAgeMs = probed.oldestJobAgeMs;
        queueStatus = redis === 'down' ? 'down' : depth > DEGRADED_QUEUE_DEPTH ? 'degraded' : 'ok';
      } catch {
        queueStatus = 'down';
      }
    }

    const model = ctx.model.status();
    const healthy = connectors.filter((c) => c.status === 'ENABLED').length;
    const degraded = connectors.filter((c) => c.status === 'DEGRADED').length;
    const quarantined = connectors.filter((c) => c.status === 'QUARANTINED').length;

    const status =
      !databaseUp || queueStatus === 'down' || model.status === 'down'
        ? ('unavailable' as const)
        : queueStatus === 'degraded' || model.status === 'degraded' || degraded > 0 || quarantined > 0
          ? ('degraded' as const)
          : ('ok' as const);

    return {
      status,
      enforcement_mode: modeRow?.mode ?? 'ENFORCED',
      synthetic_data_mode: tenant?.synthetic ?? false,
      app_env: ctx.config.appEnv,
      version: ctx.config.version,
      dependencies: {
        database: databaseUp ? ('up' as const) : ('down' as const),
        redis,
        queue: {
          status: queueStatus,
          depth,
          oldest_job_age_ms: oldestJobAgeMs,
          outbox_pending: outboxCounts['PENDING'] ?? 0,
          outbox_dead: outboxCounts['DEAD'] ?? 0,
        },
        model_provider: {
          enabled: model.enabled,
          status: model.status,
          breaker: model.breaker,
          model_id: model.modelId,
        },
      },
      connectors: {
        total: connectors.length,
        healthy,
        degraded,
        quarantined,
      },
      checked_at: new Date(),
    };
  });
}
