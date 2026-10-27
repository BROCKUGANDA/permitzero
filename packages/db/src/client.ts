/**
 * Database client: connection lifecycle, transaction helper, SQL migration
 * runner and test reset.
 *
 * Migrations are plain SQL files under `infra/migrations`, applied in filename
 * order and tracked in `_migrations`. `migrate()` is idempotent: applied files
 * are skipped, each new file runs inside a transaction with its tracking row.
 * Drizzle is the query builder only — it never generates schema.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getTableName, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { ALL_TABLES } from './schema.js';

export type DrizzleDb = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
/** The query surface repositories need; both the root client and transactions satisfy it. */
export type DbExecutor = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export interface Db {
  sql: postgres.Sql;
  db: DrizzleDb;
}

export function createDb(url: string, opts?: { max?: number }): Db {
  const client = postgres(url, { max: opts?.max ?? 10 });
  return { sql: client, db: drizzle(client, { schema }) };
}

export async function closeDb(db: Db): Promise<void> {
  await db.sql.end({ timeout: 5 });
}

export async function withTransaction<T>(db: Db, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.db.transaction((tx) => fn(tx));
}

export async function healthCheck(db: Db): Promise<boolean> {
  try {
    await db.sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Create a database if missing. Used by tests and local setup only. */
export async function ensureDatabaseExists(adminDb: Db, name: string): Promise<void> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to create database with unexpected name: ${name}`);
  }
  try {
    await adminDb.sql.unsafe(`CREATE DATABASE "${name}"`);
  } catch (err) {
    if (dbErrorCode(err) === '42P04') return; // already exists
    throw err;
  }
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../infra/migrations', import.meta.url));

/**
 * `0006_row_level_security.sql` creates the `pz_app` runtime role, which is a
 * cluster-wide object that needs a password to connect over TCP the way every
 * other role here does. The value is not committed to the repository: the file
 * carries a `{{PZ_RLS_ROLE_PASSWORD}}` placeholder and the runner substitutes it
 * from the environment.
 *
 * The character class is enforced because the substitution is textual — a
 * password containing a quote would otherwise become part of the statement.
 */
const RLS_PASSWORD_PLACEHOLDER = /\{\{PZ_RLS_ROLE_PASSWORD\}\}/g;
const RLS_PASSWORD_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function renderMigrationSql(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!RLS_PASSWORD_PLACEHOLDER.test(text)) return text;
  RLS_PASSWORD_PLACEHOLDER.lastIndex = 0;
  const value = env['PZ_RLS_ROLE_PASSWORD'] ?? 'pz_app_dev';
  if (!RLS_PASSWORD_PATTERN.test(value)) {
    throw new Error(
      'PZ_RLS_ROLE_PASSWORD must match [A-Za-z0-9_.-]{1,128}: it is substituted into SQL text, so quoting characters are not allowed.',
    );
  }
  return text.replace(RLS_PASSWORD_PLACEHOLDER, value);
}

export interface MigrateResult {
  applied: string[];
}

export async function migrate(db: Db, opts?: { migrationsDir?: string }): Promise<MigrateResult> {
  const dir = opts?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  await db.sql`CREATE TABLE IF NOT EXISTS _migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const appliedRows = await db.sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
  const applied = new Set(appliedRows.map((r) => r.filename));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const newly: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(path.join(dir, file), 'utf8');
    await withTransaction(db, async (tx) => {
      await tx.execute(sql.raw(renderMigrationSql(text)));
      await tx.execute(sql`INSERT INTO _migrations (filename) VALUES (${file})`);
    });
    newly.push(file);
  }
  return { applied: newly };
}

export interface MigrateStatus {
  applied: string[];
  pending: string[];
}

/** What `/health/ready` reports: every migration file accounted for. */
export async function migrateStatus(db: Db, opts?: { migrationsDir?: string }): Promise<MigrateStatus> {
  const dir = opts?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  let applied: string[] = [];
  try {
    const rows = await db.sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
    applied = rows.map((r) => r.filename);
  } catch {
    applied = [];
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const appliedSet = new Set(applied);
  return { applied, pending: files.filter((f) => !appliedSet.has(f)) };
}

/**
 * Truncate all data (audit triggers permit TRUNCATE). Test and local-demo use
 * only — the CLI refuses production without `--force`.
 */
export async function resetDb(db: Db): Promise<void> {
  const names = ALL_TABLES.map((t) => `"${getTableName(t)}"`).join(', ');
  await db.sql.unsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

/**
 * The SQLSTATE behind an error, however many layers wrapped it.
 *
 * Drizzle 0.45 began reporting query failures as `DrizzleQueryError`, which puts
 * the driver's `code` on `.cause` instead of on the error the caller catches.
 * Every duplicate-key and constraint check in this repository reads that code, so
 * a naive `err.code` does not fail loudly — it returns `undefined`, which matches
 * no code, and the retry paths simply stop retrying:
 *
 *   · `intake.ts` stops recognising the idempotency race, so a concurrent
 *     duplicate submission answers 500 instead of replaying the winner;
 *   · `approvals.ts` stops turning a double-decision into 409;
 *   · `repos/audit.ts` stops retrying an audit append that lost the chain-head
 *     race, turning a transient collision into a failed request.
 *
 * Walking `cause` is therefore not a convenience, it is what keeps those three
 * behaviours intact. The depth limit bounds a pathological cycle.
 */
export function dbErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True when `err` is a PostgreSQL error with one of the given SQLSTATE codes. */
export function isDbError(err: unknown, ...codes: string[]): boolean {
  const code = dbErrorCode(err);
  return code !== null && codes.includes(code);
}
