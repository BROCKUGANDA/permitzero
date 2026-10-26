/**
 * Pinned policy revisions and document hashing.
 *
 * A "pinned" revision binds the exact document bytes to the hash the caller
 * loaded. The evaluator re-computes the hash on every call so a mismatched
 * document/hash pair fails closed instead of evaluating the wrong policy.
 */
import { canonicalHash } from '@permitzero/domain';
import type { PolicyRevisionStatus } from '@permitzero/domain';
import type { PolicyDocument } from '@permitzero/schemas';

export interface PinnedPolicyRevision {
  revisionId: string;
  policyId: string;
  tenantId: string;
  revisionNumber: number;
  document: PolicyDocument;
  /** `sha256:…` over the canonical document. Recomputed on every evaluation. */
  policyHash: string;
  status: PolicyRevisionStatus;
  publishedAt: Date | null;
}

/** Canonical hash of a policy document. Deterministic across processes. */
export function hashPolicyDocument(document: PolicyDocument): string {
  return canonicalHash(document);
}
