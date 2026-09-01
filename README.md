# TaskFlow

Multi-tenant company platform: Work, Chat, Docs, Voice & Messaging, People, Platform.

Built solo with heavy AI assistance, on the premise that the author cannot catch every security
defect by reading diffs — so the architecture makes the dangerous mistakes impossible to express
rather than merely discouraged.

- **Plan:** [PLAN.md](PLAN.md) — architecture, security model, roadmap
- **Working agreement:** [CLAUDE.md](CLAUDE.md) — the rules that apply to every change
- **References:** [ai/](ai/) — architecture notes, security checklist, feature template

**Status:** Phases 0–8 complete, plus Chat, Docs, Search, Notifications (Phase 9), Automation &
webhooks (Phase 10), Sprints (Phase 10.5), People (Phase 11.5), the platform-admin console
(Phase 12 Waves 1–2), billing (Phase 12 Wave 3), in-app voice/WebRTC (Phase 13 Waves 1–2), and a
React Native mobile app (Phase 14). The web app (`apps/web`), API (`apps/api`), realtime and collab
gateways, worker, and mobile client all run. `CLAUDE.md`'s "Current state" section is the
authoritative, per-phase status of record; a few later specs in [ai/](ai/) still carry pre-build
"DRAFT" headers even though their code has shipped — read the newest `ai/phase-*.md` header
alongside `CLAUDE.md` before trusting any single marker. Still draft / not built: analytics
(Phase 11) and the Phase 12 Wave 4 plan catalog.

## Quick start

Requires Node >= 22.12 and Docker.

```bash
pnpm install
docker compose up -d          # Postgres, Mailpit (:8025), MinIO (:9001)
pnpm --filter @taskflow/db migrate:up
pnpm verify                   # lint + typecheck + test
```

See `CLAUDE.md` § Commands for the per-service dev commands (`pnpm --filter @taskflow/api dev`,
`… @taskflow/web dev`, and the realtime/collab gateways).

## Commands

| Command                                     | Purpose                                            |
| ------------------------------------------- | -------------------------------------------------- |
| `pnpm verify`                               | Lint, typecheck, and test every package            |
| `pnpm preflight`                            | Everything CI checks, locally, in one run          |
| `pnpm preflight --full`                     | Adds gitleaks, Trivy, and the full Semgrep ruleset |
| `pnpm verify:guardrails`                    | Prove the security lint rules still fire           |
| `pnpm check:encoding`                       | No BOM, no CRLF, no mojibake                       |
| `pnpm --filter @taskflow/db migrate:verify` | Migrations up, down, and up again                  |

Run `pnpm preflight` before pushing. It exists because several CI failures were caused by
assumptions that were never executed locally, and it is cheaper than a round trip.

## Layout

```
apps/       web, api, realtime, collab, worker   (arriving Phase 0B+)
packages/   config, db, observability, feature-flags, guardrail-selftest
docker/     compose config, Postgres init (roles + RLS)
scripts/    preflight, encoding, Semgrep rule verification
ai/         architecture, security checklist, feature template
```

## The parts worth knowing

**Tenant isolation is enforced by the database, not by queries.** Application code runs as a
Postgres role that cannot bypass Row-Level Security, so a query missing its org filter returns
zero rows rather than another tenant's data. See PLAN.md section 8.3.

**The security rules are self-testing.** `packages/guardrail-selftest` asserts every ESLint
guardrail still fires, and `scripts/verify-semgrep-rules.mjs` does the same for the custom
Semgrep rules. Both exist because a rule that silently stops matching is worse than no rule —
the protection is assumed but absent, which has already happened three times here.

**Unfinished modules ship behind feature flags** so `main` stays deployable throughout an
18-month roadmap.
