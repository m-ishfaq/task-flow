# Phase 14 — Mobile (Android & iOS)

Status: **DRAFT, not yet approved.** Written 2026-08-20. This draft scopes **Wave 1 only — the
mobile foundation spine**: the shared client, the native session/auth model, the socket layer,
the org gate, the navigation shell, and the guardrail story for a new rendering surface. It is
the mobile equivalent of Phases 0B–4 for the web — the base every product surface will later sit
on — and deliberately ships **no product feature**. Work, Chat, Docs, and Voice are named here as
later waves so the spine is designed to hold them, not built now.

Read this header before trusting a phase marker anywhere else. The standing lesson from Phases
3.5, 5, 7, 8 and 12 Wave 2 holds with extra force here: **a status marker is a claim, not a
fact**, and on mobile the gap between "the suite is green" and "this works when you tap it" is
wider than anywhere in this codebase — Keychain, the Keystore, biometrics, push tokens, passkeys,
and WebRTC do not exist in a Node test process at all (§11). A green CI on this phase is a
statement about type-checking and pure logic, never about a signed build on a real handset.

---

## 1. The one thing that makes this cheap, and the one that makes it hard

**Cheap: the wire contract is already shared, and mobile is a third consumer of it.**
`packages/contracts` (branded IDs, `.strict()` Zod, the `Wire<T>` restatement in
`apps/web/src/lib/wire.ts`) and the `AppRouter` type exported from `@taskflow/api/router` are the
same contract `apps/web` and `apps/api` already speak. A TypeScript React Native client imports
those _identical_ types. So the two guardrails that the whole codebase is built around —
**#1 branded IDs** and **#5 generated client** — extend to mobile for free: a drift between the
app and the API is a compile error in `apps/mobile`, exactly as it is in `apps/web`. This is the
entire reason the stack is Expo/React Native and not native Swift + Kotlin (§3): a native pair
would hand-transcribe every wire type _twice_ and turn every one of those compile errors back into
a runtime surprise, forfeiting the property this codebase spends the most effort to keep.

**Hard: the web's session security is browser-shaped, and none of its primitives exist on a
handset.** `apps/web/src/lib/session.ts` rests on a refresh token held in an `httpOnly`,
`__Host-`-prefixed, `SameSite=Strict`, **same-origin** cookie that script can never read, plus an
access token kept in memory only. A native app has _none_ of those: no same-site, no `__Host-`
cookie jar, no same origin, and nothing the OS will keep out of the app's own JavaScript the way a
browser keeps an httpOnly cookie out of `document.cookie`. The refresh token has to live in
hardware-backed device storage, and its custody is a genuinely different threat model. Redesigning
it touches `apps/api/src/identity` and `session-response.ts`, both §2.2 human-review surfaces.
**§4 is the load-bearing section of this phase.** Everything else is plumbing; that is a security
decision.

> The single most important constraint of this phase: **the change that lets a native client hold
> a refresh token must never let a browser client hold one in a response body.** The web defence
> is that the refresh token is _absent_ from every body — `session-response.ts`'s `.strict()`
> output schema is what keeps it out. Adding a native path that returns it in the body must be
> gated so tightly that the browser path cannot reach it even by accident (§4.3). If you can only
> read one section before reviewing, read that one.

---

## 2. Scope

In scope for **this phase (Wave 1)**: a shippable Expo app for iOS and Android that a real user
can install, sign in to (password + TOTP + OAuth; passkeys named for Wave 1b), select an org in,
hold a session across cold starts via hardware-backed storage, make authenticated tRPC calls
against the existing API, and open an authenticated realtime socket. Plus the CI/build pipeline
that produces a signed artifact, and the guardrail extensions that put the new surface under the
same lint the web app is under. **No product screens beyond a signed-in placeholder home.**

Out of scope, deliberately, for Wave 1:

- **Any product surface** (Work boards, Chat, Docs, Voice). Each is its own later wave and each
  reuses this spine unchanged. Building one now would design the spine around one product instead
  of all of them.
- **Offline-first / local persistence of tenant data.** The web app is deliberately
  online-and-authoritative (TanStack Query is the cache; "never mirror server data into Zustand",
  architecture.md). Mobile keeps that for Wave 1. A durable offline store is a large, separate
  security surface (tenant data at rest on a lost phone) and gets its own wave with its own
  encryption story — never smuggled in as "just a cache."
