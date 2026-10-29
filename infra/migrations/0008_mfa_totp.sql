-- =============================================================================
-- PermitZero — 0008_mfa_totp.sql
--
-- The storage behind MFA step-up: the TOTP shared secret of an account, and
-- the narrow write path that records that the enrolment was confirmed.
--
-- Until this file existed, `require_mfa` was unsatisfiable. The server could
-- verify a step-up assertion (`packages/policy/src/mfa.ts`) but nothing could
-- issue one, because there was nowhere to keep the second factor and nothing
-- to enrol it against. A policy that asked for MFA therefore failed closed —
-- which is the right direction, but it is not an implemented control, it is
-- an absent one.
--
-- What lives here:
--
--   1. `mfa_secrets` — one row per account. The shared secret is stored
--      ENCRYPTED (`v1.<iv>.<tag>.<ciphertext>`, AES-256-GCM under a key
--      derived from the server secret with a label of its own), because a TOTP
--      secret is a credential that reproduces itself: whoever holds it can
--      mint a code at will. It cannot be hashed, because the server has to
--      recompute a code from it.
--
--      The row is TENANT-SCOPED and the secret is PER USER. A person who
--      belongs to several tenants still has one authenticator entry, so
--      there is one secret; the tenant column says which tenant the
--      enrolment happened under, and that is the boundary row-level security
--      enforces. The unique index is on `user_id` alone, and that is the
--      honest expression of "one secret per person" — a second tenant
--      cannot mint a second secret for the same account.
--
--   2. `users.mfa_enrolled_at` — the CONFIRMATION marker. It exists since
--      0001 and was never written by anything. It is set when an enrolment is
--      confirmed and cleared when a new enrolment starts, so the row says
--      "this person proved they hold the secret", not "a secret is stored".
--
--      Writing it is the delicate part. `users` is a global table with no
--      tenant column, and migration 0007 closed the runtime role's write
--      path on it entirely: the role may READ the users it has members in
--      and may write nothing. This file re-opens exactly one column, for
--      transactions scoped to a tenant the account belongs to, and a trigger
--      refuses every other column — the same "policy decides the rows, the
--      trigger decides the columns" shape 0007 used for the outbox claim.
--
-- Idempotent: every object is dropped before it is created, so re-running
-- this file is a no-op rather than an error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The confirmation marker. Already present since 0001; added here so a
--    database that somehow lacks it still gets one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;

COMMENT ON COLUMN public.users.mfa_enrolled_at IS
  'SECURITY: set when this account CONFIRMED a TOTP enrolment, cleared when a new enrolment starts. NULL means "a secret may be stored, but nobody has proved they hold it".';

-- -----------------------------------------------------------------------------
-- 2. The secret table.
--
-- The CHECK keeps the ciphertext in the shape the application writes. It is
-- not a secrecy control — the plaintext is not in this table at all — it is a
-- guard against a row that holds something the reader cannot decrypt, which
-- would otherwise present as "MFA is enrolled" and then fail at the worst
-- possible moment.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mfa_secrets (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tenant_id        text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  last_code_hash   text,
  last_used_step   bigint,
  CONSTRAINT chk_mfa_secrets_encrypted_shape
    CHECK (secret_encrypted ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

COMMENT ON TABLE public.mfa_secrets IS
  'SECURITY: one row per account, holding the TOTP shared secret ENCRYPTED under AES-256-GCM. The row is tenant-scoped for row-level security; the secret itself is per user, because a person has one authenticator.';

COMMENT ON COLUMN public.mfa_secrets.secret_encrypted IS
  'SECURITY: v1.<iv>.<tag>.<ciphertext>, base64url. The plaintext secret exists only in the enrolment response and in the authenticator app.';

COMMENT ON COLUMN public.mfa_secrets.last_verified_at IS
  'The moment this account last completed a step-up verification. A step-up assertion may only be issued within the configured window of this instant.';

COMMENT ON COLUMN public.mfa_secrets.last_code_hash IS
  'Keyed fingerprint of the last TOTP code this account spent. A code is valid for a whole thirty-second step, so without this a captured code could be presented twice.';

ALTER TABLE public.mfa_secrets ADD COLUMN IF NOT EXISTS last_used_step bigint;
COMMENT ON COLUMN public.mfa_secrets.last_used_step IS
  'The TOTP step counter of the last accepted code. A code is accepted only when its step exceeds this value — otherwise a replayed or window-stale code from an earlier step could be accepted after a later step was used.';

-- One secret per person. The index is the database's statement of that, and
-- it is what makes a second tenant unable to enrol a second secret for the
-- same account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfa_secrets_user ON public.mfa_secrets (user_id);

-- Row-level security, the same recipe every other tenant-bearing table gets.
-- The DDL event trigger from 0006 has already applied it to this table by the
-- time this statement runs; calling it again is idempotent and states the
-- intent here rather than relying on the trigger having fired.
SELECT public.pz_enforce_tenant_rls('mfa_secrets');

COMMENT ON POLICY tenant_isolation ON public.mfa_secrets IS
  'SECURITY: the tenant boundary for MFA secrets. The secret belongs to a person; the row that holds it lives in the tenant the enrolment happened under, and no transaction outside that tenant can read or change it.';

-- Per-user, not per-tenant: a person has one authenticator.
--
-- The preceding statement applied the project's default tenant isolation to
-- this table, which hid a secret enrolled in one workspace from every other
-- workspace the same person belongs to. A step-up in that other workspace
-- then looked up no secret, concluded "not enrolled", and approved without
-- asking — the finding "Second-workspace approvals lose MFA".
--
-- MFA is a property of the person, not the workspace. The row's
-- `tenant_id` remains for provenance (where the enrolment happened), but
-- the boundary is removed so the lookup is visible to the person wherever
-- they are. The enrolment row plus `users.mfa_enrolled_at` remain the
-- cross-workspace markers; the global uniqueness index `uq_mfa_secrets_user`
-- is still the database's statement of "one authenticator per person".
ALTER TABLE public.mfa_secrets DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.mfa_secrets;

-- -----------------------------------------------------------------------------
-- 3. One writable column on `users`.
--
-- The policy admits the row: the account must be a member of the tenant the
-- transaction is scoped to. The membership subquery is itself under
-- row-level security, so it can only ever match the current tenant's rows —
-- the policy is composed, not trusted to be written correctly.
--
-- The trigger is what makes "one column" mean something. A policy decides
-- which ROWS a statement may touch; it cannot decide which COLUMNS the
-- statement may change, so the column half of the rule needs a row
-- comparison between OLD and NEW, which is the only place where "what
-- changed" is visible.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS mfa_enrolment ON public.users;
CREATE POLICY mfa_enrolment ON public.users
  AS PERMISSIVE FOR UPDATE TO pz_app
  USING (
    pz_current_tenant() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tenant_memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = pz_current_tenant()
    )
  )
  WITH CHECK (
    pz_current_tenant() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tenant_memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = pz_current_tenant()
    )
  );

