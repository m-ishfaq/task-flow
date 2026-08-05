# Phase 4 — Realtime spine

**Status: DRAFT — not yet approved.** Written to be reviewed and argued with, the same way
`phase-3.5-work-ux.md` was before its own approval. Nothing here should be built until the
structural decisions in §3 are settled, for the same reason `feature-template.md` puts permission
before code: getting §3 wrong is expensive to unwind once a gateway is broadcasting to real
clients, and cheap to argue about now.

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

The six things worth getting right before any gateway code exists.

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

## 4. Event catalog for Wave 1 — nothing new to define

Every event this phase broadcasts already exists (`apps/api/src/work/events.ts`) and already flows
through the outbox in its own transaction (guardrail 11). This phase is a BROADCASTER, not a new
producer:

```
card.created · card.updated · card.moved · card.assigned · card.archived · card.status_changed
list.created · list.updated · list.reordered · list.archived · list.rebalanced
board.created · board.updated · board.archived
comment.created · comment.updated · comment.deleted
checklist.* · custom_field.* · label.* · view.*
```

No new `defineEvent()` calls, no new payload schemas. The event→room table in §3.4 is the only new
mapping this phase introduces.

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
  tick of the `grant.revoked` event.

### Wave 2 — full catalog, presence, reconnect

- Every event in §4 wired through the room table.
- Presence: in-process, ephemeral, per §9 — who else has this room open, no persistence, cleared on
  disconnect. Socket.io's own room membership is presence; this is mostly a client-side avatar
  stack reading `io.sockets.adapter.rooms`, not a new data model.
- Reconnect-and-diff (§9): on reconnect, the client refetches the board's queries rather than
  replaying a missed-event log — `apps/web` already has this shape in `refetchOnReconnect: true`
  (`lib/query.ts`); Wave 2 is confirming the socket's own reconnect triggers it, not building a new
  mechanism.
- Session/membership-revocation force-disconnect (§3.3) extended to every event named there, not
  just the one Wave 1 proved.
- **Acceptance:** every board interaction Phase 3.5 shipped (drag, quick-assign, comment, status
  change, checklist toggle) is visible to a second viewer live. A socket that drops for thirty
  seconds and reconnects ends up in the same state a hard refresh would have produced.

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

## 7. Open decisions — need a call before or during Wave 1

Unlike §3, these don't have a codebase precedent to lean on and should get an explicit answer
rather than a default nobody chose on purpose.

1. **Reauth cadence (§3.2).** Reconnect-on-refresh is proposed, but the exact trigger — client
   disconnects proactively when the token has, say, 60 seconds left, vs. waits for the gateway to
   reject a stale token and reconnects reactively — changes whether a user ever sees a visible gap.
2. **Force-leave vs. full disconnect (§3.3).** A revoked board `viewer` tuple should probably leave
   just that room; a revoked SESSION should probably close the whole connection. Worth confirming
   that split rather than assuming it.
3. **Relay tick interval for the realtime consumer.** The audit relay's 5 seconds was chosen for a
   compliance record, where a few seconds of lag is invisible. Realtime is the channel where lag is
   the whole point of the feature — worth deciding whether it needs a shorter tick, a
   `LISTEN`/`NOTIFY` wake-up instead of polling, or is fine inheriting the same number until it
   demonstrably isn't.
4. **How far "activity stream" goes in Wave 2.** §2 scopes it to "the broadcast shape supports one"
   — confirm that's the intended bar for Phase 4, versus pulling a minimal persisted feed in now.

---

## 8. Sequencing and cost

Per PLAN.md §13: 3 weeks estimated, following directly after 3.5. Phases 5, 6, and 7 (Chat, Docs,
Voice) do not start until this is done — see §1. No migration beyond the `'realtime'` consumer rows
added to `outbox_dispatch` in Wave 1; the schema fan-out work is already built on
`development-phase4` (PR #15) — not yet merged to `development`.
