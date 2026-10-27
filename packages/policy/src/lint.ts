/**
 * Policy linter for Policy Studio: catch the mistakes that make a policy
 * silently too broad or silently too strict, before publish.
 *
 * Every check is syntactic and documented as such — in particular,
 * OVERLAPPING_ALLOW_DENY only fires on textually identical scope+condition
 * pairs, which is an under-approximation of true overlap. The Replay Lab, not
 * the linter, proves what a policy does.
 */
import { canonicalize } from '@permitzero/domain';
import { PolicyLintCode, PolicyLintSeverity, SIDE_EFFECTING_TOOLS, SUPPORTED_TOOLS } from '@permitzero/schemas';
import type { Condition, PolicyDocument, PolicyLintFinding, PolicyRule } from '@permitzero/schemas';
import { eachCondition, ruleReferencesModel } from './match.js';

const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOLS);
const SIDE_EFFECTING_SET = new Set<string>(SIDE_EFFECTING_TOOLS);

const AMOUNT_FIELDS = new Set(['arguments.amount_minor', 'budget.spend_minor', 'arguments.record_count']);
const COMPARISON_OPS = new Set(['less_than', 'less_than_or_equal', 'greater_than', 'greater_than_or_equal']);
// A minor-units threshold below this almost certainly meant major units
// ($1.00 = 100 minor). Heuristic, advisory, documented in the message.
const MINOR_UNIT_SUSPECT_BELOW = 100;

function scopeKeyCount(rule: PolicyRule): number {
  const scope = rule.scope ?? {};
  let n = 0;
  if (scope.tools !== undefined && scope.tools.length > 0) n += 1;
  if (scope.operations !== undefined && scope.operations.length > 0) n += 1;
  if (scope.environments !== undefined && scope.environments.length > 0) n += 1;
  if (scope.agent_ids !== undefined && scope.agent_ids.length > 0) n += 1;
  if (scope.resource_refs !== undefined && scope.resource_refs.length > 0) n += 1;
  return n;
}

function highRiskScope(rule: PolicyRule): boolean {
  const tools = rule.scope?.tools ?? [];
  if (tools.length === 0) return true;
  if (tools.includes('*')) return true;
  return tools.some((t) => SIDE_EFFECTING_SET.has(t));
}

function overlapKey(rule: PolicyRule): string | null {
  try {
    return canonicalize({ scope: rule.scope ?? {}, when: rule.when });
  } catch {
    return null;
  }
}

const SEVERITY_RANK: Record<PolicyLintSeverity, number> = {
  [PolicyLintSeverity.ERROR]: 0,
  [PolicyLintSeverity.WARNING]: 1,
  [PolicyLintSeverity.INFO]: 2,
};

