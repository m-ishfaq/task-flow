import { describe, expect, it } from 'vitest';
import { FLAG_NAMES } from '@taskflow/feature-flags';
import { adminModule, OVERRIDES } from './modules/platform.admin.js';
import { usersModule } from './modules/identity.users.js';
import { auditModule } from './modules/platform.audit.js';
import { PROFILES } from './profiles.js';
import { resolveModules, tablesInTeardownOrder } from './registry.js';

/**
 * The platform-admin fixture (Phase 12 Wave 1) — module shape and the
 * invariants that keep the seeded console reachable.
 *
 * Pure, like every suite in this package (vitest.config.ts): the module
 * graph, the override literal, and the profile shapes are all checkable
 * without Postgres. What actually runs against the database — the operator
 * row landing, the suspended org being refused — is exercised by running
 * `pnpm seed`, the package's own standing arrangement.
 */

describe('platform.admin module shape', () => {
  it('is named platform.admin', () => {
    expect(adminModule.name).toBe('platform.admin');
  });

  it('requires only the user pool — the operator is relative to NO org', () => {
    /* Every tenant-scoped module in this package requires `tenancy.orgs`.
       This one must not: the operator flag and the overrides are global
       tables, so requiring the org module would be a lie the graph would
       happily believe — and a future reader "fixing" the ordering would put
       the operator inside an orgScope it must never have. */
    expect(adminModule.requires).toEqual([usersModule]);
  });

  it('declares exactly the two global tables it writes', () => {
    expect(adminModule.tables).toEqual(['platform.operators', 'platform.flag_overrides']);
  });
});

describe('the flag-override literal', () => {
  it('names only registered flags — a retired flag would seed a row the evaluator ignores', () => {
    /* The runtime check in `seed` throws on an unregistered flag; this
       asserts the literal against the SAME registry so a rename surfaces in
       the test suite rather than at the end of a demo run. */
    const registered = new Set<string>(FLAG_NAMES);
    for (const override of OVERRIDES) {
      expect(registered.has(override.flagName), override.flagName).toBe(true);
    }
  });

  it('has no duplicate flag names — flag_name is the primary key', () => {
    const names = OVERRIDES.map((override) => override.flagName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes a false value — the evaluator's `false !== absent` case", () => {
    /* `flag-evaluator.ts` distinguishes an explicit off from a missing row
       (an absent override falls back to the default; a false one does not).
       No registry flag defaults ON, so the only way to seed that distinction
       is to pin one off explicitly. */
    expect(OVERRIDES.some((override) => !override.value)).toBe(true);
  });
});

describe('the module graph', () => {
  const ordered = resolveModules([auditModule]);
  const names = ordered.map((module) => module.name);

  it('reaches platform.admin from the audit root', () => {
    /* Nothing reads its output, so the only thing keeping it in the graph is
       the entry in `platform.audit`'s `requires` — the same trap every other
       leaf module documents in registry.test.ts. Drop that entry and the run
       reports success with no operator and a console nobody can open. */
    expect(names).toContain('platform.admin');
  });

  it('runs after the user pool it reads and before the audit drain', () => {
    expect(names.indexOf('identity.users')).toBeLessThan(names.indexOf('platform.admin'));
    expect(names.indexOf('platform.admin')).toBeLessThan(names.indexOf('platform.audit'));
  });

  it('clears the global tables before identity.users in teardown order', () => {
    /* `reset.ts` handles these two outside the per-org loop (no org_id), and
       deletes overrides before the users DELETE — `flag_overrides.set_by`
       has no cascade. This asserts the derived teardown order agrees: an
       override must never outlive the user it names. */
    const tables = tablesInTeardownOrder(ordered);
    for (const table of ['platform.operators', 'platform.flag_overrides']) {
      const at = tables.indexOf(table);
      expect(at, table).toBeGreaterThanOrEqual(0);
      expect(at, table).toBeLessThan(tables.indexOf('identity.users'));
    }
  });
});

describe('the seeded operator and the suspended org (profile invariants)', () => {
  it('grants the flag to an account no profile can put in an org', () => {
    /* This replaced an invariant that no longer exists. The old rule was
       "keep user 0 in an active org", because `platform.admin` granted the
       operator flag to `users[0]` — Acme's owner — and a profile that put
       user 0's only org in the suspended state would have locked the operator
       out of the product its console sits beside.
     *
     * The operator is now `usersModule`'s `operator`: a dedicated account
     * held OUTSIDE the indexable pool. `OrgPlan.members` can only name an
     * index into `users`, so "the operator is in an org" is not a state any
     * profile can express — which is why the old test's whole class of failure
     * is gone rather than merely unobserved.
     *
     * What is worth asserting instead is that the structural guarantee holds:
     * every member index a profile names must be a real index into the pool,
     * and the pool is exactly the tenant population. An index at or past
     * `users` would silently be the operator's slot if the arrays were ever
     * merged again. */
    for (const profile of Object.values(PROFILES)) {
      for (const org of profile.orgs) {
        for (const member of org.members) {
          expect(member.user, `${profile.name}/${org.slug}`).toBeLessThan(profile.users);
          expect(member.user, `${profile.name}/${org.slug}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('seeds exactly one suspended org in the demo — Globex', () => {
    /* The operator console's Orgs tab needs a row in its suspended state to
       demo reactivation against; the other two tenants stay active so the
       switcher still has somewhere to go. */
    const demo = PROFILES['demo'];
    const suspended = (demo?.orgs ?? []).filter((org) => org.status === 'suspended');
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.slug).toBe('globex');
  });

  it('keeps every other profile fully active', () => {
    /* `minimal` and `large` carry no operator-console demo need, and a
       suspended org there would silently eat most of what they exist to
       exercise — minimal's whole org, large's only tenant.
     *
     * `marketing` is excluded for the opposite reason: it suspends Ironbark
     * DELIBERATELY, and while that org is still paying. Wave 3 keeps
     * `billing_status` and Wave 1's operator-controlled `status` in separate
     * columns precisely so an automated billing recovery cannot undo a manual
     * suspension, and Ironbark is the only fixture anywhere that has both set
     * at once — which is what makes a console that conflated them visibly
     * wrong there and nowhere else. */
    for (const [name, profile] of Object.entries(PROFILES)) {
      if (name === 'demo' || name === 'marketing') continue;
      for (const org of profile.orgs) {
        expect(org.status ?? 'active', `${name}/${org.slug}`).toBe('active');
      }
    }
  });

  it('gives the suspended org real content — reactivation reveals a live tenant', () => {
    /* The point of seeding a suspended org is what an operator sees after
       reactivating it. An empty org would demo nothing. */
    const demo = PROFILES['demo'];
    const globex = demo?.orgs.find((org) => org.slug === 'globex');
    expect(globex?.channels.length ?? 0).toBeGreaterThan(0);
    expect(globex?.projects.length ?? 0).toBeGreaterThan(0);
    expect(globex?.spaces.length ?? 0).toBeGreaterThan(0);
  });
});
