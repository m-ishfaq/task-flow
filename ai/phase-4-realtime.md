# Phase 4 — Realtime spine

**Status: APPROVED 2026-08-05 — Waves 1 and 2 built.** Drafted to be reviewed and argued with, the
same way `phase-3.5-work-ux.md` was before its own approval. §3 stands as written; the five open
questions in §7 were answered on approval and are recorded there with the reasoning, not left as a
default nobody chose. Getting §3 wrong is expensive to unwind once a gateway is broadcasting to
real clients, which is why it was argued about first.

Read §7 before §5 — three of those answers change what Wave 1 builds.

**Where the draft turned out to be wrong.** Four places, all corrected in place rather than left for
a reader to trip over, because a spec that disagrees with the code teaches the code is wrong:
§4.1 (the catalog's exclusions are three different arguments, not one), §4.2 (one payload change WAS
needed, contradicting "no new payload schemas"), §5.1 (presence must use `fetchSockets()`, not
`adapter.rooms`), and §5.2 (reconnect needs an explicit rejoin, not just a refetch). §7.2's event
name was also wrong — `session.token_reuse_detected`, not `token.reuse_detected`.

Wave 3 (activity-stream persistence) remains out of scope — see §2 and §7.4.

Parent: [PLAN.md](../PLAN.md) §9 (Real-Time Architecture), §10.6 (Domain events), §13 (Roadmap).

---

## 1. Why this phase exists

Work today is round-trip only. Two people on the same board do not see each other's moves,
comments, or status changes without a manual refresh — `staleTime: 30_000` on every query
(`apps/web/src/lib/query.ts`) means a colleague's change can sit invisible for up to thirty
seconds even then. That gap is tolerable for a solo user and wrong for the thing this product is
for.

It also unblocks nothing on its own and everything after it: PLAN.md §13 is explicit that
**Phase 4 must precede 5, 6, and 7** — Chat, Docs, and Voice all assume a working socket layer
exists. Phase 3.5 already paid down the cost of delaying this once; the plan is not to delay it
again.

## 2. What's in scope, and what is deliberately not

**In scope:** the **App events** channel from PLAN.md §9 — Socket.io + `@socket.io/postgres-adapter`,
broadcasting Work's existing domain events (card moves, comments, status changes, presence) to
whoever has a board open. Room authorization, connection lifecycle, reconnect-and-diff, and enough
of an activity feed to prove the spine carries real traffic.

**Out of scope, on purpose:**

- **Chat delivery** (Phase 5) and **Doc collaboration** / Hocuspocus (Phase 6) are the other two
  channels in §9's table. They build ON this gateway — Chat reuses the same Socket.io server on a
  dedicated namespace; Docs is a genuinely different write model (CRDT) that only shares the
  authorization hook. Building either now is scope creep past what "the spine works" needs to
  prove.
- **`apps/worker` / pg-boss.** CLAUDE.md flags the outbox relay's current timer-in-the-API as an
  accepted placeholder that "belongs in `apps/worker` on pg-boss from Phase 4" — but the roadmap
  line for Phase 4 (PLAN.md §13) does not list a worker app as a deliverable, and the relay's own
  header comment defends the timer as "the smallest thing that makes it real today." §3.5 below
  proposes realtime uses the SAME kind of placeholder rather than standing up `apps/worker` as a
  prerequisite. Revisit when a real deliverable needs pg-boss's retry/scheduling semantics, not
  before.
- **A durable activity-stream UI.** The roadmap line says "activity stream," and Wave 2 gives
  every broadcast the shape an activity feed needs — but a persisted, paginated feed is a read
  model with its own migration and query, not free from the broadcast alone. §5 scopes Wave 2 to
  proving the shape works; a real feed page is a follow-up, not blocking.

## 3. Structural decisions

The eight things worth getting right before any gateway code exists. §3.7 and §3.8 are the two
that matter most if you read nothing else here: this section exists because a socket layer with no
authorization model — one that trusts whatever identity a client claims in a payload — is a real,
observed failure mode, not a theoretical one.

### 3.1 A room is a board

