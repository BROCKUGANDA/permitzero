/**
 * Intake pipeline: POST /v1/actions.
 *
 * Validate → authorize → pin the published policy → screen (model, advisory)
 * → evaluate → persist the decision, the permit (if any), the audit trail
 * and the outbox event in ONE transaction. Anything that fails before the
 * commit leaves no trace; anything committed is complete — there is no state
 * in which a permit exists without its audit event.
 *
 * Idempotency: the caller's key scopes to (tenant, principal). A completed
 * key replays the stored decision (without the permit token, which was
 * returned exactly once); the same key with a different payload is a 409.
 */
import {
  Decision,
  EmergencyStopActiveError,
  ForbiddenError,
  HASH_VERSION,
  NotFoundError,
  PolicyEngineUnavailableError,
  canonicalHash,
  newId,
  redact,
} from '@permitzero/domain';
import type { ActionState, Decision as DecisionType, EvidenceRef, Principal, RiskSignal } from '@permitzero/domain';
import { SUPPORTED_TOOLS, TOOL_SCHEMAS, isSideEffectingTool } from '@permitzero/schemas';
import type { CreateActionRequest, CreateActionResponse } from '@permitzero/schemas';
import { evaluatePolicy } from '@permitzero/policy';
import type { PinnedPolicyRevision } from '@permitzero/policy';
import { PermitService } from '@permitzero/broker';
import {
  completeIdempotencyRecord,
  createAction,
  createDbStores,
  createIdempotencyRecord,
  findIdempotencyRecord,
  getAction,
  getActionByIdempotency,
  getAgent,
  getEnforcementMode,
  getRevision,
  insertModelEvaluation,
  insertOutboxEvent,
  listApprovalsByAction,
  setActionDecisionExtras,
  toAgentRecord,
  transitionAction,
  withTransaction,
} from '@permitzero/db';
import type { ActionRow, ApprovalRow, Db, DbTransaction, IdempotencyRecordRow } from '@permitzero/db';
import { DomainError, ErrorCode, IdempotencyReuseError, ValidationError } from '@permitzero/domain';
import type { ModelAdapter, ModelAnalysisOutcome } from './model.js';
import { approvalRequirementsFor, evaluateQuorum } from './quorum.js';
import type { ApprovalRequirements } from './quorum.js';
import { buildPolicyInput, pinPublishedPolicy, revisionUsesModel } from './policy-input.js';
import { pgCode, zodError } from './errors.js';

export interface IntakeDeps {
  db: Db;
  model: ModelAdapter;
  permitSigningKey: string;
  permitSigningKeyId: string;
  permitTtlSeconds: number;
  auditHmacKey: string | null;
  clock?: () => Date;
}

export interface IntakeResult {
  status: 200 | 201;
  body: CreateActionResponse;
}

const REQUESTED_AT_SKEW_MS = 60_000;

/**
 * The scope verb for a tool. Almost always the segment after the last dot;
 * `vendor.update_bank_details` scopes as `update`, matching the seeded agent
 * tool scopes — keep the two in sync when tools change.
 */
function operationFor(toolName: string): string {
  if (toolName === 'vendor.update_bank_details') return 'update';
  const parts = toolName.split('.');
  return parts[parts.length - 1] ?? toolName;
}

function evidenceRefsFrom(body: CreateActionRequest): EvidenceRef[] {
  return body.evidence_refs.map((ref) => ({
    ref,
    kind: ref.split(':')[0] ?? 'unknown',
    trusted: false,
  }));
}

function requestHashFor(body: CreateActionRequest): string {
  return canonicalHash({
    tool_name: body.tool_name,
    arguments: body.arguments,
    agent_id: body.agent_id,
    run_id: body.run_id,
    task_purpose: body.task_purpose,
    environment: body.environment,
  });
}

function riskSignalDtos(signals: readonly RiskSignal[]): CreateActionResponse['risk_signals'] {
  return signals.map((s) => ({
    kind: s.kind,
    source: s.source,
    severity: s.severity,
    reason_code: s.reasonCode,
    evidence_ref: s.evidenceRef,
    confidence: s.confidence,
    detail: s.detail,
  }));
}

function principalKey(principal: Principal): string {
  return principal.actorId;
}

