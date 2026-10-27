-- =============================================================================
-- PermitZero — 0006_row_level_security.sql
--
-- Tenant isolation as a DATABASE property, not a coding convention.
--
-- Before this file, isolation rested on every repository function remembering
-- `WHERE tenant_id = ?`. That is a convention: a future query that forgets it
-- leaks another customer's rows and nothing in the database objects. This
-- migration makes that leak structurally impossible for the role the application
-- actually runs as.
--
-- Four pieces, and all four are load-bearing:
--
--   1. `pz_app` — the runtime role: NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE,
--      NOCREATEDB. RLS does not apply to superusers or to roles carrying
--      BYPASSRLS, so an application connected as `postgres` gets zero protection
--      no matter how many policies exist. `rlsEnforcementState()` in
--      packages/db proves this at boot and /health/ready + /status report it;
--      it is never assumed.
--   2. A permissive `tenant_isolation` policy on EVERY table that carries a
--      `tenant_id` column, applied by walking the catalog rather than from a
--      hand-maintained list. A table added later is enforced automatically,
--      which is the point — the enforcement set cannot silently fall behind the
--      schema. `FORCE ROW LEVEL SECURITY` additionally binds the table owner, so
--      a deployment connected as the owner is still isolated.
--   3. `app.tenant_id`, set with `set_config(..., true)` (transaction-local) by
--      `withTenantTransaction()`. Transaction-local means it cannot leak to
--      whichever query borrows the same pooled connection next. And because the
--      policy compares against `pz_current_tenant()`, which returns NULL when
--      the GUC is unset, a transaction that forgot to set it sees ZERO rows
--      rather than all of them, and its writes are rejected. Fail closed.
--   4. A tenant-id-immutability trigger: no UPDATE may move a row between
--      tenants. The two escape-hatch policies below constrain visibility only,
--      so this trigger is what stops a visibility grant being used to smuggle a
--      row across.
--
-- Two operations are legitimately not tenant-scoped. Neither one gets the whole
-- application exempted; each gets a narrow, explicit, transaction-local escape
-- hatch (`pz.tenant_blind`, set only by `withTenantBlindTransaction`):
--
--   · the door. `findCredentialBySecretHash` cannot know a tenant before it has
--     authenticated, so SELECT on tenants, users, service_credentials, agents
--     and tenant_memberships is additionally permitted while the flag is on, and
--     only those five tables. Everything downstream runs tenant-scoped.
--   · the delivery worker. `claimOutboxEvents` uses `FOR UPDATE SKIP LOCKED`
--     across all tenants by design — a per-tenant claim loop would let one busy
--     tenant starve the queue behind it. Its UPDATE cannot retarget a row because
--     of piece 4, which is why `WITH CHECK` on that policy is the flag alone.
--
-- `{{PZ_RLS_ROLE_PASSWORD}}` is substituted by the migration runner from the
-- environment (default `pz_app_dev`, see packages/db/src/client.ts). It is a
-- local/CI development credential, and the runner rejects anything that is not
-- [A-Za-z0-9_.-]+ so the substitution cannot inject SQL. A real deployment sets
-- its own value and rotates it like any other secret; the ALTER below re-applies
-- the configured password on every run so a re-migrated database cannot keep a
-- stale one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1a. Preflight: the role running this migration must itself be exempt.
-- -----------------------------------------------------------------------------
-- The policies below are named `TO pz_app`. With RLS enabled, a role for which
-- NO policy applies sees zero rows and can write nothing — default deny. Since
-- `FORCE ROW LEVEL SECURITY` also binds the table owner, running this migration
-- as a non-exempt owner role would blind the migration/admin role in the
-- database it just created, and `db:seed`, `resetDb` and `migrateStatus` would
-- all quietly find an empty schema.
--
-- This matters on managed Postgres: an RDS `rds_superuser` has rolsuper = false.
-- Refusing here is the honest behaviour; silently shipping a blinded admin role
-- is not. Remedy for those platforms is a role carrying BYPASSRLS for the admin
-- connection only (on RDS: `GRANT rds_bypass_rls TO <role>`), while `pz_app`
-- stays non-exempt — which is the whole point of the split.

