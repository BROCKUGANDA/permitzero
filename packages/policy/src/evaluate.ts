/**
 * Deterministic policy decision point.
 *
 * Decision order is structural, not priority-ordered:
 *   1. Fail-closed gates (policy store, revision binding, operating mode).
 *   2. Any matching DENY wins over everything.
 *   3. Any matching REQUIRE_APPROVAL wins over ALLOW.
 *   4. A matching ALLOW allows — unless a required model signal is missing, in
 *      which case the decision is capped to REQUIRE_APPROVAL, never ALLOW.
 *   5. No allow path but an unresolvable allow rule means INDETERMINATE.
 *   6. Otherwise the default: DENY with NO_EXPLICIT_ALLOW.
 *
 * This function never throws for a policy-level problem; it returns
 * DENY/INDETERMINATE with a reason code. Only a programming error throws.
 * It reads no clock except `input.requestedAt`, so results are deterministic
 * for a fixed input.
 */
import {
  ApprovalReason,
  DenyReason,
  EnforcementMode,
  IndeterminateReason,
  hashEquals,
} from '@permitzero/domain';
import type {
  ApprovalReason as ApprovalReasonType,
  Decision,
  DenyReason as DenyReasonType,
  EvaluatedRule,
  IndeterminateReason as IndeterminateReasonType,
  PolicyEvaluationInput,
  PolicyEvaluationResult,
  RiskSignal,
} from '@permitzero/domain';
import { RuleEffect, isSideEffectingTool } from '@permitzero/schemas';
import type { PolicyRule, RuleEffect as RuleEffectType } from '@permitzero/schemas';
import { resolveFieldMap } from './fields.js';
import { evaluateConditionGroup, ruleInScope, ruleReferencesModel } from './match.js';
import { hashPolicyDocument } from './revision.js';
import type { PinnedPolicyRevision } from './revision.js';

const DENY_REASON_SET = new Set<string>(Object.values(DenyReason));
const APPROVAL_REASON_SET = new Set<string>(Object.values(ApprovalReason));
const INDETERMINATE_REASON_SET = new Set<string>(Object.values(IndeterminateReason));

function asDenyReasons(codes: readonly string[]): DenyReasonType[] {
  return codes.filter((c): c is DenyReasonType => DENY_REASON_SET.has(c));
}

function asApprovalReasons(codes: readonly string[]): ApprovalReasonType[] {
  return codes.filter((c): c is ApprovalReasonType => APPROVAL_REASON_SET.has(c));
}

function asIndeterminateReasons(codes: readonly string[]): IndeterminateReasonType[] {
  return codes.filter((c): c is IndeterminateReasonType => INDETERMINATE_REASON_SET.has(c));
}

const EFFECT_RANK: Record<RuleEffectType, number> = {
  [RuleEffect.DENY]: 0,
  [RuleEffect.REQUIRE_APPROVAL]: 1,
  [RuleEffect.ALLOW]: 2,
};

