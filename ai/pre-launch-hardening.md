# Pre-launch hardening

**Status: Priorities 1 and 2 COMPLETE — 2026-08-10.** Priority 1 (deployment) is verified
against a real stack: all four images built, `compose.prod.yaml` up with all seven services
healthy, all 42 migrations applied, and a real browser click-through passed (signup → verify →
login → org → Work shell with Chat/Docs/Calls/People rendering) — see the Priority 1 status
header for the four real bugs the smoke test found and fixed. Priority 2 (adversarial security
review of every §2.2 human-review surface) is also done: one confirmed finding — the SSRF
blocklist in `packages/security/src/outbound-url.ts` missed 63/64 of the IPv6 link-local range
(`fe80::/10` is first hextet `fe80`–`febf`, the check only matched `fe80`) — fixed with
boundary tests; full write-up in `ai/security-review-priority-2.md`. Priority 3 is COMPLETE —
§3.4 (device/session inventory + impossible-travel detection), §3.5 (org deletion) and §3.6
(self-serve DSAR export) all shipped — see the Priority 3 status header. Priority 4 is
underway: **Search (Phase 8) is COMPLETE as of 2026-08-11** — all three waves, spec:
`ai/phase-8-search.md` (read its own header: Wave 3 carried a premature SHIPPED marker for a
day, and item 1 of Priority 4 below records what was actually missing). **Automation
(Phase 10) and Analytics (Phase 11) are the remainder of Priority 4, and both are still zero
code.**

**CI ran against this branch for the first time on 2026-08-10 and found four more real
issues, all fixed the same day:** (1) `ip-address@5.9.4`, a transitive dependency of
`geoip-lite` (pulled in by Priority 3's impossible-travel geo lookup), carried a HIGH SSRF
CVE — reachable only through `geoip-lite`'s offline `updatedb` maintenance script, never the
runtime lookup path, but `pnpm audit` doesn't do reachability analysis and the fix (a pnpm
override pinning `>=10.3.1`) is trivial regardless. (2) `apps/web/Dockerfile` was the one of
the four Dockerfiles that actually ran as root — Trivy's misconfig scan (AVD-DS-0002) caught
it; item 1 below claiming "every image runs as non-root" was wrong until this fix swapped the
base to `nginxinc/nginx-unprivileged` (which moves the container's internal port from 80 to
8080 — `compose.prod.yaml` now maps `80:8080`; nothing changes for anyone hitting the app from
outside). (3) Semgrep flagged all four `proxy_pass` lines in `apps/web/nginx.conf` as a
"dynamic proxy host" risk — a false positive the rule can't distinguish from a real one: the
variable is a hardcoded literal set two lines above (`set $upstream_api api:3000;`), never
request-derived, and exists only so nginx re-resolves Docker's compose-network DNS per request
instead of caching it at startup. Suppressed inline with `# nosemgrep:` and a comment
explaining why, not disabled globally. (4) Two small lint errors in the Priority 3 diff
(`geo.ts`'s unnecessary type assertion, a test fixture's async function with no `await`) —
both mechanical, fixed with no behavior change.

**The first attempt at (2) and (3) both re-failed on the very next CI run, for two reasons
worth remembering rather than re-discovering:** Trivy's Dockerfile linter reads only the
instructions literally present in the file being scanned — it has no way to inspect a FROM
base image's own layers, so swapping to `nginxinc/nginx-unprivileged` (which already runs
unprivileged internally) still tripped AVD-DS-0002 until an explicit `USER nginx` line was
added, purely to make it visible to static analysis. And the first `# nosemgrep:` comments
were placed on the line ABOVE each `proxy_pass` — Semgrep only honors a suppression comment
trailing on the SAME physical line as the match, so all four were silently ignored. Both fixed
in a follow-up commit the same day; see that commit for the corrected placement of each.

Not a numbered roadmap phase — this is cross-cutting work found by auditing `main` directly
(grep, file counts, CI config — not just PLAN.md) for what genuinely blocks shipping, independent
of which product phase it falls under. Four priorities, sorted by importance; each becomes its
own implementation pass, most likely its own branch/PR once Priority 1 lands, the same convention
`phase-12-wave-2` and `phase-13-webrtc` already used.

Read this header before trusting a status marker anywhere else in this file — the same standing
lesson every other `ai/phase-*.md` in this repo states for itself.

---

## Why this file exists

Nothing here is new architecture. It is the gap between what PLAN.md describes and what `main`
actually has, found by checking the codebase rather than trusting the docs:

- **No deployment mechanism exists at all.** No Dockerfiles for the four app services, no IaC, no
  CD job in CI. `compose.yaml` only containerizes _dependencies_ (Postgres, MinIO, Mailpit,
  ClamAV, coturn) for local dev, never the app itself.
