#!/usr/bin/env node
/**
 * scripts/audit-gate.mjs — dependency vulnerabilities, gated by exception rather
 * than by threshold.
 *
 * `npm audit --audit-level=low` on a tree that already has highs is a red CI
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
 * The scope is the WHOLE dependency tree, devDependencies included. The gate
 * used to run `npm audit --omit=dev`, which meant an advisory that only
 * existed in a build-time dependency was invisible to it — and a build-time
 * dependency is still code that runs on a developer's machine and in CI, on a
 * pull request, with the repository's secrets in reach. A gate that only
 * watches half the tree is a gate that reports on half the risk.
 *
 * Every advisory the audit reports must be named, not merely every package: a
 * package that carries three advisories is three separate findings, and a new
 * advisory on a package that is already excepted has to fail the build like
 * any other. Each named advisory carries a reason, a compensating control, the
 * reviewer who decided, the date they decided, and the date it must be looked
 * at again.
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
  // The whole tree, devDependencies included. `--omit=dev` was what left
  // build-time advisories outside the gate, and the `--dev` flag that used to
  // widen the scope is now the default: it is still accepted so an existing
  // invocation does not break, and it changes nothing.
  const args = ['audit', '--json'];
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

/** Severity order, for "the severity rose" checks. */
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function severityRank(severity) {
  return SEVERITY_RANK[String(severity ?? '').toLowerCase()] ?? -1;
}

/**
 * The identifier of an advisory.
 *
 * npm's own report does not carry `github_advisory_id`; it carries a numeric
 * `source` and a URL, and the URL is where the GHSA id lives. The id is what
 * an exception names, so it has to be the one a reader can look up — and the
 * numeric source id changes when the advisory is republished.
 */
function advisoryId(advisory) {
  if (advisory.github_advisory_id) return String(advisory.github_advisory_id);
  const url = typeof advisory.url === 'string' ? advisory.url : '';
  const match = /GHSA-[0-9a-z-]+/i.exec(url);
  if (match) return match[0];
  if (advisory.source) return `npm-${advisory.source}`;
  return '';
}

/**
 * Every advisory the audit reports, one finding each.
 *
 * Not one finding per package: a package carrying three advisories is three
 * separate findings, and the exception that accepts one of them says nothing
 * about the other two. An advisory that npm reports through another package
 * (`via: ['postcss']`) has no identifier of its own — it is the same advisory,
 * counted against the package that pulls it in — and is reported as a finding
 * with no id, carrying the package it inherits from.
 *
 * Severity is not a filter here. Threshold-based acceptance is what this script
 * replaces: the exceptions list is the allowlist, so a moderate must be named
 * too, or "moderate" becomes the place things hide.
 */
function auditFindings(audit) {
  const findings = [];
  for (const [name, entry] of Object.entries(audit.vulnerabilities ?? {})) {
    const advisories = (entry.via ?? []).filter((v) => typeof v === 'object');
    const inheritedFrom = (entry.via ?? []).filter((v) => typeof v === 'string');
    if (!entry.isDirect && advisories.length === 0 && inheritedFrom.length === 0) continue;
    if (!entry.severity) continue;
    if (advisories.length > 0) {
      for (const advisory of advisories) {
        findings.push({
          package: name,
          id: advisoryId(advisory),
          title: advisory.title ?? '',
          severity: advisory.severity ?? entry.severity,
          packageSeverity: entry.severity,
          range: advisory.vulnerable_versions ?? advisory.range ?? entry.range,
          github: advisoryId(advisory),
          cve: advisory.cve ?? '',
          direct: Boolean(entry.isDirect),
          inheritsFrom: inheritedFrom.join(','),
        });
      }
      continue;
    }
    // The package carries no advisory of its own: it inherits one.
    findings.push({
      package: name,
      id: '',
      title: '',
      severity: entry.severity,
      packageSeverity: entry.severity,
      range: entry.range,
      github: '',
      cve: '',
      direct: Boolean(entry.isDirect),
      inheritsFrom: inheritedFrom.join(','),
    });
  }
  return findings;
}

function describeFinding(finding) {
  const what = finding.title ? `${finding.title}` : `inherits the advisory of ${finding.inheritsFrom}`;
  return `${finding.id ? `${finding.id} ` : ''}${what}`;
}

