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
 * The address domain every seeded account uses.
 *
 * Load-bearing for the reset: it is how `--reset` recognizes a user this seeder
 * created, so a developer's own account survives a re-seed. `.test` is reserved
 * by RFC 2606 and cannot be registered, so no seeded address can ever reach a
 * real mailbox even if a mail worker picked one up.
 */
export const SEED_EMAIL_DOMAIN = 'taskflow.seed.test';

/**
 * The platform operator's own address and password come from
 * `ctx.platformOperator` (`SEED_PLATFORM_ADMIN_EMAIL`/`SEED_PLATFORM_ADMIN_PASSWORD`
 * in `cli.ts`) — deliberately NOT a constant in this file, and deliberately
 * NOT the shared `SEED_PASSWORD` above.
 *
 * The operator can suspend any organization, change every org's plan, and read
 * a global audit log. A hardcoded pair here would mean every clone of this
 * repository ships the same credential for the most privileged account in the
 * system, committed in the clear, forever — worse than sharing `SEED_PASSWORD`
 * with the demo employees, because that one is at least meant to be public
 * and disposable. Reading it from the environment instead means the operator
 * simply does not exist in a database seeded with no configuration, which is
 * the correct default: `identity.users` and `platform.admin` both skip
 * themselves when `ctx.platformOperator` is null, the same null-is-"skip"
 * rule `storage`/`telephony`/`keys` already follow.
 */

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
   *
   * `null` when `ctx.platformOperator` is null — no `SEED_PLATFORM_ADMIN_EMAIL`/
   * `SEED_PLATFORM_ADMIN_PASSWORD` configured, so there is nothing to seed a
   * login for. `platform.admin` reads this to decide whether it has anything
   * to grant.
   */
  readonly operator: SeededUser | null;
  /** The shared tenant-account password. Does NOT work for `operator`. */
  readonly password: string;
  /** The operator's own password, or null exactly when `operator` is. */
  readonly operatorPassword: string | null;
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

    /* null when ctx.platformOperator is null — see PlatformOperatorSeedConfig's
       own header on why that is the correct default rather than a fallback to
       a hardcoded pair. Hashed separately from the shared tenant hash, not
       reused: Argon2id salts per call, so these two would differ even for
       identical inputs — but the point is that the INPUTS differ, and a
       reader of this file can see that they do. */
    const operator: SeededUser | null =
      ctx.platformOperator === null
        ? null
        : {
            id: rng.uuid(ctx.now),
            name: { first: 'Platform', last: 'Operations', full: 'Platform Operations' },
            email: ctx.platformOperator.email,
          };
    const operatorHash =
      ctx.platformOperator === null ? null : await hashPassword(ctx.platformOperator.password);

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
      [...users, ...(operator === null ? [] : [operator])].map((user) => {
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

    ctx.log(
      `identity.users: ${String(users.length)} accounts` +
        (operator === null
          ? ' (no platform operator — SEED_PLATFORM_ADMIN_EMAIL/SEED_PLATFORM_ADMIN_PASSWORD unset)'
          : ` + operator ${operator.email}`),
    );
    return {
      users,
      operator,
      password: SEED_PASSWORD,
      operatorPassword: ctx.platformOperator?.password ?? null,
    };
  },
});
