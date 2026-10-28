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
 *     "passed".
 *   · "Skipped" and "not applicable here" are different statements, so each step
 *     says which one it is. A step that cannot apply — the live demo scenario
 *     with no running stack to drive, the secret scan on a machine without
 *     gitleaks — is not required, and skipping it does not fail the gate. A
 *     step that was required and could not run is a hole in the gate, so
 *     `--strict` turns that skip into a failure, which is what CI should use.
 *   · Exit code is 0 only when every step that ran passed. `--strict` adds one
 *     more condition to that: no required step may have been skipped.
 *
 * Usage:
 *   node scripts/verify.mjs                 typecheck, lint, unit/integration,
 *                                           production build
 *   node scripts/verify.mjs --quick         stop before the build
 *   node scripts/verify.mjs --e2e           add the Playwright suite
 *   node scripts/verify.mjs --live URL      run the demo scenario against a
 *                                           running stack (proves the deployed
 *                                           product, not just the code)
 *   node scripts/verify.mjs --strict        a required step that was skipped
 *                                           fails the gate
 */
import { spawnSync } from 'node:child_process';
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

// The dependency gate decides whether a tree has findings by parsing what npm
// printed, and npm reports its own failures in JSON as well. Its parser is
// checked against those shapes before it is allowed to judge a tree: it once
// mistook npm's error envelope for an empty report and announced a clean tree
// it had never seen.
add('dependency gate self-check', 'node', ['scripts/audit-gate.mjs', '--self-test'], { required: true });

add('format check', 'npx', ['prettier', '--check', '**/*.{ts,tsx,js,jsx,json,md,css,yml,yaml}'], {
  required: true,
});

/**
 * Is gitleaks actually installed on this machine?
 *
 * The secret scan used to be added to the list only when
 * `infra/deploy/permitzero.env` existed, and the step it added carried a skip
 * reason saying gitleaks was not installed. Those are two unrelated facts: the
 * deploy file is a fact about a deployment, the binary is a fact about the
 * machine running the gate. Asking about the file told the gate nothing about
 * whether it could scan, and the skip reason then described a machine that was
 * never consulted. So the question is put to the machine.
 */
function gitleaksAvailable() {
  const probe = spawnSync('gitleaks', ['version'], {
    cwd: root,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return !probe.error && probe.status === 0;
}

const gitleaksArgs = ['detect', '--source', '.', '--no-git', '--redact', '--exit-code', '1'];
if (gitleaksAvailable()) {
  // The same command `npm run secret:scan` runs, so the local gate and the CI
  // step are the same scan rather than two things that look alike.
  add('secret scan', 'gitleaks', gitleaksArgs, { required: true });
} else {
  add('secret scan', 'gitleaks', gitleaksArgs, {
    required: false,
    skip: 'gitleaks is not installed on this machine; CI runs the same scan in its secret-scan job',
  });
}

const results = [];
const startedAll = Date.now();

for (const step of steps) {
  if (step.skip) {
    // `required` travels with the result, because the strict decision is made
    // after every step has run: a skip is only a hole in the gate when the step
    // it skipped was one the gate was counting on.
    results.push({ name: step.name, status: 'SKIPPED', detail: step.skip, ms: 0, required: step.required });
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
    results.push({ name: step.name, status: 'FAIL', detail: res.error.message, ms, required: step.required });
    continue;
  }
  results.push({
    name: step.name,
    status: res.status === 0 ? 'PASS' : 'FAIL',
    detail: res.status === 0 ? '' : `exit ${res.status}`,
    ms,
    required: step.required,
  });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log('\n' + '─'.repeat(56));
console.log('verify summary');
console.log('─'.repeat(56));
for (const r of results) {
  const required = r.required ? '' : ' (optional)';
  console.log(`${r.status.padEnd(8)} ${r.name.padEnd(width)} ${(r.ms / 1000).toFixed(1)}s ${r.detail}${required}`);
}
console.log('─'.repeat(56));

const failed = results.filter((r) => r.status === 'FAIL');
// Only a required step that was skipped is a hole in the gate. An optional step
// that was skipped — the live demo scenario with no stack to drive, the secret
// scan on a machine without gitleaks — was never counted on, so counting its
// skip here would fail a gate over a check the caller was told would not apply.
// The bug this replaces failed every `--strict` run for exactly that reason:
// CI ran `verify -- --strict` and was permanently red over a step marked
// `required: false`.
const skippedRequired = results.filter((r) => r.status === 'SKIPPED' && r.required && strict);
const elapsed = ((Date.now() - startedAll) / 1000).toFixed(1);

if (failed.length > 0) {
  console.log(`FAILED: ${failed.length} of ${results.length} steps did not pass (${elapsed}s)`);
  process.exit(1);
}
if (skippedRequired.length > 0) {
  const names = skippedRequired.map((r) => r.name).join(', ');
  console.log(`FAILED (strict): ${skippedRequired.length} required step(s) were skipped — ${names} (${elapsed}s)`);
  process.exit(1);
}
const skipped = results.filter((r) => r.status === 'SKIPPED').length;
console.log(
  `PASSED: ${results.filter((r) => r.status === 'PASS').length}/${results.length} steps, ${skipped} skipped (${elapsed}s)`,
);
