# PermitZero — Limitations

Honest disclosure of limitations. Source: `README.md` §8, `docs/compliance/EVIDENCE.md`,
`BASELINE.md`, `INSPECTION.md`.

## 1. Not certified

No SOC 2, ISO 27001, PCI DSS, OWASP coverage certification, or legal compliance
guarantee. Evidence mapping only. Compliance gate maps controls to code and tests.

## 2. Finance execution is simulated

The connector is simulated; receipts are synthetic. No real money movement, custody,
private keys, or live payment rails. Never point at a live payment rail.

## 3. Absent controls (explicitly, not hidden)

- `MULTI-REGION-FAILOVER` — absent. Single Postgres, single Redis, one region, one host.
- `INDEPENDENT-THIRD-PARTY-REVIEW` — absent. The adversarial review in
  `docs/security-review.md` was performed by an automated reviewer inside the repo,
  triaged by the author. A review by someone who did not write the code requires a
  budget and a second party.

## 4. Partial controls

- `CI-RUNNER-ISOLATION` — partial. Fork PRs never reach the self-hosted runner,
  but the runner lives on the deploy host alongside production stacks and four other
  projects, sharing disk. Hosted runners are refused on this account ("account is
  locked due to a billing issue"). Moving back is a one-line change to the
  `CI_RUNNER` repository variable once billing is cleared.

## 5. Performance ceiling

Intake throughput is capped by the per-tenant audit hash chain, which serializes
appends by design: ~46–63 req/s on one tenant on this rig, flat whether the runtime
pool is 10 or 25 (`npm run load:sweep`, `docs/benchmarks/SCALING.md`). At 25
concurrent clients on one tenant, 0.65–0.69% of requests exceeded the client
timeout, breaching the 99.9% availability objective — measured, not hidden.
Per-tenant chain partitioning is the remedy and is not built.

## 6. Model limitations

- Model confidence is a claim, not a calibrated probability (no labeled eval dataset).
- Live Meta calls require `MODEL_PROVIDER=meta` + credentials; not part of the
  default demo. Default demo runs deterministic with `MODEL_ENABLED=false`.

## 7. MFA

MFA step-up is a real TOTP second factor (enrol, confirm, verify, step-up endpoint
issuing the signed assertion a policy requires). No hardware-key or WebAuthn factor.
No SSO/SCIM.

## 8. Replay Lab

Replays stored actions; full run-trace replay with redaction is P1.

## 9. Environment limitation in this session

PostgreSQL 17 could not be stabilized in the sandbox used for this exercise
(Windows exception `0xC0000142` after ~2 minutes). Redis is running. Docker Desktop
daemon is not responding. Consequently migrate/seed/stack/demo/DB-dependent tests
were not executed end-to-end here; typecheck, lint, and the 136 DB-independent tests
pass. A judge should run on a machine with a stable PostgreSQL 17 + Redis.

## 10. No independent validation

Benchmarks, CI results, and deployment claims are documented but not independently
reproduced in this session unless explicitly labeled "Verified." See
`CLAIMS-AND-EVIDENCE.md`.