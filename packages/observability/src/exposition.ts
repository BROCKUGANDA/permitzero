/**
 * Prometheus text exposition, parsed.
 *
 * Small on purpose, and deliberately not a dependency: both the SLO report and
 * the load harness need counters, gauges and histograms, and a release-evidence
 * script that needs a package install to run is a script that does not run on the
 * day it is needed.
 *
 * The one subtlety worth a comment is label values containing commas or escaped
 * quotes — splitting the label set on `,` naively corrupts a value like
 * `reason="A,B"`, which is a real shape in this project's reason codes.
 */

export interface Sample {
  labels: Record<string, string>;
  value: number;
}

export interface Metric {
  type: string;
  samples: Sample[];
}

export type Exposition = Map<string, Metric>;

export function parseExposition(text: string): Exposition {
  const metrics: Exposition = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // `# TYPE <name> <type>` split on whitespace yields ['#','TYPE',name,type] —
      // matching on a '# TYPE' element never happened, so metric types were
      // silently never recorded and every entry stayed 'untyped'.
      const parts = line.split(/\s+/);
      if (parts[1] === 'TYPE' && parts[2]) ensure(metrics, parts[2]).type = parts[3] ?? 'untyped';
      continue;
    }
    const braceStart = line.indexOf('{');
    let name: string | undefined;
    let labels: Record<string, string> = {};
    let valueText: string | undefined;
    if (braceStart === -1) {
      const parts = line.split(/\s+/);
      name = parts[0];
      valueText = parts[1];
    } else {
      name = line.slice(0, braceStart);
      const braceEnd = line.lastIndexOf('}');
      labels = parseLabels(line.slice(braceStart + 1, braceEnd));
      valueText = line
        .slice(braceEnd + 1)
        .trim()
        .split(/\s+/)[0];
    }
    const value = Number(valueText);
    if (!name || !Number.isFinite(value)) continue;
    ensure(metrics, name).samples.push({ labels, value });
  }
  return metrics;
}

function ensure(map: Exposition, name: string): Metric {
  if (!map.has(name)) map.set(name, { type: 'untyped', samples: [] });
  return map.get(name) as Metric;
}

/**
 * `k="v"` pairs.
 *
 * Two subtleties, both of which the first version got wrong:
 *
 *   · the opening `"` is not the closing one. Committing on the first quote seen
 *     after `=` yields an empty value for every label, and an empty label is not
 *     visibly broken — an unfiltered sum over those samples is still exactly
 *     right, while any query that filters on `status_class="4xx"` silently matches
 *     nothing. That is how a load run of 51,000 rate-limited requests reported
 *     "throttled: 0" and passed its own capacity check.
 *   · values may contain commas and escaped quotes (reason codes and route
 *     patterns both do in this project), so splitting on `,` is not enough.
 */
export function parseLabels(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = '';
  let value = '';
  let i = 0;
  while (i < body.length) {
    // key
    while (i < body.length && body[i] !== '=' && body[i] !== ',') {
      if (body[i] !== ' ') key += body[i];
      i++;
    }
    if (i >= body.length) break;
    if (body[i] === ',') {
      key = '';
      i++;
      continue;
    }
    i++; // consume '='
    // value: must be quoted
    while (i < body.length && body[i] === ' ') i++;
    if (body[i] !== '"') {
      // Unquoted tail (`# TYPE`-style leftovers); stop rather than mis-assign.
      break;
    }
    i++; // consume the OPENING quote
    value = '';
    let closed = false;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '\\' && i + 1 < body.length) {
        const next = body[i + 1];
        value += next === 'n' ? '\n' : next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        i++;
        break;
      }
      value += ch;
      i++;
    }
    if (!closed) break;
    if (key) out[key] = value;
    key = '';
    value = '';
    while (i < body.length && (body[i] === ',' || body[i] === ' ')) i++;
  }
  return out;
}

export type LabelFilter = Record<string, string>;

function matches(labels: Record<string, string>, filter?: LabelFilter): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => labels[k] === v);
}

