# @taskflow/mobile

The Android & iOS app (Expo / React Native). Full plan: [ai/phase-14-mobile.md](../../ai/phase-14-mobile.md).

## Status — Wave 1: spine, guardrails, native auth, channel binding, the Expo shell, and the socket client

Five increments in, Wave 1's acceptance bar (§7: the three gates and one
authenticated tRPC read, on a real device, against the real API) has
everything CI can prove behind it. **A green `pnpm verify` here is not the
same claim as "this works when you click it" (§11) — nobody has run this on a
simulator or a physical device yet.** Keychain, biometrics, push and WebRTC
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

**Not in this increment, named rather than half-built (CLAUDE.md's own
rule):** passkeys, OAuth (`expo-auth-session` + an `oauth-callback` route —
the button and the callback screen have nothing to do without the PKCE flow
that drives them, so neither is here yet), biometric app-lock, and device
binding — all Wave 1b per §4.4–§4.5.

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
for the full argument, and why this is a named INTERIM gap, superseded once
Wave 1b's device-bound keypair (§4.5) gives native a real per-device proof.

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

## Not here yet

- **Running this anywhere.** No simulator or device run has happened. `pnpm
--filter @taskflow/mobile start` plus a real API reachable at
  `MOBILE_API_BASE_URL` (see `.env.example`) is the next step, before any
  further product screens. In particular, `isNativeClient`'s own header names
  what a real-device run would need to confirm about `Origin` on RN's
  WebSocket transport — see `apps/realtime/src/auth.ts`.
- Passkeys, OAuth, biometric app-lock, device binding (Wave 1b, §4.4–§4.5).
- The product waves themselves (Work, Chat, Docs, RTC) — the socket client
  exists but nothing calls `joinBoardRoom` yet.
