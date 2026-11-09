# PermitZero — Threat Model

Summary of threats and mitigations. Source: `README.md` §4, `docs/security-review.md`,
`docs/compliance/EVIDENCE.md`. This is an engineering threat model, not an
independent security audit.

---

## 1. Scope

In scope: the API, worker, web console, packages, database, queue, and simulated
connector. Out of scope: the host OS, cloud provider, and any real payment rail
(none is connected — finance execution is simulated).

## 2. Trust boundaries

- Agent ↔ API (agent untrusted).
- Model provider ↔ backend (model output untrusted until validated).
- PDP ↔ broker (permit is the contract).
- Broker ↔ connector (broker holds connector authority).
- Tenant ↔ tenant (database-enforced).
- Dashboard user ↔ privileged ops (authenticated roles, step-up).

## 3. Threats and mitigations

| Threat | Mitigation | Evidence |
| --- | --- | --- |
| Agent bypasses PermitZero | Broker-only credentials; connector access policy; integration tests | `packages/broker`, `apps/api/test` |
| Prompt injection in documents | Untrusted-source labeling; model is advisory only; deterministic scope/amount/destination/approval rules still apply even if detection fails | `packages/provider-meta`, `packages/policy` |
| False allow from policy bug | Deny-by-default; deny precedence; replay corpus; mutation tests; two-person policy publication for high-risk rules | `packages/policy/test` |
| Duplicate payment after timeout | Durable idempotency; `UNKNOWN_OUTCOME` state; connector reconciliation; no blind retry | `packages/broker`, `apps/api/test/execute.test.ts` |
| Stale approval | Approval + permit bound to exact hash + policy revision; re-evaluated at execution | `apps/api/src/approvals.ts` |
| Self-approval | Requester excluded from approval and from quorum's distinct-approver count | `apps/api/src/approvals.ts`, `apps/api/test/approvals.test.ts` |
| Tenant data leak | PostgreSQL RLS on non-exempt `pz_app` role (22/22 tenant tables), read-only blind escape hatch, transaction-local context returning zero rows when unset, tenant-id immutability trigger, DDL event trigger; adversarial cross-tenant tests | `infra/migrations/0006_row_level_security.sql`, `packages/db/test/rls.test.ts` |
| Model provider outage / rate limit | Model-independent deterministic core; bounded queue; backoff + breaker + safe degraded mode (`REQUIRE_APPROVAL`/`INDETERMINATE`, never `ALLOW`) | `packages/provider-meta` |
| Overclaiming compliance/security | Evidence mapping only; no unsupported certification claims; compliance gate | `docs/compliance/EVIDENCE.md`, `npm run compliance:gate` |
| Audit tampering | Hash-chained per-tenant audit events; `verifyAuditChain`; concurrent-writer test (10 writers, gapless) | `packages/db/test/audit-concurrency.test.ts` |
| Permit replay / alteration | Expiry, argument-hash mismatch, wrong audience/tenant/action/policy revision, revoked permit, concurrent consumption all rejected | `packages/broker` tests |
| Credential stuffing on MFA | IP-limited failed-auth budget; TOTP replay atomic on step counter | `apps/api/test` rate-limit/MFA tests |

## 4. Residual risks (disclosed)

- Single-region, single Postgres, single Redis, one host. Multi-region failover **absent**.
- No independent third-party security review or penetration test (the review in
  `docs/security-review.md` was performed by an automated reviewer inside the repo,
  triaged by the author).
- CI runner is self-hosted on the deploy host (account billing lock prevents hosted runners).
- Model confidence is not a calibrated probability (no labeled eval dataset).
- Per-tenant audit chain serializes appends (~46–63 req/s on one tenant); per-tenant
  chain partitioning is the remedy and is not built.

## 5. Out of scope / not claimed

- No SOC 2, ISO 27001, PCI DSS, OWASP coverage certification.
- No real bank transfers, custody, or bank connectivity (simulated).
- No multi-region failover.
- No SSO/SCIM; MFA is TOTP step-up only (no hardware key/WebAuthn).

## 6. Related

- `docs/security-review.md` — adversarial review register.
- `docs/compliance/EVIDENCE.md` — control evidence map (31 controls: 28 implemented, 1 partial, 2 absent).
- `LIMITATIONS.md` — honest limitations.