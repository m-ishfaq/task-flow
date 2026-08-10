# Phase 8 — Search & TQL

Status: **APPROVED 2026-08-10 — Wave 1 (TQL parser) SHIPPED 2026-08-10; Wave 2 (search
spine) SHIPPED 2026-08-10; Wave 3 (UI) next.** Waves 2–3 were approved in scope at the
same review, each re-reviewed when its turn comes. Written 2026-08-10 against
`pre-launch-hardening` HEAD, per `ai/pre-launch-hardening.md` Step 4 (each remaining
priority is its own multi-week phase and wants its own spec written and approved before
implementation).

Decisions taken at approval (2026-08-10): Wave 1 first then review; docs bodies titles-only in
Wave 2 with body content a named follow-up; `fast-check` added as a devDependency for the
property tests; transcripts join the `entity_type` enum in Wave 3.

### What Wave 1 shipped

The TQL text frontend in `packages/filter` — everything in §1, plus the `search` field set
and the symbolic-date plumbing the search spine will compile. `tokenize` → `parse` → the
SAME `FilterNode` the visual builder produces, with `format` for the round trip; `-7d`/
`@today` stay symbolic in the tree and resolve against an injectable clock in `compile` AND
`evaluate` (parity-tested); `@me`/booleans/null as values; bare terms desugar to
`text contains`. Security posture unchanged: the parser emits only comparisons over
`fields.ts` entries, `validate`+`compile` re-check everything, values stay parameterized
(the injection test proves it). Validated: 87 filter tests (incl. fast-check round-trip
properties over both field sets), parity suite 25/25 against real Postgres, tsc/eslint/
format/guardrail-selftest green, code review passed with four documentation-level findings
(addressed: pinned the `@me`-literal conflation and card-resource TQL strictness with tests;
documented the `contains me` quoting rule and the free-text-before-NOT corner in §1.6/§1.7).

### What Wave 2 shipped — the search spine, end to end

Everything in §2, committed as `feat(search): Phase 8 Wave 2 …` (2026-08-10):

- **Migration 0045** — `search.documents` (org-scoped projection, `(org_id,
entity_type, entity_id)` unique key for idempotent upserts, `metadata` jsonb for
  permalink + authz context) in a schema with **deliberately no `ALTER DEFAULT
PRIVILEGES`** — the 0041 lesson, every grant explicit; RLS generated per the
  template; GIN tsvector + trgm indexes over `coalesce(title,'') || ' ' ||
coalesce(body,'')` (the expression the `text` field compiles to, so a
  title-only page is findable); the `taskflow_search` claim role on the 0016
  recipe — SELECT/UPDATE on the outbox (WITH CHECK (false) on the mark policy,
  the FOR UPDATE lesson of 0016), dispatch bookkeeping pinned to
  `consumer = 'search'`, and **nothing** on `search.documents`, because indexing
  runs per event under `withOrgScope` as `taskflow_app`. The spec's §2.3
  assumption of a consumer CHECK to widen was read against the real migration
  before writing: `outbox_dispatch`'s only CHECK is
  `length(btrim(consumer)) > 0`, so no widening was needed.
- **The indexer relay** (`apps/api/src/search/indexer.relay.ts`) — the
  backlinks-relay shape: claim cross-tenant on its own `DATABASE_SEARCH_URL`
  pool (optional like `DATABASE_BACKLINKS_URL`; an instance without it serves
  requests), work per org under `withOrgScope` as the app role. Consumes the
  §2.2 event table (cards, card comments, chat messages, channels, docs pages
  incl. `page.content_updated` re-reading title only per §2.4, docs comments),
  upserting on the unique key. The relay suite (`indexer.relay.test.ts`)
  covers the full fold, redelivery idempotency, archive, delete, channel-archived
  hiding its messages, missing-parent, title-only pages, and ordering.
