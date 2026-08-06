import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase, sql, withGlobalScope } from '@taskflow/db';
import { up } from '@taskflow/db/migrate';
import { RecordingEventBus } from '@taskflow/events';
import { isAppError, unsafeAsId, type UserId } from '@taskflow/contracts';
import * as identity from './identity.service.js';
import type { DeliverableLink, IdentityDeps } from './identity.service.js';
import * as profile from './profile.service.js';
import * as repo from './repository.js';

/**
 * Display names (migration 0019) against real Postgres.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): `apps/api/src/identity`.
 *
 * ## What is actually under test here
 *
 * A display name is the first piece of FULLY ATTACKER-CONTROLLED text this
 * system stores about a person and then shows to other people. It is not a
 * credential and it decides nothing, and the entire safety argument is that it
 * stays that way. So these tests are less about the feature working and more
 * about three properties holding:
 *
 *   1. It is not an identifier. Two accounts may carry the same name, and
 *      nothing resolves a user by it — `findUserByEmail` still keys on
 *      `email_normalized` and every authorization decision on the user id.
 *   2. It cannot be set for somebody else. The subject comes from the verified
 *      principal at the route; `updateProfile` takes a user id as an ARGUMENT
 *      and the input schema has no field for one.
 *   3. A blank name never reaches the column. Null is a real value meaning "show
 *      my address"; a string of spaces is a name that renders as an empty gap,
 *      which looks like a broken page rather than a missing name.
 *
 * Real Postgres because the third property is enforced by a CHECK constraint
 * and the first by the ABSENCE of a unique index — neither of which a fake can
 * demonstrate, since a fake would agree with whatever this file assumed.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const JWT_SECRET = new Uint8Array(Buffer.alloc(32, 7));
const PASSWORD = 'correct horse battery staple 42';
const meta = { ip: '203.0.113.5', userAgent: 'vitest' };

const ALICE = 'profile-alice@example.test';
const BOB = 'profile-bob@example.test';

let events: RecordingEventBus;
let delivered: DeliverableLink[];

function deps(): IdentityDeps {
  return {
    config: {
      jwtSecret: JWT_SECRET,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      verificationTtlMs: 24 * 60 * 60 * 1000,
      passwordResetTtlMs: 60 * 60 * 1000,
      lockThreshold: 3,
      lockDurationMs: 15 * 60 * 1000,
      onBreachCheckUnavailable: 'allow',
    },
    events,
    checkBreached: () => Promise.resolve({ status: 'ok' as const }),
    deliver: (message) => {
      delivered.push(message);
      return Promise.resolve();
    },
  };
}

/** Registers and verifies an account, returning its id. */
async function registeredUser(email: string): Promise<UserId> {
  await identity.register(deps(), { email, password: PASSWORD }, meta);
  const link = delivered.find((message) => message.kind === 'verify_email');
  await identity.verifyEmail(deps(), { token: link?.token ?? '' });
  delivered.length = 0;
  events.events.length = 0;

  const user = await repo.findUserByEmail(email);
  if (user === undefined) throw new Error(`fixture failed: ${email} was not created`);
  return unsafeAsId<'UserId'>(user.id);
}

function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : `not an AppError: ${String(error)}`;
}

async function codeOfRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no error thrown';
  } catch (error) {
    return codeOf(error);
  }
}

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });
  initializeDatabase({ url: APP_URL, applicationName: 'profile-test' });
}, 60_000);

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  events = new RecordingEventBus();
  delivered = [];

  /* Scoped to THIS file's own fixture addresses, never a table wipe: CI runs
     every package's suites against one shared `taskflow_test`, and an unscoped
     DELETE here has previously deleted a row another package's suite was
     depending on mid-run — an FK violation that reads as a bug in that
     package's code rather than as what it is. */
  await withGlobalScope(async (tx) => {
    await tx.execute(sql`
      DELETE FROM identity.users
      WHERE email_normalized = ${ALICE} OR email_normalized = ${BOB}
    `);
  });
});

describe('setting your own name', () => {
  it('stores a name and reports it back', async () => {
    const alice = await registeredUser(ALICE);

    const result = await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });

    expect(result.displayName).toBe('Alice Doe');
    expect((await repo.findUserById(alice))?.displayName).toBe('Alice Doe');
  });

  it('starts null, so nothing is guessed from the address', async () => {
    /* Migration 0019 deliberately backfills nothing. A name inferred from the
       local part of an email gets written into a column that looks authored,
       after which an entered name and an inferred one are indistinguishable and
       the inferred ones are never corrected. */
    const alice = await registeredUser(ALICE);
    expect((await repo.findUserById(alice))?.displayName).toBeNull();
  });

  it('clears the name when given null', async () => {
    // A real operation, not "leave it alone": going back to being shown by
    // address is something a person can want, and there is no other way to say
    // it.
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });

    const cleared = await profile.updateProfile(deps(), alice, { displayName: null });

    expect(cleared.displayName).toBeNull();
    expect((await repo.findUserById(alice))?.displayName).toBeNull();
  });

  it('trims surrounding whitespace rather than storing it', async () => {
    const alice = await registeredUser(ALICE);

    const result = await profile.updateProfile(deps(), alice, { displayName: '  Alice Doe  ' });

    expect(result.displayName).toBe('Alice Doe');
  });

  it('treats a name of only whitespace as clearing it', async () => {
    /* The CHECK constraint refuses a blank name outright, so without the trim
       this would be a failed write — a 500 for someone pressing space. The
       constraint stays as the backstop; this is what keeps it unreachable. */
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });

    const result = await profile.updateProfile(deps(), alice, { displayName: '   ' });

    expect(result.displayName).toBeNull();
    expect((await repo.findUserById(alice))?.displayName).toBeNull();
  });

  it('refuses a name longer than the column allows', async () => {
    // Bounded here as well as by the CHECK, so an over-long name is a readable
    // validation error rather than a 500 from a refused write.
    const alice = await registeredUser(ALICE);

    expect(
      await codeOfRejection(profile.updateProfile(deps(), alice, { displayName: 'x'.repeat(81) })),
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses to name an account that does not exist', async () => {
    const ghost = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-0000000000ff');

    expect(
      await codeOfRejection(profile.updateProfile(deps(), ghost, { displayName: 'Nobody' })),
    ).toBe('NOT_FOUND');
  });
});

