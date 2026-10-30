/**
 * Encryption at rest, and the keyring that makes a master-key rotation
 * survivable.
 *
 * Three decisions live in this file, and each of them is a decision about what
 * the database is allowed to say in the clear:
 *
 *  1. The STORED bytes are ciphertext; the RECORD of what happened is the
 *     canonical plaintext. The audit chain's hash is computed over the
 *     canonical plaintext and the payload is encrypted afterwards, so the chain
 *     still proves what the decision was while the row on disk no longer says
 *     it. Encrypting first and hashing the ciphertext would have been simpler
 *     and wrong: the hash would then prove only that a ciphertext was not
 *     altered, not what was decided.
 *
 *  2. The envelope is SELF-DESCRIBING (`enc.v1.<iv>.<tag>.<ciphertext>`), so a
 *     row written before encryption was switched on is still readable. The
 *     legacy rule is deliberate: a value that carries no envelope is returned
 *     unchanged. `audit_events` is append-only, so those rows can never be
 *     rewritten in place; refusing to read them would turn a migration into an
 *     outage, and quietly "fixing" them would rewrite evidence.
 *
 *  3. ONE master secret, MANY derived keys. Every purpose derives its own key
 *     with HKDF-SHA256 under a distinct label, so the capability to read an
 *     audit payload is not the capability to read an outbox payload, and
 *     neither is the capability to forge an audit-chain entry. The master
 *     secret itself is never used as a cipher key.
 *
 * The keyring exists because a master key that cannot be rotated is a master
 * key that cannot be leaked safely. `AUDIT_HMAC_KEYS` is an ordered list — the
 * first entry is the current key, the rest are accepted for verification only —
 * so a rotation can be staged (add the new key, keep the old one current),
 * activated (make the new key current, keep the old one for verification), and
 * finally retired (drop the old key) without a window in which the audit chain
 * cannot be verified.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/** The envelope's version tag. Bump the suffix when the wire format changes. */
export const ENVELOPE_PREFIX = 'enc.v1';

/**
 * The jsonb key that marks a column as holding an envelope rather than a
 * plaintext payload.
 *
 * A reserved key rather than a bare string so that the column stays jsonb: a
 * jsonb column holding a bare JSON string is indistinguishable from a payload
 * that happens to be a string, and every reader would have to guess. The marker
 * is also what makes the legacy rule decidable — "is this row encrypted?" is a
 * question with an answer, not a guess.
 */
export const ENVELOPE_FIELD = '__pz_enc';

/** The shape of a well-formed envelope. Checked in SQL as well as in TypeScript. */
export const ENVELOPE_PATTERN = /^enc\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** The environment variable holding the ordered keyring. */
export const KEYRING_ENV = 'AUDIT_HMAC_KEYS';

/** The single-key environment variable, kept working on its own. */
export const SINGLE_KEY_ENV = 'AUDIT_HMAC_KEY';

/**
 * The purposes a key can be derived for.
 *
 * `secret-material` is declared but unused today: the schema deliberately
 * stores a secret-manager REFERENCE, a one-way hash and a short prefix rather
 * than a plaintext secret, so there is nothing to encrypt. The label exists so
 * that the day a column does hold secret material it gets its own key rather
 * than borrowing the audit one.
 */
export type EncryptionPurpose =
  'audit-payload' | 'outbox-payload' | 'execution-payload' | 'model-evaluation-payload' | 'secret-material';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * A fixed salt for every derivation.
 *
 * HKDF's salt is not a secret — it exists to stop the same input key from
 * producing the same output key in two different derivations. It is a constant
 * here because the master secret is already high-entropy and the domain
 * separation comes from `info` (the purpose), not from the salt.
 */
const HKDF_SALT = 'permitzero/db/encryption/v1';

export type DecryptionFailure = 'MALFORMED' | 'UNAUTHENTICATED' | 'NO_KEY';

/**
 * A refusal to decrypt, with the reason separated from the message.
 *
 * The reason matters to callers that must decide between "this row is
 * unreadable" and "this row was tampered with": both are failures, but only
 * one of them is evidence of an attack.
 */