Every place the frontend already scopes a live query is per-board:
`cardsQuery(orgId, boardId, filter)`, `keys.cardsOfBoard`, `keys.lists`. Card-level or list-level
rooms would multiply the join/leave traffic for no client that wants it — nobody subscribes to one
card without already having its board open. **Socket.io room name: `board:{boardId}`.** A client
joins on mount of `board-page.tsx` / `home-page.tsx`'s board-scoped queries and leaves on unmount.

`home-page.tsx` (My Tasks) is the one screen that isn't board-scoped — it shows cards across every
board the caller can reach. It does not get a room. Realtime for it is out of scope for Wave 1 and
2: a page open to `N` boards would otherwise mean joining `N` rooms just for a due-date-grouped
summary view, and it already lives with `staleTime`-bounded staleness rather than a live query — a
cross-board room strategy is worth designing on its own once the per-board case is proven, not
folded into Wave 1 as an afterthought.

### 3.2 Connection authentication has no header to piggyback on

HTTP resolves org+role fresh on every request, off the `x-taskflow-org` header and a membership
read (CLAUDE.md, Phase 2 notes). A socket connection is long-lived — there is no per-message
header to re-resolve against, and the access token it authenticates with is a 10-minute JWT
(`ACCESS_TOKEN_TTL_SECONDS`, `packages/security/src/jwt.ts`) kept in memory only, never persisted
(CLAUDE.md, Phase 3 notes on why).

Proposed handshake: the socket connects with the SAME access token the tRPC client already holds
in memory, sent once as Socket.io's `auth` payload (not a query string — those end up in server
access logs). `apps/realtime` verifies it exactly as `authenticate()` does today, and stores
`{ userId, sessionId }` on the socket. **No org and no role are resolved at connect time** — same
reason the HTTP principal carries neither (`context.ts`: "an earlier draft... assumed [a token
would carry a role]... a revoked admin keeps admin for the ten minutes that matter most"). Org and
role are resolved per ROOM JOIN, in §3.3, not per connection.

**A connection presenting no token, an invalid one, or an expired one is refused at the handshake
— `io.use()` middleware rejects it before `connection` fires, not "accepted, then treated as
anonymous."** There is no anonymous state for a socket to be in: CLAUDE.md is explicit that nothing
in Work happens without an org, and there is no `publicRoute`/`selfRoute` equivalent for
`apps/realtime` to carry over. A connection that never authenticates has no work to do here — it
should not be able to open a socket and sit on it waiting to see what it can get away with next.

**Origin is checked at the same handshake, allow-listing only this app's own origin(s)** — the
identical purpose `apps/api`'s CORS policy already serves for HTTP. A page loaded from anywhere
else must never get far enough to present a token in the first place. This is NOT a substitute for
XSS defenses (a script running inside the app's own origin, in an already-authenticated tab, still
has a real token — that is what CLAUDE.md rule 4's TipTap-only rich text and the
`dangerouslySetInnerHTML` ban exist to prevent, and nothing here relaxes either); it is the
narrower, cheaper control that stops a connection attempt from a domain that was never supposed to
be able to reach this server at all.

**Reauth is reconnect, not refresh-in-place.** When the access token nears expiry, the client
already has a working silent-refresh path (`lib/session.ts`, single-flight). The socket client
disconnects and reconnects with the freshly refreshed token rather than the gateway implementing a
second token-rotation protocol over an open connection. Socket.io's own reconnect/backoff handles
the gap; `board-view.tsx` already has to tolerate a disconnected gateway (see §3.6) so a
reconnect-driven reauth is not a new failure mode, just a scheduled instance of one that already
has to be handled.

### 3.3 Room join is a fresh `can()` check, not a cached decision

Joining `board:{boardId}` runs `board:read` through the exact same `can()` used everywhere else —
built from a `Subject` assembled by `loadTuples(orgId, userId)` + the current membership role, the
identical inputs `resolveOrgMembership` produces for an HTTP request. **This must not be a special
second authorization path.** A gateway that reimplements "can this user see this board" is the
same mistake §8.2 forbids the UI from making, aimed at a different consumer.

