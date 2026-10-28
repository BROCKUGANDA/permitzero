# PermitZero

> **Authority before action.** A zero-trust action firewall that intercepts every consequential tool call made by AI agents, binds it to a tenant, identity, task, policy version and exact argument hash, then allows, denies, queues for human approval, or safely halts the action before a connector can execute it.

PermitZero is a runtime authorization and transaction-control plane for agentic AI, built for the **Meta Global AI Developer Hackathon** (startup track). Finance execution is **simulated** — there are no real bank transfers, custody, private keys, or live payment rails. Performance, compliance, and security claims are **not certified** and require independent validation.

---

## For the judge: sixty seconds, then the evidence

**The one-line bet.** An AI agent with a payment tool should not be able to spend
money because a language model thought it was fine. PermitZero puts a
deterministic, tenant-scoped, tamper-evident authorization plane between the agent
and the connector: the model advises, policy decides, a human can be required, and
every step is written to a hash-chained audit log the database itself enforces.

**Run it.**

```bash
npm ci && cp .env.example .env
npm run db:migrate && npm run db:seed   # synthetic tenant, model provider disabled
npm run dev                             # API :8080, console :3000, worker
npm run demo:scenario                   # allow / deny / approval, end to end
```

**What one decision looks like.**

```mermaid
sequenceDiagram
    participant A as Agent (untrusted)
    participant API as API :8080
    participant P as Policy PDP
    participant M as Meta model (optional)
    participant DB as Postgres (RLS, hash chain)
    participant B as Broker → simulated connector
    A->>API: POST /v1/actions (token, task, tool, exact args, idempotency key)
    API->>DB: tenant-blind credential lookup, then resolve principal in that tenant
    API->>DB: pin the published policy revision (a version, not "latest")
    opt model configured
        API->>M: bounded, redacted risk-hints request (json_schema + Zod revalidation)
        M-->>API: hints, or none — a missing hint is never treated as safe
    end
    API->>P: evaluate(pinned revision, facts, hints)
    P->>DB: append decision to the tenant's audit chain (one tx: action + audit + outbox)
    alt ALLOW
        API-->>A: signed permit (TTL, nonce, argument hash, policy revision)
        A->>B: execute with the narrowly scoped permit
        B->>DB: broker re-verifies hash, TTL, nonce and revision before the connector runs
    else DENY or REQUIRE_APPROVAL
        API-->>A: terminal answer, or a two-of-N human approval that expires
    end
```

**How the pieces hold together.**

```mermaid
flowchart LR
    subgraph edge["Edge"]
      Caddy["Caddy: TLS, security headers"]
    end
    subgraph apip["apps/api (Fastify)"]
      Intake["intake → policy → decision"]
      Approvals["approvals / quorum"]
      Permits["permit issuance"]
      Obs["metrics + W3C trace + /metrics"]
    end
    subgraph pkgs["packages"]
      Policy["policy: deterministic PDP"]
      Domain["domain / schemas"]
      DBPkg["db: RLS, hash chain, outbox"]
      Queue["queue: BullMQ, leases, DLQ"]
      Meta["provider-meta: breaker + backoff"]
      ObsPkg["observability: SLOs, burn rates"]
    end
    subgraph asyncp["apps/worker"]
      Disp["outbox dispatcher + redrive"]
    end
    Console["apps/web console (Next.js)"]
    PG[("PostgreSQL: pz_app role, 22 tenant tables under RLS")]
    RD[("Redis")]
    P1[("Meta API, optional")]

    Console --> Caddy --> apip
    Intake --> Policy --> Domain
    Intake --> Meta --> P1
    apip --> DBPkg --> PG
    Disp --> Queue --> RD
    Queue --> DBPkg
    Obs --> ObsPkg
```

**Measured, not asserted.**

