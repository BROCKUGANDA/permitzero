# Load test — 2026-10-27T23:31:11.618Z

**Verdict: PASS.** Target `http://127.0.0.1:8080`, scenario `allow`,
10 concurrent clients for 30s against
`POST /v1/actions` with the model provider disabled (the deterministic path an
agent depends on when Meta is unreachable).

Reproduce with `npm run load:test`. This file is generated; do not hand-edit it.

## Result

| | value |
| --- | --- |
| Requests completed | 1590 (53 req/s) |
| Fresh policy decisions | 159 |
| Answered from the idempotent record | 1432 (90.01%) |
| Bytes/s on the wire | 87020.8 |
| Client latency p50 / p99 | 186 ms / 259 ms |
| Server decision p50 / p95 / p99 | 175 / 243 / 249 ms |
| Decisions recorded | 159 |
| HTTP status classes seen by the client | 200:1431 201:159 |
| Requests with no usable answer | 0 (0.00%) — 0 socket errors/timeouts, 0 pipeline resets |

Client latency includes the load generator's own scheduling on the same host; the
server percentiles are the API's own histogram. Where the two disagree, the
generator is the reason, not the decision engine.

Availability is asserted twice on purpose. The server rate counts 5xx it actually
returned; the client rate counts requests that produced no usable answer at all.
A saturated pool shows up only in the second: the request is accepted, queued behind a
pooled transaction, and the generator gives up before the server has anything to
record. `RUNTIME_POOL_MAX` is therefore part of the workload description, not a
deployment detail — and `npm run load:sweep` measures what the ceiling actually is
rather than assuming the pool owns it.

Server percentiles come from the API histogram scraped before/after, so they exclude load-generator scheduling. They are cumulative since process start, which is why the deltas of the counters are reported alongside.

## Checks

- ✅ **load actually reached the server** — `{"requests":1590}`
- ✅ **the server was reachable and scraped** — `{"scrapedBefore":true,"scrapedAfter":true,"metricsTokenConfigured":true}`
- ✅ **the server recorded the decisions it made** — `{"decisionsDelta":159,"histogramCount":326}`
- ✅ **decision p99 within the 1500ms objective** — `{"serverP99Ms":249,"clientP99Ms":259,"fallbackUsed":false,"objective":0.99}`
- ✅ **server-observed availability held under load** — `{"serverErrorRate":0,"objective":0.999}`
- ✅ **client-observed availability held under load** — `{"clientFailureRate":0,"clientFailures":0,"objective":0.999,"connectionErrorsAndTimeouts":0,"ofWhichTimeouts":0,"pipelineResets":0,"expectationMismatches":0,"statusCodes":{"200":1431,"201":159}}`
- ✅ **the server answered every request it accepted without a 5xx** — `{"server5xx":0,"runtimePoolMax":"10"}`
- ✅ **the run measured the engine, not the rate limiter** — `{"throttled":0,"requestsSeen":1591,"rateLimitMax":"(default 500/min)"}`

## Query plans under load

`EXPLAIN (ANALYZE, BUFFERS)` for the four statements this path and its immediate
consumers depend on. Recorded so an index regression is visible as a plan change
rather than as a vague feeling that it got slower.

| statement | node | index | actual ms | rows |
| --- | --- | --- | --- | --- |
| actions by tenant + state (approval queue) | error | — | — | — |
| actions by tenant + time (list page) | error | — | — | — |
| audit by tenant + time (evidence page) | error | — | — | — |
| outbox claim (dispatcher tick) | error | — | — | — |

## Reading the two rates

fresh decisions are the ones that evaluated policy; the remainder answered 200 from the completed idempotency record. autocannon replays its request list from the start on every
connection, so the ratio of fresh decisions to completed requests tracks the
connection count rather than the workload. The latency objective is evaluated on
the server's decision histogram, which only fresh decisions enter.

## What this does not measure

- Single host, single region, one Postgres. No failover timing, no cross-region
  write skew, no storage-level replication lag.
- Model provider disabled, so Meta's latency variance is excluded by construction.
  `pz_model_latency_seconds` carries it separately when a key is configured.
- A benchmark run is not a capacity claim for a deployment: connection ceilings,
  disk and the size of the approval queue all move the numbers. The thresholds
  asserted here are the SLOs, so a pass means "within objective on this rig".
