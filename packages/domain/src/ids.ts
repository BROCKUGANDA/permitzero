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

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING[(bytes[i] as number) % ENCODING_LEN];
  }
  return out;
}

export function ulid(seedTime: number = Date.now()): string {
  return encodeTime(seedTime, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

/** ID prefixes. Add a prefix here and it becomes part of the parsed contract. */
export const ID_PREFIX = {
  tenant: 'ten',
  user: 'usr',
  membership: 'mbr',
  agent: 'agt',
  credential: 'cred',
  policy: 'pol',
  policyRevision: 'polrev',
  action: 'act',
  trace: 'trc',
  approval: 'appr',
  permit: 'pmt',
  execution: 'exe',
  connector: 'con',
  auditEvent: 'aev',
  outboxEvent: 'obx',
  run: 'run',
  simulation: 'sim',
  replay: 'rpl',
  modelEvaluation: 'mev',
  idempotency: 'idm',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

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
