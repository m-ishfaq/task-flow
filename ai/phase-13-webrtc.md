# Phase 13 — In-app voice (WebRTC)

Status: **Waves 1 and 2 COMPLETE.** Wave 1 — signalling spine, TURN + credential minting, 1:1 DM
audio, call records, the authorization reuse. Wave 2 — ringing on any screen, ringtones, the
missed-call notification, and recording behind a consent gate. Wave 3 (video, screen share, device
selection) open. Approved 2026-08-10.

Read this header before trusting a phase marker anywhere else (the standing lesson from Phase 3.5,
Phase 5 and Phase 7: a status marker is a claim, not a fact).

### What Wave 1 shipped

`packages/db/migrations/0041_rtc_wave1.*` (the `rtc` schema — sessions, participants, TURN issuance) ·
`packages/security/src/turn-credential.ts` · `apps/api/src/rtc` (events, the session service, the
TURN gate, the router) · `apps/realtime`'s `/rtc` namespace, `rtc-rooms.ts` and the signal relay ·
`apps/web/src/lib/rtc-socket.ts` and `apps/web/src/features/rtc` (peer mesh, call button, ringing
banner, in-call bar) · `coturn` in `compose.yaml`.

### Three things found while building it

**`enforce()` answers NOT_FOUND, not FORBIDDEN, to someone who cannot read the channel** — and the
first version of both test suites asserted FORBIDDEN and failed. That is §8.7 working: a 403 on a
session id would confirm two specific people are on a call. The assertions now say NOT_FOUND and
say why, because "assert the refusal" and "assert the refusal does not leak" are different tests
and only one of them was written first.

**An offer could still be sent after the caller hung up.** `PeerMesh.#offerTo` checked `#closed`
before `await createOffer()` and not after, so a hangup landing in that window still emitted an
offer — the far side then opened a connection to a tab that had stopped listening and sat out the
ICE timeout showing them as "connecting". Found by a unit test that expected the opposite, kept as
`does not send an offer that was in flight when the caller hung up`.

**The participant helpers had to leave `session.service.ts`.** Guardrail 11's lint rule fired on
`joinParticipant` and `endSessionRow` — private helpers that mutate and emit nothing. The fix is
the one `chat/membership.ts` and `work/counters.ts` already document: move them to a repository
(`apps/api/src/rtc/participants.ts`), where mutating without an event is the point, and keep the
event on the operation a person performed. An inline disable would have removed the rule's ability
to notice the next one.

---

## 1. The one thing that makes this cheap

**A call room authorizes exactly like a channel room.** `apps/realtime/src/rooms.ts`'s
`authorizeChannelJoin` already resolves membership through `resolveOrgMembership`, builds a
`channelTarget` carrying `closed`, and asks `can()`. A call in channel X is joinable by precisely
those who can read channel X — so DMs inherit the whole closed-target correctness argument for
free, and Phase 5 §3.3's standing rule that **there is never a `participantIds.includes(userId)`
shortcut** carries over untouched.

`authorizeRtcJoin` in `apps/realtime/src/rtc-rooms.ts` is therefore three lines of its own plus a
call to `authorizeChannelJoin`. It resolves the session row to find which channel the session
belongs to, and then asks the existing function. It contains no membership logic.

> **Do not invent a second membership check for calls.** That is the single most important
> constraint in this phase. If a future wave needs "who is in this call", it needs
> `rtc.participants` (a record of what happened) — never a substitute for `can()`.

---

## 2. Scope

In scope for the phase: 1:1 and small-group in-app audio, riding the existing socket gateway for
signalling and the existing API for state; TURN with server-minted, short-lived credentials; a
durable record of who called whom and for how long.

Out of scope, deliberately: an SFU (a separate deployable, and a half-SFU is worse than neither),
recording, and PSTN bridging (joining a Twilio call to an in-app one).

| Wave | Contents                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | Signalling spine, TURN + credential minting, 1:1 DM audio, call records, the authorization reuse                       |
| 2    | Ringing on any screen, ringtones, ringback, the missed-call notification, join-in-progress, **recording with consent** |
| 3    | Video, screen share, device selection                                                                                  |
| —    | Deferred: SFU, PSTN bridging                                                                                           |