- **A "complete" phase had a silent-data-loss bug and a feature with a 100% failure rate since it
  shipped, and a clean `pnpm verify` never caught either.** Both were found in one afternoon by a
  human clicking through the real app against real Postgres/MinIO (see `ai/phase-13-webrtc.md`'s
  own addenda, 2026-08-10). That is not a one-off — CLAUDE.md's own history documents the same
  shape of bug recurring across Phases 4, 5, 6, 7, and 12. The fix is not a feature to build, it's
  a discipline: real click-through testing against Docker, on every phase marked done, is part of
  what "done" has to mean from here on.
- **PLAN.md's own launch phase (§13) names a third-party penetration test and paid external
  review of `auth`/`policy` before launch.** Neither has happened. This file's Priority 2 is not
  a substitute for that — it is the review that can happen without hiring anyone, done first.
- **Phase 12 Wave 2 shipped half of what it scoped.** Grepped, not assumed: no device/session
  inventory, no impossible-travel detection, no org deletion, no self-serve DSAR export anywhere
  in `apps/api/src` or `apps/web/src`. The design for all three already exists and was approved
  (`ai/phase-12-wave2.md` §3.4–§3.6) — this is implementation against a spec, not new design work.
- **Three whole product surfaces are zero code.** `ls apps packages` — no `search`, `automation`,
  `analytics` directory anywhere. Real product-completeness gaps, not safety gaps, which is why
  they are last.

## Priority 1 — Deployment mechanism

Blocks shipping regardless of how complete the product is: there is currently no way to run this
anywhere except `pnpm --filter X dev` on someone's machine.

**What's already true and does not need to change:**

- `apps/api`, `apps/realtime`, `apps/collab` all run via `tsx` even in their own `"start"` script
  (`"start": "tsx src/main.ts"`) — no compiled `dist/` anywhere. That's a legitimate lightweight
  production shape (install prod deps + `tsx`, run `pnpm start`), not a gap to fix by introducing
  a bundler.
- `apps/web` has a real `build` script (`tsc --noEmit && vite build`) producing static output.
- `apps/api` already has a `health.live` route (`router.ts`; it's in the public-route allowlist
  `apps/api/src/trpc/guardrails.test.ts` asserts). `realtime` and `collab` have no equivalent yet.

**Explicitly not in this wave:** an actual cloud account, a real domain/TLS cert, real Twilio/S3
production credentials. This wave makes the deploy MECHANISM real; pointing it at a real target is
a config/secrets exercise the user does once a host exists, not code.

### Priority 1 status — read this before touching any of it

**COMPLETE — verified 2026-08-10 by the first real `docker build` and `docker compose up` of
this stack** (Docker was available in the session that picked this up, unlike the one that
wrote the mechanism). All four images built; `compose.prod.yaml` came up with all seven
services healthy after four real bugs were found and fixed (item 9 below; also
`ai/deployment-runbook.md`'s failure-modes section). `pnpm format`, `pnpm verify` (54/54
tasks) and the guardrail selftest (11/11) are green on this branch, and the runbook was
written from the actual smoke test. Items 1–8 below are the original write-up of each shipped
piece; item 9 is the smoke-test addendum.

