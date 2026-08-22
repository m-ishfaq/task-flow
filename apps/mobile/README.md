# @taskflow/mobile

The Android & iOS app (Expo / React Native). Full plan: [ai/phase-14-mobile.md](../../ai/phase-14-mobile.md).

## Status — Wave 1 complete, Wave 1b complete (passkeys infra-blocked), Wave 2 (Work) complete, Wave 3 (Chat + push) complete and now at full web parity, Account parity complete, Sprints complete — Work now at full parity with web: My Tasks, Boards, and all six card-detail sections (status/assignees/labels/checklists/custom fields/attachments/comment edit-delete-replies)

Wave 1's acceptance bar (§7: the three gates and one authenticated tRPC
read, on a real device, against the real API) has everything CI can prove
behind it, plus a real Metro bundle (`pnpm --filter @taskflow/mobile build`)
for both platforms. **This has now actually run on a real development
build, not just typechecked and bundled** — and that live run is what found
the biggest gap so far: two flat screens (`home.tsx`, `card/[cardId].tsx`)
with no surrounding navigation shell, and a sign-in screen with no way to
create an account or recover a password. Both are fixed — see "The
navigation shell, and the auth screens that were missing" below — which is
exactly the standing lesson this file keeps re-learning: a green
`pnpm verify` is not the same claim as "this works when you click it"
(§11), and the gaps that survive it are never the ones a diff review would
catch. Keychain, biometrics, push and WebRTC stay device-only no matter how
green this gets.

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
  `auth.native.login` / `auth.native.totp.verifyLogin`, plus OAuth and
  passkeys), `register.tsx` and `forgot-password.tsx` (§"The navigation
  shell" below), and a layout that bounces an already-authenticated caller
  straight to `/home`.
- **`(app)/`** — `_layout.tsx` is the org gate (validate the remembered org
  against `tenancy.orgs.list` before anything renders); `(tabs)/` is the tab
  bar (`home.tsx` — "My Tasks" — and `account.tsx`); `card/[cardId].tsx` is
  a sibling of `(tabs)/`, pushed over it rather than rendered inside it.
- **`org-picker.tsx`** — deliberately at the app ROOT, a sibling of `(app)/`
  and `(auth)/` rather than nested inside `(app)/`. It started out nested
  there, and a real run found the bug that placement caused: `(app)/_layout.tsx`
  wraps every route inside it, so landing on `/org-picker` while still
  governed by that SAME layout's `orgId === null` redirect re-fired the
  identical redirect on every render — "Maximum update depth exceeded",
  forever. Matches `apps/web/src/router.tsx`'s `/orgs` route, which takes
  `requireSession` (auth only) rather than `requireOrg` for the identical
  reason: the picker is the escape hatch FROM the org gate, so it cannot
  also be a route the gate still governs.

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

**A duplicate `@tanstack/react-query` instance — a bundle-succeeds,
runtime-only bug `expo export` cannot catch, only a real device run can.**
Opening a card threw `[Error: No QueryClient set, use QueryClientProvider
to set one]` from inside `@taskflow/client`'s `useOptimistic`
(`packages/client/src/optimistic.ts`), despite `app/_layout.tsx` genuinely
wrapping the whole tree in `QueryClientProvider`. Root cause, confirmed by
`readlink -f` on each package's own `node_modules/@tanstack/react-query`
rather than assumed: this app pins `react` to an EXACT version (`19.2.3`,
Expo SDK 57's own requirement), `packages/client`'s `package.json`
separately devDependency-pins a newer `react` range for ITS OWN test suite,
and because `@tanstack/react-query` has a peer dependency on `react`, pnpm
resolved that difference into two PHYSICALLY SEPARATE copies of
`@tanstack/react-query` in the store. Metro resolves a bare specifier
starting from the nearest `node_modules` above the IMPORTING FILE, not from
the app root — so `optimistic.ts`, physically inside `packages/client/`,
got the copy resolved against that package's own `react`, while
`app/_layout.tsx` got the copy resolved against THIS app's `react`. Two
module instances means two distinct `React.createContext()` objects for
`QueryClientContext`; the Provider from one is invisible to
`useQueryClient()` from the other — which is what the error message means
even though a provider is genuinely mounted.

`resolver.extraNodeModules` was the first fix tried and does NOT work here:
Expo's default config sets `unstable_enablePackageExports: true`, and both
packages ship a `package.json` `exports` map, so Metro resolves them
through that mechanism, which never consults `extraNodeModules` at all —
confirmed, not assumed, by rebuilding with `expo export --source-maps` and
grepping the emitted map's `sources` for both pnpm variant directories;
both were still present after the extraNodeModules attempt. The fix that
actually works, in `metro.config.js`: intercept the two specifiers before
Metro's own resolution strategy runs at all, and call Metro's real resolver
(`context.resolveRequest`) with `originModulePath` rewritten to a fixed
file inside this app — which forces whichever strategy Metro picks
(package-exports or the legacy walk) to start from this app's own
`node_modules` regardless of which package's file contained the `import`.
Re-verified the same way: the rebuilt sourcemap contains exactly one
`@tanstack+react-query@…` directory, on both platforms. Scoped to just
`react` and `@tanstack/react-query` — the two actually observed to split —
rather than forcing every shared dependency through this app's copy, which
would be a broader, unverified change for a problem that has not actually
appeared elsewhere. `apps/web`'s separate Vite build is untouched by this
file entirely.

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
module, so this one carries none of that section's NATIVE-COMPILE-risk
caveat. _(It turned out to carry the sibling LINK-time risk in full — see
the correction directly below; "official package" only ruled out one of the
two failure modes.)_ `session.ts` gained exactly one new read-only method,
`hasStoredCredential()`, so the gate can tell "nothing to protect" apart
from "something to protect" before ever prompting — a first-time,
never-signed-in launch never sees Face ID.

**A second real run found the same bug class as device binding, in an
"official package" this section had assumed was exempt.**
`expo-local-authentication`'s own `ExpoLocalAuthentication.js` resolves its
native module at ITS OWN top level — a plain
`requireNativeModule('ExpoLocalAuthentication')` outside any function,
inside code this repo doesn't own or control. `biometric-gate.native.ts`
used to `import * as LocalAuthentication from 'expo-local-authentication'`
at ITS top level too, and `app-session.ts` builds `createBiometricGate()`
into a module-level singleton that `app/_layout.tsx` imports statically,
above `session.restore()` (by design, per this section's own text above) —
so the moment `device-key`'s eager-import bug was fixed, the very next
`npx expo start` against the same not-yet-relinked development build hit
`[Error: Cannot find native module 'ExpoLocalAuthentication']`, with the
identical every-route "missing the required default export" cascade.
Fixed the same way — the package is now loaded with a dynamic `import()`
inside `isAvailable()`/`authenticate()` rather than a static top-level one
— and both call sites now catch a failed load explicitly, which
`isAvailable()` didn't do before either: it folds straight into "nothing
enrolled" and `authenticate()` into the "resolve `false`, never throw"
contract this section already documents below. The general lesson,
worth carrying into any FUTURE native module this app adds: "official Expo
package" answers whether the NATIVE CODE is trustworthy, not whether
importing it is safe to do eagerly from a module every route depends on —
that second question is about where in the import graph the module sits,
and is the same question for a first-party module as a custom one.

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

## Wave 2 (Work) — started: "My Tasks", then card detail + the TipTap-JSON renderer

Every Wave 1b item is done; Wave 2's roadmap row (`ai/phase-14-mobile.md`)
names it plainly: "Work — boards, lists, cards, My Tasks, card detail; the
TipTap-JSON native renderer (§6.4); optimistic mutations." `(app)/home.tsx`
is the first slice — deliberately the SMALLEST useful cut, not an attempt
at the whole row. `(app)/card/[cardId].tsx` plus `src/lib/rich-text.ts` /
`rich-text-view.tsx` are the second: tapping a card now goes somewhere.

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
- **Optimistic mutations.** This screen has no mutations — it is a pure
  `useQuery` read, same as web's own My Tasks.

`CardSummary` is derived from the live client's own inferred type
(`Wire<Awaited<ReturnType<MobileTRPCClient['work']['cards']['mine']
['query']>>>[number]`) — the same `Awaited<ReturnType<typeof api.<route>.
query>>` convention `apps/web/src/features/work/api.ts` uses for its own
`CardSummary`, never hand-declared, so a field the server adds, removes,
or renames is a compile error here rather than a silent drift.

### Card detail + the TipTap-JSON native renderer (§6.4)

Tapping a card in "My Tasks" now navigates to `(app)/card/[cardId].tsx` —
read-only, backed by `work.cards.get`. Title, reference, priority/due-date/
checklist/comment-count badges (the same row "My Tasks" already renders),
and the card's description, rendered by a genuinely new native TipTap-JSON
renderer rather than anything borrowed from web (ProseMirror needs a DOM;
web's own read-only rendering is the real editor mounted `editable={false}`,
which has no native equivalent).

**The renderer is a security control, not just a UI feature** — §6.4 says so
directly: "rich text is rendered by a closed switch over the node/mark
whitelist, never by feeding a string to any HTML/Markdown-to-native library
that could execute an attribute." It is split into two files for exactly the
reason `session.ts`'s DI-port files are split from their native
implementations — one half worth testing in isolation, one half that is not:

- **`src/lib/rich-text.ts`** — `sanitizeRichText(input: unknown)`, a pure
  function with no React import, walking the untrusted `description` field
  into a `SanitizedNode` tree. It imports `NODE_ATTRIBUTES`, `NODE_TYPES`,
  `MarkSchema`, `MAX_DEPTH` and `MAX_NODES` from `@taskflow/api/richtext` —
  now a real (not dev-only) dependency — rather than restating the
  whitelist, the same reason `apps/collab/src/content-guard.ts` and
  `apps/api/src/docs/render.ts` both import it instead of copying it. An
  unrecognized node type, or a known type with attributes that fail its own
  schema, is DROPPED (not attr-stripped) — `render.ts`'s own header makes
  this exact call for the identical read-only case: there is no editor
  around afterward to notice and fix a half-broken `mention`. A `link` mark
  whose `href` fails `MarkSchema`'s scheme check is dropped from that text
  run's marks — the text still renders, just not as a clickable link — which
  is where "never touches an HTML parser" actually pays off: there is no
  string concatenation of a URL into anything a WebView or a Markdown
  renderer could later interpret. Depth and node-count are re-bounded during
  the walk (mirroring `richtext.ts`'s own `measure()` doing the same thing
  iteratively) because a phone's JS stack is much smaller than the server's,
  and this is a second, independent walk of data the client does not itself
  control. `rich-text.test.ts` (11 cases) asserts all of this directly,
  including the two that matter most: a `javascript:` link is stripped while
  its text survives, and a document nested far past `MAX_DEPTH` sanitizes
  without a stack overflow.
- **`src/lib/rich-text-view.tsx`** — `RichTextView`, the pure `switch` on
  `SanitizedNode['type']` into RN elements §6.4 asks for. It does no
  validation of its own — everything reaching it already passed
  `sanitizeRichText` — which is what keeps it untested: there is nothing
  left to assert once the security-relevant half already has full coverage,
  the same "test the logic, not the JSX" split this codebase already
  applies to `biometric-gate.ts` vs. its screens.

`work.ts` gained `CardDetail`, derived from `work.cards.get`'s own inferred
type exactly the way `CardSummary` is derived from `.mine` — never
hand-declared.

**What this slice still deliberately does NOT have:** editing — that landed
next, see "Editing: title and priority" below — the comment list and
composer (only the count renders; `work.comments.list` has no mobile caller
yet), checklist items (only the done/total count; no per-item read or
toggle), and boards/kanban (still Work's whole remaining row).

## The navigation shell, and the auth screens that were missing

Found by the first real device run against this build, not by spec review:
Wave 1 and Wave 2 had each shipped one flat screen (`home.tsx`, then
`card/[cardId].tsx`) with no surrounding frame — no way to reach the org
picker except the forced redirect on first sign-in, nothing but an inline
"Sign out" button, and a sign-in screen with no path to creating an account
or recovering a password. `apps/web` has had all of this since Phase 1/3;
nothing on native ever built the equivalent. This closes both gaps.

**A bottom tab bar, not a sidebar drawer.** `apps/web`'s `Sidebar` is a
desktop-shaped pattern — a persistent rail beside the content, which has no
native equivalent on a phone-width screen. `(app)/(tabs)/_layout.tsx` uses
`expo-router`'s `Tabs`, which renders the platform's own primary-nav idiom
(iOS's tab bar, Android's bottom navigation) rather than a hand-built
approximation. Two tabs today, matching what actually exists: **My Tasks**
(`home.tsx`, moved from directly under `(app)/`) and **Account**
(`account.tsx`, new). Chat/Docs/People join this bar as their own waves
ship real screens — the same way web's sidebar grew its nav rail one item
per phase, not all at once. Text-only labels, no icon set: nothing else in
this app uses one yet, and adding an icon library was not a call worth
making inside this fix.

**`card/[cardId].tsx` stays a sibling of `(tabs)/`, not nested inside it.**
`(app)/_layout.tsx` renders a `<Stack>` (see "A real `<Stack>`, not `<Slot
/>`" below — this was originally a bare `<Slot />`, found broken by a real
device run), so pushing to a card opens on top of the tab view as its own
stack entry rather than replacing it — the correct native pattern for a
detail screen; a phone does not want a tab bar competing with a card's own
"← Back" for space.

**`account.tsx` is where `apps/web`'s sidebar footer's two jobs went**:
`OrgSwitcher` (which org, and a way to leave it) and the account dropdown
(sign out). "Switch organization" pushes `/org-picker` — the SAME screen
`(app)/_layout.tsx`'s gate already redirects to when no valid org is
remembered, now also reachable on demand; nothing about that screen needed
to change to be reachable voluntarily as well as by force, since it already
handles "no memberships" and already calls `session.selectOrg` +
`router.replace('/home')` on pick. Passkey enrollment also moved here from
`home.tsx`'s old footer, matching where it lives on web (`AccountPage`, not
the My Tasks-equivalent page). **What this screen deliberately does NOT
have**, matching web's much larger `account-page.tsx` (656 lines: profile
editing, connected accounts, TOTP, device/session inventory, DSAR export):
none of that. This is the smallest useful cut — see the current org, leave
it, manage a passkey, sign out. A fuller account screen is real, separate
work.

**`register.tsx` and `forgot-password.tsx`** are the native counterparts of
web's `RegisterPage`/`ForgotPasswordPage`, reachable from new links on
`sign-in.tsx`. `auth.register` and `auth.requestPasswordReset` are
unchanged from browser to native — neither takes or returns a session, so
neither needed a `native.` sibling the way `auth.login` did. Both render a
"check your email" state on success, with the same confirmation wording
regardless of whether the address exists — an account-existence oracle
needs no password guesses at all. **There is deliberately no
`reset-password.tsx`** to receive the emailed link: `packages/mail`'s
templates build that link against the WEB app's own base URL, not a
`taskflow://` deep link, so it always opens in a browser regardless of
which surface the request came from — the same universal-link
infrastructure gap passkeys' own section documents, sidestepped here
because nothing on this path actually needs it. `sign-in.tsx` also gained
the `EMAIL_NOT_VERIFIED` recovery web's `LoginPage` already has — a
"Resend verification email" button — ported with one small difference:
it reads the live `email` field rather than web's `signIn.variables?.email`,
since this screen's `signIn` mutation takes no argument to capture one from.

## Editing: title and priority, and Wave 2's "optimistic mutations" roadmap item

Card detail stopped being read-only. `src/lib/card-patch.ts` and
`src/lib/use-update-card.ts` port `apps/web/src/features/work/
use-update-card.ts` — read that file's own header before touching either:
`work.cards.update` is a FULL REPLACE, and the entire point of this pair of
files is that a caller can only express "change these fields", never
express "clear the ones it could not see" by accident.

**Split into two files for one reason: Vitest cannot parse `react-native`'s
Flow-typed source.** `mergePatch`/`asRichText` — the actual "loaded gun"
logic (`'key' in patch`, touched-possibly-to-null, versus the key being
absent, untouched — `??` alone gets this backwards) — live in
`card-patch.ts`, which imports nothing but `type CardDetail`/`type
Priority` from `work.ts`. `use-update-card.ts` is the thin hook wrapping it
in `useMutation` + `@taskflow/client`'s shared `useOptimistic`, and it
imports `apiClient` from `app-session.ts` — which pulls in `react-native`
itself. The first attempt at a test file imported straight from
`use-update-card.ts` and failed with `RolldownError: Parse failure: Flow is
not supported` inside `react-native/index.js` — Vitest's plain transform
has no Metro/Babel step to strip Flow syntax, so anything reachable from
`apiClient` poisons a test file's whole module graph the moment it is
imported, even for logic that itself touches no native API. This is the
same "Expo-free and Vitest-safe" boundary `work.ts`'s own header already
draws and the same shape as the `rich-text.ts` (pure) / `rich-text-view.tsx`
(native-consuming) split — now a proven pattern, not a one-off.
`card-patch.test.ts` (8 cases) is what that split buys: `mergePatch` tested
directly, no `QueryClient`, no network, no native runtime.

**`useOptimistic` came from `@taskflow/client`, already built for this.**
Not ported, not reimplemented — `packages/client/src/optimistic.ts`'s own
header already named `apps/mobile` as a consumer (`ai/phase-14-mobile.md
§5, §12 decision 4`) before this increment existed to prove it. The one
real adaptation: web also optimistically patches `cardsOfBoard`, because a
board's tiles are visible WHILE its detail panel is open — two copies of
one card on screen at once. Mobile has no board view yet, so there is only
ever one visible copy of a card being edited — the detail screen itself —
so `useUpdateCard` patches only `cardQueryKey(cardId)` and separately
invalidates `MY_TASKS_QUERY_KEY` on settle (a plain `onSettled` override,
same as web's own — an object spread does not compose two handlers of the
same name, the later one wins), so a title/priority change is already
there when the user navigates back to "My Tasks" rather than waiting on
that list's own staleness window.

**Title and priority only — not description, dates, or anything else.**
Title gets local state, an explicit "Save" button, dirty-tracked
(`card/[cardId].tsx`'s `TitleField`) — mirroring web's `TitleAndDescription`
minus the description half, because there is no native rich text EDITOR
yet, only `rich-text-view.tsx`'s read-only renderer; a description field
here would have nowhere real to write back to. Priority fires immediately
on tap, no separate save — mirroring web's `<select onChange>`, since a
discrete choice already IS a complete edit, unlike continuous typing. Due
date and start date are not editable either: no date-picker dependency has
been added yet, the same kind of call `_layout.tsx`'s tab bar already made
for icons — a dependency decision this increment did not need to force.

## Wave 2 complete: boards, and comments — plus Wave 3 started: Chat

Shipped together, deliberately batched rather than pushed one screen at a
time: the backend for all three has been done since earlier phases, and
splitting a batch this size into single-screen pushes would have meant
more round trips of "push, wait for a device test, push again" without
changing what actually needed verifying at each step — the same
typecheck/lint/test/bundle-build/guardrail pass either way. Small,
single-purpose increments are still the right default (see this file's own
running history above); this batch is the exception, made deliberately,
not the new normal.

### Boards — Wave 2's remaining item

Three screens complete Work's navigation: `(tabs)/boards.tsx` (every
project, mirroring `apps/web/src/features/work/projects-page.tsx`'s own top
level) → `project/[projectId].tsx` (that project's boards — not skipped
even for a single board; this app does not special-case the count) →
`board/[boardId].tsx` (one board). A new fourth tab, alongside My Tasks,
Chat and Account.

**Vertically stacked list sections, not `apps/web`'s horizontal kanban
columns.** A phone's width cannot fit two columns side by side at a
readable card size, and a horizontally scrolling board on top of a
vertically scrolling screen is the "two scroll directions fighting each
other" pattern mobile UI guidance warns against — so the board reflows
into one vertical scroll, list name + card count as a section header,
cards stacked underneath.

**`work.lists.list` (names, `cardCount`, no cards) and `work.cards.list`
(every live card on the board, with `listId`) are two separate reads,
grouped client-side by `listId` and sorted by `rank`** (plain string
comparison — CLAUDE.md's rank scheme is built to be lexicographically
comparable) — there is no single "board render" route on the server.

**No drag-and-drop.** The same call `home.tsx`'s own header already made
for "My Tasks" (`card-row.tsx`'s new header repeats it): a full drag
implementation is real, separate work — rebalancing, WIP-limit feedback
mid-drag, a gesture handler that has to agree with the server's
neighbour-based ranking. Moving a card here is a discrete "Move" button on
each row (new: `card-row.tsx`'s `onMove` prop) opening a plain bottom-sheet
list of the board's OTHER lists, built on RN's own `Modal` — no new
dependency — and always append-to-end (`beforeCardId`/`afterCardId` both
null), never a reorder within a list.

**`card-row.tsx` (new)** extracts the reference/title/badge rendering
`home.tsx`'s original `renderCard` had, once the board view needed the
identical rendering for a second screen — three near-identical copies is
this codebase's own bar for "extract it" (CLAUDE.md: "three similar lines
is better than a premature abstraction" — two screens sharing one
component is the inverse call, made once a second real caller existed, not
before).

### Comments — read + post on a card

`card/[cardId].tsx` gained a `CommentsSection`: existing comments render
through `RichTextView` unchanged (`work.comments.list`'s `body` is the same
TipTap-JSON `RichTextDocument` shape a description already is), and posting
one uses `plainParagraph` from `@taskflow/api/richtext` — the exact helper
`richtext.ts` itself documents as "the one document shape a stored TEXT
field may become," now reused a third time (after the rule-body and CSV
importer) rather than reimplemented as a fourth copy. No native rich text
EDITOR exists, so the composer is plain text wrapped in a single paragraph
— the identical boundary `TitleField`'s own header already draws for why
the description field isn't editable yet either.

A deleted comment is tombstoned server-side (`deletedAt` set, `body`/
`bodyText` cleared, the ROW kept so a reply still has a parent) — rendered
here as "Comment deleted" rather than an empty `RichTextView`, which would
look like a blank comment rather than a removed one. No edit, no delete, no
replies: read + post is the whole slice.

`authorId` shows as "You" (compared against `session.ts`'s own `userId`,
already tracked for the access token) or a generic "Member" — resolving a
real display name needs a member-profile lookup this slice does not build,
the same simplification Chat's channel list makes for a DM's name below.

### Chat — Wave 3 started: channels, read + send

A new tab: `(tabs)/chat.tsx` lists every channel the caller can see
(`chat.channels.list`), joined ones first. Tapping one opens
`channel/[channelId].tsx`: `chat.messages.list`'s most recent page (default
`limit`, no "load more" yet — real, separate work, the same class of gap
boards' own "no drag-and-drop" note names), reversed client-side for
display since the route itself returns newest-first (`ORDER BY id DESC`,
the same direction its `before` pagination cursor walks). Sending reuses
the identical `plainParagraph` + `RichTextView` pair Comments established
one section up — the two domains share the exact same TipTap-JSON wire
shape, so the pattern transfers unchanged.

**A DM shows a plain "Direct message" placeholder, never a wrong or missing
name.** `apps/web` resolves the other participant's real name via a
member-profile lookup; this slice does not build that join (real, separate
work, the same call Comments' author display already made) — a named
public/private channel still shows its actual name, since that field comes
back directly with no resolution needed. _(Superseded the same day a real
device video review named this exact gap explicitly — `use-members.ts` now
builds that lookup, and DMs are named for real. See "Chat, reworked" below
rather than an edit in place, per this file's own habit of correcting a
stale claim rather than silently rewriting it.)_

**Explicitly out of scope, all real and separate work**: reactions, thread
replies (`chat.messages.thread` has no caller here), mentions autocomplete,
edit/delete, typing indicators, read receipts, file attachments, link
unfurls, and push (§9's own FCM/APNs wiring — Wave 3's roadmap row names it
explicitly, and nothing here touches it). This is "channels exist and you
can talk in them," not the whole of Wave 3. _(Reactions and mentions
composing shipped in the same increment that closed the DM-naming gap
above — see "Chat, reworked" below. Thread replies, edit/delete, typing
indicators, read receipts, attachments, link unfurls and push are still
exactly this: real, separate work.)_

**Writing this section is what found a real, silent gap: `app/_layout.tsx`
was never refetching anything on app-foreground, on ANY screen, since the
very first increment.** `createQueryClient`'s shared defaults
(`packages/client/src/query-client.ts`) set `refetchOnWindowFocus: true` —
correct for `apps/web`, where the browser's `visibilitychange` event
already exists — but TanStack Query's `focusManager` has no such event to
listen for on React Native unless something calls
`focusManager.setEventListener` itself, which nothing here ever did. So
every screen has been "fresh on navigation, frozen otherwise" since Wave 1,
invisible because a fast round trip through a screen (navigate away,
navigate back) refetches anyway and looks identical to a real focus
refetch. Chat is what made it matter: leaving the app backgrounded for a
minute and returning to a channel should not show a thread frozen at
whatever it looked like a minute ago. Fixed in `app/_layout.tsx` — an
`AppState` listener mapping `'active'` to `focusManager.setFocused(true)`,
the exact shape TanStack Query's own React Native guide documents —
verified by reading the library's focus-manager source, not assumed, since
this specific gap survives typecheck, lint, and a bundle build identically
whether the listener exists or not; only a real device, backgrounded and
resumed, would have shown it directly.

## Five bugs found by a real device video review, all fixed together

The user recorded a screen capture of a real development build driving every
screen shipped so far and reviewed it frame by frame (`ffmpeg`/`ffprobe`
weren't available in the review sandbox; `opencv-python-headless` extracted
40 evenly-spaced frames instead, reviewed as images). Consistent with this
file's own running lesson — a green `pnpm verify` is not the same claim as
"this works when you click it" — none of these five were reachable by
typecheck, lint, the unit suite, or a bundle build. All five were confirmed
against the recording, not assumed from the complaint text, and fixed
together as one batch per the user's own stated priority ("bugs first, then
the board redesign").

### A real `<Stack>`, not `<Slot />` — the back button that always landed on My Tasks

**Every "← Back" press, from anywhere in the app, landed on My Tasks — not
one screen back.** `(app)/_layout.tsx` rendered a bare `<Slot />`, which is
not a navigator: it has no history stack of its own, so `router.back()` had
nothing real to pop and fell through to `expo-router`'s own default, the
tab group's initial route. This was invisible to every check so far because
none of them press a back button and observe where it lands — a `<Slot />`
bundles, typechecks, and renders the CURRENT screen correctly; only
navigating two or more levels deep and pressing back exposes that there was
never a real stack underneath.

Fixed by rendering a genuine `<Stack screenOptions={{ headerShown: false }}
/>` instead. This auto-registers every route under `(app)/` — the tab
group, `card/[cardId]`, `board/[boardId]`, `project/[projectId]`,
`channel/[channelId]` — as one real navigation stack, so `router.back()` now
pops exactly one level, matching every screen's own hand-built "← Back"
button (which calls `router.back()` and previously relied on it working).
`headerShown: false` keeps Expo Router's own chrome off, since every screen
already renders its own back button rather than expecting a native header
bar.

### Tab bar icons that were rendering, but as broken empty glyph boxes

The tab bar's four tabs had never had icons at all — `(tabs)/_layout.tsx`
shipped with text-only labels (this file's own "navigation shell" section
above says so explicitly: "no icon set... adding an icon library was not a
call worth making inside this fix"). What the recording showed was not
missing icons but broken ones: an icon FONT reference with no font actually
loaded renders as an empty glyph box, which reads as "no icon" only in a
static screenshot — in motion, across four tabs, it reads as a bug. Fixed
by adding `@expo/vector-icons` (Expo's own maintained icon package, already
a transitive dependency of `expo-router` — this makes it a direct,
explicit one) and wiring `Ionicons` into all four `Tabs.Screen` entries:
checkmark-circle (My Tasks), grid (Boards), chatbubbles (Chat),
person-circle (Account), each filled when focused and outlined otherwise.

### Content scrolling under the status bar

Every screen's content started at a fixed `paddingTop: 24` — enough to
clear the status bar at the TOP of a scroll, but nothing stopped scrolled
content from later passing back UNDER it, since Android's status bar was
translucent by default (drawn over the app, not reserving real space). A
static padding value only fixes where content STARTS, not everywhere it can
scroll to. Two-part fix:

- **`app.config.ts`** gained an explicit `androidStatusBar` block
  (`backgroundColor`, `barStyle: 'light-content'`, `translucent: false`),
  making the status bar opaque and reserving real layout space for it,
  rather than leaving content free to render visibly underneath.
- **`src/lib/use-top-inset.ts`** (new) — `useTopInset(extra = 24)`, a thin
  wrapper over `react-native-safe-area-context`'s `useSafeAreaInsets().top`
  (already available; `SafeAreaProvider` already wraps the whole app) —
  replaces every screen's static `paddingTop: 24` with the device's ACTUAL
  safe-area inset plus the same 24px breathing room, so the padding is
  correct on a device with a notch or punch-hole camera and on one without,
  rather than a guess that happened to work on the one test device.

Applied to every screen carrying the old static value: `home.tsx`,
`boards.tsx`, `chat.tsx`, `account.tsx`, `org-picker.tsx`,
`card/[cardId].tsx`, `board/[boardId].tsx`, `project/[projectId].tsx`, and
`channel/[channelId].tsx`. First attempt at `card/[cardId].tsx` placed the
`useTopInset()` call after two early returns (`card.isPending`,
`card.isError`) — a Rules of Hooks violation caught before verification
completed and moved above both, matching the ordering every other hook on
that screen already follows.

One import gotcha worth recording for the next person who reaches for a
shared token: `app.config.ts` tried importing `colors` from
`@taskflow/tokens` to avoid hand-writing the status bar's hex value, and
that broke `expo config`/`expo export`/`eas build` outright —
`Error [ERR_MODULE_NOT_FOUND]`, tracing to `@taskflow/tokens`'s NodeNext-style
`./colors.js` re-export. `app.config.ts` is loaded by Expo CLI's own
Node-based config loader, which shares neither Metro's custom `.js`→`.ts`
resolver (see "Metro actually bundling the app" above) nor `tsc`/Vitest's
NodeNext `moduleResolution` — so a workspace package built around that
convention is simply unreachable from this one file. Caught by running
`npx expo config --json` before committing, not assumed safe because it
typechecked. Fixed by hardcoding the hex value as a local constant with a
comment explaining why, rather than trying to route around the loader.

### The composer hidden behind the keyboard, in two places

**Typing a comment or a chat message showed nothing — the text input was
rendering fully behind the open keyboard**, invisible, with no way to see
what was being typed. Both `card/[cardId].tsx`'s comment composer and
`channel/[channelId].tsx`'s message composer wrapped their content in
`KeyboardAvoidingView`, but `channel/[channelId].tsx`'s Android `behavior`
was `undefined` — relying entirely on native `windowSoftInputMode` resizing
the screen, which the test device did not do. `card/[cardId].tsx`'s
composer had no `KeyboardAvoidingView` at all. Fixed by wrapping
`card/[cardId].tsx`'s `<ScrollView>` in a `KeyboardAvoidingView` and
changing `channel/[channelId].tsx`'s Android `behavior` from `undefined` to
`'height'` — the standard cross-platform-safe fallback that shrinks the
view's own height when the keyboard opens rather than trusting the OS to do
it, which does not depend on whichever `windowSoftInputMode` the current
build happens to have. `'padding'` on iOS is unchanged in both files.

## The board redesign, and create-project / create-board actions

Second half of the user's own stated priority order ("bugs first, then the
board redesign + create actions, then the rest"). Both come from the same
video review the bug-fix section above documents.

### Board view: a tab strip over a virtualized list, replacing the vertical stack

**The board screen's original layout — every list's cards stacked in one
tall `ScrollView`, one section per list — was found broken against a real
board with 90+ cards in its first list.** Seeing a second list's name at
all meant scrolling past all 90 cards in the first one; the user's own
words were "not very easy to see where a list is, finished, next,
started." That is not a cosmetic complaint — it is the layout making the
board's actual STATE (which list has what, and how much) invisible without
a long scroll.

`board/[boardId].tsx` now renders a fixed, always-visible horizontal tab
strip — one chip per list, showing its name and live card count — above a
single `FlatList` holding only the SELECTED list's cards. Every list's name
and count is on screen at once (answering "where is a list" directly, no
scrolling), and seeing that list's actual cards is one tap away, not a
scroll past everything before it. `FlatList` also virtualizes, which the
old `ScrollView.map()` never did — a 90-card list is no longer 90 mounted
rows at once, closing a real performance gap the video surfaced alongside
the visibility one.

Selection state (`selectedListId`) falls back to the board's first list
whenever nothing is selected yet, or the previously-selected list no longer
exists (reloaded data, an archived/removed list) — never a blank strip with
no list's cards showing. The `FlatList` is keyed on the active list id, so
switching tabs resets scroll position to the top of the new list rather
than preserving whatever offset the previous list was scrolled to. The
"Move" button and its bottom-sheet `Modal` are unchanged — moving a card
still opens a plain list of the board's other lists, append-to-end only,
same as before this redesign.

Still horizontal-scroll, not swipe-between-lists: a `ScrollView` of
pressable chips, not a paged `FlatList` or a gesture-driven tab view. A
swipeable board (drag left/right between lists, matching Trello's/Linear's
mobile pattern more closely) is a reasonable next step but a materially
bigger change — new gesture handling, a real "which page am I on"
paging state, and animation — and was not what the reported bug needed
fixed to be usable again.

### "New project" and "New board" — the same server capability, never a role check

**Both actions were entirely missing from mobile** — `work.projects.create`
and `work.boards.create` had no caller anywhere under `apps/mobile`, so
there was genuinely no way to create anything from the phone. Ported from
`apps/web/src/features/work/projects-page.tsx`'s own pattern rather than
invented fresh, because CLAUDE.md's rule for this app ("the UI never
re-derives authorization... every control is shown and the server
answers") applies exactly as much on native as on web, and that file's own
header already states the precedent to follow: **never a client-side role
comparison, always the server's own `capabilities` field.**

- **`(tabs)/boards.tsx`**: "+ New project" is gated on
  `tenancy.orgs.get`'s `capabilities.createProject` — an org-level,
  role-only flag (`can(subject, 'project:create')` with no target, since
  creating a project has no existing resource to hold a tuple yet), the
  identical `orgDetailQuery` read web's `ProjectsPage` uses. Submitting
  opens an inline form (name, key, optional description) calling
  `work.projects.create`, then invalidates `PROJECTS_QUERY_KEY`. The key
  field mirrors the server's own `ProjectKey` shape client-side as a
  typing hint (2-10 letters/digits, starting with a letter, auto-uppercased)
  — the server still re-validates; this only avoids a round-trip for the
  obvious case.
- **`project/[projectId].tsx`**: "+ New board" is gated on
  `project.capabilities.update` — not a separate `capabilities.createBoard`,
  because there isn't one: `board.service.ts`'s `createBoard` enforces
  `project:update` on the PARENT project, so `update` is genuinely what
  decides whether this control can do anything, the same non-obvious
  mapping `projects-page.tsx`'s own `BoardList` comment names explicitly.
  This screen has no dedicated "get one project" route to read that flag
  from, so it re-runs `(tabs)/boards.tsx`'s own `work.projects.list` query —
  same key, same `includeArchived: false` args — which is a cache hit, not
  a second network request, whenever this screen is reached the normal way
  (tapping a project row that query already rendered). Submitting opens an
  inline name-only form (a board needs nothing else to exist), calls
  `work.boards.create`, and invalidates that project's own
  `boardsQueryKey`.

Both buttons render as hidden, not disabled, when the capability is false —
matching `projects-page.tsx`'s own stated reasoning: a create form nobody
without the permission could submit is clutter, not information, and the
list below stays fully visible either way.

### A tab-strip rendering bug, found on the very next real-device run

**The board tab strip above rendered as four near-fullscreen vertical
pills instead of a compact row of chips**, the first time it ran on a real
device — a genuine regression in the redesign itself, not a pre-existing
gap. Root cause: a horizontal `ScrollView` given no explicit `style` sizes
its own FRAME to fill remaining flex space from its column parent (not
just its content), and the default cross-axis `alignItems: 'stretch'` on
its row-direction content container then stretched every chip to match
that frame's height. Fixed with three layers, each closing one part of the
mechanism: `tabStripFrame` (`flexGrow: 0, flexShrink: 0`) pins the
`ScrollView`'s own frame to its content height; `alignItems: 'flex-start'`
on the content container stops it stretching children by default; `tab`
itself also carries `alignSelf: 'flex-start'` as a third, defensive layer.
Caught immediately from a screenshot of the running app, not assumed fixed
from reading the diff.

## Chat, reworked: real names, message grouping, reactions, mentions, and a way to actually start something

A second real device video review — this time of the app with boards and
comments already shipped — named Chat specifically as "very messy... we
need like how web has," itemizing gaps against the placeholder version
above: no real names anywhere (chat AND comments both said "You"/
"Member"), no way to tell who a DM was with, no reactions, no way to
create a channel or DM at all, and mentions that rendered as plain text
with no way to compose one. Closed together, because most of it traces to
one missing piece.

**`src/lib/use-members.ts` (new) is the root fix everything else builds
on** — a direct port of `apps/web/src/features/org/use-members.ts`'s
`personOf`/`peopleOf` lookup over `tenancy.members.list`, that file's own
header explaining the design in full (a `Map` derived per render from the
query cache rather than copied into a store, so a renamed or removed
member is never stale independently of the cache; a missing id falls back
to the raw uuid rather than hiding the author, since hiding would silently
misreport a message as authorless). Nothing native had this lookup before
— chat and card comments were each independently rendering a hardcoded
"You"/"Member" pair. Both now call the same hook: `channel/[channelId].tsx`
and `(tabs)/chat.tsx` for chat, `card/[cardId].tsx`'s `CommentRow` for
Work. One fix, two screens' worth of the same complaint closed at once.

**`src/lib/avatar.tsx` (new)** — an initials circle on a deterministic
color (hashed from the label, so the same person gets the same color
everywhere), not a photo. Closes half of Wave 2's own "no avatars" gap
("`AvatarStack` needs a members lookup and image loading, neither of which
exist on mobile yet") — the lookup half, now that `use-members.ts` exists.
Image loading is still real, separate work; this is the same fallback
Slack/Linear's own avatar renders when there is no uploaded picture, not a
reduced stand-in for one.

**Message grouping** — `chat.ts` gained `groupMessages`/`MessageGroup`/
`GROUP_WINDOW_MS`, logic ported unchanged from
`apps/web/src/features/chat/grouping.ts` (that file's own header has the
full reasoning: grouped by author ID never the resolved label, since two
different people can share `personOf`'s raw-id fallback; the five-minute
window resets from each message to the PREVIOUS one, so a burst of
messages five minutes apart end-to-end still reads as one exchange).
`channel/[channelId].tsx` now renders one avatar + name + timestamp header
per GROUP, not per message — the single change that most makes the thread
read as a conversation instead of a log of identical repeating boxes,
exactly the complaint "very messy" was naming. `chat.test.ts` (11 cases)
asserts the grouping boundary conditions natively, because a native-only
bug here (grouping by the wrong field, an off-by-one in the window
comparison) would be invisible to web's own suite.

**A channel finally has a header.** `channel/[channelId].tsx` had NO
title at all before this — just a back button over a bare message list,
with nothing naming which channel you were even in. It now fetches
`chat.channels.get` and shows the channel's real name (or, for a DM, the
SAME `personOf`-based naming `(tabs)/chat.tsx`'s list uses — `chat.ts`'s
`channelDisplayName` takes a `personOf` argument now instead of resolving
to a bare placeholder), plus the topic or an "Archived" notice as a
subtitle.

**The composer is now gated on `capabilities.post`, never a role check** —
`channels.get`'s own `capabilities` field is the server's real `can()`
verdict, the same pattern `(tabs)/boards.tsx`'s create buttons already
established. An archived channel, or a read-only (`commenter`-shaped)
membership, now shows no composer at all instead of one that would 403 on
send — one of the very FIRST complaints this app's review ever named
("not all things what web has as per roles... this is throughout the
app"), closed here for chat specifically.

**Reactions** — `chat.messages.react`/`.reactions` wired for the first
time. `QUICK_REACTIONS` (👍❤️😂🎉👀✅) is the exact same six web offers
(`chat-page.tsx`'s own constant) — chat's reaction picker is not a full
emoji keyboard on EITHER platform, so this is genuine parity, not a
reduced mobile cut. Long-pressing a message opens a bottom-sheet picker
(the same `Modal` shape `board/[boardId].tsx`'s "Move" sheet already
established); tapping an existing reaction pill directly toggles the
viewer's own reaction, no picker needed for the common un-react case.
`chat.ts`'s `groupReactions` (ported from `chat-page.tsx`'s function of
the same name) groups the flat reaction-row list by message then emoji.
The `chat.messages.reactions` query is fetched CHUNKED, 25 message ids per
dispatch, and keyed STABLY (no `messageIds` in the query key) — both
ported directly from `apps/web/src/features/chat/api.ts`'s own
`reactionsQuery`, whose header records exactly why: an unchunked dispatch
carrying this screen's ~50 loaded message ids is close enough to
`trpc-client.ts`'s `maxURLLength` ceiling (shared by this app's identical
`httpBatchLink` config) that web hit the real "Input is too big for a
single dispatch" failure, and a key embedding a fresh array reference every
render restarts the query every render, so the reactions bar never
settles.

**Mentions — rendering already existed; composing did not.**
`rich-text-view.tsx`'s `case 'mention'` predates this increment entirely
(§6.4's renderer has always handled it) — what was missing was any way to
PRODUCE one from native input; typing "@Jane" just sent literal text.
`src/lib/message-compose.ts` (new) is the bounded substitute for not
having a real rich text editor to track a live cursor/selection with (that
file's own header has the full design): the composer offers a dropdown
only while the user is typing the END of the draft — `activeMentionQuery`
returns the trailing `@query`, or `null` once whitespace ends it or there
is no trailing `@` at all — never a mid-string trigger, since a plain
`TextInput` cannot express "insert at the cursor" the way a real editor
can. Picking a candidate (`insertMention`) replaces that trailing query
with literal `@Label ` text and records `{userId, label}`; at SEND time,
`buildMessageBody` walks the final draft left-to-right, swapping each
recorded marker's literal text for a real `mention` node, and degrades
silently to plain text for any pick whose marker text got edited away in
the meantime — never a broken half-reference. `message-compose.test.ts`
(14 cases) covers this directly, including the "picked then edited away"
degradation and resolving markers in TEXT order regardless of which order
they were picked in.

**A way to actually create something.** `(tabs)/chat.tsx` gained a "+ New"
button opening a plain sheet — "New channel" (hidden unless
`chat.channels.list`'s own `canCreateChannel` says so, the identical
server-capability pattern Work's own create buttons use) and "New direct
message" (no such gate: `channels.openDirect`'s own router comment says
starting a DM only needs `channel:read`, the same permission that already
got the caller onto this screen at all). Both reuse the bottom-sheet
`Modal` shape already established twice elsewhere in this app now (Move,
React) rather than a fourth new pattern. Before this, there was genuinely
no way to start a channel or a DM from the phone at all — the complaint
was literal, not an exaggeration.

**Still explicitly out of scope, all real and separate work**: thread
replies (`chat.messages.thread` has no caller anywhere on native), message
edit/delete, typing indicators, read receipts, link unfurls, and push.
Mentions autocomplete is real but bounded to the trailing-query case
above — mid-string mention insertion needs an actual rich text editor, the
same boundary `card/[cardId].tsx`'s `TitleField` already draws for why the
description field isn't editable either. _(File attachments' "real,
separate work" status narrowed one increment later — see "The channel
details screen" below: reading and downloading what has already been
shared is now built; attaching a NEW file from the composer is the part
still deferred.)_

## The keyboard bug in "New channel"/"New direct message", and the channel details screen

A second real device review, of the increment above, found one more bug
and one more named gap: **"when creating new channel the textbox is behind
the keyboard"**, and **"where to see details like what we do by clicking
the chat header to see members and all this info and where to add
members."** Both closed together; asked "how much of web's details panel"
this pass should build, and told, explicitly, "everything web has."

**The keyboard bug** was the identical failure mode
`channel/[channelId].tsx`'s own header already documents for the message
composer — a `TextInput` that autofocuses the moment its screen mounts,
inside a container with no `KeyboardAvoidingView` at all — on a SECOND
screen that never got the same fix, because `(tabs)/chat.tsx`'s "New
channel"/"New direct message" sheet was built after that fix and nobody
carried the lesson forward by hand. Fixed the same way: the whole `Modal`
now wraps its content in a `KeyboardAvoidingView` (`'padding'` on iOS,
`'height'` on Android), matching every other composer in this app.

**The channel details screen** (`app/(app)/channel-details/[channelId].tsx`,
new) is a feature-for-feature port of
`apps/web/src/features/chat/channel-details.tsx` — not the smaller
"roster + settings" cut that was also on offer, because the user's own
answer to that scope question was "everything web has." Reached by tapping
the channel header in `channel/[channelId].tsx` (previously inert — a
`View`, not a `Pressable`, so there was no way to reach this at all). One
full-screen route (`router.push`, not a bottom-sheet `Modal` like this
app's other secondary flows) — web's own panel already collapses to "a
full-width overlay on top of the conversation" below its `md` breakpoint,
i.e. at phone width, which is a router push in a navigator with no
side-panel concept at all. Sections, in order:

- **Identity** — a DM shows who you are talking to (participant names via
  `personOf`, the same lookup the header title already used); a named
  channel shows `#`/🔒 + name + topic, with an inline rename/re-topic form
  gated on `channel.data.capabilities.manage`.
- **Members**, with Leave/Remove — `chat.channels.removeMember` is ONE
  route for both; the label follows whether the target is the viewer
  (which the client knows for certain), never a permission the client only
  half-knows, the exact reasoning `apps/web`'s own `MemberRoster` states.
  A DM's roster renders informationally (no remove control) — the service
  refuses both add and remove on one, so a control here could only ever
  error.
- **Add people**, non-DM only — search by email against
  `tenancy.members.list` minus whoever is already in, matching web's own
  choice of search field exactly (not a mobile improvisation).
- **Pinned**, with Unpin. The other half of this loop —
  **pinning** — was added to `channel/[channelId].tsx` itself: long-pressing
  a message now offers "📌 Pin this message" alongside the existing
  quick-react row, reusing the same bottom-sheet state that row already
  had. Pin lives on the message (web's own split too); unpin lives in the
  list that resulted from pinning.
- **Starred by you** — `chat.saved.list` is ORG-WIDE (a save is personal;
  the same route a future "Saved" sidebar surface would read unfiltered),
  filtered client-side to this one channel rather than adding a second,
  channel-scoped route for an already-cheap, already-cached query — the
  identical choice web's own `SavedSection` makes, restated verbatim in
  this screen's own comment.
- **Files** — every live attachment this conversation has ever held, via
  `chat.attachments.listForChannel`. Download only: tapping a clean file
  calls `chat.attachments.download` for a freshly authorized, short-lived
  URL and opens it with `Linking.openURL` — the same primitive
  `rich-text-view.tsx` already uses for a link mark, not a new download
  library. **Attaching a NEW file from the composer is still explicitly
  out of scope** — a real, separate feature (an image/document picker, an
  upload flow, virus-scan status polling on mobile), not something this
  pass's "list what already exists" scope needed.
- **Guest access**, private channels only, `capabilities.manage` only —
  invite/revoke against the same member search as Add People, with an
  optional expiry in days. Rendered only under `capabilities.manage`
  (never shown-then-refused) for the identical reason web's own header
  gives: hiding a section gated on the server's own capability IS
  displaying that decision, not a second one layered on top of it.
- **Retention & compliance**, non-DM, `capabilities.manage` only — a
  retention-days input (blank means keep forever), a legal-hold toggle,
  and Export. **Export has no browser download to fall back on** — the
  mobile-native equivalent of web's Blob-and-anchor trick is React
  Native's own `Share.share()` (core, zero new dependencies), handing the
  exported JSON to the OS share sheet — Save to Files, AirDrop, email,
  whatever the device offers — rather than a reduced substitute for a
  download.
- **Archive/Restore**, non-DM only, always shown (never gated on
  `capabilities.manage` client-side) — the same "show it, let the server
  refuse" rule this file's other sections apply.

**One deliberate exclusion from "everything web has," stated rather than
silently dropped:** web's panel also renders a call-history list and, for
a two-person DM, a click-to-call button against the person's work phone.
Neither made it here. Phase 7's telephony client and Phase 13's WebRTC
signaling have never been ported to `apps/mobile` at all — building
either into this pass would mean standing up an entire second feature
area from nothing, inside what was asked for as a chat-details
enhancement. A call button that cannot place a call is worse than no
button; a "past calls" list with no query layer behind it is the same
mistake this app's own history already warns against — a control that
reads correctly and does nothing real. Real, separate work, named here
rather than quietly missing.

## Account screen parity with web — complete

The next item after the video-review bug fixes and the board/chat work:
bringing `(tabs)/account.tsx` up to web's much larger `account-page.tsx`
(profile, working hours, TOTP, connected accounts, passkey management,
sessions, DSAR export). Started with the piece everything else depends on,
plus the first section built on it.

**Nearly every mutation this parity work needs — link/unlink an OAuth
provider, enroll/disable TOTP, remove a passkey, revoke a session, sign out
everywhere — is `stepUp: true` server-side, and mobile had NO step-up
handling at all before this increment.** `apps/api/src/trpc/builder.ts`'s
own comment is exact about why this can never be satisfied by a token
refresh: `authenticatedAt` is set at LOGIN, and a refresh deliberately never
advances it — so a stolen refresh token alone can never pass this gate, only
a fresh password/passkey/TOTP proof can. Skipping this would have meant
every section below silently 401ing the moment five minutes passed since
sign-in, which is the common case for anyone actually using the Account tab.

- **`src/lib/use-step-up.ts`** — `useStepUp()`, ported from
  `apps/web/src/features/auth/use-step-up.tsx`: a `guard(error, retry)` that
  recognizes `STEP_UP_REQUIRED` and queues the retry as a thunk (never
  captured arguments — a caller may need to re-run something composite),
  plus `pending`/`confirm`/`cancel` state a sheet component reads. Split
  from the sheet itself for the identical reason web's two files are split:
  a module exporting both a hook and a component risks losing Fast Refresh
  on the component, in Metro exactly as in Vite.
- **`src/lib/step-up-sheet.tsx`** — `<StepUpSheet />`, the mobile
  `StepUpDialog`. Re-authenticating IS signing in again, so this reruns the
  identical `auth.native.login`/`auth.native.totp.verifyLogin` pair
  `(auth)/sign-in.tsx` already uses (password, then an inline TOTP challenge
  if the account has one enrolled), `session.adopt`s the fresh pair — a
  genuinely new `authenticatedAt`, the one thing this control exists to
  bump — then calls the caller's queued retry rather than navigating
  anywhere. A bottom-sheet `Modal` wrapped in `KeyboardAvoidingView` from
  the start, matching the lesson `(tabs)/chat.tsx`'s "New channel" fix above
  already paid for: a password TextInput in an unguarded sheet is the exact
  shape that broke there.
- **`src/lib/connected-accounts-section.tsx`** — the first section built on
  it, and the one piece of this whole slice that needed new SERVER code:
  `apps/api/src/identity/router.ts`'s `auth.native.oauth.startLink` (own
  commit, own header — a ⚠ human-review-surface change, flagged for review
  before merge rather than folded silently into this one). Listing and
  unlinking use the CHANNEL-AGNOSTIC `auth.oauth.listConnected`/`unlink` —
  the same routes the browser calls, since neither reads or writes anything
  channel-specific. Linking is the one channel-specific operation (the
  redirect must land back in THIS app, not a browser tab), so it goes
  through the new native route, mirroring `(auth)/sign-in.tsx`'s own OAuth
  mutation (`openAuthSessionAsync` + `parseOAuthRedirect`) almost exactly —
  the one difference is `onSuccess`: sign-in adopts a session, this never
  does, because a `{ kind: 'linked' }` result carries no tokens to adopt.
- **`(tabs)/account.tsx`** gained a `ScrollView` (was a plain `View` — fine
  for three items, not for the eight sections it now holds).

**The remaining six sections, all built on the step-up infrastructure
above** (each its own file in `src/lib/`, each ported from the matching
web component, each wired into `account.tsx` in the same order web renders
them: profile, working hours, passkeys, TOTP, connected accounts, sessions,
export):

- **`sessions-section.tsx`** — device/session inventory. `list` is a plain
  `selfRoute` read; `revoke` (one device) and `auth.logoutEverywhere`
  (every device, including this one) are both `stepUp: true`. Deliberately
  does NOT call `session.signOut()` for the "everywhere" case — that method
  also revokes THIS device's own refresh token server-side, which is
  redundant (the server already revoked every session) and pointless to
  await (the very token it would send is one of the ones just revoked).
  `session.clear()` is the correct local half: drop the stored token, flip
  `status` to `'anonymous'`, and let `(app)/_layout.tsx`'s existing gate —
  the same one the ordinary "Sign out" button already relies on — do the
  redirect, with no explicit navigation call needed here either.
- **`passkey-section.tsx`** — replaces `account.tsx`'s original enroll-only
  block with enroll, list, rename, and remove. `remove` is `stepUp: true`
  (§8.1: removing an authenticator is exactly what a stolen session is used
  for first); `list`/`rename` are not.
- **`totp-section.tsx`** / **`qr-code.tsx`** — two-factor authentication,
  the one section needing a genuinely new native dependency
  (`react-native-qrcode-svg` + its `react-native-svg` peer — nothing in
  this app rendered a QR code before). `qr-code.tsx` loads it with a
  memoized dynamic `import()`, never a static top-level one — the exact
  shape `device-key.ts`'s `getNative()`, `biometric-gate.native.ts`'s
  dynamic `expo-local-authentication` import, and `passkeys.ts`'s
  `loadPasskeys()` all already use, for the identical reason each of their
  own headers documents: a native module's entry file commonly calls
  `requireNativeModule`/`requireNativeComponent` at ITS top level, which
  throws wherever the module is not yet linked, and a static import in a
  file reachable from the tab bar poisons Metro's whole module graph before
  a single screen renders — the exact failure this file's own history
  names twice already for the two previous native modules this app added.
  Failing to load renders `null` rather than throwing; the manual secret
  (shown alongside the QR, not conditionally) stays a complete, usable
  enrollment path on its own either way. `npx expo install` itself failed
  in this sandbox — it fatally errored trying to reach
  `reactnative.directory`'s compatibility-metadata service (blocked by
  this environment's outbound proxy) rather than gracefully skipping that
  check as its own log claimed it would — so the dependency was added with
  a direct `pnpm add` instead, verified the only way that actually matters
  here: a real `expo export` for both platforms with the new native code
  in the graph.
- **`profile-section.tsx`** — display name, read-only email, verified
  badge, member-since. `auth.me` (read) and `people.profile.update`
  (write) are both `selfRoute` with NO `stepUp` — a display name is not
  credential-adjacent — so this is the one new section that needs none of
  the `useStepUp` plumbing every other one does.
- **`working-hours-section.tsx`** — timezone, work start/end, a
  working-days toggle grid, out-of-office from/until/message, via
  `people.profile.get`/`.update` (the merged view `auth.me` deliberately
  does not carry). Time and date fields are plain text (`HH:MM`,
  `YYYY-MM-DD`), not native pickers — the same call `card/[cardId].tsx`'s
  own header already makes for due/start dates, still the right one here:
  this session already added two new native dependencies (icons, the TOTP
  QR renderer above), and a third for two rarely-touched fields is not a
  call to make silently inside a port. The server re-validates either way.
  One subtlety worth naming: `oooFrom`/`oooUntil` arrive over the wire as
  full ISO instants (a `z.date()` output), sliced to their leading
  `YYYY-MM-DD` before landing in the text field — the same treatment web's
  `value.oooFrom?.slice(0, 10)` gives the identical field — so a reloaded
  value re-populates the date that was actually typed, not a raw
  timestamp.
- **`export-data-section.tsx`** — self-serve DSAR export.
  `people.profile.exportMine` is a tRPC QUERY but called on demand from a
  button press, never auto-fetched — the same choice web's own header
  notes explicitly for the identical route. `Share.share` (React Native
  core, zero new dependencies) is the mobile equivalent of web's
  `Blob`-and-anchor download, the same pattern
  `channel-details/[channelId].tsx`'s own compliance export already
  established for this app.

**One finding worth recording for the next native dependency this app
adds**: this session's own empirical check found that `z.date()` fields
already arrive correctly typed as `string` on the mobile tRPC client with
NO `wire()` applied — `@trpc/client@11.18`'s type inference now resolves
this automatically for an HTTP link with no transformer, which is not the
behavior this file's own CLAUDE.md-documented history describes. Confirmed
directly: `const x: string = result.exportedAt` typechecks with no cast,
and `const y: Date = result.exportedAt` fails with `Type 'string' is not
assignable to type 'Date'`, on more than one route. `wire()` is still
called at every query boundary in the files added this session regardless
— consistency with this codebase's own established, explicitly documented
convention matters more than exploiting a version-specific inference
improvement that a future dependency bump could just as easily reverse,
and `Wire<T>` is a no-op identity mapping wherever the field is already
correctly typed, so there is no cost to keeping the pattern.

## Sprints — view, assign, project sprint management

The last item from the original priority list after Account parity:
`ai/phase-14-mobile.md`'s Sprints roadmap row, entirely absent from mobile
before this increment. `src/lib/sprints.ts` (types, the query key, the
`isOpenSprint` closed-sprint check) plus one new screen,
`app/(app)/sprints/[projectId].tsx`, reached from a new "Sprints" button on
`project/[projectId].tsx`'s header — always shown, unlike "+ New board",
because viewing sprints is `project:read`, the same floor that screen is
already gated on.

**A sprint belongs to a PROJECT, not a board** (`packages/db/migrations/
0054_sprints.up.sql`), and a card's `sprintId` is nullable — no sprint means
the backlog, which is not a row anywhere, just the absence of one. The
screen renders the identical tab-strip-over-a-list shape `board/
[boardId].tsx`'s own redesign already established: "Backlog" plus one chip
per sprint (status-color dot, name, live card count), switching which cards
the `FlatList` below shows. Moving a card between the backlog and a sprint
reuses that same screen's bottom-sheet Move pattern too — the "Move" button
`CardRow` already renders opens a sheet naming the OTHER destinations
(backlog + open sprints instead of lists), calling `work.cards.
assignSprint`/`releaseSprint`.

**A board picker appears only when the project has more than one board.**
`work.cards.list` is board-scoped — there is no project-wide card read — so
this screen has to pick one board's cards to show; `apps/web`'s own
`SprintPlanning` names the identical constraint via its own board
`<select>` ("shown when more than one option exists"). For the common
one-board-per-project case this renders nothing extra.

Sprint lifecycle (start/complete/cancel) and create/edit are all gated on
`canManage` — `project.capabilities.update`, reusing the same
`PROJECTS_QUERY_KEY` cache-sharing pattern `project/[projectId].tsx`
already established for "+ New board", never a client-side role check.
Completing a sprint opens a second modal asking where unfinished cards go
(backlog or another open sprint) — cards already in a "done" category stay
in the completed sprint as the shipped record, mirroring the service's own
shipped/released split; cancelling releases everything, no modal needed.

**No CSV import** — a file picker is a new native dependency this app does
not have, plus a dry-run preview and a per-row error list are real,
separate work at roughly the size of this increment's other pieces
combined, not a corner to cut silently inside a sprints port. _(The
file-picker half is no longer true as written — `expo-document-picker`
landed with Chat's own composer-attaching increment, "Chat, complete"
below. The dry-run-preview-and-per-row-error-list half is still real,
separate work; left as written rather than edited, per this file's own
habit of correcting a stale claim in place instead of silently rewriting
it.)_ Export ships:
`work.cards.export`'s output is a plain string, wrapped in the same
`Share.share` pattern `export-data-section.tsx`'s DSAR export already
established — the one wrinkle is that `export` is a tRPC QUERY, not a
mutation, so `exportCsv` is a `useMutation` wrapping an on-demand `.query()`
call, the same shape `export-data-section.tsx` and `people.profile.
exportMine` already use for the identical reason (a query invoked as a user
ACTION, not data the screen needs to render).

`card/[cardId].tsx` also gained a `SprintSelector` — a chip row matching
`PrioritySelector`'s own shape rather than web's `<select>` (this app has
no native picker component). `assignSprint`/`releaseSprint` are dedicated
`card:update` routes, not part of `cards.update`'s full replace, so this
calls them directly rather than going through `useUpdateCard`/`CardPatch`.
A CLOSED sprint (`completed`/`cancelled`) still renders when the card is
currently in one — so the card shows where it shipped — but only as the
current selection, never offered as a destination: `isOpenSprint` is the
same check the sprints screen's own Move sheet uses.

**Every branded-id cast this file initially had (`as CardId`, `as
SprintId`, `projectId as never`) turned out to be unnecessary and was
removed.** `idSchema()` (`packages/contracts/src/ids.ts`) validates with
`.regex().transform()`, so a branded schema's Zod INPUT type — what a tRPC
`.mutate()`/`.query()` call actually has to satisfy — is the pre-transform
plain `string`, not the branded output type. `board/[boardId].tsx`'s
existing `move.mutate({ targetListId: list.listId })` already relied on
this without comment; ESLint's `no-unnecessary-type-assertion` is what
caught it here, on every cast this file had, rather than it being
noticed by inspection.

## Chat, closer to complete: thread replies, edit/delete, "remove for me", read receipts, link unfurls

The next item after Sprints, per the user's own choice between finishing Chat + push,
starting Docs, or starting Voice/RTC: close the largest remaining gap this
file's own Chat sections kept naming — `channel/[channelId].tsx`'s header
listed "thread replies... edit/delete... typing indicators, read receipts...
link unfurls, and push" as still out of scope. This increment closes
thread replies, edit/delete, adds "remove for me", and closes read
receipts and link unfurls; typing indicators, attachments from the
composer, and push are still open (see below).

**Replies live in the same `chat.messages.list` page as their root, and
that fact is the whole design.** Nothing new to fetch for the main channel
view — a reply is just a row with `parentMessageId` set — so `channel/
[channelId].tsx` now filters to `topLevel` (`parentMessageId === null`)
before grouping, exactly the way `apps/web`'s own `chat-page.tsx` filters
its identically-named `topLevel`; without it a reply would render twice,
once inline and once inside its thread. `replyCountsOf` (`chat.ts`, with
its own test) is the same "count by parent id" computation web makes
inline, over the SAME already-loaded page — no second query for a number
already sitting in memory.

- **`app/(app)/thread/[messageId].tsx`** (new) — the thread screen, a
  pushed route rather than web's right-hand panel (this app has no
  side-by-side layout to spare). Takes `messageId` as the path param and
  `channelId` as a second param via `router.push({ pathname, params })` —
  a thread has no meaning without knowing which channel's cache to read.
  **The root message comes from `channel/[channelId].tsx`'s already-loaded
  `messages.list` query, not a second fetch** — reaching this screen is
  always a push FROM the channel screen, which stays mounted underneath in
  the real `<Stack>` (see "A real `<Stack>`" above), so
  `messagesQueryKey(channelId)` is a cache hit, the identical reasoning
  web's own header gives for reading `rootMessage` off the page already on
  screen. Replies come from `chat.messages.thread`, one level deep only —
  `message.service.ts`'s own limit (a reply cannot itself be replied to),
  so the channel screen's long-press menu only offers "Reply in thread" on
  a message whose OWN `parentMessageId` is null. **No reactions, edit,
  delete, or "remove for me" on a reply — matching web's `ThreadPanel`
  exactly**, which is web's actual scope (its `renderPlain` draws the same
  bare author/timestamp/body/"edited" row with no per-message controls),
  not a mobile-only cut.
- **`src/lib/message-composer.tsx`** (new) — the plain-text
  `TextInput` + trailing-`@`-mention dropdown, extracted out of
  `channel/[channelId].tsx` once the thread screen needed the identical
  block. Purely presentational: `draft`/`pendingMentions` stay owned by
  each CALLER, so "clear the draft only once send succeeds, leave it on
  failure" — the established behavior — is one `onSuccess` handler per
  screen, not a callback the shared component would need to expose.
- **Edit** (`chat.messages.edit`) is AUTHOR-ONLY with no server override —
  the same reasoning as Work's comments (CLAUDE.md §8.2) and web's own
  message toolbar: nobody else's edit would ever succeed, so the option is
  hidden rather than shown-and-refused. It reuses `plainParagraph`
  (`@taskflow/api/richtext`), not `buildMessageBody` — an edit does not
  re-open mention composing, the same boundary `card/[cardId].tsx`'s
  comment composer already draws for its own plain-text field. Renders as
  an inline `TextInput` replacing the bubble's `RichTextView`, the same
  "seed once, explicit Save" shape `card/[cardId].tsx`'s `TitleField` uses.
- **Delete is two actions, Slack-style, exactly as web splits it.** "Remove
  for me" (`chat.messages.hide`, `message:read`, offered to everyone) only
  changes the viewer's own list — no tombstone, no event. "Delete for
  everyone" (`chat.messages.delete`) is author OR moderation; the CLIENT
  gates the button on `authorId === viewerId || channel.data.capabilities.
moderate` (the server's own verdict, never a role check) and hides it
  rather than showing-and-refusing for anyone who is neither, but the
  SERVICE still decides which permission actually applies once it knows
  the author — the client sends the identical route call either way.
- The long-press action sheet (`channel/[channelId].tsx`, renamed from
  `reactingTo`/quick-react-only to `actionsFor`) now offers, in order:
  quick reactions, Reply in thread (only on a top-level message the
  caller can post to), Pin, Edit (own messages only), Remove for me,
  Delete for everyone (own or moderator) — each hidden rather than shown
  disabled, per this file's own established rule for every other
  capability-gated control.

**Read receipts split the same way `apps/web` splits them: one screen
ADVANCES the cursor, a different one DISPLAYS the badge — no socket
needed for either half.** `channel/[channelId].tsx` gained a `useEffect`
that calls `chat.channels.markRead` whenever the newest TOP-LEVEL message
id changes (opening the channel, sending, or a refetch picking up someone
else's message) — `markRead` itself refuses to move the cursor backward,
so re-firing on an unchanged id is harmless, which is what makes the
effect's dependency safely just the id rather than a one-shot mount flag.
`(tabs)/chat.tsx` gained an unread-badge query, `chat.channels.
unreadCounts` polled every 15s, mirroring web's own `unreadCountsQuery`
exactly — a badge running a few seconds stale after reading a channel
elsewhere is the accepted tradeoff web's own header already names.
`unreadCountsQueryKey` (`chat.ts`) puts the channel-id array INSIDE the
key (so each distinct roster gets its own cache entry) while `markRead`'s
own `onSuccess` invalidates the bare `['chat.channels.unreadCounts']`
PREFIX — TanStack Query matches a shorter key against every longer one
that starts with it, so the mutation does not need to know the live
channel-id array to invalidate whatever it produced. **No "new messages"
divider** — web's own `entryCursor`/`firstUnreadAfter` machinery, a real
but separate refinement; this increment closes the badge, not the divider.

**Link unfurls are read-only, chunked the same way reactions already
are.** `chat.unfurls.list` takes `channelId` + `messageIds`, so
`channel/[channelId].tsx` fetches it in 25-id batches over the loaded
page — the same `maxURLLength` ceiling `reactionsQuery`'s own header
names, hit against the identical `httpBatchLink` config. `groupPreviews`
(`chat.ts`, with its own test) groups the flat rows by message id, the
same "group by a key" shape `groupReactions` already is. The SERVICE
already filters to resolved rows only (`unfurl.service.ts`'s
`previewsFor`: a `pending`/`failed`/`refused` row "is not something to
render, and sending it would tell every reader which links the SSRF
control blocked"), so `UnfurlPreview`'s own header notes there is no
`status` to branch on client-side — every row this type describes is
ready to show. `LinkPreviewList` renders one card per preview (site name,
title, description) between the message body and its reaction bar, the
same order web's `MessageRow` draws attachments/previews/reactions in;
tapping a card calls `Linking.openURL` directly — the URL came from the
server's own unfurl record, not a client-sanitized document, so there is
no whitelist to re-check the way `rich-text-view.tsx`'s `link` mark does.

**Still explicitly out of scope, all real and separate work**: mentions
autocomplete beyond the trailing-query case (mid-string insertion needs a
real editor — unchanged from before this increment), file attaching from
the composer (a new file-picker dependency, the same deferral `sprints.ts`
already named for CSV import), and push (FCM/APNs — the largest remaining
piece, and the most device-dependent, closed next — see "Push
notifications" below). Typing indicators closed after push — see "Chat,
live" further below.

## Push notifications (Wave 3 §9) — code complete, infrastructure not

The last named item in "finish Chat + push" — chosen explicitly over
building typing indicators (a live-socket project) after Chat's other
gaps closed. Touches `packages/db` (a ⚠ human-review surface per
CLAUDE.md), so the design decisions below are worth reading in full before
merge, not just the diff.

**A new `platform.expo_push_tokens` table (migration 0082), not a widened
`platform.push_subscriptions`.** `ai/phase-14-mobile.md` §9 originally
assumed the existing web-push table would just gain native rows; building
it showed why that was wrong. A web-push subscription is `(endpoint,
p256dh, auth)` plus RFC 8291 encryption; an Expo push token is one opaque
string the server holds no key material for at all — Expo's own relay
encrypts to the device on our behalf. Making `push_subscriptions`
polymorphic would have touched a table `notification-push.ts` already
depends on, for no benefit over a second table with the IDENTICAL RLS
shape (self-scoped CRUD; `taskflow_audit` gets SELECT/UPDATE/DELETE and
no INSERT — registration is always the person's own act through the
application role). §9's own text has been corrected in place to say so,
per this codebase's own "leave the stale claim, note the correction"
habit rather than silently rewriting it.

**`ExpoPushProvider` (`apps/api/src/platform/push-provider.ts`) calls
Expo's own relay, not FCM/APNs directly** — the implementation
`push-provider.ts`'s own header predicted before a mobile app existed
("the day a mobile app exists, FcmPushProvider/ApnsPushProvider implement
the same shape"). Needs no server-held secret to construct at all: unlike
VAPID (a key pair THIS server signs with), the credentials that make a
send actually reach a device — an Apple Push key, an FCM service account
— live in the EAS project's own configuration, not in this repo or its
env. `EXPO_ACCESS_TOKEN` is optional and only raises rate limits.
`notification-push.ts`'s drain loop now fans ONE pending delivery out to
BOTH `PushProvider` (web) and `ExpoPushProvider` (native) destinations a
person has, independently — a deployment can run either, both, or
neither, and someone signed in on a browser and a phone gets the message
on both rather than one arbitrarily chosen channel. Getting the
"sent"/"pending"/"failed" bookkeeping right across two independent
channels (one row, two fan-outs, a transient error on one channel must
never mark the row failed if the OTHER channel already delivered it) took
a real rewrite of that loop's outcome tracking — see its own header.

- **`src/lib/push-notifications.ts`** — the registration ceremony:
  permission, an Android notification channel, an Expo push token
  (`getExpoPushTokenAsync({ projectId })`, reading `app.config.ts`'s own
  `extra.eas.projectId`), and registering it with the server.
  `expo-notifications` is loaded lazily, never as a static top-level
  import — the FIFTH time this exact "a native module's entry file calls
  `requireNativeModule` at its own top level, and a static import poisons
  Metro's whole module graph before a single screen renders" bug shape has
  been named in this codebase (after `device-key.ts`, `biometric-
gate.native.ts`, `passkeys.ts`, `qr-code.tsx`). **Registration is
  explicit, never automatic on launch** — the identical consent-first call
  web's own push checkbox already makes, and also just the platform-review
  norm: prompting for notification permission before someone has done
  anything is the pattern every mobile guideline warns against.
  `registerForPushNotifications` never throws — every failure (permission
  denied, no EAS project configured, no token returned, a refused
  registration call) folds into one `PushRegistrationResult`, so the
  section component needs one branch, not a try/catch around a promise
  that sometimes rejects.
- **`src/lib/notification-path.ts`** — mobile's OWN translation of the
  WEB-shaped path a delivered notification's `data.path` carries
  (`/chat?channel=X`, `/boards/X?card=Y` — `apps/api/src/platform/
notification-paths.ts`'s own routing shadow, sent verbatim to both
  channels). Web's route shape has no relationship to this app's
  segment-based routes (`/channel/[channelId]`, `/card/[cardId]`), so a
  raw `router.push(webPath)` would 404 on every tap. Returns `null` for a
  shape this app has no screen for yet (`/docs?...` — no Docs feature on
  native at all; `/settings` — a membership-change link with no mobile
  equivalent) rather than guessing. **A separate file from
  `push-notifications.ts` specifically so it stays unit-testable** —
  `push-notifications.ts` imports `react-native` and `expo-constants`,
  and `react-native`'s own source fails to even PARSE under Vitest (Flow
  syntax), the identical "split for testability" call `config.ts`'s own
  header already makes for `app-session.ts`'s `Constants` read. Found by
  writing the test, not by inspection: the first version of this function
  lived inline and its test suite failed with a Rolldown parse error
  before a single assertion ran.
- **`_layout.tsx`** gained the tapped-notification listener
  (`attachNotificationResponseListener`), mounted unconditionally — the
  identical "runs for the app's whole lifetime, not tied to auth state"
  placement its own `AppState` listener already uses, and for the same
  reason: listening for a tap costs nothing and prompts no permission,
  unlike registering (which only ever runs from the account screen's
  button). Also configures FOREGROUND display via
  `setNotificationHandler` — without it, a push arriving while the app is
  already open is silently swallowed rather than shown, which is
  `expo-notifications`' own default.
- **`src/lib/push-notifications-section.tsx`** — the account-screen UI:
  "Enable on this device" plus a registered-device list with Remove,
  mirroring web's `NotificationPreferencesSection` push half. **The
  category/channel preference MATRIX that section also renders is
  deliberately NOT ported** — no screen on native reads
  `notifications.prefs.*` at all yet, and `direct.push` already defaults
  to enabled server-side, so registering a device here starts real
  delivery for mentions/DMs/assignments with no preference edit needed.
  Editing preferences is real, separate work.
- **`apps/api/src/identity/sessions.service.ts`'s `pushDeviceCount`** —
  found stale while wiring this in, fixed the same day: it counted only
  `platform.push_subscriptions` (web), so a mobile-only user who never
  opens a browser would have shown 0 registered devices on `/account`'s
  existing "Push notifications are active on N devices" line despite push
  genuinely being on. Now sums both tables.

**Still structurally blocked, the identical wall passkeys and biometric
app-lock already hit in this codebase**: a real send needs EAS push
credentials (an Apple Push key, an FCM service account) that only the
account owner can configure in EAS's own dashboard — nothing in this repo
can stand those up. Until then, `registerForPushNotifications` fails
cleanly with an honest reason rather than a silent no-op, exactly like
passkeys' own ceremony does against a domain with no hosted association
files. Getting past that point is also the first time this whole path can
be exercised end-to-end at all; see this file's own "Not here yet"
section for the same standing caveat applied to every other real-device-
only primitive.

## Chat, live: typing indicators + broadcast-driven refresh

The last named gap against web's Chat surface, closed after push. Unlike
push and passkeys this needed no external infrastructure this repo cannot
stand up — the `/chat` namespace's wire protocol (`channel:join`,
`typing:start`/`typing:stop`, the `typing` broadcast) has existed in
`apps/realtime` since Phase 5 with zero server-side changes required; the
gap was entirely that nothing on native had ever joined a chat-equivalent
socket room.

**`src/lib/chat-socket.ts`** is a second Socket.io connection (`/chat`,
not `/socket.io`'s default namespace), mirroring `socket.ts`'s own
DI-factory `createMobileSocket` shape byte-for-byte — same lazy connect,
same reconnect-replay (`joinedChannels`, recorded before the emit, not
inside the ack), same native-client marker via `extraHeaders`. Structurally
this also mirrors `apps/web/src/lib/chat-socket.ts`, which documents the
same fact from the other side: calling `io()` again with a different
namespace path but the same base URL/transport options reuses the existing
Engine.IO Manager rather than opening a second transport, so this is one
extra namespace, not one extra connection. Its `ChatSocketDeps` carries no
`onSessionEnded`, unlike the board socket's `SocketDeps` — this namespace's
own `session:ended` handler tears down only its own connection; clearing
the session itself stays `gatewaySocket`'s job, exactly the split web's two
socket files already draw. Wired into `app-session.ts` as a second
module-level singleton (`chatSocket`), alongside `gatewaySocket`.

**`src/lib/use-chat-room.ts`** is the mobile counterpart of
`apps/web/src/features/chat/use-channel-room.ts`, mounted from
`channel/[channelId].tsx` for the first time. It joins the channel's room,
tracks typing users with the identical per-user `setTimeout` scheme web
uses (reset on each `typing:start`, cleared on an explicit `typing:stop`
or after `TYPING_TIMEOUT_MS = 4000` with no signal — "the absence of a
signal must still resolve to a safe state," the same reasoning presence
uses elsewhere), and dispatches every `broadcast` event to the same
invalidate-not-patch handling web's `applyBroadcast` already does, for the
identical reason: `message.sent`/`message.edited` carry only an excerpt,
never the full TipTap body or an `authorId`, so patching would render a
message with no author line.

**This closes more than the typing label.** Until this increment,
`channel/[channelId].tsx` only ever refetched from a LOCAL mutation's own
`onSuccess` — nothing joined a room, so a message someone else sent, an
edit, a reaction, a pin, or a membership change never appeared without a
manual pull-to-refresh. Joining the room typing needs anyway makes all of
that live as a direct consequence, not a separate feature bolted on.

`describeTyping` (`chat.ts`, with its own test coverage now — web's
version is inline and untested, since it has no reason to be its own
module there) is a verbatim port of `chat-page.tsx`'s copy: one name, two
names joined with "and", or a count, never a list that could run past a
phone's width.

**Scoped to the main composer only, matching web exactly**:
`thread/[messageId].tsx`'s reply composer wires no typing signal either
there or on web — `startTyping` fires on every keystroke, no debounce,
and `stopTyping` fires right before the message actually sends (mirrors
`chat-page.tsx`'s three call sites: the ordinary send path, slash
commands, and file-share sends — file-share sends joined the native
composer next, see "Chat, complete" below, so both call sites now apply
here too).

## Chat, complete: attaching a file from the composer

The last named Chat gap, closed after typing indicators — Chat is now at
full parity with web. Ported from `apps/web/src/features/chat/api.ts`'s
own `uploadMessageFile` and `chat-page.tsx`'s `attach` mutation.

**Three new files, split for the same testability reason
`notification-path.ts` already established**: `upload-message-file.ts` is
the presign/PUT/confirm orchestration, with zero `react-native` import of
its own — DI'd (`UploadMessageFileDeps`) rather than calling `apiClient`
inline the way web's version does, purely so it stays unit-testable the
way `push-provider.test.ts` already tests its own fetch-driven send path
(`presign`/`confirm` stubbed, the PUT exercised against a stubbed global
`fetch`). `pick-attachment.ts` is the native-touching half:
`expo-document-picker` loaded lazily — the SIXTH time this codebase has
hit the "a native module's entry file calls `requireNativeModule` at its
own top level, and a static import poisons Metro's whole module graph"
bug shape, after `device-key.ts`, `biometric-gate.native.ts`,
`passkeys.ts`, `qr-code.tsx`, and `push-notifications.ts`. `accepted-file-
types.ts` is a small MIME-only sibling of web's own `accepted-file-
types.ts` — a courtesy for the picker's `type` filter, not a control; the
real enforcement stays server-side in `packages/security/src/
magic-bytes.ts`, unchanged.

**`PickedFile.sizeBytes` comes from the fetched `Blob`, not the picker
asset's own `size` field — the one real divergence from a straight
port.** A browser's `File.size` is always accurate, so web's version never
had to think about this; `expo-document-picker`'s `DocumentPickerAsset.
size` is `undefined` on some Android content providers, and even where
present is OS-reported metadata rather than the exact byte count about to
be sent. `presign`'s `sizeBytes` PINS the upload signature
(`packages/storage`'s `signableHeaders` — CLAUDE.md's own Phase 3
attachments section), so what gets declared must be exactly what gets
PUT. `pick-attachment.ts` reads the picked file into a `Blob`
(`fetch(uri).then(r => r.blob())`, the standard React Native idiom for a
local file URI) and hands that same `Blob` on as the PUT body, so
`blob.size` and the declared `sizeBytes` can never disagree.

**Send-then-attach, exactly as web does it and for the same reason**: an
attachment hangs off a message, and until one exists there is no channel
to authorize the upload against (`attachment.service.ts`). The current
draft is sent if there is one, otherwise a short "Shared **filename**"
message (`plainParagraph`, already imported for the edit mutation — not a
new helper), and `chatSocket.stopTyping` fires the same as an ordinary
send. No toast library on this app (established convention — see
`push-notifications-section.tsx`'s own plain inline-`Text` pattern), so
upload progress and the clean/infected/rejected verdict both render as a
small status line above the composer instead: `uploadStage` while it is
in flight, then `uploadNotice` once it settles.

**The attach control is a plain text button ("📎 Attach a file") above the
composer, not inline with Send** — `MessageComposer` is shared with
`thread/[messageId].tsx`, which has no attach affordance (matching typing
indicators' identical scoping above), so this stays a sibling element in
`channel/[channelId].tsx` rather than a new prop threaded through the
shared component for a feature only one of its two callers needs.

## Work, closing the gap against web: My Tasks grouped + sprint scope

The first slice of a broader pass bringing `apps/mobile`'s Work surface
(My Tasks, Boards, card detail) up to what `apps/web`'s own Work feature
already offers — audited section by section against
`apps/web/src/features/work/*`, starting here since it was both the
smallest gap and the one named first. My Tasks had been a flat,
ungrouped list since Wave 2; it is now ported from
`apps/web/src/features/work/home-page.tsx` in full.

**`groupCardsByDue` (`work.ts`) is `grouping.ts`'s `groupCards('due', ...)`,
narrowed to the one grouping this screen needs** — not the full five-way
`GroupBy` union (`list`/`status`/`assignee`/`priority`/`due`). The other
four are board-scoped concerns (a board's own group-by control is real,
separate work — see "Boards" below), so carrying them here would be dead
code; `dueBucketOf`'s bucketing (overdue / today / this week / later / no
due date) is ported verbatim, with its own test (`work.test.ts`) pinning
the clock the same way `formatDueDate`'s tests already do. `SectionList`
— React Native's own sectioned-list primitive — renders the buckets; no
new dependency, and it virtualizes exactly like the `FlatList` it
replaced.

**The sprint scope pills (All / This sprint / Backlog) mirror
`home-page.tsx`'s own `scope` state, including "offered only when a
sprint is actually running."** `ACTIVE_SPRINTS_QUERY_KEY` (`sprints.ts`,
new) reads `work.sprints.active` ORG-WIDE — no `projectId` — for the
identical reason web's own comment gives: My Tasks spans every board, so
"this sprint" has to mean membership in ANY active sprint, not one
board's. Reuses `isOpenSprint`'s sibling reasoning rather than inventing
a second membership check.

Status stays deliberately absent, matching web exactly — Wave 2's own
investigation into why is unchanged (status definitions are per-project;
My Tasks spans many projects at once).

## Work, closing the gap against web: Boards — create card, create list, WIP limits, list options

The second slice of the Work parity pass, following My Tasks. Audited
against `apps/web/src/features/work/list-column.tsx` and `add-list.tsx`:
`board/[boardId].tsx` could previously only READ a board that already
existed, with no way to grow one at all — no "+ Add card", no "+ Add
list", no WIP limit shown, no way to rename or archive a column. All
four close in this increment; **column REORDERING (web's own left/right
buttons) does not** — see this screen's own header for why it is called
out as a separate, explicit gap rather than silently skipped.

**Add Card ported the two non-obvious behaviors web's own comments call
out, not just the happy path.** The field clears on SUBMIT, not on
success, and restores the typed title only if the box is still empty on
failure — someone who already started the next card must not have it
overwritten by the previous one's recovery. And there is still no
optimistic insert: a card's reference (`WEB-142`) is server-assigned from
a per-project counter, and a number that changes under the reader a
moment later is worse than one that appears a moment late.

**The WIP limit is displayed, never enforced — the same §10.1 rule
`card-row.tsx`'s "no drag-and-drop" header already lives by.** A tab now
reads `count` or `count/limit`, the limit half turning to a warning color
once the column is over — `cards.move` reports the breach and completes
the move regardless. Blocking someone from recording work already in
progress stops them using the board, not the work.

**List options (rename / WIP limit / archive) open on a LONG PRESS of a
tab** — the same gesture `channel/[channelId].tsx` already uses for a
message's action sheet, chosen over a per-tab "⋯" button a narrow chip
has no room for without crowding the name and count it already shows. An
empty WIP-limit box means "no limit" (`null`), not zero — zero would
render the column as permanently over its limit, the identical footgun
web's own `ListMenu` comment names.

## Work, closing the gap against web: card detail's status, assignees, and labels

The third slice of the Work parity pass, following My Tasks and Boards.
Audited against `apps/web/src/features/work/detail/status-priority-
section.tsx`, `assignee-section.tsx` and `label-section.tsx`: card detail
could edit title, priority and sprint, and nothing else — status,
assignees and labels were entirely absent, not even shown read-only.
Checklist interactivity, custom fields, attachments, and comment
edit/delete are still open — see "Not here yet" below.

**`StatusSelector` is a chip row, not web's `<select>`** — the same
substitution `SprintSelector` already made for the identical reason (no
native picker component on this app). `work.statuses.list` is
PROJECT-scoped vocabulary, the same tier `sprints.ts` already places
sprints at, and `cards.setStatus` is a dedicated mutation rather than
riding `cards.update`'s full replace — mirroring the server's own split
in `card.service.ts` (status changes emit `card.status_changed`;
priority does not).

**`AssigneeSelector` is a MODAL picker, not a wall of chips — the same
call web's own header makes, for the same reason: an org's member list
can run to dozens of people**, and scrolling past fifty names inline to
find one checkbox is the bug both platforms avoid. Sends the WHOLE SET on
every tap (never a delta, matching `cards.assign`), and every tap fires
immediately rather than disabling the control while pending — assigning
two or three people in a row is the normal gesture. Unlike status and
labels, an assignee change also invalidates `MY_TASKS_QUERY_KEY`: it is
the one field among the three that changes whether the card appears on
that screen at all.

**`LabelSelector` stays an inline chip row, unlike assignees** — a
project's label set is typically five to eight entries, well under the
threshold that pushed assignees into a modal. Reuses the same two-
permission split web's own header documents (`card:update` to tag,
`project:update` to manage the vocabulary), shown to everyone with the
server as the only adjudicator. `nextLabelColor` (`work.ts`) is
`label-section.tsx`'s own `nextColor`, ported verbatim — a fixed palette
cycled deterministically, never `Math.random()`.

## Work, closing the gap against web: interactive checklists

The fourth slice of the Work parity pass. Checklists had been COUNT-only
since Wave 2 — `checklistDone/checklistTotal` read straight off
`CardDetail`/`CardSummary` and rendered as a badge, with no way to see an
item, tick it, or add one. Ported from `apps/web/src/features/work/
detail/checklist-section.tsx` in full: multiple checklists per card,
adding/deleting a checklist, adding/ticking/deleting an item.

**Ticking and deleting an item are optimistic; creating a checklist or
adding an item are not — the same split web's own comments draw, for the
same reasons.** A checkbox that waits for a round trip before it fills in
is the canonical "this app feels slow," so `toggleItem`/`deleteItem`
patch the checklist query directly (via `onMutate`/rollback-on-`onError`,
since this screen has no shared `useOptimistic` helper the way
`use-update-card.ts` does — checklists are the first card-detail mutation
on native to need a snapshot-and-rollback of its own). Creating a
checklist or an item stays round-trip: the new id comes from the server,
and a row that cannot be deleted until the refetch lands is worse than
one that appears a moment late — the identical "no fake reference"
reasoning `board/[boardId].tsx`'s own Add Card already lives by.

**Every mutation invalidates the card AND the board's card list, not just
the checklist query — a real gap the other five card-detail sections
above still have.** Checklist counts render in two places at once now
that `board/[boardId].tsx` exists (`CardRow`'s badge and this screen's
own badge row), and the server recomputes those counters inside the
writing transaction rather than incrementing them (`counters.ts`)
precisely so the number is never a guess. `StatusSelector`/
`PrioritySelector`/`AssigneeSelector`/`SprintSelector`/`LabelSelector`
above predate `board/[boardId].tsx` rendering `CardRow` at all — from
back when `use-update-card.ts`'s own header could honestly say "mobile
has no board view yet" — and none of their invalidation sets were widened
to match once that stopped being true. None of those five fields render
on a `CardRow` badge today, so nothing is visibly wrong yet, but it is a
real, separate follow-up rather than something this increment silently
carries forward.

## Work, closing the gap against web: custom fields

The fifth and final "vocabulary" slice of the Work parity pass, following
status, assignees, labels and checklists. Ported from `apps/web/src/
features/work/detail/custom-field-section.tsx` in full — all seven field
types (`text`, `number`, `date`, `checkbox`, `select`, `multi_select`,
`user`), defining a new field, and setting its value on a card.

**Two deliberate divergences from a straight port, both to stay honest
about what this app actually has, not to add capability web doesn't
carry.** `type: 'user'` falls through to the plain-text default —
matching web's OWN `FieldInput` exactly, which has no specialized picker
for it either (visible in that file's own field-type list: every other
type gets an `if` branch, `user` does not). Building a nicer member
picker here — this app already has one, from `AssigneeSelector` — would
make mobile more capable than web in an undocumented way the two
platforms would then quietly disagree about; the point of this whole pass
is parity, not exceeding it by accident. `date` is a plain `YYYY-MM-DD`
text entry rather than a calendar control, for the same "no date-picker
dependency added yet" reason a card's own due/start dates are still
uneditable — this is the first PARTIAL exception to that stance (a
project-defined field can now hold a typed date; the card's own due/start
columns still cannot be edited at all), typed by hand rather than picked,
which is real but working.

**`select`/`multi_select` reuse the same chip-row idiom `StatusSelector`/
`LabelSelector` already established** rather than inventing a `<select>`
substitute — a project's field option list is the same "handful of
values" scale labels are. `AddFieldForm`'s type picker is a chip row for
the identical reason.

## Work, closing the gap against web: attachments on a card

The sixth and final card-detail section this pass closes, following
status, assignees, labels, checklists and custom fields — card detail is
now at full parity with `apps/web/src/features/work/detail/*.tsx`.
⚠ Human-review surface (CLAUDE.md §2.2: any file upload/download path).

**`upload-card-attachment.ts` is a SEPARATE module from Chat's own
`upload-message-file.ts`, structurally identical, rather than one shared
uploader** — mirroring how `apps/web` itself keeps two independent
`AttachmentSection` components (Chat's and Work's) rather than a generic
one, and CLAUDE.md §6's own "extract at three, not two." The one real
difference: `presign` here takes a `cardId` directly, with no
`messageId`-style "send first" step, since a card — unlike a chat
message — already exists by the time its detail screen can attach
anything to it. `pick-attachment.ts` (the device-picker half) is reused
completely unchanged; it never had any chat-specific coupling.

**The same two rules Chat's own attach flow already lives by, restated as
their own separate human-review surface**: a successful PUT is never
treated as a successful upload (the object exists in storage the moment
the PUT finishes and nothing can prevent that — only `confirm`'s verdict
decides whether anyone is ever handed a download URL), and a download is
offered ONLY for `status === 'clean'` — `presignDownload` refuses every
other status with a 404, so the control would be a button that cannot
work on `pending` and one that must not on `infected`.
`ATTACHMENT_STATUS_TEXT` is `apps/web`'s own `STATUS_TEXT`, ported
verbatim — a `Map`, not a `Record`, because the status comes from the
server as a plain string a `Record` would TYPE as known while being
`undefined` at runtime for a status this build has never heard of.

## Work, closing the gap against web: comment edit/delete/replies — Work parity complete

The final slice of the Work-parity pass named at its start (My Tasks,
Boards, card detail). Comments were read+post only since Wave 2; ported
from `apps/web`'s own `CommentSection` in full: edit, delete, and one
level of replies. Every card-detail section named against
`apps/web/src/features/work/*` at the start of this pass is now shipped —
**Work is at full parity with web.**

**Edit is a client-side IDENTITY check (`comment.authorId === viewerId`),
not a role decision** — the same distinction `LabelSelector`'s own header
draws elsewhere on this screen. There is no server override, ever
(`updateComment`), so showing Edit to anyone but the author could only
ever end in a refusal; hiding it is not re-deriving authorization, it is
recognizing there is no legitimate outcome to gate. **Delete stays
visible to EVERYONE, unconditionally** — moderation is a real,
server-adjudicated path (author-or-moderator), so unlike Edit this one
genuinely needs the server's answer rather than a client guess.

**Neither Edit nor Delete is optimistic, unlike web's own version** — a
deliberate simplification, not an oversight. Web's optimism exists
because POSTING itself is optimistic there (a fake `pending:` id scheme
`CommentSection`'s own header documents in detail); posting stays
round-trip on native, as it already was, so there is no existing
optimistic-list machinery for Edit/Delete to plug into. This matches
every other already-shipped card-detail section on this screen
(status/assignees/labels are round-trip too) rather than introducing a
one-off exception just for comments.

**Replies are ONE level, matching the service exactly** —
`comment.service.ts` refuses a reply to a reply, so `repliesOf` only
ever needs two tiers, and the Reply control is passed to top-level
`CommentRow`s only, never to a reply's own row.

**`@mention` composing in the comment box is explicitly NOT ported** —
that lives only in Chat's message composer (`message-compose.ts`), which
has its own trailing-`@`-query dropdown machinery. Building a second,
independent mention-composing surface for Work comments is real,
separate work, not something to fold silently into "closing the gap."

## Not here yet

- **Confirming this on a simulator or physical device beyond what has
  already run.** The app has now actually been installed and driven on a
  real development build — sign-in, the org picker, "My Tasks", and card
  detail have all been exercised live, and that live run is exactly what
  found the navigation-shell gap this file's newest section fixes. What is
  still unconfirmed: `isNativeClient`'s own header names what a real-device
  run would need to confirm about `Origin` on RN's WebSocket transport (see
  `apps/realtime/src/auth.ts`) — nothing has joined a socket room yet, since
  nothing on native calls `joinBoardRoom`.

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
- **Push notifications actually being delivered.** The same structural
  gap as passkeys, not a verification one: `registerForPushNotifications`
  is code-complete, but a real send needs EAS push credentials (an Apple
  Push key, an FCM service account) configured in EAS's own dashboard,
  which nothing in this repo can stand up. See "Push notifications" above
  for the full account.
- **Passkeys actually working at all.** Not a verification gap like the two
  above — a structural one. The ceremony cannot complete without a real
  production domain, hosted `apple-app-site-association`/`assetlinks.json`
  files, and a real Android signing certificate, none of which exist yet.
  See that section's own checklist for exactly what to stand up first.
- Work is now at full parity with web (My Tasks, Boards, and all six
  card-detail sections — see "Work, closing the gap" above for the full
  account). Still genuinely open across the app: a native rich text
  EDITOR (description/comment/message composers all stay plain-text until
  one exists), `@mention` composing in Work comments specifically (Chat's
  own composer has it; Work comments deliberately do not yet — see
  "comment edit/delete/replies" above), due/start date editing on a
  CARD's own dates specifically (no date-picker dependency added yet — a
  custom field of type `date` can now hold a typed value, see "custom
  fields" above for why that is a partial exception, not a reversal),
  card drag-and-drop, and list reordering (both boards' own sections
  above have the full reasoning). The rest of Chat (attachments
  from the
  composer — reactions, mentions composing, thread replies,
  edit/delete/"remove for me", read receipts, link unfurls, push, typing
  indicators and broadcast-driven live refresh have all shipped, see "Chat,
  reworked", "Chat, closer to complete", "Push notifications", and "Chat,
  live" above) and the other product waves (Docs, RTC). Chat now joins a
  room (`chat-socket.ts`, `use-chat-room.ts`) and stays live while a
  channel screen is open; Work's `gatewaySocket` still has no caller —
  nothing calls `joinBoardRoom` yet — so every board/card screen remains a
  plain `useQuery`: fresh on navigation and on app-foreground (see
  `_layout.tsx`'s `AppState` wiring, below), not live while the screen
  stays open and nobody moves.
