#!/usr/bin/env node
/**
 * scripts/judge/demo.mjs
 *
 * Runs the repository's end-to-end demo scenario against a running API and reports
 * the result. Reads API_URL (default http://127.0.0.1:8080). Tokens are read from
 * storage/demo-credentials.json (written by `npm run db:seed`), never printed.
 *
 * Exits non-zero on the first unexpected response.
 *
 * Usage:
 *   node scripts/judge/demo.mjs            # API_URL defaults to http://127.0.0.1:8080
 *   API_URL=http://127.0.0.1:8080 node scripts/judge/demo.mjs
 */

import { spawnSync } from 'node:child_process';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8080';

console.log(`PermitZero judge demo against ${API_URL}\n`);

const res = spawnSync('npm', ['run', 'demo:scenario'], {
  encoding: 'utf8',
  env: { ...process.env, API_URL },
  stdio: 'inherit',
});

if (res.status !== 0) {
  console.error(`\nDemo failed with exit code ${res.status}`);
  process.exit(res.status ?? 1);
}
console.log('\nDemo finished: every step behaved as promised.');
