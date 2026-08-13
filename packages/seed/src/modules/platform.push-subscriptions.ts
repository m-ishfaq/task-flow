import { defineSeedModule } from '../registry.js';
import { daysBefore } from '../support.js';
import type { Rng } from '../rng.js';
import { usersModule } from './identity.users.js';

/**
 * Web-push device rows (migration 0029, ai/phase-9-notifications.md §3.7).
 *
 * ## Global per user, not org-scoped — and that is why this module exists on
 * its own rather than folding into `platform.notifications`
 *
 * `push_subscriptions_self_insert`'s `WITH CHECK` is keyed on `app.user_id`,
 * never `app.org_id` — a subscription belongs to a person, not a tenant
 * (`packages/db/migrations/0029...`'s own header). `ctx.orgScope` cannot
 * express that: it calls `AdminConnection.setOrg`, which always clears
 * `app.user_id` back to empty (`testing/index.ts`) because every OTHER
 * table this package writes is org-scoped. This module sets it directly
 * instead, the exact pattern `reset.ts`'s own `findSeededOrgIds` already
 * uses for the identical reason (`orgs_self_read` is the other policy keyed
 * on `app.user_id` alone).
 *
 * ## Plaintext, on purpose — not a shortcut
 *
 * The real key material is unencrypted at rest by design (§7.3's decision,
 * recorded in the migration's own header): an attacker who can read this
 * table already holds the VAPID private key the server signs with, so
 * envelope-encryption would defend against a threat the system cannot
 * survive anyway. So a plausible fake token here is exactly as "real" as
 * the column requires — there is no ciphertext contract to get wrong, unlike
 * `comms.telephony`'s counterparty columns.
 */

const USER_AGENTS = [
  'Chrome on macOS',
  'Chrome on Windows',
  'Chrome on Android',
  'Firefox on Windows',
  'Firefox on Linux',
  'Safari on iOS',
  'Safari on macOS',
  'Edge on Windows',
] as const;

/*
 * Endpoints on a RESERVED domain, not the real push services.
 *
 * The first version used `fcm.googleapis.com`, `updates.push.services.mozilla.com`
 * and `push.apple.com`, on the reasoning that an endpoint should look like a
 * real one. Two consequences, both discovered by running a dev server rather
 * than by reading this file:
 *
 *   1. Two of those hosts RESOLVE, so the delivery loop sent real HTTPS
 *      requests to Google and Mozilla carrying garbage tokens, from every
 *      developer machine, forever.
 *   2. `push.apple.com` does NOT resolve (Apple's is `web.push.apple.com`), so
 *      it failed DNS. `deliverPendingPushes` classifies a thrown error as
 *      TRANSIENT and leaves the row pending, so every tick retried it — a
 *      permanent failure wearing a temporary failure's clothes, at five-second
 *      intervals, drowning the API log.
 *
 * `.test` is RFC 2606-reserved and can never resolve, which makes these
 * obviously-fake rather than plausibly-real. Note this does NOT stop the retry
 * loop on its own — that is a real gap in the delivery loop (no attempt cap),
 * and it is why a seeded subscription still costs something until that is
 * fixed. What it does stop is a developer's machine talking to Google.
 */
const PUSH_SERVICES = [
  'https://push.taskflow.seed.test/fcm',
  'https://push.taskflow.seed.test/wpush',
  'https://push.taskflow.seed.test/apns',
] as const;

/**
 * Real P-256 uncompressed public points (65 bytes, leading `0x04`), picked
 * deterministically per row rather than generated fresh.
 *
 * `isValidSubscriptionKeys` decodes `p256dh` and requires exactly that shape;
 * 87 random base64url characters are the right LENGTH and essentially never
 * the right first byte, so a naive `token(rng, 87)` here produced a
 * structurally invalid key on every row — the delivery loop could not
 * encrypt for it, each attempt stayed pending and was retried forever, and a
 * seeded database produced a continuous stream of push failures in the API
 * log that read as a bug in web-push rather than as invented key material.
 *
 * The fix is NOT `generateVapidKeys()` called per row: that function reaches
 * into `node:crypto` for genuine randomness, which means two seed runs with
 * the identical `--seed` value produce DIFFERENT databases — silently
 * breaking the one guarantee `pnpm seed --seed <value>` documents. This
 * package's own determinism suite (`push-subscriptions.test.ts`) caught it:
 * running the same module twice with the same seed produced two different
 * sets of rows, differing only in this column.
 *
 * These five were generated once, offline, with the exact code
 * `generateVapidKeys` runs (`createECDH('prime256v1').generateKeys()`,
 * base64url-encoded) — real points, just fixed rather than fresh. Nothing
 * ever encrypts a real push payload against seeded key material (the file
 * header's "plaintext, on purpose" argument extends to reuse: there is no
 * real device on the other end to distinguish one valid point from another),
 * so picking deterministically from a small pool costs nothing a real
 * subscription would have needed.
 */
