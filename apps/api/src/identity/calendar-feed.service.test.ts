import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { RecordingEventBus } from '@taskflow/events';
import { hasActiveFeedToken, mintFeedUrl } from './calendar-feed.service.js';
import { resolveUserByFeedToken } from './calendar-feed-tokens.js';
import { calendarFeedTokenMinted } from './events.js';
import { TEST_ENV } from '../testing/fixtures.js';

/**
 * The calendar feed's own bearer token (migration 0110), against real
 * Postgres — the properties that matter are database behaviours: minting
 * again REVOKES the previous token rather than leaving two active, an
 * unknown or revoked token resolves to `undefined` rather than throwing,
 * and a real token round-trips through `hashToken` to the same user that
 * minted it.
 */

const USER_A = unsafeAsId<'UserId'>('0195ef40-0000-7000-8000-000000000101');
const USER_B = unsafeAsId<'UserId'>('0195ef40-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [USER_A, 'a@calendar-feed-token.test'],
  [USER_B, 'b@calendar-feed-token.test'],
];

let admin: AdminConnection;

function deps(): { events: RecordingEventBus; webOrigin: string } {
  return { events: new RecordingEventBus(), webOrigin: TEST_ENV.WEB_ORIGIN };
}

beforeAll(async () => {
  admin = await connectAsMigrator();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'calendar-feed-token-test' });
});

afterAll(async () => {
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.calendar_feed_tokens WHERE user_id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('mintFeedUrl / resolveUserByFeedToken', () => {
  it('mints a URL that resolves back to the minting user', async () => {
    const testDeps = deps();
    const { url } = await mintFeedUrl(testDeps, USER_A);

    expect(url.startsWith(`${TEST_ENV.WEB_ORIGIN}/calendar/`)).toBe(true);
    expect(url.endsWith('.ics')).toBe(true);

    const rawToken = url.slice(`${TEST_ENV.WEB_ORIGIN}/calendar/`.length, -'.ics'.length);
    expect(await resolveUserByFeedToken(rawToken)).toBe(USER_A);
  });

  it('emits user.calendar_feed_token_minted', async () => {
    const testDeps = deps();
    await mintFeedUrl(testDeps, USER_A);

    expect(testDeps.events.names()).toContain(calendarFeedTokenMinted.name);
  });

  it('resolves to undefined for a token that never existed', async () => {
    expect(await resolveUserByFeedToken('tf_sl_not-a-real-token')).toBeUndefined();
  });

  it('revokes the previous token when minting again — only one is active at a time', async () => {
    const testDeps = deps();
    const first = await mintFeedUrl(testDeps, USER_A);
    const second = await mintFeedUrl(testDeps, USER_A);

    expect(second.url).not.toBe(first.url);

    const firstToken = first.url.slice(`${TEST_ENV.WEB_ORIGIN}/calendar/`.length, -'.ics'.length);
    const secondToken = second.url.slice(`${TEST_ENV.WEB_ORIGIN}/calendar/`.length, -'.ics'.length);

    expect(await resolveUserByFeedToken(firstToken)).toBeUndefined();
    expect(await resolveUserByFeedToken(secondToken)).toBe(USER_A);
  });

  it('reports hasActiveFeedToken correctly before and after minting', async () => {
    expect(await hasActiveFeedToken(USER_B)).toBe(false);

    await mintFeedUrl(deps(), USER_B);

    expect(await hasActiveFeedToken(USER_B)).toBe(true);
  });
});
