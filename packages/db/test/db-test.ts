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
}
