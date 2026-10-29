#!/usr/bin/env node
/**
 * scripts/compliance-gate.mjs — the evidence map cannot rot.
 *
 * `docs/compliance/EVIDENCE.md` is the file a reviewer reads to decide whether the
 * claims in the README are backed by anything. Written by hand it decays the first
 * time code moves: a cited line drifts to different content, a renamed test stops
 * existing, a "partial" quietly becomes an "implemented" with no gap line. So every
 * structural fact in that document is checked here against the repository:
 *
 *   · every evidence entry names a file that exists, and (where an `expect:`
 *     token is given) content that is IN that file. The token is the evidence:
 *     it identifies the construct the claim rests on. A line number that has
 *     drifted because something above it grew is corrected and reported — the
 *     claim still holds. A token that is GONE, or that appears more than
 *     once so the reference is ambiguous, fails the gate;
 *   · every test entry names a file that exists, and a test title that appears in
 *     it, so a control cannot be "tested" by pointing at an unrelated file;
 *   · `implemented` requires both evidence and a test; `partial` and `absent`
 *     require a gap sentence, because a status without a stated hole is the claim
 *     this file exists to avoid;
 *   · at least one control must be `absent`. A map with no gaps is marketing, and
 *     deleting the honest rows would otherwise be the easy way past this gate.
 *
 * Usage: node scripts/compliance-gate.mjs [--map path] [--verbose]
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const mapPath = path.join(root, arg('map', 'docs/compliance/EVIDENCE.md'));
const verbose = process.argv.includes('--verbose');

const STATUSES = new Set(['implemented', 'partial', 'absent']);
const REQUIRED_FRAMEWORKS = ['SOC 2', 'OWASP', 'MAS SAFR', 'ISO 27001'];
const MIN_CONTROLS = 20;
/**
 * The documented absences. A control map's easy way past any count rule is to delete
 * the rows that admit a hole, so these four are named: if one disappears or is
 * relabelled as though it had been built, the gate fails. They are the honest
 * boundary of this build, not a to-do list to be quietly trimmed.
 */
const REQUIRED_ABSENT = [
  'ENCRYPTION-AT-REST',
  'BACKUP-AND-POINT-IN-TIME-RECOVERY',
  'DATA-RETENTION-AND-DELETION',
  'PENETRATION-TEST-AND-INDEPENDENT-REVIEW',
];

/**
 * The alert runbooks.
 *
 * Every alert rule points at `docs/incidents.md#<anchor>`, and a paged
 * engineer who follows a dead link at 03:00 has no runbook at all. The file
 * existed and the anchors did not, which is the worst version of this: the
 * rules looked complete.
 *
 * So the anchors are checked here. The list is derived from the alert rules
 * themselves rather than duplicated here, so adding an alert without writing
 * its runbook fails this gate instead of shipping a broken link.
 */
const ALERT_RULES_FILE = path.join(root, 'infra', 'observability', 'prometheus', 'rules', 'permitzero-alerts.yml');
const RUNBOOK_FILE = path.join(root, 'docs', 'incidents.md');

const failures = [];
const notes = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);
/**
 * A finding that is TRUE but not a failure.
 *
 * Used where the evidence still holds and only the pointer to it drifted —
 * a line number in a document that was edited. Those are corrected in place
 * rather than failing the build, because a red build about a sentence that
 * did not change is how a gate stops being read.
 */
const note = (where, message) => notes.push(`${where}: ${message}`);

