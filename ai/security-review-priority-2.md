# Priority 2 — Adversarial security review of the human-review surfaces

Status: **COMPLETE** — full pass over every §2.2 surface, one confirmed finding, fixed
with tests. Companion to [pre-launch-hardening.md](pre-launch-hardening.md).

## Scope

Every surface PLAN.md §2.2 names, read adversarially — looking for the failure mode
each file exists to prevent, not for style:

| Surface                 | Files read                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/policy         | decide.ts, enforce.ts, tuples.ts, assignment.ts, roles.ts, permissions.ts                                                                                 |
| packages/db             | client.ts, rls.ts, tenants.ts, index.ts, comms-directory.ts                                                                                               |
| packages/security       | tokens.ts, jwt.ts, random.ts, password.ts, webauthn.ts, twilio-signature.ts, blind-index.ts, encryption.ts, outbound-url.ts, turn-credential.ts, oauth.ts |
| apps/api identity       | authenticate.ts, cookies.ts, identity.service.ts, oauth.service.ts (+ tests), router.ts, repository.ts (via service), totp wiring                         |
| apps/api telephony      | webhook.ts, webhook.routes.ts, spend-gate.ts, subaccount.service.ts                                                                                       |
| apps/api rtc            | turn-gate.ts, turn.service.ts                                                                                                                             |
| apps/realtime           | rtc-rooms.ts (rtc:signal relay), gateway.ts (via rtc-rooms)                                                                                               |
| apps/collab             | auth.ts, authorize.ts                                                                                                                                     |
| apps/api platform-admin | router.ts, operator.ts                                                                                                                                    |
| apps/api work           | attachment.service.ts                                                                                                                                     |
| apps/api chat           | unfurl.ts (SSRF caller)                                                                                                                                   |
| apps/api trpc           | builder.ts (route()/platformRoute enforcement)                                                                                                            |

## Findings

### CONFIRMED — SSRF blocklist missed most of the IPv6 link-local range (fixed)

**File:** `packages/security/src/outbound-url.ts` → `isBlockedIpv6`
**Severity:** LOW (defense-in-depth gap in a control that otherwise holds)

`isBlockedIpv6` checked `plain.startsWith('fe80')`. Link-local is the entire
`fe80::/10` prefix — first hextet `fe80` through `febf`, not just `fe80`. Addresses
like `fe9f::1` or `febf::1` (the upper 63/64 of the range) passed the check and
would have been fetched, despite being link-local and unreachable from the public
internet. Worth noting this was found while reading, not by an exploit: no attacker
payload was known to use these spellings, which is exactly why the hole survived —
the file's own philosophy is that a blocklist with a hole looks identical to one
without.

**Fix:** `/^fe[89ab]/i` matches the whole `/10` range, and the adjacent routable
`fec0`–`feff` block (the rest of `fe80::/9`) is asserted _allowed_ so the fix cannot
drift into over-blocking. Boundary tests added for both sides.

### Reviewed and verified correct — the notes a future reader should keep

No finding, but each of these is where a plausible bug was looked for and the design
turned out to be load-bearing:

- **OAuth auto-link is safe because both providers prove the email.** GitHub requires
  `primary && verified` from `/user/emails`; `verifyGoogleIdToken` requires the
  `email_verified: true` claim (and asserts `sub`/`email` types). An attacker who
  merely _enters_ a victim's address at Google cannot get it auto-linked to a TaskFlow
  account — the whole guarantee of `identity.users.emailVerifiedAt`, re-proven at the
  OAuth boundary. `oauth.test.ts` and `oauth.service.test.ts` between them cover the
  forged-state, wrong-provider-state, cross-account-link, and suspended-account paths.
- **`linkUserId` cannot be forged.** The account-linking path is `oauth.startLink`, a
  `selfRoute` with `stepUp: true`; the plain `start` route never carries a user id.
  The id travels inside the _signed_ state token, so a callback can only ever link to
  the account whose session minted the state.
- **TURN gate's critical assertion is "the secret was never used".** `turn-gate.test.ts`
  asserts refusal against a recording minter, and the durable per-org issuance budget
  lives in Postgres (`rtc.turn_issuance`), so a restart cannot forgive anyone.
- **The signal relay's `to` is a roster selector, never a routing key** — verified in
  `rtc-rooms.ts`; `from` is stamped from `socket.data.identity`, and the integration
  test asserts both refusals.
- **Refresh-token reuse detection revokes the whole session** (not just the request),
  and `authenticatedAt` is deliberately NOT advanced on refresh, so a stolen session
  never becomes step-up eligible.
- **`fetchUnfurl` is the model SSRF caller**: shape check → resolve EVERY record →
  block ANY private address → `redirect: 'manual'` (a 302 to 169.254.169.254 cannot be
  followed) → no cookies/referrer → 5s timeout, 512 KB cap, coarse error reasons so the
  endpoint cannot become a port scanner with readable output.

## Accepted residual risks (documented, deliberate)

- **DNS-rebinding window in `unfurl.ts`** — resolved-then-fetched leaves a timing gap
  between check and connect; the file records it explicitly (pinning the checked IP
  needs a custom agent). Accepted as out of scope for a preview feature.
- **No admin override on call recording** — a capability that let an owner record over
  an objection would make the consent gate decorative. Deliberate (§3.9).
- **Calls in public channels, web push to closed tabs, video/screen-share** — Phase 13
  still-open items, not review findings.

## Verdict

One confirmed low-severity finding (fixed, tested) across ~10,000 lines of the most
sensitive code in the repository. The two-source-of-truth hazard the review kept
looking for — a claim in a comment disagreeing with the code, or a check that looks
redundant and isn't — did not materialize; the files' own documented histories show
those battles were fought and won before this review started.
