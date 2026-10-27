/**
 * Database sweeps: the backstop behind every event. Queues can lose a nudge;
 * these passes re-derive the same work from stored state on an interval, so
 * nothing waits forever:
 *
 * - lapsed approval windows move to EXPIRED (deciders check the same clock,
 *   so a sweep and a late approval resolve to one outcome, never two);
 * - unknown executions past their grace period run through reconciliation.
 *
 * Rows are settled one at a time and a row that fails is logged and skipped,
 * never allowed to wedge the rest of the pass.
 *
 * Both passes iterate tenants rather than scanning every tenant in one query.
 * That is forced by row-level security — a cross-tenant SELECT needs the blind
 * context, which is reserved for the door and the outbox claim — but it is also
 * the better shape on its own merits: `limit` becomes per tenant, so a tenant
 * with a large approval backlog cannot consume the whole batch and delay every
 * other tenant's expiry by another interval. Only the tenant list itself is read
 * blind; all row work is tenant-scoped.
 */
import { NotFoundError } from '@permitzero/domain';
import type { Broker } from '@permitzero/broker';
import {
  getAction,
  insertOutboxEvent,
  listActiveTenantIds,
  listExpiredApprovalActions,
  tenantScope,
  transitionAction,
  withTenantBlindTransaction,
} from '@permitzero/db';
import type { Db, DbStores } from '@permitzero/db';

export interface SweepDeps {
  db: Db;
  stores: DbStores;
  broker: Broker;
  clock?: () => Date;
}

export interface ExpirySweepResult {
  checked: number;
  expired: number;
  errors: number;
  /** Tenants visited this pass; a surprise here usually means a tenant was suspended. */
  tenants: number;
}

async function activeTenantIds(db: Db): Promise<string[]> {
  return withTenantBlindTransaction(db, (tx) => listActiveTenantIds(tx));
}

export async function sweepExpiredApprovals(
  deps: SweepDeps,
  opts?: { now?: Date; limit?: number },
): Promise<ExpirySweepResult> {
  const now = opts?.now ?? deps.clock?.() ?? new Date();
  const limit = opts?.limit ?? 100;
  const tenants = await activeTenantIds(deps.db);
  let checked = 0;
  let expired = 0;
  let errors = 0;

  for (const tenantId of tenants) {
    const scope = tenantScope(deps.db, tenantId);
    const rows = await scope((ex) => listExpiredApprovalActions(ex, tenantId, now, limit));
    checked += rows.length;
    for (const row of rows) {
      try {
        // One transaction for read → compare-and-set → outbox insert. Splitting
        // them meant three pool round-trips per expired action, and left a
        // window in which the state had moved but the nudge was not yet durable.
        const outcome = await scope(async (ex) => {
          const fresh = await getAction(ex, tenantId, row.actionId);
          if (!fresh || fresh.state !== 'APPROVAL_REQUIRED') return null;
          if (!fresh.expiresAt || fresh.expiresAt.getTime() > now.getTime()) return null;
          const moved = await transitionAction(ex, {
            tenantId,
            actionId: row.actionId,
            to: 'EXPIRED',
            expectedVersion: fresh.version,
            now,
          });
          // a decider won the race; their outcome stands
          if (!moved.ok) return null;
          await insertOutboxEvent(ex, {
            tenantId,
            aggregateType: 'action',
            aggregateId: row.actionId,
            eventType: 'action.expired',
            queueName: 'pz.outbox',
            payload: { action_id: row.actionId },
            traceId: row.traceId,
          });
          return fresh;
        });
        if (!outcome) continue;
        expired += 1;
        await deps.stores.audit.append({
          tenantId,
          actionId: row.actionId,
          runId: row.runId,
          actorType: 'SYSTEM',
          actorId: 'system:worker',
          eventType: 'action.expired',
          eventTime: now,
          traceId: row.traceId,
          policyRevisionId: row.policyRevisionId,
          payloadRedacted: { expired_at: row.expiresAt?.toISOString() ?? null },
        });
      } catch (err) {
        errors += 1;
        console.error(
          `expiry sweep failed for action ${row.actionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return { checked, expired, errors, tenants: tenants.length };
}

export interface ReconcileSweepResult {
  checked: number;
  succeeded: number;
  failed: number;
  manual: number;
  skipped: number;
  errors: number;
  tenants: number;
}

const RECONCILABLE_STATES = new Set(['UNKNOWN_OUTCOME', 'RECONCILING']);

export async function sweepUnknownOutcomes(
  deps: SweepDeps,
  opts?: { now?: Date; limit?: number; graceMs?: number },
): Promise<ReconcileSweepResult> {
  const now = opts?.now ?? deps.clock?.() ?? new Date();
  const graceMs = opts?.graceMs ?? 30_000;
  const limit = opts?.limit ?? 100;
  const tenants = await activeTenantIds(deps.db);
  const result: ReconcileSweepResult = {
    checked: 0,
    succeeded: 0,
    failed: 0,
    manual: 0,
    skipped: 0,
    errors: 0,
    tenants: tenants.length,
  };

  for (const tenantId of tenants) {
    const executions = await deps.stores.executions.listUnknownOutcomes(tenantId, limit);
    result.checked += executions.length;
    for (const execution of executions) {
      if (execution.updatedAt.getTime() > now.getTime() - graceMs) {
        result.skipped += 1; // in flight; the caller may still be waiting on it
        continue;
      }
      try {
        const action = await tenantScope(deps.db, tenantId)((ex) => getAction(ex, tenantId, execution.actionId));
        if (!action || !RECONCILABLE_STATES.has(action.state)) {
          result.skipped += 1;
          continue;
        }
        const settled = await deps.broker.reconcile(execution.actionId, tenantId);
        if (settled.outcome === 'RESOLVED_SUCCEEDED') result.succeeded += 1;
        else if (settled.outcome === 'RESOLVED_FAILED') result.failed += 1;
        else result.manual += 1;
      } catch (err) {
        if (err instanceof NotFoundError) {
          result.skipped += 1;
          continue;
        }
        result.errors += 1;
        console.error(
          `reconcile sweep failed for execution ${execution.executionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return result;
}
