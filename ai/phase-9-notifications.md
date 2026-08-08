# Phase 9 — Notifications

**Status: Wave 1 core landed the same day, ahead of §7's answers being confirmed by a human.**
Written the way `phase-3.5-work-ux.md` and `phase-4-realtime.md` were before their own approval
dates: argued from the actual code that exists today, with the genuinely open calls pulled into
§7 instead of silently decided. §7's items are still open — they were reasonable defaults to build
against, not decisions a human signed off on, and are worth a real look before anything here is
called done.

**Revised same day, before approval.** Two decisions this draft originally left as a gap and a
narrow default were resolved and folded in rather than left for Wave 1 to discover: PLAN.md §13
now schedules **Phase 11.5 (People)**, so §2, §3.7, and §3.9 reference a concrete future phase
instead of an unscheduled module; and `platform.push_subscriptions` (§3.7) is deliberately shaped
as a device row rather than a bare endpoint/key pair, so Phase 12's device inventory reads from it
instead of redesigning around it. §8 spells out the resulting (one-directional) relationship.

**What's actually built vs. still just designed, since this file's own prose doesn't distinguish
them anywhere else:** migration 0027, the widened `kind`/`subject_type` usage, `identity.notification_prefs`
(§3.3 — moved there from the `platform.notification_prefs` this draft originally specified; see
that migration's own header for why), `notification_deliveries`, the generalized projection
(`apps/api/src/platform/notification.projection.ts`, covering `card.assigned` and both products'
comment-mentions alongside chat), immediate email delivery (`packages/mail`'s
`renderNotificationEmail`), the `notifications`/`notifications.prefs.*` tRPC routes (via a new
`memberRoute` builder — §3.5's `selfRoute`-only assumption for these turned out wrong; see
`trpc/builder.ts`), and bell navigation to the right product's page for a card or Docs
notification. **Not built**: the personal realtime room (§3.5), digests (§3.4), due-date reminders
and `taskflow_notification_sweep` (§3.8), web push and `platform.push_subscriptions` (§3.7), and a
dedicated preferences page in `apps/web` (routes exist; no UI calls them yet). All of Wave 2, in
other words, plus one piece of Wave 1's own scope (the realtime room and the prefs UI).

Parent: [PLAN.md](../PLAN.md) §3.6 (Platform), §7 (`platform.notifications`,
`notification_prefs`), §10.6 (Domain events), §13 (Roadmap, row 9).

---

## 1. Why this phase exists

Chat already has a notification system, on purpose a narrow one. Migration `0022`'s own header
says so directly:

> PLAN.md puts the notification SYSTEM — digests, per-channel preferences, email and push
> delivery, the whole preference matrix — in a later phase, and that is still where it belongs.
> What this table is, deliberately, is the narrow thing chat cannot work without... So
> `platform.notifications` is deliberately minimal, and Phase 9 is expected to ADD to it... rather
> than replace it.

That table has been carrying real traffic since Phase 5: `apps/api/src/chat/notification.projection.ts`
drains `message.sent` under its own outbox consumer name (`'notifications'`), and
`apps/web/src/features/chat/notification-bell.tsx` reads it. But everything about it is chat-only
and in-app-only:

- The `kind` CHECK constraint accepts exactly three values, all `chat.*`.
- Nobody is told anything unless they have the tab open — there is no channel but the bell.
- There is no `platform.notification_prefs` table. PLAN.md §7's schema table names it; it does
  not exist in `packages/db/src/schema/platform.ts` yet.
- A card assignment, a `@mention` in a card comment, a Docs page comment, a due date arriving —
  none of these produce a notification today, even though `work.cards` already carries a
  `dueDate` column with a partial index built for exactly this (`work.ts:240`,
  `WHERE due_date IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL`), and Work's
  `comment.created` payload already carries a field whose own comment says "Notifications need
  words, not a document" (`apps/api/src/work/events.ts:544`) — written before this phase existed,
  for this phase.

This phase is that: cross-channel routing, batching, preferences, and due reminders, built as an
addition to what Phase 5 already proved rather than a parallel system.

## 2. What's in scope, and what is deliberately not

**In scope:** email and web-push delivery alongside the existing in-app channel; a per-category
preference matrix; daily digests; due-date reminders; extending the existing chat-only projection
to Work (`card.assigned`, `comment.created` mentions) and Docs (`page.comment_created` mentions).

**Out of scope, and why each one is a real constraint rather than a preference:**

- **SMS delivery is designed into the schema and stubbed at the send boundary.** PLAN.md's own
  roadmap line for this phase says "in-app/email/SMS/push" — but sending SMS needs a
  `TelephonyProvider` with a real subaccount, spend caps, and geo-allowlisting (§8.5), and that is
  Phase 7's deliverable, not built. §3.7 below designs the channel enum and preference matrix to
  include `sms` now, so the schema does not need a second migration when Phase 7 lands, while the
  actual send is a no-op behind the existing `telephony` flag (`packages/feature-flags/src/flags.ts`)
  until a real provider exists. This is the same shape §5's provider interfaces already use
  elsewhere — a free/stub implementation behind an interface that does not change when the real
  one arrives.
- **Push is genuinely new — there is no `PushProvider` in PLAN.md §5's table at all.** §3.7 covers
  the gap and the recommended fill.
- **Quiet hours cannot read a canonical user timezone, because there isn't one yet.** PLAN.md §13
  now schedules Phase 11.5 (People) to own "timezones, working hours" — added to the roadmap
  alongside this draft, specifically because this phase needed the field and People did not exist
  to own it. `identity.users` has no timezone column today (confirmed against
  `packages/db/src/schema/identity.ts`). §3.9 below scopes quiet hours to a timezone captured on
  the preference row itself, not a claim about the person's canonical profile — so this phase does
  not collide with what Phase 11.5 will later own, and Phase 11.5 is free to become the source that
  field defaults from without a migration conflict.
- **No `apps/worker` / pg-boss.** Same accepted placeholder CLAUDE.md and `apps/api/src/tenancy/relay.ts`
  already use for the audit relay: "the relay belongs in `apps/worker`... and that app does not
  exist until [it exists]... A timer in the API is the smallest thing that makes \[this] real
  today." Digest batching and the due-reminder scan (§3.4, §3.8) extend that same timer rather
  than standing up a scheduler.
- **No device management UI, but the schema is built as its future seed.** Phase 12 still owns the
  actual device/session inventory screen, and Phase 11.5 still owns canonical profile data — this
  phase ships no device-list UI. But `platform.push_subscriptions` (§3.7) is deliberately shaped as
  a per-device row (endpoint, key, a parsed user-agent label, `createdAt`, `lastSeenAt`), not a bare
  credential blob, specifically so Phase 12's device UI can read directly from it as one of its
  sources rather than Phase 9 inventing a throwaway shape Phase 12 has to redesign around. Confirmed
  with PLAN.md's Phase 12 row, which now cross-references this table.
- **No native mobile push.** The tech stack (PLAN.md §4.1) is React 19 + Vite — a web app, no
  mobile client exists. "Push" in this phase means the Web Push API (browser + service worker),
  not FCM/APNs. Native push is a Phase-12-or-later question, contingent on a mobile app existing
  at all.

## 3. Structural decisions

### 3.1 Extend `platform.notifications`; do not replace it

Migration 0022 already anticipated this. Two details in the existing schema are load-bearing and
were put there for this phase specifically:

- `kind` is a `CHECK`, not a Postgres enum — "adding a value to an enum is a harder migration than
  it needs to be, and Phase 9 will add several" (0022's own comment). Wave 1 adds
  `card.assigned`, `card.comment_mention`, `card.due_soon`, `page.comment_mention` to that check.
- `subject_type` already allows `'card'` and `'page'`, not just `'message'` — the CHECK constraint
  in `0022_chat_saved_and_notifications.up.sql` is
  `CHECK (subject_type IN ('message', 'card', 'page'))`, and nothing in Phase 5 or 6 ever writes
  `'card'` or `'page'`. That is Phase 9's row waiting to be filled, not a new column.

So Wave 1's schema change to `platform.notifications` itself is small: widen the `kind` check,
nothing else. The row shape (`title`/`excerpt` snapshot, no FK to the subject, one row per
recipient) is exactly right for Work and Docs too, for the identical reasons chat's rows needed
it — a card can be archived, a page comment retention-swept, without erasing the record that
someone was told something.

### 3.2 Delivery state is a separate table from the notification record

`platform.notifications.readAt` answers "did the recipient open the bell entry." It must not also
answer "did the email send," because those are independent facts with independent failure modes —
an email can bounce after the in-app row is already correctly marked unread, and marking the bell
read must never look like a resend.

New table, `platform.notification_deliveries`: one row per `(notificationId, channel)`, with a
status (`pending | sent | failed | suppressed`) and a reason for `suppressed` (`quiet_hours`,
`pref_disabled`, `digest_pending`). This is the same shape `platform.attachments.status` already
uses for its own pipeline (`pending → scanning → clean | infected | rejected`) — a state machine
on one column, not a boolean. `suppressed` matters as its own state rather than simply "not sent":
an admin debugging "why didn't I get an email" needs to see _that a decision was made_, not
silence indistinguishable from a bug.

The in-app channel does **not** get a row here — the `platform.notifications` insert itself _is_
the in-app delivery, atomically, in the same transaction the existing projection already runs.
Giving in-app a synthetic `notification_deliveries` row would only be tracking that a write
succeeded a moment after it succeeded.

### 3.3 Preferences are a category × channel matrix, defaulted like feature flags

A full `kind × channel` matrix is the wrong grain — it is already seven kinds after Wave 1
(`chat.mention`, `chat.direct`, `chat.thread_reply`, `card.assigned`, `card.comment_mention`,
`card.due_soon`, `page.comment_mention`) times three channels, and every kind added later widens
it further. `platform.notification_prefs` keys on `(orgId, userId, category, channel)`, where
`category` is a small fixed set (`direct` — mentions, DMs, assignments; `activity` — replies,
comments, due reminders) that groups kinds the same way `PROJECT_SCOPED_PREFIXES` groups events in
`apps/realtime/src/event-rooms.ts` — a short, closed, reviewed list, not something a caller
supplies.

**Absence of a row means the coded default, exactly like `FLAGS`' `defaultValue`.** Nobody needs a
migration-time backfill inserting a row per existing user per category per channel — the
preference _evaluator_ (a `packages/feature-flags`-shaped module, not that package itself:
guardrail 7 is explicit flags gate product surface only, and a notification preference is user
choice, not a security control or a release gate) consults a small hardcoded default table first,
an explicit row second. Defaults for Wave 1: `direct` → email on, push on; `activity` → email off
(digest only), push off. In-app is **always on and not in the matrix at all** — turning off your
own bell is not a preference this phase needs to support, and leaving it out of the matrix removes
an entire "what if every channel is off" edge case.

### 3.4 Digests batch delivery, never the record

The `platform.notifications` row is written immediately, by the same at-least-once,
idempotent-by-unique-index projection Phase 5 already proved. Nothing about _that_ changes.

A digest is a batching of the **email channel's delivery**, not a second copy of the notification.
Once a day (configurable per user, single daily cadence for Wave 1 — see §7), a scan collects each
user's `activity`-category notifications since their last digest, still `pending` in
`notification_deliveries`, and sends one email covering all of them, writing every covered row to
`sent` in one pass. `direct`-category notifications never sit in a digest — they were already sent
immediately per §3.3's defaults, and a `@mention` arriving in tomorrow's digest instead of tonight
defeats the point of mentioning someone.

The in-app bell is never batched. Batching it would undo what `notification-bell.tsx` already does
well: every unread row is there the moment it is written, full stop.

### 3.5 A personal realtime room — safe, because Phase 4 already drew this line

`ai/phase-4-realtime.md` §3.7 is explicit that a client-asserted identity in a socket payload is
the shape of the most damaging class of Socket.io bug, and closes with: "if a future change needs
a second personal channel, a second identity field... that change is the vulnerability, not a
shortcut around one." That is not a ban on a personal channel — it is a requirement on how one gets
built. This phase is the "future change," and it satisfies the requirement rather than working
around it:

- The room is `user:{socket.data.userId}` — the _same_ server-set, handshake-verified identity
  every other handler in `apps/realtime` already reads (§3.2 of that spec). No client message ever
  names it.
- **The gateway auto-joins every authenticated socket to its own room at connection time.** There
  is no `user:join` request for a client to send, and therefore nothing for a client to lie about.
  This is the one room in the system that needs no `can()` check, for the same reason a person
  never needs permission to read their own mailbox: the join is driven entirely by server-known
  state, not by a request naming a target.
- Unlike `board:{boardId}` or `channel:{channelId}`, this room's membership is provably one
  identity, possibly across several of that identity's own tabs. The payload-minimality argument
  in `event-rooms.ts` (never broadcast an attachment's presigned URL to a room, because the room's
  audience is everyone subscribed, not the one caller who asked) does not transfer here — there is
  no "everyone subscribed" to overshare to.

**What actually gets broadcast is still minimal, but for a different reason: consistency with the
existing UI, not security.** `notification-bell.tsx` already reads via TanStack Query
(`notificationCountQuery`, `notificationsQuery`) on a poll. The realtime addition is the
**INVALIDATE** strategy `ai/phase-4-realtime.md` §5 already established as one of three named
strategies (PATCH / ADJUST / INVALIDATE) for exactly this kind of choice — the payload is
`{ userId }` alone, and the client's only reaction is to invalidate those two queries. Building a
bespoke patch path for a feature that already polls correctly would be new surface for a marginal
latency win.

**The mechanism for getting the broadcast onto the wire is the existing outbox, run once more.**
`apps/realtime` is a separate process from `apps/api` (§7.0 of the realtime spec) and cannot call
into the running notification projection directly. The projection, after inserting a
`platform.notifications` row inside its own transaction (still `withAuditScope`, still the
`'notifications'` outbox consumer for the _original_ event), appends one more row to
`platform.outbox` itself: `notification.created`, payload `{ userId, notificationId }`. This is a
second-order event — a consumer producing an event about its own write — which has no precedent in
this codebase yet, so it is called out explicitly rather than assumed. It is safe for the same
reason guardrail 11 wants events colocated with the mutation they describe: the insert into
`platform.notifications` and the `notification.created` outbox row commit in the same transaction,
so a broadcast is never sent for a notification that did not actually get written, and a written
notification never fails to get a broadcast queued for it.

`apps/realtime`'s existing `'realtime'` consumer routes it with a new, tiny resolver —
`roomUserIdOf`, structurally identical to `roomBoardIdOf` in `event-rooms.ts` (one event name, one
fixed payload key, no lookup) — to `user:{userId}` instead of `board:{boardId}`. No new consumer,
no new relay loop; one new row in an existing table-shaped lookup.

### 3.6 Email reuses `packages/mail`, generalized beyond credentials

`packages/mail/src/index.ts`'s own header currently reads: "The messages this package sends are
the verification and password-reset links, which are credentials rather than notifications." That
sentence is accurate today and becomes wrong the moment this phase ships — it needs to be edited,
not worked around. The package itself does not need new architecture:

- `MailQueue` already has the retry/backoff/abandon behavior a notification email needs, and its
  own docblock already names the eventual upgrade path this phase does **not** need to take yet:
  "The durable version is the transactional outbox... driven by a real worker process — this is
  the Phase 1 shape, and the interface does not change when that arrives." Still true; still not
  this phase's problem to solve.
- `Mailer` (`SmtpMailer` / `MemoryMailer`) is already the provider-interface seam §5 asks for.
  Nothing changes there.
- What is new: a `templates.ts`-shaped module for notification and digest bodies, and call sites
  in the (extended) notification projection and the digest sweep.

The timing-oracle discipline `queue.ts` exists for (`requestPasswordReset` must not leak account
existence through send latency) does not apply to a notification email — there is no secret
being protected by constant timing here. The **non-blocking enqueue-and-return** discipline still
applies for an unrelated reason: a comment or card-assignment mutation must not wait on SMTP to
complete its own response.

### 3.7 Web Push needs a new `PushProvider`; SMS is designed-in but stubbed

PLAN.md §5's Provider Interfaces table has no push row today — this is a genuine gap, not an
oversight to route around. Proposed addition, in the same table shape as the other six:

| Interface      | Free implementation                       | Paid upgrade                  | Trigger to switch  |
| -------------- | ----------------------------------------- | ----------------------------- | ------------------ |
| `PushProvider` | Web Push (VAPID) — no third-party service | Native mobile push (FCM/APNs) | A mobile app ships |

Web Push needs no paid tier at any volume this project will reach solo — it is a direct
browser-to-service-worker protocol, not a message broker with a free quota to outgrow. VAPID
key generation and request signing are a cryptographic primitive, so per CLAUDE.md rule 5 the
signing code lives in `packages/security` (a new `web-push.ts`, one file per primitive, same as
every other entry there) — `apps/api` calls it, never `node:crypto` or a push library directly.

**`platform.push_subscriptions` is shaped as a device row, not a bare credential.** The minimum
this phase needs is `(userId, endpoint, keys)`. It ships with three more columns anyway —
`userAgentLabel` (parsed at registration time into something a person recognizes, e.g. "Chrome on
macOS"), `createdAt`, `lastSeenAt` (touched on every successful push) — because PLAN.md's Phase 12
row now names this table as one of its sources for the device/session inventory screen. Shipping
the narrower shape now and widening it later would mean either a migration Phase 12 has to write
before it can start, or Phase 12 building its own parallel device concept and reconciling two
tables that describe overlapping things. The extra three columns cost nothing this phase doesn't
already have to compute (the registration request already carries a user-agent header; `lastSeenAt`
is one `UPDATE` alongside the existing send). This phase still ships **no UI** beyond "push
notifications: on/off" in the preferences page (Wave 2) — a full device list with per-device revoke
is Phase 12's screen to build, reading a table that already has what it needs.

**SMS is the deliberately-unfinished half.** The channel enum in `notification_prefs` and
`notification_deliveries` includes `sms` starting in Wave 1, so no later migration is needed to
add it. The send path behind it is a stub that logs "would send" and writes `suppressed` with
reason `no_provider` until Phase 7 ships a real `TelephonyProvider` — reusing the existing
`telephony` flag (`packages/feature-flags/src/flags.ts`) as the gate rather than inventing a
second one for the identical concept.

### 3.8 Due-date reminders are a scan, not an event — and get idempotency for free

"Due date approaching" is not a mutation; nothing emits an event when a clock crosses a threshold.
This needs a periodic scan of `work.cards`, extending the same accepted timer-in-`apps/api`
placeholder `relay.ts` already uses, on a much slower cadence (hourly is more than enough — a
reminder does not need five-second latency) rather than a new subsystem.

The scan reads `work.cards WHERE due_date IS NOT NULL AND due_date <= now() + interval '24 hours'
AND archived_at IS NULL AND deleted_at IS NULL` — the exact partial index already sitting unused
for this (`packages/db/src/schema/work.ts:240`) — and, for each assignee on a matching card,
inserts a `platform.notifications` row with `kind = 'card.due_soon'`, `subjectType = 'card'`,
`subjectId = cardId`. **No new idempotency mechanism is needed:** the existing unique index
`notifications_event_user_key` on `(orgId, subjectId, userId, kind)` already refuses a duplicate,
so the scan can run every hour against the same still-due card forever and only ever write the row
once, via the identical `.onConflictDoNothing()` pattern `notification.projection.ts` already
uses.

**The one gap that index does not close on its own: an edited due date.** If a reminder already
fired and someone then pushes the due date out and back in, the unique key still matches and no
second reminder ever fires — silently. The fix does not touch the index; it touches what happens
to the _existing_ row. `card.updated`'s payload already carries exactly what is needed to detect
this precisely (`apps/api/src/work/events.ts:158`): `changed` includes `'dueDate'`, and
`before.dueDate !== after.dueDate`. Extending the projection to delete any existing
`card.due_soon` row for that card when that condition is seen lets the next scan pass re-fire a
fresh reminder against the new date, rather than the reminder silently going stale.

**This needs a privilege the existing `taskflow_audit` role does not have and should not
acquire.** `taskflow_realtime`'s own justification in `packages/db/src/client.ts:252` is explicit
about why: "A FOURTH role rather than reusing `taskflow_audit`... the gateway holds nothing on
`audit.audit_log`" — least privilege per consumer, not one role accumulating grants across every
system job. The due-reminder scan needs cross-org read access to `work.cards`, which is a
genuinely different privilege than anything either existing system role holds. Recommended: a
fifth role, `taskflow_notification_sweep`, granted `SELECT` on a narrow **column list** of
`work.cards` (`id, org_id, board_id, title, number, due_date, assignee_ids`) — mirroring Wave 3's
`taskflow_backlinks` grant, which excludes `page_versions.state` for the identical reason: the
role that discovers a fact should not be handed more than the fact requires — plus `SELECT,
INSERT` on `platform.notifications`. It needs no `outbox_dispatch` policies at all; it never reads
the outbox, since it is not consuming an event.

### 3.9 Quiet hours: timezone lives on the preference row, not on `identity.users`

Storing a timezone on `identity.users` now would preempt Phase 11.5 (People), which PLAN.md §13
now names as the owner of "timezones, working hours" — and a column added here, then duplicated or
superseded there, is exactly the kind of migration churn the expand/migrate/contract discipline
(§7.4) exists to avoid creating in the first place.

So `notification_prefs` carries its own `timezone` (IANA name, e.g. `America/Chicago`), captured
from the browser at the moment a user sets a quiet-hours window and defaulted to UTC if never set.
This makes no claim to be the person's canonical profile timezone — it answers one narrower
question, "when should this person's digest and quiet-hours logic run," and Phase 11.5's eventual
timezone field is free to become the _source_ this defaults from later without a schema conflict,
exactly the kind of seam §5's provider-interface pattern is generally used for elsewhere.

## 4. Event catalog

**New `platform.notifications.kind` values** (Wave 1): `card.assigned`, `card.comment_mention`,
`card.due_soon`, `page.comment_mention`.

**New domain event**: `notification.created` (§3.5), emitted by the notification projection
itself rather than by a user-facing service method — the one deliberate exception to "guardrail 11
events come from service methods," argued for in §3.5.

**Payload changes needed on existing events — the same lesson Phase 4 Wave 2 already learned
once** (`ai/phase-4-realtime.md` §4.2: "The draft claimed no new payload schemas... That held for
Wave 1 and broke in Wave 2"). Checked against the real payloads rather than assumed:

- `card.assigned` needs **no change** — `before`/`after` assignee arrays (`work/events.ts:225`)
  are already sufficient to compute "who is newly assigned" as `after` minus `before`.
- `comment.created` (Work) needs a **new field**, `mentionedUserIds: string[]`. It already carries
  `excerpt` — "Notifications need words, not a document," written for this phase — but nothing
  names who was `@mentioned` in that excerpt. The parser that extracts mentions from the TipTap
  document already has to run somewhere to build the excerpt; this is one more field off the same
  pass, not a new one.
- `page.comment_created` (Docs) needs **two** new fields: `mentionedUserIds: string[]` and
  `excerpt: string`. Today's payload (`apps/api/src/docs/events.ts:164`) carries only
  `commentId, pageId` — deliberately minimal for Phase 6's own scope, but insufficient for a
  projection that must snapshot title/excerpt at write time rather than re-reading the comment
  later (§3.1's whole argument for why `platform.notifications` never re-reads its subject).

## 5. Waves

**Wave 1 — schema, preferences, immediate delivery for the `direct` category.**
`platform.notification_deliveries`, `platform.notification_prefs`, the `kind` CHECK widened, the
payload additions in §4, the extended projection covering `card.assigned` and the two comment-mention
kinds, email templates and call sites, the personal realtime room (§3.5), a preferences page in
`apps/web`. **Acceptance:** being `@mentioned` in a card comment, a Docs page comment, or assigned
to a card produces an in-app row, an email (unless the recipient turned it off), and an instant bell
update in an already-open tab — without a refresh.

**Wave 2 — digests, due reminders, web push.** The digest sweep (§3.4), the due-reminder sweep and
its dedicated role (§3.8), `PushProvider` (§3.7) and the subscription-registration UI, SMS wired to
the stub (§3.7). **Acceptance:** turning off `direct`/email and leaving `direct`/push on means a
mention shows up as a push notification and nothing else; an `activity`-category comment reply
shows up in the next day's digest and not before; a card due within 24 hours produces exactly one
reminder, and editing its due date after that reminder produces exactly one more.

## 6. Cross-cutting obligations

**Guardrail 11 still applies everywhere except the one named exception.** Every _user-facing_
mutation that should notify someone still emits its own typed event from `packages/events`, exactly
as today. `notification.created` (§3.5) is a consumer producing a second-order event about its own
write, not a service method skipping the rule — call this out in review rather than let it read as
guardrail 11 quietly growing an exception nobody decided on.

**RLS scoping is per-user on top of per-org, same discipline `notifications.ts` already
established.** `notification_prefs` and `notification_deliveries` both need the identical pattern
`apps/api/src/chat/notifications.ts` already documents: "RLS scopes to the ORG... Only mine is the
userId predicate below, and it is not optional." Any new query against either table repeats that
predicate; RLS alone is not enough to keep one member from reading another's preferences.

**Push subscription keys are a credential-adjacent value, not simple metadata.** A stolen
subscription endpoint/key pair lets an attacker who compromises the _server_ push arbitrary
content to a user's device — a smaller blast radius than a session token, but not nothing. This
applies to the `endpoint`/`keys` columns specifically; `userAgentLabel`, `createdAt`, and
`lastSeenAt` (§3.7's device-row shape) are not credentials and need no special handling. Whether
`endpoint`/`keys` rise to §8.4's envelope-encryption bar (currently reserved for phone numbers,
recording URLs, transcripts, and profile PII) is a call for §7, not something to default silently
either way.

**Tests ship with the slice (PLAN.md §11).** Minimum, mirroring what Phase 4 and Phase 6 both
called out by name rather than left implicit: a preference-matrix test proving an explicit `off`
row actually suppresses delivery and an absent row falls back to the coded default; an idempotency
test proving the due-reminder scan run twice against an unchanged card writes one row, not two; the
due-date-edit-clears-and-refires path from §3.8 as its own named test, not folded into a general
"reminders work" case; a realtime test proving a socket only ever receives its **own**
`user:{id}` room's broadcasts — the personal-room analogue of the existing
"a socket presenting a valid token for user A cannot join user B's room" test in
`ai/phase-4-realtime.md` §6.4.

## 7. Decisions — for review

These are the calls this draft is making by recommendation rather than by unilateral default,
following `ai/phase-4-realtime.md` §7's own precedent of separating "argued in §3" from "actually
decided by a human before Wave 1 starts."

1. **Category grouping.** §3.3 proposes exactly two categories (`direct`, `activity`) for Wave 1.
   Confirm the split, or add a third before the preferences UI ships — adding a category later
   means re-bucketing every existing preference row, where adding a _kind_ to an existing category
   does not.
2. **Digest cadence.** §3.4 proposes daily-only for Wave 1, no hourly/weekly option. Confirm, or
   scope a cadence enum into the Wave 1 migration now rather than adding one later.
3. **Push subscription sensitivity.** Whether `platform.push_subscriptions` needs §8.4's envelope
   encryption or is adequately protected by RLS + being unreachable without a valid session — see
   the cross-cutting note above.
4. **`taskflow_notification_sweep` as a fifth system role**, granted a column-limited read on
   `work.cards` (§3.8), versus reusing `taskflow_audit` and accepting a broader-than-ideal grant on
   a role that already spans two purposes. The precedent in `client.ts:252` argues for the fifth
   role; the cost is one more role to reason about in every future security review.
5. **SMS's stub boundary** (§3.7, §2) — confirm gating actual sends behind the existing `telephony`
   flag rather than a new `notificationsSms` flag is the right call, given the two flags would
   otherwise always be toggled together until Phase 7 ships.

---

## 8. Sequencing and cost

Per PLAN.md §13: 3 weeks estimated. Depends on Phase 3 (Work events), Phase 5 (Chat — the
projection and table this phase extends), and Phase 6 (Docs events) — all three already complete.
**Does not depend on Phase 7 (Voice) or Phase 8 (Search)**, despite sitting after both in the
roadmap's numbering: SMS is designed-in and stubbed (§3.7) rather than blocking on Phase 7, and
nothing here touches search indexing. The roadmap's own sequencing notes already say phases 8–11
"each add a consumer to an event bus that already carries production traffic" with no ordering
constraint among themselves — this phase is exactly that shape, one wave earlier than its number
might suggest is required.

**The dependency with Phase 11.5 (People) runs the other direction.** Phase 9 does not wait on
11.5 — §3.9's timezone-on-the-preference-row seam and §3.7's device-row-shaped
`push_subscriptions` table both exist so that Phase 9 can ship now, ahead of it. What Phase 11.5
actually inherits from this phase: a `notification_prefs.timezone` column to read as a default
rather than invent, and a `push_subscriptions` table already shaped for Phase 12's device UI to
read from. Neither later phase should need to migrate around what Phase 9 leaves behind — see
PLAN.md §13's row for 11.5 and the note added to Phase 12's row.

Two new roles if §7.4 is confirmed as proposed (`taskflow_notification_sweep`, and no change to
`taskflow_audit`'s existing footprint), three new tables (`notification_deliveries`,
`notification_prefs`, `push_subscriptions`), one widened CHECK constraint, and payload additions to
two existing events (§4) — smaller than Phase 6's Wave 1, comparable to Phase 4's Wave 1.
