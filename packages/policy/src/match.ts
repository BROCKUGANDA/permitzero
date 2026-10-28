/**
 * Scope filtering and three-valued condition matching.
 *
 * Conditions evaluate to TRUE, FALSE or UNKNOWN (Kleene logic). UNKNOWN arises
 * only from unresolvable fields — never from a value comparison — so an
 * UNKNOWN verdict always means "authoritative state was missing", which the
 * evaluator turns into INDETERMINATE rather than ALLOW.
 *
 * Operator notes:
 *  - `exists` / `not_exists` test field resolution, not truthiness: use
 *    `is_true` / `is_false` for booleans.
 *  - Comparisons on strings are lexicographic (UTF-16 code unit order) and on
 *    booleans are false < true. Mixed-type comparisons are false.
 *  - `contains` on a multi-valued field tests whether any member contains the
 *    substring; `equals` / `in` test membership.
 */
import type { PolicyEvaluationInput } from '@permitzero/domain';
import { PolicyOperator } from '@permitzero/schemas';
import type { Condition, ConditionGroup, PolicyField, PolicyRule } from '@permitzero/schemas';
import { effectiveEnvironment } from './environment.js';
import type { InternalResolved } from './fields.js';

export type Verdict = 'TRUE' | 'FALSE' | 'UNKNOWN';

export interface GroupEvaluation {
  verdict: Verdict;
  trueCount: number;
  falseCount: number;
  unknownCount: number;
}

export const MODEL_FIELD_PREFIX = 'model.';

type ConditionValue = string | number | boolean | ReadonlyArray<string | number> | null | undefined;

function isCondition(node: Condition | ConditionGroup): node is Condition {
  return (node as Condition).field !== undefined;
}

/** Visit every leaf condition in a group, including nested groups. */
export function eachCondition(when: ConditionGroup, visit: (c: Condition) => void): void {
  const groups: (readonly (Condition | ConditionGroup)[] | undefined)[] = [when.all, when.any, when.none];
  for (const list of groups) {
    if (!list) continue;
    for (const node of list) {
      if (isCondition(node)) visit(node);
      else eachCondition(node, visit);
    }
  }
}

/** True when any leaf condition in the group references a `model.*` field. */
export function ruleReferencesModel(when: ConditionGroup): boolean {
  let found = false;
  eachCondition(when, (c) => {
    if (typeof c.field === 'string' && c.field.startsWith(MODEL_FIELD_PREFIX)) found = true;
  });
  return found;
}

/**
 * True when the rule's scope selects this action. Every present scope key must
 * match. `resource_refs` matches against the action's evidence refs. A missing
 * or empty scope matches everything (the linter flags empty scopes on allows).
 */
export function ruleInScope(rule: PolicyRule, input: PolicyEvaluationInput): boolean {
  const scope = rule.scope ?? {};
  if (scope.tools !== undefined && scope.tools.length > 0) {
    if (!scope.tools.includes('*') && !scope.tools.includes(input.toolName)) return false;
  }
  if (scope.operations !== undefined && scope.operations.length > 0) {
    if (!scope.operations.includes(input.operation)) return false;
  }
  if (scope.environments !== undefined && scope.environments.length > 0) {
    // The derived environment, never the one the request asked for: a caller
    // who could name the environment could drop the protective rules that only
    // apply to the environment they named.
    if (!scope.environments.includes(effectiveEnvironment(input))) return false;
  }
  if (scope.agent_ids !== undefined && scope.agent_ids.length > 0) {
    if (!scope.agent_ids.includes(input.agent.agentId)) return false;
  }
  if (scope.resource_refs !== undefined && scope.resource_refs.length > 0) {
    const refs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map((r) => r?.ref) : [];
    if (!scope.resource_refs.some((r) => refs.includes(r))) return false;
  }
  return true;
}