export class DecryptionError extends Error {
  readonly reason: DecryptionFailure;

  constructor(reason: DecryptionFailure, message: string) {
    super(message);
    this.name = 'DecryptionError';
    this.reason = reason;
  }
}

/**
 * Derive the key for one purpose from the master secret.
 *
 * HKDF-SHA256 rather than a bare hash of the secret: a hash gives every
 * purpose the SAME key material, and the domain separation would then rest on
 * the caller remembering to use a different key. HKDF makes the separation
 * structural — the label is part of the derivation, so two purposes cannot
 * collide even if the labels are transposed by a caller.
 */
export function deriveKey(masterSecret: string, purpose: string): Buffer {
  if (typeof masterSecret !== 'string' || masterSecret.length === 0) {
    throw new Error('deriveKey: the master secret is empty');
  }
  const derived = hkdfSync(
    'sha256',
    Buffer.from(masterSecret, 'utf8'),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(`permitzero/db/${purpose}/v1`, 'utf8'),
    KEY_BYTES,
  );
  return Buffer.from(derived);
}

/**
 * Encrypt a string with AES-256-GCM.
 *
 * GCM rather than CBC precisely because it authenticates: a ciphertext whose
 * bytes were altered fails the tag check instead of decrypting into garbage.
 * For the audit chain that is the difference between "tampering is detected"
 * and "tampering is silently reinterpreted".
 */
export function encrypt(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

/**
 * Decrypt an envelope.
 *
 * Refuses three different things for three different reasons: a value that is
 * not an envelope at all (MALFORMED), a value whose bytes were altered or
 * whose key is wrong (UNAUTHENTICATED — GCM cannot tell those apart, and
 * pretending otherwise would be a lie), and a caller with no key (NO_KEY).
 */
export function decrypt(encoded: string, key: Buffer): string {
  assertKey(key);
  // The prefix carries a dot of its own, so the envelope is cut at the
  // prefix rather than split on every dot: `enc.v1` is the version, and the
  // three segments after it are the iv, the tag and the ciphertext.
  const prefix = `${ENVELOPE_PREFIX}.`;
  const parts =
    typeof encoded === 'string' && encoded.startsWith(prefix) ? encoded.slice(prefix.length).split('.') : [];
  if (parts.length !== 3) {
    throw new DecryptionError('MALFORMED', 'the value is not a permitzero encryption envelope');
  }
  const iv = decodeSegment(parts[0], IV_BYTES);
  const tag = decodeSegment(parts[1], TAG_BYTES);
  const ciphertext = decodeSegment(parts[2]);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError(
      'UNAUTHENTICATED',
      'the envelope failed authentication: the ciphertext was altered or the key is wrong',
    );
  }
}

/**
 * The envelope inside a stored column value, or null when the column holds a
 * plaintext payload.
 *
 * A value is an envelope only when the marker holds a WELL-FORMED envelope of
 * the current version. A payload that merely happens to carry a key called
 * `__pz_enc` — with any other value in it — is a payload, and is treated as
 * one. Reading it as ciphertext would fail a row that is perfectly readable,
 * which is the kind of false positive that makes an operator distrust the
 * reader that reported it.
 */
