/**
 * Action repositories: the action lifecycle, approvals and idempotency
 * records. State transitions are compare-and-swap on `(id, tenant, version)`
 * after `assertTransition` validation; illegal transitions throw (a bug), lost
 * races return typed conflicts.
 */
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { assertTransition } from '@permitzero/domain';
import type { ActionState, ActorType, Environment, EvidenceRef, RiskSignal } from '@permitzero/domain';
import type { ActionTransitionInput, ActionTransitionResult } from '@permitzero/broker';
import type { DbExecutor } from '../client.js';
import { assertSafeMinor, toActionRecord } from '../mappers.js';
import { actions, approvals, idempotencyRecords } from '../schema.js';
import type { ActionRow, ApprovalRow, IdempotencyRecordRow } from '../schema.js';

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

export interface CreateActionInput {
  actionId: string;
  tenantId: string;
  agentId: string;
  runId: string;
  toolName: string;
  operation: string;
  taskPurpose: string;
  argumentsRedacted: Record<string, unknown>;
  argumentsHash: string;
  hashVersion: string;
  evidenceRefs: readonly EvidenceRef[];
  idempotencyKey: string;
  requestedAt: Date;
  environment: Environment;
  requiredApprovals?: number;
  expiresAt?: Date | null;
  traceId: string;
  createdByActorId: string;
  createdByActorType: ActorType;
}

export async function createAction(ex: DbExecutor, input: CreateActionInput): Promise<ActionRow> {
  const [row] = await ex
    .insert(actions)
    .values({
      actionId: input.actionId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      runId: input.runId,
      toolName: input.toolName,
      operation: input.operation,
      taskPurpose: input.taskPurpose,
      argumentsJsonRedacted: input.argumentsRedacted,
      argumentsHash: input.argumentsHash,
      hashVersion: input.hashVersion,
      evidenceRefsJson: input.evidenceRefs.map((r) => ({ ...r })),
      idempotencyKey: input.idempotencyKey,
      state: 'RECEIVED',
      requestedAt: input.requestedAt,
      environment: input.environment,
      requiredApprovals: input.requiredApprovals ?? 0,
      expiresAt: input.expiresAt ?? null,
      traceId: input.traceId,
      createdByActorId: input.createdByActorId,
      createdByActorType: input.createdByActorType,
    })
    .returning();
  if (!row) throw new Error('action insert returned no row');
  return row;
}

export async function getAction(ex: DbExecutor, tenantId: string, actionId: string): Promise<ActionRow | null> {
  return first(
    ex.select().from(actions).where(and(eq(actions.tenantId, tenantId), eq(actions.actionId, actionId))).limit(1),
  );
}

export async function getActionByIdempotency(
  ex: DbExecutor,
  tenantId: string,
  agentId: string,
  idempotencyKey: string,
): Promise<ActionRow | null> {
  return first(
    ex
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.tenantId, tenantId),
          eq(actions.agentId, agentId),
          eq(actions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1),
  );
}