| Claim                                  | Number                                                                                                                                                                                                  | Where to check it                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Tenant isolation is the database's job | 22/22 tenant-bearing tables RLS-enabled, forced and policy-covered for a non-exempt role; asserted from the catalog at boot and reported by `/health/ready`                                             | `infra/migrations/0006_row_level_security.sql`, `packages/db/test/rls.test.ts` |
| Decisions are tamper-evident           | Every event hashes the canonical payload plus the previous hash; ten concurrent writers on one tenant finish gapless and the chain verifies                                                             | `packages/db/test/audit-concurrency.test.ts`, `verifyAuditChain`               |
| Throughput and latency                 | 1,590 requests, 159 fresh policy decisions, server decision p99 **249 ms**, 0 5xx, 0 client failures at 10 concurrent clients                                                                           | `docs/benchmarks/RESULTS.md`                                                   |
| Where the ceiling actually is          | ~46–63 req/s on one tenant, flat as the runtime pool doubles (2.6%): the per-tenant audit chain is the limit, not the pool                                                                              | `docs/benchmarks/SCALING.md`                                                   |
| Objectives that can fail               | Multi-window, multi-burn-rate SLOs with a histogram bucket at the threshold; the report exits non-zero when breached                                                                                    | `packages/observability/src/slos.ts`, `npm run slo:report:strict`              |
| Survives a provider or queue outage    | The drill kills Postgres and Redis mid-flight and asserts no lost events, no duplicate delivery, bounded shutdown                                                                                       | `npm run drill:resilience`                                                     |
| Nothing unproven is claimed            | 24 controls mapped to code and tests: 15 implemented, 5 partial, **4 absent** (encryption at rest, backup/PITR, retention and deletion, independent review)                                             | `docs/compliance/EVIDENCE.md`, `npm run compliance:gate`                       |
| Test surface                           | 498 tests across 39 files, plus typecheck, lint at `--max-warnings=0`, format, gitleaks, the dependency gate and the evidence-map gate — all wired into `npm run verify` and `.github/workflows/ci.yml` | `npm run verify`, `.github/workflows/ci.yml`                                   |

Those gates run on the development machine and are configured for every push. No hosted CI
run has actually executed on this repository yet: each run finishes in about three seconds
with no runner assigned and no logs. So the numbers above are local numbers, and
`docs/compliance/EVIDENCE.md` records that under CHANGE-CONTROL instead of letting a
workflow file stand in for proof.

**Read the honest parts too.** The model never issues a permit, publishes policy or
calls a connector, and that is structural rather than a convention:
`MODEL_FIELD_IN_ALLOW_RULE` refuses to publish a policy whose ALLOW rules read a
`model.*` field. Finance execution is simulated. The capacity ceiling above is a
consequence of the design, and the remedy (per-tenant chain partitioning) is named
but not built. `npm run compliance:gate` exists so that a control claimed here cannot
quietly rot as the code moves.

---

## 1. What it does

Companies are connecting AI agents to tools that can read sensitive data and change business state (ERP/AP, vendor master data, payments, refunds, cloud control planes). Existing IAM answers "does this credential have permission to call this API?" — it does not answer "is this exact action, for this task, at this time, within this amount, to this destination, safe and approved?"

PermitZero sits between agent intent and every side-effecting integration and enforces, before dispatch:

- Tenant, identity, agent and tool scope checks
- Deterministic policy evaluation (amount limits, vendor state, PO match, velocity, budget, cooling periods, evidence requirements)
- Risk signals from the Meta Model API (advisory only — never an authorization authority)
- Human approval with separation of duties, bound to the exact action hash and policy revision
- Short-lived, single-use, audience-scoped execution permits
- A broker that is the **only** route to side-effecting connectors, with durable execution-intent records and reconciliation of unknown outcomes
- Append-only, hash-chained audit events from proposal to simulated receipt

---

## 2. Architecture

```
Agent ──POST /v1/actions──► API (Fastify) ──► Intake pipeline
                                    │
                                    ├── authenticate principal, resolve tenant
                                    ├── validate + canonicalize args, hash
                                    ├── pin published policy revision (immutable)
                                    ├── authoritative lookups (vendor, invoice, PO, connector, mode)
                                    ├── Meta Model API screening (advisory; redacted input)
                                    ├── deterministic PDP (policy package)  ← never overridden by model
                                    ├── persist decision + audit event + outbox (one transaction)
                                    ├── issue single-use permit on ALLOW
                                    └── broker executes via simulated connector (permit verified)
                                              │
                                              └── receipt recorded, reconciled, audited
```

### Packages (monorepo workspaces)