function compareScalars(actual: string | number | boolean, op: PolicyOperator, expected: ConditionValue): Verdict {
  switch (op) {
    case PolicyOperator.EQUALS:
      return actual === expected ? 'TRUE' : 'FALSE';
    case PolicyOperator.NOT_EQUALS:
      return actual !== expected ? 'TRUE' : 'FALSE';
    case PolicyOperator.IN:
      return Array.isArray(expected) && (expected as readonly unknown[]).includes(actual) ? 'TRUE' : 'FALSE';
    case PolicyOperator.NOT_IN:
      return Array.isArray(expected) && !(expected as readonly unknown[]).includes(actual) ? 'TRUE' : 'FALSE';
    case PolicyOperator.IS_TRUE:
      return actual === true ? 'TRUE' : 'FALSE';
    case PolicyOperator.IS_FALSE:
      return actual === false ? 'TRUE' : 'FALSE';
    case PolicyOperator.CONTAINS:
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected) ? 'TRUE' : 'FALSE';
    case PolicyOperator.MATCHES_REGEX: {
      if (typeof actual !== 'string' || typeof expected !== 'string') return 'FALSE';
      try {
        return new RegExp(expected).test(actual) ? 'TRUE' : 'FALSE';
      } catch {
        // Unvalidated policy text; fail closed rather than crash.
        return 'UNKNOWN';
      }
    }
    case PolicyOperator.LESS_THAN:
      return lessThan(actual, expected) === true ? 'TRUE' : 'FALSE';
    case PolicyOperator.LESS_THAN_OR_EQUAL:
      return lessThan(actual, expected) === true || actual === expected ? 'TRUE' : 'FALSE';
    case PolicyOperator.GREATER_THAN:
      return lessThan(expected, actual) === true ? 'TRUE' : 'FALSE';
    case PolicyOperator.GREATER_THAN_OR_EQUAL:
      return lessThan(expected, actual) === true || actual === expected ? 'TRUE' : 'FALSE';
    case PolicyOperator.EXISTS:
    case PolicyOperator.NOT_EXISTS:
      // Handled before resolution-kind dispatch; unreachable here.
      return 'FALSE';
  }
}

/** Strict ordering within one type; null when the pair is not comparable. */
function lessThan(a: ConditionValue, b: ConditionValue): boolean | null {
  if (typeof a === 'number' && typeof b === 'number') return a < b;
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === false && b === true;
  return null;
}

function compareSet(members: readonly string[], op: PolicyOperator, expected: ConditionValue): Verdict {
  switch (op) {
    case PolicyOperator.EQUALS:
      return typeof expected === 'string' && members.includes(expected) ? 'TRUE' : 'FALSE';
    case PolicyOperator.NOT_EQUALS:
      return typeof expected === 'string' && !members.includes(expected) ? 'TRUE' : 'FALSE';
    case PolicyOperator.IN:
      return Array.isArray(expected) && expected.some((e) => typeof e === 'string' && members.includes(e))
        ? 'TRUE'
        : 'FALSE';
    case PolicyOperator.NOT_IN:
      return Array.isArray(expected) && !expected.some((e) => typeof e === 'string' && members.includes(e))
        ? 'TRUE'
        : 'FALSE';
    case PolicyOperator.CONTAINS:
      return typeof expected === 'string' && members.some((m) => m.includes(expected)) ? 'TRUE' : 'FALSE';
    case PolicyOperator.MATCHES_REGEX: {
      if (typeof expected !== 'string') return 'FALSE';
      try {
        const re = new RegExp(expected);
        return members.some((m) => re.test(m)) ? 'TRUE' : 'FALSE';
      } catch {
        return 'UNKNOWN';
      }
    }
    case PolicyOperator.IS_TRUE:
    case PolicyOperator.IS_FALSE:
    case PolicyOperator.LESS_THAN:
    case PolicyOperator.LESS_THAN_OR_EQUAL:
    case PolicyOperator.GREATER_THAN:
    case PolicyOperator.GREATER_THAN_OR_EQUAL:
      return 'FALSE';
    case PolicyOperator.EXISTS:
    case PolicyOperator.NOT_EXISTS:
      return 'FALSE';
  }
}

