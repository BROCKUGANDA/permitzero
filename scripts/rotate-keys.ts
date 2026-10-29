#!/usr/bin/env tsx
/**
 * Master-key rotation for the PermitZero audit chain and the encrypted
 * payload columns.
 *
 * Why a script and not a runbook paragraph: the safe order for a key rotation
 * is not obvious, and getting it wrong loses the ability to verify the audit
 * chain — which is the one thing the chain is for. The safe order is:
 *
 *   1. ADD the new key to the ring, keeping the old one current. Both verify;
 *      nothing changes for the rows already on disk.
 *   2. MAKE the new key current. The old key still verifies.
 *   3. WAIT for as long as rows written under the old key must stay
 *      verifiable.
 *   4. REMOVE the old key. Rows written under it stop verifying, and the
 *      chain reports them as breaks. That is the point: a ring with no defined
 *      lifetime is a key that was never rotated.
 *
 * This script prints the exact environment value for each step. It never
 * prints a key unless it is printing the value the operator is about to put in
 * the environment, and the status output prints FINGERPRINTS only — a
 * SHA-256 prefix, which is enough to tell two keys apart and useless for
 * recovering either.
 *
 * The key material itself is deliberately awkward to pass: `--new` puts it in
 * the shell history and in the process list, and `--from-file` exists for the
 * cases where that matters. Both paths warn.
 */
import { readFileSync } from 'node:fs';
import { keyFingerprint, keyRing } from '../packages/db/src/crypto.js';
import { loadRootEnv } from '../packages/db/src/root-env.js';

const KEYRING_ENV = 'AUDIT_HMAC_KEYS';
const SINGLE_KEY_ENV = 'AUDIT_HMAC_KEY';

interface Options {
  newKey: string | null;
  fromFile: string | null;
  activate: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { newKey: null, fromFile: null, activate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--activate') {
      options.activate = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--new') {
      options.newKey = argv[++i] ?? null;
    } else if (arg === '--from-file') {
      options.fromFile = argv[++i] ?? null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    'Usage:',
    '  tsx scripts/rotate-keys.ts                              status: fingerprints and the runbook',
    '  tsx scripts/rotate-keys.ts --new <key>                  stage: add the new key to the ring',
    '  tsx scripts/rotate-keys.ts --new <key> --activate       activate: make the new key current',
    '  tsx scripts/rotate-keys.ts --from-file <path> [--activate]',
    '',
    'The key is read from AUDIT_HMAC_KEYS (comma separated, first entry is current) or',
    'AUDIT_HMAC_KEY (single key) in the environment, falling back to the repository .env.',
  ].join('\n');
}

/**
 * The key out of a file.
 *
 * The first non-empty line, trimmed: a file written by `openssl rand -hex 32`
 * has a trailing newline, and a trailing newline inside an environment
 * variable is a key nobody can reproduce.
 */
function readKeyFile(file: string): string {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the key file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const first = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) throw new Error(`the key file ${file} is empty`);
  return first;
}

function runbook(): string {
  return [
    '',
    'RUNBOOK — rotating the master key without losing the ability to verify the chain',
    '',
    '  The ring is ordered. The FIRST key is the current one: it signs new writes. Every',
    '  other key is accepted for VERIFICATION only. The order of the steps below is the',
    '  safety property — a key joins the ring BEFORE it is allowed to write, so every row',
    '  on disk is always readable by the ring that can verify it.',
    '',
    '  1. STAGE     Run this script with --new <key> (or --from-file <path>) and put the',
    '               printed AUDIT_HMAC_KEYS value into the environment of EVERY process',
    '               that writes or verifies: the API, the worker, and whatever runs the',
    '               audit sweep. Deploy and restart. Both keys now verify; the old key',
    '               still writes. No row on disk has changed.',
    '',
    '  2. ACTIVATE  Run this script with --new <key> --activate and put the printed value',
    '               into the environment. Deploy and restart. The new key writes from now',
    '               on and the old key still verifies, so the rows written under it stay',
    '               checkable.',
    '',
    '  3. WAIT      Keep the old key in the ring for as long as rows written under it',
    "               must remain verifiable. The ring's lifetime is the retention window",
    '               of the evidence, not a matter of preference.',
    '',
    '  4. RETIRE    When no row needs the old key any more, remove it from AUDIT_HMAC_KEYS.',
    '               Rows written under it stop verifying and the chain reports them as',
    '               breaks. That is the intended outcome, not a failure.',
    '',
    '  NOTE         apps/api/src/config.ts and apps/worker/src/config.ts still require',
    '               AUDIT_HMAC_KEY and read it for the writes they make. Keep',
    '               AUDIT_HMAC_KEY equal to the FIRST entry of AUDIT_HMAC_KEYS. If the',
    '               two disagree, the API and the worker write with one key while the',
    '               ring says another, and the chain becomes two chains.',
    '',
  ].join('\n');
}

