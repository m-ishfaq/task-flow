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

/** Every seeded TENANT account logs in with this. Printed by the CLI when the run finishes. */
export const SEED_PASSWORD = 'TaskFlow!Demo1';

/**
 * The platform operator's own address and password — deliberately NOT the
 * shared pair above.
 *
 * The operator can suspend any organization, change every org's plan, and read
 * a global audit log. Handing it the same password as twenty-four demo
 * employees means anyone who is shown a demo account is one email address away
 * from the console: the credential that protects the most privileged account in
 * the system would be the one most widely distributed.
 *
 * Separate credentials also make the seeded database honest about how the real
 * thing is meant to be operated — an operator account is not a member account
 * with an extra flag, and `platform.operators` having no relationship to org
 * membership is the whole point of Wave 1.
 *
 * ## This is still a PUBLIC password
 *
 * It is committed to a public repository, so its strength buys nothing against
 * anyone who can read this file. What actually protects it is that seeded
 * accounts only ever exist in a development database: `assertSafeToSeed`
 * refuses to run against `NODE_ENV=production` or a `_test`-suffixed
 * database, and `.test` is RFC 2606-reserved so the address can never receive
 * mail. Treat any environment where this pair works as a development
 * environment, because that is what it is.
 */

/**
 * The address domain every seeded account uses.
 *
 * Load-bearing for the reset: it is how `--reset` recognizes a user this seeder
 * created, so a developer's own account survives a re-seed. `.test` is reserved
 * by RFC 2606 and cannot be registered, so no seeded address can ever reach a
 * real mailbox even if a mail worker picked one up.
 */
export const SEED_EMAIL_DOMAIN = 'taskflow.seed.test';

/**
 * The operator's address, built from `SEED_EMAIL_DOMAIN` rather than spelling
 * the domain again — `--reset` recognizes a seeded account by that exact
 * suffix, so a second copy that drifted would leave the operator behind on
 * every re-seed while every other account was cleared.
 */
export const SEED_OPERATOR_EMAIL = `operations@${SEED_EMAIL_DOMAIN}`;

/** See the note above `SEED_PASSWORD` on why this is separate, and on why its strength buys nothing. */
export const SEED_OPERATOR_PASSWORD = 'rV#9!wK2$mX5&Tp4';

export interface SeededUser {
  readonly id: string;
  readonly name: PersonName;
  readonly email: string;
}

export interface UsersOutput {
  /**
   * The tenant population. `OrgPlan.members` indexes into THIS array.
   *
   * The operator below is deliberately not in it — see `operator`.
   */
  readonly users: readonly SeededUser[];
  /**
   * The platform operator, and the reason it sits outside `users` rather than
   * at some index inside it.
   *
   * Wave 1's central claim is that operator power and org role are unrelated:
   * `platform.operators` has no relationship to org membership at all. The
   * seeder used to contradict that by granting the flag to user 0 — Acme's
   * OWNER — which made every console screenshot show a person who was also a
   * tenant admin, and left the interesting question ("what does an operator
   * who belongs to nothing see?") untested by the one fixture that could
   * answer it.
   *
   * Keeping it out of the indexable array makes the separation structural
   * rather than a rule to remember: `OrgPlan.members` can only name an index
   * into `users`, so there is no way to express "put the operator in an org"
   * even by accident. The same "make the mistake impossible" reasoning
   * CLAUDE.md opens with.
   *
   * Consequence worth knowing, because it is a real product state rather than
   * a seeding artifact: this account logs in, has no org, and `/` sends it to
   * the org picker — which links the console for operators precisely so this
   * is not a dead end.
   */
  readonly operator: SeededUser;
  /** The shared tenant-account password. Does NOT work for `operator`. */
  readonly password: string;
  /** The operator's own password — see `SEED_OPERATOR_PASSWORD`. */
  readonly operatorPassword: string;
}

export const usersModule = defineSeedModule({
  name: 'identity.users',
  requires: [],
  tables: ['identity.users'],

  async seed(ctx): Promise<UsersOutput> {
    const rng = ctx.rng.fork('identity.users');
    const names = people(rng, ctx.profile.users);
    const passwordHash = await hashPassword(SEED_PASSWORD);
    /* Hashed separately, not reused. Argon2id salts per call, so these two
       hashes would differ even for identical inputs — but the point is that
       the INPUTS differ, and a reader of this file can see that they do. */
    const operatorHash = await hashPassword(SEED_OPERATOR_PASSWORD);

    const users: SeededUser[] = names.map((name, index) => ({
      id: rng.uuid(ctx.now),
      name,
      /* The index disambiguates: the corpus guarantees distinct NAMES, and two
         distinct names can still fold to one address once accents and spaces are
         stripped. `users_email_normalized_key` would refuse the second. */
      email: `${emailLocalPart(name)}${String(index)}@${SEED_EMAIL_DOMAIN}`,
    }));

    /* A FIXED address, unlike everyone else's generated one. This is the
       account a person types into a login box to demo the console, so it has
       to be memorable and stable across runs and profiles — `ops@` is both,
       where `priya.raghavan7@` is neither. */
    const operator: SeededUser = {
      id: rng.uuid(ctx.now),
      name: { first: 'Platform', last: 'Operations', full: 'Platform Operations' },
      email: SEED_OPERATOR_EMAIL,
    };

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
        'display_name',
      ],
      [...users, operator].map((user) => {
        const isOperator = user === operator;
        const createdAt = daysBefore(ctx.now, rng.int(30, 400));
        return [
          user.id,
          user.email,
          user.email.toLowerCase(),
          createdAt,
          isOperator ? operatorHash : passwordHash,
          createdAt,
          'active',
          createdAt,
          createdAt,
          /* Written HERE as well as in people.profiles, which is where the
             product actually reads it from. The column existed and was left
             null by every seed run, so anything reading identity.users
             directly — the operator console's user list among them — showed an
             email address where a name belongs. */
          user.name.full,
        ];
      }),
    );

    ctx.log(`identity.users: ${String(users.length)} accounts + operator ${operator.email}`);
    return {
      users,
      operator,
      password: SEED_PASSWORD,
      operatorPassword: SEED_OPERATOR_PASSWORD,
    };
  },
});