/** Split a `; `-separated list, tolerating an empty field and the `—` placeholder. */
function list(raw) {
  if (!raw || raw.trim() === '—') return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseControls(text) {
  const blocks = text.split('\n### ').slice(1);
  return blocks.map((block) => {
    const headingLine = block.split('\n')[0] ?? '';
    const id = (headingLine.split('—')[0] ?? '').trim();
    const fields = {};
    const KEYS = ['status', 'sources', 'claim', 'evidence', 'tests', 'gap', 'note'];
    let current = null;
    // Field values may wrap across lines until the next known key. Structural
    // lines (blank, `---`, headings) are not content and must not be folded into
    // the previous field: a `gap: —` followed by the block separator would
    // otherwise become a "gap sentence", making a clean control look dishonest.
    for (const line of block.split('\n').slice(1)) {
      if (!line.trim() || /^---+$/.test(line.trim()) || line.startsWith('#')) {
        current = null;
        continue;
      }
      const match = /^([a-z]+):\s*(.*)$/.exec(line);
      if (match && KEYS.includes(match[1])) {
        current = match[1];
        fields[current] = match[2];
      } else if (current) {
        fields[current] = `${fields[current] ?? ''} ${line}`.trim();
      }
    }
    return { id, heading: headingLine, fields };
  });
}

/** The line number an evidence entry currently cites, or null. */
function entryLine(entry) {
  const location = entry.split(' expect:')[0]?.trim() ?? '';
  const m = /^(.+?):(\d+)$/.exec(location);
  return m ? Number(m[2]) : null;
}

/** `path:line expect:token` → parts, with the repo-relative path resolved. */
function parseEvidence(entry, where) {
  const expectSplit = entry.split(' expect:');
  const location = (expectSplit[0] ?? '').trim();
  const expect = expectSplit[1]?.trim();
  const locationMatch = /^(.+?):(\d+)$/.exec(location);
  if (!locationMatch) {
    fail(where, `evidence "${entry}" is not path:line`);
    return null;
  }
  return { file: locationMatch[1] ?? '', line: Number(locationMatch[2]), expect, location };
}

function checkEvidence(control, entry) {
  const where = control.id;
  const parsed = parseEvidence(entry, where);
  if (!parsed) return null;
  const absolute = path.join(root, parsed.file);
  if (!existsSync(absolute)) {
    fail(where, `evidence file does not exist: ${parsed.file}`);
    return null;
  }
  const lines = readFileSync(absolute, 'utf8').split('\n');
  const isDocument = /\.(md|mdx)$/i.test(parsed.file);
  const outOfRange = parsed.line < 1 || parsed.line > lines.length;
  if (outOfRange && !(isDocument && parsed.expect)) {
    fail(where, `${parsed.file}:${parsed.line} is outside the file (${lines.length} lines)`);
    return null;
  }
  if (!parsed.expect) return { file: parsed.file, line: parsed.line };
  if (!outOfRange) {
    const window = lines.slice(Math.max(0, parsed.line - 9), parsed.line + 8).join('\n');
    if (window.includes(parsed.expect)) return { file: parsed.file, line: parsed.line };
  }

  // The cited line has moved, but the TEXT is still in the file.
  //
  // The token is the evidence. A citation says "this construct is here, and
  // it does this" — and the token is what identifies the construct. When the
  // token is still present, uniquely, in the same file, the claim is still
  // evidenced; only the LINE NUMBER has drifted, because something above it
  // grew.
  //
  // Failing on that is a false alarm about a true claim, and it teaches
  // people to ignore this gate: every edit to a file would have to be
  // accompanied by a hunt for its citations. The failure is reserved for the
  // two cases where the claim really is no longer evidenced — the token is
  // gone, or it is ambiguous because it appears more than once.
  //
  // When the token appears MORE THAN ONCE, the match is ambiguous: the gate
  // cannot tell which occurrence was meant, and silently rewriting the
  // citation to the first one would persist the wrong evidence. That case
  // fails, with the candidates listed so the owner can point at the right
  // one.
  const matches = [];
  lines.forEach((l, i) => {
    if (l.includes(parsed.expect)) matches.push(i + 1);
  });
  if (matches.length === 1) {
    const [only] = matches;
    note(
      where,
      `${parsed.file}:${parsed.line} no longer contains "${parsed.expect}" — it moved to line ${only}; the citation was updated`,
    );
    return { file: parsed.file, line: only };
  }
  if (matches.length > 1) {
    fail(
      where,
      `${parsed.file}:${parsed.line} does not contain "${parsed.expect}", and it now appears on ${matches.length} lines (${matches.join(', ')}) — point the citation at the one you mean`,
    );
    return null;
  }

  fail(
    where,
    `${parsed.file}:${parsed.line} no longer contains "${parsed.expect}" — the code moved and the citation is stale`,
  );
  return null;
}

function checkTests(control, entries) {
  const where = control.id;
  for (const entry of entries) {
    const [filePart, titlePart] = entry.split('|').map((s) => (s ?? '').trim());
    const absolute = path.join(root, filePart);
    if (!existsSync(absolute)) {
      fail(where, `test path does not exist: ${filePart}`);
      continue;
    }
    if (!titlePart) continue;
    if (statSync(absolute).isDirectory()) {
      fail(where, `named a test title inside a directory: ${filePart}`);
      continue;
    }
    const body = readFileSync(absolute, 'utf8');
    if (!body.includes(titlePart)) {
      fail(where, `${filePart} has no test matching "${titlePart}"`);
    }
  }
}

function main() {
  if (!existsSync(mapPath)) {
    console.error(`compliance gate: no evidence map at ${mapPath}`);
    process.exit(1);
  }
  const controls = parseControls(readFileSync(mapPath, 'utf8'));
  if (controls.length < MIN_CONTROLS) {
    failures.push(
      `map: only ${controls.length} controls; at least ${MIN_CONTROLS} are expected for the surface this project claims`,
    );
  }

  const seen = new Set();
  const counts = { implemented: 0, partial: 0, absent: 0 };
  const frameworkHits = new Map(REQUIRED_FRAMEWORKS.map((f) => [f, 0]));
  // Every citation whose line number was corrected, across every control.
  const allCorrections = [];

  for (const control of controls) {
    const { id, fields } = control;
    if (seen.has(id)) fail('map', `duplicate control id "${id}"`);
    seen.add(id);

    const status = (fields.status ?? '').trim();
    if (!STATUSES.has(status)) {
      fail(id, `status "${status}" is not one of ${[...STATUSES].join(', ')}`);
      continue;
    }
    counts[status] = (counts[status] ?? 0) + 1;

    if (!(fields.claim ?? '').trim()) fail(id, 'no claim sentence');
    const sources = fields.sources ?? '';
    if (!sources.trim()) fail(id, 'no framework source');
    for (const framework of REQUIRED_FRAMEWORKS) {
      if (sources.includes(framework)) frameworkHits.set(framework, (frameworkHits.get(framework) ?? 0) + 1);
    }

    const evidence = list(fields.evidence);
    const tests = list(fields.tests);
    if (evidence.length === 0) fail(id, 'no evidence entries — a control with nothing behind it is a wish');
    // The citations that need their line number corrected are collected and
    // written back to the map below, so the correction persists rather than
    // being reported on every run.
    const corrections = [];
    for (const entry of evidence) {
      const fixed = checkEvidence(control, entry);
      if (fixed && fixed.line !== entryLine(entry)) {
        corrections.push({ entry, fixed });
      }
    }
    allCorrections.push(...corrections);
    checkTests(control, tests);

    if (status === 'implemented') {
      if (evidence.length === 0) fail(id, 'implemented without evidence');
      if (tests.length === 0) fail(id, 'implemented without a test');
      const gap = (fields.gap ?? '').trim();
      if (gap && gap !== '—') fail(id, 'implemented but carries a gap line; make the status match the sentence');
    } else {
      const gap = (fields.gap ?? '').trim();
      if (!gap || gap === '—') fail(id, `${status} without a gap sentence — say what is missing`);
    }
  }

  if ((counts.absent ?? 0) === 0) {
    fail('map', 'nothing is marked absent; a control map with no gaps is not an evidence map');
  }
  for (const id of REQUIRED_ABSENT) {
    const control = controls.find((c) => c.id === id);
    if (!control) fail('map', `${id} is missing from the map — the documented absence was deleted rather than fixed`);
    else if ((control.fields.status ?? '').trim() !== 'absent') {
      fail('map', `${id} is no longer marked absent while nothing has been built for it`);
    }
  }
  const withGap = controls.filter((c) => {
    const gap = (c.fields.gap ?? '').trim();
    return gap && gap !== '—';
  });
  if (withGap.length < 3) {
    fail(
      'map',
      `only ${withGap.length} control(s) state a gap; a build this age has more than that and the README says so`,
    );
  }
  for (const [framework, hits] of frameworkHits) {
    if (hits === 0) fail('map', `no control cites ${framework}, but the README claims coverage of it`);
  }

  // Every runbook link an alert rule carries must resolve to a heading in the
  // runbook file. A rule that points nowhere is an alert with no procedure,
  // and the person woken by it is the one who finds out.
  if (!existsSync(RUNBOOK_FILE)) {
    fail('runbooks', `docs/incidents.md is missing; every alert rule points at it`);
  } else if (existsSync(ALERT_RULES_FILE)) {
    const rules = readFileSync(ALERT_RULES_FILE, 'utf8');
    const runbook = readFileSync(RUNBOOK_FILE, 'utf8');
    const anchors = new Set(
      [...runbook.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) =>
        m[1]
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-'),
      ),
    );
    const referenced = [...rules.matchAll(/runbook:\s*'docs\/incidents\.md#([a-z0-9-]+)'/g)].map((m) => m[1]);
    if (referenced.length === 0) {
      fail('runbooks', 'no alert rule references docs/incidents.md; the runbook may have been renamed');
    }
    for (const anchor of new Set(referenced)) {
      if (!anchors.has(anchor)) {
        fail('runbooks', `docs/incidents.md has no section for the "${anchor}" anchor that the alert rules link to`);
      }
    }
  }

  if (verbose) {
    for (const control of controls) {
      console.log(
        `  ${control.id} — ${(control.fields.status ?? '').trim()} (${list(control.fields.evidence).length} evidence, ${list(control.fields.tests).length} tests)`,
      );
    }
  }

  // The corrected citations are written back to the map, so the correction
  // persists. A line number that is fixed in the report but not in the file
  // would be reported again on every run, and the report would grow.
  //
  // The replacement is SCOPED to the whole evidence entry — the path, the
  // line AND the `expect:` token — and never to the bare `path:line`. A bare
  // location is a PREFIX of every longer line number that shares its
  // digits: correcting `README.md:25` by replacing that string would also
  // rewrite `README.md:251`, silently moving a citation the gate had
  // validated against a different file. The gate would then be editing the
  // evidence it is supposed to be checking.
  if (allCorrections.length > 0) {
    let text = readFileSync(mapPath, 'utf8');
    for (const { entry, fixed } of allCorrections) {
      const location = entry.split(' expect:')[0]?.trim() ?? '';
      const m = /^(.+?):(\d+)$/.exec(location);
      if (!m) continue;
      // The full entry, with the same `expect:` suffix it already carries.
      const from = entry;
      const to = `${fixed.file}:${fixed.line} expect:${entry.split(' expect:')[1]?.trim() ?? ''}`.replace(/\s+$/, '');
      if (text.includes(from)) text = text.split(from).join(to);
    }
    writeFileSync(mapPath, text);
  }

  console.log(
    `compliance gate — ${failures.length === 0 ? 'PASS' : 'FAIL'}: ` +
      `${controls.length} controls (${counts.implemented} implemented, ${counts.partial} partial, ${counts.absent} absent), ` +
      `${failures.length} finding(s)`,
  );
  for (const f of failures) console.error(`  ✗ ${f}`);
  for (const n of notes) console.log(`  · ${n}`);
  console.error('  Note: this gate proves the citations resolve. It does not certify anything.');
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