export function envelopeOf(stored: unknown): string | null {
  if (typeof stored === 'string') {
    return ENVELOPE_PATTERN.test(stored) ? stored : null;
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const marker = (stored as Record<string, unknown>)[ENVELOPE_FIELD];
  return typeof marker === 'string' && ENVELOPE_PATTERN.test(marker) ? marker : null;
}

/** True when the stored value carries an encryption envelope. */
export function isEncryptedColumn(stored: unknown): boolean {
  return envelopeOf(stored) !== null;
}

/**
 * Encrypt a JSON value for storage in a jsonb column.
 *
 * The plaintext is JSON, not a native structure, so that what comes back out
 * is exactly what a jsonb column would have held: jsonb drops `undefined`
 * members and preserves nothing else about the JavaScript value. Encrypting
 * the object itself would have produced a row that decrypts to something the
 * column could never have held.
 */
export function encryptColumn(value: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  return { [ENVELOPE_FIELD]: encrypt(serializeForStorage(value), key) };
}

/**
 * The same, for a column that may be NULL.
 *
 * NULL stays NULL rather than becoming an envelope of "null": a receipt that
 * does not exist is not a secret, and storing an envelope for it would make
 * "no receipt" and "a receipt whose content is null" indistinguishable.
 */
export function encryptNullableColumn(
  value: Record<string, unknown> | null,
  key: Buffer,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return encryptColumn(value, key);
}

/**
 * Read a column that may hold an envelope.
 *
 * THE LEGACY RULE: a value with no envelope is returned unchanged. A row
 * written before encryption was enabled keeps its plaintext, keeps verifying,
 * and does not crash the reader.
 *
 * An envelope is decrypted with the first key that opens it. A keyring is a
 * list of keys that were valid at some point, so trying each of them is not a
 * weakening of the authentication: every one of them is a key the server was
 * configured to trust for this data.
 */
export function readColumn<T = Record<string, unknown>>(stored: unknown, keys: readonly Buffer[]): T {
  const envelope = envelopeOf(stored);
  if (envelope === null) return stored as T;
  if (keys.length === 0) {
    throw new DecryptionError('NO_KEY', 'no key is available to decrypt this column');
  }
  let failure: DecryptionError | null = null;
  for (const key of keys) {
    try {
      return JSON.parse(decrypt(envelope, key)) as T;
    } catch (err) {
      failure =
        err instanceof DecryptionError ? err : new DecryptionError('MALFORMED', 'the decrypted payload is not JSON');
    }
  }
  throw failure ?? new DecryptionError('UNAUTHENTICATED', 'no key in the ring could decrypt this column');
}

/**
 * The keyring: the ordered list of keys this deployment accepts.
 *
 * `AUDIT_HMAC_KEYS` wins when it is set, and its FIRST entry is the current
 * key. `AUDIT_HMAC_KEY` alone still works, as a one-entry ring. The list is
 * read from the environment on every call rather than cached at import time,
 * so a rotated key does not need a rebuild — only a restart, which is what an
 * operator rotating a key is doing anyway.
 */
export function keyRing(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = splitKeys(env[KEYRING_ENV]);
  if (listed.length > 0) return listed;
  const single = (env[SINGLE_KEY_ENV] ?? '').trim();
  return single.length > 0 ? [single] : [];
}

/** The key new writes use. Null when the deployment has no key at all. */
export function currentKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return keyRing(env)[0] ?? null;
}

/** Every key that may verify or decrypt, current first. */
export function verificationKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return keyRing(env);
}

/**
 * A short, non-reversible fingerprint of a key.
 *
 * Printed by the rotation CLI so an operator can confirm WHICH key is in use
 * without the key appearing in a terminal, a log or a screenshot. Twelve hex
 * characters of SHA-256 is enough to tell two keys apart and useless for
 * recovering one.
 */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12)}`;
}

function splitKeys(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`the encryption key must be ${KEY_BYTES} bytes of derived key material`);
  }
}

/**
 * Decode one base64url segment of an envelope.
 *
 * `Buffer.from(x, 'base64url')` silently ignores characters outside the
 * alphabet, so a corrupted envelope would decode into different bytes instead
 * of being rejected. The charset is checked first.
 */
function decodeSegment(segment: string | undefined, expectedLength?: number): Buffer {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new DecryptionError('MALFORMED', 'the envelope contains a segment that is not base64url');
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new DecryptionError(
      'MALFORMED',
      `the envelope segment is ${decoded.length} bytes, expected ${expectedLength}`,
    );
  }
  return decoded;
}

/**
 * Serialize a JSON value for storage.
 *
 * `JSON.stringify` matches what a jsonb column would have stored: `undefined`
 * members are dropped, dates become their ISO form, and key order is not
 * preserved (jsonb does not preserve it either). A bigint becomes a number
 * rather than throwing, because the domain keeps money within the safe
 * integer range and a payload that cannot be serialized is worse than one
 * whose money field arrived as a JSON number.
 */
function serializeForStorage(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? Number(item) : item));
}
