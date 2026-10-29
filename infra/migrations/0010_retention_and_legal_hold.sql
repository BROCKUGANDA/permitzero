-- =============================================================================
-- PermitZero — 0010_retention_and_legal_hold.sql
--
-- Two controls that were absent: nothing aged anything out, and nothing held
-- anything back.
--
-- 1. RETENTION. An append-only audit chain and an erasure request are in
--    direct tension: the chain says "never rewrite", the erasure request says
--    "remove this". Until now the only answer was a shrug. This file adds the
--    machinery to age out data on a window, and to record that it happened.
--
-- 2. LEGAL HOLD. A retention window that cannot be suspended is a retention
--    window that will eventually destroy evidence somebody was ordered to
--    keep. `legal_holds` is the suspension: tenant-scoped, with a reason, the
--    operator who placed it, and the timestamp at which it is released.
--
-- -----------------------------------------------------------------------------
-- The chain problem, stated plainly
-- -----------------------------------------------------------------------------
-- The audit chain is per tenant and gapless: `sequence` runs 1..n, every row
-- carries the `event_hash` of its predecessor in `previous_hash`, and each
-- `event_hash` is computed OVER the `previous_hash`. So removing a row from
-- the middle of the chain does not leave a hole — it breaks every row after
-- it, because the successor's `previous_hash` names a row that no longer
-- exists and its own hash was computed over that value.
--
-- A purge that leaves the chain broken is worse than no purge at all. The
-- audit trail would report ITSELF as tampered, every downstream reader
-- (`/v1/evidence/bundle`, the audit chain monitor, `verifyAuditChain`) would
-- raise a break, and the signal that is supposed to mean "somebody altered
-- the record" would come to mean "the retention sweep ran". That is how a
-- tamper-evidence control stops being evidence.
--
-- So the purge here is a RE-ANCHOR, not a hole:
--
--   · the surviving rows are re-sequenced 1..m and re-linked, so the chain is
--     contiguous and verifies again — `verifyAuditChain` stays green;
--   · a MARKER row is appended to the chain recording the purge: how many
--     rows went, which window applied, and the `event_hash` of the last row
--     that was removed. Because the marker lives INSIDE the chain, that
--     boundary commitment is covered by the chain's keyed hash — a reader can
--     prove the chain was truncated at that point rather than rewritten.
--
-- The trade-off, stated rather than hidden: re-anchoring recomputes the
-- hashes of the surviving rows. The tamper-evidence of the chain from the
-- purge point onward therefore rests on the purge having been honest. Two
-- things keep that honest, and both are in this file and in the sweep:
--
--   · the sweep VERIFIES the chain before it touches it and refuses to purge
--     a chain that is already broken — so a purge can never launder a
--     pre-existing tampering into a clean-looking chain;
--   · the content of an event is immutable even for the purge. The trigger
--     below lets the platform owner re-link the chain and stamp retention
--     metadata, and NOTHING else. No role, at any privilege level, may change
--     what an audit event says.
--
-- The alternative designs were rejected for stated reasons:
--
--   · "delete the row and leave a gap" — breaks the chain, as above.
--   · "replace the row with a redacted tombstone" — the tombstone's payload
--     differs from the original, so its hash differs, so the cascade is
--     identical to the re-anchor; and it additionally requires letting the
--     owner rewrite an event's payload, which is a far larger concession than
--     letting it re-link hashes.
--   · "verify per segment" — the repository's own verifier
--     (`verifyAuditChain`) checks one chain per tenant and would still report
--     the gap. Making the API's own evidence bundle say "tampered" after a
--     legitimate retention sweep is not a trade-off worth making.
--
-- -----------------------------------------------------------------------------
-- The blast radius
-- -----------------------------------------------------------------------------
-- The relaxation below is deliberately narrow:
--
--   · it requires the session flag `pz.retention_purge = 'on'`, set
--     transaction-locally by the sweep, so an ordinary UPDATE against
--     `audit_events` is still refused exactly as before;
--   · it requires the current role to be exempt from row-level security
--     (rolsuper or rolbypassrls). The runtime role `pz_app` is neither, so
--     the API — and anything that compromises it — still cannot rewrite or
--     delete a single audit row, with or without the flag;
--   · on UPDATE it permits ONLY `sequence`, `previous_hash`, `event_hash`,
--     `expires_at` and `purged_at` to move. Every content column is
--     compared and any change is refused;
--   · on DELETE it permits only rows whose `expires_at` has been stamped and
--     is in the past. A row must have been marked expired by the platform
--     before it can be removed.
--
-- Idempotent: every object is dropped before it is created, and every column
-- is added with IF NOT EXISTS, so re-running this file is a no-op rather than
-- an error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Retention columns
-- -----------------------------------------------------------------------------
--
-- `expires_at` is the row's retention DEADLINE: the instant after which the
-- sweep may remove it. It is stamped by the sweep from the configured window
-- (`AUDIT_RETENTION_DAYS` / `OUTBOX_RETENTION_DAYS`), so the deadline stored
-- on a row and the deadline the sweep enforces are the same number — a
-- stored deadline that disagreed with the policy would be a second source of
-- truth, and two sources of truth for a deletion window means a deletion
-- happens on whichever one an operator forgot about.
--
-- `purged_at` exists on `audit_events` only, and only because a purged audit
-- row is DELETED rather than marked: there is no row left to stamp. The
-- marker row appended to the chain carries `purged_at` instead — it is the
-- row that records the purge, so it is the row that says when it happened.
-- The outbox has no `purged_at` for the same reason: 0005 says a published
-- outbox row is delivery history and that "retention deletes stay allowed so
-- history can still be aged out by an explicit purge", so outbox retention is
-- a DELETE. The record of that deletion is `retention_runs` below, not a
-- column on a row that no longer exists.
ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;
ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS purged_at timestamptz NULL;
ALTER TABLE public.outbox_events
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

