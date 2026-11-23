/**
 * Provider webhooks — the inbound provenance half of the live finance path.
 *
 * Wise calls this route on `transfers#state-change`. What makes it trustworthy:
 *
 *  - The signature is verified against Wise's PUBLIC key (PEM in
 *    `WISE_WEBHOOK_PUBLIC_KEY`) over the RAW body bytes. A bad or missing
 *    signature gets 401/403 and nothing else happens.
 *  - The route is registered only when that key is configured (fail closed).
 *  - Every delivery is recorded with its `X-Delivery-Id` BEFORE any work; a
 *    fully-processed redelivery is acknowledged without being re-processed.
 *  - The tenant is resolved by the provider's own reference number, iterated
 *    across active tenants with RLS-scoped reads — never guessed, never
 *    trusted from the payload beyond the reference.
 *  - A found transfer enqueues the existing `execution.unknown_outcome` event
 *    on `pz.reconciliation`; the existing consumer reconciles it against
 *    provider truth. The webhook never flips money state itself.
 *
 * The ack contract with Wise: 200 once we hold the delivery durably; 4xx for
 * anything we refuse (they alert); 5xx only when OUR storage failed so Wise
 * retries. Unknown references are acked 200 and recorded as
 * `ignored_unknown_ref` — retrying them would never succeed.
 */
import {
  decodeWiseWebhookPublicKey,
  WiseWebhookError,
  parseWiseStateChangeEvent,
  verifyWiseWebhookSignature,
} from '@permitzero/connectors';
import { eq, desc } from 'drizzle-orm';
import {
  finalizeWebhookDelivery,
  findDispatchByProviderRef,
  findExecutionByConnectorKey,
  getWebhookDelivery,
  insertOutboxEvent,
  recordWebhookDelivery,
  schema,
  tenantScope,
  withTransaction,
} from '@permitzero/db';
import { ForbiddenError, UnauthenticatedError } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

const PROVIDER = 'wise';

