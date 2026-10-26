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
 */
import { NotFoundError } from '@permitzero/domain';
import type { Broker } from '@permitzero/broker';
import {
  getAction,
  insertOutboxEvent,
  listExpiredApprovalActions,
  transitionAction,
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
}

export async function sweepExpiredApprovals(
  deps: SweepDeps,
  opts?: { now?: Date; limit?: number },
): Promise<ExpirySweepResult> {
  const now = opts?.now ?? deps.clock?.() ?? new Date();
  const rows = await listExpiredApprovalActions(deps.db.db, now, opts?.limit ?? 100);
  let expired = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const fresh = await getAction(deps.db.db, row.tenantId, row.actionId);
      if (!fresh || fresh.state !== 'APPROVAL_REQUIRED') continue;
      if (!fresh.expiresAt || fresh.expiresAt.getTime() > now.getTime()) continue;
      const moved = await transitionAction(deps.db.db, {
        tenantId: row.tenantId,
        actionId: row.actionId,
        to: 'EXPIRED',
        expectedVersion: fresh.version,
        now,
      });
      if (!moved.ok) continue; // a decider won the race; their outcome stands
      expired += 1;
      await deps.stores.audit.append({
        tenantId: row.tenantId,
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
      await insertOutboxEvent(deps.db.db, {
        tenantId: row.tenantId,
        aggregateType: 'action',
        aggregateId: row.actionId,
        eventType: 'action.expired',
        queueName: 'pz.outbox',
        payload: { action_id: row.actionId },
        traceId: row.traceId,
      });
    } catch (err) {
      errors += 1;
      console.error(
        `expiry sweep failed for action ${row.actionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { checked: rows.length, expired, errors };
}

export interface ReconcileSweepResult {
  checked: number;
  succeeded: number;
  failed: number;
  manual: number;
  skipped: number;
  errors: number;
}

const RECONCILABLE_STATES = new Set(['UNKNOWN_OUTCOME', 'RECONCILING']);

export async function sweepUnknownOutcomes(
  deps: SweepDeps,
  opts?: { now?: Date; limit?: number; graceMs?: number },
): Promise<ReconcileSweepResult> {
  const now = opts?.now ?? deps.clock?.() ?? new Date();
  const graceMs = opts?.graceMs ?? 30_000;
  const rows = await deps.stores.executions.listUnknownOutcomes(null, opts?.limit ?? 100);
  const result: ReconcileSweepResult = { checked: rows.length, succeeded: 0, failed: 0, manual: 0, skipped: 0, errors: 0 };
  for (const execution of rows) {
    if (execution.updatedAt.getTime() > now.getTime() - graceMs) {
      result.skipped += 1; // in flight; the caller may still be waiting on it
      continue;
    }
    try {
      const action = await getAction(deps.db.db, execution.tenantId, execution.actionId);
      if (!action || !RECONCILABLE_STATES.has(action.state)) {
        result.skipped += 1;
        continue;
      }
      const settled = await deps.broker.reconcile(execution.actionId, execution.tenantId);
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
  return result;
}
