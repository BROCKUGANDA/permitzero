/**
 * Retention sweep: age out what the window says is old, keep what a legal
 * hold says is not, and record what happened either way.
 *
 * -----------------------------------------------------------------------------
 * Why this file is careful about the audit chain
 * -----------------------------------------------------------------------------
 * The audit chain is per tenant and gapless. `sequence` runs 1..n; every row
 * carries its predecessor's `event_hash` in `previous_hash`; and each
 * `event_hash` is computed OVER `previous_hash`. So a row removed from the
 * middle of the chain breaks every row after it — the successor names a
 * predecessor that no longer exists, and its own hash was computed over that
 * value.
 *
 * A purge that leaves the chain broken is worse than no purge. `verifyAuditChain`
 * — the same function the evidence bundle and the chain monitor use — would
 * report the chain as tampered, and the signal that is supposed to mean
 * "somebody altered the record" would come to mean "the retention sweep ran".
 * A tamper-evidence control that cries wolf on its own housekeeping is not a
 * control.
 *
 * So the purge here is a RE-ANCHOR, and the shape of it is forced:
 *
 *   1. The chain is VERIFIED before anything is touched. A chain that is
 *      already broken is left exactly as it is and the tenant is skipped.
 *      This is the anti-laundering rule: a purge must never be able to turn
 *      pre-existing tampering into a clean-looking chain.
 *   2. The surviving rows are re-sequenced 1..m and re-linked, so the chain
 *      is contiguous and verifies again.
 *   3. A MARKER row is appended to the chain recording the purge: how many
 *      rows went, which window applied, and the `event_hash` of the last row
 *      that was removed. The marker lives inside the chain, so the boundary
 *      it commits to is covered by the chain's keyed hash — a reader can
 *      prove the chain was truncated where the retention record says, rather
 *      than rewritten to look tidy.
 *
 * The trade-off, stated rather than buried: re-anchoring recomputes the
 * hashes of the surviving rows, so from the purge point onward the chain's
 * tamper-evidence rests on the purge having been honest. Steps 1 and 3 are
 * what keep that honest, and the alternative — leaving the chain broken, or
 * rewriting an event's payload to make a tombstone — was rejected because
 * both make the trail report itself as tampered.
 *
 * -----------------------------------------------------------------------------
 * What runs on which pool
 * -----------------------------------------------------------------------------
 * The purge runs on the MANAGEMENT pool, not the restricted runtime pool, and
 * that is deliberate rather than convenient:
 *
 *   · the runtime role `pz_app` must never be able to remove or rewrite an
 *     audit row. `infra/migrations/0010_retention_and_legal_hold.sql` keeps the
 *     append-only trigger closed for it — the retention gate requires a role
 *     exempt from row-level security, and `pz_app` is neither superuser nor
 *     BYPASSRLS. A compromised API therefore cannot delete evidence, no
 *     matter what it sets in the environment.
 *   · the sweep therefore has to be a platform operation, and it says so: it
 *     runs as the owner, takes the chain advisory lock, and writes down what
 *     it did.
 *
 * Every statement still names its tenant explicitly. The owner is exempt from
 * row-level security, so nothing downstream of this file is protected by a
 * policy here — the scoping is this file's own responsibility, and it is
 * explicit rather than inherited.
 */
// The retention sweep's own output helper — permitted where bare
// `console.log` is not. Every call through this object is an intentional
// operational record (legal-hold skip, purge result, startup status) rather
// than a debug print left behind.
const retentionLog = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

import { sql } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import {
  listActiveTenantIds,
  reanchorAuditHash,
  sealAuditEvent,
  verifyAuditChain,
  withTenantBlindTransaction,
} from '@permitzero/db';
import type { Db, DbTransaction } from '@permitzero/db';

/** The event type the marker row carries. Stable: it is part of the evidence. */
export const AUDIT_PURGE_EVENT_TYPE = 'retention.audit_purged';

const DAY_MS = 86_400_000;

