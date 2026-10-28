#!/usr/bin/env node
/**
 * scripts/verify.mjs — the repository's release gate, in one command.
 *
 * Referenced by package.json as `npm run verify` since the first slice, but the
 * file did not exist, so the gate could not run. A gate that cannot run is
 * worse than no gate: it reports safety.
 *
 * Rules this file holds itself to:
 *   · Every step runs for real. Nothing here swallows a non-zero exit.
 *   · A skipped step is printed as SKIPPED with the reason, never folded into
 *     "passed". `--strict` turns any skip into a failure, which is what CI
 *     should use.
 *   · Exit code is 0 only when every required step passed.
 *
 * Usage:
 *   node scripts/verify.mjs                 typecheck, lint, unit/integration,
 *                                           production build
 *   node scripts/verify.mjs --quick         stop before the build
 *   node scripts/verify.mjs --e2e           add the Playwright suite
 *   node scripts/verify.mjs --live URL      run the demo scenario against a
 *                                           running stack (proves the deployed
 *                                           product, not just the code)
 *   node scripts/verify.mjs --strict        a skipped required step fails
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const valueOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : (argv[i + 1] ?? def);
};

const quick = flag('quick');
const strict = flag('strict');
const liveUrl = valueOf('live', null);
const withE2E = flag('e2e');

/** @type {{name: string, cmd: string[], args: string[], env?: Record<string,string>, required: boolean, skip?: string}[]} */
const steps = [];

function add(name, cmd, args, opts = {}) {
  steps.push({ name, cmd, args, ...opts });
}

add('typecheck', 'npm', ['run', 'typecheck'], { required: true });
add('lint', 'npx', ['eslint', '.', '--max-warnings=0'], { required: true });
add('unit + integration', 'npm', ['test', '--', '--reporter=dot'], { required: true });

if (!quick) {
  add('production build (web)', 'npm', ['run', 'build', '-w', '@permitzero/web'], { required: true });
}

if (withE2E) {
  add('browser e2e', 'npm', ['run', 'test:e2e', '-w', '@permitzero/web'], { required: true });
}

if (liveUrl) {
  // Measured, not asserted: the SLO report scrapes the running stack and fails
  // if an objective is breached. It is REQUIRED when --live is given, and skipped
  // (loudly) otherwise, because a report of an absent stack would print all
  // zeros and look like a clean bill of health.
  add('SLO report (live scrape)', 'npx', ['tsx', 'scripts/slo-report.mjs', '--url', liveUrl], {
    required: true,
    env: { METRICS_TOKEN: process.env.METRICS_TOKEN ?? '' },
  });
}

if (liveUrl) {
  // The scenario file is the product's own proof: it drives intake → policy →
  // approval → permit → broker → simulated connector → receipt and exits
  // non-zero on the first unexpected response.
  add('live demo scenario', 'npm', ['run', 'demo:scenario'], {
    required: true,
    env: { API_URL: liveUrl },
  });
} else {
  add('live demo scenario', 'npm', ['run', 'demo:scenario'], {
    required: false,
    skip: 'no --live URL given, so no running stack to drive',
  });
}

// The evidence map is a claim about the rest of this repository, so it is checked
// like one: every citation must resolve, and the documented absences must still be
// documented. Skipping this step is how a control map becomes decoration.
add('compliance evidence gate', 'node', ['scripts/compliance-gate.mjs'], { required: true });

add('format check', 'npx', ['prettier', '--check', '**/*.{ts,tsx,js,jsx,json,md,css,yml,yaml}'], {
  required: true,
});

if (existsSync(path.join(root, 'infra', 'deploy', 'permitzero.env'))) {
  add('secret scan', 'npx', ['--no', 'gitleaks', 'detect', '--source', '.', '--no-git', '--redact', '--exit-code', '1'], {
    required: false,
    skip: 'gitleaks is not installed locally; the deploy host runs it',
  });
}

const results = [];
const startedAll = Date.now();

for (const step of steps) {
  if (step.skip) {
    results.push({ name: step.name, status: 'SKIPPED', detail: step.skip, ms: 0 });
    console.log(`\n── ${step.name}: SKIPPED (${step.skip})`);
    continue;
  }
  console.log(`\n══ ${step.name} ══`);
  const started = Date.now();
  const res = spawnSync(step.cmd, step.args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(step.env ?? {}) },
  });
  const ms = Date.now() - started;
  if (res.error) {
    results.push({ name: step.name, status: 'FAIL', detail: res.error.message, ms });
    continue;
  }
  results.push({
    name: step.name,
    status: res.status === 0 ? 'PASS' : 'FAIL',
    detail: res.status === 0 ? '' : `exit ${res.status}`,
    ms,
  });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log('\n' + '─'.repeat(56));
console.log('verify summary');
console.log('─'.repeat(56));
for (const r of results) {
  console.log(`${r.status.padEnd(8)} ${r.name.padEnd(width)} ${(r.ms / 1000).toFixed(1)}s ${r.detail}`);
}
console.log('─'.repeat(56));

const failed = results.filter((r) => r.status === 'FAIL');
const skippedRequired = results.filter((r) => r.status === 'SKIPPED' && strict);
const elapsed = ((Date.now() - startedAll) / 1000).toFixed(1);

if (failed.length > 0) {
  console.log(`FAILED: ${failed.length} of ${results.length} steps did not pass (${elapsed}s)`);
  process.exit(1);
}
if (skippedRequired.length > 0) {
  console.log(`FAILED (strict): ${skippedRequired.length} step(s) were skipped (${elapsed}s)`);
  process.exit(1);
}
const skipped = results.filter((r) => r.status === 'SKIPPED').length;
console.log(`PASSED: ${results.filter((r) => r.status === 'PASS').length}/${results.length} steps, ${skipped} skipped (${elapsed}s)`);
