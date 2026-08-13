# TaskFlow deployment runbook

Companion to `compose.prod.yaml` (Priority 1 of `ai/pre-launch-hardening.md`). This
runbook was written from a real end-to-end smoke test of the stack on 2026-08-10 —
the first time any of it had been through an actual `docker build` and `docker
compose up` — so the failure modes below are the ones actually hit, not predicted
ones.

Read `ai/pre-launch-hardening.md`'s Priority 1 section for the design decisions
(Dockerfiles as tsx-run TypeScript-source images, same-origin nginx proxying for
the `__Host-` refresh cookie, the password-only Postgres role bootstrap) and for
the history of what the smoke test found and fixed.

---

## What you are deploying

Seven containers on one Docker host:

| Service    | What it is                                                          | Exposed                                                |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `postgres` | Postgres 17, roles bootstrapped with REAL passwords (init-prod/05)  | no                                                     |
| `minio`    | S3-compatible object storage (attachments, exports, recordings)     | 9000/9001 (needs public reach + TLS before real users) |
| `clamav`   | Attachment virus scanner (fail-closed)                              | no                                                     |
| `migrate`  | One-shot; applies migrations. Behind the `tools` profile.           | no                                                     |
| `api`      | Fastify + tRPC (port 3000)                                          | no                                                     |
| `realtime` | Socket.io gateway (port 3001)                                       | no                                                     |
| `collab`   | Hocuspocus docs gateway (port 3002)                                 | no                                                     |
| `web`      | nginx (non-root): static bundle + same-origin reverse proxy (:8080) | 80 → container's 8080                                  |
| `coturn`   | TURN relay for in-app voice. Behind the `turn` profile. Opt-in.     | host network                                           |

All app traffic enters through `web` on port 80: `/trpc` and `/telephony` →
`api`, `/socket.io` → `realtime`, `/collab` → `collab`. This is not a
convenience layer — the `__Host-taskflow_refresh` cookie is `SameSite=Strict`,
so the API must be same-origin with the app in production exactly as it is in
development (`apps/web/vite.config.ts`'s proxy block is the source of truth;
`apps/web/nginx.conf` reproduces it path-for-path).

TLS is NOT terminated anywhere in this stack — see "TLS" below. Everything
inside the compose network is plain HTTP by design.

## Prerequisites

- A Linux VM (Docker Desktop on Windows/macOS also works for a local smoke test;
  production is a Linux host). Docker + Compose v2 (`docker compose`, not the
  legacy `docker-compose`).
- The repo checked out on the host, and `.env.prod` present (from
  `.env.prod.example`) with every variable filled in. `docker compose config`
  refuses to start anything if one is missing — it names the variable.
- DNS pointed at the host if you are using a real domain.

### Preparing `.env.prod`

Every value must be freshly generated — reusing a dev-secret value from
`.env.example` in production defeats the point of the file. Each variable's
comment in `.env.prod.example` has its generation command. The ones to get right:

- The nine Postgres role passwords and both MinIO values: `openssl rand -hex 24`.
  **Hex only** for the Postgres ones — `docker/postgres/init-prod/05-set-passwords.sh`
  interpolates them into a single-quoted SQL literal and hex cannot contain a `'`.
- `MASTER_KEY_BASE64` and `JWT_SECRET`: the two `node -e` one-liners in the
  example file. They must differ from each other (enforced at boot).
- `WEB_ORIGIN`: the public origin users will load, e.g. `https://app.example.com`.
  It doubles as the WebSocket handshake allowlist and the passkey relying-party
  id, so it must match exactly what the browser sees (including scheme).
- `STORAGE_ENDPOINT`: reachable from the BROWSER, not just the host — presigned
  URLs are fetched directly by the client. Self-hosted MinIO: the public URL of
  the host's port 9000 (or a TLS'd reverse proxy in front of it).
- `MAIL_HOST`/`MAIL_PORT`/`MAIL_FROM`: a real SMTP relay. Mailpit is
  deliberately not in this stack.
- `API_TRUST_PROXY`/`REALTIME_TRUST_PROXY`: `1` trusts exactly one hop (the
  `web` nginx). If a second proxy (cloud load balancer) sits in front of nginx,
  it is `2`. Never `true` — that makes per-IP rate limits opt-out.
- Twilio / VAPID / OAuth / TURN: optional. **Leave them empty (or unset) and
  the corresponding feature is unconfigured-but-valid**: the API boots and the
  surface simply doesn't render / answers SERVICE_UNAVAILABLE. Note the
  empty-string rule below.