export function lintPolicy(document: PolicyDocument): PolicyLintFinding[] {
  const findings: PolicyLintFinding[] = [];
  const rules = Array.isArray(document.rules) ? document.rules : [];

  if ((document.default_effect as string) !== 'DENY') {
    findings.push({
      code: PolicyLintCode.MISSING_DEFAULT_DENY,
      severity: PolicyLintSeverity.ERROR,
      ruleIds: [],
      message: 'default_effect must be DENY; a policy that defaults to allow is not a policy.',
    });
  }

  const seenIds = new Set<string>();
  const dupIds = new Set<string>();
  for (const rule of rules) {
    if (seenIds.has(rule.id)) dupIds.add(rule.id);
    seenIds.add(rule.id);
  }
  for (const id of dupIds) {
    findings.push({
      code: PolicyLintCode.DUPLICATE_RULE_ID,
      severity: PolicyLintSeverity.ERROR,
      ruleIds: [id],
      message: `rule id "${id}" appears more than once; rule references would be ambiguous.`,
    });
  }

  let enabledAllowCount = 0;
  for (const rule of rules) {
    if (rule.enabled === false) {
      findings.push({
        code: PolicyLintCode.DISABLED_RULE,
        severity: PolicyLintSeverity.INFO,
        ruleIds: [rule.id],
        message: `rule "${rule.id}" is disabled and takes no part in evaluation.`,
      });
    }
    if (rule.effect === 'ALLOW' && rule.enabled !== false) enabledAllowCount += 1;

    // A model signal can escalate but never allow; the evaluator neuters such
    // rules, so flag them loudly here instead of failing silently at runtime.
    if (rule.effect === 'ALLOW' && ruleReferencesModel(rule.when)) {
      findings.push({
        code: PolicyLintCode.MODEL_FIELD_IN_ALLOW_RULE,
        severity: PolicyLintSeverity.ERROR,
        ruleIds: [rule.id],
        message: `rule "${rule.id}" is ALLOW but reads model.* fields; model output can never produce an allow.`,
      });
    }

    if (rule.effect === 'ALLOW' && scopeKeyCount(rule) === 0) {
      findings.push({
        code: PolicyLintCode.EMPTY_SCOPE_ON_ALLOW,
        severity: PolicyLintSeverity.WARNING,
        ruleIds: [rule.id],
        message: `rule "${rule.id}" is ALLOW with an empty scope; it matches every tool including side-effecting ones.`,
      });
    }

    const tools = rule.scope?.tools ?? [];
    if (tools.includes('*')) {
      findings.push({
        code: PolicyLintCode.OVERLY_BROAD_WILDCARD,
        severity: PolicyLintSeverity.WARNING,
        ruleIds: [rule.id],
        message: `rule "${rule.id}" scopes tools to "*"; a wildcard allow is how a policy accidentally grants everything.`,
      });
    }
    const unknownTools = tools.filter((t) => t !== '*' && !SUPPORTED_TOOL_SET.has(t));
    if (tools.length > 0 && unknownTools.length === tools.filter((t) => t !== '*').length && unknownTools.length > 0) {
      findings.push({
        code: PolicyLintCode.UNREACHABLE_RULE,
        severity: PolicyLintSeverity.WARNING,
        ruleIds: [rule.id],
        message: `rule "${rule.id}" scopes only unknown tools (${unknownTools.join(', ')}); intake rejects those tools, so this rule can never match.`,
      });
    } else if (unknownTools.length > 0) {
      findings.push({
        code: PolicyLintCode.UNKNOWN_TOOL_IN_SCOPE,
        severity: PolicyLintSeverity.WARNING,
        ruleIds: [rule.id],
        message: `rule "${rule.id}" scopes unknown tool(s): ${unknownTools.join(', ')}.`,
      });
    }

    if (rule.effect === 'REQUIRE_APPROVAL') {
      const quorum = rule.approval?.required_approvals ?? 1;
      if (quorum <= 1 && highRiskScope(rule)) {
        findings.push({
          code: PolicyLintCode.APPROVAL_QUORUM_ONE_FOR_HIGH_RISK,
          severity: PolicyLintSeverity.WARNING,
          ruleIds: [rule.id],
          message: `rule "${rule.id}" requires a single approver for a high-risk scope; beneficiary changes and large payments need dual approval.`,
        });
      }
    }

    const checkAmountUnits = (c: Condition) => {
      if (AMOUNT_FIELDS.has(c.field) && COMPARISON_OPS.has(c.op) && typeof c.value === 'number') {
        if (Math.abs(c.value) < MINOR_UNIT_SUSPECT_BELOW) {
          findings.push({
            code: PolicyLintCode.AMOUNT_UNIT_SUSPECT,
            severity: PolicyLintSeverity.WARNING,
            ruleIds: [rule.id],
            message: `rule "${rule.id}" compares ${c.field} against ${c.value}; amounts are integer minor units ($1.00 = 100), so this looks like major units.`,
          });
        }
      }
    };
    eachCondition(rule.when, checkAmountUnits);
  }

  const params = document.parameters as Record<string, unknown> | undefined;
  if (params !== undefined && typeof params === 'object' && params !== null) {
    for (const [key, value] of Object.entries(params)) {
      if (
        /amount|minor|budget|limit|threshold|velocity/i.test(key) &&
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        Math.abs(value) < MINOR_UNIT_SUSPECT_BELOW
      ) {
        findings.push({
          code: PolicyLintCode.AMOUNT_UNIT_SUSPECT,
          severity: PolicyLintSeverity.WARNING,
          ruleIds: [],
          message: `parameter "${key}" is ${value}; amounts are integer minor units ($1.00 = 100), so this looks like major units.`,
        });
      }
    }
  }

  if (enabledAllowCount === 0) {
    findings.push({
      code: PolicyLintCode.NO_ALLOW_RULE,
      severity: PolicyLintSeverity.WARNING,
      ruleIds: [],
      message: 'the policy has no enabled ALLOW rule, so it can never allow anything.',
    });
  }

  // Syntactic overlap: an ALLOW and a DENY with textually identical scope and
  // conditions. The deny always wins, so the allow is dead weight that
  // misleads reviewers about what the policy permits.
  const denyKeys = new Map<string, PolicyRule[]>();
  for (const rule of rules) {
    if (rule.effect !== 'DENY' || rule.enabled === false) continue;
    const key = overlapKey(rule);
    if (key === null) continue;
    const list = denyKeys.get(key) ?? [];
    list.push(rule);
    denyKeys.set(key, list);
  }
  for (const rule of rules) {
    if (rule.effect !== 'ALLOW' || rule.enabled === false) continue;
    const key = overlapKey(rule);
    if (key === null) continue;
    const denies = denyKeys.get(key);
    if (denies !== undefined && denies.length > 0) {
      findings.push({
        code: PolicyLintCode.OVERLAPPING_ALLOW_DENY,
        severity: PolicyLintSeverity.WARNING,
        ruleIds: [rule.id, denies[0]?.id ?? 'unknown'],
        message: `rule "${rule.id}" (ALLOW) is textually identical in scope and conditions to "${denies[0]?.id}"; the deny always wins, so the allow never takes effect.`,
      });
    }
  }

  findings.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const ar = a.ruleIds.join(',');
    const br = b.ruleIds.join(',');
    return ar < br ? -1 : ar > br ? 1 : 0;
  });
  return findings;
}
