/**
 * Provider webhook repositories: dedupe evidence plus the cross-tenant lookup
 * that ties a provider's own reference back to (tenant, action).
 *
 * The lookup iterates active tenants blind and then queries inside each
 * tenant's RLS context — the same shape the sweeps use. A dispatch that
 * cannot be found anywhere is reported, never guessed at.
 */
import { and, eq } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import type { Db, DbExecutor, DbTransaction } from '../client.js';
import { withTenantBlindTransaction, withTenantTransaction } from '../tenant.js';
import { listActiveTenantIds } from './identity.js';
import { connectorDispatches, webhookDeliveries } from '../schema.js';
import type { WebhookDeliveryRow } from '../schema.js';

export interface WebhookDeliveryInput {
  provider: string;
  deliveryId: string;
  providerRef: string | null;
}

export type DeliveryInsert = { kind: 'inserted'; traceId: string } | { kind: 'duplicate' };

const uniqueViolationCodes = new Set(['23505']);
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    uniqueViolationCodes.has((err as { code: string }).code)
  );
}

/**
 * Insert the dedupe row. The (provider, delivery_id) PK is the guard: a
 * redelivered webhook inserts nothing and returns 'duplicate'.
 */
export async function recordWebhookDelivery(ex: DbExecutor, input: WebhookDeliveryInput): Promise<DeliveryInsert> {
  const traceId = newId('trace');
  try {
    await ex.insert(webhookDeliveries).values({
      provider: input.provider,
      deliveryId: input.deliveryId,
      traceId,
      outcome: 'received',
      providerRef: input.providerRef,
    });
    return { kind: 'inserted', traceId };
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: 'duplicate' };
    throw err;
  }
}

export interface DeliveryOutcome {
  outcome:
    'enqueued' | 'ignored_event_type' | 'ignored_unknown_shape' | 'ignored_unknown_ref' | 'ignored_inactive_action';
  resolvedTenantId?: string | null;
  resolvedActionId?: string | null;
  providerRef?: string | null;
}

export async function finalizeWebhookDelivery(
  ex: DbExecutor,
  provider: string,
  deliveryId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  await ex
    .update(webhookDeliveries)
    .set({
      outcome: outcome.outcome,
      resolvedTenantId: outcome.resolvedTenantId ?? null,
      resolvedActionId: outcome.resolvedActionId ?? null,
      providerRef: outcome.providerRef ?? null,
    })
    .where(and(eq(webhookDeliveries.provider, provider), eq(webhookDeliveries.deliveryId, deliveryId)));
}

export interface ResolvedProviderRef {
  tenantId: string;
  connectorIdempotencyKey: string;
}

/**
 * Find the dispatch that carries a provider reference, across tenants.
 * Read-only, iterates active tenants blind, queries scoped — the same shape
 * the sweeps use, so RLS stays the enforcement.
 */
export async function findDispatchByProviderRef(db: Db, providerRef: string): Promise<ResolvedProviderRef | null> {
  const tenants = await withTenantBlindTransaction(db, (tx) => listActiveTenantIds(tx));
  for (const tenantId of tenants) {
    const rows = await withTenantTransaction(db, tenantId, (tx: DbTransaction) =>
      tx
        .select({ key: connectorDispatches.connectorIdempotencyKey })
        .from(connectorDispatches)
        .where(and(eq(connectorDispatches.tenantId, tenantId), eq(connectorDispatches.providerRef, providerRef)))
        .limit(1),
    );
    const row = rows[0];
    if (row) return { tenantId, connectorIdempotencyKey: row.key };
  }
  return null;
}

/** Any dispatch carrying this provider ref at all (evidence/audit counts). */
export async function countDispatchesWithProviderRef(ex: DbExecutor, providerRef: string): Promise<number> {
  const rows = await ex
    .select({ n: connectorDispatches.providerRef })
    .from(connectorDispatches)
    .where(eq(connectorDispatches.providerRef, providerRef))
    .limit(1);
  return rows.length;
}

export async function getWebhookDelivery(
  ex: DbExecutor,
  provider: string,
  deliveryId: string,
): Promise<WebhookDeliveryRow | null> {
  const rows = await ex
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.provider, provider), eq(webhookDeliveries.deliveryId, deliveryId)))
    .limit(1);
  return rows[0] ?? null;
}
