/**
 * Liveness and readiness probes. Both are unauthenticated (load balancers
 * cannot present credentials), so readiness reports only platform state —
 * per-tenant enforcement posture lives on the authenticated /v1/status.
 */
import { healthLiveSchema, healthReadySchema } from '@permitzero/schemas';
import type { TenantIsolation } from '@permitzero/schemas';
import { healthCheck, migrateStatus, rlsEnforcementState } from '@permitzero/db';
import type { AppContext, ZodFastifyInstance } from '../app.js';

export async function healthRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health/live', { schema: { response: { 200: healthLiveSchema } } }, async () => ({ status: 'ok' as const }));

  app.get('/health/ready', { schema: { response: { 200: healthReadySchema } } }, async () => {
    const reasons: string[] = [];
    const warnings: string[] = [];
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

    // Tenant isolation, asked of the pool that actually serves tenant traffic.
    // Probing `ctx.db` would prove nothing: it is the management pool and is
    // normally exempt, and RLS does not apply to a superuser or BYPASSRLS role
    // however many policies exist. So `enforced` here means "this connection is
    // bound by row-level security AND every tenant-bearing table is covered",
    // read from the database catalog rather than asserted from config.
    //
    // Readiness deliberately does not fail on it. A correctly configured app
    // whose runtime role simply has not been through 0006 yet is still serving
    // traffic — the repositories' own `WHERE tenant_id = ?` filters have not gone
    // anywhere — and failing the gate on a database-side rollout would pull
    // healthy instances out of rotation over a control that does not touch the
    // request path. Silence is the other wrong answer, though: this is precisely
    // the fact that decides whether one forgotten filter leaks or not, so it is
    // reported in full and carried by `warnings` + `tenant_isolation` instead of
    // by `reasons`, which stays the list of things that actually block traffic.
    // A deployment stuck at `enforced: false` keeps running and stays visible.
    //
    // `null` means the probe could not run at all, which is reported as unknown
    // rather than as a pass.
    let tenantIsolation: TenantIsolation | null = null;
    try {
      const state = await rlsEnforcementState(ctx.runtime);
      tenantIsolation = {
        role: state.role,
        superuser: state.superuser,
        bypassrls: state.bypassrls,
        subject_to_rls: state.subjectToRls,
        enforced: state.enforced,
        tables_total: state.tablesTotal,
        tables_enforced: state.tablesEnforced,
        unenforced_tables: state.unenforcedTables,
        coverage_readable: state.coverageReadable,
      };
      if (!state.subjectToRls) {
        warnings.push(
          `runtime pool authenticates as "${state.role}" (${state.superuser ? 'superuser' : 'BYPASSRLS'}): row-level security does not apply to it, so tenant isolation is enforced by application code only`,
        );
      } else if (!state.coverageReadable) {
        warnings.push(
          'runtime pool is bound by row-level security but pz_rls_coverage is unreadable; 0006_row_level_security may not be applied',
        );
      } else if (!state.enforced) {
        warnings.push(
          `${state.unenforcedTables.length} tenant-bearing table(s) without full row-level security: ${state.unenforcedTables
            .slice(0, 3)
            .join(', ')}`,
        );
      }
    } catch {
      warnings.push('tenant isolation state unreadable on the runtime pool');
    }

    const ready = database && migrationsApplied;
    return {
      status: ready ? ('ready' as const) : ('not_ready' as const),
      database,
      migrations_applied: migrationsApplied,
      protected_writes_allowed: ready,
      reasons,
      tenant_isolation: tenantIsolation,
      warnings,
    };
  });
}
