/**
 * Liveness and readiness probes. Both are unauthenticated (load balancers
 * cannot present credentials), so readiness reports only platform state —
 * per-tenant enforcement posture lives on the authenticated /v1/status.
 */
import { healthLiveSchema, healthReadySchema } from '@permitzero/schemas';
import { healthCheck, migrateStatus } from '@permitzero/db';
import type { AppContext, ZodFastifyInstance } from '../app.js';

export async function healthRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health/live', { schema: { response: { 200: healthLiveSchema } } }, async () => ({ status: 'ok' as const }));

  app.get('/health/ready', { schema: { response: { 200: healthReadySchema } } }, async () => {
    const reasons: string[] = [];
    const database = await healthCheck(ctx.db);
    if (!database) reasons.push('database unreachable');
    let migrationsApplied = false;
    try {
      const status = await migrateStatus(ctx.db);
      migrationsApplied = status.pending.length === 0;
      if (!migrationsApplied) {
        reasons.push(`${status.pending.length} migration(s) pending: ${status.pending.slice(0, 3).join(', ')}`);
      }
    } catch {
      reasons.push('migration status unreadable');
    }
    const ready = database && migrationsApplied;
    return {
      status: ready ? ('ready' as const) : ('not_ready' as const),
      database,
      migrations_applied: migrationsApplied,
      protected_writes_allowed: ready,
      reasons,
    };
  });
}
