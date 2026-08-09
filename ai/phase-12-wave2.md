# Phase 12, Wave 2 — Identity extras, device security, and account erasure

**Status: approved for build.** Scope and the architecturally-significant decisions were resolved
directly with the project owner on 2026-08-09 (recorded in §7) rather than left as an open-questions
section for a first draft, since this document is written immediately before implementation starts,
not ahead of it the way Wave 1's was.

Parent: [PLAN.md](../PLAN.md) §13 (Roadmap, row 12). Sibling: [phase-12-admin.md](phase-12-admin.md)
(Wave 1 — org governance & platform admin, shipped).

This is **the second wave of Phase 12**, covering everything Wave 1's own §2 named and deferred:
user suspension, device inventory, impossible-travel detection, TOTP, OAuth account linking, org
deletion, and a self-serve data-export path. **Not** in this wave, decided explicitly rather than
silently dropped: SCIM, SAML, cross-product retention-policy scheduling, org-wide/compliance-facing
DSAR export, and SOC 2 evidence collection as a distinct feature (§2, §7).

---

## 1. What this wave found, and how it changes the roadmap line

PLAN.md's Phase 12 row bundles "retention policies, DSAR export, crypto-shred erasure... TOTP,
OAuth... device inventory, impossible-travel... SCIM + SAML... SOC 2 evidence" into one line. Two
things discovered while scoping this wave change what "crypto-shred erasure" can honestly mean
right now:

1. **`packages/contracts`' `KeyProvider` and `packages/security`'s envelope-encryption primitives
   have never been wired to any real data.** A repo-wide check for `generateDataKey`/
   `encryptString`/`KeyProvider` outside `packages/security` itself returns nothing. No product
   field — Work card descriptions, Chat messages, Docs content, People PII — is encrypted at rest,
   and no per-org data key is generated or stored anywhere. This is real, tested infrastructure from
   Phase 0B that seven phases of product work never consumed, not a placeholder that was assumed
   to exist and turned out broken (the Wave 1 pattern) — it is fully correct and simply unused.
2. **`KeyProvider`'s design is per-organization** (`fieldAad` takes `orgId`; the whole point is "one
   org's key, one org's blast radius"). This wave's own new sensitive fields — a TOTP secret, an
   OAuth refresh token — belong to `identity.users`, which has no org at all by design (login
   resolves an account before any org is known, the same reason `identity.orgs` needs its own
   cross-tenant role in Wave 1 §3.7). A per-org key does not fit a pre-tenant table.

**Decided (§7, confirmed 2026-08-09): org deletion in this wave is genuine, irrecoverable cascading
deletion** across every schema — a real `DELETE`, not a key-based shortcut, which is a legitimate
way to satisfy GDPR erasure on its own. **This wave's own new secrets get real encryption for the
first time**, under one new identity-scoped data key (not per-org — see §3.2), making
`KeyProvider` a genuinely consumed piece of infrastructure rather than one this document repeats
the "not yet wired up" finding about. Retrofitting encryption onto six phases of already-shipped,
unencrypted product data is explicitly **not** this wave's job — naming it here as a real,
deliberate deferral rather than a discovery some later reader has to make from scratch.

## 2. In scope, and what stays out

**In scope:**

- `identity.users.status` given a write path (freeze/reactivate a single account), mirroring Wave
  1's org-suspension shape.
- TOTP as a second factor: enrollment, confirmation, recovery codes, and login/step-up integration.
- OAuth sign-in (Google, GitHub) with auto-link-on-verified-email.
- A device/session inventory view, built from data that already exists (`identity.sessions`,
  `identity.refresh_tokens`, `platform.push_subscriptions`) rather than a new device concept — the
  exact instruction PLAN.md §13's own roadmap note already gives.
- Impossible-travel detection over that same session data.
- Org deletion: real cascading delete, operator-triggered, irreversible, heavily audited.
- Self-serve DSAR export: a signed-in user's own account-level data (profile, memberships, sessions,
  linked OAuth identities) as a structured export, on demand.

**Deliberately out of scope, decided 2026-08-09 (§7):**