export async function transitionAction(ex: DbExecutor, input: ActionTransitionInput): Promise<ActionTransitionResult> {
  const row = await getAction(ex, input.tenantId, input.actionId);
  if (!row) {
    return { ok: false, reason: 'NOT_FOUND', detail: `action ${input.actionId} not found`, current: null };
  }
  // Illegal transitions are bugs: loud, matching the broker port contract.
  assertTransition(row.state, input.to);
  if (input.expectedFrom !== undefined && row.state !== input.expectedFrom) {
    return {
      ok: false,
      reason: 'STATE_MISMATCH',
      detail: `expected state ${input.expectedFrom} but found ${row.state}`,
      current: toActionRecord(row),
    };
  }
  const patch = input.patch ?? {};
  const updated = await ex
    .update(actions)
    .set({
      state: input.to,
      version: row.version + 1,
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
      ...(patch.decisionReasonCodes !== undefined ? { decisionReasonCodesJson: [...patch.decisionReasonCodes] } : {}),
      ...(patch.policyRevisionId !== undefined ? { policyRevisionId: patch.policyRevisionId } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    })
    .where(
      and(eq(actions.tenantId, input.tenantId), eq(actions.actionId, input.actionId), eq(actions.version, input.expectedVersion)),
    )
    .returning();
  const next = updated[0];
  if (!next) {
    const reread = await getAction(ex, input.tenantId, input.actionId);
    if (!reread) {
      return { ok: false, reason: 'NOT_FOUND', detail: `action ${input.actionId} not found`, current: null };
    }
    return {
      ok: false,
      reason: 'VERSION_CONFLICT',
      detail: `expected version ${input.expectedVersion} but found ${reread.version}`,
      current: toActionRecord(reread),
      expectedVersion: input.expectedVersion,
      actualVersion: reread.version,
    };
  }
  return { ok: true, action: toActionRecord(next) };
}

/**
 * Persist evaluation byproducts the transition patch cannot carry. Call in the
 * same transaction as the decision transition so the two never diverge.
 */
export async function setActionDecisionExtras(
  ex: DbExecutor,
  input: { tenantId: string; actionId: string; riskSignals?: readonly RiskSignal[]; requiredApprovals?: number },
): Promise<void> {
  await ex
    .update(actions)
    .set({
      ...(input.riskSignals !== undefined ? { riskSignalsJson: [...input.riskSignals] } : {}),
      ...(input.requiredApprovals !== undefined ? { requiredApprovals: input.requiredApprovals } : {}),
    })
    .where(and(eq(actions.tenantId, input.tenantId), eq(actions.actionId, input.actionId)));
}

export interface ListActionsFilters {
  /** Unknown states simply match nothing; the route casts the raw query string. */
  states?: ActionState[];
  agentId?: string;
  runId?: string;
  toolName?: string;
  vendorId?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  reasonCode?: string;
  from?: Date;
  to?: Date;
}

export interface ListActionsResult {
  rows: ActionRow[];
  nextCursor: string | null;
}

function encodeCursor(requestedAt: Date, actionId: string): string {
  return Buffer.from(JSON.stringify({ t: requestedAt.toISOString(), a: actionId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { t: string; a: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; a?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.a !== 'string') return null;
    return { t: parsed.t, a: parsed.a };
  } catch {
    return null;
  }
}

export async function listActions(
  ex: DbExecutor,
  tenantId: string,
  filters: ListActionsFilters,
  opts: { limit: number; cursor?: string | null },
): Promise<ListActionsResult> {
  const conditions = [eq(actions.tenantId, tenantId)];
  if (filters.states && filters.states.length > 0) {
    // inArray, not `= ANY(array-literal)`: the driver binds JS arrays as
    // scalar strings, which postgres rejects as a malformed array literal.
    conditions.push(inArray(actions.state, filters.states));
  }
  if (filters.agentId) conditions.push(eq(actions.agentId, filters.agentId));
  if (filters.runId) conditions.push(eq(actions.runId, filters.runId));
  if (filters.toolName) conditions.push(eq(actions.toolName, filters.toolName));
  if (filters.vendorId) conditions.push(sql`${actions.argumentsJsonRedacted}->>'vendor_id' = ${filters.vendorId}`);
  if (filters.minAmountMinor !== undefined) {
    conditions.push(sql`(${actions.argumentsJsonRedacted}->>'amount_minor')::bigint >= ${filters.minAmountMinor}`);
  }
  if (filters.maxAmountMinor !== undefined) {
    conditions.push(sql`(${actions.argumentsJsonRedacted}->>'amount_minor')::bigint <= ${filters.maxAmountMinor}`);
  }
  if (filters.reasonCode) conditions.push(sql`${actions.decisionReasonCodesJson} ? ${filters.reasonCode}`);
  // Dates cross into raw SQL as ISO text: the driver serializes bound Date
  // objects unreliably inside `sql` fragments, while timestamptz parses ISO.
  if (filters.from) conditions.push(sql`${actions.requestedAt} >= ${filters.from.toISOString()}`);
  if (filters.to) conditions.push(sql`${actions.requestedAt} <= ${filters.to.toISOString()}`);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    conditions.push(sql`(${actions.requestedAt}, ${actions.actionId}) < (${cursor.t}::timestamptz, ${cursor.a})`);
  }
  const rows = await ex
    .select()
    .from(actions)
    .where(and(...conditions))
    .orderBy(desc(actions.requestedAt), desc(actions.actionId))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > opts.limit && last ? encodeCursor(last.requestedAt, last.actionId) : null,
  };
}

/** Velocity: actions by this agent since `since` (for `velocity.count`). */
export async function countAgentActionsSince(
  ex: DbExecutor,
  tenantId: string,
  agentId: string,
  since: Date,
): Promise<number> {
  const rows = await ex
    .select({ n: sql<number>`count(*)` })
    .from(actions)
    .where(and(eq(actions.tenantId, tenantId), eq(actions.agentId, agentId), sql`${actions.requestedAt} >= ${since.toISOString()}`));
  return Number(rows[0]?.n ?? 0);
}

export async function countActionsInRun(ex: DbExecutor, tenantId: string, runId: string): Promise<number> {
  const rows = await ex
    .select({ n: sql<number>`count(*)` })
    .from(actions)
    .where(and(eq(actions.tenantId, tenantId), eq(actions.runId, runId)));
  return Number(rows[0]?.n ?? 0);
}

/** Budget: sum of succeeded payment amounts since `since`, in minor units. */
export async function sumSucceededPaymentsSince(ex: DbExecutor, tenantId: string, since: Date): Promise<number> {
  const rows = await ex
    .select({ total: sql<bigint | null>`COALESCE(SUM((${actions.argumentsJsonRedacted}->>'amount_minor')::bigint), 0)` })
    .from(actions)
    .where(
      and(
        eq(actions.tenantId, tenantId),
        eq(actions.toolName, 'payment.execute'),
        eq(actions.state, 'SUCCEEDED'),
        sql`${actions.requestedAt} >= ${since.toISOString()}`,
      ),
    );
  return assertSafeMinor(rows[0]?.total ?? 0n, 'budget spend');
}

/**
 * Approval windows that lapsed without a quorum. The worker sweeps these to
 * EXPIRED; cross-tenant by design (service role), oldest first.
 */
export async function listExpiredApprovalActions(ex: DbExecutor, now: Date, limit: number): Promise<ActionRow[]> {
  return ex
    .select()
    .from(actions)
    .where(and(eq(actions.state, 'APPROVAL_REQUIRED'), lte(actions.expiresAt, now)))
    .orderBy(asc(actions.expiresAt))
    .limit(limit);
}

export interface CreateApprovalInput {
  approvalId: string;
  tenantId: string;
  actionId: string;
  actionHash: string;
  policyRevisionId: string;
  approverUserId: string;
  decision: ApprovalRow['decision'];
  reasonCode: string;
  reasonTextRedacted?: string | null;
  expiresAt?: Date | null;
  mfaContextRef?: string | null;
}

export async function createApproval(ex: DbExecutor, input: CreateApprovalInput): Promise<ApprovalRow> {
  const [row] = await ex
    .insert(approvals)
    .values({
      approvalId: input.approvalId,
      tenantId: input.tenantId,
      actionId: input.actionId,
      actionHash: input.actionHash,
      policyRevisionId: input.policyRevisionId,
      approverUserId: input.approverUserId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      reasonTextRedacted: input.reasonTextRedacted ?? null,
      expiresAt: input.expiresAt ?? null,
      mfaContextRef: input.mfaContextRef ?? null,
    })
    .returning();
  if (!row) throw new Error('approval insert returned no row');
  return row;
}

export async function listApprovalsByAction(ex: DbExecutor, tenantId: string, actionId: string): Promise<ApprovalRow[]> {
  return ex
    .select()
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.actionId, actionId)))
    .orderBy(asc(approvals.approvedAt));
}