export async function webhookRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  const pem = ctx.config.wiseWebhookPublicKey ? decodeWiseWebhookPublicKey(ctx.config.wiseWebhookPublicKey) : null;
  if (!pem) {
    // No key configured: no route. Fail closed.
    return;
  }

  // Raw-body parser scoped to this plugin only — the signature is over bytes,
  // and a re-serialized JSON object would not verify.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  });

  app.post('/webhooks/wise', async (request, reply) => {
    const deliveryIdHeader = request.headers['x-delivery-id'];
    const signatureHeader = request.headers['x-signature-sha256'];
    const deliveryId =
      typeof deliveryIdHeader === 'string' && deliveryIdHeader.trim().length > 0 ? deliveryIdHeader.trim() : null;
    const signature =
      typeof signatureHeader === 'string' && signatureHeader.trim().length > 0 ? signatureHeader.trim() : null;
    if (!deliveryId || !signature) {
      throw new ForbiddenError('Missing delivery id or signature header.');
    }
    const rawBody = request.body as Buffer;

    try {
      verifyWiseWebhookSignature(rawBody, signature, pem);
    } catch (err) {
      if (err instanceof WiseWebhookError) {
        throw new ForbiddenError('The webhook signature did not verify.');
      }
      throw err;
    }

    const testNotification = request.headers['x-test-notification'] === 'true';
    if (testNotification) {
      // Wise sends exactly one of these per subscription setup; log and ack.
      return reply.code(200).send({ status: 'test_acknowledged' });
    }

    // Parse before recording, so a malformed body never occupies a delivery id.
    let parsed;
    try {
      parsed = parseWiseStateChangeEvent(rawBody);
    } catch (err) {
      if (err instanceof WiseWebhookError && err.reason === 'EVENT_NOT_STATE_CHANGE') {
        return reply.code(200).send({ status: 'ignored', reason: 'event_type' });
      }
      throw new ForbiddenError('The webhook body could not be parsed.');
    }

    // Dedupe by delivery id: insert wins → we process; a duplicate whose
    // previous attempt never finished (outcome 'received') is re-processed;
    // anything else is acknowledged without rework.
    const dedupe = await withTransaction(ctx.runtime, (tx) =>
      recordWebhookDelivery(tx, { provider: PROVIDER, deliveryId, providerRef: parsed.providerRef }),
    );
    let traceId: string | null = dedupe.kind === 'inserted' ? dedupe.traceId : null;
    if (dedupe.kind === 'duplicate') {
      const existing = await withTransaction(ctx.runtime, (tx) => getWebhookDelivery(tx, PROVIDER, deliveryId));
      if (existing && existing.outcome !== 'received') {
        return reply.code(200).send({ status: 'duplicate', outcome: existing.outcome });
      }
      traceId = existing?.traceId ?? null;
    }

    // Resolve (tenant, execution) for the provider's reference.
    const dispatch = await findDispatchByProviderRef(ctx.runtime, parsed.providerRef);
    if (!dispatch) {
      await withTransaction(ctx.runtime, (tx) =>
        finalizeWebhookDelivery(tx, PROVIDER, deliveryId, {
          outcome: 'ignored_unknown_ref',
          providerRef: parsed.providerRef,
        }),
      );
      return reply.code(200).send({ status: 'ignored', reason: 'unknown_provider_ref' });
    }

    const scope = tenantScope(ctx.runtime, dispatch.tenantId);
    const enqueuedActionId = await scope(async (ex) => {
      const execution = await findExecutionByConnectorKey(ex, dispatch.connectorIdempotencyKey, dispatch.tenantId);
      if (!execution) return null;
      await insertOutboxEvent(ex, {
        tenantId: dispatch.tenantId,
        aggregateType: 'execution',
        aggregateId: execution.executionId,
        eventType: 'execution.unknown_outcome',
        queueName: 'pz.reconciliation',
        payload: {
          action_id: execution.actionId,
          provider_ref: parsed.providerRef,
          delivery_id: deliveryId,
          provider_status: parsed.status,
          reason: 'provider_reported',
        },
        ...(traceId ? { traceId } : {}),
      });
      return execution.actionId;
    });

    await withTransaction(ctx.runtime, (tx) =>
      finalizeWebhookDelivery(tx, PROVIDER, deliveryId, {
        outcome: enqueuedActionId ? 'enqueued' : 'ignored_inactive_action',
        resolvedTenantId: dispatch.tenantId,
        resolvedActionId: enqueuedActionId,
        providerRef: parsed.providerRef,
      }),
    );

    ctx.stores.audit
      .append({
        tenantId: dispatch.tenantId,
        actionId: enqueuedActionId,
        runId: null,
        actorType: 'SYSTEM',
        actorId: 'system:webhooks',
        eventType: 'provider.webhook_received',
        eventTime: new Date(),
        traceId,
        policyRevisionId: null,
        payloadRedacted: {
          provider: PROVIDER,
          delivery_id: deliveryId,
          provider_ref: parsed.providerRef,
          provider_status: parsed.status,
          enqueued: enqueuedActionId !== null,
        },
      })
      .catch(() => undefined);

    return reply.code(200).send({ status: enqueuedActionId ? 'accepted' : 'ignored', action_id: enqueuedActionId });
  });
}

export async function webhookDeliveryRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  // List recent deliveries (redacted) — authenticated, tenant-scoped to the
  // caller's tenant. Useful for the console's webhook status page.
  app.get('/webhooks/wise/deliveries', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const scope = tenantScope(ctx.runtime, principal.tenantId);
    const rows = await scope(async (ex) => {
      return ex
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.resolvedTenantId, principal.tenantId))
        .orderBy(desc(schema.webhookDeliveries.receivedAt))
        .limit(50);
    });
    return { items: rows };
  });
}
