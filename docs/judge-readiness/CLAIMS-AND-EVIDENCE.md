# PermitZero — Claims and Evidence

Every major README statement mapped to implementation path, test path, verification
command, evidence status, and limitations. "Verified" means reproduced in this
session or cited with a real file/line that was inspected. Claims not verified are
labeled.

## 1. Claim: Tenant isolation is the database's job

- Claim: 22/22 tenant-bearing tables RLS-enabled, forced, policy-covered for a
  non-exempt role; cross-tenant read with no tenant context returns zero rows.
- Implementation path: `infra/migrations/0006_row_level_security.sql`,
  `packages/db/src/tenant.ts`, `packages/db/src/stores.ts`.
- Test path: `packages/db/test/rls.test.ts`, `apps/api/test/tenant-isolation.test.ts`.
- Verification command: `npm test` (DB-required); `npm run compliance:gate`.
- Evidence status: Verified (code + tests inspected; control map marks implemented).
- Limitations: Requires running as `pz_app` role; verified on the deployed instance
  per `EVIDENCE.md`, not re-verified in this sandbox.

## 2. Claim: Deployment verifies isolation from the database

- Claim: After rollout, a query as the runtime role with no tenant context must
  return zero rows; deploy fails otherwise.
- Implementation path: `infra/deploy/deploy-vps.sh`.
- Test path: `packages/db/test/rls.test.ts`.
- Verification command: deploy workflow (not run in this session).
- Evidence status: Documented but not independently reproduced in this session.
- Limitations: Deployment not verified here (no deployment revision available).

## 3. Claim: Blind escape hatch cannot write

- Claim: Migration 0007 narrows `users` to SELECT; `outbox_events` allows SELECT +
  UPDATE of three claim columns only, confined by trigger.
- Implementation path: `infra/migrations/0007_rls_write_scope.sql`.
- Test path: `packages/db/test/rls.test.ts`.
- Verification command: `npm test` (DB-required).
- Evidence status: Verified by inspection of migration + control map.
- Limitations: None stated.

## 4. Claim: Decisions are tamper-evident

- Claim: Every event hashes canonical payload + previous hash; 10 concurrent writers
  on one tenant finish gapless and chain verifies.
- Implementation path: `packages/db` audit store, `verifyAuditChain`.
- Test path: `packages/db/test/audit-concurrency.test.ts`.
- Verification command: `npm test` (DB-required).
- Evidence status: Verified by test name + control map.
- Limitations: Not run in this session (Postgres unavailable).

## 5. Claim: Human cannot approve their own action

- Claim: Approval by requesting actor refused at decision point and excluded from
  quorum's distinct-approver count.
- Implementation path: `apps/api/src/approvals.ts`.
- Test path: `apps/api/test/approvals.test.ts`.
- Verification command: `npm test` (DB-required).
- Evidence status: Verified by inspection.
- Limitations: Not run in this session.

## 6. Claim: Throughput and latency

- Claim: 1,590 requests, 159 fresh policy decisions, server decision p99 249 ms,
  0 5xx, 0 client failures at 10 concurrent clients.
- Implementation path: `docs/benchmarks/RESULTS.md`, `scripts/load-test.mjs`.
- Test path: n/a (benchmark, not unit test).
- Verification command: `npm run load:test` (requires running stack).
- Evidence status: Historical/environment-specific (not reproduced in this session).
- Limitations: Depends on hardware/methodology; see `docs/benchmarks/RESULTS.md`
  and `BENCHMARK REPRODUCIBILITY` (Phase 8). Single-tenant audit chain caps
  throughput (~46–63 req/s).

## 7. Claim: Where the ceiling actually is

- Claim: ~46–63 req/s on one tenant, flat as runtime pool doubles (2.6%).
- Implementation path: `docs/benchmarks/SCALING.md`, `scripts/load-sweep.mjs`.
- Test path: n/a.
- Verification command: `npm run load:sweep`.
- Evidence status: Historical/environment-specific.
- Limitations: Per-tenant chain serialization by design; remedy (partitioning) not built.

## 8. Claim: Objectives that can fail (SLOs)

- Claim: Multi-window, multi-burn-rate SLOs with histogram bucket at threshold;
  report exits non-zero when breached or when it measured nothing.
- Implementation path: `packages/observability/src/slos.ts`.
- Test path: `packages/observability/test`.
- Verification command: `npm run slo:report:strict`.
- Evidence status: Code inspected; report not run in this session (requires live stack).
- Limitations: None stated.

## 9. Claim: Alerts can actually fire

- Claim: Three previously-declared-never-written series now produced; delivery-lag
  gauge measures the outbox row, not the queue job.
- Implementation path: `apps/api/src/observability.ts`.
- Test path: `packages/observability/test`.
- Verification command: `npm test`.
- Evidence status: Code inspected.
- Limitations: None stated.

## 10. Claim: Survives provider/queue outage

- Claim: Resilience drill asserts readiness 503, decision 503 not 500, no driver
  detail leak, no half-written action, retained owed outbox event, no double-claim.
- Implementation path: `scripts/resilience-drill.ts`.
- Test path: `apps/api/test/resilience.test.ts`.
- Verification command: `npm run drill:resilience`.
- Evidence status: Not run in this session (requires live stack).
- Limitations: None stated.

## 11. Claim: Nothing unproven is claimed

- Claim: 31 controls mapped to code and tests: 28 implemented, 1 partial, 2 absent.
- Implementation path: `docs/compliance/EVIDENCE.md`.
- Test path: `npm run compliance:gate`.
- Verification command: `npm run compliance:gate`.
- Evidence status: Verified by inspection of control map.
- Limitations: Not certified; evidence mapping only.

## 12. Claim: Test surface

- Claim: 606 tests across 47 files; typecheck, lint, format, gitleaks, dependency
  gate, evidence-map gate, resilience drill, strict SLO wired into `npm run verify`
  and CI.
- Implementation path: `vitest.config.ts`, `.github/workflows/ci.yml`,
  `scripts/verify.mjs`.
- Test path: all `*.test.ts`.
- Verification command: `npm run verify -- --strict`.
- Evidence status: Typecheck + lint verified this session; full suite DB-dependent.
- Limitations: 96 DB-dependent tests could not run (Postgres unavailable).

## 13. Claim: Meta model is advisory only

- Claim: Model never issues permits, publishes policy, grants approvals, or invokes
  connectors; structural via `MODEL_FIELD_IN_ALLOW_RULE`.
- Implementation path: `packages/policy/src/lint.ts`, `packages/provider-meta/`,
  `apps/api/src/model.ts`.
- Test path: `packages/policy/test/policy.test.ts`, `apps/api/test/model.test.ts`,
  `packages/provider-meta/test`.
- Verification command: `npm test` (DB-independent parts pass).
- Evidence status: Verified (136 DB-independent tests pass this session).
- Limitations: Live Meta calls require `MODEL_PROVIDER=meta` + credentials; not
  exercised in default demo.

## 14. README claims corrected/qualified in this exercise

- CI results: not labeled passing unless workflow run + commit SHA verified. Baseline
  records CI as "documented but not independently reproduced."
- Deployment revision: none available; deployed-API claims refer to a maintainer-operated
  deployment not independently verified.
- Benchmarks: labeled historical/environment-specific unless reproduced.
- Compliance: explicitly "not a certification."
- Multi-region failover and independent third-party review: marked `absent`, not hidden.