DO $pzrls$
DECLARE am_exempt boolean;
BEGIN
  SELECT bool_or(rolsuper OR rolbypassrls) INTO am_exempt
    FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(am_exempt, false) THEN
    RAISE EXCEPTION
      'this migration must run as a role with rolsuper or bypassrls (connected as "%"). '
      'Policies named TO pz_app do not apply to other roles, and FORCE ROW LEVEL SECURITY binds the table owner, '
      'so a non-exempt owner would see zero rows afterwards. On AWS RDS: GRANT rds_bypass_rls TO <admin role>.',
      current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$pzrls$;

-- -----------------------------------------------------------------------------
-- 1b. The runtime role (cluster-wide object, so created before per-database work)
-- -----------------------------------------------------------------------------

DO $pzrls$
DECLARE
  needs_alter boolean;
BEGIN
  -- Roles are CLUSTER-WIDE, but this migration runs once per database, and the
  -- test harness migrates one database per vitest worker concurrently. Two
  -- workers reaching for the same `pz_app` tuple is where a migration can die for
  -- a reason that has nothing to do with the database it is opening, so the
  -- advisory lock serialises the intent.
  --
  -- Transaction-scoped on purpose: it is released when the migration commits or
  -- rolls back, so a crashed migrator cannot leave the role creation blocked.
  PERFORM pg_advisory_xact_lock(hashtextextended('pz_rls_role', 0));

  BEGIN
    CREATE ROLE pz_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB
      PASSWORD '{{PZ_RLS_ROLE_PASSWORD}}';
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  -- The unconditional `ALTER ROLE` that used to follow this still lost races: the
  -- lock orders the intent, but every database opened afterwards wrote the same
  -- pg_authid tuple, and PostgreSQL answered `tuple concurrently updated`
  -- (SQLSTATE XX000), aborting that whole migration transaction — the worker's
  -- database then had no 0006, no pz_rls_coverage, and a file of tests failing
  -- with 500s whose cause was an unrelated database opening at the same moment.
  -- Observed twice; this is why the write is now conditional.
  --
  -- A per-database migration has no business performing a cluster-wide write on
  -- every run. The role is repaired when it has drifted from what this file
  -- requires, and doing nothing otherwise is the correct outcome. Rotating the
  -- password on a live cluster stays an explicit `ALTER ROLE pz_app PASSWORD ...`
  -- by an operator, not a side effect of opening a database.
  SELECT rolsuper OR rolbypassrls OR NOT rolcanlogin OR rolcreaterole OR rolcreatedb
    INTO needs_alter
    FROM pg_roles
   WHERE rolname = 'pz_app';

  IF COALESCE(needs_alter, true) THEN
    ALTER ROLE pz_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB
      PASSWORD '{{PZ_RLS_ROLE_PASSWORD}}';
  END IF;
END
$pzrls$;

-- If an operator has since marked the role superuser or BYPASSRLS, every policy
-- below is decoration. Fail the migration instead of reporting isolation that
-- does not exist.
DO $pzrls$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'pz_app';
  IF r IS NULL THEN
    RAISE EXCEPTION 'role pz_app is missing after role setup; cannot continue';
  END IF;
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION
      'role pz_app has rolsuper=% rolbypassrls=%; row-level security is bypassed for such a role, so tenant isolation cannot hold. Remove those attributes.',
      r.rolsuper, r.rolbypassrls;
  END IF;
END
$pzrls$;

-- -----------------------------------------------------------------------------
-- 2. Catalog helpers used by the policies
-- -----------------------------------------------------------------------------
-- STABLE (not VOLATILE) so the planner evaluates them once per statement and can
-- still use the (tenant_id, ...) indexes; a VOLATILE call would be re-tested for
-- every candidate row.

CREATE OR REPLACE FUNCTION pz_current_tenant() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT current_setting('app.tenant_id', true) $$;

CREATE OR REPLACE FUNCTION pz_tenant_blind() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT current_setting('pz.tenant_blind', true) = 'on' $$;

-- Defined here, before pz_enforce_tenant_rls() references it: the event trigger
-- can be invoked by DDL at any point after this migration, so the helper must
-- already exist by then.
CREATE OR REPLACE FUNCTION pz_tenant_id_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'tenant_id is immutable on %.% (old=% new=%): a row cannot be moved between tenants',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.tenant_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION pz_current_tenant() IS
  'The tenant the current transaction is scoped to, or NULL. NULL is not "everything": every policy compares equality against it, so an unset context matches no row and rejects every write. Set transaction-local by withTenantTransaction().';
