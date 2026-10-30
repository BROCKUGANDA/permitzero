/**
 * Server-issued MFA step-up assertions, and the second factor behind them.
 *
 * A step-up assertion is a signed statement that "this principal completed
 * step-up authentication for this action, at this time". The server issues it
 * when a step-up is performed and verifies it before an approval that requires
 * MFA is accepted.
 *
 * The second factor itself is TOTP (RFC 6238): a six-digit code from the
 * person's authenticator, derived from a shared secret. The secret is
 * generated here, verified here and encrypted here — the shared secret never
 * leaves this module in plaintext, and the code is compared in constant time.
 *
 * The encryption helpers exist because a TOTP secret is a credential that
 * reproduces itself: whoever holds it can mint a code at will, so it is
 * stored the way a password hash would be — except that it cannot be hashed,
 * because the server has to recompute a code from it. Hence encryption, with
 * a key derived from the server secret under a label of its own.
 *
 * Why this is not a client-supplied string: `require_mfa` used to be satisfied
 * by any non-empty `mfa_context_ref`, so the control was a field the caller
 * filled in — a caller who wanted to bypass it had to type one character. The
 * assertion below carries the server's signature over the subject, the action
 * and the expiry, so a client can present one but cannot manufacture one.
 *
 * Binding is deliberately narrow: tenant, principal, action and a short
 * expiry. An assertion for one approval cannot be replayed for another, and it
 * cannot outlive the moment it was issued.
 *
 * The signature is HMAC-SHA256 over the encoded payload and is compared in
 * constant time. The key is derived from the server secret with domain
 * separation, so forging an audit-chain entry and forging a step-up assertion
 * are not the same capability.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MFA_ASSERTION_PREFIX = 'pzmfa';
export const MFA_ASSERTION_VERSION = 1;

/**
 * How long an assertion stays usable. Step-up is a moment, not a session: an
 * assertion that is still valid an hour later is a credential, not a step-up.
 */
export const MFA_ASSERTION_TTL_SECONDS = 300;

export interface MfaAssertionPayload {
  v: number;
  tenantId: string;
  actorId: string;
  actionId: string;
  /** Epoch milliseconds. */
  issuedAt: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Makes two assertions for the same action distinguishable. */
  nonce: string;
}

export type MfaVerificationFailure =
  'MALFORMED' | 'UNSUPPORTED_VERSION' | 'BAD_SIGNATURE' | 'NOT_YET_VALID' | 'EXPIRED' | 'SUBJECT_MISMATCH';

export type MfaVerification =
  { ok: true; assertion: MfaAssertionPayload } | { ok: false; reason: MfaVerificationFailure };

export interface MfaExpectation {
  tenantId: string;
  actorId: string;
  actionId: string;
  /** The instant the assertion is judged against. */
  now: Date;
}

function encode(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function sign(payload: string, key: Buffer): string {
  return encode(createHmac('sha256', key).update(payload, 'utf8').digest());
}

/**
 * The assertion key, derived from the server secret rather than being that
 * secret. Domain separation is the point: one server secret must not be a
 * single capability, and a signature made with this key says nothing about an
 * audit chain signed with the raw secret.
 */
export function deriveMfaAssertionKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('permitzero/mfa-assertion/v1', 'utf8').digest();
}

/**
 * Issue an assertion. The caller is the server, at the moment a step-up was
 * actually performed — there is no way for a client to reach this function,
 * which is the entire point of the mechanism.
 */
export function issueMfaAssertion(
  payload: {
    tenantId: string;
    actorId: string;
    actionId: string;
    issuedAt: number;
    expiresAt: number;
    nonce?: string;
  },
  key: Buffer,
): string {
  const assertion: MfaAssertionPayload = {
    v: MFA_ASSERTION_VERSION,
    tenantId: payload.tenantId,
    actorId: payload.actorId,
    actionId: payload.actionId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce ?? randomBytes(8).toString('base64url'),
  };
  const encoded = encode(Buffer.from(JSON.stringify(assertion), 'utf8'));
  return `${MFA_ASSERTION_PREFIX}.${encoded}.${sign(encoded, key)}`;
}