The `userId` half of that `Subject` is `socket.data.userId` — set once at handshake in §3.2, from
the verified token. It is never read from the join request's payload. `boardId` IS client-supplied
(it is a request: "let me into this room"), and that is fine, because `can()` is what decides
whether the request is granted — the client naming a board is not different from a browser naming
a URL to navigate to. See §3.7 for why that distinction (a REQUEST vs. a CLAIMED IDENTITY) is the
entire security model of this section.

The harder question §8.2's HTTP model doesn't have to answer: a socket can stay joined to a room
for hours, and a membership can change in that window — a role demotion, a revoked `viewer` tuple,
a removed member, a fully revoked session. **The fix is not a TTL on the join decision.** It is
subscribing to the events that already exist for exactly this: `member.role_changed`,
`member.removed`, `grant.revoked`, `session.revoked`, `token.reuse_detected`
(`apps/api/src/tenancy/events.ts`, `apps/api/src/identity/events.ts` — all defined today, all
flowing through the outbox already). On any of these, the gateway re-runs `can()` for every socket
currently joined to a room that member/session touches, and force-leaves (or fully disconnects, for
the two session events) anyone who no longer passes. This is the realtime analogue of "role is read
per request, never trusted from the token" — applied to a connection instead of a request, using
infrastructure this phase is already building to carry the events that trigger it.

### 3.4 A new event→room table, not a shared one

`audit.projection.ts` already has `RESOURCE_OF` — an event name → `{ type, key }` lookup used to
label audit entries. It is tempting to reuse it for "which room does this event belong to." Don't:
the two questions have different correct answers. Audit's mapping resolves `card.moved` to
`{ type: 'card', key: 'cardId' }` because that is the precise resource an audit trail should name.
Realtime needs the BOARD — `card.moved`'s payload already carries `boardId` directly
(`apps/api/src/work/events.ts`), so the room table is `card.moved -> boardId`, a different value
from audit's `cardId` for the identical event. Same shape (a fixed literal lookup — never derived,
never a caller string), separate table, because conflating them would mean a correct audit mapping
silently becoming a wrong room mapping the first time someone "simplified" it to one shared table.

### 3.5 Realtime is the outbox's second consumer — already wired