- **A public REST/OpenAPI client.** Phase 10 Wave 2's public API + scoped tokens is not built, so
  mobile targets the _internal_ tRPC surface exactly as `apps/web` does. If the public API lands
  first, mobile is a swap of the transport, not a redesign — the contract types are the same.

| Wave  | Contents                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The spine.** Expo app scaffold in the monorepo; the native session/auth model (§4); the shared tRPC/socket/org client (§5); the guardrail extension for a new surface (§6); the nav + auth + org gate shell (§7); CI/build (§10). Sign-in works; home is a placeholder. |
| 1b    | Passkeys via platform authenticators; biometric app-lock; device-bound refresh tokens (§4.5)                                                                                                                                                                              |
| 2     | **Work** — boards, lists, cards, My Tasks, card detail; the TipTap-JSON native renderer (§6.4); optimistic mutations                                                                                                                                                      |
| 3     | **Chat + push** — channels, DMs, threads, mentions; FCM/APNs wired into Phase 9 notifications (§9)                                                                                                                                                                        |
| 4     | **Docs (read + comment)** — native TipTap-JSON rendering; comments/suggestions read; live Yjs editing explicitly deferred                                                                                                                                                 |
| 5     | **Voice / RTC** — `react-native-webrtc`, CallKit / ConnectionService, ringing on any screen                                                                                                                                                                               |
| —     | Deferred: offline store, video/screen-share, telephony dialer, the public-API transport swap                                                                                                                                                                              |

---

## 3. Stack decision — Expo (React Native) + TypeScript

Chosen for one reason above all: it is the only option that keeps guardrails #1 and #5 (§1). The
secondary reasons — one codebase for both platforms, OTA-updatable JS, a managed build service
(EAS) so this repo never holds signing keys in a way a contributor can leak — are real but would
not, on their own, outweigh native fidelity. The shared contract does.

**What we pull in, and what we refuse.**

- **Yes:** `expo`, `expo-router` (file-based routing, the closest analogue to TanStack Router's
  typed routes), `@trpc/client` + `@trpc/react-query` + `@tanstack/react-query` (the web already
  uses this exact pair — server state is Query, always), `expo-secure-store` (Keychain / Keystore
  wrapper), `socket.io-client` (the web uses it; the client is platform-agnostic), `nativewind`
  (Tailwind-class semantics on RN, so the design tokens from Phase 6.5 have a path to reuse rather
  than a second styling language).
- **No, deliberately:** `@react-native-async-storage/async-storage` for **anything credential-
  bearing**. AsyncStorage is an unencrypted on-disk key-value file — the mobile equivalent of the
  `localStorage` the web session file spends three paragraphs explaining why it never touches. A
  refresh token there is a token an attacker keeps off a rooted/jailbroken or backed-up device.
  This is a §6.2 lint ban, not a code-review note.
- **No embedded WebView for auth.** OAuth runs in the system browser
  (`ASWebAuthenticationSession` / Chrome Custom Tabs via `expo-web-browser` + `expo-auth-session`),
  never an in-app WebView — an embedded WebView can read the provider's credential fields and
  defeats the entire point of delegating to the provider (§4.4).

`apps/mobile` joins the pnpm workspace (`apps/*` already globs it). Metro needs monorepo config —
`watchFolders` for the repo root and symlink resolution — because pnpm's strict, non-hoisted
`node_modules` is exactly the layout Metro historically fought. This is a known, solved Expo
setup, but it is real work and it is Wave 1 work, not an afterthought: if Metro cannot resolve
`@taskflow/contracts` through the workspace symlink, nothing else in this phase compiles.

---

## 4. The native session model — the centerpiece

Everything the web session file argues (`apps/web/src/lib/session.ts`) about _why_ the tokens live
where they do still applies; what changes is that mobile has different places to put them and a
different set of attacks to defend against. The server-side identity machinery — Argon2id, refresh
**rotation with reuse detection that revokes the whole family**, lockout, session revocation —
is reused **unchanged**. This section is entirely about token _custody and delivery_, not about
inventing a second identity system.

### 4.1 Where the two tokens live on a handset

