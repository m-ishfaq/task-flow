# A personal account page — plan

**Status: PROPOSED, implementing on the same branch as the passkey browser ceremony
(`claude/development-passkey-plan-6ghpgq`).**

## Why this exists

Two things converged:

1. **A real bug.** `/settings` (`admin/settings-page.tsx`) is gated by `requireOrg` — it needs an
   org selected. `PasskeySection`, added in this branch's first slice, has no org dependency at
   all (`list`/`startRegistration`/`rename`/`remove` are all `selfRoute`), but it was mounted
   inside that org-gated page anyway. A user with no org yet — or one whose stored org selection
   went stale (`OrgGate`'s own documented failure mode) — could never reach it. Passkeys are exactly
   the kind of thing someone wants to set up regardless of which, or how many, organizations they
   are in.
2. **`profile.service.ts` already named the fix.** Its own header comment on `ProfileSection`
   (before this change, living in `admin/settings-page.tsx`) says: "the right home is a `/account`
   route when §3.6's People surface is built." This is that route — a narrow personal slice of it,
   not §3.5's full People phase (org directory, teams, reporting lines, session/device inventory,
   SCIM — all explicitly still deferred in PLAN.md). This page is deliberately small: profile,
   passkeys, "sign out everywhere," and the org list. Nothing here is a step toward SCIM or a team
   directory.

## Scope

**In scope**

- A new route, `/account`, gated by `requireSession` only — **not** `requireOrg`. Reachable the
  moment someone is signed in, with or without an org.
- Reachable from the sidebar avatar menu: a new "Profile settings" item, above "Sign out."
- Four sections on the page:
  1. **Profile** — email (read-only), display name (editable, same `auth.updateProfile` route
     `ProfileSection` already used), account created date, email-verified status. Needs a NEW
     read route (see below) since the only account-info source until now was the ORG member list
     (`tenancy.members.list`), which does not exist with no org selected.
  2. **Passkeys** — `PasskeySection`, moved here verbatim from `admin/settings-page.tsx`. No
     behavioral change; this is the fix for the bug above.
  3. **Sessions** — one button, "Sign out of everywhere else," on the already-shipped
     `auth.logoutEverywhere` (step-up protected). Explicitly **not** a session/device list — that
     is PLAN.md §3.5's "session and device inventory," named there as deferred, and building a
     table for it now would be scope creep this slice does not need.
  4. **Organizations** — the orgs the caller belongs to and their role in each, via the existing
     `orgsQuery()` (`tenancy.orgs.list`, already `selfRoute`, already used by the switcher). A link
     to `/orgs` to join or create another, reusing the existing picker rather than building a
     second one.
- `admin/settings-page.tsx` loses `ProfileSection` and `PasskeySection` entirely. What is left there
  — org name, members, teams — is genuinely org-scoped, which is what that page's own heading
  ("Organization settings") already claims and previously did not fully deliver on.

**Out of scope**

- Anything from PLAN.md §3.5 beyond what is listed above: org directory, teams, reporting lines,
  timezones, working hours, out-of-office, role/group management UI, session/device inventory,
  SCIM.
- Passkey-first account creation — unchanged from the existing plan.
- Deleting/deactivating an account.

## What needs a new server route, and why

`ProfileSection` today derives the display name from `useMembers().personOf(viewerId)` — the ORG
member list. There has never been a route that answers "what is my own account, independent of any
org." Adding one is a small, necessary addition to `apps/api/src/identity` (⚠ human-review surface,
§2.2 — flagged here explicitly, same as `profile.service.ts`'s own header already does for
`updateProfile`).

- `apps/api/src/identity/repository.ts`: `UserRow`/`selectUser` gain `createdAt`. It is already a
  plain column on `identity.users` (migration 0002); nothing about the query's authorization
  changes, and every existing caller of `findUserById`/`findUserByEmail` gets one more field for
  free — none of them read the interface exhaustively, so this cannot break an existing caller.
- `apps/api/src/identity/profile.service.ts`: a new `getProfile(userId)` reading
  `email`, `displayName`, `createdAt`, and `emailVerified` (a boolean, not the raw timestamp — the
  UI needs "verified or not," not the exact moment, and the smaller response is the one that cannot
  leak something later, the same reasoning `listPasskeys` already gives for its own trimmed shape).
- `apps/api/src/identity/router.ts`: `auth.me`, `selfRoute`, a query with no input — the subject
  is the verified principal, exactly like `updateProfile`, `logoutEverywhere`, and every passkey
  route. No new trust decision: it reads the same row `updateProfile` already writes, gated the
  same way.

No password hash, no lockout state, no failed-login count — none of that is needed by a profile
view, and keeping the new route's output narrow is cheaper than auditing later why it grew.

## Testing

- `profile.service.test.ts`: `getProfile` — returns the right shape, `emailVerified` reflects
  `emailVerifiedAt`, 404s for a user id that does not resolve (mirrors `updateProfile`'s existing
  check).
- A frontend test for the new profile section's display + edit flow, in the same
  `verify-email-page.test.tsx`-style state-machine spirit already used for `login-page.test.tsx` /
  `passkey-section.test.tsx` in this branch.
- `PasskeySection`'s own tests are untouched — moving the file does not change its behavior, and
  its test file moves with it.
- No new authorization matrix entries: `auth.me` is `selfRoute`, the same shape
  `packages/policy`'s matrix already does not enumerate (self-routes are deliberately outside the
  role × permission matrix, same as `updateProfile` today).

## Rollout

Same branch, same PR (`#27`) as the passkey browser ceremony — the user's own instruction, and it
also happens to be the right call: this slice exists partly _because of_ a bug the passkey slice's
placement caused, so keeping them in one review makes that causality visible instead of splitting
a fix from the bug it fixes across two PRs.
