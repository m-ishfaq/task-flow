# Phase 11.5 — People

**Status: Waves 1 and 2 are COMPLETE — approved and built 2026-08-08 on top of Phase 9 (merged
into `main` first, per the author's own instruction). Wave 3 (dropping `identity.users.display_name`
after a release cycle) remains deliberately not built — it is a contract step that cannot run at
build time. Migrations 0030/0031, `apps/api/src/people` (profile, directory, membership, reporting),
the `/people` + `/people/$userId` pages, the `/account` working-hours/timezone/OOO section, and the
`profile.updated`/`membershipProfile.updated`/`reportingLine.changed` events all shipped. The demo
seeder shipped too — `packages/seed/src/modules/people.profiles.ts` seeds both tables so `/people`,
the org chart and the OOO badge have real data in a demo run; its org chart is cycle-free BY
CONSTRUCTION (a manager is always an earlier entry in the org plan's member list — see the module
header), and it emits the two org-scoped events but never `profile.updated`, whose `SYSTEM_ORG`
envelope the outbox's RLS cannot hold. Two
build-time corrections to the draft are recorded here because they are exactly the kind of thing
the next reader needs: `selfRoute` won over `memberRoute` for the profile routes once Phase 9's
builder was actually in the tree (the account page must answer with NO org selected — see
`apps/api/src/people/router.ts`'s own header), and §7's OOO decision resolved to **schedule in
advance** (`ooo_from` + `ooo_until`, CHECK `from < until`), so the directory never badges someone
as out while they are still working.**

**Relationship to Phase 9.** `ai/phase-9-notifications.md` (drafted 2026-08-08, Wave 1 core landed
the same day, not yet merged to `main`) is the reason this phase exists on the roadmap at all —
its own §3.9 needed a canonical user timezone, found none, and scheduled this phase to own it
rather than inventing one. That draft's §3.9 and §8 already commit to the direction of the
dependency: **Phase 9 does not wait on this phase**, and this phase inherits what Phase 9 leaves
behind (`identity.notification_prefs.timezone`, once its own Wave 2 ships) as a seed, not a
migration source. §3.3 below is written to hold regardless of which phase actually merges to
`main` first — it does not assume Phase 9's tables exist at migration time.

Parent: [PLAN.md](../PLAN.md) §3.5 (People), §13 (Roadmap, row 11.5).

---

## 1. Why this phase exists

Nobody built a People module before now because nobody needed one badly enough to justify it —
two other phases needed one _field_ each, and both built the minimal thing rather than wait:

- **Phase 5 (Chat) added `identity.users.display_name`** (migration 0019) because a DM sidebar
  with no channel name to fall back on rendered raw email addresses on every line. Its own
  migration header says so directly: "Chat is what makes it stop being cosmetic." It is a single
  nullable column on the identity table, with no timezone, no title, no manager, and no org
  directory around it.
- **Phase 9 (Notifications) needs a timezone for quiet hours** and, finding none, scoped it to
  `identity.notification_prefs.timezone` — captured from the browser at the moment someone sets a
  quiet-hours window, defaulted to UTC, explicitly **not** a claim about anyone's canonical
  profile (`ai/phase-9-notifications.md` §3.9, its own words: "This makes no claim to be the
  person's canonical profile timezone").

Both are satellite phases building the minimal People-shaped field they needed, each one
documented at the time as provisional — Phase 5's migration says "becomes a display name when
there is a profile surface"; Phase 9's says "Phase 11.5's eventual timezone field is free to
become the source this defaults from later." This phase is that surface: the place a person's
name, timezone, working hours, out-of-office state, and reporting line live as one real record,
instead of one field per phase that happened to need one.

**Teams and role/group management are not this phase's job — they already shipped, in Phase 2**
(`identity.teams`, `identity.team_members`, `packages/policy`'s role matrix). This phase adds no
role, no permission scope, no team concept. **Session/device inventory and SCIM stay in Phase 12**
(`ai/account-page.md` already turned away "session and device inventory" once, explicitly, as
scope creep for a smaller slice; Phase 9's `platform.push_subscriptions` is deliberately
device-row-shaped specifically so Phase 12 can read it without this phase inventing a second
device concept). This phase is profile data — who someone is, when they work, who they report to
— not identity or session infrastructure, and every decision below is checked against that line.

## 2. What's in scope, and what is deliberately not

**In scope:** an org directory (`/people`) listing every member with their profile; a canonical
personal profile (display name, timezone, working hours, out-of-office) editable from `/account`;
an org-scoped reporting line (manager) and job title/department, editable by an admin from the
directory; a profile detail view showing a person's place in the org chart (manager, direct
reports).

**Out of scope, and why each is a real constraint rather than a preference:**

- **No avatar/photo upload.** That is an attachment pipeline (presign → magic-byte → ClamAV,
  §8.4's fail-closed model) built for a different purpose (Work) and not a small add-on to this
  phase. A future slice, not this one; PLAN.md's People description never named it.
- **No session/device inventory, no SCIM, no SAML.** Phase 12's row, unchanged by this phase
  beyond the cross-reference Phase 9 already added (`platform.push_subscriptions` as one of its
  sources).
- **No new role, no new permission catalog entries beyond reuse of `member:read`/`member:manage`.**
  §3.8 argues why the existing two are sufficient and a `profile` resource type is not needed.
  Guardrail 4's fail-closed builder and the 235-entry authz matrix (guardrail 9) both get more
  expensive to keep correct with every resource type added; this phase adds zero.
- **No automation hooks on out-of-office** (e.g. "don't route a card assignment to someone who is
  OOO"). That is Phase 10's shape — a consumer of an event this phase emits — not something this
  phase builds a consumer for itself. §4 emits an event rich enough for Phase 10 to build that
  later without a payload change.
- **No canonicalization of every OTHER place a local time gets rendered.** Work's due dates, Docs'
  timestamps, and Chat's message times keep their current behavior (browser-local rendering).
  Wiring the canonical profile timezone through every date-rendering call site in `apps/web` is a
  real, valuable, and large follow-up — out of this phase's blast radius, named here so it is not
  mistaken for an oversight.
- **No per-day working-hours customization.** §3.4 scopes working hours to one weekly window
  (start time, end time, a set of working weekdays) rather than a schedule that varies Monday to
  Friday. §7 names the richer version as a candidate follow-up, not a Wave-1 requirement.

## 3. Structural decisions

### 3.1 Two tables, split the same way `identity.users` and `identity.memberships` already are

A profile has two kinds of fact in it, and they do not share a lifecycle:

- **Personal facts** — display name, timezone, working hours, out-of-office — are true of the
  _person_, identically in every organization they belong to. This is exactly
  `identity.users.display_name`'s existing shape, and `ai/account-page.md`'s own words for why:
  "yours alone... the same wherever you sign in."
- **Organizational facts** — job title, department, who you report to — are true of a
  _membership_. A consultant who belongs to three orgs can have three managers and three titles;
  collapsing that onto the user row would make "who is Priya's manager" an ambiguous question the
  moment she joins a second org, which `identity.memberships` already solved for `role` by keying
  it on `(org_id, user_id)` rather than on the user.

So this phase adds a new `people` Postgres schema (parallel to `work`, `chat`, `docs`,
`platform` — each product owns its schema; People is a product) with two tables, not one:

```sql
-- Personal, global, no org_id. One row per person who has set at least one field.
CREATE TABLE people.profiles (
  user_id             uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  display_name        text,
  timezone            text,                     -- IANA zone name, e.g. 'America/Chicago'
  working_hours_start time,
  working_hours_end   time,
  working_days        smallint[], -- ISO weekday ints 1-7, e.g. {1,2,3,4,5}
  ooo_until            timestamptz,
  ooo_message          text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Organizational, one row per (org, member) who has set at least one field.
CREATE TABLE people.membership_profiles (
  org_id           uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  manager_user_id  uuid,
  job_title        text,
  department       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id)
    REFERENCES identity.memberships (org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, manager_user_id)
    REFERENCES identity.memberships (org_id, user_id) ON DELETE SET NULL,
  CONSTRAINT membership_profiles_no_self_report
    CHECK (manager_user_id IS NULL OR manager_user_id <> user_id)
);
```

The composite foreign keys are the same containment argument CLAUDE.md already makes for Work's
card hierarchy and Docs' page tree: `identity.memberships` carries the unique index
`memberships_org_user_key` on `(org_id, user_id)` (migration 0004) precisely so a child row can be
constrained to reference a membership that actually exists **in that org** — `manager_user_id`
naming someone who is a member of a _different_ org is refused by the database, not caught by a
service-layer lookup someone could forget to write. `ON DELETE SET NULL` on the manager FK (rather
than `CASCADE`) is deliberate: a manager leaving the org should orphan their reports' `manager_id`
back to null, not delete the reports' own job-title/department rows.

**Both tables are populated lazily, like `identity.notification_prefs`' absent-row-means-default
and unlike a migration-time backfill.** Nobody needs a row inserted per existing user or membership
— `getProfile`/`getMembershipProfile` return nulls for every unset field, and the UI renders an
empty state exactly like `ProfileSection` already does for a display name nobody has set yet.

### 3.2 Moving `display_name`: expand, migrate, contract — for real, across this phase's own waves

"Canonicalize the field Phase 5 added ad hoc" means the column actually moves, not merely that a
new table gets read first. `identity.users.display_name` stays a nullable text column with no
special meaning beyond "auth's own record of it, on its way out" until the contract step removes
it; nothing about `identity.users`' shape changes at Wave 1 time beyond that reinterpretation.

Three call sites read or write it today, and all three are enumerated here because "grep it before
you drop the column" is not a plan a second agent can verify against — this is:

- `apps/api/src/identity/repository.ts` — `findUserById`/`findUserByEmail` select it;
  `updateDisplayName` writes it.
- `apps/api/src/identity/profile.service.ts` — `getProfile`/`updateProfile`, the `auth.me`/
  `auth.updateProfile` routes' implementation (`ai/account-page.md`).
- `apps/api/src/tenancy/member.service.ts` — `listMembers` joins `identity.users` to read it for
  `tenancy.members.list` (the admin settings page's role-management table).

**Wave 1 (expand):** migration creates `people.profiles`, backfills one row per user with a
non-null `display_name` (`INSERT INTO people.profiles (user_id, display_name, updated_at) SELECT
id, display_name, now() FROM identity.users WHERE display_name IS NOT NULL`), and stops there —
`identity.users.display_name` is untouched, still readable, not yet written by new code.
`apps/api/src/people/profile.service.ts`'s `updateProfile` becomes the new write path (see §3.9)
and writes `people.profiles` only. `identity/profile.service.ts`'s `updateProfile` is deleted, not
deprecated-in-place — CLAUDE.md's own rule against compatibility shims for code known to be
unused applies here as much as anywhere. `auth.me`/`auth.updateProfile`'s underlying calls move to
`people.profile.get`/`people.profile.update` (see §3.9 for whether the route names themselves
move); `member.service.ts::listMembers` changes its join from `identity.users.display_name` to
`LEFT JOIN people.profiles ON people.profiles.user_id = identity.memberships.user_id`.

**Wave 3 (contract), a separate migration, not bundled with Wave 1's:** once a deploy has run with
Wave 1's code for at least one full release cycle — long enough to be confident nothing still
reads the old column, the same operational patience `CLAUDE.md`'s expand-migrate-contract
discipline asks for everywhere else — a follow-up migration drops
`identity.users.display_name` and its two CHECK constraints. This is deliberately its own
migration file, per "migrations are paired... never edited once applied": Wave 1's migration
already ran and is not the place to add a `DROP COLUMN` weeks later.

**What does NOT move:** `identity.displayNameChanged` (the event) is retired, replaced by
`people.profileUpdated` (§4) — grep confirms it has exactly one producer
(`identity/profile.service.ts`) and zero consumers today, so retiring it is a rename with no
migration path required for a consumer.

### 3.3 Canonical timezone: a fallback in the read path, never a write into another phase's table

The same lesson migration 0019 already wrote down for `display_name` — "the FALLBACK lives in the
read path... that keeps the guess where it can be changed and out of the data" — is exactly the
shape this needs, for the identical reason: writing a backfilled guess into
`people.profiles.timezone` would look exactly like something the person entered, and the guess
would never get corrected because it looks fine.

`people.profiles.timezone` starts `NULL` for every existing user; there is no migration-time
backfill from `identity.notification_prefs.timezone` at all. Instead, `getProfile` in
`apps/api/src/people/profile.service.ts` resolves it as: **the profile's own value if set, else
`identity.notification_prefs.timezone` if that table and a row for this user exist, else `null`**
(the UI prompts for one; it does not invent one). The middle branch is read-only and one-directional
— setting a profile timezone never writes back to `notification_prefs`, and Phase 9's quiet-hours
logic is untouched by this phase entirely.

This is written to hold **regardless of merge order**, which matters concretely: as of this
writing, `ai/phase-9-notifications.md`'s own status header says its Wave 2 (the wave that actually
adds a `timezone` column to `identity.notification_prefs`) is **not built** — only Wave 1's core
landed, and Wave 1's migration (0027, on the unmerged `development-phase9` branch) has no timezone
column at all yet. So the middle branch above is written as a **runtime existence check** (does the
column/row resolve, not a compile-time assumption that it does), specifically so this phase's own
migration and code do not have to be sequenced after Phase 9's Wave 2 to be correct. If Phase 9's
Wave 2 has not shipped by the time this phase does, the fallback chain simply has one fewer rung —
nothing errors, nothing blocks. If it ships later, the fallback starts working the day it does,
with no change to this phase's code.

**The dependency is one-directional and does not flow back.** Nothing in this phase writes to
`identity.notification_prefs`; Phase 9's own §3.9 and §8 already say the reverse relationship (its
table seeding this phase's field, once) is what they designed for, and this section is the
implementation of that promise. Whoever builds Phase 9's Wave 2 after this phase exists should
point the same fallback in reverse (quiet hours defaulting FROM `people.profiles.timezone` when a
user has never set a quiet-hours-specific one) — noted here so it is a known future edit to that
phase's file, not a surprise.

### 3.4 Working hours: one weekly window, not a per-day schedule

`working_hours_start`/`working_hours_end` (`time`, no date, interpreted in the profile's own
`timezone`) plus `working_days` (`smallint[]`, ISO weekday numbers) describes one recurring window
— "9 to 5, Monday through Friday" — not "9 to 5 on weekdays, 10 to 2 on Saturdays." A CHECK
(`working_hours_end > working_hours_start`) rejects an overnight window (a shift crossing
midnight) rather than silently storing a window that every consumer would interpret backwards;
this is a named simplification (§7), not an oversight — a genuine overnight-shift feature needs a
richer shape than one CHECK can express honestly, and nothing in this phase's scope (an org
directory badge, not a scheduling system) needs it yet.

Both columns are nullable and independent: a person can set a timezone with no working-hours
window at all (the directory just shows their local time, no "likely available" badge), and the
UI treats "hours unset" and "hours set but currently outside them" as two different presentations
rather than collapsing "unknown" into "unavailable."

### 3.5 Out-of-office: a state, not a log

`ooo_until` (nullable `timestamptz`) and `ooo_message` (nullable, bounded text, same
present-and-non-blank CHECK pattern as `display_name`) together answer one question — "is this
person OOO right now, and until when" — as a single mutable pair, not an append-only history of
OOO periods. Setting `ooo_until` to a future timestamp starts OOO immediately (there is no
`ooo_from` for scheduling a _future_ OOO period in advance — §7 names this as an open call, not a
default nobody considered); clearing it (`null`) ends OOO immediately, which is also how someone
returning early cancels it. "Is this person OOO" is computed at read time (`ooo_until IS NOT NULL
AND ooo_until > now()`), never stored as a separate boolean that could drift from the timestamp
that actually decides it.

### 3.6 Reporting lines: containment from the schema, cycle prevention from the service

§3.1's composite foreign keys already make an org chart's edges structurally sound — a manager
must be a real membership in the same org. What they cannot express is acyclicity: nothing stops
`UPDATE people.membership_profiles SET manager_user_id = B WHERE user_id = A` immediately after
`... SET manager_user_id = A WHERE user_id = B`, and the database has no constraint language for
"not reachable from here going up." This is the identical problem Docs' page tree solves for
`movePage` — a node cannot become its own ancestor — solved the identical way: a service-level
check before the write, not a schema trick.

`setReportingLine(orgId, userId, managerUserId)` in `apps/api/src/people/reporting.service.ts`
walks the proposed manager's chain upward (`membership_profiles.manager_user_id`, repeatedly,
bounded at a fixed depth — 100 hops is generous for any real org and exists purely as a safety
valve against a bug elsewhere producing a chain that never terminates, not as a belief that a
legitimate chain could be that deep) and refuses the write with a validation error if `userId`
appears anywhere in it. A direct self-report (`manager_user_id = user_id`) is caught by §3.1's
CHECK already; this closes the transitive case the CHECK cannot see.

**Setting a reporting line is never self-service, and job title is.** This is the same asymmetry
`packages/policy/src/roles.ts` already documents for `message:update` vs `message:delete` — two
actions that look similar and are authorized differently on purpose. A job title is cosmetic,
self-asserted text with the identical safety argument `display_name` already has (attacker-
controlled, reaches a label and nothing else, `member:read` is all that is needed to see it). A
reporting line is a structural fact other people rely on — an org chart, eventually an approval
routing rule in Phase 10's automation — and letting someone assign their own manager (or worse,
assign themselves as someone else's) is a shape of privilege confusion this phase should not
introduce even though nothing downstream depends on it yet. `people.profile.update` (personal
fields, including the org-scoped `jobTitle`/`department` on one's own membership) is self-service;
`people.reportingLine.set` requires `member:manage`, unconditionally, with no author-exception —
mirroring `changeRole`'s existing "nobody changes their own role" defense-in-depth, restated here
as "nobody assigns their own manager."

### 3.7 Visibility: no RLS on personal profiles, ordinary tenant RLS on membership profiles

`people.profiles` gets **no row-level security policy at all — the same choice `identity.users`
already made**, and for the identical reason: nothing about a display name, a timezone, or an
out-of-office message is secret from other people in a shared org, and the actual access boundary
is which _routes_ exist, not which _rows_ a query can see. There is no route that accepts an
arbitrary target user id for a personal-profile write (§3.9's `people.profile.update` is
self-only, exactly like `auth.updateProfile` before it), so no row-level check is doing any work a
route-level check is not already doing more legibly. Adding RLS here would be defense that defends
against nothing, and CLAUDE.md's own taste is explicit about not building controls for scenarios
that cannot happen.

`people.membership_profiles` is the opposite case and gets the ordinary, non-negotiable org
tenant-isolation policy every other org-scoped table has (guardrail 1): `org_id =
current_setting('app.org_id')::uuid`, `USING`/`WITH CHECK` both. This one **is** doing real work —
`people.reportingLine.set` is callable by an admin naming _another_ member as the subject, so the
query is not self-scoped the way §3.9's personal-profile routes are, and `withOrgScope` plus RLS
is what stops an admin of org A from being able to name org B's membership rows at all, the same
guarantee every other tenant table in this codebase relies on.

### 3.8 No new resource type, no new permission

`member:read` (already granted to every non-guest role) gates the directory listing and any
individual profile's org-scoped fields; `member:manage` (already admin-and-owner-only) gates
`reportingLine.set` and admin-initiated edits to someone else's job title/department. Both already
exist in `packages/policy/src/permissions.ts` and `roles.ts`; this phase's authorization matrix
diff is **zero new rows** — `member:read`/`member:manage`'s existing 4-role × 2-permission
coverage already answers every question this phase's routes ask. Adding a `profile` resource type
for a phase that needs no permission `member:read`/`member:manage` cannot already express would be
the kind of speculative abstraction CLAUDE.md's working agreement asks not to build.

Personal-field self-editing (`people.profile.update`, reading/writing one's own
`displayName`/`timezone`/`workingHours`/`ooo`) uses the same `memberRoute` builder
`ai/phase-9-notifications.md` §"What's actually built" introduces for `notifications.prefs.*`:
authenticated, org resolved, no specific permission — because, as that draft's own reasoning goes,
no single `Permission` describes "manage your own X," and gating it behind any one permission
would wrongly refuse a caller who holds none of the ones chosen. (If Phase 9's `memberRoute`
addition to `apps/api/src/trpc/builder.ts` has not merged yet when this phase is implemented,
`selfRoute` — the org-independent equivalent `auth.me`/`auth.updateProfile` already use — is the
fallback; §7 names the choice between them as dependent on merge order, not on this phase's own
design.)

### 3.9 API surface — a new `apps/api/src/people` module

Mirrors the existing per-product layout (`work/`, `chat/`, `docs/`), mounted in
`apps/api/src/router.ts` as `createPeopleRouter`, top-level namespace `people`:

- `people.profile.get` — `memberRoute`/`selfRoute` (§3.8). No input; subject is the caller. Returns
  the merged personal-profile view, including §3.3's timezone fallback.
- `people.profile.update` — same route kind. Input: partial `{ displayName, timezone,
workingHoursStart, workingHoursEnd, workingDays, oooUntil, oooMessage }`, using the same
  `'x' in patch` (not `??`) discipline `apps/web`'s `useUpdateCard` already established for
  telling "clear this field" apart from "did not send this field" (CLAUDE.md, Phase 3 §"the two
  places its types lied").
- `people.directory.list` — `route({ permission: 'member:read' })`. Org-scoped. Returns every
  member's merged view: `identity.memberships` joined to `people.profiles` (personal) and
  `people.membership_profiles` (org-scoped), the union `tenancy.members.list` deliberately does
  not return today (that route stays focused on role administration, unchanged by this phase —
  §1's own line about not touching Phase 2's surface). Some duplication of the base
  membership→user join between the two routes is accepted, the same way Phase 9 §3.3 accepted
  "already seven kinds... times three channels" rather than force one table to serve two
  call sites with different shapes.
- `people.directory.get` — `route({ permission: 'member:read' })`. One member's full profile plus
  `managerUserId`'s resolved name and a list of direct reports (`membership_profiles` rows where
  `manager_user_id = this user`), for the profile detail view.
- `people.membershipProfile.update` — `route({ permission: 'member:manage' })` for editing
  **someone else's** `jobTitle`/`department`; self-editing one's own goes through
  `people.profile.update` instead (§3.6 already separates the self-service case). Both write the
  same table; the permission difference is which subject the caller is allowed to name.
- `people.reportingLine.set` — `route({ permission: 'member:manage' })`, always, no self-exception
  (§3.6). Input: `{ userId, managerUserId: string | null }`.

### 3.10 Web UI surface

- **`/people`** (new top-level route, `requireOrg`, mirroring `boardRoute`/`docsRoute`'s pattern in
  `apps/web/src/router.tsx`): the org directory. A searchable list (name, title, local time derived
  from timezone, an OOO badge when applicable), reusing `Section`/`Empty`/`SkeletonRows` from
  `components/primitives.tsx` the same way every other list view in this codebase does rather than
  inventing new list chrome.
- **`/people/$userId`**: one member's profile — personal fields (read-only unless it is the
  viewer's own), job title/department, manager (linked), direct reports (linked). An admin viewing
  someone else's page sees an edit affordance for job title/department/manager gated on
  `member:manage`, exactly as `admin/settings-page.tsx`'s role dropdown already is today — the UI
  never re-derives that check (CLAUDE.md's standing rule, §"The UI never re-derives authorization");
  the server answers and a member without the permission gets an honest FORBIDDEN from the route,
  not a hidden button.
- **`/account`** (`ai/account-page.md`'s existing page) gains a new section, **Working hours &
  timezone**, between the existing Profile and Passkeys sections: timezone picker, working-hours
  start/end + weekday toggles, out-of-office toggle with an optional return date and message. This
  is the natural home — `ai/account-page.md`'s own header already anticipated it: "the right home
  is a `/account` route when §3.6's [now §3.5's] People surface is built." `ProfileSection`'s
  existing display-name field now calls `people.profile.update` instead of `auth.updateProfile`
  (§3.2); nothing about its own UI changes.
- **`admin/settings-page.tsx`** is unchanged beyond nothing — job title/manager administration
  lives on the `/people/$userId` page, not bolted onto the existing role-management table, because
  that table's own purpose (`changeRole`) is a different concern than a profile edit and conflating
  them would make one screen do two unrelated things.

## 4. Event catalog

Three new events, one retirement, all following `<resource>.<past_tense_verb>` (`packages/events`'
naming rule) and, per guardrail 11, emitted inside the same transaction as the write:

- **`profile.updated`** — `{ userId, changed: string[], before: {...}, after: {...} }` for
  whichever of `displayName`/`timezone`/`workingHoursStart`/`workingHoursEnd`/`workingDays`/
  `oooUntil`/`oooMessage` changed, mirroring `card.updated`'s existing `changed`-array shape
  (CLAUDE.md, Phase 4/9's own precedent for "payload changes needed on existing events" applies in
  reverse here: build the array from the start rather than add it once a consumer needs it).
  Emitted with `SYSTEM_ORG` as the audit scope's `orgId` — the identical sentinel
  `identity/profile.service.ts`'s retired `displayNameChanged` already used, because this fact
  is org-independent, same as before.
- **`membershipProfile.updated`** — `{ orgId, userId, changed: string[], before, after }` for
  `jobTitle`/`department`. Real `orgId`, not `SYSTEM_ORG` — this fact is org-scoped and the audit
  log's per-org projection needs to attribute it correctly.
- **`reportingLine.changed`** — `{ orgId, userId, before: managerUserId | null, after:
managerUserId | null }`, its own event rather than folded into `membershipProfile.updated`
  (§3.6's own reasoning: a structural org-chart edge is a more sensitive fact than a free-text
  title, and deserves to be independently greppable in the audit log rather than mixed into a
  "some profile field changed" bucket an auditor has to open to interpret).
- **Retired: `identity.displayNameChanged`** (§3.2). Zero consumers today, confirmed by grep at the
  time this was written; delete the definition rather than leave a dead event type importable from
  `@taskflow/events`.

No changes to any _existing_ event's payload — unlike Phase 4 Wave 2 and Phase 9's own experience
("the draft claimed no new payload schemas... that held for Wave 1 and broke in Wave 2"), this
phase touches no event another product already emits, because it consumes nothing — no automation,
no notification routing, no search indexing reads a People event yet. That is a deliberate
absence (§2), not an oversight: the payloads above are shaped to make Phase 10 automation
("assign to whoever the sender reports to") and Phase 9's own eventual timezone default (§3.3) both
buildable later with no payload change, the same forward-compatible shaping §5's provider-interface
pattern uses elsewhere.

## 5. Waves

**Wave 1 — schema, personal profile, org directory (read + self-edit).** `people` schema,
`people.profiles`, the display-name expand migration and backfill (§3.2), `apps/api/src/people`
with `profile.get`/`profile.update`/`directory.list`/`directory.get`, `/people` and `/people/$userId`
(read-only for org-scoped fields — no reporting-line UI yet), `/account`'s new working-hours/
timezone/OOO section, `profile.updated` event. **Acceptance:** every existing display-name read
call site (§3.2's three) sources from `people.profiles`; the directory shows every org member's
name, timezone-derived local time, and OOO badge; a person can set their own timezone, working
hours, and out-of-office state from `/account`.

**Wave 2 — reporting lines and org-scoped fields.** `people.membership_profiles`, the composite FKs
and cycle-prevention service (§3.6), `membershipProfile.update`/`reportingLine.set`, the
manager/direct-reports view on `/people/$userId`, admin edit affordances gated on `member:manage`,
`membershipProfile.updated`/`reportingLine.changed` events. **Acceptance:** an admin can set a
member's manager and job title; a self-report or a cycle is refused with a validation error, not a
500; a non-admin sees the same page with no edit controls and gets FORBIDDEN if they call the
mutation routes directly.

**Wave 3 — contract.** A follow-up migration (§3.2), timed after a release cycle, dropping
`identity.users.display_name` and its two CHECK constraints. **Acceptance:** `pnpm --filter
@taskflow/db migrate:verify` (up → down → up) passes with the column gone; grep confirms zero
remaining references to `identity.users.display_name` outside the migration history itself.

## 6. Cross-cutting obligations

**Guardrail 11 applies with no exception in this phase** — unlike Phase 9's one named exception
for a second-order event, every mutation here (`profile.update`, `membershipProfile.update`,
`reportingLine.set`) is a direct, user-facing service method and emits its own event in the same
transaction as its write, the ordinary case guardrail 11's lint rule already checks for.

**Guardrail 8 (tenancy fuzz) enrollment is automatic for the `member:manage`-gated routes** and
needs a specific assertion for the self-service ones: `people.profile.update` and
`people.profile.get` take no org-scoped resource id as input (the subject is always the caller), so
the fuzz harness should record them `not-applicable` for cross-tenant substitution — the same
documented outcome `ai/phase-9-notifications.md`'s `memberRoute` routes get — rather than a test
author being surprised a route with no id argument reports nothing to substitute.

**Tests ship with the slice.** Minimum, named explicitly rather than left to "reporting lines
work": a test proving `setReportingLine` refuses a direct self-report (the CHECK) and a transitive
cycle (the service walk) with a validation error, not a constraint-violation 500; a test proving
`people.membership_profiles`' composite FK refuses a manager who is a member of a **different**
org (the tenancy-fuzz-style cross-tenant substitution, run once explicitly as a targeted unit test
too, since a passing fuzz run alone would not explain _why_ it passed to a future reader); a
migration-verify test for Wave 1's expand step and, separately, Wave 3's contract step; a test
proving `people.profile.get`'s timezone fallback reads `identity.notification_prefs` when present
and returns `null` (not `'UTC'`, not an error) when that table has no row for the caller — the
concrete case that exercises §3.3's "hold regardless of merge order" claim; a test proving
`display_name` set via the old `auth.updateProfile` route no longer exists (a route removed, not
merely superseded) once Wave 1 lands, so a stale client cannot silently keep writing the old path.

**RLS split gets its own test per table**, the same discipline `identity.notification_prefs`
established: a query as user A must never return user B's `people.membership_profiles` row from a
different org (ordinary tenant isolation, asserted against real Postgres); a query for
`people.profiles` must succeed for **any** authenticated caller reading **any** user's row (proving
§3.7's "no RLS" choice is the intended behavior, not an untested gap — a test that only checks
"my own row is readable" would not catch a regression that accidentally added a self-only policy
and broke the directory).

## 7. Decisions — for review

Following `ai/phase-4-realtime.md` §7's and `ai/phase-9-notifications.md` §7's own precedent:
recommendations, not decisions a human has signed off on yet.

1. **Working hours as one weekly window vs. a per-weekday schedule** (§3.4). This draft scopes
   Wave 1 to the simpler shape. Confirm, or widen the column shape now — `working_hours_start`/
   `_end` becoming per-weekday is a real schema change, not a UI-only addition, so it is cheaper to
   decide before Wave 1 ships than after.
2. **Scheduling a future out-of-office period in advance** (§3.5). Today's shape starts OOO the
   moment `ooo_until` is set. Adding `ooo_from` is a small, additive column if wanted — confirm
   whether Wave 1 needs it or it is a real Wave 2/3 candidate.
3. **`memberRoute` vs `selfRoute` for `people.profile.*`** (§3.8), contingent on whether Phase 9's
   `apps/api/src/trpc/builder.ts` addition has merged by the time this phase is implemented. Not a
   design call this phase controls — noted so the implementer checks rather than assumes either.
4. **Migration numbering.** `packages/db/migrations` ends at `0026` on `main` as of this writing;
   Phase 9's own (unmerged) Wave 1 claims `0027`. This phase's migrations are written above without
   a hardcoded number for that reason — claim the next number actually free on `main` at merge
   time, and coordinate with whichever of Phase 7/9/10/11 merges first if more than one is in
   flight simultaneously.
5. **Whether `people.directory.list`'s response should be paginated from Wave 1.** Every existing
   `*.list` route in this codebase (`tenancy.members.list`, `docs.spaces.list`) returns everything
   unpaginated, on the reasoning that org membership counts are small at this project's current
   scale. Confirm that reasoning still holds for People specifically, or scope cursor pagination
   into Wave 1's route shape now rather than as a breaking change to the client later.

## 8. Sequencing and cost

Per PLAN.md §13: 3 weeks estimated, same as Phase 9's row. Depends on Phase 2 (memberships, the
role matrix — already complete) and, for §3.2's `listMembers` join update, Phase 2's
`member.service.ts` (already complete). **Does not depend on Phase 7 (Voice), Phase 8 (Search),
Phase 10 (Automation), or Phase 11 (Analytics)** despite sitting after all four in the roadmap's
numbering — nothing here reads from or writes to any of their tables, and §3.3 is written
specifically so it does not need to wait on Phase 9 either, the same "add a consumer to an event
bus that already carries production traffic" shape the roadmap's own sequencing notes already use
to describe why Phases 8–11 have no ordering constraint among themselves.

**What Phase 12 inherits from this phase, the same direction Phase 9 → this phase already runs:**
a real `people.profiles`/`people.membership_profiles` pair for its device/session inventory screen
to sit alongside, and an established `apps/api/src/people` module for its SCIM provisioning sync
(Phase 12's row) to write into rather than inventing its own profile-shaped table. Neither should
need to migrate around what this phase leaves behind.

One new Postgres schema, two new tables, zero new Postgres roles (§3.7 — both tables are reached
through the ordinary app role via `withOrgScope`/`selfRoute`, nothing async touches them), two new
permission-matrix rows (zero — §3.8 reuses `member:read`/`member:manage` exactly as they exist
today), three new domain events and one retired, one expand migration (Wave 1) and one contract
migration (Wave 3, deliberately separate) — smaller than Phase 9's Wave 1, comparable to Phase 4's
Wave 1.
