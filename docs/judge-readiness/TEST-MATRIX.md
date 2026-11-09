# PermitZero — Test Matrix

47 test files, 606 tests (per README §1 claim). Categories, commands, and where to
find coverage. DB-dependent files require PostgreSQL; they fail with
`ECONNREFUSED 127.0.0.1:5432` without it.

## 1. Commands

| Command | Scope |
| --- | --- |
| `npm test` | All workspaces (Vitest) |
| `npm run typecheck` | All workspaces (`tsc --noEmit`) |
| `npm run lint` | ESLint, `--max-warnings=0` |
| `npm run verify` / `npm run verify -- --strict` | Release gate (typecheck, lint, tests, build, format, gitleaks, dependency gate, evidence-map gate, resilience drill, strict SLO) |
| `npm run secret:scan` | gitleaks |
| `npm run audit:gate` | Evidence map gate |
| `npm run compliance:gate` | Control evidence gate |
| `npm run drill:resilience` | Resilience drill |
| `npm run slo:report:strict` | Strict SLO report |
| `npm run test:e2e` | Playwright (web) |

## 2. Category → test files

### Domain / schemas (DB-independent)
- `packages/domain/test/domain.test.ts`
- `packages/schemas` (covered via consumers; schema tests in policy/provider-meta)

### Policy (DB-independent)
- `packages/policy/test/policy.test.ts` — deny precedence, default deny, amount boundaries, velocity, budget, vendor suspension, PO mismatch, missing evidence, model hints, `MODEL_FIELD_IN_ALLOW_RULE` lint.

### Provider-meta / Meta model (DB-independent)
- `packages/provider-meta/test/client.test.ts`
- `packages/provider-meta/test/config.test.ts`
- `packages/provider-meta/test/prompt.test.ts`
- `apps/api/test/model.test.ts`

### Broker / permits / connector
- `packages/broker/test/broker.test.ts`
- `packages/broker/test/connector.test.ts`
- `packages/broker/test/permits.test.ts`

### Database / RLS / audit / outbox (DB-required)
- `packages/db/test/rls.test.ts`
- `packages/db/test/audit-concurrency.test.ts` (10 concurrent writers, gapless)
- `packages/db/test/outbox-concurrency.test.ts`
- `packages/db/test/repos.test.ts`
- `packages/db/test/execution-stores.test.ts`
- `packages/db/test/seed.test.ts`
- `packages/db/test/schema-parity.test.ts`
- `packages/db/test/encryption.test.ts`
- `packages/db/test/rotation.test.ts`
- `packages/db/test/root-env.test.ts`

### Queue / worker
- `packages/queue/test/dispatcher.test.ts`
- `packages/queue/test/dispatcher-resilience.test.ts`
- `packages/queue/test/dlq-durability.test.ts`
- `apps/worker/test/lifecycle.test.ts`
- `apps/worker/test/reconcile.test.ts`
- `apps/worker/test/retention.test.ts`
- `apps/worker/test/router.test.ts`
- `apps/worker/test/sweeps.test.ts`

### API intake / approvals / execution / security (DB-required)
- `apps/api/test/intake.test.ts`
- `apps/api/test/approvals.test.ts`
- `apps/api/test/execute.test.ts`
- `apps/api/test/auth.test.ts`
- `apps/api/test/tenant-isolation.test.ts`
- `apps/api/test/security.test.ts`
- `apps/api/test/rate-limit.test.ts`
- `apps/api/test/resilience.test.ts`
- `apps/api/test/health.test.ts`
- `apps/api/test/logging.test.ts`
- `apps/api/test/observability.test.ts`
- `apps/api/test/alerts.test.ts`
- `apps/api/test/mfa-step-up.test.ts`
- `apps/api/test/shutdown.test.ts`

### Observability
- `packages/observability/test/observability.test.ts`
- `packages/observability/test/alert-rules.test.ts`
- `packages/observability/test/dashboard.test.ts`
- `packages/observability/test/exposition.test.ts`
- `packages/observability/test/tracing.test.ts`

### Test fixtures
- `packages/test-fixtures/test/corpus.test.ts`

## 3. Coverage highlights

- Tenant isolation: DB RLS + API cross-tenant tests.
- Audit chain: concurrency test (10 writers, gapless, verifies).
- Permit security: expiry, replay, hash mismatch, audience/tenant/action/revision, revocation, concurrent consumption.
- Model: valid/invalid/missing/unexpected fields, evidence refs, amount/currency, prompt injection, unavailable, timeout, rate limit, semantically unsafe.
- Approvals: self-approval refusal, quorum, binding to hash + revision.

## 4. Environment dependency

- DB-independent suites (domain, policy, provider-meta, schemas): pass without Postgres (136 tests verified this session).
- DB-dependent suites: require PostgreSQL 17 + Redis; fail with `ECONNREFUSED` without them.

## 5. Gaps (honest)

- No independent third-party test review.
- Playwright e2e not run in this session (requires running stack).
- Resilience drill / SLO strict report not run in this session (require live stack).