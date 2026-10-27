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
 * Exit codes: 0 nothing unexpected; 1 unlisted or expired exception found.
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
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities exist, and still prints the
    // report. Treating that exit as failure would make the gate unable to tell
    // "clean" from "npm could not reach the registry" — the latter must be an
    // error, not a silent pass.
    const stdout = err?.stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
      try {
        return JSON.parse(stdout);
      } catch {
        /* fall through */
      }
    }
    throw new Error(
      `npm audit produced no parseable report (${err instanceof Error ? err.message : String(err)}). ` +
        'Refusing to treat an unavailable audit as a pass.',
    );
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
      out.push({ package: name, severity: entry.severity, title: '', range: entry.range, github: '', cve: '', direct: true });
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
      problems.push(`${finding.package} (${finding.severity}): ${finding.title} — not listed in ${path.relative(root, EXCEPTIONS_FILE)}`);
      continue;
    }
    if (['high', 'critical'].includes(String(exception.severity ?? '').toLowerCase()) === false && ['high', 'critical'].includes(finding.severity)) {
      problems.push(`${finding.package}: severity rose to ${finding.severity} but the recorded exception was ${exception.severity}`);
      continue;
    }
    const reviewBy = exception.reviewBy ? new Date(exception.reviewBy) : null;
    if (!reviewBy || Number.isNaN(reviewBy.getTime())) {
      problems.push(`${finding.package}: exception has no usable reviewBy date, so it can never expire`);
      continue;
    }
    if (reviewBy < today) {
      problems.push(`${finding.package}: exception expired on ${exception.reviewBy} — re-review it or fix the dependency`);
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

main();
