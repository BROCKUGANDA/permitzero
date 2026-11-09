#!/usr/bin/env node
/**
 * scripts/judge/setup.mjs
 *
 * Judge-friendly setup: verify toolchain, PostgreSQL and Redis, apply migrations,
 * seed synthetic data, and report health-check readiness.
 *
 * Exits non-zero on the first failed check with a named diagnostic.
 *
 * Usage:
 *   node scripts/judge/setup.mjs
 */

import { spawnSync } from 'node:child_process';

let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return res;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`setup: required environment variable ${name} is not set`);
    process.exit(2);
  }
  return v;
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  console.log('PermitZero judge setup\n');

  // Load .env if present (mirrors scripts/dev.mjs), so a judge can run
  // `cp .env.example .env` and then `npm run judge:setup` without exporting.
  const root = resolve(process.cwd());
  const envPath = resolve(root, '.env');
  const envFile = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const envValue = (name) => {
    const fromFile = envFile.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
    return process.env[name] || fromFile || '';
  };
  if (envValue('DATABASE_URL')) process.env.DATABASE_URL = envValue('DATABASE_URL');
  if (envValue('DATABASE_URL_RUNTIME')) process.env.DATABASE_URL_RUNTIME = envValue('DATABASE_URL_RUNTIME');
  if (envValue('REDIS_URL')) process.env.REDIS_URL = envValue('REDIS_URL');

  // 1. Toolchain
  const node = run(process.execPath, ['--version']);
  const npm = run('npm', ['--version']);
  check('node >= 20', node.status === 0, node.stdout.trim());
  check('npm >= 10', npm.status === 0, npm.stdout.trim());

  const DATABASE_URL = envValue('DATABASE_URL') || requireEnv('DATABASE_URL');
  const DATABASE_URL_RUNTIME = envValue('DATABASE_URL_RUNTIME') || requireEnv('DATABASE_URL_RUNTIME');
  const REDIS_URL = envValue('REDIS_URL') || requireEnv('REDIS_URL');

  // 2. PostgreSQL: admin role (migrations) and runtime role (RLS-bound tenant traffic)
  // psql treats a connection string after the option as the first db arg; shell
  // out via the URL form psql understands:
  const pgAdmin2 = run('psql', [DATABASE_URL, '-t', '-c', 'SELECT 1;']);
  check('PostgreSQL admin role reachable (DATABASE_URL)', pgAdmin2.status === 0,
    pgAdmin2.stderr.trim() || pgAdmin2.stdout.trim());

  const pgRuntime = run('psql', [DATABASE_URL_RUNTIME, '-t', '-c', 'SELECT 1;']);
  check('PostgreSQL runtime role reachable (DATABASE_URL_RUNTIME, pz_app)', pgRuntime.status === 0,
    pgRuntime.stderr.trim() || pgRuntime.stdout.trim());

  // 3. Redis
  const redis = run('redis-cli', ['-u', REDIS_URL, 'PING']);
  check('Redis answers PING', redis.status === 0 && redis.stdout.trim() === 'PONG',
    redis.stdout.trim() || redis.stderr.trim());

  // 4. Migrations (idempotent; advisory-locked runner)
  const migrate = run('npm', ['run', 'db:migrate']);
  check('db:migrate applies cleanly', migrate.status === 0,
    (migrate.stderr || migrate.stdout).trim().slice(0, 300));

  // 5. Seed (idempotent, synthetic data only)
  const seed = run('npm', ['run', 'db:seed']);
  check('db:seed writes synthetic fixtures', seed.status === 0,
    (seed.stderr || seed.stdout).trim().slice(0, 300));

  // 6. Health checks require the API to be running; report what we can without it.
  //    The API is started separately (`npm run dev`). Verify /health/live and
  //    /health/ready once it is listening (see judge:demo).
  console.log();
  console.log('Health checks: start the stack with `npm run dev`, then:');
  console.log('  GET http://127.0.0.1:8080/health/live   (expect 200)');
  console.log('  GET http://127.0.0.1:8080/health/ready   (expect 200, status ready)');

  if (failures > 0) {
    console.log(`\nSetup finished with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nSetup complete: dependencies, PostgreSQL, Redis, migrations, and seed are ready.');
}

main().catch((err) => {
  console.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