/**
 * Verify an assertion against the subject it is expected to cover.
 *
 * Every failure mode is a refusal: a malformed token, a signature that does
 * not verify, a token issued in the future, an expired token, and a token that
 * is valid but belongs to another tenant, another principal or another action.
 * There is no "close enough" branch — a step-up is either this principal's
 * step-up for this action, or it is nothing.
 */
export function verifyMfaAssertion(token: string, key: Buffer, expected: MfaExpectation): MfaVerification {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== MFA_ASSERTION_PREFIX) return { ok: false, reason: 'MALFORMED' };
  const encoded = parts[1] ?? '';
  const provided = Buffer.from(parts[2] ?? '', 'base64url');
  const computed = Buffer.from(sign(encoded, key), 'base64url');
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'MALFORMED' };
  const assertion = parsed as MfaAssertionPayload;
  if (assertion.v !== MFA_ASSERTION_VERSION) return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  const now = expected.now.getTime();
  if (!Number.isFinite(now)) return { ok: false, reason: 'MALFORMED' };
  if (!Number.isFinite(assertion.issuedAt) || !Number.isFinite(assertion.expiresAt)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (now < assertion.issuedAt) return { ok: false, reason: 'NOT_YET_VALID' };
  if (now >= assertion.expiresAt) return { ok: false, reason: 'EXPIRED' };
  if (
    assertion.tenantId !== expected.tenantId ||
    assertion.actorId !== expected.actorId ||
    assertion.actionId !== expected.actionId
  ) {
    return { ok: false, reason: 'SUBJECT_MISMATCH' };
  }
  return { ok: true, assertion };
}

// ---------------------------------------------------------------------------
// The second factor: TOTP (RFC 6238)
// ---------------------------------------------------------------------------

/**
 * The TOTP parameters, fixed rather than configurable.
 *
 * SHA-1 is what every authenticator app in the world implements, and a second
 * factor that most people cannot enrol is not a factor. Six digits and a
 * thirty-second step are the defaults an authenticator assumes, so a code
 * typed into this product works with the app the person already has.
 */
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

/**
 * How many steps either side of "now" a code is accepted from.
 *
 * One step each way, so a person whose clock is a little off is not locked
 * out and a code that was captured a moment ago has already expired. Wider
 * windows multiply the number of live codes per secret, which is a cost paid
 * in replay risk, so this is one and not three.
 */
export const TOTP_DEFAULT_WINDOW = 1;

/**
 * The base32 alphabet of RFC 4648, minus the padding.
 *
 * Written out rather than pulled from a dependency: the encoding is ten lines
 * and a package would be a dependency to maintain and audit for the sake of
 * ten lines. Authenticator apps read base32 without padding, which is what
 * `generateTotpSecret` produces.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Base32 (RFC 4648) without padding; null when the input is not base32. */