- **SCIM + SAML.** `packages/contracts`' own `IdentityProvider` provider-interface table (PLAN.md
  §5) names its trigger explicitly: "first enterprise customer." That has not happened. Building a
  real protocol integration against a trigger that hasn't fired inverts the entire point of the
  provider-interface pattern — swap the implementation when the trigger fires, don't build the
  paid-tier thing speculatively. `IdentityProvider`'s seam already exists; nothing new is added
  here, and nothing needs to be — there is no code to write until a real SAML/SCIM consumer shows
  up to test against.
- **Retrofitting per-org field encryption onto existing product data** (§1). A real, large,
  cross-product undertaking (Work, Chat, Docs, People all gain encrypted columns, a migration
  strategy for existing plaintext rows, and a key-rotation story) that deserves to be sized and
  reviewed on its own, not folded into "the rest of Phase 12" as a side effect.
- **Cross-product retention-policy scheduling.** Chat already has its own retention/legal-hold
  system (Phase 5, `chat/compliance.service.ts`) scoped to chat messages specifically. A general,
  configurable-per-org retention scheduler spanning Work/Chat/Docs is real, valuable, separate work
  — this wave does not generalize Chat's existing mechanism or add a new one.
- **Org-wide / compliance-facing DSAR export.** This wave's export is self-serve and account-scoped
  — what you can see about yourself, on demand, with no operator involved. An operator-triggered
  export answering a real legal request for one person's data ACROSS every org they belong to,
  reaching into Work/Chat/Docs product data under each org's own RLS, is a materially bigger
  capability (the same "cross-org data access stays structurally out of reach without a
  purpose-built, audited path" argument Wave 1 §2 already makes for the platform-admin console) —
  named here as real follow-up work, not built.
- **SOC 2 evidence collection as its own feature.** Nothing in this wave adds an "evidence export"
  surface. What SOC 2 evidence actually needs — access reviews, control descriptions, audit-log
  completeness — is largely already produced by existing mechanisms (the hash-chained audit log,
  Wave 1's operator accountability log, the role/permission matrix tests) rather than a new thing to
  build; packaging that into an auditor-facing report is a process/documentation exercise for
  whoever runs the actual audit, not application code. If a real SOC 2 engagement surfaces a
  concrete gap, that becomes its own scoped piece of work then.
- **Billing.** Never part of this roadmap line to begin with — Wave 1 §2 already named it as its own
  future phase; repeating that here rather than letting it look like an oversight.

## 3. Structural decisions

### 3.1 User suspension — the direct extension of Wave 1's org suspension

`identity.users.status` already has a `CHECK` constraint (`'active' | 'suspended' | 'invited'` —
verified against migration 0002) and login/passkey auth already refuse anything but `'active'`
(`identity.service.ts:206`, `passkey.service.ts:218`, per Wave 1's own §1.2 finding about the
equivalent org column). The gap is identical in shape to Wave 1's very first finding: a column
that's real and already enforced on read, with no write path.

- `platformAdmin.users.suspend` / `.reactivate` — new `platformRoute`s, same conditional-`WHERE`
  pattern as `orgs.service.ts`'s `suspendOrg`/`reactivateOrg` (`fromStatus` in the `UPDATE ...
  WHERE`, turning a redundant call into an honest `CONFLICT` rather than a silent no-op).
- Suspending a user does **not** touch their `identity.sessions` rows — the next request they make
  fails at whatever route-level check reads `users.status` (already exists), and existing sessions
  age out or get revoked the same way any other session does. Force-revoking every session on
  suspend is real, natural follow-up hardening (closes the same "already-connected socket" lag
  Wave 1 §3.9 named for orgs) but is not free with the read-side enforcement the way it looks —
  `logoutEverywhere`'s existing revoke-all is the right primitive to call, and doing so as part of
  `suspendUser` is a one-line addition once that route exists. **Decided: call it.** Suspending
  someone should mean their existing sessions stop working immediately, not eventually.
- Event: `platform.userSuspended` / `platform.userReactivated`, `{ userId, operatorUserId }` — same
  shape and same dual-audit routing as Wave 1's org events (§4), except there is no natural
  "target org's own audit log" to also write into (a suspended user may belong to several orgs, or
  none) — so these write **only** into `platform.operator_audit_log`, not a second, org-scoped
  location. This is a real, deliberate asymmetry with the org-suspend events, not an oversight: Wave
  1's dual-write existed specifically so an Owner sees "an operator suspended MY org" in their own
  audit history with no operator access required, and there is no equivalent single audience for a
  cross-org user-suspend event to notify that way.
- Web: `platformAdmin.users.list`'s existing read-only rows (Wave 1 §3.6) gain a suspend/reactivate
  action, the exact shape the Orgs tab already has.

### 3.2 An identity-scoped data key, and TOTP as its first real consumer

Per §1's finding: one new singleton data key, generated once via the existing `KeyProvider`
(`generateDataKey({ purpose: 'identity-secrets' })`), its wrapped form stored in a new one-row
table:

```sql
CREATE TABLE identity.secret_keys (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),  -- singleton, mirrors
                                                                   -- platform.operator_chain_head
  wrapped_key      bytea NOT NULL,
  master_key_id    text  NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

Unwrapped once at process start (`main.ts`, alongside where `KeyProvider` is already constructed),
held in memory for the process lifetime — the identical shape `SoftwareKeyProvider` itself already
uses for master keys, one level up. A new `identityFieldAad({ table, column, rowId })` in
`packages/security` (parallel to `encryption.ts`'s existing `fieldAad`, deliberately not a
generalization of it — the two will diverge the moment KMS per-org keys exist for real, and a
premature shared abstraction would need un-sharing then) binds each ciphertext to its row without
an `orgId`, since none exists at this table.

**TOTP** (`otplib`, per PLAN.md §4.2's own tech-stack choice — not yet a dependency; added here):

```sql
CREATE TABLE identity.totp_credentials (
  user_id        uuid PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  secret_encrypted bytea NOT NULL,      -- encrypted under the identity-scoped key
  confirmed_at   timestamptz,           -- null = enrolled but not yet confirmed with a real code
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.totp_recovery_codes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  code_hash   text NOT NULL,   -- Argon2id, same primitive as passwordHash — one-time use
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Enrollment is two calls, not one — `auth.totp.startEnrollment` generates a secret, encrypts and
stores it unconfirmed, returns the provisioning URI for a QR code; `auth.totp.confirmEnrollment`
takes the first real code from the authenticator app and only THEN marks `confirmed_at`, generating
and returning ten recovery codes **once** (never re-displayable, matching how the original
credential secret itself is only ever shown once). An unconfirmed row is not usable for login or
step-up — this is what stops an enrollment interrupted mid-flow (network drop, browser closed)
from silently locking someone out of an account they never actually finished securing. Both routes
are `selfRoute` with `stepUp: true` — enabling a new factor is exactly the kind of credential-
adjacent change §8.1's step-up list already covers, and `auth.totp.disable` (also `selfRoute`,
`stepUp: true`) removes the credential and its recovery codes together.

**Login and step-up integration — the one real design choice here.** Once
`identity.totp_credentials` has a confirmed row for a user, `login()` (`identity.service.ts`)
changes shape: after the password check succeeds, it does **not** yet issue a session. It returns a
short-lived, signed challenge (`{ challenge: 'totp_required', token }`, a JWT with a 5-minute
expiry and no other claims worth anything, the minimum needed to prove the password step already
happened) instead. A new `auth.totp.verifyLogin` (`publicRoute` — the caller has no session yet)
takes that token plus either a 6-digit TOTP code or a recovery code, verifies it, marks a used
recovery code `used_at` if that path was taken, and issues the real session — the exact same
`issueSession` call `login()` itself already makes on success. **Step-up gets this for free**:
`StepUpDialog` already re-calls `auth.login` to prove a fresh credential (`step-up.tsx`'s own
header explains why a refresh cannot substitute); for an account with TOTP enabled, that call now
returns the `totp_required` challenge instead of a session, and the dialog prompts for a code inline
before calling `auth.totp.verifyLogin` to complete it. One mechanism, both call sites, no second
step-up code path to keep in sync with the first.

### 3.3 OAuth (Google, GitHub) with auto-link on verified email

New table:

```sql
CREATE TABLE identity.oauth_identities (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  provider          text NOT NULL,   -- 'google' | 'github', a CHECK not an enum, matching
                                      -- notification_prefs' own category/channel convention
  provider_user_id  text NOT NULL,   -- the provider's own stable subject id, never the email
  email             text NOT NULL,   -- captured at link time, for display only — never re-derives
                                      -- identity.users.email, which stays the account's own
  linked_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_user_id),   -- one provider identity links to exactly one account
  UNIQUE (user_id, provider)             -- one account links at most once per provider
);
```

Hand-rolled authorization-code flow, not a new dependency — the same "own it, it's the most
security-critical path" call PLAN.md §4.2 already makes for password/passkey auth, and the flow
itself is short enough that a library buys little over `jose` (already a dependency, verifies
Google's ID token against Google's published JWKS) plus a plain `fetch` for GitHub's REST API
(GitHub does not issue OIDC ID tokens; its access token is exchanged against `GET /user` and
`GET /user/emails`, filtering for `primary && verified`).

- `auth.oauth.start` (`publicRoute`) — takes `{ provider }`, returns the provider's authorization
  URL with a fresh CSRF `state` and PKCE `code_verifier`/`code_challenge` pair, the state signed
  (short-lived JWT, same shape as the TOTP login challenge) rather than stored server-side — no new
  table needed for something that only has to survive one redirect round trip.
- `auth.oauth.callback` (`publicRoute`) — takes `{ provider, code, state }`, verifies `state`,
  exchanges `code` for the provider's tokens, resolves a verified email:
  - **A confirmed `oauth_identities` row already exists** for `(provider, provider_user_id)` → sign
    that account in directly (`issueSession`, same as ordinary login).
  - **No existing link, but `identity.users.emailNormalized` matches the OAuth-verified email** →
    **auto-link** (per §7's decision): insert the `oauth_identities` row against the existing
    account and sign in. The OAuth provider has already done its own email verification (that's
    what "verified" in the API response means for both Google and GitHub), so this does not weaken
    the guarantee `identity.users.emailVerifiedAt` already represents — it is a second, independent
    party vouching for the same fact.
  - **No existing account at all** → create one (`emailVerifiedAt` set immediately, from the
    OAuth-verified email; no `passwordHash`, mirroring how a passkey-only account already has none)
    and link it. This is the one path that touches `org.service.ts::createOrg`'s Wave 1
    email-verification gate — a brand-new OAuth-created account can create an org immediately,
    which is correct: the gate exists to stop an unverified address from farming orgs, and this
    address was never unverified.
- Account settings (`apps/web/src/features/auth/account-page.tsx`) gains a "Connected accounts"
  section: list linked providers, link a new one (while already signed in — reuses
  `auth.oauth.start`/`.callback` with the existing session attached instead of issuing a new one),
  unlink one (`stepUp: true` — removing a sign-in method is exactly the shape of change the step-up
  list already covers). **A user may not unlink their last sign-in method** if they have no password
  and no passkey either — the same "not locking someone out of their own account" reasoning
  `passkeys.remove`'s existing password-fallback check already applies, generalized to "at least one
  of password, a passkey, or an OAuth link must remain."
- New env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, all `NonEmpty.optional()` — matching every other integration in this
  codebase (VAPID, storage), OAuth sign-in is a valid deployment to not have configured, and an
  unconfigured provider's button simply doesn't render rather than the app failing to boot.

### 3.4 Device inventory and impossible-travel

**No new device table** — PLAN.md's own roadmap note already settles this: "Device inventory reads
`platform.push_subscriptions` (Phase 9) as one of its sources rather than inventing a second device
concept." The inventory is a read-shaped view joining what already exists:

- `identity.sessions` (one row per sign-in — `userAgent`, `ip`, `authenticatedAt`, `lastSeenAt`,
  `revokedAt`) is the primary source — "a device" in this UI is really "an active session," which
  is the honest unit this system already tracks (the alternative, fingerprinting a physical device
  across sessions, is real product work with no data behind it yet).
- `platform.push_subscriptions` joins in for any session-adjacent row that registered for push, to
  show "this device can receive push" alongside the session's own facts.
- `auth.sessions.list` (new `selfRoute`) returns the caller's own active sessions with a
  human-readable label derived from `userAgent` (a small, deterministic parser — "Chrome on macOS",
  not a dependency for something this narrow) plus `ip`, `lastSeenAt`, and whether push is
  registered. `auth.sessions.revoke` (`selfRoute`, `stepUp: true`) revokes one session by id —
  `logoutEverywhere` already revokes all of them; this is the single-device version the account page
  does not have today.
- Web: `account-page.tsx` gains a "Sessions" section listing this, each row with a "Sign out" action
  — the device-inventory UI IS the sessions list, not a second page.

**Impossible-travel** is computed at login time, over the same `identity.sessions` rows — comparing
the new session's IP-derived location against the account's most recent **active** session's
location, flagging (not blocking) a sign-in whose implied travel speed exceeds a generous threshold.
**Decided: geolocation is IP-country-level only, via a free/offline database (MaxMind GeoLite2,
already free-tier per PLAN.md §4's cost model — no new paid dependency), not a live API call per
login** — the accuracy this buys (country, not city-level precision) is exactly what "impossible"
travel needs (a login from two countries nobody can physically travel between within the elapsed
time), and it keeps login's latency independent of a third-party service's availability, matching
the same "no network call inside the transaction that must complete for someone to sign in"
discipline `login()` already applies elsewhere. A flagged sign-in does **not** block — it records an
event (`identity.impossibleTravelDetected`, own audit visibility, no product-facing block) and
surfaces on the Sessions page ("this sign-in looked unusual — TODO copy") rather than refusing
outright, because a false positive (a real VPN, a real fast flight, a shared/NAT'd IP a whole office
sits behind) blocking a legitimate sign-in is a worse failure mode than an alert that sometimes
fires on nothing.

### 3.5 Org deletion — real, cascading, operator-triggered

Per §1: no key to shred, so this is what it looks like without one. `platformAdmin.orgs.delete` —
new `platformRoute`, unconditional step-up (already implied by every `platformRoute`), takes
`{ orgId, confirmSlug: string }` where `confirmSlug` must match the org's actual slug — the same
"type the name to confirm" pattern this codebase does not have precedent for yet but every
comparable irreversible-deletion UI in the industry uses, because a single confirm-button click is
too cheap an action to gate the one operation in this entire system with no undo.

- Requires the org to already be `'suspended'` — **decided:** deletion is a two-step operation
  (suspend, confirm, then delete), never a single action from `'active'`. This gives a real,
  visible waiting period (however short an operator chooses to make it in practice) between "this
  org looks like it should go" and "this org is gone forever," and reuses a control this wave
  already has rather than adding a new one (a `pendingDeletionAt` grace-period timestamp, cool-down
  scheduling) for a capability used, realistically, close to never.
- The delete itself: one large transaction, `withPlatformAdminScope` for the `identity.orgs` row
  (Wave 1's role already has `UPDATE`; this needs `DELETE` added to its grant) cascading through
  every table with a real `org_id` foreign key — which is most of the schema by this point (Work,
  Chat, Docs, People, notifications, the org's own audit chain, its outbox rows). Rather than
  hand-listing every table (a list that silently rots the day a new one is added — the exact
  "gap nobody notices until an incident" shape this codebase's own history keeps finding), the
  migration adds `ON DELETE CASCADE` to every existing `org_id` foreign key that isn't already one
  (a repo-wide audit of `packages/db/migrations/*.up.sql` for `REFERENCES identity.orgs` is part of
  this migration, not assumed) — deleting the `identity.orgs` row is then a single statement Postgres
  itself fans out correctly, forever, with no maintained list to fall out of sync with the schema.
- `identity.orgs` itself is the one row this DOESN'T cascade-delete on write — it's the root of the
  cascade, deleted last (implicitly, by being the actual delete target). The org's `audit.audit_log`
  and `platform.outbox` rows go with it; **before** the delete, this route writes one final entry
  into `platform.operator_audit_log` (never into the org's own chain — it wouldn't survive the
  delete) naming the org id, slug, member count, and confirmation slug typed, since this is the one
  operator action in the entire system where the org-scoped half of Wave 1's dual-audit-write
  (§4) is structurally impossible: there is no "org's own audit log" left to write into once this
  transaction commits.
- Event: `platform.orgDeleted`, `{ orgId, slug, operatorUserId, memberCount }` — published via
  `EventBus.publish()` with the `SYSTEM_ORG` envelope (Wave 1's `flags.service.ts` already
  established this exact pattern for an event whose subject has no `org_id` context to write an
  outbox row against), **not** the org's own outbox, for the identical reason the operator-log entry
  above goes global.

### 3.6 Self-serve DSAR export

`people.profile.exportMine` — new `selfRoute`, no input, returns a structured JSON document: the
caller's own `identity.users` row (minus `passwordHash`), every `identity.memberships` row with its
org's name/slug, every active `identity.sessions` row's metadata (not raw tokens — those never
existed as anything but a hash, per Wave 1's own §"credential hygiene" tests), linked
`oauth_identities` (provider + email, never provider tokens), and their `people.profiles` row if one
exists (Phase 11.5). Modeled directly on `chat/compliance.service.ts`'s `exportChannel` — the same
shape (a route returning the export inline as JSON, not a background job producing a downloadable
file, since account-level data at this scale is small enough to hand back synchronously) and the
same audit discipline (an event recording that an export happened, never the export's own contents,
matching `compliance.exported`'s existing header on why: "an outbox row is replayed into a log that
keeps whatever is put in it").

**Explicitly excluded from this export** (§2's scope line): product data across Work/Chat/Docs the
caller authored — a card they created, a message they sent. Reaching that honestly needs per-org
RLS-scoped reads across every org membership, which is real, larger work this wave's "self-serve,
account-level" framing does not cover — named as a gap for a real DSAR request today, not hidden
behind an export that looks complete and isn't.

## 4. Event catalog

Six new events, guardrail 11 applies with no exception:

- **`platform.userSuspended`** / **`platform.userReactivated`** — `{ userId, operatorUserId }`,
  `platform.operator_audit_log` only (§3.1).
- **`platform.orgDeleted`** — `{ orgId, slug, operatorUserId, memberCount }`, `SYSTEM_ORG` envelope
  via `EventBus.publish()` (§3.5).
- **`identity.totpEnrolled`** / **`identity.totpDisabled`** — `{ userId }`, ordinary
  identity-module events (existing pattern — `identity.service.ts` already emits comparable
  credential-lifecycle events for passkeys).
- **`identity.oauthLinked`** — `{ userId, provider }`. No `.unlinked` counterpart needed beyond
  what account-settings' own audit trail already covers via `identity.service.ts`'s existing
  event shape — named here because "a new sign-in method was added to this account" is exactly
  the class of fact CLAUDE.md's Phase 1 notes already say the audit log exists to answer.
- **`identity.impossibleTravelDetected`** — `{ userId, sessionId, previousCountry, newCountry }`
  (§3.4) — informational, never blocks.

## 5. Web UI surface

- **`account-page.tsx`** gains three new sections: **Two-factor** (TOTP enroll/confirm/disable with
  recovery codes shown once), **Connected accounts** (OAuth link/unlink), **Sessions** (device
  inventory, §3.4, replacing nothing — `logoutEverywhere` stays where it is).
- **`login-page.tsx`** gains the TOTP challenge step (code entry, appearing only when `login()`
  returns `totp_required`) and "Sign in with Google" / "Sign in with GitHub" buttons, rendered only
  for a provider whose env vars are actually configured (§3.3).
- **`step-up.tsx`** (`StepUpDialog`) gains the same TOTP-challenge branch as the login page — one
  extracted component, not two copies, since the shape is now identical at both call sites.
- **`platform-admin-page.tsx`**'s existing Users tab (Wave 1) gains suspend/reactivate; existing Orgs
  tab gains a Delete action, gated behind the org already being suspended (§3.5) and the
  type-the-slug confirmation.

## 6. Cross-cutting obligations

**Everything in §3.2 and §3.3 joins CLAUDE.md's `⚠ human-review` list** alongside
`apps/api/src/identity` (they mostly live there) — TOTP and OAuth are both new ways into an account,
the same severity class CLAUDE.md's existing identity-module entry already names.
`apps/api/src/platform-admin/*` (org deletion, user suspension) stays on the list Wave 1 already
added it to; nothing new needed there structurally, just more surface under the same entry.

**Tests ship with the slice**, matching Wave 1's own bar:

- A test proving an unconfirmed TOTP enrollment cannot be used for login or step-up.
- A test proving a recovery code is single-use (a second attempt with the same code fails).
- A test proving the OAuth callback auto-links to an existing account by verified email, and refuses
  to link if the provider's email is unverified.
- A test proving a user cannot unlink their last sign-in method (no password, no passkey, one OAuth
  link — unlink refused).
- A test proving org deletion refuses a non-suspended org, and a wrong `confirmSlug`.
- A test proving org deletion actually removes rows from at least one table in each of Work, Chat,
  Docs, and People (not just `identity.orgs` itself) — the one test that would catch a foreign key
  that didn't get `ON DELETE CASCADE` added in the migration.
- A test proving `identity.secret_keys` is unreadable/unwritable from `taskflow_app` the same way
  `platform.operators` is in Wave 1 — the identical "no code-level fallback if this grant is ever
  widened" reasoning.
- A test proving suspending a user revokes their existing sessions (§3.1).

## 7. Decisions

Resolved directly with the project owner, 2026-08-09, before this document was written rather than
left open in a draft — recorded here for the same reason Wave 1 §7 records its own: so a later
reader does not have to reconstruct why the shape is what it is.

1. **SCIM + SAML.** Deferred, explicitly — no enterprise-customer trigger has fired (PLAN.md §5's
   `IdentityProvider` row). Not touched by this wave.
2. **TOTP's relationship to passkeys.** Second factor, layered on top of password login and also
   usable to satisfy step-up — not a competing primary factor, not a passkey replacement (§3.2).
3. **The retention / DSAR / crypto-shred / org-deletion cluster.** Contained: org deletion (real
   cascading delete, §3.5) plus self-serve, account-scoped DSAR export (§3.6). Cross-product
   retention-policy scheduling and org-wide/compliance-facing DSAR both deferred, explicitly (§2).
4. **OAuth account linking.** Auto-link on a provider-verified email match, no separate "confirm you
   want to link" step (§3.3) — the provider has already done real verification; requiring a second,
   redundant confirmation buys friction, not safety.
5. **The KeyProvider gap** (§1). Org deletion does not attempt to use `KeyProvider` at all — it does
   real deletion instead. This wave's own new secrets (TOTP, OAuth tokens) become the first real
   consumer of `KeyProvider`, under one new identity-scoped (not per-org) data key. Retrofitting
   encryption onto existing product data is explicitly out of scope.

## 8. Sequencing and cost

Depends on Wave 1 (complete) for the `platform-admin` module and `platformRoute` (user suspension,
org deletion both use it) and Phase 1 (complete) for the login/session/step-up machinery every other
piece here extends. Independent of Phases 8–11, same reasoning Wave 1 §8 already gives for its own
position.

New surface: two new identity tables plus the identity-scoped key singleton (§3.2), one new OAuth
identities table (§3.3), no new device table (§3.4 — reads existing data), one migration doing a
repo-wide cascade-FK audit rather than a small schema addition (§3.5, genuinely the riskiest single
piece here to get right), six new events, three new/extended account-page UI sections, two new
login-flow branches (TOTP challenge, OAuth buttons) that touch `login-page.tsx` and `step-up.tsx`
both. Six distinct feature areas (user suspension, TOTP, OAuth, device inventory, org deletion,
DSAR export) each carrying its own real design surface — **estimate: 3–4 weeks**, roughly matching
what remains of Phase 12's original 6-week line once Wave 1's already-spent 3–4 weeks are subtracted,
with SCIM/SAML, retention scheduling, org-wide DSAR, and SOC 2 evidence collection all still
unscheduled, named explicitly rather than implied "done" by this wave's own completion.
