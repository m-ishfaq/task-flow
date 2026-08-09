import { FLAG_NAMES } from '@taskflow/feature-flags';
import { defineSeedModule } from '../registry.js';
import { usersModule, type SeededUser } from './identity.users.js';

/**
 * The platform-admin console's fixture (Phase 12 Wave 1,
 * ai/phase-12-admin.md) — the operator flag and the global flag-override
 * store.
 *
 * Without this module a seeded database has a console that cannot be
 * reached: the account menu only renders the /platform-admin link for
 * whoever `platformAdmin.self.check` answers true to, which is exactly the
 * rows in `platform.operators` — and there is no UI that writes that table
 * (§7 decision 7: migration or one-off script only, never a route). The
 * seeder is precisely such a script, running as `taskflow_migrator` — the
 * one role the migration grants INSERT to, and the same sanctioned path the
 * migration's own bootstrap uses.
 *
 * ## Two GLOBAL tables — no orgScope, no events
 *
 * Both tables carry no `org_id` and no RLS, so nothing here runs inside
 * `ctx.orgScope` — the identical structural reason `operator.ts`'s
 * `isPlatformOperator` uses `withGlobalScope` on the read side. And neither
 * write emits a domain event: `platform-admin/events.ts`'s own header
 * documents that `platform.operator_granted`/`platform.flag_override_set`
 * travel the in-process EventBus, never `platform.outbox` (whose RLS policy
 * keys on `app.org_id`, and a cross-tenant grant has no org to key on). A
 * seed run has no EventBus instance, so the durable record of these writes
 * is the rows themselves — `granted_by`/`granted_at`/`note` on the operator,
 * `set_by`/`updated_at` on each override — exactly as migration 0035's
 * bootstrap records the operator it creates.
 *
 * ## The operator is user index 0
 *
 * The first seeded account — Acme's owner in the demo profile. The console
 * is a console for a person, and the same login that demos the product
 * should demo it. `granted_by` equals the operator's own id, mirroring the
 * migration's `SELECT id, id, ...` self-bootstrap: the script granting is
 * the account itself, there being no operator before the first one.
 */

/**
 * The flag overrides a run creates — deliberately few and deliberate.
 *
 * Exported (not module-private) so the test suite can assert the literal
 * against the real registry: a flag renamed or deleted below the test's
 * notice is a row the evaluator would silently ignore, and the only other
 * place the validation lives is the runtime check in `seed`.
 */
export const OVERRIDES = [
  /* Default-off flipped on: the Flags tab's override state with the toggle
     ON, and the value a default would never produce. */
  { flagName: 'automation', value: true },
  /* Pinned off. No flag in the registry defaults ON, so there is no
     "flip off a default-on flag" to seed; this one instead exercises the
     evaluator's `false !== absent` distinction (flag-evaluator.ts's own
     test) — an explicit off that must not fall back to the default. */
  { flagName: 'chat', value: false },
] as const;

export interface PlatformAdminOutput {
  /** The seeded operator — user index 0 of the shared pool. */
  readonly operator: SeededUser;
  readonly overrides: readonly { readonly flagName: string; readonly value: boolean }[];
}

export const adminModule = defineSeedModule({
  name: 'platform.admin',
  /* Only the user pool — the operator is relative to NO org, so unlike every
     tenant-scoped module this one must not require `tenancy.orgs`. */
  requires: [usersModule],
  /* GLOBAL tables (no org_id) — `reset.ts` treats them specially (its
     GLOBAL_TABLES set), never through the per-org loop. */
  tables: ['platform.operators', 'platform.flag_overrides'],

  async seed(ctx): Promise<PlatformAdminOutput> {
    const { users } = ctx.use(usersModule);
    const operator = users[0];
    if (!operator) {
      throw new Error(
        'platform.admin: the user pool is empty — cannot grant the operator flag. ' +
          'Raise `users` on the profile.',
      );
    }

    /* No orgScope — see the file header. `granted_at` is the run's `now`,
       exactly as every other module derives its timestamps. */
    await ctx.db.insert(
      'platform.operators',
      ['user_id', 'granted_by', 'granted_at', 'note'],
      [
        [
          operator.id,
          operator.id,
          ctx.now,
          'Seeded platform operator (Phase 12 Wave 1, §7 decision 7).',
        ],
      ],
    );

    /* Validated against the real registry rather than trusted from the
       literal above — the same "re-validate rather than assume" discipline
       filter.fields.ts applies to its field names. A flag deleted from the
       registry would otherwise seed a leftover row the evaluator ignores,
       silently. */
    for (const override of OVERRIDES) {
      /* The literal above is `as const`, so `override.flagName` is already
         assignable to `FlagName` — the compile-time equivalent of this very
         check, for the values declared here. The runtime check still matters
         for the day someone edits OVERRIDES with a name the registry does
         not have, so it stays. */
      if (!FLAG_NAMES.includes(override.flagName)) {
        throw new Error(
          `platform.admin: "${override.flagName}" is not a registered flag. ` +
            `Available: ${FLAG_NAMES.join(', ')}.`,
        );
      }
    }

    await ctx.db.insert(
      'platform.flag_overrides',
      ['flag_name', 'value', 'set_by', 'updated_at'],
      OVERRIDES.map((override) => [override.flagName, override.value, operator.id, ctx.now]),
    );

    ctx.log(
      `platform.admin: operator ${operator.email} + ${String(OVERRIDES.length)} flag override(s)`,
    );
    return { operator, overrides: OVERRIDES };
  },
});