Recording moved from "deferred" into Wave 2 on the author's request, with the §3.9 condition
attached rather than waived — see that section.

---

## 3. Design decisions

### 3.1 Signalling rides `apps/realtime` and stays broadcast-only

CLAUDE.md rule 8 holds without an exception. The socket relays SDP offers/answers and ICE
candidates and **writes nothing**. The call record — who called, who joined, how long — goes
through `apps/api` routes, where validation, authorization, audit and the outbox already live.

The flow: the initiator calls `rtc.start`, gets a `sessionId`, and signalling happens in a room
named by it. `apps/collab` remains the one documented write-from-a-socket exception; this phase
does not add a second.

Signalling lives on its own namespace, `/rtc`, with its own event maps — the same reasoning
`wire.ts` gives for `/chat`: two maps mean an RTC signal cannot be delivered to a chat listener
even by mistake. The handshake is the SAME `verifyHandshake` middleware. This phase adds zero new
authentication code.

### 3.2 The relay must never trust a peer id in the payload

This is Phase 4's "subscribe me to my own notifications" bug in a new costume. If a client sends
`{ to: <userId>, sdp }` and the server relays it by that id, that is a cross-room
message-injection primitive: name anyone, and the server delivers your payload to them.

The target is **validated against the call room's roster, derived from socket state** — never taken
from the message body as a routing key. Concretely, in `gateway.ts`'s `rtc:signal` handler:

1. The sender must already hold the room (`socket.data.rooms.has(sessionId)`), which means it
   passed `authorizeRtcJoin`.
2. `fetchSockets()` on `rtcRoom(sessionId)` produces the roster **the server holds**.
3. The `to` id selects from that roster. A `to` naming someone not in the room matches nothing and
   the signal is dropped.
4. `from` is filled from `socket.data.identity`, never from the payload — the same rule as
   `typing`.

The wrong implementation, written down so it is recognizable: `socket.to(userRoom(to)).emit(...)`.
That compiles, reads fine, delivers reliably — and relays to that user **anywhere**, in any tab,
with no room check at all. `fetchSockets()` rather than the adapter's local room set, for Phase 4
§9's reason: the local set sees only this instance.

Payload size is bounded by Zod (`MAX_SIGNAL_BYTES`). An SDP body is a few kilobytes; unbounded, it
is a memory amplifier that one authorized peer can point at another.

### 3.3 TURN credentials are short-lived and minted server-side

Never a static secret in the client bundle. `packages/security/src/turn-credential.ts` implements
coturn's REST scheme (`use-auth-secret`): username is `<unix-expiry>:<opaque-identity>`, credential
is `base64(HMAC-SHA1(static-auth-secret, username))`. HMAC-SHA1 is not a choice — it is what
coturn's `TURN REST API` draft specifies and what the server verifies against; the security
argument is HMAC's, not SHA-1's collision resistance.

One file, one primitive, on the human-review list — the reason the `node:crypto` ban exists.

### 3.4 TURN is a bandwidth spend surface, and the gate ships before the thing it gates

An open TURN relay carries strangers' traffic on your bill. That makes it the WebRTC analogue of
the telephony spend gate, and it gets the same treatment Phase 7 Wave 1 gave outbound calling:
**the gate exists and refuses correctly before any product surface can reach it.**

`apps/api/src/rtc/turn-gate.ts` refuses in this order, and the order is the control:

1. **Org status** — a suspended org gets nothing. Same reason as the telephony gate: a kill switch
   that only runs where a user is waiting is not a kill switch.
2. **Participation** — the caller must be a participant of a session that is not `ended`. Not "a
   member of the org", not "someone who can read the channel": a credential is a capability to
   relay bytes, and it is issued for a call that is actually happening.
3. **Durable issuance budget** — `rtc.turn_issuance` rows in a rolling window, per org, against
   `RTC_TURN_ISSUANCE_CAP_PER_DAY`. In Postgres, not in process: an in-memory counter forgives
   everyone on restart, which is exactly what an attacker restarts you to get. Same relationship
   the telephony velocity limiter has to the spend ledger.

**The most important assertion in `turn-gate.test.ts` is not that a refusal is returned — it is
that the secret was never used**, asserted against a minting function that would have recorded the
call. A gate that answers `{ allowed: false }` after minting reads correctly in a diff and hands
out a working credential.

