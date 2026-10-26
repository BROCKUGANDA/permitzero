/**
 * Execute pipeline: POST /v1/actions/:id/execute.
 *
 * The permit token in the body is the authorization; the bearer token only
 * proves which tenant the caller belongs to. Before touching the broker the
 * route re-checks the operating mode (it may have changed since intake) and
 * the caller's right to spend this action's permit. Broker outcomes map to
 * HTTP honestly: only a verified connector receipt is a success, an unknown
 * outcome is a 409 that names the execution to reconcile, and a permit from
 * another tenant is a 404, never a 403.
 */
import {
  ConflictError,
  DenyReason,
  DomainError,
  EmergencyStopActiveError,
  ErrorCode,
  NotFoundError,
  PermitInvalidError,
  UnknownOutcomeError,
} from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import type { ExecuteActionRequest, ExecuteActionResponse } from '@permitzero/schemas';
import { executeActionResponseSchema } from '@permitzero/schemas';
import { Broker } from '@permitzero/broker';
import {
  findConnectorForTool,
  getAction,
  getEnforcementMode,
  insertOutboxEvent,
  toActionRecord,
} from '@permitzero/db';
import type { Db } from '@permitzero/db';
import { requireExecute } from './auth.js';

export interface ExecuteDeps {
  db: Db;
  broker: Broker;
  clock?: () => Date;
}

const BLOCKED_MODES = ['EMERGENCY_STOP', 'DEGRADED_READ_ONLY', 'QUARANTINE'] as const;

export async function executeApprovedAction(
  deps: ExecuteDeps,
  principal: Principal,
  actionId: string,
  body: ExecuteActionRequest,
): Promise<ExecuteActionResponse> {
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;

  const action = await getAction(deps.db.db, tenantId, actionId);
  if (!action) throw new NotFoundError();
  requireExecute(principal, toActionRecord(action));
  if (action.state !== 'PERMIT_ISSUED') {
    throw new ConflictError(
      `This action is ${action.state}; only actions with a live permit can execute.`,
    );
  }

  const mode = (await getEnforcementMode(deps.db.db, tenantId))?.mode ?? 'ENFORCED';
  if ((BLOCKED_MODES as readonly string[]).includes(mode)) {
    if (mode === 'EMERGENCY_STOP') throw new EmergencyStopActiveError();
    throw new ConflictError(`Mode ${mode} does not dispatch side effects.`);
  }
  if (mode === 'SIMULATION') {
    const connector = await findConnectorForTool(deps.db.db, tenantId, action.toolName);
    if (!connector?.simulated) {
      throw new ConflictError('Simulation mode only dispatches to simulated connectors.');
    }
  }

  const result = await deps.broker.execute({
    tenantId,
    actionId,
    permitToken: body.permit_token,
    actorId: principal.actorId,
    traceId: action.traceId,
    ...(body.client_timeout_ms !== undefined ? { deadlineMs: now.getTime() + body.client_timeout_ms } : {}),
  });

  switch (result.outcome) {
    case 'SUCCEEDED': {
      const reloaded = await getAction(deps.db.db, tenantId, actionId);
      return executeActionResponseSchema.parse({
        action_id: actionId,
        execution_id: result.execution.executionId,
        state: reloaded?.state ?? 'SUCCEEDED',
        accepted: true,
        receipt: {
          external_reference: result.receipt.externalReference,
          receipt_hash: result.receipt.receiptHash,
          amount_minor: result.receipt.amountMinor,
          currency: result.receipt.currency,
          beneficiary_ref: result.receipt.beneficiaryRef,
          completed_at: result.receipt.completedAt,
          simulated: result.receipt.simulated,
        },
        trace_id: action.traceId,
      });
    }
    case 'UNKNOWN_OUTCOME': {
      // Nudge the reconciler now; the worker's periodic sweep is the backstop
      // if this insert fails, so a failure here must not mask the 409.
      try {
        await insertOutboxEvent(deps.db.db, {
          tenantId,
          aggregateType: 'execution',
          aggregateId: result.execution.executionId,
          eventType: 'execution.unknown_outcome',
          queueName: 'pz.reconciliation',
          payload: { action_id: actionId, execution_id: result.execution.executionId },
          traceId: action.traceId,
        });
      } catch (err) {
        console.error(
          `unknown-outcome nudge lost for execution ${result.execution.executionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw new UnknownOutcomeError(actionId, result.execution.executionId);
    }
    case 'FAILED_RETRYABLE':
      throw new DomainError('The connector failed transiently; reconcile, then retry with a fresh evaluation.', {
        code: ErrorCode.CONNECTOR_ERROR,
        httpStatus: 502,
        retryable: true,
        details: {
          action_id: actionId,
          execution_id: result.execution.executionId,
          error_class: result.errorClass,
        },
      });
    case 'FAILED_TERMINAL':
      throw new DomainError('The connector refused this action; it will not succeed on retry.', {
        code: ErrorCode.CONNECTOR_ERROR,
        httpStatus: 422,
        retryable: false,
        details: {
          action_id: actionId,
          execution_id: result.execution.executionId,
          error_class: result.errorClass,
        },
      });
    case 'REJECTED':
      if (result.reason === DenyReason.PERMIT_TENANT_MISMATCH) {
        // A genuine permit from another tenant: 404, never 403 (FR-7.5).
        throw new NotFoundError();
      }
      throw new PermitInvalidError(result.detail, { deny_reason: result.reason });
  }
}