function orderForExplanation(rules: PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => {
    const rank = (EFFECT_RANK[a.effect] ?? 3) - (EFFECT_RANK[b.effect] ?? 3);
    if (rank !== 0) return rank;
    const priority = (b.priority ?? 0) - (a.priority ?? 0);
    if (priority !== 0) return priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Display mapping only; model confidence is a claim, not a calibrated probability. */
function severityForConfidence(confidence: number): RiskSignal['severity'] {
  if (confidence >= 0.9) return 'CRITICAL';
  if (confidence >= 0.7) return 'HIGH';
  if (confidence >= 0.5) return 'MEDIUM';
  if (confidence >= 0.3) return 'LOW';
  return 'INFO';
}

function modelRiskSignals(input: PolicyEvaluationInput): RiskSignal[] {
  const hints = input.riskHints;
  if (hints === null) return [];
  return hints.instructionInjectionIndicators.map((i) => ({
    kind: i.kind,
    source: 'MODEL_ADVISORY' as const,
    severity: severityForConfidence(typeof i.confidence === 'number' ? i.confidence : 0),
    reasonCode: ApprovalReason.MODEL_RISK_SIGNAL_ESCALATION,
    evidenceRef: i.evidenceRef,
    confidence: typeof i.confidence === 'number' ? i.confidence : null,
    detail: `Model advisory: ${i.kind} reported in ${i.evidenceRef}`,
  }));
}

function buildResult(
  input: PolicyEvaluationInput,
  revision: PinnedPolicyRevision,
  decision: Decision,
  reasonCodes: readonly string[],
  opts: {
    requiredApprovals?: number;
    rulesEvaluated?: readonly EvaluatedRule[];
  } = {},
): PolicyEvaluationResult {
  return {
    decision,
    reasonCodes,
    denyReasons: asDenyReasons(reasonCodes),
    approvalReasons: asApprovalReasons(reasonCodes),
    indeterminateReasons: asIndeterminateReasons(reasonCodes),
    requiredApprovals: opts.requiredApprovals ?? 0,
    rulesEvaluated: opts.rulesEvaluated ?? [],
    riskSignals: modelRiskSignals(input),
    policyRevisionId: revision.revisionId,
    policyRevisionNumber: revision.revisionNumber,
    policyHash: revision.policyHash,
    fromCache: false,
    evaluatedAt: new Date(input.requestedAt.getTime()),
  };
}

export function evaluatePolicy(
  input: PolicyEvaluationInput,
  revision: PinnedPolicyRevision,
): PolicyEvaluationResult {
  // Gate 1: the policy store could not be read authoritatively. Nothing about
  // the action can be decided, so block without pretending a rule fired.
  if (input.policyStoreAvailable === false) {
    return buildResult(input, revision, 'INDETERMINATE', [
      IndeterminateReason.POLICY_EVALUATOR_UNAVAILABLE,
    ]);
  }

  // Gate 2: the pinned revision must be self-consistent — the right document
  // for the claimed hash, in the action's tenant.
  let computedHash: string;
  try {
    computedHash = hashPolicyDocument(revision.document);
  } catch {
    return buildResult(input, revision, 'DENY', [DenyReason.POLICY_MALFORMED]);
  }
  if (!hashEquals(computedHash, revision.policyHash)) {
    return buildResult(input, revision, 'DENY', [DenyReason.POLICY_HASH_MISMATCH]);
  }
  if (revision.tenantId !== input.tenantId) {
    return buildResult(input, revision, 'DENY', [DenyReason.TENANT_MISMATCH]);
  }

  // Gate 3: degraded operating modes block side-effecting tools. Reads proceed
  // so operators keep visibility (PRD: safe degradation preserves read-only
  // visibility). OBSERVE_ONLY and SIMULATION are enforced by the caller at the
  // broker boundary, not by the decision value.
  if (isSideEffectingTool(input.toolName)) {
    if (input.enforcementMode === EnforcementMode.EMERGENCY_STOP) {
      return buildResult(input, revision, 'DENY', [DenyReason.EMERGENCY_STOP_ACTIVE]);
    }
    if (input.enforcementMode === EnforcementMode.DEGRADED_READ_ONLY) {
      return buildResult(input, revision, 'DENY', [DenyReason.WRITE_DISABLED_DEGRADED_MODE]);
    }
    if (input.enforcementMode === EnforcementMode.QUARANTINE) {
      return buildResult(input, revision, 'DENY', [DenyReason.QUARANTINE_ACTIVE]);
    }
  }

  // Evaluate every enabled in-scope rule. Disabled and out-of-scope rules are
  // not evaluated and do not appear in `rulesEvaluated`.
  const rules = Array.isArray(revision.document.rules) ? revision.document.rules : [];
  const inScope = orderForExplanation(rules.filter((r) => r.enabled !== false && ruleInScope(r, input)));
  const fields = resolveFieldMap(input);

  const evaluated: EvaluatedRule[] = [];
  const matchedDeny: PolicyRule[] = [];
  const matchedApproval: PolicyRule[] = [];
  const matchedAllow: PolicyRule[] = [];
  let unknownAllow = false;

  for (const rule of inScope) {
    const group = evaluateConditionGroup(rule.when, fields);
    const matched = group.verdict === 'TRUE';
    // A model signal can escalate but never allow: an ALLOW rule that reads
    // any `model.*` field cannot contribute an allow, matched or not.
    const neutered = rule.effect === RuleEffect.ALLOW && ruleReferencesModel(rule.when);
    if (rule.effect === RuleEffect.ALLOW && group.verdict === 'UNKNOWN' && !neutered) {
      unknownAllow = true;
    }
    const counts = `${group.trueCount} true, ${group.falseCount} false, ${group.unknownCount} unknown`;
    evaluated.push({
      ruleId: rule.id,
      effect: rule.effect,
      matched: matched && !neutered,
      reasonCode: rule.reason_code,
      detail: neutered
        ? `matched but neutered: ALLOW rules must not read model.* fields (${counts})`
        : `${matched ? 'matched' : 'did not match'} (${counts})`,
    });
    if (matched && !neutered) {
      if (rule.effect === RuleEffect.DENY) matchedDeny.push(rule);
      else if (rule.effect === RuleEffect.REQUIRE_APPROVAL) matchedApproval.push(rule);
      else matchedAllow.push(rule);
    }
  }

  if (matchedDeny.length > 0) {
    return buildResult(
      input,
      revision,
      'DENY',
      matchedDeny.map((r) => r.reason_code),
      { rulesEvaluated: evaluated },
    );
  }

  if (matchedApproval.length > 0) {
    let quorum = 0;
    for (const r of matchedApproval) {
      const q = r.approval?.required_approvals ?? 1;
      if (q > quorum) quorum = q;
    }
    const codes = [...new Set(matchedApproval.map((r) => r.reason_code))];
    if (input.requiredModelSignalUnavailable && inScope.some((r) => ruleReferencesModel(r.when))) {
      codes.push(ApprovalReason.REQUIRED_SIGNAL_UNAVAILABLE);
    }
    return buildResult(input, revision, 'REQUIRE_APPROVAL', codes, {
      requiredApprovals: quorum,
      rulesEvaluated: evaluated,
    });
  }

  if (matchedAllow.length > 0) {
    // A missing required model signal caps a would-be allow at human review.
    if (input.requiredModelSignalUnavailable && inScope.some((r) => ruleReferencesModel(r.when))) {
      return buildResult(input, revision, 'REQUIRE_APPROVAL', [ApprovalReason.REQUIRED_SIGNAL_UNAVAILABLE], {
        requiredApprovals: 1,
        rulesEvaluated: evaluated,
      });
    }
    return buildResult(
      input,
      revision,
      'ALLOW',
      matchedAllow.map((r) => r.reason_code),
      { rulesEvaluated: evaluated },
    );
  }

  // No allow path, but an allow rule could not be fully evaluated: report the
  // gap instead of a clean deny, and never allow.
  if (unknownAllow) {
    return buildResult(input, revision, 'INDETERMINATE', [
      IndeterminateReason.AUTHORITATIVE_STATE_UNAVAILABLE,
    ], { rulesEvaluated: evaluated });
  }

  return buildResult(input, revision, 'DENY', [DenyReason.NO_EXPLICIT_ALLOW], {
    rulesEvaluated: evaluated,
  });
}
