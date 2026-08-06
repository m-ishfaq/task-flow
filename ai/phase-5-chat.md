# Phase 5 — Chat

**Status: IMPLEMENTED — all four waves shipped, 2026-08-06.** Phase 4's prerequisite (§8) was met
by merging `development-phase4` into this branch before any chat code landed.

Read this header before trusting a phase marker anywhere else — CLAUDE.md records that the §13
roadmap table and its own "Current state" section were both stale through two previous phases.

What shipped, by wave:

| Wave | Scope                                                     | Where                                                |
| ---- | --------------------------------------------------------- | ---------------------------------------------------- |
| 1    | channels, DMs, messages, `/chat` namespace, live delivery | migration 0017, `apps/api/src/chat`, `apps/realtime` |
| 2    | threads, reactions, pins, mentions, read cursors, typing  | migration 0018                                       |
| 3    | file sharing, SSRF-safe link unfurls, slash commands      | migration 0020, `packages/security/outbound-url.ts`  |
| 4    | retention, legal hold, guest access, compliance export    | migration 0021                                       |

Also shipped, not in the original spec: **display names** (migration 0019). §3.1 assumes a DM can be
labelled by its participants, and `identity.users` had only an email — so a DM was titled with an
address, or with the same address twice. ⚠ `apps/api/src/identity` is a human-review surface.

**The §7 open decisions, as resolved:**

1. **Read cursors** (§3.6/§7.1) — own table, own event, excluded from the audit projection by an
   explicit `NEVER_AUDITED` set rather than by omission.
2. **Namespace multiplexing** (§7.2) — one connection, both namespaces. Reuses Phase 4's Manager,
   backoff and join-replay rather than growing a second reconnect path to keep correct.
3. **Guest data model** (§7.3) — a relation tuple, as §3.8 proposed. No new table; `is_guest` marks
   the row for access review and changes nothing about how `can()` reads it.
4. **Can a guest DM?** (§7.4) — **no.** Channel-scoped is the definition of a guest. Also refused on
   public channels, which would be a private channel wearing a misleading label.
5. **Legal hold granularity** (§7.5) — **both.** Per-message covers "preserve this statement";
   per-channel covers "preserve this conversation", including messages written after the hold. A
   hold may be placed on a message already past its window.
6. **Unfurl timing** (§7.6) — **async**, with its own `message.unfurled` event and room-table entry.
   A send never waits on a third-party host.
7. **In-channel search** (§7.7) — deferred to Phase 8, as §2 anticipated. Slash commands needed
   nothing beyond what the existing routes already do.

**Three findings worth carrying forward** — each is a control that looked correct and was not:

- **`closed` on the `can()` target is the whole chat authorization model.** `member` holds
  `channel:read` from the role matrix, so a target built without it allows every private channel and
  every DM in the organization, with a decision trace that reads as entirely correct. Nothing throws.
  `packages/policy/src/decide.test.ts` and `apps/realtime/src/chat-rooms.test.ts` both fail without it.
- **Channel visibility must be decided by `can()`, never by channel TYPE.** A "public, or I hold a
  tuple" filter is right for a member and wrong for a guest, who holds no role grants at all — every
  public channel appeared in an external collaborator's sidebar.
- **The room-table attachment ban must match the resource segment, not a prefix.** Chat's events are
  `message_attachment.*`; a `startsWith('attachment.')` check let every one of them through, and what
  would then reach a channel room is a presigned download URL.

Still open, deliberately: `apps/worker` does not exist, so the retention sweep runs on a timer in
`apps/api` behind `RETENTION_SWEEP_ENABLED` — exactly one instance may set it, because the sweep has
no `SKIP LOCKED` claim. See `retention.scheduler.ts`.