async function replayFromRecord(
  deps: IntakeDeps,
  tenantId: string,
  record: IdempotencyRecordRow,
  now: Date,
): Promise<IntakeResult | null> {
  if (!record.resourceId) return null;
  const action = await getAction(deps.db.db, tenantId, record.resourceId);
  if (!action || !action.decision) return null;
  return {
    status: 200,
    body: await buildResponseFromAction(deps, tenantId, action, {
      replayed: true,
      permitToken: null,
      now,
    }),
  };
}

async function replayFromAction(
  deps: IntakeDeps,
  tenantId: string,
  agentId: string,
  idempotencyKey: string,
  now: Date,
): Promise<IntakeResult | null> {
  const action = await getActionByIdempotency(deps.db.db, tenantId, agentId, idempotencyKey);
  if (!action || !action.decision) return null;
  return {
    status: 200,
    body: await buildResponseFromAction(deps, tenantId, action, {
      replayed: true,
      permitToken: null,
      now,
    }),
  };
}

export interface ResponseBuildOptions {
  replayed: boolean;
  /** Set only on first issue; replays return the permit block without a token. */
  permitToken: {
    permitId: string;
    token: string;
    issuedAt: Date;
    expiresAt: Date;
  } | null;
  now: Date;
  requirements?: ApprovalRequirements;
}

/**
 * Rebuild a response from the stored action. Used for idempotent replays and
 * for the race path where a concurrent intake won the unique key.
 */
export async function buildResponseFromAction(
  deps: IntakeDeps,
  tenantId: string,
  action: ActionRow,
  opts: ResponseBuildOptions,
): Promise<CreateActionResponse> {
  const ex = deps.db.db;
  const revision = action.policyRevisionId ? await getRevision(ex, tenantId, action.policyRevisionId) : null;
  const approvals: readonly ApprovalRow[] =
    action.decision === Decision.REQUIRE_APPROVAL ? await listApprovalsByAction(ex, tenantId, action.actionId) : [];
  const mode = await getEnforcementMode(ex, tenantId);

  let approval: CreateActionResponse['approval'] = null;
  if (action.decision === Decision.REQUIRE_APPROVAL && revision) {
    const requirements =
      opts.requirements ??
      approvalRequirementsFor(
        revision.policyJson as PinnedPolicyRevision['document'],
        action.decisionReasonCodesJson,
        action.requiredApprovals,
      );
    const progress = evaluateQuorum(requirements, approvals, action.expiresAt);
    const { satisfied: _satisfied, ...dto } = progress;
    approval = dto;
  }

  return {
    action_id: action.actionId,
    state: action.state,
    decision: action.decision ?? Decision.DENY,
    policy_revision: revision
      ? {
          id: revision.revisionId,
          revision_number: revision.revisionNumber,
          policy_hash: revision.policyHash,
        }
      : null,
    reason_codes: [...action.decisionReasonCodesJson],
    action_hash: action.argumentsHash,
    hash_version: action.hashVersion,
    permit: opts.permitToken
      ? {
          permit_id: opts.permitToken.permitId,
          token: opts.permitToken.token,
          audience: action.toolName,
          action_hash: action.argumentsHash,
          policy_revision_id: action.policyRevisionId ?? '',
          issued_at: opts.permitToken.issuedAt,
          expires_at: opts.permitToken.expiresAt,
        }
      : null,
    approval,
    risk_signals: riskSignalDtos(action.riskSignalsJson),
    trace_id: action.traceId,
    requested_at: action.requestedAt,
    expires_at: action.expiresAt,
    replayed: opts.replayed,
    enforcement_mode: mode?.mode ?? 'ENFORCED',
  };
}