COMMENT ON POLICY mfa_enrolment ON public.users IS
  'SECURITY: the runtime role may set mfa_enrolled_at on the users it has members in, and nothing else. 0007 closed the write path on this table entirely; this policy re-opens one column for the MFA enrolment, and the trigger pz_users_mfa_scope refuses every other column.';

CREATE OR REPLACE FUNCTION pz_users_mfa_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  role_exempt boolean;
BEGIN
  -- The same boundary row-level security draws: a superuser or a BYPASSRLS
  -- role is not bound by the policies, and the migration and seed connection
  -- is exempt; the runtime role is not.
  SELECT rolsuper OR rolbypassrls INTO role_exempt
    FROM pg_roles WHERE rolname = current_user;
  IF COALESCE(role_exempt, false) THEN
    RETURN NEW;
  END IF;

  -- `mfa_enrolled_at` is deliberately absent from this comparison: it is the
  -- one column this path exists to move. Everything else about a user row —
  -- who they are, whether they are active, when they signed in — belongs to
  -- the identity system, not to the MFA flow.
  --
  -- `updated_at` is absent too, and for a different reason: 0002 installs a
  -- trigger that moves it on EVERY update, so comparing it here would make
  -- this guard depend on the order two BEFORE triggers happen to fire in.
  -- It is a bookkeeping column with no meaning of its own.
  IF (NEW.id, NEW.identity_provider_subject, NEW.email, NEW.display_name, NEW.status,
      NEW.last_login_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.identity_provider_subject, OLD.email, OLD.display_name, OLD.status,
      OLD.last_login_at, OLD.created_at) THEN
    RAISE EXCEPTION
      'users row % may only have mfa_enrolled_at changed by the runtime role (tenant_id=%)',
      OLD.id, pz_current_tenant()
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pz_users_mfa_scope() IS
  'SECURITY: confines the runtime role''s write on the global users table to the single column mfa_enrolled_at. Any other column change requires an exempt role.';

DROP TRIGGER IF EXISTS trg_users_mfa_scope ON public.users;
CREATE TRIGGER trg_users_mfa_scope
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION pz_users_mfa_scope();

-- The trigger function has to stay executable by the trigger machinery on
-- behalf of pz_app; trigger functions are not callable from SQL in any useful
-- way, so EXECUTE goes back to the runtime role. Nothing else about it is
-- public.
REVOKE ALL ON FUNCTION public.pz_users_mfa_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pz_users_mfa_scope() TO pz_app;

-- -----------------------------------------------------------------------------
-- 4. The assertion that makes a half-applied migration fail instead of
--    quietly reporting isolation it does not have. `pz_rls_coverage` reads
--    the live catalog, so a table that slipped through without enforcement
--    shows up as a row rather than as an absence.
-- -----------------------------------------------------------------------------
DO $pzrls$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM public.pz_rls_coverage WHERE enforced = false;
  IF missing > 0 THEN
    RAISE EXCEPTION
      '% tenant-bearing table(s) are not fully RLS-enforced after migration 0008: %',
      missing,
      (SELECT string_agg(table_name, ', ' ORDER BY table_name) FROM public.pz_rls_coverage WHERE enforced = false);
  END IF;
END
$pzrls$;
