/**
 * Read models: stored rows to API DTOs. The permit block never carries the
 * token (it is not stored and was returned exactly once at issue); approval
 * progress is recomputed from the pinned revision so reads agree with the
 * quorum that wrote them.
 */
import { Decision } from '@permitzero/domain';
import type { ActionDto } from '@permitzero/schemas';
import {
  findLatestExecutionByAction,
  findLatestPermitByAction,
  getRevision,
  listApprovalsByAction,
} from '@permitzero/db';
import type { ActionRow, DbExecutor } from '@permitzero/db';
import { approvalRequirementsFor, evaluateQuorum } from './quorum.js';

export async function toActionDto(ex: DbExecutor, tenantId: string, action: ActionRow): Promise<ActionDto> {
  const [revision, approvals, permit, execution] = await Promise.all([
    action.policyRevisionId ? getRevision(ex, tenantId, action.policyRevisionId) : Promise.resolve(null),
    action.decision === Decision.REQUIRE_APPROVAL
      ? listApprovalsByAction(ex, tenantId, action.actionId)
      : Promise.resolve([]),
    findLatestPermitByAction(ex, tenantId, action.actionId),
    findLatestExecutionByAction(ex, action.actionId, tenantId),
  ]);

  let approvalProgress: ActionDto['approval_progress'] = null;
  if (action.decision === Decision.REQUIRE_APPROVAL && revision) {
    const requirements = approvalRequirementsFor(
      revision.policyJson as Parameters<typeof approvalRequirementsFor>[0],
      action.decisionReasonCodesJson,
      action.requiredApprovals,
    );
    const { satisfied: _satisfied, ...dto } = evaluateQuorum(requirements, approvals, action.expiresAt);
    approvalProgress = dto;
  }

  return {
    action_id: action.actionId,
    tenant_id: action.tenantId,
    agent_id: action.agentId,
    run_id: action.runId,
    tool_name: action.toolName,
    operation: action.operation,
    task_purpose: action.taskPurpose,
    arguments_redacted: action.argumentsJsonRedacted,
    action_hash: action.argumentsHash,
    hash_version: action.hashVersion,
    evidence_refs: action.evidenceRefsJson.map((e) => e.ref),
    idempotency_key: action.idempotencyKey,
    state: action.state,
    decision: action.decision,
    reason_codes: [...action.decisionReasonCodesJson],
    risk_signals: action.riskSignalsJson.map((s) => ({
      kind: s.kind,
      source: s.source,
      severity: s.severity,
      reason_code: s.reasonCode,
      evidence_ref: s.evidenceRef,
      confidence: s.confidence,
      detail: s.detail,
    })),
    policy_revision_id: action.policyRevisionId,
    policy_revision_number: revision?.revisionNumber ?? null,
    required_approvals: action.requiredApprovals,
    approval_progress: approvalProgress,
    permit: permit
      ? {
          permit_id: permit.permitId,
          audience: permit.audienceTool,
          action_hash: permit.actionHash,
          policy_revision_id: permit.policyRevisionId,
          issued_at: permit.issuedAt,
          expires_at: permit.expiresAt,
        }
      : null,
    execution: execution
      ? {
          execution_id: execution.executionId,
          state: execution.state,
          attempt_number: execution.attemptNumber,
          connector_id: execution.connectorId,
          external_reference: execution.externalReference,
          receipt_hash: execution.receiptHash,
          error_class: execution.errorClass,
          dispatch_started_at: execution.dispatchStartedAt,
          result_received_at: execution.resultReceivedAt,
        }
      : null,
    trace_id: action.traceId,
    environment: action.environment,
    requested_at: action.requestedAt,
    expires_at: action.expiresAt,
    version: action.version,
    created_at: action.createdAt,
    updated_at: action.updatedAt,
  };
}
