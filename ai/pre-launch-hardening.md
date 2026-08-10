# Pre-launch hardening

**Status: Priority 1 (deployment) mostly shipped — see "Priority 1 status" below for exactly
what's done vs. left. Priorities 2–4 not started.**

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

**Shipped, and verified as far as `tsc`/`eslint`/YAML-parse/`docker compose config` can verify —
NONE of it has been through a real `docker build` or `docker compose up`, because this session's
sandbox has no Docker daemon (`docker ps` fails with "no such file or directory"). That real
verification — the thing this file's own "Why this file exists" section calls the one lesson that
keeps recurring across every phase in CLAUDE.md — has not happened yet for any of this. Doing it
is the single most important remaining step; see the handoff section below.**

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
   **Not verified** — the same no-Docker-daemon limitation blocks running Trivy locally; this will
   run for real on the next push's CI, if `CI_SECURITY_ALWAYS` is on for that push (see ci.yml's
   own minute-budget comment — otherwise it only runs weekly/on dispatch).

**Left in Priority 1 — see the handoff section immediately below for exactly how to do each one:**

- The runbook (`ai/deployment-runbook.md`) — not written yet.
- Real Docker verification of everything above — not done yet, blocked on this sandbox having no
  Docker daemon.
- `pnpm verify` / `pnpm format` / `node packages/guardrail-selftest/verify.js` on the whole
  repo — not re-run since the Dockerfile/compose/workflow work started (none of it touches
  application TypeScript except `apps/realtime/src/gateway.ts`, which was checked individually,
  but the full-repo pass hasn't run this session).
- Committing and pushing this wave to `pre-launch-hardening` — not done yet as of this note.

## Handoff — exactly what's left and how to do it

This section exists because the person picking this up next may be a different, less experienced
agent than the one that did the work above, and the recording bugs earlier in this project's
history are the concrete example of what happens when a plausible-looking change ships unverified
against a live stack. Follow this in order. Do not skip the verification steps to "save time" —
that is exactly the failure mode this file's own "why" section documents.

### Step 1 — Finish and verify Priority 1 (do this first, before anything else)

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

Design already exists and is approved — read `ai/phase-12-wave2.md` §3.4, §3.5, §3.6 in full before
writing any code; this is implementation against a spec, not new design work. Grep first to
reconfirm each piece is still actually missing (`ai/phase-12-wave2.md` may itself be stale — this
whole codebase's standing lesson is to check the code, not just the doc):

- §3.4 device/session inventory + impossible-travel detection — built from `identity.sessions`,
  `identity.refresh_tokens`, `platform.push_subscriptions`, which already exist; no new device
  concept per that section's own instruction.
- §3.5 org deletion — real, cascading, operator-triggered, irreversible, heavily audited. The
  riskiest single piece in this priority: before writing the delete path, do a repo-wide grep for
  every foreign key referencing `identity.orgs` (or any table that in turn references it) to build
  a complete cascade map — an incomplete one leaves orphaned rows in a tenant table, which is
  exactly the kind of defect guardrail 3 exists to make impossible for ordinary queries but cannot
  prevent for a DELETE issued by a privileged role.
- §3.6 self-serve DSAR export.

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

Not a substitute for PLAN.md §13's third-party pentest — explicitly scoped as the review that can
happen without hiring anyone, first. Scope is CLAUDE.md's own named list, verbatim:

`packages/policy` · `packages/db` · `packages/security` · `apps/api/src/identity` ·
`apps/api/src/telephony` (the spend gate, subaccount credentials, `webhook.ts`'s signature
verification) · `apps/api/src/rtc/turn-gate.ts` and `turn.service.ts` · `apps/realtime/src/rtc-rooms.ts`
and `gateway.ts`'s `rtc:signal` handler · `apps/collab/src/auth.ts` and `authorize.ts` ·
`apps/api/src/platform-admin` · any webhook signature verification · any upload/download path ·
any code touching telephony spend.

Read every line adversarially, report findings ranked by severity (the `ReportFindings` shape:
CONFIRMED vs PLAUSIBLE, file/line, concrete failure scenario), fix what's concretely fixable in
the same pass, flag what needs a human call rather than guessing.

## Priority 3 — Compliance/identity gaps (Phase 12 Wave 2's unshipped remainder)

Grep-verified absent, not assumed from a stale status header. Only 3 of 6 planned Wave 2 pieces
shipped — user suspension (`apps/api/src/platform-admin/router.ts:153`), TOTP, OAuth. Missing,
with the design already approved in `ai/phase-12-wave2.md`:

- **§3.4 — Device/session inventory + impossible-travel detection.** Built from data that already
  exists (`identity.sessions`, `identity.refresh_tokens`, `platform.push_subscriptions`) — no new
  device concept, per that section's own instruction.
- **§3.5 — Org deletion.** Real, cascading, operator-triggered, irreversible, heavily audited —
  not a key-based shortcut. The riskiest single piece: a repo-wide cascade-FK audit.
- **§3.6 — Self-serve DSAR export.**

## Priority 4 — Missing product surfaces: Search, then Automation, then Analytics

Verified absent (`ls apps packages` — no `search`, `automation`, `analytics` directory anywhere).
Product-completeness gaps, not safety gaps — sequenced by how much a real user would miss each:

1. **Search (Phase 8, ~3wk).** `packages/filter`'s AST/compiler/evaluator already exists (Phase
   3); this adds the TQL text parser onto it, cross-product indexing, saved filters, command
   palette integration. Reuses the existing filter package rather than building parsing from
   scratch.
2. **Automation & integrations (Phase 10, ~6wk).** Rules engine on the existing domain-event bus
   (`@taskflow/events` — guardrail 6 already makes every mutation emit one), outbound webhooks,
   public API + scoped tokens, Slack/GitHub connectors, importers/exporters.
3. **Analytics (Phase 11, ~4wk).** Velocity/burndown/CFD/cycle-time/workload dashboards and
   comms-spend reporting — read-only over data that already exists.

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
