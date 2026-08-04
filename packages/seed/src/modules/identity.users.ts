import { hashPassword } from '@taskflow/security';
import { emailLocalPart, people, type PersonName } from '../corpus.js';
import { defineSeedModule } from '../registry.js';
import { daysBefore } from '../support.js';

/**
 * The user pool — the only rows in this seeder that belong to no organization.
 *
 * `identity.users` carries no `org_id` and no RLS tenant policy, which is why
 * this module writes with the org scope CLEARED. Every other module sets one.
 *
 * ## Why every seeded account shares one password hash
 *
 * Argon2id is deliberately expensive — that is the entire point of it — and the
 * demo profile creates twenty-four accounts. Hashing per user would add seconds
 * to every run to produce twenty-four hashes of the same string. So the password
 * is hashed ONCE and the resulting string is copied.
 *
 * That is safe here and would not be in production: an Argon2 hash embeds its
 * own salt, so two users sharing a hash is not two users sharing a salt — it is
 * two users who genuinely have the same password, which is exactly what a demo
 * fixture wants and exactly what a real signup must never produce. Nothing in
 * this package is reachable from a registration path.
 */

/** Everything seeded logs in with this. Printed by the CLI when the run finishes. */
export const SEED_PASSWORD = 'TaskFlow!Demo1';

/**
 * The address domain every seeded account uses.
 *
 * Load-bearing for the reset: it is how `--reset` recognizes a user this seeder
 * created, so a developer's own account survives a re-seed. `.test` is reserved
 * by RFC 2606 and cannot be registered, so no seeded address can ever reach a
 * real mailbox even if a mail worker picked one up.
 */
export const SEED_EMAIL_DOMAIN = 'taskflow.seed.test';

export interface SeededUser {
  readonly id: string;
  readonly name: PersonName;
  readonly email: string;
}

export interface UsersOutput {
  readonly users: readonly SeededUser[];
  readonly password: string;
}

export const usersModule = defineSeedModule({
  name: 'identity.users',
  requires: [],
  tables: ['identity.users'],

  async seed(ctx): Promise<UsersOutput> {
    const rng = ctx.rng.fork('identity.users');
    const names = people(rng, ctx.profile.users);
    const passwordHash = await hashPassword(SEED_PASSWORD);

    const users: SeededUser[] = names.map((name, index) => ({
      id: rng.uuid(ctx.now),
      name,
      /* The index disambiguates: the corpus guarantees distinct NAMES, and two
         distinct names can still fold to one address once accents and spaces are
         stripped. `users_email_normalized_key` would refuse the second. */
      email: `${emailLocalPart(name)}${String(index)}@${SEED_EMAIL_DOMAIN}`,
    }));

    /* Verified on creation. An unverified account cannot sign in, so a seeder
       that skipped this would produce a database nobody can log into — and the
       failure would surface as a login error rather than as a seeding bug. */
    await ctx.db.insert(
      'identity.users',
      [
        'id',
        'email',
        'email_normalized',
        'email_verified_at',
        'password_hash',
        'password_updated_at',
        'status',
        'created_at',
        'updated_at',
      ],
      users.map((user) => {
        const createdAt = daysBefore(ctx.now, rng.int(30, 400));
        return [
          user.id,
          user.email,
          user.email.toLowerCase(),
          createdAt,
          passwordHash,
          createdAt,
          'active',
          createdAt,
          createdAt,
        ];
      }),
    );

    ctx.log(`identity.users: ${String(users.length)} accounts`);
    return { users, password: SEED_PASSWORD };
  },
});
