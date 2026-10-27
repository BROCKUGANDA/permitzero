/**
 * Audit routes: append-only, hash-chained event log reads + chain verification.
 * Tenant always comes from the principal. Cross-tenant access returns 404.
 */
import { auditPageSchema, auditQuerySchema } from '@permitzero/schemas';
import { z } from 'zod';
import { listAuditEvents, verifyAuditChain } from '@permitzero/db';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

const verifyResponseSchema = z
  .object({
    checked: z.number().int(),
    chain_valid: z.boolean(),
    breaks: z.array(z.object({ sequence: z.number().int(), event_id: z.string(), reason: z.string() }).strict()),
  })
  .strict();

async function authHook(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.db.db, request.headers.authorization, new Date());
  });
}

export async function auditRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  await authHook(app, ctx);

  app.get(
    '/audit',
    {
      schema: {
        querystring: auditQuerySchema,
        response: { 200: auditPageSchema },
      },
    },
    async (request) => {
      const q = request.query;
      const page = await listAuditEvents(
        ctx.db.db,
        request.principal.tenantId,
        {
          ...(q.action_id ? { actionId: q.action_id } : {}),
          ...(q.run_id ? { runId: q.run_id } : {}),
          ...(q.event_type ? { eventType: q.event_type } : {}),
          ...(q.from ? { from: q.from } : {}),
          ...(q.to ? { to: q.to } : {}),
        },
        { limit: q.limit ?? 50, cursor: q.cursor ?? null },
      );
      return {
        data: page.rows.map((r) => ({
          event_id: r.eventId,
          tenant_id: r.tenantId,
          action_id: r.actionId,
          run_id: r.runId,
          actor_type: r.actorType,
          actor_id: r.actorId,
          event_type: r.eventType,
          event_time: r.eventTime,
          trace_id: r.traceId,
          policy_revision_id: r.policyRevisionId,
          payload_redacted: r.payloadRedacted,
          previous_hash: r.previousHash,
          event_hash: r.eventHash,
          hash_version: r.hashVersion,
          sequence: r.sequence,
        })),
        meta: { limit: q.limit ?? 50, next_cursor: page.nextCursor },
      };
    },
  );

  app.post(
    '/audit/verify',
    {
      schema: { response: { 200: verifyResponseSchema } },
    },
    async (request) => {
      const result = await verifyAuditChain(ctx.db.db, request.principal.tenantId, {
        hmacKey: ctx.config.auditHmacKey,
      });
      return {
        checked: result.checked,
        chain_valid: result.chainValid,
        breaks: result.breaks.map((b) => ({ sequence: b.sequence, event_id: b.eventId, reason: b.reason })),
      };
    },
  );
}
