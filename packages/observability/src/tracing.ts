/**
 * W3C Trace Context propagation, without an SDK.
 *
 * Every consequential action in this system is already recorded in the audit
 * chain with a `trace_id`, so the question is only whether that identifier can
 * be tied to the caller's own distributed trace. The `traceparent` header is the
 * interchange format for that, and implementing it directly (rather than taking
 * on an exporter and a collector) means the correlation works with any
 * conforming tracer on either side, and nothing has to be running for it to be
 * true.
 *
 * A header from an untrusted agent is accepted as a *link*, not as authority:
 * the trace id is reused for correlation, but the sampled flag and the parent id
 * are ours to set. Parsing is strict and a malformed header is discarded rather
 * than repaired — a caller sending garbage should not be able to inject a
 * string that ends up in an audit payload or a log line.
 */

export interface TraceContext {
  traceId: string;
  parentId: string;
  /** 0/1 flags field, kept as the two hex characters that were sent. */
  flags: string;
}

const TRACE_VERSION = '00';
const TRACE_ID = /^[0-9a-f]{32}$/;
const PARENT_ID = /^[0-9a-f]{16}$/;
const FLAGS = /^[0-9a-f]{2}$/;
/** All-zero ids are invalid by spec and must not be propagated. */
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_PARENT_ID = '0'.repeat(16);

function hex(count: number): string {
  const bytes = new Uint8Array(count / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a fresh root context. Sampling is on: this service is the trace owner. */
export function newTraceContext(): TraceContext {
  return { traceId: hex(32), parentId: hex(16), flags: '01' };
}

/**
 * Parse an incoming `traceparent`, or return null when it is absent or invalid.
 *
 * The version is allowed to be higher than 00 (forward compatibility is part of
 * the spec) as long as the first three fields still parse, since a future
 * version may append fields we do not read.
 */
export function parseTraceparent(header: string | string[] | undefined | null): TraceContext | null {
  // A repeated header arrives as an array. Taking the first is what the HTTP
  // parsers do, but here it would mean a caller able to choose our trace id by
  // sending two, so an ambiguous header is discarded outright instead.
  if (typeof header !== 'string') return null;
  const parts = header.trim().split('-');
  if (parts.length < 4) return null;
  const [version, traceId, parentId, flags] = parts as [string, string, string, string];
  if (!/^[\da-f]{2}$/.test(version)) return null;
  if (!TRACE_ID.test(traceId) || traceId === INVALID_TRACE_ID) return null;
  if (!PARENT_ID.test(parentId) || parentId === INVALID_PARENT_ID) return null;
  if (!FLAGS.test(flags)) return null;
  return { traceId, parentId, flags };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `${TRACE_VERSION}-${ctx.traceId}-${ctx.parentId}-${ctx.flags}`;
}

/**
 * Continue a caller's trace with a new span id of ours. The trace id survives,
 * so the caller's spans and our audit events are one story; the parent id is
 * replaced because our span is not their span.
 */
export function childOf(incoming: TraceContext): TraceContext {
  return { traceId: incoming.traceId, parentId: hex(16), flags: incoming.flags };
}

export function isSampled(ctx: TraceContext): boolean {
  return (Number.parseInt(ctx.flags, 16) & 0x01) === 1;
}

/**
 * Decide the context for one inbound request.
 *
 * Reuses the caller's trace id when it is well formed, otherwise starts a root.
 * Either way the response carries a valid `traceparent`, so a downstream hop
 * never has to guess whether we participate.
 */
export function contextFromRequest(header: string | string[] | undefined | null): {
  ctx: TraceContext;
  propagated: boolean;
} {
  const incoming = parseTraceparent(header);
  if (incoming) return { ctx: childOf(incoming), propagated: true };
  return { ctx: newTraceContext(), propagated: false };
}
