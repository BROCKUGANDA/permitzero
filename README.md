# PermitZero

> **Authority before action.** A zero-trust action firewall that intercepts every consequential tool call made by AI agents, binds it to a tenant, identity, task, policy version and exact argument hash, then allows, denies, queues for human approval, or safely halts the action before a connector can execute it.

PermitZero is a runtime authorization and transaction-control plane for agentic AI, built for the **Meta Global AI Developer Hackathon** (startup track). Finance execution is **simulated** — there are no real bank transfers, custody, private keys, or live payment rails. Performance, compliance, and security claims are **not certified** and require independent validation.

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

| Package | Responsibility |
|---|---|
| `packages/domain` | Types, reason codes, errors, canonicalization, money |
| `packages/schemas` | Zod request/response + policy + risk-hints (Meta structured output) schemas |
| `packages/policy` | Pure deterministic PDP: deny precedence, default deny, field resolution, lint, simulation |
| `packages/broker` | Permit issuing/verification/consumption, broker, simulated finance connector, reconciliation |
| `packages/db` | Drizzle + postgres; migrations, seeds, stores, RLS-friendly tenant scoping |
| `packages/queue` | BullMQ + transactional outbox, dispatcher, workers, DLQ |
| `packages/provider-meta` | Meta Model API client: config, prompt, retry, circuit breaker, semaphore, strict validation |
| `packages/ui` | Shared React UI kit (design tokens, components) |
| `packages/test-fixtures` | Synthetic corpus + builders |
| `apps/api` | Fastify API: intake, approvals, execution, policies, replay, health, status |
| `apps/worker` | Outbox dispatcher, model-analysis consumer, reconciliation, sweeps |
| `apps/web` | Next.js operator console (dashboard, action queue, policy studio, replay lab, evidence) |

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

| Threat | Mitigation |
|---|---|
| Agent bypasses PermitZero | Broker-only credentials; architecture + integration tests; connector access policy |
| Prompt injection in documents | Untrusted-source labeling; model advisory signal; deterministic scope/amount/destination/approval rules still apply even if detection fails |
| False allow from policy bug | Deny-by-default; replay corpus; mutation tests; two-person policy publication for high-risk rules |
| Duplicate payment after timeout | Durable idempotency; `UNKNOWN_OUTCOME` state; connector reconciliation; no blind retry |
| Stale approval | Approval + permit bound to exact hash + policy revision; re-evaluated at execution |
| Tenant data leak | Server-side identity; DB constraints/RLS; no tenant ID trusted from client; adversarial tenant tests |
| Model provider outage/rate limit | Model-independent deterministic core; bounded queue; backoff + breaker + safe degraded mode |
| Overclaiming compliance/security | Evidence mapping only; independent review; no unsupported certification claims |

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
- Performance SLOs are not measured under representative load.
- Model confidence is a claim, not a calibrated probability (no labeled eval dataset yet).

---

## 9. References

- OWASP Agentic Applications Top 10 — agentic risk taxonomy (goal hijacking, tool misuse, identity/privilege abuse).
- MAS SAFR (2026) — runtime authorization, human oversight, records of decisions in agentic finance.
- Meta Model API — `https://api.meta.ai/v1` (chat completions, structured output, models, error handling).

---

## License

MIT. See `LICENSE` (add if distributing).
