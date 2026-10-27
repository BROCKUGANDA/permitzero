/**
 * Argument canonicalization and hashing.
 *
 * PRD FR-012 / Master Prompt §5.6: an approval and a permit bind to the *exact*
 * canonical argument hash. If two semantically identical payloads could produce
 * different bytes — or two different payloads the same bytes — the whole
 * approval-binding guarantee collapses. So canonicalization is deliberately
 * strict: it rejects ambiguity rather than silently normalizing it away.
 *
 * Rules:
 *  - Object keys sorted by UTF-16 code unit; duplicate keys impossible in a
 *    parsed JS object, so key order in the input is irrelevant.
 *  - `undefined` is rejected inside objects and arrays. Absence must be written
 *    as explicit `null` so that "field omitted" and "field null" cannot drift
 *    into different hashes for the same intent.
 *  - Numbers must be finite. Money is integer minor units (see money.ts); a
 *    float amount is rejected here too, because 0.1 + 0.2 !== 0.3 would let an
 *    approval bind to a value the connector never sees.
 *  - Strings are Unicode NFC-normalized so visually identical text hashes
 *    identically, while confusable *glyphs* remain distinct bytes — confusables
 *    are a policy/risk signal, not something canonicalization should erase.
 *  - Depth and node-count limits prevent a stack-overflow or memory DoS from a
 *    hostile payload (PRD FR-011: oversized payloads rejected).
 */
import { createHash } from 'node:crypto';

export const HASH_ALGORITHM = 'sha256';
export const HASH_VERSION = 'pz-canon-v1';

export const CANONICAL_MAX_DEPTH = 16;
export const CANONICAL_MAX_NODES = 4096;
export const CANONICAL_MAX_STRING_LENGTH = 8192;

export class CanonicalizationError extends Error {
  readonly code = 'CANONICALIZATION_FAILED';
  constructor(
    message: string,
    readonly path: string = '$',
  ) {
    super(`${message} (at ${path})`);
    this.name = 'CanonicalizationError';
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface CanonicalizeOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxStringLength?: number;
}

/**
 * Produce the canonical JSON string for a value. Throws CanonicalizationError on
 * any ambiguous or hostile input.
 */
export function canonicalize(value: unknown, options: CanonicalizeOptions = {}): string {
  const maxDepth = options.maxDepth ?? CANONICAL_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? CANONICAL_MAX_NODES;
  const maxStringLength = options.maxStringLength ?? CANONICAL_MAX_STRING_LENGTH;
  let nodes = 0;

  const walk = (node: unknown, path: string, depth: number): Json => {
    if (++nodes > maxNodes) {
      throw new CanonicalizationError(`payload exceeds ${maxNodes} nodes`, path);
    }
    if (depth > maxDepth) {
      throw new CanonicalizationError(`payload exceeds max depth ${maxDepth}`, path);
    }

    if (node === null) return null;

    const t = typeof node;

    if (t === 'boolean') return node as boolean;

    if (t === 'number') {
      const n = node as number;
      if (!Number.isFinite(n)) {
        throw new CanonicalizationError('non-finite number is not canonical', path);
      }
      // -0 must not hash differently from 0.
      return n === 0 ? 0 : n;
    }

    if (t === 'bigint') {
      // Accepted only when it is exactly representable; otherwise the caller must
      // send a string. Silently truncating would change the authorized amount.
      const bi = node as bigint;
      if (bi > BigInt(Number.MAX_SAFE_INTEGER) || bi < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new CanonicalizationError('bigint outside safe integer range', path);
      }
      return Number(bi);
    }

    if (t === 'string') {
      const s = node as string;
      if (s.length > maxStringLength) {
        throw new CanonicalizationError(`string exceeds ${maxStringLength} chars`, path);
      }
      // Reject lone surrogates: they are not valid Unicode scalar values and
      // different encoders serialize them differently.
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) {
            throw new CanonicalizationError('string contains a lone surrogate', path);
          }
          i++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          throw new CanonicalizationError('string contains a lone surrogate', path);
        }
      }
      return s.normalize('NFC');
    }

    if (t === 'undefined') {
      throw new CanonicalizationError('undefined is not canonical; use explicit null', path);
    }

    if (t === 'function' || t === 'symbol') {
      throw new CanonicalizationError(`${t} is not canonical`, path);
    }

    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    }

    if (node instanceof Date) {
      // Dates are canonicalized to their ISO-8601 UTC form so that two Date
      // objects denoting the same instant hash identically.
      const ms = node.getTime();
      if (Number.isNaN(ms)) {
        throw new CanonicalizationError('invalid Date', path);
      }
      return node.toISOString();
    }

    if (t !== 'object') {
      throw new CanonicalizationError(`unsupported type ${t}`, path);
    }

    const source = node as Record<string, unknown>;
    const out: Record<string, Json> = {};
    const keys = Object.keys(source).sort();
    for (const key of keys) {
      if (key.length === 0) {
        throw new CanonicalizationError('empty object key', path);
      }
      if (key.length > maxStringLength) {
        throw new CanonicalizationError('object key too long', path);
      }
      const child = source[key];
      if (child === undefined) {
        throw new CanonicalizationError(`property "${key}" is undefined; use explicit null`, path);
      }
      out[key.normalize('NFC')] = walk(child, `${path}.${key}`, depth + 1);
    }
    return out;
  };

  return stableStringify(walk(value, '$', 0));
}

/** Serialize an already-canonicalized value with sorted keys and no whitespace. */
function stableStringify(node: Json): string {
  if (node === null) return 'null';
  const t = typeof node;
  if (t === 'boolean') return node ? 'true' : 'false';
  if (t === 'number') return Object.is(node, -0) ? '0' : String(node);
  if (t === 'string') return JSON.stringify(node);
  if (Array.isArray(node)) {
    return `[${node.map(stableStringify).join(',')}]`;
  }
  const obj = node as Record<string, Json>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k] as Json)}`).join(',')}}`;
}

/**
 * Canonical hash of an action's authoritative inputs. The permit, the approval
 * and the execution-time re-check all compare against this exact string.
 *
 * Domain separation (`HASH_VERSION`) is part of the preimage so a future
 * canonicalization change cannot collide with hashes issued under the old one.
 */
export function canonicalHash(value: unknown, options: CanonicalizeOptions = {}): string {
  const canonical = canonicalize(value, options);
  const digest = createHash(HASH_ALGORITHM).update(`${HASH_VERSION}\n`).update(canonical).digest('hex');
  return `${HASH_ALGORITHM}:${digest}`;
}

/** The canonical string itself, for evidence display and replay debugging. */
export function canonicalString(value: unknown, options: CanonicalizeOptions = {}): string {
  return canonicalize(value, options);
}

export interface ActionHashInput {
  tenantId: string;
  agentId: string;
  runId: string;
  toolName: string;
  operation: string;
  arguments: unknown;
  environment: string;
}

/**
 * The action hash covers the fields an approver is actually authorizing. It
 * deliberately excludes the idempotency key and client request ID: resubmitting
 * the same intent under a new idempotency key must produce the *same* action
 * hash, so that an approval or permit cannot be laundered by changing only the
 * transport-level identifier.
 */
export function actionHash(input: ActionHashInput): string {
  return canonicalHash({
    agent_id: input.agentId,
    arguments: input.arguments,
    environment: input.environment,
    operation: input.operation,
    run_id: input.runId,
    tenant_id: input.tenantId,
    tool_name: input.toolName,
  });
}

/** Constant-time comparison of two hash strings. */
export function hashEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