export function base32Decode(input: string): Buffer | null {
  const normalized = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  if (normalized.length === 0) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < normalized.length; i++) {
    const index = BASE32_ALPHABET.indexOf(normalized[i]!);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A fresh TOTP shared secret.
 *
 * Twenty bytes: RFC 4226 says 160 bits, which is what an authenticator
 * expects and what makes guessing the secret hopeless. The secret is returned
 * to the caller exactly once, in the enrolment response, and never again —
 * the server keeps only the encrypted form.
 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * The six-digit code for the step that contains `atMs`.
 *
 * The counter is the number of thirty-second steps since the Unix epoch, the
 * HMAC-SHA1 of that counter under the shared secret is truncated the way
 * RFC 4226 says, and the result is reduced modulo 10^6. `atMs` is a parameter
 * rather than a clock read so the whole thing stays a pure function: the
 * caller decides what "now" means, and a test can place a code in any step it
 * likes.
 *
 * Throws on a secret that is not base32: that is a corrupt secret, and a
 * corrupt secret must not be mistaken for a valid one.
 */
export function totpCode(secret: string, atMs: number): string {
  const key = base32Decode(secret);
  if (!key || key.length === 0) throw new Error('The TOTP secret is not valid base32.');
  const counter = Math.max(0, Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** The TOTP step counter for the instant `atMs`. */
export function totpStep(atMs: number): number {
  return Math.max(0, Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
}

/**
 * The TOTP step counter of `code` if it matches `secret` in the window around
 * `atMs`, otherwise null.
 *
 * Every candidate step is compared and no comparison ends the search, so the
 * time taken does not depend on WHICH step matched. The comparison itself is
 * `timingSafeEqual`, which refuses buffers of different lengths — hence the
 * length check first, on a value whose length is not secret.
 *
 * Returning the step rather than a boolean lets the caller store the step and
 * accept a code only when its step exceeds the stored one — without that, a
 * code from an earlier step could be replayed after a later step was accepted,
 * because the window is ±1 and only the last hash was remembered.
 */
export function verifyTotpCodeStep(
  secret: string,
  code: string,
  atMs: number,
  window: number = TOTP_DEFAULT_WINDOW,
): number | null {
  const candidate = typeof code === 'string' ? code.trim() : '';
  if (!/^\d{6}$/.test(candidate)) return null;
  const provided = Buffer.from(candidate, 'utf8');
  const steps = Math.max(0, Math.floor(window));
  const base = totpStep(atMs);
  let matchedStep: number | null = null;
  for (let offset = -steps; offset <= steps; offset++) {
    let expected: string;
    try {
      expected = totpCode(secret, atMs + offset * TOTP_PERIOD_SECONDS * 1000);
    } catch {
      return null;
    }
    const expectedBytes = Buffer.from(expected, 'utf8');
    // Constant-time per candidate, constant-time over the window: which step
    // matched does not affect how long the function takes.
    if (expectedBytes.length === provided.length && timingSafeEqual(expectedBytes, provided)) {
      matchedStep = base + offset;
    }
  }
  return matchedStep;
}

/**
 * True when `code` is the TOTP code for the step containing `atMs`, or for
 * one of the `window` steps either side of it.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  atMs: number,
  window: number = TOTP_DEFAULT_WINDOW,
): boolean {
  return verifyTotpCodeStep(secret, code, atMs, window) !== null;
}

/**
 * The `otpauth://` URI an authenticator app reads, for a QR code or for
 * manual entry.
 *
 * The label is `issuer:account` as the Key URI format says, and the issuer is
 * repeated as a query parameter because apps disagree about where they read
 * it from. The secret is in the URI — which is why the URI is shown exactly
 * once, at enrolment, and why the enrolment response is the one response in
 * this API that carries a credential.
 */
export function totpUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Storing the shared secret
// ---------------------------------------------------------------------------

/**
 * The key that encrypts TOTP secrets, derived from the server secret rather
 * than being that secret.
 *
 * The same discipline as `deriveMfaAssertionKey`, and for the same reason: one
 * server secret must not be a single capability. A key that can sign a
 * step-up assertion cannot decrypt a shared secret, and the label keeps the
 * two derivations apart even though they start from the same master.
 *
 * HMAC rather than a password KDF on purpose: the master secret is already a
 * 32-byte random value, so there is no low-entropy secret for a KDF to
 * stretch. What is needed here is domain separation, and that is what a
 * labelled HMAC provides.
 */
export function deriveMfaSecretKey(masterSecret: string): Buffer {
  return createHmac('sha256', masterSecret).update('permitzero/mfa-secret/v1', 'utf8').digest();
}

/**
 * Encrypt a TOTP secret under AES-256-GCM.
 *
 * The output is `v1.<iv>.<tag>.<ciphertext>`, base64url. The version is in the
 * clear so the format can change without a migration; the IV is random per
 * call, so encrypting the same secret twice does not produce the same text;
 * GCM's tag is what makes a tampered ciphertext fail to decrypt rather than
 * decrypt into something else.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Decrypt a secret produced by `encryptSecret`; null when it cannot be read.
 *
 * Null rather than a throw, because the two reasons for failure are the same
 * from the caller's side: the ciphertext is not ours, or it was altered.
 * Telling them apart would tell an attacker which half they achieved.
 */
export function decryptSecret(payload: string, key: Buffer): string | null {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * A keyed fingerprint of a TOTP code, for remembering that a code was spent.
 *
 * The code itself is six digits — a million possibilities, which is nothing
 * to brute force — so the fingerprint is an HMAC under the server's key
 * rather than a plain hash: a database dump on its own does not confirm a
 * guessed code. The label keeps this from being confused with any other use
 * of the same key.
 */
export function hashConsumedCode(key: Buffer, code: string): string {
  return createHmac('sha256', key).update(`permitzero/mfa-code/v1:${code}`, 'utf8').digest('hex');
}