COMMENT ON FUNCTION pz_tenant_blind() IS
  'True only inside a withTenantBlindTransaction() — the door lookup and the cross-tenant outbox claim. Transaction-local, so it cannot persist onto a reused pooled connection.';

-- -----------------------------------------------------------------------------
-- 3. Grants. Table-level privilege only: which ROWS pz_app may touch is decided
--    exclusively by the policies below, never by a grant.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO pz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pz_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pz_app;

-- So tables created by a later migration are reachable without another grant
-- statement (the row policy still applies).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pz_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pz_app;

-- -----------------------------------------------------------------------------
-- 4. Enforce on every tenant-bearing table, discovered from the catalog
-- -----------------------------------------------------------------------------
-- One function holds the whole recipe so the initial sweep below and the DDL
-- event trigger in 4b cannot drift apart — a table created by migration 0007
-- gets enforced by the identical code path, not by someone remembering to add
-- another migration.

CREATE OR REPLACE FUNCTION pz_enforce_tenant_rls(p_table text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_table IS NULL OR p_table = '' THEN RETURN; END IF;
  -- The bookkeeping table and anything outside public are not tenant-bearing.
  IF p_table IN ('_migrations', 'pz_rls_coverage') THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_table AND column_name = 'tenant_id'
  ) THEN
    RETURN;
  END IF;

  -- A VIEW satisfies information_schema.columns too, and cannot carry RLS.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = p_table AND c.relkind = 'r'
  ) THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);
  -- Existence-checked instead of `DROP ... IF EXISTS`: the unconditional form
  -- emits one NOTICE per table per migration run, and 22 of those on every test
  -- worker's first query drowns the real warnings in the suite output.
  IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = p_table AND p.polname = 'tenant_isolation') THEN
    EXECUTE format('DROP POLICY tenant_isolation ON public.%I', p_table);
  END IF;
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON public.%I '
    || 'AS PERMISSIVE FOR ALL TO pz_app '
    || 'USING (tenant_id = pz_current_tenant()) '
    || 'WITH CHECK (tenant_id = pz_current_tenant())',
    p_table
  );

  IF EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = p_table
                AND tg.tgname = 'trg_' || p_table || '_tenant_id_immutable') THEN
    EXECUTE format('DROP TRIGGER trg_%I_tenant_id_immutable ON public.%I', p_table, p_table);
  END IF;
  EXECUTE format(
    'CREATE TRIGGER trg_%I_tenant_id_immutable BEFORE UPDATE ON public.%I '
    || 'FOR EACH ROW EXECUTE FUNCTION pz_tenant_id_immutable()',
    p_table, p_table
  );

  -- Needed because GRANT ... ON ALL TABLES only covers objects that exist at
  -- grant time; a table created by a later migration would otherwise be
  -- unreachable by the runtime role.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO pz_app', p_table);
END
$fn$;

COMMENT ON FUNCTION pz_enforce_tenant_rls(text) IS
  'SECURITY: apply the tenant_isolation policy and tenant-id-immutability trigger to one table. Idempotent. Called by the migration sweep and by the pz_rls_on_ddl event trigger, so no tenant-bearing table can exist unenforced.';

DO $pzrls$
DECLARE
  r record;
  enforced integer := 0;
BEGIN
  FOR r IN
    SELECT t.table_name
      FROM information_schema.tables t
      JOIN information_schema.columns c
        ON c.table_name = t.table_name AND c.table_schema = t.table_schema
     WHERE t.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.column_name = 'tenant_id'
     ORDER BY t.table_name
  LOOP
    PERFORM pz_enforce_tenant_rls(r.table_name);
    enforced := enforced + 1;
  END LOOP;
  RAISE NOTICE 'row-level security enforced on % tenant-bearing tables', enforced;
END
$pzrls$;

-- 4b. A new tenant-bearing table is enforced the moment it is created, by
-- whoever creates it. Without this, the enforcement set falls behind the schema
-- exactly when a later migration adds a table and nobody thinks about RLS —
-- which is the failure this whole slice exists to prevent.
--
-- PostgreSQL has no `ddl_table_end` event (it was removed in 9.5), so this hooks
-- `ddl_command_end` and filters. The table is resolved from `objid` against
-- pg_class rather than by parsing `object_identity`, which is schema-qualified
-- and carries a column name for `table comment`-style subcommands.
CREATE OR REPLACE FUNCTION pz_rls_on_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  obj record;
  tbl  text;
