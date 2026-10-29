/**
 * Key rotation: the ring, and the window in which a chain written under an
 * old key still verifies.
 *
 * The property under test is not "the new key works" — it is that there is no
 * moment in the rotation in which the audit chain cannot be verified. That is
 * why the order matters: a key joins the ring BEFORE it becomes current, and
 * it leaves the ring only after the rows written under it have stopped
 * needing it.
 *
 * The ring lives in the environment, so the test drives it the way an
 * operator does: by setting `AUDIT_HMAC_KEYS` and letting the repositories
 * read it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@permitzero/domain';
import { appendAuditEvent, seed, verifyAuditChain, type Db, type SeedResult } from '../src/index.js';
import { currentKey, keyFingerprint, keyRing, verificationKeys } from '../src/crypto.js';
import { closeTestDb, resetTestDb, testDb } from './db-test.js';

let db: Db;
let seeded: SeedResult;

const OLD_KEY = 'rotation-old-master-key-0123456789abcd';
const NEW_KEY = 'rotation-new-master-key-0123456789abcd';

const ORIGINAL_KEYRING = process.env['AUDIT_HMAC_KEYS'];
const ORIGINAL_SINGLE_KEY = process.env['AUDIT_HMAC_KEY'];

const TENANT = () => seeded.tenantIds[0] ?? '';

function useKeyring(keys: string | null): void {
  if (keys === null) {
    delete process.env['AUDIT_HMAC_KEYS'];
  } else {
    process.env['AUDIT_HMAC_KEYS'] = keys;
  }
  delete process.env['AUDIT_HMAC_KEY'];
}

function event(n: number) {
  return {
    tenantId: TENANT(),
    actionId: null,
    runId: null,
    actorType: 'SYSTEM' as const,
    actorId: 'system:rotation-test',
    eventType: 'system.config_changed',
    eventTime: new Date(`2026-10-26T12:00:0${n}Z`),
    traceId: newId('trace'),
    policyRevisionId: null,
    payload: { n },
  };
}

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  if (ORIGINAL_KEYRING === undefined) delete process.env['AUDIT_HMAC_KEYS'];
  else process.env['AUDIT_HMAC_KEYS'] = ORIGINAL_KEYRING;
  if (ORIGINAL_SINGLE_KEY === undefined) delete process.env['AUDIT_HMAC_KEY'];
  else process.env['AUDIT_HMAC_KEY'] = ORIGINAL_SINGLE_KEY;
  await closeTestDb();
});

beforeEach(async () => {
  useKeyring(OLD_KEY);
  await resetTestDb();
  seeded = await seed(db);
});

describe('the keyring', () => {
  it('reads the first entry as the current key and the rest as verification keys', () => {
    useKeyring(`${NEW_KEY},${OLD_KEY}`);
    expect(currentKey()).toBe(NEW_KEY);
    expect(verificationKeys()).toEqual([NEW_KEY, OLD_KEY]);
    expect(keyRing()).toEqual([NEW_KEY, OLD_KEY]);
  });

  it('accepts a single key on its own', () => {
    delete process.env['AUDIT_HMAC_KEYS'];
    process.env['AUDIT_HMAC_KEY'] = OLD_KEY;
    expect(currentKey()).toBe(OLD_KEY);
    expect(verificationKeys()).toEqual([OLD_KEY]);
    delete process.env['AUDIT_HMAC_KEY'];
  });

  it('identifies a key without printing it', () => {
    expect(keyFingerprint(OLD_KEY)).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(keyFingerprint(OLD_KEY)).not.toContain(OLD_KEY);
    expect(keyFingerprint(OLD_KEY)).not.toBe(keyFingerprint(NEW_KEY));
  });
});

describe('rotating the master key', () => {
  it('keeps a chain written under the old key verifiable through every step', async () => {
    // Step 1: the chain is written while the old key is the only key.
    await appendAuditEvent(db.db, event(1));
    expect((await verifyAuditChain(db.db, TENANT())).chainValid).toBe(true);

    // Step 2: the new key is ADDED to the ring. Both verify; the old key is
    // still the one that writes.
    useKeyring(`${OLD_KEY},${NEW_KEY}`);
    expect(currentKey()).toBe(OLD_KEY);
    expect((await verifyAuditChain(db.db, TENANT())).chainValid).toBe(true);

    // Step 3: the new key becomes CURRENT. The old one still verifies, which
    // is what makes the activation safe to deploy on its own.
    useKeyring(`${NEW_KEY},${OLD_KEY}`);
    expect(currentKey()).toBe(NEW_KEY);
    expect((await verifyAuditChain(db.db, TENANT())).chainValid).toBe(true);

    // A row written after the activation is verified under the new key too.
    await appendAuditEvent(db.db, event(2));
    expect((await verifyAuditChain(db.db, TENANT())).chainValid).toBe(true);
  });

  it('stops verifying once the old key leaves the ring', async () => {
    await appendAuditEvent(db.db, event(1));

    // The old key is retired: the ring no longer holds it.
    useKeyring(NEW_KEY);
    const verification = await verifyAuditChain(db.db, TENANT());
    expect(verification.chainValid).toBe(false);
    expect(verification.breaks.length).toBeGreaterThan(0);
    expect(verification.breaks[0]?.reason).toContain('no key provided');
  });
});
