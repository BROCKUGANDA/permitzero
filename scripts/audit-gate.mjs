#!/usr/bin/env node
/**
 * scripts/audit-gate.mjs — dependency vulnerabilities, gated by exception rather
 * than by threshold.
 *
 * `npm audit --audit-level=low` on a tree that already has four highs is a red CI
 * on the day it is added, which means it gets removed or loosened. Setting the
 * level to "critical" instead is worse, because it silently accepts everything
 * short of critical forever.
 *
 * So this script does the third thing: it fails on anything that is not
 * individually named in `infra/security/dependency-exceptions.json`, and it also
 * fails a listed exception whose review date has passed. A new advisory therefore
 * cannot be absorbed without someone writing down why, and an accepted one cannot
 * quietly become permanent.
 *
 * Exit codes: 0 nothing unexpected; 1 unlisted or expired exception found —
 * and 1 also when the audit itself could not be produced, because an audit
 * that never ran is not a clean bill of health.
 * `--json` for machine-readable output.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCEPTIONS_FILE = path.join(root, 'infra', 'security', 'dependency-exceptions.json');
const asJson = process.argv.includes('--json');
const includeDev = process.argv.includes('--dev');

/**
 * The audit could not be produced.
 *
 * A separate error type because the two failures have to be reported
 * differently: an unlisted advisory is a finding about the tree, while an audit
 * that never ran is a statement about the machine that ran it, and the second
 * one must not be dressed up as the first.
 */
class AuditUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

/**
 * The report npm produced, or a refusal to pretend one exists.
 *
 * npm reports its own failures as JSON too:
 *
 *   {"error":{"code":"EALLOWSCRIPTS","summary":"...","detail":""}}
 *
 * That envelope parses, carries no `vulnerabilities` key, and used to be read
 * as "no findings" — so a broken npm configuration printed
 * `PASS (0 direct advisory finding(s))` and exited 0. The gate was reporting
 * on a tree it had never seen. The shape of what npm printed is therefore
 * checked, not just that something was printed: a report has a
 * `vulnerabilities` object in it, and anything else is npm talking about
 * itself.
 */