COMMENT ON COLUMN public.audit_events.expires_at IS
  'RETENTION: the instant after which the retention sweep may remove this event. Stamped by the sweep from the configured window; NULL means the row has not been evaluated yet.';
COMMENT ON COLUMN public.audit_events.purged_at IS
  'RETENTION: set on the marker row that records a purge. A purged event is deleted rather than marked, so no ordinary event carries this.';
COMMENT ON COLUMN public.outbox_events.expires_at IS
  'RETENTION: the instant after which the retention sweep may remove this delivery record. Stamped by the sweep from the configured window.';

-- The sweep finds its work by deadline, so the deadline is indexed. Without
-- it the sweep scans the whole audit trail of every tenant on every pass,
-- which is exactly the kind of unbounded work that turns a background job
-- into a load problem.
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_expires_at
  ON public.audit_events (tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant_expires_at
  ON public.outbox_events (tenant_id, expires_at);

-- -----------------------------------------------------------------------------
-- 2. `legal_holds` — the suspension
-- -----------------------------------------------------------------------------
--
-- A hold is tenant-scoped: it belongs to the tenant whose data is being kept,
-- and it is visible under the same row-level security as everything else the
-- tenant owns. A hold with no `released_at` is in force indefinitely; a hold
-- whose `released_at` is in the future is in force until then. The sweep asks
-- "is this tenant under an active hold" before it removes anything, and a
-- hold that covers one row covers the tenant.
--
-- `reason` and `operator_id` are NOT NULL and cannot be blank. A hold with
-- no stated reason is indistinguishable from a bug, and a hold nobody can be
-- held responsible for is one nobody will release.
CREATE TABLE IF NOT EXISTS public.legal_holds (
  legal_hold_id       text        PRIMARY KEY,
  tenant_id           text        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  reason              text        NOT NULL,
  operator_id         text        NOT NULL,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz NULL,
  release_reason      text        NULL,
  release_operator_id text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_legal_holds_reason_nonempty CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_legal_holds_operator_nonempty CHECK (length(btrim(operator_id)) > 0),
  CONSTRAINT chk_legal_holds_release_after_placement
    CHECK (released_at IS NULL OR released_at >= placed_at)
);

COMMENT ON TABLE public.legal_holds IS
  'RETENTION: a suspension of the retention sweep for one tenant. While a hold is in force (released_at IS NULL, or released_at in the future) the sweep removes nothing for that tenant. Reason and operator are mandatory: an unexplained hold is indistinguishable from a bug.';

CREATE INDEX IF NOT EXISTS idx_legal_holds_tenant_active
  ON public.legal_holds (tenant_id)
  WHERE released_at IS NULL;

-- -----------------------------------------------------------------------------
-- 3. `retention_runs` — the record of what was removed
-- -----------------------------------------------------------------------------
--
-- A deletion nobody can see is not a deletion anybody can be asked about.
-- One row per tenant per sweep that touched it, carrying the counts, the
-- window that was applied, and the chain hashes at the boundary.
--
-- `chain_head_before` and `chain_head_after` are the tenant's chain head
-- before and after the re-anchor, and `chain_boundary_hash` is the hash of
-- the last row that was removed. The boundary hash is ALSO carried inside the
-- marker row's payload, which means it is covered by the chain's own keyed
-- hash: a reader can check that the chain was truncated where the retention
-- record says it was, and not merely rewritten to look tidy.
CREATE TABLE IF NOT EXISTS public.retention_runs (
  retention_run_id     text        PRIMARY KEY,
  tenant_id            text        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  started_at           timestamptz NOT NULL,
  finished_at          timestamptz NOT NULL,
  outcome              text        NOT NULL,
  audit_retention_days integer     NOT NULL,
  outbox_retention_days integer    NOT NULL,
  audit_cutoff         timestamptz NOT NULL,
  outbox_cutoff        timestamptz NOT NULL,
  audit_rows_purged    integer     NOT NULL DEFAULT 0,
  outbox_rows_purged   integer     NOT NULL DEFAULT 0,
  audit_rows_relinked  integer     NOT NULL DEFAULT 0,
  legal_hold           boolean     NOT NULL DEFAULT false,
  chain_head_before    text        NULL,
  chain_head_after     text        NULL,
  chain_boundary_hash  text        NULL,
  operator_id          text        NOT NULL,
  detail               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_retention_runs_outcome
    CHECK (outcome IN ('purged', 'held', 'skipped', 'error')),
  CONSTRAINT chk_retention_runs_counts_nonneg
    CHECK (audit_rows_purged >= 0 AND outbox_rows_purged >= 0 AND audit_rows_relinked >= 0)
);

COMMENT ON TABLE public.retention_runs IS
  'RETENTION: what the sweep did, per tenant, per pass. A deletion that leaves no record is a deletion nobody can be asked about; this table is that record. The chain hashes at the boundary tie the record to the chain it describes.';

-- -----------------------------------------------------------------------------
-- 4. Row-level security on the two new tables
-- -----------------------------------------------------------------------------
--
-- Both carry a `tenant_id`, so the 0006 sweep would have enforced them
-- automatically — but the enforcement is stated here rather than left to the
-- DDL event trigger, because a table that is only protected by an event
-- trigger is one table-rewrite away from being unprotected, and the whole
-- point of this repository's isolation work is that the protection does not
-- depend on remembering.
--
-- `pz_enforce_tenant_rls` is idempotent, so calling it twice is harmless.
SELECT public.pz_enforce_tenant_rls('legal_holds');
SELECT public.pz_enforce_tenant_rls('retention_runs');

COMMENT ON POLICY tenant_isolation ON public.legal_holds IS
  'SECURITY: the tenant boundary for legal holds. A tenant sees its own holds and nobody else''s; the runtime role cannot write a hold for another tenant, and the hold list itself is never a blind read.';
COMMENT ON POLICY tenant_isolation ON public.retention_runs IS
  'SECURITY: the tenant boundary for retention records. A tenant sees the record of what was removed from its own data, which is what an erasure request needs in order to be answerable.';

-- -----------------------------------------------------------------------------
-- 5. The append-only trigger, with the retention gate
-- -----------------------------------------------------------------------------
--
-- The rule is unchanged for everybody who is not the platform owner: UPDATE
-- and DELETE on `audit_events` raise, exactly as 0002 said they would.
--
-- The gate opens only for the platform owner (a role that is exempt from
-- row-level security — rolsuper or rolbypassrls, the same roles 0006's
-- preflight insists the migrating connection carries) and only inside a
-- transaction that has set `pz.retention_purge = 'on'` transaction-locally.
-- The runtime role `pz_app` is neither exempt nor able to become exempt, so
-- no code path reachable from the API can rewrite or delete an audit row.
--
-- Inside the gate:
--
--   UPDATE may move `sequence`, `previous_hash`, `event_hash`, `expires_at`
--   and `purged_at` and NOTHING ELSE. Every content column is compared
--   explicitly and a difference raises. This is the load-bearing part: the
--   re-anchor needs to re-link hashes, and it must not need to rewrite
--   evidence.
--
--   DELETE is permitted only for a row whose `expires_at` has been stamped
--   and is in the past. The platform has to have decided the row was due
--   before it can go. That is a guardrail against an accidental mass delete
--   as much as a rule; the real boundary is the role.
CREATE OR REPLACE FUNCTION pz_audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  purge_enabled boolean;
  role_exempt   boolean;
BEGIN
  purge_enabled := COALESCE(current_setting('pz.retention_purge', true), 'off') = 'on';
  SELECT rolsuper OR rolbypassrls INTO role_exempt FROM pg_roles WHERE rolname = current_user;

  IF purge_enabled AND COALESCE(role_exempt, false) THEN
    IF TG_OP = 'UPDATE' THEN
      -- The re-anchor moves the chain; it does not rewrite history.
      IF (NEW.event_id, NEW.tenant_id, NEW.event_type, NEW.action_id, NEW.run_id,
          NEW.actor_type, NEW.actor_id, NEW.event_time, NEW.trace_id,
          NEW.policy_revision_id, NEW.payload_redacted_json, NEW.hash_version,
          NEW.created_at)
         IS DISTINCT FROM
         (OLD.event_id, OLD.tenant_id, OLD.event_type, OLD.action_id, OLD.run_id,
          OLD.actor_type, OLD.actor_id, OLD.event_time, OLD.trace_id,
          OLD.policy_revision_id, OLD.payload_redacted_json, OLD.hash_version,
          OLD.created_at) THEN
        RAISE EXCEPTION
          'audit_events content is immutable: the retention purge may re-link the chain and stamp retention metadata, but it may not change what an event says (event %)',
          OLD.event_id
          USING ERRCODE = 'feature_not_supported';
      END IF;
      RETURN NEW;
    END IF;

    -- A row has to have been stamped as expired before it can be removed.
    IF OLD.expires_at IS NULL THEN
      RAISE EXCEPTION
        'audit event % carries no retention deadline and cannot be deleted by the retention purge',
        OLD.event_id
        USING ERRCODE = 'feature_not_supported';
    END IF;
    IF OLD.expires_at > now() THEN
      RAISE EXCEPTION
        'audit event % is not due for purge until %',
        OLD.event_id, OLD.expires_at
        USING ERRCODE = 'feature_not_supported';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'audit_events is append-only: % is not permitted (PermitZero FR-052). Record a compensating event instead.',
    TG_OP
    USING ERRCODE = 'feature_not_supported';
END;
$$;

COMMENT ON FUNCTION public.pz_audit_events_append_only() IS
  'SECURITY: audit_events is append-only for every role. The platform owner (a role exempt from row-level security) may additionally, and only inside a transaction that set pz.retention_purge=on, re-link the chain (sequence, previous_hash, event_hash) and stamp retention metadata (expires_at, purged_at). No path lets any role change the content of an audit event.';

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON public.audit_events;
CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION pz_audit_events_append_only();

DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON public.audit_events;
CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION pz_audit_events_append_only();

-- -----------------------------------------------------------------------------
-- 6. The outbox freeze, with the retention stamp
-- -----------------------------------------------------------------------------
--
-- 0005 froze a PUBLISHED outbox row: it is delivery history, and flipping it
-- back to FAILED would publish it twice. That rule stays.
--
-- What changes is that the retention deadline is now a column on the row, and
-- a PUBLISHED row still has to be given one — otherwise the outbox would
-- carry two different rules for "when may this go" depending on whether the
-- dispatcher happened to have finished with it, which is exactly the kind of
-- rule nobody can reason about.
--
-- So the freeze is narrowed rather than lifted: on a PUBLISHED row every
-- other column is still frozen, and only `expires_at` may move. The delivery
-- semantics of a published event are still immutable.
CREATE OR REPLACE FUNCTION pz_outbox_events_freeze_published() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN
    IF (NEW.outbox_event_id, NEW.tenant_id, NEW.aggregate_type, NEW.aggregate_id,
        NEW.event_type, NEW.queue_name, NEW.payload_json, NEW.status,
        NEW.max_attempts, NEW.published_at, NEW.last_error_class, NEW.created_at)
       IS DISTINCT FROM
       (OLD.outbox_event_id, OLD.tenant_id, OLD.aggregate_type, OLD.aggregate_id,
        OLD.event_type, OLD.queue_name, OLD.payload_json, OLD.status,
        OLD.max_attempts, OLD.published_at, OLD.last_error_class, OLD.created_at) THEN
      RAISE EXCEPTION
        'outbox event % was already published and cannot be modified (PermitZero: PUBLISHED is terminal)',
        OLD.outbox_event_id
        USING ERRCODE = 'feature_not_supported';
    END IF;
    -- `expires_at` is deliberately absent from the comparison above: the
    -- retention deadline is metadata about the row's future, not a change to
    -- what the row says or to where it is in its delivery lifecycle.
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pz_outbox_events_freeze_published() IS
  'SECURITY: a PUBLISHED outbox row is delivery history and its delivery fields are frozen (0005). The retention deadline `expires_at` may still be stamped on it, so the purge window is the same rule for every row.';

DROP TRIGGER IF EXISTS trg_outbox_events_freeze_published ON public.outbox_events;
CREATE TRIGGER trg_outbox_events_freeze_published
  BEFORE UPDATE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION pz_outbox_events_freeze_published();

-- -----------------------------------------------------------------------------
-- 7. The machine-readable coverage
-- -----------------------------------------------------------------------------
--
-- `pz_rls_coverage` discovers tenant-bearing tables from the catalog, so the
-- two new tables are already in it. The assertion below is the same one 0006
-- ends with, repeated here because a migration that adds tables and does not
-- re-assert is a migration that can leave them unenforced and still succeed.
DO $pzretention$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing FROM public.pz_rls_coverage WHERE enforced = false;
  IF missing > 0 THEN
    RAISE EXCEPTION
      '% tenant-bearing table(s) are not fully RLS-enforced after the retention migration: %',
      missing,
      (SELECT string_agg(table_name, ', ' ORDER BY table_name) FROM public.pz_rls_coverage WHERE enforced = false);
  END IF;
END
$pzretention$;