BEGIN
  -- Recursion guard: pz_enforce_tenant_rls() itself runs ALTER TABLE / CREATE
  -- POLICY, which would otherwise re-enter this trigger.
  --
  -- Session-scoped rather than transaction-scoped on purpose, and cleared on
  -- BOTH exits. A migration file is one transaction containing many ALTER TABLE
  -- statements; had this been `set_config(..., true)` the first statement would
  -- have left it on for the rest of the transaction and every later table in the
  -- same file would go unenforced — a fail-open bug that looks like success. The
  -- probe that found it is packages/db/test/rls.test.ts.
  IF current_setting('pz.in_rls_ddl', true) = 'on' THEN RETURN; END IF;
  PERFORM set_config('pz.in_rls_ddl', 'on', false);

  BEGIN
    FOR obj IN
      SELECT * FROM pg_event_trigger_ddl_commands()
     WHERE schema_name = 'public'
       AND classid = 'pg_class'::regclass::oid
       AND command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'ALTER TABLE',
                           'CREATE MATERIALIZED VIEW', 'SELECT INTO')
    LOOP
      SELECT c.relname INTO tbl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = obj.objid AND n.nspname = 'public' AND c.relkind IN ('r', 'p');
      IF FOUND THEN
        PERFORM pz_enforce_tenant_rls(tbl);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('pz.in_rls_ddl', 'off', false);
    RAISE;
  END;

  PERFORM set_config('pz.in_rls_ddl', 'off', false);
END
$fn$;

DROP EVENT TRIGGER IF EXISTS pz_rls_on_ddl;
CREATE EVENT TRIGGER pz_rls_on_ddl ON ddl_command_end
  EXECUTE FUNCTION pz_rls_on_ddl();

COMMENT ON EVENT TRIGGER pz_rls_on_ddl IS
  'SECURITY: re-applies tenant row-level security after any CREATE/ALTER TABLE on a public table, so enforcement cannot be forgotten for a table added later.';


-- -----------------------------------------------------------------------------
-- 5. The two global tables, scoped by relationship rather than by a column
-- -----------------------------------------------------------------------------
-- `users` has no tenant_id. Its tenant link is membership, so the policy walks
-- that link. The subquery reads tenant_memberships, which is itself under RLS
-- for pz_app, so it can only ever match rows of the current tenant — the policy
-- is composed, not trusted to be written correctly.

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_membership ON public.users;
CREATE POLICY tenant_membership ON public.users
  AS PERMISSIVE FOR ALL TO pz_app
  USING (
    pz_tenant_blind()
    OR (pz_current_tenant() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tenant_memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = pz_current_tenant()
    ))
  )
  -- A tenant context may never write the global user row; only the door path may,
  -- and it only ever touches last_login_at / mfa_enrolled_at.
  WITH CHECK (pz_tenant_blind());

DROP POLICY IF EXISTS tenant_self ON public.tenants;
CREATE POLICY tenant_self ON public.tenants
  AS PERMISSIVE FOR ALL TO pz_app
  USING (id = pz_current_tenant())
  WITH CHECK (id = pz_current_tenant());

-- -----------------------------------------------------------------------------
-- 6. Escape hatch: the door (SELECT on exactly these five tables)
-- -----------------------------------------------------------------------------

DO $pzrls$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
      'tenants', 'users', 'service_credentials', 'agents', 'tenant_memberships'
    ]) AS table_name
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS door_lookup ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY door_lookup ON public.%I AS PERMISSIVE FOR SELECT TO pz_app USING (pz_tenant_blind())',
      r.table_name
    );
  END LOOP;
END
$pzrls$;

-- -----------------------------------------------------------------------------
-- 7. Escape hatch: the cross-tenant outbox claim
-- -----------------------------------------------------------------------------
-- WITH CHECK is the flag alone because the immutability trigger below makes an
-- UPDATE that changes tenant_id impossible regardless of policy.
DROP POLICY IF EXISTS dispatch_claim ON public.outbox_events;
CREATE POLICY dispatch_claim ON public.outbox_events
  AS PERMISSIVE FOR ALL TO pz_app
  USING (pz_tenant_blind())
  WITH CHECK (pz_tenant_blind());

