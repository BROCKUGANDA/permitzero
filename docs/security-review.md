# Security review

An adversarial review of this build, and what it found.

**What this is.** A record of a security review performed against PermitZero
during the hardening work, with every finding and its remediation. The register
below is the evidence for the `ADVERSARIAL-SECURITY-REVIEW` control in
`docs/compliance/EVIDENCE.md`.

**What this is not.** It is **not** an independent third-party penetration
test, and it is not a certification. The reviewer was an automated code
reviewer running inside this repository, and the triage was done by the
author — the same person who wrote the code. A review by the author of the
thing reviewed is worth something; it is not the same thing as a review by
someone who did not write it. That distinction is recorded as its own open
control (`INDEPENDENT-THIRD-PARTY-REVIEW`), and it is not claimed here.

---

## 1. Scope and method

**In scope.** The whole repository: the API, the worker, the policy engine, the
database layer and its migrations, the deployment scripts, the Docker Compose
stack, the CI/CD workflows, and the operational tooling (janitor, drill,
gates).

**Method.** Three passes, in this order:

1. **Automated adversarial review.** A code-reviewer integration posts findings
   against every pull request. Each finding was read, reproduced against the
   code, and either fixed or explicitly rejected with a reason. All of them are
   in the register below — none were dismissed without a decision.
2. **Deployment-path review.** The deployment was traced end to end, from the
   commit that lands on `main` to the container that serves traffic, looking
   for the points where a value is read by one component and assumed by
   another. This is where the highest-severity findings came from, because a
   deployment path is where configuration drifts from code.
3. **Live verification.** Every fix was checked against the running
   deployment rather than against a local checkout — a control that is
   "enforced" in the repository but disabled in the deployed stack is worse
   than one that is absent, because the map claims it.

**Out of scope.** Performance beyond what the drill measures; the third-party
model provider's own implementation; the host operating system's own
hardening; and any environment other than the one deployment this project
runs in.

---

## 2. Findings

Twenty-seven findings. Every one was reproduced before it was fixed.

### Deployment and secrets

| #   | Sev    | Finding                                                                                                                                                                                                                                                                                                                                       | Resolution                                                                                                                                              |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High   | `actions/checkout` removes untracked and ignored files, so a later checkout erased the deployment's env file. The next deploy would generate a NEW permit signing key and a NEW audit HMAC key against the existing database — invalidating every permit already issued and breaking the audit chain — with no error at the point of failure. | Durable state moved outside the checkout (`PZ_STATE_DIR`); Compose reads the env file through `PZ_APP_ENV_FILE`. Verified: the keys survive a checkout. |
| 2   | High   | The deploy script sourced its env file as `"./$ENV_FILE"`. Once the state directory put that file outside the tree, the path became absolute, the prefix turned it relative, and the deploy aborted under `set -e` before it had built or migrated anything.                                                                                  | Absolute-path resolution. Verified on the host: an absolute path sources, the old form fails exactly as described.                                      |
| 3   | Medium | The runtime role's password was written into the env file but never applied to the role that already existed in the database, so the API could not log in at all. Migration 0006 only repairs a password when the role's _attributes_ have drifted, and it runs once.                                                                         | The deploy applies the password explicitly, retries while Postgres starts, and fails loudly if it cannot.                                               |
| 4   | Medium | The tenant-isolation probe could not distinguish a psql error from a row count, so an authentication failure was reported as "the runtime role sees N audit rows" — a misleading statement about row-level security when the real fault was a password.                                                                                       | The exit status decides the branch; a probe that cannot run now fails the deploy instead of warning and continuing.                                     |
| 5   | Medium | The deploy pruned other projects' Docker images and build cache on a shared host. `-a` also removes every _tagged_ image nobody references, which on that host includes other projects' rollback targets — the images that exist so a bad deploy can be undone.                                                                               | Scoped to this project's compose label; the global build cache is not pruned at all, because it cannot be scoped.                                       |
| 6   | High   | The disk janitor removed every dangling volume. A _named_ volume — a production database — also becomes dangling the moment its container is removed, so the janitor could destroy a database that the next `compose up` was about to reattach to.                                                                                            | Only anonymous volumes (64 hexadecimal characters) are removed. Every named volume on the host is unreachable by that loop.                             |
| 7   | Medium | Two CI jobs published their service containers on the same host ports. The collision is silent — GitHub reports "Initialize containers" as a success — so the job carried on and ran against the _other_ job's database.                                                                                                                      | Per-job ports, and each job checks that the port it was given is serving its own container before it does any work.                                     |
| 8   | Low    | The webhook URL was interpolated into a `sed` replacement unescaped, where `&` means "the text that matched" and `                                                                                                                                                                                                                            | ` ends the expression.                                                                                                                                  | Escaped before substitution. |
| 9   | Low    | The janitor's failures were silent. A janitor that cannot reclaim space and says nothing is worse than one that says so: the operator sees a healthy log and a full disk.                                                                                                                                                                     | Every failure is reported — the listing, an unreadable timestamp, a removal that did not take.                                                          |

