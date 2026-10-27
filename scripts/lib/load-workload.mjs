/**
 * The intake workload both load scripts send, in one place.
 *
 * A benchmark is only comparable across runs if the request it generates is the
 * same in every run, so the body shape, the credential lookup and the scraping
 * live here rather than being written twice — the second copy of this logic in
 * `load-test.mjs` was a live risk of the two scripts measuring different things
 * while both calling it "the intake path".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseExposition, sumBy } from '../../packages/observability/src/index.js';

export function loadCredentials(root) {
  const file = path.join(root, 'storage', 'demo-credentials.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const agentId = data.agentIds?.[0];
  const token = agentId ? data.agentTokens?.[agentId] : undefined;
  if (!agentId || !token) throw new Error('storage/demo-credentials.json has no agent token; run npm run db:seed');
  return { agentId, token, tenantId: data.tenantIds?.[0] };
}

/** A single intake request. `i` only seeds the idempotency key. */
export function intakeBody(agentId, i, { scenario = 'allow', amountMinor = 300000 } = {}) {
  return JSON.stringify({
    agent_id: agentId,
    run_id: `load_${scenario}`,
    task_purpose: scenario === 'deny' ? 'Pay far more than any policy allows' : 'Pay a verified invoice',
    tool_name: 'payment.execute',
    arguments: {
      invoice_id: 'INV-2041',
      vendor_id: 'VEN-017',
      amount_minor: amountMinor,
      currency: 'USD',
      beneficiary_ref: 'BEN-017-VERIFIED',
    },
    evidence_refs: [],
    // A distinct key per request. Reusing one would make the run a measurement of
    // idempotent replay (a much cheaper path that evaluates no policy at all)
    // rather than of decision throughput.
    idempotency_key: `load-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 10)}`,
    environment: 'DEMO',
  });
}

/**
 * autocannon cycles a fixed `requests` array, so the keys have to be generated up
 * front. Its `setupClient` hook runs once per connection, which would send the
 * same key repeatedly on that connection.
 */
export function buildRequestPool({ agentId, token, scenario, amountMinor, size }) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return Array.from({ length: size }, (_, i) => ({
    method: 'POST',
    path: '/v1/actions',
    headers,
    body: intakeBody(agentId, i, { scenario, amountMinor }),
  }));
}

/** The exposition the server itself reports, or null when it cannot be reached. */
export async function scrapeMetrics(baseUrl, token) {
  if (!token) return null;
  try {
    const res = await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return parseExposition(await res.text());
  } catch {
    return null;
  }
}

/** Sum a counter across matching series; an absent series is zero, because a
 * freshly started process legitimately has no traffic and "unknown" would make
 * the first measurement after a boot impossible. */
export function counterAt(metrics, name, filter) {
  const v = sumBy(metrics, name, filter);
  return v === null ? 0 : v;
}

/**
 * Delta of a monotonic counter between two scrapes.
 *
 * `absentAsZero` matters for a per-status-class series: a run with no 5xx at all
 * legitimately has no `{status_class="5xx"}` series, and reporting that as unknown
 * would fail every clean benchmark. For a series that must exist (the request
 * counter, the decision counter) leaving it false keeps "could not measure"
 * separate from "measured zero".
 */
export function counterDelta(before, after, name, filter, { absentAsZero = false } = {}) {
  if (!before || !after) return null;
  const a = absentAsZero ? counterAt(before, name, filter) : sumBy(before, name, filter);
  const b = absentAsZero ? counterAt(after, name, filter) : sumBy(after, name, filter);
  if (a === null || b === null) return null;
  return b < a ? null : b - a;
}
