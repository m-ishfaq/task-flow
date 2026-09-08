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
`apps/api/src/telephony` (Phase 7 — the outbound spend gate, subaccount credential handling, and
`webhook.ts`'s signature verification; §6.1 of the phase spec named these before they existed) ·
`apps/api/src/rtc/turn-gate.ts` and `turn.service.ts` (Phase 13 — the TURN credential gate; an
open relay carries strangers' traffic on this deployment's bill, which makes it the WebRTC
analogue of the telephony spend gate) · `apps/realtime/src/rtc-rooms.ts` and `gateway.ts`'s
`rtc:signal` handler (the peer-id relay: a `to` used as a routing key rather than a roster
selector is a cross-room message-injection primitive) ·
`apps/collab/src/auth.ts` and `authorize.ts` (Phase 6 — the collab gateway's own handshake and
tree-permission resolution, the same severity as `apps/realtime/src/auth.ts`/`rooms.ts`) ·
`apps/api/src/platform-admin` (Phase 12 Wave 1 — the org-directory console that runs as
`taskflow_platform_admin`, the one role that can change another org's status, plus the
`withGlobalScope` carve-out that admits it in `packages/config/eslint/security.js`) ·
any webhook signature verification · any file upload/download path · any code touching
telephony spend.

For these, a second adversarial AI pass in a fresh context is expected, not optional.

---

## Layout

```
apps/       api
              src/identity   ⚠ auth, tokens, sessions, passkeys
              src/tenancy      orgs, memberships, teams, grants, audit projection
              src/work         projects, boards, lists, cards, ranking, rich text,
                               labels, checklists, custom fields, comments,
                               ⚠ attachments, filter wiring
              src/chat         channels, DMs, messages, threads, reactions
              src/docs         spaces, page tree, inherited-permission Target
                               building, page-version save/restore, comments,
                               suggestions, the backlinks relay, publish-to-
                               public, PDF export, page templates (Phase 6)
              src/platform-admin ⚠ Phase 12 Wave 1 — the org-directory console,
                               run as taskflow_platform_admin (the one role that
                               may change another org's status)
              src/rtc        ⚠ Phase 13 — in-app voice: call sessions authorized
                               through the CHANNEL (never a participant lookup),
                               and the TURN credential gate (turn-gate.ts)
            realtime           Socket.io gateway — broadcast only, never writes
              src/auth.ts    ⚠ handshake: token, origin, socket.data.identity
              src/rooms.ts   ⚠ room join = a fresh can() check
              src/rtc-rooms.ts ⚠ Phase 13 — a call room authorizes exactly like
                               its channel; three lines and a call to
                               authorizeChannelJoin, and it must stay that way
              src/relay.ts     the 'realtime' outbox consumer
            worker             background jobs (Phase 10) — takes only work
                               added from Phase 10 onward: the automation
                               engine, webhook delivery, the analytics rollup
                               refresh. The seven setInterval loops already
                               inside apps/api STAY there; a second consumer
                               process is what FOR UPDATE SKIP LOCKED and the
                               per-consumer outbox_dispatch were built for
            collab             Hocuspocus gateway (Phase 6) — the one process
                               allowed to write from a socket handler, and only
                               to docs.yjs_updates/docs.page_versions
              src/auth.ts    ⚠ handshake, adapted from realtime's to
                               onAuthenticate — verifyAccessToken directly, not
                               apps/api's authenticate() (see ai/phase-6-docs.md
                               §3.3's correction on approval)
              src/authorize.ts ⚠ page-tree permission resolution: loadPage's
                               ancestorIds -> pageTarget -> can(), the harder
                               version of rooms.ts's room-join check
            web                React 19 + Vite
              src/lib          tRPC client, session, query client, wire types
              src/components   primitives + app shell
              src/features     auth/ org/ work/ admin/
              src/telephony  ⚠ Phase 7 — the ONE outbound gate (spend cap,
                               geo, velocity, org freeze), subaccount
                               provisioning, webhook signature verification +
                               replay (Wave 1); numbers, calls, the consent
                               gate, recordings, transcripts, SMS threads,
                               STOP/UNSUBSCRIBE, card-attached recordings
                               (Waves 2–3); a spend-gated Verify capability
                               with no caller yet, and cost-attribution
                               reporting (Wave 4 — see status header, its
                               MFA half is not apps/api/src/identity work)
            mobile             Expo / React Native (Phase 14) — Android & iOS,
                               sharing @taskflow/contracts and the generated
                               tRPC client with apps/web (guardrails 1 and 5
                               extended to a third platform)
              src/lib          session (DI factory, refresh token in
                               Keychain/Keystore via SecureStore), org-gate,
                               socket (ported, reconnect-and-replay), trpc-
                               client, config (per-channel API base URL)
              app/             expo-router routes — Wave 1: auth + org gates,
                               one placeholder home screen proving the spine
packages/   client (shared Wire<T>, retry policy, optimistic-mutation
            contract — apps/web and apps/mobile alike), config, contracts,
            db, security, policy, events, mail, observability,
            feature-flags, guardrail-selftest, payments, seed, ⚠ storage,
            filter, telephony (carrier boundary + geo allowlist), tokens
            (shared color/radius/motion VALUES, kept in sync by hand with
            apps/web/src/styles.css's @theme block — not a build-time
            Tailwind dependency), ui (design system extracted from apps/web,
            Phase 6.5 Wave 3)
docker/     compose config + Postgres init (roles, RLS)
```

Two ESLint-enforced module boundaries carry the whole guardrail system:
`packages/db` exports only the tenant-scoped client; `packages/policy` is the only module that
may compare roles.

**There is no per-package `eslint.config.js`, and adding one switches the guardrails off.**
Flat config does not cascade: `eslint src` run inside a package finds that file first and never
reaches the root. Framework rules are composed at the root with a `files` scope instead. The
selftest asserts the computed config for `apps/web` still carries every ban.

---

## Commands

```bash
docker compose up -d          # Postgres, Mailpit (:8025), MinIO (:9001)
pnpm verify                   # lint + typecheck + test — run before declaring done
pnpm format
node packages/guardrail-selftest/verify.js          # prove guardrails still fire
pnpm --filter @taskflow/db migrate:up
pnpm --filter @taskflow/db migrate:verify           # up -> down -> up, on taskflow_test

pnpm --filter @taskflow/api dev                     # API on :3000
pnpm --filter @taskflow/realtime dev                # socket gateway on :3001
pnpm --filter @taskflow/collab dev                  # Hocuspocus gateway on :3002 (Phase 6)
pnpm --filter @taskflow/web dev                     # app on :5173, proxies /trpc + /socket.io
```

The web dev server PROXIES `/trpc` rather than the API enabling CORS. The refresh cookie is
`__Host-` prefixed and `SameSite=Strict`, so a browser on :5173 calling an API on :3000 is
cross-site and never sends it — and the obvious fix is to weaken the cookie for everyone.
Same-origin in development keeps it behaving exactly as it does in production.

`pnpm verify` needs Docker running — the db tests hit real Postgres deliberately. RLS is a
database behaviour; a mocked version would only prove the test agrees with itself.

**`test` is `"cache": false` in `turbo.json`, and must stay that way.** Turbo keys its cache on
file contents, and these suites assert against Postgres, MinIO and ClamAV — none of which are
inputs it can see. So a cached PASS records the verdict of a machine that may no longer exist.
This is not hypothetical: the ClamAV suite skips its live assertions when the scanner is not
answering, that skip was cached as a pass, and a genuinely failing test stayed green through a
full `pnpm verify` after the container came up. Caching a test whose result depends on the world
outside the repo turns a green run into a statement about the past. It costs about 35 seconds.

**A phantom `TS2307: Cannot find module` after installing a dependency is a stale
`tsconfig.tsbuildinfo`. Delete it.** `incremental: true` in `packages/config/tsconfig/base.json`
makes `tsc` persist its module-resolution results, and `node_modules` is not an input it tracks —
so adding a dependency does not invalidate the cache, and the compiler keeps reporting the
pre-install answer. The trap is that the error names a module that is demonstrably present, with a
`dist/index.d.ts` you can `cat`, so the search goes to the exports map, the `moduleResolution`
setting, and pnpm's symlinks — none of which are wrong. `--traceResolution` is what settles it, and
it settles it confusingly: passing the flag changes the compiler options, which discards the cache,
so the trace shows the module resolving perfectly while the plain run still fails.

```bash
find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
```

Left incremental deliberately rather than switched off. Unlike the cached `test` result above this
fails CLOSED — a false FAILURE, which stops and gets investigated, not a false pass that ships.
Non-incremental costs about 5 seconds per package on `apps/web` (22.6s vs 17.5s), which is not
worth paying on every run to avoid an error that announces itself. `*.tsbuildinfo` is gitignored,
so CI starts from a clean checkout and never sees this.

---

## Conventions

- **TypeScript strict**, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  No `any`, no `@ts-ignore`. `@ts-expect-error` needs a `TF-<n>` justification.
- **Branded ID types** (`OrgId`, `UserId`) — constructed only by parsers at trust boundaries.
- **Zod at every boundary**, `.strict()` by default.
- **Migrations** are paired `NNNN_name.up.sql` / `.down.sql`, expand-migrate-contract, never
  edited once applied. The one accepted exception is a correctness fix to a `.down.sql` that has
  never run against production data — e.g. commit `61da94d`, which added the `NO FORCE`/`FORCE`
  bracketing a `DELETE` under `FORCE ROW LEVEL SECURITY` silently needs — since a broken reversal
  path is only ever exercised by `migrate:verify` and a fresh CI checkout. A committed `.up.sql`
  stays frozen regardless.
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

**Later phases at a glance (added 2026-09-01 — the per-phase entries below had drifted behind the
code, the exact "a status marker is a claim, not a fact" failure this section documents for Phases
3.5, 5, 7 and 8, caught here in the governance doc itself).** Shipped since Phase 8, each with a
detailed entry somewhere below or a spec in [ai/](ai/): **Phase 9 (Notifications)** — bell,
digests, due reminders, web + Expo push (`apps/api/src/platform`, migration 0027); **Phase 10
(Automation & webhooks)** — the `apps/worker` consumers (migrations 0047, 0049, 0055), all four
waves (engine, webhooks, public API + scoped tokens, connectors and the flagged telephony
actions), not just Wave 1 — PLAN.md §13's roadmap row said "Waves 2-4... not started" until this
pass corrected it; **Phase 10.5 (Sprints)** — `work.sprints` (migration 0054), with the Phase 10.6
sprint-flow slices (all four) built on top — that spec's own header said only slices 1-3 were
built and "uncommitted" until this pass corrected it, past tense being the operative word: the
code has been in `main` for some time; **Phase 11.5 (People)** — `apps/api/src/people`,
`people.profiles` (migration 0030); **Phase 12 Wave 1 (org governance & platform admin)** and
**Wave 3 (Billing)** — see their corrected entries below, both of whose own spec headers said
"DRAFT, not yet approved for build" long after shipping; **Phase 13 Wave 2 (WebRTC
ringing/recording)** — see the Phase 13 section; **operator broadcasts** — migrations 0083–0084,
`apps/api/src/platform-admin/broadcast*.ts`; **Phase 14 (Mobile)** — a full Expo / React Native app
(`apps/mobile`) covering auth, Work, Chat, Docs, Calls, People and Billing, whose own spec header
(`ai/phase-14-mobile.md`) said "DRAFT, Wave 1 only" despite the shipped breadth until this pass
corrected it; **Phase 11 (Analytics)** — velocity, burndown, CFD, cycle time, workload, volume and
spend dashboards (`apps/api/src/analytics`, `apps/web/src/features/analytics`), whose own spec
header said "DRAFT... awaiting approval" the whole time; **Phase 12 Wave 4 (Plan catalog &
entitlements)** — the four-tier plan/override resolution in `apps/api/src/billing/
entitlement-resolver.ts` and its operator-facing editor in `plans-tab.tsx`, whose own spec header
said "DRAFT... nothing built" the whole time. **Both of those last two headers were corrected the
same day a real gap between them was found**:
`analytics`'s flag had existed in the registry since Phase 11 landed, but no analytics route ever
checked it, so every org on every plan received full analytics for free — the entitlement system
Wave 4 built to gate exactly this kind of module was never connected to it. Fixed by adding
`feature: { flag: 'analytics', ... }` to every route in `apps/api/src/analytics/router.ts` and
granting `analytics` to the `business` tier in `packages/seed/src/modules/billing.catalog.ts` —
the first real feature difference between `pro`
and `business`, which previously differed only on limits and price. When in doubt, open the
newest `ai/phase-*.md` and read its status header, remembering it too can lag the code — twice
more, in this case.

**One phase was missing from this list entirely, not just stale within it: Phase 15.** §1 (org-level
permission grants) shipped and was then substantially extended — see its own section below.
§2+§3 (the `AiProvider` abstraction and the token/spend budget gate), §4 Wave 1 (the tool-calling
assistant, read-only tools), §4 Wave 2 (single-card write tools plus confirm-before-execute), §4
Wave 3 (sprint planning tools) and §4.3's last item (`chat.post_message`) have since shipped too —
see their own sections below. That closes §4.3's entire wave order. `docs.create_page` — §4.1's
table named it, no wave scheduled it — has also shipped (title-only page creation; see its own
section), and so has the assistant's own missing frontend (`apps/web/src/features/ai`), found
while building §6. **This paragraph itself went stale the same way PLAN.md's roadmap table and
`ai/phase-7-voice.md`'s status header already did, for the identical reason: §5 (the standup
view), §6 (new-org Docs bootstrap) and §8 (onboarding/offboarding automation, a real six-of-ten
subset) shipped in later passes and this paragraph was never revisited to say so** — see each
one's own section below for what actually shipped and, for §8, what was deliberately left out and
why. §7 (GitHub PR review — its own spec flags this as needing a separate review pass) has since
started: Wave 1 (read-only PR tools for the assistant) shipped; the rest of §7 — write tools, the
webhook extension, the card↔PR link table — remains exactly as drafted in
`ai/phase-15-ai-copilot-and-permissions.md`, designed but not built. See "Phase 15 §7 Wave 1" below
for what actually shipped and why it turned out smaller than the spec's own text implied.

**Phase 0B, Phase 1 (identity), Phase 2 (tenancy, authz & audit) and Phase 3 (Work) complete** —
backend and `apps/web`.

**Phase 3.5 (Work UX) is COMPLETE** — spec in [ai/phase-3.5-work-ux.md](ai/phase-3.5-work-ux.md),
approved 2026-07-30. All three waves shipped: sidebar, optimistic mutations, inline create and the
detail modal; status, priority, group-by/sort-by and List view (migrations 0011/0012); then saved
views, bulk actions, My Tasks, the command palette and keyboard shortcuts.

**Phase 4 (realtime spine) is COMPLETE for its scoped waves** — spec in
[ai/phase-4-realtime.md](ai/phase-4-realtime.md), approved 2026-08-05. Wave 1 (the gateway, room
authorization, the `'realtime'` outbox consumer) and Wave 2 (the full event catalog, presence,
reconnect-and-diff) both shipped. Wave 3 — a persisted activity stream — is explicitly NOT in this
phase; §2 and §7.4 argue why, and it is a follow-up rather than an omission.

**Phase 5 (Chat) is COMPLETE** — spec in [ai/phase-5-chat.md](ai/phase-5-chat.md), all four waves.
Channels, DMs, threads, reactions, pins, read cursors, typing, file sharing, link unfurls, slash
commands, retention, legal hold, guest access and compliance export. Migrations 0017–0021, plus
0019 for display names, which §3.1 needed and did not have.

Nine things in that phase are controls that looked correct and were not — three found before the
header first said COMPLETE, six more found the same day, by manual testing against a running
instance, after it did. All nine are written up in the spec's status header. The first is the one
to read before touching chat authorization: **`closed` on a channel's `can()` target is the entire
model.** Without it every member reads every DM, and the decision trace says nothing is wrong. The
next one to read before touching the route-level permission gate: **`can()` with no target answers
from ROLE ALONE**, which silently refused every `guest` on every chat route — a role that grants
nothing by design — before the resource-aware check that would have consulted their tuple ever ran.
Not every one of the nine has a test that fails without the fix; the newest three (a UI that never
got built, a seed script drifted from the schema it seeds) had no test at all, which is why they
survived past a header that already claimed the phase done. A green `pnpm verify` is not the same
claim as "this works when you click it."

**Phase 6 (Docs) is COMPLETE — all four waves shipped.** Spec in
[ai/phase-6-docs.md](ai/phase-6-docs.md), approved 2026-08-06. Wave 1 shipped migration 0023
(`docs.spaces`, `docs.pages` — tree only, no body content), the inherited-permission `Target`
resolver (`apps/api/src/docs/shared.ts`), space/page CRUD and `movePage`'s reparent-and-rank
mechanics (`apps/api/src/docs`), and `apps/collab`'s authorization spine (`onAuthenticate` composing
token verification with the same tree-permission resolution, §3.3–§3.4), with an authz-matrix suite
proving `packages/policy`'s `nearestApplicable()` at genuine multi-level depth for the first time in
this codebase. Wave 2 shipped everything `apps/collab` exists for: migration 0024
(`docs.yjs_updates`, `docs.page_versions`, the `taskflow_collab` role), live Yjs sync over
Hocuspocus with durable WAL persistence (`beforeHandleMessage`, before-ack — not `onChange`),
snapshot-plus-tail replay on load (`onLoadDocument`), live-document content stripping via
compaction (`onStoreDocument`), and `apps/api`'s on-demand save/restore routes. Wave 3 shipped
comments and suggestions anchored via opaque, serialized Yjs `RelativePosition` bytes (migration
0025: `docs.comments`, `docs.suggestions`), proved to survive a concurrent edit landing before the
anchor rather than merely round-tripping unchanged, and backlinks — computed entirely by `apps/api`,
never by `apps/collab`, over a new `taskflow_backlinks` role holding a COLUMN-LEVEL grant on
`docs.page_versions` that excludes `state`, so the role that discovers which pages changed can never
read what changed. Wave 4 shipped publish-to-public, PDF export and page templates (migration 0026):
a page's `published_version_id` is a COMPOSITE foreign key into `docs.page_versions` — org AND page,
not just "some row exists" — so a published pointer can never name another page's or another
tenant's content even if application code got it wrong; the public read route
(`docs.public.getPage`) takes a plain, RLS-scoped `orgId` rather than a separate opaque token,
because it already re-checks `published_version_id IS NOT NULL` on every request, unlike a presigned
URL's independent capability; PDF export runs on `pdf-lib` (pure JS) rather than a headless browser,
split into a pure, testable layout pass and a separate byte-rendering pass; and both the public
route and PDF export independently re-validate `apps/collab`'s content whitelist rather than
trusting it already ran, because they are the first two Docs surfaces to serve content to an
audience with no authenticated session of its own to fall back on. Templates needed no new
permission at all — `space:manage`/`space:read` (already in the catalog since Wave 1) cover the
vocabulary, and using one is exactly `page:create`.

**Two bugs in Wave 2 had no failing unit test and were found only by a real end-to-end test** —
`apps/collab/src/gateway.integration.test.ts`, which boots a real gateway and drives it with the
official `@hocuspocus/provider` client over a real WebSocket, per this file's own standing lesson
that a green `pnpm verify` is not the same claim as "this works when you click it." First:
`onAuthenticate` set `data.context = {...}`, which `@hocuspocus/server`'s hook runner silently
discards — it only threads a hook's RETURN value forward, since `data` is a fresh per-call copy of
the real payload. Every real connection's `context` was empty, and every page open failed;
authentication itself still reported success, because it doesn't consult context, masking the bug
completely from anything short of an end-to-end run. Second: `restorePageVersion` originally
appended the restored state as a new WAL row, on the reasoning that a full Yjs state is a valid
`Y.applyUpdate` input — true, and irrelevant, since Yjs updates are additive CRDT operations and
reapplying an old state cannot undo a later edit; a page edited after its save point and then
"restored" came back as the union of both, not the restored text alone. Both are fixed and both
are documented in `ai/phase-6-docs.md`'s status header and in the affected files' own comments —
read those before touching `onAuthenticate`'s context handling or the restore path again.

**Wave 3's backlinks relay looked correct in the migration and passed both `tsc` and `eslint`, and
still failed the first time it touched a real database as the real role.** The claim query used
`FOR UPDATE OF pv SKIP LOCKED`, mirroring `claimPending`'s own outbox query — and Postgres refused
it with `permission denied for table page_versions`, even though `taskflow_backlinks`' column-level
grant (`id, org_id, page_id, created_at` — never `state`) was exactly what the migration intended.
Row-locking clauses need SELECT on every column of a table, not just the ones a query projects; a
migration review and a type checker both agree that looks fine, and only a real connection as the
real role disproves it. Fixed by dropping `FOR UPDATE` rather than widening the grant to get the
lock back — see `ai/phase-6-docs.md`'s status header and `packages/db/src/docs-backlinks.ts`'s own
comment for the accepted trade (two racing relay instances can now redundantly, but never
incorrectly, reprocess the same row).