function readAuditReport(stdout, failure) {
  const text = (stdout ?? '').trim();
  if (!text.startsWith('{')) {
    throw new AuditUnavailableError(
      `npm audit did not produce a report (${failure ?? 'it printed nothing'}). ` +
        'Refusing to treat an unavailable audit as a pass.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AuditUnavailableError(
      `npm audit printed something that is not JSON (${failure ?? (err instanceof Error ? err.message : String(err))}). ` +
        'Refusing to treat an unavailable audit as a pass.',
    );
  }

  const envelope = parsed && typeof parsed === 'object' ? parsed.error : undefined;
  if (envelope) {
    const code = envelope.code ?? 'ERROR';
    const summary = String(envelope.summary ?? JSON.stringify(envelope)).replace(/\.$/, '');
    const detail = envelope.detail ? ` (${envelope.detail})` : '';
    throw new AuditUnavailableError(
      `npm audit did not produce a report: ${code} — ${summary}${detail}. ` +
        'Refusing to treat an unavailable audit as a pass.',
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.vulnerabilities !== 'object' ||
    parsed.vulnerabilities === null
  ) {
    throw new AuditUnavailableError(
      'npm audit did not produce a report: the JSON it printed has no "vulnerabilities" section. ' +
        'Refusing to treat an unavailable audit as a pass.',
    );
  }
  return parsed;
}

function loadAudit() {
  const args = ['audit', '--json', '--omit=dev'];
  if (includeDev) args.splice(1, 0, '--include=dev');
  try {
    const out = execFileSync('npm', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // On Windows `npm` is `npm.cmd`, which cannot be spawned directly. Same
      // approach as scripts/verify.mjs.
      shell: process.platform === 'win32',
    });
    return readAuditReport(out, null);
  } catch (err) {
    if (err instanceof AuditUnavailableError) throw err;
    // npm audit exits non-zero when vulnerabilities exist, and still prints the
    // report. Treating that exit as failure would make the gate unable to tell
    // "clean" from "npm could not reach the registry" — the latter must be an
    // error, not a silent pass. So the exit code is not the signal; the shape of
    // what npm printed is.
    const stdout = err?.stdout;
    const text = typeof stdout === 'string' ? stdout : '';
    if (!text.trim()) {
      throw new AuditUnavailableError(
        `npm audit did not produce a report (${err instanceof Error ? err.message : String(err)}). ` +
          'Refusing to treat an unavailable audit as a pass.',
      );
    }
    return readAuditReport(text, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The set of findings an exception has to cover.
 *
 * Deliberately the same set `npm audit` summarises: any package that is either a
 * direct dependency or carries an advisory of its own. Filtering to
 * direct-dependency-with-inline-advisory-only looked tidy and silently dropped
 * transitive highs (`postcss` reached through `next`) — which is the exact class
 * of finding a reviewer expects the gate to have seen.
 *
 * Severity is not a filter here. Threshold-based acceptance is what this script
 * replaces: the exceptions list is the allowlist, so a moderate must be named too,
 * or "moderate" becomes the place things hide.
 */
function vulnerablePackages(audit) {
  const out = [];
  for (const [name, entry] of Object.entries(audit.vulnerabilities ?? {})) {
    const advisories = (entry.via ?? []).filter((v) => typeof v === 'object');
    if (!entry.isDirect && advisories.length === 0) continue;
    if (!entry.severity) continue;
    for (const advisory of advisories.length ? advisories : [{}]) {
      out.push({
        package: name,
        severity: advisory.severity ?? entry.severity,
        title: advisory.title ?? '',
        range: advisory.vulnerable_versions ?? entry.range,
        github: advisory.github_advisory_id ?? '',
        cve: advisory.cve ?? '',
        direct: Boolean(entry.isDirect),
      });
    }
    if (advisories.length === 0 && !out.some((f) => f.package === name && f.title === '')) {
      out.push({
        package: name,
        severity: entry.severity,
        title: '',
        range: entry.range,
        github: '',
        cve: '',
        direct: true,
      });
    }
  }
  return out;
}

function main() {
  const exceptions = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'));
  const listed = new Map((exceptions.exceptions ?? []).map((e) => [e.package, e]));
  const today = new Date();
  // One finding per package: a package carrying three advisories is still one
  // dependency decision, and listing it three times would make the exception file
  // look like it covers three separate things.
  const seen = new Set();
  const findings = vulnerablePackages(loadAudit()).filter((f) => {
    if (seen.has(f.package)) return false;
    seen.add(f.package);
    return true;
  });

  const problems = [];
  const accepted = [];
  for (const finding of findings) {
    const exception = listed.get(finding.package);
    if (!exception) {
      problems.push(
        `${finding.package} (${finding.severity}): ${finding.title} — not listed in ${path.relative(root, EXCEPTIONS_FILE)}`,
      );
      continue;
    }
    if (
      ['high', 'critical'].includes(String(exception.severity ?? '').toLowerCase()) === false &&
      ['high', 'critical'].includes(finding.severity)
    ) {
      problems.push(
        `${finding.package}: severity rose to ${finding.severity} but the recorded exception was ${exception.severity}`,
      );
      continue;
    }
    const reviewBy = exception.reviewBy ? new Date(exception.reviewBy) : null;
    if (!reviewBy || Number.isNaN(reviewBy.getTime())) {
      problems.push(`${finding.package}: exception has no usable reviewBy date, so it can never expire`);
      continue;
    }
    if (reviewBy < today) {
      problems.push(
        `${finding.package}: exception expired on ${exception.reviewBy} — re-review it or fix the dependency`,
      );
      continue;
    }
    if (!Array.isArray(exception.acceptedBecause) || exception.acceptedBecause.length === 0) {
      problems.push(`${finding.package}: exception records no acceptedBecause reason`);
      continue;
    }
    if (!exception.compensatingControl) {
      problems.push(`${finding.package}: exception records no compensatingControl`);
      continue;
    }
    accepted.push(`${finding.package} (${finding.severity}) accepted until ${exception.reviewBy}`);
  }

  // An exception for something no longer vulnerable is noise that hides real
  // entries, so say so rather than letting the list only ever grow.
  const stillVulnerable = new Set(findings.map((f) => f.package));
  const stale = [...listed.keys()].filter((name) => !stillVulnerable.has(name));

  const verdict = problems.length === 0 ? 'PASS' : 'FAIL';
  if (asJson) {
    console.log(JSON.stringify({ verdict, findings, problems, accepted, staleExceptions: stale }, null, 2));
  } else {
    console.log(`\ndependency audit gate — ${verdict}  (${findings.length} direct advisory finding(s))`);
    for (const line of accepted) console.log(`  accepted  ${line}`);
    for (const line of problems) console.log(`  PROBLEM   ${line}`);
    for (const name of stale) console.log(`  stale     ${name}: no longer vulnerable, remove the exception`);
    if (problems.length === 0) console.log('  nothing unreviewed; every finding is named, reasoned and in date');
  }
  if (problems.length > 0) process.exitCode = 1;
}

/**
 * The gate's own parser, checked against the shapes npm actually produces.
 *
 * `--self-test` exists because the failure this file had is the kind that
 * nothing around it catches: npm's error envelope parsed as an empty report,
 * so the gate announced a clean tree it had never seen. The vitest
 * configuration collects the packages' and the apps' test directories only, so
 * a test file for this script would mean changing shared test infrastructure —
 * and a self-check is the smaller change. It runs in CI, through
 * scripts/verify.mjs, so the parser cannot rot unnoticed.
 */
function selfTest() {
  const cases = [
    {
      name: 'a real audit report is accepted',
      input: JSON.stringify({
        vulnerabilities: { fastify: { severity: 'high', isDirect: true, via: [] } },
        metadata: { vulnerabilities: { total: 1 } },
      }),
      expect: 'report',
    },
    {
      name: "npm's error envelope is refused, and named",
      input: JSON.stringify({ error: { code: 'EALLOWSCRIPTS', summary: 'not allowed here', detail: '' } }),
      expect: 'refused',
      // The refusal has to name the failure, not merely refuse: a refusal that
      // does not say which failure it was leaves the reader guessing whether
      // the audit ran.
      expectText: 'EALLOWSCRIPTS',
    },
    {
      name: 'JSON without a vulnerabilities section is refused',
      input: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }),
      expect: 'refused',
    },
    {
      name: 'output that is not JSON at all is refused',
      input: 'npm error code ENOTFOUND',
      expect: 'refused',
    },
  ];

  const problems = [];
  for (const c of cases) {
    let outcome = 'report';
    let message = '';
    try {
      readAuditReport(c.input, 'self-test');
    } catch (err) {
      outcome = err instanceof AuditUnavailableError ? 'refused' : `wrong error: ${err.message}`;
      message = err instanceof Error ? err.message : String(err);
    }
    if (outcome !== c.expect) problems.push(`${c.name}: expected ${c.expect}, got ${outcome}`);
    if (c.expectText && !message.includes(c.expectText)) {
      problems.push(`${c.name}: the refusal did not name "${c.expectText}"`);
    }
  }

  console.log(`audit gate self-test — ${problems.length === 0 ? 'PASS' : 'FAIL'}: ${cases.length} case(s)`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
}

/**
 * The gate failed before it could judge the tree.
 *
 * An unavailable audit is reported as a failure and not as an unhandled crash,
 * because the two are read very differently by whoever is looking at a red
 * pipeline: "the dependency tree has an unreviewed advisory" is a finding
 * about this repository, while "npm could not produce a report" is a statement
 * about the machine — and the second one used to be printed as the first.
 */
if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) {
      console.log(
        JSON.stringify(
          { verdict: 'FAIL', error: message, findings: [], problems: [message], accepted: [], staleExceptions: [] },
          null,
          2,
        ),
      );
    } else {
      console.error('\ndependency audit gate — FAIL');
      console.error(`  ${message}`);
      // A bug in the gate is a third thing entirely, and it should not hide
      // behind a tidy message with no stack.
      if (!(err instanceof AuditUnavailableError) && err instanceof Error) console.error(err.stack);
    }
    process.exitCode = 1;
  }
}
