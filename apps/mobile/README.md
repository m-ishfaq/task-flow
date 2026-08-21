# @taskflow/mobile

The Android & iOS app (Expo / React Native). Full plan: [ai/phase-14-mobile.md](../../ai/phase-14-mobile.md).

## Status — Wave 1 complete, Wave 1b complete (passkeys infra-blocked), Wave 2 (Work) complete, Wave 3 (Chat) started

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
back directly with no resolution needed.

**Explicitly out of scope, all real and separate work**: reactions, thread
replies (`chat.messages.thread` has no caller here), mentions autocomplete,
edit/delete, typing indicators, read receipts, file attachments, link
unfurls, and push (§9's own FCM/APNs wiring — Wave 3's roadmap row names it
explicitly, and nothing here touches it). This is "channels exist and you
can talk in them," not the whole of Wave 3.

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
- **Passkeys actually working at all.** Not a verification gap like the two
  above — a structural one. The ceremony cannot complete without a real
  production domain, hosted `apple-app-site-association`/`assetlinks.json`
  files, and a real Android signing certificate, none of which exist yet.
  See that section's own checklist for exactly what to stand up first.
- Checklist items (still count-only, no per-item read or toggle), a native
  rich text EDITOR (description/comment/message composers all stay
  plain-text until one exists), due/start date editing (no date-picker
  dependency added yet), and card drag-and-drop (boards' own section above
  has the full reasoning). The rest of Chat (reactions, thread replies,
  mentions, edit/delete, typing indicators, read receipts, attachments,
  link unfurls, push) and the other product waves (Docs, RTC) — the socket
  client exists but nothing calls `joinBoardRoom`/a chat-equivalent yet, so
  every screen above is a plain `useQuery`: fresh on navigation and on
  app-foreground (see `_layout.tsx`'s `AppState` wiring, below), not live
  while the screen stays open and nobody moves.