This is what the outbox fan-out work (migration `0015`, this session) exists for. `claimPending`,
`markDispatched`, and `recordFailure` all already take a `consumer` argument; `'audit'` is the only
one that exists today. Realtime adds `'realtime'` — its own rows in `outbox_dispatch`, its own RLS
role and three policies mirroring `outbox_dispatch_audit_*` exactly (the migration's own "what this
deliberately does not do" section names this as the next step). No further schema change.

Drains the same way the audit relay does today — a timer, not `apps/worker` (see §2's "out of
scope"). `startAuditRelay` in `apps/api/src/tenancy/relay.ts` is the direct template: a five-second
tick, `FOR UPDATE SKIP LOCKED` (now scoped per-consumer via `outbox_dispatch`, not shared), one
transaction per batch. `apps/realtime` runs its own copy of that shape rather than importing the
audit relay, because the two will diverge the moment realtime needs backpressure the audit relay
does not (a slow client is a reason to shed a broadcast; a slow audit write is never a reason to
drop an audit entry).

### 3.6 Every broadcast carries `{ mutationId, actorId, version }`

Straight from §9, restated here because it is the one client-side contract Wave 1 has to get right
or the whole exercise is cosmetic: a client that just performed a mutation optimistically already
has the new state. Receiving its own broadcast back and re-applying it is redundant at best and a
flicker at worst. Every mutation that emits a domain event already has a natural mutation id — the
`requestId` on the envelope (`envelopeOf(actor)` in `apps/api/src/work/shared.ts`) already carries
one; the realtime payload reuses it rather than minting a second id the client has to correlate
separately. `version` lets a client that's behind (reconnected after a gap, or received events
out of order across two boards) know to refetch rather than trust a payload that assumes a state it
never saw.

### 3.7 No identity, ever, from an event payload

A payload field is not a badge. A message telling the gateway "I am user 4821" or "subscribe me to
board X's room" proves nothing about who is actually holding the socket — it is a value in JSON,
indistinguishable from any other value an attacker chose to write. The socket's identity is decided
EXACTLY ONCE, at the handshake in §3.2, from the verified access token, and stored on
`socket.data.userId` — a server-controlled property, not a client-writable one. Every handler that
needs "who is this," for the rest of the connection's life, reads that stored value. None of them
ever reads a `userId` field the client sent in a connect payload or an event.

This is not a hypothetical failure mode; it is the exact shape of the most damaging class of
Socket.io vulnerability that shows up in real deployments: a "subscribe me to my own notifications"
handler that takes `userId` from the message and joins that user's channel with no check that the
connection ever authenticated as them — looped across a range of ids, this harvests every user's
private messages, file-download links, and session data from a socket that never proved any
identity at all, and leaves nothing in an HTTP audit log because no HTTP route was ever touched.
`apps/realtime` has exactly one identity-bearing property per socket (`socket.data.userId`, set once,
read-only from every handler's perspective), and exactly one authorization check per room (§3.3) —
if a future change needs a second personal channel, a second identity field, or a "trusted" event
that skips `can()`, that change is the vulnerability, not a shortcut around one.

### 3.8 The handshake is a perimeter, not a formality

Two controls beyond the token check itself:

- **Rejected outright, not degraded to anonymous.** A connection with no token, an invalid one, or
  an expired one is refused before `connection` fires (Socket.io `io.use()` middleware). There is
  no anonymous-but-limited state to fall into — CLAUDE.md is explicit that nothing in Work happens
  without an org, and `apps/realtime` carries that over rather than inventing a lighter tier "just
  for sockets."
- **Failed attempts are observable, even though sockets never write to the audit log.** A token
  that fails verification, or a room join `can()` refuses, goes through `@taskflow/observability`
  with enough shape to see a pattern — the same socket, or the same source IP, refused across a wide
  range of rooms in a short window is exactly what enumerating "which boards exist and which of
  them will let me in" looks like. Guardrail 6 (every state-mutating service method emits a typed
  domain event) does not apply here — a refusal is not a mutation — but "not an audit event" and
  "invisible to anyone" are not the same requirement, and this phase should not conflate them.

## 4. Event catalog — nothing new to define

Every event this phase broadcasts already exists (`apps/api/src/work/events.ts`) and already flows
through the outbox in its own transaction (guardrail 11). This phase is a BROADCASTER, not a new
producer.

**As built (Wave 2), the room table carries these 25** — `apps/realtime/src/event-rooms.ts` is the
authority; this list is a description of it, not a second source of truth:

```
card.created · card.updated · card.moved · card.assigned · card.archived
card.status_changed · card.labeled · card.field_set
list.created · list.updated · list.reordered · list.archived · list.rebalanced
board.updated · board.archived
comment.created · comment.updated · comment.deleted
checklist.created · checklist.deleted
checklist_item.created · checklist_item.updated · checklist_item.deleted
view.created · view.updated · view.deleted
```

### 4.1 The three exclusions, and why each is a different argument

The draft catalog above listed `checklist.*`, `custom_field.*`, `label.*` and `board.created`
loosely. Building it forced each to be decided, and they did not decide the same way. All three are
enforced at boot by `assertRoomTableIsSafe`, not by comment alone — the check runs in CI and on
every developer's machine, before a connection is accepted, rather than in production on the first
real event.

**`attachment.*` — a security exclusion.** A presigned download URL is a bearer credential for the
one file it names, with its own short expiry, and broadcasting one to a room hands it to everyone
currently subscribed rather than the one caller who asked. If attachment events are ever added, the
payload carries `attachmentId` and the client re-requests a URL over the normal authorized HTTP
path. This is the one exclusion where being wrong leaks data.

**`label.*`, `custom_field.*`, `status.*` — a routing exclusion.** These are PROJECT-scoped
vocabulary changes: their payloads carry `projectId`, never a single `boardId`, because a project
commonly has more than one board and renaming a label affects every card carrying it across all of
them. §3.4's whole design is one fixed key per event precisely so "which room" is never a judgment
made at broadcast time, and there is no single board room that is the right answer here. Routing to
"every board under the project" would need a project-room concept §3.1 does not have, or a
per-broadcast database lookup the table exists to avoid. Left on the 30-second `staleTime` poll
instead: renaming a label is a low-frequency admin action, and the gap is a wait of at most half a
minute rather than a silently broken feature.

**`board.created` — a pointless-broadcast exclusion.** It names a board that did not exist a moment
ago, so no client can have joined `board:{boardId}` for it. The room always has zero subscribers.
Excluded not because it is unsafe but because including it would look like a working feature under
any test that does not check who actually received it.

### 4.2 One payload change was needed after all

The draft claimed "no new `defineEvent()` calls, no new payload schemas." That held for Wave 1 and
broke in Wave 2: the five `checklist.*` / `checklist_item.*` events carried `cardId` but no
`boardId`, and `cardId` names a card, not a room. Since §3.4 routes strictly on a fixed payload key
with no lookup, those events could not be routed at all.

`boardId` was added to all five payloads (`apps/api/src/work/events.ts`, and the corresponding
`createEvent` calls in `checklist.service.ts`). Every caller already held the parent card, so this
is a field already in hand rather than a new query. The alternative — letting the room table do a
database read to resolve a card's board — is the exact per-broadcast lookup §3.4 exists to prevent.

Old outbox rows written before this change carry no `boardId`, and `roomBoardIdOf` returns null for
them rather than guessing: they are marked dispatched and broadcast nowhere, which is correct for
an event whose audience cannot be determined.

## 5. Waves

### Wave 1 — the spine, proven on one event

- `apps/realtime` scaffolded as a Turborepo app (Socket.io server, `@socket.io/postgres-adapter`
  wired even at single-instance scale — cheap now, expensive to retrofit once two instances are
  running behind a load balancer).
- Connection auth (§3.2), room join/leave with a real `can()` check (§3.3), the event→room table
  (§3.4) seeded with just `card.moved` and `card.created`.
- The `'realtime'` outbox consumer (§3.5) — migration adding its role + policies, the relay loop.
- `apps/web`: a room-join hook mounted from `board-page.tsx`, and ONE handler — a card move from
  another client patches the board's cached card list exactly the way `useUpdateCard`'s optimistic
  patch does today, just triggered by a socket event instead of a mutation response.
- **Acceptance:** two browser tabs on the same board; a card dragged in one appears in the other
  without a refresh, within the outbox relay's tick interval. A tab on a DIFFERENT board's room
  never receives it. A tab whose `viewer` tuple gets revoked mid-session is force-left within one
  tick of the `grant.revoked` event. A socket with a valid token for one user, sent a join request
  naming a board that user has no membership on, is refused — and the same socket cannot join
  ANY room by asserting a different `userId` in the request, because there is nowhere in the
  protocol a `userId` can be asserted (§3.7). A connection presenting no token, or a token for a
  different origin's app, never reaches `connection` at all.

### Wave 2 — full catalog, presence, reconnect

- Every event in §4 wired through the room table, with the three exclusion classes in §4.1 enforced
  at boot and the payload change in §4.2 made to reach them.
- `apps/web` handles the catalog with three strategies chosen per event — PATCH the field, ADJUST a
  counter by a delta the payload can compute exactly, or INVALIDATE. The rule for choosing is the
  same one §3.4 applies to rooms: never guess. `checklist_item.deleted` invalidates rather than
  adjusts because its payload carries no `done` state for the item it removed, so the counter delta
  is unknowable; `checklist_item.updated` adjusts, because `before`/`after` give it outright.
- Presence: ephemeral, per §9 — who else has this room open, no persistence, no domain event,
  cleared on disconnect.
- Reconnect-and-diff (§9).
- Session/membership-revocation force-disconnect (§3.3) extended to every event named there.
- **Acceptance:** every board interaction Phase 3.5 shipped (drag, quick-assign, comment, status
  change, checklist toggle) is visible to a second viewer live. A socket that drops for thirty
  seconds and reconnects ends up in the same state a hard refresh would have produced.

#### 5.1 Presence reads `fetchSockets()`, not `io.sockets.adapter.rooms`

The draft said "mostly a client-side avatar stack reading `io.sockets.adapter.rooms`". That is
wrong the moment there is a second instance, and wrong silently: `adapter.rooms` only ever sees
sockets connected to THIS process, so presence would report a subset of who is actually there, with
nothing failing to say so. Since §5 wires the Postgres adapter at single-instance scale precisely so
a second instance is not a retrofit, presence must not be the one thing that quietly assumes one.

`io.in(room).fetchSockets()` is the adapter-aware API for exactly this — it asks every instance and
answers as one cluster — so `presence.ts` is already correct whether the gateway is one process or
several.

The broadcast is the FULL member list, never a delta. A client that missed one update is correct
again on the very next one, with nothing to reconcile; a delta stream would need the client to
detect and repair its own drift.

#### 5.2 Reconnect needs an explicit rejoin, which the draft did not anticipate

The draft treated reconnect-and-diff as "confirming the socket's own reconnect triggers
`refetchOnReconnect`, not building a new mechanism." The refetch half is indeed that. The other half
is not, and missing it leaves a tab that looks connected and receives nothing:

**Room membership does not survive a reconnect.** The gateway's `disconnect` handler already ran and
cleared its side, so a socket that re-authenticates and stops there is in no rooms at all. The
client therefore tracks which boards this tab wants joined and replays `board:join` for each on
Socket.io's `reconnect` event (`lib/socket.ts`).

Two details worth keeping:

- It is the Manager's `reconnect`, not the socket's `connect`. `connect` also fires on the FIRST
  connection, where there is no membership to have lost and nothing to diff — firing there would
  invalidate every board query on every page load.
- The room is recorded BEFORE the join is emitted, not in its ack. An ack only arrives if the
  connection survives long enough to carry it back, so recording it there loses exactly the joins
  that were in flight when the socket dropped — the precise case a reconnect exists to recover from.
  `apps/web/src/lib/socket.test.ts` asserts this directly, and the assertion fails against the
  ack-based version.

Wave 3 (activity-stream persistence) is explicitly not scoped here — see §2.

## 6. Cross-cutting obligations

### 6.1 Sockets still never write

CLAUDE.md's rule 8 already states this (not to be confused with PLAN.md's numbered guardrail 8,
the tenancy fuzz harness — two separate numbering schemes that happen to collide at "8"); Wave 1's
own acceptance criteria depend on it staying true. The temptation this phase invites is a client
emitting an event the gateway relays directly to other clients as an optimization — skip it. Every
mutation still goes through the API, where validation, authorization, audit, and the outbox already
live. A socket that can write is a second write path, and PLAN.md §9 calls that out by name as "the
single most common source of subtle inconsistency in systems like this."

