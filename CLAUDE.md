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

5. **Anything security-relevant uses `@taskflow/security`.** `Math.random()` is banned
   everywhere, and importing `node:crypto` outside `packages/security` is a lint error — the
   point is that there is one file per primitive to audit, not that crypto is forbidden.
   Missing something? Add it there, where it gets reviewed.

6. **Every state-mutating service method emits a typed domain event** from `@taskflow/events`.
   Audit, notifications, search indexing, and automation all consume it. Enforced by a custom
   lint rule on `**/services/**`; the event goes to the outbox in the mutation’s own transaction.

7. **Feature flags gate product surface only.** Never put a security control behind a flag.

8. **Sockets broadcast; they never write.** All mutations go through the API, where validation,
   authorization, audit, and job enqueueing already live. Docs/Yjs is the one documented
   exception (§9).

---

## Surfaces requiring human review

AI may write anything, but changes to these need the author to read every line before merge
(PLAN.md §2.2):

`packages/policy` · `packages/db` · `packages/security` · `apps/api/src/identity` ·
any webhook signature verification · any file upload/download path · any code touching
telephony spend.

For these, a second adversarial AI pass in a fresh context is expected, not optional.

---

## Layout

```
apps/       api                              (arriving: web, realtime, collab, worker)
packages/   config, contracts, db, security, policy, events, mail, observability,
            feature-flags, guardrail-selftest        (arriving: ui)
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
- **Never write repository files from PowerShell.** Windows PowerShell 5.1 corrupts them three
  different ways: `Set-Content -Encoding utf8` adds a BOM (which broke CI — a BOM in
  `package.json` makes `JSON.parse` throw), the default adds CRLF (which breaks `run: |` blocks
  in bash), and `-Encoding ascii` silently replaces every non-ASCII character with a question
  mark, so section references and em dashes in comments turn to punctuation soup. Use an editor,
  or Node: `node -e "require('fs').writeFileSync('path', content, 'utf8')"`.
  `pnpm check:encoding` catches all three, but not writing the corruption is cheaper than
  repairing it.

---

## Current state

**Phase 0B and Phase 1 (identity) complete.** Next: Phase 2 — tenancy, authz & audit.

Password auth end to end (Argon2id + HIBP, email verification, lockout, refresh rotation with
reuse detection, session revocation, password reset), **passkeys** as the primary factor,
real SMTP delivery, and per-IP rate limiting at the gateway.

Two things about the shape of this slice are worth knowing before changing it:

**A token proves _who_, not _which tenant_.** `authenticate()` produces an
`AuthenticatedPrincipal` — user, session, credential-proof time — and `principal.org` is
`null`, because there is no membership table until Phase 2. `selfRoute` needs only the
principal and works today; `route({ permission })` additionally needs an org and therefore
denies with NOT_A_MEMBER. Deriving a role from a token claim would mean the caller's own
credential asserted their role, and a demotion would not take effect until the token expired.

**Passkey sign-in takes no identifier.** Credentials are discoverable
(`residentKey: 'required'`), so the ceremony never asks who you are — which is the one flow
here that cannot be used to enumerate accounts by construction rather than by careful
answering. Do not add `allowCredentials`.

What is enforced, and by what:

| Guardrail            | Mechanism                                | Proven by                          |
| -------------------- | ---------------------------------------- | ---------------------------------- |
| 1 branded ids        | `packages/contracts`                     | type-level tests                   |
| 2 no raw DB access   | ESLint import ban                        | guardrail-selftest                 |
| 3 RLS                | Postgres policies                        | `packages/db` tests, real Postgres |
| 4 fail-closed routes | `route({ permission })` + boot assertion | `apps/api` guardrail tests         |
| 5 generated client   | tRPC                                     | compile                            |
| 6 Zod at boundaries  | `.strict()` schemas                      | per-package tests                  |
| 7 banned constructs  | ESLint                                   | guardrail-selftest                 |
| 8 tenancy fuzz       | manifest-driven harness                  | `apps/api/src/testing`             |
| 9 authz matrix       | 235 role × permission assertions         | `packages/policy`                  |
| 10 human review      | this file, PLAN.md §2.2                  | people                             |
| 11 domain events     | custom ESLint rule                       | guardrail-selftest                 |

`node packages/guardrail-selftest/verify.js` proves the lint-enforced ones still fire — including
the negative cases, since a rule that reports correct code is one that gets switched off.

Identity integration tests run against real Postgres (`docker compose up -d`) and, for
passkeys, a real ES256-signing authenticator (`@taskflow/security/testing`). They assert the
properties that only a real execution can demonstrate: a duplicate signup stopped by a unique
index, two concurrent refreshes adjudicated by a conditional UPDATE, a lockout counter that
survives parallel guessing, a passkey assertion refused because the origin in the signed
client data was a lookalike domain.

**Two per-request controls that are easy to weaken by accident:**

- `API_TRUST_PROXY` defaults to `false`. Fastify's `trustProxy: true` — which this server
  shipped with — makes the client address whatever `X-Forwarded-For` says, so every per-IP
  limit becomes opt-out with one header. Use a hop count or a CIDR list.
- The tRPC Fastify adapter replaces the JSON parser with a pass-through, so `request.body`
  on every `/trpc` route is a **string**. Middleware that reads a field off it must parse
  first; `accountOf` in `middleware/rate-limit.ts` is the worked example, and the object-only
  version of it silently downgraded per-account rate limiting to per-address.

Roadmap and phase definitions: PLAN.md §13.