export interface RetentionConfig {
  /** Days an audit event is kept before the sweep may remove it. */
  auditRetentionDays: number;
  /** Days a delivery record is kept before the sweep may remove it. */
  outboxRetentionDays: number;
  /**
   * The audit chain's keyed hash. Without it the chain cannot be re-anchored
   * — the surviving hashes are computed with the key — so the sweep refuses
   * to touch the audit chain and says so.
   */
  auditHmacKey: string | null;
  /** Who performed the purge. Recorded on the marker and on the run record. */
  operatorId: string;
}

export interface RetentionDeps {
  /** The management pool (the owner). See the note at the top of this file. */
  db: Db;
  config: RetentionConfig;
  clock?: () => Date;
}

export type RetentionOutcome = 'purged' | 'held' | 'skipped' | 'error';

export interface TenantRetentionResult {
  tenantId: string;
  outcome: RetentionOutcome;
  auditRowsPurged: number;
  outboxRowsPurged: number;
  auditRowsRelinked: number;
  legalHold: boolean;
  chainHeadBefore: string | null;
  chainHeadAfter: string | null;
  chainBoundaryHash: string | null;
  error?: string;
}

export interface RetentionSweepResult {
  ranAt: string;
  tenantsScanned: number;
  tenantsHeld: number;
  auditRowsPurged: number;
  outboxRowsPurged: number;
  auditRowsRelinked: number;
  errors: number;
  tenants: TenantRetentionResult[];
}

interface AuditRow {
  event_id: string;
  sequence: string;
  previous_hash: string | null;
  event_hash: string;
  hash_version: string;
  action_id: string | null;
  run_id: string | null;
  actor_type: string;
  actor_id: string;
  event_type: string;
  trace_id: string;
  policy_revision_id: string | null;
  /**
   * Epoch milliseconds, as text.
   *
   * Not a `Date`: a raw statement through drizzle's `execute` hands back the
   * server's own text for a timestamptz, in the session's timezone, and the
   * audit hash is computed over a Date's millisecond instant. Converting in
   * SQL keeps the two exactly equal — `floor` truncates towards the past, so
   * a row stored with microseconds lands on the same millisecond the audit
   * repository hashes.
   */
  event_time_ms: string;
  expires_at_ms: string | null;
  payload_redacted_json: unknown;
}

/** Milliseconds, because the audit hash is computed over a Date. */
function truncateToMs(date: Date): Date {
  return new Date(Math.floor(date.getTime()));
}

function countRows(result: unknown): number {
  return Array.isArray(result) ? result.length : 0;
}

/**
 * The active legal holds for a tenant.
 *
 * A hold with no `released_at` is in force indefinitely; a hold whose
 * `released_at` is in the future is in force until then. One hold covers the
 * tenant: the sweep is not selective about which rows it would have removed,
 * so it does not remove any of them.
 */
async function activeLegalHold(tx: DbTransaction, tenantId: string, now: Date): Promise<string | null> {
  const rows = await tx.execute(sql`
    SELECT legal_hold_id, reason, operator_id, placed_at
      FROM public.legal_holds
     WHERE tenant_id = ${tenantId}
       AND (released_at IS NULL OR released_at > ${now.toISOString()})
     ORDER BY placed_at ASC
     LIMIT 1
  `);
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return JSON.stringify({
    legal_hold_id: row['legal_hold_id'],
    reason: row['reason'],
    operator_id: row['operator_id'],
    placed_at: row['placed_at'],
  });
}

interface AuditPurgeOutcome {
  purged: number;
  relinked: number;
  headBefore: string | null;
  headAfter: string | null;
  boundaryHash: string | null;
}

/**
 * Re-anchor the tenant's audit chain around the rows that survive.
 *
 * See the header of this file for why this is a re-anchor and not a delete.
 */