export async function intakeAction(
  deps: IntakeDeps,
  principal: Principal,
  body: CreateActionRequest,
): Promise<IntakeResult> {
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;

  if (!(SUPPORTED_TOOLS as readonly string[]).includes(body.tool_name)) {
    throw new ValidationError(`Unsupported tool '${body.tool_name}'.`, { tool_name: body.tool_name });
  }
  const toolSchema = TOOL_SCHEMAS[body.tool_name as keyof typeof TOOL_SCHEMAS];
  const parsedArgs = toolSchema.safeParse(body.arguments);
  if (!parsedArgs.success) {
    throw zodError(`Invalid arguments for tool '${body.tool_name}'.`, parsedArgs.error);
  }
  const args = parsedArgs.data as Record<string, unknown>;
  const operation = operationFor(body.tool_name);

  if (principal.actorType === 'AGENT' && principal.agentId !== body.agent_id) {
    throw new ForbiddenError('Agents may only submit actions for themselves.');
  }
  const agentRow = await getAgent(deps.db.db, tenantId, body.agent_id);
  if (!agentRow) {
    throw new NotFoundError('Unknown agent for this tenant.');
  }
  const scopes = Array.isArray(agentRow.allowedToolsJson) ? agentRow.allowedToolsJson : [];
  const scopeOk = scopes.some(
    (s: { toolName?: unknown; operations?: unknown }) =>
      s.toolName === body.tool_name && Array.isArray(s.operations) && s.operations.includes(operation),
  );
  if (!scopeOk) {
    throw new ForbiddenError(`This agent is not allowed to use ${body.tool_name}.`);
  }

  const requestedAt = body.requested_at ?? now;
  if (requestedAt.getTime() > now.getTime() + REQUESTED_AT_SKEW_MS) {
    throw new ValidationError('requested_at is in the future.');
  }

  const sideEffecting = isSideEffectingTool(body.tool_name);
  const modeRow = await getEnforcementMode(deps.db.db, tenantId);
  if (sideEffecting && modeRow?.mode === 'EMERGENCY_STOP') {
    throw new EmergencyStopActiveError();
  }

  const requestHash = requestHashFor(body);
  const existing = await findIdempotencyRecord(deps.db.db, tenantId, principalKey(principal), body.idempotency_key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyReuseError(existing.resourceId ?? undefined);
    }
    if (existing.status === 'IN_PROGRESS') {
      throw new DomainError('An identical request is already being processed. Retry shortly.', {
        code: ErrorCode.CONFLICT,
        httpStatus: 409,
        retryable: true,
      });
    }
    if (existing.status === 'COMPLETED') {
      const replayed = await replayFromRecord(deps, tenantId, existing, now);
      if (replayed) return replayed;
    }
    // FAILED records fall through: same payload, a previous attempt died.
  }

  const pin = await pinPublishedPolicy(deps.db.db, tenantId);
  if (!pin.ok) {
    // No revision, no evaluation — not even an INDETERMINATE is meaningful,
    // because every decision is bound to the revision that produced it.
    throw new PolicyEngineUnavailableError(
      `No published policy is available for this tenant (${pin.detail}); failing closed.`,
    );
  }

  // Lookups first (hints null), then the advisory screen over what they found.
  const draftInput = await buildPolicyInput(deps.db.db, {
    tenantId,
    environment: body.environment,
    agent: toAgentRecord(agentRow),
    principal,
    toolName: body.tool_name,
    operation,
    taskPurpose: body.task_purpose,
    args,
    evidenceRefs: evidenceRefsFrom(body),
    requestedAt,
    runId: body.run_id,
    riskHints: null,
    requiredModelSignalUnavailable: false,
  });

  let analysis: ModelAnalysisOutcome = {
    status: 'DISABLED',
    hints: null,
    modelId: null,
    promptVersion: null,
    errorClass: null,
    latencyMs: 0,
  };
  if (deps.model.enabled) {
    const untrustedTexts =
      draftInput.invoice?.documentText != null && draftInput.invoice.invoiceId
        ? [{ ref: `invoice:${draftInput.invoice.invoiceId}`, text: draftInput.invoice.documentText }]
        : [];
    analysis = await deps.model.analyze({
      tenantId,
      actionId: null,
      toolName: body.tool_name,
      operation,
      taskPurpose: body.task_purpose,
      argumentsRedacted: redact(args) as Record<string, unknown>,
      evidenceRefs: draftInput.evidenceRefs,
      untrustedTexts,
    });
  }
  // Deliberately-disabled screening is an explicit deployment choice, not a
  // missing signal. Only a failed call from an enabled provider caps allows.
  const requiredModelSignalUnavailable = deps.model.enabled && analysis.status !== 'OK' && revisionUsesModel(pin.pin);

  const evaluation = evaluatePolicy(
    { ...draftInput, riskHints: analysis.hints, requiredModelSignalUnavailable },
    pin.pin,
  );

  const traceId = newId('trace');
  const actionId = newId('action');
  const actionHash = canonicalHash(args);
  const redactedArgs = redact(args) as Record<string, unknown>;
  const evidenceRefs = evidenceRefsFrom(body);
  const requirements =
    evaluation.decision === Decision.REQUIRE_APPROVAL
      ? approvalRequirementsFor(pin.pin.document, evaluation.reasonCodes, evaluation.requiredApprovals)
      : null;
  const decidedExpiresAt =
    evaluation.decision === Decision.REQUIRE_APPROVAL && requirements
      ? new Date(now.getTime() + requirements.ttlSeconds * 1000)
      : null;

  // A FAILED record from a dead attempt is resumed, not re-inserted: the
  // unique key stays claimed by this payload either way.
  const idemId = existing?.status === 'FAILED' ? existing.idempotencyId : newId('idempotency');
  try {
    const committed = await withTransaction(deps.db, async (tx: DbTransaction) => {
      if (!existing) {
        await createIdempotencyRecord(tx, {
          id: idemId,
          tenantId,
          principalId: principalKey(principal),
          principalType: principal.actorType === 'USER' ? 'USER' : principal.actorType === 'AGENT' ? 'AGENT' : 'WORKER',
          idempotencyKey: body.idempotency_key,
          requestHash,
          resourceType: 'action',
        });
      }

      const created = await createAction(tx, {
        actionId,
        tenantId,
        agentId: body.agent_id,
        runId: body.run_id,
        toolName: body.tool_name,
        operation,
        taskPurpose: body.task_purpose,
        argumentsRedacted: redactedArgs,
        argumentsHash: actionHash,
        hashVersion: HASH_VERSION,
        evidenceRefs,
        idempotencyKey: body.idempotency_key,
        requestedAt,
        environment: body.environment,
        traceId,
        createdByActorId: principal.actorId,
        createdByActorType: principal.actorType,
      });

      const stores = createDbStores(tx, { auditHmacKey: deps.auditHmacKey });
      await stores.audit.append({
        tenantId,
        actionId,
        runId: body.run_id,
        actorType: principal.actorType,
        actorId: principal.actorId,
        eventType: 'action.submitted',
        eventTime: now,
        traceId,
        policyRevisionId: pin.pin.revisionId,
        payloadRedacted: {
          tool_name: body.tool_name,
          operation,
          action_hash: actionHash,
        },
      });

      let moved = await transitionAction(tx, {
        tenantId,
        actionId,
        to: 'VALIDATING',
        expectedVersion: created.version,
        now,
      });
      if (!moved.ok) throw new Error(`intake transition failed: ${moved.reason}`);
      moved = await transitionAction(tx, {
        tenantId,
        actionId,
        to: 'EVALUATING',
        expectedVersion: moved.action.version,
        now,
      });
      if (!moved.ok) throw new Error(`intake transition failed: ${moved.reason}`);

      await insertModelEvaluation(tx, {
        evaluationId: newId('modelEvaluation'),
        tenantId,
        actionId,
        provider: deps.model.providerName,
        modelId: analysis.modelId ?? 'none',
        promptVersion: analysis.promptVersion ?? 'none',
        schemaVersion: 'risk-hints.v1',
        inputHash: canonicalHash({ action_hash: actionHash, untrusted_refs: evidenceRefs.map((e) => e.ref) }),
        status: analysis.status,
        latencyMs: analysis.latencyMs,
        errorClass: analysis.errorClass,
      });

      // INDETERMINATE authorizes nothing: park it in DENIED with the
      // engine's own decision and reason codes preserved for the caller.
      const terminalState: ActionState =
        evaluation.decision === Decision.DENY || evaluation.decision === Decision.INDETERMINATE
          ? 'DENIED'
          : evaluation.decision === Decision.REQUIRE_APPROVAL
            ? 'APPROVAL_REQUIRED'
            : 'ALLOWED';
      const decided = await transitionAction(tx, {
        tenantId,
        actionId,
        to: terminalState,
        expectedVersion: moved.action.version,
        now,
        patch: {
          decision: evaluation.decision as DecisionType,
          decisionReasonCodes: [...evaluation.reasonCodes],
          policyRevisionId: pin.pin.revisionId,
          ...(decidedExpiresAt ? { expiresAt: decidedExpiresAt } : {}),
        },
      });
      if (!decided.ok) throw new Error(`intake transition failed: ${decided.reason}`);

      await setActionDecisionExtras(tx, {
        tenantId,
        actionId,
        riskSignals: evaluation.riskSignals,
        requiredApprovals: requirements?.requiredApprovals ?? 0,
      });

      let issued: { permitId: string; token: string; issuedAt: Date; expiresAt: Date } | null = null;
      let finalAction = decided.action;
      if (evaluation.decision === Decision.ALLOW && sideEffecting) {
        const permits = new PermitService({
          signingKey: deps.permitSigningKey,
          signingKeyId: deps.permitSigningKeyId,
          store: stores.permits,
          clock: () => now,
        });
        const fresh = await permits.issue({
          tenantId,
          agentId: body.agent_id,
          actionId,
          actionHash,
          policyRevisionId: pin.pin.revisionId,
          audienceTool: body.tool_name,
          ttlSeconds: deps.permitTtlSeconds,
        });
        issued = { permitId: fresh.permitId, token: fresh.token, issuedAt: fresh.issuedAt, expiresAt: fresh.expiresAt };
        const permitted = await transitionAction(tx, {
          tenantId,
          actionId,
          to: 'PERMIT_ISSUED',
          expectedVersion: finalAction.version,
          now,
        });
        if (!permitted.ok) throw new Error(`intake transition failed: ${permitted.reason}`);
        finalAction = permitted.action;
        await stores.audit.append({
          tenantId,
          actionId,
          runId: body.run_id,
          actorType: principal.actorType,
          actorId: principal.actorId,
          eventType: 'permit.issued',
          eventTime: now,
          traceId,
          policyRevisionId: pin.pin.revisionId,
          payloadRedacted: { permit_id: fresh.permitId, audience: body.tool_name },
        });
      }

      await stores.audit.append({
        tenantId,
        actionId,
        runId: body.run_id,
        actorType: 'SYSTEM',
        actorId: 'system:policy-engine',
        eventType: 'action.decided',
        eventTime: now,
        traceId,
        policyRevisionId: pin.pin.revisionId,
        payloadRedacted: {
          decision: evaluation.decision,
          reason_codes: [...evaluation.reasonCodes],
          state: finalAction.state,
        },
      });

      await insertOutboxEvent(tx, {
        tenantId,
        aggregateType: 'action',
        aggregateId: actionId,
        eventType: 'action.decided',
        queueName: 'pz.outbox',
        payload: {
          action_id: actionId,
          decision: evaluation.decision,
          state: finalAction.state,
          policy_revision_id: pin.pin.revisionId,
        },
        traceId,
      });

      await completeIdempotencyRecord(tx, {
        id: idemId,
        tenantId,
        responseSnapshot: { action_id: actionId, state: finalAction.state, decision: evaluation.decision },
        httpStatus: 201,
        resourceId: actionId,
      });

      return { finalAction, issued };
    });

    const stored = await getAction(deps.db.db, tenantId, actionId);
    if (!stored) throw new Error('intake committed but the action could not be reloaded');
    return {
      status: 201,
      body: await buildResponseFromAction(deps, tenantId, stored, {
        replayed: false,
        permitToken: committed.issued,
        now,
        ...(requirements ? { requirements } : {}),
      }),
    };
  } catch (err) {
    if (pgCode(err) === '23505') {
      // Lost a race with an identical intake (or a zombie IN_PROGRESS row
      // whose owner died). Re-read outside the rolled-back transaction.
      const record = await findIdempotencyRecord(deps.db.db, tenantId, principalKey(principal), body.idempotency_key);
      if (record?.status === 'COMPLETED' && record.requestHash === requestHash) {
        const replayed = await replayFromRecord(deps, tenantId, record, now);
        if (replayed) return replayed;
      }
      if (record?.status === 'IN_PROGRESS') {
        throw new DomainError('An identical request is already being processed. Retry shortly.', {
          code: ErrorCode.CONFLICT,
          httpStatus: 409,
          retryable: true,
        });
      }
      const byAction = await replayFromAction(deps, tenantId, body.agent_id, body.idempotency_key, now);
      if (byAction) return byAction;
    }
    throw err;
  }
}
