/**
 * Release-gate suite for the versioned adversarial / resilience corpus.
 *
 * The invariant under test is the one in Master Prompt §12 / PRD §14.2: "zero
 * known false allows in the release-gating forbidden-action corpus". A red test
 * here means a candidate policy or engine change lets a forbidden action through
 * without a human, so nothing in this file may be weakened to get green — a new
 * expectation has to be justified by the engine's actual decision order.
 */
import { describe, expect, it } from 'vitest';
import {
  AllowReason,
  ApprovalReason,
  Decision,
  DenyReason,
  IndeterminateReason,
} from '@permitzero/domain';
import type { PolicyEvaluationResult } from '@permitzero/domain';
import type { PolicyDocument } from '@permitzero/schemas';
import { buildApProtectPolicyDocument } from '@permitzero/db/seed-policy';
import { DEFAULT_MAX_FIXTURES, evaluatePolicy, hashPolicyDocument, simulatePolicy } from '@permitzero/policy';
import { CORPUS_NOW } from '../src/builders.js';
import {
  CORPUS_VERSION,
  FIXTURE_GROUPS,
  GROUP_MINIMUMS,
  TOTAL_MINIMUM,
  actionHashOf,
  corpus,
  corpusByGroup,
  corpusById,
  corpusHash,
  corpusSummary,
  forbiddenCorpus,
  pinnedRevisionOf,
  simulateCases,
} from '../src/index.js';
import type { FixtureCase, FixtureGroup } from '../src/index.js';

const revision = pinnedRevisionOf(buildApProtectPolicyDocument());

const REASON_SETS: Record<Decision, ReadonlySet<string>> = {
  [Decision.ALLOW]: new Set<string>(Object.values(AllowReason)),
  [Decision.DENY]: new Set<string>(Object.values(DenyReason)),
  [Decision.REQUIRE_APPROVAL]: new Set<string>(Object.values(ApprovalReason)),
  [Decision.INDETERMINATE]: new Set<string>(Object.values(IndeterminateReason)),
};

const DECISION_BY_GROUP: Record<FixtureGroup, Decision | null> = {
  normal: Decision.ALLOW,
  deny: Decision.DENY,
  approval: Decision.REQUIRE_APPROVAL,
  adversarial: null,
  resilience: null,
};

function decide(fixture: FixtureCase): PolicyEvaluationResult {
  return evaluatePolicy(fixture.input, revision);
}

function describeFailure(fixture: FixtureCase, result: PolicyEvaluationResult): string {
  return `${fixture.id} (${fixture.label}): expected ${fixture.expectedDecision}/${
    fixture.expectedReasonCode ?? '-'
  } but the engine returned ${result.decision}/${result.reasonCodes.join(',')}`;
}