Parent: [PLAN.md](../PLAN.md) §3.2 (Chat), §9 (Real-Time Architecture), §10.6 (Domain events),
§13 (Roadmap). Sibling: [phase-4-realtime.md](phase-4-realtime.md) — Chat is the second channel in
§9's table (`Chat delivery — Socket.io, dedicated namespace — Message fanout, typing, read
receipts — No write path`) and the first real product built on top of the gateway Phase 4 stands
up. Slice procedure: [feature-template.md](feature-template.md).

---

## 1. Why this phase exists

PLAN.md §3.2 describes Chat as public and private channels, DMs, group DMs, threads, reactions,
mentions, per-channel read cursors, file sharing, link unfurls, slash commands, per-channel
retention, legal hold, compliance export, and channel-scoped guest access. That is most of a
product surface, and almost none of it is a new technical problem — it is Work's existing patterns
(comments, attachments, rich text, RLS-scoped services, the outbox) applied to a different table
shape, delivered live over the socket gateway Phase 4 already built for a different purpose.

The one genuinely new thing is **volume and shape of the write path**: Work generates a card
mutation every few seconds per active user; a busy channel generates a message every few seconds
_per channel_, sustained, from people who are typing, not dragging. §10.6's "one producer, five
consumers" model and the outbox still hold, but this is the first phase where the audit chain,
the realtime relay, and the notification fanout all see traffic at a materially different rate
than Phase 3 exercised them at — which is why the risk register (PLAN.md §15) already names "Chat
table growth" as its own line item, months before this phase starts.

## 2. What's in scope, and what is deliberately not

**In scope:** channels (public, private), DMs, group DMs, threads, reactions, edits, pins, saved
items, mentions, typing indicators, presence (reusing Phase 4's), per-channel read cursors and
unread counts, file sharing (reusing the existing attachment pipeline), link unfurls, slash
commands, per-channel retention policies, legal hold, compliance export, channel-scoped guest
access.

**Out of scope, on purpose:**

- **A second realtime gateway.** §3.2 below is explicit: Chat delivery is a namespace on the SAME
  `apps/realtime` process Phase 4 builds, not a new app. Standing up a second Socket.io server
  would duplicate the handshake, room-authorization, and outbox-consumer machinery Phase 4 already
  has to get right once.
- **Voice/SMS/WhatsApp inbox surfacing.** PLAN.md §3.4 puts "SMS and WhatsApp threads surfaced in
  the Chat inbox" under Voice & Messaging (Phase 7). This phase builds the inbox Phase 7 later
  feeds into; it does not build Phase 7's telephony pipeline.
- **Cross-product search over messages.** §10.2's TQL AST already models `type IN (message, page)`
  as a target query shape, but the tokenizer/parser is Phase 8 and cross-product indexing is
  Phase 8/11's job, not this phase's. Chat ships its own in-channel message search only if named
  explicitly in a wave below — see §5.
- **Automation triggers on chat events** ("message posted matching a pattern" — PLAN.md §10.3).
  The automation engine is a Phase 10 consumer of the event bus; this phase's job is only to make
  sure `message.sent` is a real, typed, outbox-carried event for Phase 10 to attach to later, the
  same relationship Phase 4 has to Phase 3's Work events.
- **HIPAA-grade retention/legal-hold guarantees.** PLAN.md §16's open question ("compliance target
  beyond SOC 2 + GDPR... resolve before Phase 7") is explicitly not resolved by this phase. Legal
  hold here means "this message is exempt from the retention job," not a full litigation-hold
  workflow with custodian tracking.

## 3. Structural decisions

### 3.1 A room is a channel, not a board

Phase 4 §3.1 rooms itself around "every place the frontend already scopes a live query" — for
Work that is a board. For Chat, every live query is per-channel: the message list, the typing
indicator strip, the read-cursor/unread badge. **Socket.io room name: `channel:{channelId}`.**

DMs and group DMs get no second room taxonomy. A DM is a `channels` row with `type = 'dm'` (or
`'group_dm'`) whose membership is exactly its participants and which cannot be joined, renamed, or
discovered the way a public channel can — but it still authorizes and rooms identically:
`channel:{channelId}`, gated by the same `channel:read` `can()` check as any other channel. Giving
DMs a separate `dm:{dmId}` room name would mean every consumer of "which room does this event
belong to" (§3.4) needs a channel-type branch it does not otherwise need.

Threads do not get their own room either. A threaded reply is a `messages` row with
`parentMessageId` set, broadcast into the same `channel:{channelId}` room as its parent — a
client viewing the channel sees new thread activity (to render an "N replies" affordance) without
joining a second room per open thread, and a client with a thread panel open filters client-side
by `parentMessageId`, the same way Work's card detail panel filters a card's comments out of a
board-level feed rather than getting its own room.

### 3.2 Chat delivery is a namespace, not a new app

PLAN.md §9's table names Chat delivery "Socket.io, dedicated namespace" — deliberately distinct
from Docs' Hocuspocus, which is a different server. `apps/realtime` gains a second Socket.io
namespace (`/chat`, alongside Work's default namespace, or vice versa) inside the same process
Phase 4 stands up. **The connection handshake is not reimplemented.** A client already holds one
verified access token and one socket connection lifecycle (Phase 4 §3.2); it either multiplexes
both namespaces over that one connection (Socket.io supports this natively — one underlying
connection, multiple namespaces) or opens a second namespace connection with the same auth
middleware Phase 4 already wrote. Either way, `io.use()` token verification, origin checking, and
"rejected outright, not degraded to anonymous" (Phase 4 §3.8) apply unchanged — this phase adds
zero new authentication code, only a new namespace and new room names on the existing gateway.

### 3.3 Room join is `channel:read` through the same `can()` — including the DM case

Same rule as Phase 4 §3.3, aimed at a different resource type: joining `channel:{channelId}`
resolves `channel:read` via `can()`, built from the identical `Subject` (`loadTuples(orgId,
userId)` + membership role) every other authorization decision in this codebase uses. **This is
not a special case for DMs.** A DM's "membership" is expressed as relation tuples the same way a
private channel's is — being a DM participant is what grants `channel:read` on that channel's
tuple, not a parallel code path that checks `participantIds.includes(userId)` inline. Guardrail 2
(`can()` from `packages/policy`, never an inline comparison) does not get an exception for chat's
most private surface; if anything that is the surface where an inline shortcut would be most
damaging to get wrong.

Membership can change mid-connection here more often than on a Work board: being removed from a
channel, a channel being archived, a channel flipping public→private, a guest's access expiring.
All of these follow Phase 4 §3.3's pattern exactly — subscribe to the events that already describe
them (`channel.member_removed`, `channel.archived`, `channel.visibility_changed`, plus Phase 4's
existing `member.removed` / `session.revoked` / `token.reuse_detected`), re-run `can()` for every
socket joined to the affected room, force-leave whoever no longer passes. No new mechanism; this
phase's channel-membership events are simply new entries feeding infrastructure Phase 4 built.

### 3.4 The event→room table gets chat's events, not a chat-specific mechanism

Phase 4 §3.4 already establishes: a fixed literal lookup, event name → room-deriving field,
never a shared table with audit's `RESOURCE_OF`, never derived from a caller string. This phase
adds rows (`message.sent -> channelId`, `channel.archived -> channelId`, ...) to that same table.
No second table, no chat-specific room-resolution code path in `apps/realtime`.

### 3.5 Messages are a REST write; the socket only ever delivers

CLAUDE.md rule 8 ("sockets broadcast; they never write") and PLAN.md §9's table (`Chat delivery...
No — REST writes, socket delivers`) are both explicit, and this phase is where the temptation is
strongest: a chat client emitting `message.sent` directly over the socket and having the gateway
relay it to the room looks like the obvious low-latency design, and is exactly the shortcut §9
calls out by name as "the single most common source of subtle inconsistency in systems like this."
`chat.messages.send` is a normal tRPC mutation — validated, authorized via `comment:create`'s
pattern (see §3.9), audited, outbox-emitted — and the realtime layer only ever broadcasts what that
mutation already committed. The perceived latency cost is the same one Phase 4 already accepted
for card moves: a relay tick, not a round trip through a second protocol.

**Typing indicators are the one deliberate, narrow exception**, and are called out explicitly so
this section is not read as silently contradicting itself. A typing indicator has no persisted
state — there is no row to write, no audit entry to make, nothing for guardrail 11 to require an
event for, because guardrail 11 fires on services that mutate, and nothing here does. `apps/web`
emits a lightweight, unauthenticated-payload-free `typing:start` directly on the already-joined
`channel:{channelId}` room; `apps/realtime` relays it in-process to the room with no service call,
no outbox row, and a short server-side TTL so a client that disconnects mid-type doesn't leave a
stuck indicator. This is the same shape as Phase 4's presence — "in-process, ephemeral, cleared on
disconnect, no persistence" — extended to a second ephemeral signal, not a new precedent for
messages, reactions, or anything that outlives the connection. If a future change wants a second
"it's fine to skip the outbox for this" case, that proposal should read this paragraph and ask
whether it is actually ephemeral-and-unpersisted the way typing is, not assume the exception
generalizes.

### 3.6 Read cursors are the one write in this phase with a genuinely open cost question

A read cursor (`channel_id, user_id, last_read_message_id, last_read_at`) is a per-user mutation
that fires on ordinary scrolling, not on a deliberate user action — plausibly the highest-frequency
write this codebase will have produced by this phase. Guardrail 11 does not carve out an exception
for high-frequency mutations, so a naive implementation hash-chains an audit entry per scroll
event, which is both a compliance-record shape that means nothing (an owner does not want to see
"read cursor advanced" a thousand times in the audit log) and a write-amplification problem the
audit chain's per-org chain-head lock (CLAUDE.md, Phase 2 notes) was never sized for.

This needs an explicit call before Wave 2, not a default — see §7.1. The candidate answer: read
cursors live in their own table, written through a dedicated small service that still emits a
typed event (satisfying guardrail 11 mechanically) but whose event is consumed by unread-badge
sync and NOT projected into `audit.audit_log` — the same "one event stream, two projections" split
§10.6 and CLAUDE.md's Phase 2 notes already describe for `platform.activities` vs the compliance
record, just with the read-cursor projection intentionally empty on the audit side. That is a
real design decision about what "every state-mutating service method emits a typed domain event"
is FOR, not a loophole, and deserves sign-off rather than quietly deciding it.

### 3.7 Retention and legal hold are a background job that must stay RLS-honest

Per-channel retention deletes messages older than a configured window; legal hold marks specific
messages (or a whole channel) exempt from that deletion regardless of the configured window. Two
things make this a slice worth naming carefully rather than "a cron job that runs a DELETE":

- **The job iterates across orgs, and nothing about that licenses `withGlobalScope`.**
  `feature-template.md`'s anti-patterns section already warns against reaching for a global-scope
  escape hatch when a query looks awkward under RLS; a retention sweep is the one background
  process in this codebase whose job description is literally "touch every org," and the correct
  shape is the outbox/audit-relay pattern already proven twice (Phase 2's audit relay, Phase 4
  §3.5's realtime relay): enumerate orgs, then `withOrgScope(orgId, fn)` per org, one transaction
  per org's batch. A single unscoped query across all tenants is the tenancy bug guardrail 8's
  fuzz harness exists to catch, run on a schedule instead of behind a route.
- **Legal hold has to be checked inside the same transaction as the delete, not before it as a
  separate read.** A message placed on hold between the retention job's "which messages are
  eligible" read and its DELETE is the race this design has to close by construction — the delete
  statement's WHERE clause carries the hold check directly (`WHERE occurred_at < :cutoff AND NOT
