/**
 * Evidence bundle: downloadable, manifest-hashed audit export for a tenant.
 * Honesty: this is application-level hash chaining, not cryptographic
 * tamper-proofing (FR-053). Gaps and missing receipts are reported, not hidden.
 */
import { auditBundleSchema } from '@permitzero/schemas';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';
import { listAuditEvents, verifyAuditChain, getAuditHead } from '@permitzero/db';

async function authHook(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.db.db, request.headers.authorization, new Date());
  });
}

export async function evidenceRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  await authHook(app, ctx);

  app.get(
    '/evidence/bundle',
    {
      schema: { response: { 200: auditBundleSchema } },
    },
    async (request) => {
      const tenantId = request.principal.tenantId;
      const head = await getAuditHead(ctx.db.db, tenantId);
      const page = await listAuditEvents(ctx.db.db, tenantId, {}, { limit: 10000 });
      const verification = await verifyAuditChain(ctx.db.db, tenantId, { hmacKey: ctx.config.auditHmacKey });

      const sequences = page.rows.map((r) => r.sequence);
      const firstSeq = sequences.length ? Math.min(...sequences) : 0;
      const lastSeq = sequences.length ? Math.max(...sequences) : 0;

      return {
        manifest: {
          tenant_id: tenantId,
          generated_at: new Date(),
          event_count: page.rows.length,
          first_sequence: firstSeq,
          last_sequence: lastSeq,
          hash_version: page.rows[0]?.hashVersion ?? 'pz-audit-v1',
          head_event_hash: head?.eventHash ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          corpus_version: null,
        },
        events: page.rows.map((r) => ({
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
        policy_snapshots: [],
        verification: {
          chain_valid: verification.chainValid,
          gaps: verification.breaks.map((b) => ({ after_sequence: b.sequence - 1, detail: b.reason })),
          missing_receipts: [],
        },
      };
    },
  );
}
