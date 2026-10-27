/**
 * Machine reason codes translated to plain words. The code itself is still
 * shown (small, mono) so operators can quote it; the sentence is what they
 * read first. Unknown codes fall back to a humanized guess, never a blank.
 */

const LABELS: Record<string, string> = {
  // Allow
  TOOL_ALLOWED: 'This tool is permitted here.',
  SCOPE_MATCHED: 'The request fits its authorized scope.',
  VENDOR_VERIFIED: 'The vendor is verified.',
  PO_MATCHED: 'A matching purchase order backs this.',
  WITHIN_LIMIT: 'The amount is within the automatic limit.',
  CURRENCY_SUPPORTED: 'The currency is supported.',
  DESTINATION_ALLOWED: 'The destination is on the allowed list.',
  EVIDENCE_PRESENT: 'The required evidence was attached.',
  WITHIN_BUDGET: 'Spending stays within budget.',
  WITHIN_VELOCITY: 'Activity is within the normal rate.',
  WITHIN_TIME_WINDOW: 'This arrived inside the allowed window.',
  WITHIN_RUN_LIMIT: 'This run still has actions left.',
  NO_RECENT_BENEFICIARY_CHANGE: 'The payout destination has not changed recently.',
  COOLING_PERIOD_ELAPSED: 'The waiting period after the last change has passed.',
  TASK_SCOPE_MATCHED: 'The task matches the stated purpose.',
  // Approval
  AMOUNT_OVER_APPROVAL_THRESHOLD: 'The amount needs a human signature.',
  DUAL_APPROVAL_REQUIRED: 'Two independent approvals are required.',
  BENEFICIARY_CHANGE: 'The payout destination is changing.',
  VENDOR_BANKING_CHANGE: 'Vendor banking details are changing.',
  INDEPENDENT_VERIFICATION_REQUIRED: 'Someone must verify this outside the system.',
  POLICY_REQUIRES_APPROVAL: 'Policy sends this to a human.',
  MODEL_RISK_SIGNAL_ESCALATION: 'Screening flagged something for a human to check.',
  REQUIRED_SIGNAL_UNAVAILABLE: 'A required safety check could not run, so a human must decide.',
  EVIDENCE_NEEDS_HUMAN_REVIEW: 'The evidence needs human eyes.',
  // Indeterminate
  POLICY_EVALUATOR_UNAVAILABLE: 'The decision engine could not be reached.',
  AUTHORITATIVE_STATE_UNAVAILABLE: 'Records needed for the decision were unreachable.',
  AMBIGUOUS_CURRENCY: 'The currency could not be determined.',
  CONFLICTING_RULES: 'The rules contradict each other on this request.',
  REQUIRED_MODEL_SIGNAL_UNAVAILABLE: 'A required screening result is missing.',
  STALE_AUTHORITATIVE_DATA: 'The records are too old to trust.',
  // Deny: identity and scope
  UNAUTHENTICATED: 'The caller could not be identified.',
  TENANT_MISMATCH: 'The credential belongs to a different tenant.',
  AGENT_REVOKED: 'This agent has been revoked.',
  AGENT_SUSPENDED: 'This agent is suspended.',
  AGENT_UNKNOWN: 'No such agent exists here.',
  AGENT_ENVIRONMENT_MISMATCH: 'The agent may not act in this environment.',
  CREDENTIAL_EXPIRED: 'The credential has expired.',
  CREDENTIAL_REVOKED: 'The credential was revoked.',
  ROLE_NOT_PERMITTED: 'This role may not do that.',
  TOOL_NOT_ALLOWED: 'This tool is not allowed for the caller.',
  TOOL_UNKNOWN: 'No such tool exists.',
  OPERATION_NOT_ALLOWED: 'This operation is not allowed.',
  RESOURCE_OUT_OF_SCOPE: 'The target is outside the authorized scope.',
  CONNECTOR_DISABLED: 'The connector is switched off.',
  CONNECTOR_UNKNOWN: 'No connector serves this tool.',
  CONNECTOR_QUARANTINED: 'The connector is quarantined.',
  // Deny: validation
  SCHEMA_INVALID: 'The request shape is invalid.',
  PAYLOAD_TOO_LARGE: 'The request is too large.',
  NON_CANONICAL_INPUT: 'The request could not be normalized safely.',
  INVALID_AMOUNT: 'The amount is invalid.',
  INVALID_CURRENCY: 'The currency code is invalid.',
  CURRENCY_UNSUPPORTED: 'That currency is not supported.',
  CURRENCY_MISMATCH: 'The currencies do not line up.',
  MALFORMED_IDENTIFIER: 'An identifier is malformed.',
  MISSING_REQUIRED_FIELD: 'A required field is missing.',
  // Deny: policy availability
  POLICY_MISSING: 'No policy is in force.',
  POLICY_MALFORMED: 'The policy document is invalid.',
  POLICY_REVISION_INCONSISTENT: 'The policy revision is internally inconsistent.',
  POLICY_HASH_MISMATCH: 'The policy content does not match its seal.',
  POLICY_STORE_UNAVAILABLE: 'Policy records could not be read.',
  POLICY_CONFLICT: 'Policies disagree; nothing proceeds.',
  NO_EXPLICIT_ALLOW: 'Nothing explicitly allows this.',
  DEFAULT_DENY: 'Denied by default: nothing allowed it.',
  // Deny: financial controls
  AMOUNT_OVER_LIMIT: 'The amount exceeds the hard limit.',
  AMOUNT_NON_POSITIVE: 'The amount must be positive.',
  VENDOR_NOT_VERIFIED: 'The vendor is not verified yet.',
  VENDOR_BLOCKED: 'This vendor is blocked.',
  VENDOR_UNKNOWN: 'No such vendor exists here.',
  DESTINATION_MISMATCH: 'The destination does not match the verified one.',
  DESTINATION_NOT_ALLOWED: 'That destination is not allowed.',
  BENEFICIARY_CHANGE_WITHIN_COOLING_PERIOD: 'The destination changed too recently to pay into.',
  BENEFICIARY_CHANGE_UNVERIFIED: 'The new destination has not been verified.',
  PO_NOT_MATCHED: 'No purchase order matches this.',
  PO_MISSING: 'A purchase order is required but missing.',
  PO_AMOUNT_MISMATCH: 'The amount differs from the purchase order.',
  BUDGET_CAP_EXCEEDED: 'This would break the budget cap.',
  VELOCITY_LIMIT_EXCEEDED: 'Too many actions too quickly.',
  RUN_ACTION_LIMIT_EXCEEDED: 'This run has used all its actions.',
  OUTSIDE_TIME_WINDOW: 'This arrived outside the allowed window.',
  EVIDENCE_MISSING: 'Required evidence is missing.',
  EVIDENCE_INSUFFICIENT: 'The evidence does not cover this.',
  DATA_CLASSIFICATION_BLOCKED: 'The data classification forbids this.',
  TASK_SCOPE_MISMATCH: 'The task does not match its stated purpose.',
  // Deny: permits and approvals
  PERMIT_MISSING: 'No valid permit was presented.',
  PERMIT_EXPIRED: 'The permit has expired.',
  PERMIT_CONSUMED: 'The permit was already used.',
  PERMIT_REVOKED: 'The permit was revoked.',
  PERMIT_SIGNATURE_INVALID: 'The permit signature is invalid.',
  PERMIT_AUDIENCE_MISMATCH: 'The permit is for a different tool.',
  PERMIT_TENANT_MISMATCH: 'The permit belongs to a different tenant.',
  PERMIT_NONCE_MISMATCH: 'The permit does not match its record.',
  PERMIT_ACTION_MISMATCH: 'The permit is for a different action.',
  PERMIT_HASH_MISMATCH: 'The action changed after the permit was issued.',
  PERMIT_POLICY_REVISION_MISMATCH: 'The policy changed after the permit was issued.',
  APPROVAL_MISSING: 'A required approval is missing.',
  APPROVAL_EXPIRED: 'The approval window has closed.',
  APPROVAL_REVOKED: 'The approval was revoked.',
  APPROVAL_HASH_MISMATCH: 'The action changed after it was reviewed.',
  APPROVAL_POLICY_REVISION_MISMATCH: 'The policy changed after the review.',
  APPROVAL_QUORUM_NOT_MET: 'Not enough approvals yet.',
  SELF_APPROVAL_FORBIDDEN: 'Nobody may approve their own action.',
  DUPLICATE_APPROVER: 'Each approver may decide only once.',
  APPROVER_NOT_ELIGIBLE: 'This account may not approve.',
  IDEMPOTENCY_KEY_REUSE: 'That reference was already used for something else.',
  EXECUTION_STATE_CONFLICT: 'The action is not in a state that allows this.',
  // Deny: operating mode
  ENFORCEMENT_UNAVAILABLE: 'Enforcement is unavailable, so nothing proceeds.',
  EMERGENCY_STOP_ACTIVE: 'An emergency stop is in force.',
  WRITE_DISABLED_DEGRADED_MODE: 'Writes are paused while degraded.',
  QUARANTINE_ACTIVE: 'A quarantine is in force.',
  AUDIT_WRITE_FAILED: 'The audit trail could not be written, so nothing proceeds.',
  RATE_LIMITED: 'Too many requests; slow down and retry.',
  // Risk signals
  INSTRUCTION_INJECTION: 'The text tries to override its own instructions.',
  REQUEST_TO_BYPASS_CONTROLS: 'The text asks to bypass controls.',
  BENEFICIARY_CHANGE_REQUEST: 'The text requests a destination change.',
  DATA_EXFILTRATION_ATTEMPT: 'The text looks like a data-theft attempt.',
  SCOPE_ESCALATION: 'The text reaches beyond its scope.',
  UNTRUSTED_INSTRUCTION_IN_EVIDENCE: 'Evidence contains untrusted instructions.',
  ANOMALOUS_AMOUNT: 'The amount looks unusual.',
  EXTRACTED_FACT_MISMATCH: 'Stated facts disagree with the records.',
};