legal_hold`), not a two-step "check then delete."

Retention deletions are still domain events (`message.deleted`, with a reason field distinguishing
`user` from `retention_policy`) — the audit trail should show a message was removed by policy, not
go silent, which is the opposite problem from §3.6's read cursors: here the mutation is rare
enough (one job tick per org, not per scroll) that the audit chain cost is a feature, not a
liability.

### 3.8 Guest access is a policy-surface change, not a chat-local flag

"Channel-scoped guest access for external collaborators" (PLAN.md §3.2) means a person who is not
an org member can hold `channel:read`/`channel:post` on specific channels. That is new shape for
`packages/policy`, which is on CLAUDE.md's human-review allowlist already — this phase does not
get to add a guest concept as a chat-package-local `if (isGuest)` check. The candidate design is a
new relation-tuple type (a guest's tuple names the channel directly, the same way §3.3's DM
membership names the channel rather than the org) rather than a role, because a guest is
explicitly NOT a role a member holds — they hold no org membership row at all, which is a
departure from every authorization decision so far in this codebase resting on `resolveOrgMembership`
finding a membership. §7.3 flags the open question; the size of that departure is why this piece
of the phase gets its own wave (§5) rather than shipping alongside ordinary channels.

### 3.9 Two authorization questions again, same shape as Work's card detail

CLAUDE.md's Phase 3 notes describe Work's card detail keeping "managing the vocabulary" (project-
level, `project:update`) separate from "filling one in" (card-level, `card:update`), and comments
as `comment:create` rather than `card:update` specifically so a commenter relation can exist.
Chat's shape is the same split: creating/archiving/renaming a **channel** is a channel-management
action (`channel:update`, held by whoever administers it); **posting** in it is `message:create`,
held by any member — including a guest holding nothing else. Editing a message is author-only with
no override, for the identical reason comment edits are (CLAUDE.md: "a discussion where an
administrator can put words in your mouth is not a record of anything"); deleting is
author-or-moderator, and the deletion event records which, exactly like comment deletion does
today.

### 3.10 Files and link unfurls reuse existing controls; they are not exemptions

**Attachments.** Chat file sharing is the existing `packages/storage` / magic-byte / ClamAV
pipeline (CLAUDE.md, Phase 3 attachments notes) pointed at a `channelId` instead of a `cardId` —
not a second upload pipeline. Phase 4 §4 already excludes `attachment.*` from the realtime event
catalog by name, for a reason that applies identically here: a presigned download URL is a bearer
credential, and broadcasting one to a room hands it to everyone currently subscribed. Chat's
`message.sent` payload for a message with an attachment carries `attachmentId` only; the client
re-requests a presigned URL through the normal authorized HTTP path, same as Phase 4 specifies.

**Link unfurls.** PLAN.md §8.7 already names the control this needs before it exists: "Outbound
webhook and unfurl URLs validated against an allowlist; private IP ranges blocked; redirects not
followed." An unfurl is a server making an outbound HTTP request to a URL a user typed into a
message — the textbook SSRF shape — and this phase does not get to treat that control as optional
because it ships as "just a preview card." The fetch happens server-side, through whatever
allowlist/redirect-blocking component the SSRF control already specifies, with a strict timeout, a
capped response size, and no credential ever attached to the outbound request.

## 4. Event catalog for Phase 5

New events this phase adds to `packages/events` (extending, not replacing, §10.6's registry):

```
channel.created · channel.updated · channel.archived · channel.visibility_changed
channel.member_added · channel.member_removed · channel.guest_invited · channel.guest_revoked
message.sent · message.edited · message.deleted · message.pinned · message.unpinned
message.reaction_added · message.reaction_removed
read_cursor.updated            (event shape TBD — see §3.6 / §7.1)
```

**Deliberately excluded, and why:**

- `typing.*` — never a domain event; §3.5 covers the ephemeral, in-process exception.
- `attachment.*` — already excluded by Phase 4 §4 for the identical bearer-credential reason;
  chat's file messages reuse that exclusion rather than needing their own.
- `presence.*` — Phase 4 already treats presence as Socket.io's own room membership, not an
  event; chat's presence is the same mechanism, no new event.

`message.sent`'s payload carries `channelId`, `parentMessageId?` (threads), and enough of the rich
text for the notification consumer to resolve `@mentions` — reusing the existing rich-text
node/mark whitelist (CLAUDE.md's `work/richtext.ts` notes) rather than inventing a second mention
syntax, since a mention is structurally the same "an attribute becomes a notification trigger"
shape a link's `href` already is.

## 5. Waves

### Wave 0 — prerequisite check, not a build wave

Confirm Phase 4 Wave 1 + Wave 2 acceptance criteria are met against a real `apps/realtime`
deployment (two tabs, live card move, force-leave on revocation, the identity-spoofing refusal
test) before any chat code lands. This phase has no independent gateway to fall back on if Phase 4
is only partially done — see §8.

### Wave 1 — channels, DMs, messages, live delivery

- Channel and message schema (`channels`, `channel_members`, `messages`), migrations paired
  up/down per `feature-template.md` §3.
- `channel:read` / `channel:update` / `message:create` added to `packages/policy`'s action union
  and role matrix, with authz-matrix test cases (guardrail 9).
- `chat.channels.create/list/archive`, `chat.messages.send/edit/delete` routers — thin, delegate
  to services, every service method emitting per guardrail 11.
- `/chat` namespace on `apps/realtime`; room join reusing Phase 4's connection auth, gated by
  `channel:read`; `message.sent`/`edited`/`deleted` wired through the event→room table.
- `apps/web`: channel list, a single flat message view (no threads, reactions, files, or mentions
  yet), messages arriving live the way a card move does in Phase 4 Wave 1.
- **Acceptance:** two tabs in the same channel see a sent message live, within one relay tick. A
  tab in a channel the user isn't a member of cannot join its room. A DM channel behaves
  identically to a private channel with respect to `can()` — no inline participant check anywhere
  in the join path (§3.3). A message edit/delete respects the author-only / author-or-moderator
  split (§3.9).

### Wave 2 — threads, reactions, pins, mentions, read cursors, typing

- Threaded replies (`parentMessageId`), reactions, pins, saved items.
- Mentions wired to the existing notification fanout (§10.6), reusing rich-text mention parsing.
- Read cursors and unread counts — **blocked on §7.1's call being made**, not built against a
  default.
- Typing indicators per §3.5's ephemeral exception.
- **Acceptance:** a threaded reply is visible in the channel feed and the thread panel from a
  second client without a refresh. A read cursor update from one of a user's two open tabs clears
  the unread badge on the other. Typing indicators appear and clear within their TTL with no
  outbox row produced.

### Wave 3 — files, link unfurls, slash commands

- File sharing through the existing attachment pipeline, scoped to `channelId`.
- Link unfurls through the SSRF-safe fetcher (§3.10).
- Slash commands — scoped to whatever the command set is at this point; likely thin given no
  automation-engine consumer exists yet (Phase 10).
- **Acceptance:** an uploaded file is downloadable only via a freshly authorized presigned URL,
  never the URL broadcast directly (mirroring Phase 4 §4's test for the same property on Work
  attachments). An unfurl request against a private/internal IP is refused before any outbound
  fetch happens.

### Wave 4 — retention, legal hold, guest access, compliance export

- Per-channel retention policy configuration and the org-iterating retention job (§3.7).
- Legal hold flag and the race-free delete-with-hold-check (§3.7).
- Guest access (§3.8) — the `packages/policy` change, on the human-review allowlist, with an
  adversarial second-AI-pass per CLAUDE.md before merge.
- Compliance export.
- **Acceptance:** a message under legal hold survives a retention sweep that would otherwise
  delete it, proven by a test that races the two rather than asserting them in sequence. A guest
  can read/post in exactly the channels they were invited to and nothing else, exercised by the
  same table-driven authz-matrix shape guardrail 9 already uses, extended with a guest row.

## 6. Cross-cutting obligations

### 6.1 Sockets still never write

Restated because this phase is where the temptation is highest (§3.5): every message, edit,
delete, reaction, and pin goes through the API. The gateway broadcasts what already committed.

### 6.2 The gateway never re-derives authorization

Same rule as Phase 4 §6.2, extended to channel membership and guest tuples: `apps/realtime` asks
`can()` for `channel:read`; it does not grow a local notion of "who's in this channel."

### 6.3 The wire lies about dates here too

`message.sent`'s `occurredAt`, a read cursor's `lastReadAt`, and every other timestamp in a chat
broadcast are strings over the wire until `wire()` is called, per Phase 4 §6.3 and CLAUDE.md's
Phase 3 `lib/wire.ts` notes. No new problem, same discipline.

### 6.4 Tests ship with the slice

Beyond the acceptance criteria per wave: a room-join test proving `can()` is actually consulted for
a DM channel specifically (not just a public one — §3.3's point is that DMs are not a shortcut
around `can()`), a tenancy-fuzz entry (guardrail 8) for every new chat mutation the way
`tenancy-fuzz.test.ts` names Work's 14 mutations explicitly, an authz-matrix extension (guardrail 9) covering the guest role, and a retention-vs-legal-hold race test per Wave 4's acceptance
criterion.

### 6.5 Rate limiting

`apps/api/src/middleware/rate-limit.ts`'s per-account/per-IP shape needs chat-specific numbers:
message-send rate per user per channel (spam), and a strict timeout/size cap on the link-unfurl
fetcher specifically, since an SSRF-safe allowlist does not by itself bound how much time or
memory a single unfurl request can consume.

## 7. Open decisions — need a call before or during Wave 1/2

1. **Read cursor write path and audit granularity (§3.6).** Whether read cursors get a real
   guardrail-11 event that skips the audit projection, or a different mechanism entirely (e.g., a
   dedicated non-audited table with no domain event, if that can be justified as legitimately
   outside guardrail 11's scope the way `rebalance.ts` is — CLAUDE.md's Phase 3 notes name that as
   the exception for repositories that "mutate by design"). Needs an explicit decision, not a
   default; this is the one write in the phase with a real chance of drowning the audit chain.
2. **Namespace multiplexing vs. a second socket connection (§3.2).** Socket.io can multiplex
   namespaces over one underlying connection or open a second; which one `apps/web` uses affects
   reconnect/backoff behavior when Work and Chat are both open in the same tab.
3. **Guest access data model (§3.8).** A new relation-tuple type in `packages/policy` vs. some
   lighter-weight channel-only ACL that isn't `can()`-shaped at all — the latter would violate
   guardrail 2 outright, but is worth naming as the wrong answer explicitly rather than assuming
   nobody proposes it.
4. **Can a guest DM an org member, or start a group DM at all?** Guests are channel-scoped by
   design; DMs are a channel type. Whether that combination is allowed, and what `can()` decides
   about it, needs an explicit answer rather than falling out of whatever the guest tuple happens
   to permit.
5. **Legal hold granularity.** Per-message flag vs. per-channel hold vs. both — affects the
   retention job's query shape and whether a hold can be placed retroactively on messages already
   past their retention window at the moment the hold is set.
6. **Link-unfurl caching and timing.** Synchronous fetch-then-send (blocks the send on an
   arbitrary outbound request — bad) vs. async fetch-then-`message.edited` (means every unfurled
   message re-broadcasts once more) — needs a decision, and the async path needs its own entry in
   the event→room table if chosen.
7. **In-channel message search scope for this phase**, per §2's exclusion of cross-product search
   — confirm whether Wave 3's slash commands need anything beyond exact/recent-message lookup, or
   whether search is entirely deferred to Phase 8.

---

## 8. Sequencing and cost

Per PLAN.md §13: 8 weeks estimated, following Phase 4. **This phase does not start until Phase 4's
Wave 1 and Wave 2 acceptance criteria are met** (`ai/phase-4-realtime.md` §5) — not "Phase 4 is
merged," but specifically that `apps/realtime` has a real connection-auth handshake, a real
room-join `can()` check, the outbox's `'realtime'` consumer draining in production, and the
identity-spoofing refusal test passing, because Wave 1 of this phase (§5) adds a namespace and room
table entries to that exact machinery rather than building any of it itself. Starting Chat
implementation before those criteria are met means building against a gateway whose own
authorization model (Phase 4 §3.3, §3.7) is still unsettled — the same mistake §1 of
`phase-4-realtime.md` warns against for its own §3.

As of this draft, Phase 4 is pre-implementation (spec status: DRAFT, only the outbox fan-out
groundwork on `development-phase4`/PR #15 exists, not yet merged to `development`). Sections 1–4 and
§7's open questions here can be reviewed and argued over in parallel with Phase 4 landing — the
same way this document itself was written before Phase 4 shipped — but no wave in §5 starts before
§8's prerequisite is real.