### Isolation and authorization

| #   | Sev    | Finding                                                                                                                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                                                      |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | High   | The blind escape hatch (`pz.tenant_blind`) was granted `FOR ALL` policies on `users` and `outbox_events`. `FOR ALL` whose `USING` clause says "the flag is on" is a _write_ grant, not a read grant: a blind transaction could rewrite another tenant's identity record, or publish, fail, kill or forge another tenant's outbox row. | Migration 0007 narrows both. The column-level half of the rule is a trigger, because a row-level policy cannot express which columns a statement may change. Covered by adversarial tests.                                                                      |
| 11  | High   | The deployment ran the API as the schema owner. Row-level security does not bind the owner, so every tenant row was reachable without a tenant context — a cross-tenant read returned every audit row in the table.                                                                                                                   | The API connects as the restricted role, and the deploy verifies the property against the live database: as the runtime role with no tenant context, the count must be zero. Verified on the running deployment.                                                |
| 12  | High   | The quorum counted _distinct_ approvers, which is not the same thing as an approver independent of the requester. A user holding an OWNER or APPROVER role could submit a payment and then be its only approver.                                                                                                                      | Refused at the point of decision, and the requester's approval is excluded from the count so a quorum can never be closed by the party the control excludes.                                                                                                    |
| 13  | High   | `require_mfa` was satisfied by any one-character string the client typed.                                                                                                                                                                                                                                                             | A server-signed assertion bound to the tenant, the approver, the action and an expiry. A client string, a wrong key, the wrong action, the wrong approver and an expired assertion are all refused.                                                             |
| 14  | High   | The environment that scoped a policy rule was taken from the request body and never compared with the principal's. A caller could claim `DEMO` to drop `PRODUCTION`-scoped protective rules out of scope, or claim `PRODUCTION` to invoke production-only logic.                                                                      | The effective environment is derived from the credential, the engine cannot be handed an environment it did not derive, and a disagreeing claim is refused. The action row, the idempotency hash and the metrics label record the derived value, not the claim. |
| 15  | Medium | The credential rate-limit budget was parsed and applied to nothing. Credential-bearing endpoints had only the global ceiling.                                                                                                                                                                                                         | Applied on the credential-bearing surface, and keyed on the credential rather than the client address.                                                                                                                                                          |
| 16  | Low    | An expired credential answered with a different message than an unknown or revoked one — a credential-existence oracle.                                                                                                                                                                                                               | One message, one code, one shape for all three.                                                                                                                                                                                                                 |

### Pipeline integrity