### 6.2 The gateway never re-derives authorization

Same rule §8.2 states for the UI, aimed at `apps/realtime` instead: it asks `can()`, it does not
reimplement a decision about who may see a board. §3.3 is the whole design; nothing here should
grow a local notion of "who's allowed in this room" that isn't a direct `can()` call.

### 6.3 The wire lies about dates here too

Every broadcast payload is JSON over a WebSocket — the same `Wire<T>` problem `lib/wire.ts` exists
for on the tRPC boundary applies identically to socket payloads. `occurredAt` on a broadcast is a
string, not a `Date`, until something on the client calls `wire()` on it.

### 6.4 Tests ship with the slice

PLAN.md §11 already names the gate: "Socket & collaboration — socket.io-client + y-websocket
harness — ✅ blocks merge." Concretely for this phase: a room-join test proving `can()` is actually
consulted (not just that a join succeeds), a force-disconnect test for at least one of the §3.3
events, and a fan-out test proving two consumers draining `outbox_dispatch` do not starve each
other — which `packages/db/src/audit.test.ts` already has for `'audit'` vs `'realtime'` as a stand-in
consumer name; extend it to prove the REAL realtime consumer that Wave 1 adds behaves the same way
against a live gateway, not just the table.

**One test is not optional: a socket presenting a VALID token for user A, attempting to join a room
by naming user B's id or a board A has no membership on, must be refused.** This is §3.7 written as
an assertion instead of a paragraph — the one property that, if it silently regressed, would turn
this gateway into the exact shape of vulnerability §3.7 describes. It belongs in the suite as its
own named test, not folded into a general "authorization works" case that could pass while this one
path regressed.

