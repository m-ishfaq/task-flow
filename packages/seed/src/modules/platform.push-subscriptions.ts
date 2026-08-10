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

const PUSH_SERVICES = [
  'https://fcm.googleapis.com/fcm/send',
  'https://updates.push.services.mozilla.com/wpush/v2',
  'https://push.apple.com/webpush',
] as const;

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A base64url-ALPHABET string of `length` characters — not a real key, just
 * something that reads like one; see the file header on why that is enough. */
function token(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TOKEN_ALPHABET.charAt(rng.int(0, TOKEN_ALPHABET.length - 1));
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
          token(rng, 87), // 65 raw bytes, base64url
          token(rng, 22), // 16 raw bytes, base64url
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