| #   | Sev    | Finding                                                                                                                                                                                                                                                                                        | Resolution                                                                                                                                                                                                                                                             |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | High   | A merge performed with the workflow's own `GITHUB_TOKEN` does not trigger a push workflow — so a commit the auto-promotion merged onto `main` reached it with **nothing verifying it** and nothing deploying it. The failure was silent: the workflow reported success.                        | The promotion dispatches CI on the merge commit explicitly, and a scheduled reconciliation workflow covers a merge that lands later. Verified: a dispatched CI run completes and the Deploy fires from it.                                                             |
| 18  | High   | A pull request from a fork was checked out and executed on the self-hosted runner — the machine that holds the deployment credentials and Docker access. Opening a pull request was enough to get code execution there.                                                                        | A fork pull request never selects the self-hosted runner. It is directed to a hosted runner, which is isolated, disposable and holds no credentials.                                                                                                                   |
| 19  | Medium | The auto-promotion identified the pull request by branch name. A branch name is not an identity — a fork can name a branch after an open Dependabot branch and have its CI run select an unrelated pull request and enable its auto-merge.                                                     | The pull request is read from the completed run's own pull-request list. The branch-name fallback was removed, not tightened.                                                                                                                                          |
| 20  | Medium | The promotion only knew `dependabot[bot]`. GitHub has moved its bots into the `app/` namespace, so every real dependency bump was declined while the workflow reported that it was behaving correctly.                                                                                         | Both logins are accepted. The old one is quoted, because `dependabot[bot]` in a shell case pattern is a glob that matches nothing.                                                                                                                                     |
| 21  | Medium | `jq` was an undeclared dependency of the promotion. A runner without it failed the step in a way that looked exactly like "there was nothing to promote".                                                                                                                                      | `gh` does the JSON parsing, and `gh` is already required.                                                                                                                                                                                                              |
| 22  | Medium | The compliance gate's citation correction replaced the bare `path:line`, which is a prefix of every longer line number sharing its digits — so correcting one citation silently corrupted another, and the gate was editing the evidence it was supposed to be checking.                       | The replacement is scoped to the whole entry — path, line and token.                                                                                                                                                                                                   |
| 23  | Medium | The CI job's disk reclaim removed the job's _own_ service containers: the runner names them with the same hash prefix it uses for leftovers, so the cleanup could not tell them apart. The job then ran against another job's database.                                                        | The workflows prune images only. Containers belong to the host janitor, which checks that no job is running.                                                                                                                                                           |
| 24  | Medium | The test harnesses read `process.env` and never the root `.env`, so in CI they fell back to a passwordless URL and every database-backed test failed with an authentication error that looked like a broken schema.                                                                            | All three harnesses call `loadRootEnv()`, and the CI exports the values as well as writing them to the file.                                                                                                                                                           |
| 25  | Medium | The migration runner had no advisory lock. Two replicas booting together both read the same pending-migration snapshot, both applied the same file, and the loser crashed on the tracking table's primary key — a crash loop caused by nothing more than two pods starting at once.            | The read-apply-record sequence runs under a per-database advisory lock, taken and released on one reserved connection. The key is derived from the database name, because `pg_advisory_lock` is cluster-wide and a fixed key would serialise unrelated databases.      |
| 26  | Low    | The secret scan read files only, so a secret that was committed and later deleted from the working tree was never found — and removing a secret from a file does not un-leak it.                                                                                                               | The scan runs over the history, from a checkout with `fetch-depth: 0`. The working-tree scan is kept separately, because a shallow checkout has no history to walk and a history scan over one examines almost nothing while looking as though it examined everything. |
| 27  | Low    | The dependency gate read an npm _configuration error_ as a clean audit. npm reports its own failures as a JSON envelope, which parses, has no `vulnerabilities` key, and therefore yields zero findings — and a zero-finding report passes. This is how four real advisories had been retired. | A report that is not a report fails the gate. The four exceptions are restored, named and reasoned.                                                                                                                                                                    |

---

## 3. Residual and accepted risks

These are known and not fixed. Each is a decision, not an oversight.

| Risk                                                                                                                         | Why it is accepted                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The CI runner shares a host with four other projects' production stacks, and with their databases.                           | The alternative was no CI at all: hosted runners are refused on this account. The runner is isolated as far as a shared host allows — fork pull requests never reach it, disk reclamation is scoped, and the janitor refuses to delete anything while a job is running. The correct fix is a separate CI host, which is a budget decision. |
| The deployment is single-region, with one Postgres and one Redis.                                                            | The drill proves the failure modes degrade rather than halt. Active-active is a different architecture, and the evidence map says so rather than implying it.                                                                                                                                                                              |
| The model provider is advisory and its outage path is exercised only by the drill, not by production traffic.                | The provider is optional by design: the deterministic path answers without it, and a policy that requires the model signal escalates rather than allowing.                                                                                                                                                                                 |
| Key rotation has a keyring with a defined lifetime but no automated schedule.                                                | Rotation is a procedure with a runbook and a test, not a cron job, because the rotation window is a risk decision (how long an old key stays acceptable) rather than a technical one.                                                                                                                                                      |
| The encryption-at-rest control covers the application's stored payloads and secret material, not the database volume itself. | Volume-level encryption is the host platform's responsibility; this project's own disk is not encrypted. The control is stated with the scope it actually has.                                                                                                                                                                             |

---

## 4. What an independent review would still need to cover

Nothing in this register substitutes for it. An external reviewer would need
to cover, at minimum:

- **The authorization path itself.** Whether a policy can be written that this
  engine evaluates incorrectly — the class of bug the internal review is least
  able to find, because it reasons from the same mental model as the author.
- **The key-derivation and encryption scheme.** That the domain separation
  between purposes holds, that the AES-GCM nonces never repeat, and that the
  keyring cannot be widened by an attacker who can write to the environment.
- **The deployment as an operator sees it.** Whether a host can be configured
  into an unsafe state by someone who is not the author — the deploy
  preflight, the compose file's secrets handling, and the janitor's scope
  decisions are all worth a second pair of eyes.
- **The claim that the audit chain is tamper-evident.** Not that it detects
  tampering — that is tested — but that the design has no second way to
  reconstruct a chain that verifies.

That work needs a party who did not write this code and a budget to pay them.
Until then it is absent, and the map says so.
