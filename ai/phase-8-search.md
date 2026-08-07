# Phase 8 — Search

**Status: DRAFT — pending approval.** Written for review the way Phase 4/5/6's drafts were
(CLAUDE.md: "a second adversarial AI pass in a fresh context is expected"). Nothing in this
phase has shipped. §7 lists what needs a decision before Wave 1 starts.

---

## 1. Why this phase exists

PLAN.md §13 scopes Phase 8 as: *"TQL tokenizer + parser onto the existing Phase 3 AST,
cross-product indexing, saved filters, command palette."* §10.2 already made the one decision
that determines this phase's shape — the filter AST, its SQL compiler, and its in-memory
evaluator all shipped in Phase 3, specifically so this phase would not have to build filtering a
second time:

```
Phase 3   visual filter builder ──► AST ──► SQL compiler      (board / table / calendar views)
Phase 10  automation conditions ──► AST ──► in-memory evaluator
Phase 8   TQL text ──► parser ──► AST                          (same tree, second frontend)
```

So Phase 8 is smaller than it looks. Two things are genuinely new — a text-to-AST parser, and a
cross-product index to query with it — and everything else (validation, compilation, the
security posture) is Phase 3's, reused rather than rebuilt.

`apps/web/src/components/command-palette.tsx` already names this phase as its own boundary:

> "must not grow into search — that is Phase 8 ... A cross-org 'find anything' box is a
> different feature with a different authorization story — every result would need `can()`
> checked per row before being shown, which a real search index does and a client-side filter
> over a partial list would not."

That sentence is this phase's central constraint, not just its motivation, and §3.4 below is
the design decision it forces.

---

## 2. What's in scope, and what is deliberately not

**In scope:**

- A TQL tokenizer and recursive-descent parser producing `packages/filter`'s existing
  `FilterNode` tree — nothing new added to `ast.ts`.
- `FIELD_SETS` gaining `message` and `page` entries (`fields.ts` currently has one: `card`, with
  the comment *"One entry today; Phase 8 adds more."*). Chat and Docs get the same
  saved-filter/TQL capability Work already has.
- A cross-product search index: a new outbox consumer (mirroring `realtime` and
  `taskflow_backlinks`) that materializes searchable content from Work, Chat, and Docs into one
  table, kept current the same way audit and realtime already are — off the mutation's own
  transaction, via the outbox.