The issuance row is written in the same transaction that answers, so a failed request does not
consume budget, and a successful one cannot fail to consume it.

### 3.5 Mesh, with a server-enforced participant cap

1:1 is peer-to-peer. Group is mesh — N(N−1)/2 connections, fine at 3–4 and unusable at 10. The cap
is `MESH_PARTICIPANT_CAP` in `apps/api/src/rtc/shared.ts`, and it is enforced **in the database**,
not in the service and certainly not in the UI: `rtc.sessions.joined_count` carries
`CHECK (joined_count <= max_participants)`, and the join transaction increments it. The (N+1)th
join is refused by Postgres.

The cap is written into each session ROW at creation rather than read at join time, so changing
the constant cannot retroactively evict someone from a call already in progress.

On the client, glare — both peers offering at once — is avoided without perfect negotiation: for
any pair, **the lexicographically smaller user id makes the offer** (`isOfferer` in
`apps/web/src/features/rtc/peer-mesh.ts`). Every pair has exactly one smaller id, so exactly one
side offers. That is sufficient for a symmetric mesh and stops being sufficient the day Wave 3
renegotiates from the "wrong" side; the file says so.

That serializes joins within one session on a row lock — accepted knowingly, the same trade
`work.projects.next_card_number` makes for gapless card numbers.

An SFU is a separate deployable and a later decision.

### 3.6 First-answer-wins needs a conditional UPDATE

"All are notified, anyone can answer" is a race — two tabs of the same callee, or two members of a
group. `answerSession` puts the current status in the WHERE clause
(`WHERE id = $1 AND status = 'ringing'`) and reads the returned row count. Same pattern as
`claimForScanning` in the attachment pipeline, and for the same reason: a check-then-write here
means two answers both "win" and both emit `rtc_session.started`.

### 3.7 New tables, not `comms.calls`

A PSTN call carries an encrypted counterparty number and a spend-ledger row; an in-app call carries
participant user ids and costs nothing. Conflating them makes every query disambiguate and fills
the spend ledger with rows that mean nothing.

`rtc.sessions` + `rtc.participants` + `rtc.turn_issuance`, org-scoped with RLS, migration 0041.

`rtc` is a NEW schema, and it deliberately has **no `ALTER DEFAULT PRIVILEGES`**. Phase 12 Wave 1's
0036 found that 0001's default privileges on `platform` silently gave `taskflow_app` full CRUD on
every table a later migration created there, making a "SELECT only" grant weaker than what the
database already enforced. The fix generalizes: a schema with no default privileges forces every
future migration to state its own grants, and "no DELETE on `rtc.sessions`" is then a fact rather
than a comment. A call record is append-and-update-only; nothing may delete one.

### 3.8 Two authorization questions, deliberately not merged

- **Joining** a call is `channel:read`, per §1. If you can read the conversation you can be in its
  call.
- **Starting** one is `message:create`. A `viewer` tuple on a channel is read-and-not-write by
  design (`packages/policy/src/tuples.ts`); someone who cannot post into a conversation should not
  be able to make everyone's phone ring in it.

Both go through `channelTarget()` and `can()` on the same resolved `Subject`. This is a second
QUESTION, not a second membership check — the distinction §1 turns on.

### 3.9 Recording, behind a consent gate (Wave 2)

Wave 1 deferred this with a condition: "if it ever lands, the consent gate applies exactly as it
does for PSTN. An in-app call is no less a recorded conversation." Wave 2 lands it, and the
condition is met rather than waived.

Phase 7's bar is three layers, of which only the third is a thing the database will not let be
wrong. All three exist here:

1. **A decision.** `requestRecording` moves the session to `pending` and emits an event. Nothing is
   captured.
2. **A code path.** `startRecording` is the only route to `active` and refuses unless everybody has
   agreed.
3. **A constraint.** `sessions_recording_needs_consent` (migration 0042) —
   `CHECK (recording_state <> 'active' OR consent_count >= joined_count)`. A CHECK sees one row, so
   "everyone agreed" is expressed as a COUNTER comparison, the same trick `joined_count` already
   uses for the mesh cap. `recording.service.test.ts` asserts this layer by writing through the
   migrator connection, bypassing every line of the service.