describe('corpus structure', () => {
  const fixtures = corpus();

  it(`holds at least ${TOTAL_MINIMUM} fixtures`, () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(TOTAL_MINIMUM);
  });

  it('meets every per-group floor from the spec', () => {
    for (const group of FIXTURE_GROUPS) {
      expect(corpusByGroup(group).length, `group ${group}`).toBeGreaterThanOrEqual(GROUP_MINIMUMS[group]);
    }
  });

  it('has unique, group-prefixed ids', () => {
    const expectedPrefix: Record<FixtureGroup, string> = {
      normal: 'N',
      deny: 'D',
      approval: 'AP',
      adversarial: 'AD',
      resilience: 'R',
    };
    const seen = new Set<string>();
    for (const f of fixtures) {
      expect(seen.has(f.id), `duplicate fixture id ${f.id}`).toBe(false);
      expect(f.id, `id ${f.id} must be prefixed by its group`).toMatch(/^(N|D|AP|AD|R)-\d{2,}$/);
      expect(f.id.split('-')[0], `id ${f.id} is in group ${f.group}`).toBe(expectedPrefix[f.group]);
      seen.add(f.id);
    }
  });

  it('resolves ids back to the same fixture object', () => {
    for (const f of fixtures) {
      expect(corpusById(f.id)).toBe(f);
    }
    expect(corpusById('NO-SUCH-FIXTURE')).toBeUndefined();
  });

  it('only expects reason codes that exist in the matching enum', () => {
    for (const f of fixtures) {
      if (f.expectedReasonCode === undefined) continue;
      expect(
        REASON_SETS[f.expectedDecision].has(f.expectedReasonCode),
        `${f.id}: ${f.expectedReasonCode} is not a ${f.expectedDecision} reason code`,
      ).toBe(true);
    }
  });

  it('keeps group semantics: normal allows, deny denies, approval escalates', () => {
    for (const f of fixtures) {
      const required = DECISION_BY_GROUP[f.group];
      if (required === null) continue;
      expect(f.expectedDecision, `${f.id} is in group ${f.group}`).toBe(required);
    }
  });

  it('has a non-empty forbidden subset, and no ALLOW fixture in it', () => {
    const forbidden = forbiddenCorpus();
    expect(forbidden.length).toBeGreaterThan(0);
    expect(forbidden.length).toBe(fixtures.filter((f) => f.unsafe).length);
    for (const f of fixtures) {
      if (f.expectedDecision === Decision.ALLOW) expect(f.unsafe, `${f.id} allows, so it is not forbidden`).toBe(false);
      else expect(f.unsafe, `${f.id} is not an allow, so it gates the release`).toBe(true);
    }
  });

  it('labels every fixture on one readable line', () => {
    for (const f of fixtures) {
      expect(f.label.trim().length).toBeGreaterThan(10);
      expect(f.label).not.toContain('\n');
    }
  });

  it('never reads a live clock: requestedAt is the anchored corpus instant', () => {
    for (const f of fixtures) {
      expect(f.input.requestedAt.getTime(), `${f.id} must anchor requestedAt to CORPUS_NOW`).toBe(
        CORPUS_NOW.getTime(),
      );
    }
  });

  it('content-addresses the corpus version', () => {
    const hash = corpusHash();
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).toBe(corpusHash());
    expect(corpusSummary().corpusHash).toBe(hash);
    expect(corpusSummary().corpusVersion).toBe(CORPUS_VERSION);
  });

  it('summarises into counts that add up', () => {
    const summary = corpusSummary();
    expect(summary.total).toBe(corpus().length);
    expect(Object.values(summary.byGroup).reduce((a, b) => a + b, 0)).toBe(summary.total);
    expect(Object.values(summary.byExpectedDecision).reduce((a, b) => a + b, 0)).toBe(summary.total);
    expect(summary.unsafe).toBe(forbiddenCorpus().length);
  });
});

