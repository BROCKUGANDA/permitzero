# PermitZero — Architecture

Judge-facing architecture summary. Source of truth for deeper detail:
`README.md` §2, `docs/module-contracts.md`, `docs/compliance/EVIDENCE.md`.

---

## 1. What it is

PermitZero is a runtime authorization and transaction-control plane for agentic AI.
It sits between an AI agent and side-effecting connectors (ERP/AP, vendor master
data, simulated finance) and enforces, before dispatch: tenant/identity/tool scope,
deterministic policy, advisory Meta model risk signals, human approval with
separation of duties, short-lived single-use permits, a broker that is the only route
to connectors, and an append-only hash-chained audit log.

Finance execution is **simulated**. No real money movement.

## 2. Request lifecycle

1. Agent calls `POST /v1/actions` with a bearer token, task, tool, exact args, and
   an idempotency key.
2. API authenticates the principal and resolves the tenant (tenant-blind credential
   lookup, then principal in that tenant).
3. Args are validated, canonicalized, and hashed.
4. The published policy revision is **pinned** (a version, not "latest").
5. Authoritative lookups: vendor, invoice, PO, connector, mode.
6. Effective environment derived from the credential.
7. Meta model screening (advisory; redacted input; optional).
8. Deterministic PDP evaluates (policy package) — never overridden by model.
9. Decision + audit event + outbox persisted in one transaction.
10. On ALLOW, a single-use permit is issued; the broker executes via the simulated
    connector, re-verifying hash/TTL/nonce/policy revision before dispatch.
11. Receipt recorded, reconciled, audited.

## 3. Workspaces

| Workspace | Responsibility |
| --- | --- |
| `packages/domain` | Types, reason codes, errors, canonicalization, money |
| `packages/schemas` | Zod request/response, policy, risk-hints (Meta structured output) |
| `packages/policy` | Pure deterministic PDP: deny precedence, default deny, field resolution, lint, simulation, signed MFA assertions |
| `packages/broker` | Permit issuing/verification/consumption, broker, simulated finance connector, reconciliation |
| `packages/db` | Drizzle + postgres; migrations, seeds, stores, RLS-friendly tenant scoping |
| `packages/queue` | BullMQ + transactional outbox, dispatcher, workers, DLQ, Redis circuit breaker |
| `packages/provider-meta` | Meta Model API client: config, prompt, retry, circuit breaker, semaphore, strict validation |
| `packages/observability` | Metrics, trace context, SLO definitions, multi-window burn-rate evaluation |
| `packages/ui` | Shared React UI kit |
| `packages/test-fixtures` | Synthetic corpus + builders |
| `apps/api` | Fastify API: intake, approvals, execution, policies, replay, health, status |
| `apps/worker` | Outbox dispatcher, model-analysis consumer, reconciliation, sweeps, DLQ redrive |
| `apps/web` | Next.js operator console |

## 4. Trust boundaries

- Agent ↔ API: agent is untrusted; request fields/content are not trusted.
- Model provider ↔ backend: model output is untrusted until schema (Zod) + semantic validation pass.
- PDP ↔ broker: narrowly scoped permit is the contract; broker re-verifies hash, TTL, nonce, policy revision.
- Broker ↔ connector: only broker holds connector authority; connector credentials never leave the broker.
- Tenant ↔ tenant: enforced in the database, not by query discipline (RLS on `pz_app`).
- Dashboard user ↔ privileged ops: authenticated roles, step-up auth, audit records.

## 5. Data tier

- PostgreSQL 17, role `pz_app` (non-exempt, RLS-bound) for runtime traffic; admin role for migrations.
- 22 tenant-bearing tables under RLS (`ENABLE` + `FORCE`), transaction-local `app.tenant_id`.
- Redis for the outbox queue (BullMQ), leases, DLQ.
- Outbox pattern: decision + audit + outbox in one transaction; dispatcher publishes asynchronously.

## 6. Meta model integration (advisory only)

- `MODEL_PROVIDER=disabled`, `MODEL_ENABLED=false` by default.
- Structured output via `response_format: json_schema` (strict) + Zod `riskHintsSchema` + semantic validation.
- `lintPolicy()` raises `MODEL_FIELD_IN_ALLOW_RULE` if an ALLOW rule reads a `model.*` field.
- Unavailable model never produces hints; PDP yields `REQUIRE_APPROVAL` or `INDETERMINATE`, never `ALLOW`.
- Resilience: retry 429/5xx/network/timeout with `Retry-After` + jittered backoff; no retry on 400/401/403/404; circuit breaker; FIFO semaphore (default concurrency 4).
- `model_evaluations` records metadata only (no raw prompts/outputs).

## 7. Deployment and CI

- CI: typecheck, lint, 606 tests, build, format, gitleaks, dependency gate, evidence-map gate, resilience drill, strict SLO scrape.
- Deploy: build, migrate under advisory lock, health check, verify isolation from the database.
- Single region; multi-region failover is **absent** (disclosed).

## 8. Key invariants

- Default deny; deny precedence.
- Model never issues permits, publishes policy, grants approvals, or invokes connectors (structural).
- Finance execution simulated.
- Audit chain hash-chained per tenant; concurrent writers finish gapless.
- Human cannot approve their own action (refused at decision point, excluded from quorum count).
- Permit single-use, scoped to tenant/action/policy revision/argument hash.