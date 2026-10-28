/**
 * Approval quorum math. The evaluation result carries only the required
 * count, so the full requirements (independent verification, MFA, TTL) are
 * re-derived from the pinned revision's matched REQUIRE_APPROVAL rules,
 * identified by the persisted decision reason codes. When several rules
 * match, the strictest union wins — fail-closed by construction.
 *
 * Independent verification is evidenced by an approval whose reason code is
 * VENDOR_VERIFIED_OUT_OF_BAND: a human asserting they checked the destination
 * outside this system. There is deliberately no lighter-weight way to set it.
 *
 * Two conditions are checked here rather than at the point of decision, so a
 * quorum can never be closed by something the decision path should have
 * refused:
 *
 *  - The requester's own approval never counts. Distinctness was enforced —
 *    the storage layer allows one decision per approver per action — but
 *    distinctness is not independence: a requester who holds an approver role
 *    could otherwise be the sole approver of their own payment, and the
 *    four-eyes property the compliance evidence claims would be a claim about
 *    nothing.
 *  - MFA counts only when the stored assertion verifies. The stored value is
 *    a server-signed step-up assertion, so "not null" is no longer the test:
 *    an unverifiable reference satisfies nothing.
 */
import type { ApprovalProgress } from '@permitzero/schemas';
import type { PolicyDocument } from '@permitzero/schemas';
import type { ApprovalRow } from '@permitzero/db';
import { verifyMfaAssertion } from '@permitzero/policy';

export const INDEPENDENT_VERIFICATION_REASON = 'VENDOR_VERIFIED_OUT_OF_BAND';
export const DEFAULT_APPROVAL_TTL_SECONDS = 900;

export interface ApprovalRequirements {
  requiredApprovals: number;
  requireDistinctApprovers: boolean;
  requireIndependentVerification: boolean;
  requireMfa: boolean;
  ttlSeconds: number;
}

export function approvalRequirementsFor(
  document: PolicyDocument,
  reasonCodes: readonly string[],
  fallbackCount: number,
): ApprovalRequirements {
  const matched = document.rules.filter(
    (r) => r.enabled !== false && r.effect === 'REQUIRE_APPROVAL' && reasonCodes.includes(r.reason_code),
  );
  if (matched.length === 0) {
    return {
      requiredApprovals: Math.max(1, fallbackCount),
      requireDistinctApprovers: true,
      requireIndependentVerification: false,
      requireMfa: false,
      ttlSeconds: DEFAULT_APPROVAL_TTL_SECONDS,
    };
  }
  return {
    requiredApprovals: Math.max(1, fallbackCount, ...matched.map((r) => r.approval?.required_approvals ?? 1)),
    requireDistinctApprovers: matched.some((r) => r.approval?.require_distinct_approvers ?? true),
    requireIndependentVerification: matched.some((r) => r.approval?.require_independent_verification ?? false),
    requireMfa: matched.some((r) => r.approval?.require_mfa ?? false),
    ttlSeconds: Math.min(...matched.map((r) => r.approval?.ttl_seconds ?? DEFAULT_APPROVAL_TTL_SECONDS)),
  };
}

export interface QuorumProgress extends ApprovalProgress {
  satisfied: boolean;
}

export interface QuorumOptions {
  /**
   * The actor that submitted the action. Their approval is never counted, so
   * a quorum cannot be closed by the party the control exists to keep out of
   * it.
   */
  requesterActorId?: string | null;
  /**
   * The server key that signs MFA step-up assertions. Without a key no
   * assertion can be verified, so a policy that requires MFA is not satisfied:
   * the fail-closed direction, and the only honest one when there is no key to
   * verify with.
   */
  mfaKey?: Buffer | null;
}

/**
 * True when this approval carries a step-up assertion that verifies for this
 * approver, this action and this tenant.
 *
 * The assertion is judged against the moment the approval was recorded, not
 * against the moment the quorum is read: an approval that was validly made
 * stays valid, however long ago it was made. What must not happen is an
 * approval counting because a reference was present.
 */
function mfaVerified(approval: ApprovalRow, key: Buffer | null | undefined): boolean {
  if (!approval.mfaContextRef) return false;
  if (!key) return false;
  const verdict = verifyMfaAssertion(approval.mfaContextRef, key, {
    tenantId: approval.tenantId,
    actorId: approval.approverUserId,
    actionId: approval.actionId,
    now: approval.approvedAt,
  });
  return verdict.ok;
}

/** Quorum over APPROVE decisions; storage already enforces one row per approver. */
export function evaluateQuorum(
  requirements: ApprovalRequirements,
  approvals: readonly ApprovalRow[],
  expiresAt: Date | null,
  opts: QuorumOptions = {},
): QuorumProgress {
  const requester = opts.requesterActorId ?? null;
  const approves = approvals.filter(
    (a) => a.decision === 'APPROVE' && !(requester !== null && a.approverUserId === requester),
  );
  const distinct = new Set(approves.map((a) => a.approverUserId));
  const independentVerificationPresent = approves.some((a) => a.reasonCode === INDEPENDENT_VERIFICATION_REASON);
  const mfaSatisfied =
    !requirements.requireMfa || (approves.length > 0 && approves.every((a) => mfaVerified(a, opts.mfaKey)));
  const satisfied =
    distinct.size >= requirements.requiredApprovals &&
    (!requirements.requireIndependentVerification || independentVerificationPresent) &&
    mfaSatisfied;
  return {
    required_approvals: requirements.requiredApprovals,
    approvals_received: approves.length,
    distinct_approvers: distinct.size,
    requires_independent_verification: requirements.requireIndependentVerification,
    independent_verification_present: independentVerificationPresent,
    requires_mfa: requirements.requireMfa,
    expires_at: expiresAt,
    invalidated: false,
    invalidation_reason: null,
    satisfied,
  };
}
