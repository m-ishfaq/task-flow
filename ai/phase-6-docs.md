# Phase 6 — Docs

**Status: APPROVED 2026-08-06; Wave 1 and Wave 2 SHIPPED same day.** §3 stands as written.
Of the six open questions in §7: §7.2 and §7.6 were decided on approval (Wave 1's migration and
process layout depended on them); §7.4 was settled at the start of Wave 2 by reading the installed
`@hocuspocus/server`'s own protocol handling (read-only IS server-enforced); §7.3 was decided at the
same point (strip disallowed content silently, from the live `Y.Doc`, not just the snapshot). All
four are recorded in place with their reasoning. §7.1 (whether the tree resolver generalizes) and
§7.5 (trash semantics) remain open, deferred as originally scoped — neither blocks Wave 2. Phase 4's
Wave 1 + Wave 2 acceptance criteria are met on `main` — Docs' one write-exception socket server is a
second, harder version of the room-authorization problem Phase 4 solved once.

**Two bugs Wave 2's own unit suites could not have caught, found only once a real end-to-end test
drove a real `apps/collab` gateway with the real `@hocuspocus/provider` client.** Every other Wave 2
suite — `persist.test.ts`, `replay.test.ts`, `compaction.test.ts` — calls its function directly; none
of them go through `onAuthenticate` as the framework actually invokes it, or through two independent
`apps/collab` processes. `gateway.integration.test.ts` does both, and found:

