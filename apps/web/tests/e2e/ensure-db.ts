/**
 * Ensures the e2e database exists so the API can boot and migrate.
 * Seeding happens later, in global setup, once both servers are up.
 */
import { closeDb, createDb, ensureDatabaseExists } from '@permitzero/db';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/permitzero_e2e';

if (!/e2e|test/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error(`refusing to touch non-test database ${DATABASE_URL}`);
}

const parsed = new URL(DATABASE_URL);
const name = parsed.pathname.replace(/^\//, '');
parsed.pathname = '/postgres';
const admin = createDb(parsed.toString(), { max: 1 });
try {
  await ensureDatabaseExists(admin, name);
  console.log(`[e2e] database ${name} present`);
} finally {
  await closeDb(admin);
}