describe('a name is not an identifier', () => {
  it('lets two people carry the same name', async () => {
    /* Deliberately NOT unique. Two people are often called the same thing, and
       uniqueness here would turn an ordinary fact about names into a failure.
       The identifier that must be unique already is: `email_normalized`. */
    const alice = await registeredUser(ALICE);
    const bob = await registeredUser(BOB);

    await profile.updateProfile(deps(), alice, { displayName: 'Sam Taylor' });
    await profile.updateProfile(deps(), bob, { displayName: 'Sam Taylor' });

    expect((await repo.findUserById(alice))?.displayName).toBe('Sam Taylor');
    expect((await repo.findUserById(bob))?.displayName).toBe('Sam Taylor');
  });

  it('does not become a way to look an account up', async () => {
    /* The property the whole design rests on. Someone may name themselves
       another person's email address — nothing prevents it, and nothing should
       have to, BECAUSE no lookup consults this column. `findUserByEmail` still
       resolves by `email_normalized`, so the impersonating name reaches a label
       and stops there. */
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: BOB });

    // Nobody is registered at BOB yet, and a name that looks like it changes
    // nothing about that.
    expect(await repo.findUserByEmail(BOB)).toBeUndefined();

    const bob = await registeredUser(BOB);
    expect(bob).not.toBe(alice);
    expect((await repo.findUserByEmail(BOB))?.id).toBe(bob);
  });

  it('leaves the sign-in address untouched', async () => {
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: 'Someone Else' });

    const user = await repo.findUserById(alice);
    expect(user?.email).toBe(ALICE);
    expect(user?.emailNormalized).toBe(ALICE);
  });

  it('stores markup verbatim rather than sanitizing it', async () => {
    /* Intentional. The name is CONTENT and is rendered as text — React escapes
       it, and there is no `dangerouslySetInnerHTML` anywhere in this codebase
       (CLAUDE.md rule 4). Stripping tags on write would be a second, weaker
       defence that invites someone to rely on it, and it would mangle names
       that legitimately contain punctuation. The escaping at the render site is
       the control; this test records that fact so nobody "fixes" it by adding a
       sanitizer here and quietly moving the guarantee. */
    const alice = await registeredUser(ALICE);
    const hostile = '<script>alert(1)</script>';

    const result = await profile.updateProfile(deps(), alice, { displayName: hostile });

    expect(result.displayName).toBe(hostile);
    expect((await repo.findUserById(alice))?.displayName).toBe(hostile);
  });
});

describe('the audit trail', () => {
  it('emits an event carrying both sides of the change', async () => {
    const alice = await registeredUser(ALICE);

    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });

    const emitted = events.events.filter((event) => event.name === 'user.display_name_changed');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toEqual({ userId: alice, before: null, after: 'Alice Doe' });
  });

  it('records the previous name, not just the new one', async () => {
    // An event saying only what a field became cannot answer whether anything
    // changed — and "what was this person called before?" is exactly the
    // question an audit reader has when an old entry names somebody who no
    // longer matches anyone.
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });
    events.events.length = 0;

    await profile.updateProfile(deps(), alice, { displayName: 'A. Doe' });

    const emitted = events.events.filter((event) => event.name === 'user.display_name_changed');
    expect(emitted[0]?.payload).toEqual({ userId: alice, before: 'Alice Doe', after: 'A. Doe' });
  });

  it('emits nothing when the value did not change', async () => {
    /* An entry in the compliance record for a save that wrote the same value is
       noise in the one log that should not have any, and it would wake every
       consumer for it. */
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });
    events.events.length = 0;

    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });

    expect(events.events.filter((event) => event.name === 'user.display_name_changed')).toEqual([]);
  });

  it('emits nothing when a trimmed name matches the stored one', async () => {
    // The trim happens before the comparison, so " Alice Doe " over "Alice Doe"
    // is not a change. Comparing the raw input instead would emit an event per
    // accidental trailing space.
    const alice = await registeredUser(ALICE);
    await profile.updateProfile(deps(), alice, { displayName: 'Alice Doe' });
    events.events.length = 0;

    await profile.updateProfile(deps(), alice, { displayName: '  Alice Doe  ' });

    expect(events.events.filter((event) => event.name === 'user.display_name_changed')).toEqual([]);
  });
});