async function purgeAuditChain(
  tx: DbTransaction,
  deps: RetentionDeps,
  tenantId: string,
  now: Date,
): Promise<AuditPurgeOutcome> {
  const hmacKey = deps.config.auditHmacKey;
  const days = deps.config.auditRetentionDays;

  // 1. Verify before touching. A broken chain is left exactly as it is: the
  //    sweep is not the thing that gets to decide a break is acceptable.
  const verification = await verifyAuditChain(tx, tenantId, { hmacKey });
  if (!verification.chainValid) {
    const first = verification.breaks[0];
    throw new Error(
      `refusing to purge the audit chain for tenant ${tenantId}: the chain is already broken ` +
        `(${verification.breaks.length} break(s), first: ${first ? `sequence ${first.sequence}: ${first.reason}` : 'unknown'})`,
    );
  }

  // 2. Materialise the deadline on every row, so the stored deadline and the
  //    configured window are the same number. `IS DISTINCT FROM` keeps the
  //    write to zero rows once the deadlines agree, which is what makes this
  //    affordable to run on every pass.
  await tx.execute(sql`
    UPDATE public.audit_events
       SET expires_at = event_time + make_interval(days => ${days}::int)
     WHERE tenant_id = ${tenantId}
       AND expires_at IS DISTINCT FROM event_time + make_interval(days => ${days}::int)
    RETURNING event_id
  `);

  // 3. Read the chain under the advisory lock, with the expiry decided by
  //    the DATABASE clock rather than the process clock: two machines with
  //    skewed clocks must not disagree about which rows are due.
  //
  //    `now()` is the transaction timestamp, so it is the same instant in this
  //    statement and in the DELETE below — which is what makes the count in
  //    the marker and the count of rows actually removed the same number.
  //
  //    No row-level `FOR UPDATE` — the chain advisory lock (taken by the
  //    caller) already serialises concurrent appends and concurrent sweeps
  //    of this tenant, and locking the full retained history while re-linking
  //    it holds that many rows for the duration of the transaction and then
  //    issues one UPDATE per survivor that needs a new link. At production
  //    scale the hourly sweep would hold locks across a year's history.
  const read = (await tx.execute(sql`
    SELECT event_id, sequence, previous_hash, event_hash, hash_version,
           action_id, run_id, actor_type, actor_id, event_type, trace_id,
           policy_revision_id, payload_redacted_json,
           floor(extract(epoch from event_time) * 1000)::bigint AS event_time_ms,
           floor(extract(epoch from expires_at) * 1000)::bigint AS expires_at_ms,
           floor(extract(epoch from now()) * 1000)::bigint AS now_ms
      FROM public.audit_events
     WHERE tenant_id = ${tenantId}
     ORDER BY sequence ASC
  `)) as unknown as Array<AuditRow & { now_ms: string }>;

  const nowMs = Number(read[0]?.now_ms ?? 0);
  const rows: AuditRow[] = read.map(({ now_ms: _nowMs, ...row }) => row);
  const survivors = rows.filter((row) => row.expires_at_ms === null || Number(row.expires_at_ms) > nowMs);
  const removed = rows.filter((row) => row.expires_at_ms !== null && Number(row.expires_at_ms) <= nowMs);
  const headBefore = rows.length > 0 ? (rows[rows.length - 1]?.event_hash ?? null) : null;

  if (removed.length === 0) {
    return { purged: 0, relinked: 0, headBefore, headAfter: headBefore, boundaryHash: null };
  }

  // 4. Compute the chain that will exist after the purge: the survivors,
  //    re-sequenced from 1 and re-linked. `sequence` is not covered by the
  //    hash, so only the LINK changes the hash.
  //
  //    The re-hash has to reproduce the row's ORIGINAL hash exactly, with
  //    only the link changed. `reanchorAuditHash` does that by DISCOVERING
  //    the key that wrote the row — the one under which its existing hash
  //    reproduces — and re-hashing with it over the new link.
  //
  //    Doing it the obvious way instead — hashing the stored column with
  //    the configured key — is wrong twice over: the stored column holds
  //    the CIPHERTEXT when the deployment has a key (the hash covers the
  //    plaintext), and the configured key is not necessarily the one that
  //    wrote the row (the ring holds several during a rotation). Both
  //    mistakes produce a chain that no longer verifies, which is the
  //    signal that is supposed to mean "somebody altered the record" —
  //    coming to mean "the retention sweep ran".
  //
  //    A row that cannot be reproduced is a row that is not what it
  //    claims to be, and re-linking it would launder that into a
  //    clean-looking chain. The tenant is refused instead.
  let previousHash: string | null = null;
  let sequence = 0;
  const relink: Array<{ eventId: string; sequence: number; previousHash: string | null; eventHash: string }> = [];
  for (const row of survivors) {
    sequence += 1;
    const rehashed = reanchorAuditHash(
      {
        tenantId,
        eventId: row.event_id,
        actionId: row.action_id,
        runId: row.run_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        eventType: row.event_type,
        eventTime: new Date(Number(row.event_time_ms)),
        traceId: row.trace_id,
        policyRevisionId: row.policy_revision_id,
        storedPayload: row.payload_redacted_json,
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
      },
      previousHash,
      { hmacKey },
    );
    if (!rehashed) {
      throw new Error(
        `refusing to purge the audit chain for tenant ${tenantId}: event ${row.event_id} cannot be reproduced with the available keys`,
      );
    }
    const hash = rehashed.hash;
    if (Number(row.sequence) !== sequence || row.previous_hash !== previousHash || row.event_hash !== hash) {
      relink.push({ eventId: row.event_id, sequence, previousHash, eventHash: hash });
    }
    previousHash = hash;
  }

  // 5. Remove the expired rows first, then re-link.
  //
  //    The order is not cosmetic. `uq_audit_events_sequence` is UNIQUE on
  //    (tenant_id, sequence), and the survivors move DOWN to 1..m. Deleting
  //    first frees the numbers the expired rows held; updating the survivors
  //    in ascending order then never lands on a number another survivor still
  //    holds, because a survivor that held it has already moved by then.
  //
  //    The trigger refuses to delete a row that has no stamped deadline or
  //    whose deadline has not passed, so the purge cannot remove evidence
  //    that the platform has not already declared expired.
  const deleted = await tx.execute(sql`
    DELETE FROM public.audit_events
     WHERE tenant_id = ${tenantId}
       AND expires_at IS NOT NULL
       AND expires_at <= now()
    RETURNING event_id
  `);

  for (const link of relink) {
    await tx.execute(sql`
      UPDATE public.audit_events
         SET sequence = ${link.sequence},
             previous_hash = ${link.previousHash},
             event_hash = ${link.eventHash}
       WHERE tenant_id = ${tenantId}
         AND event_id = ${link.eventId}
    `);
  }

  // 6. The marker. It is an ordinary append — the chain's own insert path
  //    assigns its sequence and checks its link — carrying the commitment to
  //    what was removed.
  //
  //    It is SEALED the way the repository seals a row: the hash over the
  //    canonical plaintext, the payload stored encrypted. A marker written
  //    any other way is a row in an encrypted table whose contents sit in
  //    the clear — and the marker is the one row that says what was
  //    deleted, which is exactly the row nobody should be able to edit in
  //    peace.
  const boundary = removed[removed.length - 1];
  const boundaryHash = boundary?.event_hash ?? null;
  const markerId = newId('auditEvent');
  const traceId = newId('trace');
  const markerPayload = {
    reason: 'retention_window_expired',
    purged_rows: removed.length,
    relinked_rows: relink.length,
    boundary_event_id: boundary?.event_id ?? null,
    boundary_hash: boundaryHash,
    audit_retention_days: days,
    purged_at: now.toISOString(),
  };
  const marker = sealAuditEvent(
    {
      tenantId,
      eventId: markerId,
      actionId: null,
      runId: null,
      actorType: 'SYSTEM',
      actorId: deps.config.operatorId,
      eventType: AUDIT_PURGE_EVENT_TYPE,
      eventTime: truncateToMs(now),
      traceId,
      policyRevisionId: null,
      payload: markerPayload,
      previousHash,
    },
    { hmacKey },
  );
  await tx.execute(sql`
    INSERT INTO public.audit_events
      (event_id, tenant_id, event_type, action_id, run_id, actor_type, actor_id,
       policy_revision_id, payload_redacted_json, event_hash, previous_hash, hash_version,
       trace_id, event_time, purged_at, expires_at)
    VALUES
      (${markerId}, ${tenantId}, ${AUDIT_PURGE_EVENT_TYPE}, NULL, NULL, 'SYSTEM', ${deps.config.operatorId},
       NULL, ${JSON.stringify(marker.storedPayload)}::jsonb, ${marker.hash}, ${previousHash}, ${marker.version},
       ${traceId}, ${now.toISOString()}, ${now.toISOString()},
       ${new Date(now.getTime() + days * DAY_MS).toISOString()})
  `);

  return {
    purged: countRows(deleted),
    relinked: relink.length,
    headBefore,
    headAfter: marker.hash,
    boundaryHash,
  };
}

