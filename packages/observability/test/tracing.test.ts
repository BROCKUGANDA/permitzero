import { describe, expect, it } from 'vitest';
import {
  childOf,
  contextFromRequest,
  formatTraceparent,
  isSampled,
  newTraceContext,
  parseTraceparent,
} from '../src/index.js';

const VALID = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const NOT_SAMPLED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00';

describe('traceparent parsing', () => {
  it('accepts a conforming header and keeps the trace id', () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentId: 'b7ad6b7169203331',
      flags: '01',
    });
  });

  it('tolerates surrounding whitespace, which HTTP clients emit', () => {
    expect(parseTraceparent(`  ${VALID}  `)).not.toBeNull();
  });

  it('accepts a higher version rather than dropping the caller’s trace', () => {
    // Forward compatibility is in the spec: fields may be appended, and refusing
    // a version we have not seen would silently orphan every request from a
    // newer tracer.
    expect(parseTraceparent(`01-${'0af7651916cd43dd8448eb211c80319c'}-b7ad6b7169203331-01`)).not.toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['no dashes', 'garbage'],
    ['too few fields', '00-0af7651916cd43dd8448eb211c80319c'],
    ['non-hex version', 'zz-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'],
    ['short trace id', '00-0af7651916cd43dd8448eb211c8-b7ad6b7169203331-01'],
    ['long trace id', `00-${'0af7651916cd43dd8448eb211c80319c' + 'f'}-b7ad6b7169203331-01`],
    ['all-zero trace id (invalid by spec)', '00-00000000000000000000000000000000-b7ad6b7169203331-01'],
    ['all-zero parent id (invalid by spec)', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'],
    ['non-hex flags', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-gg'],
    ['sql-ish injection attempt', "00-'; DROP TABLE audit_events;-- -b7ad6b7169203331-01"],
    ['uppercase (not canonical hex)', '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01'],
  ])('rejects a %s header instead of repairing it', (_label, value) => {
    expect(parseTraceparent(value as string | undefined)).toBeNull();
  });

  it('rejects a repeated header rather than letting the caller choose the trace id', () => {
    // Two headers means two candidate trace ids. Picking the first would be an
    // arbitrary tie-break that a client can exploit to steer correlation.
    expect(parseTraceparent([VALID, VALID] as unknown as string)).toBeNull();
  });
});

describe('context derivation', () => {
  it('generated ids are the right shape and sampling is on', () => {
    const ctx = newTraceContext();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.parentId).toMatch(/^[0-9a-f]{16}$/);
    expect(isSampled(ctx)).toBe(true);
  });

  it('does not reuse the same id twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newTraceContext().traceId));
    expect(seen.size).toBe(500);
  });

  it('round-trips through the wire format', () => {
    const ctx = newTraceContext();
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
  });

  it('keeps the caller trace id and replaces the parent span id', () => {
    const incoming = parseTraceparent(VALID)!;
    const child = childOf(incoming);
    expect(child.traceId).toBe(incoming.traceId);
    expect(child.parentId).not.toBe(incoming.parentId);
    expect(child.parentId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('preserves the caller sampling decision rather than forcing it', () => {
    const incoming = parseTraceparent(NOT_SAMPLED)!;
    expect(isSampled(childOf(incoming))).toBe(false);
  });

  it('starts a root when the header is missing or unusable', () => {
    for (const header of [undefined, 'nonsense', '00-zz']) {
      const { ctx, propagated } = contextFromRequest(header);
      expect(propagated).toBe(false);
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('reports propagation only for a header it actually honoured', () => {
    expect(contextFromRequest(VALID).propagated).toBe(true);
  });
});
