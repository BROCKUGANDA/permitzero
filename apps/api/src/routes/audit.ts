/**
 * Audit routes: append-only, hash-chained event log reads + chain verification.
 * Tenant always comes from the principal. Cross-tenant access returns 404.
 */
import { auditPageSchema, auditQuerySchema } from '@permitzero/schemas';
import { z } from 'zod';
import { listAuditEvents, tenantScope, verifyAuditChain } from '@permitzero/db';
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
    request.principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
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
      const tenantId = request.principal.tenantId;
      // `audit_events` carries `tenant_id`, so it is under RLS: the read has to
      // run on the transaction that sets `app.tenant_id`, on the runtime pool.
      // One statement, so one scope is all it needs — no network call inside.
      const scope = tenantScope(ctx.runtime, tenantId);
      const page = await scope((ex) =>
        listAuditEvents(
          ex,
          tenantId,
          {
            ...(q.action_id ? { actionId: q.action_id } : {}),
            ...(q.run_id ? { runId: q.run_id } : {}),
            ...(q.event_type ? { eventType: q.event_type } : {}),
            ...(q.from ? { from: q.from } : {}),
            ...(q.to ? { to: q.to } : {}),
          },
          { limit: q.limit ?? 50, cursor: q.cursor ?? null },
        ),
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
      const tenantId = request.principal.tenantId;
      // Verification recomputes the chain from one tenant's whole log. It is a
      // single SELECT, so it gets a single tenant-scoped transaction; on the root
      // pool RLS would hand it zero rows and report an empty log as `chain_valid`.
      const scope = tenantScope(ctx.runtime, tenantId);
      const result = await scope((ex) => verifyAuditChain(ex, tenantId, { hmacKey: ctx.config.auditHmacKey }));
      return {
        checked: result.checked,
        chain_valid: result.chainValid,
        breaks: result.breaks.map((b) => ({ sequence: b.sequence, event_id: b.eventId, reason: b.reason })),
      };
    },
  );
}