- A global field set for cross-product queries (`type`, `title`/`text`, `author`, `updated`,
  ...) distinct from each resource's own field set, because `type IN (message, page) AND author
  = @ali` has no single resource to validate `author` against.
- Saved filters: persisted AST + resource (or "global") + owner, listable and re-runnable.
- The command palette's search mode: results ranked and grouped by product, each one routed
  through the same `can()` the source page would have used.

**Deliberately not in scope:**

- Ranking sophistication beyond recency + exact/prefix match. Phase 8 is 3 weeks per PLAN.md
  §13; relevance tuning is a return trip, not a blocker to shipping search that returns correct,
  authorized results.
- Typo tolerance / fuzzy matching. Postgres `tsvector`/`tsquery` (§3.4) gives stemming for free;
  fuzzy match is `pg_trgm`, a real but separate decision, listed as open in §7.
- Searching **inside** rich text bodies at full fidelity — same `description_text` /
  `content_text` flattening pattern `fields.ts` already uses for card descriptions ("Searching
  inside jsonb would mean the filter depended on the document schema"). The index stores flat
  text, not TipTap JSON.
- Automation reuse. §10.3 already wires automation conditions to the AST evaluator directly;
  Phase 8 changes nothing there.

---

## 3. Structural decisions

### 3.1 The parser has exactly one job: produce a tree the compiler already accepts

The tokenizer recognizes field names, the fixed operator set (`=`, `!=`, `<`, `<=`, `>`, `>=`,
`IN (...)`, `IS EMPTY`, `IS NOT EMPTY`, string/number/boolean literals, `AND`/`OR`/`NOT`,
parentheses, and `ORDER BY <field> [ASC|DESC]`), and nothing else. The parser's output type is
literally `FilterNode` from `packages/filter/src/ast.ts` — not a superset, not a richer
intermediate form. That constraint is what keeps this phase from quietly growing a second query
language: if TQL can express something the AST cannot, the parser has nowhere to put it, and
that surfaces as a parse error during design, not as a shipped feature the compiler then has to
be extended to support.

`ORDER BY` is the one clause with no AST equivalent today (`FilterNode` has no sort concept).
The parser returns `{ tree: FilterNode, orderBy?: { field: string; direction: 'asc' | 'desc' } }`
— a thin wrapper, not a change to the tree itself — and the caller (route handler) applies sort
the same way `cards.list`'s existing `sortBy` param already does.

### 3.2 The whitelist does the same job it always did — the parser adds no new trust boundary

§10.2: *"the whitelist is the security control — no user string ever reaches the database as a
field name or operator."* That control lives in `fields.ts` and `validate.ts` today and does not
move. A TQL string is untrusted input exactly like a JSON filter tree posted from the visual
builder is untrusted input; the parser's output goes through the *same* `validate(tree,
resource)` call before it ever reaches `compiledPredicate`. Concretely: parsing `assignee = me
AND xyz = 1` for the `card` resource succeeds structurally (the parser doesn't know field names
are wrong) and then fails at `validate` with an unknown-field error, identically to how the
visual builder would fail if it somehow constructed the same tree. The parser is not a second
place that needs to reject bad input — it's not a place that *can*, because it has no field
catalog of its own. One whitelist, two producers, same enforcement point.

### 3.3 Cross-product queries need a second, smaller field set — this is the one real addition

`FIELD_SETS` today is `Resource`-keyed (`{ card: CARD_FIELD_MAP }`) and every field belongs to
exactly one resource's table. That model is right for board/channel/space-scoped filtering and
wrong for `type IN (message, page) AND author = @ali AND updated > -7d` — there is no single
resource for `validate` to check `author` against, because the query spans three.

Phase 8 adds a second, parallel field set — call it `GLOBAL_FIELDS`, resource key `'search'` in
`FIELD_SETS` — with a small, deliberately narrow vocabulary that every indexed content type can
answer honestly:

| field     | type         | meaning                                                    |
| --------- | ------------ | ----------------------------------------------------------- |
| `type`    | enum         | `card` \| `message` \| `page` (closed, matches indexed kinds) |
| `title`   | text         | card title / message excerpt / page title                   |
| `text`    | text         | flattened body — see §2's scope note                        |
| `author`  | uuid         | `acceptsMe: true`, same `@me` handling as `card.creator`     |
| `updated` | date         | last-modified                                                |
| `project` | uuid         | board's project / channel's — only where it applies          |

This does **not** replace `card`/`message`/`page` field sets — those still exist for
resource-scoped saved filters (a filter saved on a board still validates against `CARD_FIELDS`
with the full column set). `GLOBAL_FIELDS` exists only for the cross-product path and is
intentionally a subset: it can never express `checklistTotal > 3`, because that has no meaning
for a chat message. A query naming a resource-specific field with `type IN (...)` spanning
multiple types is a validation error, not a partial match — same "closed set, not degraded
match" posture as everywhere else in this package.

### 3.4 The index is an outbox consumer, and this was decided before Phase 8 was written

CLAUDE.md's own description of the outbox — "Audit, notifications, search indexing, and
automation all consume it" — already commits to this shape. Confirmed by grepping the current
outbox implementation: `apps/realtime/src/relay.ts` and `packages/db/src/docs-backlinks.ts` are
both existing instances of the exact pattern this needs — claim via
`claimPending(consumer, ...)`, `LEFT JOIN platform.outbox_dispatch d ON ... d.consumer =
${consumer}`, and a migration adding `WITH CHECK (consumer = '<name>')` scoped to a role that can
only mark its own name dispatched.

So the search index is **not** a synchronous write inside `cards.create`, `messages.send`, or
`pages.updateContent` (that would violate guardrail 6's "the event goes to the outbox in the
mutation's own transaction" — the mutation emits an event, it does not know search exists). It
is a fourth outbox consumer, `search`, alongside `audit`, `realtime`, and `backlinks`:

```
card.created / card.updated / card.archived    ─┐
message.sent / message.edited / message.deleted ─┼─► outbox ─► search consumer ─► platform.search_documents
page.published / page.contentSaved / page.archived ─┘
```

`platform.search_documents` (new migration): `id, org_id, resource_type, resource_id,
container_type, container_id, title, body_text, author_id, updated_at, tsv tsvector generated
always as (...) stored`. RLS-scoped like every other table — `org_id` under `tenant_isolation`,
same as the rest of `platform.*`. The consumer role gets INSERT/UPDATE/DELETE on this one table
only, the same narrow-grant shape `taskflow_backlinks` uses for its column-level restriction on
`docs.page_versions` — except here the restriction is *table*-level rather than column-level,
because the consumer's whole job is to hold denormalized copies of exactly `title` and
`body_text`, nothing else from the source rows.

**At-least-once, like realtime, not exactly-once like audit.** A crash between "wrote the
search row" and "marked dispatched" reprocesses the same event — an `INSERT ... ON CONFLICT
(resource_type, resource_id) DO UPDATE` makes that idempotent, the same reasoning
`docs-backlinks.ts`'s own header gives for its `onConflictDoNothing`.

**Full-text via generated `tsvector`, not `pg_trgm` or an external engine.** No new
infrastructure — Postgres's built-in `to_tsvector('english', title || ' ' || body_text)` as a
generated column, a GIN index on it, and `plainto_tsquery`/`websearch_to_tsquery` for the
free-text half of a query (`text CONTAINS "foo bar"` compiles to `tsv @@
websearch_to_tsquery(...)`, comparison fields compile the ordinary way). This matches §14's cost
posture — Meilisearch is explicitly listed in PLAN.md §15 as "a documented upgrade path, not a
day-one dependency," and search volume at this stage does not justify a new component with its
own auth story to build.

### 3.5 Visibility is enforced by what gets indexed, not by filtering results afterward

This is the decision the command-palette comment was flagging. Two designs were possible:

1. Index everything the mutation touches; check `can()` per row at query time before returning
   results.
2. Index only what the querying user could see, by carrying enough of the container's identity
   in the row to make visibility a join, not N `can()` calls.

**(2) is the design**, for the same reason Phase 5's chat model exists: *"`closed` on a
channel's `can()` target is the entire model. Without it every member reads every DM."* A search
index is exactly the shape that bug loves — a flat table with no per-row authorization is a
structural DM leak waiting for someone to type a common word. `container_type`/`container_id` on
every `search_documents` row (the board a card lives on, the channel a message lives on, the
space a page lives on) lets the query join against the same tuple-membership check every other
read already goes through, rather than re-deriving `can()` in a hot path over what could be
thousands of candidate rows. Concretely: the search route runs inside `withOrgScope`, and RLS on
`search_documents` — not a new bespoke policy, the existing `tenant_isolation` shape plus a
second policy restricting rows to containers the caller has a grant on — is what the "per row"
guarantee in the command-palette comment actually cashes out to. A message in a channel the
caller has left, or a DM they were never part of, must not be indexed as visible to them; it is
either excluded by the same authorization state that would exclude it from the channel list, or
re-derived on membership change (see §7's open question on revocation).

This is also why `search_documents` cannot simply mirror `docs.page_versions`'s
`taskflow_backlinks` trick (a role with no read access to content, only existence). Search's
entire purpose is serving content — title and body text — back to a user, so the row-level
guarantee has to be "this row is only ever readable by someone with current access to its
container," enforced the same layer RLS already enforces tenant boundaries.

### 3.6 Saved filters are a small new table, not a repurposing of anything existing

`platform.saved_filters`: `id, org_id, owner_id, name, resource ('card' | 'message' | 'page' |
'search'), tree jsonb, tql text, created_at`. Storing both `tree` (the validated AST — what
actually runs) and `tql` (what the user typed or what the builder round-tripped to — what
re-renders in the box) avoids re-serializing the AST back to text on every load, and avoids
re-parsing text on every run. `tree` is authoritative; `tql` is a display cache invalidated
together with it. `@me` stays symbolic in storage exactly as §10.2 already established for
in-flight filters — a saved filter shared org-wide must mean the same thing to whoever opens it.

Access: a saved filter is owner-only to start (list/run/delete gated on `owner_id = caller`,
`policy` needs no new resource type for that — it's an ownership check, not a `can()` grant).
Whether saved filters become **shareable** (a team's saved view of "unassigned bugs") is called
out as open in §7 rather than decided here, because it is a `RESOURCE_TYPES` and permission-
catalog change (`RESOURCE_TYPES` is a three-place change per `permissions.ts`'s own header) and
should not be bundled into the phase that is primarily about the parser.

### 3.7 The command palette gets a second mode, not a second component

`command-palette.tsx` currently does destination-navigation only, deliberately, per its own
comment. Phase 8 adds a search mode inside the same dialog rather than a new surface: typing a
plain string still does what it does today (fuzzy-matches known destinations, instant, client-
side, no network round trip) while typing past a threshold — or an explicit `/` or `>` prefix,
to be decided in implementation — switches to querying `search.query` (debounced, server-side,
authorized). This mirrors how Linear/GitHub's palettes disambiguate "jump to X" from "search for
X" without asking the user to pick a mode up front. Results group by product (Work / Chat /
Docs) with the resource's own icon and route, and selecting one navigates exactly like today's
project-jump entries do — no separate "search results page" is required for the palette path,
though one is still useful for a saved, shareable query (a URL with a saved-filter id or an
inline TQL string in the query param, validated through the same `FilterTree`/`GLOBAL_FIELDS`
path the URL-as-trust-boundary section of CLAUDE.md already establishes for board filters).

---

## 4. TQL grammar (informal)

```
query      := expr (orderClause)?
expr       := orTerm
orTerm     := andTerm ('OR' andTerm)*
andTerm    := unary ('AND' unary)*
unary      := 'NOT' unary | atom
atom       := comparison | '(' expr ')'
comparison := field op value
            | field 'IN' '(' value (',' value)* ')'
            | field 'IS' 'EMPTY'
            | field 'IS' 'NOT' 'EMPTY'