/**
 * The decision: what is accepted, what is a problem, and what is stale.
 *
 * Separated from `main()` so the self-test can feed it a report that was
 * never going to come out of npm — including a report with an advisory that
 * nobody has named, which is the failure this gate exists to catch.
 */
function evaluate(audit, exceptions, today) {
  const listed = new Map((exceptions.exceptions ?? []).map((e) => [e.package, e]));
  const findings = auditFindings(audit);
  const problems = [];
  const accepted = [];
  const named = new Set();

  for (const finding of findings) {
    const exception = listed.get(finding.package);
    if (!exception) {
      problems.push(
        `${finding.package} (${finding.severity}): ${describeFinding(finding)} — not listed in ${path.relative(root, EXCEPTIONS_FILE)}`,
      );
      continue;
    }

    // The advisory itself has to be named, not just the package it lives in.
    // This is what makes a NEW advisory fail the build even on a package that
    // is already excepted.
    const advisories = Array.isArray(exception.advisories) ? exception.advisories : [];
    if (finding.id) {
      const namedAdvisory = advisories.find((a) => a && a.id === finding.id);
      if (!namedAdvisory) {
        problems.push(
          `${finding.package}: advisory ${finding.id} (${finding.title}) is not named in the exception for ${finding.package}`,
        );
        continue;
      }
      const recorded = namedAdvisory.severity ?? exception.severity;
      if (severityRank(finding.severity) > severityRank(recorded)) {
        problems.push(
          `${finding.package}: advisory ${finding.id} rose to ${finding.severity} but the exception records ${recorded}`,
        );
        continue;
      }
    }

    // An exception that says which advisory it inherits has to still inherit
    // it: a dependency that has been replaced stops being an exception for
    // something and becomes an exception for nothing.
    if (exception.inheritsFrom && !finding.inheritsFrom.split(',').includes(exception.inheritsFrom)) {
      problems.push(
        `${finding.package}: the exception says it inherits the advisory of ${exception.inheritsFrom}, but the audit no longer reports that`,
      );
      continue;
    }

    // The package-level severity: a package whose worst advisory got worse
    // must be looked at again.
    if (severityRank(finding.packageSeverity) > severityRank(exception.severity)) {
      problems.push(
        `${finding.package}: severity rose to ${finding.packageSeverity} but the recorded exception was ${exception.severity}`,
      );
      continue;
    }

    // The paperwork. A reason, what mitigates it here, who decided, when they
    // decided, and when it has to be looked at again: an exception without
    // those is a decision nobody made.
    if (!Array.isArray(exception.acceptedBecause) || exception.acceptedBecause.length === 0) {
      problems.push(`${finding.package}: exception records no acceptedBecause reason`);
      continue;
    }
    if (!exception.compensatingControl) {
      problems.push(`${finding.package}: exception records no compensatingControl`);
      continue;
    }
    if (!exception.decidedBy) {
      problems.push(`${finding.package}: exception records no decidedBy reviewer`);
      continue;
    }
    const decidedOn = exception.decidedOn ? new Date(exception.decidedOn) : null;
    if (!decidedOn || Number.isNaN(decidedOn.getTime())) {
      problems.push(`${finding.package}: exception records no usable decidedOn date`);
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
    named.add(finding.package);
    accepted.push(
      `${finding.package} (${finding.severity}${finding.id ? ` ${finding.id}` : ''}) accepted until ${exception.reviewBy}`,
    );
  }

  // An exception for something no longer vulnerable is noise that hides real
  // entries, so say so rather than letting the list only ever grow.
  const stillVulnerable = new Set(findings.map((f) => f.package));
  const stale = [...listed.keys()].filter((name) => !stillVulnerable.has(name));

  return { findings, problems, accepted, stale };
}

function main() {
  const exceptions = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'));
  const { findings, problems, accepted, stale } = evaluate(loadAudit(), exceptions, new Date());

  const verdict = problems.length === 0 ? 'PASS' : 'FAIL';
  if (asJson) {
    console.log(JSON.stringify({ verdict, findings, problems, accepted, staleExceptions: stale }, null, 2));
  } else {
    console.log(`\ndependency audit gate — ${verdict}  (${findings.length} advisory finding(s), whole tree)`);
    for (const line of accepted) console.log(`  accepted  ${line}`);
    for (const line of problems) console.log(`  PROBLEM   ${line}`);
    for (const name of stale) console.log(`  stale     ${name}: no longer vulnerable, remove the exception`);
    if (problems.length === 0) console.log('  nothing unreviewed; every finding is named, reasoned and in date');
  }
  if (problems.length > 0) process.exitCode = 1;
}

/**
 * The gate's own parser and rules, checked against the shapes npm actually
 * produces.
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

  // The rule, checked against a report that could not have come out of npm:
  // an advisory nobody has named is a problem, and so is an exception whose
  // review date has passed. Both are what the gate exists for, and both are
  // the kind of thing that stops being true without anybody noticing.
  const today = new Date('2026-10-29T00:00:00Z');
  const ruleCases = [
    {
      name: 'an advisory nobody named is a problem',
      audit: {
        vulnerabilities: {
          leftpad: {
            severity: 'high',
            isDirect: true,
            range: '<1.0.0',
            via: [
              {
                severity: 'high',
                title: 'Left-pad is not a security control',
                github_advisory_id: 'GHSA-self-test-0001',
                vulnerable_versions: '<1.0.0',
              },
            ],
          },
        },
      },
      exceptions: { exceptions: [] },
      expectProblem: /not listed/,
    },
    {
      name: 'an advisory on an excepted package that is not named is a problem',
      audit: {
        vulnerabilities: {
          leftpad: {
            severity: 'high',
            isDirect: true,
            range: '<1.0.0',
            via: [
              {
                severity: 'high',
                title: 'Left-pad is not a security control',
                github_advisory_id: 'GHSA-self-test-0002',
                vulnerable_versions: '<1.0.0',
              },
            ],
          },
        },
      },
      exceptions: {
        exceptions: [
          {
            package: 'leftpad',
            severity: 'high',
            advisories: [{ id: 'GHSA-self-test-0001', severity: 'high' }],
            acceptedBecause: ['because'],
            compensatingControl: 'a control',
            decidedBy: 'the self-test',
            decidedOn: '2026-01-01',
            reviewBy: '2027-01-01',
          },
        ],
      },
      expectProblem: /is not named in the exception/,
    },
    {
      name: 'an expired exception is a problem',
      audit: {
        vulnerabilities: {
          leftpad: {
            severity: 'high',
            isDirect: true,
            range: '<1.0.0',
            via: [
              {
                severity: 'high',
                title: 'Left-pad is not a security control',
                github_advisory_id: 'GHSA-self-test-0001',
                vulnerable_versions: '<1.0.0',
              },
            ],
          },
        },
      },
      exceptions: {
        exceptions: [
          {
            package: 'leftpad',
            severity: 'high',
            advisories: [{ id: 'GHSA-self-test-0001', severity: 'high' }],
            acceptedBecause: ['because'],
            compensatingControl: 'a control',
            decidedBy: 'the self-test',
            decidedOn: '2026-01-01',
            reviewBy: '2026-02-01',
          },
        ],
      },
      expectProblem: /expired/,
    },
    {
      name: 'a fully named and in-date exception is accepted',
      audit: {
        vulnerabilities: {
          leftpad: {
            severity: 'high',
            isDirect: true,
            range: '<1.0.0',
            via: [
              {
                severity: 'high',
                title: 'Left-pad is not a security control',
                github_advisory_id: 'GHSA-self-test-0001',
                vulnerable_versions: '<1.0.0',
              },
            ],
          },
        },
      },
      exceptions: {
        exceptions: [
          {
            package: 'leftpad',
            severity: 'high',
            advisories: [{ id: 'GHSA-self-test-0001', severity: 'high' }],
            acceptedBecause: ['because'],
            compensatingControl: 'a control',
            decidedBy: 'the self-test',
            decidedOn: '2026-01-01',
            reviewBy: '2027-01-01',
          },
        ],
      },
      expectProblem: null,
    },
  ];

  for (const c of ruleCases) {
    const result = evaluate(c.audit, c.exceptions, today);
    if (c.expectProblem) {
      if (!result.problems.some((p) => c.expectProblem.test(p))) {
        problems.push(
          `${c.name}: expected a problem matching ${c.expectProblem}, got ${JSON.stringify(result.problems)}`,
        );
      }
    } else if (result.problems.length > 0) {
      problems.push(`${c.name}: expected no problems, got ${JSON.stringify(result.problems)}`);
    }
  }

  console.log(
    `audit gate self-test — ${problems.length === 0 ? 'PASS' : 'FAIL'}: ${cases.length + ruleCases.length} case(s)`,
  );
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
