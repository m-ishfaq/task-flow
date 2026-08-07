# Phase 7 — Voice & Messaging

**Status: DRAFT — not yet approved.** Written to be reviewed and argued with, the same way
`phase-5-chat.md` and `phase-6-docs.md` were before their own approvals, and for a sharper reason
than either of them had: this is the first phase in the whole plan that spends real money and
carries real regulatory exposure (call recording consent law) on every request it serves. §3 names
structural decisions that are expensive to unwind once a spend cap has shipped wrong or a
consent gate has shipped absent, and §7 lists the calls that need to be made before Wave 1 starts
rather than defaulted into. Nothing here should be built until the calls in §7 are made — §8.5's
own words are the standard this phase is held to: "Fraud controls are built in Phase 7 from day
one, not added after an incident."

Parent: [PLAN.md](../PLAN.md) §3.4 (Voice & Messaging), §5 (Provider Interfaces —
`TelephonyProvider`), §8.5 (Telephony security), §9 (Real-Time Architecture), §10.6 (Domain
events), §13 (Roadmap), §15 (Risk Register — toll fraud, recording consent, credential
compromise). Sibling: [phase-5-chat.md](phase-5-chat.md) (the inbox surface SMS/WhatsApp threads
land in, §3.8 below), [phase-6-docs.md](phase-6-docs.md) (the most recent phase to actually stand
up a new deployable process, cited throughout §3 and §6 for precedent). Checklist:
[security-checklist.md](security-checklist.md) already has a "Telephony (Phase 7)" section waiting
to be satisfied. Slice procedure: [feature-template.md](feature-template.md).

**This phase has no concurrent sibling.** Phase 5 and Phase 6 are both merged to `main`; PLAN.md
§13's sequencing note that "Phases 5, 6, and 7 are independent... and can be reordered" is now
moot for this phase specifically — there is no `packages/events`/`packages/policy` merge-collision
risk to flag the way `phase-6-docs.md` §6.5 had to for Phase 5, because nothing else is in flight
against those files right now.

---

## 1. Why this phase exists

PLAN.md §3.4 describes Voice & Messaging as per-org phone number provisioning, click-to-call from
any card/contact/chat thread, inbound routing with IVR and queues, call recording behind a consent
gate, transcription, recordings attachable to cards, SMS/WhatsApp threads surfaced in the Chat
inbox, Twilio Verify as an MFA fallback, and a full call/message log with per-org cost
attribution. Unlike Chat and Docs, which both reused this codebase's own existing patterns (Work's
rich text, Phase 4's room authorization, relationship tuples) applied to new tables, this phase's
defining fact is that **every mutation crosses a boundary this codebase has never had to defend
before: a paid third-party carrier, acting on the org's behalf, with real money and a live person
on the other end of the line.** `packages/contracts/src/providers/index.ts`'s own header explains
why `TelephonyProvider` was never built earlier despite being named since Phase 0B: "Deferred
until their phase has a real consumer, because an interface designed without one is a guess." This
phase is that consumer.

The product surface — phone numbers, calls, recordings, SMS threads — is not unfamiliar
engineering territory; Chat already proved per-org rate limiting, retention policies, and an
inbox-shaped UI (Phase 5), and Work already proved attaching an external artifact to a card
(attachments, Phase 3). What is new is that this phase's write path has a **cost per call, a
compliance obligation per recording, and a third party issuing webhooks this codebase must trust
exactly as much as their signature proves and no further.** Every structural decision in §3 below
exists to answer one question first, before any product surface: given that this phase can spend
the org's money and record a real conversation, what is the smallest set of gates that must exist
before either is possible at all — and only then, what does click-to-call, an inbox thread, or a
call log actually look like.

## 2. What's in scope, and what is deliberately not

**In scope:** Twilio subaccount provisioning per org, phone number search/purchase/release,
outbound click-to-call, inbound call routing with IVR and queues, call recording behind a consent
gate, transcription with PII redaction, recordings attachable to Work cards, SMS and WhatsApp
send/receive surfaced in the Chat inbox, Twilio Verify as an MFA fallback, per-org spend caps and
fraud controls, a full call/message log with cost attribution, webhook signature verification and
replay protection.

**Out of scope, on purpose:**

