/**
 * Execution repositories: permits and execution attempts. Permit consumption
 * is a single conditional UPDATE (`consumed_at IS NULL AND revoked_at IS
 * NULL`); exactly one concurrent consumer wins and revocation always wins the
 * race against consumption.
 *
 * The execution receipt is stored ENCRYPTED and read back in the clear. A
 * receipt carries the external reference, the amount and the beneficiary
 * reference of a payment that actually happened — the most concrete personal
 * and financial data this schema holds — so it is not left in the clear in a
 * backup. The mapper that turns a receipt row into a domain receipt is
 * unchanged: the repository decrypts at the boundary, so every consumer sees
 * what it always saw.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ExecutionResultUpdate, PersistedExecution, PersistedPermit } from '@permitzero/broker';
import type { DbExecutor } from '../client.js';
import { currentKey, deriveKey, encryptNullableColumn, readColumn, verificationKeys } from '../crypto.js';
import { toPersistedPermit } from '../mappers.js';
import { executions, permits } from '../schema.js';
import type { ExecutionRow, PermitRow } from '../schema.js';

/** The domain-separation label for the execution receipt's encryption key. */
const EXECUTION_PAYLOAD_PURPOSE = 'execution-payload';

/** The keys that may decrypt an execution receipt. */
function payloadKeys(explicit?: string | null): Buffer[] {
  const masters: string[] = [];
  for (const master of [explicit, ...verificationKeys()]) {
    if (typeof master === 'string' && master.length > 0 && !masters.includes(master)) masters.push(master);
  }
  return masters.map((master) => deriveKey(master, EXECUTION_PAYLOAD_PURPOSE));
}

/**
 * The row as the application sees it: the receipt in the clear.
 *
 * A receipt written before encryption was enabled holds plaintext and is read
 * as it is, so encryption can be switched on without rewriting the execution
 * history.
 */
function withDecryptedReceipt(row: ExecutionRow, keys: readonly Buffer[]): ExecutionRow {
  return { ...row, receiptJson: readColumn<Record<string, unknown> | null>(row.receiptJson, keys) };
}

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

function serializeReceipt(receipt: PersistedExecution['receipt']): Record<string, unknown> | null {
  if (!receipt) return null;
  return {
    externalReference: receipt.externalReference,
    receiptHash: receipt.receiptHash,
    amountMinor: receipt.amountMinor,
    currency: receipt.currency,
    beneficiaryRef: receipt.beneficiaryRef,
    completedAt: receipt.completedAt.toISOString(),
    simulated: receipt.simulated,
  };
}

export async function insertPermit(ex: DbExecutor, permit: PersistedPermit): Promise<PermitRow> {
  const [row] = await ex
    .insert(permits)
    .values({
      permitId: permit.permitId,
      tenantId: permit.tenantId,
      actionId: permit.actionId,
      actionHash: permit.actionHash,
      policyRevisionId: permit.policyRevisionId,
      audienceTool: permit.audienceTool,
      nonceHash: permit.nonceHash,
      issuedAt: permit.issuedAt,
      expiresAt: permit.expiresAt,
      tokenHash: permit.tokenHash,
      signatureKeyId: permit.signatureKeyId,
    })
    .returning();
  if (!row) throw new Error('permit insert returned no row');
  return row;
}

export async function consumePermit(
  ex: DbExecutor,
  permitId: string,
  tenantId: string,
  now: Date,
): Promise<{ consumed: boolean; row: PersistedPermit | null }> {
  // Single statement: exactly one concurrent consumer wins, and revocation
  // always wins the race against consumption.
  const updated = await ex
    .update(permits)
    .set({ consumedAt: now, version: sql`${permits.version} + 1` })
    .where(
      and(
        eq(permits.permitId, permitId),
        eq(permits.tenantId, tenantId),
        isNull(permits.consumedAt),
        isNull(permits.revokedAt),
      ),
    )
    .returning();
  const row = updated[0] ?? null;
  if (!row) {
    const current = await getPermit(ex, tenantId, permitId);
    return { consumed: false, row: current ? toPersistedPermit(current) : null };
  }
  return { consumed: true, row: toPersistedPermit(row) };
}

export async function findPermitByTokenHash(
  ex: DbExecutor,
  tokenHash: string,
  tenantId: string,
): Promise<PermitRow | null> {
  return first(
    ex
      .select()
      .from(permits)
      .where(and(eq(permits.tokenHash, tokenHash), eq(permits.tenantId, tenantId)))
      .limit(1),
  );
}

/** Latest permit issued for an action, for read models. Never returns the token (it is not stored). */
export async function findLatestPermitByAction(
  ex: DbExecutor,
  tenantId: string,
  actionId: string,
): Promise<PermitRow | null> {
  return first(
    ex
      .select()
      .from(permits)
      .where(and(eq(permits.tenantId, tenantId), eq(permits.actionId, actionId)))
      .orderBy(desc(permits.issuedAt))
      .limit(1),
  );
}

export async function getPermit(ex: DbExecutor, tenantId: string, permitId: string): Promise<PermitRow | null> {
  return first(
    ex
      .select()
      .from(permits)
      .where(and(eq(permits.tenantId, tenantId), eq(permits.permitId, permitId)))
      .limit(1),
  );
}

/** Best-effort idempotent revoke: consumed permits are left alone (they are spent). */
export async function revokePermit(
  ex: DbExecutor,
  tenantId: string,
  permitId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await ex
    .update(permits)
    .set({ revokedAt: now, revocationReason: reason })
    .where(
      and(
        eq(permits.tenantId, tenantId),
        eq(permits.permitId, permitId),
        isNull(permits.consumedAt),
        isNull(permits.revokedAt),
      ),
    );
}