| Package                  | Responsibility                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `packages/domain`        | Types, reason codes, errors, canonicalization, money                                         |
| `packages/schemas`       | Zod request/response + policy + risk-hints (Meta structured output) schemas                  |
| `packages/policy`        | Pure deterministic PDP: deny precedence, default deny, field resolution, lint, simulation    |
| `packages/broker`        | Permit issuing/verification/consumption, broker, simulated finance connector, reconciliation |
| `packages/db`            | Drizzle + postgres; migrations, seeds, stores, RLS-friendly tenant scoping                   |
| `packages/queue`         | BullMQ + transactional outbox, dispatcher, workers, DLQ                                      |
| `packages/provider-meta` | Meta Model API client: config, prompt, retry, circuit breaker, semaphore, strict validation  |
| `packages/ui`            | Shared React UI kit (design tokens, components)                                              |
| `packages/test-fixtures` | Synthetic corpus + builders                                                                  |
| `apps/api`               | Fastify API: intake, approvals, execution, policies, replay, health, status                  |
| `apps/worker`            | Outbox dispatcher, model-analysis consumer, reconciliation, sweeps                           |
| `apps/web`               | Next.js operator console (dashboard, action queue, policy studio, replay lab, evidence)      |

### Trust boundaries

- **Agent ↔ API**: agent is untrusted; request fields and content are not trusted.
- **Model provider ↔ backend**: model output is untrusted until schema (Zod) + semantic validation pass.
- **PDP ↔ broker**: narrowly scoped permit is the contract; broker re-verifies hash, TTL, nonce, policy revision.
- **Broker ↔ connector**: only broker holds connector authority; connector credentials never leave the broker.
- **Tenant ↔ tenant**: enforced server-side in API + DB constraints; cross-tenant access returns 404, never 403.
- **Dashboard user ↔ privileged ops**: authenticated roles, step-up auth for sensitive actions, audit records.

---

## 3. Meta Model API usage

Meta's models are used for **structured extraction and advisory risk signals only** (PRD §4.8, §11). Forbidden powers are enforced structurally, not by convention:

- `MODEL_ID` has no default and is never invented (FR-072). Configured value is verified via `discoverModels()`.
- Output is constrained with `response_format: json_schema` (strict) **and** re-validated with Zod `riskHintsSchema` + `validateRiskHintsSemantics()` (evidence refs must be carried, ISO-4217 currency, amount requires currency).
- `lintPolicy()` raises `MODEL_FIELD_IN_ALLOW_RULE` (ERROR) if any `ALLOW` rule references a `model.*` field, so a policy author cannot make the model the final judge.
- A failed/unavailable model never produces hints; `requiredModelSignalUnavailable` makes the PDP yield `REQUIRE_APPROVAL` or `INDETERMINATE` — never `ALLOW`.
- Inputs are redacted/bounded (max 8 untrusted texts × 4,000 chars, 8,000 chars of args); no secrets, signing keys, or unnecessary PII are sent.
- Resilience: retry 429/5xx/network/timeout with `Retry-After` + jittered backoff; never retry 400/401/403/404; circuit breaker (CLOSED→OPEN→HALF_OPEN); FIFO semaphore bulkhead (default concurrency 4).
- `model_evaluations` records metadata only (model id, prompt/schema version, input hash, latency, status, error class) — no raw prompts/outputs.
- The entire demo and all acceptance gates pass with `MODEL_ENABLED=false` (deterministic mode).

See `packages/provider-meta/` and `apps/api/src/model.ts`.

---

## 4. Threat model (summary)

| Threat                           | Mitigation                                                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent bypasses PermitZero        | Broker-only credentials; architecture + integration tests; connector access policy                                                                                                                                                                               |
| Prompt injection in documents    | Untrusted-source labeling; model advisory signal; deterministic scope/amount/destination/approval rules still apply even if detection fails                                                                                                                      |
| False allow from policy bug      | Deny-by-default; replay corpus; mutation tests; two-person policy publication for high-risk rules                                                                                                                                                                |
| Duplicate payment after timeout  | Durable idempotency; `UNKNOWN_OUTCOME` state; connector reconciliation; no blind retry                                                                                                                                                                           |
| Stale approval                   | Approval + permit bound to exact hash + policy revision; re-evaluated at execution                                                                                                                                                                               |
| Tenant data leak                 | PostgreSQL RLS on the non-exempt `pz_app` role (22/22 tenant tables, catalog-asserted at boot, transaction-local context that matches zero rows when unset, tenant-id immutability trigger, DDL event trigger for future tables); adversarial cross-tenant tests |
| Model provider outage/rate limit | Model-independent deterministic core; bounded queue; backoff + breaker + safe degraded mode                                                                                                                                                                      |
| Overclaiming compliance/security | Evidence mapping only; independent review; no unsupported certification claims                                                                                                                                                                                   |

