# TaskFlow — Capabilities Overview

*A complete inventory of what's actually built, module by module.*

---

## What TaskFlow is

A multi-tenant company platform covering six areas most teams currently pay for separately: **Work** (project/task tracking), **Chat** (team messaging), **Docs** (collaborative pages), **Voice & Messaging** (calling/SMS), **People** (org directory), and **Platform** (admin/audit). One data model, one permission system, one real-time layer underneath all six — not six tools bolted together.

Built solo, with AI doing most of the actual typing. The organizing principle: since one person can't catch every mistake in code review the way a team would, the architecture is built so entire classes of bugs — especially cross-tenant data leaks — can't be expressed at all, rather than relying on vigilance to catch them.

---

## 1. Work — project & task tracking

**Core structure:** Projects → Boards → Lists → Cards, each level scoped to the ones above it (a card can't exist outside its board's list, enforced by the database, not application logic).

- **Boards & lists**: create, rename, archive, reorder. Drag-and-drop card and list ordering using a fractional-ranking scheme that stays short even after thousands of insertions at either end of a list.
- **Cards**: title, rich-text description (TipTap JSON, never raw HTML — closes an XSS path by construction), due dates, start dates, priority, status.
- **Custom fields**: per-project field definitions (text, number, select, etc.), with type immutability once created (no silent `select`→`number` migrations that would corrupt data).
- **Labels**: per-project label set, multi-label per card, filterable.
- **Checklists**: multiple per card, live-updating done/total counts, optimistic add/tick/delete.
- **Assignees**: multiple people per card.
- **Comments**: separate permission from editing the card itself — someone can be given a voice on a board without edit rights. Author-only edit, author-or-moderator delete.
- **Attachments**: presigned direct-to-storage upload, MIME-type and magic-byte validated, virus-scanned (fails closed — if the scanner can't be reached, the file is rejected, not silently allowed through).
- **Sprints**: create, assign cards to a sprint, complete a sprint, board view scoped to sprint.
- **My Tasks**: a cross-project view of everything assigned to you.
- **List view**: a flat, sortable, groupable table alternative to the board view.
- **Filtering & saved views**: a full filter-builder (status, assignee, label, due date, text search, etc.), savable as named views per board.
- **TQL (TaskFlow Query Language)**: a typed text query language — the same filters expressed as searchable text, with `@me` and relative dates (`-7d`) staying symbolic until the query actually runs, so a shared saved search means "assigned to whoever runs it," not "assigned to whoever saved it."
- **Bulk actions**: multi-select cards, bulk status/assignee/label changes.
- **Command palette & keyboard shortcuts** for fast navigation without a mouse.
- **Real-time sync**: another person moving a card, changing a status, or commenting shows up live, no refresh — Socket.io rooms per board, reconciled with a database poll so a missed event during a dropped connection still arrives.

## 2. Chat — team messaging

- **Channels**: public and private, per-org.
- **Direct messages**: 1:1 and group DMs.
- **Threads**: reply-in-thread without cluttering the main channel.
- **Reactions, pins, read cursors ("unread" tracking), typing indicators.**
- **File sharing** inside messages, with the same scan/validate pipeline as Work attachments.
- **Link unfurls**: pasted URLs render a preview card.
- **Slash commands.**
- **"New messages" divider**, channel-type glyphs (public/private/DM at a glance), read-only notice on archived channels.
- **Org-wide Saved Messages** and a **notification center**.
- **"Who reacted" view** on a long-press.
- **@mention** with live autocomplete, including mid-string mention editing.
- **Native rich text composer** (bold, links, lists) on message composer, thread replies, and — shared with Docs — card descriptions and comments.
- **Retention policies and legal hold**: an org can set how long messages persist, and place a legal hold that overrides normal deletion — real compliance functionality, not just message history.
- **Compliance export**: pull a channel or org's message history out for legal/audit purposes.
- **Guest access**: external people can be invited into specific channels without full org membership.
- **Click-to-call and SMS** directly from a chat thread, a contact, or a DM (bridges into the Voice & Messaging module).

## 3. Docs — collaborative pages

- **Spaces and a page tree**: nested pages, move/reparent with automatic rank assignment.
- **Real-time collaborative editing**: multiple people editing the same page simultaneously, powered by Yjs (CRDT-based) over a dedicated WebSocket gateway — genuinely concurrent, not lock-and-wait.
- **Durable persistence**: every edit is written to a write-ahead log, so a crash mid-edit doesn't lose content; loading a page replays the latest snapshot plus any tail updates since.
- **Page versions**: save a named version, restore to it later. Restoring correctly discards edits made after the save point rather than merging them back in.
- **Comments and suggestions**: anchored to a specific block or selection (not just "somewhere on this page"), and the anchor survives concurrent edits landing before it.
- **Backlinks**: automatically computed — see which other pages link to the one you're viewing — without exposing the content of pages you can't read.
- **Publish to public**: expose a specific, chosen page version to anyone with the link, independent of your org's internal permissions, without accidentally exposing a draft or another page.
- **PDF export**: server-rendered, not a browser screenshot.
- **Page templates.**
- **Permission inheritance**: a page's permissions default to its parent's unless explicitly overridden, resolved through the same tree the UI shows you.

## 4. Voice & Messaging — calling & SMS

- **Phone numbers**: search and provision real numbers.
- **Outbound & inbound calling**, with a spend cap, geographic allowlist (closed by default — a new country/prefix must be explicitly allowed), and per-org velocity limiting.
- **SMS threads**: two-way texting, STOP/UNSUBSCRIBE compliance handled automatically.
- **Call recording**, gated behind explicit consent — recording literally cannot start unless the required announcement has played and/or consent has been captured, enforced at the database level, not just in application code.
- **Transcripts** of recorded calls.
- **Cost-attribution reporting**: see spend broken down by kind (calls, SMS, number purchases, automation-triggered calls/SMS).
- **Click-to-call** from a contact card, a chat thread, or a person's profile.
- **In-app voice calling (WebRTC)**: browser/app-to-app calls that never touch the phone network, with ringing, custom ringtones, missed-call notifications, and native OS integration (CallKit on iOS, ConnectionService on Android) so an incoming call rings like a real phone call even if the app isn't in the foreground.
- **Multi-party consent for recording**: if anyone joins an in-progress recorded call without consenting, the recording pauses automatically rather than silently continuing.
- **Org-freeze kill switch**: an org's outbound telephony can be frozen entirely (used automatically when an org is suspended), so a compromised account can't run up a phone bill.

## 5. People — org directory

- **Directory** of everyone in the org: name, role, contact info.
- **Reporting lines**: who reports to whom.
- **Teams**: group people for chat/permission purposes.
- **Membership profiles**: org-specific info per person (e.g., a work phone number), scoped so it's never visible to a person's *other* orgs.
- **Self-serve data export (DSAR)**: a user can export their own data.

## 6. Platform — administration & audit

- **Org settings**: rename, manage members, invite/remove, role changes.
- **Feature flags**, settable per org.
- **Hash-chained audit log**: every state-changing action in the product writes an audit entry, and the entries are cryptographically chained so an entry can't be altered or deleted after the fact without breaking the chain — verifiable, not just logged.
- **Platform admin console** (operator-only, separate role from any org's own admins): org directory, suspend/reactivate an org, global feature-flag overrides, a global operator audit log covering every admin action including reads.
- **Billing**: plan catalog, checkout, plan changes, cancellation, a billing portal, and invoice history — built on Stripe. *(Whether this is actually configured with live payment processing on any given deployment is a per-deployment setting, not a codebase fact — check your own environment's configuration rather than assuming.)*
- **Org suspension**: independent from billing status, so an automated billing action can never silently override a manual operator decision or vice versa. A suspended org's API routes, realtime connections, and Docs access are all cut off from the same single check.
- **Multi-tenancy**: every table, every query, every socket room is scoped to one organization. An organization can never see another's data even if application code has a bug — enforced by the database (row-level security), not by remembering to add a `WHERE org_id = ...` clause everywhere.

## Security architecture (the actual differentiator)

This is what separates TaskFlow's pitch from "we built a chat app":

- **Tenant isolation by construction**: every database query goes through one shared, tenant-scoped client. Skip it, or get the org wrong, and the query returns zero rows — never another org's data.
- **One policy gate for every permission check**: authorization logic lives in a single module; comparing roles directly anywhere else in the codebase is a compile-time lint error.
- **Banned raw primitives**: raw SQL, cryptographic operations, and non-cryptographic randomness are all lint-banned outside a small number of audited files — one primitive per file, so there's exactly one place to review for each.
- **Tamper-evident audit log**: every mutation writes a hash-chained entry, so a write can't be quietly altered after the fact.
- **Real bugs found and fixed this way, honestly documented**: this isn't a theoretical claim. A caching bug that briefly leaked one account's data into another session after sign-out was found and fixed during development — evidence the process catches real mistakes, not proof none exist.

## Mobile

- **Android app**, distributed as a direct APK install (no Play Store account behind it yet).
- Feature parity effort with the web app across Work, Chat, Docs, Voice & Messaging, and account management — boards, My Tasks, card detail, chat with rich text and reactions, real-time Docs collaboration, in-app calling with native CallKit/ConnectionService integration, push notifications for calls and messages.
- **Passkey, OAuth, and biometric app-lock** support alongside password auth.
- **iOS**: not built yet. Android shipped first since it needed no app-store account to distribute.
