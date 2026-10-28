/**
 * Authenticated tenant status. Unlike /health/ready this names the tenant's
 * enforcement posture, the model provider's honest state and connector
 * health — the three things an operator asks about first.
 */
import { meSchema, statusSchema } from '@permitzero/schemas';
import {
  countOutboxByStatus,
  getEnforcementMode,
  getTenantById,
  healthCheck,
  listConnectors,
  tenantScope,
  withTenantBlindTransaction,
} from '@permitzero/db';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

const DEGRADED_QUEUE_DEPTH = 100;

export async function statusRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
  });

  app.get('/me', { schema: { response: { 200: meSchema } } }, async (request) => {
    const p = request.principal;
    return {
      actor_type: p.actorType,
      actor_id: p.actorId,
      tenant_id: p.tenantId,
      display_name: p.displayName,
      roles: [...p.roles],
      environment: p.environment,
    };
  });

  app.get('/status', { schema: { response: { 200: statusSchema } } }, async (request) => {
    const tenantId = request.principal.tenantId;
    // Three branches, deliberately not merged into one transaction:
    //
    //   · tenant / enforcement mode / connectors are one logical snapshot of THIS
    //     tenant's posture, so they share one tenant-scoped transaction. `tenants`,
    //     `enforcement_modes` and `connectors` all carry `tenant_id`, so any of
    //     them issued on the root pool would read zero rows and the route would
    //     answer with the defaults (`ENFORCED`, no connectors) instead of failing.
    //   · `healthCheck` is `SELECT 1` — a connectivity fact about the server, not a
    //     row read, so RLS cannot affect it and it stays on the management pool.
    //   · the outbox counts see the comment below; they are the one legitimately
    //     cross-tenant read here.
    //
    // The branches run concurrently as before, but the tenant reads now share one
    // transaction, so the request pins two runtime connections rather than four.
    const scope = tenantScope(ctx.runtime, tenantId);
    const [databaseUp, tenantSnapshot, outboxCounts] = await Promise.all([
      healthCheck(ctx.db),
      scope(async (ex) => {
        const [tenant, modeRow, connectors] = await Promise.all([
          getTenantById(ex, tenantId),
          getEnforcementMode(ex, tenantId),
          listConnectors(ex, tenantId),
        ]);
        return { tenant, modeRow, connectors };
      }),
      // `countOutboxByStatus` groups `outbox_events` by status with NO tenant_id
      // predicate, so it is a delivery-plane total, not tenant data — the same
      // read the dispatcher's cross-tenant claim uses (packages/db/src/stores.ts
      // runs it through `runBlind` for exactly this reason). Wrapping it in the
      // tenant scope would not error, it would quietly shrink `outbox_pending` /
      // `outbox_dead` to this tenant's share of a platform backlog. So it runs in
      // a blind transaction instead: policy `dispatch_read` (0007) is the only
      // thing that lets a non-exempt role see outbox rows across tenants, it is
      // transaction-local, and here it is read-only.
      withTenantBlindTransaction(ctx.runtime, (tx) => countOutboxByStatus(tx)).catch(
        () => ({}) as Record<string, number>,
      ),
    ]);
    const { tenant, modeRow, connectors } = tenantSnapshot;

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
