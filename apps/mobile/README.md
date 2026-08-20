# @taskflow/mobile

The Android & iOS app (Expo / React Native). Full plan: [ai/phase-14-mobile.md](../../ai/phase-14-mobile.md).

## Status — Wave 1, increment 1: the pure client spine

This first increment is deliberately the parts of the foundation that are **real,
testable TypeScript with no Expo runtime**, so the security-critical logic is
provable in CI now (ai/phase-14-mobile.md §11 draws exactly this line: only
type-compile and pure logic are CI-provable; Keychain, biometrics, push and
WebRTC are device-only).

Shipped here (`src/lib/`):

- **`config.ts`** — per-channel API base URL, validated at boot; the tRPC URL is
  derived, never separately configured.
- **`secure-store.ts`** — the one credential-writing seam (§4.1, §6.2). The
  real `expo-secure-store` implementation, with its accessibility class, lands
  with the Expo shell; this defines the port and an in-memory test double.
- **`session.ts`** — the in-memory access token, refresh-token custody in the
  keystore, single-flight refresh, and the mobile-specific safeguard that an
  **offline launch never deletes a valid session** (only a rejected refresh
  token does). The native token shape carries the refresh token — the §4.3
  client half of that contract.
- **`org-gate.ts`** — validates a remembered org against real memberships before
  any org-scoped screen renders (ported from apps/web's `OrgGate`).
- **`trpc-client.ts`** — the header-bearer tRPC client, typed against the shared
  `AppRouter` (guardrail 5 extended), with no cookie.

Everything transport- and storage-facing is an injected port, which is what lets
`session.test.ts` exercise token custody with no Expo runtime and no live server.

## Not here yet (later increments, each flagged in the spec)

- The **Expo shell**: `expo` / `expo-router` / `expo-secure-store`, `app.config.ts`,
  `eas.json`, the nav + auth + org gate screens, the native SecureStore and
  Preferences implementations. This is what brings the large native dependency
  tree, so it is its own step.
- The **guardrail extension** (§6): scope the client import-bans to `apps/mobile`,
  add the new mobile bans (no credential in unencrypted storage; no embedded auth
  WebView), and a `guardrail-selftest` case for the computed `apps/mobile` config.
- The **native auth path** on the API (§4.3) — a §2.2 human-review surface, built
  and reviewed on its own.
- The **realtime socket** client, and the product waves (Work, Chat, Docs, RTC).