export async function revokePermitsByAction(
  ex: DbExecutor,
  tenantId: string,
  actionId: string,
  reason: string,
  now: Date,
): Promise<number> {
  const updated = await ex
    .update(permits)
    .set({ revokedAt: now, revocationReason: reason })
    .where(
      and(
        eq(permits.tenantId, tenantId),
        eq(permits.actionId, actionId),
        isNull(permits.consumedAt),
        isNull(permits.revokedAt),
      ),
    )
    .returning({ permitId: permits.permitId });
  return updated.length;
}

export async function insertExecution(
  ex: DbExecutor,
  execution: PersistedExecution,
  opts?: { hmacKey?: string | null },
): Promise<ExecutionRow> {
  const master = opts?.hmacKey ?? currentKey();
  const receipt = serializeReceipt(execution.receipt);
  const [row] = await ex
    .insert(executions)
    .values({
      executionId: execution.executionId,
      tenantId: execution.tenantId,
      actionId: execution.actionId,
      connectorId: execution.connectorId,
      attemptNumber: execution.attemptNumber,
      connectorIdempotencyKey: execution.connectorIdempotencyKey,
      state: execution.state,
      dispatchStartedAt: execution.dispatchStartedAt,
      resultReceivedAt: execution.resultReceivedAt,
      externalReference: execution.externalReference,
      receiptHash: execution.receiptHash,
      receiptJson: master ? encryptNullableColumn(receipt, deriveKey(master, EXECUTION_PAYLOAD_PURPOSE)) : receipt,
      errorClass: execution.errorClass,
      retryAfterAt: execution.retryAfterAt,
      permitId: execution.permitId,
      permitNonceHash: execution.permitNonceHash,
      actorId: execution.actorId,
      traceId: execution.traceId,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
    })
    .returning();
  if (!row) throw new Error('execution insert returned no row');
  return withDecryptedReceipt(row, payloadKeys(master));
}

export async function markExecutionDispatched(
  ex: DbExecutor,
  executionId: string,
  tenantId: string,
  dispatchStartedAt: Date,
): Promise<ExecutionRow | null> {
  const updated = await ex
    .update(executions)
    .set({ state: 'DISPATCHING', dispatchStartedAt, updatedAt: dispatchStartedAt })
    .where(
      and(
        eq(executions.executionId, executionId),
        eq(executions.tenantId, tenantId),
        eq(executions.state, 'INTENT_RECORDED'),
      ),
    )
    .returning();
  const keys = payloadKeys();
  if (updated[0]) return withDecryptedReceipt(updated[0], keys);
  const row = await first(
    ex
      .select()
      .from(executions)
      .where(and(eq(executions.executionId, executionId), eq(executions.tenantId, tenantId)))
      .limit(1),
  );
  return row ? withDecryptedReceipt(row, keys) : null;
}

export async function markExecutionResult(
  ex: DbExecutor,
  update: ExecutionResultUpdate,
  opts?: { hmacKey?: string | null },
): Promise<ExecutionRow | null> {
  const master = opts?.hmacKey ?? currentKey();
  const receipt = update.receipt !== undefined ? serializeReceipt(update.receipt) : undefined;
  const updated = await ex
    .update(executions)
    .set({
      state: update.state,
      resultReceivedAt: update.resultReceivedAt,
      ...(update.externalReference !== undefined ? { externalReference: update.externalReference } : {}),
      ...(update.receiptHash !== undefined ? { receiptHash: update.receiptHash } : {}),
      ...(receipt !== undefined
        ? {
            receiptJson: master
              ? encryptNullableColumn(receipt, deriveKey(master, EXECUTION_PAYLOAD_PURPOSE))
              : receipt,
          }
        : {}),
      ...(update.errorClass !== undefined ? { errorClass: update.errorClass } : {}),
      ...(update.retryAfterAt !== undefined ? { retryAfterAt: update.retryAfterAt } : {}),
      updatedAt: update.resultReceivedAt,
    })
    .where(and(eq(executions.executionId, update.executionId), eq(executions.tenantId, update.tenantId)))
    .returning();
  return updated[0] ? withDecryptedReceipt(updated[0], payloadKeys(master)) : null;
}

export async function findLatestExecutionByAction(
  ex: DbExecutor,
  actionId: string,
  tenantId: string,
): Promise<ExecutionRow | null> {
  const row = await first(
    ex
      .select()
      .from(executions)
      .where(and(eq(executions.actionId, actionId), eq(executions.tenantId, tenantId)))
      .orderBy(desc(executions.attemptNumber))
      .limit(1),
  );
  return row ? withDecryptedReceipt(row, payloadKeys()) : null;
}

export async function findExecutionByConnectorKey(
  ex: DbExecutor,
  connectorIdempotencyKey: string,
  tenantId: string,
): Promise<ExecutionRow | null> {
  const row = await first(
    ex
      .select()
      .from(executions)
      .where(and(eq(executions.connectorIdempotencyKey, connectorIdempotencyKey), eq(executions.tenantId, tenantId)))
      .orderBy(desc(executions.attemptNumber))
      .limit(1),
  );
  return row ? withDecryptedReceipt(row, payloadKeys()) : null;
}

export async function listUnknownOutcomeExecutions(
  ex: DbExecutor,
  tenantId: string | null,
  limit = 100,
): Promise<ExecutionRow[]> {
  const conditions =
    tenantId === null
      ? [eq(executions.state, 'UNKNOWN_OUTCOME')]
      : [eq(executions.state, 'UNKNOWN_OUTCOME'), eq(executions.tenantId, tenantId)];
  const rows = await ex
    .select()
    .from(executions)
    .where(and(...conditions))
    .orderBy(desc(executions.createdAt))
    .limit(limit);
  const keys = payloadKeys();
  return rows.map((row) => withDecryptedReceipt(row, keys));
}