field      := identifier                      -- resolved against the resource's field set
op         := '=' | '!=' | '<' | '<=' | '>' | '>='
value      := string | number | boolean | '@me' | '@' identifier | relativeDate
relativeDate := '-' integer ('d'|'w'|'m')      -- e.g. -7d, resolved to an ISO date at parse time
orderClause := 'ORDER' 'BY' field ('ASC' | 'DESC')?
```

Examples from §10.2, annotated:

```
assignee = me AND status != Done AND due < "next friday" ORDER BY priority DESC
```
`me` and `"next friday"` are the two non-literal value forms: `me` → `ME` sentinel (§ast.ts,
resolved at compile time, not parse time — same reasoning as `@me` today), `"next friday"` → a
natural-language date phrase. **Open question in §7**: whether relative natural-language dates
(`"next friday"`, `"last week"`) ship in Phase 8 or only the terser `-7d` form the second example
uses — the two need different parsing (a fixed grammar of offsets vs. a phrase table) and
different test surfaces.

```
type IN (message, page) AND author = @ali AND updated > -7d
```
`type` only exists in `GLOBAL_FIELDS` (§3.3) — this query is only valid against the `search`
resource, never against `card`. `@ali` is a **mention-style user reference**, distinct from the
bare `@me` sentinel: it needs resolving a handle to a `UserId` before compilation, which is a
lookup (`identity.users` by handle, org-scoped) the parser itself cannot do — this resolution
happens in the route handler between parse and validate, the same place `me` → caller-id
substitution already happens, so the parser's own output keeps `@ali` as an unresolved reference
type the caller must settle before `validate()` runs. An unresolvable handle is a normal
validation error (`400`, "no such user"), not a silent empty match.

---

## 5. Waves

**Wave 1 — TQL parser onto the existing AST, single-resource only.**
Tokenizer, recursive-descent parser, `ORDER BY` wrapper. Ships against `card` only — the one
resource with a real field set today. Board's existing TQL-less filter bar gains a text-entry
mode that round-trips with the visual builder, proving §3.1/§3.2 before anything cross-product
exists. Property-based tests (parser output is always a well-formed `FilterNode` or a parse
error, never a tree that passes `validate` and disagrees with what a human reading the string
would expect) — mirrors the existing `fast-check` coverage on the rank generator and policy
engine per §8.6 of PLAN.md.

**Wave 2 — the search index.**
Migration for `platform.search_documents` + `taskflow_search` role + `WITH CHECK (consumer =
'search')`. The `search` outbox consumer, subscribing to `card.*`, `message.*`, `page.*` events
already emitted today (no new event types — guardrail 6 already requires every mutation to emit
one, so this consumer adds a subscriber, not a producer). `GLOBAL_FIELDS` + `search` resource in
`FIELD_SETS`. No UI yet — this wave is provably correct against the outbox directly, the same
way Wave 1 of Phase 4 proved the gateway "on one event" before building the full catalog.

**Wave 3 — command palette search mode + saved filters.**
`search.query` route (parse → validate → compile against `search_documents`, RLS + container
join per §3.5). Palette's second mode (§3.7). `saved_filters` table, CRUD routes, "save current
filter" affordance on both the board filter bar and the palette's search box. `message` and
`page` gain their own `FIELD_SETS` entries so Chat and Docs get resource-scoped saved filters
too, not just the cross-product one.

Three waves, not one — deliberately smaller than Phase 4's two or Phase 6's four, because §13
budgets this phase at 3 weeks (a third of Phase 6's 8) and each wave here is independently
demoable: Wave 1 alone is a real, shippable improvement to the Work filter bar even if Waves 2–3
slipped.

---

## 6. Cross-cutting obligations

### 6.1 The wire lies about dates here too

`search.query`'s response carries `updatedAt` the same way `cards.list` does — a `z.date()`
output serialized to an ISO string with no transformer configured (Phase 3's own documented
trap). Route output goes through `wire()` like every other tRPC result; a search-results
component that reads `result.updatedAt` as a `Date` without going through `lib/wire.ts` repeats
the exact bug `cards.list` already had.

### 6.2 A saved filter's `@me` cannot be resolved by the client

Same reasoning as §10.2's original argument, restated because it is easy to get backwards for
`@ali`-style mentions specifically: resolving a handle to a `UserId` client-side and sending the
resolved id would make a saved filter's meaning depend on who last edited it rather than who is
running it now. The route resolves handles server-side, per §4's grammar note, every time the
filter runs — not once at save time.

### 6.3 Tests ship with the slice, per the standing rule

Parser: property-based round-trip (parse → serialize → parse again is stable) and a fixed corpus
of the malformed inputs a hand-typed query actually produces (unclosed paren, unknown field,
`IN` with zero values, operator/type mismatch — the same class of thing `ComparisonSchema`'s
`superRefine` already guards against for the builder's path, now reachable from text too).
Index: an integration test proving a message in a channel the test's second user was never
added to does not appear in that user's `search.query` results — the direct analogue of Phase
5's own missed-`closed`-flag lesson, written as a test *before* the consumer ships rather than
found by manual testing after, per CLAUDE.md's standing complaint about Phase 5's nine
after-the-fact findings.

---

## 7. Decisions — needed before Wave 1 starts

1. **Relative dates: `-7d` only, or also `"next friday"`-style phrases?** §4 flags the two need
   different parsing strategies. Recommend: ship `-Nd`/`-Nw`/`-Nm` in Wave 1 (small, unambiguous
   grammar), leave phrase parsing as a named follow-up rather than blocking the wave on a phrase
   table's edge cases (timezone of "next", week-start convention, etc.).

2. **Saved filter sharing.** Owner-only (§3.6) is the smaller change; team/org-visible saved
   filters need a `RESOURCE_TYPES` addition and role-matrix rows. Decide before Wave 3, since the
   table schema (§3.6) would need a nullable `visibility`/`team_id` column added now rather than
   migrated in later if sharing is wanted for launch.

3. **Index staleness on revocation.** §3.5's container-join design means a membership revocation
   is enforced at query time (the join simply stops matching), *not* by deleting or updating
   `search_documents` rows — so no stale-index leak, but worth stating explicitly and testing,
   since it is the one place this design's safety argument depends on the join always running
   rather than ever being bypassed by a cached result.

4. **Fuzzy/typo-tolerant matching.** Out of scope per §2; confirm that stays true for launch or
   whether `pg_trgm` should be pulled into Wave 2's migration while the `search_documents` table
   is already being created (cheaper to add the extension and a trigram index now than to
   migrate it in after real query patterns exist).

5. **Palette mode-switch trigger.** §3.7 proposes a length threshold or explicit prefix; needs a
   product decision, not just an engineering one — this is the one UI-feel question in the
   phase.

---

## 8. Sequencing and cost

Depends on: Phase 3's filter AST (shipped), the outbox (shipped, three consumers already prove
the pattern), Phase 5 Chat and Phase 6 Docs for `message`/`page` events to index (both shipped).
No dependency on Phase 7 — Search does not touch Voice & Messaging content by design (call
recordings and transcripts are not in `GLOBAL_FIELDS`; if that's wanted later it's an explicit,
separately-reviewed addition given §2.2's compliance sensitivity around telephony data).

Nothing here needs a new paid service — `tsvector`/GIN is built into the Postgres already
running, consistent with §14's "$0 through Phase 6" cost posture continuing to hold. The one
new infrastructure-shaped decision is question 4 above (`pg_trgm`), and it is free either way.