- **A general-purpose telephony platform.** This phase builds what PLAN.md §3.4 names and nothing
  speculative beyond it — no call center analytics dashboard (that's Phase 11, PLAN.md §3.6:
  "chat/call volume" under Analytics), no outbound dialer/campaign tooling, no voicemail
  transcription-to-automation trigger (Phase 10's job, same relationship Phase 5 §2 and Phase 6 §2
  both describe for their own automation hooks: this phase emits real, typed events for a call or
  message; consuming them for an automation rule is a later phase's job).
- **A second real-time transport.** PLAN.md §9's table names exactly three channels — app events,
  chat delivery, doc collaboration — and none of them is "telephony." Call-state changes (ringing,
  connected, ended) broadcast over the existing **app events** channel (`apps/realtime`,
  Socket.io + Postgres adapter), the identical pattern chat notifications and card moves already
  use. See §3.10. This phase does not stand up a fourth channel, and does not give `apps/realtime`
  a write path — CLAUDE.md rule 8 stays true for it exactly as it is today.
- **A second occurrence of the queue debate Phase 4, 5, and 6 all deferred.** `apps/worker` still
  does not exist on `main` — CLAUDE.md records the retention sweep (Phase 5) and the outbox relay
  (Phase 2) both still running on a timer inside `apps/api`, each time noting it "belongs in
  `apps/worker` on pg-boss" without that app ever getting built. This phase is the first one whose
  core action — placing a call, sending an SMS — is _inherently_ asynchronous rather than a
  convenience deferred for later, which is exactly why §7.1 asks the question explicitly instead
  of quietly repeating the same placeholder a fourth time.
- **Full call/message content search.** Same relationship Chat and Docs both have to Phase 8:
  this phase emits `call.completed`/`message.sent`-shaped outbox events a future search index can
  consume; it does not build the index.
- **HIPAA-grade consent/compliance tracking beyond what §8.5 already specifies.** Two-party-consent
  jurisdiction detection and an enforced announcement are in scope (§3.5); a custodian-tracked
  litigation hold on call recordings is the same open compliance question Phase 5 §2 and Phase 6
  §2 both already declined to resolve, and stays declined here.
- **Telnyx or SignalWire as a live implementation.** `TelephonyProvider`'s contract test suite
  (§3.1) is written so a second implementation is a config change, not a rewrite — but this phase
  ships exactly one real implementation (Twilio) plus the interface, matching how `StorageProvider`
  shipped with only R2 and `MailProvider` with only Resend.

## 3. Structural decisions

### 3.1 `TelephonyProvider` is a real interface with exactly one implementation, and Twilio subaccounts are the tenancy boundary underneath it

Following `KeyProvider`/`MailProvider`/`StorageProvider`'s established shape
(`packages/contracts/src/providers/`): a plain interface — `placeCall`, `sendSms`, `purchaseNumber`,
`releaseNumber`, `startVerification`, `checkVerification`, and whatever the recording/transcription
callback shape needs — with a contract test suite every implementation must pass, and exactly one
implementation (`TwilioTelephonyProvider`, `packages/telephony/`) built against Twilio's own free
test credentials (magic numbers that simulate success/failure with no real spend, per Twilio's own
docs), the identical "free tier now, paid trigger later" shape the table in PLAN.md §5 already
commits to (`Twilio test credentials → Twilio live / Telnyx / SignalWire`, trigger: "live demo").

**A Twilio _subaccount_ per org, not a shared account with an org-id tag on every resource.**
PLAN.md §8.5's own risk table names this directly: "Credential compromise — Twilio subaccount per
org — a leaked credential's blast radius is one tenant." This is the same reasoning
`packages/security`'s per-primitive envelope encryption and RLS's per-tenant isolation both already
apply to data at rest, extended to a _third party's_ credential: a leaked API key for one org's
subaccount can place calls and send SMS on that org's Twilio balance, and nothing else's. The
subaccount's own SID/auth-token pair is the credential this phase's `KeyProvider`-wrapped secret
storage protects — never a bare env var, the identical discipline `MASTER_KEY_ID`/
`MASTER_KEY_BASE64` already establish for this codebase's own secrets.

### 3.2 Fraud controls are Wave 1, before a single call can be placed — not a feature bolted onto Wave 2

PLAN.md §8.5, verbatim: "Fraud controls are built in Phase 7 from day one, not added after an
incident. ... **The single most expensive failure mode in the system.**" This is not phrasing to
echo, it is a build-order constraint: the spend cap, the geo allowlist, and the velocity limiter
(§3.3) must exist and be enforced _before_ Wave 2 makes it possible to place a call or send an SMS
at all — the same reasoning `attachment.service.ts`'s pipeline (CLAUDE.md) puts magic-byte
verification and virus scanning _before_ a download URL is ever handed out, not as a follow-up
pass. A `pnpm verify` that is green because outbound sending doesn't exist yet is not a weaker
version of the control; building the gate first is the only order that guarantees Wave 2 cannot
ship without it, the identical reasoning `couldGrant`'s own bug (Phase 5, CLAUDE.md) teaches in
the opposite direction — a control retrofitted after the capability it should have gated already
shipped is the control most likely to have a hole in it nobody has looked for yet.

### 3.3 The spend cap is enforced by one function every outbound path calls through, never duplicated per call site

Exactly the discipline `packages/policy`'s `can()` already establishes for authorization — one
decision function, every caller routes through it, so a second call site can never quietly
re-implement the check slightly wrong. `checkSpendLimit(orgId, estimatedCost)` (or equivalent) is
the single gate `placeCall`, `sendSms`, and `purchaseNumber` all call before reaching
`TelephonyProvider`, reading a per-org cap (configurable, defaulting to a conservative ceiling) and
the org's rolling spend from `telephony.spend_ledger` (§3.4's table). **Checked BEFORE the
provider call, not reconciled after** — an after-the-fact reconciliation catches an overspend once
it has already happened, which is a report, not a control. The geo allowlist (destination country
code against a default-deny high-risk list) and a per-user/per-number velocity limit (calls or
messages per minute, the identical shape Phase 1's per-IP rate limiter already uses for login
attempts) are checked in the same gate, for the same reason: three separate checks in three
separate call sites is three chances for one of them to be forgotten on the next new outbound path
this phase or a later one adds.

