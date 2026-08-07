# Passkey browser ceremony — plan

**Status: PROPOSED, not yet implemented.** This document is the plan; no application code changes
ship in the commit that adds it.

## Why this exists

PLAN.md's Phase 3 roadmap entry and `CLAUDE.md`'s "Current state" section both call this out by
name: the passkey backend (§8.1) has been complete since Phase 1 — options generation, verification,
challenge single-use, step-up on removal, the full `apps/api/src/identity/passkey.*` slice and
`packages/security/src/webauthn.ts` — but `apps/web` never wired `@simplewebauthn/browser` to it. The
login page's "Sign in with a passkey" button currently just sets a note saying so
(`apps/web/src/features/auth/login-page.tsx:107-120`). This closes that gap: the browser ceremony
only, no server-side changes.

## Scope

**In scope**

1. Passkey sign-in from the login page (`startAuthentication` → `finishAuthentication`).
2. Passkey enrollment, listing, renaming, and removal from account settings
   (`startRegistration` → `finishRegistration`, `list`, `rename`, `remove`).
3. Feature detection and graceful degradation on browsers/contexts without WebAuthn.
4. Tests for all of the above, mocking `@simplewebauthn/browser` the same way existing auth-page
   tests mock `../../lib/trpc.js` (see `verify-email-page.test.tsx`).

**Out of scope**

- Any change to `apps/api/src/identity`, `packages/security`, or the passkey database schema. This
  is a browser-only slice against an already-shipped, already-reviewed API surface.
- Passkey-first registration (creating an account with no password). Registration stays
  email+password; a passkey is added to an existing, signed-in account, matching how
  `passkeys.startRegistration` is scoped today (`selfRoute`, user comes from the verified token).
- Conditional UI / autofill (`mediation: 'conditional'`). Worth a follow-up once the primary flow is
  proven; adding it now doubles the surface to test in one slice.

## How the ceremony works

### Sign-in (login page)

1. Add `@simplewebauthn/browser` as a dependency of `apps/web`.
2. New module, `apps/web/src/features/auth/passkey.ts`, wrapping the two ceremonies:
   - `signInWithPasskey()`: calls `api.auth.passkeys.startAuthentication.mutate()` to get
     `PublicKeyCredentialRequestOptionsJSON`, passes it to `startAuthentication()` from
     `@simplewebauthn/browser`, then sends the result to
     `api.auth.passkeys.finishAuthentication.mutate({ response })`. Returns the same
     `SessionResponse` shape `auth.login` does.
   - `enrollPasskey(name?)`: the same shape for `startRegistration`/`finishRegistration`.
   - Both wrap the browser call in a translator that turns `@simplewebauthn/browser`'s thrown
     `WebAuthnError` into a small closed set of UI-facing reasons (`'cancelled' | 'not_allowed' |
     'unsupported' | 'unknown'`) rather than letting a raw `DOMException` reach a component — the
     browser side gets the same "one shape of failure the UI understands" treatment
     `passkey.service.ts` already gives the server side.
3. `login-page.tsx`'s passkey button becomes a real mutation using `useMutation` +
   `signInWithPasskey()`, following the exact `onSuccess` path the password form already uses:
   `adopt(session, ...)`, `resetCache(queryClient)`, `navigate({ to: search.next ?? '/' })`. Unlike
   password sign-in there is no email to pass to `adopt` — it takes `null`, same as a restored
   session today (session.ts already handles `email: null`).
4. A cancelled ceremony (`NotAllowedError` — the user dismissed the prompt or it timed out) is not
   an error banner; it resets to the idle button state silently, the same way a browser's own
   password-autofill cancel does. A genuine failure (bad signature, unknown credential — the API's
   single `INVALID_CREDENTIALS` for all of them, per §8.1 property 2) does show the existing
   `ErrorView`.

### Enrollment, listing, rename, remove (settings)

