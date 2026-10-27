/**
 * Shared DB test harness. Each vitest worker gets its own database
 * (`<base>_<pool>_<worker>`, created on demand and migrated), so test files
 * can run in parallel without sharing state. Every test starts from a clean
 * slate via `resetTestDb()`.
 *
 * Safety: refuses to run unless the database name contains "test".
 */
import { closeDb, createDb, ensureDatabaseExists, migrate, resetDb, type Db } from '../src/index.js';

const poolId = process.env['VITEST_POOL_ID'] ?? '1';
const workerId = process.env['VITEST_WORKER_ID'] ?? '1';
const BASE_URL = process.env['DATABASE_URL_TEST'] ?? 'postgres://postgres@127.0.0.1:5432/permitzero_test';

function workerUrl(): string {
  const url = new URL(BASE_URL);
  const baseName = url.pathname.replace(/^\//, '') || 'permitzero_test';
  url.pathname = `/${baseName}_${poolId}_${workerId}`;
  return url.toString();
}

let db: Db | null = null;

export async function testDb(): Promise<Db> {
  if (db) return db;
  const url = workerUrl();
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(`refusing to run db tests against non-test database "${name}"`);
  }
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  const admin = createDb(`${parsed.protocol}//${auth}${parsed.host}/postgres`, { max: 1 });
  try {
    await ensureDatabaseExists(admin, name);
  } finally {
    await closeDb(admin);
  }
  db = createDb(url, { max: 5 });
  await migrate(db);
  // One clean database per test FILE. Vitest reuses a worker slot for several
  // files and the slot's database outlives the process that made it, so without
  // this a file inherits whatever the previous file left — which showed up as
  // `uq_tenants_slug` collisions on the demo tenant the instant a second file
  // started seeding three tenants. `beforeEach` resets are not enough: they run
  // after `beforeAll` has already seeded.
  await resetDb(db);
  return db;
}

export async function resetTestDb(): Promise<void> {
  await resetDb(await testDb());
}

export async function closeTestDb(): Promise<void> {
  if (db) {
    await closeDb(db);
    db = null;
  }
  if (appDb) {
    await closeDb(appDb);
    appDb = null;
  }
}

/**
 * A second connection to the SAME worker database, authenticated as the
 * restricted `pz_app` runtime role created by
 * `infra/migrations/0006_row_level_security.sql`.
 *
 * This exists because row-level security is a property of the *role*, not of
 * the schema: every other test in this suite connects as the admin role, which
 * is exempt, so testing tenant isolation against `testDb()` would prove nothing
 * at all. Assertions that claim isolation is enforced must go through here.
 */
let appDb: Db | null = null;

export async function testAppDb(): Promise<Db> {
  if (appDb) return appDb;
  await testDb(); // guarantees the database exists and 0006 has run
  const parsed = new URL(workerUrl());
  const password = process.env['PZ_RLS_ROLE_PASSWORD'] ?? 'pz_app_dev';
  parsed.username = 'pz_app';
  parsed.password = password;
  appDb = createDb(parsed.toString(), { max: 4 });
  return appDb;
}
