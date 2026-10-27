/**
 * Exposition parsing, with the emphasis on the failures that are invisible.
 *
 * A parser that returns empty label values still sums correctly when you do not
 * filter. Every unfiltered number in a report looks fine, and every filtered one
 * is zero — which reads as "no such events happened" rather than "the parser is
 * broken". That is precisely how a load run of 51,000 rate-limited requests
 * reported `throttled: 0` and passed its own guard, so the filtered path is
 * asserted directly instead of being inferred from the totals.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketCountAtOrBelow,
  histogramCount,
  histogramQuantile,
  parseExposition,
  parseLabels,
  sumBy,
} from '../src/index.js';

const SAMPLE = [
  '# HELP pz_http_requests_total Requests answered.',
  '# TYPE pz_http_requests_total counter',
  'pz_http_requests_total{route="/v1/actions",method="POST",status_class="2xx",service="pz"} 108',
  'pz_http_requests_total{route="/v1/actions",method="POST",status_class="4xx",service="pz"} 51529',
  'pz_http_requests_total{route="unmatched",method="GET",status_class="4xx",service="pz"} 7',
  '# TYPE pz_decision_duration_seconds histogram',
  'pz_decision_duration_seconds_bucket{le="0.5",decision="ALLOW"} 40',
  'pz_decision_duration_seconds_bucket{le="1.5",decision="ALLOW"} 58',
  'pz_decision_duration_seconds_bucket{le="2.5",decision="ALLOW"} 60',
  'pz_decision_duration_seconds_bucket{le="+Inf",decision="ALLOW"} 60',
  'pz_decision_duration_seconds_sum{decision="ALLOW"} 21.5',
  'pz_decision_duration_seconds_count{decision="ALLOW"} 60',
  'pz_tenant_isolation_enforced{role="pz_app"} 1',
  'bare_gauge 42',
].join('\n');

describe('parseLabels', () => {
  it('extracts every label with its value intact', () => {
    expect(parseLabels('route="/v1/actions",method="POST",status_class="2xx"')).toEqual({
      route: '/v1/actions',
      method: 'POST',
      status_class: '2xx',
    });
  });

  it('is the thing that keeps a filtered sum from being silently zero', () => {
    // The regression this file exists for: an opening quote consumed as the
    // closing one produced `{route:'', method:''}`, totals that still added up,
    // and filters that matched nothing.
    const parsed = parseLabels('status_class="4xx"');
    expect(parsed.status_class).toBe('4xx');
    expect(parsed.status_class).not.toBe('');
    expect(Object.values(parsed).every((v) => v.length > 0)).toBe(true);
  });

  it('keeps commas and escaped quotes inside a value', () => {
    expect(parseLabels('reason="A,B",code="X\\"Y"')).toEqual({ reason: 'A,B', code: 'X"Y' });
  });

  it('handles an escaped newline and a single label', () => {
    expect(parseLabels('a="1"')).toEqual({ a: '1' });
    expect(parseLabels('note="line\\nnext"')).toEqual({ note: 'line\nnext' });
  });
});

describe('parseExposition', () => {
  const metrics = parseExposition(SAMPLE);

  it('reads types, and keeps untyped and label-less lines', () => {
    expect(metrics.get('pz_http_requests_total')?.type).toBe('counter');
    expect(sumBy(metrics, 'bare_gauge')).toBe(42);
  });

  it('sums unfiltered correctly AND separates status classes when filtered', () => {
    expect(sumBy(metrics, 'pz_http_requests_total')).toBe(108 + 51529 + 7);
    expect(sumBy(metrics, 'pz_http_requests_total', { status_class: '4xx' })).toBe(51529 + 7);
    expect(sumBy(metrics, 'pz_http_requests_total', { status_class: '2xx' })).toBe(108);
    expect(sumBy(metrics, 'pz_http_requests_total', { status_class: '5xx' })).toBe(0);
  });

  it('distinguishes "absent" from "zero", because the report depends on it', () => {
    expect(sumBy(metrics, 'pz_http_requests_total', { status_class: '5xx' })).toBe(0);
    expect(sumBy(metrics, 'no_such_metric')).toBeNull();
  });

  it('filters on more than one label', () => {
    expect(sumBy(metrics, 'pz_http_requests_total', { route: '/v1/actions', status_class: '4xx' })).toBe(51529);
  });

  it('reads histogram counts and buckets at a boundary', () => {
    expect(histogramCount(metrics, 'pz_decision_duration_seconds')).toBe(60);
    expect(bucketCountAtOrBelow(metrics, 'pz_decision_duration_seconds', 1.5)).toBe(58);
    // `+Inf` must not be counted as "at or below 1.5" even though it is a bucket.
    expect(bucketCountAtOrBelow(metrics, 'pz_decision_duration_seconds', 1e9)).toBe(60);
  });

  it('interpolates a quantile inside the bucket it lands in', () => {
    // 60 observations: p99 is the 59.4th, which falls in the (1.5, 2.5] bucket
    // holding 2 samples — so it is above 1.5, not clamped to the bucket edge.
    const p99 = histogramQuantile(metrics, 'pz_decision_duration_seconds', 0.99);
    expect(p99).not.toBeNull();
    expect(p99 as number).toBeGreaterThan(1.5);
    expect(p99 as number).toBeLessThanOrEqual(2.5);
    expect(histogramQuantile(metrics, 'pz_decision_duration_seconds', 0.5)).toBeLessThanOrEqual(0.5);
  });

  it('returns null rather than zero for a histogram that does not exist', () => {
    expect(histogramQuantile(metrics, 'pz_nonexistent_seconds', 0.99)).toBeNull();
    expect(histogramCount(metrics, 'pz_nonexistent_seconds')).toBeNull();
    expect(bucketCountAtOrBelow(metrics, 'pz_nonexistent_seconds', 1)).toBeNull();
  });

  it('is not confused by the comment lines that precede a metric', () => {
    // `# TYPE x histogram` must not create a sample named 'histogram'.
    expect(metrics.has('histogram')).toBe(false);
    expect(metrics.get('pz_tenant_isolation_enforced')?.samples[0]?.labels.role).toBe('pz_app');
  });
});