export type ReasonTone = 'allow' | 'review' | 'deny' | 'unknown';

const REVIEW_CODES = new Set([
  'AMOUNT_OVER_APPROVAL_THRESHOLD',
  'DUAL_APPROVAL_REQUIRED',
  'BENEFICIARY_CHANGE',
  'VENDOR_BANKING_CHANGE',
  'INDEPENDENT_VERIFICATION_REQUIRED',
  'POLICY_REQUIRES_APPROVAL',
  'MODEL_RISK_SIGNAL_ESCALATION',
  'REQUIRED_SIGNAL_UNAVAILABLE',
  'EVIDENCE_NEEDS_HUMAN_REVIEW',
  'POLICY_EVALUATOR_UNAVAILABLE',
  'AUTHORITATIVE_STATE_UNAVAILABLE',
  'AMBIGUOUS_CURRENCY',
  'CONFLICTING_RULES',
  'REQUIRED_MODEL_SIGNAL_UNAVAILABLE',
  'STALE_AUTHORITATIVE_DATA',
]);

const ALLOW_CODES = new Set([
  'TOOL_ALLOWED',
  'SCOPE_MATCHED',
  'VENDOR_VERIFIED',
  'PO_MATCHED',
  'WITHIN_LIMIT',
  'CURRENCY_SUPPORTED',
  'DESTINATION_ALLOWED',
  'EVIDENCE_PRESENT',
  'WITHIN_BUDGET',
  'WITHIN_VELOCITY',
  'WITHIN_TIME_WINDOW',
  'WITHIN_RUN_LIMIT',
  'NO_RECENT_BENEFICIARY_CHANGE',
  'COOLING_PERIOD_ELAPSED',
  'TASK_SCOPE_MATCHED',
]);

export function reasonLabel(code: string): string {
  const known = LABELS[code];
  if (known) return known;
  return code
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function reasonTone(code: string): ReasonTone {
  if (ALLOW_CODES.has(code)) return 'allow';
  if (REVIEW_CODES.has(code)) return 'review';
  if (code in LABELS) return 'deny';
  return 'unknown';
}