const P256DH_KEYS = [
  'BJD-_aM8LxcrwduKEOj30x3D9u43tL3cfh4tcezro-7Pc3d6-W6z4btzwh-oHYH_7QgOn6-ZFEsZIizuH8JLJIA',
  'BOdHrnzdYcSUg3fvzhliE21SSSvKBvkkwL5276Gam02JyuAI32DdPrZW-jdc23PVs86dMhV2kRMzRRYV7XYNovU',
  'BPu3C6hQhzqGugAXqfcph9j1z3bk4P97tlt0P18plYPMi1f4rHQDD_tRJ1K6cUkVTsd1n6A3XFRNHDv3Jvc2XS0',
  'BC0Tcl7xe5OiVIgGziSjNOnhC-jPMFIpu3OJk_4jufOUQeZrrMmwFxc37dd1G-1Htkw4_KJ3X2cQhhybCaSo0gs',
  'BB99DlFdUYW8STiQgNMk_Ocu7b_7UIbLQhEHkRgrWO87lnPRKHGG6btoCD-KnZEb_bovIY5VPcVOuwfGG7QcGz4',
] as const;

const URL_SAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A base64url-ALPHABET string of `length` characters.
 *
 * Fine for an endpoint path and for the 16-byte `auth` secret, which is
 * genuinely arbitrary bytes. NOT fine for `p256dh` — see `pushKeys`.
 */
function token(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += URL_SAFE_ALPHABET.charAt(rng.int(0, URL_SAFE_ALPHABET.length - 1));
  }
  return out;
}

const SUBSCRIPTION_RATE = 0.4;

export const pushSubscriptionsModule = defineSeedModule({
  name: 'platform.push_subscriptions',
  requires: [usersModule],
  tables: ['platform.push_subscriptions'],

  async seed(ctx) {
    const rng = ctx.rng.fork('platform.push_subscriptions');
    const { users } = ctx.use(usersModule);

    let subscriptionCount = 0;

    for (const user of users) {
      if (!rng.chance(SUBSCRIPTION_RATE)) continue;

      const deviceCount = rng.chance(0.25) ? 2 : 1;
      const rows: unknown[][] = [];

      for (let i = 0; i < deviceCount; i += 1) {
        const createdAt = daysBefore(ctx.now, rng.int(1, 120));
        const lastSeenAt = daysBefore(ctx.now, rng.int(0, 10));
        rows.push([
          rng.uuid(createdAt),
          user.id,
          `${rng.pick(PUSH_SERVICES)}/${token(rng, 32)}`,
          /* See P256DH_KEYS's own header on why this is a deterministic pick
             from a fixed pool rather than a fresh `generateVapidKeys()` call. */
          rng.pick(P256DH_KEYS),
          /* `auth` genuinely IS 16 arbitrary bytes, so the token generator is
             correct here — the validator only checks its decoded length. */
          token(rng, 22),
          rng.pick(USER_AGENTS),
          createdAt,
          lastSeenAt,
        ]);
      }

      /* `orgScope` always clears app.user_id (see file header); set it
         directly instead, matching reset.ts's own precedent, and reset it
         back to empty once this user's rows are written so no later module
         inherits a stale one. */
      await ctx.db.query(`SELECT set_config('app.org_id', '', false)`);
      await ctx.db.query(`SELECT set_config('app.user_id', $1, false)`, [user.id]);

      await ctx.db.insert(
        'platform.push_subscriptions',
        [
          'id',
          'user_id',
          'endpoint',
          'p256dh',
          'auth',
          'user_agent_label',
          'created_at',
          'last_seen_at',
        ],
        rows,
      );
      subscriptionCount += rows.length;
    }

    await ctx.db.query(`SELECT set_config('app.user_id', '', false)`);

    ctx.log(
      `platform.push_subscriptions: ${String(subscriptionCount)} devices ` +
        `across ${String(users.length)} users`,
    );

    return { subscriptionCount };
  },
});
