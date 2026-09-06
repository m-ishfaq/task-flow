# TaskFlow — Company Operating Platform

**Canonical build plan.** Six products on one identity, one permission model, one audit trail:
Work · Chat · Docs · Voice & Messaging · People · Platform.

- **Developer:** solo, AI-assisted
- **Hard constraint:** security is non-negotiable
- **Budget:** $0/month through Phase 6; ~$2/month thereafter
- **Estimated duration:** ~18 months solo full-time

> **Free-tier caveat.** Every free-tier limit quoted in this document was accurate at time of
> writing and changes frequently. Verify current terms before committing to any provider.
> §5 (Provider Interfaces) exists so that none of these choices are load-bearing.

---

## Table of Contents

1. [Product Thesis](#1-product-thesis)
2. [The Security-First Development Model](#2-the-security-first-development-model)
3. [Product Surface](#3-product-surface)
4. [Tech Stack](#4-tech-stack)
5. [Provider Interfaces](#5-provider-interfaces)
6. [Repository Layout](#6-repository-layout)
7. [Data Architecture](#7-data-architecture)
8. [Security Architecture](#8-security-architecture)
9. [Real-Time Architecture](#9-real-time-architecture)
10. [Module Designs](#10-module-designs)
11. [Testing & CI Gates](#11-testing--ci-gates)
12. [Infrastructure & Deployment](#12-infrastructure--deployment)
13. [Roadmap](#13-roadmap)
14. [Cost Timeline](#14-cost-timeline)
15. [Risk Register](#15-risk-register)
16. [Decision Log & Open Questions](#16-decision-log--open-questions)

---

## 1. Product Thesis

Four separate tools — Jira, Slack, Confluence, Twilio — mean four identities, four permission
models, four audit trails, four search indexes, and no automation that crosses between them.

TaskFlow's entire reason to exist is that these are **one system**:

- A card assignment notifies you in chat, on your phone, or by email — one preference model.
- A doc page links a card, a card links a call recording, a call creates a card.
- One search finds a message, a page, a card, and a transcript in one result set.
- An automation can span all four: _card → Done_ fires _post to #releases_ and _update the runbook page_.
- One audit log answers "who touched this customer's data" across every product.
- One permission decision governs whether you can see a card, a channel, a page, or a recording.

This coherence is the product. It must be visible in the architecture — shared identity, shared
policy engine, shared event stream, shared search — not four apps behind one login.

---

## 2. The Security-First Development Model

This system is built solo with heavy AI assistance and cannot compromise on security. Those two
facts are in genuine tension, and resolving it is the most important design decision in the plan.

Fast AI-generated code reliably produces a specific set of defects: a query missing its tenant
filter, a route missing its permission check, an unvalidated webhook, an over-shared ID, a
secret in a log line. Code review by one tired person does not reliably catch these.

**The resolution: make insecure code structurally impossible to write.** Guardrails that fail at
compile time or in CI, never relying on human vigilance. This section is the spine of the plan.
Every later section assumes it.

### 2.1 The eleven guardrails

| #   | Guardrail                            | Mechanism                                                                                                                                                                                                    | Defect class eliminated                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1   | **Branded ID types**                 | `type OrgId = string & { readonly __brand: 'OrgId' }` for every entity. Constructed only by parsers at trust boundaries.                                                                                     | Type-confusion IDOR; passing a `UserId` where a `ChannelId` belongs                     |
| 2   | **No raw DB access in feature code** | `packages/db` exports only `db.forOrg(ctx)`. The unscoped client is not importable outside the data layer — enforced by ESLint module boundaries.                                                            | Queries missing `WHERE org_id = ?`                                                      |
| 3   | **Postgres Row-Level Security**      | Every tenant table carries an RLS policy on `current_setting('app.org_id')`, set per-transaction from the verified token.                                                                                    | Cross-tenant leakage _even when guardrail 2 is bypassed_                                |
| 4   | **Fail-closed route builder**        | A procedure without `.meta({ permission })` is a **type error**. The router additionally throws at boot if any registered route lacks a declared permission.                                                 | Unprotected endpoints                                                                   |
| 5   | **Generated client**                 | tRPC. The frontend cannot call an endpoint that doesn't exist or send a wrong-shaped payload.                                                                                                                | FE/BE contract drift                                                                    |
| 6   | **Zod at every boundary**            | Request input, response output, env vars, webhook bodies, queue payloads. `.strict()` by default — unknown keys rejected.                                                                                    | Injection, mass assignment, prototype pollution                                         |
| 7   | **Banned constructs**                | ESLint bans: raw SQL template strings, `dangerouslySetInnerHTML`, `role ===` outside `packages/policy`, bare `process.env`, `Math.random()`, `node:crypto` outside `packages/security`, `any`, `@ts-ignore`. | The classic five                                                                        |
| 8   | **Tenancy isolation fuzz test**      | CI creates two orgs and calls **every registered endpoint** cross-tenant, asserting 403/404. New endpoints are enrolled automatically from the router manifest.                                              | The most common multi-tenant SaaS breach                                                |
| 9   | **Authorization matrix test**        | Table-driven assertion of every `(role × action × resource)` pair against the spec in §8.2.                                                                                                                  | Silent permission regressions                                                           |
| 10  | **Human-review allowlist**           | AI may write anything, but **seven surfaces require deliberate human review before merge**.                                                                                                                  | The places where automated generation is not yet trustworthy                            |
| 11  | **Mandatory domain events**          | A service method that mutates state without emitting a typed event from `packages/events` fails lint.                                                                                                        | Silently skipped audit entries, notifications, search indexing, and automation triggers |

### 2.2 The seven surfaces requiring human review

No AI-generated change to these merges without the developer reading every line:

1. `packages/policy` — permission definitions and evaluation
2. `packages/db` — tenant scoping and RLS policies
3. `apps/api/src/identity` — authentication, tokens, session lifecycle
4. `packages/security` — cryptography, hashing, envelope encryption, redaction
5. Any webhook signature verification
6. Any file upload/download path
7. Any code touching telephony spend

Enforced with `CODEOWNERS` plus a CI label check. This is not a productivity tax on the whole
codebase — it is roughly 5% of the code carrying 90% of the risk.

### 2.3 Compensating for solo review

**Guardrail 10 is the weakest guardrail on a solo project, and pretending otherwise would be
dishonest.** "Human review" normally means a second person; here it means reviewing your own
AI-generated code, which catches materially less. Three compensating controls apply to the seven
surfaces above:

1. **Adversarial second pass.** A fresh AI context with an explicit attacker prompt — "find the
   authorization bypass in this file" — not a "does this look correct" pass. Different framing
   surfaces different defects.
2. **Property-based tests, not example tests.** `fast-check` against the policy engine, token
   lifecycle, rank generation, and TQL compiler. Generated adversarial inputs find what
   hand-written cases miss, which is exactly the gap solo review leaves.
3. **One paid external review** of `apps/api/src/identity` and `packages/policy` before any real user
   data touches the system. A few hundred dollars, scheduled in Phase 13 alongside the
   penetration test — the highest-value money in the project.

### 2.4 Why guardrails beat review

Guardrails 3, 8, and 10 are the ones this project would not ship without. Guardrail 3 means a
single missed `WHERE` clause is not a breach. Guardrail 8 means a regression is caught by a
machine in ninety seconds rather than by a customer. Guardrail 10 means the small set of code
that genuinely requires human judgment actually gets it.

---

## 3. Product Surface

### 3.1 Work

Workspaces → projects → boards → lists → cards. Kanban, table, calendar, and timeline views.
Sprints, story points, epics, dependency graph, custom fields, checklists, labels, time tracking,
board templates, per-board automations.

### 3.2 Chat

Public and private channels, DMs, group DMs, threads. Reactions, edits, pins, saved items,
mentions. Typing indicators, presence, per-channel read cursors and unread counts. File sharing,
link unfurls, slash commands. Per-channel retention policies, legal hold, and compliance export.
Channel-scoped guest access for external collaborators.

### 3.3 Docs

Spaces containing nested page trees. Real-time collaborative editing via Yjs CRDT. Inline
comments and suggestions, version history with restore, templates, permissions inheriting down
the tree, publish-to-public, PDF export, backlinks.

### 3.4 Voice & Messaging

Per-org phone number provisioning. Click-to-call from any card, contact, or chat thread. Inbound
routing with IVR and queues. Call recording behind a consent gate, transcription, recordings
attachable to cards. SMS and WhatsApp threads surfaced in the Chat inbox. Twilio Verify as an MFA
fallback. Full call and message log with per-org cost attribution.

**Depends on Phase 12 Wave 1 for one thing specifically: a real org-suspension kill switch.**
[ai/phase-12-admin.md](ai/phase-12-admin.md) makes `identity.orgs.status` enforced for the first
time — today it's a column nothing reads. That enforcement sits in `resolveOrgMembership`, so it
is free for every Phase 7 route that goes through the ordinary authenticated request path (buying
a number, click-to-call, sending an SMS from the UI) the moment both phases exist — no Phase-7
code has to check org status itself for those. It does **not** cover the paths that make telephony
the expensive phase in the first place: an inbound Twilio webhook, a queued outbound send, or a
spend-cap worker have no `x-taskflow-org` header and no request to authenticate — see §8.5's new
row and `ai/phase-12-admin.md` §9 for what Phase 7 has to do about that itself.

### 3.5 People

Org directory, teams, reporting lines, profiles, timezones, working hours, out-of-office. Role
and group management. Session and device inventory. SCIM provisioning.

Split across three roadmap phases (§13): teams and role/group management shipped in Phase 2;
profiles, canonical timezone, working hours, out-of-office, and reporting lines are Phase 11.5;
session/device inventory and SCIM are Phase 12.

### 3.6 Platform

Unified cross-product search (TQL + visual builder). Notification routing across in-app, email,
SMS, and push with granular preferences. Cross-product automation rules engine. Analytics.
Audit. Public API and outbound webhooks. Integration hub.

---

## 4. Tech Stack

### 4.1 Frontend

| Concern         | Choice                                   | Note                                                                       |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| Core            | React 19, TypeScript strict, Vite 6      | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`         |
| Routing         | TanStack Router                          | Typed routes and typed search params; route params arrive as branded types |
| Server state    | TanStack Query v5                        | + IndexedDB persistence for offline reads                                  |
| Client state    | Zustand                                  | Ephemeral UI only — **never mirrors server data**                          |
| Styling         | Tailwind CSS v4 + Radix UI primitives    | CSS-first config; Radix for accessible primitives                          |
| Forms           | React Hook Form + Zod                    | Schemas imported from `@taskflow/contracts`                                |
| Editor          | TipTap 2 + Yjs collaboration             | Stores JSON, never HTML                                                    |
| Drag & drop     | dnd-kit                                  | Keyboard-accessible sensors                                                |
| Realtime        | Socket.io client + y-websocket           | Two channels, see §9                                                       |
| Virtualization  | TanStack Virtual                         | Chat scrollback, table view                                                |
| Charts          | Recharts                                 |                                                                            |
| Command palette | cmdk                                     |                                                                            |
| Dates           | date-fns + `@date-fns/tz`                | Timezone-correct due dates and working hours                               |
| Testing         | Vitest, Testing Library, MSW, Playwright |                                                                            |

### 4.2 Backend

| Concern        | Choice                                                 | Rationale                                                                      |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Runtime        | Node 22 LTS                                            |                                                                                |
| Framework      | **Fastify 5**                                          | Fastest mature option; schema-first validation                                 |
| Internal API   | **tRPC v11**                                           | End-to-end type safety = guardrail 5                                           |
| Public API     | Fastify + **OpenAPI 3.1** generated from Zod           | Versioned, separately rate-limited, scoped tokens                              |
| Database       | **PostgreSQL 17**                                      | RLS is the decisive factor — see §8.3                                          |
| ORM            | **Drizzle**                                            | SQL-first, no engine binary, composes cleanly with RLS session variables       |
| Queues         | **pg-boss**                                            | Postgres-backed; job enqueue is transactional with the mutation that caused it |
| Realtime       | Socket.io + `@socket.io/postgres-adapter`              | No Redis required at single-instance scale                                     |
| Collaboration  | **Hocuspocus** (Yjs server)                            | Doc CRDT sync, persisted to Postgres                                           |
| Search         | Postgres FTS + `pg_trgm` → Meilisearch                 | Behind `SearchProvider`, see §5                                                |
| Object storage | **Cloudflare R2** (S3-compatible)                      | 10 GB free, zero egress                                                        |
| AV scanning    | ClamAV in worker                                       | Every upload, before it becomes downloadable                                   |
| Telephony      | **Twilio** (Voice, Messaging, Verify, Lookup)          | Test credentials during development                                            |
| Email          | **Resend** + React Email                               | 3,000/month free                                                               |
| Auth core      | Own it — `argon2`, `jose`, `@simplewebauthn`, `otplib` | Most security-critical path; must be fully auditable                           |
| Enterprise SSO | Deferred (see §13, Phase 12)                           | No enterprise customers yet                                                    |

### 4.3 Infrastructure

| Concern          | Free choice                                             | Note                                                     |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Compute          | **Oracle Cloud Always Free**                            | 4 ARM cores, 24 GB RAM, 200 GB storage, always-on        |
| Database hosting | Self-hosted Postgres on that VM                         | 200 GB, no connection limits, full RLS control           |
| Frontend hosting | **Cloudflare Pages**                                    | Unlimited bandwidth, commercial use permitted            |
| CDN / WAF / DDoS | **Cloudflare free**                                     | DDoS protection, TLS, 5 custom WAF rules                 |
| Object storage   | **Cloudflare R2**                                       |                                                          |
| Errors           | **Sentry** free                                         | 5k events/month                                          |
| Telemetry        | **Grafana Cloud** free                                  | 10k metrics, 50 GB logs, 50 GB traces                    |
| CI               | **GitHub Actions**                                      | 2,000 min/month on private repos                         |
| Secrets          | GitHub Actions secrets + **SOPS/age**                   | Encrypted-at-rest in git                                 |
| IaC              | Terraform                                               | Even for one VM — reproducibility is a security property |
| Containers       | Docker Compose (distroless, non-root, read-only rootfs) |                                                          |

**Oracle Always Free is the key unlock.** 24 GB of always-on RAM runs API, worker, realtime
gateway, Hocuspocus, Postgres, and later Meilisearch in a single `docker compose up`, with no
cold starts, no sleeping services, and no connection limits.

> **Operational note:** convert the Oracle account to Pay As You Go after signup. It still costs
> $0 while inside Always Free limits, but exempts the instance from idle reclamation, which can
> otherwise delete free-only accounts' VMs.

### 4.4 What the free tier changes — and why it's better

Redis is dropped entirely. This is not merely a cost decision:

| Was Redis         | Now                                  | Why it's an improvement                                                                                 |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| BullMQ queues     | **pg-boss**                          | Enqueue participates in the same transaction as the mutation. No "job fired but the write rolled back." |
| Socket.io adapter | `@socket.io/postgres-adapter`        | One fewer service to secure and operate                                                                 |
| Rate limiting     | Postgres table + in-process counters | Adequate at single-instance scale                                                                       |
| Presence          | In-process on the realtime gateway   | Ephemeral by nature; no persistence needed                                                              |
| Sessions          | Already Postgres                     | No change                                                                                               |

Redis returns when a second API instance appears — behind `QueueProvider` and the socket adapter
interface, so it is a config change.

---

## 5. Provider Interfaces

Every service that has a free implementation now and a paid one later sits behind an interface
defined in `packages/contracts`. Outgrowing a free tier must never require a rewrite.

| Interface           | Free implementation                                   | Paid upgrade                              | Trigger to switch                                   |
| ------------------- | ----------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `KeyProvider`       | `SoftwareKeyProvider` — master key from secrets store | AWS KMS / GCP KMS                         | First real customer data                            |
| `StorageProvider`   | Cloudflare R2                                         | R2 paid / S3                              | Past 10 GB                                          |
| `SearchProvider`    | Postgres FTS + `pg_trgm`                              | Self-hosted Meilisearch → Typesense Cloud | Past ~200k indexed rows or fuzzy quality complaints |
| `QueueProvider`     | pg-boss                                               | BullMQ + Redis                            | Second API instance                                 |
| `TelephonyProvider` | Twilio test credentials                               | Twilio live / Telnyx / SignalWire         | Live demo                                           |
| `MailProvider`      | Resend free                                           | Resend paid / SES                         | Past 3k/month                                       |
| `IdentityProvider`  | Own auth                                              | + WorkOS SAML/SCIM                        | First enterprise customer                           |

Each interface ships with a contract test suite that **every** implementation must pass. Swapping
providers is then a config change plus a green test run, not an audit.

This costs roughly one day in Phase 0 and is the single highest-leverage item in the plan.

---

## 6. Repository Layout

pnpm workspaces + Turborepo.

```
taskflow/
├─ apps/
│  ├─ web/                React 19 + Vite
│  │  └─ src/
│  │     ├─ features/     work/ chat/ docs/ comms/ people/ admin/
│  │     │  └─ <feature>/ api/  components/  hooks/  stores/
│  │     ├─ components/   design system consumers
│  │     ├─ lib/          query client, socket client, offline queue
│  │     └─ routes/       TanStack Router tree
│  ├─ api/                Fastify + tRPC + OpenAPI
│  │  └─ src/
│  │     ├─ modules/      <name>/ router.ts  service.ts  schema.ts
│  │     ├─ auth/         ⚠ human-review surface
│  │     ├─ middleware/   context, rate limit, error handler, request ID
│  │     └─ config/       Zod-validated env schema
│  ├─ realtime/           Socket.io gateway (separate process — different scaling profile)
│  ├─ collab/             Hocuspocus server
│  └─ worker/             pg-boss processors
├─ packages/
│  ├─ contracts/          Zod schemas, tRPC types, OpenAPI spec, provider interfaces
│  ├─ events/             Typed domain event registry + bus (see §10.6)
│  ├─ policy/             ⚠ permission definitions, can(), decision trace
│  ├─ db/                 ⚠ Drizzle schema, migrations, RLS policies, tenant-scoped client
│  ├─ security/           ⚠ crypto, tokens, hashing, envelope encryption, redaction
│  ├─ observability/      logger, metrics, tracing, redaction paths — sole OTel/Pino/Sentry entry
│  ├─ feature-flags/      Flag definitions + evaluation; every post-Phase-4 feature is gated
│  ├─ testing/            Shared harnesses: tenancy fuzz, authz matrix, provider contract tests
│  ├─ ui/                 Design system — extracted from Phase 3, not built upfront
│  └─ config/             ESLint (incl. custom security rules), tsconfig, prettier
├─ docs/
│  ├─ decisions/          ADRs — one file per architectural decision, never deleted
│  ├─ architecture/       Diagrams, data flow, threat model
│  ├─ api/                Generated OpenAPI + versioning policy
│  ├─ database/           Schema docs, migration strategy, index rationale
│  └─ security/           Control mapping, incident runbooks
├─ ai/                    rules.md · coding-style.md · security-checklist.md
│                         feature-template.md · review-checklist.md
├─ CLAUDE.md              Root context file — points into ai/, auto-loaded by Claude Code
├─ infra/                 Terraform
├─ docker/                Dockerfiles + compose files
└─ .github/workflows/
```

`⚠` marks human-review surfaces from §2.2.

**On `packages/ui`:** do not build it speculatively. Radix + Tailwind covers most primitives;
extract a component only once the same pattern appears three times in Phase 3. A design system
built before it has consumers is a reliable time sink.

**On `ai/`:** these files are attached to every AI-assisted session so generated code matches the
architecture rather than generic conventions. `CLAUDE.md` at the root is the entry point because
that is the file Claude Code loads automatically; a generic `rules.md` will not be.

Three module-boundary rules carry the whole guardrail system and are ESLint-enforced:

1. `packages/db` exports only the tenant-scoped client outside itself.
2. `packages/policy` is the only module permitted to compare roles.
3. `packages/observability` is the only module permitted to import Pino, Sentry, or OTel directly.

---

## 7. Data Architecture

**PostgreSQL 17. One database, schema per concern, `org_id` on every tenant table, RLS on all of them.**

| Schema     | Contents                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `identity` | users, orgs, memberships, teams, sessions, credentials, mfa_factors, api_tokens                                                           |
| `authz`    | roles, permissions, relationship_tuples, policy_overrides                                                                                 |
| `work`     | workspaces, projects, boards, lists, cards, card_links, sprints, checklists, custom_field_defs, custom_field_values, time_entries, labels |
| `chat`     | channels, channel_members, messages, threads, reactions, read_cursors, retention_policies                                                 |
| `docs`     | spaces, pages, page_versions, yjs_updates, page_comments, page_permissions                                                                |
| `comms`    | phone_numbers, calls, recordings, transcripts, sms_threads, sms_messages, consent_records, spend_ledger                                   |
| `platform` | activities, notifications, notification_prefs, automations, automation_runs, webhooks, integrations, saved_filters, attachments           |
| `audit`    | audit_log (append-only, hash-chained), audit_exports                                                                                      |

### 7.1 Cross-cutting conventions

**IDs — UUIDv7 everywhere.** Time-sortable for index locality, non-enumerable so there is no
`/card/1234` to probe.

**Partitioning from day one.** `chat.messages`, `platform.activities`, and `audit.audit_log` are
range-partitioned by month immediately. Retrofitting partitioning onto a live high-volume table
is genuinely painful; doing it upfront costs one afternoon.

**Soft delete vs archive vs erasure** are three distinct concepts:

- `archived_at` — user-visible, restorable, surfaced in the UI
- `deleted_at` — soft delete, purged by a retention job after a grace period
- **Crypto-shredding** — GDPR erasure, destroys the org's data key (§8.4)

**Optimistic concurrency** via a `version` column on cards, pages, and messages.

### 7.2 Notable table designs

**`work.cards`** — `rank` (base-62 string, fractional index), `number` (per-project sequence →
`WEB-142`), `description` (TipTap JSON) plus `description_text` (flattened, for search),
denormalized counters (`comment_count`, `checklist_done`), `version`.
Indexes: `(board_id, list_id, rank)`, `(org_id, assignee_ids, due_date)`, GIN on `description_text`.

**`chat.messages`** — ordering is a **per-channel monotonic sequence**, not a timestamp. Read
cursors reference sequence numbers, which turns unread counts into a single indexed range count
rather than a timestamp comparison across clock skew.

**`docs.yjs_updates`** — append-only Yjs update log, compacted into a snapshot every N updates by
a worker. `docs.page_versions` holds materialized snapshots at explicit save points. Three
independent recovery paths: live CRDT state, update log, version snapshots.

**`authz.relationship_tuples`** — Zanzibar-style `(subject, relation, object)`. Necessary because
`guest in #channel`, `viewer on doc-subtree`, and `member of team` do not fit flat roles.

**`audit.audit_log`** — append-only, each row containing the previous row's hash (§8.6).

### 7.3 Analytics

Materialized views refreshed on a schedule, never live aggregation over transactional tables.
ClickHouse is the documented escape hatch if any dashboard exceeds ~500 ms — but explicitly not
day one. Every additional service is additional attack surface, and on this project that
outweighs query speed.

### 7.4 Migration strategy — expand, migrate, contract

**No migration is ever breaking.** Every schema change is three separate deploys:

| Step         | Action                                                                           | Deploy safe to roll back? |
| ------------ | -------------------------------------------------------------------------------- | ------------------------- |
| **Expand**   | Add the new column/table, nullable or defaulted. Old code ignores it.            | ✅                        |
| **Migrate**  | Backfill in batches via a job. New code writes both, reads old. Then reads new.  | ✅                        |
| **Contract** | Drop the old column once no code references it — a separate release, days later. | ✅                        |

Consequences that are non-negotiable: columns are never renamed (add, backfill, drop);
`NOT NULL` is added only after a backfill completes; migrations never run inside the application
deploy transaction. Backfills are jobs, not migration scripts, so they are resumable and
observable.

Migrations run through a versioned runner as a pre-deploy step, using an elevated database role
unavailable to application code (§8.3). Every migration has a tested `down`, and CI verifies
`up → down → up` cleanly on every PR that touches the schema.

### 7.5 Seed data

Four seed profiles, all reproducible from a fixed random seed:

| Profile          | Contents                                                     | Purpose                                                              |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `seed-small`     | 1 org, 2 users, 1 board, ~20 cards                           | Fast local iteration, E2E fixtures                                   |
| `seed-demo`      | 3 orgs, realistic names, full history, all roles represented | Screenshots, demos, manual QA                                        |
| `seed-large`     | 1 org, 50 users, 100k cards, 500k messages                   | UI performance, virtualization, pagination                           |
| `seed-benchmark` | Partition-spanning volumes across 24 months                  | **Validates partitioning and index choices before real data exists** |

`seed-benchmark` is the one that matters most and is the easiest to skip. Query plans that look
fine on 20 rows are how index mistakes reach production.

---

## 8. Security Architecture

### 8.1 Identity

- **Argon2id** (19 MiB memory, t=2, p=1). Breached-password check via the HIBP k-anonymity API
  on every password set.
- **Passkeys (WebAuthn) as the primary factor**, shipped in Phase 1. TOTP secondary and Twilio
  Verify SMS fallback are deferred to Phase 12 — SMS is the weakest factor and is never
  sufficient alone for Owner or Admin roles.
- MFA **mandatory** for Owner/Admin; enforceable org-wide by policy.
- **Access token:** JWT, 10-minute lifetime, held in memory only. Never `localStorage`.
- **Refresh token:** 30 days, `httpOnly` + `Secure` + `SameSite=Strict` + `__Host-` prefix,
  **rotated on every use with reuse detection**. A replayed token revokes the entire token
  family and forces re-authentication.
- **Step-up re-authentication** required for: role changes, member removal, API token creation,
  phone number purchase, recording export, data export, workspace deletion.
- Session revocation ships in Phase 1. Device inventory UI and impossible-travel detection are
  deferred to Phase 12 — they are monitoring affordances, not access controls.

**What is deliberately deferred, and why the cut falls here.** The expensive, subtle, and
hard-to-retrofit parts of authentication are refresh rotation with reuse detection, step-up
auth, and the second factor — all of which ship in Phase 1. Passkeys via `@simplewebauthn` are
roughly 200 lines and cost far less than adding a second factor to live accounts later, which
requires enrollment flows, recovery codes, and step-up paths retrofitted onto existing sessions.

**OAuth is deferred to Phase 12**, ahead of passkeys, because it is the more expensive and more
dangerous of the two: provider registration, redirect URI handling, and **account linking** —
"this Google email already has a password account" is a subtle decision that has produced real
account-takeover vulnerabilities. A solo developer does not need social login to test the system.

### 8.2 Authorization

Central policy engine in `packages/policy`, consumed identically by the API, workers, socket
gateway, Hocuspocus, and the UI. The UI never re-derives rules — it asks the same engine.

Model is **RBAC + relationship tuples** (Zanzibar-lite) stored in Postgres.

**Four independent layers.** A bug in any one does not produce a breach:

```
Layer 1  Route declares required permission          → compile-time enforced (guardrail 4)
Layer 2  Policy engine evaluates role + tuples + resource attributes
Layer 3  Tenant-scoped data layer injects org context (guardrail 2)
Layer 4  Postgres RLS refuses cross-tenant rows regardless of app logic (guardrail 3)
```

**Roles:** Owner · Admin · Member · Guest, at org level, with per-resource overrides and
relationship-based grants (channel membership, doc-tree viewer, team membership).

| Capability group                          | Owner |    Admin    |      Member       |         Guest         |
| ----------------------------------------- | :---: | :---------: | :---------------: | :-------------------: |
| Org settings, deletion, billing           |  ✅   |     ❌      |        ❌         |          ❌           |
| Manage members & roles                    |  ✅   | invite only |        ❌         |          ❌           |
| View audit log                            |  ✅   |     ✅      |        ❌         |          ❌           |
| Project / board / space creation          |  ✅   |     ✅      |        ❌         |          ❌           |
| Automations, webhooks, integrations       |  ✅   |     ✅      |        ❌         |          ❌           |
| Telephony: buy numbers, export recordings |  ✅   |     ❌      |        ❌         |          ❌           |
| Place calls / send SMS                    |  ✅   |     ✅      | ✅ (within quota) |          ❌           |
| Card create / update / move               |  ✅   |     ✅      |        ✅         |          ❌           |
| Chat in channels                          |  ✅   |     ✅      |        ✅         | invited channels only |
| Edit docs                                 |  ✅   |     ✅      |        ✅         |  granted pages only   |
| Comment, upload, checklist                |  ✅   |     ✅      |        ✅         |   ✅ within grants    |

The full matrix lives in `packages/policy` and is asserted by guardrail 9.

**The policy engine returns a decision trace, not a boolean.** Every evaluation produces the
ordered list of rules considered, which tuples matched, which layer produced the outcome, and
why:

```
deny  card:update  card_9f3a  user_2b1
  ✓ layer 1  route declares card:update
  ✓ layer 2  role=member → grants card:update
  ✗ layer 2  tuple (user_2b1, viewer, board_71c) → read-only grant overrides role
  – layer 3  not reached
```

One mechanism, three uses: an admin debugging page (§10.7), the failure output of the
authorization matrix test, and a structured audit field on every denial. Debugging "why can't
this user see this" is otherwise the most miserable part of operating a relationship-based
permission model.

**OpenFGA is the documented upgrade path** if tuple volume outgrows Postgres.

### 8.3 Tenancy isolation

Every tenant table has RLS enabled:

```sql
ALTER TABLE work.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.cards FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.cards
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
```

Three details in those three lines are load-bearing, and all three were verified
against the real image by `docker/postgres/rls-probe.sql`:

- **`FORCE`** — without it a table's _owner_ bypasses every policy. `ENABLE` alone
  protects nothing from the role that ran the migration.
- **`NULLIF`** — the obvious `current_setting('app.org_id', true)::uuid` behaves
  differently depending on how org context went missing: unset yields `NULL` and
  filters correctly, but an empty string throws `22P02` and surfaces as a 500.
  `NULLIF` collapses both to `NULL`, so an unscoped query returns zero rows either
  way.
- **the `true` second argument** — makes `current_setting` return `NULL` for a
  missing setting instead of raising.

Every tenant table repeats this exact form. Any migration creating a schema must
also `GRANT USAGE ON SCHEMA <name> TO taskflow_app` — `USAGE` only makes the
namespace resolvable and grants no table access, but without it the app cannot
reach its own tables at all.

`app.org_id` is set with `SET LOCAL` inside the request transaction, derived from the verified
token — never from a request parameter. The application connects as a role **without**
`BYPASSRLS`. Migrations use a separate elevated role, unavailable to application code.

This is why Postgres was chosen over MongoDB. There is no comparable primitive in a document
store, and it is the layer that makes AI-assisted development of a multi-tenant system defensible.

### 8.4 Data protection

- TLS 1.3 everywhere, including internal service-to-service traffic.
- **Envelope encryption** for sensitive fields — phone numbers, recording URLs, transcripts,
  profile PII. Per-org data key wrapped by a master key from `KeyProvider`.
- **Crypto-shredding** for GDPR erasure: destroying an org's data key renders all its encrypted
  data unrecoverable. This is how erasure is actually satisfied at scale, rather than chasing
  rows across backups.
- Object storage private by default. Downloads only via 60-second presigned URLs issued after a
  fresh authorization check.
- **Upload pipeline:** presigned PUT with MIME type and size pinned in the signature → magic-byte
  verification on confirm → ClamAV scan → only then flagged downloadable. Served from a separate
  origin with `Content-Disposition: attachment`.

> **Free-tier downgrade:** `SoftwareKeyProvider` holds the master key in the secrets store rather
> than an HSM. The code path is identical to the KMS implementation; only the provider changes.
> This is a genuine, contained reduction in assurance and is the first thing to upgrade when
> real customer data arrives.

### 8.5 Telephony security

This is where most integrations fail, and where the money-loss risk lives.

| Risk                                    | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forged webhooks**                     | Validate `X-Twilio-Signature` on every inbound request. Reject unsigned. Non-negotiable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Webhook replay**                      | Nonce cache with a 5-minute window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **SMS pumping / toll fraud**            | Per-org hard spend caps with automatic cutoff · destination geo-allowlist (high-risk countries blocked by default) · per-user and per-number velocity limits · anomaly alerting. **The single most expensive failure mode in the system.**                                                                                                                                                                                                                                                                                                                        |
| **Recording consent**                   | Consent gate before recording begins · jurisdiction detected via Twilio Lookup · two-party-consent regions get an enforced announcement · consent event written to the audit log                                                                                                                                                                                                                                                                                                                                                                                  |
| **Recording exposure**                  | Recordings stored in your own object storage, never left on Twilio. Access requires explicit permission plus step-up auth. Every download audited.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **PII in transcripts**                  | Automatic redaction pass (card numbers, national IDs) before storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Opt-out compliance**                  | STOP/UNSUBSCRIBE honored automatically and permanently at org level; suppression list checked before every send                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Credential compromise**               | Twilio **subaccount per org** — a leaked credential's blast radius is one tenant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Abusive org, not just abusive usage** | Platform-operator org suspension (Phase 12 Wave 1, `ai/phase-12-admin.md`) as the manual kill switch, complementing the automatic per-org spend cap above — an operator can freeze an org on a support ticket or an anomaly alert **before** it ever trips the automatic cap. This needs Phase 7's own worker to treat `platform.orgSuspended` as a hard stop before any outbound Twilio API call: suspension enforcement elsewhere in the system runs at request-authentication time, which a webhook-triggered or queued telephony action never passes through. |

Fraud controls are built in Phase 7 from day one, not added after an incident. They are testable
end-to-end with free test credentials.

### 8.6 Audit

Append-only and **hash-chained** — each entry includes the hash of the previous entry, so
tampering is detectable. Written through a dedicated database role holding `INSERT` only, with no
`UPDATE` or `DELETE` grant.

Captures: actor, action, resource, before/after diff, IP, user agent, session ID, request ID,
timestamp. Daily export to immutable storage. Retention configurable per org, minimum one year.

**One event stream, two projections.** `platform.activities` powers user-facing timelines;
`audit.audit_log` is the compliance record with field diffs and network metadata, visible only to
Owner/Admin. One write path, two readers.

### 8.7 Application security

| Threat           | Control                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| XSS              | TipTap JSON only, never HTML. Server-side sanitization against a node/mark whitelist before persistence. `dangerouslySetInnerHTML` banned by lint.                                                                       |
| SQL injection    | Drizzle parameterized queries; raw SQL strings banned by lint                                                                                                                                                            |
| CSRF             | Double-submit token on all cookie-authenticated state-changing routes                                                                                                                                                    |
| Mass assignment  | Zod `.strict()` on every input schema                                                                                                                                                                                    |
| IDOR             | Branded types + RLS + UUIDv7                                                                                                                                                                                             |
| Rate limiting    | Per-IP, per-user, per-org sliding windows. Aggressive on auth (5/15 min login, 3/hour password reset), moderate on writes, generous on reads, quota-based on expensive endpoints (search, analytics, export, telephony). |
| SSRF             | Outbound webhook and unfurl URLs validated against an allowlist; private IP ranges blocked; redirects not followed                                                                                                       |
| Secrets in logs  | Pino redaction paths for tokens, passwords, phone numbers, recording URLs                                                                                                                                                |
| Header hardening | Helmet with real CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`                                                                                                                                                  |

### 8.8 Supply chain

`pnpm` with `ignore-scripts` and frozen lockfile · Renovate with grouped auto-merge for patch
releases only · **gitleaks** pre-commit and in CI · **Semgrep OSS** SAST · **Trivy** container and
dependency scanning · **OSV-Scanner** · **Checkov** on Terraform · **OWASP ZAP** DAST against
preview · SBOM via Syft · **cosign**-signed images · signed commits · branch protection.

**Any high or critical finding fails the build.** No exceptions, no bypass flag.

> **Free-tier downgrade:** CodeQL requires GitHub Advanced Security on private repos. Semgrep OSS
> covers most of the same ground. Every other tool above is free.

### 8.9 Runtime

Distroless non-root containers, read-only root filesystem, dropped capabilities, seccomp
profiles. Only the reverse proxy is internet-reachable; all services bind to a private Docker
network. Cloudflare in front for TLS termination, DDoS protection, and WAF rules.

> **Free-tier downgrade:** Cloudflare free provides DDoS protection and 5 custom WAF rules, not
> managed OWASP rule sets. Those 5 rules go to auth endpoints and the public API. Application-layer
> rate limiting and Zod validation carry the rest.

### 8.10 Compliance readiness

SOC 2 control mapping maintained from Phase 0 — dramatically cheaper than retrofitting.
GDPR: DSAR export, right-to-erasure via crypto-shredding, processing records, configurable
retention per data class. Threat model written in Phase 0 and updated each phase. Third-party
penetration test scheduled in Phase 13.

---

## 9. Real-Time Architecture

Three channels, deliberately separated by scaling profile and trust model:

| Channel               | Transport                      | Carries                                       | Write path?                           |
| --------------------- | ------------------------------ | --------------------------------------------- | ------------------------------------- |
| **App events**        | Socket.io + Postgres adapter   | Card moves, comments, notifications, presence | **No** — broadcast only               |
| **Chat delivery**     | Socket.io, dedicated namespace | Message fanout, typing, read receipts         | **No** — REST writes, socket delivers |
| **Doc collaboration** | Hocuspocus (y-websocket)       | Yjs CRDT updates, awareness cursors           | **Yes** — CRDT _is_ the write model   |

**Architectural rule: sockets broadcast what already happened.** All mutations go through the API,
where validation, authorization, audit, and job enqueueing already live. Two write paths is the
single most common source of subtle inconsistency in systems like this.

Docs are the one justified exception, because CRDT convergence is the write model. Hocuspocus
gets an authorization hook calling the same policy engine before granting document access, and
its persistence layer writes through the same tenant-scoped data layer.

**Room joins are authorization decisions, never client assertions.** Presence is in-process and
ephemeral. On reconnect, clients refetch and diff rather than replaying a missed event log —
simpler and correct. Every payload carries `{ mutationId, actorId, version }`; clients drop
echoes of their own `mutationId`, and version mismatches trigger a targeted refetch.

---

## 10. Module Designs

### 10.1 Card ordering (Work)

The most interesting technical problem in the Work module, and it is designed rather than improvised.

**Fractional indexing with base-62 string ranks.** Lists and cards carry `rank: string`, sorted
lexicographically within their parent.

- Insert between two neighbours → generate a string strictly between their ranks. **Single-row
  write**, no neighbours touched.
- Concurrent inserts may produce equal ranks; sort is `(rank, id)` so ordering stays total and
  deterministic.
- Ranks lengthen under repeated same-point insertion. A `rank-rebalance` job renormalizes a list
  past a threshold and broadcasts a full reorder.

**The move API takes neighbours, never a computed rank:**

```
cards.move({ cardId, targetListId, beforeCardId?, afterCardId? })
```

The server derives the rank. Two clients dragging simultaneously converge instead of fighting
over an index.

`packages/contracts/rank.ts` is unit-tested independently against adversarial cases: repeated
midpoint insertion, boundary characters, empty list, single element, 10,000 sequential inserts.

### 10.2 Search & TQL (Platform)

**TQL (TaskFlow Query Language)** — Jira's power without JQL's opacity.

```
assignee = me AND status != Done AND due < "next friday" ORDER BY priority DESC
type IN (message, page) AND author = @ali AND updated > -7d
label IN (bug, urgent) AND board = "Website" AND points > 3
```

Pipeline: `tokenize → parse to AST → validate fields and operators against a whitelist → compile
to a parameterized query`. **The whitelist is the security control** — no user string ever
reaches the database as a field name or operator.

**The AST ships in Phase 3; the text parser ships in Phase 8.** This split matters. The AST plus
its compiler and evaluator are needed immediately for board filters, and again in Phase 10 for
automation conditions. The tokenizer and parser are only needed once users type queries. Build
the AST early and the parser late, and filtering is built once:

```
Phase 3   visual filter builder ──► AST ──► SQL compiler      (board / table / calendar views)
Phase 10  automation conditions ──► AST ──► in-memory evaluator
Phase 8   TQL text ──► parser ──► AST                          (same tree, second frontend)
```

Building ILIKE search in Phase 3 and TQL in Phase 8 would mean writing filtering twice and
throwing one away.

**The visual builder edits the AST directly.** Dragging a filter chip regenerates the TQL text;
editing the text reparses into chips. Users learn the language by using the builder — precisely
what Jira fails to do.

### 10.3 Automation engine (Platform)

Cross-product rules: **trigger → conditions → actions**.

- **Triggers:** card created/moved/field-changed · due date approaching · comment added ·
  checklist completed · message posted matching a pattern · page published · call completed ·
  SMS received · schedule
- **Conditions:** the TQL AST evaluator from §10.2
- **Actions:** move card · set field · assign · add label · post chat message · create/update
  doc page · send notification · place call · send SMS · call webhook

**Execution:** the automation engine is a **consumer of the domain event bus** (§10.6), not a
subsystem with its own triggers. A mutation emits its typed event; the worker picks it up,
evaluates enabled rules against the AST evaluator from §10.2, and executes actions **through the
same service layer as user actions** — so automations produce events, activities, broadcasts,
notifications, and audit entries identically, for free.

Because both the event bus and the AST evaluator already exist by Phase 10, the engine itself is
a few hundred lines of orchestration rather than a new platform.

**Loop protection is mandatory and built day one:** every execution carries a depth counter, hard
capped; per-org hourly execution limits; run history with per-rule success/failure; a kill switch.
Actions with cost (SMS, calls) additionally check the spend cap from §8.5.

### 10.4 Views (Work)

Kanban (dnd-kit) · Table (TanStack Virtual, inline edit) · Calendar (month/week/day) ·
Timeline/Gantt with dependency rendering. All four read the same TQL-filtered query. Per-user
view preferences persisted.

### 10.5 Frontend state ownership

The rule that keeps a system this size maintainable:

- **Server state → TanStack Query, always.** Boards, cards, messages, pages, everything fetched.
- **Client state → Zustand, only** for things with no server representation: drag-in-flight, open
  modals, filter drafts, sidebar collapse, command palette.
- **Never mirror server data into Zustand.** This is the most common way apps like this rot.

Socket events invalidate or surgically patch the query cache from **one module** — the only place
outside a mutation that touches the cache.

Optimistic mutations on every user-visible interaction, each with `onMutate` (snapshot + patch),
`onError` (rollback + toast), `onSettled` (invalidate).

Card detail and page views are **route-driven** (`?card=`), so they are deep-linkable, shareable,
and back-button correct.

### 10.6 Domain events

`packages/events` defines a typed registry of everything that happens in the system. It is the
single seam between mutations and everything reactive.

```ts
CardCreated · CardMoved · CardAssigned · CardArchived
BoardCreated · ListReordered
MemberInvited · MemberRoleChanged · MemberRemoved
MessageSent · MessageEdited · ChannelCreated
PageUpdated · PagePublished
CallCompleted · SmsReceived · SpendThresholdCrossed
```

Every event carries `{ orgId, actorId, occurredAt, requestId, payload }`, with the payload shape
defined by Zod and the event name a discriminated union member.

**One producer, five consumers:**

```
service method
   └─► emit(CardMoved)  ──┬─► audit           (hash-chained record)
                          ├─► notifications   (fanout + batching)
                          ├─► realtime        (socket broadcast)
                          ├─► search          (index update)
                          └─► automation      (rule evaluation)
```

Three properties make this worth a dedicated package rather than ad-hoc calls:

1. **Guardrail 11.** A service method that writes but emits nothing fails lint. Without this, an
   AI-written handler silently skips audit and notification — and nothing fails, which is the
   worst kind of bug.
2. **Emission is transactional.** Events are written to an outbox table in the same transaction
   as the mutation, then dispatched by pg-boss. No "notification sent, write rolled back."
3. **New consumers are free.** Phases 8, 9, and 10 each add a consumer to an event stream that
   already carries real traffic, instead of retrofitting hooks into every mutation.

### 10.7 Permission debugging

An admin page rendering the decision trace from §8.2: pick a user and a resource, see every rule
evaluated, which tuples matched, which layer decided, and whether the grant was inherited,
explicit, or denied by override.

This exists because a relationship-based permission model is otherwise opaque at exactly the
moment you need it — a user reporting they cannot see something. Same mechanism powers the
authorization matrix test's failure output, so it stays correct by being continuously exercised.

---

## 11. Testing & CI Gates

Tests ship inside each slice. A slice with untested authorization is not done.

| Gate                                                                               | Tool                                               |     Blocks merge      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- | :-------------------: |
| Lint + typecheck                                                                   | ESLint (incl. custom security rules), tsc          |          ✅           |
| Unit — policy, ranking, TQL, crypto                                                | Vitest, ~100% on these                             |          ✅           |
| **Property-based** — policy engine, token lifecycle, rank generation, TQL compiler | `fast-check`                                       |          ✅           |
| Domain event coverage — every mutation emits (guardrail 11)                        | ESLint rule + integration assertion                |          ✅           |
| Integration — every route: happy / invalid / **unauthorized per role**             | Vitest + Testcontainers Postgres                   |          ✅           |
| **Tenancy isolation fuzz** (guardrail 8)                                           | Custom harness, auto-enrolled from router manifest |          ✅           |
| **Authorization matrix** (guardrail 9)                                             | Table-driven, full role × action grid              |          ✅           |
| Provider contract tests                                                            | Vitest, run against every implementation           |          ✅           |
| Socket & collaboration                                                             | socket.io-client + y-websocket harness             |          ✅           |
| Secret scan / SAST / dep audit / container scan / IaC scan                         | gitleaks, Semgrep OSS, OSV-Scanner, Trivy, Checkov |       ✅ high+        |
| E2E                                                                                | Playwright, multi-browser-context for realtime     |       on `main`       |
| DAST                                                                               | OWASP ZAP against preview                          |        nightly        |
| Load                                                                               | k6 — chat fanout, board hydration, call spikes     |      pre-release      |
| Penetration test                                                                   | Third party                                        | Phase 13, then annual |

The tenancy fuzz test and the authorization matrix are the two tests that make solo AI-assisted
development of a multi-tenant system defensible. They run in under two minutes.

---

## 12. Infrastructure & Deployment

**Local development:** `docker compose up` brings the full stack — Postgres (with RLS policies
applied), API, worker, realtime, collab, Mailhog, MinIO (R2 stand-in). Seed with any of the four
profiles from §7.5 (`pnpm seed:small` · `:demo` · `:large` · `:benchmark`).

**Environments:** `local` → `preview` (per-PR, ephemeral schema) → `production`.

**Production topology (free tier):**

```
Cloudflare  →  Pages (web)
            →  DNS / TLS / WAF / DDoS
                     ↓
        Oracle Cloud Always Free VM (ARM, 24 GB)
        ┌──────────────────────────────────────┐
        │  Caddy (reverse proxy, only exposed) │
        │    ├─ api        (Fastify + tRPC)    │
        │    ├─ realtime   (Socket.io)         │
        │    ├─ collab     (Hocuspocus)        │
        │    ├─ worker     (pg-boss)           │
        │    └─ postgres   (RLS enforced)      │
        └──────────────────────────────────────┘
                     ↓
            Cloudflare R2 (objects)
```

**Backups are non-optional and yours to own.** Nightly `pg_dump` encrypted and pushed to R2, with
weekly restore verification. Self-hosted Postgres means losing the VM without backups loses
everything — this is the most likely catastrophic failure on the free tier.

**CI/CD (GitHub Actions):**

```
PR:      install (cached) → lint → typecheck → unit → integration
         → tenancy fuzz → authz matrix → security scans → build → preview
main:    above + E2E → build & sign images → deploy → smoke test
nightly: dependency audit, ZAP DAST, full Playwright, backup restore verification
```

Turborepo remote caching keeps runs inside the 2,000-minute free allowance. Migrations run as a
pre-deploy step through a versioned runner.

---

## 13. Roadmap

Vertical slices — schema, API, UI, and tests together. Estimates are solo full-time.

| #    | Phase                                                                                                                       | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Est.    |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0A   | **Platform foundation**                                                                                                     | Monorepo + Turborepo, TS strict, ESLint security rules, Docker Compose, Terraform, Drizzle + Postgres running, migration runner with expand/migrate/contract, `observability`, `feature-flags`, `docs/` + first ADRs, `CLAUDE.md` + `ai/`, CI skeleton                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2 wks   |
| 0B   | **Security foundation** ✅                                                                                                  | `contracts` + branded types, **provider interfaces + contract tests**, `security` (UUIDv7, CSPRNG, Argon2id, AES-GCM envelope encryption), `policy`, `events` registry + outbox, tenant-scoped DB layer, RLS policies, fail-closed route builder, `testing` harnesses, full CI gate suite, threat model. _No product code._                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 3 wks   |
| 1    | **Identity** ✅                                                                                                             | Registration, Argon2id + HIBP, **passkeys**, refresh rotation with reuse detection, step-up auth, session revocation, email verification, password reset, mail worker, per-IP rate limiting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 4 wks   |
| 2    | **Tenancy, authz & audit** ✅                                                                                               | Orgs, memberships, teams, policy engine with **decision trace**, relationship tuples, hash-chained audit log, permission debug **endpoint** (page deferred to Phase 3 with `apps/web`). **Guardrails 8, 9, 11 green.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 4 wks   |
| 3    | **Work** ✅                                                                                                                 | Projects, boards, lists, cards, fractional ranking, TipTap validation, per-project card numbers, WIP limits, card detail (labels, checklists, custom fields, comments), **attachments** (presign → magic-byte → ClamAV, fail-closed), **filter AST + SQL compiler + evaluator**, and `apps/web` — kanban (dnd-kit) + table (TanStack Virtual), TipTap editor, **visual filter builder**, permission debug **page**. Deferred: passkey browser ceremony, calendar/timeline views                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 11 wks  |
| 3.5  | **Work UX** ✅                                                                                                              | Sidebar hierarchy, optimistic mutations, inline creation, status + priority as fields, group-by/sort-by, List view, saved views, bulk actions, My Tasks, command palette, keyboard shortcuts. Full spec: [ai/phase-3.5-work-ux.md](ai/phase-3.5-work-ux.md). **Approved 2026-07-30, complete 2026-08-05.** All three waves shipped. **Accepted cost: pushed Phase 4 and everything behind it back by its own length.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 5–8 wks |
| 4    | **Realtime spine** ✅                                                                                                       | Socket gateway, room authorization, Postgres adapter, presence, reconnect-and-diff, activity stream (Wave 3 activity stream explicitly deferred, see CLAUDE.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3 wks   |
| 5    | **Chat** ✅                                                                                                                 | Channels, DMs, threads, reactions, read cursors, mentions, files, retention policies, legal hold, export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 8 wks   |
| 6    | **Docs** ✅                                                                                                                 | Spaces, page tree, Hocuspocus + Yjs, inline comments, versions, templates, inherited permissions, publish, PDF export, backlinks. All four waves shipped (tree/auth foundation; live sync + the three recovery paths; comments/suggestions/backlinks; publish-to-public/PDF export/templates). Full spec: [ai/phase-6-docs.md](ai/phase-6-docs.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 8 wks   |
| 6.5  | **UI Polish & Design System** ✅ _all six waves shipped, three items still need a browser_                                  | Extracts `packages/ui` from the real duplication a per-pattern grep confirmed — Modal (6 files/7 instances), DropdownMenu (2/3), Popover (6/10) — not Select or Checkbox, which the draft assumed were duplicated and the real audit found were not. Fixes all six contrast failures found by computing WCAG ratios from `styles.css`'s actual OKLCH values, including `line`/`line-strong`'s border contrast, applied once explicitly approved. Makes the app shell, Chat, and Docs responsive down to phone width on the author's explicit call for full scope — an off-canvas drawer, two list/detail splits, a `packages/ui` `Modal` margin fix covering every dialog at once. Cross-surface pass verified loading/empty/error states already adequate, fixed two real avatar gaps in Docs, and quantified (not guessed) that Chat's optimistic-mutation coverage is zero of 25 mutations versus Work's 8 of 48 — named as its own future work rather than rushed, since fixing it needs a de-duplication story against the realtime socket layer. Accessibility pass verified every icon-only control already has a real label, found and fixed a genuine keyboard gap in the new mobile drawer (Escape, focus management), and wired the motion tokens into an actual transition. **Three items explicitly not done, named rather than hidden: the screen-reader pass (flagged in three separate waves), real-browser verification of the responsive work, and dnd-kit's keyboard sensors re-checked against the Modal extraction** — none of which this environment can perform. Full spec: [ai/phase-6.5-ui-polish.md](ai/phase-6.5-ui-polish.md), drafted and all six waves built 2026-08-08.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 5–7 wks |
| 7    | **Voice & Messaging** ✅                                                                                                    | Twilio subaccounts, numbers, click-to-call, IVR, recording + consent gate, transcription, SMS/WhatsApp inbox, **spend caps + fraud controls**, plus the `apps/web` UI (Wave 5). All waves shipped and, per `ai/phase-7-voice.md`'s own status header, subsequently proven against a REAL Twilio account — four defects a clean test suite had not caught (credential pairing, an unregistered TwiML route, missing record-intent persistence, relative webhook URLs) were found and fixed. **Its own spend-cap worker must treat `platform.orgSuspended` (Phase 12 Wave 1, §3.4) as a hard stop independent of the request-authentication path** — see §8.5's new row and `ai/phase-12-admin.md` §9. If Phase 7 is built before Phase 12 Wave 1 exists, it needs its own equivalent org-freeze primitive rather than shipping toll-fraud controls with no operator kill switch at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 7 wks   |
| 8    | **Search** ✅                                                                                                               | TQL tokenizer + parser onto the existing Phase 3 AST, cross-product indexing, saved filters, command palette. All three waves shipped: the parser (2026-08-10); the `search.documents` projection, indexer relay, `SearchProvider` and the per-hit `can()` route (2026-08-10); the `/search` page, transcripts joining the projection, saved searches and the board filter's builder ↔ TQL round trip (2026-08-10/11). Full spec: [ai/phase-8-search.md](ai/phase-8-search.md) — read its status header first: Wave 3 was marked SHIPPED while three things it scoped did not yet exist, and the header records that rather than quietly correcting it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 3 wks   |
| 9    | **Notifications** ✅                                                                                                        | Cross-channel routing (in-app/email/SMS/push), batching, granular preferences, digests, due reminders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 3 wks   |
| 10   | **Automation & integrations** ✅                                                                                            | Cross-product rules engine with loop protection, run history, outbound webhooks, public API + scoped tokens, Slack/GitHub integrations, importers, exporters. **All four waves shipped** — this row said "Wave 1 shipped... Waves 2-4 not started" long after webhooks (`webhook.router`), the public API (`apiToken.router` — mint/revoke, individually grantable since Phase 15 §1), Slack/GitHub connectors (`integration.router`), and the cost-bearing telephony actions (still behind their off-by-default env flag) had all landed. Also built `apps/worker`, which §6 had listed as "arriving" since Phase 0 — new background work runs there, the seven existing timers in `apps/api` migrate later one at a time. Spec: [ai/phase-10-automation.md](ai/phase-10-automation.md), nine decisions resolved at review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 6 wks   |
| 10.5 | **Sprints (Work)** ✅                                                                                                       | Sprint record and lifecycle (planned -> active -> completed), card membership and a backlog, what happens to unfinished cards when a sprint closes, the sprint board and picker. Not in the original numbering: added 2026-08-11 when Phase 11 review established that burndown without sprints is a chart no team recognizes, and that a work tracker without them is not competitive with Jira/ClickUp/Linear. Sequenced BEFORE Phase 11 deliberately — building the metric twice to save three weeks is not a saving. Shipped (migration 0054), with the Phase 10.6 sprint-flow slices (address/palette/close-destination/planning-view) built on top — see [ai/phase-10.5-sprints.md](ai/phase-10.5-sprints.md) and [ai/phase-10.6-sprint-flow.md](ai/phase-10.6-sprint-flow.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2-3 wks |
| 11   | **Analytics** ✅                                                                                                            | Velocity, burndown, CFD, cycle time, workload, chat/call volume, comms spend. NOT "read-only over data that already exists" — `work.cards` stores only the present, so four of the six are questions the transactional schema cannot answer; the phase's spine is a status-transition projection off the outbox. Burndown depends on Phase 10.5. Shipped — `apps/api/src/analytics`, `apps/web/src/features/analytics`. Spec: [ai/phase-11-analytics.md](ai/phase-11-analytics.md), whose own header said "DRAFT... awaiting approval" long after the code landed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 4 wks   |
| 11.5 | **People** ✅                                                                                                               | Org directory, profiles, canonical timezone, working hours, out-of-office, reporting lines. Canonicalizes the `displayName` field Phase 5 added ad hoc (§3.1's need, with nothing else to build it against) and the notification-timezone field Phase 9 added ad hoc (`ai/phase-9-notifications.md` §3.9) into one real profile record — both were satellite phases building the minimal People-shaped field they needed, on the understanding this phase would later own the canonical version. Teams and role/group management already shipped in Phase 2; session/device inventory, SCIM, and SAML stay in Phase 12 — this phase is profile data, not identity/session infrastructure. Shipped, Waves 1 and 2 — `apps/api/src/people`, `people.profiles` (migration 0030). Full spec: [ai/phase-11.5-people.md](ai/phase-11.5-people.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 3 wks   |
| 12   | **Admin, identity extras & compliance** (Waves 1-4 shipped)                                                                 | Admin console, retention policies, DSAR export, crypto-shred erasure, audit UI, **TOTP, OAuth (Google/GitHub) with account linking, device inventory, impossible-travel**, SCIM + SAML if a customer requires it, SOC 2 evidence, **billing & org lifecycle (trials, Stripe subscriptions, automated non-payment suspension)**. Device inventory reads `platform.push_subscriptions` (Phase 9) as one of its sources rather than inventing a second device concept — see that phase's §3.7. **Wave 1 (org governance & platform admin — self-serve creation guardrails, ownership transfer, the platform-operator console) shipped:** [ai/phase-12-admin.md](ai/phase-12-admin.md), whose own header said "DRAFT, not yet approved" long after shipping. **Wave 2 (identity extras, device security, account erasure) shipped:** [ai/phase-12-wave2.md](ai/phase-12-wave2.md). **Wave 3 (billing & org lifecycle) shipped:** [ai/phase-12-wave3.md](ai/phase-12-wave3.md) — `packages/payments`, `apps/api/src/billing`, migration 0059 — whose own header also said "DRAFT, not yet approved" long after shipping; the org-role/platform-operator split Wave 1 built stays untouched, this wave only added the subscription state that was missing. **Wave 4 (plan catalog & entitlements) shipped:** [ai/phase-12-wave4-plans.md](ai/phase-12-wave4-plans.md) — the four-tier plan/override resolution in `apps/api/src/billing/entitlement-resolver.ts` and its operator-facing editor in `plans-tab.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 6 wks   |
| 13   | **In-app voice (WebRTC)** ✅ _shares this number with the row below — see note_                                             | Real-time audio calling inside TaskFlow: the signalling spine, TURN credential minting, 1:1 DM audio, call records, ringing on any screen, ringtones, missed-call notifications, and recording behind a consent gate. Wave 3 (video, screen share, device selection) is the only part still open. Missing from this table entirely until this pass, despite being shipped and extensively documented in CLAUDE.md's own Phase 13 section — a real numbering collision with row 13 below (**Hardening & launch**, which the Cost Timeline §14 also cites as "Phase 13"), not something this pass tries to silently resolve by renumbering either one. Full spec: [ai/phase-13-webrtc.md](ai/phase-13-webrtc.md), approved 2026-08-10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 4 wks   |
| 13   | **Hardening & launch**                                                                                                      | Load testing, index tuning, DR drill, **third-party penetration test + paid external review of `auth` and `policy`**, runbooks, calendar/timeline views, launch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 6 wks   |
| 14   | **Mobile app (Android & iOS)** ✅ _Wave 1 spine, plus far more_                                                             | Expo / React Native app sharing `@taskflow/contracts` and the generated tRPC client with `apps/web` (guardrails 1 and 5 extended to a third platform). Redesigns token custody for a device with no `httpOnly` cookie — refresh token in Keychain/Keystore behind a structurally separate native auth path, the server-side rotation/reuse-detection machinery reused unchanged, plus channel binding so a token minted for one transport is refused on the other. Wave 1 (session/guardrails/native-auth spine, the Expo shell, the realtime socket client) shipped, and this row said "in progress... nobody has run this on a simulator or device yet" long after `apps/mobile` had grown into a full app covering auth, Work, Chat, Docs, Calls, People, and Billing — those later waves were built without their own scoping addendum to the spec below. Not in the original numbering: added 2026-08-20. Full spec: [ai/phase-14-mobile.md](ai/phase-14-mobile.md), whose own header undersold the same way until corrected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | TBD     |
| 15   | **Org-level permission grants & AI copilot** _§1–§4 (all waves), §6 and §8 (a real subset) shipped, §5 and §7 drafted only_ | §1 (foundation): a second, org-level (no-resource) permission-grant mechanism alongside the existing relationship tuples, closing a real gap (any Member could place calls/send SMS on any of the org's numbers with no per-person restriction). Shipped, then extended past its own spec: five more permissions (automation/webhook/integration/API-token management) made individually grantable, a full sweep across `apps/web` and `apps/mobile` fixing every permission-gated control that rendered unconditionally, a bulk multi-select grant/revoke UI, and mobile parity for Individual Permissions where none existed before. §2+§3 also shipped: `packages/ai` (a provider abstraction over an LLM — `AiProvider`, `FakeAiProvider`, `AnthropicProvider`), the `ai:use` permission and `aiAssistant` flag, a token/spend ledger (`ai.usage_ledger`, a new tenant-scoped schema rather than `platform.*`, per CLAUDE.md's rule against unscoped org filtering) and its budget gate (`completeGated`, resolved through Phase 12 Wave 4's existing entitlement chain rather than a new override table), and the platform-admin "AI Models" catalog/org-override/spend-report routes. §4 Wave 1 also shipped: the tool-calling assistant loop (bounded, sequential tool execution) with one read-only tool (`search`, reusing the exact authorized pipeline `search.query` itself calls), exposed as `ai.chat.send` — `completeGated`'s first real caller. Building this required fixing `AiMessage` itself: the flat `{ role, content }` shape §2 shipped cannot hold a multi-turn tool-calling exchange, so it is now a discriminated union carrying tool-call/tool-result content. §4 Wave 2 also shipped: single-card write tools (`card.create`/`card.update`/`card.assign`/`card.set_status`) and confirm-before-execute (§4.2) — every write tool requires confirmation, resolving a self-contradiction between §4.2's and §4.3's own text on whether create/update should auto-execute, rather than guessing which an unapproved draft meant. §4 Wave 3 also shipped: sprint planning tools (`sprint.create`, `sprint.add_cards`) — unlike Wave 2, the spec's own §4.2 text names sprint creation and moving many cards by name as needing confirmation, so no contradiction needed resolving this time. `sprint.add_cards` loops the real per-card `assignSprint` (there is no bulk version) and reports each card's own outcome rather than aborting the batch on the first failure. §4.3's last item also shipped: `chat.post_message`, reusing the already-whitelisted `mention` TipTap node so a tagged person is notified through the identical path a human's own mention would use — closing §4.3's entire wave order. `docs.create_page` (§4.1's table's own last unbuilt tool, title-only since Docs pages carry no body content outside `apps/collab`'s Yjs sync) has also shipped. §8 (onboarding/offboarding automation) also shipped a real subset: six of its ten checklist items, each backed by a real service call — `channel.add_member`/`channel.remove_member` (wrapping Phase 5's own channel-membership services), `docs.grant_space_access` (fixed at the `viewer` relation), `identity.revoke_sessions` (a widened `logoutEverywhere`), `member_grant.revoke_all` (a new loop over the existing per-permission revoke), and `cards.bulk_reassign` (a genuinely new mutation, its own `card.bulk_reassigned` audit event, per-card authorization, and a `sprint.add_cards`-style partial-failure result). Three of those six needed a `member:manage` check written inside the worker's executor itself, because the services they wrap rely on their tRPC route for authorization and a worker call never goes through a route. The other four checklist items (onboarding's starter-checklist cards, manager notification, and default permission bundle; offboarding's connector-access half) were deliberately left out, each needing a real design decision this pass did not make. §6 (the new-org Docs bootstrap) also shipped, and building it surfaced a real gap: nothing in `apps/web` had ever called `ai.chat.send` — every wave of §4 shipped as a tRPC route with no frontend. Both shipped together: an assistant chat page (message list, input, one Approve/Decline row per pending tool call — §4.2's confirm-before-execute, rendered) gated on a new `useAi` capability, and the bootstrap dialog itself, whose two questions (team size, handbook-only vs. handbook-plus-wiki) are an ordinary form rather than a model-parsed conversation — composing one exact instruction for the assistant to create the named Docs pages via `docs.create_page`, while the Docs SPACE itself is created by a plain mutation the dialog makes directly, since which pages to seed is the only thing the answers actually decide. §5 (a standup view) and §7 (GitHub PR review/merge tools) remain exactly as drafted: designed, no code. Not in the original numbering: added 2026-09-05. Full spec: [ai/phase-15-ai-copilot-and-permissions.md](ai/phase-15-ai-copilot-and-permissions.md). | TBD     |

**≈ 78 weeks (~18 months) solo full-time, plus 6.5's 5–7 weeks — ≈ 83–85 weeks, plus Phase
10.5's 2–3 weeks added 2026-08-11 — ≈ 85–88 weeks, plus Phase 14 (mobile) added 2026-08-20.**
This running total was never revised again after that: Phase 14 shipped far past its own
Wave-1-only estimate (see its row above), and Phases 13 (WebRTC) and 15 (permission grants, added
2026-09-05) were never folded in at all. Treat this figure as a historical snapshot through
2026-08-20, not a current estimate of remaining work.

### Sequencing constraints

- **Phases 0A–2 are the critical path** and do not parallelize. Thirteen weeks before a single
  user-visible feature ships. That is the price of the security posture, and compressing it is
  the one change that would genuinely compromise it. Phase 0A ends with a running, deployed,
  empty application — worth the split for momentum alone over an 18-month solo build.
- **Phases 0A–4 are a shared foundation every product depends on.** Nothing about Chat, Docs, or
  Voice begins until they are complete.
- **Phase 3 delivers a genuinely usable Jira/Trello-class product.** Phases 0A–4 together are the
  real milestone: identity, orgs, audit, Work, and realtime — deployed and complete.
- Phase 4 must precede 5, 6, and 7 — all three depend on the realtime spine.
- The **filter AST ships in Phase 3**, not Phase 8 (§10.2). Phase 8 adds only the text parser;
  Phase 10's automation conditions reuse the same evaluator.
- Phases 5, 6, and 7 are independent of each other and can be reordered by interest or urgency.
  Voice is placed last of the three deliberately — it is the only product carrying real financial
  risk, and it benefits from a mature audit and policy layer.
- Phases 8–11 each add a consumer to an event bus that already carries production traffic, which
  is why they are short.
- **Phase 10.5 (Sprints) must precede Phase 11's burndown**, and it is the one insertion in this
  roadmap that came from a product argument rather than a technical one: burndown is
  conventionally per-sprint, this system has no sprint, and a burndown over an arbitrary date
  range is a chart no team recognizes. Shipping the metric first and the concept second means
  building it twice.
- **Phase 11 must run its backfill before anything prunes `platform.outbox`.** Nothing has ever
  pruned it, which makes it an accidental event store and the only surviving record of every
  status transition — `work.cards` stores the present only. Phase 10 correctly wants to prune
  it and deliberately does not; Phase 11 does, after its backfill. Getting that order wrong
  destroys the history with nothing failing to say so. Recorded in both specs' own headers.
- **Phase 10 builds `apps/worker`**, which §6's layout has listed as "arriving" since Phase 0.
  New background work goes there; the seven `setInterval` loops already running inside
  `apps/api` migrate afterwards, one at a time, each with its own verification.
- **UI Polish (6.5) sits between Docs and Voice on purpose.** Voice adds three more UI-heavy
  surfaces (dialer, IVR builder, SMS/WhatsApp inbox) that would otherwise reinvent the same Radix
  wrappers Work, Chat, Docs, and Auth already reinvented independently four times over. Doing the
  extraction before Voice makes it the first consumer of a proven `packages/ui` instead of the
  sixth surface duplicating around it. It delays Phase 7 by its own length, the same trade-off
  Phase 3.5 made against Phase 4 — see [ai/phase-6.5-ui-polish.md](ai/phase-6.5-ui-polish.md) §11.
- **People (11.5) has no phase forcing it earlier, and that's a choice, not an oversight.** Phase
  5 needed a display name and Phase 9 needs a timezone; both built the minimal field themselves
  rather than wait, the same way Phase 3's `card_labels`/`custom_field_values` composite FKs
  predate any dedicated ownership of "vocabulary." People's job is to canonicalize what's already
  scattered, not to unblock anything — so it sits right before Phase 12, which is the first phase
  that actually needs a real profile surface to extend (device inventory, SCIM).
- **Every phase from 3 onward is independently deployable and feature-flagged.** If time runs out,
  what exists is complete and shippable rather than half-wired.

---

## 14. Cost Timeline

| Milestone                                        | Monthly cost   | What changed                                               |
| ------------------------------------------------ | -------------- | ---------------------------------------------------------- |
| Phases 0–6                                       | **$0**         | Oracle + Cloudflare + Resend + Sentry + Grafana free tiers |
| Phase 7 (live telephony demo)                    | **~$2**        | One phone number; Twilio trial credit covers usage         |
| First real users                                 | ~$0–5          | Still inside free tiers                                    |
| Postgres past ~50 GB, or wanting managed backups | +~$20          | Neon Scale or equivalent                                   |
| Second API instance                              | +~$10          | Redis returns via `QueueProvider`                          |
| Real customer data                               | +~$25          | Managed KMS + WAF — closes the §8.4 downgrade              |
| First enterprise customer                        | WorkOS pricing | SAML/SCIM                                                  |

Development through Phase 6 costs nothing but time.

**One deliberate exception — budget for it.** A paid external review of `apps/api/src/identity` and
`packages/policy` before real user data (Phase 13, §2.3). A few hundred dollars, one-off. On a
solo project it is the single highest-value spend in the plan, because it is the only control
that compensates for having no second reviewer on the code that matters most.

---

## 15. Risk Register

| Risk                                           | Severity                    | Mitigation                                                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI-generated authorization bug**             | Critical                    | Four independent layers (§8.2) + guardrails 8–11. Every security-critical surface on the human-review allowlist.                                                                                                                   |
| **Solo review is weaker than peer review**     | Critical                    | Explicitly acknowledged in §2.3. Adversarial second AI pass, property-based tests, and one paid external review of `auth` + `policy` before real user data. Guardrail 10 is the weakest guardrail here and is not relied on alone. |
| **`main` broken by long-running feature work** | High                        | `packages/feature-flags` — every post-Phase-4 feature ships disabled and deployable. Trunk-based development only; no long-lived branches.                                                                                         |
| **Toll fraud / SMS pumping**                   | Critical — real money, fast | Hard spend caps, geo allowlist, velocity limits, per-org subaccounts, anomaly alerts. Phase 7 day one, never retrofitted.                                                                                                          |
| **Losing the VM without backups**              | Critical                    | Nightly encrypted `pg_dump` to R2 from day one, weekly restore verification. Most likely catastrophic free-tier failure.                                                                                                           |
| **Software key management vs HSM**             | High                        | Contained behind `KeyProvider`; identical code path; first upgrade when real customer data arrives.                                                                                                                                |
| **Scope: 18 months solo**                      | High                        | Every phase independently deployable. Phases 0–2 are the irreducible core; each product module after is optional and self-contained.                                                                                               |
| **Free-tier terms change**                     | Medium                      | Provider interfaces (§5) make every one a config change. Contract tests prove equivalence.                                                                                                                                         |
| **Oracle idle reclamation**                    | Medium                      | Convert to Pay As You Go account; stays $0 inside Always Free limits.                                                                                                                                                              |
| **Yjs persistence loss**                       | Medium                      | Append-only update log + periodic snapshots + explicit versions — three recovery paths.                                                                                                                                            |
| **Chat table growth**                          | Medium                      | Monthly partitioning from day one, retention policies, cold-partition archival.                                                                                                                                                    |
| **Recording consent liability**                | Medium                      | Jurisdiction detection, enforced announcement, consent events in audit log, legal review before launch.                                                                                                                            |
| **Component sprawl = attack surface**          | Medium                      | Deliberately capped: Postgres, object storage, and nothing else at launch. Redis, Meilisearch, ClickHouse, OpenFGA are documented upgrade paths, not day-one dependencies.                                                         |
| **Penetration test finds something late**      | Medium                      | Phase 13 reserves six weeks. Threat model written in Phase 0 and updated each phase, so findings should be confirmatory.                                                                                                           |

---

## 16. Decision Log & Open Questions

### Decided

| Decision           | Chosen                                | Over                        | Because                                                                                                                      |
| ------------------ | ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Database           | PostgreSQL 17                         | MongoDB                     | RLS — no document-store equivalent, and it is the layer that makes AI-assisted multi-tenancy defensible                      |
| ORM                | Drizzle                               | Prisma, Mongoose            | SQL-first, composes cleanly with RLS session variables                                                                       |
| API                | tRPC internal + OpenAPI public        | REST only                   | Compile-time contract safety (guardrail 5) without giving up a public API                                                    |
| Framework          | Fastify                               | Express, NestJS             | Speed + schema-first validation; the fail-closed route builder replaces Nest's guards with compile-time enforcement          |
| Routing            | TanStack Router                       | React Router                | Typed routes and search params carry branded types end to end                                                                |
| Queues             | pg-boss                               | BullMQ + Redis              | Transactional enqueue; one fewer service; free                                                                               |
| Auth core          | Own it                                | Auth0, Better Auth          | Most security-critical path must be fully auditable and unlocked                                                             |
| Enterprise SSO     | WorkOS, deferred                      | Hand-rolled SAML            | SAML is easy to implement insecurely; no enterprise customer yet                                                             |
| Compute            | Oracle Always Free                    | Render, Fly, Railway        | Only free tier with always-on persistent WebSockets and real RAM                                                             |
| Repository layer   | None                                  | Repository pattern          | Drizzle is already the data-access abstraction; a tier over it buys nothing until a second datastore exists                  |
| Domain events      | Typed registry + transactional outbox | Ad-hoc calls per consumer   | Five consumers of the same events; guardrail 11 makes emission non-optional                                                  |
| Second auth factor | Passkeys in Phase 1                   | Defer all MFA               | ~200 lines with `@simplewebauthn`; retrofitting a factor onto live accounts is far more expensive than building it in        |
| OAuth              | Deferred to Phase 12                  | Phase 1 alongside passwords | Account linking is a subtle security decision with real CVE history, and a solo developer does not need social login to test |
| Filter AST         | Phase 3, parser in Phase 8            | ILIKE now, TQL later        | Otherwise filtering is built twice and one implementation is discarded                                                       |
| `packages/ui`      | Extracted from Phase 3 usage          | Built upfront               | Speculative design systems are a reliable time sink; Radix + Tailwind covers the primitives                                  |
| Automation engine  | Event-bus consumer                    | Standalone subsystem        | Once `events` and the AST evaluator exist, it is orchestration, not a platform                                               |

### Reversed during planning

| Reversal                                                                | Trigger                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Permission debug **page** → **endpoint** in Phase 2                     | `apps/web` did not exist until Phase 3; the decision trace shipped with the endpoint, its UI with the app that renders it. Both are now in place, and the page computes nothing — it renders the trace the server produced, so the two cannot disagree |
| Email invitations deferred out of Phase 2                               | Inviting an address with no account needs a token, an acceptance flow, and the same account-linking decision §8.1 defers OAuth for. `members.add` covers existing users                                                                                |
| Phase 0 split into 0A / 0B                                              | Momentum on an 18-month solo build; 0A ends with a deployed running app                                                                                                                                                                                |
| `observability`, `events`, `feature-flags`, `testing` added as packages | External review — all four were implied by the plan but not owned by any module                                                                                                                                                                        |
| Guardrail 11 added                                                      | The event registry made "did this mutation emit?" mechanically checkable                                                                                                                                                                               |
| §2.3 added                                                              | Guardrail 10 assumed a second human reviewer that does not exist on this project                                                                                                                                                                       |

### Open

1. **Compliance target beyond SOC 2 + GDPR.** HIPAA would add BAA constraints on Twilio and force
   changes to recording, transcript, and retention handling. Resolve before Phase 7.
2. **Region and data residency.** Determines the Oracle region and whether per-region deployment
   is needed later. **Not blocking** — only relevant at first deploy. Pick the nearest region then;
   provider interfaces make relocating a redeploy rather than a migration.

### Closed

| Question                     | Resolution  | Consequence                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public vs private repository | **Private** | CI budget is 2,000 Linux minutes/month — Turborepo caching keeps runs inside it. **CodeQL unavailable**; Semgrep OSS is the SAST gate (§8.8), with custom rules enforcing the architecture-specific invariants (e.g. flag any Drizzle query not obtained from `db.forOrg()`), which matter more here than generic taint rules. Repo can be opened later; history would need a secret audit first. |

---

_This document is the canonical plan. It is expected to change — update it in place as decisions
resolve, and record reversals in §16 rather than silently editing history._
