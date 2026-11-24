/**
 * Read-only delivery history.
 *
 * The inbound Wise webhook route was removed with the live-finance surface:
 * this release is simulation-only. Historical delivery rows remain available
 * as evidence, scoped to the authenticated tenant, but no route accepts a
 * provider callback or constructs a live provider session.
 */
import { eq, desc } from 'drizzle-orm';
import { schema, tenantScope } from '@permitzero/db';
import { UnauthenticatedError } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

export async function webhookDeliveryRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/webhooks/wise/deliveries', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const scope = tenantScope(ctx.runtime, principal.tenantId);
    return scope(async (ex) => {
      const rows = await ex
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.resolvedTenantId, principal.tenantId))
        .orderBy(desc(schema.webhookDeliveries.receivedAt))
        .limit(50);
      return {
        items: rows.map((row) => ({
          provider: row.provider,
          delivery_id: row.deliveryId,
          trace_id: row.traceId,
          outcome: row.outcome,
          resolved_tenant_id: row.resolvedTenantId,
          resolved_action_id: row.resolvedActionId,
          provider_ref: row.providerRef,
          received_at: row.receivedAt.toISOString(),
        })),
      };
    });
  });
}
