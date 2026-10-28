-- =============================================================================
-- PermitZero — 0007_rls_write_scope.sql
--
-- 0006 gave the runtime role a blind escape hatch (`pz.tenant_blind`) for the
-- two operations that genuinely cannot know their tenant: the door lookup and
-- the cross-tenant outbox claim. It gave that hatch to the right tables, but
-- with `FOR ALL` policies — and `FOR ALL` whose USING clause says "the flag is
-- on" is a WRITE grant, not a read grant. Two holes followed:
--
--   1. `users` — the `tenant_membership` policy was `AS PERMISSIVE FOR ALL`
--      with `WITH CHECK (pz_tenant_blind())`, so a blind transaction could
--      INSERT, UPDATE or DELETE any user row of any tenant. 0006's own header
--      says the blind flag opens SELECT on five tables; for `users` that was
--      never true.
--   2. `outbox_events` — the `dispatch_claim` policy was `FOR ALL` with
--      `USING/WITH CHECK (pz_tenant_blind())`, so a blind transaction could
--      write any tenant's outbox row: publish it, fail it, kill it, delete
--      it, or forge a new one. The tenant-id immutability trigger stopped a
--      row being MOVED between tenants; it never stopped a row being changed
--      where it lies.
--
-- This file narrows both, and states — for the first time in one place —
-- exactly what the blind flag may do:
--
--   · MAY  SELECT on the five door tables — `tenants`, `users`,
--     `service_credentials`, `agents`, `tenant_memberships`. That is the
--     credential lookup and the tenant list a sweep needs; the credential row
--     carries the tenant, and everything after it is tenant-scoped.
--   · MAY  SELECT on `outbox_events`. The delivery backlog is a platform
--     total, not tenant data: /v1/status reports how much is pending, failed
--     or dead, and the numbers only mean something across every tenant.
--   · MAY  UPDATE the three claim columns of an outbox row — `attempt_count`,
--     `next_attempt_at`, `updated_at`. That is the claim, and nothing else.
--   · MAY NOT write anything else, anywhere, in any context. In particular:
--     no INSERT, UPDATE or DELETE on `users`; no INSERT or DELETE on
--     `outbox_events`; and no change to any other column of an outbox row
--     outside a transaction scoped to that row's own tenant.
--
-- The outbox claim keeps working because it is the one operation that must
-- cross tenants: `claimOutboxEvents` leases a batch with `FOR UPDATE SKIP
-- LOCKED` across every tenant, because a per-tenant claim loop would let one
-- busy tenant starve the queue behind it. Narrowing the claim does not
-- remove it — it confines it to the three columns a claim actually moves, and
-- the trigger below is what holds it there.
--
-- The other half of the fix is on the application side: the dispatcher now
-- carries each row's tenant into its status writes, so those writes run
-- tenant-scoped and the `tenant_isolation` policy is the thing that admits
-- them. That is why the blind context no longer needs to be able to write a
-- status at all.
--
-- Idempotent: every object is dropped before it is created, so re-running
-- this file is a no-op rather than an error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. `users`: the door may read it; nobody may write it through the runtime
--    role.
-- -----------------------------------------------------------------------------
-- The policy becomes SELECT-only. A tenant context still sees the users it
-- has members in (the membership subquery is itself under row-level security,
-- so it can only ever match the current tenant's rows); the blind flag still
-- sees the table for the door lookup.
--
-- With no INSERT/UPDATE/DELETE policy on the table, the runtime role simply
-- has no path to write one. The seed writes users through the migration
-- role, which row-level security does not bind — that is the intended shape:
-- a global identity row is created by the platform, not by a tenant.
DROP POLICY IF EXISTS tenant_membership ON public.users;
CREATE POLICY tenant_membership ON public.users
  AS PERMISSIVE FOR SELECT TO pz_app
  USING (
    pz_tenant_blind()
    OR (pz_current_tenant() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tenant_memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = pz_current_tenant()
    ))
  );

COMMENT ON POLICY tenant_membership ON public.users IS
  'SECURITY: the runtime role may READ the users it has members in, and may READ any user while the blind flag is on (the door lookup). It may never WRITE one: there is no INSERT/UPDATE/DELETE policy on this table for pz_app, so a blind transaction cannot create, edit or delete a user of any tenant.';

-- -----------------------------------------------------------------------------
-- 2. `outbox_events`: the delivery backlog is readable across tenants, and
--    writable only by the tenant that owns the row — with one exception, the
--    claim.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS dispatch_claim ON public.outbox_events;
DROP POLICY IF EXISTS dispatch_read ON public.outbox_events;