**Empty-string rule:** a variable that is present-but-empty in `.env.prod` is
the same as unset. Compose passes every optional variable through `${VAR:-}`,
which yields `''`; `apps/api/src/config/env.ts` now treats that as "not set"
(previously an empty optional — OAuth client ids, `TWILIO_VERIFY_SERVICE_SID`,
VAPID keys — failed boot validation; found by the first real `up`).

## First deploy

In this order, from the repo root:

```bash
docker compose --env-file .env.prod -f compose.prod.yaml build
# or, if using images pushed by CD: set IMAGE_TAG=<sha> in .env.prod and `pull` instead.

docker compose --env-file .env.prod -f compose.prod.yaml --profile tools run --rm ensure-roles
docker compose --env-file .env.prod -f compose.prod.yaml --profile tools run --rm migrate
docker compose --env-file .env.prod -f compose.prod.yaml up -d
docker compose --env-file .env.prod -f compose.prod.yaml ps   # all healthy
```

`ensure-roles` and migrations always run BEFORE the app containers start, and
never as a side effect of `up` — both sit behind the `tools` profile
deliberately, so a plain `up -d` could not run either by accident.

**Why `ensure-roles` runs before `migrate`, as a separate step:** roles are
NOT created by migrations — `taskflow_migrator` is deliberately `NOCREATEROLE`
(so a migration file, ordinary reviewed application code, can never mint a
Postgres role as a side effect of a routine deploy). `docker/postgres/init/
02-roles.sql` creates every role known at the time this cluster was FIRST
initialized, but `docker-entrypoint-initdb.d` never runs again after that —
so a role a later phase adds is invisible to an existing cluster until
something explicitly creates it. `ensure-roles` (`docker/postgres/
ensure-roles.sh`) is that something: it runs on every deploy, connects as the
Postgres SUPERUSER (the one identity allowed to create roles), and creates
only whichever of the sixteen roles this database does not have yet —
idempotent, so it is a no-op on every deploy after the one where a role is
new. `CREATE ROLE` alone grants nothing; the actual permissions a role gets
still come from a migration's own `GRANT`, reviewed as a separate change.

**What "healthy" means here:** every service shows `healthy` in `docker compose
ps` except `web` (running) and `minio-init` (exited 0 — it is a one-shot bucket
creator). The healthchecks are real two-tier probes: `api` and `realtime`
answer `/health/live` (process up, no DB) and `/health/ready` (DB reachable);
`collab` has no dedicated route and its check is any HTTP 200 from Hocuspocus's
default handler; `web`'s checks that nginx serves the SPA.

### First-deploy smoke test (the minimum to call it deployed)

1. `curl http://<host>/` returns the app HTML.
2. `curl http://<host>/trpc/health.live` returns `{"result":{"data":{"status":"ok"}}}`.
3. `curl 'http://<host>/socket.io/?EIO=4&transport=polling'` returns a `0{"sid":...}`
   handshake — proves the WebSocket upgrade proxy works.
4. `curl http://<host>/collab` returns HTTP 200.
5. In a browser: sign up a fresh account, complete email verification (real
   SMTP delivers it now), create an org, and click through Work and Chat at
   minimum. A green stack is not the same claim as "this works when you click
   it" — that sentence is why this file exists.

## Subsequent deploys

Same order every time:

```bash
IMAGE_TAG=<new-sha> docker compose --env-file .env.prod -f compose.prod.yaml --profile tools run --rm ensure-roles
IMAGE_TAG=<new-sha> docker compose --env-file .env.prod -f compose.prod.yaml --profile tools run --rm migrate
IMAGE_TAG=<new-sha> docker compose --env-file .env.prod -f compose.prod.yaml pull
IMAGE_TAG=<new-sha> docker compose --env-file .env.prod -f compose.prod.yaml up -d --remove-orphans
```

This is exactly what `.github/workflows/cd.yml`'s `deploy` job does over SSH
when `DEPLOY_HOST`/`DEPLOY_SSH_KEY`/`DEPLOY_USER` repo secrets are set: rsync
the SHA's `compose.prod.yaml`/`docker/postgres` from the CI runner (which
already has them from its own checkout) → ensure-roles → migrate → pull →
`up -d --remove-orphans`. Until those secrets exist, CD builds and pushes
images to GHCR and the deploy job prints a `::notice::` explaining that
nothing more happened.

The files are pushed to the host, not pulled by it — the target host holds no
GitHub credential of any kind and never itself contacts GitHub. That is
narrower than the Prerequisites section above requiring "the repo checked out
on the host": that requirement is for the manual first deploy, where an
operator runs `docker compose ... build` from local source. Once CD is
configured, `$DEPLOY_PATH` only ever needs `.env.prod` and whatever compose
files the last successful deploy rsynced in — a git checkout there is
optional going forward, not a standing requirement.