1. `apps/api/Dockerfile`, `apps/realtime/Dockerfile`, `apps/collab/Dockerfile` — multi-stage,
   `node:22-alpine`. Every workspace package's `package.json` is consumed as TypeScript SOURCE
   (each one's `"exports"` points at `./src/index.ts`, not a build output), so these install the
   FULL workspace (`pnpm install --frozen-lockfile`, no `--prod`) and copy in real package source,
   not just `node_modules` — `tsx` is a devDependency in all three despite being the declared
   `"start"` script's runtime. Manifests are copied one-by-one before source, so an
   application-code-only change doesn't invalidate the install layer. Each image runs as a
   non-root `taskflow` user and carries a `HEALTHCHECK` hitting its own `/health/live` (api,
   realtime) or `/` (collab — see next point).
2. `apps/realtime/src/gateway.ts` now answers `GET /health/live` and `GET /health/ready`
   (two-tier, mirroring `apps/api/src/server.ts`'s own routes) — this is a REAL code change,
   verified clean via `tsc --noEmit` and `eslint`. `apps/collab` needed NO code change: Hocuspocus's
   `Server` has no `onRequest` override in this codebase, so its default request handler already
   answers any GET with HTTP 200 — sufficient for a liveness check. (An `onRequest` hook was
   considered and rejected: Hocuspocus's `hooks()` chain only threads a hook's RETURN value
   forward, and using it to short-circuit with a thrown response risks an unhandled promise
   rejection, since `createServer`'s async listener isn't awaited by Node's http module — see the
   comment in `apps/collab/Dockerfile`.)
3. `apps/web/Dockerfile` + `apps/web/nginx.conf` — builds the static bundle (`vite build`, which
   needs `apps/api`'s source too, present as a type-only devDependency for the `AppRouter` type),
   serves it via nginx, which proxies `/trpc` and `/telephony` → `api:3000`, `/socket.io` →
   `realtime:3001` (WS upgrade), `/collab` → `collab:3002` (WS upgrade) — same-origin, matching
   `apps/web/vite.config.ts`'s own dev proxy block path-for-path, which CLAUDE.md is explicit
   matters for the `__Host-` refresh cookie's `SameSite=Strict` in production too.
4. `compose.prod.yaml` — postgres, minio (+ minio-init), clamav, an opt-in `coturn` (behind the
   `turn` compose profile), a one-shot `migrate` service (behind the `tools` profile — never runs
   as a side effect of `up -d`), and the four app services. Every secret is a REQUIRED
   (`${VAR:?message}`) substitution variable — `docker compose config` fails loudly, naming the
   variable, if one is missing. Verified with `python3 -c "import yaml; yaml.safe_load(...)"` and
   `docker compose --env-file <fixture> -f compose.prod.yaml config` (using throwaway fixture
   values) — both pass. **Not verified: an actual `build` or `up`.**
5. `docker/postgres/init-prod/05-set-passwords.sh` — the ONE thing `compose.prod.yaml` changes
   about role bootstrap versus dev. It runs after the SAME `01-extensions.sql`/`02-roles.sql`/
   `03-grants.sql` dev uses (mounted individually, unmodified — `04-test-database.sql` is
   deliberately excluded from prod) and `ALTER ROLE ... PASSWORD` for each of the 9 app roles,
   from required env vars. No role/grant logic was touched or reimplemented — CLAUDE.md lists
   `packages/db` as a human-review surface, and the safest change to a file like that is the
   smallest one.
6. `.env.prod.example` — every variable `compose.prod.yaml` substitutes, with generation commands
   for each secret. `.gitignore` updated (`!.env.prod.example`) so it isn't swallowed by the
   existing `.env.*` ignore rule.
7. `.github/workflows/cd.yml` — triggered by `workflow_run` on CI's completion (gated on
   `conclusion == 'success'`, so this repo never deploys something CI didn't pass), builds and
   pushes all four images to GHCR (SHA + `latest` tags, buildx with a per-service GHA cache
   scope), then a `deploy` job that no-ops with a `::notice::` (not a failure) when
   `DEPLOY_HOST`/`DEPLOY_SSH_KEY`/`DEPLOY_USER` repo secrets are unset, or SSHes in and runs
   migrate → pull → `up -d --remove-orphans` when they are. Verified: `python3 -c "yaml.safe_load"`
   only — **never run**, because doing so requires pushing to `main` or a real `workflow_run`
   event, neither of which happens from a feature branch.
8. `.github/workflows/ci.yml`'s `trivy` job — flipped `--scanners vuln,secret` to
   `--scanners vuln,secret,misconfig`, and updated its own comment, which explicitly said to do
   this once Dockerfiles existed ("today it finds zero config files... Add it back with the IaC").
   Not run locally (no Trivy here); it runs for real on the next push's CI, if
   `CI_SECURITY_ALWAYS` is on for that push (see ci.yml's own minute-budget comment — otherwise
   it only runs weekly/on dispatch).
9. **The first real `docker build`/`up` (2026-08-10) found four bugs that no static check could
   see — the exact failure class this file's "why" section exists to catch.** (a) The API
   refused to boot: compose passes every optional variable through `${VAR:-}`, and an empty
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`TWILIO_VERIFY_SERVICE_SID`/VAPID key failed
   `NonEmpty.optional()` validation. `apps/api/src/config/env.ts` now treats present-but-empty
   as unset (`OptionalNonEmpty`/`OptionalUrl`/`OptionalKey`), with tests. (b) `realtime` and
   `collab` crash-looped with `ERR_MODULE_NOT_FOUND` — their images lacked `apps/api` source,
   which the gateway code imports at runtime through `@taskflow/api`'s exports map (trust-proxy,
   tenancy/resolve, work/board, chat/channel, rtc/session, docs/page, richtext). Both
   Dockerfiles now `COPY apps/api`. (c) Every healthcheck failed on `localhost` — Alpine
   resolves it to `::1` first while the services listen IPv4-only, so `wget localhost:PORT`
   was refused with the process perfectly up. All four Dockerfiles AND the three compose
   `healthcheck:` blocks (which OVERRIDE the images' own HEALTHCHECKs — a two-source-of-truth
   trap worth knowing) now probe `127.0.0.1`. (d) `docker compose up -d` did NOT recreate
   containers after a same-tag (`:local`) rebuild — the running container kept the old
   healthcheck while the image carried the fixed one; the stack needed `--force-recreate`.
   After all four fixes: all seven services healthy, and a browser click-through passed —
   signup → verify (via psql, since the smoke-test SMTP is a dummy) → login → org creation →
   app shell with My tasks/Chat/Docs/Calls/People rendering and no console errors, with the
   per-IP login rate limiter firing as designed.

**All four "left" items from the original handoff are now done** — the runbook
(`ai/deployment-runbook.md`), the real Docker verification (this item), the full verification
suite, and the commit/push of this wave to `pre-launch-hardening`.

## Handoff — exactly what's left and how to do it

This section exists because the person picking this up next may be a different, less experienced
agent than the one that did the work above, and the recording bugs earlier in this project's
history are the concrete example of what happens when a plausible-looking change ships unverified
against a live stack. Follow this in order. Do not skip the verification steps to "save time" —
that is exactly the failure mode this file's own "why" section documents.

### Step 1 — Finish and verify Priority 1 (COMPLETE — 2026-08-10)

Everything in this step happened and is recorded in the Priority 1 status header and in
`ai/deployment-runbook.md`: the full verification suite is green, the real build/up succeeded
(after the four fixes in item 9), the browser click-through passed, the runbook was written
from the actual run, and the wave is committed and pushed to `pre-launch-hardening`. The
numbered instructions below are kept as the record of what was done — the parts still relevant
to a future reader are the failure classes named in items 2–4 below and the standing
instruction in item 5.

1. **Run the full verification suite** from the repo root:

   ```bash
   pnpm format
   pnpm verify
   node packages/guardrail-selftest/verify.js
   ```

   Fix anything that fails. `pnpm format` may reformat files this session touched (YAML/Dockerfile
   are not Prettier's concern, but `apps/realtime/src/gateway.ts` and `.github/workflows/*.yml`
   could be affected by whitespace rules — check `git diff` afterward and re-stage).

2. **Build every image and confirm it actually starts.** This requires Docker running locally
   (the user has it installed — see this file's own "why" section, "the user already runs Docker
   locally"). From the repo root:

   ```bash
   cp .env.prod.example .env.prod
   ```

   Fill in `.env.prod` with real generated values — every variable has a generation command in its
   own comment in that file (`openssl rand -hex 24` for the 9 Postgres role passwords,
   `openssl rand -hex 24` for MinIO credentials, the two `node -e "..."` one-liners for
   `MASTER_KEY_BASE64` and `JWT_SECRET`, `openssl rand -hex 24` for `TASKFLOW_*` again — do not
   reuse one value for two different variables). Set `WEB_ORIGIN=http://localhost` (matches the
   `web` service's `80:80` port mapping for a local test), `STORAGE_ENDPOINT=http://localhost:9000`,
   `MAIL_HOST`/`MAIL_PORT`/`MAIL_FROM` to anything non-empty for this smoke test (a real SMTP
   relay is not needed to prove the containers boot — mail delivery will just fail loudly in logs,
   which is fine for this step; do not spend time setting up real SMTP just to test the build).
   Then:

   ```bash
   docker compose --env-file .env.prod -f compose.prod.yaml build
   docker compose --env-file .env.prod -f compose.prod.yaml --profile tools run --rm migrate
   docker compose --env-file .env.prod -f compose.prod.yaml up -d
   docker compose --env-file .env.prod -f compose.prod.yaml ps
   docker compose --env-file .env.prod -f compose.prod.yaml logs api realtime collab web --tail 100
   ```

   **What "success" looks like:** every service shows `healthy` (or `running` for `web`/`minio-init`,
   which have no/one-shot healthchecks) in `ps`; `curl http://localhost/` returns the web app's HTML;
   `curl http://localhost/trpc/health.live` (or whatever the real route path is — check
   `apps/api/src/trpc/router.ts` for the exact procedure name) returns a 200. Then actually load
   `http://localhost` in a browser, sign up a fresh account, and click around Work/Chat at minimum —
   the same click-through loop this file's "Verification" section already commits to.

   **What to do if something fails:** read the container logs (`docker compose ... logs <service>`)
   before changing anything. Common failure classes to expect, given this was never run before:
   - A missing/misspelled env var → the Zod schema error names the exact variable; fix it in
     `.env.prod` and re-run `up -d` (no rebuild needed for an env-only fix).
   - `nginx: [emerg] host not found in upstream` → the `resolver 127.0.0.11` directive in
     `apps/web/nginx.conf` should prevent this by resolving at request time rather than nginx
     startup, but if it still happens, check that the backend service names in `nginx.conf`
     (`api`, `realtime`, `collab`) match `compose.prod.yaml`'s actual service names exactly.
   - A 403/signature error on file upload → re-read this file's own history further up
     (`ai/phase-13-webrtc.md`'s addenda) on the `Content-Length`-signature bug class before assuming
     it's a new bug; check whether `STORAGE_ENDPOINT` is reachable from wherever the browser is
     running the test from, not just from inside the compose network.
   - `permission denied` inside a container → likely the non-root `taskflow` user in
     `apps/api|realtime|collab/Dockerfile` lacking a permission the app needs at a path it's trying
     to write; these apps are stateless (no local writes expected), so this would be a real bug to
     fix in the Dockerfile, not a permission to bypass by reverting to root.

   Take down the stack when done testing (`docker compose --env-file .env.prod -f compose.prod.yaml
down -v` — the `-v` drops the test volumes; do NOT run this against a real deployment, only this
   local smoke test).

3. **Write `ai/deployment-runbook.md`.** Once step 2 has actually succeeded once, write the runbook
   from what you just did, not from theory. It must cover, at minimum:
   - Prerequisites (a Linux VM with Docker + Compose v2, this repo checked out, `.env.prod` filled
     in from `.env.prod.example`, DNS pointed at the host if using a real domain).
   - First deploy, in order: `docker compose --env-file .env.prod -f compose.prod.yaml build` (or
     `pull` if using CD's pushed images — set `IMAGE_TAG` to the desired SHA first), then the
     `migrate` profile run, THEN `up -d` — migrations always before the app containers start,
     never automatic, matching `compose.prod.yaml`'s own header comment.
   - Subsequent deploys: same order — `pull`, `migrate`, `up -d --remove-orphans`. This is exactly
     what `.github/workflows/cd.yml`'s `deploy` job already does over SSH; the runbook should say
     so and give the manual equivalent for when SSH deploy isn't configured yet.
   - Rollback: `IMAGE_TAG=<previous-sha> docker compose --env-file .env.prod -f compose.prod.yaml up
-d` rolls the app containers back; state that a migration is NOT automatically reversed by
     this (matching `pnpm --filter @taskflow/db migrate:down`'s existence as a separate, manual
     step) and that rolling back past a migration that dropped/renamed a column is a data-loss risk
     requiring a read of that migration's own `.down.sql` first.
   - Secrets rotation: for a Postgres role password, the two-step version is (1) `ALTER ROLE ...
PASSWORD` directly against the running database (NOT by re-running the init scripts, which
     only fire on an empty data directory), (2) update `.env.prod` and restart the one or two
     services that hold that role's URL. For `JWT_SECRET`, rotating it invalidates every live
     session — state that plainly rather than leaving it implicit.
   - TLS: this compose file deliberately terminates nothing — say what the operator needs to add in
     front of the `web` service (a managed load balancer, or another reverse proxy doing ACME) and
     that `WEB_ORIGIN`/`TELEPHONY_WEBHOOK_ORIGIN` must be the `https://` public URL once TLS exists,
     not `http://localhost`.
   - How to enable the `turn` compose profile safely (set `RTC_TURN_URLS`/`RTC_TURN_SECRET` for
     real in `.env.prod` FIRST, then add `--profile turn` to the `up -d` command — never the other
     way around, per the warning comment already in `compose.prod.yaml`'s `coturn` service).

4. **Commit and push.** Stage everything from `git status` on the `pre-launch-hardening` branch
   (this session already has an uncommitted working tree — check `git status` again before
   committing, in case step 1's `pnpm format` changed anything), write a commit message describing
   the deployment mechanism being added, and `git push -u origin pre-launch-hardening`. Then open a
   draft PR if the repo's own convention (this file's header, and `phase-12-wave-2`/
   `phase-13-webrtc`'s own PRs) is followed — check whether one already exists for this branch
   first.

5. **Update this file's status line and Priority 1 section** to reflect what actually happened in
   steps 1–4 — especially if step 2 surfaced and fixed a real bug, which should be documented the
   same way `ai/phase-13-webrtc.md`'s own addenda document the recording bugs: what looked right,
   what was actually wrong, how it was found. This is the standing instruction from the user who
   commissioned this file: **update this document before every push, for the life of this effort.**
   Do this before every subsequent push too, not just this first one.

### Step 2 — Priority 2: adversarial security review

Only start this after Priority 1 is fully committed, pushed, and (ideally) merged — don't interleave
them in one branch/PR, so a security finding's fix has a clean diff to land against.

Scope is copied verbatim from CLAUDE.md's own "Surfaces requiring human review" list — do not
narrow it and do not add surfaces not on that list without asking the user first:

```
packages/policy · packages/db · packages/security · apps/api/src/identity ·
apps/api/src/telephony (the spend gate, subaccount credentials, webhook.ts's signature
verification) · apps/api/src/rtc/turn-gate.ts and turn.service.ts ·
apps/realtime/src/rtc-rooms.ts and gateway.ts's rtc:signal handler ·
apps/collab/src/auth.ts and authorize.ts · apps/api/src/platform-admin ·
any webhook signature verification · any upload/download path · any code touching telephony spend.
```

Method: read every line in scope adversarially — assume nothing is safe because it passed review
once. For each file, ask: what happens with a malformed/adversarial input here, what happens if
this check is skipped or races, what happens if the caller is not who the code assumes. Report
findings using the `ReportFindings` tool if available in your environment (severity-ranked,
CONFIRMED vs PLAUSIBLE, file/line, concrete failure scenario) — if that tool isn't available,
produce the same structure as a markdown report. Fix what's concretely fixable in the same pass
(small, well-understood corrections); flag anything that needs a design decision or a human call
rather than guessing at one. State explicitly in the write-up that this is NOT a substitute for
the third-party penetration test PLAN.md §13 calls for before launch — it's the review that can
happen without hiring anyone, done first.

### Step 3 — Priority 3: Phase 12 Wave 2's unshipped remainder

**COMPLETE — 2026-08-10.** §3.4 (device/session inventory + impossible-travel detection), §3.5
(org deletion) and §3.6 (self-serve DSAR export) all shipped — see the Priority 3 status header
for what landed, the two real findings the §3.5 cascade audit surfaced (0040's "audit rows go with
it" was wrong for `audit.audit_log` — no FK possible on a RANGE-partitioned table — fixed by
0044's SECURITY DEFINER purge trigger), and the one named residual (carrier subaccount never
released at Twilio).

Same verification bar as every other wave: `tsc`/`eslint`/`vitest` on touched packages, `pnpm
format`, guardrail-selftest, and a real click-through against `docker compose up` (the ORIGINAL
dev `compose.yaml`, not `compose.prod.yaml`, is the right target for this kind of feature-level
testing) before merging. Update this file's status before pushing, per the standing instruction.

### Step 4 — Priority 4: Search, then Automation, then Analytics

Each is its own multi-week phase per PLAN.md's own estimates (~3wk / ~6wk / ~4wk) — do not attempt
to start more than one without checking in with the user first, and expect each to want its own
`ai/phase-N-*.md` spec written and approved before implementation starts, matching how every other
phase in this codebase was run (see `ai/phase-template.md` if one exists, or the shape of
`ai/phase-9-notifications.md` as a template for how much detail a phase spec here carries). Search
reuses `packages/filter`'s existing AST/compiler/evaluator (Phase 3) rather than building parsing
from scratch — read that package before designing the TQL text parser so the new syntax compiles
to the same tree the filter UI already produces.

## Priority 2 — Adversarial security review of the human-review surfaces

**COMPLETE — 2026-08-10.** Full read of every surface on CLAUDE.md's own §2.2 list, against
real code, looking for each file's failure mode rather than style. The complete report is
`ai/security-review-priority-2.md`; this section is the short version.

**One confirmed finding, fixed with tests:** `packages/security/src/outbound-url.ts`'s
`isBlockedIpv6` checked `plain.startsWith('fe80')`, but link-local is the whole `fe80::/10`
prefix — first hextet `fe80`–`febf`, so 63/64 of the range (`fe9f::1`, `febf::1`, ...) passed
the check and would have been fetched by the link-unfurl path despite being link-local.
Fixed with `/^fe[89ab]/i` (the exact `/10` range), plus boundary tests asserting the range is
blocked and the adjacent routable `fec0`–`feff` block (the rest of `fe80::/9`) is not — so the
fix cannot drift into over-blocking, which is its own bug.

**Everything else verified sound**, including the places a plausible bug was specifically
looked for: OAuth auto-link is safe only because BOTH providers prove the email
(GitHub requires `primary && verified`; Google requires the `email_verified: true` claim —
checked, not assumed); `linkUserId` travels only inside the signed state token minted by the
`selfRoute`/`stepUp` `oauth.startLink`, so it cannot be forged; the TURN gate's test asserts the
secret was never used; the realtime relay's `to` is a roster selector, never a routing key;
refresh-token reuse revokes the whole session; `fetchUnfurl` refuses redirects, checks every
resolved record, sends no cookies, and bounds everything. See the report for the two accepted
residual risks (DNS-rebinding window, no recording override).

Not a substitute for PLAN.md §13's third-party pentest — it is the review that can happen
without hiring anyone, done first. Scope was CLAUDE.md's own named list, verbatim:

`packages/policy` · `packages/db` · `packages/security` · `apps/api/src/identity` ·
`apps/api/src/telephony` (the spend gate, subaccount credentials, `webhook.ts`'s signature
verification) · `apps/api/src/rtc/turn-gate.ts` and `turn.service.ts` · `apps/realtime/src/rtc-rooms.ts`
and `gateway.ts`'s `rtc:signal` handler · `apps/collab/src/auth.ts` and `authorize.ts` ·
`apps/api/src/platform-admin` · any webhook signature verification · any upload/download path ·
any code touching telephony spend.

**Do not re-run this whole pass from scratch.** What to do instead when touching any of those
files: keep the report's "reviewed and verified correct" notes in mind (each names the load-
bearing property that a naive change would break), and remember the standing rule this file has
already stated twice — a green `pnpm verify` is not the same claim as "this works when you
click it." The third-party pentest before launch is still owed.

## Priority 3 — Compliance/identity gaps (Phase 12 Wave 2's unshipped remainder)### Priority 3 status — COMPLETE (2026-08-10)

Grep-verified absent, not assumed from a stale status header. Only 3 of 6 planned Wave 2 pieces
had shipped before this priority started — user suspension (`apps/api/src/platform-admin/router.ts:153`),
TOTP, OAuth. The design for the rest was already approved in `ai/phase-12-wave2.md`; all three
remaining pieces are now implemented and validated (`tsc`/`eslint`/`pnpm format`/guardrail-selftest,
API 54 files/829 tests, web 32 files/302 tests, both new migrations up→down→up):

- **§3.4 — Device/session inventory + impossible-travel detection — SHIPPED.** Migration 0043
  (`identity.sessions.country`, `identity.sessions.impossible_travel_at`),
  `apps/api/src/identity/geo.ts` (country lookup via `geoip-lite@1.4.10` — pinned because the 2.x
  line requires Node ≥ 24 and this stack runs Node 22 — plus an embedded, diff-reviewable
  country-centroid table and haversine), detection inside the single `issueSession` chokepoint so
  all four login paths (password, passkey, TOTP, OAuth) get it by construction,
  `auth.sessions.list`/`auth.sessions.revoke` (`selfRoute`s; revoke `stepUp: true`), and a
  Sessions section on the web account page (per-device sign out, current-session badge, "looked
  unusual" note, push-device count). Two design decisions worth recording because they are easy to
  break: **the geo lookup is fail-open AT THE CALL SITE, not only inside the lookup** —
  `countryOfIp` never throws AND `issueSession` wraps whatever lookup is injected in its own
  try/catch, because an informational control must never sit in the path that completes a sign-in
  (a test proves a throwing lookup still completes the login and stores `country = null`); and
  **the country is stored on EVERY session**, flagged or not, which is what lets the NEXT login
  compare against this one without a fresh lookup. Detection is distance-over-time — haversine
  between country centroids divided by the hours since the previous session's `authenticated_at`,
  flagging only a pair implying faster than 900 km/h — never country-change alone.
- **§3.5 — Org deletion — SHIPPED.** `platformAdmin.orgs.delete` (`platformRoute`, step-up
  baked in): the org must already be `'suspended'`, and the operator must type the org's actual
  slug into the confirmation field (the web Orgs tab renders both gates — a Delete button on
  suspended rows only, and a type-the-slug modal whose confirm stays disabled until the slug
  matches). The delete is ONE statement — `DELETE FROM identity.orgs` — and Postgres fans it out
  across Work/Chat/Docs/People/outbox through the cascading org_id foreign keys (the repo-wide
  audit: every direct `REFERENCES identity.orgs` FK cascades, including RTC's 0041/0042; the
  `people.membership_profiles`/`platform.outbox_dispatch` composite FKs cascade transitively).
  **Two real findings the audit surfaced that 0040's header had missed:** `audit.audit_log` has
  NO foreign key to `identity.orgs` at all — and cannot have one, because it is partitioned
  `BY RANGE (occurred_at)` and Postgres requires any FK on a partitioned table to include the
  partition key. Migration 0044 closes the gap with a narrow SECURITY DEFINER trigger
  (`platform.purge_org_audit`, the 0036 `operator_chain_hash` precedent): owned by the migrator,
  takes NO arguments (the org id always comes from the trigger's `OLD.id`, so no caller can aim
  it at an org of their choice), and sets `app.org_id` from `OLD.id` itself — because
  `audit.audit_log` is FORCE RLS keyed on `app.org_id` and the deleting path clears org context,
  so a naive DELETE would silently match zero rows. The final accountability record is the
  `orgs.delete` entry in the GLOBAL operator chain carrying org id, slug, member count and the
  confirmation slug typed; `platform.org_deleted` publishes with the SYSTEM_ORG envelope (added
  to the audit projection's NEVER_AUDITED). One residual named rather than fixed: a provisioned
  Twilio subaccount is frozen by the preceding suspend but never RELEASED at the carrier — the
  `comms.subaccounts` row cascades away, and releasing needs a carrier-delete capability the
  telephony module does not yet have.
- **§3.6 — Self-serve DSAR export — SHIPPED.** `people.profile.exportMine` (`selfRoute`)
  returns the caller's account data inline as one structured document — `identity.users` minus
  `passwordHash`, every membership joined with its org's name/slug (through the same
  SELECT-only self policies the org switcher uses), active sessions' metadata (no tokens — they
  only ever existed as hashes), linked OAuth identities (provider + email, never the provider's
  subject id), and the `people.profiles` row — all in ONE `withUserScope` transaction. The
  `user.data_exported` event records that the export happened, never its contents (the
  `compliance.exported` discipline). Web: the account page's "Your data" section downloads it
  as a JSON file. Product data the caller authored across Work/Chat/Docs is excluded per the
  spec's own §2 scope line — named there as real follow-up work, not hidden.

## Priority 4 — Missing product surfaces: Search, then Automation, then Analytics

Verified absent (`ls apps packages` — no `search`, `automation`, `analytics` directory anywhere).
Product-completeness gaps, not safety gaps — sequenced by how much a real user would miss each:

1. **Search (Phase 8, ~3wk) — ✅ COMPLETE 2026-08-11.** `packages/filter`'s AST/compiler/
   evaluator already existed (Phase 3); this added the TQL text parser onto it, cross-product
   indexing, saved searches and command-palette integration. Spec:
   [ai/phase-8-search.md](ai/phase-8-search.md).

   **Wave 3 was marked SHIPPED a day before it was**, and that is worth recording here rather
   than only in the phase spec, because this file's whole premise is auditing what `main`
   actually has instead of trusting a marker. The `/search` page landed; §3.2's saved searches,
   the transcripts the approval decision had deferred INTO Wave 3, and §3.1's builder ↔ TQL
   text box did not, and the spec then contradicted itself for a day ("Wave 3 is next" four
   sections below a header saying it had shipped). All three were built 2026-08-11 —
   migration 0046, a new `search:manage` permission, `search.searches`, `indexTranscript`, a
   `/calls?call=` permalink and the first UI in the app that actually renders a transcript
   (`telephony.recordings.transcript` had shipped in Phase 7 Wave 2 with no caller). Verified
   with `migrate:verify`, full `pnpm verify` (54/54, 854 API tests) and the guardrail selftest.

2. **Automation & integrations (Phase 10, ~6wk) — SPEC DRAFTED 2026-08-11, not yet approved:**
   [ai/phase-10-automation.md](ai/phase-10-automation.md). Rules engine on the existing
   domain-event bus (guardrail 6 already makes every mutation emit one), outbound webhooks,
   public API + scoped tokens, Slack/GitHub connectors, importers/exporters. The spec's own
   "checked, not assumed" pass found this phase is better provisioned than it looks: four
   working outbox consumers to mirror, the condition evaluator shipped in Phase 3, the SSRF
   gate, and BOTH token kinds (`tf_pat`, `tf_whs`) already minted in
   `packages/security/tokens.ts` with no callers — the Phase 7 Wave 1 shape again. Seven open
   decisions, of which the sharpest are where loop-protection depth lives (the envelope is
   `.strict()` and has no causation field) and whether cost-bearing actions are in scope at all.
3. **Analytics (Phase 11, ~4wk) — SPEC DRAFTED 2026-08-11, not yet approved:**
   [ai/phase-11-analytics.md](ai/phase-11-analytics.md). Velocity/burndown/CFD/cycle-time/
   workload dashboards and comms-spend reporting. **Not "read-only over data that already
   exists", which is what this file said before anyone checked** — `work.cards` stores only the
   present, there is no `completed_at`, no status-transition history and no sprint concept, so
   four of the six dashboards are questions the transactional schema cannot answer at all. The
   phase's spine is a transitions projection off the outbox.

   **The two specs share one ordering constraint, recorded in both:** Phase 11's only route to
   historical data is replaying `card.status_changed` out of `platform.outbox`, which has never
   been pruned. Phase 10 correctly proposes pruning it. Either Phase 11's backfill runs first,
   or the pruner excludes those events until it has — otherwise the history is destroyed with
   nothing failing to say so.

## Addendum — seed data coverage for the shipped surfaces

Outside the four priorities above, but load-bearing for demonstrating them: `packages/seed`
previously had zero coverage for in-app calling, notifications, or the device/session inventory
this Priority 3 shipped — a freshly seeded database could not show any of the three in the web UI
even though the backend was real. Closed as a follow-up, same verification bar as everything else
in this file (`tsc`/`eslint`/`vitest run`/`pnpm format` on `@taskflow/seed`, plus `@taskflow/api`
for the one new export map entry, guardrail-selftest):

- **`rtc.calls`** — `rtc.sessions`/`participants`/`recordings` for `dm`/`group_dm` channels only
  (public channels have no ring list — a still-open Phase 13 item, not a seed omission), holding
  the mesh cap and the recording-implies-answered-and-consented invariants the real CHECK
  constraints enforce.
- **`platform.notifications` + `platform.push_subscriptions`** — only `chat.direct` and
  `chat.mention` are seeded; the other five kinds the real projection derives need a card/page
  title `SeededCardRef`/`SeededPage` do not currently export, so inventing one would be exactly the
  "lie that looks like data" this package's other modules refuse — named in the module's own
  header as real follow-up, not silently dropped. `push_subscriptions` is its own module because
  its RLS is keyed on `app.user_id`, not `app.org_id`, which `ctx.orgScope` cannot express —
  it sets `app.user_id` directly, the same pattern `reset.ts`'s `findSeededOrgIds` already used.
- **`identity.sessions` (§3.4's device inventory)** — multiple devices per user, some revoked
  (an old device signed out), and at least one row with `impossible_travel_at` set. The flag is
  **computed**, not faked: the module imports the real `assessImpossibleTravel` from
  `apps/api/src/identity/geo.ts` (newly exported as `@taskflow/api/identity/geo`) and evaluates it
  against each user's own session list exactly as `issueSession` would, replaying
  `mostRecentActiveSession`'s "not revoked, not yet expired, most recent by `authenticatedAt`"
  query against the in-memory draft list. One user is guaranteed a flagged pair (two countries
  twenty minutes apart) rather than leaving it to chance across the demo profile's draws.

All three are wired into `platform.audit`'s `requires` — the pattern every leaf module in this
package's dependency graph must follow, since only modules reachable from that root ever run.

## Verification, for every wave of every priority

- `tsc --noEmit` + `eslint` + `vitest run` on touched packages, `pnpm format`, and
  `node packages/guardrail-selftest/verify.js` before pushing.
- Real `docker compose -f compose.prod.yaml up` and a real click-through happens on the user's
  machine (Docker installed there) before anything merges to `main` — the same loop that caught
  both real bugs in the WebRTC session this file's own "why" section cites. A green CI run is not
  the same claim as "this works when you click it," and this file exists partly because that
  lesson keeps needing to be relearned per phase.
- This file gets updated — status, what shipped, what was found, what's still open — before every
  push, for the life of this effort.
