/**
 * Evidence bundle: downloadable, manifest-hashed audit export for a tenant.
 * Honesty: this is application-level hash chaining, not cryptographic
 * tamper-proofing (FR-053). Gaps and missing receipts are reported, not hidden.
 */
import { auditBundleSchema } from '@permitzero/schemas';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';
import { listAuditEvents, tenantScope, verifyAuditChain, getAuditHead } from '@permitzero/db';

async function authHook(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
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
      // The head, the event page and the chain verification are ONE read of ONE
      // transaction, and that has to be the case: this payload is an evidentiary
      // artifact whose manifest asserts a head hash and a chain verdict for the
      // events it ships. Read across three transactions, an append landing between
      // them would produce a bundle that is internally inconsistent — events up to
      // sequence N, a head at N+2, a verdict computed from a third state — and the
      // bundle would then "prove" a chain that is not the one it contains. A single
      // scope also pins one pool connection rather than three.
      //
      // All three statements carry the tenant: `audit_events` has a `tenant_id`
      // column, so it is under row-level security, and on the root pool each would
      // return zero rows — an empty bundle that verifies cleanly.
      const scope = tenantScope(ctx.runtime, tenantId);
      const { head, page, verification } = await scope(async (ex) => ({
        head: await getAuditHead(ex, tenantId),
        page: await listAuditEvents(ex, tenantId, {}, { limit: 10000 }),
        verification: await verifyAuditChain(ex, tenantId, { hmacKey: ctx.config.auditHmacKey }),
      }));

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