### 3.4 A cost ledger is written inside the same transaction as the call/message record, never inferred later from Twilio's own billing

`telephony.spend_ledger` (or a `cost_cents` column on `telephony.calls`/`telephony.messages`
directly — an open question for the migration, not a structural one) is written in the SAME
database transaction that records the call or message succeeded, using Twilio's own per-request
price data where available and a conservative estimate otherwise, corrected once Twilio's async
billing webhook confirms the real figure. This mirrors Work's `next_card_number` and Phase 2's
audit chain: the number that gates the next spend decision (§3.3) must never depend on a
reconciliation job running on time, or the spend cap becomes a control with a lag exploitable by
placing many calls faster than the reconciliation interval.

### 3.5 Recording consent is a gate before recording starts, and the announcement is enforced, not merely offered

PLAN.md §8.5: "Consent gate before recording begins · jurisdiction detected via Twilio Lookup ·
two-party-consent regions get an enforced announcement · consent event written to the audit log."
Read literally: a call _can_ proceed without being recorded, but a recording cannot begin before
the consent step has run for that specific call, and in a two-party-consent jurisdiction the
announcement is not a checkbox in a settings page — it is audio actually played into the call
before recording starts, the same "enforced, not advisory" distinction §3.8 of `phase-6-docs.md`
draws for Hocuspocus's read-only mode: a UI affordance a determined caller could skip is not a
control, only something the server itself refuses to proceed past counts. The consent decision
(jurisdiction detected, announcement played, recording started) is written as its own audit entry
— `legal_hold.changed`'s precedent from Chat (an entry that names a governance decision about a
resource, not a content mutation) is the shape to follow, not a side effect buried in
`call.recording_started`'s payload where a compliance review would have to know to look for it.

### 3.6 Recordings live in this org's own object storage, never left sitting on Twilio, and every download is audited

