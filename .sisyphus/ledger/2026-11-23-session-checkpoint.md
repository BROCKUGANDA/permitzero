# 2026-11-23 — post-submission/judge-readiness

## Direction confirmed with the user
- Do **not** trigger any workflow. `auto-promote` and `auto-deploy` are GitHub Actions on GitHub,
  and deploy is deliberately main-only + CI-gated; dispatching it "on all branches" would defeat
  its safety design. Add the missing `auto-version` locally and review the other two.
- "3d vinyls" means a signature 3D vinyl motif in the UI, not a separate feature/app.
- Continue from the existing uncommitted WIP; do not reset or overwrite it.
- Aesthetic: signal-room / SOC. Ink background, phosphor cyan, amber for attention, monospace
  display type, hairline grid. Explicitly not generic AI styling.

## Changed
- New `.github/workflows/auto-version.yml` — semantic version tags from green main CI runs;
  idempotent (skips already-tagged commits), concurrency-serialised, no deploy, no branch push.
- New UI: `apps/web/src/components/vinyl.tsx` (CSS-3D disc, deck, mark), `signal-hero.tsx`,
  `motion.tsx`, `apps/web/src/lib/haptics.ts`.
- Theme: rewrote `apps/web/src/app/globals.css`, extended `tailwind.config.ts`, forced dark
  `layout.tsx`, applied the shell/overview/login/approval-dialog interaction polish.
- Hardening: `apps/api/src/code-execution-key.ts` + route fix (deterministic idempotency instead
  of `Date.now()`, language allowlist aligned with the route contract, visible audit failures)
  and `apps/api/test/code-execution-key.test.ts` (6 tests).
- Build fixes in WIP files: removed unused imports in connected-accounts / market-data / webhooks
  pages, `market.ts`, and `server.ts`. Live finance was already wired through `config.ts`.

## Verified
- `npm run typecheck` — clean, all 13 workspaces.
- `npm run lint` — clean.
- `npm run build -w @permitzero/web` — production build succeeds (10 routes).
- Targeted vitest: code-execution-key + outbox-router = 13/13 pass.
- Full `npm test`: 403 pass, 96 fail after this pass (383 before) — all failures are `ECONNREFUSED 127.0.0.1:5432`
  (no Postgres; Docker daemon is down). Pre-existing environment block, not code regressions.
- Visual QA against the production build with the API mocked in-browser: header, hero, disc,
  tonearm and grid render as designed. Nav wrapping at 1280px was found and fixed.

## Second pass — automations run locally, more hardening
- Ran automations in their safe local form (nothing dispatched, consistent with the saved decision):
  - all 5 workflow YAMLs parse; all 4 deploy shell scripts pass `bash -n`;
  - `auto-version` dry-run over all 4 local branches: no tags exist, every branch computes `v0.1.0` (minor);
  - `auto-promote` dry-run over 8 open Dependabot PRs: all 8 pass the author/base/draft gate, but
    NONE would merge — required checks are skipped, cancelled or failed on every head commit;
  - no deploy dry-run exists in `deploy-vps.sh`, so deploy was not exercised.
- Fixed `HttpNotificationSink`/`MemoryNotificationSink`: the documented (tenant, deliveryId)
  idempotency was not implemented. Added in-flight + receipt caching, bounded cache, tenant
  scoping, and 9 tests (`packages/connectors/test/notification-sink.test.ts`).
- Fixed `WiseTokenManager`: concurrent refreshes could rotate a refresh token twice and strand
  the account. Added per-account in-flight refresh covering the store save, plus 5 tests
  (`packages/connectors/test/token-manager.test.ts`).
- Verified after this pass: typecheck clean (13 workspaces), lint clean, 14/14 new connector tests.
- Known unwired adapter: `HttpFinanceConnector.dispatchHttp` has tests but no API route. It was
  deliberately NOT exposed — a generic outbound HTTP route needs an explicit allowlist config
  and permit design before it can be safe. Ask before adding it.

## Next steps
1. Bring up Postgres/Redis (Docker daemon is stopped) and re-run the full suite.
2. Continue production hardening: edge-case tests for market/webhook/notification sinks and
   the outbox publishers; verify consumer dead-letter behaviour for every emitted event type.
3. Run `gitnexus detect-changes --scope all --repo .` before any commit; GitNexus index was
   61 commits behind at the start of this session.
4. Only the user can decide whether to trigger workflows or deploy. Do not dispatch deploy
   across branches.