Four things fall out of the counter that are worth stating:

- **Somebody joining a recording call pauses it.** A new participant increments `joined_count` and
  not `consent_count`, so an `active` recording would violate the constraint and the JOIN would
  fail. Being unable to answer a call is a worse failure than a pause, so `joinSession` moves
  recording back to `pending` in the same transaction. The behaviour that falls out is the one a
  compliance review would ask for: capture stops the moment somebody who has not agreed can hear
  it.
- **Consent is per RECORDING, not per session.** `stopRecording` clears every answer. Agreeing once
  must not make you recordable for the rest of the call.
- **A single refusal ends the request** rather than leaving it pending until it times out.
- **There is no admin override.** No permission overrides a participant's refusal, and the org's
  own owner is exactly who somebody most needs to be able to refuse.

**The browser records, because there is no server in the media path.** Wave 1 is mesh, so the only
place every stream exists together is inside one participant's tab. The honest limitation: the file
is only as complete as the recorder's own connection. The database records who consented and when,
not that the audio is forensically complete, and nothing claims otherwise. Server-side capture
needs an SFU (§2).

The object key is server-generated from ids this server minted — Phase 3's attachment rule, because
a filename in a key needs path escaping, which is a traversal this design removes rather than
mitigates.

---

## 7. Ringing (Wave 2)

**The ring arrives on a socket and is CONFIRMED by a poll.** `rtc_session.started` fans out to each
invitee's `user:{userId}` room — the room the gateway places every socket into at connection time,
so a call rings on whatever page the person is looking at. `incomingCallsQuery` polls every six
seconds behind it. That is Phase 4's own NOTIFY/poll relationship: delete the socket handler and
calls still ring, six seconds later; delete the poll and a dropped message is a call that never
rang.

**Fan-out is its own room table**, `USER_LIST_KEY_OF`, not a widening of `USER_KEY_OF`. Making that
field sometimes an array would give every call site a `string | string[]`, and the branch that
forgets the array case delivers to nobody. The list is bounded by `MAX_FANOUT` and an oversized one
is refused ENTIRELY rather than truncated — truncation would present as "the call rang for some
people", which is far harder to diagnose than a ring that did not happen.

**Others keep ringing after the first answer.** `incomingCalls` filters on the caller's own
participant state being `invited` and the session not being `ended` — deliberately NOT on
`status = 'ringing'`, which would silence everybody else the instant one person picked up, so a
three-way call could only ever have two people in it.

**Ringtones are synthesized, not shipped.** Five tones as Web Audio oscillator cadences
(`apps/web/src/features/rtc/ringtone.ts`): no asset to host, nothing that can 404, and a tone
becomes a short enum with a CHECK constraint instead of a URL somebody's browser fetches. The
choice lives in `identity.call_prefs`, global per user like `notification_prefs` and for the same
reason — every route reading it is a `selfRoute`, which resolves no org. `ring_enabled` is separate
from muting notifications: an open-plan office wants the popup without announcing it to the room.

The caller hears a ringback, which is deliberately not configurable — a ringtone tells you which
device is ringing and is worth personalising; a ringback only has to say "still trying".

**The missed-call notification is `call.missed`, and only from the ENDED event.** A notification for
a call that is currently ringing would arrive alongside the live ring and then be read minutes later
as "someone is calling" about a call long over. `missedUserIds` is carried on the event rather than
derived downstream, because "was still ringing when it ended" is a fact only the ending transaction
can see — every participant is settled into `missed` or `left` by the time any consumer reads the
row, so recomputing it would tell everyone who was ON the call that they missed it.

---

## 4. Domain events

Registered in `apps/api/src/rtc/events.ts`. No event here carries an SDP body, an ICE candidate, or
a TURN credential — an outbox payload is persisted and projected into the audit log, where
`REDACTION_PATHS` never runs. The same rule Phase 7's events file states, for the same reason.