- **Access token — in memory only.** Same as web, same reason: a module variable's blast radius
  under a compromise is that process's lifetime, and the token expires in minutes regardless.
  Never `expo-secure-store`, never AsyncStorage — persisting a short-lived bearer buys nothing and
  widens exposure.
- **Refresh token — `expo-secure-store`, and nowhere else.** That is Keychain on iOS and the
  Keystore-backed encrypted store on Android — hardware-backed, per-app, and (configured
  correctly) excluded from device backups and iCloud. The exact accessibility class matters and is
  a reviewed choice: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` — readable after the first unlock so a
  push-woken background refresh works, `THIS_DEVICE_ONLY` so a restored backup on a different
  handset does not carry a live session. The default (available even before first unlock, included
  in backups) is the wrong one and must be set explicitly.

### 4.2 The threat model actually changed — name what we lost and what we did not

The web's `__Host-` + `SameSite=Strict` + httpOnly triad bought three distinct things. On native:

- **httpOnly (script can't read it):** _lost._ Nothing keeps the app's own JS from reading a token
  the app itself must present. This is why the store must be hardware-backed and why device
  binding (§4.5) exists — the compensating controls move from the transport to the OS and the
  token itself.
- **`SameSite=Strict` (anti-CSRF):** _not a loss._ CSRF is a browser-ambient-credential attack. A
  native app sends a bearer in an `Authorization` header it constructs per request; there is no
  ambient cookie for a hostile page to ride. The web needed SameSite precisely because a cookie is
  ambient; a header bearer is not.
- **`__Host-` (origin/path binding):** _replaced, not dropped._ The binding a browser got from the
  cookie prefix, native gets from (a) a client-type-bound token that the web path refuses (§4.3)
  and (b) optional device binding (§4.5).

Writing this down is the point: "mobile is less secure because it lost httpOnly" is the shallow
reading. One of the three protections is genuinely gone and is compensated; the other two either
do not apply or are re-established elsewhere.

### 4.3 The delivery change — a native auth path, gated so the browser path can't leak

Today `auth.login` / `auth.refresh` set the refresh token in a `Set-Cookie` and `session-
response.ts` deliberately keeps it out of the response _body_. Native has no usable cookie, so the
API needs a variant that returns the refresh token **in the body** — but only to a caller that is,
provably, the native client, and never to a browser.

The design constraint is that these two must be **structurally unable to cross**:

- A native auth surface (e.g. an `auth.native.*` procedure namespace, or the same procedures
  keyed on a required `X-Taskflow-Client: mobile` context that the browser transport can never
  set to `mobile` and be believed) returns `{ accessToken, refreshToken, expiresIn, sessionId }`
  in the body. Its `.strict()` output schema _includes_ the refresh token — and is a **different
  schema object** from the browser's `SessionResponse`, so the web path physically cannot acquire
  the field by editing one shared schema. Two schemas, changed independently, is the same "two
  facts, two columns" discipline Phase 7 used for record intent.
- The refresh token minted for a native client carries a binding (audience/`typ` claim, or a
  distinct token family kind) so that presenting a native refresh token to the browser refresh
  path — or a browser one to the native path — is refused, not merely unusual. A stolen token is
  bound to the channel it was minted for.
- The web path is **untouched**. Its refresh token stays cookie-only and body-absent. Nothing in
  this phase is allowed to weaken it; the temptation to "unify" the two paths by returning the
  token in the body for everyone is the exact regression this section exists to forbid.

This is real work on a human-review surface (`apps/api/src/identity`, `session-response.ts`), and
it is the part of the phase the author reads every line of before merge.

### 4.4 Sign-in methods on native

- **Password + TOTP:** the existing flow. Login can return the `totp_required` challenge (Phase 12
  Wave 2 shipped it) and the native UI collects the code — no server change.
- **OAuth (Google/GitHub):** `expo-auth-session` with **PKCE** in the **system browser**, redirect
  to a registered app scheme / universal link. Never an embedded WebView (§3). The provider
  secrets stay server-side exactly as they are; the app holds only a public client id.
- **Passkeys (Wave 1b):** native platform authenticators — `ASAuthorization` passkeys on iOS,
  Credential Manager on Android — over the same server ceremony endpoints. This is genuinely
  _better_ than the web, where the browser ceremony is still deferred (`ai/passkey-browser-