- **`SearchProvider` + `PostgresSearchProvider`** — the interface declared over
  the TQL-compiled AST (§2.6) so the future Meilisearch implementation
  translates the same tree; the Postgres rendering compiles against
  `search.documents`, ranks free text by `ts_rank_cd` (first term, honest
  rather than a made-up combined score), orders by explicit `ORDER BY` when
  present else rank/`updated_at`, and builds a matched-term excerpt (server
  returns text only — highlight markup is the client's job).
- **The `search.query` route** (§2.7) — TQL TEXT is the input and the SERVER
  is the only parser (`parse` + `validate('search', …)` at the boundary, the
  positioned errors flowing to the UI); `search:query` is a membership floor
  (admin + member, never guest — the matrix test updated first, per the
  template's §2 order); the real gate is per-hit `can()` against the parent
  row loaded through each resource's own loader (`loadCard`/`loadChannel`/
  `loadPage`), with a stale hit (parent gone, or RLS-erased) dropped via
  NOT_FOUND rather than 500ing the query. Bounded 50/100.
- **Backfill** — `packages/seed/src/search-backfill.cli.ts` (runnable
  `pnpm --filter @taskflow/seed search:backfill`), the §2.5 shape: scans the
  four source tables per org under `withOrgScope` and upserts documents;
  idempotent by the unique key.
- **Wiring** — `taskflow_search` role in 02/03-roles.sql + prod password
  bootstrap, `DATABASE_SEARCH_URL` env (validated schema, `.env.example`/
  `.env.prod.example`), the relay started/stopped in `main.ts` alongside the
  others.

One wave-scope note: the same commit carried a few small web/telephony fixes
(the call-composer contact picker, a phone-contacts cache invalidation, a
sessions empty state) that surfaced while exercising the workspace — they
belong to the Phase 7 Wave 5 follow-up thread, not to this phase, and are
recorded as such in the commit message.

Validated: `pnpm verify` 54/54 tasks green (including the new relay/route suites
and the search field-set parity tests), guardrail-selftest green. The standing
"aborted run seeds the next failure" lesson bit once during validation: a stale
`work-move` org left by an aborted run hid behind FORCE RLS (a role-visible count
returned zero rows), and was cleared from `taskflow_test` before re-running.

Wave 3 (the UI) is next: the `/search` page with live per-token errors and type
facets, saved searches, and command-palette integration, per §3.

Read this header before trusting a status marker anywhere else in this file — the standing
lesson every `ai/phase-*.md` in this repo states for itself.

## What already exists (checked, not assumed)

PLAN.md §10.2 split the pipeline deliberately — _"the AST ships in Phase 3; the text parser
ships in Phase 8"_ — and Phase 3 shipped its half in full:

- `packages/filter` — the AST (`ast.ts`), the per-resource field whitelist (`fields.ts`),
  validation (`validate.ts`), the SQL compiler (`compile.ts`), the in-memory evaluator
  (`evaluate.ts`), and a parity suite proving the two backends agree.
- `work.cards.description_text` (flattened, for search) with a GIN tsvector index already in
  migration 0008; `work.card_comments.body_text` indexed in 0009. `chat.messages.body_text`
  exists (0017). `docs.pages.title` exists; page BODY is Yjs binary with no plaintext column.
- `pg_trgm` is already installed (`docker/postgres/init/01-extensions.sql`, "for the free-tier
  SearchProvider (§5)").
- The event catalog was written FOR this phase — every slice's event file says "search
  indexing (Phase 8)" in its consumer list, and the payloads carry what the indexer needs
  (titles, `excerpt`s, `restored` booleans, `page.content_updated` as the "go re-read it"
  signal).
- The outbox gives each consumer its own claim (`outbox_dispatch`, migration 0015), and the
  repo has two working consumer relays to mirror: `tenancy/relay.ts` + `audit.projection.ts`
  (exactly-once, own role) and `docs/backlinks.relay.ts` (claim cross-tenant as a narrow role,
  work per-org under `withOrgScope`).
- The command palette (`apps/web/src/components/command-palette.tsx`) draws its own scope
  line explicitly: _"must not grow into search — that is Phase 8 … every result would need
  `can()` checked per row before being shown, which a real search index does."_ That is the
  authorization requirement this phase must meet, not an optional nicety.
- PLAN.md's `SearchProvider` (§5) was deferred "until their phase has a real consumer". Phase 8
  IS that consumer, so the interface is built here, with Postgres FTS + `pg_trgm` as the free
  implementation and self-hosted Meilisearch as the documented upgrade path.

## Goal

One search finds a card, a message, a page, and a transcript in one result set (PLAN.md's
own §10.2 promise), and users can type the query in TQL instead of only dragging filter
chips. The TQL text and the visual builder edit the SAME AST — _"the visual builder edits the
AST directly. Dragging a filter chip regenerates the TQL text; editing the text reparses into
chips"_ — so a user learns the language by using the builder, and a saved query means the
same thing in the board view, the search page, and (later) an automation condition.

## Waves

Three waves, sized so each ships a vertical slice and gets reviewed before the next starts —
the established convention in this repo.

- **Wave 1 — TQL parser** (pure, zero database): tokenizer, recursive-descent parser onto the
  existing `FilterNode` AST, AST→TQL formatter (the round trip), the cross-product `search`
  field set, relative-date literals, `@me`, bare-term free text, and an error model the UI can
  show per token. Everything a user can type is decided here; everything below consumes it.
- **Wave 2 — Search spine**: migration 0045 (`search.documents` projection + `taskflow_search`
  claim role + RLS + trgm/tsvector indexes + outbox-dispatch consumer entry), the indexer
  relay (mirroring `backlinks.relay.ts`), the `SearchProvider` interface (Postgres impl now),
  the `search.query` route with **per-hit `can()`**, and a backfill path for existing rows.
- **Wave 3 — UI**: the `/search` page (TQL input with live per-token errors, type facets,
  result list with permalinks into board/chat/docs), saved searches, and command-palette
  integration.

Wave 1 is the phase's namesake and its only novel parsing code; it is also what the board
filter's TQL text box (a Phase 3 §10.2 promise) and Phase 10's automation conditions both
consume, so it gets the pure-function test budget first.

---

## 1. TQL — the language (Wave 1)

### 1.1 What a query is

A query is one or more comparisons combined with `AND` / `OR` / `NOT`, parentheses, an
optional `ORDER BY <field> [ASC|DESC]` tail, and optional bare free-text terms. It parses
against a resource's field set (`card` for the board, `search` for cross-product) and
compiles to the exact tree the visual builder already produces — `parse(text, resource)`
then the existing `validate(resource, ast)` and `compile(resource, ast)`:

```
assignee = me AND status != Done AND due < -7d ORDER BY priority DESC
type IN (message, page) AND updated > -7d
label IN (bug, urgent) AND board = "Website" AND text contains "deploy outage"
"quarterly report" updated:me
```

### 1.2 Tokenizer (`packages/filter/src/tql/tokenize.ts`)

A hand-written tokenizer (no parser-generator dependency — the grammar is small, and a
generator hides the precedence rules the way the AST hides its operators). Tokens:

- **Identifiers** — `[a-zA-Z_][a-zA-Z0-9_]*` (field names, enum values like `Done`, `me`).
- **Quoted strings** — `"..."` and `'...'`, with `\"`/`\\` escapes; a quoted string is ALWAYS
  a value, never a field name (a field named with quotes is a parse error, not a lookup).
- **Numbers** — integers and decimals (`3`, `3.5`), including negative (`-7`).
- **Relative dates** — `-7d`, `-2w`, `-1mo`, `+3d` (see §1.5).
- **Special values** — `@me`, and any other `@name` (see §1.6).
- **Operators** — `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`.
- **Keywords** — `AND`, `OR`, `NOT`, `IN`, `ORDER BY`, `ASC`, `DESC` (case-insensitive).
- **Punctuation** — `(`, `)`, `,`.
- **Everything else** — a bare word that is none of the above is a **free-text term** (§1.7).

The tokenizer is deliberately dumb: it produces a token stream with positions, and every
token carries `start`/`end` offsets so the UI can underline exactly the bad token. It does
not decide what is a field name — that is the parser + `validate`'s job, and the two are
separate because the tokenizer is resource-agnostic.

### 1.3 Parser (`packages/filter/src/tql/parse.ts`)

Recursive descent with the one precedence table that matters:

```
NOT  >  AND  >  OR
```

- `parse(input: string): ParseResult` where
  `ParseResult = { ok: true, filter: FilterNode | null, orderBy: OrderBy | null }
| { ok: false, errors: TqlError[] }` and `TqlError = { offset, length, message }`.
  Free text is not returned separately: it desugars into `text contains` comparisons inside
  the returned tree, so the AST is the single source of truth and the round trip in §1.4
  needs no second channel.
- Returns errors rather than throwing, mirroring `validate.ts`'s "show all the problems at
  once" contract — a query with two bad chips lights up two chips.
- **Ordering is NOT part of the AST.** `ORDER BY priority DESC` is query-level structure the
  board filter has no use for, and cramming it into `FilterNode` would force `compile` and
  `evaluate` to carry a concept they deliberately do not have. `parse` returns it separately;
  `compileQuery` (Wave 2) appends the ORDER BY fragment to the compiled WHERE.

### 1.4 The round trip (`packages/filter/src/tql/format.ts`)

`format(resource, ast): string` renders a tree back to canonical TQL — the half of §10.2's
promise that makes the visual builder teach the language: drag a chip, the text regenerates;
edit the text, it reparses into chips. Both directions get a round-trip test: `parse(format(x))`
must equal `x` for every tree in the property test (§1.8).

### 1.5 Relative dates stay symbolic until compile time

`due < -7d` must mean "due in the last seven days **as of when the query runs**", not when it
was typed — the identical reasoning `view.service.ts` records for `@me`: _"Resolving it at
save time would make a shared 'assigned to me' view mean 'assigned to whoever saved it'."_ A
saved query resolving its dates at parse time goes stale in a week.

So `-7d` parses to a **symbolic string value** (`'-7d'`), which `validate`'s date branch
accepts via a closed pattern (`@today`, `@now`, `-Nd`, `-Nw`, `-Nmo`, `+Nd`…), and which
`compile`'s `resolve()` substitutes for an ISO timestamp against an injectable `now`
(`CompileOptions.now`, defaulting to real now — the `@me`/`viewerId` precedent, extended with
a clock so tests are deterministic). `evaluate` resolves identically, keeping the two backends
in agreement by construction. Formatted back to text, a resolved date renders as its ISO
string — the relative form is not round-trippable, which is honest: the tree no longer
contains it.

**Natural-language dates (`"next friday"`) are explicitly OUT of scope.** They need a
weekday-relative calendar, they cannot be represented symbolically, and PLAN.md's example is
one line in a spec, not a feature request. Named here so the gap is a decision, not an
oversight.

### 1.6 `@me`, and why `@ali` waits

`@me` works everywhere the AST already allows it — `author = @me` on the `search` resource
uses the same `acceptsMe` mechanism as `assignee = me` on cards. **`author = @ali` does not
ship in Wave 1.** Resolving a handle means a users table lookup, which the parser (pure, no
database) cannot do, and baking a UUID into the tree at parse time makes a saved query name
the person rather than the handle — the shared-filter trap from §10.2, in a second place.
The UI bridges the gap the honest way: the author picker inserts the resolved UUID (exactly
what the visual builder already does for `assignee`), and the parser ACCEPTS `@name` tokens
as string values so a pasted query never hard-errors. Documented, not built.

Quoting is the escape from the desugar rules, and it has two corners worth naming. A value
that collides with a desugar keyword must be quoted: `text contains me` is REJECTED (the
bare `me` desugars to `@me`, which a text field refuses) — the literal word is
`text contains "me"`. And the literal string `@me` is not expressible at all: the AST's ME
constant IS the string `@me`, and validate's ME check runs before the type switch, so a
quoted `"@me"` is treated as the symbol, not the text. That is pre-existing AST design,
pinned by test so the parser cannot drift from the builder.

### 1.7 Bare free text

A token that is not a field name, operator, keyword, or the value after one is a free-text
term. Top-level bare terms AND-combine into `text contains <term>` comparisons — the same
operator the visual builder already has, so the AST stays closed:

```
"quarterly report" type:page        →  text contains "quarterly report" AND type = page
```

(`type:page` — a `field:value` shorthand — is accepted because it is the one form users
expect from every other tracker; it tokenizes as a bare identifier + `:` + identifier and
desugars to `type = page`.) All of it compiles to the SAME tree the builder produces, which
is the phase's entire point.

One grammar corner is a decision, not an oversight: free text immediately followed by the
keyword `NOT` (`report NOT status = Done`) is a parse error, because `NOT` after a word is
read as the start of a `NOT IN` operator. Quote the word (`report "not" status = Done`) or
reorder — the error message names `NOT`, so the fix is discoverable.

### 1.8 Tests (Wave 1)

- **Token-level**: each token kind, escapes, offsets, and the malformed cases (`"unclosed`,
  lone `=`, `ORDER BY` with no field).
- **Parser**: precedence (`a OR b AND c` ⇒ `a OR (b AND c)`), parens, NOT, IN lists, quoted
  strings containing keywords (`label IN ("in progress", bug)`), trailing garbage, empty
  input, `ORDER BY` forms.
- **Round trip**: `parse(format(ast))` equals `ast` over a generated corpus of trees.
- **Property**: a seeded generator builds random valid trees from the `search` and `card`
  field sets and asserts the round trip + `validate` agreement. PLAN.md's own testing table
  (§13, row: _"Property-based — … TQL compiler"_) names this — the repo has no `fast-check`
  dependency today; Wave 1 adds it as a devDependency (pure JS, test-only) or uses a seeded
  hand-rolled generator if adding the dependency is unwanted. Decision recorded in the status
  header when taken.
- **Compile parity**: a relative-date tree compiles identically under an injected `now` in
  both `compile` and `evaluate` — the Phase 3 parity contract, extended to the new literals.

## 2. Cross-product indexing (Wave 2)

### 2.1 `search.documents` — a projection, not a UNION over source tables

Four heterogeneous tables (cards, messages, pages, comments) with different columns, different
authz shapes, and different lifecycles cannot be searched as one result set by joining them.
The audit and notification projections already established the answer this repo uses for
"one consumer, many sources": **project into a single org-scoped table** (migration 0045):

```sql
CREATE TABLE search.documents (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  entity_type text        NOT NULL,   -- 'card' | 'message' | 'page' | 'comment' (transcript joins in Wave 3)
  entity_id   uuid        NOT NULL,   -- the source row's id
  title       text,
  body        text,
  author_id   uuid,
  updated_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL,
  archived    boolean     NOT NULL DEFAULT false,
  metadata    jsonb,                  -- board/channel/space ids for the permalink + authz context
  UNIQUE (org_id, entity_type, entity_id)
);
```

- **RLS** exactly like every other tenant table: `tenantRlsPolicy('search', 'documents')`,
  FORCE included. The search ROUTE reads it through `withOrgScope`; there is no search-specific
  read grant to get wrong.

  The `search` field set in `packages/filter` (Wave 1, §1) maps onto these columns so the
  EXISTING compiler needs no changes: `type` (enum → `entity_type`), `title` (text → `title`),
  `text` (text → `body`), `author` (uuid, accepts `@me` → `author_id`), `updated` (date →
  `updated_at`), `created` (date → `created_at`), `archived` (boolean → `archived`).

- **Indexes**: GIN on `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))`
  (the 0008 immutability rule — config argument mandatory), GIN `pg_trgm` on the same
  concatenation for prefix/substring fuzz, both leading with `org_id` per the template.
- **The claim role `taskflow_search`** mirrors `taskflow_backlinks`: SELECT-only over the
  outbox (see §2.3), writes happen under the ordinary `taskflow_app` role inside
  `withOrgScope`. One role, one job, permissive policy, never widened — the 0035 shape.
- **Delete/archive semantics**: org deletion cascades (0044's trigger needs no change).
  Archiving emits the same events with `restored`; the indexer marks the row
  `archived = true`-equivalent (a boolean column) rather than deleting it, so "show me
  archived work" is a filter, not a reindex.

### 2.2 The indexer relay (`apps/api/src/search/indexer.relay.ts`)

Mirrors `docs/backlinks.relay.ts` line for line in shape — claim cross-tenant as
`taskflow_search` on its own pool/URL (`DATABASE_SEARCH_URL`, optional like
`DATABASE_BACKLINKS_URL`; an instance without it serves requests and another drains the
backlog), then work per org under `withOrgScope` as `taskflow_app`. Wired in `main.ts`
alongside the other relays. At-least-once by the claim contract; **idempotent by the
`(org_id, entity_type, entity_id)` unique key** — a redelivered event upserts, never
duplicates (the notification projection's `notifications_event_user_key` precedent).

Events consumed (every one of these exists today, registered by its owning slice):

| Source        | Events                                                                  | What the indexer stores                                                                                 |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Cards         | `card.created`, `card.updated`, `card.archived`                         | title + description (re-read the row for the text the event deliberately does not carry), archive state |
| Card comments | `comment.created`, `comment.updated`, `comment.deleted`                 | excerpt / re-read body                                                                                  |
| Chat messages | `message.sent`, `message.edited`, `message.deleted`                     | excerpt (full body re-read under `withOrgScope`)                                                        |
| Channels      | `channel.created`, `channel.updated`, `channel.archived`                | name/topic, archive state                                                                               |
| Docs pages    | `page.created`, `page.updated`, `page.archived`, `page.content_updated` | title; body **Wave 2 indexes titles only** — see §2.4                                                   |
| Docs comments | `page.comment_created`, `page.comment_updated`, `page.comment_deleted`  | excerpt                                                                                                 |

Deletes are real DELETEs of the document row when the source is deleted (the event exists for
messages/comments); channel archive hides its messages via the channel row's state carried in
`metadata`.

### 2.3 The consumer registration

`platform.outbox_dispatch` (0015) gives each consumer a claim table; adding the `'search'`
consumer is part of migration 0045 (widen the consumer CHECK the way 0027 did for
notifications — the exact CHECK is read from the migration before writing, not assumed).

### 2.4 Docs bodies: materialize, or not

Page content lives in Yjs binary; there is no plaintext column. `materializeCurrentState`
(`apps/api/src/docs/page-version.service.ts`) already extracts text from Yjs — the backlinks
relay calls it every tick — so the mechanism exists. The cost is real (decode + strip the
collab whitelist per changed page), and every keystroke's autosave fires `page.content_updated`
batching through the backlinks relay's distinct-page fold.

**Wave 2 indexes page TITLES and defers body content to a named follow-up** (same pattern as
the backlinks relay's own fold-to-distinct-pages: the follow-up reuses `materializeCurrentState`
under the same relay, batched and folded). Titles alone already make docs findable; body
content is the difference between "findable" and "searchable inside", and is the right place
to spend the phase's remaining budget after the spine works. The `page.content_updated`
consumer subscription ships in Wave 2 but starts by re-reading only `title` — the follow-up
widens the same handler.

### 2.5 Backfill

The relay only sees events that happen after it exists. Existing rows need one backfill:
a script (`scripts/search-backfill.ts`, runnable via pnpm) that scans cards/messages/pages/
comments per org under `withOrgScope` and upserts documents — the same shape as the seed
scripts in `packages/seed`. Runs idempotently (the unique key again), so re-running after a
failure is safe.

### 2.6 The `SearchProvider` interface

Phase 8 is the real consumer §5 deferred the interface for, so it is built now, in
`packages/contracts/src/providers/`:

- `SearchProvider.search({ orgId, filter, orderBy, viewerId, limit }) → SearchHit[]` —
  declared over the TQL-compiled AST, not over SQL or over Meilisearch's query language, so
  the Postgres implementation and the future Meilisearch one both translate from the SAME
  tree (the interface extends §10.2's "same tree" discipline to the provider boundary).
- Postgres implementation (`packages/search` or `apps/api/src/search/postgres-provider.ts`):
  `compile(resource='search', ast)` → the existing compiler against `search.documents`, with
  `ORDER BY` appended, plus `ts_rank`/`similarity` ordering when free text is present.
- Meilisearch is the documented upgrade path behind this interface ("switch when past ~200k
  indexed rows or fuzzy quality complaints", §5). Not built here.

### 2.7 The route: `search.query`, and why per-hit `can()` is non-negotiable

The command palette's scope note is the spec: _"every result would need `can()` checked per
row before being shown, which a real search index does and a client-side filter would not."_

- **New policy action `search:query`** — added to `packages/policy`'s `Action` union + role
  matrix + authz-matrix test (the template's §2 order: the matrix test fails until the row is
  filled, which is the intended order). The route floor is membership-level; the REAL gate is
  below.
- **The per-hit gate**: `search.documents` carries the parent context (board/channel/space)
  in `metadata`; the route resolves each hit's resource Target and calls `can()` — the exact
  decision trace the permission debug page already renders. A card in a board the caller
  cannot read is never returned, even though RLS admitted the row (RLS answers TENANT, not
  RESOURCE — the same reason `card_labels` carries `project_id` as a second boundary). The
  result is bounded (default 50, max 100), so the per-hit checks are a bounded loop, not a
  fan-out.
- **Output**: `type`, `entityId`, `title`, excerpt/snippet with the matched term highlighted,
  and the permalink route params (board+card, channel+message, space+page) — the client
  navigates, it never re-derives authorization.

## 3. UI (Wave 3)

### 3.1 The `/search` page

- One TQL input with **live per-token errors** (the parser's `offset`/`length`/`message`
  underline the bad token, exactly like the filter builder's per-chip errors), type facet
  chips (`All · Cards · Messages · Pages`), and a result list.
- Results render per type with their permalink: card → the board with the card detail open
  (the URL is a trust boundary — `CardIdSchema` etc. already parse it), message → the channel
  at the message, page → the docs page.
- Keyboard: `/` or the existing palette key reaches it; results are arrow-navigable.
- The **filter builder's TQL text box** (the §10.2 promise: builder ↔ text round trip)
  lands here too — the saved-views editor grows a "TQL" tab that `format()` fills and
  `parse()` validates against `card`'s field set. This is the piece that makes the language
  learnable, which is the whole point of §10.2's split.

### 3.2 Saved searches

Cross-product saved searches are a NEW resource (`search.searches`), not a widening of
`work.views` (which is board-scoped by `board_id`). Same shape as views: `org_id`, owner,
`name`, stored **unresolved** TQL/AST (the `@me` + relative-date rules from §1.5), private vs
shared with the same two-tier permission split views use. Migration + service + route in
Wave 3, following `view.service.ts` as the pattern.

### 3.3 Command palette

The palette gains a search entry that routes to `/search` with the typed query prefilled —
it does NOT become a search box itself (its own scope note stays true: per-hit `can()` is
the search page's job, not a client-side filter over a partial list).

## 4. Security notes (the whole phase in four lines)

1. **The whitelist is the control, unchanged**: TQL text produces a `FilterNode`; the parser
   can emit only comparisons over `fields.ts` entries, and `validate` + `compile` re-check
   it the way they already re-check builder input. A user string becomes SQL only through the
   existing closed field/operator tables and `$n` placeholders. The parser adds no second
   path to SQL.
2. **Per-hit `can()`** on every search result — RLS answers the tenant question; the policy
   engine answers the resource question; both must pass (the palette's own requirement).
3. **The indexer writes under the ordinary app role** inside `withOrgScope`; `taskflow_search`
   is a claim-only reader, the 0035 shape, never widened.
4. **`search.documents` is a projection, not a copy of record.** It can be rebuilt from the
   source tables at any time (the backfill path is that rebuild); it is the audit-log view of
   search, not a second database of truth.

## 5. What is deliberately NOT in this phase

Named so the gaps are decisions, not oversights:

- Natural-language dates (`"next friday"`) — §1.5.
- `@handle` resolution (`author = @ali`) — §1.6; the picker inserts UUIDs, `@name` parses but
  only `@me` resolves.
- Meilisearch deployment — §2.6; the interface exists, the switch is a config change.
- Docs body-content indexing — §2.4; titles in Wave 2, bodies a named follow-up reusing
  `materializeCurrentState`.
- Transcripts (`comms.transcripts`) — PLAN.md's "one search" names them; they join the
  `entity_type` enum in Wave 3 after a schema read (transcript storage shape is checked before
  the enum widens, not assumed).
- File/attachment body search — filenames only, if at all (magic-byte/size metadata is
  indexed; contents are not, and scanning them is a storage-side feature).
- Relevance tuning beyond trigram similarity + `ts_rank` ordering.
- Per-org index sharding beyond RLS (Meilisearch's tenant token rules are a launch-phase
  concern, §13 of PLAN.md).

## 6. Open decisions for approval

1. **Wave granularity** — implement Wave 1 (TQL parser) now, review, then Wave 2, then
   Wave 3; or run the whole phase in one pass. Repo convention is wave-by-wave.
2. **Docs bodies** — Wave 2 titles-only with a named follow-up (recommended), or
   materialize-and-index bodies in Wave 2.
3. **Property tests** — add `fast-check` as a devDependency (recommended, PLAN.md names
   property-based TQL testing), or a seeded hand-rolled generator.
4. **Transcripts** — defer to Wave 3 (recommended) or drop to a follow-up phase entirely.