1. **`gateway.ts`'s `onAuthenticate` set `data.context = {...}`, and every connection's context was
   silently empty.** `@hocuspocus/server`'s `hooks()` runner builds a FRESH object — `{ ...hookPayload,
   ... }` — for every hook call; assigning `data.context` replaces a property on that throwaway copy,
   never the real `hookPayload.context` the rest of the pipeline reads. The framework only threads
   context forward through the hook's RETURN value (`onAuthenticate?(data): Promise<any>` — the `any`
   is exactly this). `data.connectionConfig.readOnly = ...` on the same line worked, and masked the
   bug: `connectionConfig` is a nested object copied by REFERENCE, so mutating a property on it does
   reach the original. Authentication itself succeeded (`scope: 'read-write'`) in every test run,
   because it doesn't consult context — only `onLoadDocument` and `beforeHandleMessage` do, and both
   received `{}`, so `withOrgScope(undefined, ...)` failed on literally the first real connection any
   test attempted. `data.context = {...}` is now `return {...}`; the file header explains why.

2. **`restorePageVersion` appended the restored state as a new WAL row, and a page edited after its
   save point did not actually revert.** The reasoning — "a full encoded Yjs state is a valid
   `Y.applyUpdate` input, so it converges correctly" — is true and irrelevant: Yjs updates are
   additive CRDT operations, never subtractive, so re-applying an old state MERGES its own operations
   back in (a no-op, since they're already known) without touching whatever was inserted afterward. A
   page saved as "original content", edited further, then "restored", came back as the union of both,
   not the restored text alone — caught because the integration test edits through a real live
   session and reads back through a real second gateway process, where `packages/db`'s per-transaction
   `now()` (same timestamp for a WAL row and the snapshot written right after it in the original,
   buggy code) had been quietly hiding the same defect from `page-version.service.test.ts`'s original
   assertions, which read the snapshot row directly rather than through `materializeCurrentState`. The
   fix writes ONLY a new `page_versions` snapshot — sufficient on its own, since both
   `materializeCurrentState` and `replayPage` always start from the latest snapshot and never look
   further back. `page-version.service.ts`'s file header and `page-version.service.test.ts` both
   record the corrected reasoning and a regression test that reads back through the real
   materialization path rather than decoding the snapshot row directly.

Neither bug had a failing unit test before this. Both are the kind CLAUDE.md's Phase 5 status header
already warned about: "a green `pnpm verify` is not the same claim as 'this works when you click it.'"

**Where the draft turned out to be wrong**, checked against `apps/realtime`'s actual code rather
than left as the draft's paraphrase of it: §3.3 said `onAuthenticate` calls `apps/api`'s
`authenticate()` — it calls `verifyAccessToken` directly, same as `apps/realtime/src/auth.ts`
does, because `authenticate()` expects an HTTP header a socket handshake doesn't carry. §6.1 said
`taskflow_collab` arrives with Wave 1's first migration — `apps/realtime`'s own dedicated role
holds no tenant-table grant at all and exists solely for outbox consumption, so Wave 1's read-only
`onAuthenticate` hook uses the ordinary `taskflow_app` connection via `withOrgScope`, identical to
`rooms.ts`; `taskflow_collab` is deferred to Wave 2, where `apps/collab` first needs to WRITE.

Parent: [PLAN.md](../PLAN.md) §3.3 (Docs), §7.2 (`docs.yjs_updates` / `docs.page_versions`), §9
(Real-Time Architecture — the CRDT write exception), §10.6 (Domain events), §13 (Roadmap).
Sibling: [phase-4-realtime.md](phase-4-realtime.md) (room authorization, the pattern this phase's
`apps/collab` auth hook reuses under a harder trust model) and
[phase-5-chat.md](phase-5-chat.md) (built the same weeks as this one — §8 below is explicit that
neither phase's Wave 1 depends on the other). Slice procedure:
[feature-template.md](feature-template.md).

**Phase 6 and Phase 5 are running concurrently, on separate branches, by design.** PLAN.md §13's
sequencing constraints say so directly: "Phases 5, 6, and 7 are independent of each other and can
be reordered by interest or urgency." Both depend only on Phase 4's gateway, which is already
merged to `main`; neither depends on the other's tables, events, or UI. The one place they could
collide is `packages/events`' shared registry file and `packages/policy`'s shared action union —
both phases add entries to files the other phase also touches, so the real integration risk is a
merge conflict at PR time, not a design coupling. See §6.5.

---

## 1. Why this phase exists

PLAN.md §3.3 describes Docs as spaces containing nested page trees, real-time collaborative
editing via Yjs CRDT, inline comments and suggestions, version history with restore, templates,
permissions inheriting down the tree, publish-to-public, PDF export, and backlinks. Unlike Chat
(Phase 5), which is almost entirely Work's existing patterns re-applied to a different table
shape, Docs contains the one deliberate architectural exception in the whole system: CLAUDE.md
rule 8 says "sockets broadcast; they never write," and immediately carves out "Docs/Yjs is the
one documented exception." This phase is where that exception becomes real code instead of a
sentence in a planning doc, which is why §3 below spends most of its length on containing the
exception rather than on the product surface around it.

The product surface — page trees, comments, versions, publish — is not new engineering territory;
Work already proved rich-text validation (Phase 3, `work/richtext.ts`), hierarchical composite
foreign keys (Work's project → board → list → card chain), and permission inheritance concepts
(relationship tuples, PLAN.md §8.2). What is new is that the write path for page **content**
specifically bypasses the "mutations go through the API" rule that every other product surface in
this codebase depends on for its security argument, because CRDT convergence requires it. Every
structural decision in §3 exists to answer the same question: given that one exception, what is
the smallest, most contained way to grant it, and what stays on the normal path regardless.

## 2. What's in scope, and what is deliberately not

**In scope:** spaces, nested page trees, real-time collaborative editing (Yjs/Hocuspocus), inline
comments, suggestions (tracked-change-style proposed edits), version history with restore,
templates, permissions inheriting down the tree, publish-to-public, PDF export, backlinks, trash
/ soft delete.

**Out of scope, on purpose:**

- **A second occurrence of the socket-gateway problem.** `apps/collab` is a new, separate,
  minimal process (§3.2) — it does not fold Yjs sync into `apps/realtime`, and it does not grow
  into a general-purpose second API. Its entire job is CRDT sync plus the one auth hook gating it.
  Anything that isn't "keep the document converged and authorize who may touch it" (page tree
  mutations, permission grants, comments, versions, publish) is an ordinary tRPC route on
  `apps/api`, exactly like Work and Chat.
- **Full-text search over page content.** PLAN.md §10.2's TQL AST already models `type IN (page,
message)` as a target shape; cross-product indexing is Phase 8/11's job. This phase emits
  `page.updated` as a real, typed, outbox-carried event for Phase 8 to index later — it does not
  build the index.
- **Automation triggers on doc events** ("page published in this space" — PLAN.md §10.3). Same
  relationship as Phase 5 §2 describes for chat events: this phase's job is to make sure
  `page.published` etc. are real outbox events, not to consume them.
- **A general hierarchical-resource primitive in `packages/policy`.** §3.4 below needs "nearest
  ancestor with an explicit grant" resolution for the page tree. Whether that becomes a reusable
  mechanism other hierarchical resources (nested spaces, future nested boards) can share, or stays
  Docs-specific, is **not decided by this phase** — see §7.1. Building the general version on
  spec, before a second caller exists, repeats the mistake `packages/ui` was deliberately built
  around avoiding (PLAN.md §16: "extract a component only once the same pattern appears three
  times").
- **HIPAA-grade legal hold / litigation tracking**, for the same reason Phase 5 §2 excludes it:
  PLAN.md §16's open compliance question is unresolved and out of scope here too. "Version history
  with restore" is a product feature, not a custodian-tracked evidentiary hold.
- **Real-time co-editing of anything other than page body content.** Titles, tree position,
  permission grants, and publish state are NOT Yjs fields — see §3.1. Two people renaming the same
  page at once is a last-write-wins ordinary update, exactly like two people renaming the same
  board in Work today; it does not need CRDT convergence because it isn't concurrent free-text
  editing.

## 3. Structural decisions

### 3.1 The CRDT is the write model for page BODY content only — nothing else

PLAN.md §9's table is precise about what Hocuspocus carries: "Yjs CRDT updates, awareness cursors"
— not page metadata. A `docs.pages` row has `title`, `parent_page_id`, `space_id`, `position`,
`archived_at`, `published_at`, and permission grants sit in `authz.relationship_tuples` exactly
like Work's do. All of that goes through `apps/api`, `withOrgScope`, `can()`, and emits domain
events — the entire normal pipeline, completely unchanged from Work and Chat. **Only the page's
rich-text body is a Yjs document**, stored as an update log (§3.7) rather than a single JSON
column.

This is a narrower exception than "Docs writes through sockets" might suggest, and keeping it
narrow is the point: every place this codebase reasons about tenancy, authorization, and audit for
_structural_ changes to a page (move it, delete it, publish it, grant access to it) stays on the
exact same rails as everything else. The exception is contained to the one thing that genuinely
cannot go through a request/response API and stay correct under concurrent editing: the live text
itself.

### 3.2 `apps/collab` is a separate app, not a namespace on `apps/realtime`

Phase 5 §3.2 puts Chat delivery on the _same_ `apps/realtime` process, as a second Socket.io
namespace, specifically because Chat's sockets still broadcast-only — reusing the handshake and
room-authorization machinery costs nothing and duplicates no trust boundary. Docs is the opposite
case. `apps/collab` (Hocuspocus / y-websocket) is the one process in the whole system allowed to
persist a write from inside a socket handler, and CLAUDE.md rule 8 is unconditional for
`apps/realtime`: "Sockets broadcast; they never write." Putting Hocuspocus inside that process
would make the rule false for the whole app rather than true of all of it except one clearly
labeled exception. Keeping `apps/collab` a small, separate, single-purpose service means:

- A bug in `apps/realtime`'s socket handling still cannot write anything, by construction — the
  blast radius of a Work- or Chat-side defect is unchanged by Docs existing.
- The one process that _can_ write from a socket is minimal enough to review as a whole. Its only
  job is CRDT sync plus the auth hook in §3.3 — there is no unrelated feature code in the same
  process for a reviewer to lose the write-exception in.
- Operationally this is a new deployable and a new thing to monitor (§7.2 raises whether that's
  worth confirming explicitly given PLAN.md §15's "component sprawl = attack surface" risk line),
  but it is still one more Node process on the same Oracle free-tier VM, not a new paid service —
  consistent with §14's "$0 through Phase 6."

### 3.3 The `onAuthenticate` hook is Phase 4's room-join lesson, under a harder trust model — and a human-review surface

Phase 4's core lesson (`ai/phase-4-realtime.md`, and CLAUDE.md's own "there is nowhere in the
protocol to assert an identity" note) is that a socket's identity is set exactly once, at the
handshake, from a verified token, and every subsequent decision reads from there — never from a
client-asserted field. Hocuspocus's `onAuthenticate(data)` hook is that same handshake moment: it
receives the requested document name and a token, and must (1) verify the token through the exact
same primitive `apps/realtime/src/auth.ts` already uses for its own handshake — `verifyAccessToken`
from `@taskflow/security`, not a second crypto path — and (2) resolve `page:read` or `page:update`
through `can()` before the connection is allowed to sync at all.

**Correction on approval:** the draft originally said this hook calls `apps/api`'s `authenticate()`
directly. `apps/realtime/src/auth.ts` was checked against that claim and does not do that —
`authenticate()` expects an `Authorization: Bearer <token>` header string, which a socket handshake
does not carry, so the gateway calls `verifyAccessToken` on the raw token instead and builds its own
`SocketIdentity`. `apps/collab`'s hook follows the actual precedent, not the draft's paraphrase of
it: same underlying verification primitive as every other entry point, reached through the same
shape `apps/realtime` already uses, not literally the same function signature. The document
name is client-supplied (it has to be — the client is asking to open a specific page) and is
treated exactly like the `x-taskflow-org` header and Phase 4's join-request board id: a lookup key
into an authorization check, never a value trusted on its own. Naming a page you have no grant on
must refuse the connection outright, not degrade it to a read-only or empty document — the same
"refused rather than silently downgraded" principle Phase 4 §3.8 established for origin checking.

This is a harder version of Phase 4's problem for one reason Phase 4 didn't have: **the
authorization check here has to resolve tree inheritance first** (§3.4) before it can even ask
`can()` a yes/no question, because the answer depends on walking up to the nearest ancestor grant.
A room-join in Phase 4 checks one flat resource (a board); a page-open in Phase 6 checks a
resolved-from-the-tree resource. Getting that resolution step wrong is not a UX bug — it is a
tenant or permission bypass exactly as serious as anything on Phase 4's `auth.ts`/`rooms.ts`, which
is why `apps/collab`'s auth hook belongs on CLAUDE.md's human-review-surfaces list the moment it
exists (see §6.2), the same way `apps/realtime/src/auth.ts` and `rooms.ts` are on it today.

**Read-only grants map to Hocuspocus's read-only connection mode** — a viewer-relation tuple or a
Guest granted only `page:read` gets a connection that receives sync/awareness updates but has
writes rejected server-side. Whether Hocuspocus's read-only mode is a _server-enforced_ rejection
of persisted writes, versus merely a client-side hint that a determined client could still send
updates past, is not assumed here — §7.4 flags it as needing verification against the library's
actual behavior before Wave 1 ships anything relying on it. If the library's guarantee turns out
to be advisory only, the enforcement has to happen server-side in the same hook regardless (drop
updates from a connection the hook marked read-only), which is buildable either way — the open
question is only which of those two is true today, not whether the safety net exists.

### 3.4 Permissions inherit down the tree by resolving at read/connect time, never by copying grants onto descendants

A page can carry an explicit permission grant (a relationship tuple, same table Work's board
grants live in); most pages don't, and inherit from the nearest ancestor that does, falling back
to the space's default role matrix if no ancestor has one. The one decision this phase cannot get
wrong: **grants are resolved by walking the tree at check time, never materialized onto every
descendant row when the grant is created.** The tempting alternative — copy the grant onto every
page under the subtree at grant time, so a lookup is a flat row read — creates the exact hazard
Work's rank-rebalancing already taught this codebase to watch for: moving a page to a new parent
would then require rewriting every descendant's copied grant as a fan-out operation across a
subtree that could be arbitrarily large, and a single row missed in that rewrite is a silent
privilege bug (a page still carrying its old grant after being moved somewhere the grantor no
longer has authority over) that nothing detects until someone notices they can see something they
shouldn't, or can't see something they should.

Resolution instead walks from the target page up to the nearest tuple, using a materialized path
column (§3.5) so the walk is an indexed prefix match, not a recursive query on every single
`page:read` check — this matters more here than it did for Work's flat board-level checks,
because every keystroke's `onAuthenticate` and every page-tree render depends on it.

### 3.5 The tree is a materialized path column, denormalized like Work's hierarchy, not a bare parent pointer

Work's lesson (Phase 3, CLAUDE.md's own note): "the hierarchy is enforced by composite foreign
keys, not by the services... RLS stops a card being written into another tenant, and does nothing
about a card written into another board of the same tenant." Docs' tree needs the same
denormalization discipline. Every `docs.pages` row carries `space_id` directly (never inferred by
walking `parent_page_id`), so RLS and org-scoping always have a flat column to index and check
regardless of tree depth. On top of that, a materialized path (an array of ancestor page ids, in
order — see §7.2 for the array-vs-`ltree` call) makes both "give me this whole subtree" and "find
the nearest ancestor with a grant" (§3.4) indexed prefix operations instead of recursive CTEs run
on every read.

**Moving a page rewrites its own path and every descendant's path in one transaction** — the same
kind of bounded-but-nontrivial repair operation Work's `rebalance.ts` performs on a degenerate
list, and for the same reason it's acceptable: it's rare (an explicit user action), bounded (one
subtree, one transaction), and the alternative (deriving the path live from `parent_page_id` on
every read) is the recursive-query cost this column exists to avoid. The migration — not the
service — is the source of truth for the constraint that a page's `space_id` must match its
parent's, mirroring exactly how Work's composite foreign keys are stated in the migration and only
weakly represented in Drizzle's single-column `references()`.

### 3.6 Comments and suggestions anchor into the document via Yjs relative positions, not a second coordinate system

Comments and suggestions are relational data — they need `comment:create`/`comment:resolve`-style
permissions distinct from `page:update`, matching Work's card-detail precedent exactly (CLAUDE.md:
"Comments are `comment:create`, never `card:update`... someone can be given a voice ... without
edit rights"; editing is author-only, deleting is author-or-moderator). What's new here is that a
comment has to stay attached to a _range of text inside a document that keeps changing underneath
it_. Storing a plain character offset would detach the comment from its text the moment anyone
edits anything before that offset. Yjs's own `RelativePosition` API exists specifically to survive
concurrent edits before or after an anchor; a comment or suggestion stores a serialized relative
position (resolved against the live Yjs doc when rendered), not a byte offset or a copy of the
anchored text.

This is flagged as the single trickiest correctness point in the phase deliberately: getting it
wrong doesn't error, doesn't fail a test written against the wrong mental model, and doesn't show
up until a real editing session drifts a comment onto the wrong sentence — the same category of
"silent, invisible until someone notices" failure this codebase has hit before (rank drift, the
`neighbours.ts` self-drop bug, the label filter's two wrong-but-different answers). A test suite
for this phase needs to prove a comment's anchor survives a concurrent edit landing before it, not
just that the comment round-trips when nothing else changes.

### 3.7 Three independent recovery paths, per PLAN.md §7.2 — and what triggers each

- **`docs.yjs_updates`** — an append-only log of every incremental Yjs update, written durably
  before acknowledgment. This is the document's write-ahead log: every recovery path other than
  "trust live memory" replays from here.
- **Periodic compaction**, run by `apps/worker` (CLAUDE.md's layout already lists `worker` as
  "arriving" alongside `collab`): merges a run of updates into a fresh compacted state, and prunes
  the raw log behind that point — never past the last snapshot boundary, so there is always a
  replayable tail. This is the same relationship Postgres's own WAL has to its checkpoints, and
  for the same reason: an unbounded update log is both a storage and a cold-start-replay cost.
- **`docs.page_versions`** — explicit, human-meaningful save points (autosave on an interval,
  always on publish, and on-demand "save a version"): a full materialized snapshot independent of
  the compaction worker's internal cadence, so "restore to this version" is a single row read, not
  a replay computed at restore time.

Three, not two, because live CRDT state is the thing most likely to be transiently wrong: a buggy
or malicious client can still send a structurally-valid-but-semantically-bad update (§3.8), and if
live state is ever suspect, the update log gives exact replay to any point while `page_versions`
gives a human-chosen point that doesn't require reasoning about exactly which raw updates to
replay. PLAN.md §15 already carries "Yjs persistence loss" as a named Medium risk with this exact
three-path mitigation — this phase is where that mitigation gets built, not re-argued.

### 3.8 Content is still validated against the same closed whitelist as Work's rich text — but the enforcement point is necessarily different

CLAUDE.md rule 4 ("Rich text is TipTap JSON, never HTML") and Phase 3's `work/richtext.ts`
precedent (closed node/mark/attribute whitelist, `javascript:` URL rejection, unknown nodes
**rejected rather than sanitized away**) apply to Docs' content too — TipTap's Yjs collaboration
extension maps the same editor schema onto a `Y.XmlFragment`, so the underlying document shape is
identical to Work's, just CRDT-backed instead of a single JSON column.

The enforcement point cannot be identical, though, and pretending it is would be the kind of
"believed but never tested" gap this codebase has hit before (the tRPC `Date`-as-`string` lie, the
raw-`tx.execute` cast in Phase 2's audit reader). `cards.update` validates a **complete replacement
document** and accepts-or-rejects it whole. A Yjs update is a binary CRDT operation, not a document
— there is no "reject this operation" hook that can whitelist-check it mid-stream the way a Zod
schema checks a full-document replace. The realistic enforcement point is a server-side pass that
decodes the _materialized_ document (on save-boundary, matching §3.9's compaction/snapshot
cadence) and validates its shape, rejecting or stripping anything outside the whitelist at that
point — meaning a disallowed node can exist in live, uncommitted CRDT state for as long as it takes
to reach the next validation pass, which is a materially weaker guarantee than Work's "invalid
document never gets written" and needs to be named as such rather than assumed away. §7.3 asks for
the actual mechanism to be settled before Wave 2, not left as "the same as Work" by default.

### 3.9 Publish-to-public and PDF export render a specific version, never the live socket

A published page must be visible to someone with no session — Hocuspocus's whole connection model
assumes a verified token, so public rendering cannot mean "connect to the live document." Publish
creates or updates an immutable published snapshot (reusing the `page_versions` machinery from
§3.7 rather than a parallel mechanism), served over a plain HTTP route with no realtime dependency
at all. This is the same principle Work's public-facing surfaces already follow — everything
mutates through the API — applied to a read path: a public page is a cached rendering of a
specific version, not a window into a live CRDT document that could be mid-edit when the request
arrives. PDF export renders from a specific version for the identical reason: exporting a document
someone is actively typing into should not be able to capture a torn, half-applied state.

### 3.10 Backlinks are derived at the same save-boundary validation pass, never trusted from the client

An internal link (`[[Page Name]]` or an explicit link node pointing at `/docs/{pageId}`) is
indexed into a `docs.backlinks` join table by the same server-side pass that whitelists content
(§3.8) — parsing the materialized document for internal link targets and upserting, scoped by org,
recomputed on every save boundary. A client-submitted backlink list is never trusted for the same
reason a client-submitted card rank never is (Phase 3's `neighbours.ts` note): the server is the
only party that can see the actual, validated document, and a client's idea of what it links to
can drift from what the document really contains.

## 4. Event catalog for Phase 6

PLAN.md §10.6 already names the two coarsest events this phase needs: `PageUpdated · PagePublished`.
The full set this phase's outbox needs to carry:

```
SpaceCreated · SpaceArchived
PageCreated · PageMoved · PageArchived · PageRestored · PageDeleted
PageUpdated · PagePublished · PageUnpublished · PageVersionRestored
CommentCreated · CommentResolved · CommentDeleted
SuggestionCreated · SuggestionAccepted · SuggestionRejected
```

**`PageUpdated` is emitted at a debounced save boundary, never per Yjs update.** The same "one
producer, five consumers" model (§10.6) that makes Work's `card.moved` one event per drag — not
one per pixel — applies with more force here: a busy document produces a CRDT update roughly per
keystroke, and audit, notifications, search indexing, and automation cannot subscribe to that
rate without either drowning downstream consumers or requiring every one of them to independently
reinvent debouncing. The debounce boundary is the same moment §3.7's compaction/snapshot logic
already needs to exist at, so this is one save-boundary concept serving two purposes, not two
independent timers that could drift apart.

## 5. Waves

Mirroring Phase 4 and Phase 5's wave structure — each wave is independently shippable behind a
feature flag, per CLAUDE.md rule 7 and PLAN.md's "every phase from 3 onward is independently
deployable."

**Wave 1 — foundation: spaces, tree, and the collab gateway's authorization spine.**
`apps/collab` stood up with `onAuthenticate` wired to `authenticate()` + `can()` (§3.3), the
materialized-path tree (§3.5) with move/reparent, space + page CRUD through the ordinary API,
inherited-permission resolution (§3.4) with its own authz-matrix-style test suite (mirroring
guardrail 9's approach — a table of "user with grant X at ancestor Y can/cannot do Z at descendant
W," not hand-picked cases). No live content collaboration lands yet; a page has a body but only
one editor at a time is exercised by tests, proving the authorization spine before the CRDT
concurrency spine sits on top of it.

**Wave 2 — live collaborative editing, validation, and the three recovery paths.** Yjs sync over
Hocuspocus for page bodies, `docs.yjs_updates` append log, the compaction worker, `page_versions`
snapshots and restore, and §3.8's save-boundary content validation pass. This is where the
concurrency properties get proven: two clients editing the same page converge, a disconnect and
reconnect resumes from the update log correctly, a version restore round-trips.

**Wave 3 — comments, suggestions, backlinks.** Relative-position anchoring (§3.6) with a test
proving anchors survive a concurrent edit landing before them; suggestions as a variant of the
same anchoring with accept/reject state; backlink indexing (§3.10) on the save-boundary pass Wave
2 already built.

**Wave 4 — publish, PDF export, templates.** Public snapshot rendering (§3.9), PDF export off a
version rather than live state, page templates (almost certainly a `page_versions`-shaped "seed
content" concept rather than new machinery).

## 6. Cross-cutting obligations

**6.1 `apps/collab` gets its own database role when it starts WRITING — not before, and not for
its reads.** Checked against what `apps/realtime` actually does, not the draft's first guess:
`taskflow_realtime` holds no grant on any tenant table at all — 03-grants.sql's comment on it is
explicit ("the gateway resolves membership and tuples over the ORDINARY `taskflow_app` connection,
under RLS, exactly as the API does"), and `rooms.ts` calls `withOrgScope` from `@taskflow/db`
directly, the identical entry point every service uses. `taskflow_realtime` exists solely to
consume `platform.outbox` — a role scoped to the ONE thing `apps/realtime` does that the API's role
has no reason to do. The same split applies here: **Wave 1's `onAuthenticate` hook reads page and
space metadata over the ordinary `taskflow_app` connection via `withOrgScope`, identical to how
`rooms.ts` loads a board.** There is nothing in Wave 1 for a dedicated role to make safer — reads
under RLS are already scoped to the caller's org regardless of which role runs them, and standing up
`taskflow_collab` now would be "an unused credential sitting in the database ahead of the app that
uses it," the exact anti-pattern this section's own Phase 4 citation warns against.

`taskflow_collab` arrives with Wave 2's first migration instead, when `apps/collab` needs to persist
something no other role should be able to: `INSERT` on `docs.yjs_updates` and
`docs.page_versions`. That is the actual write-exception surface guardrail 8's "sockets never write"
carve-out is about, and scoping a role to exactly those two tables — nothing else, no broader tenant
access than the reads it already gets for free over `taskflow_app` — is what makes a compromised
`apps/collab` process unable to reach anything beyond the CRDT log it owns.

**6.2 `apps/collab/src/auth.ts` (or wherever the hook lives) joins CLAUDE.md's human-review
surface list the moment it's written**, alongside `apps/realtime/src/auth.ts` and `rooms.ts` — §3.3
already argues why it carries the same severity. This is a documentation update this phase owes,
not an afterthought; a surface this sensitive sitting off the reviewed list for even one PR is
the exact gap the list exists to prevent.

**6.3 Guardrail 11 (typed domain events) and guardrail 6 (Zod at boundaries) apply to every
non-CRDT mutation exactly as they do everywhere else** — space/page CRUD, comments, suggestions,
publish, all go through ordinary `*.service.ts` files under `apps/api/src/docs/`, subject to the
same lint rule as Work and Chat. Nothing about Docs having one CRDT exception loosens that for the
99% of this phase's mutations that aren't page body content.

**6.4 The permission-debug decision trace (PLAN.md §10.7, §8.2) extends to tree-resolved grants.**
A denial trace for a page needs to show which ancestor's grant (or lack of one) produced the
answer, the same way today's trace shows "tuple (user, viewer, board) overrides role" — resolving
"why can't this user see this page" is already "the most miserable part of operating a
relationship-based permission model" per §8.2's own description, and a tree adds a dimension to
get lost in without the trace naming which node in the path decided the outcome.

**6.5 Shared-file collision with Phase 5, named explicitly since both phases are in flight.**
`packages/events`' registry and `packages/policy`'s `Action` union are both edited by Chat and by
Docs concurrently. Neither phase depends on the other's additions, but both will produce a merge
conflict in the same file if their branches diverge for the length of an 8-week phase. This is a
process note, not a design one: whichever phase's PR lands second rebases past a conflict in a
literal enum/union addition, which is mechanical, not structural — flagged here only so it isn't
mistaken for a real coupling when it happens.

## 7. Open decisions — need a call before or during Wave 1/2

1. **Does the "nearest ancestor grant" resolver in §3.4 become a general `packages/policy`
   mechanism, or stay Docs-specific?** No second caller exists yet (Work's grants are flat). Build
   it scoped to Docs' tree now; revisit generalizing only if a third hierarchical resource shows
   up, per PLAN.md §16's own stated bias against building abstractions ahead of three callers.
2. **Materialized path: `ltree` extension vs. a plain `uuid[]` ancestor-array column. DECIDED on
   approval: `uuid[]`.** No extension to enable on the managed free-tier instance; the migration
   for §3.5's tree column defines an ancestor-array with a GIN index and manual prefix-match
   queries (`ancestor_ids @> ARRAY[:pageId]` for "is under," `ancestor_ids[1:n]` slicing for
   nearest-grant walk) rather than `ltree`'s native operators.
3. **The exact mechanism for §3.8's save-boundary content whitelist pass. DECIDED at Wave 2 start:
   strip silently.** The pass runs the whitelist over the materialized document at the
   compaction/snapshot boundary and, on finding a disallowed node or attribute, removes it from the
   live `Y.Doc` itself via a transaction — not merely from the snapshot being written — so the
   sanitized state is what every currently-connected client converges to as well, not just what
   gets persisted. Chosen over "reject the whole save" (would block the update log from ever
   compacting, and blocks every OTHER collaborator's legitimate concurrent edits from being
   persisted along with the one bad node) and "flag for review" (leaves the dangerous content live
   — e.g. a `javascript:` URL stays clickable — until a human notices, which is exactly the kind of
   vigilance-dependent control this codebase's whole architecture exists to avoid). Consistent with
   CLAUDE.md's own framing: guardrails fail automatically, never by relying on someone noticing a
   flag.
4. **Whether Hocuspocus's read-only connection mode is a server-enforced write rejection or an
   advisory client hint. DECIDED on Wave 2 start: server-enforced.** Read directly from the
   installed `@hocuspocus/server@4.5.0`'s `readSyncMessage` (`hocuspocus-server.esm.js`): for both
   `messageYjsUpdate` and `messageYjsSyncStep2`, a connection with `readOnly` true never reaches
   `readUpdate`/`readSyncStep2` — the branch acks `writeSyncStatus(false)` and returns without
   calling `Y.applyUpdate` at all. The update is neither applied to the shared document nor
   propagated to other connections. `apps/collab`'s Wave 1 `onAuthenticate` already sets
   `data.connectionConfig.readOnly` correctly; Wave 2 needs no additional enforcement code in the
   hook itself — the library's own protocol handling is the enforcement.
5. **Trash / soft delete semantics** — confirm this reuses Work's `deleted_at` pattern directly
   (a page moves to trash, is excluded from the tree and from search, and is purged or restorable
   for some retention window) rather than inventing a parallel mechanism.
6. **Whether `apps/collab` is worth standing up as a genuinely separate deployable now. DECIDED on
   approval: yes, in Wave 1.** §3.2's isolation argument — the write-exception stays contained to
   one small, reviewable process instead of making CLAUDE.md rule 8 false for the whole of
   `apps/realtime` — was weighed explicitly against PLAN.md §15's component-sprawl risk line and
   judged to outweigh it, on the same terms `apps/realtime` itself was approved under in Phase 4.

## 8. Sequencing and cost

Depends only on Phase 4 (Wave 1 + Wave 2, both shipped on `main`) — not on Phase 5. PLAN.md §13:
"Phases 5, 6, and 7 are independent of each other and can be reordered by interest or urgency,"
and separately, "Phase 4 must precede 5, 6, and 7 — all three depend on the realtime spine." Both
conditions are satisfied for Phase 6 to start now, concurrently with Phase 5's own Wave 1.

Estimated 8 weeks per PLAN.md §13's table, matching Chat. Budget impact: **$0**, consistent with
§14's "development through Phase 6 costs nothing but time" — Hocuspocus is self-hosted (the
`@hocuspocus/server` + `yjs` libraries, no new paid service), and `apps/collab` is an additional
process on the same Oracle Always Free compute Phase 4's gateway already runs on, not a new tier
of infrastructure spend.