-- -----------------------------------------------------------------------------
-- 8. Lock down the SECURITY DEFINER helpers
-- -----------------------------------------------------------------------------
-- `pz_enforce_tenant_rls()` and `pz_rls_on_ddl()` run as the migrating role,
-- which is superuser or BYPASSRLS per the preflight in 1a. Leaving them
-- EXECUTE-able by PUBLIC would hand the runtime role a path into a superuser-
-- owned function — a real escalation surface even if the worst it can currently
-- do is add enforcement. Superusers bypass ACL checks, so revoking from PUBLIC
-- costs the migration nothing and closes the surface for everyone else.

REVOKE ALL ON FUNCTION public.pz_enforce_tenant_rls(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pz_rls_on_ddl() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pz_tenant_id_immutable() FROM PUBLIC;

-- The tenant-id-immutability trigger function has to stay executable by the
-- trigger machinery on behalf of pz_app; trigger functions are not callable
-- from SQL in any useful way, so EXECUTE goes back to the runtime role.
GRANT EXECUTE ON FUNCTION public.pz_tenant_id_immutable() TO pz_app;

COMMENT ON FUNCTION public.pz_tenant_id_immutable() IS
  'SECURITY: blocks UPDATE that changes tenant_id. The door_lookup and dispatch_claim policies constrain visibility only; this trigger is what prevents them being used to move a row into another tenant.';

-- -----------------------------------------------------------------------------
-- 9. Machine-readable coverage, so "enforced" is a query and not a claim
-- -----------------------------------------------------------------------------
-- /health/ready and the compliance evidence map both read this. A tenant-bearing
-- table that somehow lacks enforcement shows up as an `enforced = false` row
-- rather than being invisible.

CREATE OR REPLACE VIEW public.pz_rls_coverage AS
SELECT
  c.table_name,
  COALESCE(cls.relrowsecurity, false)      AS rls_enabled,
  COALESCE(cls.relforcerowsecurity, false) AS rls_forced,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = cls.oid) AS policy_count,
  (SELECT count(*) FROM pg_trigger tg
    WHERE tg.tgrelid = cls.oid AND NOT tg.tgisinternal
      AND tg.tgname = 'trg_' || c.table_name || '_tenant_id_immutable') AS immutable_trigger,
  COALESCE(cls.relrowsecurity, false)
    AND COALESCE(cls.relforcerowsecurity, false)
    AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = cls.oid) > 0
    AND (SELECT count(*) FROM pg_trigger tg
          WHERE tg.tgrelid = cls.oid AND NOT tg.tgisinternal
            AND tg.tgname = 'trg_' || c.table_name || '_tenant_id_immutable') = 1
    AS enforced
FROM (
  SELECT DISTINCT t.table_name
    FROM information_schema.tables t
    JOIN information_schema.columns col
      ON col.table_name = t.table_name AND col.table_schema = t.table_schema
   WHERE t.table_schema = 'public'
     AND t.table_type = 'BASE TABLE'
     AND col.column_name = 'tenant_id'
) c
LEFT JOIN pg_class cls ON cls.relname = c.table_name
  AND cls.relnamespace = 'public'::regnamespace
  AND cls.relkind = 'r';

COMMENT ON VIEW public.pz_rls_coverage IS
  'Per-tenant-table row-level-security state. enforced = true means: RLS enabled, RLS forced for the owner, at least one policy, and the tenant-id-immutability trigger present. Read by /health/ready, /status and the compliance evidence map.';

-- Created after `GRANT ... ON ALL TABLES`, so it needs its own grant. Read-only
-- for the runtime role: it is a self-report of the boundary, not a data path.
GRANT SELECT ON TABLE public.pz_rls_coverage TO pz_app;

-- The assertion that makes a half-applied migration fail instead of quietly
-- reporting isolation it does not have.
DO $pzrls$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM public.pz_rls_coverage WHERE enforced = false;
  IF missing > 0 THEN
    RAISE EXCEPTION
      '% tenant-bearing table(s) are not fully RLS-enforced after migration: %',
      missing,
      (SELECT string_agg(table_name, ', ' ORDER BY table_name) FROM public.pz_rls_coverage WHERE enforced = false);
  END IF;
END
$pzrls$;

-- -----------------------------------------------------------------------------
-- 10. Security comments (same convention as 0003)
-- -----------------------------------------------------------------------------

COMMENT ON POLICY tenant_isolation ON public.actions IS
  'SECURITY: the database-level tenant boundary. A query that forgets WHERE tenant_id = ? now returns only the current tenant''s rows instead of every tenant''s.';
