/**
 * Approval pipeline: POST /v1/actions/:id/approve and .../reject.
 *
 * An approval is a human decision bound to the exact action hash and policy
 * revision the approver reviewed. Any drift — arguments changed, policy
 * republished — invalidates the review instead of silently approving the new
 * shape (FR-041). The first REJECT vetoes; APPROVEs accumulate toward the
 * quorum derived from the pinned revision. The deciding approval moves to
 * APPROVED and stops there — the permit is collected by the spending party
 * afterwards (see permits.ts), so the token never passes through the human.
 *
 * Row-level security means a decided request is three tenant transactions: read
 * the action and the revision it pinned, write the decision, read the action
 * back for the response. They stay separate because the response must describe
 * the committed state rather than the write transaction's own uncommitted rows,
 * and because the expiry path — a fourth transaction, on the rare branch that
 * takes it — writes and then fails: inside the read transaction, the 409 would
 * roll back the EXPIRED transition it just made.
 */
import {
  ApprovalInvalidatedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  hashEquals,
  newId,
  redact,
} from '@permitzero/domain';
import type { Principal } from '@permitzero/domain';
import type { ActionDto, ApproveActionRequest, RejectActionRequest } from '@permitzero/schemas';
import { deriveMfaAssertionKey, verifyMfaAssertion } from '@permitzero/policy';
import {
  createApproval,
  createDbStores,
  getAction,
  getRevision,
  insertOutboxEvent,
  listApprovalsByAction,
  tenantScope,
  transitionAction,
  withTenantTransaction,
} from '@permitzero/db';
import type { Db, DbTransaction } from '@permitzero/db';
import type { MetricsBundle } from '@permitzero/observability';
import { requireApprover } from './auth.js';
import { approvalRequirementsFor, evaluateQuorum } from './quorum.js';
import { toActionDto } from './dto.js';
import { pgCode } from './errors.js';

export interface ApprovalDeps {
  db: Db;
  auditHmacKey: string | null;
  clock?: () => Date;
  /** Prometheus series; recorded here so the decision itself, not just the HTTP envelope, is observable. */
  metrics: MetricsBundle;
}

export type ApprovalBody = ApproveActionRequest | RejectActionRequest;

function isApprove(body: ApprovalBody): body is ApproveActionRequest {
  return body.decision === 'APPROVE';
}

/**
 * The key that signs MFA step-up assertions.
 *
 * The API has exactly one server-side HMAC secret today (`AUDIT_HMAC_KEY`) and
 * `config.ts` is outside this change, so the assertion key is *derived* from it
 * with domain separation rather than reusing the raw secret: forging an audit
 * chain entry and forging a step-up assertion stay different capabilities.
 *
 * No secret means no assertion can be verified. That is the fail-closed
 * direction: a policy that requires MFA cannot be approved, rather than being
 * approved on the strength of a string the caller typed.
 */
function mfaAssertionKey(deps: ApprovalDeps): Buffer | null {
  if (!deps.auditHmacKey) return null;
  return deriveMfaAssertionKey(deps.auditHmacKey);
}

