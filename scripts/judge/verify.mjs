#!/usr/bin/env node
/**
 * scripts/judge/verify.mjs
 *
 * Runs the repository's release gate in strict mode: typecheck, lint, unit +
 * integration tests, production build. Under --strict any required step that is
 * skipped fails the gate.
 *
 * Usage:
 *   node scripts/judge/verify.mjs   (runs `npm run verify -- --strict`)
 */

import { spawnSync } from 'node:child_process';

console.log('PermitZero judge verification (strict)\n');

const res = spawnSync('npm', ['run', 'verify', '--', '--strict'], {
  encoding: 'utf8',
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (res.status !== 0) {
  console.error(`\nVerification failed with exit code ${res.status}`);
  process.exit(res.status ?? 1);
}
console.log('\nVerification complete: all required steps passed.');
