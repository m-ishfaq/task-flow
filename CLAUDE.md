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
apps/       api                              (arriving: collab, worker)
              src/identity   ⚠ auth, tokens, sessions, passkeys
              src/tenancy      orgs, memberships, teams, grants, audit projection
              src/work         projects, boards, lists, cards, ranking, rich text,
                               labels, checklists, custom fields, comments,
                               ⚠ attachments, filter wiring
            realtime           Socket.io gateway — broadcast only, never writes
              src/auth.ts    ⚠ handshake: token, origin, socket.data.identity
              src/rooms.ts   ⚠ room join = a fresh can() check
              src/relay.ts     the 'realtime' outbox consumer
            web                React 19 + Vite
              src/lib          tRPC client, session, query client, wire types
              src/components   primitives + app shell
              src/features     auth/ org/ work/ admin/
packages/   config, contracts, db, security, policy, events, mail, observability,
            feature-flags, guardrail-selftest, ⚠ storage, filter   (arriving: ui)
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

**Read a spec's own status header before trusting a phase marker anywhere else.** The §13 roadmap
table and this section were both stale for the whole of Phase 3.5's Wave 1 and Wave 2, which is how
an agent asked to find "what's next" confidently answered Phase 4 while Wave 3 was still open. The
same staleness recurred at the end of 3.5. If you are reading this to decide what to build, open the
newest `ai/phase-*.md` and read its header first.

Deferred deliberately from Phase 3, and NOT bugs: passkey sign-in is wired on the API but the
browser ceremony (`@simplewebauthn/browser`) is not in this build, so the login page says so
rather than showing a button that does nothing. Calendar and timeline views are §10.4 surfaces
the plan does not schedule until later. `packages/ui` is still unbuilt on purpose — §6 says
extract a component only once the same pattern appears three times, and `components/primitives.tsx`
is where that will be measured from.

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

Deferred deliberately: email invitations (`members.add` requires an existing account), and the
permission debug **page** — the `tenancy.authz.explain` endpoint ships now, its UI with `apps/web`.

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
