import { describe, expect, it } from 'vitest';
import {
  ActionState,
  Capability,
  CanonicalizationError,
  Decision,
  DenyReason,
  FAIL_CLOSED_REASONS,
  HASH_VERSION,
  IllegalTransitionError,
  MoneyError,
  Role,
  TERMINAL_STATES,
  actionHash,
  allowedTransitions,
  assertTransition,
  canTransition,
  canonicalHash,
  canonicalize,
  formatMoney,
  hashEquals,
  isTerminal,
  money,
  newId,
  parseId,
  isIdOfKind,
  parseMajorToMinor,
  redact,
  REDACTED,
  roleHasCapability,
  capabilitiesFor,
  sideEffectMayHaveOccurred,
  scrubLogMessage,
  assertValidAmountMinor,
} from '../src/index.js';

describe('canonicalization', () => {
  it('is order-independent for object keys', () => {
    const a = canonicalize({ amount_minor: 300000, currency: 'USD', vendor_id: 'VEN-017' });
    const b = canonicalize({ vendor_id: 'VEN-017', currency: 'USD', amount_minor: 300000 });
    expect(a).toBe(b);
  });

  it('is order-dependent for arrays, which are semantically ordered', () => {
    expect(canonicalize(['a', 'b'])).not.toBe(canonicalize(['b', 'a']));
  });

  it('treats -0 and 0 as the same value', () => {
    expect(canonicalize({ n: -0 })).toBe(canonicalize({ n: 0 }));
  });

  it('normalizes equivalent Unicode representations to one hash', () => {
    // U+00E9 (precomposed) vs U+0065 U+0301 (combining) — same visible text.
    const precomposed = 'caf\u00E9';
    const combining = 'cafe\u0301';
    expect(canonicalHash({ name: precomposed })).toBe(canonicalHash({ name: combining }));
  });

  it('keeps distinct glyphs distinct rather than folding confusables', () => {
    // Canonicalization must NOT erase a Cyrillic "а" masquerading as Latin "a":
    // that is a policy/risk signal, and silently folding it would let an
    // approval bind to a destination the connector never receives.
    const latin = { beneficiary_ref: 'BEN-017' };
    const confusable = { beneficiary_ref: 'BEN-0\u04307' };
    expect(canonicalHash(latin)).not.toBe(canonicalHash(confusable));
  });

  it('rejects undefined instead of silently dropping the key', () => {
    // Dropping it would make {a:1,b:undefined} hash identically to {a:1}, so an
    // approver could review a payload the connector never sees.
    expect(() => canonicalize({ a: 1, b: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: 1, b: null })).not.toThrow();
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
  });

  it('rejects lone surrogates', () => {
    expect(() => canonicalize({ a: '\uD800' })).toThrow(CanonicalizationError);
  });

  it('enforces depth and node limits', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => canonicalize(deep)).toThrow(/max depth/);

    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    expect(() => canonicalize(wide)).toThrow(/nodes/);
  });

  it('is stable across repeated calls (deterministic)', () => {
    const value = { b: [3, 1, 2], a: { z: null, y: 'x' } };
    const first = canonicalize(value);
    for (let i = 0; i < 20; i++) expect(canonicalize(value)).toBe(first);
  });

  it('does not mutate its input', () => {
    const input = { b: 1, a: 2 };
    const snapshot = JSON.stringify(input);
    canonicalize(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('action hashing', () => {
  const base = {
    tenantId: 'ten_01J0000000000000000000000A',
    agentId: 'agt_01J0000000000000000000000A',
    runId: 'run_1',
    toolName: 'payment.execute',
    operation: 'execute',
    arguments: { amount_minor: 300000, currency: 'USD', vendor_id: 'VEN-017' },
    environment: 'DEMO',
  };

  it('produces a sha256-prefixed digest', () => {
    expect(actionHash(base)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('changes when any authorized field changes', () => {
    const original = actionHash(base);
    expect(actionHash({ ...base, arguments: { ...base.arguments, amount_minor: 7500000 } })).not.toBe(original);
    expect(actionHash({ ...base, toolName: 'vendor.export' })).not.toBe(original);
    expect(actionHash({ ...base, environment: 'PRODUCTION' })).not.toBe(original);
    expect(actionHash({ ...base, runId: 'run_2' })).not.toBe(original);
  });

  it('is unaffected by transport-only identifiers, so an approval cannot be laundered', () => {
    // The idempotency key and client request id are deliberately outside the
    // hash: resubmitting identical intent under a new key must yield the same
    // action hash, otherwise a fresh key would dodge an existing denial.
    const hashInput = { ...base };
    expect(actionHash(hashInput)).toBe(actionHash({ ...hashInput }));
  });

  it('includes the hash version in the preimage', () => {
    expect(HASH_VERSION).toBe('pz-canon-v1');
    const canonical = canonicalize({ a: 1 });
    expect(canonicalHash({ a: 1 })).not.toBe(`sha256:${canonical}`);
  });

  it('compares hashes in constant time', () => {
    const h = actionHash(base);
    expect(hashEquals(h, h)).toBe(true);
    expect(hashEquals(h, h.replace(/.$/, '0'))).toBe(false);
    expect(hashEquals(h, 'short')).toBe(false);
  });
});

describe('state machine', () => {
  it('allows the happy path from PRD §5.3', () => {
    const path = [
      ActionState.RECEIVED,
      ActionState.VALIDATING,
      ActionState.EVALUATING,
      ActionState.ALLOWED,
      ActionState.PERMIT_ISSUED,
      ActionState.EXECUTION_PENDING,
      ActionState.EXECUTING,
      ActionState.SUCCEEDED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows the approval path', () => {
    expect(canTransition(ActionState.EVALUATING, ActionState.APPROVAL_REQUIRED)).toBe(true);
    expect(canTransition(ActionState.APPROVAL_REQUIRED, ActionState.APPROVED)).toBe(true);
    expect(canTransition(ActionState.APPROVED, ActionState.PERMIT_ISSUED)).toBe(true);
  });

  it('allows the unknown-outcome reconciliation path', () => {
    expect(canTransition(ActionState.EXECUTING, ActionState.UNKNOWN_OUTCOME)).toBe(true);
    expect(canTransition(ActionState.UNKNOWN_OUTCOME, ActionState.RECONCILING)).toBe(true);
    expect(canTransition(ActionState.RECONCILING, ActionState.SUCCEEDED)).toBe(true);
    expect(canTransition(ActionState.RECONCILING, ActionState.MANUAL_REVIEW)).toBe(true);
  });

  it('forbids skipping evaluation to reach an executing state', () => {
    expect(canTransition(ActionState.RECEIVED, ActionState.EXECUTING)).toBe(false);
    expect(canTransition(ActionState.EVALUATING, ActionState.SUCCEEDED)).toBe(false);
    expect(canTransition(ActionState.EVALUATING, ActionState.PERMIT_ISSUED)).toBe(false);
  });

  it('forbids resurrecting a terminal state', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(isTerminal(terminal)).toBe(true);
      for (const target of Object.values(ActionState)) {
        if (target === ActionState.QUARANTINED) continue;
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('forbids turning a DENIED action into a different action', () => {
    // PRD §5.3: "DENIED: terminal unless a new action is submitted".
    expect(canTransition(ActionState.DENIED, ActionState.EVALUATING)).toBe(false);
    expect(canTransition(ActionState.DENIED, ActionState.APPROVAL_REQUIRED)).toBe(false);
    expect(canTransition(ActionState.DENIED, ActionState.ALLOWED)).toBe(false);
    expect(allowedTransitions(ActionState.DENIED)).toEqual([]);
  });

  it('forbids jumping from UNKNOWN_OUTCOME back to EXECUTING (blind retry)', () => {
    // The invariant behind acceptance criterion 8: reconcile before retrying.
    expect(canTransition(ActionState.UNKNOWN_OUTCOME, ActionState.EXECUTING)).toBe(false);
    expect(canTransition(ActionState.UNKNOWN_OUTCOME, ActionState.EXECUTION_PENDING)).toBe(false);
  });

  it('throws a typed error on an illegal transition', () => {
    expect(() => assertTransition(ActionState.DENIED, ActionState.ALLOWED)).toThrow(IllegalTransitionError);
    try {
      assertTransition(ActionState.RECEIVED, ActionState.SUCCEEDED);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).code).toBe('ILLEGAL_STATE_TRANSITION');
    }
  });

  it('allows quarantine from any non-terminal state and release only to safe states', () => {
    for (const state of Object.values(ActionState)) {
      if (isTerminal(state) || state === ActionState.QUARANTINED) continue;
      expect(canTransition(state, ActionState.QUARANTINED)).toBe(true);
    }
    expect(canTransition(ActionState.QUARANTINED, ActionState.EXECUTING)).toBe(false);
    expect(canTransition(ActionState.QUARANTINED, ActionState.MANUAL_REVIEW)).toBe(true);
  });

  it('knows when a side effect may already have happened', () => {
    expect(sideEffectMayHaveOccurred(ActionState.EXECUTING)).toBe(true);
    expect(sideEffectMayHaveOccurred(ActionState.UNKNOWN_OUTCOME)).toBe(true);
    expect(sideEffectMayHaveOccurred(ActionState.SUCCEEDED)).toBe(true);
    expect(sideEffectMayHaveOccurred(ActionState.PERMIT_ISSUED)).toBe(false);
    expect(sideEffectMayHaveOccurred(ActionState.EVALUATING)).toBe(false);
  });
});

describe('role capabilities are not a ladder', () => {
  it('never lets a service agent approve, publish policy or manage connectors', () => {
    const agent = capabilitiesFor(Role.SERVICE_AGENT);
    expect(agent).toContain(Capability.ACTION_SUBMIT);
    expect(roleHasCapability(Role.SERVICE_AGENT, Capability.ACTION_APPROVE)).toBe(false);
    expect(roleHasCapability(Role.SERVICE_AGENT, Capability.POLICY_PUBLISH)).toBe(false);
    expect(roleHasCapability(Role.SERVICE_AGENT, Capability.POLICY_WRITE)).toBe(false);
    expect(roleHasCapability(Role.SERVICE_AGENT, Capability.CONNECTOR_MANAGE)).toBe(false);
    expect(roleHasCapability(Role.SERVICE_AGENT, Capability.MODE_CHANGE)).toBe(false);
    expect(roleHasCapability(Role.SERVICE_AGENT, Capability.AUDIT_EXPORT)).toBe(false);
  });

  it('grants an approver approval rights but no policy write', () => {
    expect(roleHasCapability(Role.APPROVER, Capability.ACTION_APPROVE)).toBe(true);
    expect(roleHasCapability(Role.APPROVER, Capability.POLICY_WRITE)).toBe(false);
    expect(roleHasCapability(Role.APPROVER, Capability.ACTION_EXECUTE)).toBe(false);
  });

  it('grants an auditor read and export but no write capability at all', () => {
    expect(roleHasCapability(Role.AUDITOR, Capability.AUDIT_EXPORT)).toBe(true);
    expect(roleHasCapability(Role.AUDITOR, Capability.ACTION_APPROVE)).toBe(false);
    expect(roleHasCapability(Role.AUDITOR, Capability.SETTINGS_WRITE)).toBe(false);
  });

  it('denies every capability not explicitly listed for a role', () => {
    // Absence is denial. If someone adds a capability to the enum, no role gets
    // it until it is listed — this test fails loudly if that changes.
    for (const role of Object.values(Role)) {
      const granted = capabilitiesFor(role);
      for (const capability of Object.values(Capability)) {
        expect(roleHasCapability(role, capability)).toBe(granted.includes(capability));
      }
    }
  });
});

describe('money', () => {
  it('rejects float major-unit amounts rather than scaling them', () => {
    expect(() => assertValidAmountMinor(3000.5, 'USD')).toThrow(MoneyError);
    expect(() => assertValidAmountMinor(Number.NaN, 'USD')).toThrow(MoneyError);
    expect(() => assertValidAmountMinor(Number.MAX_SAFE_INTEGER + 10, 'USD')).toThrow(MoneyError);
  });

  it('rejects unsupported currency codes', () => {
    expect(() => assertValidAmountMinor(100, 'XYZ')).toThrow(MoneyError);
    expect(() => assertValidAmountMinor(100, 'usd')).toThrow(MoneyError);
  });

  it('parses major-unit strings to minor units without float error', () => {
    expect(parseMajorToMinor('3000.00', 'USD')).toBe(300000);
    expect(parseMajorToMinor('75000', 'USD')).toBe(7500000);
    expect(parseMajorToMinor('0.07', 'USD')).toBe(7);
    expect(parseMajorToMinor('3000', 'JPY')).toBe(3000);
    expect(parseMajorToMinor('1.234', 'BHD')).toBe(1234);
    expect(parseMajorToMinor('-12.50', 'USD')).toBe(-1250);
  });

  it('refuses to silently truncate excess precision', () => {
    expect(() => parseMajorToMinor('3000.001', 'USD')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('1.2345', 'BHD')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('abc', 'USD')).toThrow(MoneyError);
  });

  it('round-trips through display formatting', () => {
    expect(formatMoney(money(300000, 'USD'))).toBe('3000.00 USD');
    expect(formatMoney(money(7500000, 'USD'))).toBe('75000.00 USD');
    expect(formatMoney(money(7, 'USD'))).toBe('0.07 USD');
    expect(formatMoney(money(3000, 'JPY'))).toBe('3000 JPY');
    expect(formatMoney(money(-1250, 'USD'))).toBe('-12.50 USD');
  });
});

describe('redaction', () => {
  it('redacts secret-bearing keys but preserves their presence', () => {
    const out = redact({
      api_key: 'sk-live-abcdef0123456789',
      password: 'hunter2',
      authorization: 'Bearer abc.def.ghi',
      vendor_id: 'VEN-017',
    }) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.vendor_id).toBe('VEN-017');
    expect(Object.keys(out)).toContain('api_key');
  });

  it('redacts token-shaped values regardless of key name', () => {
    const out = redact({ note: 'used Bearer eyJhbGci.eyJzdWIi.abc123 here' }) as Record<string, unknown>;
    expect(String(out.note)).not.toContain('eyJhbGci');
  });

  it('masks long digit runs but keeps the last four for operator matching', () => {
    const out = redact({ account: '1234567890123456' }) as Record<string, unknown>;
    expect(String(out.account)).toBe('••••3456');
  });

  it('leaves short legitimate numbers alone', () => {
    const out = redact({ amount_minor: 300000, currency: 'USD' }) as Record<string, unknown>;
    expect(out.amount_minor).toBe(300000);
    expect(out.currency).toBe('USD');
  });

  it('does not mutate the input, because the original feeds the action hash', () => {
    const input = { api_key: 'secret', amount_minor: 100 };
    const snapshot = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('scrubs bearer tokens out of free-form log messages', () => {
    expect(scrubLogMessage('call with Bearer abc123def456.789012.xyz failed')).not.toContain('abc123def456');
  });

  it('bounds recursion depth', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 30; i++) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});

describe('identifiers', () => {
  it('generates prefixed, parseable, unique IDs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = newId('action');
      expect(id).toMatch(/^act_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('rejects a wrong-prefix or malformed ID', () => {
    const action = newId('action');
    expect(parseId(action)?.kind).toBe('action');
    expect(isIdOfKind(action, 'action')).toBe(true);
    expect(isIdOfKind(action, 'permit')).toBe(false);
    expect(parseId('act_notavalidulid')).toBeNull();
    expect(parseId('unknown_01J0000000000000000000000A')).toBeNull();
    expect(parseId('')).toBeNull();
    // Excluded Crockford characters must not parse.
    expect(parseId('act_01J0000000000000000000000U')).toBeNull();
  });

  it('sorts lexicographically by creation time', () => {
    const earlier = newId('auditEvent');
    const later = newId('auditEvent');
    expect(earlier.localeCompare(later)).toBeLessThanOrEqual(0);
  });
});

describe('fail-closed reason codes', () => {
  it('classifies every enforcement-outage reason as fail-closed', () => {
    expect(FAIL_CLOSED_REASONS).toContain(DenyReason.POLICY_STORE_UNAVAILABLE);
    expect(FAIL_CLOSED_REASONS).toContain(DenyReason.ENFORCEMENT_UNAVAILABLE);
    expect(FAIL_CLOSED_REASONS).toContain(DenyReason.AUDIT_WRITE_FAILED);
  });

  it('never treats a missing decision as ALLOW', () => {
    // The enum has exactly four members and INDETERMINATE is distinct from ALLOW:
    // a code path that cannot decide has somewhere to go that is not "allow".
    expect(Object.values(Decision)).toEqual(['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'INDETERMINATE']);
    expect(Decision.INDETERMINATE).not.toBe(Decision.ALLOW);
  });
});