### Gotcha: changing a Dockerfile does not recreate a running container

`docker compose up -d` recreates a container when its compose service config
changes. If you change an image (a Dockerfile `HEALTHCHECK`, an `ENV`, a `CMD`)
but the image TAG and compose file are unchanged, `up -d` can keep the OLD
container running (the `:local` tag case hit this during the first smoke test —
the rebuilt image had the fixed healthcheck, the running container still had
the old one, and the container was marked unhealthy for a check its own config
no longer contained). After rebuilding an image locally, use
`up -d --force-recreate` (or `up -d --build`) so the running stack matches the
images you built. With SHA tags from CD this is a non-issue — the tag changes
every deploy — but it will bite any manual `docker build` + `up` loop.

### Gotcha: compose `healthcheck:` overrides the Dockerfile's

`compose.prod.yaml` defines `healthcheck:` blocks for `api`, `realtime` and
`collab`, and those OVERRIDE the `HEALTHCHECK` instruction in the images. If a
healthcheck misbehaves in the deployed stack, fix BOTH files — the compose block
governs this stack, the image instruction governs a standalone `docker run`.

## Rollback

```bash
IMAGE_TAG=<previous-sha> docker compose --env-file .env.prod -f compose.prod.yaml up -d
```

Rolls the app containers back to the previous images. **A migration is NOT
automatically reversed by this.** `pnpm --filter @taskflow/db migrate:down` is a
separate, manual step, and rolling back past a migration that dropped or renamed
a column is a data-loss risk — read that migration's own `.down.sql` first and
decide deliberately.

## Secrets rotation

- **Postgres role password** (two steps, in this order): (1) `ALTER ROLE ... PASSWORD`
  directly against the running database — NOT by re-running the init scripts,
  which only fire on an empty data directory; (2) update `.env.prod` and restart
  the one or two services that hold that role's URL (`docker compose up -d
--force-recreate <service>`).
- **`JWT_SECRET`**: rotating it invalidates every live session and every
  in-flight access token immediately. State that plainly to whoever asked for
  the rotation; schedule it as an outage window.
- **`MASTER_KEY_BASE64`**: re-encrypt anything encrypted under the old key (the
  app's key-id scheme in `@taskflow/security` is designed for this).
- **`TELEPHONY_INDEX_KEY`**: rotating invalidates every blind index — lookups
  stop matching (calls remain readable). A rotation is a reindex, not a restart.

## TLS

This compose file deliberately terminates nothing. Put a certificate in front of
the `web` service: a managed load balancer, or another reverse proxy doing ACME
(Caddy, another nginx). Once TLS exists:

- `WEB_ORIGIN` and `TELEPHONY_WEBHOOK_ORIGIN` must be the `https://` public URL,
  not `http://...` — the refresh cookie is `Secure` and the passkey relying
  party derives from the origin, and Twilio signs webhook URLs against the
  configured origin.
- Put TLS in front of MinIO's port 9000 too (or point `STORAGE_ENDPOINT` at a
  real S3/R2 endpoint) before real users upload anything — an attachment upload
  over plain HTTP is not something to ship.
- Set `WEB_HOST_BIND=127.0.0.1` in `.env.prod` before starting the reverse
  proxy. `web`'s own port mapping defaults to every interface (`0.0.0.0`) so
  the runbook's plain-HTTP first-deploy smoke test works with nothing else
  running — but that means it is still holding host `:80` when a
  freshly-installed Caddy/nginx tries to bind the same port for ACME, and one
  of the two fails with "address already in use" depending on start order.
  Binding `web` to loopback only frees the public port for the proxy while
  keeping `web` reachable through it (`reverse_proxy localhost:80` in a
  Caddyfile still resolves). `docker compose up -d --force-recreate web`
  applies the change to an already-running stack.

## Log visibility (Dozzle)

`dozzle` in `compose.prod.yaml` is a live log viewer for every container in this
stack (`docker logs -f`, per service, in a browser). It ships bound to
`127.0.0.1:8081` only — never set `DOZZLE_HOST_BIND=0.0.0.0`, since unlike `web`
it has no first-deploy reason to be briefly public, and reading it means
reading every container's stdout, including anything
`packages/observability`'s `REDACTION_PATHS` did not anticipate.

Expose it through the same reverse proxy already terminating TLS for `web`, at
a path, gated by HTTP basic auth. This is VM-only config — it does not live in
this repo, the same way no Caddyfile does. One shared operator credential is
enough; it is intentionally outside the app's own login/role system (it does
not reuse `taskflow_platform_admin` or any org-owner account) because Dozzle
has no concept of a Postgres role or a tRPC session to check against — the
proxy's basic-auth prompt is the entire access control, and it runs before the
request ever reaches the container.