function statusOutput(ring: string[], env: NodeJS.ProcessEnv): string {
  const lines = ['', 'PermitZero master key — status', ''];
  if (ring.length === 0) {
    lines.push(
      '  No key is configured.',
      '  AUDIT_HMAC_KEYS and AUDIT_HMAC_KEY are both empty, so the audit chain is an',
      '  UNKEYED SHA-256 and the payload columns are stored in the clear. That is the',
      '  pre-existing behaviour of a deployment with no key.',
      '',
    );
  } else {
    lines.push(`  ring size : ${ring.length}`);
    ring.forEach((key, index) => {
      const role = index === 0 ? 'current — writes' : 'verification only';
      lines.push(`    [${index + 1}] ${keyFingerprint(key)}  (${role})`);
    });
    lines.push('');
  }
  const single = (env[SINGLE_KEY_ENV] ?? '').trim();
  if (single) {
    const agrees = ring.length > 0 && ring[0] === single;
    lines.push(`  ${SINGLE_KEY_ENV} : ${keyFingerprint(single)}`);
    lines.push(
      agrees
        ? '    agrees with the head of the ring.'
        : '    DOES NOT AGREE with the head of the ring. The application reads this variable',
    );
    if (!agrees) {
      lines.push(
        '    for the writes it makes, so the API and the worker would sign with a key the',
        '    ring does not consider current. Fix this before deploying anything.',
      );
    }
    lines.push('');
  }
  lines.push('  The key itself is never printed here. A fingerprint is enough to identify it.');
  return lines.join('\n');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.newKey !== null && options.fromFile !== null) {
    throw new Error('--new and --from-file are mutually exclusive: a key arrives one way or the other');
  }

  // The repository .env is read so that the operator sees the ring the
  // deployment actually uses. An explicit environment always wins, because
  // `loadRootEnv` never overwrites a value that is already set.
  loadRootEnv();
  const env = process.env;
  const ring = keyRing(env);

  const staged = options.fromFile !== null ? readKeyFile(options.fromFile) : options.newKey;
  if (staged !== null && staged.length === 0) {
    throw new Error('the key is empty');
  }

  if (staged === null) {
    console.log(statusOutput(ring, env));
    console.log(runbook());
    return;
  }

  const existing = ring.filter((key) => key !== staged);
  const warning =
    options.fromFile !== null
      ? [
          '',
          "  WARNING: the key is in this terminal's scrollback. It was read from a file,",
          '  so it is NOT in your shell history — but it is printed here, because the value',
          '  has to be pasted into the environment.',
          '',
        ].join('\n')
      : [
          '',
          "  WARNING: the key is in this terminal's scrollback. It was passed on the",
          '  command line, so it is ALSO in your shell history and in the process list of',
          '  every process on the machine. Use --from-file <path> for a key that matters.',
          '',
        ].join('\n');

  if (!options.activate) {
    // STAGE: the new key joins the ring at the END, so it verifies but does
    // not write. The current key stays where it is.
    const stagedRing = [...existing, staged];
    console.log(statusOutput(ring, env));
    console.log(
      [
        '',
        'STAGE — the new key is added to the ring and does NOT write yet.',
        '',
        '  Put this in the environment of every process that writes or verifies',
        '  (API, worker, audit sweep), then deploy and restart:',
        '',
        `    ${KEYRING_ENV}=${stagedRing.join(',')}`,
        `    ${SINGLE_KEY_ENV}=${existing[0] ?? staged}`,
        '',
        '  The current key still writes; the new key verifies. Nothing on disk has',
        '  changed, and every existing row is still verifiable.',
        '',
      ].join('\n'),
    );
    console.log(warning);
    console.log(runbook());
    return;
  }

  // ACTIVATE: the new key moves to the HEAD of the ring, so it writes, and the
  // old keys stay behind it for verification.
  const activatedRing = [staged, ...existing];
  console.log(statusOutput(ring, env));
  console.log(
    [
      '',
      'ACTIVATE — the new key writes from now on; the retired keys still verify.',
      '',
      '  Put this in the environment of every process that writes or verifies',
      '  (API, worker, audit sweep), then deploy and restart:',
      '',
      `    ${KEYRING_ENV}=${activatedRing.join(',')}`,
      `    ${SINGLE_KEY_ENV}=${staged}`,
      '',
      '  Rows written under the previous key stay verifiable until it leaves the ring.',
      '',
    ].join('\n'),
  );
  console.log(warning);
  console.log(runbook());
}

try {
  main();
} catch (err) {
  console.error(`rotate-keys: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