ceremony.md`): the platform APIs are first-class and the associated-domains / Digital Asset Links
  files are a one-time deployment step. Named for 1b so Wave 1 ships with proven factors first.
- **Biometric app-lock (Wave 1b):** Face ID / fingerprint gates _reading_ the stored refresh token
  after a cold start, so a found-and-unlocked phone still can't silently resume a session. This is
  a local gate, not a second server factor — it never replaces `can()` or the token.

### 4.5 Device binding (Wave 1b, named now so Wave 1 leaves room for it)

The strongest compensation for the lost httpOnly property: mint a device keypair in the secure
enclave / StrongBox at first sign-in, register the public key with the session, and have the
native refresh exchange prove possession (sign a server nonce). A refresh token copied off the
device without the non-exportable private key is then inert. This is the native analogue of the
cookie's origin binding and it is where the "a stolen token is useless elsewhere" guarantee
actually comes from. Deferred to 1b because Wave 1's job is to establish the token custody it
hardens; shipping the binding first would be hardening a thing that does not exist yet.

---

## 5. The shared client spine — `apps/mobile` mirrors `apps/web/src/lib`

The web app's `lib/` is the reference implementation of every piece of plumbing this phase
re-homes. The mobile spine is a deliberate mirror so a reader who knows one knows the other; where
it diverges, it diverges only for a reason named here.

| Web (`apps/web/src/lib`)              | Mobile (`apps/mobile/src/lib`)  | Change, and why                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trpc-client.ts`                      | `trpc-client.ts`                | `httpBatchLink` with the same `maxURLLength` guard. `credentials` cookie option is dropped — native sends a header bearer, not a cookie. Base URL comes from config, not a proxy.                                   |
| `session.ts`                          | `session.ts`                    | Same Zustand store, same in-memory access token, same single-flight refresh. The refresh **source** changes from the same-origin cookie to `expo-secure-store` (§4).                                                |
| `config.ts`                           | `config.ts`                     | No dev proxy exists on a device; the API base URL is an explicit env value baked per build channel (dev / preview / prod), validated at boot the way the web validates its env.                                     |
| `wire.ts`                             | _(imported from a shared home)_ | The `Wire<T>` restatement is identical for every client — same JSON-over-the-wire lie about `Date`. Extract it to a shared package (or `@taskflow/contracts`) rather than copy it, so the two clients cannot drift. |
| `socket.ts`, `*-socket.ts`            | `socket.ts`, `*-socket.ts`      | The Socket.io `auth: cb => cb({ token })` handshake and the reconnect-and-replay-joins logic are platform-agnostic and port near-verbatim. The one real difference is lifecycle (§8).                               |
| `optimistic.ts`, `query.ts`           | reused as-is                    | Pure TanStack Query helpers; no DOM. Move to a shared package if a second consumer justifies it (Phase 6.5's "extract at the third instance" rule).                                                                 |
| `error-message.ts`, `field-errors.ts` | reused as-is                    | Pure functions over the `ApiError` envelope. No change.                                                                                                                                                             |

**Org context is unchanged and stays attacker-safe.** The `x-taskflow-org` header is a WHERE
filter against the caller's own memberships, never a value written to `app.org_id` — naming an org
you are not in resolves to no membership and every permission-bearing route answers NOT*A_MEMBER
(session.ts documents exactly this). The web's `OrgGate` — validate the remembered org id against
`tenancy.orgs.list` (the one read that needs no org) \_before* rendering anything org-scoped —
ports directly (§7). The remembered org id may sit in AsyncStorage: it is not a credential and
confers nothing, the same reasoning session.ts already records for `localStorage`.

---

## 6. Guardrails on a new rendering surface

The codebase's thesis — make the dangerous mistake impossible to express, fail in CI not by
vigilance — has to cover `apps/mobile` on day one, or the app becomes the one surface where the
bans don't apply. Guardrail-selftest already asserts the _computed_ ESLint config for `apps/web`
still carries every ban, precisely because a framework block that grows its own
`no-restricted-syntax` silently replaces the whole list. `apps/mobile` gets the same treatment.

### 6.1 The bans that carry unchanged

`Math.random` is banned everywhere and stays banned (guardrail 5). `node:crypto` outside
`packages/security` stays a lint error — a mobile app that needs randomness uses
`@taskflow/security` (or `expo-crypto` behind it), never an inline primitive. Raw DB access, role
comparison outside `packages/policy`, `process.env` outside the validated schema, and the domain-
event rule are all API/backend guardrails that `apps/mobile` never touches because it is a client
— but the flat-config composition at the root must still _scope the client bans to_
`apps/mobile`, and the selftest must assert the computed config for it, so the app cannot quietly
opt out by growing its own config (there is no per-package `eslint.config.js`, CLAUDE.md — that
rule now covers `apps/mobile` too).

### 6.2 New bans this surface needs

- **No credential in unencrypted storage.** A `no-restricted-imports` / `no-restricted-syntax`
  rule that flags `AsyncStorage` (and any plain `expo-file-system` write) reached from the session
  module. Credentials go through the SecureStore wrapper only. This is guardrail 5's spirit — one
  audited place per sensitive primitive — applied to token custody.
- **No embedded auth WebView.** A ban on `react-native-webview` in the auth feature, so OAuth can
  only go through the system-browser path (§4.4). A WebView elsewhere (rendering a doc preview, say)
  is a separate decision with its own review.
- **No `dangerouslySetInnerHTML` analogue.** RN has no innerHTML, which removes the web's classic
  XSS vector by construction — but it has its own: rich text (§6.4). The ban that matters here is
  that **rich text is rendered by a closed switch over the node/mark whitelist, never by feeding
  a string to any HTML/Markdown-to-native library that could execute an attribute.**

### 6.3 A `guardrail-selftest` case for the new computed config

Add a case asserting the computed `apps/mobile` config carries the global bans and the new mobile-
specific ones, mirroring the existing `apps/web` assertion. A guardrail with no self-test is a
guardrail that gets switched off — CLAUDE.md's standing rule.

### 6.4 Rich text is TipTap **JSON**, and the native renderer is a security control

"Rich text is TipTap JSON, never HTML" (guardrail 4) is _more_ convenient on native, not less: the
server already stores a validated JSON tree against a **closed** whitelist of node types, mark
types, per-node attributes, and URL schemes (`apps/api/src/work/richtext.ts` rejects an unknown
node rather than sanitizing it, and excludes `rel`/`javascript:` by construction). The native
renderer is a pure walk of that same tree into RN components — a `switch` on node type, an unknown
node rendered as an inert placeholder, `link.href` opened only after the same scheme check the
server already applied. It never touches an HTML parser. This lands in Wave 2 (Work) / Wave 4
(Docs); it is specified here so the spine reserves the seam and nobody reaches for a
markdown-to-HTML shortcut under deadline.

---

## 7. Navigation, the auth gate, and the org gate

`expo-router` file-based routes, structured as three gates the web already has, in the same order:

1. **Auth gate.** `restore()` runs at boot — read the refresh token from SecureStore, exchange it
   for an access token, settle `status` to `authenticated` or `anonymous`. Until it settles, a
   splash, never a product screen (the web's `restoring` status, ported). A failed exchange that is
   an _auth_ failure clears the session; a network failure leaves it alone (session.ts's narrow
   `isUnauthenticated` distinction ports exactly — signing a user out because the subway dropped
   wifi is the failure mode to avoid).
2. **Org gate.** The web's `OrgGate` blocks the router until the remembered org id is validated
   against `tenancy.orgs.list`, then routes to the org picker if it is stale or absent. Ported
   verbatim in intent: a check that races the first org-scoped query is no check at all.
3. **Deep links / universal links.** Registered for the OAuth callback (§4.4) and, later, for
   opening a specific card/message from a push notification (§9). Every deep-linked target is
   parsed through the shared branded-id/Zod parsers before a screen sees it — the URL is a trust
   boundary on native exactly as it is on web (`apps/web` parses route params through
   `BoardIdSchema` et al.; the app does the same), and a malformed link falls back to a safe
   screen, never an error state that leaks.

Wave 1's signed-in home is a placeholder that proves the three gates and one authenticated tRPC
read (e.g. `tenancy.orgs.list` + the caller's profile). That is the acceptance bar for the spine:
the gates work and an authorized call returns, on a real device, against the real API.

---

## 8. Realtime, RTC, and collab — what ports and what is genuinely harder

- **Socket.io (realtime spine, Phase 4):** the client is platform-agnostic; the handshake and the
  reconnect-and-replay-joins logic port near-verbatim (§5). The **real** difference is
  **background lifecycle**: iOS suspends sockets aggressively when the app backgrounds, so
  "presence" and "live updates while backgrounded" are not free the way they are in a browser tab.
  Phase 4's own design already answers this — **NOTIFY is an optimization; the poll is the
  correctness guarantee** — so a socket that drops on background and reconnects-and-diffs on
  foreground loses nothing, by the same argument that makes the web gateway correct. Push (§9), not
  a background socket, is how a backgrounded app learns something happened.
- **WebRTC (Phase 13, Wave 5 here):** `react-native-webrtc` plus **CallKit** (iOS) /
  **ConnectionService** (Android) for real incoming-call UX. The server side is untouched — TURN
  credentials are already server-minted and short-lived (`packages/security/turn-credential.ts`),
  and a call room authorizes exactly like its channel (Phase 13 §1), so the app inherits the whole
  authorization argument. This is the highest-complexity wave and is last for that reason.
- **Collab / Yjs (Phase 6, Wave 4 here):** `y-websocket` runs in RN, but a _native TipTap editor_
  is a large, separate build. Wave 4 ships **read + comment** over the native JSON renderer (§6.4);
  live collaborative _editing_ on mobile is explicitly deferred, named rather than implied.

None of these are Wave 1. They are here so the spine's socket and auth layers are designed to hold
them — e.g. the token handshake in §5 is the same one `/rtc` and collab will reuse.

---

## 9. Push (Wave 3, designed against the existing Phase 9 machinery)

Mobile push is **FCM** (Android) and **APNs** (iOS), delivered through Expo's push service or
directly. It is not a new notification system: Phase 9 already owns notification generation, and
`platform.push_subscriptions` already exists as the device/subscription table (Phase 12 Wave 2's
device inventory reads it as a source, PLAN.md). The mobile work is (a) registering the device's
push token into that existing table on sign-in and clearing it on sign-out, and (b) a delivery
adapter for FCM/APNs alongside the web-push one. A push carries an opaque reference (org + resource
id), and tapping it deep-links through the §7 parsers and _then_ fetches over an authenticated call
— the notification payload is never trusted as the content, only as a pointer, the same discipline
the search index uses ("the index answers which org, never the content", Phase 8). No tenant
content rides in a push body.

---

## 10. Build, release, and the "no secret in the bundle" rule

- **EAS Build** for signed iOS/Android artifacts, with three channels (dev / preview / prod) whose
  API base URL and public OAuth client ids differ per channel and are validated at boot.
- **A mobile bundle is fully extractable — treat it like published output.** This is the exact
  analogue of the Artifact rule that a self-contained page holds no secret: anything shipped in the
  app binary is readable by anyone who downloads it. So the app holds **only public** values —
  public OAuth client ids, the API base URL, the TURN _server_ address. Twilio credentials, OAuth
  client _secrets_, signing keys, the TURN shared secret — all stay server-side, and TURN
  credentials stay server-minted and short-lived. A CI check that greps the bundle/config for
  known-secret shapes is the mobile sibling of `pnpm check:encoding`: cheaper to prevent than to
  rotate after a leak.
- **Signing keys live in EAS, not the repo.** A contributor can trigger a build without ever
  holding the distribution certificate — the managed-service reason from §3 made concrete.
- **OTA JS updates (`expo-updates`)** are allowed for JS-only changes, but **never** carry a
  native permission change or an auth-model change silently — those go through a store review so
  the change is auditable. A security control shipped OTA is a control that changed with no review
  gate, which §2.2's whole premise forbids.

---

## 11. Testing — and the unusually wide gap between green and working

The house lesson ("a green `pnpm verify` is not the same claim as 'this works when you click it'")
is sharper here than anywhere, because the platform primitives this phase is _about_ — Keychain,
the Keystore, biometrics, push tokens, passkeys, WebRTC, the secure enclave — **do not exist in a
Node/Jest process at all.** So the test story is explicitly two-tier and the boundary is named, not
blurred:

- **What CI can prove (and what a green run therefore claims):** the shared client types compile
  against the real `AppRouter` (guardrail 5, extended); pure logic — the session store's
  single-flight refresh, the org-gate validation, the TipTap-JSON renderer's whitelist walk, the
  deep-link parsers — under unit tests with SecureStore and the network mocked; the guardrail-
  selftest computed-config assertion for `apps/mobile` (§6.3). This is real and worth having. It is
  **not** a claim that sign-in works.
- **What only a device/simulator can prove, and is therefore E2E (Detox or Maestro on a simulator,
  plus a manual real-device pass for the rest):** that the refresh token actually persists across a
  cold start in Keychain/Keystore with the right accessibility class; that OAuth round-trips
  through the system browser and back via the app scheme; that a push arrives and deep-links; that
  biometrics gate the token read; that passkeys and WebRTC work at all. **APNs, real passkeys, and
  the secure enclave are real-device-only** — a simulator does not fully stand in.

The acceptance bar for Wave 1 is stated in device terms on purpose (§7): the three gates and one
authorized read, on a real handset, against the real API. A spec that let "the suite is green"
stand in for that would be repeating the exact mistake this codebase has caught itself making in
Phases 5, 7, 8 and 12 — here it would just be easier to make and harder to notice.

---

## 12. Decisions to resolve at review

1. **Native auth transport shape (§4.3):** a separate `auth.native.*` procedure namespace, or the
   existing procedures keyed on a trusted client-type context? Both can be made structurally safe;
   the choice affects how much of `apps/api/src/identity` changes and how the two output schemas
   are kept un-unifiable.
2. **Device binding in Wave 1 or 1b (§4.5)?** Shipping it in Wave 1 hardens the token from day one
   but couples the spine to secure-enclave key management before any product rides on it. The draft
   proposes 1b; the author may want it in Wave 1.
3. **Styling: NativeWind vs a hand-rolled token layer.** NativeWind reuses Tailwind-class semantics
   and the Phase 6.5 tokens' vocabulary; a hand-rolled layer avoids a build-time dependency. Design-
   system reuse argues for NativeWind; this is an owner call, like the payments-provider call in
   Phase 12 Wave 3.
4. **`wire.ts` / shared-helper home (§5):** extract the `Wire<T>` restatement and the pure Query
   helpers into a new shared package now, or leave them in `apps/web` and import across the app
   boundary until the third consumer justifies the move (Phase 6.5's rule)? Extracting now avoids a
   copy that can drift; extracting prematurely adds a package before it is earned.
5. **Expo managed vs bare / prebuild.** Managed keeps the config surface small; some native modules
   (CallKit, certain WebRTC setups) push toward prebuild/config-plugins. The draft assumes managed
   with config plugins and revisits at Wave 5.

---

## What Wave 1 will create (file map, for the reviewer)

```
apps/mobile/
  app/                      expo-router routes: splash, (auth)/sign-in, (auth)/oauth-callback,
                            (app)/org-picker, (app)/home  ← placeholder home, proves the spine
  src/lib/
    trpc-client.ts          the batched tRPC client, header bearer (§5)
    session.ts              Zustand store + single-flight refresh, refresh token in SecureStore (§4)
    secure-store.ts         the ONE SecureStore wrapper; the only credential-writer (§6.2)
    config.ts               per-channel API base URL + public OAuth ids, validated at boot
    socket.ts               the realtime handshake + reconnect-replay (ported, §8)
    org-gate.ts             validate remembered org vs tenancy.orgs.list before render (§7)
  app.config.ts             Expo config, schemes, associated domains (passkeys/OAuth deep links)
  eas.json                  build channels
packages/config/eslint/
  security.js               scope the client bans to apps/mobile + the new mobile bans (§6)
packages/guardrail-selftest/
  (case)                    assert the computed apps/mobile config carries every ban (§6.3)
apps/api/src/identity/
  session-response.ts       a native output schema that includes the refresh token, kept
  (+ native auth path)      structurally separate from the browser SessionResponse (§4.3) ⚠ §2.2
```

`⚠` marks the human-review surface: the identity change in §4.3 is read line-by-line before merge,
and a second adversarial AI pass in a fresh context is expected, not optional (CLAUDE.md §2.2).