### 6.5 Room-join and connection attempts are rate-limited

`apps/api/src/middleware/rate-limit.ts` already exists for this exact shape of problem on HTTP —
repeated attempts against one account or one IP. `apps/realtime` needs the same control on new
connections per IP and room-join attempts per socket. `can()` correctly refusing every attempt in
an enumeration loop (§3.7) is not the same as that loop being free: a single valid token is enough
to attempt joining every board id in the system in a tight loop, and an unbounded refusal path is
still a resource-exhaustion vector and still the reconnaissance phase of the same attack, whether or
not any individual attempt succeeds.

## 7. Decisions — answered on approval

These had no codebase precedent to lean on, which is why they were pulled out of §3 and answered
explicitly rather than defaulted into.

### 7.0 The gateway is its own app

`apps/realtime`, not Socket.io bolted onto `apps/api`'s Fastify instance. CLAUDE.md's layout
already names it (`apps/ api (arriving: realtime, collab, worker)`), and Chat (Phase 5) and Docs
(Phase 6) both land on this process — moving a gateway that already holds open connections is the
expensive version of this decision, and it gets more expensive every phase.

What it does NOT mean is a second copy of anything security-relevant. The gateway imports
`resolveOrgMembership` and `loadTuples` from `@taskflow/api` — the SAME functions the HTTP path
calls, not a reimplementation — for the reason §6.2 gives. A separate app is a separate deployment
unit, not a separate authorization model. The one thing genuinely duplicated is the relay loop
(§3.5), and that duplication is argued for there.

