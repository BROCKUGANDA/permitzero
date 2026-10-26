/**
 * Policy repositories: policy definitions, immutable revisions and the atomic
 * publish pointer. Revision rows are never mutated after publish (the database
 * trigger enforces it); publishing only moves the pointer and marks the
 * previous head rolled back.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '@permitzero/domain';
import type { PolicyDocument } from '@permitzero/schemas';
import { isDbError, type DbExecutor } from '../client.js';
import { policies, policyRevisions } from '../schema.js';
import type { PolicyRevisionRow, PolicyRow } from '../schema.js';

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

export async function createPolicy(
  ex: DbExecutor,
  input: { id: string; tenantId: string; name: string; code: string; description?: string | null; createdBy?: string | null },
): Promise<PolicyRow> {
  const [row] = await ex
    .insert(policies)
    .values({
      policyId: input.id,
      tenantId: input.tenantId,
      name: input.name,
      code: input.code,
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error('policy insert returned no row');
  return row;
}

export async function getPolicyById(ex: DbExecutor, tenantId: string, id: string): Promise<PolicyRow | null> {
  return first(
    ex.select().from(policies).where(and(eq(policies.tenantId, tenantId), eq(policies.policyId, id))).limit(1),
  );
}

export async function getPolicyByCode(ex: DbExecutor, tenantId: string, code: string): Promise<PolicyRow | null> {
  return first(
    ex.select().from(policies).where(and(eq(policies.tenantId, tenantId), eq(policies.code, code))).limit(1),
  );
}

export async function listPolicies(ex: DbExecutor, tenantId: string): Promise<PolicyRow[]> {
  return ex.select().from(policies).where(eq(policies.tenantId, tenantId));
}

export async function createRevision(
  ex: DbExecutor,
  input: {
    id: string;
    tenantId: string;
    policyId: string;
    document: PolicyDocument;
    policyHash: string;
    changeReason?: string | null;
    createdBy?: string | null;
    fixtureCorpusVersion?: string | null;
  },
): Promise<PolicyRevisionRow> {
  // Revision numbers are dense per policy; a concurrent insert collides on the
  // unique number and retries with a fresh max+1.
  for (let attempt = 0; attempt < 3; attempt++) {
    const peak = await ex
      .select({ n: sql<number | null>`max(${policyRevisions.revisionNumber})` })
      .from(policyRevisions)
      .where(and(eq(policyRevisions.tenantId, input.tenantId), eq(policyRevisions.policyId, input.policyId)));
    const next = (peak[0]?.n ?? 0) + 1;
    try {
      const [row] = await ex
        .insert(policyRevisions)
        .values({
          revisionId: input.id,
          tenantId: input.tenantId,
          policyId: input.policyId,
          revisionNumber: next,
          policyJson: input.document as unknown as Record<string, unknown>,
          policyHash: input.policyHash,
          changeReason: input.changeReason ?? null,
          createdBy: input.createdBy ?? null,
          fixtureCorpusVersion: input.fixtureCorpusVersion ?? null,
        })
        .returning();
      if (!row) throw new Error('revision insert returned no row');
      return row;
    } catch (err) {
      if (isDbError(err, '23505') && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error('revision insert collided repeatedly');
}

export async function getRevision(
  ex: DbExecutor,
  tenantId: string,
  revisionId: string,
): Promise<PolicyRevisionRow | null> {
  return first(
    ex
      .select()
      .from(policyRevisions)
      .where(and(eq(policyRevisions.tenantId, tenantId), eq(policyRevisions.revisionId, revisionId)))
      .limit(1),
  );
}

export async function listRevisions(ex: DbExecutor, tenantId: string, policyId: string): Promise<PolicyRevisionRow[]> {
  return ex
    .select()
    .from(policyRevisions)
    .where(and(eq(policyRevisions.tenantId, tenantId), eq(policyRevisions.policyId, policyId)))
    .orderBy(asc(policyRevisions.revisionNumber));
}

/** The currently enforced revision, or null when nothing is published yet. */
export async function getPublishedRevision(
  ex: DbExecutor,
  tenantId: string,
  policyId: string,
): Promise<PolicyRevisionRow | null> {
  const policy = await getPolicyById(ex, tenantId, policyId);
  if (!policy || !policy.publishedRevisionId) return null;
  return getRevision(ex, tenantId, policy.publishedRevisionId);
}

export interface PublishInput {
  tenantId: string;
  policyId: string;
  revisionId: string;
  /** Optimistic concurrency: the head the publisher reviewed must still be head. */
  expectedCurrentRevisionId: string | null;
  now?: Date;
}

/**
 * Atomically move the publish pointer. Call inside `withTransaction`: the
 * pointer move, the new head's PUBLISHED mark and the old head's ROLLED_BACK
 * mark commit together or not at all.
 */
export async function publishRevision(
  ex: DbExecutor,
  input: PublishInput,
): Promise<{ policy: PolicyRow; revision: PolicyRevisionRow }> {
  const now = input.now ?? new Date();
  const policy = await getPolicyById(ex, input.tenantId, input.policyId);
  if (!policy) throw new NotFoundError('Policy not found or not accessible.');
  if (policy.publishedRevisionId !== input.expectedCurrentRevisionId) {
    throw new ConflictError('Policy head changed underneath this publish; reload and review again.');
  }
  const revision = await getRevision(ex, input.tenantId, input.revisionId);
  if (!revision) throw new NotFoundError('Policy revision not found or not accessible.');
  if (revision.policyId !== input.policyId) {
    throw new ValidationError('Revision does not belong to this policy.');
  }
  if (revision.status !== 'DRAFT' && revision.status !== 'READY') {
    throw new ConflictError(`Only draft or ready revisions can publish; this one is ${revision.status}.`);
  }

  if (policy.publishedRevisionId) {
    await ex
      .update(policyRevisions)
      .set({ status: 'ROLLED_BACK', rolledBackAt: now })
      .where(
        and(
          eq(policyRevisions.tenantId, input.tenantId),
          eq(policyRevisions.revisionId, policy.publishedRevisionId),
          eq(policyRevisions.status, 'PUBLISHED'),
        ),
      );
  }
  const [published] = await ex
    .update(policyRevisions)
    .set({ status: 'PUBLISHED', publishedAt: now })
    .where(and(eq(policyRevisions.tenantId, input.tenantId), eq(policyRevisions.revisionId, input.revisionId)))
    .returning();
  const [moved] = await ex
    .update(policies)
    .set({ publishedRevisionId: input.revisionId, version: policy.version + 1, updatedAt: now })
    .where(and(eq(policies.tenantId, input.tenantId), eq(policies.policyId, input.policyId)))
    .returning();
  if (!published || !moved) throw new Error('publish update returned no row');
  return { policy: moved, revision: published };
}