export async function decideApproval(
  deps: ApprovalDeps,
  principal: Principal,
  actionId: string,
  body: ApprovalBody,
): Promise<ActionDto> {
  requireApprover(principal);
  const now = deps.clock?.() ?? new Date();
  const tenantId = principal.tenantId;
  const scope = tenantScope(deps.db, tenantId);
  // Derived once: the decision verifies the assertion against it and the
  // quorum re-verifies the stored one against it.
  const mfaKey = mfaAssertionKey(deps);

  const { action, revision } = await scope(async (ex) => {
    const found = await getAction(ex, tenantId, actionId);
    if (!found) throw new NotFoundError();
    return {
      action: found,
      revision: found.policyRevisionId ? await getRevision(ex, tenantId, found.policyRevisionId) : null,
    };
  });

  if (action.state !== 'APPROVAL_REQUIRED') {
    throw new ConflictError(`This action is ${action.state}; only actions awaiting approval can be decided.`);
  }
  if (action.expiresAt && action.expiresAt.getTime() <= now.getTime()) {
    // The window lapsed. Re-read so a concurrent decision is reported
    // truthfully instead of as an expiry. Its own transaction, and it has to
    // commit: the request still fails with a 409 below, and a transaction
    // unwound by that error would undo the EXPIRED transition.
    const fresh = await scope(async (ex) => {
      const current = await getAction(ex, tenantId, actionId);
      if (current && current.state === 'APPROVAL_REQUIRED') {
        await transitionAction(ex, {
          tenantId,
          actionId,
          to: 'EXPIRED',
          expectedVersion: current.version,
          now,
        });
      }
      return current;
    });
    if (!fresh || fresh.state === 'APPROVAL_REQUIRED' || fresh.state === 'EXPIRED') {
      throw new ConflictError('The approval window has expired; submit the action again for a fresh review.');
    }
    throw new ConflictError(`This action is ${fresh.state}; only actions awaiting approval can be decided.`);
  }
  if (!action.policyRevisionId) {
    throw new ConflictError('This action has no pinned policy revision and cannot be approved.');
  }
  if (!revision) throw new NotFoundError('The pinned policy revision is no longer readable.');
  const requirements = approvalRequirementsFor(
    revision.policyJson as Parameters<typeof approvalRequirementsFor>[0],
    action.decisionReasonCodesJson,
    action.requiredApprovals,
  );

  if (isApprove(body)) {
    // Four eyes. The requester of an action may not be the approver of it.
    //
    // Distinctness was already enforced — one decision per approver per
    // action — but distinctness is not independence. A user who holds an
    // approver role could submit an action and then be its only approver,
    // which satisfies a quorum of one and leaves the separation of duties
    // this file exists to provide as a claim about nothing. The check lives
    // on the decision rather than at submission, because the requester is
    // not the only way an action comes to exist, and the control that
    // matters is the one that stops the approval.
    //
    // A REJECT is not blocked: it can only withhold an approval, never grant
    // one, and it is the requester's way to withdraw a request they made by
    // mistake. The four-eyes property is about the grant.
    if (action.createdByActorId === principal.actorId) {
      throw new ForbiddenError('You cannot approve an action you requested.');
    }
    if (!hashEquals(body.action_hash, action.argumentsHash)) {
      throw new ApprovalInvalidatedError('the action changed after it was reviewed');
    }
    if (body.policy_revision_id !== action.policyRevisionId) {
      throw new ApprovalInvalidatedError('the policy changed after it was reviewed');
    }
    // Step-up authentication, if one is claimed at all.
    //
    // `mfa_context_ref` used to be a free-form client string and the only
    // test was that it was present, so any character satisfied a policy's
    // `require_mfa`. It is now a server-issued, signed assertion: the server
    // verifies the signature, the expiry and the subject (this tenant, this
    // principal, this action) before the approval counts. An unverifiable
    // reference is refused whether or not the policy asked for one, because a
    // caller who presents a step-up proof that does not hold has presented
    // nothing.
    if (body.mfa_context_ref !== undefined) {
      const verdict = mfaKey
        ? verifyMfaAssertion(body.mfa_context_ref, mfaKey, {
            tenantId,
            actorId: principal.actorId,
            actionId,
            now,
          })
        : null;
      if (!verdict || !verdict.ok) {
        throw new ValidationError('The step-up assertion presented with this approval could not be verified.', {
          reason: verdict ? verdict.reason : 'NO_SERVER_KEY',
        });
      }
    } else if (requirements.requireMfa) {
      throw new ValidationError('This approval requires a verified step-up authentication assertion.');
    }
  }

  try {
    await withTenantTransaction(deps.db, tenantId, async (tx: DbTransaction) => {
      const stores = createDbStores(tx, { auditHmacKey: deps.auditHmacKey });
      await createApproval(tx, {
        approvalId: newId('approval'),
        tenantId,
        actionId,
        actionHash: action.argumentsHash,
        policyRevisionId: action.policyRevisionId ?? '',
        approverUserId: principal.actorId,
        decision: body.decision,
        reasonCode: body.reason_code,
        reasonTextRedacted: body.reason_text ? String(redact(body.reason_text)) : null,
        // Stored only after the assertion verified above: the quorum re-checks
        // it, so a row can never claim MFA it did not perform.
        mfaContextRef: isApprove(body) ? (body.mfa_context_ref ?? null) : null,
      });

      if (!isApprove(body)) {
        const rejected = await transitionAction(tx, {
          tenantId,
          actionId,
          to: 'REJECTED',
          expectedVersion: action.version,
          now,
        });
        if (!rejected.ok) throw new ConflictError(`Approval race lost: ${rejected.detail}`);
        await stores.audit.append({
          tenantId,
          actionId,
          runId: action.runId,
          actorType: principal.actorType,
          actorId: principal.actorId,
          eventType: 'action.rejected',
          eventTime: now,
          traceId: action.traceId,
          policyRevisionId: action.policyRevisionId,
          payloadRedacted: { reason_code: body.reason_code },
        });
        await insertOutboxEvent(tx, {
          tenantId,
          aggregateType: 'action',
          aggregateId: actionId,
          eventType: 'action.rejected',
          queueName: 'pz.outbox',
          payload: { action_id: actionId, reason_code: body.reason_code },
          traceId: action.traceId,
        });
        return;
      }

      const approvals = await listApprovalsByAction(tx, tenantId, actionId);
      if (approvals.some((a) => a.decision === 'REJECT')) {
        throw new ConflictError('This action was already rejected.');
      }
      const progress = evaluateQuorum(requirements, approvals, action.expiresAt, {
        // The requester's own approval never counts, whatever the decision
        // path did or did not catch.
        requesterActorId: action.createdByActorId,
        mfaKey,
      });

      await stores.audit.append({
        tenantId,
        actionId,
        runId: action.runId,
        actorType: principal.actorType,
        actorId: principal.actorId,
        eventType: 'action.approval_recorded',
        eventTime: now,
        traceId: action.traceId,
        policyRevisionId: action.policyRevisionId,
        payloadRedacted: {
          reason_code: body.reason_code,
          distinct_approvers: progress.distinct_approvers,
          required_approvals: progress.required_approvals,
          quorum_satisfied: progress.satisfied,
        },
      });

      if (!progress.satisfied) return;

      // Quorum moves to APPROVED and stops: the permit is collected by the
      // agent separately (permits.ts), so the token reaches the party that
      // will spend it instead of the human who approved it.
      const approved = await transitionAction(tx, {
        tenantId,
        actionId,
        to: 'APPROVED',
        expectedVersion: action.version,
        now,
      });
      if (!approved.ok) throw new ConflictError(`Approval race lost: ${approved.detail}`);
      void approved;

      await insertOutboxEvent(tx, {
        tenantId,
        aggregateType: 'action',
        aggregateId: actionId,
        eventType: 'action.approved',
        queueName: 'pz.outbox',
        payload: {
          action_id: actionId,
          distinct_approvers: progress.distinct_approvers,
          independent_verification_present: progress.independent_verification_present,
        },
        traceId: action.traceId,
      });
    });
  } catch (err) {
    if (pgCode(err) === '23505') {
      throw new ConflictError('This approver has already decided this action.');
    }
    throw err;
  }

  return scope(async (ex) => {
    const reloaded = await getAction(ex, tenantId, actionId);
    if (!reloaded) throw new NotFoundError();
    // Counted from the committed row rather than from the transaction's own
    // bookkeeping: if this reload says APPROVED, the quorum really closed, and a
    // rollback that threw before reaching here never increments.
    deps.metrics.approvalDecisions.inc({
      decision: body.decision,
      quorum_complete: String(reloaded.state === 'APPROVED'),
    });
    return toActionDto(ex, tenantId, reloaded);
  });
}
