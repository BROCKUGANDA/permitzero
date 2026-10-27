#!/usr/bin/env tsx
/**
 * Database CLI: migrate | seed | reset | health.
 *
 * Reads `DATABASE_URL` (and `APP_ENV`) from the environment / `.env` file.
 * `seed` writes the demo bearer tokens to `storage/demo-credentials.json`
 * (gitignored runtime state) outside production; secrets are never printed.
 */
import { loadRootEnv } from './root-env.js';

// Resolved from the repository root rather than from cwd, which npm sets to this
// package when it runs `npm run db:migrate`.
loadRootEnv();
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closeDb, createDb, ensureDatabaseExists, healthCheck, migrate, resetDb } from './client.js';
import { seed } from './seed.js';

const APP_ENV = process.env['APP_ENV'] ?? 'development';

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('error: DATABASE_URL is not set (see .env.example).');
    process.exit(1);
  }
  return url;
}

async function ensureTargetExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  parsed.pathname = '/postgres';
  const admin = createDb(parsed.toString(), { max: 1 });
  try {
    await ensureDatabaseExists(admin, name);
  } finally {
    await closeDb(admin);
  }
}

async function cmdMigrate(): Promise<void> {
  const url = databaseUrl();
  await ensureTargetExists(url);
  const db = createDb(url);
  try {
    const result = await migrate(db);
    if (result.applied.length === 0) console.log('migrations: already up to date.');
    else for (const file of result.applied) console.log(`migrations: applied ${file}`);
  } finally {
    await closeDb(db);
  }
}

async function cmdSeed(): Promise<void> {
  if (APP_ENV === 'production') {
    console.error('error: refusing to seed synthetic demo data in production.');
    process.exit(1);
  }
  const url = databaseUrl();
  await ensureTargetExists(url);
  const db = createDb(url);
  try {
    await migrate(db);
    const result = await seed(db);
    const storageDir = fileURLToPath(new URL('../../../storage', import.meta.url));
    await mkdir(storageDir, { recursive: true });
    await writeFile(
      `${storageDir}/demo-credentials.json`,
      `${JSON.stringify(
        {
          tenantIds: result.tenantIds,
          userIds: result.userIds,
          agentIds: result.agentIds,
          agentTokens: result.agentTokens,
          userTokens: result.userTokens,
          serviceTokens: result.serviceTokens,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(
      `seed: tenant ${result.tenantIds[0]} with ${Object.keys(result.userIds).length} users, 1 agent, 1 policy.`,
    );
    console.log('seed: demo bearer tokens written to storage/demo-credentials.json (gitignored, do not share).');
  } finally {
    await closeDb(db);
  }
}

async function cmdReset(args: string[]): Promise<void> {
  if (APP_ENV === 'production' && !args.includes('--force')) {
    console.error('error: refusing to reset a production database without --force.');
    process.exit(1);
  }
  const url = databaseUrl();
  await ensureTargetExists(url);
  const db = createDb(url);
  try {
    await migrate(db);
    await resetDb(db);
    console.log('reset: all tables truncated (schema and migration history kept).');
  } finally {
    await closeDb(db);
  }
}

async function cmdHealth(): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    const ok = await healthCheck(db);
    console.log(ok ? 'health: database reachable.' : 'health: database unreachable.');
    process.exit(ok ? 0 : 1);
  } finally {
    await closeDb(db);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'migrate':
      await cmdMigrate();
      break;
    case 'seed':
      await cmdSeed();
      break;
    case 'reset':
      await cmdReset(args);
      break;
    case 'health':
      await cmdHealth();
      break;
    default:
      console.error('usage: cli.ts <migrate|seed|reset|health>');
      process.exit(1);
  }
}

await main();