Cost accepted: its own env schema, its own `taskflow_realtime` Postgres role, and the web dev
server has to proxy the WebSocket upgrade the same way it already proxies `/trpc` — same
same-origin reasoning CLAUDE.md gives for why that proxy exists at all.

### 7.1 Reauth is proactive, and the lead time is configuration

The client refreshes through the existing single-flight path and reconnects **while the old token
is still valid**, rather than waiting for the gateway to refuse a stale one. Reactive reauth means
every user gets a visible disconnected window every ten minutes, and — the part that matters more —
it fills the logs with refusals indistinguishable from the enumeration attempts §3.8 asks us to
watch for. A control whose signal is buried in routine noise is not a control.

**The lead time is `REALTIME_REAUTH_LEAD_SECONDS`, not a literal.** It lives in the validated env
schema (guardrail 3) and is bounded there at both ends:

- **Floor of 30 seconds.** Below that a slow refresh does not reliably finish before the token it
  is replacing expires, and proactive reauth degrades into the reactive behaviour it exists to
  avoid — silently, and only for users on bad networks.
- **Ceiling strictly below `ACCESS_TOKEN_TTL_SECONDS`.** A lead time at or above the TTL means the
  token is always "about to expire", so the client reconnects continuously. That is a self-inflicted
  denial of service configured in one line, and the schema refuses it at boot rather than at 3am.

**The client reads the value from the server**, in the handshake acknowledgement — it does not
hardcode 60. That seam is the point: today the value comes from the environment, and when a
platform-settings surface exists it comes from there instead, with no client change and no second
place for the number to live. See §7.6.

### 7.2 Revocation: force-leave for grants, disconnect for sessions

Confirmed as §3.3 proposed, with the split written out so a test can assert it:

| Event                          | Response                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `grant.revoked`                | re-run `can()`; force-leave only the rooms that now fail |
| `member.role_changed`          | re-run `can()`; force-leave only the rooms that now fail |
| `member.removed`               | leave every room belonging to that org                   |
| `session.revoked`              | disconnect the whole connection                          |
| `session.token_reuse_detected` | disconnect the whole connection                          |

The last row is named `session.token_reuse_detected`, not `token.reuse_detected` as §3.3 first
wrote it — `apps/api/src/identity/events.ts` is the authority. Worth spelling out because a
subscription keyed on a name that does not exist raises nothing anywhere: it simply never matches,
and the control is silently absent.

A `grant.revoked` naming a TEAM is handled by re-checking every socket in that org rather than
expanding the team's membership. Expanding it would mean querying the very relation the event says
just changed, and the cheap-but-partial alternative — re-check only the subject id — leaves exactly
the people a team grant was revoked from sitting in their rooms.