PLAN.md §8.5: "Recordings stored in your own object storage, never left on Twilio. Access requires
explicit permission plus step-up auth. Every download audited." The mechanism is the inverse of
Work's attachment upload pipeline (CLAUDE.md: presign → magic-byte → scan, fail-closed) rather than
a copy of it — here the file arrives FROM a trusted third party via a signed callback URL, not
from an untrusted browser upload, so there is no magic-byte/AV scan step this phase needs (the
content is Twilio's own recording of a real phone call, not an arbitrary upload); what carries over
unchanged is **presigned access is the only door**, exactly `attachment.service.ts`'s own
`presignDownload` model: `recording:read` alone is not sufficient to fetch bytes, `recording:export`
(Owner-only per the role matrix already shipped — see below) plus step-up re-authentication is,
and the download itself is the audited event, matching how CLAUDE.md already documents attachment
downloads as an audited action rather than an unlogged read.

**The permission catalog already has this decided, and it constrains the implementation rather
than the reverse.** `packages/policy/src/roles.ts` already lists `phoneNumber:read`, `call:place`,
`call:read`, `sms:send`, `sms:read` on Member; `recording:read` is Admin-and-Owner only (absent
from Member entirely); `phoneNumber:purchase`, `phoneNumber:release`, and `recording:export` are
Owner-only, with the file's own header naming these as the deliberate reason roles are not modeled
as a hierarchy ("Modelling Admin as Member-plus-extras... `recording:export` and
`phoneNumber:purchase` are exactly the cases where it is not"). This phase does not choose that
matrix — it was chosen before this phase existed, and this phase's routes are the first real
consumer of a shape guardrail 9's matrix test has been asserting against with no caller for it
until now.

### 3.7 Transcription redaction runs before a transcript is ever stored, not as a pass over what's already saved

PLAN.md §8.5: "PII in transcripts — Automatic redaction pass (card numbers, national IDs) before
storage." The word "before" is load-bearing the same way it is in §3.5: a redaction pass that runs
after storage and then updates the row is a window, however short, where the unredacted transcript
exists at rest and in whatever logging or replication touched the write. Transcription runs
through `TelephonyProvider` (Twilio's own transcription, or a swappable second provider behind the
identical interface, matching `MailProvider`'s multi-implementation shape), and the redaction pass
is applied to the result **before** the `INSERT` — the row that lands in `telephony.transcripts`
is already the sanitized version, with no unredacted intermediate ever reaching a table.

### 3.8 SMS/WhatsApp threads are NOT `chat.channels` rows — they're a parallel resource surfaced into the same inbox UI

Chat's channel model (`public` / `private` / `dm` / `group_dm`) assumes every participant is an org
member with a `UserId` and a relationship tuple (Phase 5, CLAUDE.md's own "membership tuple" model).
An SMS thread's other party is a phone number, not an account — there is no `UserId` to write a
`member` tuple for, and no permission model question to resolve for someone who was never a
principal in this system to begin with. Forcing an external phone number into `chat.channels` would
mean either inventing a fake membership for a non-user (the same category of modeling mismatch
`docs.comments` avoided by NOT reusing `work.card_comments`' shape wholesale, per that phase's own
reasoning) or weakening `chat.channels`' invariants for one row type. This phase instead gives SMS
and WhatsApp threads their own table (`telephony.message_threads`, org-scoped, RLS'd identically to
every other tenant table), and the Chat inbox UI (`apps/web/src/features/chat`) reads BOTH
`chat.channels` and `telephony.message_threads` to render one merged list — a read-side
aggregation, not a write-side reuse. `chat:read`-shaped permissions do not apply; this phase's own
`sms:read`/`sms:send` (already in the catalog, §3.6) gate it instead.

### 3.9 Click-to-call and card-attached recordings are a plain foreign key, never a second attachment pipeline

A recording "attachable to a card" does not need Work's presign/magic-byte/scan pipeline run a
second time — the file already passed through this phase's own trusted ingestion (§3.6). Attaching
one to a card is a nullable `card_id` column on `telephony.recordings` (or a join table, if a
recording can reasonably attach to more than one card — an open product question, not a structural
one) referencing `work.cards`, checked the same way Docs' `pages_published_version_fk` proves a
published pointer names the right page: the FK is the enforcement, not a service-level lookup that
could be forgotten on a second call site. Reading a card's attached recordings is `card:read` plus
`recording:read` — two permissions checked, matching the "two authorization questions, deliberately
not merged" precedent CLAUDE.md documents for Work's card detail (managing a project's label
vocabulary vs. filling in one card) and for Docs' page comments (reading a page vs. commenting on
it): being allowed to see the card does not by itself disclose a recording someone without
`recording:read` should not hear.

### 3.10 Call state broadcasts over the EXISTING app-events channel — no new real-time transport

PLAN.md §9's table is exhaustive about what exists: app events (Socket.io + Postgres adapter),
chat delivery, doc collaboration. A ringing/connected/ended call is a state transition a UI wants
to reflect live, the identical shape a card move or a chat notification already is — not a new
kind of real-time problem. `apps/realtime` gets a new room type (`call:<callId>`, joined the
identical way a board or a channel room is: `couldGrant`-then-`can()` on `call:read`, never a
client-asserted membership) and a handful of new broadcast events; it does not get a write path,
and this phase does not stand up a fourth transport. The inbound Twilio webhook that reports a call
connected is what writes the row (via the ordinary `apps/api` path, §3.11) and enqueues the
broadcast — `apps/realtime` still only ever relays what the database already recorded, CLAUDE.md
rule 8 unchanged.

### 3.11 Inbound Twilio webhooks are a plain Fastify route, not a tRPC procedure — and the signature check happens before the body is trusted at all

Every mutation elsewhere in this codebase goes through `route({ permission })` — a verified,
already-authenticated principal calling a typed procedure. A Twilio webhook has no such principal:
it is an unauthenticated HTTP POST from a third party, form-encoded (not JSON), whose only proof of
legitimacy is the `X-Twilio-Signature` header validated against the exact request URL and body per
Twilio's own signing algorithm. This does not fit tRPC's shape and is not forced into it — it is a
plain Fastify route mounted alongside the tRPC router (the same "ordinary route, not a procedure"
carve-out `apps/api/src/main.ts` already makes for `health.live`), and `security-checklist.md`'s
own external-boundaries section is the actual gate: **signature verified before the body is parsed
or trusted at all**, replay protection via a nonce cache with a 5-minute window (§8.5's own words),
and only after both pass does the handler do anything resembling what an ordinary
`route()`-gated mutation does — validate, write inside `withOrgScope`, emit a domain event. The org
this webhook belongs to is resolved from the phone number or call SID in the payload, looked up
against this org's own subaccount mapping — never trusted as a claim in the request itself, the
same "client-supplied value is a lookup key, never an assertion" principle Phase 4's `x-taskflow-org`
header and Phase 6's `onAuthenticate` document name both already establish.

### 3.12 Twilio Verify is a second, narrower use of the SAME provider interface — not a separate MFA system

PLAN.md §3.4 names "Twilio Verify as an MFA fallback" for identity. This phase's `TelephonyProvider`
interface includes `startVerification`/`checkVerification` alongside call/SMS methods, and
`apps/api/src/identity`'s existing MFA path (⚠ human-review surface already) is the ONLY consumer —
this phase does not add a second parallel verification concept. The org-level spend cap and geo
allowlist (§3.3) still apply to a Verify SMS exactly as they do to an ordinary one; a verification
code is not exempt from the fraud controls just because identity, not Voice & Messaging, is asking
for it.

## 4. Event catalog for Phase 7

The full set this phase's outbox needs to carry, following Chat and Docs' own naming convention
(resource, past-tense action):

```
PhoneNumberPurchased · PhoneNumberReleased
CallPlaced · CallConnected · CallCompleted · CallFailed
RecordingStarted · RecordingCompleted · RecordingDownloaded
ConsentRecorded
TranscriptionCompleted
MessageSent · MessageReceived · MessageDeliveryFailed
MessageThreadOptedOut
SpendCapReached · SpendLimitExceeded
VerificationStarted · VerificationSucceeded · VerificationFailed
```

**`SpendCapReached`/`SpendLimitExceeded` are events precisely because §3.2/§3.3 need them to be.**
A spend cap that only prevents the NEXT call is a control; one that also fires a typed,
outbox-carried event is a control someone can be notified about (Phase 9's job to route that
notification, not this phase's — the identical relationship Phase 5 §2 already describes for
"this phase emits the event, a later phase consumes it"), which is the difference between "the
system quietly stopped placing calls" and "an admin found out why within the hour."

**`RecordingDownloaded` is a read, not a mutation, and gets an event anyway** — the same exception
Chat's `compliance.exported` and Docs' `page.published`'s public-read cousin already establish:
guardrail 11 is framed around state mutation, but an action this sensitive (§3.6: step-up-gated,
explicit-permission-only access to a recorded phone call) is exactly the kind of read CLAUDE.md's
audit section already treats as compliance-relevant regardless of whether a row changed.

## 5. Waves

Mirroring Chat and Docs' wave structure — each wave independently shippable behind a feature flag
per CLAUDE.md rule 7, and, more than either of those phases, ordered so that nothing capable of
spending money or recording a person exists until the controls gating it already do.

**Wave 1 — the safety rails, before anything they gate exists.** `TelephonyProvider` interface +
contract tests, `TwilioTelephonyProvider` against test credentials, Twilio subaccount provisioning
per org (§3.1), the spend cap / geo allowlist / velocity limiter gate (§3.2–§3.4) with its own
test suite proving it refuses BEFORE any caller can reach `TelephonyProvider`, webhook signature
verification + replay protection (§3.11) with no route registered yet that uses it for anything
real. Deliberately ships nothing a user would call a feature — the acceptance bar is "the gate
exists and refuses correctly," proven against a `TelephonyProvider` no product surface calls yet.

**Wave 2 — voice.** Phone number search/purchase/release, outbound click-to-call, inbound routing
with IVR and queues, the call log, real-time call-state broadcast (§3.10) over `apps/realtime`.
Recording behind the consent gate (§3.5), stored in this org's object storage (§3.6), gated by
`recording:read`/`recording:export` plus step-up for export. Transcription with redaction-before-
storage (§3.7).

**Wave 3 — messaging.** SMS and WhatsApp send/receive, the parallel `telephony.message_threads`
resource surfaced into the Chat inbox (§3.8), STOP/UNSUBSCRIBE suppression-list compliance,
recordings/calls attachable to Work cards (§3.9).

**Wave 4 — Verify, and the cost log.** Twilio Verify wired into `apps/identity`'s existing MFA
fallback path (§3.12), the full call/message log with per-org cost attribution reporting
(consuming §3.4's ledger), admin-facing spend visibility.

## 6. Cross-cutting obligations

**6.1 This phase's inbound webhook handler and its subaccount-credential handling join CLAUDE.md's
human-review-surfaces list the moment they're written** — `security-checklist.md` already lists
"webhook verification" and "telephony spend" among the surfaces requiring a read-every-line pass
plus a fresh-context adversarial review before merge; this phase is where those stop being
hypothetical line items and become real files. Named as an obligation here rather than assumed,
the identical reasoning `phase-6-docs.md` §6.2 gives for `apps/collab`'s auth hook.

**6.2 Guardrail 11 (typed domain events) and guardrail 6 (Zod at boundaries) apply to every route
this phase adds, including the webhook handler once past signature verification** — the fact that
the INBOUND request isn't a tRPC procedure (§3.11) does not exempt what it writes from going
through the same `withOrgScope`, same event-emission discipline as everything else under
`apps/api/src/telephony/*.service.ts`.

**6.3 The permission-debug decision trace (PLAN.md §10.7, §8.2) needs no new work here** — unlike
Docs' tree-resolved grants (`phase-6-docs.md` §6.4), every telephony permission is a flat role
grant with no relationship-tuple or ancestor-walk component (§3.6), so `can()`'s existing no-target
and role-only paths already produce a correct trace with zero changes. Worth stating explicitly so
a future reader doesn't go looking for a telephony-specific resolver that was never needed.

**6.4 New secrets go in the env schema and `.env.example` with a placeholder, never a value** —
`security-checklist.md`'s own line item, concrete here: Twilio's master account SID/auth token
(for subaccount provisioning), and whatever signing secret the webhook verification step needs,
all through `parseEnv` (CLAUDE.md rule 3), never a bare `process.env` read.

**6.5 `REDACTION_PATHS` in `@taskflow/observability` gains entries for this phase's new sensitive
fields** — phone numbers, recording URLs, transcript text, and the Twilio auth token itself all
need to never reach a log line unredacted, the identical obligation `security-checklist.md`'s
data-exposure section already states for any new sensitive field.

## 7. Open decisions — need a call before Wave 1 starts

1. **Is this finally the phase `apps/worker`/pg-boss gets built for real, or does outbound
   call/SMS placement go through yet another timer-in-`apps/api` placeholder?** Three phases
   (Realtime, Chat, Docs) have each deferred `apps/worker` in turn, always because the thing
   needing it could tolerate a timer. Placing a call cannot: Twilio's API is a network call with
   real latency, and blocking a tRPC mutation's response on it is a materially worse UX than
   enqueueing and returning immediately, the identical "enqueue participates in the same
   transaction as the mutation" argument PLAN.md §4 already makes for pg-boss generally. Leaning
   toward: yes, this is the phase — but it is a real scope addition (a new deployable, `apps/worker`
   in CLAUDE.md's layout going from "arriving" to real) that deserves an explicit sign-off given
   PLAN.md §15's "component sprawl = attack surface" line, the same weighing `phase-6-docs.md` §7.6
   did before standing up `apps/collab`.
2. **What is the default per-org spend cap, and who can raise it?** §3.3 names the mechanism;
   PLAN.md does not name a number. Needs a concrete default (a fixed dollar amount? scaled to org
   size or plan tier?) and a decision on whether raising it needs Owner-only + step-up (matching
   `phoneNumber:purchase`'s existing tier) or is itself a support-ticket-gated action outside this
   phase's self-service surface entirely.
3. **Does WhatsApp ship in Wave 3 alongside SMS, or slip to its own wave?** WhatsApp Business API
   access requires a real approval process with Meta independent of anything this codebase
   controls, unlike SMS which Twilio provisions instantly on a purchased number. If that approval
   cannot be obtained on a timeline matching Wave 3, SMS ships alone and WhatsApp becomes a
   follow-up wave — flagged now so it is a known risk rather than a Wave 3 slip discovered
   mid-wave.
4. **Recording transcription: Twilio's own built-in transcription, or a separate provider behind
   `TelephonyProvider`?** §3.7's redaction-before-storage requirement is provider-agnostic, but
   accuracy, cost, and language support differ meaningfully between "ask Twilio for a transcript"
   and "run the recording through a dedicated speech-to-text provider." Needs a concrete choice
   before Wave 2's transcription work is scoped, since it changes whether this phase adds a SECOND
   external provider interface or extends `TelephonyProvider` alone.
5. **Does a recording attach to at most one card, or many?** §3.9 flags this as a product question
   the schema needs an answer to before the migration is written — a plain nullable FK on
   `telephony.recordings` if at most one, a join table if many. Affects the migration, not the
   authorization model either way.
6. **Is the default geo allowlist a hand-maintained country list in this codebase, or sourced from
   a maintained external list (e.g., a known high-risk-jurisdiction dataset)?** §3.3 assumes the
   allowlist exists; it does not yet specify whether it is curated here (simple, but needs upkeep
   as fraud patterns shift) or pulled from a source of truth this codebase doesn't own (accurate,
   but a new dependency). Needs a decision before Wave 1's gate can be built, since the two shapes
   have different test strategies.

## 8. Sequencing and cost

Depends only on Phase 1 (identity — Twilio Verify extends the existing MFA fallback path, §3.12)
and Phase 4 (realtime spine — call-state broadcast, §3.10), both shipped and merged to `main`.
PLAN.md §13: "Phase 4 must precede 5, 6, and 7 — all three depend on the realtime spine," and
"Phases 5, 6, and 7 are independent of each other and can be reordered by interest or urgency."
Both conditions are satisfied; Phase 5 and Phase 6 being already complete removes even the
merge-collision risk those two had to name against each other.

Estimated 7 weeks per PLAN.md §13's table — one week shorter than Chat or Docs, but the FIRST
phase in the plan carrying real financial risk, which is why §3.2's ordering (fraud controls
before capability) costs real wall-clock time up front rather than compressing the estimate.
Budget impact: **~$2/month**, per PLAN.md §14 — "Phase 7 (live telephony demo) ~$2 — one phone
number; Twilio trial credit covers usage." This is the first phase in the whole plan that moves
the project off the $0 tier PLAN.md §14 has held since Phase 0, and the number is small
specifically because Wave 1 is built and tested entirely against Twilio's free test credentials
before a single real phone number is ever purchased.
