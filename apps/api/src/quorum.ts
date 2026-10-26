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
 */
import type { ApprovalProgress } from '@permitzero/schemas';
import type { PolicyDocument } from '@permitzero/schemas';
import type { ApprovalRow } from '@permitzero/db';

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

/** Quorum over APPROVE decisions; storage already enforces one row per approver. */
export function evaluateQuorum(
  requirements: ApprovalRequirements,
  approvals: readonly ApprovalRow[],
  expiresAt: Date | null,
): QuorumProgress {
  const approves = approvals.filter((a) => a.decision === 'APPROVE');
  const distinct = new Set(approves.map((a) => a.approverUserId));
  const independentVerificationPresent = approves.some((a) => a.reasonCode === INDEPENDENT_VERIFICATION_REASON);
  const mfaSatisfied = !requirements.requireMfa || approves.every((a) => a.mfaContextRef !== null);
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