export async function findIdempotencyRecord(
  ex: DbExecutor,
  tenantId: string,
  principalId: string,
  idempotencyKey: string,
): Promise<IdempotencyRecordRow | null> {
  return first(
    ex
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.tenantId, tenantId),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1),
  );
}

export async function createIdempotencyRecord(
  ex: DbExecutor,
  input: {
    id: string;
    tenantId: string;
    principalId: string;
    principalType?: IdempotencyRecordRow['principalType'];
    idempotencyKey: string;
    requestHash: string;
    resourceType?: string | null;
    expiresAt?: Date | null;
  },
): Promise<IdempotencyRecordRow> {
  const [row] = await ex
    .insert(idempotencyRecords)
    .values({
      idempotencyId: input.id,
      tenantId: input.tenantId,
      principalId: input.principalId,
      principalType: input.principalType ?? 'USER',
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      resourceType: input.resourceType ?? null,
      status: 'IN_PROGRESS',
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error('idempotency insert returned no row');
  return row;
}

export async function completeIdempotencyRecord(
  ex: DbExecutor,
  input: { id: string; tenantId: string; responseSnapshot: Record<string, unknown>; httpStatus: number; resourceId?: string | null },
): Promise<void> {
  await ex
    .update(idempotencyRecords)
    .set({
      status: 'COMPLETED',
      responseSnapshotRedacted: input.responseSnapshot,
      httpStatus: input.httpStatus,
      resourceId: input.resourceId ?? null,
    })
    .where(and(eq(idempotencyRecords.idempotencyId, input.id), eq(idempotencyRecords.tenantId, input.tenantId)));
}

export async function failIdempotencyRecord(ex: DbExecutor, id: string, tenantId: string): Promise<void> {
  await ex
    .update(idempotencyRecords)
    .set({ status: 'FAILED' })
    .where(and(eq(idempotencyRecords.idempotencyId, id), eq(idempotencyRecords.tenantId, tenantId)));
}