describe('corpus behaviour against the seeded AP-PROTECT-01 policy', () => {
  it('pins a revision whose hash matches its own document', () => {
    expect(revision.policyHash).toBe(hashPolicyDocument(revision.document));
    expect(revision.document.rules.length).toBeGreaterThan(0);
  });

  it('returns the expected decision and reason code for every fixture', () => {
    const failures: string[] = [];
    for (const f of corpus()) {
      const result = decide(f);
      if (result.decision !== f.expectedDecision) {
        failures.push(describeFailure(f, result));
        continue;
      }
      if (f.expectedReasonCode !== undefined && !result.reasonCodes.includes(f.expectedReasonCode)) {
        failures.push(describeFailure(f, result));
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('routes the over-threshold and dual-approval families to the right quorum', () => {
    const quorumFailures: string[] = [];
    for (const f of corpusByGroup('approval')) {
      const approvals = decide(f).requiredApprovals;
      // A vendor bank-detail change must always need two humans; an oversized
      // payment at least one.
      const minimum = f.input.toolName === 'vendor.update_bank_details' ? 2 : 1;
      if (approvals < minimum) {
        quorumFailures.push(`${f.id}: requiredApprovals ${approvals} < ${minimum}`);
      }
    }
    expect(quorumFailures, quorumFailures.join('\n')).toEqual([]);
  });

  it('never lets a model advisory produce the decision', () => {
    for (const f of corpus()) {
      const result = decide(f);
      for (const signal of result.riskSignals) {
        expect(signal.source).toBe('MODEL_ADVISORY');
        expect(signal.reasonCode).toBe(ApprovalReason.MODEL_RISK_SIGNAL_ESCALATION);
      }
      if (f.input.riskHints === null) {
        expect(result.riskSignals, `${f.id} has no hints, so it has no advisory signals`).toHaveLength(0);
        continue;
      }
      const escalated = f.input.riskHints.instructionInjectionIndicators.some((i) => i.confidence > 0.7);
      if (escalated) {
        expect(result.decision, `${f.id} crossed the escalation threshold yet ended as ALLOW`).not.toBe(
          Decision.ALLOW,
        );
      }
    }
  });
});

describe('release gate: zero known false allows in the forbidden corpus', () => {
  it('evaluates no unsafe fixture to ALLOW', () => {
    const offenders: string[] = [];
    for (const f of forbiddenCorpus()) {
      const result = decide(f);
      if (result.decision === Decision.ALLOW) {
        offenders.push(`${f.id} ${f.label} -> ALLOW [${result.reasonCodes.join(',')}]`);
      }
    }
    expect(offenders, `false allows in the release-gating corpus:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps INDETERMINATE a blocked state, never a soft allow', () => {
    for (const f of corpus()) {
      if (f.expectedDecision !== Decision.INDETERMINATE) continue;
      expect(decide(f).decision, `${f.id} must stay INDETERMINATE`).toBe(Decision.INDETERMINATE);
    }
  });
});

describe('fail-closed revision gates over corpus inputs', () => {
  // A stale or unhashable revision cannot be expressed as a `PolicyEvaluationInput`,
  // so the same gate is checked against a corpus action instead of a fixture row.
  it('denies a stale revision whose document no longer matches the pinned hash', () => {
    const fixture = corpusById('N-01')!;
    const stale = pinnedRevisionOf(revision.document, {
      policyHash: 'sha256:' + '0'.repeat(64),
    });
    const result = evaluatePolicy(fixture.input, stale);
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasonCodes).toContain(DenyReason.POLICY_HASH_MISMATCH);
    expect(result.rulesEvaluated).toHaveLength(0);
  });

  it('denies rather than throwing when the document cannot be canonicalized', () => {
    const fixture = corpusById('N-01')!;
    const document: PolicyDocument = {
      ...revision.document,
      parameters: { unusable: undefined as unknown as string },
    };
    // The stored hash is the last thing that still parses; the document behind it
    // cannot be canonicalized, so the gate must deny instead of propagating.
    const revisionWithUnusableDocument = pinnedRevisionOf(revision.document, {
      document,
      policyHash: revision.policyHash,
    });
    const result = evaluatePolicy(fixture.input, revisionWithUnusableDocument);
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasonCodes).toContain(DenyReason.POLICY_MALFORMED);
  });
});

describe('determinism', () => {
  it('produces identical decisions, reason codes and hashes over the whole corpus twice', () => {
    const first = corpus().map((f) => {
      const r = decide(f);
      return { id: f.id, decision: r.decision, codes: r.reasonCodes.join(','), hash: r.policyHash, approvals: r.requiredApprovals, at: r.evaluatedAt.getTime() };
    });
    const second = corpus().map((f) => {
      const r = decide(f);
      return { id: f.id, decision: r.decision, codes: r.reasonCodes.join(','), hash: r.policyHash, approvals: r.requiredApprovals, at: r.evaluatedAt.getTime() };
    });
    expect(second).toEqual(first);
    expect(first).toHaveLength(corpus().length);
    for (const row of first) {
      expect(row.hash).toBe(revision.policyHash);
      expect(row.at).toBe(CORPUS_NOW.getTime());
    }
  });

  it('rebuilds the same corpus hash from a fresh module-level evaluation', () => {
    const rebuilt = corpus().map((f) => `${f.id}:${decide(f).decision}:${f.unsafe}`);
    expect(rebuilt.join('|')).toBe(corpus().map((f) => `${f.id}:${decide(f).decision}:${f.unsafe}`).join('|'));
    expect(corpusHash()).toMatch(/^sha256:/);
  });
});

describe('simulation purity guard', () => {
  it('fits in one explicit batch so nothing is silently dropped', () => {
    expect(corpus().length).toBeLessThanOrEqual(DEFAULT_MAX_FIXTURES);
    expect(DEFAULT_MAX_FIXTURES).toBeGreaterThan(0);
  });

  it('throws instead of truncating beyond DEFAULT_MAX_FIXTURES', () => {
    const cases = simulateCases();
    const oversized = Array.from({ length: DEFAULT_MAX_FIXTURES + 1 }, (_, i) => ({
      ...cases[i % cases.length]!,
      fixtureId: `overflow-${i}`,
    }));
    expect(() => simulatePolicy(oversized, revision)).toThrow(RangeError);
    expect(() => simulatePolicy(oversized, revision)).toThrow(/maxFixtures/);
    expect(simulatePolicy(cases, revision)).toHaveLength(corpus().length);
  });

  it('matches the direct evaluatePolicy results for every fixture', () => {
    const simulated = simulatePolicy(simulateCases(), revision);
    expect(simulated).toHaveLength(corpus().length);
    const mismatches: string[] = [];
    simulated.forEach((caseResult, index) => {
      const fixture = corpus()[index]!;
      if (caseResult.fixtureId !== fixture.id || caseResult.label !== fixture.label) {
        mismatches.push(`${fixture.id}: simulation returned ${caseResult.fixtureId}`);
        return;
      }
      const direct = decide(fixture);
      if (
        caseResult.result.decision !== direct.decision ||
        caseResult.result.reasonCodes.join(',') !== direct.reasonCodes.join(',') ||
        caseResult.result.requiredApprovals !== direct.requiredApprovals
      ) {
        mismatches.push(`${fixture.id}: ${caseResult.result.decision} vs ${direct.decision}`);
      }
    });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});

describe('fixture pairs that prove mutation and replay shapes', () => {
  it('binds an approval to the exact arguments it covered', () => {
    const approved = corpusById('AD-06')!;
    const mutatedAmount = corpusById('AD-05')!;
    const mutatedDestination = corpusById('AD-07')!;
    expect(actionHashOf(approved)).not.toBe(actionHashOf(mutatedAmount));
    expect(actionHashOf(approved)).not.toBe(actionHashOf(mutatedDestination));
    expect(decide(approved).decision).toBe(Decision.ALLOW);
    expect(decide(mutatedAmount).decision).toBe(Decision.REQUIRE_APPROVAL);
    expect(decide(mutatedDestination).decision).toBe(Decision.DENY);
  });

  it('recognises a resubmitted identical action as the same canonical intent', () => {
    const replayA = corpusById('AD-28')!;
    const replayB = corpusById('AD-29')!;
    expect(actionHashOf(replayA)).toBe(actionHashOf(replayB));
    expect(decide(replayA).decision).toBe(decide(replayB).decision);
  });

  it('decides duplicate deliveries identically', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['R-27', 'R-28'],
      ['R-29', 'R-30'],
    ];
    for (const [a, b] of pairs) {
      const first = decide(corpusById(a)!);
      const second = decide(corpusById(b)!);
      expect(first.decision, `${a}/${b} decision`).toBe(second.decision);
      expect(first.reasonCodes.join(','), `${a}/${b} codes`).toBe(second.reasonCodes.join(','));
      expect(first.requiredApprovals).toBe(second.requiredApprovals);
    }
    expect(actionHashOf(corpusById('R-27')!)).toBe(actionHashOf(corpusById('R-28')!));
  });
});