function evaluateCondition(condition: Condition, fields: ReadonlyMap<PolicyField, InternalResolved>): Verdict {
  const r = fields.get(condition.field);
  if (!r || r.status === 'unknown') return 'UNKNOWN';
  if (condition.op === PolicyOperator.EXISTS) {
    // Scalar: resolved means present. Set: present means non-empty.
    if (r.setValues !== null) return r.status === 'resolved' && r.setValues.length > 0 ? 'TRUE' : 'FALSE';
    return r.status === 'resolved' ? 'TRUE' : 'FALSE';
  }
  if (condition.op === PolicyOperator.NOT_EXISTS) {
    if (r.setValues !== null) return r.status === 'absent' || r.setValues.length === 0 ? 'TRUE' : 'FALSE';
    return r.status === 'absent' ? 'TRUE' : 'FALSE';
  }
  if (r.status === 'absent' || r.value === null) return 'FALSE';
  if (r.setValues !== null) return compareSet(r.setValues, condition.op, condition.value);
  return compareScalars(r.value, condition.op, condition.value);
}

function conjunction(parts: Verdict[]): Verdict {
  if (parts.includes('FALSE')) return 'FALSE';
  if (parts.includes('UNKNOWN')) return 'UNKNOWN';
  return 'TRUE';
}

function disjunction(parts: Verdict[]): Verdict {
  if (parts.includes('TRUE')) return 'TRUE';
  if (parts.includes('UNKNOWN')) return 'UNKNOWN';
  return 'FALSE';
}

function negation(parts: Verdict[]): Verdict {
  if (parts.includes('TRUE')) return 'FALSE';
  if (parts.includes('UNKNOWN')) return 'UNKNOWN';
  return 'TRUE';
}

function mergeCounts(into: GroupEvaluation, child: GroupEvaluation): void {
  into.trueCount += child.trueCount;
  into.falseCount += child.falseCount;
  into.unknownCount += child.unknownCount;
}

function evaluateNode(
  node: Condition | ConditionGroup,
  fields: ReadonlyMap<PolicyField, InternalResolved>,
): GroupEvaluation {
  if (isCondition(node)) {
    const verdict = evaluateCondition(node, fields);
    return {
      verdict,
      trueCount: verdict === 'TRUE' ? 1 : 0,
      falseCount: verdict === 'FALSE' ? 1 : 0,
      unknownCount: verdict === 'UNKNOWN' ? 1 : 0,
    };
  }
  return evaluateConditionGroup(node, fields);
}

/**
 * A group matches when its `all` conjunction, its `any` disjunction and its
 * `none` negation all hold; an absent key is vacuously satisfied. A group with
 * no keys at all is UNKNOWN (malformed policy text fails closed).
 */
export function evaluateConditionGroup(
  when: ConditionGroup,
  fields: ReadonlyMap<PolicyField, InternalResolved>,
): GroupEvaluation {
  const total: GroupEvaluation = { verdict: 'TRUE', trueCount: 0, falseCount: 0, unknownCount: 0 };
  const parts: Verdict[] = [];
  let keys = 0;
  if (when.all !== undefined) {
    keys += 1;
    const verdicts: Verdict[] = [];
    for (const node of when.all) {
      const child = evaluateNode(node, fields);
      verdicts.push(child.verdict);
      mergeCounts(total, child);
    }
    parts.push(conjunction(verdicts));
  }
  if (when.any !== undefined) {
    keys += 1;
    const verdicts: Verdict[] = [];
    for (const node of when.any) {
      const child = evaluateNode(node, fields);
      verdicts.push(child.verdict);
      mergeCounts(total, child);
    }
    parts.push(disjunction(verdicts));
  }
  if (when.none !== undefined) {
    keys += 1;
    const verdicts: Verdict[] = [];
    for (const node of when.none) {
      const child = evaluateNode(node, fields);
      verdicts.push(child.verdict);
      mergeCounts(total, child);
    }
    parts.push(negation(verdicts));
  }
  total.verdict = keys === 0 ? 'UNKNOWN' : conjunction(parts);
  return total;
}