**Wave 4's composite FK on `pages.published_version_id` caught this session's own test, not a bug
in the feature.** `wave4.service.test.ts`'s teardown originally deleted `docs.page_versions` rows
before clearing a page's published pointer, and Postgres refused it —
`update or delete on table "page_versions" violates foreign key constraint
"pages_published_version_fk"`. That is the constraint doing exactly its job: a published page can
never be left pointing at a version that no longer exists. Fixed in the test (clear the pointer
first, delete the version rows after — "children before parents," the same ordering
`tenancy-seed.ts`'s `clearTenant` already documents for Work), not in the schema.

### Email invitations (SHIPPED) — the gap `addMember`'s own doc comment named

`packages/db/migrations/0107_identity_invitations.*` · `identity.invitations` ·
`identity.invitation_lookup` · `apps/api/src/tenancy/{invitation.service,invitation-mail}.ts` ·
`tenancy.invitations` sub-router · `apps/web/src/features/auth/accept-invite-page.tsx` ·
`apps/web/src/features/admin/settings-page.tsx`'s `MemberSection`. Phase 2's own header named this
as a deliberate deferral, and `addMember`'s doc comment spelled out exactly what it would take:
"an invitations table, a mailed token, and an acceptance flow that decides what happens when the
invited address later registers by another route." This is that slice, unaltered in shape from
what was named seven phases ago.

**Two tables, not one — the same "resolve the tenant before you have a scope" problem
`comms.subaccount_orgs`/`billing.customer_orgs` already solved twice.** `identity.invitations`
carries everything about the invitation (email, role, status, who sent it) and is an ordinary
RLS-protected tenant table, read and written only inside `withOrgScope(orgId)` — every operation
on it (`createInvitation`, `listInvitations`, `revokeInvitation`) is called by an admin who
already knows which org they're acting in. `acceptInvitation` is the one caller who does NOT:
it is invoked by someone holding nothing but an opaque token, by definition not yet a member of
the org the token names, so there is no scope to open until the org is known.
`identity.invitation_lookup` (`token_hash -> org_id`, no more) exists solely to answer that one
question, over `resolveOrgByInvitationToken` (`packages/db/src/tenancy-directory.ts`) — the
identical `withGlobalScope` shape `resolveOrgBySubaccountSid`/`resolveOrgByStripeCustomerId`
already use, added to `scripts/check-migration-rls.mjs`'s `RLS_EXEMPT` list with the same "holds
nothing worth protecting, and the column set is the control" reasoning as its two siblings. Unlike
those two, this lookup answers to a caller who has already PROVEN possession of the credential (a
raw token, hashed before it ever reaches the resolver) — there is no signature left to verify
afterward, only pending/expiry/email checks the accept flow makes once inside the real scope.

**A separate flow from `addMember`, not a widening of it.** `addMember`'s existing contract —
instant, known-account-only, `NOT_FOUND` for an unregistered address — stays exactly as it was;
existing tests and its own route depend on that. `createInvitation` is a second door, always
mailed, always the same `{ status: 'invited' }` answer whether or not the address already has an
account — an admin cannot use it to learn anything about an address beyond what `members.list`
already tells them about their own org. `apps/web`'s Members section now offers only the second
door (the single "Invite" form calls `invitations.send`, not `members.add`) — not because
`addMember` was wrong, but because offering both would ask an admin to guess which one a given
address needs, and the invitation flow's answer is a strict superset of what instant-add could do.

**One row per pending invite, rotated on resend, never duplicated.**
`invitations_org_email_pending_key` is a partial unique index on `(org_id, lower(email)) WHERE
status = 'pending'` — re-inviting an address that already has a pending row can't create a second
one, so `createInvitation` ROTATES the existing row's token instead: a new hash, a fresh
`invitation_lookup` entry, and the OLD lookup row deleted in the same transaction. A stale earlier
email's link stops resolving an org the instant a newer one is sent, and the pending list never
shows the same person twice.

**Acceptance checks the invited EMAIL against the AUTHENTICATED caller's own account, not against
who clicked the link.** A forwarded invitation email must not hand away access to whoever happens
to be signed in when they click it. `acceptInvitation` reads the caller's own `identity.users` row
(no RLS — readable from any scope, the same reasoning `addMember`'s own comment gives) and refuses
with `FORBIDDEN` on a mismatch, naming the fix ("sign in with that address") rather than leaving
the reader to guess. Expiry is checked the same call, marking the row `expired` and deleting its
lookup entry rather than leaving a token that resolves an org forever with nothing behind it.

**Idempotent against a real race: the invited person joining some other way before they accept.**
If the org's admin adds the same address via `addMember`, or the person is added through automation,
between the invite being sent and being accepted, `acceptInvitation` does not attempt a second
membership insert (which would violate the unique `(org_id, user_id)` index) — it returns
`alreadyMember: true` and still marks the invitation accepted, emitting `invitation.accepted` but
NOT a second `member.added` (that event already fired from whichever path actually created the
membership).

**`member.added` fires from `acceptInvitation` exactly as it does from `addMember`** — every
existing consumer (audit, notifications, search indexing, the `member.added` automation trigger,
Phase 15 §8's onboarding checklist) keeps working with no separate case for "joined via invitation."
`invitation.accepted`/`invitation.sent`/`invitation.revoked` exist only for what `member.added`
cannot express on its own: which invitation this was, and its own lifecycle.

**The accept page is click-to-confirm, not auto-fire on mount** — the identical StrictMode/
mail-scanner reasoning `verify-email-page.tsx`'s own header documents at length, reapplied here
rather than relearned: a double-mounted effect can spend a single-use token with no observer left
to hear the result, and a security scanner following the link before a human sees it would burn it
silently. Requires a session (`requireSession` in `router.tsx`, not `requireOrg` — the whole point
of this page is reaching it with no org selected yet), and `beforeLoad` carries the token forward
into `next` so a visitor bounced to `/login` lands back here, still holding it, once signed in.

**Mobile got the functional swap, not the pending-invitations list.** `org-settings.tsx`'s "Add
member" form now calls `invitations.send` instead of `members.add` — the actual gap this feature
closes — but has no resend/revoke UI or pending list yet, a real, narrower scope for this pass
rather than an oversight this screen was built to ignore.

### Phase 15 §1 — org-level permission grants (SHIPPED, extended past its own spec)

`packages/policy/src/permissions.ts` (`GRANTABLE_PERMISSIONS`) · `authz.member_grants` ·
`apps/api/src/tenancy/member-grant.service.ts` · `apps/web/src/features/admin/settings-page.tsx`
(`PermissionsSection`) · `apps/mobile/app/(app)/permissions.tsx`. Spec:
[ai/phase-15-ai-copilot-and-permissions.md](ai/phase-15-ai-copilot-and-permissions.md) — its own
header names exactly what shipped and what is still just designed; §2 onward (the AI copilot
itself) has no code behind it yet.

**One org-level permission, given to one specific member on top of their role, with no resource
attached.** This is deliberately a SECOND mechanism from relationship tuples, not tuples stretched
to cover a shape they were not built for — `permissions.ts`'s own `ORG_LEVEL_PERMISSIONS` already
drew that boundary before this phase, and this phase does not remove it. `can()` composes role +
tuple + grant; a grant only ever ADDS capability, never narrows what a role already gives (taking
capability away from one member is a harder, explicitly deferred problem — see the spec's §9).

**Closed the telephony gap the phase exists to fix, then found and closed the same gap for
automation.** `call:place`/`call:read`/`sms:send`/`sms:read`/`phoneNumber:read` moved off the flat
Member role onto individual grants first (Wave 1, migration 0098 backfilling existing access so
nobody already using it was silently cut off). A follow-up pass added `automation:manage`,
`webhook:manage`, `integration:manage`, `apiToken:create`, and `apiToken:revoke` to the same list —
an org can now hand one Member the ability to build automation rules, or manage the webhook
registry, without promoting them to Admin. Safe for the identical reason it is safe for every
Admin: `automation.service.ts` asks no per-resource question when a rule is BUILT, because the
resource-aware question is asked again at EXECUTION, in the worker, against the rule owner's own
live permissions re-resolved on every run — granting the ability to build a rule never also grants
what a built rule can do.

**A full sweep found and fixed every remaining place a permission-gated control rendered
unconditionally.** The pattern report started with two live bugs: a Member opening Settings →
Billing got a raw "You do not have permission to do that" instead of the section simply not being
there, and the "Individual permissions" list itself disclosed which extra permission each colleague
held to anyone who could see the Members page. A search-first sweep across `apps/web` and
`apps/mobile` (deliberately done before any fixing, per the standing instruction that motivated it)
found the same shape repeated: telephony's Buy/Release buttons, Docs space creation and page
archive/restore, board/list/sprint management, comment moderation, card recordings, saved-search
sharing, and — found only by following the exact URL that had originally reported the bug, after
the sweep itself had already been declared done — the People page's "Manage member" edit form,
which rendered for anyone viewing a colleague's profile regardless of role. Every one of these is
now a boolean computed server-side from the real `can()` check (`SettingsCapabilities` for
org-level permissions, a per-row `capabilities` object for resource-scoped ones like
`board:update`/`space:manage`/`page:delete`), read by the client to decide what to render — never a
second authorization decision, and never assumed to be the last one: this sweep is the second time
this exact bug class was found in this codebase (the first is Phase 5's `closed`-target findings),
which is worth remembering the next time a permission is added to `GRANTABLE_PERMISSIONS` and every
one of its old unconditional display sites needs the identical re-check, not just the one that gets
reported.

**Hide entirely, except when the underlying data is already visible.** The default fix for a
control gated on a permission not every role holds is to hide it, not disable it — a disabled
control still discloses that the action exists and, to anyone who inspects the DOM, exactly how it
is wired. The one deliberate exception is the People page's "Manage member" section: job
title/department/work phone/manager are not privileged the way billing figures or another
colleague's individual grants are — they are already visible elsewhere on the same page as
read-only badges and an org-chart card — so a caller without `manageMembers` gets
`PersonFactsSummary`, the same four fields presented read-only, instead of nothing. Getting this
distinction right required checking, for each hidden section, whether hiding it actually withheld
information the viewer could not already see, not applying one rule everywhere.

**The one-member-one-permission add form became a bulk batch, on both platforms.** Both the member
picker and the permission picker in `settings-page.tsx`'s `PermissionsSection` are multi-select —
choosing 3 members and 2 permissions and submitting once grants the full 3×2 Cartesian product.
There is no new bulk server endpoint: `runGrantBatch` calls the existing single-pair
`memberGrants.grant` route once per pair in sequence, which is safe only because that route is
idempotent (granting something already granted returns the existing row) — a batch that fails
partway through a step-up prompt is retried from the start in full, and every pair before the
failure point silently no-ops rather than erroring or duplicating. The list gained the identical
batching in reverse (checkboxes + "Revoke selected"), which needed `member-grant.service.ts`'s
`revoke()` to gain the same idempotency `grant()` already had — without it, a retried revoke batch
would 404 on a pair it already revoked before the interruption and abort whatever was left selected.
A missing MEMBERSHIP still throws on either route; that is a different failure from "already
granted" or "already revoked", not the same one.

**Mobile had no Individual Permissions screen at all until this pass** — web-only since the
feature was built, a real gap rather than a deliberate platform difference, and one that mattered
more once the automation permissions became grantable too: before `permissions.tsx` existed, an
org running mobile-only had no way to hand one out. Built to the identical bulk-grant shape as web,
reusing the same mobile `useStepUp`/`StepUpSheet` pair `org-settings.tsx` already established.

### Phase 15 §2+§3 — the AI provider abstraction and budget gate (SHIPPED)

`packages/ai` · `packages/contracts/src/providers/ai-provider.ts` · migrations 0099–0100
(`ai.usage_ledger`, `platform.ai_provider_config`, `platform.ai_org_overrides`,
`billing.plans`/`billing.org_entitlements`'s `ai_token_budget_monthly_cents`) ·
`apps/api/src/ai` · a new `ai` sub-router on `platformAdmin`. Spec:
[ai/phase-15-ai-copilot-and-permissions.md](ai/phase-15-ai-copilot-and-permissions.md) §2, §3.
Deliberately NOT built in this pass: §4 onward (the assistant itself, the standup view, GitHub
PR review, onboarding/offboarding automation) — this is §2+§3 only, per the spec's own §10 build
order ("§2 + §3 in parallel... retrofitting spend tracking after the fact is the mistake to
avoid"), the identical order Phase 7 Wave 1 and Phase 13 Wave 1 both used.

**The ledger is `ai.usage_ledger`, not `platform.ai_usage_ledger` as the spec's draft said.**
The draft followed `platform.flag_overrides`'s shape throughout, which is right for the model
CATALOG (`platform.ai_provider_config` really is global — one row per configured provider/model,
no `org_id` at all) and wrong for usage, which is per-org data. A global table queried per org
would need `WHERE org_id = ...` in application code, which rule 1 bans outright. The ledger gets
its own schema instead, RLS-protected exactly like `comms.spend_ledger` — the telephony spend
gate this module directly mirrors.

**`platform.ai_org_overrides` fits neither `flag_overrides`' shape nor `spend_ledger`'s cleanly,
and got a third one.** It is operator-owned configuration, like `flag_overrides` — but unlike
that table it names one specific org per row, so it carries an `org_id` column, and
`scripts/check-migration-rls.mjs` is right to demand real RLS on any table that does. It gets
`identity.orgs`'s own two-policy shape from migration 0035 instead: the ordinary tenant-isolation
policy (so an org's own request can read which provider IT resolves to) plus a second permissive
policy naming `taskflow_platform_admin` (so the console can set an override for ANY org).
`taskflow_app` holds SELECT only — an org never writes its own override, only an operator does.

**The budget ceiling is resolved through the SAME four-tier entitlement chain Phase 12 Wave 4
built for telephony's cap, not a second override table next to it.** Migration 0100 adds one
column — `ai_token_budget_monthly_cents`, the identical nullable-ceiling convention as
`telephony_cap_cents` (NULL unlimited, 0 none-at-all) — to both `billing.plans` and
`billing.org_entitlements`, and `entitlement-resolver.ts`'s existing `pick(override, plan)`
resolves it for free. Building a parallel mechanism for one more ceiling would give an operator
two different places to look for "what limits does this org have" depending on which module they
mean.

**The budget gate can only ask "has this org already reached its budget," never "would this
call cross it" — a real, narrower guarantee than telephony's, not an oversight.** Telephony can
price a call before placing it (`TelephonyProvider.estimateCostCents`); an LLM completion's
token usage is not known until the response returns, so there is no honest pre-call estimate to
check against a remaining balance. `apps/api/src/ai/spend-gate.ts`'s own header states this
explicitly rather than inventing a token-count guess from prompt text that every provider's real
tokenizer would disagree with.

**No `estimated`/`actual` split in the ledger, unlike telephony's — the provider reports the
real cost inline, so there is nothing to reconcile.** `comms.spend_ledger`'s whole
`sumWithFallback` mechanism exists because a phone call's cost arrives asynchronously from a
carrier webhook; `AiCompletionResult.usage` is returned in the same response as the content, so
`ai.usage_ledger`'s numbers are final the moment they are written. A plain `SUM` is correct here
where it would be a bug for telephony.

**`completeGated` in `apps/api/src/ai/complete.ts` is the one call site permitted to call
`AiProvider.complete`, mirroring `checkOutboundAllowed`'s exact role for telephony.** The
property `complete.test.ts` exists to prove is the same one CLAUDE.md states for every spend
gate in this codebase: on a refused request, `provider.calls` (the `FakeAiProvider`'s own
inspection surface, built for exactly this) stays empty. When this section was written, nothing
in this phase called `completeGated` yet — the identical "ship the gate before the thing it
gates" state Phase 7 Wave 1 and Phase 13's TURN gate both shipped in. `assistant.ts`'s
tool-calling loop (§4 Wave 1, its own section below) is the first real caller, added the same
week.

**`packages/ai`'s `AnthropicProvider` authenticates over raw `fetch`, no SDK**, matching
`StripePaymentProvider`'s "one call in, one call out" shape. `system`-role messages are pulled
out of `AiMessage[]` into Anthropic's own top-level `system` field — its Messages API has no
system role inside the message array at all, unlike the OpenAI-shaped union `AiMessage` is
written to resemble. Membership-set (`.has()`) checks do that pulling, not `===`/`!==`
comparisons on `.role` — `packages/config/eslint/security.js`'s `roleMember`/`roleIdentifier`
guardrails ban any equality comparison naming `role`, on the theory that the shape is almost
always an inline org-role check drifting from `can()`. `AiMessage.role` is a different concept
(a chat turn's speaker) that the selector cannot distinguish by name alone, and per this file's
own rule the fix is in the code, not a guardrail exemption.

**`OpenAiProvider` and `GeminiProvider` (added after this section was first written) are the
second and third `AiProvider` implementations, added specifically so `resolveAiProvider` is a
real per-org CHOICE and not an Anthropic-shaped interface with one tenant.** Migration 0101
widened `ai_provider_config_provider_valid` from `('anthropic')` to
`('anthropic', 'openai', 'gemini')` — the expand half of expand-migrate-contract, no existing
row touched — and `provider-resolver.ts`'s `providerFor` switch, `provider-config.service.ts`'s
`CreateProviderConfigInput`, and the platform-admin router's `CreateAiProviderConfigInput` widen
to match. Each new provider is proven against the identical `describeAiProviderContract` suite
`AnthropicProvider` is, plus its own round-trip tests — the same "outgrowing an implementation is
a config change plus a green contract run" property `describeTelephonyProviderContract` and
`describePaymentProviderContract` already give their own modules. The two are NOT shaped alike
on the wire, and each owns a real translation, not a cosmetic one: OpenAI's Chat Completions API
already has `system`/`tool` roles inside the same `messages` array (closer to `AiMessage`'s own
union than Anthropic's content-block scheme), but has no `is_error` field on a tool message, so a
failed result is prefixed `Error: ` rather than dropping the signal. Gemini has no call-id concept
at all — a `functionCall`/`functionResponse` pair is matched by NAME, not an opaque id the
provider mints — so `AiToolCall.id` is synthesized as `"<name>::<partIndex>"` and decoded back on
the return trip; and `stopReason` cannot trust `finishReason` alone, because Gemini often reports
`STOP` on a turn that also asked for a tool, so `tool_use` is read off the presence of a
`functionCall` part instead. `rates.ts` carries each provider's own published list prices rather
than one blended figure, the same reasoning `RATES`' own header gives for Anthropic's three tiers.

**The provider catalog's write path lives in `apps/api/src/ai/provider-config.service.ts`,
gated entirely on `platformRoute`, and publishes through the injected `EventBus` rather than
the transactional outbox** — `taskflow_platform_admin` holds no grant on `platform.outbox`
(migration 0083's own header), the identical reason `flags.service.ts`'s `setFlag` and
`org-directory.service.ts`'s suspend/reactivate already publish the same way. Every API key is
envelope-encrypted under its OWN freshly generated data key — never a key shared across catalog
rows — the same "one wrapped key per row" shape `comms.subaccounts` uses, so retiring one
config's credential can never affect another's. The AAD reuses `identityFieldAad` (table +
column + row, no org) rather than a new helper: `platform.ai_provider_config` has no `org_id`
at all, the identical no-org shape `identity.totp_credentials` already uses that function for,
even though the row itself is not an `identity.*` table.

**`resolveAiProvider` needs no `withGlobalScope`, and deliberately does not use it** — reading
both `platform.ai_org_overrides` (RLS-scoped to the caller's own org) and
`platform.ai_provider_config` (no RLS at all, a genuinely global catalog) inside one ordinary
`withOrgScope` transaction works because RLS only restricts tables that declare it; a table
with none is visible to any scope. `apps/api/src/ai` is not on `withGlobalScope`'s short
exempt-module list (identity, people, platform-admin) and does not need to be.

**`@taskflow/ai`'s own `index.ts` re-exported `describeAiProviderContract` straight from
`contract-test.ts`, and crashed `apps/api`'s dev server the first time someone actually ran
it.** `contract-test.ts` imports `vitest` at module scope; re-exporting it from the package's
main entry drags `vitest` into the runtime graph of every consumer, and `vitest`'s `expect`
throws immediately ("Vitest failed to access its internal state") when there is no active
worker — which every real process outside `vitest run` is. `packages/telephony/src/index.ts`
already hit and fixed this EXACT bug for `describeTelephonyProviderContract`, with a comment
explaining it in detail; `@taskflow/ai` repeated the mistake rather than following that
precedent, and nothing in CI catches it because no test suite actually boots `apps/api` as a
live process — every test calls services or the tRPC router directly. Fixed the identical way:
the re-export is gone, `packages/ai/package.json` gained a `./contract-test` subpath export
(the four provider test files already imported the suite via a relative path, so nothing in
`packages/ai` itself needed to change), and `index.ts` carries the same explanatory comment
telephony's does. Found by the project owner running `pnpm --filter @taskflow/api dev` locally
— the one way to reach this that no test in this repo exercises.

**The "AI Models" tab the platform-admin router's own comment already named did not exist —
`apps/api/src/ai/provider-config.service.ts`'s CRUD had shipped with no caller in `apps/web` at
all, the identical "shipped backend, no consumer" gap this file's own "Phase 15 §4 — the
assistant's missing frontend" section already documents once for `ai.chat.send`.** Found the
same way: the project owner went looking for where to add a real provider and found nowhere.
Closed by `apps/web/src/features/platform-admin/ai-tab.tsx` — catalog list/create/rotate-
key/set-default, an org-override panel, and the cross-org spend report, wired into
`platform-admin-page.tsx`'s tab bar. One more real gap surfaced while building it:
`getOrgProviderOverride` existed (`provider-config.service.ts`'s own doc comment already called
it "for the console's per-org detail view") but had no route at all — `orgOverride.set`/
`.clear` could change an org's override with no way to read it back. Added
`platformAdmin.ai.orgOverride.get`, and gave `getOrgProviderOverride` the `operator` parameter
and `recordOperatorAction` call every other read in this file already has — it had neither,
because nothing had ever called it end to end before.

**The spend report showed a bare org uuid, and the project owner's own question — "how are we
calculating the cost, on what basis" — surfaced that the answer was nowhere in the UI either.**
`aiSpendReport` now joins `identity.orgs` (the exact same grant every other cross-org report in
`provider-config.service.ts`/`billing-directory.service.ts` already relies on) for `orgName`/
`orgSlug`, and sums `input_tokens`/`output_tokens` alongside `cost_cents` — real numbers already
sitting in `ai.usage_ledger`, not a re-derivation. `rates.ts` gained `rateFor(model)`, a read-only
lookup alongside the existing `costCentsFor`, so a row can report the published per-model rate it
was actually billed at. `SpendReportPanel` renders these collapsed behind a per-row expand
("40,000 input tokens at $0.80 / 1M tokens + 8,000 output tokens at $4.00 / 1M tokens"), hidden by
default so the table stays scannable.

**Explicitly did NOT start storing the actual prompt or response text, after asking rather than
assuming.** The obvious literal reading of "let me see the details" would be logging the real
messages sent to and from the provider — and `packages/ai`'s own `AiProvider` header already
states the reason not to: this is the one provider interface that moves org-authored CONTENT
(card text, chat messages, comments) to a third party, and persisting a second copy of that in an
operator-readable table is a real retention/redaction decision, not a UI affordance. Put to the
project owner directly rather than built silently; the answer was to show the computation's real
inputs (tokens, rate) instead, which is what shipped. `ai.usage_ledger` still carries no content
column of any kind — CLAUDE.md's own account of the schema (§2+§3's section above) remains
accurate unchanged.

**`aiAssistant` had never been granted to a single billing plan, which meant the entire assistant
surface — `/assistant`, the standup Narrate button, the §6 new-org setup dialog — was unreachable
for every org on every plan, found from a real report: a freshly created org's setup dialog never
appeared.** `entitlement-resolver.ts` only turns a flag on for an org when it appears in that org's
PLAN's `features` array, and `aiAssistant`'s own registry entry had said, since it was written,
"registered ahead of its first caller so the plan catalog has a name to grant the day §4 ships
one" — and then nobody ever came back to actually grant it once §4 shipped. `stage: 'in-progress'`
was the one honest marker left; every other launched, `perOrg` flag in the registry had a real
grant somewhere. This is `analytics`'s own bug (flag existed, no route ever checked it) in
reverse: here every route checks it, but no plan ever turns it on.

**Granted to all four tiers — free through business — each with its own AI spend ceiling in the
SAME nullable-ceiling convention `telephonyCapCents` already uses, added to `billing.catalog.ts`
rather than a migration.** A migration would be a one-time INSERT that a later catalog edit could
never reach — `packages/seed/src/modules/billing.catalog.ts`'s own header already explains why
this whole module calls the real `createPlan`/`updatePlan` platform-admin service functions
instead of writing rows directly, the identical mechanism this fix reuses rather than inventing a
second one. `aiTokenBudgetMonthlyCents` is bounded on every tier, including Business, rather than
following `automationRunsPerHour`/`turnIssuancePerDay`'s null-on-Business pattern — deliberately:
an LLM completion is real third-party spend (Anthropic/OpenAI/Gemini), the same unvetted
self-serve-checkout risk `telephonyCapCents`'s own comment already argues against leaving
unbounded on Business, not an internal cost like an automation run. Business's number ($100/month)
is the identical figure `telephonyCapCents` already uses for that tier.

**The read side of `aiTokenBudgetMonthlyCents` worked from the moment migration 0100 added the
column — `entitlement-resolver.ts`'s `pick(override, plan)` already resolved it correctly, because
`select()` with no column list reads every column. The WRITE side did not exist at all.**
`plan-catalog.service.ts`'s `PlanLimitsInput`/`CreatePlanInput`/`UpdatePlanInput` had no
`aiTokenBudgetMonthlyCents` field, and `createPlan`/`updatePlan` never touched the column — so
there was no way, even from the platform console, to ever set it to anything but the migration's
default of NULL. Wired the same way every other limit field already is: a new required field on
`PlanLimitsInput` (required, not optional — the same "a write tool that forgot to set it should
fail to compile" reasoning guardrail 6 gives for a domain event), read into `readPlans()`'s mapping,
written in `createPlan`'s insert, and diffed in `updatePlan`'s own `assign()` helper. The
platform-admin router's `PlanLimitFields` (shared between create and update) and `PlanRow` output
schema both widened to match, and `plans-tab.tsx`'s `EditLimitsDialog` gained a matching form field
— without it, an operator could see the catalog's seeded number but never change it for one plan
without editing code and re-running the reconcile script.

**Editing `billing.catalog.ts` alone does not retroactively touch `free`/`pro` on an existing
database — migration 0063 already seeded both of those two ids directly, and this seed module
treats an existing plan id as `reused` (a no-op) unless `ctx.reseedPlans` is explicitly true.**
0063's own header states why it seeded `free`/`pro` at all rather than leaving the catalog module
to create everything: `identity.orgs.plan_id`'s foreign key needed something to reference before it
could be added, so those two ids exist in every database ahead of this module ever running, with
whatever feature list 0063 hardcoded at the time (no `aiAssistant` — it did not exist yet). Getting
the new grant onto an already-seeded database is `pnpm --filter @taskflow/seed plan-catalog-reconcile`
(or a fixture reseed with `--reseed-plans`) — not a migration, per the project owner's own
instruction, and not automatic from editing the catalog literal alone.

**No test in this codebase exercises `createPlan`/`updatePlan` directly — a pre-existing gap, not
one this pass introduced, and not closed here either.** `plan-catalog.service.test.ts` only tests
`setOrgEntitlements` (the per-org override, a different interface entirely, with no
`aiTokenBudgetMonthlyCents` field of its own — out of scope for this pass, which was about the
PLAN ceiling the project owner asked for, not a second per-org override). Building real DB-backed
coverage for the plan-catalog write path is real, separate work.

**The grant above still did nothing for a brand-new org, found the same day from a real run —
`createOrg` never places a new org on `free`.** It writes `plan_id = 'trial'` directly (migration
0094's own non-purchasable, `is_active = false` tier, "every new organization starts here"), and
`trial` is not one of `CATALOG`'s four owner-facing tiers — so neither `billing.catalog.ts`'s own
seed loop nor `plan-catalog-reconcile.cli.ts` had ever looked at it. The identical class of bug
`aiAssistant`'s own flag entry already caused once (a grant that reaches nowhere), recurring one
tier lower and caught only by actually running the reconcile script and checking a fresh org
against it.

**`TRIAL_PLAN` is a second constant, exported alongside `CATALOG` but never folded into it —
`trial` fails every property that array is FOR.** `CATALOG` is the owner-facing catalog: what a
person can buy, most with a real price and a Stripe product. `trial` has neither, and must never
be reached through `createPlan`, which hardcodes `isActive: true` on every row it creates — `trial`
has to stay `is_active = false` forever (0094's own comment: never in the upgrade picker, never
operator-assignable). So `TRIAL_PLAN` is only ever passed to `updatePlan`, on the standing
assumption that migration 0094 already created the row — which every migrated database has,
before any seed script runs. Both the seed module and the reconcile CLI now validate its feature
names and reconcile it (the seed module gated on the identical `ctx.reseedPlans` flag every
`CATALOG` tier already uses; the CLI unconditionally, gated only by its own `--dry-run`), right
after their existing per-tier loop — a missing `trial` row at that point throws loudly rather than
silently creating one, since that would mean 0094 was rolled back without being re-applied, a real
anomaly worth surfacing rather than papering over.

**Every number on `TRIAL_PLAN.limits` mirrors 0094's own INSERT literally, except the new AI
field.** Reconciling `trial`'s telephony/automation ceilings to anything other than what that
migration deliberately chose would be this file silently overriding a decision it was never asked
to revisit. `aiTokenBudgetMonthlyCents: 100` follows 0094's own stated reasoning for its telephony
cap exactly — "enough to prove the feature works, never enough to be worth abusing" — applied to
the one ceiling that migration predates and could not have set.

**None of the three real `AiProvider`s ever put a timeout on their own outbound `fetch` call —
found from a real report of the assistant page's Approve/Decline buttons staying disabled
forever, with "Thinking…" never clearing.** A stalled connection to the provider (a TLS hang, a
connection accepted and never answered — real, if rare, failure modes for a third-party HTTPS
endpoint this deployment does not control) left `AiProvider.complete`'s promise pending
indefinitely, and every control gated on the assistant page's one mutation (`turn.isPending`) —
Approve, Decline, the composer, the send button — is disabled for exactly as long as that promise
takes to settle. A promise that never settles is a UI that never recovers, with no error to show
and no route back except a hard reload.

**`packages/ai/src/timeout.ts`'s `COMPLETION_TIMEOUT_MS` (90s) plus `signal:
AbortSignal.timeout(...)` on each provider's `fetch` call is the fix — the identical mechanism
`apps/worker/src/webhooks/delivery.ts`'s own `TIMEOUT_MS` already uses for the same "bound a
request to a third party this deployment does not control" problem.** A timed-out `fetch` REJECTS
rather than hanging, which is a case every provider's code already handles correctly (the same
path an ordinary network failure or a non-2xx response already takes) — so the fix needed no new
error handling, only a bound on how long the attempt gets before it counts as one. 90 seconds
rather than `delivery.ts`'s 15: a webhook is one HTTP round trip to an endpoint an operator
configured; a completion is a real LLM inference call, slower by nature and slower still with
tools attached or a large system prompt, so a much tighter bound would misclassify a legitimately
slow-but-working answer as wedged. This bounds each INDIVIDUAL provider call, not
`ai.chat.send`'s whole request — a multi-round tool-calling turn (up to `MAX_TOOL_ITERATIONS`
real completions) can still legitimately take longer in total; the fix is that it now always
either finishes or fails within a bounded time, never hangs forever on one stuck call within it.

**Each provider's own test file gained a case proving a real `AbortSignal` is actually attached to
the request, not just that the timeout constant exists somewhere.** `capturedInit?.signal` is
asserted to be an `AbortSignal` instance and not yet aborted — proving the wiring reaches the real
`fetch` call, the same "test the property, not that it compiles" standard this package's other
provider tests already hold themselves to.

### Phase 15 §4 Wave 1 — the tool-calling assistant (read-only tools, SHIPPED)

`apps/api/src/ai/{router,assistant,complete}.ts` · `apps/api/src/ai/tools/` ·
`apps/api/src/search/search.service.ts` · `ai.chat.send`. Spec:
[ai/phase-15-ai-copilot-and-permissions.md](ai/phase-15-ai-copilot-and-permissions.md) §4, §4.3.
Deliberately NOT built in this pass: §4's write tools and confirm-before-execute (§4.2), the
standup view (§5), new-org Docs bootstrap (§6), GitHub/PR integration (§7, its own spec explicitly
flags it as needing a separate review pass), and onboarding/offboarding automation (§8) — this is
Wave 1 only, per §4.3's own order ("read-only... proves the UX and the token ledger with the
least risk"). _(Wave 2 — single-card writes and confirm-before-execute — has since shipped; see its
own section below.)_

**`AiMessage` shipped in §2 could not actually hold a multi-turn tool-calling conversation, and
nothing caught it until this wave tried to build one.** The original type was a flat
`{ role: 'system' | 'user' | 'assistant', content: string }` — plausible, unremarkable, and wrong
the moment a second turn needed to reference a tool call from the first: Anthropic's API rejects a
`tool_use` content block that is not followed, in the very next turn, by a `tool_result` block
naming the same id, and a flat string had nowhere to put either. `AiMessage` is now a
discriminated union (`system` / `user` / `assistant` with an optional `toolCalls` array /
`tool_result` naming a `toolCallId`), and `packages/ai`'s `AnthropicProvider` maps each variant to
Anthropic's actual content-block wire shape (`anthropic.test.ts`'s two new cases assert the
round-trip, including that a `tool_use` block replays as content, not as flattened text). This is
exactly the kind of gap §2's own contract test could not have caught: nothing in Wave 1's tests
ever sent a second turn.

**The client owns conversation history; the server owns the system prompt.** `ai.chat.send` is
stateless — no `ai_conversations` table, no server-side session. The caller resends the growing
`messages` array every turn (capped at 40, matching `search.query`'s own input-size hygiene, not a
product decision about conversation length), and `runAssistantTurn` prepends its own system prompt
before calling the model and never returns it — so the array a caller stores after one turn is
exactly what it sends as the next turn's input, with nothing to strip back out. A persistent,
multi-conversation history is real, separate work this wave does not need to prove the loop or the
budget gate.

**Every round of a multi-round tool-calling exchange is its own priced completion — there is no
"free" intermediate call.** A model that requests a tool, reads the result, and asks a follow-up
question has made TWO real completions, both budget-gated through `completeGated`, both real rows
in `ai.usage_ledger`. `assistant.test.ts` asserts the row count directly rather than trusting the
loop's own bookkeeping.

**The loop is bounded (`MAX_TOOL_ITERATIONS = 6`) because a tool-calling conversation can
genuinely spin** — a model retrying its own tool call, or misreading a result as "try again" —
and the bound exists to cap the blast radius of that to one request, the same reasoning
`search.query`'s own result limit bounds a fan-out rather than trusting the caller to ask
reasonably. `assistant.test.ts` proves it by queuing ten consecutive tool-call responses from a
`FakeAiProvider` and asserting the loop throws `AssistantLoopExceededError` rather than running
forever.

**Tool execution is sequential, not `Promise.all`, even though Wave 1's only tool (`search`) is
read-only and side-effect-free.** A future write tool's ordering must not depend on which of
several concurrent promises a JavaScript runtime happens to settle first — paying a small latency
cost now is cheaper than discovering the race the day Wave 2 adds a mutating tool.

**A thrown error inside a tool — most commonly a `can()` refusal — becomes a `tool_result` the
MODEL sees, never a rejection that aborts the turn.** `defineTool`'s wrapper (§4.1) catches both a
Zod validation failure and a thrown exception and turns each into
`{ content, isError: true }`, so the model can tell the person "I don't have permission to do
that" the same way a UI renders a denied action as a message rather than crashing. Every real tool
still goes through the exact `can()`-checked service call a human's own click would — `search`
wraps `performSearch`, freshly extracted out of `search/router.ts` so the tRPC route and the
assistant's tool call the identical authorized pipeline rather than the tool re-deriving the
per-hit authorization loop that file's own header warns against duplicating.

**Two independent gates on `ai.chat.send`, composed by the ordinary `route()` machinery and
nothing bespoke:** `ai:use` (per member, grantable per §1) and the `aiAssistant` feature flag (per
org plan, resolved through the same entitlement chain §3 already reuses). `router.test.ts` proves
both fire independently — a member with no grant is refused before any provider is ever resolved,
and an owner on a plan without the flag gets `PLAN_REQUIRED` even though their role alone would
grant `ai:use`.

**`search` alone could not answer "what are my pending tasks" at all — a real, structural gap, not
a prompt problem — found from a real transcript where the model tried `search` four times and gave
up.** `packages/filter/src/fields.ts`'s `SEARCH_FIELDS` (`type`/`title`/`text`/`author`/`updated`/
`created`/`archived`) and `CARD_FIELDS` (`assignee`/`status`/`due`/...) are deliberately DISJOINT
(Phase 8's own header), so a TQL query filtering by assignee or due date is valid syntax against
the wrong resource and fails validation every time — and `search`'s own tool description made this
worse by offering `"status = open AND assignee = @me"` as its EXAMPLE query, actively steering the
model toward a shape that can never work. Fixed two ways: `search`'s description and example were
rewritten to use only real search fields and explicitly say what it cannot do, and a new `my_cards`
tool (`my-cards.ts`) wraps `listMyCards` — the same real, per-row-authorized, cross-board query
`work.cards.mine` (My Tasks) already runs — to answer the actual question. "Pending" is filtered
INSIDE the tool, deterministically, via one batched lookup of each returned card's status category
(`listMyCards`'s own output carries only an opaque `statusId`, no category) — the identical
"classification stays deterministic" rule this file's standup section already applies, extended
here so the model is never handed a raw status id and trusted to guess whether it means "done."
The system prompt (`router.ts`) also gained today's date, since a tool result only ever carries a
raw due date — nothing previously gave the model a reference point to resolve "this week" or
"overdue" against.

**A second real gap, found the same way: "create a card in project X... tag it Y" had no way to
resolve either NAME to an id — closed by `lookup.ts`'s three read tools plus a new write tool,
`card_add_labels`.** Every write tool in this registry takes an id
(`listId`/`cardId`/`labelId`/...), never a name, and until now nothing in the registry could ever
PRODUCE one from a name a person actually typed — `search`'s entity types
(`card`/`message`/`page`/`comment`/`transcript`) have no `project`/`board`/`label` at all, because
Phase 8 indexed content people write, not the vocabulary a project is organized with. `list_boards`
deliberately nests each board's lists in one response rather than requiring a separate
`list_lists` call — a card is always created into a specific LIST, so a project resolved by
`list_projects` needs exactly two more calls (`list_boards`, then `card_create`) to reach one,
not three. `card_add_labels` wraps `setCardLabels` — the real service's own doc comment says it
REPLACES the whole set, for the same "concurrent editors sending deltas would fight" reason
`assignCard` does — the same ADDITIVE fix `card_assign` already applies: read the card's current
labels first, union with the requested ones, then call the real replace. If a label the user names
is not found by `list_labels`, the tool's own description tells the model to say so rather than
guess a close match — there is no fuzzy matching or on-the-fly label creation here, a deliberate,
narrower scope than "tag it Y" might suggest; inventing a label nobody asked for by name is a worse
failure mode than asking the person to create it first.

**A third gap in the same report — nobody using the assistant could tell what it was capable of —
was a pure discoverability problem, not a missing tool, and got a UI fix instead of a new tool.**
`apps/web/src/features/ai/assistant-page.tsx` gained a "What can I do?" panel (open by default on
a fresh conversation, toggleable afterward from the header) listing every capability in plain
language, plus clickable example prompts that fill the message box without sending it — so a
person can see the exact phrasing that reaches a tool and edit it before anything happens. The
panel's content (`CAPABILITIES`) is hand-curated, not generated from the tool registry: a tool's
own `description`/`jsonSchema` is written for the MODEL and reads like an API reference (the same
reason `search`'s own tool description is not what a person should see), so this is a second,
human-facing restatement kept in sync by hand — the same trade `packages/tokens` already accepts
for staying in sync with `apps/web/src/styles.css`'s `@theme` block by hand rather than a
build-time dependency.

**A follow-up report on the same `my_cards` result — real data, but "hard to read and act on
it" — was a presentation problem the prompt alone could not fix, so it got a real UI, not more
prompt tuning.** The assistant's own text reply was a numbered list the MODEL had retyped from
`my_cards`' JSON — accurate, but unclickable, and only as trustworthy as the model's own
transcription of data the frontend already had verbatim. `my-cards.ts` gained a `cardId` field
(previously omitted, on `search.ts`'s own "plumbing the model has no use for" reasoning — but the
FRONTEND does), and `assistant-page.tsx`'s `MessageBubble` now looks up the real `tool_result` a
`my_cards` call produced (matched by `toolCallId`, from a `toolResultsById` map — a `switch` on
`role`, not `===`, the identical guardrail-7 collision this file's own `DisplayableMessage`
handling already documents) and, when it parses as a real card list, renders it as one — reference,
title, priority, due date, each opening `CardQuickView`.

**`CardQuickView` moved from `features/standup` to `features/work`, and its `onClose` was
generalized to hand the caller the loaded card rather than invalidating a query itself.** The
component's own cache-refresh side effect (re-fetching the standup buckets a card edit could have
changed) was specific to the ONE feature that first needed it; the assistant page needs no such
refresh, and a shared component has no business knowing which sibling views exist. `onClose` now
receives the card (or `undefined` if it never loaded) and each caller decides what, if anything,
to invalidate — `standup-page.tsx` still does its own project-scoped standup invalidation, moved
into its own `onClose` callback verbatim; the assistant page does nothing extra at all.

**The system prompt (`router.ts`) was told the app already shows a `my_cards` list separately, and
asked for one short sentence of commentary instead of a restated table** — the same "classification
stays deterministic, the model only adds real color" instinct this section's `my_cards` entry and
the standup redesign both already apply, extended to PRESENTATION: once the UI renders the real
data, a model's prose restatement of the same fields is redundant, not merely verbose.

**A follow-up report — "still no way to mention a sprint or member, and creating a fully-specified
card takes multiple iterations" — closed the last of the name-resolution gap and, separately, made
a fully-specified card ONE confirmation instead of up to five.** Two distinct fixes, found from the
same complaint:

`list_members` and `list_sprints` (`lookup.ts`) round out `list_projects`/`list_boards`/
`list_labels` — every noun a person can name when describing a card ("assign to Priya," "add it to
Sprint 14") now resolves to an id in the same conversational turn. `list_members` is the one closing
a gap this file's own §4.3 section named explicitly and left open: "there is still no tool that
resolves a person's NAME to a `userId`." It has to check `member:read` itself
(`can(ctx.subject, 'member:read').allowed`, the identical in-executor check
`apps/worker`'s automation executor already uses for services with no built-in permission check of
their own) — `listMembers`'s route floors on `member:read`, and a tool call bypasses every route.

The multi-iteration complaint turned out not to be about the READ side at all — the read-only lookup
calls above already chain automatically within one turn, invisible to the person typing (that is
what the tool-calling loop is for). It was the WRITE side: `card_create` only ever took
`listId`/`title`/`description`, so a fully-specified card ("project X, assign Y, tag Z, due Friday")
needed `card_create` and then a SEPARATE confirmation for `card_assign`, another for
`card_add_labels`, another for `card_update`'s priority/due date — up to four more approvals for one
mental action. Confirmation happens at the TOOL boundary, not the service boundary, so nothing
stopped one tool from calling the same real services in sequence behind ONE confirmation instead:
`card_create` now takes optional `assigneeIds`/`labelIds`/`priority`/`dueDate`/`sprintId`, and
`execute()` chains `createCard` → `assignCard`/`setCardLabels` (full-replace is correct here,
unlike `card_assign`/`card_add_labels`'s own additive fix — a card that was JUST created has nothing
to accidentally drop) → `updateCard` (priority/due date, read-then-patch as `card_update` already
does) → `assignSprint`, all under `card_create`'s own `can()` checks. A failure partway through
(most commonly a wrongly-resolved id) is reported in a `warnings` array rather than thrown — the
card already exists by that point, and throwing would leave a real card behind while telling the
model nothing happened, the same "report per-item outcome, do not pretend nothing happened"
reasoning `sprint_add_cards` already established for a batch. `card_create`'s own comment states the
property this whole fix rests on: bundling several real service calls behind one tool call changes
nothing about what a caller is allowed to do — every call still runs through its own real `can()`
check — only how many times a human has to click "Approve."

**The `my_cards` fix above was a one-off, and the very next report proved it — `list_projects`
and `list_boards` results still came back as the model's own retyped bullet tree.** Every tool in
the registry has always returned real, well-formed JSON as `ToolResult.content`; that was never
the gap. The gap was that `assistant-page.tsx`'s `MessageBubble` only knew how to interpret ONE
tool's shape (`my_cards`), so every other tool call fell back to a plain "Used `<tool>`" chip with
no data in it — and since the model still has to say SOMETHING, it filled the silence by
transcribing the tool's JSON into prose of its own, which is exactly the "not a clean way to
present info" complaint repeating itself one tool later. Patching `list_projects` next would have
left `list_labels` broken, then `list_members`, then every future tool the registry ever grows —
the same one-test-case-at-a-time trap the report named directly, asking for the whole rendering
surface fixed at once rather than iteratively.

**`apps/web/src/features/ai/tool-results.tsx` is that whole surface — one renderer per tool, keyed
by tool NAME through a `RENDERERS` lookup table, dispatched generically from `MessageBubble`.**
Adding a new tool to the registry now costs one new renderer function and one map entry, not
another pass through `assistant-page.tsx`'s message-rendering logic. Every renderer reads the REAL
`tool_result` message (`toolResultsById`, moved here unchanged from `assistant-page.tsx`) —
never the model's narration of it — and checks `result.isError` first, rendering its own
tool-specific error presentation rather than falling through to one generic error box; a failed
`sprint_add_cards` needs to show which cards failed and why, which a generic "something went
wrong" cannot. `renderToolResult(call, resultsById, ctx)` returns `null` for an unrecognized shape
or a still-missing renderer, and `MessageBubble` falls back to the plain "Used `<tool>`" chip in
that case — the fallback that started this whole complaint is now the edge case, not the norm.

**Write-tool renderers read entity identity from `call.input`, not from the service's own output —
deliberately, to keep the fix entirely frontend-side.** `card_update`, `card_assign`,
`card_set_status`, and `card_add_labels` all require `cardId` in their INPUT schema, but their
SERVICE outputs (`{version}`, `{assigneeIds}`, `{statusId}`, `{labelIds}`) never carry it back —
enriching four backend services and their tests to echo an id the caller already sent would be
real, avoidable churn. `cardWriteRenderer(verb)` is a small factory that reads
`call.input['cardId']` and renders the shared `CardActionResult` chip (a checkmark, the verb, and
an "Open card" link into `CardQuickView`) — one function producing `renderCardUpdate`,
`renderCardAssign`, `renderCardSetStatus`, and `renderCardAddLabels`, since all four only differ by
their confirmation verb.

**Every list result links to the real page it names, using the actual route tree
(`apps/web/src/router.tsx`) rather than a guessed URL** — `list_projects` links each row to
`/projects/$projectId`, `list_boards` to `/boards/$boardId` with its lists as `Badge` chips beneath,
`list_members` to `/people/$userId`, `list_sprints` to the project's `/projects/$projectId/sprints`
view (no per-sprint route exists to link to one directly), `chat_post_message` to `/chat?channel=`,
and `docs_create_page` to `/docs?space=&page=`. Building these surfaced a real TanStack Router
typing quirk worth knowing before adding another one: whether a route's `params`/`search` prop
needs a branded id (`as UserId`, `as ChannelId`) or accepts a plain `string` depends entirely on
whether that route's `parseParams`/`validateSearch` actually parses through the branded Zod schema
or passes the value through raw — `boardRoute` and `projectSettingsRoute` do the former and need
the cast; `personRoute`, `chatRoute`'s `channel`, and `docsRoute`'s `space`/`page` do the latter and
flag the cast as an `@typescript-eslint/no-unnecessary-type-assertion` error. There is no way to
know which a given route needs without reading its actual `parseParams`/`validateSearch` — guessing
either way compiles until lint catches it.

**The system prompt's "don't restate what a tool already rendered" instruction, previously
`my_cards`/`search`-specific, is now written for every tool in the registry by name** — the same
generalization the frontend just made, made once more in `router.ts` so the model's own behavior
matches what the UI actually shows: at most one sentence of genuine commentary after a READ tool,
never a restated list; a brief confirmation sentence after a WRITE tool that never repeats the
fields the confirmation chip already shows.

**A long conversation eventually hit `ChatSendInput.messages`' own 40-element cap and got stuck —
found from a real server log, `BAD_REQUEST: Array must contain at most 40 element(s)`, with the
assistant simply refusing to reply from then on.** `assistant-page.tsx` resends the WHOLE growing
transcript every turn (its own header, unchanged since §4 Wave 1) with nothing on the client ever
bounding it — a real conversation crosses 40 messages faster than it looks, since a single
tool-calling round contributes an assistant turn PLUS one `tool_result` per tool call, not one
message per exchange. The 40 cap itself is correct and deliberately not raised: `router.ts`'s own
comment already calls it "real input-size hygiene, not a product decision about conversation
length," the identical role `search.query`'s own `.max()` plays.

**The fix windows what gets SENT, not what stays on screen.** `windowForRequest` (`api.ts`) trims
at the TRANSPORT boundary; `assistant-page.tsx`'s own `messages` state keeps the full history
forever, and `onSuccess` appends only the new suffix of what comes back
(`result.messages.slice(variables.messages.length)`) rather than replacing the displayed
transcript with the server's own (windowed) view of it — `runAssistantTurn`'s own contract,
`[...transcript, ...newTurns]`, is what guarantees that slice is exactly "what this turn added"
regardless of how much of the front got trimmed before sending.

**Trimming per MESSAGE would corrupt the transcript, not merely shorten it — Anthropic and OpenAI
alike reject a `tool_use`/`toolCalls` block with no matching `tool_result` in the very next turn,
so an assistant tool-call message and the results answering it are one atomic UNIT.**
`messageUnits` groups the array into these units first; `windowForRequest` then keeps the longest
RECENT run of whole units that both fits under the cap and starts on a `user` turn — never a
window that opens on an `assistant` message, since that would mean its own preceding `user`
message got dropped out from under it, a shape neither provider's API accepts as a first message.
Walking backward from the newest unit and remembering the earliest `user`-headed unit still within
budget (rather than stopping at the first one found) is what lets the window include as much
recent history as actually fits, not just the last two units. The one accepted fallback — a window
that opens on `assistant` after all — fires only when no `user`-starting suffix fits under the cap
at all, a pathological shape unreachable at the real 40-message cap in practice; `api.test.ts`
covers it anyway, alongside the atomic-unit and user-start-preferring properties, as the pure
function this codebase's own "test the pure half directly" precedent (`neighbours.test.ts`,
`peer-mesh.test.ts`) already establishes for exactly this kind of client-only logic.

**Two `.role ===` comparisons inside `windowForRequest`/`messageUnits` tripped guardrail 7's
`roleMember` rule on first pass** — the identical name-not-semantics collision this file's own
`router.ts`/`anthropic.ts`/`assistant-page.tsx` entries already document for `ChatMessageWire`'s
chat-turn `role`. Fixed the same way `assistant.ts`'s own `ASSISTANT_ROLE_MESSAGES` already does:
`Set.has()` membership tests (`USER_ROLE_MESSAGES`, `ASSISTANT_ROLE_MESSAGES`,
`TOOL_RESULT_ROLE_MESSAGES`) rather than a `switch`, since these are boolean predicates embedded in
larger expressions, not exhaustive dispatches over the whole union.

**A real transcript surfaced four more defects in one pass: a bare, context-free tool error that
made a whole conversation unrecoverable; two structured renderers that collapsed into unreadable
run-on text on copy; the model calling a lookup tool with an id it could not possibly have yet; and
the model's own free-text replies never rendering as anything but a flat paragraph.** Diagnosed by
reading the transcript literally — tracing "Not found." to the exact line that produces it, not
guessing — rather than patched by intuition.

**`defineTool`'s thrown-error branch discarded all context, while its OWN validation-failure branch
two lines above already prefixed with the tool name — an inconsistency inside one function.**
`apps/api/src/work/shared.ts`'s `translatingConstraints` turns a foreign-key violation into a bare
`errors.notFound()` (`packages/contracts/src/errors.ts`'s own default: `'Not found.'`), and dozens
of call sites across `work/card.service.ts` alone throw that same bare default. Traced from a real
transcript: with no label-creation tool in the registry (`ai/tools/index.ts` has none, by design —
"no fuzzy matching or on-the-fly label creation," this file's own Phase 15 §4 Wave 1 section), the
model fabricated a plausible-looking uuid for `card_add_labels`'s `labelIds`, which passed Zod's
FORMAT-only check, then failed the real foreign key — surfacing as a bare "Not found." with zero
indication of which of several tool calls in the turn had even failed. `registry.ts`'s catch now
prefixes every thrown-error result the identical way its own validation branch already does:
`` `Tool "${name}" failed: ${message}` ``. `registry.test.ts` gained a case naming this exact
scenario (a thrown `Error('Not found.')` on a tool named `card_add_labels`) rather than only a
generic one, so the fix is proven against the failure it was found from, not just a stand-in.

**Two structured list renderers collapsed into unreadable run-on text the moment a person copied
them as plain text — `Badge` is a `<span>`, and a browser only inserts a line break between
BLOCK-level elements, not ones separated purely by CSS `gap`.** `list_labels`' flat row of `Badge`
chips pasted as `choredesigndocsfeaturegoodfirstissue...`; `list_boards`' nested per-board `Badge`
row of list names pasted as `BacklogTo DoIn ProgressIn ReviewBlockedDone` — both confirmed from a
real pasted transcript, not merely suspected (an earlier pass had noticed the SAME shape once for
`my_cards` and left it as an unconfirmed hypothesis; this is that hypothesis confirmed, for a
different pair of renderers). `renderListLabels` (`tool-results.tsx`) now renders a real vertical
`EntityList`/`EntityRow` — one label per `<li>`, a genuine block boundary — both more readable at a
glance for more than a handful of labels and immune to the collapse, since block-level siblings
survive a plain-text copy. `renderListBoards`' per-board list-of-lists stays a compact single line
(a board's own columns read naturally that way) but is now a literal joined string
(`board.lists.map(l => l.name).join(' · ')`) rather than a row of chips — a real character between
each name, not CSS spacing a copy can silently drop.

**The system prompt gained explicit rules against three behaviors a real transcript caught in one
sitting: guessing an id, offering a capability with no tool behind it, and silently answering only
part of a compound request.** `list_boards`/`list_sprints` failed Zod's UUID check on the very
first turn of a conversation — before the model had ever seen a real project id back from
`list_projects` — because nothing stopped it from requesting a dependent tool in the SAME round as
the lookup it depends on; `assistant.ts`'s own loop only guarantees SEQUENTIAL tool EXECUTION
within a round, never that a later call in the same round can see an earlier one's result, since
all of a round's tool calls come from one completion the model produced before any of them ran.
Separately, the model offered to "create the label first" for a capability the registry has never
had, then retried the identical broken approach a second time after the first attempt's bare
"Not found." gave it nothing to learn from (now fixed by the paragraph above) — and a compound
instruction ("set it to urgent and what about labels") got only its second half answered, with no
`card_update` confirmation for the first half anywhere in the transcript. None of these has a code
fix on its own — they are the model's own behavior, not a service the assistant calls — so the
system prompt (`router.ts`) now states each rule directly: every id-shaped field must come from a
tool result already in the conversation, never invented, with dependent calls sequenced across
rounds rather than guessed at in the same one; the model can only do what a tool in its list lets
it do, and must say so plainly rather than offer or retry something it cannot; and a multi-part
message needs every part answered, not just the last. The same paragraph adds a rule against
re-calling a `list_*` tool for something an earlier result in the SAME conversation already gave it
— `list_projects` was called twice and `list_members` a third time in the one transcript that found
all of this, wasted spend and turns that also made the conversation cross `ai.chat.send`'s 40-message
cap far sooner than a conversation of its actual complexity should have.

**The model's own free-text replies rendered as a bare `<p>{content}</p>`, so a fixed-enum answer
with no tool behind it — "1. Urgent 2. High 3. Normal 4. Low" — showed the literal markdown syntax,
never an actual list.** Most of the model's commentary is one short sentence by design (this
section's own system-prompt entries above), which a plain paragraph handles fine; the gap is
exactly the reply that has no tool result to render instead, where the model has to fall back to
describing something in its own words. `apps/web/src/features/ai/markdown-lite.tsx` is a small,
deliberately narrow renderer — bold spans and bullet/numbered lists, nothing else — built from real
React elements (`<p>`, `<ul>`, `<ol>`, `<li>`, `<strong>`) parsed from plain text, never
`dangerouslySetInnerHTML` over a markdown-to-HTML string, which rule 4 bans outright with no
exception for content the app itself generated. `parseMarkdownBlocks`/`parseInlineSegments` are
exported pure functions, tested directly (`markdown-lite.test.ts`) the same "test the pure half"
way `windowForRequest` and `neighbours.ts` already are, rather than only through a rendered
component. `MessageBubble`'s assistant bubble now wraps `<MarkdownLite text={message.content} />`
in the same bg/padding/rounding the bare `<p>` used to carry directly.

**`find_card` closes the one lookup gap `lookup.ts`'s tools had left open — a card by the
reference every OTHER surface in this app already names it by.** Found from a real transcript:
"move WEB-709" had no path to a real `cardId` at all, `search` matched nothing (it indexes card
CONTENT, never the reference), and the model fell back to a plain listing of ~50 unfiltered cards
and guessed wrong. `getCardByReference` (`work/card.service.ts`) parses `"WEB-142"` into a project
key and number, uppercasing the key first — `router.ts`'s own `ProjectKey` schema transforms every
key to uppercase before it is ever stored, so a lowercase reference a person actually types would
silently match nothing without that step — then the same `card:read` `enforceOn` check every other
card read already goes through. `lookup.test.ts` gained a `find_card` block covering the real
match, the case-insensitive match, a reference that parses but does not exist, and text that is not
a valid reference shape at all — the same "children before parents" teardown fix
(`work.cards` before `work.sprints`/org) this file's own §4 Wave 3 section already documents,
needed the moment this test file started creating a card too.

**The system prompt now tells the model directly to use `find_card` for a named reference, since
nothing about the tool's own existence tells the model WHEN to reach for it over `search`.** The
same paragraph that already banned inventing an id now names the specific failure mode this closes:
`search` looking like the obvious tool for "WEB-142" and quietly returning nothing.

**The capabilities panel and empty state were both real instances of the "excessive text nobody
reads" complaint, found from a screenshot rather than a transcript.** `CAPABILITIES`' items were
trimmed to true one-liners (padding words removed, not information), and a new `REFERENCE_HINTS`
row ("Point at things: A card (WEB-142) · A person (@Priya) · A project, board, sprint, or label
(just its name)") teaches the conventions the assistant is actually reliable at resolving now that
`find_card` exists — phrased as conventions that work, not a special trigger syntax the input
enforces, since no such syntax is wired up yet. The empty state's own description used to restate
the same "ask a question about your projects..." text the panel above it already shows whenever the
panel is open on a fresh conversation — real duplication on screen at once, fixed by showing that
description only when the panel is collapsed (`exactOptionalPropertyTypes` needs a conditional
prop spread here, not `description={condition ? text : undefined}`, since the target's own
`description?: string` refuses an explicit `undefined` under that setting).

**The reference-hints row hit the identical collapse-on-copy bug this file's own `tool-results.tsx`
entry just documented for a `Badge` row — caught before shipping, not after.** Three adjacent
`<span>`s separated only by `gap-x-3` CSS spacing collapse into one run-on line on a plain-text
copy; fixed the same way, a literal `" · "` string between entries rather than layout spacing
alone.

**A real `@`/`#`/`&`/`%`/`~` mention picker was deferred here as a genuine scope decision needing
the project owner's own choice — asked directly, and shipped the same session once both answers
came back.** `apps/web/src/features/ai/{entity-reference.ts,entity-mention-extension.ts,
assistant-composer.tsx}`. The two open questions this paragraph itself named: what a picked mention
actually sends (a display string the model still resolves via a lookup tool, or an embedded id),
and which entities get a picker at all. The answer to the first was "zero error" stated directly —
which a display-string-only mention cannot promise on its own, since the MODEL still has to
independently resolve it, the exact step that can still go wrong (two members sharing a display
name is a real, documented possibility in this codebase's own seed data — see `packages/seed`'s
`displayNameNicknameShare`, cited once already in this file's Phase 15 §5 section for exactly this
collision). The answer to the second was "for all" of people/projects/boards/sprints/lists, with
the trigger character for the four non-person types left to be decided.

**The wire format needed no change at all — `Label{{type:id}}` is a plain-text suffix, not a new
`ChatSendInput` field.** `entity-reference.ts`'s own header states the reasoning: `ai.chat.send`'s
`content` stays an ordinary string, so nothing about `ChatMessageWire`, the server's Zod schemas, or
the tool-calling loop changes — only the system prompt (`router.ts`) needed a new paragraph telling
the model to trust an id arriving this way rather than re-resolving it, and `stripReferenceEmbeds`
strips the suffix back out for DISPLAY of a person's own sent bubble, which otherwise would show the
raw id sitting behind their `@Priya Nakamura`. `{{type:uuid}}` (ASCII, a closed type enum, a real
UUID shape required inside) is deliberately over-specific rather than a bare `{{...}}` — a person
pasting a Handlebars or MediaWiki-style `{{template}}` into a message must never have that text
silently eaten by a strip function meant only for what the picker itself inserts;
`entity-reference.test.ts` asserts exactly that non-collision directly.

**Reusing Chat's own `mention-extension.ts` turned out not to be possible, and the real reason is
worth knowing before trying again:** it is built on a ProseMirror editor instance and serializes
into Chat's own rich-text JSON, which already carries `userId` structurally — nothing about it needs
an assistant-specific embed trick, because Chat never throws the structure away. The assistant does
throw it away (down to a plain string), which is the one thing Chat's node was never built to do.
`entity-mention-extension.ts` is a NEW, purpose-built generalization of the same underlying pattern
(a TipTap `Node` on `@tiptap/suggestion`) rather than a Chat/Docs code change — one factory function
taking `{name, char, type, pluginKey, fetchItems, emptyHint}`, instantiated five times from
`assistant-composer.tsx`, where the runtime data (`queryClient`, `orgId`, the current document's own
content) actually lives.

**A plain `<textarea>` was considered and rejected for a reason beyond "TipTap is what Chat already
uses" — string-index tracking cannot survive an edit near an inserted mention.** Splicing a
mention's display text into a plain string and remembering `{start, end, type, id}` breaks the
moment a person edits text before or after it: the recorded range drifts, and there is no way to
tell "three characters were deleted before the mention" from "part of the mention itself was
deleted." A TipTap atomic inline node does not have this problem — it is a single indivisible unit
that carries its `refId` regardless of what is typed around it, the identical guarantee Chat's own
`@mention` already relies on. The genuine complexity of a real editor instance is spent buying
correctness a string-splicing approach cannot actually deliver, not convenience.

**Registering five `Suggestion()` plugins in one editor crashes unless each gets its own
`PluginKey` — the library's own default silently shares one across every instance that does not set
one explicitly.** `@tiptap/suggestion`'s `Suggestion({pluginKey = SuggestionPluginKey, ...})`
defaults to the SAME exported singleton, fine for Chat/Docs (one mention type each) and fatal here:
ProseMirror refuses to build an editor state with two plugins sharing a key at all. Each of the five
entity types gets its own `PluginKey`, created once in `assistant-composer.tsx` (a lazy `useState`
initializer, not a fresh one per render, since `isAnyMentionSuggestionActive`'s lookups need the
SAME reference across renders to keep resolving) and threaded into the factory. The consequence
reaches further than plugin registration: `rich-text-editor.tsx`'s own `handleKeyDown` checks ONE
`SuggestionPluginKey.getState()` to tell "Enter should pick the highlighted candidate" from "Enter
should submit" — with five independent keys, that check has to ask all five,
`isAnyMentionSuggestionActive` doing exactly that.

**Board/sprint/list pickers require a project (or board) already mentioned earlier in the SAME
draft — a real, documented boundary, not a corner cut for time.** `work/api.ts` has no org-wide
"every board" or "every sprint" query; `boardsQuery`/`sprintsQuery` take a `projectId`,
`listsQuery` a `boardId`, matching the actual hierarchy a board belongs to a project and a list to a
board. Inventing new backend routes purely so this ONE picker could search org-wide would be new
surface for a UI convenience a real workflow does not need anyway — "in Website's Delivery board"
is how a person phrases this regardless. `firstMentionInDoc` walks the CURRENT ProseMirror document
for the first node of the prerequisite type and reads its `refId`; typing `&`/`%` before a project,
or `~` before a board, shows "Mention a project first." / "Mention a board first." instead of an
empty list that looks like the org simply has none.

**The placeholder text is a small React-managed overlay, not `@tiptap/extension-placeholder`.**
Adding a new dependency for one small affordance in an already-large change was not worth it; the
overlay is built from `empty` state this component already tracks via `onUpdate` (shown only while
`editor.isEmpty`), rather than the official extension's usual mechanism — a ProseMirror decoration
carrying `content: attr(data-placeholder)` on the exact empty `<p>` node, which the FIRST version of
this file got wrong by setting `data-placeholder` on `editorProps.attributes` instead (the OUTER
`contentEditable` div, not the inner paragraph CSS's `attr()` actually needs it on) — caught before
shipping by reasoning through the CSS rule rather than by a runtime check, since a broken placeholder
is easy to miss visually behind an already-empty-looking input.

**The example prompts in `CapabilitiesPanel` show trigger characters as literal pre-fill text, and
clicking one does NOT produce a real resolved mention.** `insertPlainText` inserts exactly the
characters shown — `#Website` lands as four ordinary characters, not a `projectMention` node with a
real `refId` — since a static string has no candidate to resolve against. The example demonstrates
PHRASING; retyping the trigger character after clicking one in is what actually opens a picker and
earns the "zero error" property. Documented in the constant's own comment rather than silently
accepted as a minor inconsistency, since it is exactly the kind of gap a person could reasonably
expect not to exist.

**A real transcript, made possible by `find_card` actually letting the assistant REACH a card,
surfaced the next two gaps immediately behind it: moving a card between lists/boards had no tool,
and neither did commenting on one.** "Move it to Bug Triage" (a board name) failed twice — the
model tried `card_set_status` (a different concept entirely: a card's STATUS, per
`card.service.ts`'s own `setCardStatus`, is a project-level field with no relationship to which
list or board a card sits on) and `sprint_add_cards` (mistaking a board for a sprint) — both ending
in a bare "Not found." (now at least correctly attributed to the right tool, per this file's own
earlier `registry.ts` fix). "Add a comment... and tag @Rosa" reached for `chat_post_message`
instead, a completely different subsystem — a card comment is Work's own `comment:create`, never a
Chat channel message.

**`card_move` wraps the real `moveCard`, which the tool registry had simply never reached before —
`card_set_status` was never it, by design.** `moveCard`'s own doc comment already states it can
cross BOARDS within the same project (never across projects, refused by the service itself), which
is exactly "move it to Bug Triage" when Bug Triage is another board in the same project. The tool
takes `cardId`, `boardId`, and `listId` — `boardId` requested explicitly rather than looked up
inside the tool, since the model already has it from `list_boards`' own nested
`{boardId, lists: [{listId}]}` shape, avoiding a second lookup purely for this tool's convenience.

**There is no `beforeCardId`/`afterCardId` input, on purpose — a model has no drag position to
report — and always appending to the END of the target list caught a real bug in its own first
implementation.** `moveCard` derives the new rank as `between(rankOf(beforeCardId),
rankOf(afterCardId))` — `beforeCardId` is the LOWER bound (the neighbour that sorts before the
moved card), `afterCardId` the upper. The first version of `card_move` passed the target list's
current last card as `afterCardId`, reading the name literally ("goes after this one") rather than
by the actual bound it names — which is backwards, and puts the moved card BEFORE the existing
last card, not after it. `card.test.ts`'s own test asserts the actual resulting ORDER of the target
list post-move, not merely that the call succeeded, and failed on the first version — exactly the
"a real test, not a mock that could agree with a wrong implementation" property this codebase's own
Wave 2 section already states for confirm-before-execute. Fixed by passing the last card as
`beforeCardId` and leaving `afterCardId` null.

**`card_add_comment` wraps `createComment`, reusing `chat_post_message`'s own segment shape rather
than inventing a second one.** The ordered text/mention SEGMENTS `chat_post_message` already
composes (`chat.ts`'s own header: "a direct, lossless map onto the one paragraph `sendMessage`'s
`body` becomes") apply identically here — `createComment`'s `body` is the same `RichTextNode` shape
— so the schema, JSON schema, and segments-to-rich-text mapping moved to a new shared
`apps/api/src/ai/tools/segments.ts` rather than being copied a second time, with `chat.ts` updated
to import from it instead of keeping its own local copy.

**Exporting that shared schema surfaced a real TypeScript declaration-emit trap worth knowing
before it happens again: `tsc` refused to compile with TS4023, "has or is using name 'brand' from
external module... but cannot be named."** A Zod schema referencing a branded type
(`UserIdSchema`'s `UserId` brand) compiles fine as long as the schema constant is never itself
EXPORTED with its type left to bare inference — every existing tool file's own input schemas
(`CardCreateInput`, `CardAssignInput`, ...) are local, unexported consts, which is why none of them
had ever hit this. The moment the identical schema needed to be exported for `card.ts` to reuse, the
declaration emitter needed a NAMEABLE type for it and could not synthesize one from
`@taskflow/contracts`' own internal brand symbol. Fixed by giving the export an explicit type
annotation — a hand-written `MessageSegment` type (naming the exported `UserId`, not the
unexported brand symbol) and `z.ZodType<MessageSegment, z.ZodTypeDef, unknown>` on the schema
const — rather than relying on inference to produce a nameable type on its own.

**The system prompt gained one more rule this same transcript's very first exchange named
directly:** the model created a card in a project/board/list the user never specified, and the
user's own follow-up — "but u did not ask me anything about it" — confirmed that was the wrong
call. `router.ts` now tells the model to ASK which project, board, or list a create-or-move request
belongs in in whenever the user's own message does not say, rather than silently picking one — even
one mentioned earlier in the conversation — unless the most recent message clearly implies it.

### Phase 15 §4 Wave 2 — single-card write tools and confirm-before-execute (SHIPPED)

`apps/api/src/ai/tools/card.ts` · `assistant.ts`'s `pendingToolCalls`/`confirmedToolCallIds` ·
`ToolDefinition.requiresConfirmation`. Spec: same file, §4.2, §4.3 item 2 ("small single-card
writes: create/update/assign/prioritize, always confirmed inline"). Deliberately not built:
sprint planning (§4.3 item 3), cross-member tagging/discussion (item 4), the standup view (§5),
doc-space bootstrap (§6), GitHub/PR integration (§7), onboarding/offboarding automation (§8).

**§4.2 and §4.3 contradict each other on exactly these tools, and this wave ships the more
conservative reading rather than guessing.** §4.2's illustrative text says
`card.create`/`card.update` "are cheap to undo and can execute directly once permitted"; §4.3's
wave-ordering table says the identical tools are "always confirmed inline." The spec is marked
DRAFT — not yet approved for build — and this is exactly the kind of ambiguity CLAUDE.md's own
"a status marker is a claim, not a fact" discipline exists to catch rather than paper over. Every
write tool in this wave requires confirmation, with no exception, matching §4.3's stricter text:
loosening any of them to auto-execute is real, separate, reviewable work later — the identical
posture §4.3 itself takes toward PR merge/close ("loosening that later is a deliberate, separate
decision"), not a default this pass takes for itself.

**`card.set_priority` is `card.update`, not a fifth tool** — there is no separate
`setCardPriority` SERVICE to wrap; `card.service.ts`'s own doc comment already explains why
priority "rides" `updateCard` rather than getting a dedicated mutation, and inventing a
priority-only AI tool around the same full-replace call would just be `card.update` with fewer
fields exposed.

**`card.update` and `card.set_priority`'s old §4.1 name both read the card FIRST and pass every
untouched field back unchanged** — the identical fix `apps/worker`'s automation executor already
uses for its own `card.set_priority` action, itself citing this file's documented `cards.update`
full-replace trap for the web client. A tool that patches by taking "whatever the model
mentioned" and defaulting the rest would erase a description per rename exactly like the bug this
file already documents once. `'field' in input` distinguishes "not supplied" from "explicitly
cleared" (`{ dueDate: null }`), the same reasoning `apps/web`'s own `useUpdateCard` gives.

**`card.assign` is ADDITIVE, never the real `assignCard`'s full replace** — mirroring
`apps/worker`'s own automation `card.assign` action, which is additive for the identical reason:
"assign this to Bob" spoken in a chat means ADD Bob, and a tool that silently unassigned everyone
else because the model did not enumerate them would do quiet damage a confirmation prompt would
not even show clearly. An "unassign" tool is future work, not a gap in this one's contract.

**Confirm-before-execute needed no new server-side state, no persistence table, and no second
route.** When a round's tool calls include one flagged `requiresConfirmation`, NONE of that
round's calls run — the model's assistant turn (its text plus the requested `toolCalls`) is
appended to the transcript and `runAssistantTurn` returns immediately with `pendingToolCalls` set,
before calling the model again. The pending state IS the transcript itself: only a deferred return
ever leaves an unresolved assistant tool-call turn with no `tool_result` after it, since every
other path in the loop appends matching results before returning or continuing — so a caller
resumes by resending that exact transcript back, unchanged, with a new `confirmedToolCallIds`
naming which pending calls a human actually approved. A call whose id is absent from that list is
DECLINED, never merely unconfirmed — defaulting an omitted id to "run it anyway" would make a
client bug indistinguishable from a human's "yes," which is the one guarantee this whole
mechanism exists to prevent. `assistant.test.ts` proves all three shapes against the real
`card.create` tool and a real database: deferred (nothing runs, zero rows), resumed-and-confirmed
(the real service runs, a real row exists), and resumed-with-nothing-confirmed (declined, zero
rows) — not against a mock that could agree with a wrong implementation.

**`ToolDefinition.requiresConfirmation` is a required field, not a default.** The same reasoning
guardrail 6 gives for not defaulting a domain event to "none": a write tool that forgot to set it
should fail to compile, never silently inherit whatever the previous tool in the file happened to
choose. `ToolContext` gained a `requestId` alongside `subject` for the identical reason a `WorkActor`
needs one — every write tool builds a real `WorkActor` to call the real `apps/api/src/work` service,
so the domain event it emits carries a real request id into the audit trail, reading "AI, on behalf
of `<user>`, did X," never "AI did X."

**Every tool name in this registry was `card.create`-style dotted, and every one of them broke the
first time a real OpenAI completion tried to use one.** OpenAI's Chat Completions API validates
`tools[].function.name` against `^[a-zA-Z0-9_-]+$` — no dot — and `ai.chat.send` 500'd with
`Invalid 'tools[N].function.name': string does not match pattern` the moment `resolveAiProvider`
picked `OpenAiProvider` for an org (found from real server logs, not a fixture: `packages/ai`'s
`AnthropicProvider` shares the identical real constraint, so this was latent for Anthropic too,
just never exercised live). Nothing in this repository's own tests could have caught it —
`assistant.test.ts` and every tool's own test call `execute` directly or drive the loop against a
`FakeAiProvider`/stubbed `fetch`, so a real provider never validated a real tool list until an org
actually configured to use one did. Renamed every write tool to `snake_case`
(`card_create`/`card_update`/`card_assign`/`card_set_status`/`sprint_create`/`sprint_add_cards`/
`chat_post_message`/`docs_create_page`) — scoped to `apps/api/src/ai/` where these strings are
genuine tool identifiers, since the same substrings appear unrelated elsewhere (domain event names,
automation action types) and are not part of this rename. `apps/web/src/features/ai/setup-dialog.tsx`
composes an instruction telling the model to use "your `docs_create_page` tool" by literal name for
§6's bootstrap flow — the one place outside the registry itself where the exact string mattered
functionally, not just as prose, and needed the identical fix.

### Phase 15 §4 Wave 3 — sprint planning tools (SHIPPED)

`apps/api/src/ai/tools/sprint.ts`. Spec: same file, §4.3 item 3 ("sprint planning (multi-card,
higher blast radius)"). Deliberately not built in this wave: cross-member tagging/discussion
(§4.3 item 4, mostly existing plumbing per the spec's own note — see its own section below, since
it shipped in a later pass), the standup view (§5), doc-space bootstrap (§6), GitHub/PR
integration (§7), onboarding/offboarding automation (§8).

**Unlike Wave 2's `card.create`/`card.update`, the spec has no internal contradiction to resolve
here** — §4.2 names "sprint creation" itself, by name, as an example of an action needing
confirmation, and "moving many cards" as its own named example of a bulk operation that does too.
Both `sprint.create` and `sprint.add_cards` require confirmation, consistent with Wave 2's
across-the-board policy but this time with the spec's unambiguous agreement rather than a
deliberately conservative reading of a contradiction.

**There is no bulk `assignSprint` in the service layer, so `sprint.add_cards` loops the real
per-card one — sequentially, the same ordering guarantee every write tool in this registry
keeps — and reports each card's OWN outcome rather than aborting the whole batch on the first
failure.** This is a deliberate departure from `apps/worker`'s automation executor, which stops a
RULE at its first failed action because a rule runs unattended and a partial run with nobody
watching needs a clean, unambiguous point to retry from. This tool runs only after a human has
already confirmed moving these specific cards; abandoning the other 49 because card 3 was already
in a completed sprint would be worse for them, not safer, since they can see exactly which cards
failed and why and decide what to do about only those. `sprint.test.ts` proves the property
directly: one bogus card id alongside one real one still moves the real one and reports the bogus
one's failure by name, rather than either silently dropping the failure or refusing the whole
batch.

**Teardown for this test file needed the `work.sprints` row deleted before `work.projects`** —
`card.test.ts`'s simpler fixture (no sprints) can delete an org straight through and let
whatever cascade exists handle the rest, but a sprint referencing a project with no `ON DELETE
CASCADE` between them means the identical straight-through teardown here hits
`sprints_project_fk` the first time a test actually creates one. Fixed the same way
`work.service.test.ts`'s own `removeOrg` and `tenancy-seed.ts`'s `clearTenant` already document:
children before parents, explicit about every table rather than relying on a cascade path that
may not exist for a table a fixture only started touching later.

### Phase 15 §4.3's last item — `chat.post_message` (SHIPPED, closes §4.3's wave order)

`apps/api/src/ai/tools/chat.ts`. Spec: same file, §4.1's table and §4.3 item 4 ("cross-member
tagging/discussion — already mostly exists via `mention` + Chat, mainly assistant wiring, not new
primitives"). With this, every wave §4.3 names is shipped. _(§4.1's table named one more tool no
wave had built — `docs.create_page` — shipped in a follow-up pass; see its own section below.)_

**This is the one write tool where §4.2's own text is unopposed, and it still requires
confirmation.** §4.2 names `chat.post_message` alongside `card.create`/`card.update` as "cheap to
undo... can execute directly once permitted," and unlike those two, §4.3 never separately
contradicts that for this tool — there was no genuine ambiguity here the way Wave 2's had one to
resolve. The choice to gate it anyway is deliberate, not a reflex extension of Wave 2's policy: a
posted message is read — and a `mention` notifies its target — before anyone could undo it,
unlike a card field only the people already looking at that card would ever notice change.
Loosening this to auto-execute, matching §4.2's text exactly, is real, separate, reviewable work
later, the same posture this registry already takes toward every other write tool.

**The model composes the message as ordered SEGMENTS, not a markup string the tool would have to
parse.** A `text` segment becomes a `text` node; a `mention` segment (naming a `userId` and the
`label` to display) becomes a `mention` node — the exact TipTap shape a human's own composer
produces, mapped directly rather than reconstructed from parsed `@name` syntax. This is what makes
`mentionedUserIds` (Phase 9's notification extraction) see the tag: the tool calls the real
`sendMessage`, so a person the assistant mentions is notified through the SAME path a human
mentioning them would use, not a second one invented for the assistant.

**There is still no tool that resolves a person's NAME to a `userId`** — the identical
discoverability gap `card.create`'s `listId` and `sprint.add_cards`'s `sprintId` already have (see
their own sections). A mention today needs a `userId` the conversation already supplied some other
way. Real, not fatal: `mention`'s own `isValidId` check inside `RichTextDocument` means a malformed
id refuses cleanly rather than posting garbage, the same as every other rich-text boundary in this
codebase.

### Phase 15 — `docs.create_page` (SHIPPED, §4.1's table's last unbuilt tool)

`apps/api/src/ai/tools/docs.ts`. Spec: same file, §4.1's table ("used by the org-onboarding
bootstrap, §6") and §6 itself. Deliberately not built: §6's actual bootstrap FLOW — the new-org
prompt offering to run the assistant, and the conversational "team size, wiki vs. handbook"
question sequence — which needs a UI trigger this pass does not add; only the tool the flow would
call.

**Title only, no body content — because that is genuinely all the real `createPage` service can
do, not a scope-narrowing choice this tool makes on its own.** Docs Wave 1 shipped `docs.pages` as
tree-only with no body column at all; a page's actual prose is written exclusively through
`apps/collab`'s Hocuspocus/Yjs sync, "the one process allowed to write from a socket handler."
There is no honest "create this page with this text" call for an ordinary HTTP caller to make —
this tool included — so a page the assistant creates is a titled, empty node in the tree, exactly
what §6's own description asks for ("a starter Docs space — a handful of pages... using the
`docs.create_page` tool," never pre-filled prose). Whoever opens the new page still writes its
content the normal way.

**Requires confirmation despite §6 making the strongest case yet for skipping it.** §6 calls a
created page "safe by construction" and "trivially reversible" — stronger language than §4.2 uses
for `chat.post_message`, and §4.2 does not even list `docs.create_page` among its own "cheap to
undo" examples, so that argument is this codebase's reading of §6, not the spec's own text. Kept
confirmation-gated anyway: one uniform rule (nothing writes without a human's explicit yes) is
simpler to reason about and audit than deciding tool-by-tool which risk is low enough to skip, and
consistency is worth more here than the marginal convenience of auto-executing the one tool with
the best argument for it.

### Phase 15 — five more tool-registry gaps, closed in one pass (SHIPPED)

`apps/api/src/ai/tools/{lookup,chat,card}.ts`. Prompted directly by the project owner ("add all
the tools missing, why do I need to ask for every one") after a transcript surfaced three failures
in one conversation rather than the usual single bug report — this pass is a deliberate departure
from the wave-by-wave, one-report-at-a-time cadence every earlier tool addition in this file
followed. The instruction changed the METHOD (audit the registry proactively instead of waiting for
the next failure), not the bar for what counts as a real gap — every addition below still traces to
a concrete transcript or a documented "future work" comment already sitting in the code, not a
speculative capability nobody asked for.

**`list_statuses` (`lookup.ts`) — the same name-to-id gap `list_boards`/`list_labels`/`list_sprints`
already closed, one entity type they missed.** `card_set_status` failed "Not found." three times in
a row against a project with boards "Roadmap" and "Incidents": a card's `statusId` is a
project-level field (`work.statuses`) entirely independent of which list/board it sits on
(`status.service.ts`'s own header), and nothing in the registry had ever produced one — the model
guessed a list id where a status id belonged, because in that project's own vocabulary a status name
("In Progress") and a list name happened to overlap. Wraps the real `listStatuses`, which already
enforces `project:read` itself; no in-tool check needed, the same shape every other project-scoped
lookup tool here already has.

**`list_channels` and `chat_post_message`'s new `dmUserIds` (`chat.ts`) — the identical id-resolution
gap, for Chat.** "Send a msg to @Rosa Pereira" failed "Not found." for the structural reason
`list_statuses` above fixes for cards: nothing in the registry could ever produce a `channelId` —
not for an existing named channel, and not for a DM, since `list_members` gives a `userId`, never a
channel. Two tools close it, not one, because the two cases have different shapes: `list_channels`
is an ordinary read (wraps `listChannels`, which already filters to what the caller may see via its
own per-row `can()`, so this tool adds no authorization of its own) for a channel or DM that ALREADY
exists; a DM that does not yet exist needs a WRITE (`openDirectMessage` finds-or-creates it), and
giving that its own confirmation step would mean two approvals for one "message Rosa" request — one
to open the DM, a second to actually send anything. Instead `dmUserIds` is a second, mutually
exclusive input on `chat_post_message` itself, and `execute()` calls `openDirectMessage` then
`sendMessage` behind the SAME single confirmation, the identical "bundle several real service calls
behind one tool call" shape `card_create` already established for create+assign+label+priority+
sprint — every call still runs through its own real check, so bundling changes nothing about what
the caller may do, only how many times a human clicks Approve. `openDirectMessage`'s own ROUTE
floors on `channel:read` ("starting a conversation with a colleague is not the same capability as
creating a channel the whole organization sees"); a tool call bypasses every route, so the tool
checks that permission itself before calling it, the same in-executor pattern `list_members` already
uses for `member:read`.

**`card_unassign` and `card_remove_labels` (`card.ts`) — the subtractive counterparts `card_assign`
and `card_add_labels` never got.** "Remove the first assignee we had" was not a bug — the model
correctly reported that unassigning was unsupported, exactly as `card_assign`'s own comment
predicted ("a separate 'unassign' tool is future work, not a gap in this one's contract"). The
explicit "add everything missing" instruction turned that documented deferral into work for this
pass. Both mirror their additive sibling exactly in reverse: read the current set fresh (never a
stale one the model might be holding from an earlier turn), drop the named ids, write the remainder
back through the same full-replace service call (`assignCard`/`setCardLabels`) the additive tools
already use — resolving against a freshly read set is what keeps this safe against a concurrent
change the same way the additive tools already are.

**Label CREATION was deliberately left out of this pass, not overlooked.** Unlike the five additions
above, "labels can only be looked up and applied, never created" is an existing, reasoned design
decision (this file's own §4.3 entry: "inventing a label nobody asked for by name is a worse failure
mode than asking the person to create it first"), not a gap this transcript's failures pointed at —
nothing in the pasted conversation showed the MODEL trying and failing to create one; it correctly
declined. Reversing a deliberate scope boundary is a different kind of change than closing an
oversight, and belongs in its own pass if wanted, not folded silently into a sweep prompted by
unrelated bugs.

`router.ts`'s system prompt gained explicit guidance on the two sharpest confusions the transcript
showed: a card's STATUS (`list_statuses`) is a different thing from its LIST/BOARD (`list_boards`),
never one guessed for the other; and there is no separate "open a DM" tool to look for —
`chat_post_message`'s own `dmUserIds` handles it. `apps/web/src/features/ai/tool-results.tsx` grew a
renderer for each new read tool (`list_statuses`, `list_channels`) and reused the existing
`cardWriteRenderer` shape for the two new card tools; `chat_post_message`'s renderer now reads
`channelId` back from the tool's own RESULT rather than the call's `input`, since a DM opened via
`dmUserIds` has no `channelId` in its input at all — only in what the tool resolved it to.

### Phase 15 §8 — onboarding/offboarding automation (SHIPPED, a real subset)

`apps/worker/src/automation/{types,executor,loop-protection}.ts` (the six new action types) ·
`apps/api/src/automation/{router,automation.service}.ts` (the matching write-boundary schemas) ·
`apps/api/src/tenancy/{events,member.service,member-grant.service}.ts` (`member.offboarding_started`,
`startOffboarding`, `revokeAll`) · `apps/api/src/work/{events,card.service}.ts`
(`card.bulk_reassigned`, `bulkReassignCards`) · `apps/api/src/identity/identity.service.ts`
(`logoutEverywhere`'s new `reason` parameter and narrowed deps type). Spec: same file, §8
("no new subsystem, two new trigger events and a handful of new actions"). This section ships six
of §8's ten checklist items — the ones a real service call already exists for, or needed only a
small, reviewable one — and documents the other four as deliberate deferrals below rather than
half-building them.

**The onboarding trigger already existed and needed no new code.** §8's draft names
`membership.created`; the real event, registered since Phase 2, is `member.added`
(`apps/api/src/tenancy/events.ts`) — the identical "the spec's draft event name doesn't match the
schema" gap this file's Phase 15 §2+§3 section already documents for `ai.usage_ledger`. Every
onboarding rule below is written against `member.added`.

**Offboarding needed a genuinely new trigger, and it changes nothing about the membership row.**
`member.offboarding_started` (`tenancy/events.ts`) is raised by a new `tenancy.members.startOffboarding`
route (`member:remove`, no step-up — nothing here is destructive) that writes no column at all; its
only effect is the event. This is the "distinct from immediate removal" §8 asks for: an admin can
flag someone as leaving and let the checklist run (session revocation, card reassignment, grant
cleanup) while the person is still, technically, a member — `removeMember` remains the only thing
that actually ends the membership, called separately, same as today. Calling `startOffboarding`
twice is not an error, on purpose: there is no state here a second call could corrupt.

**All six new actions act on the member the TRIGGER named, never a `userId` the rule stores** —
`userIdOf(event)` in `executor.ts` is `cardIdOf`'s exact discipline (§4's own established pattern)
applied to §8: `member.added`/`member.offboarding_started` both carry `userId` in their payload, no
action's Zod schema has a `userId` field of its own (`.strict()` refuses one), and
`action-schema.test.ts` asserts that refusal directly. The one action naming a SECOND person,
`cards.bulk_reassign`'s `toUserId`, is the replacement assignee — there is no other way to say who a
departing member's work goes to.

**`channel.add_member` / `channel.remove_member` wrap the existing `addChannelMember`/
`removeChannelMember` (Phase 5) and need no authorization check of their own in the executor** —
both already carry `channel:manage` internally, the identical "the service checks itself" shape
`card.assign` etc. already rely on. Message history is untouched by a removal for the ordinary
reason it always has been: `removeChannelMember` only deletes the membership tuple, never a message
row, so §8's "without deleting their message history" item needed no new mechanism at all — the
existing service already has that property.

**`docs.grant_space_access` and `member_grant.revoke_all`/`identity.revoke_sessions` are the three
actions that needed an authorization check INSIDE THE EXECUTOR, because the services they call do
not check themselves.** `grant.service.ts`'s `grant()`, `member-grant.service.ts`'s `revokeAll()`
(new — see below), and `identity.service.ts`'s `logoutEverywhere()` all rely on their tRPC ROUTE's
`route({ permission: 'member:manage' })` for authorization, exactly as `grants.grant`'s route
comment says: "writing a tuple is granting access to a specific thing, so it sits behind
`member:manage`." A worker call bypasses every route, so `executor.ts`'s three new cases call
`can(actor.subject, 'member:manage')` themselves before reaching the service — the identical
reasoning `enqueueWebhookDelivery` already gives for checking `webhook:manage` INSIDE itself rather
than trusting a route that cannot see this caller. `docs.grant_space_access` fixes the relation at
`'viewer'` rather than taking one as a field, on purpose: an unattended rule handing out `'editor'`
or `'owner'` on a space is a bigger blast radius than "let the new hire read the handbook" needs.

**`member-grant.service.ts` gained `revokeAll` — a loop of the same conditional UPDATE `revoke()`
already makes, not a new bulk statement** — because each permission is its own `memberGrantRevoked`
event (guardrail 6), and an admin auditing "what could this person still do the day they left"
wants the list, not a count. Idempotent on zero active grants, the common case for most members.

**`identity.service.ts`'s `logoutEverywhere` gained a `reason` parameter (`'logout_all'` default,
`'admin'` for offboarding) and a narrowed deps type — `Pick<IdentityDeps, 'events' | 'now'>` instead
of the full interface.** The narrowing is what makes this the one identity mutation callable from
OUTSIDE the identity module without fabricating a `config`/`checkBreached`/`deliver` the caller
holds none of. `identity.sessions` carries no RLS at all (Phase 12 Wave 2), so there is no
per-resource question for `can()` to ask here the way there is for a grant on one space — ending a
colleague's sessions is folded into the same `member:manage` bucket that already covers role changes
and removal.

**`cards.bulk_reassign` is a genuinely new mutation shape, exactly as §8 itself calls it out
("own audit event since it's a new mutation shape, not a loop of existing ones").** No bulk
`assignCard` exists, so `bulkReassignCards` (`work/card.service.ts`) queries every non-archived card
carrying `fromUserId` (`uuidArrayContains`, the same named expression Docs' ancestor lookups use) and
updates each — but authorization is still PER CARD, inside the loop, because a relationship tuple can
restrict `card:update` on one board and not another (§8.2's worked example). A card the rule owner
cannot touch is reported in the result's `failed` list rather than thrown — the `sprint.add_cards`
precedent for a confirmed bulk operation: abandoning every other card because one board refused would
be worse for the org, not safer. One event, `card.bulk_reassigned`, names every card the operation
actually touched; `apps/api/src/tenancy/audit.projection.ts` resolves it to the departing member
(`fromUserId`) rather than to any one card, since there is no single card to name and "what happened
to this departing member's work" is the question an offboarding audit actually asks.

**Four of §8's ten checklist items are deliberately NOT built, and each needed a real design
decision this pass did not make, not just more typing:**

- **Onboarding item 3 (starter checklist cards / "clone template cards").** There is no `card.create`
  automation action and no card-template-cloning concept in the engine at all; inventing either is
  real, separate work, not a one-line addition to this pass's six.
- **Onboarding item 4 (notify the manager).** `platform/notification.projection.ts`'s `plan*`
  functions are deliberately PURE — no database read — and "who is this new hire's manager" needs
  one (`people.membership_profiles.manager_user_id`, Phase 11.5). Breaking that purity for one
  notification kind is a design decision for that file, not something to slip in here.
- **Onboarding item 5 (apply the role's default permission-grant bundle).** There is no "role →
  default `member_grants`" config table anywhere in this codebase yet — building one is new state,
  not a new action wrapping existing state, and deserves its own review.
- **Offboarding item 3's connector half ("connected-tool access (repo, telephony)").** The telephony
  half is already covered: `call:place`/`sms:send`/`phoneNumber:read` are ordinary `member_grants`
  permissions, which `member_grant.revoke_all` already revokes. The connector half does not apply to
  this codebase's actual model — Slack/GitHub connector rows are ORG-scoped credentials
  (`apps/worker`'s own `integration-action.service.ts`), not per-member, so there is nothing
  per-departing-member to revoke there.

_(Corrected in place, per this file's own habit, rather than silently rewritten: three of these
four — starter cards, notify the manager, the role default grant bundle — shipped in a later pass,
each after the real design decision this paragraph said it needed. The connector item above needed
no further work; it was already closed. See "Phase 15 — §8's four deferred items, closed" further
down for what actually shipped and why.)_

Offboarding item 5 ("final audit entry confirming the checklist completed") needed no new code
either, for a different reason: `automation_runs` already records every rule's full outcome
(`RunOutcome` — status, per-action results, duration) on every execution, which already answers
"did the checklist complete and what happened" more precisely than a single confirmation entry
would.

### Phase 15 §4 — the assistant's missing frontend, found while building §6 (SHIPPED)

`apps/web/src/features/ai/{api,assistant-page,setup-dialog}.tsx` ·
`apps/web/src/lib/{assistant-seed,bootstrap-flag}.ts` · the `useAi` capability
(`apps/api/src/tenancy/org.service.ts`). Spec: same file, §4 and §6.

**Every wave of the assistant — read-only search, single-card writes, sprint planning,
`chat.post_message`, `docs.create_page` — had shipped as a tRPC route with no way for a person to
actually reach it.** Building §6 (the new-org bootstrap offer) surfaced this: §6 assumes an
assistant chat surface exists to hand the user off to, and none did. Closing that gap turned out
to be §6's real prerequisite, not `docs.create_page` (which §6's own spec correctly named as
already built) — the missing piece was the ENTIRE frontend, found only because building the
feature that depends on it forced someone to look for the page it links to.

**`ai.chat.send`'s statelessness (§4 Wave 1's own design) is what let the client own the whole
transcript with no new persistence.** `assistant-page.tsx` keeps `messages` in local component
state, resending the growing array every turn exactly as the route's header always specified;
nothing server-side needed to change to grow a UI on top of it.

**Confirm-before-execute (§4.2) is rendered as one Approve/Decline row per pending call, never a
single "approve all."** `assistant.ts`'s own contract is per-id — an id absent from
`confirmedToolCallIds` is declined, never "undecided" — and a blanket approve button would make it
impossible to say yes to two proposed actions and no to a third, the exact shape a batch of
pending tool calls can take.

**`message.role === 'user'` in `MessageBubble` tripped the identical guardrail-7 name collision
`packages/ai/src/anthropic.ts` already documents for `AiMessage.role`** — a chat-turn speaker,
not an org role, matched by the lint rule's syntactic selector anyway. Fixed the same way: a
`switch` on `message.role` is not a `BinaryExpression`, so it does not trip
`packages/config/eslint/security.js`'s `roleMember`/`roleIdentifier` rules.

**`ai:use` needed its own `SettingsCapabilities` field, `useAi`, because nothing had ever read it
from `apps/web` before.** Every other individually-grantable permission (§1's Wave 2 sweep, the
telephony five) already had one; `ai:use` existed in `packages/policy` since §2.4 but had no
nav-visibility boolean to gate the new `/assistant` route and sidebar item on, the identical
`capability` + `flag` pairing `/analytics` already uses (all-or-nothing by role, unlike `/calls`'s
`anyOfCapabilities`).

**A real transcript from the §6 setup dialog produced an opaque OpenAI 400 — "An assistant message
with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'" — on a
request this codebase's own code should never have been able to construct.** Root cause:
`assistant-page.tsx`'s `respondToPending` cleared `pendingToolCalls` SYNCHRONOUSLY, before its own
resume request resolved. With `pendingToolCalls` back to `[]`, the composer's disabled condition
depended on `busy` alone to still block it — and a render landing between the `mutate()` call and
React Query's `isPending` flip (or simply a fast click) could re-enable it. Sending a new message in
that window appends a user turn, in LOCAL state, immediately after the still-unresolved §4.2
confirmation turn — a shape `pendingCallsIn` (`assistant.ts`) cannot see, since it only ever
inspects the transcript's LAST message. The malformed transcript sailed straight through to the
provider.

**Fixed on both sides, not just the client.** `respondToPending` no longer clears
`pendingToolCalls` itself — `onSuccess` already sets it to whatever the resumed turn's own result
says, and leaving it populated for the whole round trip keeps the composer AND the pending-actions
panel correctly disabled via `busy`, closing the race outright. `PendingActions` gained a `key`
derived from its own batch's call ids: since it no longer unmounts between batches
(`pendingToolCalls` never briefly empties), its internal `decided`/`approved` state needed a real
reason to reset between two different batches — otherwise a Gemini-synthesized id
(`"<name>::<index>"`, `packages/ai/src/gemini.ts`) reused by coincidence across two unrelated
rounds would read as already decided. `assistant.ts` gained `assertWellFormedTranscript`, a
defense-in-depth guard independent of the client fix: it refuses, with a clear `VALIDATION_FAILED`,
any assistant tool-calls turn that is NOT the transcript's own trailing message and has no matching
`tool_result` later in the array — turning an opaque provider-level 400 into an ordinary,
actionable validation error, and protecting against any client (this one after a regression, or a
different one) ever producing the same malformed shape again. `assistant.test.ts` proves the exact
shape from the real transcript is refused before a second provider call is ever made.

### Phase 15 §6 — new-org Docs bootstrap (SHIPPED)

`apps/web/src/features/ai/setup-dialog.tsx`. Spec: same file, §6 ("when a new org is created,
offer to have the assistant ask a few questions... and then create a starter Docs space...
using the `docs.create_page` tool").

**The "few questions" are an ordinary form, not a model-led conversation.** Letting the MODEL
phrase and interpret free-form answers to "how big is your team" would make the feature's
behaviour depend on how well the model listens to small talk, which is not a property a dialog
can test or guarantee. Two form fields (team size, handbook-only vs. handbook-plus-wiki) produce
one fully-formed instruction naming EXACT page titles, so the model's job is reduced to calling
`docs.create_page` the requested number of times — exactly what §6 asks for ("using the
`docs.create_page` tool") without depending on it having asked the right follow-up questions
itself.

**Creating the Docs SPACE is a plain mutation, not a model decision — every new org gets one
"{OrgName} Wiki" space the same way regardless of the answers, so there is no reason to spend a
model call deciding to do it.** WHICH PAGES to seed depends on the answers, and routing only that
part through `ai.chat.send` is what makes this genuinely §6 rather than an ordinary settings form:
it exercises the real §4.2 confirm-before-execute path `docs.create_page` requires, on the real
assistant page.

**REDESIGNED after shipping: the trigger is no longer a `sessionStorage` flag at all — it is
`docs.spaces.list` being empty.** The original trigger was `markOrgForBootstrap`/
`consumeBootstrapFlag` (`bootstrap-flag.ts`, now deleted), a flag set the moment `orgs.create`
succeeded and consumed — read-and-cleared — on the very next render: an offer seen exactly once,
in the tab that created the org, whether or not anyone acted on it. Closing the dialog, missing it
behind another modal, or simply not being ready to decide meant it was gone for good, with no
route back except finding Docs' own manual "+ Space" control — a real loss for exactly the org
that most needs a starter space, raised directly rather than found from a transcript. The fix
needs no flag at all, stored or otherwise: `docs.spaces.list` is already the authoritative answer
to "does this org have Docs content yet," so `NewOrgSetupDialog` now renders whenever that list is
empty and stops the moment it isn't — checked fresh via `spacesQuery(orgId)` on every mount rather
than remembered from a past visit. This is a STRICTLY simpler mechanism than the one it replaces:
no `sessionStorage`, no per-org key, no "a read is a consume" contract to get right, one query the
page already needs to decide whether to render at all. `org-picker-page.tsx`'s `orgs.create`
success handler lost its `markOrgForBootstrap` call entirely — a freshly created org trivially
satisfies "zero Docs spaces" on its own, so there is nothing left to set.

**`dismissed` stays local, un-persisted `useState`, on purpose — the offer's "off" switch and its
"on" switch are deliberately asymmetric.** Closing the dialog quiets it for the rest of THIS
browsing session (so it does not reopen on every route change within the app, which the
gating query alone would do since nothing about a route change makes a Docs space appear), but a
fresh page load re-evaluates from scratch: if the org still has no space, the offer is back. That
is the literal shape asked for — shown until a space exists, not shown forever once dismissed
once — and it is why `dismissed` must NOT be persisted to `sessionStorage` the way the old trigger
was: persisting the dismissal would recreate the exact one-shot behavior this redesign exists to
remove, just moved to a different flag.

**Handing the composed opening message from the dialog to `/assistant` needed exactly one piece
of cross-navigation state, not a rewrite of where the transcript lives.** `assistant-seed.ts`'s
`useAssistantSeedStore` holds a single pending seed — `ui-store.ts`'s own rule that Zustand holds
only things with no server representation, applied to a draft transcript that has none either.
`assistant-page.tsx` reads it once via a lazy `useState` initializer (never an effect calling
`setState`, which `react-hooks/set-state-in-effect` refuses) and consumes it — clearing the
store, not React state — in a ref-guarded effect, so Strict Mode's double-invoke can't replay the
opening message twice and a later, unrelated visit to `/assistant` starts genuinely empty.

**`NewOrgSetupDialog` derives whether to open ENTIRELY from render-time state, with no effect at
all** — `use-board-room.ts`'s own "reset derived state when a prop changes" pattern, applied to an
org switch: Shell mounts this component once and keeps it mounted across `orgId` changing, so
re-deriving `dismissed` during render when `orgId !== lastOrgId` is what lets the offer re-arm
correctly the moment someone switches to a SECOND org with no Docs space yet, without ever calling
a `useState` setter synchronously inside a `useEffect` body. The mutation's own `onSuccess` calls
`invalidateSpaces(queryClient, orgId)` before navigating away — without it, the gating query could
still read the pre-creation empty list on a later visit (stale, not wrong) and show the offer one
more time despite the space already existing.

**Deliberately not built: §6's own two questions as a model-parsed free-text exchange** — a form
was, and remains, the correct, testable choice instead (see above). The "no org-level 'was this
ever offered' record" deferral this section used to note here no longer applies to the CURRENT
design at all: there was never a need for one, on EITHER version — the first used a session-scoped
flag instead, and this one uses live Docs state, and neither is a durable "offered" record of the
kind a wizard's completion flag would be.

### Phase 15 §5 — the standup view (SHIPPED)

`apps/api/src/standup` · `apps/web/src/features/standup`. Spec:
[ai/phase-15-ai-copilot-and-permissions.md](ai/phase-15-ai-copilot-and-permissions.md) §5 ("a new
screen, not a new subsystem — assembles data that already exists").

**`query` floors on `project:read`, not `analytics:read` — a standup is a daily ritual every
project member should reach, not an Admin/Owner-only report.** `standup.service.ts`'s own header
states this explicitly: Analytics's floor is deliberately narrow because it answers a management
question; a standup answers "what is my team doing right now", which every Member holding
`project:read` by role already needs to see the board at all. `router.test.ts` proves the
difference between the two enforcement LAYERS this produces for the identical `guest` refusal —
the ROUTE floor (`route({ permission: 'project:read' })`, a plain role check that never reaches
the handler) answers FORBIDDEN, while `queryStandup`'s own resource-aware `enforceOn` check,
exercised directly in `standup.service.test.ts`, answers NOT_FOUND for the same guest calling the
service layer beneath it — `enforceOn`'s `denialFor` returning the "reveals less" answer when the
permission failing is the read permission itself. Neither test's expectation transfers to the
other layer; each is right for what it actually measures.

**Narration is one `completeGated` call, not the §4 tool-calling loop — there is nothing for the
model to DO here, only text to produce from data the server already assembled.** `narrate.ts`
calls `queryStandup` itself and serializes the result as the user turn; §2's own `complete.ts`
doc comment had already anticipated `'standup'` as a feature name before this section existed,
which is what confirmed the one-shot design was the intended shape rather than an improvised
shortcut around the loop.

**`narrate` never accepts a client-supplied "standup data" blob to summarize — it re-runs
`queryStandup` itself, under the same two gates (`ai:use` + `aiAssistant`) `query` alone does
not need.** A route that trusted the caller's own copy of the standup would let anyone type up a
JSON payload for a project they cannot read and have the assistant narrate it back to them,
defeating `query`'s own floor from one route over. `router.test.ts`'s end-to-end case (a stubbed
`fetch`, mirroring `ai/router.test.ts`'s own pattern for the identical reason —
`AnthropicProvider` speaks raw `fetch`, no SDK) asserts the resulting ledger row carries
`feature: 'standup'`, not a generic `chat` label, so a spend report can tell the two apart.

**Redesigned the same day it first rendered against real data — both halves of the original
version looked correct in isolation and were genuinely unusable together.** The first cut asked
the model for "one paragraph, plain sentences, one per person" and rendered whatever text came
back verbatim; against ~15 real members that was one run-on paragraph with no visual seams
between people, exactly as loosely as it sounds — nothing about a text completion GUARANTEES the
shape a prose instruction asks for. And the page itself rendered every member's full three-bucket
grid always expanded, one full-width section per person: since "Done recently" and "Overdue" are
usually empty, that squeezed "Still open" (often 8-13 cards) into a third of the width and
truncated every title into an unreadable fragment, for a page ~15 sections tall.

**The fix for the narration is `AiCompletionRequest.tools` — already built for §4's tool-calling
loop — reused here as a one-tool "response schema," not free text.** `narrate.ts`'s
`emit_standup_lines` tool takes `{ lines: [{ userId, line }] }`; `stopReason !== 'tool_use'` is
treated as the model declining to comply and throws, never a silent fallback to raw prose — the
identical "have the model return real structured data" decision this file's own §2+§3 section
already documents for the AI provider abstraction generally, applied here for the first time to
an actual caller. Classification (who has overdue work, who has nothing) stays entirely
DETERMINISTIC — computed server-side from the real buckets `queryStandup` already assembled,
never something asked of the model — the model's only job is one short sentence per person it is
already given the id for. A member the model omits gets a computed fallback line
(`fallbackLineFor`, e.g. "2 overdue, 1 still open.") rather than silently vanishing from the
summary; a duplicate id resolves to the LAST line named, the same "later wins" rule this codebase
uses for every other last-write-in-a-batch shape. `linesFromCompletion` is the pure parse/merge
half, exported specifically so `narrate.test.ts` can prove the merge-with-fallback and
malformed-input cases directly against a hand-built `AiCompletionResult` — fast, no database —
while `router.test.ts`'s existing end-to-end case still proves the real wiring (a stubbed `fetch`
answering with Anthropic's actual `tool_use` content-block shape, not a plain-text one).

**Structured output alone was not enough — the tool call forced a SHAPE, and said nothing about
the CONTENT, so the first prompt still produced lines nobody would want to read.** Found by
looking at real narrated output: every line started by repeating the person's own name a second
time ("Aoife — Aoife has two overdue items...") because the prompt never told the model the name
would already be shown next to it, and a person with nothing overdue got a bare "has no overdue
tasks" — a lazy, technically-complete answer to "call out anything overdue" that says nothing
about what they are actually doing. Both are PROMPT fixes, not shape fixes: the system prompt now
explicitly says the name is already shown ("never repeat it, never start the sentence with it"),
requires the line say something concrete about the person's actual work rather than only whether
anything is overdue, and asks for card references (not just counts) and varied sentence structure
across people so eighteen lines do not all read as the same template with different numbers
substituted in.

**`headline` is a fourth field, computed and never asked of the model, added for a genuinely
different reason than the line-content fix above.** The project owner asked to "see it in all" —
an aggregate across the whole roster ("how many people have overdue work, how many cards got
done") — and the answer is a `Array.filter`/`.reduce` over data `queryStandup` already assembled,
not a fifth thing to ask an LLM to count correctly over eighteen people's buckets. `headlineFor`
is exported and unit-tested directly, the same "classification stays deterministic" rule this
section's own line-fallback logic already follows — an aggregate that could be wrong in a way a
plain count cannot is strictly worse than one more `completeGated` call would have been worth.

**The apparent duplicate member row (two people both displayed as the same first name) was
diagnosed, not silently fixed, because it isn't this feature's bug.** `queryStandup`'s per-member
bucket is a `Map<string, ...>` keyed on the real `userId`, so it is structurally impossible for
one person to produce two entries — two identical-looking rows can only mean two DIFFERENT
`userId`s whose display names happen to collide, which `packages/seed`'s own
`displayNameNicknameShare` config (a fraction of demo profiles display a bare first name instead
of a full name) makes a real, expected possibility in fake data. Told to the project owner as a
diagnosis with the reasoning, not assumed away — this codebase's own "verify before you claim a
fix" discipline applied to a report, not just to code.

**The fix for the page is collapsing every member to a name-plus-counts row by default, never
merging or hiding anyone regardless of activity.** `MemberRow` opens to the identical
three-bucket layout the first version always showed, now with the whole page width to itself
instead of a third of it shared with fourteen other people's sections. The count badges
(`CountBadge`) dim to near-invisible at zero rather than always drawing the eye, so a scan of the
collapsed list answers "who has overdue work" without opening anything. Explicitly NOT done,
by direct instruction after the redesign was scoped as options: sorting members by urgency or
folding anyone with nothing noteworthy into a shared "no updates" group — every project member
keeps their own row in the order `queryStandup` returns them, on the reasoning that a standup is
a roll call, and an ordinary day is not a reason to skip someone.

**The frontend reuses the real board card-detail panel wholesale, reached without a board in
hand — not three rebuilt sections.** §5's own text names `card.move`/`card.assign` as "the
existing mutation path, just reachable from a standup-shaped screen instead of the board view."
Every other caller of `CardDetailPanel` already knows the card's `boardId` because it opened the
panel FROM that board; a standup row has only a card id. `card-quick-view.tsx` closes that one
gap — fetch the card once to learn its `boardId`/`projectId`, then mount the identical
`CardDetailPanel` the board uses — rather than re-implementing assignee, priority and location
controls a second time. Every mutation a person makes from the standup view is therefore the
exact same `cards.assign`/`cards.update`/`cards.move` call, with the exact same `can()` check and
the exact same domain event, that a click on the board would have made; the panel closing
invalidates the standup view's own cache entry (scoped to that project, not the whole `projects`
branch other unrelated queries share) so the buckets reflect whatever just changed.

**The "Narrate" control is gated inline, on the button itself, never at the route.** Unlike
`/analytics` and `/assistant`, which wrap their entire page in `CapabilityGate`/`FeatureGate`
because their whole surface is Admin-and-Owner-or-plan-gated, `/projects/$projectId/standup` gates
nothing at the route — every project member who can already open the board can already open this
page. Only `narrate`'s two additional gates (`ai:use`, `aiAssistant`) are checked client-side, and
only to decide whether the button renders at all, per Phase 15 §1's "hide, don't disable" rule; a
Member without either simply does not see the button, and the server re-checks both regardless of
what the client decided.

**Deliberately not built: an emailed copy of the standup**, per §5's own text ("no email report
as the primary surface... an optional emailed copy can reuse the existing notification-mail path
later if wanted, but is not required for this wave") — a real, explicitly named deferral, not an
oversight.

**A FIXED `maxOutputTokens` broke against a real team, found from production logs rather than any
test in this codebase's own (smaller) fixtures.** `narrateStandup` originally capped
`emit_standup_lines`' completion at a flat 800 tokens; a project of ~18 members, each needing a
full `userId` (a uuid, ~15-20 tokens) plus the richer per-person sentence the prompt fix above now
requires (a card reference, concrete work described, not just a bare count), pushed the JSON tool
arguments past that budget. The model's output was truncated mid-argument, `packages/ai`'s
`toolCallFromWire` failed to `JSON.parse` the cut-off string, and `standup.narrate` 500'd with
`OpenAI returned malformed tool-call arguments` — the provider's own error handling doing exactly
its documented job (fail loud on malformed JSON rather than hand a tool corrupted input), which is
why the fix belongs in the caller's token budget, not in loosening that check. `maxOutputTokensFor`
replaces the constant: scaled by member count (`memberCount * 70`) rather than a second fixed
number, floored at 800 so a small project still gets a cheap call and ceilinged at 4,000 so a very
large roster cannot turn one narration into unbounded spend. Exported and unit-tested directly in
`narrate.test.ts` against the floor, the linear middle, and the ceiling — the same "prove the pure
half without a database" pattern this file's `linesFromCompletion`/`headlineFor` already use —
rather than trusted only through `router.test.ts`'s small fixture, which is exactly the kind of
case that let the original fixed budget go unnoticed until real data hit it.

**REDESIGNED again, this time replacing the whole per-member narration with real
Yesterday/Today/Overdue/Urgent buckets and an optional team-level callout.** The project owner's
own comparison made the gap concrete: a real daily standup answers "what did you do yesterday,
what are you doing today, what's blocking you" — the ClickUp workflow this screen exists to
replace is exactly "filter the sprint by member and look at their cards," and the AI-prose design
was answering a different, worse question. Looking at real narrated output (18 people, pasted
directly) showed why: every line read as arbitrary busywork ("still working on X and Y") because
`stillOpen` was the ENTIRE non-done backlog — a card nobody had opened and a card someone was
actively coding were indistinguishable, so the model had no real signal for which two cards
represented "today" and was effectively guessing.

**The fix is a data-model change, not a prompt change — `work.statuses.category` (`not_started` /
`active` / `done`) already had the distinction the old bucketing threw away.**
`standup.service.ts`'s `StandupMember` now carries `yesterday` (done within the window, unchanged
from the old `recentlyDone`), `today` (status category `active` and not done — a real "what am I
doing right now", not the whole backlog), `overdue` (unchanged), and `urgent` (`urgent`/`high`
priority, not done, and NOT already in `overdue`, kept disjoint from it so a card past its due
date is never double-counted under two headings). `not_started` backlog cards are excluded from
every bucket on purpose, not merely unbucketed — a standup is not the place to dump an entire
backlog, and a member who wants that already has the board. `headlineFor` moved from `narrate.ts`
into `standup.service.ts` and is now returned directly on `StandupResult` — it needs no AI call,
so `query` alone is now a complete, meaningful standup screen with no button to click.

**`narrate.ts` no longer produces a per-member line at all — its whole job shrank to one optional,
team-wide callout paragraph.** Once real Yesterday/Today/Overdue/Urgent lists are the page's
primary content, a per-person AI SENTENCE describing the same data is redundant with what the page
already renders directly next to that person's name — the "classification stays deterministic"
rule extended one step further: not just the bucketing but the PRESENTATION of one person's own
status is a fact, not something worth a completion to paraphrase. What a model is actually suited
for is the one thing buckets alone cannot show: a pattern across the WHOLE roster a PM would
otherwise have to find by eyeballing eighteen rows — several people blocked on the same
dependency, or one person carrying an unusually heavy load relative to everyone else.
`emit_team_callout` (replacing `emit_standup_lines`) takes exactly `{ callout: string }`, and the
model is explicitly told it is fine to say nothing stands out rather than inventing a pattern to
fill space. `calloutFromCompletion` (replacing `linesFromCompletion`) still fails LOUD on a
declined or malformed response — but for a different reason than before: the old fallback-per-line
design existed because the UI structurally needed one line per member and could not afford to
silently drop anyone, while this route's entire output IS the callout, so there is nothing sensible
to fall back to.

**The old per-member token-budget fix (`maxOutputTokensFor`, scaled by team size) is gone along
with the mechanism it protected — replaced by a single fixed `MAX_OUTPUT_TOKENS = 400`.** This is
not a regression back to the bug a few paragraphs up: that bug existed because the OUTPUT scaled
with team size (one JSON entry per member); a short callout paragraph does not scale with team
size even though the INPUT payload still does, so a fixed output budget is the correct choice here
specifically, not merely the simpler one.

**The web page changed to match**: the always-visible headline banner now reads directly from
`standup.data.headline` rather than only appearing after a narrate click, each member row grew a
fourth count badge and expanded section (Yesterday / Today / Overdue / Urgent, using `PlayCircle`
for "today" and `Flame` for "urgent" — distinct icons from the existing done/overdue ones so a
four-badge row still scans at a glance), and the "Narrate" panel shrank to a single paragraph with
no per-person list. `MemberRow`'s "nothing to report" check now looks at all four buckets.

**`StandupCardRow` packed reference + title + due date into one horizontal flex line, and inside
the four-column bucket grid that left the title almost no width — found from a real screenshot, not
a layout review: a title like "Audit WIP limits under concurrent edits" wrapped to one or two words
per line for a dozen lines.** The row's remaining width after two `shrink-0` metadata spans (a
mono-font reference and a due date) is generous at the page's full width (the top-level
urgent-sprint list, where this row is also used) and often under 100px inside a bucket column — the
same title text, two very different outcomes, from the same component. Fixed by stacking the row
into two lines instead of one: a compact metadata line (priority dot, reference, due date) above,
the title on its OWN full-width line below. The title now always gets the whole row's width to wrap
into regardless of how narrow the surrounding column is, so the fix holds at both the wide
top-level list and the narrow bucket grid without a media query telling it which one it's in.

**§6 (new-org Docs bootstrap) and §8 (onboarding/offboarding automation) are both real, verified
gaps in DISCOVERABILITY, not incomplete features — checked against the actual code, not assumed.**
§6 has a real trigger (`org-picker-page.tsx`'s `markOrgForBootstrap`, fired the moment `orgs.create`
succeeds) but it is a one-shot `sessionStorage` flag by design (`bootstrap-flag.ts`'s own header —
"§6 is an OFFER, not a state machine"), so it is only ever seen once, in the same browser tab, at
the moment a NEW org is created — an existing org will never show it, and there is no menu item to
summon it again. §8 is a step further: a search across `apps/web/src` for every one of its six new
automation action types (`channel.add_member`, `channel.remove_member`, `docs.grant_space_access`,
`member_grant.revoke_all`, `identity.revoke_sessions`, `cards.bulk_reassign`) and for
`startOffboarding`/`offboarding_started` returns ZERO matches. `apps/web/src/features/automation/
vocabulary.ts`'s `TRIGGER_OPTIONS` has no `member.added` or `member.offboarding_started` entry, and
its `ACTION_LABELS`/`ActionValue`/`ARGUMENTS` have none of the six new action types — the rule
builder cannot construct a rule using any of them. There is also no button anywhere that calls the
new `tenancy.members.startOffboarding` route. This is the identical "shipped backend, no consumer"
gap this file's own Phase 15 §4/AI-Models-tab entries already document twice — found here a third
time, by the same kind of direct code check rather than trusting the spec's own account of what
shipped. **Fixed in a follow-up pass — see the §8 UI wiring section, right after the §4.3 sprint
planning entry below, for what shipped.**

### Phase 15 — §8's UI wiring: the trigger, the six actions, and the offboarding button (SHIPPED)

`apps/web/src/features/automation/{vocabulary,action-pickers}.tsx` ·
`apps/web/src/features/admin/settings-page.tsx` · `apps/mobile/src/lib/automation.ts`. Closes the
gap the paragraph directly above this section documents: §8 (`ai/phase-15-ai-copilot-and-
permissions.md` §8) had shipped a trigger, six automation actions, and a member-facing route with
zero UI path to any of them — a rule using one could only ever be written by hand against the raw
API, and nothing could ever fire `member.offboarding_started` at all.

**`member.added`/`member.offboarding_started` join `TRIGGER_OPTIONS` as a SECOND card-less
exception, the same shape the Wave 4 slice 3 connector events already are.** Both carry a `userId`,
never a `cardId` — every one of §8's six actions is written against that instead
(`apps/worker/src/automation/executor.ts`'s own `userIdOf`, the identical discipline `cardIdOf`
already applies to every card trigger). No new filtering mechanism needed: the builder already
offers every action regardless of the selected trigger and lets a mismatched combination fail
honestly at runtime (`trigger_not_evaluable`) — the same accepted shape a card action paired with a
connector event already has, extended one trigger pair further.

**The six actions needed one new `ArgumentKind`, `'space'`, and nothing else structurally new.**
`channel.add_member`/`channel.remove_member` reuse the existing `channel` picker unchanged;
`cards.bulk_reassign`'s `toUserId` reuses `member`; `identity.revoke_sessions` and
`member_grant.revoke_all` take zero arguments, which `ARGUMENTS`' own empty-array entries already
make `actionsComplete` treat as complete with nothing to render underneath — the two-arg-and-fewer
shapes this table already had covered every case but one. `docs.grant_space_access`'s `spaceId` is
the exception: `SpacePicker` (`action-pickers.tsx`) is a new, small component reusing
`spacesQuery(orgId)` from the Docs feature, org-scoped like `ChannelPicker` right above it in the
same file — a Docs space belongs to the org directly, never to a project, so (unlike
`list`/`status`/`label`) it needed no entry in `PROJECT_SCOPED` and no project-choice step first.

**None of the six carries a `userId` field of its own — a rule always acts on the member the
TRIGGER named, never one a rule author could type in.** This mirrors the server-side refusal
`action-schema.test.ts` already proves (a `.strict()` Zod schema with no `userId` key), so the
absence here is not merely cosmetic: even if a picker offered one, the server would reject the
saved rule. `cards.bulk_reassign`'s `toUserId` is the one field naming a second person, and it is
labelled "Reassign to" rather than left to read as the trigger's own subject, since it names the
REPLACEMENT assignee, not who the rule is about.

**"Start offboarding" (`settings-page.tsx`'s `MemberRow`) is the first and only thing in the
product that can fire `member.offboarding_started` at all — without it, every rule built on the
trigger above would sit forever unfired.** Gated on `member:remove`, the same permission `Remove`
already floors on and the identical capability (`removeMembers`) already read from
`SettingsCapabilities` — flagging someone as leaving is a strictly smaller action than removing
them outright, so reusing the permission rather than inventing a narrower one is deliberate, not
a shortcut. Not a `ConfirmButton` like Remove: the route itself carries no step-up and writes no
column at all (`member.service.ts`'s own header — "nothing here is destructive or hard to undo"),
and calling it twice is explicitly harmless by design, so a confirm step would be friction over a
control this codebase's own contract already treats as safe to click twice. Feedback is a toast
(`useToast`), not a visible row change, because there genuinely is no row change to show —
`startOffboarding` writes an event and nothing else — and a silently-successful button invites a
confused second click the toast is what actually prevents.

**`apps/mobile` gets the DISPLAY half only, not a matching editor — a deliberate, narrower scope
consistent with a boundary that already existed before this pass.** Mobile's own
`automation.ts`/`automation-editor.tsx` already draws a line between what it can EDIT and what it
can only READ: `call_webhook` and the two connector actions have real labels in `ACTION_LABELS`
but no entry in mobile's own (smaller) `ARGUMENTS` table, so `EDITABLE_ACTION_TYPES` excludes them
and `canEditOnMobile` refuses "Edit" for a rule holding one, while the rule list and run history
still describe them correctly. The six §8 actions get the identical treatment — labelled for
`describeAction`/`actionOutcomeOf`, absent from `ARGUMENTS` — rather than a second native `space`
picker and a full parallel builder: without the label entries, a rule built on WEB using any of
the six would have shown its bare type string ("channel.add_member") instead of a sentence the
moment someone opened it on a phone, a real regression this pass caught and closed rather than
shipped alongside the web changes. Building a native space picker and full edit support for these
six, matching web exactly, is real, separate work this pass does not attempt.

**Deliberately not built in this pass: any UI surface for §8's four still-deferred checklist
items** (starter cards, notify-the-manager, default permission bundles, connector-access
revocation) — see this file's own §8 section for why each needed a real design decision rather
than more wiring. This pass closes the gap for the SIX ACTIONS AND TRIGGER that already existed
in the engine with nothing pointing at them; it does not expand §8's own scope.

### Phase 15 — §8's four deferred items, closed (SHIPPED)

`apps/worker/src/automation/{types,executor,loop-protection}.ts` · `apps/api/src/automation/
{automation.service,router}.ts` · `apps/api/src/tenancy/{events,audit.projection,role-default-grant.service,router}.ts`
· `apps/web/src/features/{automation/vocabulary,admin/settings-page,org/api}.ts` ·
`apps/mobile/src/lib/automation.ts` · migrations 0102–0103. Spec: same file, §8's own checklist —
the four items this file's own account of §8 (above) named as deliberately deferred, each needing
a real design decision rather than more wiring.

**Prompted by the project owner directly, in the identical spirit that motivated the earlier
five-tool-registry-gaps pass: "find a better way... but first proper search checking... we can't
afford to do tweaks later as it will touch some sensitive areas."** That instruction changed the
METHOD — research and a written plan before any code, with one `AskUserQuestion` for the single
genuine design fork, rather than the usual one-report-at-a-time cadence — not the bar for what
counts as real work. All three items below trace to the exact deferral reasoning this file's own
§8 section already gave; none is speculative scope beyond what that section named.

**Item 4 (offboarding: revoke connector access) needed no code and stays closed — confirmed, not
assumed.** Telephony access (`call:place`/`sms:send`/`phoneNumber:read`) is an ordinary
`member_grants` permission, already revoked by `member_grant.revoke_all`. Slack/GitHub connector
rows are ORG-scoped credentials (`apps/worker/src/automation/integration-action.service.ts`), not
per-member, so there is nothing per-departing-member to revoke there. The research pass re-verified
this rather than trusting the original deferral note's own account of it.

**Item 1 (onboarding: starter checklist cards) turned out smaller than its own deferral text
implied, once actually researched — the blocker was believed to be "no card-creation action, no
template concept," and neither half of that was really true.** `createCard(actor, {listId, title,
description})` was already a plain, fully-authorized (`card:create` on the board) service call with
its own test coverage, and the automation engine already lets one rule hold several actions on one
trigger — so a three-card starter checklist is three `card.create` actions on one `member.added`
rule, with no template/cloning subsystem needed at all. Ships as a new `card.create` action, no
description field (a title is enough for a checklist item, the same plain-string shape `sms.send`'s
`body` already has), following the established three-place-plus pattern (the `AutomationAction`
union and executor switch in `apps/worker`, the mirrored union and `EVENTS_EMITTED_BY` self-trigger
table in `apps/api/src/automation/automation.service.ts`, the write boundary's Zod schema, and the
builder vocabulary in `apps/web` plus a display-only label in `apps/mobile`).
`loop-protection.test.ts`'s own "every card action emits `card.updated`" assertion needed a genuine
carve-out rather than a workaround: `card.create` is the one `card.*` action that does not mutate
an EXISTING row — it inserts a new one and emits only `card.created`.

**Item 2 (onboarding: notify the manager) was the real blocker its deferral text described —
`notification.projection.ts`'s `plan*` functions are deliberately pure, and "who is this new hire's
manager" needs a database read (`people.membership_profiles.manager_user_id`, Phase 11.5).**
Resolved by the CALLER (`drainNotifications`), exactly like `actorLabel` already is (migration
0087's own precedent), never inside the pure planning layer. `planManagerNotified` is a THIRD role
none of this file's other notification kinds have needed: the recipient is neither the actor (who
added the new member) nor the event's own subject (who was added) — they are looked up from a
separate table entirely. `resolveManagerUserIds` mirrors `resolveActorLabels`' batched-lookup and
fail-open shape on purpose, including the 0087/0088 lesson it was built from: an unhandled error
here would abort `drainNotifications`' whole transaction and silently stop every consumer scheduled
after it in the same tick, so a missing manager notification degrades quietly rather than causing
an outage. Keyed by `${orgId}:${userId}`, not a bare `userId` — the same user id can be a member of
more than one org with a different manager in each, a possibility this file's own account of
multi-org membership elsewhere already establishes as real, not hypothetical.

**Migration 0102's own first draft would have shipped a silent bug — caught by re-reading 0071's
precedent rather than by a failing test.** `resourceOf` (the audit projection's own resource-mapper)
reads its `key` field out of the event's PAYLOAD, never off the outbox row's own `orgId` column —
confirmed by checking `member.ownershipTransferred`'s payload, which carries `orgId` explicitly
for exactly this reason. The new `role_default_grant.set`/`.removed` events (see item 3, next) were
first drafted without an `orgId` field at all, on the assumption that `RESOURCE_OF`'s `key: 'orgId'`
mapping would fall back to the envelope — it does not, and would have produced audit entries with a
null `resource_id` forever. Fixed by adding `orgId` to both event payloads before anything shipped.

**Item 3 (onboarding: apply the role's default permission-grant bundle) was the one place the
project owner's own choice mattered — a genuine fork the deferral text had already flagged
("there is no 'role -> default `member_grants`' config table anywhere in this codebase yet...
deserves its own review"), put to `AskUserQuestion` rather than guessed.** Two shapes existed: (a)
a new automation action a rule author adds to their own `member.added` rule, consistent with every
other §8 item's architecture, opt-in by construction, and (b) a standalone "default permissions per
role" admin screen applied directly and unconditionally by `member.service.ts`'s own join path —
closer to the literal spec wording, but a bigger, more magic-feeling change reaching into identity/
tenancy code that has never needed to know about this concept. **The project owner chose (a).**

**`authz.role_default_grants` (migration 0103) is a THIRD authorization mechanism, not
`authz.member_grants` reused with a null `membershipId`.** It is pure CONFIGURATION ("what does a
new Member get by default"), never itself consulted by `can()` — only the new automation action
reads it, to decide which REAL `member_grants` rows to stamp for the member its trigger named.
Folding this into `member_grants` would make every reader of that table's own
`member_grants_membership_idx` handle a resource-less-AND-membership-less case that isn't really
about one membership at all — a config template and a granted capability are different things with
different lifecycles, the identical reasoning that kept `member_grants` a second mechanism rather
than folding into `relationship_tuples` in the first place (0097's own header). Real DELETE, unlike
`member_grants`' `revoked_at`: this table has no history to preserve, it is standing config, the
same shape `platform.flag_overrides` already has — changing an org's bundle for the `member` role
is an edit, not an event worth remembering forever. `role`, unlike `permission`, DOES get a CHECK
constraint (the identical closed list `identity.memberships.role` already has) — the role catalog
is stable in a way the grantable-permission list is not, so constraining it in the schema costs
nothing. No separate `taskflow_app` grant was needed at all: migration 0001's `ALTER DEFAULT
PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA authz` already covers full CRUD on every table this
schema gets, this one included — only the RLS policy needed writing, mirroring `member_grants`'
own migration 0097 exactly.

**The executor's new `member_grant.apply_role_defaults` case re-resolves the TARGET member's own
CURRENT role, never trusting the trigger event's own `role` field and never letting a rule author
name one — the union has no field for it at all.** The identical "a demotion takes effect
immediately" reasoning this file's `execute()` already applies one level up for the RULE OWNER,
applied here one level down for the person the rule acts on: a stale or rule-author-supplied role
would let a rule apply a bundle configured for a role the member does not actually hold. It then
loops the real, already-idempotent `memberGrants.grant` once per configured permission — a member
with an empty bundle (the common case, since most orgs will never configure one) loops zero times
and the action is a no-op, and re-running it (a retried rule, or two rules both applying defaults)
never duplicates a grant.

**Settings gained a "Role defaults" section — a small `member`/`guest` × `GRANTABLE_PERMISSIONS`
toggle matrix, deliberately excluding `owner` and `admin` as configurable rows.** Both already hold
every individually-grantable permission BY ROLE (`packages/policy`'s `ROLE_PERMISSIONS`), so a
checkbox for either would be either always-checked-and-inert or, worse, a control that reads as
doing something it cannot. Gated on the same `manageMembers` capability the Individual permissions
section beside it already uses — no new capability field needed, since the underlying routes are
gated on the identical `member:manage` permission. `apps/mobile` gets the DISPLAY-only label for
the new action, the same treatment every other §8 action already has there: no native picker
needed, since the action takes no arguments at all.

**No dedicated DB-backed integration test was written for either migration's grant/RLS wiring —
a real, acknowledged gap, not an oversight.** Both follow an already-proven, previously-tested
pattern (0037's column-limited-grant-plus-permissive-policy shape for migration 0102; 0097's
ordinary-tenant-policy shape for migration 0103) rather than inventing a new one, and this sandbox
has no Postgres to verify against locally — consistent with this session's own established
practice of relying on CI's real-Postgres run for DB-backed correctness while local coverage
proves everything provable without one: the pure planning/lookup logic (`planManagerNotified`,
`planManagerNotifications`, `resolveManagerUserIds`'s fail-open behavior against a fake `tx`, the
identical shape `resolveActorLabels`' own tests already use), the write-boundary Zod schemas, the
executor's target-resolution discipline, and `audit.projection.test.ts`'s own "every registered
event is mapped" invariant, which the new `role_default_grant.*` events had to satisfy to pass at
all.

### Phase 15 §7 Wave 1 — GitHub/PR read tools for the AI assistant (SHIPPED)

`apps/api/src/automation/pr-read.service.ts` · `apps/api/src/ai/tools/pr.ts` ·
`apps/web/src/features/ai/tool-results.tsx`'s three new renderers. Spec: same file, §7 ("GitHub/PR
integration — separate wave — larger, needs its own review pass"). §7's own text asks for four new
permissions, read tools, write tools (comment/request-changes/merge/close, the last two
confirmation-gated), an inbound-webhook extension for `pr.merged`, and a card↔PR link table. This
wave ships exactly the read tools and one permission — everything else named above is real,
separable follow-up work, not built here.

**The webhook piece §7 itself calls "the largest single piece, needs its own human-review pass" —
already existed, shipped in Phase 10 Wave 4, and §7's own text never noticed.** `apps/api/src/
automation/integration-webhooks.ts` already verifies inbound GitHub webhook signatures
(`packages/security/github-signature.ts`, also already built) following the identical
order-of-operations the telephony webhook established: resolve the org from the UNVERIFIED
`repository.full_name`, load THAT org's stored secret, verify, only then trust the payload. It's
already a CLAUDE.md ⚠ human-review surface (Phase 10's own review pass covered it) and already
replay-deduped (`platform.integration_deliveries`). Every inbound event becomes one generic
`integration.github_event` domain event (`providerEvent` = the `X-GitHub-Event` header,
`payload` = the raw body), and the automation engine's condition evaluator
(`apps/worker/src/automation/engine.ts`) already matches rules on `provider_event`/`provider_scope`
for it. What's genuinely still missing for "auto-move the card to Done when its PR merges" isn't a
webhook at all — GitHub sends every `pull_request` sub-action (opened, closed, merged,
synchronize...) as the identical `providerEvent: 'pull_request'`, and the condition evaluator has
no payload-field matching to tell a merge from a synchronize; separately, this generic
connector-event trigger was never exposed in the web rule-builder's `TRIGGER_OPTIONS` vocabulary at
all — the same "shipped backend, no UI" gap this file documents for §8's six actions and the AI
Models tab. Both are real, scoped follow-up work for a later wave, not something this wave needed
to touch.

**Scope precedent, checked rather than assumed: `ai:use` was introduced ALONE, one permission with
one caller in the same wave — not bundled with siblings that had no caller yet.** That's the closer
precedent than the Wave 2 `GRANTABLE_PERMISSIONS` addition (`automation:manage`/`webhook:manage`/
`integration:manage`/`apiToken:create`/`apiToken:revoke`), which made permissions ALREADY IN the
catalog and ALREADY CHECKED individually grantable — a different situation from registering a
brand-new permission ahead of any code that checks it. So this wave adds exactly one permission,
`pr:view` — not `pr:review`/`pr:merge`/`repo:connect`, §7's other three, which gate tools that don't
exist yet. Registering all four now would reproduce the exact "flag/permission registered ahead of
its first caller, then nobody comes back to wire it" gap this file already documents twice
(`aiAssistant` granted to no plan for a release cycle; `analytics` checked by no route for a release
cycle). `pr:view` follows `ai:use`'s own five-place pattern exactly: `PERMISSIONS`,
`ORG_LEVEL_PERMISSIONS` (the connector is org furniture — `platform.integrations` has no
per-resource tuple target), `GRANTABLE_PERMISSIONS`, `roles.ts`'s `ADMIN` array only (not
`MEMBER`/`GUEST` — an org grants it to one trusted Member individually instead of promoting them),
and `matrix.test.ts`'s hand-written `EXPECTED.admin`.

**`GRANTABLE_PERMISSIONS`'s own test file, `member-grants.test.ts`, turned out to be a HAND-
MAINTAINED enumeration with a hardcoded `.size` assertion, not generic coverage — found by actually
checking rather than assuming a plan note was right.** The plan going into this wave assumed the
member-grant write path generically covered every entry in `GRANTABLE_PERMISSIONS`, the same way
`matrix.test.ts`'s parametrized role × permission loop covers every entry in `PERMISSIONS` for
free. It doesn't: `member-grants.test.ts` asserts `isGrantable('pr:view')` in one explicit new test
case, one per wave, exactly like `matrix.test.ts`'s `EXPECTED.admin` — and `expect(
GRANTABLE_PERMISSIONS.size).toBe(11)` would have kept passing at 11 forever, silently proving
nothing about the twelfth entry, had it not been bumped to 12 alongside the new case.

**`connectedGithubRepo` (new, `integration.service.ts`) is the first "the org's connector" lookup —
every existing read (`connectorFor`) takes a specific `integrationId`, because the AI tool registry
never hands a tool an opaque connector id at all; the model only ever knows "the org's GitHub
repo."** Owns no decrypt logic itself — it resolves the row id, then delegates to `connectorFor` for
the actual unwrap, so an AAD or key-handling change still has exactly one call site. `ORDER BY
created_at DESC LIMIT 1` is a documented tie-break, not a proof of uniqueness: nothing in the schema
stops an org ending up with two simultaneously-`'connected'` GitHub rows (`selectRepo` only
revives/retires a row sharing the SAME `provider_scope`; connecting a second, different repo without
disconnecting the first isn't refused at that layer) — preventing that is a future
`integration:manage`-route concern, not something this read-only lookup can fix by picking
differently, so it's tested and documented rather than silently assumed impossible.

**Every function in `pr-read.service.ts` checks `pr:view` itself, mirroring
`integration-action.service.ts`'s own `assertMayManage` exactly, for the identical reason: these
functions have no tRPC route of their own — only the AI tool registry reaches them — so a route-level
floor doesn't exist to lean on.** `repoPath` (the path-traversal guard `createGithubIssue` already
used before interpolating a stored `provider_scope` into a GitHub URL) is exported and reused rather
than reimplemented a third time.

**`get_pr_diff` is the one tool in this whole registry whose GitHub response isn't JSON — a diff is
raw text — and it still comes back as a JSON-enveloped `ToolResult.content`, not raw text passed
through.** Every other tool and `tool-results.tsx`'s own `parseJson` helper assume JSON; wrapping the
diff as `{prNumber, truncated, diff}` keeps that assumption true end to end rather than special-
casing one tool's transport shape. Capped at 20,000 characters — "real input-size hygiene," the same
role `search.query`'s own limit and `ChatSendInput.messages`'s 40-cap play elsewhere — with both a
structural `truncated: boolean` and a human-readable marker appended to the text itself, so the model
can tell the person their diff was cut off without reasoning about the boolean alone.

**`get_pr_comments` merges GitHub's two genuinely separate comment endpoints** — the Issues API's
conversation thread and the Pulls API's inline review comments — tagged `kind: 'general' | 'review'`
and sorted by time, because "what did reviewers say" needs both and GitHub itself never merges them.

**`tool-results.tsx` gained its first renderer linking OUTSIDE TaskFlow entirely.** Every prior
renderer's `<Link>` opens a real `apps/web` route; a GitHub PR has none, so `renderListPrs` is the
first plain `<a target="_blank" rel="noopener noreferrer">` in this file. `renderGetPrDiff` is
likewise the first renderer showing preformatted TEXT (a scrollable `<pre>`) rather than a
structured list — a diff has no natural row-per-item shape the way every other tool result here
does.

### Phase 15 §7 Wave 2 — PR write tools: comment, request changes, merge, close (SHIPPED)

`apps/api/src/automation/pr-write.service.ts` · four new `integration.pr_*` events
(`integration-events.ts`) · `apps/api/src/ai/tools/pr.ts`'s four write tools ·
`apps/web/src/features/ai/tool-results.tsx`'s `prWriteRenderer` factory. Spec: same file, §7.2
("post a review comment, request changes. Merge and close require the confirm step from §4.2").
Closes the write half of §7's read/write split; still not built: the webhook trigger's
payload-level filtering, the `work.card_pull_requests` link table, and "create a branch from this
card" (`repo:connect`, still unregistered — no caller yet).

**Two new permissions, not one, following the identical alone-with-its-own-caller precedent Wave 1
used for `pr:view`.** `pr:review` (posting a comment, requesting changes) and `pr:merge` (merge,
close) both land in this wave because both get real callers in it — unlike Wave 1, which shipped
only `pr:view` because `pr:review`/`pr:merge` had no caller yet. Kept as TWO permissions rather than
one, deliberately: an org can let one Member review PRs without letting them merge or close —
reviewing is a normal part of contributing, merging is materially more consequential, and folding
both into one permission would remove that distinction with no way to get it back short of a new
migration. Both are `ORG_LEVEL_PERMISSIONS` and `GRANTABLE_PERMISSIONS`, Owner/Admin by role, same
shape as `ai:use`/`pr:view`.

**All four write tools require confirmation — including the two §7.2's own text never explicitly
demanded it for.** §7.2 only names merge/close as needing "the confirm step from §4.2"; posting a
comment or requesting changes could have been read as auto-executable. This registry has been here
before: `chat_post_message` and `docs_create_page` both shipped confirmation-gated despite the
spec's own text calling them "cheap to undo... can execute directly once permitted," on the
reasoning that one uniform rule is simpler to reason about and audit than deciding tool-by-tool
which risk is low enough to skip — and a PR comment is exactly the same shape as a chat message:
visible to the whole GitHub org, and anyone subscribed, the instant it posts, read before a human
could undo it. `pr.ts`'s own header states this explicitly rather than leaving it to be inferred
from the diff.

**Every write function checks its own permission, mirroring `integration-action.service.ts`'s
`assertMayManage` exactly, for the identical reason `pr-read.service.ts`'s functions do: no tRPC
route protects any of these, only the AI tool registry reaches them.** `postPrComment`/
`requestPrChanges` check `pr:review`; `mergePr`/`closePr` check `pr:merge` — refused before any
network call, the same "provider never reached" property this codebase proves for every gate.

**Every event is written to the outbox AFTER GitHub's own effect succeeds, never before — identical
discipline to `postSlackMessage`/`createGithubIssue`, and for the identical reason: the effect is on
a platform this deployment does not control, so it cannot share the caller's own transaction the way
a card mutation can, and an event claiming an effect that GitHub actually refused would be a false
entry in a hash-chained log that can never be corrected.** Four new events —
`integration.pr_comment_posted`, `integration.pr_review_submitted`, `integration.pr_merged`,
`integration.pr_closed` — following `integration-events.ts`'s own "OUTBOUND effects" rule to the
letter: no comment text, no review text, ever. A test in `pr-write.service.test.ts` asserts this
directly (`expect(JSON.stringify(payload)).not.toContain('looks good')`) rather than trusting the
schema alone, since a schema only proves the FIELD isn't declared, not that nobody ever widens it
later without re-reading this rule.

**Every function also returns `providerScope`, a real departure from how a card write tool
behaves.** `card_update`/`card_assign`'s own renderers deliberately read `cardId` from the tool
CALL's `input`, never the service's OUTPUT, specifically to avoid enriching four backend services
just for a frontend convenience the model already gave them. A PR write tool cannot follow the same
rule: `providerScope` (`owner/repo`) is resolved entirely server-side and never appears anywhere in
the model's own input, so there is nothing for a renderer to read off the call — returning it is
what makes a working `https://github.com/<scope>/pull/<n>` link possible at all, not optional
enrichment. `prWriteRenderer(verb)` in `tool-results.tsx` is the shared factory reading `prNumber`
from `call.input` (the model already has it, same as `cardWriteRenderer`) and `providerScope` from
the result (the one field this tool family cannot get any other way).

**`mergePr`'s Zod-optional `mergeMethod` field tripped `exactOptionalPropertyTypes` the first time
it was wired into the tool's `execute()`.** Zod's own `.optional()` inference produces
`mergeMethod?: T | undefined`, not merely "optional" — passing that object straight through to a
service function whose own parameter declares `mergeMethod?: T` (no explicit `| undefined`) is
refused under this codebase's strict tsconfig, the identical trap `apps/web`'s own
`description={condition ? text : undefined}` pattern hits and the fix documented there for. The fix
is the same: build the object conditionally so the key is ABSENT when unset, never
present-with-`undefined`.

### Phase 15 §7 Wave 3 — the card↔PR link (SHIPPED)

`packages/db/migrations/0105_card_pull_requests.*` · `apps/api/src/work/card-pull-request.service.ts`
· `apps/api/src/work/detail.router.ts`'s `pullRequests:` block · `apps/api/src/ai/tools/pr.ts`'s
`list_card_prs`/`card_link_pr`. Spec: same file, §7.2 ("a new small table linking a card to a
PR... and a new action, 'create a feature branch from this card'"). This wave ships only the link
table and the two tools that read/write it — still not built: `repo:connect`, "create a feature
branch from this card," and the inbound `pr.merged` trigger the link table exists to serve (see
below for why that trigger needed real research before it could even be scoped, let alone built).
_(`repo:connect`/"create a feature branch from this card" shipped in the very next §7 pass below;
the inbound `pr.merged` trigger — as `card.pull_request_merged`, paired with auto-link-by-branch-
name — shipped later still; see "Phase 15 §7.2 — auto-move on merge, auto-link by branch name" for
what actually closed both of §7.2's remaining named gaps.)_

**§7.2's own text calls the inbound webhook piece "the largest single piece" and separately says
`pr.merged` becomes "a new domain event... a new trigger name plus the already-existing `card.move`
action, not new engine work." Both turned out to need the SAME missing piece to actually mean
anything: a way to know WHICH card a merged PR is even about.** Before this wave, nothing recorded
that relationship anywhere — an org's automation could react to "a `pull_request` webhook arrived"
but had no way to turn "PR #42 merged" into "move card WEB-142." §7.1's own "what exists today"
already correctly named this gap ("no card↔PR link"); this wave closes it. The merge-trigger itself
is still not built — seeing this dependency only became clear from actually researching the existing
automation engine (see the next two paragraphs), not assumed going in.

**`packages/filter/src/fields.ts`'s own connector field set (`provider_event`/`provider_scope`,
exactly two fields) turns out to be the WRONG place to add "was this a merge" filtering, and its own
header already explains why, unprompted: "the provider's own body stays `unknown`... a field set
over it would be this repo asserting a schema it does not own and cannot keep current." Generic
payload-field filtering (`action = 'closed' AND merged = true`) was the first idea considered for
"auto-move on merge" and rejected on rereading that file's own reasoning — it would mean this
package owning a slice of GitHub's webhook schema, the exact thing that file's two-field design
deliberately refuses to do. §7.2's own text agrees independently: `pr.merged` is a NEW, SPECIFIC
domain event, the identical shape every other trigger in this system already is (`member.added`,
`card.created`), not a generic catch-all filtered by payload condition. Building the merge trigger
is therefore real, separate work — parsing GitHub's raw `pull_request` payload for
`action === 'closed' && pull_request.merged === true` inside the inbound webhook handler and
emitting a distinct event from it — deliberately deferred out of this wave rather than rushed in
alongside the link table it depends on.

**The link is `card:update`, not a new permission, and deliberately NOT also gated on `pr:view`.**
`card-pull-request.service.ts`'s own header states why: linking is filling in a fact about ONE
card, the identical `card:update` shape `checklist.service.ts` already gives "a checklist is part
of its card, not a resource anyone grants access to separately" — and nothing about linking reads
from GitHub at all (no fetch, no token use beyond resolving which repo the org connected), so
requiring a SECOND permission would refuse a Member who can already edit the card from recording a
fact they already know via other means (their own branch name, a Slack mention) for no real
authorization reason.

**No existence check against GitHub — a deliberate, narrower scope than `card_add_labels`'s own
label-id handling, not an oversight.** A label id is checked against a local table and a fabricated
one fails a real foreign key; a PR number has no local row to validate against, and verifying it
would mean a second permission (`pr:view`) plus a real network call just to record a claim. The
link is exactly that: a claim a person or the assistant can make and later correct, not a
synchronized mirror of GitHub's own state.

**Modeled directly on `comms.recording_cards` (migration 0034), the closest existing precedent for
"attach an external thing to a card": a composite FK back to `work.cards(org_id, id)` so a link can
never point at another tenant's card even if application code got it wrong, and MANY on both sides
for the identical reason `recording_cards` is — one card can span several PRs (a large feature), and
in principle one PR could reference more than one card. The "PR" side is plain columns
(`provider_scope` + `pr_number`), not a foreign key: there is no local table for a GitHub pull
request to reference. A second index, ordered PR-first rather than card-first, exists for the
reverse lookup a future merge-trigger action will need ("given this PR, which cards name it") —
added now, while the migration was already being written, since the need is already certain from
§7.2's own text, not speculative.**

**`providerScope` is caller-supplied to the SERVICE, unlike every PR read/write tool — a deliberate
asymmetry, not an inconsistency.** `pr-read.service.ts`/`pr-write.service.ts` always resolve the
repo via `connectedGithubRepo`, never from caller input, because they use it to build a real GitHub
API URL, where a caller-supplied scope would be a path-traversal-shaped redirection risk
(`repoPath`'s own doc comment). This service makes no such call — `providerScope` is inert data
written to one row, so an arbitrary string here is not unsafe the way it would be in a URL. The one
caller today (`card_link_pr`) still resolves it from the org's own connector before calling the
service, for a different reason: consistency with what a person sees when they open the PR (the
same `owner/repo` the read tools already show), not because the service itself needs the
guarantee.

**`linkCardPullRequest` is idempotent via `onConflictDoNothing` on the composite primary key, the
identical shape `memberGrants.grant`/`revoke` already use for a retried batch** — linking a PR that
is already linked is not a different fact, and a second `card_link_pr` call for the same reference
should not fail or duplicate the row. Idempotency is at the ROW level only, not the event: each
call still emits its own `card.pull_request_linked`, the same "every call is a real attempt worth
recording" reasoning the identity/tenancy idempotent routes already accept, proven directly in
`card-pull-request.service.test.ts`'s own idempotency case (one row, two events).

**The audit projection's two new entries (`card.pull_request_linked`/`.unlinked`, both mapped to
`{type: 'card', key: 'cardId'}`) were added in the SAME change that registers the events, not a
follow-up pass — the identical gap CI had just caught one commit earlier for Wave 2's four
`integration.pr_*` events (see this file's own "Two bugs CI found on PR #134" section, directly
below), deliberately not repeated here.**

Both surfaced from the CI run §7 Wave 2's own push triggered, not from anything Wave 1 or Wave 2
changed — pre-existing, unrelated to GitHub/PR work, fixed because this PR's author is responsible
for its CI regardless of which change exposed the failure.

**`chat_post_message`'s `dmUserIds` path failed "Not found." on every call, whether the DM was new
or already existed.** `openDirectMessage` writes a fresh membership tuple when it opens a DM, but
`chat.ts`'s `execute()` kept calling `sendMessage` with the same `ToolContext.subject` snapshot
captured before the tool ran — so `actor.subject.tuples` never reflected the tuple `openDirectMessage`
had just written. A DM is a CLOSED authorization target (`chat/shared.ts`'s `isClosedChannel`), and
`decide.ts`'s own rule for a closed target is an unconditional deny when no applicable tuple is
found — not even an Owner/Admin bypass reaches it — so the very next `sendMessage` in the same tool
call was refused on the channel the caller had just been added to. Fixed by reloading tuples via
`loadTuples(orgId, userId)` (`tenancy/resolve.ts`, the same function `chat/membership.ts` already
uses) immediately after `openDirectMessage` returns, before building the `actor` passed to
`sendMessage`.

**`orgs_self_read` (identity.orgs' RLS policy, migration 0004) still hard-coded `m.status =
'active'`, silently reintroducing a bug the app layer had already fixed once.** `org.service.ts`'s
`listMyOrgs` was earlier corrected to report a suspended membership rather than omitting it (this
file's own Phase 3 section: "narrowing to 'active' used to happen here... a suspended membership
was indistinguishable from no membership at all") — but that function's `INNER JOIN` against
`identity.orgs` runs inside `withUserScope`, where `orgs_self_read` is what actually admits the org
row, and the policy itself was never updated to match. A suspended membership's org row stayed
invisible under RLS regardless of what the app-level query intended, so the join silently dropped
it and the fix never took effect end-to-end — caught only by CI running the real test against real
Postgres, not by anything a mocked check could see. Migration 0104 widens the policy's `EXISTS` to
`m.status IN ('active', 'suspended')`. `resolveOrgMembership` (`resolve.ts`) is unaffected by the
widening: it throws `membershipSuspended()` on a non-active membership before it ever queries
`identity.orgs`, so this only changes the one caller, `listMyOrgs`, that genuinely needs to see a
suspended membership's own org row.

### Phase 15 §7 — multi-repo resolution, `pr_approve`/`get_pr_files`/branch creation, a diff viewer (SHIPPED)

`packages/policy/src/{permissions,roles}.ts` (`repo:connect`) ·
`apps/api/src/automation/integration.service.ts` (`connectedGithubRepos`, `connectedGithubRepo`'s
ambiguity refusal) · `apps/api/src/automation/{pr-read,pr-write}.service.ts` (`repoScope` on every
existing function, `getPullRequestFiles`, `approvePr`) · `apps/api/src/automation/branch.service.ts`
(new) · `apps/api/src/ai/tools/pr.ts` (`list_repos`, `get_pr_files`, `pr_approve`,
`create_branch_from_card`) · `apps/web/src/features/ai/diff-view.tsx` (new). Prompted directly by
the project owner, in four parts: what happens with more than one connected repo, a way to create a
branch from a card, more GitHub capability generally ("these looks very basic"), and a genuinely
readable diff ("very tricky to read... not presentable... if we go with the diff of a pr it should
be proper way").

**Multi-repo: the old silent "most recently connected" tie-break is gone, replaced by an explicit
refusal the model can recover from.** `connectedGithubRepo` used to pick a repo with no signal to
anyone that a repo other than the intended one was now in use — a real, silent-wrong-answer risk
the moment a second repo got connected, not a hypothetical one. It now takes an optional
`repoScope`: given, it is checked against the org's own connected rows (never trusted blind — a
value naming a repo this org never connected is refused with `NOT_FOUND`, identical to an omitted
scope on a single-repo org); omitted with exactly one repo connected, resolution is unchanged;
omitted with more than one connected, it throws `VALIDATION_FAILED` naming `list_repos` as the
recovery path, with zero network calls made — the same "refused before any external effect"
property this codebase proves for every access gate. `list_repos` (`connectedGithubRepos`, no
GitHub call — reads `platform.integrations` directly) is what turns that refusal into "ask the
user which one, then reuse the answer" per the project owner's own stated design: `router.ts`'s
system prompt tells the model explicitly to call `list_repos` on that refusal, ask once, and reuse
the chosen `repoScope` for the rest of THIS conversation unless told otherwise — a conversation-
scoped choice, not a server-side one, since `ai.chat.send` is stateless (§4 Wave 1) and has nothing
durable to remember it in. Every existing PR tool (`list_prs`, `get_pr_diff`, `get_pr_comments`,
`pr_post_comment`, `pr_request_changes`, `pr_merge`, `pr_close`, `card_link_pr`) gained the
identical optional `repoScope` field via a shared `RepoScopeField`/`RepoScopeProperty` fragment in
`pr.ts`, rather than each tool inventing its own copy of the same three lines.

**`create_branch_from_card` closes the last item on §7.2's original four-permission list —
`repo:connect` — the one that went the longest without a caller.** Gated on `repo:connect`
specifically, not `pr:review`/`pr:merge`: a fresh ref on the default branch is visible to the whole
GitHub org the instant it exists, a bigger blast radius than commenting on or even merging a PR
someone else already reviewed, so it is not something every reviewer/merger should be able to do
without a separate grant. The branch name is `<reference>-<slug>` — e.g. `web-142-fix-login-
redirect` — built entirely server-side from the card's own reference and title, never asked of the
model, the identical "classification stays deterministic" instinct this codebase applies everywhere
a name could otherwise be guessed (`standup.service.ts`'s bucketing, `card_move`'s rank derivation).
Unlike `card_link_pr` (which records a claim with no GitHub round trip at all, by design), this
tool creates a REAL ref, so "does a branch with this name already exist" has a real, cheap answer —
`GET .../git/ref/heads/<name>` before ever attempting `POST .../git/refs` — and an existing branch
is reported back (`alreadyExisted: true`) rather than treated as a failure, the same reasoning
`linkCardPullRequest`'s own idempotency exists for: a retried confirmation should not error for no
reason. The event (`integration.branch_created`) is written only after GitHub's own ref creation
succeeds, identical discipline to every other PR write tool in this registry, and its audit
projection mapping was added in the SAME change that registers the event — the exact gap CI caught
once already for Wave 2's `integration.pr_*` events, deliberately not repeated here.

**`pr_approve` closes an asymmetry: the registry could formally reject a PR (`pr_request_changes`)
but never approve one.** Shares `pr:review` — an approval is a review, the same permission tier
`pr_request_changes`/`pr_post_comment` already sit at — and the identical "GitHub refuses a formal
review on the connector's own PR" 422 hint, naming `pr_post_comment` as the working alternative.

**`get_pr_files` answers "what does this PR touch" without `get_pr_diff`'s truncation risk.** A
large PR's diff routinely blows past `MAX_DIFF_CHARS` before a person learns the SHAPE of the
change at all; the files endpoint (path, status, additions/deletions per file) is one page
regardless of PR size, and is never truncated.

**The diff viewer replaces one undifferentiated `<pre>` block of raw unified-diff text — found
directly "very tricky to read... not presentable" — with real per-file, per-hunk structure, colored
additions/deletions, modeled on GitHub's own diff view.** `apps/web/src/features/ai/diff-view.tsx`'s
`parseUnifiedDiff` is exported and pure specifically so it can be tested directly against real diff
text (`diff-view.test.ts`), the same "test the pure half" split `markdown-lite.tsx`/`api.test.ts`
already establish for this feature — a unified diff has enough real edge cases (renames, added/
deleted files via `/dev/null`, a file with no trailing newline, `\ No newline at end of file`
annotations) that eyeballing the component's output is not enough to trust the parser. It never
throws: an unrecognized line inside a hunk is treated as context rather than aborting the whole
parse, since `get_pr_diff`'s own `MAX_DIFF_CHARS` truncation can cut a diff off mid-hunk — a real,
expected input, not a malformed one. One real bug the test suite itself caught before this shipped:
`text.split('\n')` produces a spurious trailing `''` whenever the diff text ends with a newline (the
common case for real diff text), which the parser's context-line fallback was turning into a fake
blank line appended to the last hunk — fixed by dropping exactly that one trailing artifact before
the main parsing loop runs, never any non-trailing blank line, since a genuine blank line in the
middle of a diff must still render as real context. `tool-results.tsx`'s `renderGetPrDiff` renders
`DiffView` in place of the old `<pre>`; a diff `parseUnifiedDiff` cannot recognize at all still
falls back to the raw text, so nothing renders worse than before.

### Phase 15 §7.2 — direct "create branch from card" UI, and a card identity bar (SHIPPED)

`packages/db/migrations/0106_card_branches.*` · `apps/api/src/work/card-branch.service.ts` ·
`apps/api/src/automation/branch.service.ts`'s `branchName` override · `apps/api/src/work/
detail.router.ts`'s `branches:` block · `apps/web/src/features/work/detail/{card-identity-bar,
development-section,branch-name}.tsx`. Prompted directly: a way to create a branch from a card
without going through the assistant, with the name pre-filled and editable; then, separately, a
request to show both the linked PR and the linked branch prominently next to the card's own id,
each clickable in a new tab, with the id itself copyable "like ClickUp."

**`create_branch_from_card` had shipped as an AI tool only — this is the same "shipped backend,
no consumer for a person not talking to the assistant" gap this file's own account of this
codebase's history already names for `card_link_pr`/`list_card_prs` before their own direct UI,
and for `ai.chat.send` before `apps/web/src/features/ai` existed at all.** `createBranchFromCard`
itself needed no new capability to be reachable directly — it already took a real `WorkActor` and
`BranchWriteDeps` — so the fix is almost entirely wiring: a new `work.branches.create` tRPC
mutation (`detail.router.ts`), floored on `repo:connect` since that is the org-level permission a
route with no resource context can meaningfully check, with the resource-aware `card:update` check
staying inside `createBranchFromCard` itself exactly as it already was for the AI tool's caller.

**Until now, nothing recorded which branch belongs to which card at all — `createBranchFromCard`
created a real GitHub ref and emitted `integration.branch_created`, and that was the entire
record.** A person (or the assistant) asking "what's the branch for this card" a second time, in a
different session, had no way to find out. Migration 0106's `work.card_branches` is modeled
directly on 0105's `work.card_pull_requests` — a composite FK back to `work.cards(org_id, id)`
so a link can never point at another tenant's card even if application code got it wrong, MANY on
both sides for the same reason `card_pull_requests` is (a card can reasonably span more than one
branch over its life; a branch name could in principle be reused after a card is deleted and
recreated), and a second, PR-scope-first index for a reverse lookup a future feature might need.
`card-branch.service.ts` (`listCardBranches`/`linkCardBranch`/`unlinkCardBranch`) is the identical
shape `card-pull-request.service.ts` already established one entity type over — `card:read`/
`card:update`, no second permission for the read/unlink half, idempotent inserts, its own
`card.branch_linked`/`card.branch_unlinked` events mapped into the audit projection the same
change that registers them (`{type: 'card', key: 'cardId'}`) — the exact gap CI had already caught
once for Wave 2's `integration.pr_*` events, deliberately not repeated here.

**`linkCardBranch` is called from INSIDE `createBranchFromCard`, in both outcomes, not left to
each caller to remember.** A branch that already existed on GitHub still gets linked to the card —
recording the association is the same intent whether GitHub had to create the ref or already had
it — but only the newly-created path also emits `integration.branch_created`; recording that event
for a branch GitHub did not actually create this call would be a false "created" claim in a
hash-chained log, the identical discipline this file's own account of every other PR/branch write
tool already states. The permission check inside `createBranchFromCard` was upgraded from
`card:read` to `card:update` at the same time, checked while loading the card — BEFORE any GitHub
call — so an actor who holds `repo:connect` but cannot update this specific card (a relationship
tuple can restrict `card:update` on one board and not another) is refused before a branch is
created that nothing would ever end up recording as belonging to it, rather than creating an
orphan ref on GitHub and then failing to link it.

**The pre-filled, editable name is a client-side computation, never a round trip.** The
`<reference>-<slug>` default `branch.service.ts` already computes deterministically needed no new
server capability to preview — `apps/web/src/features/work/detail/branch-name.ts` duplicates the
identical `slugify`/join logic locally (the same trade `apps/mobile/src/lib/org-picker.ts`'s own
`slugify` already accepts for not sharing code across the `apps/api`/`apps/web` boundary), used
ONLY to show a live "will be created as…" preview beneath the input as a person types — the actual
name is decided server-side regardless, by the SAME `slugify` `branch.service.ts` already runs on
whatever text arrives, so drift between the two would be a cosmetic preview bug, never a
correctness one. `createBranchFromCard` gained an optional `branchName` field: given, it is
slugified and used verbatim in place of the deterministic default; an edit that slugifies to
nothing (clearing the field, typing only punctuation) falls back to the default rather than
attempting to create a branch literally named `""`.

**The card identity bar (`card-identity-bar.tsx`) is a NEW header-level component, not an
expansion of the existing "Pull requests" section — the two requests were different, and the fix
for one is not the fix for the other.** "Create a branch, editable" is a WRITE workflow, real
enough to need its own form, its own pending/error state, and enough room that it belongs in the
panel body. "Show me what's already linked, prominently, next to the id" is a READ/navigation
need, answered by a compact, always-visible row in the header — the same two queries
(`cardPullRequestsQuery`/`cardBranchesQuery`) the body section already uses, React Query
deduplicating by key so mounting both costs no extra request. `card-detail-panel.tsx`'s
`ModalTitle` (the dialog's accessible name) is now `sr-only`: the identity bar already renders the
reference as its own copy-button element, and painting the same text twice — once as the
accessible-only heading, once as the visible copy button — would be pure duplication, not
redundancy worth keeping.

**The copyable reference button is `navigator.clipboard.writeText`, a local `copied` boolean, and
a 1.5s timeout — no toast, no tooltip primitive, because this app has no `Tooltip` component to
reach for.** A `Copy`/`Check` icon swap in place, styled as a small mono badge, is the entire
feedback surface; it does not depend on `useToast` (reserved for mutation outcomes elsewhere in
this file, not a plain client-side clipboard write that cannot itself fail in a way worth
reporting).

**Every chip — PR or branch — is a real `<a target="_blank" rel="noopener noreferrer">`, never a
button that opens a new tab via `window.open`, and each carries its own icon (`GitPullRequest`/
`GitBranch`) so the two are never confused at a glance the way an undifferentiated list could
be.** This mirrors `tool-results.tsx`'s own precedent for the first renderer in that file linking
outside TaskFlow entirely — nothing about a GitHub PR or branch has a real `apps/web` route to
open with `<Link>`.

### Phase 15 §7.2 — a repo picker for the PR-link and branch-create forms (SHIPPED)

`apps/api/src/work/detail.router.ts`'s `githubRepos:` block ·
`apps/web/src/features/work/{api,detail/development-section}.tsx`. Prompted directly, from a
screenshot: the branch-create form failing outright with
`repoScope: required — more than one GitHub repository is connected` — `connectedGithubRepo`'s own
deliberate ambiguity refusal (§7's own text), reachable the moment a second org connects a second
repo, with no UI path to resolve it. "Same goes to pr" extended the identical fix to the PR-link
form in the same request.

**The fix is two bugs, not one — a missing picker, and the wrong permission gating its data
source.** Both forms' only source of "which repo is connected" was `integrationsQuery`
(`automation.integration.list`, gated on `integration:manage` — Owner/Admin, or an individually
granted Member) via a bare `.find()`, which both picks silently wrong the moment a second repo
exists AND is the wrong floor for who should be able to link a PR (`card:update`) or create a
branch (`repo:connect`) in the first place — neither of which implies `integration:manage`. Fixing
only the picker would still 403 a Member who holds `repo:connect` but not `integration:manage`.

**`work.githubRepos.list` is a new, deliberately narrower route — `card:read`-gated, not
`integration:manage` or `pr:view`.** Its own header states why: repo names are non-sensitive data
(the identical reasoning the AI tool's own `list_repos` already relies on), and both real callers
of this route — the PR-link form (`card:update`) and the branch-create form (`repo:connect`) — are
only ever reachable from a card detail panel a caller already opened, which is itself `card:read`.
Gating the LIST on the loosest permission any of its callers could need, rather than the strictest
action behind it, is the same "gate on what the caller actually needs, not a stricter unrelated
permission" instinct this codebase already applies elsewhere (`standup.service.ts`'s
`project:read` floor vs. Analytics's narrower one). It wraps the existing `connectedGithubRepos`
(`automation/integration.service.ts`) unchanged — no new service logic, only a new, correctly-
scoped door to it.

**The repo choice is lifted to `DevelopmentSection`, the shared parent, not duplicated per
form.** `githubReposQuery` is fetched ONCE there; `selectedRepoScope` lives there too, so picking a
repo while linking a PR is remembered for creating a branch in the same card session without
asking twice — the identical "ask once, reuse for the rest of the session" shape the AI
assistant's own multi-repo conversation handling already established (§7's own account of
`list_repos`), just scoped to one open card instead of one conversation. `effectiveRepoScope`
collapses the single-repo case back to today's zero-friction behavior (the sole repo is implied,
no picker rendered at all) and only asks when there is a genuine choice to make; both forms' submit
controls disable on an unmade choice (`repoScope === undefined`) the same way they already disable
on `!reposLoaded`.

### Phase 15 §7 — a missing 401 hint on every GitHub call site (SHIPPED)

`apps/api/src/automation/{branch,pr-read,pr-write,integration-action}.service.ts`. Prompted
directly, from a real local server log: `work.branches.create` failing with a bare
`GitHub answered 401.` — no hint, no next step, on the one status code this codebase's own
established "name the GitHub status code that has a real explanation" pattern had never covered.

**403, 404, 405, 409, 410 and 422 all had actionable hints already — `pr-read.service.ts`'s
`githubReadError`, `pr-write.service.ts`'s `githubWriteError`, and
`integration-action.service.ts`'s `createGithubIssue` each name at least one of them — and 401 was
absent from every one of them, including `branch.service.ts`, which had no hint mapping at ALL
across its four GitHub call sites.** 401 is not a variant of 403: 403 means a live, valid token
that merely lost scope or is being rate-limited (worth retrying, or waiting out); 401 means the
token itself is dead — revoked at GitHub, or the connected OAuth App's own client secret rotated —
which no retry will ever recover from. Collapsing the two into one generic
`GitHub answered ${status}.` message left a person staring at a permanently-failing action with no
signal that the fix is "reconnect the repository," not "try again."

**Every one of the four files gets the identical hint text, phrased to match each file's own
existing 403 wording rather than sharing one new helper across files.** This follows the
codebase's own existing convention here — the near-identical 403 hint ("the connector token no
longer has \[write \]access, or GitHub is rate limiting") is already duplicated, worded slightly
differently, across `pr-read.service.ts`, `pr-write.service.ts`, and
`integration-action.service.ts`, rather than factored into one shared function; a fourth
near-duplicate for `branch.service.ts` (which needed a genuinely new local `githubErrorHint`
helper, since it had none before) matches that precedent rather than introducing a shared
abstraction none of the other three ever adopted. The hint names the actual recovery path —
"reconnect the repository (Settings → Automation)" — the identical phrase
`development-section.tsx`'s own empty-state text already uses for the same action.

**No new test was added for the hint text itself, matching the existing gap rather than papering
over it.** None of the four files' existing 403/404/410/422 hints have dedicated test coverage
either — `pr-read.service.test.ts`/`pr-write.service.test.ts` assert error `code`
(`NOT_FOUND`/etc.), never the hint string inside a `SERVICE_UNAVAILABLE` message, and
`branch.service.test.ts`/`integration-action.service.test.ts` have never covered any non-2xx
GitHub response at all. Inventing string-content assertions for one status code while every
sibling hint stays untested would be inconsistent scope for what is, in every file it touches, a
message-wording fix — not a behavior change to the error `code` a caller can already branch on.

### Phase 15 §7.2 — card-panel PR polish: checkout copy, live state/CI dot, view diff (SHIPPED)

`apps/api/src/automation/pr-read.service.ts` (`getPullRequestStatus`) ·
`apps/api/src/work/detail.router.ts`'s `pullRequests.status`/`.diff` ·
`apps/web/src/features/work/detail/{development-section,card-identity-bar,pr-status-badge,
pr-diff-dialog}.tsx`. Prompted directly, from a list of options put to the project owner after the
repo-picker fix — four picked ("UI polish first"): a copy-checkout-command action on branch chips,
a colored PR-state icon plus a CI pass/fail dot, and a "view diff" button reachable from the card
panel with no assistant detour. Deliberately not built in this pass: auto-move-on-merge,
auto-link-by-branch-name, "create PR from card," and branch/PR cleanup on archive — bigger-scope
items the project owner chose to defer, all still real, separate follow-up work. _(The first two —
auto-move-on-merge and auto-link-by-branch-name — have since shipped; see "Phase 15 §7.2 —
auto-move on merge, auto-link by branch name.")_

**Copy checkout command needed no backend at all — it composes
`git fetch origin <branch> && git checkout <branch>` from data the branch row already has.**
`CopyCheckoutButton` (`development-section.tsx`) reuses `card-identity-bar.tsx`'s own
`CopyableReference` click-to-copy shape (a `Check`/`Copy` icon swap, 1.5s timeout, no toast, no
tooltip primitive this app doesn't have) rather than inventing a second feel for the identical
interaction. `git fetch` runs first, deliberately: a branch this session just created (or one a
teammate pushed) is not necessarily in a local clone's remote-tracking refs yet, and a bare
`checkout` would 404 on it.

**Live PR state and a CI dot needed a genuinely new backend call — `getPullRequestStatus`
combines two real GitHub calls into one (`GET .../pulls/{n}` for state/merged/draft plus the head
sha, `GET .../commits/{sha}/check-runs` for the rollup), because the checks call needs a sha the
PR call is the only source of.** `merged` is a THIRD fact layered on `state: 'closed'` (a merged
PR is always closed, a closed PR is not always merged) — the card chip needs to color the two
distinctly, so `PrStatus` keeps `merged` as its own boolean rather than widening `state` to a
three-value enum. The checks rollup is computed server-side, deterministically, from the real
`check_runs[]` array (`status`/`conclusion` pairs) — `'pending'` if anything is not `completed`,
`'failure'` if anything completed with a conclusion in `FAILING_CONCLUSIONS`
(`failure`/`timed_out`/`cancelled`/`action_required` — `neutral`/`skipped` deliberately excluded,
matching GitHub's own PR-merge-check behavior of not blocking on either), `'none'` for zero check
runs, `'success'` otherwise — the identical "classification stays deterministic" instinct this
codebase applies everywhere a raw status could otherwise be guessed at by a caller. A failed checks
call degrades to `'none'` rather than failing the whole request: the PR's own state/merged/draft
facts are already in hand, and a repo with no Checks API access (an older integration scope, or
GitHub itself degraded) should still show a colored state icon, just with no CI dot.

**`work.pullRequests.status`/`.diff` are gated on `pr:view`, deliberately UNLIKE their
`list`/`link`/`unlink` siblings on the same router.** Those three touch only the org's own
link-table row and never call GitHub at all (`card-pull-request.service.ts`'s own header explains
why `pr:view` is not required there); `status` and `diff` both call GitHub for live content — the
identical data `pr-read.service.ts`'s AI tools already gate behind `pr:view` — so a caller who can
link a PR (`card:update`) but holds no `pr:view` grant still sees the plain chip, just without the
live decoration. `PrStatusBadge`/`PrDiffButton` render nothing at all on ANY query error, FORBIDDEN
included — `retry: false` so React Query does not hammer a permission refusal — rather than
plumbing a new `SettingsCapabilities` field through props to pre-check the grant: Phase 15 §1's
"hide, don't disable" rule was written for ACTION controls (a button that would do something you
can't do), and there is nothing to disable on a decorative status dot that either answers or
silently doesn't.

**`work.githubRepos.list`'s own precedent (this file's own §7.2 "repo picker" section) does NOT
apply here, and the difference is worth naming: that route deliberately floors on the LOOSEST
permission any of ITS callers need, because it touches no GitHub data of its own.** `status`/`diff`
touch live GitHub content directly, the same shape `pr-read.service.ts`'s own functions already
gate — reusing that precedent (gate on the loosest caller need) would mean gating live PR content
on `card:update`, which is not what `pr:view` exists to control.

**No `cardId` on either new route, unlike their siblings — a deliberate scope narrowing, not an
oversight.** `list`/`link`/`unlink` all name a card because they read or write the card's own
link-table row; `status`/`diff` ask GitHub about a `repoScope`+`prNumber` pair and nothing about
the card at all, the identical scope `pr-read.service.ts`'s own functions already have. Both reuse
`deps.branch` (`Pick<IntegrationDeps, 'keys' | 'fetchImpl'>`) — structurally identical to
`PrReadDeps`, so no new dependency wiring was needed in `router.ts`'s composition root at all.

**"View diff" reuses the exact `DiffView` component and `getPullRequestDiff` service function the
AI assistant's `get_pr_diff` tool already calls — a new tRPC door to the same pipeline, not a
second implementation.** `PrDiffButton`/`PrDiffDialogBody` (`pr-diff-dialog.tsx`) mount the dialog
body ONLY while open, so the (up to 20,000-character, per `MAX_DIFF_CHARS`) diff query never runs
until someone actually clicks the button — the same "fetch on demand, never eagerly for every
linked PR a card happens to show" instinct `pullRequestDiffQuery`'s own header states. A trigger
button plus its own small dialog, not a route: a diff is scratch viewing, not a destination worth
its own URL. Every dialog in this codebase carries a `ModalDescription` (here `sr-only`, matching
`card-detail-panel.tsx`'s own precedent) — Radix's `Dialog.Content` warns without one, and this is
the first new dialog added since `modal.tsx`'s own audit standardized the pattern, so it follows
that standard rather than reinventing it.

**No dedicated `getPullRequestStatus` router-level test — service-level coverage only, matching
this file's existing convention.** `detail.router.ts` has no dedicated test file at all; every
route in it (including the `status`/`diff` additions) is a thin pass-through to a real,
already-tested service function, and `pr-read.service.test.ts` gained five new cases for
`getPullRequestStatus` directly: open/not-merged/not-draft with a successful checks rollup, merged
as a fact distinct from closed, a still-running check rolling up to `'pending'` and a failed one to
`'failure'`, the checks-endpoint-failure degrading to `'none'` without failing the call, and the
`pr:view` refusal with zero network calls made — the same "refused before the network call"
property every access gate in this codebase proves the same way.

### Phase 15 §4 — assistant page polish: a lighter capabilities panel, real markdown (SHIPPED)

`apps/web/src/features/ai/{assistant-page,markdown-lite,markdown-lite.test}.tsx`. Prompted
directly: the capabilities sidebar was "too much text… hard to read," with the actually-actionable
"Try one" example prompts buried underneath all of it, and the assistant's own replies still looked
"raw" — visible markdown syntax, messy formatting — despite `markdown-lite.tsx` already existing to
prevent exactly that for lists.

**The capabilities panel is reordered, not rewritten — nothing in `CAPABILITIES`/
`EXAMPLE_PROMPTS`/`REFERENCE_HINTS` was cut.** The original layout painted all four capability
groups, in full sentences, before ever reaching the example prompts — backwards for what a person
actually does with the panel (skim for "can it do X," then click something to try). Renamed to
"Try asking" and moved to the TOP, `EXAMPLE_PROMPTS`' own chip styling untouched. The full
capability list — the wall of text that prompted the report — moved behind a single `<details>`
disclosure ("Everything it can do"), collapsed by default: the native, JS-free collapsible
`calls-panel.tsx`'s own transcript expander already established in this codebase, not a new
pattern. `ChevronRight` rotates via Tailwind's `group-open:` variant; the browser's own default
disclosure triangle is hidden (`[&_summary::-webkit-details-marker]:hidden`) since a second
indicator next to a custom chevron would be redundant. Every text size/weight in the panel stepped
down one notch (`text-xs font-semibold` → `text-[11px]`/`text-[12px]` `font-medium`) — the literal
"lighter" the report asked for, not just a reorganization.

**`markdown-lite.tsx` gained inline code, links, and fenced code blocks — the exact three
constructs a code-adjacent assistant reply reaches for that bold+lists never covered.** A reply
mentioning a command or a PR link showed literal backticks/brackets, the identical "syntax visible,
not rendered" complaint the original bold/list fix already solved once for markdown. `InlineSegment`
widened from `{text, bold}` to a real discriminated union (`text` / `code` / `link`) so a single
ordered scan (`INLINE_TOKEN`, one regex with three alternatives) produces segments in the order they
actually appear — resolving one construct at a time and re-scanning the leftovers would let a later
pass corrupt an earlier one's output (e.g. bolding text that sits inside a code span). Still
deliberately NOT a general markdown parser: no headings, no tables, no nested lists — the system
prompt still caps the model's own commentary at one short sentence, so the added surface is exactly
what a short, code-adjacent answer needs, not a step toward full CommonMark.

**A link's `href` is checked against `isSafeUrl` before it ever renders as a real, clickable
anchor — the identical scheme whitelist `work/richtext.ts` already enforces for a TipTap `link`
mark, applied here for the identical reason.** A `[text](url)` pair reaching this renderer can
originate from content the model merely ECHOED (a PR description, a doc) rather than composed
itself, so `javascript:`/`data:` reached through a link is script execution through otherwise-plain
chat text, not a hypothetical rule 4 already exists to close everywhere else. A link that fails the
check renders as its own literal `[text](url)` text instead of a dead or dangerous anchor.

**`isSafeUrl`'s first draft used a base URL (`new URL(url, 'https://placeholder.invalid')`), and a
test written directly against it — not assumed — caught why that was wrong before it shipped.**
The WHATWG `URL` constructor resolves ANY non-absolute text as a relative PATH against a supplied
base, so `isSafeUrl('not a url at all')` returned `true` — the base's own `https:` scheme silently
inherited by text that was never a URL at all, defeating the entire check for exactly the
malformed input it exists to catch. Fixed by dropping the base entirely: with none, only a real
absolute URL (a real scheme, `javascript:`/`data:` included, which is what the check is FOR) ever
parses at all. `markdown-lite.test.ts` keeps the case (`isSafeUrl('not a url at all')` →
`false`) as the regression proof, not just the two `javascript:`/`data:` cases the security
property itself needed.

**`PendingActions`' confirmation row rendered a tool's `input` as one run-on
`` `key: "value", key2: "value2"` `` string — exactly the "raw JSON" look the report named.**
`formatCallValue` drops `JSON.stringify`'s quote marks for a plain string (the overwhelming
majority of a real tool's input — a title, a name, an id) while still stringifying anything else
(a number, boolean, array, or object, none of which has an unambiguous bare rendering of their
own); each field now renders as its own small segment in a wrapped row, dimmed key next to a
legible value, rather than one long string a person has to parse themselves.

**The assistant's chat bubble gained a small avatar mark — the same "who's speaking" cue Claude and
ChatGPT both use — because a left-aligned, unmarked bubble read as just another block of page text,
not a reply.** A 24px circle (`bg-accent/10` with a `Bot` glyph) sits beside every assistant bubble
and the "Thinking…" indicator alike, so the loading state and the eventual reply share one visual
identity rather than the icon-plus-text row the "Thinking…" state used before. The user's own bubble
gets no such mark — right-aligned in solid accent color is already unambiguous, and a mark on both
sides would be visual noise for no disambiguation gained. Bubble padding and line-height both grew
slightly (`py-2` → `py-2.5`, explicit `leading-relaxed`) for the same "reads like a real reply, not
a cramped notification" polish, and the user bubble gained `whitespace-pre-wrap` so a genuinely
multi-line question — the composer already supports Shift+Enter — displays its own line breaks
instead of collapsing them.

**Not verified in a live browser — this sandbox has no Postgres, and the assistant page needs a
real org session, an AI provider config, and a live model to render past its own empty state.**
Verified instead by what a sandbox WITHOUT Docker can prove for certain: `tsc`, `eslint`, a real
`vitest run` of `markdown-lite.test.ts` (pure logic, no database — 19 passing cases including the
`isSafeUrl` regression above), `pnpm check:encoding`, and the guardrail selftest. A person should
confirm the actual rendering looks right before calling this done, per this file's own standing
rule that a green non-visual check is not the same claim as "this works when you look at it."

### Phase 15 §7.2 — auto-move on merge, auto-link by branch name (SHIPPED)

`apps/api/src/work/events.ts` (`cardPullRequestMerged`) ·
`apps/api/src/work/card-pull-request.service.ts` (`notifyPullRequestMerged`,
`autoLinkPullRequestFromBranchName`) · `apps/api/src/automation/integration-webhooks.ts`'s
`handlePullRequestPayload` · `apps/api/src/tenancy/audit.projection.ts` ·
`apps/web/src/features/automation/vocabulary.ts` · `apps/mobile/src/lib/automation.ts`. Prompted
directly, naming both of §7.2's own remaining documented gaps by name: "auto-move card on PR
merge" and "auto-link PR to card by branch name."

**Both features share one missing piece, and it was already closed before this pass started —
Wave 3's `work.card_pull_requests` link table, plus the PR-first reverse index that table's own
migration comment already named as built "for a future 'PR merged -> move its linked cards'
trigger."** Neither feature needed a migration; both are read/write logic over a table and index
that already existed, closing the dependency §7 Wave 3's own account of this gap described.

**Auto-move is a genuinely NEW domain event, `card.pull_request_merged`, not a payload-filter
condition on the existing generic `integration.github_event` trigger — exactly the design §7.2's
own text called for and Wave 3's account of researching this gap rejected the alternative for.**
`packages/filter/src/fields.ts`'s two-field connector set (`provider_event`/`provider_scope`) was
the first idea considered and rejected on rereading that file's own header: filtering on
`action = 'closed' AND merged = true` would mean this repo asserting a schema slice of GitHub's
own webhook body it does not own. A specific event is the same shape every other trigger in this
system already is (`member.added`, `card.created`) — and because it carries a real `cardId`, it
needed no `connector`-set special case in `resourceForTrigger` at all: it is an ORDINARY card
trigger as far as the engine's `evaluableRowFor`/`cardIdOf` are concerned, so `apps/worker` needed
zero code changes — the existing generic "a card trigger re-reads the card row" path just works,
proven by reusing the identical mechanism `card.moved`/`card.assigned`/etc. already exercise.

**One event per linked card, never a single event naming several — `cardIdOf`'s own doc comment
states the property this design preserves: "a rule cannot name a DIFFERENT card than the event
that fired it... 'this card' keeps the blast radius of a rule equal to the blast radius of its
trigger."** A PR linked to two cards (the many-to-many shape migration 0105 was built for) fires
the SAME rule twice, once per card, each execution acting only on the card its own event named —
not a batch action reaching across every card a PR happens to touch. `notifyPullRequestMerged`
does the fan-out: one query over the reverse index, one `card.pull_request_merged` per row.

**"Move to Done" needed no new ACTION at all — `card.move` (Wave 1) already takes a `listId`, and
a rule author already picks the target list directly when building the rule, independent of
whatever fired it.** The only web/mobile change either platform needed was one new
`TRIGGER_OPTIONS` entry pairing with that already-existing action — exactly what §7.2's own text
predicted ("a new trigger name plus the already-existing `card.move` action, not new engine
work"). Placed in the MAIN trigger list, not the card-less connector/§8 exceptions section, since
it carries a real `cardId` and is — unlike those two pairs — fully editable on mobile too, with no
`EDITOR_TRIGGER_OPTIONS` exclusion needed.

**Auto-link parses a card reference off the PR's own HEAD BRANCH name, matching only a LEADING
`<key>-<number>` prefix — the exact inverse of `branch.service.ts`'s own `<reference>-<slug>`
naming, not a scan for a reference anywhere in the string.** `web-142-fix-login-redirect` names
`WEB-142`; a key that happened to appear mid-branch-name unrelated to a real reference would be a
false positive a full-string scan risks and a prefix anchor does not. Deliberately scoped to the
convention this codebase's own `create_branch_from_card`/the UI branch-create button already
produce, not every naming convention a person might invent by hand.

**Auto-link fires on `action: 'opened'` only, not every `pull_request` delivery** — the literal
shape of the ask ("if someone OPENS a PR from..."), and the one point in a PR's life the branch
name is decided; a later `synchronize` (a new push) cannot rename the branch a PR already opened
from. Running it on more events would find nothing new, just spend more no-op queries.

**Both new functions in `card-pull-request.service.ts` take an already-open `tx: TenantDb`
directly, never a `WorkActor`, and neither calls `enforceOn` — there is no human on the other end
of an inbound webhook delivery to authorize.** `integration-webhooks.ts` calls both from INSIDE
its own existing `withOrgScope` block, the SAME transaction that claims the delivery-dedupe row
and appends `integration.github_event` — so a card gets linked or notified of a merge in the same
atomic unit as the delivery being recorded (a rolled-back delivery rolls these back with it), and
a replayed delivery never reaches either function at all, since the dedupe check runs first and
returns before either is called. This mirrors `emitSlackTrigger`/`loadGithubVerify`'s own precedent
of a system function taking a transaction rather than opening a second one, applied one level
lower — an actual card mutation, not just a trigger emission.

**`autoLinkPullRequestFromBranchName` deliberately does NOT reuse `linkCardPullRequest`'s own
looser "emit unconditionally, even on an existing row" behavior — it checks `.returning()` and
only emits when a row was actually inserted.** `linkCardPullRequest`'s own test proves it emits a
fresh event on every call regardless of conflict, which is safe there because a human clicking
"Link" twice is a rare, deliberate retry. This function runs on every `opened` delivery for every
PR an org receives; emitting unconditionally would produce a duplicate `card.pull_request_linked`
the moment GitHub redelivers (rare, but real) rather than only when something genuinely changed.

**The audit projection's new entry (`card.pull_request_merged` -> `{type: 'card', key: 'cardId'}`)
was added in the SAME change that registers the event, not a follow-up pass — the identical gap
CI already caught once for Wave 2's `integration.pr_*` events, deliberately not repeated a third
time.**

**Tests split the same way the service/webhook boundary does: `card-pull-request.service.test.ts`
covers both new functions' own edge cases directly (multi-card fan-out, no-match no-ops, the
idempotency contrast with `linkCardPullRequest`), and `integration-webhooks.test.ts` gained four
END-TO-END wiring cases proving a real POST through the route actually reaches them in the same
transaction as the delivery claim — not re-testing the business logic a second time, since the
service-level suite already owns that.**

### Phase 15 §1 — the Individual permissions list, regrouped one row per person (SHIPPED)

`apps/web/src/features/admin/settings-page.tsx`'s `PermissionsSection`/`PermissionGrantChip`.
Prompted directly, from a screenshot: a member holding two grants (`call:place`, `sms:send`)
showed as two separate, near-identical rows — same avatar, same name, same role, differing only
in one `Badge` — and the request was one row per person with every permission they hold, the
grant date visible rather than buried, and a less "generic" look than the flat list this section
shipped with in §1's own original Wave 2 sweep.

**The mutation and selection logic needed no change at all — only how `visibleGrants` is
RENDERED.** `selectedGrants` is still a flat `Set<string>` keyed `${userId}:${permission}`, and
`runGrantBatch`/`runRevokeBatch` still call the existing single-pair `memberGrants.grant`/`.revoke`
routes once per pair in sequence, exactly as this section's own Wave 2 header already documents.
Grouping is a pure display transform applied to the same filtered array the flat list already
computed (`visibleGrants`), so a search still narrows at the GRANT level — a query matching one of
someone's three permissions shows a person's row with just that one chip, not all three, since
grouping happens strictly after filtering.

**`Map<userId, group>` rather than an index-tracked array, so building the groups needs no
indexed-access fallback under `noUncheckedIndexedAccess`.** Each grant in `visibleGrants` either
finds its person's existing group object and pushes into its (mutable, unlike the rest of this
codebase's usual `readonly`) `items` array, or creates one — no `array[index]!` non-null assertion
anywhere, and `Map`'s own insertion-order iteration is exactly the order `visibleGrants` was
already in, so `[...groupsByUserId.values()]` needs no separate order-tracking array either.

**The per-person row's own checkbox is a real tri-state control, not a second, disconnected
selection mechanism.** `allSelected`/`someSelected` are computed from the SAME `selectedGrants` set
each permission chip's own checkbox already reads — checking the person-level box adds or removes
every one of their grant keys at once, and the DOM's native `indeterminate` property (set via a ref
callback; React has no declarative prop for it) shows the "some but not all selected" state a plain
`checked` boolean cannot express on its own.

**The grant date moved INTO the chip as visible text, not a `title` hover tooltip** — the literal
ask ("the time as well but with better UI"), and consistent with this app having no `Tooltip`
primitive to reach for anywhere else (`card-identity-bar.tsx`'s copy button, `development-section
.tsx`'s checkout-copy button both already accept the same constraint). `PermissionGrantChip`'s own
per-permission revoke stays a two-step confirm — the identical shape `ConfirmButton` already gives
every other destructive-enough action in this codebase — built inline rather than by reusing
`ConfirmButton` directly, since that component's `label` is sized for a whole button's text, not a
compact pill that also has to hold a mono permission name and a date on one line.

### Phase 15 §7 — a 406 hint, and `get_pr_file_content` (SHIPPED)

`apps/api/src/automation/pr-read.service.ts` (`getPullRequestFileContent`,
`fitFileContentToBudget`) · `apps/api/src/ai/tools/pr.ts`'s `get_pr_file_content` ·
`apps/web/src/features/ai/tool-results.tsx`'s `renderGetPrFileContent`. Prompted directly, from a
real transcript: `get_pr_diff` failing with a bare "GitHub answered 406", and — in the same
exchange — "show me the content of apps/api/src/ai/complete.ts" getting a fabricated answer
("this file wasn't part of the repository before this PR") instead of either real content or an
honest refusal, because no tool in the registry could ever show a file's own text at all. The
same message also asked, more broadly, for the assistant to do "whatever a team lead can do from
GitHub by opening the PR" — a real, large ambition; this pass closes the two concrete gaps the
transcript actually hit, not that whole surface at once.

**406 is a real, distinct GitHub answer, not a variant of an existing hint.** `githubReadError`
already distinguished 401 (dead token) from 403 (live token, lost scope) with different recovery
advice; 406 means neither — GitHub refused to render the requested MEDIA TYPE for this specific
resource, which happens on `get_pr_diff`'s own diff media type when a PR is too large to diff that
way, and (once `get_pr_file_content` existed to hit it) on the raw content media type for a binary
file. No reconnect or permission change fixes either case, so the hint names the real alternative
— `get_pr_files`, or opening the PR/file on GitHub directly — instead of implying a retry would
help.

**`get_pr_file_content` needed a second round trip for the PR's own HEAD sha before it could ask
for anything** — "the file at this PR" means the file on the PR's branch, not whatever the default
branch currently holds, and GitHub's Contents API takes a `ref`. The same extra round trip
`getPullRequestStatus` already pays for its own checks-rollup sha, for the identical reason.
`application/vnd.github.raw` on the Contents API request is what returns the file's actual bytes
directly as the response body, rather than a JSON envelope with the content base64-encoded inside
it — the same "ask GitHub for the shape actually wanted" choice `get_pr_diff` already makes for
`application/vnd.github.v3.diff`. A binary file (an image, a compiled asset) answers 406 under this
media type, surfaced by the hint above rather than decoded into garbage text.

**`fitFileContentToBudget` is `fitDiffToBudget`'s own binary-search shape, repeated rather than
factored into one shared generic** — a second near-duplicate, matching how `githubReadError`
itself already writes each status hint out per-case rather than building a lookup table for two.
The property is identical either way: `JSON.stringify({..., content})` — the exact string
`execute()` hands back as `ToolResult.content` — has to fit under `MAX_TOOL_RESULT_CONTENT_CHARS`,
not just the raw content's own length, for the same JSON-escape-inflation reason the diff fix
directly above this section documents finding on a real PR.

**Each path segment is percent-encoded on its own, `/` separators preserved, before it ever
reaches a GitHub URL** — a path containing `@`, `#`, or a literal `..` segment is neutralized the
same way `encodeURIComponent` already neutralizes it everywhere else this codebase builds a URL
from caller-shaped input; there is no local filesystem underneath this call for a `..` to
traverse, only a GitHub API path, so no `repoPath`-style dedicated guard was needed on top of the
encoding itself. `pr-read.service.test.ts` asserts the exact encoded URL directly rather than only
that the call succeeds.

**The frontend renderer is a scrollable code block with the path and a truncation flag in its own
header row — the same "show real preformatted text, not a structured list" shape `renderGetPrDiff`'s
own `<pre>` fallback already established, not a second implementation of it.** No "view on GitHub"
link: unlike every other PR write-tool renderer, `PrFileContentResult` carries no `providerScope`
(nothing needed one before this tool), and inventing one purely to build a link was out of scope
for closing the immediate gap.

**Deliberately not attempted in this pass: the broader "do whatever a team lead can do from
GitHub" ambition the same message named.** Browsing the repository tree beyond one PR's changed
files, viewing commit history, or anything resembling edit-and-push access are each real, separate
features with their own authorization questions — `get_pr_file_content` closes the one concrete
"show me this file" gap the transcript actually hit, not the whole surface a person browsing
GitHub directly would have.

### Phase 15 §7 — `get_pr_diff` could 500 the whole assistant turn on a real PR (FIXED)

`apps/api/src/automation/pr-read.service.ts`. Found from a real report — "tell me the diff for pr
135" answered "The assistant could not reply" — traced to a server log showing `ai.chat.send`
throwing on its own OUTPUT validation: `messages[14].content` (the `tool_result` for that exact
`get_pr_diff` call) failed `String must contain at most 20000 character(s)`. This looked, at
first, like it could be the same dead-GitHub-token 401 this file documents finding and fixing
elsewhere in this phase — it was not; `getPullRequestDiff` reached GitHub fine and returned 200.

**The old `MAX_DIFF_CHARS = 20_000` capped the wrong string.** It bounded the RAW diff text
fetched from GitHub, chosen — the comment said so explicitly — to match `router.ts`'s own
`ChatMessage` `tool_result` variant's `content: z.string().max(20_000)` ceiling exactly. But
`execute()` never sends the raw diff as `content` — it sends
`JSON.stringify({prNumber, truncated, diff})`, and `JSON.stringify` turns every real newline in
the diff into the two characters `\n`. A unified diff is mostly newlines, so a diff already
sitting at the raw 20,000-character cap routinely serialized to well over router.ts's own
ceiling — the exact PR in the report never needed truncating by the old rule (its raw diff was
under 20,000 characters) and still blew the budget once JSON-encoded. **No test in this file
caught it because none of them ever asserted the SERIALIZED size of a large diff** — the existing
truncation test only checked `result.diff.length`, never `JSON.stringify(result).length`, which
is the number that actually crosses the wire and the number `router.ts`'s schema actually
validates.

**The fix, `fitDiffToBudget`, binary-searches the actual serialized size instead of guessing a
raw-text cap.** `MAX_TOOL_RESULT_CONTENT_CHARS = 19_500` — a little under router.ts's 20,000, as
headroom for the `{"prNumber":...,"truncated":...,"diff":"..."}` wrapper's own overhead and for
the truncation notice appended to a cut diff — is checked against
`JSON.stringify({prNumber, truncated, diff: candidate}).length` directly, not against
`candidate.length`. A fixed divisor (e.g. "assume JSON escaping adds 20%") was considered and
rejected: escape expansion is content-dependent — a diff full of quotes and backslashes (a JSON
file, a Windows path, a regex) escapes far more per character than a plain-prose one — so no
single ratio is safe for every diff a real PR could contain. The search is valid because
`size(mid)` is monotonically non-decreasing in `mid`: every additional raw character can only add
characters to the JSON-encoded output, never remove any.

**`pr-read.service.test.ts` gained the regression case the original bug needed and the old test
suite didn't have**: a diff built from 1,900 short lines (19,000 raw characters — under the OLD
flat cap, so the old code would have returned `truncated: false` and still overflowed the wire)
now asserts `JSON.stringify(result).length <= 20_000` directly, the real contract, rather than
trusting the raw diff's own length as a proxy for it. The existing truncation test was widened
the same way rather than left checking the old, wrong invariant.

**The index answers WHICH ORG; it can never answer WHICH RESOURCE.** RLS admits every
document row in the tenant, including a message in a DM between two other people — and
`member` genuinely holds `channel:read` from the role matrix, so a route that stopped at its
floor would return that DM with a decision trace that looks entirely correct. The real gate is
the per-hit `can()` loop in `search/router.ts`, which loads each hit's parent through that
resource's own loader and asks with the same Target its own routes use. Bounded at 50/100 so
it is a bounded loop, not a fan-out. Do not "optimize" it into a join.

**A transcript is the one hit kind whose permission has no target, and that is deliberate.**
`recording:read`, answered from ROLE ALONE — exactly as `getTranscript` asks it, because
"may see that a call happened" and "may read what was said" are two questions. Inventing a
per-resource target here would make search a cheaper door to a recorded conversation than the
telephony surface it came from. Its `title` and `author_id` are NULL on purpose: the obvious
title is a phone number, and 0033 blind-indexes counterparties precisely so a number never
sits in a readable column — a trigram-indexed `title` would undo that in the one table built
for substring matching. The body is safe to index because `comms.transcripts` has no
unredacted form to copy.

**A saved search stores TQL TEXT; `work.views` stores the AST. Both are right.** A view is
built by the visual builder, which has no text form to preserve. A saved search is typed, and
`format(parse(text))` is not the identity — it normalizes spacing, quoting and clause order,
so storing the tree hands the author back a reworded version of their own query. What both
share is that the value stays UNRESOLVED: `@me` and `-7d` survive as characters, or a shared
"assigned to me" means "assigned to whoever saved it."

**The card and search field sets are both closed and they do NOT overlap.** `assignee`,
`status`, `description` are card-only; `author` and `text` are search-only; `status` holds
ids rather than names and `assignee` is a `uuid_array` that `=` cannot compare. Two test
suites written the same day were wrong on first run for exactly this, and one shipped an
invalid example into a placeholder. Check a TQL example against `validate()` before writing
it anywhere a person will read it.

**Wave 3's status marker said SHIPPED while three of the things it scoped did not exist** —
saved searches, transcripts, and the builder ↔ TQL box — and the spec contradicted itself for
a day. Nothing built was wrong; the claim about what "shipped" covered was. The header records
it rather than quietly correcting it, which is the same habit this file documents for Phases
3.5, 5 and 7. **A status marker is a claim, not a fact.**

### Phase 13 Wave 1 — in-app voice (WebRTC)

`packages/db/migrations/0041_rtc_wave1.*` (the `rtc` schema) · `packages/security/turn-credential.ts` ·
`apps/api/src/rtc` · `apps/realtime`'s `/rtc` namespace · `apps/web/src/features/rtc` · `coturn` in
`compose.yaml`. Spec: [ai/phase-13-webrtc.md](ai/phase-13-webrtc.md), approved 2026-08-10.
⚠ Human-review surface (§2.2) — the TURN gate and the signal relay.

**A call room authorizes exactly like a channel room, and `rtc-rooms.ts` is almost empty because
of it.** `authorizeChannelJoin` already resolves membership, builds a `channelTarget` carrying
`closed`, and asks `can()`; `authorizeRtcJoin` turns a session id into its channel id and calls
that. DMs inherit the whole closed-target correctness argument for free. **Do not invent a second
membership check for calls** — `rtc.participants` records what happened and must never answer "may
this person join", which is the `participantIds.includes(userId)` shortcut Phase 5 §3.3 forbids,
rebuilt in the one layer with no HTTP audit trail. Two authorization QUESTIONS, deliberately not
merged: starting a call is `message:create` (making everyone's phone ring is speaking), joining one
is `channel:read`.

**The relay never trusts a peer id in the payload.** `rtc:signal` carries a `to`, and it is a
SELECTOR over the room roster the server holds via `fetchSockets()` — never a routing key. The
wrong implementation, `socket.to(userRoom(to)).emit(...)`, compiles, reads correctly, and hands any
authorized socket a message-injection primitive into any browser in the deployment. `from` is
stamped from `socket.data.identity`, so a client cannot impersonate another participant's offer.
`rtc.integration.test.ts` boots a real gateway with real clients and asserts both refusals; nothing
short of that distinguishes the two implementations.

**TURN is a bandwidth spend surface, so the gate shipped before the thing it gates.** Same
build-order constraint as Phase 7 Wave 1, and the same acceptance bar: the most important assertion
in `turn-gate.test.ts` is not that a refusal is returned, it is that **the secret was never used**,
asserted against a recording minter injected through `deps.mint`. Org freeze, then actual
participation, then a DURABLE per-org issuance budget in `rtc.turn_issuance` — in Postgres, because
an in-process counter forgives everyone on restart, which is the state an attacker restarts you to
reach. One row per credential MINTED, never per request, so a refused request cannot exhaust a real
org's allowance.

**The mesh cap is a CHECK constraint.** `joined_count <= max_participants` on `rtc.sessions`, so
the (N+1)th concurrent join is refused by the database rather than by a count-then-insert two
callers both pass. First-answer-wins is a conditional UPDATE (`WHERE status = 'ringing'`), the
`claimForScanning` pattern — a check-then-write lets two answers both "win" and both emit
`rtc_session.answered`.

**The `rtc` schema has NO `ALTER DEFAULT PRIVILEGES`, deliberately.** 0036's lesson generalized: a
schema with default privileges gives `taskflow_app` full CRUD on every table a later migration
creates there, so a migration's own "SELECT only" grant can be weaker than what the database
already enforces. With none, every grant is explicit forever — which makes "nothing may DELETE a
call record" and "nothing may UPDATE an issuance row" facts rather than intentions.

**Wave 2 (migration 0042) added ringing, ringtones, the missed-call notification, and recording
behind a consent gate.**

**A call rings on whatever page you are on, and the poll is still the correctness guarantee.**
`rtc_session.started` fans out to each invitee's `user:{userId}` room through a SECOND room table
(`USER_LIST_KEY_OF`) — not a widening of `USER_KEY_OF`, because a field that is sometimes an array
gives every call site a `string | string[]` and the branch that forgets the array case delivers to
nobody. An oversized list is refused entirely rather than truncated: "the call rang for some
people" is far harder to diagnose than a ring that did not happen. Phase 4's NOTIFY/poll
relationship holds — the socket makes it instant, the six-second poll makes it correct.

**Others keep ringing after the first answer.** `incomingCalls` filters on the caller's own
participant state, deliberately NOT on `status = 'ringing'` — that would silence everybody else the
instant one person picked up, so a three-way call could only ever have two people in it.

**Ringtones are Web Audio cadences, not files.** Nothing to host, nothing that can 404, and the
choice is a short enum with a CHECK constraint rather than a URL a browser fetches.
`identity.call_prefs` is global per user like `notification_prefs`, for the same reason: every
route reading it is a `selfRoute`, which resolves no org.

**Recording landed with the §3.9 condition met, not waived.** Three layers, as Phase 7:
`requestRecording` (a decision), `startRecording` (a code path), and
`sessions_recording_needs_consent` — `CHECK (recording_state <> 'active' OR consent_count >=
joined_count)`. A CHECK sees one row, so "everyone agreed" is a COUNTER comparison, the same trick
the mesh cap uses. `recording.service.test.ts` asserts that layer through the migrator connection,
bypassing the service entirely. Consequences worth knowing: somebody joining a recording call
PAUSES it (they increment `joined_count` and not `consent_count`, so the join would otherwise be
refused by the constraint); consent is cleared on stop, because agreeing once is not agreeing to be
recordable for the rest of the call; and there is NO admin override, because a capability that let
an owner record over an objection would make the gate decorative.

**The browser records, because there is no server in the media path.** Mesh audio never touches
this deployment, so the only place every stream exists together is one participant's tab. The
honest limit: the file is only as complete as that person's connection. The database records who
consented and when, not that the audio is forensically complete.

Still not done: calls in public channels (the ring list is the channel's member tuples and a public
channel has none), web push to a CLOSED tab, video, screen share, and any UI for browsing stored
recordings.

### Phase 12 Wave 1 — the platform console (org directory, flag overrides, operator audit)

`apps/api/src/platform-admin` · migrations 0035–0036 · `apps/web/src/features/platform-admin` ·
the `platformRoute` route kind in `apps/api/src/trpc/builder.ts`. Spec:
[ai/phase-12-admin.md](ai/phase-12-admin.md). ⚠ Human-review surface (§2.2): the module runs as
`taskflow_platform_admin`, the one role that can change another org's status, so the author reads
every line of it before merge.

Shipped: the flat operator flag (`platform.operators` — SELECT-only for every
application-reachable role, bootstrapped by migration, never by a route); the org directory
(list/suspend/reactivate, writing `identity.orgs.status` and nothing else through the dedicated
role's permissive policies); global feature-flag overrides (`platform.flag_overrides`); a GLOBAL
hash-chained operator audit log (`platform.operator_audit_log`, the one-row sibling of 0007's
per-org chain) recording every operator call — reads included; `platformRoute` (no org context
at all, step-up baked into every call, while `self.check` is deliberately a `selfRoute` so the
account menu can ask for everyone); `tenancy.members.transferOwnership` (one atomic transaction,
never an observable zero-owner moment); the email-verification gate and 3/day rate limit on
`orgs.create`; and suspension enforcement in `resolveOrgMembership` — one check that refuses the
suspended org's routes, realtime room joins, AND collab page authorizations for free. The web
console lives at `/platform-admin` (Orgs, Users, Flags, Audit), gated on the server's own
`self.check` answer.

**Two grant bugs had no failing unit test and were found only by the wave's own §6 tests against a
real database — the same lesson Phase 4 and Phase 6 taught: the database does not read your
comments.** First, migration 0001's `ALTER DEFAULT PRIVILEGES ... IN SCHEMA platform` gives
`taskflow_app` full CRUD on every table the migrator later creates there, so 0035's "SELECT only"
grants on `platform.operators` were weaker than what the database already enforced — the table was
WRITABLE by the app role despite the migration saying otherwise, until 0036's explicit REVOKEs. A
migration that creates a table in a schema with default privileges must say what the table should
NOT have, not only what it should. Second, `GRANT USAGE ON SCHEMA public` from a migration is a
silent no-op: `03-grants.sql` grants the migrator `ALL ON SCHEMA public` WITHOUT GRANT OPTION, so
Postgres answers `WARNING: no privileges were granted` and changes nothing — which meant the
operator chain trigger could not call `public.digest` as SECURITY INVOKER at all. The fix is a
narrow SECURITY DEFINER hash wrapper (`platform.operator_chain_hash`) in a schema the role can
use, keeping the trigger SECURITY INVOKER per the 0007 precedent and the digest preimage
byte-identical. Both are written up in 0036's own header.

§3.9 (the notification sweeps respecting org suspension) shipped 2026-08-09 with migration 0037:
the due-reminder scan, digest collection, push drain, and the projection's immediate-email
decision all join `identity.orgs.status = 'active'`, via column-limited `(id, status)` org reads
for `taskflow_notification_sweep` and `taskflow_audit` (permissive policies, the 0035 shape).
Pending deliveries written before a suspension stay `pending` and resume on reactivation; the
§3.9 suite in `wave2.sweep.test.ts` proves all four paths refuse a suspended org as the real
roles.

The flag-override store gained its live consumer 2026-08-09: `platform-admin/flag-evaluator.ts`
merges `platform.flag_overrides` into `FeatureFlags`' env tier (TTL-cached, single-flight),
`platformAdmin.flags.list` resolves every row through the real evaluator, and a `flags.snapshot`
selfRoute serves the resolved snapshot to the client bootstrap. §9's stretch also landed the same
day: `platformAdmin.orgs.suspend`/`.reactivate` freeze or unfreeze the org's Twilio subaccount
through the telephony module's own `setSubaccountStatus` (reused; best-effort and last, so a
missing subaccount or carrier outage never fails the operator's action), with the freeze recorded
in the org's audit chain via `subaccount.status_changed`.

Still open: granting the operator flag is migration/script-only (§7 decision 7 — no self-service
route, deliberately); and `platformAdmin.audit.list` exists because the doc's route list named the
Audit tab but no route to feed it.

### Phase 12 Wave 2 — identity extras, device security, account erasure (SHIPPED)

Spec: [ai/phase-12-wave2.md](ai/phase-12-wave2.md). **This section did not exist until 2026-08-12,
two days after the code shipped** — the spec's own header still said "approved for build" the
whole time, which is the exact "status marker is a claim, not a fact" failure this file's Phase 5
and Phase 8 sections already document, just caught later. Shipped, verified against the real code
rather than trusted from the spec: user suspension (`identity.users.status`, mirroring Wave 1's org
suspension); TOTP as a second factor (`totp.service.ts`, migration 0040, the identity-scoped data
key, login returning a `totp_required` challenge); OAuth sign-in for Google/GitHub with auto-link on
a provider-verified email (`oauth.service.ts`); device/session inventory and impossible-travel
detection over `identity.sessions` (migration 0043, IP-country-level only, flags rather than
blocks); org deletion as a real cascading `DELETE` behind a suspend-then-type-the-slug two-step gate
(migration 0044, `platformAdmin.directory.delete`); and self-serve DSAR export
(`people.exportMine`).

**One real gap, closed the same day it was found:** `auth.totp.startEnrollment`/`confirmEnrollment`
had shipped with no caller — `account-page.tsx` had Passkeys, Connected accounts, Sessions, and
Export sections but nothing for TOTP, so a user could never actually turn it on. Closed by
`totp-section.tsx`, mirroring `passkey-section.tsx`'s enroll-then-confirm shape (show the secret,
collect one real code, show recovery codes exactly once) rather than inventing a new pattern.

**Phase 12 Wave 3 — billing & org lifecycle — SHIPPED (the spec header lags).** Its spec
[ai/phase-12-wave3.md](ai/phase-12-wave3.md) (written 2026-08-12) still opens "DRAFT, not yet
approved for build", but the code has since landed: `packages/payments` (the `PaymentProvider`
interface with a Stripe implementation and a `fake` for tests), `apps/api/src/billing`
(`org-billing.service.ts`, `webhook.routes.ts`, `entitlement-resolver.ts`, `overage.service.ts`,
`sweep.service.ts`, `billing-mail.ts`), migration 0059 (`identity.orgs.billing_status`), and the
billing UI in both `apps/web` and `apps/mobile`. Left as a corrected-in-place note rather than a
silent rewrite of the spec header, per this file's own discipline. The design, unchanged and
correct: it confirms Wave 1's org-role /
platform-operator split already holds (an Owner of N orgs has N independent, non-overlapping
memberships; `platform.operators` has no relationship to org membership at all) and adds the
piece that was actually missing: an org's subscription/trial state, as a **second, independent**
column (`identity.orgs.billing_status`) from Wave 1's own operator-controlled `status` — kept
separate on purpose, so an automated billing recovery can never silently undo a manual operator
suspension (or vice versa). Enforcement widens the same `resolveOrgMembership` chokepoint Wave 1
built rather than adding a second one. Stripe is the first `PaymentProvider` implementation,
chosen by an explicit `PAYMENTS_PROVIDER` env var (not credential-sniffed, unlike telephony's
`ACtest` marker) so a second processor is an implementation swap, per the project owner's own
instruction.

#### Phase 7 — four defects a green suite could not see, found by a live carrier (2026-08-10)

**Outbound telephony had never worked against real Twilio**, through five "complete" waves, 733
passing API tests and a clean lint. Read `ai/phase-7-voice.md`'s status header before touching any
of it; the short version:

**Basic auth paired the subaccount SID with the parent's auth token**, which names no account —
every number search, purchase, release, call and SMS answered 401/20003. Only subaccount creation,
Lookup and Verify worked, because only those three passed the parent SID, so it read as a
credentials problem rather than a bug. **The wrong rule was written down first**:
`subaccount.service.ts` claimed Twilio "accepts the master token for its children", `twilio.ts` was
built to match, and `twilio.test.ts` asserted the same wrong pairing — an implementation and a test
that agreed with each other and with nothing real. `#authorization` no longer takes a username at
all: the subaccount is named by the URL path, the credential is always the parent's pair.

**`/telephony/outbound/:callId` was never registered**, though `placeCall` has always pointed Twilio
at it for the call's TwiML. `outboundTwiml` sat in `packages/telephony` with no caller. Calls were
accepted and then dropped on a 404 — no phone ever rang. `placeCall`'s tests assert what we SEND the
provider; this is the request the provider makes BACK, and nothing but a real carrier issues it.

**Record intent was never persisted** (migration 0038). Folding `record` into
`announcement_required` is recoverable in an all-party jurisdiction and ambiguous in a one-party one
— GB, CA, IE, NZ, IN, ZA all store `false` either way — so recording silently did nothing for a
large share of destinations. Two facts, two columns, because a compliance review needs both.

**A missing `TELEPHONY_WEBHOOK_ORIGIN` yielded RELATIVE callback URLs.** Purchase fails loudly
(21402); the quiet half is that `statusCallbackUrl` is how actual cost arrives, so the instance
would bill every org against `sumWithFallback`'s ESTIMATE forever. `deps.ts` now refuses at boot for
a live carrier — the `TELEPHONY_INDEX_KEY` precedent.

**None of it was diagnosable until `TwilioApiError` carried Twilio's numeric `code`.** The body is
still withheld (Twilio echoes phone numbers and message bodies into error payloads, exactly what
`REDACTION_PATHS` guards), but the code is an integer from a published table that echoes no
parameter. `carrier-error.ts` maps the ones worth naming, so a landline in the To field is a field
error rather than a 500.

Also shipped: the surfaces PLAN.md §3.4 named and Wave 5 missed — a "New message" composer (there
was **no way to start an SMS from the UI**), click-to-call from an SMS thread, a contact, and a 1:1
DM, plus `people.membership_profiles.work_phone` (0039), org-scoped so a number given to one
employer is not disclosed to every other org. And `placeCall`'s refusal path now compensates the
ledger (`actual_cents = 0`, call `failed`) rather than leaving an estimate held against the cap for
30 days with no SID to correct it.

### Phase 7 — Voice & Messaging: Waves 1–4 complete (API), Wave 5 (UI) added and shipped

**Every wave through Wave 4 shipped `apps/api/src/telephony` only — nothing in `apps/web` referenced
telephony at all, despite the spec's own §2 listing click-to-call and an SMS inbox as in-scope.**
That was a real gap against the phase's stated scope, not a deferral: Chat and Docs each shipped
their UI inside their own phase, and this phase's spec never said Wave 5 would come later. Added and
shipped in the same session that found the gap — `apps/web/src/features/telephony` (numbers, calls,
messages, spend) behind a new `/calls` sidebar item, and `recording-section.tsx` for attaching a
recording to a Work card. See `ai/phase-7-voice.md`'s own Wave 5 note for the two API-surface gaps
this UI had to design around (no `fromPhoneNumberId` on a thread; no org-wide recording search).

### Phase 7 — Voice & Messaging: Waves 1–3 complete, Wave 4 split

`packages/telephony` · `packages/security/twilio-signature.ts` · migrations 0032–0034 (`comms.*`) ·
`apps/api/src/telephony`. Spec: [ai/phase-7-voice.md](ai/phase-7-voice.md), approved 2026-08-08.
⚠ Human-review surface — read that spec's status header before touching any of it. That header was
itself stale for a stretch of this phase (see below), which is the same lesson Phase 3.5 and Phase 5
already taught this file: a status marker is a claim, not a fact, and this codebase's own habit of
correcting a wrong premise in the header rather than silently in the code is what makes it possible
to catch.

**Wave 1 (below) shipped the gate before anything could reach it. Waves 2 and 3 — numbers, calls,
the consent gate, recordings, transcripts, SMS threads, STOP/UNSUBSCRIBE, and card-attached
recordings — shipped in the same commit that never updated this section or the spec's own status
line, so a later pass found a phase that read "not started" and was, by file count, mostly done.**
Nothing wrong was found in that read-through beyond the status claim itself; what was missing was
test coverage for it, not correctness. `call.service.test.ts` and `message.service.test.ts` closed
the two highest-stakes gaps: the first proves `comms.calls`' `calls_recording_after_announcement`
CHECK constraint — not the service — is what actually refuses a recording started before a required
announcement played; the second proves `sendSms` checks the suppression list BEFORE the spend gate,
using an org that is both suppressed and over its cap so the ORDER is what the assertion depends on,
not just the outcome. `number.service.ts`, `recording.service.ts` and `transcript.service.ts` still
have no dedicated test file.

**Wave 4 — Twilio Verify wired into "the existing MFA path" — does not have an existing MFA path to
wire into.** The spec's §3.12 assumed one exists in `apps/api/src/identity`; PLAN.md §3.4 is explicit
that TOTP and this SMS/call fallback are deferred to Phase 12, itself still an unapproved draft, and
`apps/api/src/identity` today is password and passkeys only. _(True when this paragraph was written;
Phase 12 Wave 2 has since shipped real login-time TOTP — `apps/api/src/identity/totp.service.ts` —
so this describes the state at the time, not the state now. Left as written rather than edited, per
this file's own rule about correcting a stale claim in place instead of silently rewriting it.)_
Building a login-time second factor here
would be new, un-spec'd work on a second human-review surface, not "finishing" an approved phase — so
only the capability shipped: `verify.service.ts`'s `startPhoneVerification`/`checkPhoneVerification`,
gated through the identical `checkOutboundAllowed` chokepoint every other outbound path uses, with no
caller, the same way Wave 1 shipped webhook verification "with no route registered yet that uses it
for anything real." The cost-attribution half of Wave 4 — `spend-report.ts`'s `spendReport`, grouping
`comms.spend_ledger` by kind, gated `recording:read` (the catalog's admin tier, reused rather than
extended per §6.3) — shipped in full, with a route and a test suite.

#### Wave 1 — the gate that ships before the thing it gates

**Wave 1 deliberately ships nothing a user would call a feature.** The acceptance bar is "the gate
exists and refuses correctly", proven against a `TelephonyProvider` no product surface calls yet.
The most important assertion in `spend-gate.test.ts` is therefore not that a refusal is returned —
it is that **the provider was never reached**, asserted against a fake that would have recorded it.
A gate that answers `{ allowed: false }` after having already placed the call reads correctly in a
diff and costs money in production, and only an assertion about the provider tells the two apart.

**`+1` is not a country, and that is why the geo check matches PREFIXES.** The E.164 code +1 is the
North American Numbering Plan — the US and Canada plus about twenty Caribbean territories that bill
at premium international rates while looking like an ordinary domestic number. A geo check that
resolved "+1" to a country and asked whether that country is allowed permits every one of them, and
`+1-809-...` is the classic toll-fraud destination. `geo.ts` is a closed, default-DENY table where
longest-prefix wins, so a `deny` on `1809` overrides the `allow` on `1`; a test reverses the table
to prove ordering cannot change a verdict.

**The spend sum is `COALESCE(actual, estimated)`, never `SUM(actual)`.** A ledger row the carrier
has not billed yet has a NULL `actual_cents`, so summing that column alone counts every in-flight
action as free — which is exactly the window an attacker exploits by going faster than
reconciliation. `SUM` over zero rows is also NULL, and a NULL parsed in JavaScript is `NaN`, which
compares false against every threshold: an org with no history would read as permanently under its
cap. Both halves live in `sumWithFallback` in `packages/db/expressions.ts`, because raw `sql` is
banned in feature code and the answer to that ban is a named expression, not an exemption.

**The velocity limiter runs LAST, because it is the only check that mutates.** Counting an attempt
that was going to be refused anyway lets an attacker burn a legitimate user's burst allowance with
requests that cost nothing to refuse — a denial of service inflicted through a control meant to
prevent one. It is also not the durable defence: those counters are in-process, so a restart
forgives everyone. The spend ledger in Postgres is what actually stops the bill, the same
relationship §8.9's per-IP limiter has to the database-backed account lockout.

**`identity.orgs.status` has existed since migration 0004 and nothing ever read it.** The gate is
its first reader. It is checked there rather than at the HTTP layer because telephony's cost risk
lives on paths that never authenticate a request — an inbound webhook, a queued send — and a kill
switch that only runs where a user is waiting is not a kill switch. Phase 12 Wave 1 will set the
column from its console; adopting it is a swap, not a redesign.

**The webhook's order of operations IS the control**, and it looks like trusting the payload.
`AccountSid` is read from an unverified body, resolved to an org through `comms.subaccount_orgs`,
and that org's token is what the signature is then checked against. That is a client-supplied value
used as a LOOKUP KEY, not as an assertion — the same reason Phase 4's `x-taskflow-org` header is
safe. Naming a subaccount whose token you do not hold resolves to an org whose key refuses you.
Nothing is written before the signature passes, and the replay check runs AFTER it, or an
unauthenticated caller could write rows into `comms.webhook_nonces` for any SID they can guess.

**The replay nonce is recorded on SUCCESS, inside the handler's own transaction.** Twilio retries a
webhook when we answer 5xx, and a retry carries a byte-identical signature — so a nonce written on
receipt would mark the request seen, the handler would fail, and the retry that exists to recover
the event would be refused as a replay. The event is lost silently, only when something was already
going wrong. Writing it alongside the effect makes a failed attempt roll it back too.

**Read a spec's own status header before trusting a phase marker anywhere else.** The §13 roadmap
table and this section were both stale for the whole of Phase 3.5's Wave 1 and Wave 2, which is how
an agent asked to find "what's next" confidently answered Phase 4 while Wave 3 was still open. The
same staleness recurred at the end of 3.5. If you are reading this to decide what to build, open the
newest `ai/phase-*.md` and read its header first.

Deferred deliberately from Phase 3, and NOT bugs: Calendar and timeline views are §10.4 surfaces
the plan does not schedule until later _(the calendar half has since shipped — see its own section
further down)_. `packages/ui` is still unbuilt on purpose — §6 says extract a component only once
the same pattern appears three times, and `components/primitives.tsx` is where that will be
measured from.

**The line that used to stand here — "passkey sign-in is wired on the API but the browser ceremony
is not in this build" — was stale, not corrected in place until this pass found it by actually
checking, the identical failure mode this file's own "a status marker is a claim, not a fact"
discipline exists to catch.** `apps/web/src/features/auth/passkey.ts` (`signInWithPasskey`,
`enrollPasskey`, both wrapping `@simplewebauthn/browser`'s `startAuthentication`/`startRegistration`
with a closed `PasskeyCeremonyReason` set rather than surfacing the raw `WebAuthnError`) has been
fully built and wired for some time: `login-page.tsx` renders a real "Sign in with a passkey"
button behind a `browserSupportsWebAuthn()` check, and `account-page.tsx`'s `PasskeySection`
(enroll-then-confirm, mirroring TOTP's own shape) is what actually lets someone add one. Both carry
real test coverage (`login-page.test.tsx`, `passkey-section.test.tsx`). Nothing here needed
building; the deferral note itself was the only thing behind.

### Phase 4 — the realtime spine, and the failures that do not announce themselves

`apps/realtime` · migration 0016 · `apps/web/src/lib/socket.ts`. ⚠ `auth.ts` and `rooms.ts` are
human-review surfaces (§2.2): together they decide who is in which room, for hours at a time.

**There is nowhere in the protocol to assert an identity, and that is the design.** A socket's
identity is set exactly once, at the handshake, from the verified token, onto `socket.data`. Every
handler reads it from there. `JoinRequest` carries an org and a board and nothing else, `.strict()`,
so a client sending `userId` is REFUSED rather than having the field ignored — ignoring it reads as
"harmless" to the next person and invites a handler that trusts it. This is the shape of the most
damaging Socket.io bug there is: "subscribe me to my own notifications", taking the id from the
message, looped over a range harvests everyone's data from a connection that proved nothing, and
leaves no HTTP audit trail because no route was touched. `wire.test.ts` asserts the refusal.

**The org id in a join IS client-supplied, and that is safe for the same reason the
`x-taskflow-org` header is.** It selects a row inside `withUserScope(verifiedUserId)`; it is never
written to `app.org_id` and never becomes a role. Naming an org you are not in matches zero
membership rows. Do not "harden" this by trusting a token claim instead — that reintroduces the
staleness the HTTP path spends a query per request to avoid.

**`FOR UPDATE` needs an UPDATE policy, and the failure is silent.** Migration 0016 granted the
consumer role SELECT only. `claimPending`'s claim is `SELECT ... FOR UPDATE OF o SKIP LOCKED`, and
Postgres will not lock a row that does not also pass a policy applying to UPDATE — it EXCLUDES the
row rather than erroring. The gateway booted cleanly, logged nothing, and delivered zero broadcasts,
indistinguishable from an idle queue. The policy's `WITH CHECK` is `false`, not `true`: a locking
select never writes a row, so it never reaches WITH CHECK — the lock is permitted and an actual
write is refused by the database. Both halves were confirmed against a real database, because
"a locking select skips WITH CHECK" is exactly the kind of claim that is cheap to believe.

**`NOTIFY` is an optimization; the poll is the correctness guarantee.** Nothing queues a
notification for a disconnected listener, so a gateway that woke only on `NOTIFY` would lose events
precisely when it had just recovered. Delete `notify.ts` and everything still arrives, one poll
later; delete the poll and events vanish. That asymmetry is why both exist, and why the poll
interval is free to stay lazy.

**Rooms do not survive a reconnect, and the client must replay the join.** The gateway's own
`disconnect` handler already cleared its side, so a socket that merely re-authenticates sits in no
rooms — receiving nothing, while looking connected, forever. `socket.ts` tracks what this tab wants
joined and replays it on the Manager's `reconnect` (not `connect`, which also fires on the first
connection and would refetch every board on every page load). The room is recorded BEFORE the emit,
never in the ack: an ack only arrives if the connection survives to carry it back, so recording it
there loses exactly the joins that were in flight when the socket dropped.

**Presence uses `fetchSockets()`, never `io.sockets.adapter.rooms`.** The latter sees only sockets
on THIS instance, so presence would report a subset the day a second one starts, with nothing
failing to say so. The Postgres adapter is wired at single-instance scale precisely so that day is
not a retrofit; presence must not be the one thing that quietly assumes one process.

**A test asserting on the outbox must scope to its own org.** `platform.outbox` is one global queue
— a consumer drains every tenant by design — so `claimPending` legitimately returns other suites'
rows, and turbo runs packages in parallel against one `taskflow_test`. Unscoped assertions fail with
`expected 6 to be 1`, which reads as a fan-out bug rather than a foreign fixture, and only
sometimes, so the reflex is to re-run rather than investigate. `ours()` in `relay.test.ts` and
`audit.test.ts` is the fix; emptying the table instead would delete fixtures belonging to suites
that file knows nothing about. Residue is not self-generating — a clean run leaves zero rows — but
an ABORTED run skips `afterAll` and seeds the next failure, which is how one red suite cascades.

### Phase 3 — `apps/web`, and the two places its types lied

`apps/web`. React 19 + Vite 6, TanStack Router/Query, Zustand, Tailwind v4, dnd-kit, TipTap.

**The wire says `string` where the client type says `Date`.** No transformer is configured on
either side (`initTRPC.create()` takes none), so `z.date()` outputs are `JSON.stringify`'d to
ISO strings while tRPC infers them as `Date`. Nothing fails: `format(card.dueDate)` silently
renders "Invalid Date", and a sort comparing them compares `undefined`. That is the one hole in
guardrail 5, and it is invisible because the compiler agrees with the lie. `lib/wire.ts` restates
each output as what JSON actually delivers, and `wire()` is called on every result — a no-op at
runtime whose whole job is to make the compiler stop agreeing. Adding superjson later collapses
`Wire` to identity and every call site is a greppable list of what to delete.

**TipTap emits attributes the server refuses, and refuses them on purpose.** `getJSON()` includes
every extension default — `orderedList` carries `type: null`, a link carries `rel` and `class` —
and the API's node schemas are `.strict()`. `rel` is excluded deliberately: a document that could
set it could opt itself out of noopener. So any document containing a numbered list or a link
failed validation, and the tempting fix was to loosen the server. `detail/rich-text.ts` normalizes
instead, and `rich-text.test.ts` parses with the API's REAL `RichTextDocument` schema — asserting
both that the raw editor output is rejected and that the normalized output is not.

**`cards.update` is a full replace, and the table view only holds a summary.** `cards.list`
returns no `description` and no `startDate`; the update route writes all four fields and its Zod
schema DEFAULTS the missing ones to null. So the obvious inline-edit implementation — take the
row, change the title, send it — erases a description per rename, silently, with the panel that
would show the loss closed. `useUpdateCard` reads the full card first and applies a patch to it,
so a caller can only express "change these fields" and cannot express "clear the ones I could not
see". It uses `'x' in patch` rather than `??` because clearing a date is `{ dueDate: null }` and
`??` would treat that as "not supplied".

**Neighbours, never a rank.** `neighbours.ts` is the entire client-side contribution to ordering,
and every way it can be wrong is silent — the card lands one slot from where it was dropped, and
the server faithfully places it between whatever it was given. Two traps: the dragged card must be
removed before measuring (or a downward move lands one short), and a card dropped ON ITSELF has to
resolve to its own current position — searching for it in the already-filtered array returns -1,
which falls through to "append" and sends a card to the bottom of its column for being clicked.
A test caught the second one. The last group in `neighbours.test.ts` feeds the result to the real
`between()`, because a reversed pair is an `InvalidRankError` that makes the server rebalance an
entire column over a client bug.

**The selected org is remembered, and remembering it is not the same as knowing it.**
`orgId` persists in `localStorage` and is read at module load — before a session exists, so
before anyone knows whose selection it is. `requireOrg` only asked whether an org was SELECTED,
and a stale id passed straight through to `/projects`, where every query answered NOT_A_MEMBER.
A dropped database, a revoked membership, or a second person signing in at the same browser all
produce that state. It was invisible because the only thing that cleared the stored value was
the sign-out button, so it appeared exactly once per browser and then "fixed itself" forever —
which reads as a fluke rather than a bug. Three things close it. `OrgGate` validates the stored
id against `tenancy.orgs.list` — the one read that works with no org, answered by `withUserScope`
— and BLOCKS the router until it settles, because a check that races the first org-scoped query
is no check at all: the error card is already on screen by the time it answers. `clear()` drops
the org so a session ending by expiry or reuse detection cannot leave one behind. And a
NOT_A_MEMBER anywhere drops the selection and routes to the picker, because a membership can be
revoked while the tab is open and the code is correctly classified as terminal — retrying it
changes nothing, which is exactly why it used to be a dead end. The recovery is guarded on
`orgId === null` so a board's dozen simultaneous failures act once. `OrgSwitcher` also renders
with an empty list now: it used to return null, which hid the only route to `/orgs` from the one
caller who needed it.

**A SUSPENDED membership hit the identical silent-drop path a STALE selection does, and the two
needed to be told apart — found from a real report, not a hypothesis.** `resolveOrgMembership`
(`apps/api/src/tenancy/resolve.ts`) used to collapse "no such org", "never a member", "membership
suspended", and "role unrecognized" into one NOT_A_MEMBER, on the reasoning that distinguishing
them would let an outsider probe which orgs exist. That reasoning holds for the first two — a
missing row, for any reason — and does NOT hold for a row that DOES exist: the query is always
`WHERE user_id = <the caller's own id>`, so telling someone their OWN membership is suspended
leaks nothing about anyone else's, only a fact they already know (they were once let into this
org, or they would hold no stored selection naming it at all). `identity.memberships.status` is
`'active' | 'suspended'` (migration 0004's own CHECK) and had been reachable in the schema since
then with no code path ever reading the difference — a member whose row this codebase's own
platform console (`org-detail.service.ts`'s `getUserDetail`) showed as `status: suspended` still
got a bare "you are not a member," which `apps/web/src/lib/query.ts`'s `recoverFromLostOrg` then
read as a stale selection and silently cleared, landing them on the picker with nothing on screen
explaining why — exactly the confusing shape `orgSuspended`'s own header had already argued
against for the ORG-level case, just never extended one level down to the membership row.

**`MEMBERSHIP_SUSPENDED` is a new, distinct error code (`packages/contracts/src/errors.ts`),
thrown by `resolveOrgMembership` only when a membership ROW EXISTS and its status is not
`'active'` — a missing row still returns null, so "no such org" and "never a member" stay
collapsed exactly as before.** `tenancy.orgs.list` (`org.service.ts`'s `listMyOrgs`) changed to
match on the READ side: it used to filter to `status = 'active'`, which made a suspended
membership indistinguishable from a stale selection naming an org the caller was never in — both
simply vanished from the list. It now returns EVERY membership with a `membershipStatus` field per
row, and the two UI surfaces that consume it decide what a non-active row means to show, rather
than the query deciding by omission.

**`OrgGate` (`apps/web/src/features/org/org-gate.tsx`) renders a direct explanation with a
"Choose a different organization" button INSTEAD OF the router for a matched-but-suspended row,
never the silent `selectOrg(null)` + redirect a genuinely missing row still gets.** The two cases
look identical from `requireOrg`'s own perspective (both end with `orgId === null` and a bounce to
`/orgs`) but are reached differently on purpose: a missing row has nothing true and useful to say
beyond "that selection no longer means anything," which the redirect itself communicates by simply
not finding the org on the picker; a suspended row has a real fact to state, so the gate states it
BEFORE clearing anything, and only drops the selection on the person's own click. `OrgPickerPage`
gained the identical fix independently for the same reason a stale-vs-suspended distinction needs
to hold on BOTH surfaces: a suspended org used to simply not appear in the list at all (identical
to never having existed); it now renders as a dashed, unclickable row labelled "Your membership is
suspended," so someone who navigates to `/orgs` directly — not just someone bounced there by the
gate — sees the same explanation. `apps/mobile` got the equivalent fix in `app/(app)/_layout.tsx`
(filtering to `membershipStatus === 'active'` before resolving a remembered selection — a widened
server contract that would otherwise have let a suspended org be silently auto-selected, a
regression this pass caught and closed rather than shipped) and `app/org-picker.tsx` (the identical
dashed, unpressable row `OrgPickerPage` renders on web).

**As of this pass, nothing in the product actually WRITES `identity.memberships.status =
'suspended'`** — a full search of `apps/api/src` found no service function setting it; `removeMember`
deletes the row outright rather than suspending it, and Phase 15 §8's onboarding/offboarding
actions revoke sessions and grants, never touch this column. The column and its CHECK constraint
have existed since migration 0004 with no writer ever built for them. This pass fixes how the
system BEHAVES when the value is `'suspended'` — found reachable by direct inspection, not by any
in-product flow — without adding a way to reach it; a "suspend one member" admin action is real,
separate, unrequested work.

**A follow-up report clarified the original bug was about the ORG being suspended, not the
membership — a DIFFERENT column this pass had left completely unsurfaced.** `resolveOrgMembership`
has thrown a distinct `ORG_SUSPENDED` for `identity.orgs.status = 'suspended'` since Phase 12 Wave
1's org directory shipped, long before this session — but `tenancy.orgs.list` never reported the
org's own status at all, only the caller's membership status, so neither `OrgGate` nor the picker
had anything to check. An org an operator suspended from the platform console still showed as a
perfectly ordinary, clickable row; choosing it passed `OrgGate` cleanly (the caller's own
membership was still `'active'`), and the FIRST org-scoped query on the next screen threw
`ORG_SUSPENDED` into a query-error path built for nothing in particular — the exact "redirects
back to the org list with no explanation" complaint the membership fix had already been built to
prevent, just for the sibling case nobody had extended it to.

**`OrgSummary`/`listMyOrgs` (`org.service.ts`) gained a second field, `orgStatus`, read alongside
`membershipStatus` rather than folded into it — they answer different questions and a caller of
either surface needs to tell them apart.** `'deleted'` is filtered OUT of the query rather than
reported, mirroring `resolveOrgMembership`'s own privacy answer for that status (collapsing to "as
if never a member") — real cascading org deletion (Phase 12 Wave 2) should make this unreachable
in practice, but the filter keeps the two functions' answer identical rather than letting them
accidentally diverge if that ever changes. `orgs.list`'s output schema widened to match.

**`OrgGate` and `OrgPickerPage` both now check `orgStatus` FIRST, before `membershipStatus`** — an
org suspension is the bigger fact (it refuses every member, not just the caller), so if a row
somehow carries both at once, the org-level explanation ("This organization has been suspended" /
suspended by a platform administrator) is the one shown, not the personal one ("Your membership is
suspended"). `apps/mobile` got the identical two fixes: `(app)/_layout.tsx`'s remembered-org
resolution now filters on `orgStatus === 'active'` alongside `membershipStatus === 'active'` before
ever auto-selecting a stored id — without it, a suspended org's id, remembered from before an
operator acted, would auto-select straight past the picker and land the caller on guarded screens
where every query would throw `ORG_SUSPENDED` with nothing to catch it, the identical regression
class the membership-status filter was added to prevent one paragraph earlier in this file, just
for the column nobody had thought to filter on yet. `org-picker.tsx` renders the same
distinguishing row text as web's picker.

**The access token is in memory and the refresh is single-flight.** `localStorage` survives the
tab and is readable by any script, so one XSS is a token an attacker keeps; a module variable
limits the same XSS to that tab. The cost is a refresh on every page load, accepted. Single-flight
matters more than it looks: refresh tokens rotate with reuse detection, so a board firing a dozen
queries at once against an expired token would present the same cookie a dozen times — the first
rotates it and the rest are replays, revoking the whole session family for loading a page.

**The URL is a trust boundary, parsed with the shared schemas.** Route params and search params go
through `BoardIdSchema`, `CardIdSchema` and `FilterTree` — the same parsers the API uses — so a
filter pasted into a link is validated against the real AST before a component sees it, and a
corrupted one falls back to the unfiltered board instead of an error page. `next=` on the login
route rejects anything not starting with a single `/`, because an absolute URL there turns sign-in
into an open redirect wearing our branding.

**The UI never re-derives authorization.** Every control is shown and the server answers. §8.2 is
explicit that a UI reimplementing `can()` produces two models that drift, and the one users see is
the one that is never tested — so the permission debug page renders the server's decision trace
and computes nothing, and a member who cannot create a project gets an honest FORBIDDEN rather
than a hidden button.

### Phase 3 — the filter field that was broken in both backends

`packages/filter/src/fields.ts`. `label` compiles to an aggregate subquery returning `uuid[]` and
was declared `type: 'uuid'`. It had no test. The compiler emitted `uuid[] = uuid`, an operator
Postgres does not have, so every label filter was a 500 — while the evaluator took the scalar
path, compared an array with `includes`, and quietly matched nothing. Two backends, two different
wrong answers, and the package whose entire purpose is that they agree.

`uuid_array` puts both on the array path: `&&` overlap in SQL, `some()` in JavaScript, and
`is_empty` covers the NULL that `array_agg` returns for an unlabelled card. The `not_in` case is
the one worth keeping a test on — a bare `NOT (labels && ...)` is UNKNOWN for a card with no
labels, so Postgres drops exactly the rows the user expects to see, and the compiler's COALESCE is
what keeps them.

### Phase 3 — attachments, and the control that was not real

`packages/storage` · `packages/security/magic-bytes.ts` · `virus-scan.ts` ·
`apps/api/src/work/attachment.service.ts`. ⚠ Human-review surface (§2.2).

**The pipeline is a state machine on one column.** `pending → scanning → clean | infected |
rejected`, and the whole security argument is that `presignDownload` is called for exactly one
of those. The object exists in storage the moment the browser's PUT finishes — nothing can
prevent that — so what the service controls is whether anyone is ever handed a URL to it.

**"Pinned in the signature" was false until a test said so.** §8.4 specifies a presigned PUT
with MIME type and size pinned. Setting `ContentType` on the SDK command does NOT do that: a
SigV4 presigned URL only covers headers named in `X-Amz-SignedHeaders`, which defaults to
`host` alone. The first version compiled, read correctly, documented the guarantee — and MinIO
accepted HTML uploaded under a `text/plain` signature. `signableHeaders` is what makes it real,
and `packages/storage/src/s3.test.ts` is what caught it. Do not remove that option.

**Magic bytes are the second half, and are not redundant.** Pinning the header proves the
client said `image/png` twice, not that the bytes are a PNG. `verifyMagicBytes` is a closed
table — `image/svg+xml` and `text/html` are absent because SVG carries script and no signature
distinguishes a safe one. `text/*` has no positive signature, so its check is negative: no NUL
byte, and not markup after skipping a BOM and whitespace, exactly as a browser skips them.

**The scanner fails closed, and that is the single most important line in the slice.** An
unreachable clamd, a timeout, an unrecognized reply — all return `error`, and the service
treats it as `rejected`. Treating "we could not check" as "clean" turns an outage into a window
where unscanned files are downloadable, while uploads keep working perfectly and nothing goes
red. `attachment.service.test.ts` asserts it against a port that always refuses.

**EICAR cannot prove the scanner saw the whole file, and the obvious test that says it does is
wrong.** Measured against this container: the 68-byte string is detected, padded to 128 bytes it
is still detected, at 129 bytes it comes back CLEAN, and at offset 10 in a small file it comes
back clean too. That is the EICAR standard working as specified, not a defect — but it means
"bury EICAR in a 300 KB file and expect `infected`" fails against a perfectly healthy scanner,
and sends the next reader hunting for a chunking bug in `scanBuffer` that is not there.

So the INSTREAM framing is asserted against a stand-in clamd in `virus-scan.test.ts` that decodes
the 4-byte length prefixes and reports the bytes back. A real clamd only ever answers with a
verdict, so it cannot tell you what it received — a scanner sent half a file replies `OK` exactly
like one sent all of it, which is a fail-OPEN outcome behind a green test. The payload is a
repeating non-uniform pattern so a duplicated chunk fails on CONTENT, not just on length.

**Confirm is a conditional claim, not a check-then-write.** `claimForScanning` puts
`status = 'pending'` in its WHERE. Without it two racing confirms both scan and both write a
verdict — including overwriting `infected` with `clean`. It lives outside `*.service.ts` for
the same reason as `rebalance.ts`: guardrail 11's scope means repositories mutate by design,
and the event belongs to the verdict.

**Storage keys are server-generated and nothing from a client reaches them.** The filename
lives in the database and is applied on download via `Content-Disposition`; a name in the key
would need path escaping, which is the traversal this design removes rather than mitigates.

### Phase 3 — card detail

**Two authorization questions, deliberately not merged.** Managing the project's VOCABULARY —
the label set, custom field definitions — is `project:update`, because it changes every card.
Filling one in is `card:update`, because it changes one card. Collapsing them would either stop
members tagging their own work or let them rewrite the project's labels from a card panel.

**Comments are `comment:create`, never `card:update`.** That separation is the entire reason
the `commenter` relation exists (§8.2): someone can be given a voice on a board without edit
rights. Editing is author-only with no permission override — a discussion where an
administrator can put words in your mouth is not a record of anything — while deleting is
author-or-moderator, and the event records which.

**Counters are recomputed, never incremented.** `recountChecklist` and `recountComments` in
`counters.ts` run a SELECT inside the writing transaction. An increment is cheaper and drifts:
deleting a DONE item must decrement two counters and a not-done item only one, and a branch
that is wrong produces a number nothing ever corrects. A wrong badge looks exactly like a
correct one.

**Cross-project children are unwritable, not merely unwritten.** `card_labels` and
`custom_field_values` carry `project_id` and reference BOTH the card and the definition on it.
A label from another project is refused by the database, so the services do no lookup that
could be forgotten. Custom field TYPES are immutable for a related reason: there is no honest
migration from `select` to `number`.

### Phase 3 — the filter AST (§10.2)

`packages/filter`. Ships now; the TQL text parser is Phase 8 and produces the same tree.

**`fields.ts` IS the security control.** A field name is a key into a map of literals, an
operator is a key into a fixed token table, and every value is a `$n` placeholder. The compiler
re-validates rather than trusting its caller and throws on an unknown field — because "the
caller validated it" is an assumption that holds until someone adds a second call site.

**The compiler and the evaluator must agree, and do not by default.** SQL is three-valued
(`NULL = 5` is UNKNOWN, so a null due date matches neither `due < x` nor its negation),
`ILIKE` is case-insensitive where `includes` is not, and Postgres compares timestamps as
instants where JavaScript compares ISO strings as text. Each is handled explicitly, and
`apps/api/src/work/filter.parity.test.ts` runs both backends over the same rows in real
Postgres. A disagreement means a Phase 10 automation fires on cards the Phase 3 board would not
have shown, and nothing fails.

**`@me` stays symbolic until compile time.** The client substituting its own id would make a
SHARED saved filter mean "assigned to whoever saved it". Validation and compilation reject the
same trees — checking `@me` only in the uuid branch let `title = @me` validate and then throw,
which is a chip the builder renders as valid and that explodes on apply.

**`compiledPredicate` in `packages/db/expressions.ts` is the bridge**, and it is where the raw
SQL ban is answered rather than widened: it copies only the literal segments between
placeholders, so it cannot emit a value into SQL text even if handed one.

### Phase 3 so far — the Work spine, and the parts that are easy to break

**A rank is `<integer><fraction>`, not a fraction.** `packages/contracts/rank.ts`. The obvious
implementation — treat the string as digits after `0.` and bisect — is correct and unusable:
bisecting toward an endpoint adds a digit every ~6 insertions, so the 10,000th card appended to a
list gets a rank about 1,600 characters long. Appending is not an adversarial case. So the integer
part is incremented instead, and sequential insertion at either end grows the rank as log₆₂(n) —
four characters at ten thousand cards. The head character encodes sign **and** length so a rank
splits with no separator, and the whole scheme rests on `0-9 < A-Z < a-z` in ASCII. The test
asserting 10,000 appends stay ≤ 4 characters is what rules out the naive version; don't relax it.

**The hierarchy is enforced by composite foreign keys, not by the services.** A card carries
`project_id`, `board_id` and `list_id` denormalized, and references all four columns against a
unique index on `lists` that already includes its own ancestors. This catches something RLS
cannot: `withOrgScope` stops a card being written into another **tenant**, and does nothing about
a card written into another **board of the same tenant** — an ordinary authorization bug where the
caller holds `card:create` on the board they named and nothing on the board they reached. Drizzle's
`references()` is single-column and cannot express any of it, so `packages/db/src/schema/work.ts`
shows the weaker half of the truth. The migration is the source.

**There is no `list` resource type, deliberately.** A list is not independently grantable — nobody
shares one column of a board — so every list-level authorization check names the **board** as its
resource. Adding `'list'` to `RESOURCE_TYPES` would add a tuple level no product surface can
create a grant on, and would need a migration to widen the `object_type` CHECK. The audit
projection maps `list.*` events to `board` for the same reason.

**`move` takes neighbours and derives the rank server-side.** No `position`, no `rank` field, on
either `cards.move` or `lists.reorder`. A client-computed rank is computed from a board read some
time ago, so two people dragging at once each place a card according to a different past. A
neighbour that is not in the target list is a **404**, not a nearest-guess — that is how a drag
silently lands in the wrong column.

**A degenerate list is repaired by the move that discovers it.** Equal ranks are a legal outcome
of concurrency, and `between` refuses them. `moveCard` catches `InvalidRankError` **specifically**
— a NOT_FOUND from a stale neighbour is rethrown, because rebalancing would not fix it and would
rewrite a whole column for a client error. The repair emits `list.rebalanced` alongside
`card.moved`; without that event every open board keeps stale ranks for the column and silently
desynchronizes. `rebalance.ts` is deliberately **not** a `*.service.ts` file: it mutates many rows
and emits nothing, which is what the guardrail-11 scope means by "repositories mutate by design".
The event belongs to the operation the user performed.

**Card numbers come from a counter on the project row.** `WEB-142` must be gapless and
per-project; a Postgres sequence is neither. `projects.next_card_number` is incremented by
`UPDATE ... RETURNING` inside the card's own transaction, which takes a row lock and serializes
card creation within one project — accepted knowingly. `RETURNING` gives the value **after** the
increment, so the card's number is one less; that off-by-one is invisible except in the test
asserting the first card is `WEB-1`.

**Rich text is validated against a closed list, not a shape.** `work/richtext.ts`. "TipTap JSON,
never HTML" removes the markup column and therefore the obvious XSS. It does not remove the second
one: TipTap renders a node by looking its type up in an extension map, and `link.href` turns an
attribute into a URL — `javascript:` there is script execution reached entirely through valid
JSON. Node types, mark types, per-node attributes and URL schemes are all whitelisted, and an
unknown node is **rejected rather than sanitized away**. The node budget is enforced after Zod has
parsed the tree, so the Fastify body limit is what bounds the input first.

**Guardrail 8 now seeds a full Work hierarchy.** `resourceIds` in the fuzz seed widened from
`Record<string, string>` to `Record<string, unknown>` because `cards.assign` takes an array and
`cards.update` a numeric `version` — with strings only, both routes reject the bag on shape and
answer BAD_REQUEST, which the harness counts as a refusal. They would have passed without the
tenant boundary ever being consulted. `tenancy-fuzz.test.ts` names the 14 Work mutations
explicitly, so a route dropping to `not-applicable` fails a test instead of quietly losing
coverage.

**WIP limits are advisory.** `moveCard` reports the breach and completes the move. Blocking
someone from recording work that is already in progress makes people stop using the board, not
stop the work.

### Phase 2 — what changed, and the parts that are easy to break

**A token still proves _who_; a header now selects _which tenant_.** `principal.org` is populated
by `resolveOrgMembership` from an `x-taskflow-org` header. That header is attacker-controlled and
is treated as such: it is a WHERE filter, never a value written to `app.org_id`. The lookup runs
in `withUserScope(verifiedUserId)`, and the ROLE comes from the membership row it returns. Naming
an org you are not in resolves to null, and every `route({ permission })` answers NOT_A_MEMBER.
The role is read per request rather than carried in the token so a demotion takes effect
immediately instead of when the token expires.

**A third session variable, `app.user_id`, and `withUserScope`.** It exists for one question the
org switcher must answer before an org is selected: "which orgs am I in?" Only two policies
consult it — `memberships_self_read` and `orgs_self_read` — and **both are `FOR SELECT` with no
`WITH CHECK`**. That is the whole safety argument: a permissive `WITH CHECK` on `user_id` would
let any authenticated caller insert a membership naming themselves in any org, as owner. Because
permissive policies are OR'ed, `withOrgScope` and `withUserScope` each set _both_ variables, so
neither can be inherited across a pooled connection.

**`identity.orgs` filters on `id`, not `org_id`** — the tenant is the row. Creating one needs no
privileged path: ids are app-generated UUIDv7, so the service mints the id, opens
`withOrgScope(newOrgId)`, and writes the org plus its owner membership in that one transaction.

**The audit log is append-only by GRANT, not by convention.** `taskflow_audit` holds INSERT and
SELECT and no UPDATE or DELETE anywhere; the app role holds SELECT only. `seq`, `prev_hash` and
`hash` are assigned by a Postgres trigger under a per-org chain-head lock, so a writer cannot
choose its own position or digest. The hash covers a **length-prefixed** concatenation — not
`jsonb_build_object(...)::text` — because the verifier in `@taskflow/security/audit-chain.ts`
would otherwise have to reproduce Postgres's jsonb rendering, and drift there reports tampering
on untouched rows. `packages/db/src/audit.test.ts` asserts the two agree against real Postgres.
**The verification SELECT list in `packages/db/src/audit-log.ts` is part of that contract.**

**So is its ORDER BY, and it must stay qualified.** `seq::text AS seq` introduces an output column
named `seq`, and Postgres resolves a bare `ORDER BY seq` to that ALIAS in preference to the
underlying bigint. Rows then arrive in text order — 1, 10, 11, 12, 2, 3 — and the verifier, which
checks each entry follows the last, reported `sequence_gap` and `broken_link` on a chain nobody
had touched. Every organization with ten or more entries failed its own integrity check. An
integrity check that cries wolf on healthy data is not a weaker control but a negative one: the
first response to a real detection becomes "the verifier is wrong again". Both readers now say
`ORDER BY audit_log.seq`, and the tests seed twelve entries — below ten, text and numeric order
agree and the bug is invisible, which is exactly how it survived every existing test.

**`occurredAt` was a cast, not a conversion.** Drizzle's raw `tx.execute` applies no driver type
parsers, so every column arrives as the text Postgres rendered; `record['occurred_at'] as Date`
was believed by TypeScript and by the service, and refused by the route's own `z.date()` output
schema. `tenancy.audit.list` answered INTERNAL_ERROR for every non-empty page and had never
returned a row. The service tests could not see it because they call the service directly, where
the cast is simply believed — it took a test that goes through the route.

**Guardrail 8 now needs Docker.** The fuzz harness previously ran with no database because no
registered route touched storage. Every tenancy route opens `withOrgScope`, so it now seeds two
real tenants and calls each route as org A's owner holding org B's ids. Routes that accept **no
input** are reported `not-applicable` rather than passing — there is no id to substitute — and
that is derived from the manifest, so a route gaining an input is re-enrolled automatically.

**Role comparisons in membership code live in `packages/policy/src/assignment.ts`**
(`isIndispensableRole`, `isDirectlyAssignable`, `sameRole`). Guardrail 7 is deliberately blunt
about `role ===`; the answer is to move the decision where the matrix test can see it, never to
disable the rule.

**The outbox relay runs on a timer inside the API** (`tenancy/relay.ts`) and belongs in
`apps/worker` on pg-boss from Phase 4. It is safe in every instance — `FOR UPDATE SKIP LOCKED`,
and claim/write/mark are one transaction, which makes the audit projection exactly-once. Later
consumers get at-least-once and must be idempotent.

Deferred deliberately: email invitations (`members.add` requires an existing account — _shipped
later, see "Email invitations" below_), and the permission debug **page** — the
`tenancy.authz.explain` endpoint ships now, its UI with `apps/web`.

### Phase 1 — identity

Password auth end to end (Argon2id + HIBP, email verification, lockout, refresh rotation with
reuse detection, session revocation, password reset), **passkeys** as the primary factor,
real SMTP delivery, and per-IP rate limiting at the gateway.

Two things about the shape of this slice are worth knowing before changing it:

**A token proves _who_, not _which tenant_.** `authenticate()` produces an
`AuthenticatedPrincipal` — user, session, credential-proof time — and it carries no role. Phase 2
fills `principal.org` from a membership read keyed by the `x-taskflow-org` header (see above);
`authenticate()` itself still returns `org: null` and consults no database, which is what keeps
it off the hot path. Deriving a role from a token claim would mean the caller's own credential
asserted their role, and a demotion would not take effect until the token expired.

**Passkey sign-in takes no identifier.** Credentials are discoverable
(`residentKey: 'required'`), so the ceremony never asks who you are — which is the one flow
here that cannot be used to enumerate accounts by construction rather than by careful
answering. Do not add `allowCredentials`.

What is enforced, and by what:

| Guardrail            | Mechanism                                | Proven by                             |
| -------------------- | ---------------------------------------- | ------------------------------------- |
| 1 branded ids        | `packages/contracts`                     | type-level tests                      |
| 2 no raw DB access   | ESLint import ban                        | guardrail-selftest                    |
| 3 RLS                | Postgres policies                        | `packages/db` tests, real Postgres    |
| 4 fail-closed routes | `route({ permission })` + boot assertion | `apps/api` guardrail tests            |
| 5 generated client   | tRPC + `Wire<T>` at the browser boundary | compile, `apps/web` wire tests        |
| 6 Zod at boundaries  | `.strict()` schemas                      | per-package tests                     |
| 7 banned constructs  | ESLint                                   | guardrail-selftest                    |
| 8 tenancy fuzz       | manifest-driven harness, two real orgs   | `apps/api/src/testing`, real Postgres |
| 9 authz matrix       | 235 role × permission assertions         | `packages/policy`                     |
| 10 human review      | this file, PLAN.md §2.2                  | people                                |
| 11 domain events     | custom ESLint rule                       | guardrail-selftest                    |
| 12 migration RLS     | `scripts/check-migration-rls.mjs`        | both directions, against a fixture    |

`node packages/guardrail-selftest/verify.js` proves the lint-enforced ones still fire — including
the negative cases, since a rule that reports correct code is one that gets switched off. It also
asserts ESLint's COMPUTED config for `apps/web`, because that is where the bans are most likely to
be lost without anything failing: a React block that grew its own `no-restricted-syntax` would
replace the whole list, disarming the XSS ban in the one app that renders.

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