5. A new "Security" section on the personal side of settings. `SettingsPage` today is entirely
   org-scoped (`requireOrg`) and holds `ProfileSection` for personal display-name editing alongside
   org/member/team management — passkeys are personal and cross-org the same way, so the natural
   place is a new `PasskeySection` alongside `ProfileSection` in
   `apps/web/src/features/admin/settings-page.tsx`, not a new route.
6. `PasskeySection`:
   - Lists via `api.auth.passkeys.list.query()` — name, device type, "Backed up" badge, created/last
     used dates (`formatDate`, already used elsewhere on this page).
   - "Add a passkey" button runs `enrollPasskey()`, prompts for a name inline on success (optional —
     `finishRegistration` already accepts `name?`), and invalidates the list query.
   - Rename is inline-edit, same pattern as `OrgSection`'s name field.
   - Remove goes through `useStepUp()` exactly like the existing member-removal and grant-revocation
     controls on the same page (`remove` is `stepUp: true` on the server) — no new step-up plumbing
     needed, just another `guard()`/retry call.
   - The server's "can't delete your last credential" `VALIDATION` error
     (`passkey.service.ts:352-356`) renders through the existing field-error path; no special casing.
7. Feature detection: `browserSupportsWebAuthn()` from `@simplewebauthn/browser` gates both the login
   button and the "Add a passkey" control. Where it returns `false` (non-secure context, unsupported
   browser), the control is replaced with the current static explanatory text rather than removed —
   consistent with the "UI never re-derives authorization, but it can say why a control is absent"
   spirit already used for the disabled state.

## Testing

- `passkey.ts` (the wrapper): unit tests mocking `@simplewebauthn/browser`'s `startAuthentication` /
  `startRegistration` and asserting the error-translation table, since that mapping is the one bit of
  actual logic in this slice.
- `login-page.test.tsx` (new): mocks `../../lib/trpc.js` and `./passkey.js`, asserting the
  passkey-button path adopts a session and navigates, and that a cancelled ceremony leaves the form
  usable rather than stuck — the same "what does the component do with a resolved/rejected promise"
  framing `verify-email-page.test.tsx` already uses, and for the same reason: this is exactly the
  kind of state-machine bug (permanent spinner, double-fire, silent failure) that class of test
  exists to catch.
- `settings-page.test.tsx` additions (or a new `passkey-section.test.tsx` if the existing file is
  awkward to extend): list rendering, add flow, rename, and remove-with-step-up — mocking `useStepUp`
  the way other settings tests already do for member removal, if such a mock exists; otherwise
  driving the real `StepUpDialog`.
- No new server-side tests — `passkey.service.test.ts` and the router already cover that half.

## Security notes (why this is lower-risk than the rest of `identity`)

- Every cryptographic decision — `expectedOrigin`, `expectedRPID`, `requireUserVerification`,
  algorithm pinning, challenge single-use — is already made in `packages/security/src/webauthn.ts`
  and `apps/api/src/identity/passkey.service.ts`, both ⚠ human-review surfaces that shipped and were
  reviewed in Phase 1. This slice adds no new trust decision; it is transport plumbing between a
  browser API and an already-verified server contract.
- The one thing worth a careful read in review: the error-translation layer must not leak which
  failure occurred (unknown credential vs. bad signature vs. locked account) beyond what the server
  already exposes as one undifferentiated `INVALID_CREDENTIALS` — the browser wrapper should collapse
  all of those to the same UI state, not helpfully re-surface `error.name` text.
- `apps/web/src/features/auth/**` is not on the `CLAUDE.md` §2.2 human-review list, but given it sits
  directly next to `apps/api/src/identity`, I'd still ask for a second look before merge rather than
  treat "not on the list" as "no review needed."

## Rollout

Single PR, one slice (no waves needed — this is small enough not to split). Order of commits:

1. Add the dependency + `passkey.ts` wrapper + its tests.
2. Wire the login page.
3. Add `PasskeySection` to settings + its tests.
4. Update `CLAUDE.md`'s "Deferred deliberately" note (remove the passkey-browser line) and PLAN.md's
   Phase 3 roadmap row (drop "passkey browser ceremony" from the Deferred column) once shipped.