/**
 * Purge the delivery records that are past their window.
 *
 * The outbox is a delivery log, not evidence: it records that an event was
 * handed to the queue, and once the window has passed nobody is entitled to
 * that record any more. 0005 already says so — "retention deletes stay
 * allowed so history can still be aged out by an explicit purge, never by the
 * dispatcher" — so this is a DELETE and not a status change.
 */
async function purgeOutbox(
  tx: DbTransaction,
  deps: RetentionDeps,
  tenantId: string,
): Promise<{ purged: number; stamped: number }> {
  const days = deps.config.outboxRetentionDays;
  const stamped = await tx.execute(sql`
    UPDATE public.outbox_events
       SET expires_at = created_at + make_interval(days => ${days}::int)
     WHERE tenant_id = ${tenantId}
       AND expires_at IS DISTINCT FROM created_at + make_interval(days => ${days}::int)
    RETURNING outbox_event_id
  `);
  const deleted = await tx.execute(sql`
    DELETE FROM public.outbox_events
     WHERE tenant_id = ${tenantId}
       AND expires_at IS NOT NULL
       AND expires_at <= now()
    RETURNING outbox_event_id
  `);
  return { purged: countRows(deleted), stamped: countRows(stamped) };
}

async function recordRun(
  deps: RetentionDeps,
  row: {
    tenantId: string;
    startedAt: Date;
    finishedAt: Date;
    outcome: RetentionOutcome;
    auditRowsPurged: number;
    outboxRowsPurged: number;
    auditRowsRelinked: number;
    legalHold: boolean;
    chainHeadBefore: string | null;
    chainHeadAfter: string | null;
    chainBoundaryHash: string | null;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await deps.db.sql`
    INSERT INTO public.retention_runs
      (retention_run_id, tenant_id, started_at, finished_at, outcome,
       audit_retention_days, outbox_retention_days, audit_cutoff, outbox_cutoff,
       audit_rows_purged, outbox_rows_purged, audit_rows_relinked, legal_hold,
       chain_head_before, chain_head_after, chain_boundary_hash, operator_id, detail)
    VALUES
      (${newId('run')}, ${row.tenantId}, ${row.startedAt.toISOString()}, ${row.finishedAt.toISOString()},
       ${row.outcome}, ${deps.config.auditRetentionDays}, ${deps.config.outboxRetentionDays},
       ${new Date(row.startedAt.getTime() - deps.config.auditRetentionDays * DAY_MS).toISOString()},
       ${new Date(row.startedAt.getTime() - deps.config.outboxRetentionDays * DAY_MS).toISOString()},
       ${row.auditRowsPurged}, ${row.outboxRowsPurged}, ${row.auditRowsRelinked}, ${row.legalHold},
       ${row.chainHeadBefore}, ${row.chainHeadAfter}, ${row.chainBoundaryHash},
       ${deps.config.operatorId}, ${JSON.stringify(row.detail)}::jsonb)
  `;
}

/**
 * One tenant's pass: the hold check, the two purges and the record, in one
 * transaction.
 *
 * One transaction per tenant, so a tenant whose chain cannot be re-anchored
 * does not hold up the others, and so a tenant is never left half-aged: the
 * outbox purge and the audit purge commit together or not at all.
 */
async function sweepTenant(deps: RetentionDeps, tenantId: string, now: Date): Promise<TenantRetentionResult> {
  const startedAt = now;

  try {
    const outcome = await deps.db.db.transaction(async (tx) => {
      // The gate the append-only trigger checks. Transaction-local, so it
      // cannot leak onto the next borrower of this pooled connection.
      await tx.execute(sql`SELECT set_config('pz.retention_purge', 'on', true)`);
      // The chain lock, the same key the chain trigger takes. Without it an
      // append could land between the read of the head and the re-anchor,
      // and the re-anchor would then link to a head that has moved.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('pz_audit_chain:' || ${tenantId}, 0))`);

      // The hold check belongs AFTER the lock and INSIDE the same
      // transaction as the deletes: the outer check committed before the
      // purge transaction started, so a hold placed between those two
      // transactions was still ignored by the deletions. Coordinating on
      // the same advisory lock (see 0010) is what makes the hold visible.
      const heldJson = await activeLegalHold(tx, tenantId, now);
      if (heldJson !== null) {
        const finishedAtH = new Date();
        await tx.execute(sql`
          INSERT INTO public.retention_runs
            (retention_run_id, tenant_id, started_at, finished_at, outcome,
             audit_retention_days, outbox_retention_days, audit_cutoff, outbox_cutoff,
             audit_rows_purged, outbox_rows_purged, audit_rows_relinked, legal_hold,
             chain_head_before, chain_head_after, chain_boundary_hash, operator_id, detail)
          VALUES
            (${newId('run')}, ${tenantId}, ${startedAt.toISOString()}, ${finishedAtH.toISOString()},
             'held', ${deps.config.auditRetentionDays}, ${deps.config.outboxRetentionDays},
             ${new Date(startedAt.getTime() - deps.config.auditRetentionDays * DAY_MS).toISOString()},
             ${new Date(startedAt.getTime() - deps.config.outboxRetentionDays * DAY_MS).toISOString()},
             0, 0, 0, true,
             NULL, NULL, NULL,
             ${deps.config.operatorId}, ${JSON.stringify({ legal_hold: JSON.parse(heldJson) as unknown })}::jsonb)
        `);
        return { held: true as const, heldJson };
      }

      const audit = await purgeAuditChain(tx, deps, tenantId, now);
      const outbox = await purgeOutbox(tx, deps, tenantId);
      // The successful run record lives in the SAME transaction as the
      // deletions. If this insert fails, the deletions roll back with it —
      // a committed deletion must never be left with no run record.
      const finishedAtP = new Date();
      await tx.execute(sql`
        INSERT INTO public.retention_runs
          (retention_run_id, tenant_id, started_at, finished_at, outcome,
           audit_retention_days, outbox_retention_days, audit_cutoff, outbox_cutoff,
           audit_rows_purged, outbox_rows_purged, audit_rows_relinked, legal_hold,
           chain_head_before, chain_head_after, chain_boundary_hash, operator_id, detail)
        VALUES
          (${newId('run')}, ${tenantId}, ${startedAt.toISOString()}, ${finishedAtP.toISOString()},
           'purged', ${deps.config.auditRetentionDays}, ${deps.config.outboxRetentionDays},
           ${new Date(startedAt.getTime() - deps.config.auditRetentionDays * DAY_MS).toISOString()},
           ${new Date(startedAt.getTime() - deps.config.outboxRetentionDays * DAY_MS).toISOString()},
           ${audit.purged}, ${outbox.purged}, ${audit.relinked}, false,
           ${audit.headBefore}, ${audit.headAfter}, ${audit.boundaryHash},
           ${deps.config.operatorId}, ${JSON.stringify({ outbox_rows_stamped: outbox.stamped })}::jsonb)
      `);
      return { held: false as const, audit, outbox };
    });

    if ((outcome as { held: boolean }).held) {
      return {
        tenantId,
        outcome: 'held',
        auditRowsPurged: 0,
        outboxRowsPurged: 0,
        auditRowsRelinked: 0,
        legalHold: true,
        chainHeadBefore: null,
        chainHeadAfter: null,
        chainBoundaryHash: null,
      };
    }

    const purged = outcome as { held: false; audit: AuditPurgeOutcome; outbox: { purged: number; stamped: number } };
    return {
      tenantId,
      outcome: 'purged',
      auditRowsPurged: purged.audit.purged,
      outboxRowsPurged: purged.outbox.purged,
      auditRowsRelinked: purged.audit.relinked,
      legalHold: false,
      chainHeadBefore: purged.audit.headBefore,
      chainHeadAfter: purged.audit.headAfter,
      chainBoundaryHash: purged.audit.boundaryHash,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordRun(deps, {
      tenantId,
      startedAt,
      finishedAt: new Date(),
      outcome: message.startsWith('refusing to purge') ? 'skipped' : 'error',
      auditRowsPurged: 0,
      outboxRowsPurged: 0,
      auditRowsRelinked: 0,
      legalHold: false,
      chainHeadBefore: null,
      chainHeadAfter: null,
      chainBoundaryHash: null,
      detail: { error: message },
    }).catch(() => undefined);
    return {
      tenantId,
      outcome: message.startsWith('refusing to purge') ? 'skipped' : 'error',
      auditRowsPurged: 0,
      outboxRowsPurged: 0,
      auditRowsRelinked: 0,
      legalHold: false,
      chainHeadBefore: null,
      chainHeadAfter: null,
      chainBoundaryHash: null,
      error: message,
    };
  }
}

/**
 * One pass over every active tenant.
 *
 * The tenant list is the only cross-tenant read, and it is read through the
 * blind context the door and the outbox claim use — every row the sweep
 * touches afterwards is named explicitly.
 */
export async function runRetentionSweep(deps: RetentionDeps, opts?: { now?: Date }): Promise<RetentionSweepResult> {
  const now = opts?.now ?? deps.clock?.() ?? new Date();
  const tenants = await withTenantBlindTransaction(deps.db, (tx) => listActiveTenantIds(tx));

  const results: TenantRetentionResult[] = [];
  let auditRowsPurged = 0;
  let outboxRowsPurged = 0;
  let auditRowsRelinked = 0;
  let tenantsHeld = 0;
  let errors = 0;

  for (const tenantId of tenants) {
    const result = await sweepTenant(deps, tenantId, now);
    results.push(result);
    auditRowsPurged += result.auditRowsPurged;
    outboxRowsPurged += result.outboxRowsPurged;
    auditRowsRelinked += result.auditRowsRelinked;
    if (result.legalHold) tenantsHeld += 1;
    if (result.outcome === 'error') errors += 1;
    if (result.outcome === 'held') {
      retentionLog.info(`[worker:retention] tenant ${tenantId} is under an active legal hold; nothing was removed`);
    }
    if (result.outcome === 'skipped' || result.outcome === 'error') {
      retentionLog.error(`[worker:retention] tenant ${tenantId}: ${result.outcome} — ${result.error ?? 'unknown'}`);
    }
  }

  return {
    ranAt: now.toISOString(),
    tenantsScanned: tenants.length,
    tenantsHeld,
    auditRowsPurged,
    outboxRowsPurged,
    auditRowsRelinked,
    errors,
    tenants: results,
  };
}

/**
 * The sweep on an interval.
 *
 * The shape is the same as the worker's other sweep: a pass that is still
 * running when the next tick arrives is not started again. A sweep that
 * overlaps itself would double-purge and race its own chain re-anchor, and
 * the symptom would be an audit chain that breaks intermittently — which is
 * precisely the failure this whole mechanism exists to avoid.
 */
export interface RetentionSweepHandle {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<RetentionSweepResult>;
}

export function startRetentionSweep(deps: RetentionDeps, opts: { intervalMs: number }): RetentionSweepHandle {
  let timer: NodeJS.Timeout | null = null;
  let sweeping = false;

  const runOnce = async (): Promise<RetentionSweepResult> => {
    const result = await runRetentionSweep(deps);
    if (
      result.auditRowsPurged > 0 ||
      result.outboxRowsPurged > 0 ||
      result.auditRowsRelinked > 0 ||
      result.tenantsHeld > 0 ||
      result.errors > 0
    ) {
      retentionLog.info(`[worker:retention] ${JSON.stringify(result)}`);
    }
    return result;
  };

  return {
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        runOnce()
          .catch((err: unknown) => {
            console.error(`[worker:retention] pass failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            sweeping = false;
          });
      }, opts.intervalMs);
      // The interval must not hold the process open on its own; the shutdown
      // path clears it, and this makes an unref'd timer the default so a
      // forgotten handle cannot keep a container alive.
      timer.unref?.();
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
  };
}