The line between the two halves is whether the CREDENTIAL is still good. A revoked board tuple
says "not this room" — kicking that user off every other board they had open is a correctness-free
punishment that makes revoking one share look like an outage. A revoked session says the
credential itself is gone, and there is no room it is still safe in.

### 7.3 `LISTEN`/`NOTIFY` to wake the relay, with the poll as the floor

The audit relay's five-second tick was chosen for a compliance record where lag is invisible.
Realtime is the channel where lag IS the feature, and five seconds of it reads as broken.

Both mechanisms, deliberately, and the ordering matters: the **poll is the correctness guarantee**
and the notification is only a latency optimization. `NOTIFY` is fire-and-forget — not queued for a
disconnected listener, dropped if the notifying transaction rolls back, and missed entirely for the
window a listener's connection was down. A gateway that woke ONLY on notification would lose events
in exactly those cases and have no way to notice. So the drain path is unchanged (`claimPending` →
broadcast → `markDispatched`); a notification just runs it sooner, and the poll behind it means a
missed notification costs latency rather than an event.

The poll interval is therefore free to stay lazy — 5 seconds, inherited from the audit relay,
because it is now a safety net rather than the delivery mechanism.

### 7.4 Wave 2's activity-stream bar stays at "the shape supports one"

As §2 scoped it. A persisted, paginated feed is a read model with its own migration, its own query,
and its own authorization question — which events may this member see in a feed, given that room
membership answered that question only for rooms they had OPEN. None of that is proven by the spine
working, and folding it in would make Wave 2's acceptance depend on a surface nobody has designed.
It is a follow-up.

### 7.5 Rate limits get their own numbers

Not the login middleware's. Legitimate traffic here has a shape the login limiter was never tuned
for: one connection per tab, then a handful of joins, then hours of silence. Wave 1's starting
numbers:

| Control                | Limit                          | What it is actually stopping                                 |
| ---------------------- | ------------------------------ | ------------------------------------------------------------ |
| New connections / IP   | 30 per minute                  | connection floods; reconnect storms from one bad client      |
| Room joins / socket    | 60 per minute                  | the §3.7 enumeration loop, which needs volume to pay         |
| Refused joins / socket | 10 per minute, then disconnect | the same loop, caught faster because refusals are the signal |

The third row carries the weight. A legitimate client's joins essentially never fail — it only asks
for boards the user just navigated to — so a run of refusals is not a user having a bad day, it is
someone finding out which board ids exist. Ten is generous for a real client and cheap for an
attacker to hit.

Numbers, not a law: they are one env-tunable block, and §7.6 is where they eventually move.

### 7.6 Follow-up: a platform-settings surface, and the min-cap policy

Two things this phase deliberately does NOT build, recorded here so they are a decision rather than
an omission:

1. **Runtime platform settings.** `REALTIME_REAUTH_LEAD_SECONDS` and the §7.5 thresholds are
   environment variables today, which means changing one is a deploy. The eventual home is an
   instance- or org-level settings surface (PLAN.md §3.6, Platform) read at runtime.
   `packages/feature-flags` is NOT that home and must not become it — guardrail 7 is explicit that
   flags gate product surface only, and every value listed above is a security-relevant timing or
   abuse control.
2. **A shared min-cap convention.** §7.1's floor-and-ceiling pattern is currently one hand-written
   Zod refinement. Any settings surface that lets these be edited at runtime needs the SAME bounds
   enforced at the write path — a value refused at boot but accepted from an admin form is a bound
   that does not exist. Whatever builds §7.6.1 owns making the cap one definition consulted by both.

---

## 8. Sequencing and cost

Per PLAN.md §13: 3 weeks estimated, following directly after 3.5. Phases 5, 6, and 7 (Chat, Docs,
Voice) do not start until this is done — see §1. The schema fan-out work is already built on
`development-phase4` (PR #15) — not yet merged to `development`.

Wave 1 adds exactly one migration, `0016_realtime_consumer`, and it is smaller than it looks:
the `taskflow_realtime` role plus the three `outbox_dispatch` policies migration 0015's closing
comment already specified, and the `NOTIFY` trigger §7.3 decided on. No new tables, no column
changes, nothing to backfill.