-- The read side: a platform total. Read-only, and only while the blind flag
-- is on.
CREATE POLICY dispatch_read ON public.outbox_events
  AS PERMISSIVE FOR SELECT TO pz_app
  USING (pz_tenant_blind());

-- The write side: the claim. It may update a row of any tenant, and the
-- trigger below confines it to the claim columns.
--
-- There is deliberately no INSERT and no DELETE policy for the blind flag. A
-- forged event and a deleted event are both worse than a stalled one, and
-- neither is something the delivery worker needs.
CREATE POLICY dispatch_claim ON public.outbox_events
  AS PERMISSIVE FOR UPDATE TO pz_app
  USING (pz_tenant_blind())
  WITH CHECK (pz_tenant_blind());

COMMENT ON POLICY dispatch_read ON public.outbox_events IS
  'SECURITY: the blind flag may READ the delivery backlog across tenants — /v1/status reports platform-wide pending, failed and dead counts. Read only.';

COMMENT ON POLICY dispatch_claim ON public.outbox_events IS
  'SECURITY: the blind flag may UPDATE the claim columns of an outbox row (attempt_count, next_attempt_at, updated_at) so the cross-tenant claim can lease a batch. The trigger pz_outbox_events_claim_scope refuses every other column change made without a tenant context matching the row.';

-- -----------------------------------------------------------------------------
-- 3. The claim scope: the trigger that makes the narrow UPDATE mean something.
-- -----------------------------------------------------------------------------
-- A policy decides which ROWS a statement may touch. It cannot decide which
-- COLUMNS the statement may change, so the column-level half of the rule
-- needs a trigger: a row comparison between OLD and NEW, which is the only
-- place where "what changed" is visible.
--
-- The rule: the three claim columns may move in any context; every other
-- column may only move in a transaction scoped to the row's own tenant.
CREATE OR REPLACE FUNCTION pz_outbox_events_claim_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  role_exempt boolean;
BEGIN
  -- The same boundary row-level security draws: a superuser or a BYPASSRLS
  -- role is not bound by the policies, and this trigger is that rule expressed
  -- as a statement-level check rather than a row filter. The migration and
  -- seed connection is exempt; the runtime role is not.
  SELECT rolsuper OR rolbypassrls INTO role_exempt
    FROM pg_roles WHERE rolname = current_user;
  IF COALESCE(role_exempt, false) THEN
    RETURN NEW;
  END IF;

  -- `attempt_count`, `next_attempt_at` and `updated_at` are the claim, and
  -- are deliberately absent from this comparison. Everything else about a row
  -- — who owns it, what it says, whether it has been delivered — belongs to
  -- its tenant.
  IF (NEW.outbox_event_id, NEW.tenant_id, NEW.aggregate_type, NEW.aggregate_id,
      NEW.event_type, NEW.queue_name, NEW.payload_json, NEW.status,
      NEW.max_attempts, NEW.published_at, NEW.last_error_class, NEW.created_at)
     IS DISTINCT FROM
     (OLD.outbox_event_id, OLD.tenant_id, OLD.aggregate_type, OLD.aggregate_id,
      OLD.event_type, OLD.queue_name, OLD.payload_json, OLD.status,
      OLD.max_attempts, OLD.published_at, OLD.last_error_class, OLD.created_at)
     AND pz_current_tenant() IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'outbox_events row % may only be changed by a transaction scoped to its own tenant (tenant_id=%)',
      OLD.outbox_event_id, OLD.tenant_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pz_outbox_events_claim_scope() IS
  'SECURITY: confines the blind outbox claim to the three columns it moves (attempt_count, next_attempt_at, updated_at). Any other change to an outbox row requires a transaction scoped to that row''s own tenant.';

DROP TRIGGER IF EXISTS trg_outbox_events_claim_scope ON public.outbox_events;
CREATE TRIGGER trg_outbox_events_claim_scope
  BEFORE UPDATE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION pz_outbox_events_claim_scope();

-- -----------------------------------------------------------------------------
-- 4. The claim scope in the machine-readable coverage.
-- -----------------------------------------------------------------------------
-- `pz_rls_coverage` reports whether a tenant-bearing table is enforced. It
-- knows nothing about column scope, so the scope rule is stated here, next to
-- the function that enforces it, rather than being implied by a view that
-- cannot express it.
--
-- The tenant-id immutability trigger from 0006 is untouched and still fires:
-- no UPDATE may move a row between tenants, whoever makes it.