| Event                     | Payload                                  |
| ------------------------- | ---------------------------------------- |
| `rtc_session.started`     | sessionId, channelId, kind, invitedCount |
| `rtc_session.answered`    | sessionId                                |
| `rtc_session.joined`      | sessionId, participantCount              |
| `rtc_session.left`        | sessionId                                |
| `rtc_session.declined`    | sessionId                                |
| `rtc_session.ended`       | sessionId, reason, durationSeconds       |
| `turn_credential.issued`  | sessionId, ttlSeconds                    |
| `turn_credential.refused` | reason, issuedInWindow, capPerWindow     |

`turn_credential.issued` is a READ that gets an event, the same exception `recording.downloaded`
takes: issuing a relay capability is the moment a bandwidth bill becomes possible, and §3.4 is the
whole reason this phase has a gate.

---

## 5. New infrastructure

`coturn` in `compose.yaml`, alongside Postgres/MinIO/Mailpit/ClamAV — the same local-dev pattern.
It runs with `use-auth-secret` and the dev secret in `.env.example`; production takes it from the
secrets manager like every other credential.

STUN alone is enough on most developer networks, which is the trap: TURN paths stay untested until
someone is behind a symmetric NAT, in production. `RTC_ICE_TRANSPORT_POLICY=relay` forces every
candidate through the relay so the TURN path can be exercised deliberately.

---

## 6. What is still not done

Stated so a later reader does not mistake a scoped delivery for a defect:

- **Public channels cannot start a call.** Ringing is derived from the channel's `member` tuples
  (`channelMemberIds`), and a public channel's readership is the whole org with no tuple roster to
  ring. Fanning out to every member of an organization is not a smaller version of the right
  behaviour, it is a different and much worse one.
- **No WEB PUSH for a call when the tab is closed.** Wave 2 rings every open tab and writes a
  missed-call notification, which flows through Phase 9's push relay on the ordinary
  notification path. A live ring to a closed tab needs a service worker that can wake and play
  audio, which is a different mechanism from the socket.
- **No video, screen share, or device selection.** Wave 3.
- **No reconnect-and-resume of a live peer connection.** A dropped socket ends that participant's
  leg; they rejoin. Renegotiation across a transport drop is a Wave 3 concern.
- **No retention policy for recordings.** §3.9 shipped a Files-tab-shaped browsing surface (below)
  but never a deletion schedule — a stored capture lives forever until someone builds one, the same
  open question Chat's own retention took a dedicated Wave 4 to answer.

### Closing the listing/playback gap, and the rest of the details-panel surface (2026-08-10)

**"Recordings have no listing or playback UI" is no longer true.** `apps/api/src/rtc/recording.service.ts`
gained `listRecordingsForChannel` and `presignRecordingDownload` — the second gated on `status = 'stored'`
exactly like `presignRecordingUpload`, and auditing every issuance as `rtc_recording.downloaded` before
the URL is minted, the same ordering `telephony/recording.service.ts`'s own `presignDownload` uses and
for the same reason (§4's `turn_credential.issued` precedent: a read that mints a capability gets an
event). Authorization is `channel:read` on the call's channel, not a narrower "was this person a joined
participant" — the same line `recordingStatus` already draws for the live consent checklist, restated
rather than tightened for a downloaded copy.

Four more surfaces landed alongside it, none of them a new wave on their own so much as the WhatsApp-shaped
group-info screen this phase never had a UI for:

- **`rtc.history.list`** (`session.service.ts`) — every call a conversation has had, with each
  participant's join/leave times and state. Feeds a Calls tab in the details panel (expandable per
  call, showing who joined a group call and for how long, plus the listen/download control when a
  recording exists) and call cards interleaved into the message timeline by timestamp — "Voice call ·
  3m 12s", "Missed voice call", "You declined this call" — a parallel resource merged into the render
  the same way Phase 7's SMS/WhatsApp threads sit beside `chat.channels` rather than becoming a new
  message kind (§3.8 there): a schema change to `chat.messages` for a system-authored row was not
  worth the read-cursor and unread-count questions it would raise for a fact this file already had
  a place to read from.
- **Pinned and starred, scoped to one conversation.** `chat.messages.pins` gained an `excerpt` field
  it was missing relative to its own org-wide sibling `allPins`; the Saved section filters the
  already-cached org-wide `chat.saved.list` to the open channel rather than adding a second route for
  a query that was already cheap.