/** Sum of a metric's samples, or null when the series is absent. Null is not 0. */
export function sumBy(metrics: Exposition, name: string, filter?: LabelFilter): number | null {
  const entry = metrics.get(name);
  if (!entry) return null;
  return entry.samples.filter((s) => matches(s.labels, filter)).reduce((acc, s) => acc + s.value, 0);
}

/**
 * Count of observations at or below `le`, or null if there is no bucket series.
 *
 * Prometheus histogram buckets are CUMULATIVE: `le="1.5"` already contains every
 * observation that also falls in `le="0.5"`. Summing the buckets at or below the
 * target therefore double-counts — and does so in a way that flatters a latency
 * objective, because the inflated "within threshold" count makes
 * `count - within` go negative, which callers clamp to zero violations. This
 * function had that bug; the p99 interpolation below reads a single bucket and so
 * was not affected.
 *
 * The correct read is the value of the narrowest bucket whose upper bound is at
 * least the target, falling back to `+Inf`.
 */
export function bucketCountAtOrBelow(
  metrics: Exposition,
  baseName: string,
  le: number,
  filter?: LabelFilter,
): number | null {
  const samples = (metrics.get(`${baseName}_bucket`)?.samples ?? []).filter((s) => matches(s.labels, filter));
  if (samples.length === 0) return null;
  const buckets: Array<{ le: number; count: number }> = [];
  let inf: number | undefined;
  for (const s of samples) {
    const raw = s.labels.le;
    if (raw === undefined) continue;
    if (raw === '+Inf') {
      inf = s.value;
      continue;
    }
    buckets.push({ le: Number(raw), count: s.value });
  }
  // Sum per label set when several series share the bucket name (one per
  // decision, say); each series is cumulative on its own.
  if (buckets.length === 0) return inf ?? null;
  const byLe = new Map<number, number>();
  for (const b of buckets) byLe.set(b.le, (byLe.get(b.le) ?? 0) + b.count);
  const sorted = [...byLe.entries()].sort((a, b) => a[0] - b[0]);
  for (const [upper, count] of sorted) {
    if (upper >= le) return count;
  }
  // Target above every finite bucket: the total is `+Inf` when present.
  return inf ?? sorted[sorted.length - 1]?.[1] ?? null;
}

/** Observation count for a histogram, or null when the series is absent. */
export function histogramCount(metrics: Exposition, baseName: string, filter?: LabelFilter): number | null {
  return sumBy(metrics, `${baseName}_count`, filter);
}

/** p-quantile by linear interpolation inside the bucket the quantile lands in. */
export function histogramQuantile(
  metrics: Exposition,
  baseName: string,
  quantile: number,
  filter?: LabelFilter,
): number | null {
  const samples = (metrics.get(`${baseName}_bucket`)?.samples ?? []).filter((s) => matches(s.labels, filter));
  if (samples.length === 0) return null;
  const byLe = new Map<number, number>();
  for (const s of samples) {
    const le = s.labels.le;
    if (le === undefined) continue;
    const key = le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le);
    byLe.set(key, (byLe.get(key) ?? 0) + s.value);
  }
  const total = byLe.get(Number.POSITIVE_INFINITY);
  if (!total) return null;
  const ascending = [...byLe.entries()].filter(([k]) => Number.isFinite(k)).sort((a, b) => a[0] - b[0]);
  const target = quantile * total;
  let lower = 0;
  let lowerCount = 0;
  for (const [upper, count] of ascending) {
    if (count >= target) {
      const span = count - lowerCount;
      return span <= 0 ? upper : lower + ((upper - lower) * (target - lowerCount)) / span;
    }
    lower = upper;
    lowerCount = count;
  }
  return ascending.length ? (ascending[ascending.length - 1]?.[0] ?? null) : null;
}

/**
 * Sum of a monotonic counter across matching series, as a delta between two
 * scrapes. Counters only ever rise, so a decrease means the process restarted
 * mid-measurement and the delta would be a lie — reported as null instead.
 */
export function counterDelta(before: Exposition, after: Exposition, name: string, filter?: LabelFilter): number | null {
  const a = sumBy(before, name, filter);
  const b = sumBy(after, name, filter);
  if (a === null || b === null) return null;
  return b < a ? null : b - a;
}
