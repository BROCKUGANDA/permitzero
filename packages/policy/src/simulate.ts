/**
 * Side-effect-free policy simulation for the Replay Lab.
 *
 * Purity is structural: `evaluatePolicy` performs no I/O, holds no credentials
 * and reads no clock except from its input, so simulation cannot reach a
 * connector no matter what the candidate revision says.
 */
import type { PolicyEvaluationInput, PolicyEvaluationResult } from '@permitzero/domain';
import { evaluatePolicy } from './evaluate.js';
import type { PinnedPolicyRevision } from './revision.js';

export interface SimulateOptions {
  maxFixtures: number;
}

export const DEFAULT_MAX_FIXTURES = 500;

export interface SimulateCase {
  fixtureId: string;
  label: string;
  input: PolicyEvaluationInput;
}

export interface SimulateCaseResult {
  fixtureId: string;
  label: string;
  result: PolicyEvaluationResult;
}

export function simulatePolicy(
  cases: ReadonlyArray<SimulateCase>,
  revision: PinnedPolicyRevision,
  options?: SimulateOptions,
): SimulateCaseResult[] {
  const max = options?.maxFixtures ?? DEFAULT_MAX_FIXTURES;
  if (cases.length > max) {
    // Never truncate silently: a dropped fixture could be the one that proves a
    // candidate policy newly allows a forbidden action.
    throw new RangeError(
      `simulatePolicy: ${cases.length} cases exceed maxFixtures ${max}; batch explicitly so no case is silently dropped.`,
    );
  }
  return cases.map((c) => ({
    fixtureId: c.fixtureId,
    label: c.label,
    result: evaluatePolicy(c.input, revision),
  }));
}