- **`chat.attachments.listForChannel`** — a Files tab resolved by `channelId` directly (a join through
  `messages`, not the existing `list` route's message-id-bag shape), because a details panel wants
  "everything ever shared here," not only whatever page of messages happens to be scrolled into view.
- **Ringing and call duration, both ticking, and a genuine missed-call signal.** The incoming-call
  banner now shows how long a call has been ringing (from the session's own `createdAt`, not from
  when this tab noticed); the active-call bar shows elapsed time from the first remote stream, not
  from `status` — the calling side's `status` flips to `in_call` the instant ringing STARTS, and
  counting from there would show a duration nobody was talking for. A banner that disappears because
  the call was answered elsewhere, cancelled, or timed out now says which, via a toast keyed off the
  `call:ended` socket message's `reason` — suppressed for the one case that needs no telling
  (`decline`'s own broadcast reaching the tab that just clicked it). The receiver's decline button
  was also relabelled from "Cancel" — a word that means something different when you did not place
  the call.

### Reversed: hanging up now finishes a recording rather than discarding it (2026-08-10)

Wave 2 shipped `hangUp()` abandoning an in-progress `MediaRecorder` (`recorder?.cancel()`) rather
than uploading it, on the reasoning that "the person who wants the file presses stop, which
uploads it" — a hangup that silently uploaded would store audio nobody asked to keep at the moment
they were leaving.

That reasoning did not survive contact with an actual call: a real session's API logs showed
`recording.request` → `answer` → `start` → a normal run of `recording.status` polls, then
`rtc.leave` with no `recording.stop`, `presignUpload`, or `confirmUpload` anywhere — the recording
was captured correctly and the file was never uploaded, because hanging up **was** how the call
ended, the same way it ends most calls. The row sat in `rtc.recordings` at `status: 'pending'`
forever, which is indistinguishable from "no recording happened" to `listRecordingsForChannel` and
therefore to the Calls tab that reads it — not a bug in that read path, a correct report of a
capture that was thrown away.

Confirmed with the project owner: losing a recording someone explicitly started because they used
the ordinary "Hang up" button instead of a second dedicated one is worse than uploading a capture
nobody pressed an extra button to keep — the first is unrecoverable, the second can just be
deleted. `hangUp()` now finishes and uploads an in-progress capture before tearing down the mesh
and local tracks (order matters — the recorder's audio graph is built from those streams, so
stopping them first would capture silence for the last moment rather than what was actually said).
A failed save surfaces as a dismissible notice, `recordingSaveError`, using the exact "outlives the
call" shape §3.1's `evicted` flag already established: the call UI is gone by the time an upload
either succeeds or fails, so the fact has to be carried past the state reset that would otherwise
lose it.

### Found immediately after the reversal above: every real upload 403'd (2026-08-10)

The very first recording that actually reached `finish()` — because the reversal above stopped
throwing them away — failed with a 403 from storage. `presignUpload` (§ above) signs
`Content-Length` into the request, and `presignRecordingUpload` was signing it against
`deps.maxRecordingBytes`, the DEPLOYMENT'S CEILING, not the capture's real size. A browser's
`fetch()` always sends the body's actual byte count as `Content-Length` — a forbidden header name
nothing can override — so a signature pinned to the ceiling validates only a body that happens to
be exactly that many bytes. Every real recording is smaller than the ceiling, so every real upload
failed the same way.

This is the identical shape of bug `packages/storage/src/s3.ts`'s own header already documents
once, for `Content-Type` — a signed value the caller does not actually control matching. It reads
as safe ("the size is pinned, storage will reject anything else") and is backwards: `chat.attachments`
gets this right because the browser knows a FILE's size before asking to upload, and passes it as
`sizeBytes` in the presign request itself; a recording's real size is not known until AFTER capture
stops, which `presignRecordingUpload` never had a field to receive. Fixed the same way attachments
already do it: `presignUpload`'s input now carries `bytes` — the just-measured real size — and the
service signs THAT, checking it against `maxRecordingBytes` as a validation ceiling rather than a
signed value. Nothing caught this before because nothing had reached a real upload before: `hangUp`
discarded every capture until the reversal above, and the explicit Stop button, the only other path
to `finish()`, apparently never ran against a real S3-compatible backend either.
