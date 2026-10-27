/**
 * Row-level security: does the database actually enforce tenant isolation?
 *
 * The reason this file exists at all is that every other test in this suite
 * connects as the admin role, which is exempt from RLS. A tenant-isolation
 * assertion made on that connection cannot fail, because the rows it expects to
 * be hidden are reachable with the role it is testing with. So the interesting
 * connection here is `testAppDb()` — the restricted `pz_app` role — and the
 * "capable of failing" test deliberately re-runs the headline query as admin.
 *
 * Write-path assertions use `rls_probe_widget`, a table this file creates itself,
 * rather than `audit_events`: audit_events carries a hash-chain BEFORE INSERT
 * trigger that would reject a fixture row for reasons that have nothing to do
 * with RLS, and a test that passes for the wrong reason is worth nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { newId } from '@permitzero/domain';
import {
  appendAuditEvent,
  createCredential,
  resetDb,
  rlsEnforcementState,
  seed,
  withTenantBlindTransaction,
  withTenantTransaction,
  type Db,
  type DbTransaction,
  type SeedResult,
} from '../src/index.js';
import { closeTestDb, testAppDb, testDb } from './db-test.js';
import { expectSqlstate } from './sqlstate.js';

let admin: Db;
let app: Db;
let seeded: SeedResult;
let tenantA = '';
let tenantB = '';
let auditCountA = 0;
let auditCountB = 0;

const q = <T>(tx: DbTransaction, text: string): Promise<T[]> => tx.execute(sql.raw(text)) as unknown as Promise<T[]>;

const PROBE = 'rls_probe_widget';

beforeAll(async () => {
  admin = await testDb();
  app = await testAppDb();
  await resetDb(admin);
  seeded = await seed(admin, { tenants: 3 });
  tenantA = seeded.tenantIds[0] ?? '';
  tenantB = seeded.tenantIds[1] ?? '';
  if (!tenantA || !tenantB) throw new Error('seed(tenants: 3) must produce at least two tenants');

  await admin.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.${PROBE} (
      probe_id  text PRIMARY KEY,
      tenant_id text NOT NULL REFERENCES tenants(id),
      note      text
    )
  `);

  // Rows in two tenants, written through the admin connection on purpose: the
  // point is that the data is definitely there for the restricted role to fail
  // to find.
  for (const tenantId of [tenantA, tenantB]) {
    for (let i = 0; i < 2; i++) {
      await appendAuditEvent(admin.db, {
        tenantId,
        actorType: 'AGENT',
        actorId: seeded.agentIds[0] ?? 'a',
        eventType: 'test.fixture',
        traceId: `trace-${tenantId}-${i}`,
        payload: { i },
      });
    }
    await admin.sql.unsafe(
      `INSERT INTO public.${PROBE} (probe_id, tenant_id, note) VALUES ('p-${tenantId}', '${tenantId}', 'owned')`,
    );
  }
  const countA = await admin.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = ${tenantA}`;
  const countB = await admin.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = ${tenantB}`;
  auditCountA = Number(countA[0]?.n ?? 0);
  auditCountB = Number(countB[0]?.n ?? 0);

  // seed() builds the rich demo tenant and leaves the extra tenants empty, which
  // means tenantB has no credential at all. The door-lookup test needs a
  // credential in two tenants or it proves nothing about crossing tenants.
  await createCredential(admin.db, {
    id: newId('credential'),
    tenantId: tenantB,
    name: 'probe-credential-b',
    subjectType: 'AGENT',
    subjectId: null,
    credentialRef: `secret://probe/${tenantB}`,
    secretHash: `sha256:${'e'.repeat(64)}`,
    secretPrefix: 'probe',
    scopes: [],
  });
});

afterAll(async () => {
  await admin.sql.unsafe(`DROP TABLE IF EXISTS public.${PROBE}`);
  await closeTestDb();
});

describe('rls: the role actually in use', () => {
  it('pz_app is subject to row-level security and every tenant table is covered', async () => {
    const state = await rlsEnforcementState(app);
    expect(state.role).toBe('pz_app');
    expect(state.superuser).toBe(false);
    expect(state.bypassrls).toBe(false);
    expect(state.subjectToRls).toBe(true);
    expect(state.coverageReadable).toBe(true);
    expect(state.tablesTotal).toBeGreaterThan(0);
    expect(state.unenforcedTables).toEqual([]);
    expect(state.enforced).toBe(true);
  });

  it('the admin connection is exempt, which is why it must not serve tenant reads', async () => {
    const state = await rlsEnforcementState(admin);
    expect(state.subjectToRls).toBe(false);
    expect(state.enforced).toBe(false);
  });

  it('every tenant-bearing table is enforced and forced', async () => {
    const cov = await admin.sql<{ table_name: string; enforced: boolean; rls_forced: boolean }[]>`
      SELECT table_name, enforced, rls_forced FROM pz_rls_coverage ORDER BY table_name`;
    expect(cov.length).toBeGreaterThanOrEqual(22);
    expect(cov.every((c) => c.enforced)).toBe(true);
    expect(cov.every((c) => c.rls_forced)).toBe(true);
    for (const required of [
      'actions',
      'audit_events',
      'permits',
      'executions',
      'service_credentials',
      'outbox_events',
      'idempotency_records',
      'policy_revisions',
    ]) {
      expect(
        cov.map((c) => c.table_name),
        required,
      ).toContain(required);
    }
    // The probe table this file created at runtime is already covered, because
    // the DDL event trigger applied enforcement when it was made.
    expect(cov.map((c) => c.table_name)).toContain(PROBE);
  });
});

describe('rls: the headline property', () => {
  it('a SELECT with no WHERE clause returns only the caller tenant rows', async () => {
    expect(auditCountB).toBeGreaterThan(0);
    const found = await withTenantTransaction(app, tenantA, (tx) =>
      q<{ tenant_id: string }>(tx, 'SELECT * FROM audit_events'),
    );
    expect(found).toHaveLength(auditCountA);
    expect(found.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  it('the same query as admin sees both tenants, so the test above can fail', async () => {
    // Without this the "only own tenant" assertion could be passing because the
    // fixture never wrote for tenantB, or because RLS is not being exercised.
    const seen = await admin.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_events`;
    expect(Number(seen[0]?.n ?? 0)).toBe(auditCountA + auditCountB);
    expect(auditCountA + auditCountB).toBeGreaterThan(auditCountA);
  });

  it('a transaction that forgot its tenant context sees nothing rather than everything', async () => {
    const seen = await app.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_events`;
    expect(seen[0]?.n).toBe('0');
    const empty = await withTenantTransaction(app, '', (tx) => q(tx, 'SELECT * FROM audit_events'));
    expect(empty).toEqual([]);
  });

  it('a cross-tenant UPDATE matches no rows and changes nothing', async () => {
    await withTenantTransaction(app, tenantA, (tx) =>
      q(tx, `UPDATE ${PROBE} SET note = 'tampered' WHERE tenant_id = '${tenantB}'`),
    );
    const after = await admin.sql.unsafe<{ note: string }[]>(
      `SELECT note FROM public.${PROBE} WHERE tenant_id = '${tenantB}'`,
    );
    expect(after[0]?.note).toBe('owned');
  });

  it('a cross-tenant INSERT is rejected by the policy', async () => {
    await expectSqlstate(
      withTenantTransaction(app, tenantA, (tx) =>
        q(tx, `INSERT INTO ${PROBE} (probe_id, tenant_id, note) VALUES ('steal', '${tenantB}', 'no')`),
      ),
      '42501',
    );

    const leaked = await admin.sql.unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM public.${PROBE} WHERE probe_id = 'steal'`,
    );
    expect(leaked[0]?.n).toBe('0');
  });

  it('tenant_id cannot be changed by an UPDATE, even in a context that can see the row', async () => {
    // Both GUCs at once, because otherwise RLS hides the row first, the trigger
    // never runs, and the test would be asserting the wrong guard.
    // 23514 (check_violation) is what the trigger raises; asserting the message
    // text would pin the test to whichever library last wrapped the error.
    await expectSqlstate(
      app.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${tenantA}, true), set_config('pz.tenant_blind', 'on', true)`,
        );
        await tx.execute(sql.raw(`UPDATE ${PROBE} SET tenant_id = '${tenantB}' WHERE probe_id = 'p-${tenantA}'`));
      }),
      '23514',
    );
  });
});

describe('rls: the escape hatch is as narrow as the code claims', () => {
  it('the door lookup sees credentials across tenants', async () => {
    const found = await withTenantBlindTransaction(app, (tx) =>
      q<{ tenant_id: string }>(tx, 'SELECT tenant_id FROM service_credentials'),
    );
    expect(new Set(found.map((f) => f.tenant_id)).size).toBeGreaterThanOrEqual(2);
  });

  it('the blind flag does NOT open the tenant tables it has no business opening', async () => {
    for (const table of ['audit_events', 'actions', 'permits', 'executions', 'invoices', 'approvals', PROBE]) {
      const found = await withTenantBlindTransaction(app, (tx) =>
        q<{ n: string }>(tx, `SELECT count(*)::text AS n FROM ${table}`),
      );
      expect(found[0]?.n, table).toBe('0');
    }
  });

  it('the blind flag does not leak onto the pooled connection afterwards', async () => {
    await withTenantBlindTransaction(app, async () => undefined);
    const seen = await app.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM service_credentials`;
    expect(seen[0]?.n).toBe('0');
  });

  it('tenant-scoped reads of a door table stay limited to one tenant', async () => {
    const found = await withTenantTransaction(app, tenantA, (tx) =>
      q<{ tenant_id: string }>(tx, 'SELECT tenant_id FROM service_credentials'),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.tenant_id === tenantA)).toBe(true);
  });
});

describe('rls: the runtime role cannot weaken its own boundary', () => {
  const refusals: Array<[string, RegExp]> = [
    ['ALTER TABLE public.audit_events DISABLE ROW LEVEL SECURITY', /must be owner/],
    ['ALTER TABLE public.audit_events NO FORCE ROW LEVEL SECURITY', /must be owner/],
    ['DROP POLICY tenant_isolation ON public.audit_events', /must be owner/],
    ['DROP TRIGGER trg_audit_events_tenant_id_immutable ON public.audit_events', /must be owner/],
    ["SELECT public.pz_enforce_tenant_rls('actions')", /permission denied/],
    ['CREATE POLICY oops ON public.audit_events TO pz_app USING (true)', /must be owner/],
    ['ALTER ROLE pz_app WITH BYPASSRLS', /permission denied|must be superuser/],
    ['CREATE POLICY sneaky ON public.' + PROBE + ' TO pz_app USING (true)', /must be owner/],
  ];
  it.each(refusals)('%s is refused', async (statement, expected) => {
    await expect(app.sql.unsafe(statement)).rejects.toThrow(expected);
  });
});

describe('rls: enforcement cannot fall behind the schema', () => {
  it('a second table created after the migration, in the same session, is enforced too', async () => {
    // Regression for a real fail-open found by this suite: the DDL event trigger
    // cleared its recursion guard only on the exception path, so the first ALTER
    // TABLE of a migration switched enforcement off for every later table in that
    // transaction — and the migration still reported success.
    await admin.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS public.rls_later_probe (probe_id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id))`,
    );
    const cov = await admin.sql<{ enforced: boolean }[]>`
      SELECT enforced FROM pz_rls_coverage WHERE table_name = 'rls_later_probe'`;
    expect(cov).toHaveLength(1);
    expect(cov[0]?.enforced).toBe(true);

    await withTenantTransaction(app, tenantA, (tx) =>
      q(tx, `INSERT INTO rls_later_probe (probe_id, tenant_id) VALUES ('ok-a', '${tenantA}')`),
    );
    await expectSqlstate(
      withTenantTransaction(app, tenantA, (tx) =>
        q(tx, `INSERT INTO rls_later_probe (probe_id, tenant_id) VALUES ('bad-b', '${tenantB}')`),
      ),
      '42501',
    );

    await admin.sql.unsafe(`DROP TABLE IF EXISTS public.rls_later_probe`);
  });

  it('a tenant-less table is left alone by the enforcer', async () => {
    await admin.sql.unsafe(`CREATE TABLE IF NOT EXISTS public.rls_global_probe (id text PRIMARY KEY)`);
    const cov = await admin.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pz_rls_coverage WHERE table_name = 'rls_global_probe'`;
    expect(cov[0]?.n).toBe(0);
    await admin.sql.unsafe(`DROP TABLE IF EXISTS public.rls_global_probe`);
  });
});
