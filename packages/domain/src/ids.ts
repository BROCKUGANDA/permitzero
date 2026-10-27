/**
 * Identifier generation.
 *
 * ULID (Crockford base32, 48-bit ms timestamp + 80-bit randomness) so IDs are
 * lexicographically sortable by creation time — this matters for the append-only
 * audit timeline and for range scans on (tenant_id, created_at DESC).
 *
 * Every ID carries a type prefix so a mis-typed ID fails loudly instead of
 * silently resolving to a row in another table (PRD FR-013: server-side action ID
 * and trace ID are distinct from any client-supplied request ID).
 */
import { randomBytes } from 'node:crypto';
import { ID_PREFIX, type IdKind } from './id-prefixes.js';

export { ID_PREFIX, type IdKind } from './id-prefixes.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let mod = now;
  const out: string[] = new Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = ENCODING[mod % ENCODING_LEN] as string;
    mod = Math.floor(mod / ENCODING_LEN);
  }
  return out.join('');
}

/**
 * Monotonic state within one process: ids minted in the same millisecond
 * increment the random part instead of re-rolling it, so lexicographic order
 * always matches creation order (the guarantee the module comment makes).
 */
let lastMs = 0;
let lastRandom: number[] | null = null;

export function ulid(seedTime: number = Date.now()): string {
  let now = seedTime;
  if (now < lastMs) now = lastMs; // clock moved backwards: hold, never go back
  if (now === lastMs && lastRandom !== null) {
    const next = [...lastRandom];
    let i = next.length - 1;
    for (; i >= 0; i--) {
      next[i] = ((next[i] as number) + 1) % ENCODING_LEN;
      if (next[i] !== 0) break;
    }
    if (i < 0) throw new Error('ulid random overflow: more than 2^80 ids in one millisecond');
    lastRandom = next;
  } else {
    const bytes = randomBytes(RANDOM_LEN);
    lastRandom = Array.from(bytes, (b) => (b as number) % ENCODING_LEN);
    lastMs = now;
  }
  return encodeTime(now, TIME_LEN) + (lastRandom as number[]).map((d) => ENCODING[d]).join('');
}

/**
 * W3C Trace Context <-> domain trace id, losslessly.
 *
 * A `traceparent` carries 128 bits as 32 lowercase hex characters. This
 * repository's identifiers are `trc_` + 26 Crockford base32 characters, and the
 * schema enforces that shape — so adopting a caller's trace id is not a matter
 * of pasting a hex string into an ID column, it is a base conversion.
 *
 * It happens to be exact: 26 symbols x 5 bits = 130 bits of capacity for a
 * 128-bit value, so nothing is truncated and nothing is padded. Two traces from
 * the same caller therefore produce the same stored id (the join an operator
 * actually needs), and `w3cTraceIdFromId()` recovers the original hex when the
 * audit trail has to be handed back to the caller's tracing system.
 *
 * The tradeoff is deliberate and worth stating: a derived trace id is not a
 * ULID, so it does not sort by creation time. Trace ids are looked up by value
 * or by (tenant_id, trace_id), never ranged, so nothing depends on the ordering
 * that `newId('trace')` would have given.
 */
const W3C_TRACE_BYTES = 16;
const W3C_TRACE_HEX_LEN = W3C_TRACE_BYTES * 2;
const W3C_TRACE_BASE32_LEN = 26;

function bigIntToBase32(value: bigint, len: number): string {
  const out: string[] = new Array(len);
  let rest = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = ENCODING[Number(rest % BigInt(ENCODING_LEN))] as string;
    rest /= BigInt(ENCODING_LEN);
  }
  return out.join('');
}

function base32ToBigInt(text: string): bigint | null {
  let value = 0n;
  for (const char of text) {
    const index = ENCODING.indexOf(char);
    if (index === -1) return null;
    value = value * BigInt(ENCODING_LEN) + BigInt(index);
  }
  return value;
}

/** `trc_` + 26 base32 characters carrying the caller's 128-bit trace id, or null if `hex` is not one. */
export function traceIdFromW3C(hex: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  // All-zero is a valid 128-bit value but is reserved-invalid by the trace
  // context spec; accepting it would let an invalid caller trace look like a
  // real one in the audit chain.
  if (hex === '0'.repeat(32)) return null;
  const encoded = bigIntToBase32(BigInt(`0x${hex}`), W3C_TRACE_BASE32_LEN);
  // 26 symbols hold 130 bits, so the leading symbol can only carry the top 2 of
  // them: Crockford '0'..'7'. Anything else means the conversion is wrong rather
  // than the input being unusual, and the assertion is cheaper than shipping a
  // malformed id into a column the schema validates.
  if (encoded.length !== W3C_TRACE_BASE32_LEN || !'01234567'.includes(encoded[0] as string)) {
    return null;
  }
  return `${ID_PREFIX.trace}_${encoded}`;
}

/** Inverse of `traceIdFromW3C`, for handing a stored trace id back to the caller's tracer. */
export function w3cTraceIdFromId(id: string): string | null {
  const match = new RegExp(`^${ID_PREFIX.trace}_([0-9A-HJKMNP-TV-Z]{26})$`).exec(id);
  if (!match?.[1]) return null;
  const value = base32ToBigInt(match[1]);
  if (value === null || value > (1n << 128n) - 1n) return null;
  return value.toString(16).padStart(W3C_TRACE_HEX_LEN, '0');
}

const PREFIX_TO_KIND = new Map<string, IdKind>(
  Object.entries(ID_PREFIX).map(([kind, prefix]) => [prefix as string, kind as IdKind]),
);

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid()}`;
}

export function newTraceId(): string {
  return newId('trace');
}

/**
 * Parse and validate a prefixed ID. Returns the kind only when the prefix is
 * known and the body is a well-formed 26-char ULID; otherwise null. Used at API
 * boundaries so a cross-table ID cannot be substituted for the expected one.
 */
export function parseId(id: string): { kind: IdKind; body: string } | null {
  const sep = id.indexOf('_');
  if (sep <= 0 || sep === id.length - 1) return null;
  const prefix = id.slice(0, sep);
  const body = id.slice(sep + 1);
  const kind = PREFIX_TO_KIND.get(prefix);
  if (!kind) return null;
  if (body.length !== TIME_LEN + RANDOM_LEN) return null;
  for (const ch of body) {
    if (!ENCODING.includes(ch)) return null;
  }
  return { kind, body };
}

export function isIdOfKind(id: string, kind: IdKind): boolean {
  const parsed = parseId(id);
  return parsed !== null && parsed.kind === kind;
}