Caddyfile addition (adjust the domain to match `web`'s existing block):

```
taskflow-demo.duckdns.org {
	# ... existing reverse_proxy for / -> localhost:80 (web) stays as-is ...

	handle /logs* {
		basicauth {
			# bcrypt hash, not the plaintext password — generate with:
			#   caddy hash-password
			<operator-username> <bcrypt-hash>
		}
		reverse_proxy localhost:8081
	}
}
```

**Use `handle`, not `handle_path`.** `handle_path` strips the matched prefix
before forwarding upstream — the natural choice, and wrong here. Dozzle's own
`DOZZLE_BASE` env var (set to `/logs` by default in `compose.prod.yaml`) makes
it render every asset and API path under that prefix; stripping the prefix on
the way in hands it a request it no longer recognizes as its own, and the
symptom is a blank page with `/main-<hash>.js` and `manifest.webmanifest`
404s in the browser console — those requests land on the domain ROOT instead
of `/logs`, where this stack's `web` service answers with ITS OWN SPA
fallback instead of a clean 404, which reads as "Dozzle is serving garbage"
rather than "the prefix got stripped twice." `handle` leaves the path alone,
matching what `DOZZLE_BASE` expects.

`caddy reload --config /etc/caddy/Caddyfile` picks it up without dropping the
existing TLS cert. Verify with a plain `curl -I https://.../logs/` first — a
401 with no prompt shown means the proxy is misrouting, not that auth is
working.

## Enabling the TURN profile (in-app voice relay)

Set `RTC_TURN_URLS` and `RTC_TURN_SECRET` to real values in `.env.prod` FIRST,
then add `--profile turn` to the `up -d` command — never the other way around.
The coturn service's `${RTC_TURN_SECRET:-CHANGE_ME...}` default is loud, not
enforced (compose resolves every service's interpolation before profile
filtering, so a `:?` there would break a plain `up -d`); the profile gate is
what actually keeps an unconfigured coturn from running. `network_mode: host`
is required (the per-call relay port range can't be port-mapped) and is
Linux-only. Verify the secret is real before ever passing `--profile turn`.

## The failure modes this runbook has already seen

All found on 2026-08-10 by the first real build/up — none of them were visible
to `tsc`/`eslint`/`docker compose config`, which is the entire argument for the
smoke-test step above. Full write-up in `ai/pre-launch-hardening.md`'s status
header:

1. **API failed boot on empty optional env vars.** `compose.prod.yaml` passes
   OAuth/Twilio/VAPID optionals through `${VAR:-}`, producing `''`, and
   `NonEmpty.optional()` rejected it. Fixed in `apps/api/src/config/env.ts`
   (present-but-empty ⇒ unset) with tests.
2. **`realtime` and `collab` crashed with `ERR_MODULE_NOT_FOUND`** — their
   images didn't carry `apps/api` source, which their runtime imports through
   `@taskflow/api`'s exports map. Fixed in both Dockerfiles (`COPY apps/api`).
3. **Every healthcheck failed on `localhost`.** Alpine's `localhost` resolves to
   `::1` first while the services listen IPv4-only, so `wget localhost:PORT`
   was refused with the process perfectly up. Fixed to `127.0.0.1` in all four
   Dockerfiles AND the three compose `healthcheck:` blocks (the compose blocks
   override the images — gotcha above).
4. **Compose did not recreate containers after an image rebuild** with the same
   `:local` tag (gotcha above) — the fixed image was running the old
   container config until `--force-recreate`.
5. **A live deployment's `migrate` step failed three separate times, on three
   separate deploys, each naming a different missing role** —
   `taskflow_billing_sweep`, `taskflow_ops_events`, then
   `taskflow_integration_auth` — each only discovered when a migration's own
   `GRANT` hit a role that did not exist. Root cause: that cluster was first
   initialized before those roles were added to `docker/postgres/init/
   02-roles.sql`, and `docker-entrypoint-initdb.d` never runs again against
   an existing data directory, so newer roles silently never landed on it.
   Manually creating the three missing roles over SSH unblocked the deploy
   each time, but that is a symptom fix repeated three times, not a closed
   gap — the next new role would have hit it a fourth time. Closed properly
   by `ensure-roles` (`docker/postgres/ensure-roles.sh`, wired into both this
   runbook's command sequence and `cd.yml`, ahead of `migrate`): idempotent,
   runs on every deploy, creates only whichever roles are still missing.

## Local smoke-test teardown

```bash
docker compose --env-file .env.prod -f compose.prod.yaml down -v   # -v drops the test volumes
```

`-v` deletes the Postgres/MinIO/ClamAV data volumes — do NOT run it against a
real deployment, only this local test stack.
