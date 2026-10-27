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
