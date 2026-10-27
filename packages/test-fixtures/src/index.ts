/**
 * @permitzero/test-fixtures — the versioned adversarial/resilience corpus and the
 * helpers that turn it into a release gate.
 *
 * The corpus is data only: it performs no I/O and reads no clock, so the same
 * fixture decides the same way in every run and every environment. `corpusHash()`
 * content-addresses the expectations, which makes a silent edit to the corpus
 * visible in any report that records it.
 */
import { actionHash, canonicalHash, Decision } from '@permitzero/domain';
import type { PolicyDocument } from '@permitzero/schemas';
import { hashPolicyDocument } from '@permitzero/policy';
import type { PinnedPolicyRevision, SimulateCase } from '@permitzero/policy';
import { CORPUS_TENANT } from './builders.js';
import type { FixtureCase, FixtureGroup } from './corpus.js';
import { CORPUS_VERSION, corpus } from './corpus.js';

export * from './builders.js';
export * from './corpus.js';

export const FIXTURE_GROUPS: readonly FixtureGroup[] = ['normal', 'deny', 'approval', 'adversarial', 'resilience'];

/** Look up one fixture by its stable id. */
export function corpusById(id: string): FixtureCase | undefined {
  return corpus().find((f) => f.id === id);
}

/** Every fixture in one group, in corpus order. */
export function corpusByGroup(group: FixtureGroup): readonly FixtureCase[] {
  return corpus().filter((f) => f.group === group);
}

/** The release-gating subset: actions that must never end as ALLOW. */
export function forbiddenCorpus(): readonly FixtureCase[] {
  return corpus().filter((f) => f.unsafe);
}

/**
 * Content address of the corpus: ids, labels, gate membership, expected
 * decisions and the proposed arguments that bind them.
 */
export function corpusHash(): string {
  return canonicalHash({
    corpusVersion: CORPUS_VERSION,
    fixtures: corpus().map((f) => ({
      id: f.id,
      label: f.label,
      unsafe: f.unsafe,
      expectedDecision: f.expectedDecision,
      expectedReasonCode: f.expectedReasonCode ?? null,
      arguments: f.input.arguments,
    })),
  });
}

export interface CorpusSummary {
  corpusVersion: string;
  corpusHash: string;
  total: number;
  unsafe: number;
  byGroup: Record<FixtureGroup, number>;
  byExpectedDecision: Record<Decision, number>;
  byExpectedReasonCode: Record<string, number>;
}

/** Counts per group and per expected decision — feeds the release report command. */
export function corpusSummary(): CorpusSummary {
  const byGroup = {
    normal: 0,
    deny: 0,
    approval: 0,
    adversarial: 0,
    resilience: 0,
  } as Record<FixtureGroup, number>;
  const byExpectedReasonCode: Record<string, number> = {};
  const byExpectedDecision = {
    [Decision.ALLOW]: 0,
    [Decision.DENY]: 0,
    [Decision.REQUIRE_APPROVAL]: 0,
    [Decision.INDETERMINATE]: 0,
  } as Record<Decision, number>;
  let unsafe = 0;
  for (const f of corpus()) {
    byGroup[f.group] += 1;
    byExpectedDecision[f.expectedDecision] += 1;
    if (f.unsafe) unsafe += 1;
    const code = f.expectedReasonCode ?? 'NO_EXPECTED_CODE';
    byExpectedReasonCode[code] = (byExpectedReasonCode[code] ?? 0) + 1;
  }
  return {
    corpusVersion: CORPUS_VERSION,
    corpusHash: corpusHash(),
    total: corpus().length,
    unsafe,
    byGroup,
    byExpectedDecision,
    byExpectedReasonCode,
  };
}

/**
 * Pin a policy document to a self-consistent revision. The evaluator recomputes
 * the document hash on every call, so `policyHash` is always derived from the
 * document it is paired with — a hand-written hash would fail closed.
 */
export function pinnedRevisionOf(
  document: PolicyDocument,
  overrides: Partial<PinnedPolicyRevision> = {},
): PinnedPolicyRevision {
  return {
    revisionId: 'polrev_corpus_001',
    policyId: 'pol_ap_protect_01',
    tenantId: CORPUS_TENANT,
    revisionNumber: 1,
    document,
    policyHash: hashPolicyDocument(document),
    status: 'PUBLISHED',
    publishedAt: new Date('2026-10-26T11:00:00Z'),
    ...overrides,
  };
}

/** The corpus projected onto the simulation contract. */
export function simulateCases(fixtures: readonly FixtureCase[] = corpus()): SimulateCase[] {
  return fixtures.map((f) => ({ fixtureId: f.id, label: f.label, input: f.input }));
}

/**
 * Canonical action hash of a fixture. Two fixtures with the same hash are the
 * same authorized intent (replay); a difference in the arguments is the mutation
 * an approval must not survive.
 */
export function actionHashOf(fixture: FixtureCase): string {
  const i = fixture.input;
  return actionHash({
    tenantId: i.tenantId,
    agentId: i.agent.agentId,
    runId: i.runId,
    toolName: i.toolName,
    operation: i.operation,
    arguments: i.arguments,
    environment: i.environment,
  });
}
