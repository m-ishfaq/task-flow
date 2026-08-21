# @taskflow/mobile

The Android & iOS app (Expo / React Native). Full plan: [ai/phase-14-mobile.md](../../ai/phase-14-mobile.md).

## Status — Wave 1 complete, Wave 1b complete (passkeys infra-blocked), Wave 2 (Work) started

Six increments in, Wave 1's acceptance bar (§7: the three gates and one
authenticated tRPC read, on a real device, against the real API) has
everything CI can prove behind it, **and now a real Metro bundle behind it
too** — `pnpm --filter @taskflow/mobile build` (`expo export`) produces an
actual Hermes bytecode bundle for both platforms, not just a green `tsc`. **A
green `pnpm verify` here is STILL not the same claim as "this works when you
click it" (§11) — nobody has run this on a simulator or a physical device
yet** — but the gap between "typechecks" and "bundles" is now closed, and
closing it found a real bug (below). Keychain, biometrics, push and WebRTC
stay device-only no matter how green this gets.

### `src/lib/` — the pure client spine (Expo-free, unit-tested)

- **`config.ts`** — per-channel API base URL, validated at boot; the tRPC URL
  is derived, never separately configured.
- **`secure-store.ts`** — the `SecureStore` port and an in-memory test double
  only. The real device implementation lives in **`device-secure-store.ts`**
  (a separate file on purpose: it imports `expo-secure-store`, which
  transitively pulls in React Native's Flow-typed source that Vitest's
  transform cannot parse — splitting the two is what keeps `session.test.ts`
  runnable with no Expo runtime in the module graph), setting the
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` accessibility class explicitly (§4.1,
  §6.2).
- **`preferences.ts`** — the non-secure `Preferences` port over `AsyncStorage`,
  for the remembered org id — deliberately NOT one of the two files the
  credential-seam guardrail locks down, since an org id is not a credential.
- **`session.ts`** — in-memory access token, refresh-token custody in the
  keystore, single-flight refresh, the offline-launch safeguard, and the
  native token shape that carries the refresh token (§4.3's client half).
- **`org-gate.ts`** — validates a remembered org against real memberships
  before any org-scoped screen renders (ported from apps/web's `OrgGate`).
- **`trpc-client.ts`** — the header-bearer tRPC client, typed against the
  shared `AppRouter` (guardrail 5 extended), plus the `apiErrorOf` /
  `errorCodeOf` / `isUnauthenticated` error-classification helpers ported from
  apps/web, which `session.ts`'s `SessionApi` adapter uses to tell "this
  refresh token is no good" apart from every other failure.
- **`app-session.ts`** — the one composition root: wires the real
  `device-secure-store` / `preferences` / tRPC client into a module-level
  `session` singleton, mirroring apps/web's own `anonymous`-client split to
  avoid a `session <-> client` construction cycle. The one file in the spine
  that cannot be unit-tested without a device (§11) — everything above it
  stays Expo-free and injectable.
- **`use-session.ts`** — the `zustand` `useStore` binding screens read
  `session.store` through.

Everything transport- and storage-facing below `app-session.ts` is an injected
port, which is what lets the unit tests (19 across 4 files) exercise token
custody with no Expo runtime and no live server.

### `app/` — the Expo Router shell (§7)

Three gates, exactly as specified, collapsed into layout components since
`expo-router` has no `beforeLoad`:

- **`_layout.tsx`** — the root: one `QueryClient`, `session.restore()` on
  boot, a splash until `status` leaves `'restoring'`.
- **`index.tsx`** — the auth gate's second half: redirect to `/sign-in` or
  `/home`.
- **`(auth)/`** — `sign-in.tsx` (password + inline TOTP challenge, via
  `auth.native.login` / `auth.native.totp.verifyLogin`) and a layout that
  bounces an already-authenticated caller straight to `/home`.
- **`(app)/`** — `_layout.tsx` is the org gate (validate the remembered org
  against `tenancy.orgs.list` before anything renders), `org-picker.tsx`, and
  `home.tsx` — Wave 1's entire signed-in surface: a placeholder that proves
  the spine via `auth.me`, one authenticated read. Real product screens start
  in Wave 2.

**Every Wave 1b item named in §4.4–§4.5 has now shipped CODE — OAuth, device
binding, biometric app-lock, and passkeys all landed in later increments,
see their own sections below. Passkeys is the one exception with an
external blocker**: its ceremony cannot actually complete until real domain
infrastructure exists (a production `WEB_ORIGIN`, a hosted
`apple-app-site-association`/`assetlinks.json`, a real signing certificate)
— see its own section for the full checklist; this was a deliberate,
confirmed scope decision, not a gap. OAuth was never actually Wave 1b (§4.4
only tags passkeys and biometric app-lock that way, and Wave 1's own file
map always listed the oauth-callback route), so it landed as a Wave 1 gap
being closed rather than early 1b work. Device binding and biometric
app-lock both closed a live gap in what Wave 1 already shipped (a portable
stolen token; a found-and-unlocked phone with no local gate) rather than
adding new capability, which is why they were built before passkeys — see
their own sections for the full reasoning.

### The realtime socket client (§5, §8)

`socket.ts` ports `apps/web/src/lib/socket.ts` as a dependency-injected
factory (`createMobileSocket`), matching the DI convention `session.ts` and
`trpc-client.ts` already established, rather than web's module-level
singleton — the handshake, reconnect-and-replay join logic, and reauth
scheduling are unchanged in substance. Wired into `app-session.ts` alongside
`session` and `apiClient`, though no Wave 1 screen calls `joinBoardRoom` yet —
Work is Wave 2.

Building it surfaced a real gap the phase spec never addressed:
`apps/realtime/src/auth.ts` (a `⚠` human-review surface) refuses any
handshake with no `Origin` header, and React Native's `socket.io-client` has
no browser enforcing what it sends — so a byte-for-byte port would compile
and typecheck but fail to connect against the real gateway. The fix is
**not** a fixed "native origin" string in the allowlist — unlike a browser's
Origin, nothing stops any caller from sending that same string, so it would
be security theater rather than a real control. `auth.ts` instead gets one
narrow, explicitly-labeled `isNativeClient` branch that relaxes the origin
check ONLY when `Origin` is completely absent AND the caller presents the
`x-taskflow-client: mobile` marker (relocated to `@taskflow/contracts` so
`apps/mobile`'s HTTP client, its socket client, and `apps/realtime`'s
handshake all read the same constant). The token verification that
immediately follows is what still decides — see that function's own header
for the full argument, and why this was a named INTERIM gap. Device binding
(below) is the thing that was meant to supersede it, though `auth.ts` itself
has not been updated to consult it yet — the socket handshake and the
refresh path are two different surfaces, and closing the socket-handshake
gap for real is left as its own follow-up rather than folded into this
increment silently.

### Build channels and the bundle-secret guardrail (§10)

`eas.json` defines the three build profiles (`development`, `preview`,
`production`). `MOBILE_API_BASE_URL` for `preview`/`production` is left as an
obviously-invalid placeholder rather than a plausible-looking guess — no real
preview/production API exists yet, and a wrong-but-valid URL would fail
silently (a network error, indistinguishable from "realtime is slow") where
an invalid one fails loudly at `parseConfig`'s `z.string().url()`. Replace the
placeholder with the real URL before running an actual preview/production
build.

`scripts/check-mobile-bundle-secrets.mjs` (wired into the fast CI tier and
`pnpm preflight`, not the tiered `secrets` job gitleaks runs in) is an
ALLOWLIST of every key `app.config.ts`'s `extra` object and any `eas.json`
build profile's `env` block may hold — both are places a value becomes
bundle-visible, "readable by anyone who downloads it" per §10. It is
deliberately not a second shape-based secret scanner: gitleaks already does
that repo-wide. What it catches instead is a key with no recognizable secret
shape at all, refused purely because it is not on the list of things this app
is allowed to embed.

### Metro actually bundling the app (§5, §11)

**Every screen in `app/` failed to bundle at all, despite a fully green
`pnpm verify`, until this increment.** This codebase writes every relative
import with a `.js` extension against a `.ts` source file —
`import { session } from '../../src/lib/app-session.js'` — the same
NodeNext-style convention `apps/api`, `apps/web` and every `packages/*` use.
`tsc` and `eslint` both understand that convention; Metro's own resolver does
not unless a `metro.config.js` says so, and this package had none. The
failure mode is exactly the one CLAUDE.md's own history keeps naming across
Phase 4, 6, 7 and 13: a control that reads correctly and passes every
existing check, disproven only by actually running the real thing. Here that
meant running `expo export` for the first time, which is also how the fix
was verified rather than assumed — the bundle failed identically before
`metro.config.js` existed and succeeded (1251 modules, both platforms) after.

`metro.config.js`'s `resolveRequest` override is narrow on purpose: only a
RELATIVE import ending in `.js` gets rewritten to try `.ts`/`.tsx` first,
falling back to Metro's own resolution otherwise — a literal `.js` import (a
third-party package, a real asset) is unaffected.

Also found the same way: `app.config.ts` never set `platforms`, so Expo
defaulted to `['ios', 'android', 'web']` — a `web` target this app has never
had any code for, since `apps/web` already owns that surface. Now explicit:
`platforms: ['ios', 'android']`.

`pnpm --filter @taskflow/mobile build` runs `expo export` to `dist/`
(gitignored — this proves the bundle, it is not a deployable artifact), wired
into the fast CI tier and `pnpm preflight` as its own step, deliberately
separate from `pnpm verify` — the same reasoning `check-encoding.mjs` and
`check-mobile-bundle-secrets.mjs` are their own steps rather than folded in.

### Shared packages: `@taskflow/client` and `@taskflow/tokens` (§12 decisions 3, 4)

`@taskflow/client` — `Wire<T>`, the retry policy and `QueryClient` defaults
(`app/_layout.tsx`'s `createQueryClient` call), and the optimistic-mutation
contract — extracted from `apps/web`, taking error classifiers and a
failure-surfacing callback as parameters instead of importing either app's
own trpc-client/toast shape. `apps/web`'s original `query.ts` was NOT the
"pure... reused as-is" file the spec's §5 table first claimed; its `keys`
registry and `NOT_A_MEMBER` recovery flow stayed there, coupled to that
app's session store.

`@taskflow/tokens` — the Phase 6.5 color ramp (plus radius and motion), as
values rather than as NativeWind's className syntax: NativeWind's only
stable release targets Tailwind v3, `apps/web` runs v4, and the version that
doesn't have that gap is still a pre-release. Every color is the `oklch(...)`
triple `apps/web/src/styles.css` defines PLUS a derived sRGB `hex` (React
Native's `StyleSheet` has no `oklch()` parser), verified via
`@csstools/color-helpers` rather than hand-converted. Wired into every Wave 1
screen for real, not left as an unused dependency — `home.tsx`, `sign-in.tsx`,
`org-picker.tsx` and both `_layout.tsx` splash/loading states all use it, and
`pnpm --filter @taskflow/mobile build` bundles clean with it in the graph.

### Guardrails (§6)

`packages/config/eslint/security.js` scopes the client import-bans to
`apps/mobile/**`, re-emits them on the credential seam (now three files:
`session.ts`, `secure-store.ts`, `device-secure-store.ts`) plus the
unencrypted-storage ban, and — new this increment — on `app/(auth)/**` plus a
`react-native-webview` ban (§6.2: OAuth must go through the system browser,
never an embedded WebView). `packages/guardrail-selftest/verify.js` asserts
all three overlapping scopes on the COMPUTED config, the same flat-config
replace-trap check apps/web's own assertion runs.

### Native auth path (§4.3, on the API) — ⚠ human-review surface

`apps/api/src/identity/session-response.ts`'s `NativeSessionResponse` is a
separate `.strict()` schema from the browser's `SessionResponse` — the
refresh token travels in the body only here, never in a cookie, and the two
schemas cannot cross. `auth.native.{login,refresh,logout}` and
`auth.native.totp.verifyLogin` are the routes this app's `apiClient` and
`app-session.ts`'s anonymous client call.

**Channel binding** (migration 0080, `identity.sessions.channel`) is the
defence-in-depth on top: `refresh()` refuses a token presented on the wrong
channel BEFORE the reuse/rotation check, so a wrong-channel probe cannot
trigger family-wide revocation — proved against real Postgres in
`channel-binding.test.ts`.

### Native OAuth (§4.4, ai/phase-14-mobile.md §12 decision 6)

`src/lib/oauth.ts` plus additions to `sign-in.tsx`. Uses `expo-web-browser`'s
`openAuthSessionAsync`, not `expo-auth-session` — the lighter primitive it
wraps, and enough on its own since PKCE is minted and signed into `state`
server-side (`auth.native.oauth.start`), never on the device. There is no
`(auth)/oauth-callback` route: `openAuthSessionAsync`'s native module
intercepts the provider's redirect to `taskflow://oauth-callback` directly
and resolves its promise before expo-router's own deep-link handling would
ever see the URL.

Server-side, `apps/api/src/identity/oauth.service.ts`'s `OAuthDeps` gained a
SEPARATE `nativeProviders` credential map, never the browser `providers` map
reused: Google's native client is a distinct, secret-less "installed
application" registration (a "Web application" client cannot use a
custom-scheme redirect at all), and GitHub's is a second, dedicated OAuth App
whose one callback URL is the native deep link. See `.env.example`'s
`GOOGLE_NATIVE_CLIENT_ID`/`GITHUB_NATIVE_CLIENT_ID`/
`GITHUB_NATIVE_CLIENT_SECRET` for what to register and where.

### Device binding (§4.5) — ⚠ human-review surface, and ⚠ UNVERIFIED native code

The compensating control for the one property native genuinely lost by not
having httpOnly cookies (§4.2): each device generates its own P-256 keypair
in the secure enclave (iOS) / StrongBox-or-TEE (Android) at first sign-in,
whose private half never leaves that hardware — not even to this app's own
JS. Once a session's key is bound, `identity.refresh()` (server-side)
requires a signature over the presented refresh token from that key, so a
copied token is inert off the device that minted it.

`src/lib/device-key.ts` is the port (mirroring `secure-store.ts`'s split from
`device-secure-store.ts`), `device-key.native.ts` its real implementation,
backed by a new LOCAL Expo Module at `modules/device-key/` — Swift for
`SecKeyCreateRandomKey`/`kSecAttrTokenIDSecureEnclave`, Kotlin for
`KeyGenParameterSpec`/`setIsStrongBoxBacked`. `session.ts`'s `adopt()` is the
one chokepoint all three native sign-in paths (password, TOTP, OAuth) funnel
through, so it is the one place that registers a device's key against a
freshly minted session (`auth.native.deviceKey.register`, a dedicated
`selfRoute` that reads `sessionId` off the caller's own access token rather
than a new field threaded through every login-completing route); `refresh()`
signs the token being redeemed whenever a local key exists at all, whether
or not that particular session ever completed registration — a signature
the server did not ask for is simply ignored. Both are best-effort: neither
a failed registration nor a failed signature blocks a login or a refresh a
legacy/unbound session never needed.

**Nothing in `modules/device-key/ios` or `modules/device-key/android` has
ever been compiled in this environment.** There is no Swift or Kotlin
toolchain here — `tsc`, ESLint, Vitest and Metro's own bundle check all stop
at the TypeScript boundary (`modules/device-key/index.ts`), and the first
real compile signal either native file gets is the next `expo prebuild` /
EAS development build that includes this module. Each native file's own
header names the specific things most worth checking first against a real
build (the DER signature format, the raw P-256 point encoding, the
StrongBox API-level guard) — read those before assuming a build failure
there is unrelated to this increment. Everything ABOVE the native module —
the server-side verification, the schema, the session orchestration — is
proved by real tests against real Postgres and real P-256 signatures
(`apps/api/src/identity/device-binding.test.ts`,
`packages/security/src/device-binding.test.ts`, `session.test.ts`'s "device
binding" suite); only the native signing itself is unverified.

**A real run found a bug the tests above could not: importing this module
used to be able to brick the entire app, not just device binding.**
`modules/device-key/index.ts` called `requireNativeModule('DeviceKey')` at
module TOP LEVEL — which throws whenever the native module isn't linked
(any Expo Go install, per §4.4/above, and any development build built
before this increment). `app-session.ts` — the composition root every route
transitively imports — constructs `device-key.native.ts`'s port into a
module-level singleton at import time, so that throw happened before
`session.ts`'s already-correct `try`/`catch` around every
`deviceKey.ensurePublicKey()`/`.sign()` call ever got a chance to run: it
poisoned Metro's whole module graph before `expo-router` rendered a single
screen, surfacing as `[Error: Cannot find native module 'DeviceKey']`
immediately followed by EVERY route warning "missing the required default
export" — the failure attributed itself to the whole app, not to the one
feature it belonged to. Fixed by resolving the native module lazily, on
first actual use (`getNative()`, memoized) rather than on import, so a
missing module is only ever observed at the two call sites that already
handle it as best-effort. Confirmed against a real `expo export`
(1291/1421 modules, both platforms) and the full Vitest suite; the fix
itself could not get a unit test — importing `expo-modules-core` pulls in
React Native's Flow-typed source, which is exactly the same reason
`device-key.native.ts`'s own header gives for keeping this module split
from the pure `device-key.ts` port in the first place.

### Biometric app-lock (§4.4)

"A LOCAL gate, not a second server factor — it never replaces `can()` or the
token," per the spec's own words, and that is the whole design: nothing here
talks to the server, and nothing lives inside `session.ts`'s token-exchange
logic. Gating the refresh EXCHANGE itself would prompt Face ID on every
ordinary mid-session access-token renewal (every ~15 minutes); "gates
reading the stored refresh token after a cold start" means once, at launch,
not on every use.

`src/lib/biometric-gate.ts` / `.native.ts` are a third instance of the same
DI split as `secure-store.ts`/`device-secure-store.ts` and
`device-key.ts`/`device-key.native.ts`, wrapping `expo-local-authentication`
— Expo's own OFFICIAL SDK package, unlike device binding's custom native
module, so this one carries none of that section's compile-risk caveat.
`session.ts` gained exactly one new read-only method,
`hasStoredCredential()`, so the gate can tell "nothing to protect" apart
from "something to protect" before ever prompting — a first-time,
never-signed-in launch never sees Face ID.

The gate itself lives in `app/_layout.tsx`, ABOVE `session.restore()`: on
boot, if a credential is stored AND the device has biometrics (or a
passcode) enrolled, the root layout renders a lock screen and auto-attempts
the platform ceremony once before `restore()` is ever called. Cancelling or
failing it leaves the stored token untouched and the app locked, with a
retry button — never a fallback to the sign-in form, which would wrongly
suggest the credential was lost. `app.config.ts`'s `expo-local-authentication`
plugin entry sets `NSFaceIDUsageDescription`, which iOS requires present
before the Face ID ceremony will even start.

### Passkeys (§4.4) — code complete, infrastructure NOT

The last Wave 1b item, and a different kind of "not here yet" from
everything above it: the code is real and tested, but the ceremony
structurally cannot complete until real domain infrastructure exists —
this was a deliberate scope decision (asked and confirmed), not an
oversight.

**Server**: `passkey.service.ts`'s `finishAuthentication` gained the same
`channel` parameter every other session-minting function already has,
threaded to `issueSession`. `auth.native.passkeys.finishAuthentication` is
the one new route — `startAuthentication` and enrollment
(`startRegistration`/`finishRegistration`) needed no native counterpart at
all: the first mints ceremony options with no session and nothing
channel-specific, and enrollment is already `selfRoute`, bearer-token
authenticated identically on both channels. Proven against real Postgres
and a real ES256-signing virtual authenticator in
`passkey.service.test.ts`'s "native sign-in" suite — the ceremony
verification itself was already covered; what this increment added is only
the channel binding on top of it.

**Client**: `react-native-passkeys` — a thin wrapper over
`ASAuthorizationController` (iOS) / `CredentialManager` (Android) that
implements no WebAuthn cryptography of its own, unlike device binding's
custom native module. Chosen over writing one: passkeys' ceremony format
(CBOR attestation objects, COSE keys, client data JSON) is real complexity
this library has four years of history getting right, where device
binding's task was simple enough (generate a key, sign a message) to keep
in-house instead. `src/lib/passkeys.ts` holds the one piece of real logic —
`toRegistrationResponse` strips the library's `getPublicKey()` convenience
method before the result reaches the server's `.strict()` Zod schema — and
is tested with no native module in its graph, mirroring `oauth.ts`'s own
"thin native calls belong in the screen" precedent rather than the
device-key/biometric-gate DI-port split: there is no orchestration state
here worth hiding behind a seam.

Sign-in lives in `(auth)/sign-in.tsx` (a "Sign in with a passkey" button,
shown only when `isSupported()`); enrollment lives on `(app)/home.tsx` (an
"Add a passkey to this device" action) rather than a proper settings
screen, because **neither web nor mobile had ever shipped passkey
enrollment before this increment** — only the server ceremony existed
(CLAUDE.md's own Phase 3 note: the web browser ceremony is still deferred).
Without enrollment somewhere reachable, the sign-in button would have
nothing any real user could ever use it with.

**What is actually missing, and why nothing here can close it:**

- **iOS**: an `apple-app-site-association` file hosted at
  `https://<production-domain>/.well-known/apple-app-site-association`,
  naming this app's Apple team id and bundle id, PLUS an Apple Developer
  Program associated-domains entitlement. `app.config.ts`'s
  `ios.associatedDomains` carries an obviously-invalid placeholder
  (`webcredentials:SET-REAL-DOMAIN-BEFORE-PASSKEYS-WORK.invalid`) for the
  same reason `eas.json`'s `MOBILE_API_BASE_URL` does: a plausible-looking
  wrong domain would fail silently (the ceremony just never completes,
  indistinguishable from "not configured"); this fails loudly instead.
- **Android**: an `assetlinks.json` at
  `https://<production-domain>/.well-known/assetlinks.json`, containing the
  SHA-256 fingerprint of the app's REAL signing certificate (not the
  ad-hoc key EAS development builds use) and, for credentials to work
  seamlessly between the web app and this one, a
  `delegate_permission/common.get_login_creds` relation. No in-app config
  field carries this — Android's OS fetches it from the domain directly at
  ceremony time.
- **The relying party ID itself**: both files above must name the EXACT
  same domain `WEB_ORIGIN` resolves to server-side
  (`relyingPartyFrom(WEB_ORIGIN, ...)` in `server.ts`) — there is no
  production `WEB_ORIGIN` decided yet either, so this is blocked one level
  up from passkeys specifically.

None of this can be created from a development sandbox: it needs a real
owned domain, an Apple Developer Program account, and a real Android
signing certificate, none of which exist yet for this project. The code
above is what to come back to once they do — nothing here needs
rewriting, only deploying to.

## Wave 2 (Work) — started: "My Tasks"

Every Wave 1b item is done; Wave 2's roadmap row (`ai/phase-14-mobile.md`)
names it plainly: "Work — boards, lists, cards, My Tasks, card detail; the
TipTap-JSON native renderer (§6.4); optimistic mutations." `(app)/home.tsx`
is the first slice — deliberately the SMALLEST useful cut, not an attempt
at the whole row.

**What shipped**: a flat, read-only list of the caller's own cards across
every board they can reach (`work.cards.mine`), replacing Wave 1's
placeholder "you're signed in" card. Ported from
`apps/web/src/features/work/home-page.tsx` + `list-view.tsx` — reference,
title, priority badge, a due-date badge (overdue in red), a checklist
badge (green once complete), and a comment count. `src/lib/work.ts` holds
the portable logic (`formatDueDate`, the priority label/color maps) kept
in step with web's own `format.ts`/`priority-colors.ts` rather than
reimplemented independently, so a due date does not read "overdue" on one
platform and "on time" on the other for the identical card.

**What this slice deliberately does NOT have, and why:**

- **Status.** Not an oversight — `home-page.tsx` doesn't show it either.
  Status definitions are per-PROJECT (Phase 3.5); "My Tasks" spans many
  projects at once, and nothing in this codebase has ever needed to
  batch-resolve status names/colors across projects for one screen.
  Priority has no such problem (a fixed four-value enum), so it renders
  here for free.
- **Avatars / assignee names.** Web's `AvatarStack` needs a members lookup
  and image loading neither of which exist on mobile yet.
- **Boards, the kanban view, drag-and-drop, card creation.** All of
  `list-view.tsx`'s own reasoning applies doubly here: no drag-and-drop and
  no inline create because both need a LIST to write into, and this is a
  reshaping of cards that live elsewhere, not a place new ones are made.
- **Card detail / tapping a card.** Needs the TipTap-JSON native renderer
  (§6.4) to show a card's description at all — real, separate work, not
  something to fold into a list screen.
- **Optimistic mutations.** This screen has no mutations — it is a pure
  `useQuery` read, same as web's own My Tasks.

`CardSummary` is derived from the live client's own inferred type
(`Wire<Awaited<ReturnType<MobileTRPCClient['work']['cards']['mine']
['query']>>>[number]`) — the same `Awaited<ReturnType<typeof api.<route>.
query>>` convention `apps/web/src/features/work/api.ts` uses for its own
`CardSummary`, never hand-declared, so a field the server adds, removes,
or renames is a compile error here rather than a silent drift.

## Not here yet

- **Running this on a simulator or physical device.** The app now bundles
  (`pnpm --filter @taskflow/mobile build`), which is real signal `expo-doctor`
  and `tsc` alone could not give — but nothing has rendered a screen or made a
  live request yet. `pnpm --filter @taskflow/mobile start` plus a real API
  reachable at `MOBILE_API_BASE_URL` (see `.env.example`) is the next step,
  before any further product screens. In particular, `isNativeClient`'s own
  header names what a real-device run would need to confirm about `Origin` on
  RN's WebSocket transport — see `apps/realtime/src/auth.ts`.

  **The public Expo Go app cannot open this project on SDK 57 today.** Expo
  Go's per-SDK build has a review-queue lag behind each SDK release, and the
  version on the app/Play Store trails this project's `~57.0.15` pin — it
  reports "requires a newer version of Expo Go" with no fix on the Expo Go
  side alone. Since the OAuth increment above needs a real `taskflow://`
  deep-link handler anyway (Expo Go owns `exp://`, not the app's own scheme,
  so it can never resolve an OAuth redirect even once SDK-current), a
  development build is the one path that unblocks both:
  `npx eas-cli build --profile development --platform android` (or `ios`;
  `eas.json`'s `development` profile already sets `developmentClient: true`),
  install the resulting build on-device, then
  `pnpm --filter @taskflow/mobile start --dev-client` and open with that app
  instead of Expo Go. `app.config.ts`'s `extra.eas.projectId`/`owner`/
  `updates`/`runtimeVersion` are what a dynamic config needs set by hand for
  `eas build` to run at all — `eas init`/`eas update:configure` cannot write
  into a `.ts` config automatically the way they can a static `app.json`, and
  each said so explicitly rather than silently doing nothing.

  **Getting past that point is the first time device binding's native module
  (above) can be exercised at all.** Confirming it actually works — a real
  key generates, a real signature verifies server-side, a stolen token is
  genuinely refused — is unverified until someone runs this on-device; see
  that section's own header for what to check first if it does not.

- **Confirming the biometric gate actually works on-device.** Like device
  binding, `expo-local-authentication`'s ceremony is real-device-only — a
  simulator can fake success but proves nothing about a genuine Face ID or
  fingerprint prompt, and `NSFaceIDUsageDescription` only gets exercised by
  Apple's own review once a real build ships.
- **Passkeys actually working at all.** Not a verification gap like the two
  above — a structural one. The ceremony cannot complete without a real
  production domain, hosted `apple-app-site-association`/`assetlinks.json`
  files, and a real Android signing certificate, none of which exist yet.
  See that section's own checklist for exactly what to stand up first.
- The rest of Work (boards, the kanban view, card detail, the TipTap-JSON
  native renderer, optimistic mutations) and the other product waves (Chat,
  Docs, RTC) — the socket client exists but nothing calls `joinBoardRoom`
  yet, and "My Tasks" (above) is Work's first slice, not its whole row.
