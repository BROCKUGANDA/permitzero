/**
 * Tenant-scoped execution context for row-level security.
 *
 * `infra/migrations/0006_row_level_security.sql` puts every tenant-bearing table
 * behind a policy that compares `tenant_id` against `current_setting('app.tenant_id')`.
 * This module is the only supported way to set that setting, and it sets it
 * transaction-locally (`set_config(..., true)`) on purpose:
 *
 *   · A pooled connection is handed to whichever query borrows it next. A
 *     session-level `SET` would therefore leak one request's tenant onto another
 *     request's transaction — the exact class of bug RLS is supposed to make
 *     impossible, reintroduced by the mechanism used to enable it.
 *   · Transaction-local means the context is gone at COMMIT or ROLLBACK with no
 *     reset step to remember and no way to forget it.
 *
 * Two consequences worth knowing while reading call sites:
 *
 *   1. Every statement must run on `tx`, not on the root `db.db`. A query issued
 *      through the root client gets a different pooled connection with no tenant
 *      context, and under RLS it returns zero rows. That is a fail-closed
 *      mistake, not a leak, but it is confusing to debug — hence
 *      `rlsEnforcementState()`, reported by /health/ready and /status.
 *   2. A transaction here holds one pool connection for its whole duration, so
 *      these helpers must not wrap network calls (the Meta model request, the
 *      connector). Intake is deliberately read-tx → model call → write-tx.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbExecutor, DbTransaction } from './client.js';

/**
 * Run `fn` inside a transaction whose tenant is `tenantId`.
 *
 * If `tenantId` is empty the transaction still opens, sets nothing, and every
 * tenant-bearing table then resolves `pz_current_tenant()` to NULL — zero rows
 * read, every write rejected. That is the intended behaviour for a caller that
 * lost its tenant, so it is not guarded into a friendly error.
 */
export async function withTenantTransaction<T>(
  db: Db,
  tenantId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` inside a transaction that is allowed to look across tenants, for the
 * two operations that legitimately must: resolving a bearer token to a tenant,
 * and the cross-tenant outbox claim.
 *
 * The grant is not "everything" — the policies in 0006 only open SELECT on the
 * five door tables and UPDATE on `outbox_events`, and the tenant-id-immutability
 * trigger keeps the claim from retargeting a row. Do not widen that set to make
 * a feature work; give the caller a tenant instead.
 */
export async function withTenantBlindTransaction<T>(db: Db, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('pz.tenant_blind', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Bind a batch of repository calls to one tenant, for the lifetime of one
 * transaction. This is the adapter between row-level security and the existing
 * repository functions, which all take a `DbExecutor` plus a `tenantId` argument
 * they also filter on.
 *
 * It is deliberately a *per logical unit* scope, not a per-request one. A
 * request that opens a transaction and then calls the Meta Model API would hold
 * a pool connection across a network round-trip, and a handler doing that at any
 * concurrency would exhaust the pool and turn an upstream slowdown into an
 * outage. Group statements that belong to one read into a single `scope()` call;
 * keep network calls outside it.
 *
 * When `db` is a role exempt from row-level security the scope still works — it
 * just enforces nothing. `rlsEnforcementState()` is how callers find out which
 * world they are in.
 */
export type TenantScope = <T>(fn: (ex: DbExecutor) => Promise<T>) => Promise<T>;

export function tenantScope(db: Db, tenantId: string): TenantScope {
  return <T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T> => withTenantTransaction(db, tenantId, (tx) => fn(tx));
}

export interface RlsEnforcementState {
  /** The role this connection actually authenticated as. */
  role: string;
  superuser: boolean;
  bypassrls: boolean;
  /**
   * True only when this connection is subject to row-level security. A
   * superuser or BYPASSRLS role reads and writes every tenant's rows no matter
   * how many policies exist, so policies alone are not evidence.
   */
  subjectToRls: boolean;
  /** True when this connection is subject to RLS *and* every tenant table is covered. */
  enforced: boolean;
  tablesTotal: number;
  tablesEnforced: number;
  unenforcedTables: string[];
  /** Rows missing a policy/trigger even though the role here could see past them. */
  coverageReadable: boolean;
}

/**
 * Ask the database what it is actually enforcing for this connection, rather
 * than asserting it from configuration. Safe to call on any pool.
 */
export async function rlsEnforcementState(db: Db): Promise<RlsEnforcementState> {
  const roleRows = await db.sql<
    { role: string; superuser: boolean; bypassrls: boolean }[]
  >`SELECT current_user::text AS role,
           COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser,
           COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypassrls`;
  const me = roleRows[0] ?? { role: 'unknown', superuser: false, bypassrls: false };
  const subjectToRls = !me.superuser && !me.bypassrls;

  let total = 0;
  let enforcedCount = 0;
  let unenforced: string[] = [];
  let coverageReadable = false;
  try {
    const rows = await db.sql<{ table_name: string; enforced: boolean }[]>`
      SELECT table_name, enforced FROM public.pz_rls_coverage ORDER BY table_name`;
    coverageReadable = true;
    total = rows.length;
    enforcedCount = rows.filter((r) => r.enforced).length;
    unenforced = rows.filter((r) => !r.enforced).map((r) => r.table_name);
  } catch {
    // The view is created by 0006, so it is absent before that migration has
    // run. Reported as "not enforced" rather than as a green check.
    coverageReadable = false;
  }

  return {
    role: me.role,
    superuser: me.superuser,
    bypassrls: me.bypassrls,
    subjectToRls,
    enforced: subjectToRls && coverageReadable && total > 0 && unenforced.length === 0,
    tablesTotal: total,
    tablesEnforced: enforcedCount,
    unenforcedTables: unenforced,
    coverageReadable,
  };
}