---

## 5. Safety boundaries

- **No real money movement.** The connector is simulated; receipts are synthetic. Never point this at a live payment rail.
- **Not certified.** No SOC 2, ISO 27001, PCI DSS, OWASP coverage claims, or legal compliance guarantees. Evidence mapping only.
- **Model is not an authority.** Model output never issues permits, publishes policy, grants approvals, or invokes connectors.
- **No autonomous approval** of material financial actions; quorum + separation of duties enforced.
- **Observe-only / simulation / degraded / emergency-stop** modes are explicitly labeled; the UI shows a persistent banner.
- **Secrets** (model keys, DB URLs, signing keys, connector creds) live in the secret manager/env only; never in browser bundles or logs.

---

## 6. Getting started

### Prerequisites

- Node.js ≥ 20, npm ≥ 10
- PostgreSQL 17 (local or Docker)
- Redis (optional; enables the outbox dispatcher + workers)
- gitleaks (for `npm run secret:scan`)

### Setup

```bash
git clone https://github.com/BROCKUGANDA/permitzero.git
cd permitzero
npm install
cp .env.example .env
# Fill in AUTH_SECRET, AUDIT_HASH_KEY, PERMIT_SIGNING_KEY, DATABASE_URL, etc.
# Meta Model API is OPTIONAL: leave MODEL_PROVIDER=disabled for deterministic mode.
```

### Database

```bash
npm run db:migrate
npm run db:seed            # synthetic demo data (tenant slug: demo)
```

### Run

```bash
npm run dev                # api + worker + web via scripts/dev.mjs
# or individually:
npm run dev:api
npm run dev:worker
npm run dev:web
```

### Demo scenario

```bash
npm run demo:scenario -- --dry-run=false
# or reset everything:
npm run demo:reset
```

### Tests

```bash
npm test                   # vitest (unit + integration)
npm run typecheck
npm run lint
npm run verify             # typecheck + lint + tests + build (+ format check)
npm run secret:scan        # gitleaks (working tree)
```

### Model connectivity check

```bash
MODEL_API_KEY=... MODEL_ID=... npm run model:check -w @permitzero/provider-meta
```

---

## 7. Repository layout

```
permitzero/
├── apps/            api, worker, web
├── packages/        domain, schemas, policy, broker, db, queue,
│                    provider-meta, ui, test-fixtures
├── infra/           migrations, docker, deploy, caddy
├── scripts/         dev.mjs, verify.mjs
├── docs/            module-contracts.md
├── .env.example
└── README.md
```

---

## 8. Known limitations (hackathon MVP)

- Single-region authoritative writer; no active-active multi-region.
- Simulated connector only; no live payment rails.
- No SSO/SCIM/MFA step-up beyond role-based auth in the MVP.
- Replay Lab replays stored actions; full run-trace replay with redaction is P1.
- Intake throughput is capped by the per-tenant audit hash chain, which serialises
  appends by design: ~46–63 requests/s on one tenant on this rig, flat whether the
  runtime pool is 10 or 25 (`npm run load:sweep`, `docs/benchmarks/SCALING.md`). At
  25 concurrent clients on one tenant, 0.65–0.69% of requests exceeded the client
  timeout, which breaches the 99.9% availability objective — measured, not hidden.
  Per-tenant chain partitioning is the remedy and is not built here.
- No encryption at rest, no backup/PITR procedure, no retention or deletion path,
  and no independent review — all four are recorded as `absent` in
  `docs/compliance/EVIDENCE.md` rather than implied by the word "secure".
- Model confidence is a claim, not a calibrated probability (no labeled eval dataset yet).

---

## 9. References

- OWASP Agentic Applications Top 10 — agentic risk taxonomy (goal hijacking, tool misuse, identity/privilege abuse).
- MAS SAFR (2026) — runtime authorization, human oversight, records of decisions in agentic finance.
- Meta Model API — `https://api.meta.ai/v1` (chat completions, structured output, models, error handling).

---

## License

MIT. See `LICENSE` (add if distributing).
