# TaskFlow — working agreement

Multi-tenant company platform: Work, Chat, Docs, Voice & Messaging, People, Platform.
Built solo with heavy AI assistance. **Security is the non-negotiable constraint.**

Full spec: [PLAN.md](PLAN.md). Deeper references: [ai/](ai/).

---

## The one thing to understand

This codebase assumes its author cannot catch every security defect by reading diffs. So the
architecture makes the dangerous mistakes **impossible to express** rather than merely
discouraged. Guardrails fail at compile time or in CI, never by relying on vigilance.

When a guardrail blocks you, that is the system working. **Never disable it inline.**
Fix the code, or — if the rule is genuinely wrong — change it in
`packages/config/eslint/security.js` with a comment explaining why, and add a case to
`packages/guardrail-selftest`.

`// eslint-disable` on a guardrail rule is never an acceptable fix.

---

## Non-negotiable rules

1. **All database access goes through `withOrgScope(orgId, fn)`** from `@taskflow/db`.
   Never import `pg`, `drizzle-orm/node-postgres`, or `@taskflow/db/client` elsewhere.
   Never add `org_id` to a WHERE clause — RLS enforces it. That is the point: forgetting it
   returns zero rows, not another tenant's data.

2. **Authorization goes through `can()` from `@taskflow/policy`.** Never compare roles
   inline. `role === 'admin'` outside `packages/policy` is a lint error.

3. **Env vars come from the validated Zod schema**, never `process.env` directly.

4. **Rich text is TipTap JSON, never HTML.** No `dangerouslySetInnerHTML`, ever.

5. **Anything security-relevant uses `@taskflow/security`**, never `Math.random()`.

6. **Every state-mutating service method emits a typed domain event** from `@taskflow/events`
   (arriving Phase 0B). Audit, notifications, search indexing, and automation all consume it.

7. **Feature flags gate product surface only.** Never put a security control behind a flag.

8. **Sockets broadcast; they never write.** All mutations go through the API, where validation,
   authorization, audit, and job enqueueing already live. Docs/Yjs is the one documented
   exception (§9).

---

## Surfaces requiring human review

AI may write anything, but changes to these need the author to read every line before merge
(PLAN.md §2.2):

`packages/policy` · `packages/db` · `packages/security` · `apps/api/src/auth` ·
any webhook signature verification · any file upload/download path · any code touching
telephony spend.

For these, a second adversarial AI pass in a fresh context is expected, not optional.

---

## Layout

```
apps/       web, api, realtime, collab, worker
packages/   config, db, observability, feature-flags, guardrail-selftest
            (arriving: contracts, policy, security, events, ui)
docker/     compose config + Postgres init (roles, RLS)
```

Two ESLint-enforced module boundaries carry the whole guardrail system:
`packages/db` exports only the tenant-scoped client; `packages/policy` is the only module that
may compare roles.

---

## Commands

```bash
docker compose up -d          # Postgres, Mailpit (:8025), MinIO (:9001)
pnpm verify                   # lint + typecheck + test — run before declaring done
pnpm format
node packages/guardrail-selftest/verify.js          # prove guardrails still fire
pnpm --filter @taskflow/db migrate:up
pnpm --filter @taskflow/db migrate:verify           # up -> down -> up
```

`pnpm verify` needs Docker running — the db tests hit real Postgres deliberately. RLS is a
database behaviour; a mocked version would only prove the test agrees with itself.

---

## Conventions

- **TypeScript strict**, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  No `any`, no `@ts-ignore`. `@ts-expect-error` needs a `TF-<n>` justification.
- **Branded ID types** (`OrgId`, `UserId`) — constructed only by parsers at trust boundaries.
- **Zod at every boundary**, `.strict()` by default.
- **Migrations** are paired `NNNN_name.up.sql` / `.down.sql`, expand-migrate-contract, never
  edited once applied.
- **Tests ship with the slice.** A slice with untested authorization is not done.
- **Comments explain why, not what.** Prefer a sentence about the failure mode being prevented
  over a restatement of the code.

---

## Current state

Phase 0A complete. Next: Phase 0B — `contracts`, `policy`, `security`, `events`, the
fail-closed route builder, and the tenancy isolation fuzz test.

Roadmap and phase definitions: PLAN.md §13.
