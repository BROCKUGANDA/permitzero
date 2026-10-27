/**
 * Permit collection: POST /v1/actions/:id/permit.
 *
 * Human quorum moves an action to APPROVED but issues nothing — the token
 * must reach the agent that will spend it, not the human who approved it.
 * The owning agent (or an operator-grade human, or a service) collects the
 * single-use token here, exactly once: after issuance the action leaves
 * APPROVED, so a second collection finds no permit to give.
 */
import { ConflictError, NotFoundError } from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import type { PermitDto } from '@permitzero/schemas';
import { PermitService } from '@permitzero/broker';
import {
  createDbStores,
  getAction,
  getEnforcementMode,
  tenantScope,
  transitionAction,
  withTenantTransaction,
} from '@permitzero/db';
import type { Db, DbTransaction } from '@permitzero/db';
import type { MetricsBundle } from '@permitzero/observability';
import { requireExecute } from './auth.js';
import { toActionRecord } from '@permitzero/db';

export interface CollectDeps {
  db: Db;
  permitSigningKey: string;
  permitSigningKeyId: string;
  permitTtlSeconds: number;
  auditHmacKey: string | null;
  clock?: () => Date;
  /** Prometheus series; recorded here so the decision itself, not just the HTTP envelope, is observable. */
  metrics: MetricsBundle;
}

const BLOCKED_MODES = ['EMERGENCY_STOP', 'DEGRADED_READ_ONLY', 'QUARANTINE'] as const;

export async function collectPermit(deps: CollectDeps, principal: Principal, actionId: string): Promise<PermitDto> {
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;
  const scope = tenantScope(deps.db, tenantId);

  // Whether this collection is allowed is one question about two tables, so it
  // gets one transaction: the action row and the tenant's operating mode are
  // read together and cannot straddle a mode flip.
  const { action, mode } = await scope(async (ex) => {
    const found = await getAction(ex, tenantId, actionId);
    if (!found) throw new NotFoundError();
    return { action: found, mode: (await getEnforcementMode(ex, tenantId))?.mode ?? 'ENFORCED' };
  });

  requireExecute(principal, toActionRecord(action));
  if (action.state === 'PERMIT_ISSUED') {
    throw new ConflictError('A permit was already issued for this action; permits are collected exactly once.');
  }
  if (action.state !== 'APPROVED') {
    throw new ConflictError(`This action is ${action.state}; only approved actions can collect a permit.`);
  }
  if (action.expiresAt && action.expiresAt.getTime() <= now.getTime()) {
    // Its own transaction, and it must commit: the 409 below would otherwise
    // unwind the EXPIRED transition this request is reporting.
    await scope(async (ex) => {
      const fresh = await getAction(ex, tenantId, actionId);
      if (fresh && (fresh.state === 'APPROVED' || fresh.state === 'APPROVAL_REQUIRED')) {
        await transitionAction(ex, {
          tenantId,
          actionId,
          to: 'EXPIRED',
          expectedVersion: fresh.version,
          now,
        });
      }
    });
    throw new ConflictError('The approval window has expired; submit the action again for a fresh review.');
  }
  if (!action.policyRevisionId) {
    throw new ConflictError('This action has no pinned policy revision and cannot collect a permit.');
  }

  if ((BLOCKED_MODES as readonly string[]).includes(mode)) {
    throw new ConflictError(`Mode ${mode} does not issue executable permits.`);
  }

  const dto = await withTenantTransaction(deps.db, tenantId, async (tx: DbTransaction) => {
    const stores = createDbStores(tx, { auditHmacKey: deps.auditHmacKey });
    const permits = new PermitService({
      signingKey: deps.permitSigningKey,
      signingKeyId: deps.permitSigningKeyId,
      store: stores.permits,
      clock: () => now,
    });
    const fresh = await permits.issue({
      tenantId,
      agentId: action.agentId,
      actionId,
      actionHash: action.argumentsHash,
      policyRevisionId: action.policyRevisionId ?? '',
      audienceTool: action.toolName,
      ttlSeconds: deps.permitTtlSeconds,
    });
    const moved = await transitionAction(tx, {
      tenantId,
      actionId,
      to: 'PERMIT_ISSUED',
      expectedVersion: action.version,
      now,
    });
    if (!moved.ok) throw new ConflictError(`Permit race lost: ${moved.detail}`);
    await stores.audit.append({
      tenantId,
      actionId,
      runId: action.runId,
      actorType: principal.actorType,
      actorId: principal.actorId,
      eventType: 'permit.issued',
      eventTime: now,
      traceId: action.traceId,
      policyRevisionId: action.policyRevisionId,
      payloadRedacted: { permit_id: fresh.permitId, audience: action.toolName, via: 'collected' },
    });
    return {
      permit_id: fresh.permitId,
      token: fresh.token,
      audience: action.toolName,
      action_hash: action.argumentsHash,
      policy_revision_id: action.policyRevisionId ?? '',
      issued_at: fresh.issuedAt,
      expires_at: fresh.expiresAt,
    };
  });
  // After the commit: a permit whose transaction rolled back was never issued,
  // and counting one would make the issuance rate lie.
  deps.metrics.permitsIssued.inc({ outcome: 'collected' });
  return dto;
}
