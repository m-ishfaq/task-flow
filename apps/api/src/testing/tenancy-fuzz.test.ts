import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { unsafeAsId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { enforce, type ResourceRef } from '@taskflow/policy';
import { createCallerFactory, route, router } from '../trpc/builder.js';
import { subjectOf, type RequestContext } from '../trpc/context.js';
import { assertNoTenancyLeaks, runTenancyFuzz, type FuzzOrg } from './tenancy-fuzz.js';
import { seedFuzzTenants, type SeededTenants } from './tenancy-seed.js';
import { testAppRouter, TEST_ENV } from './fixtures.js';

/**
 * GUARDRAIL 8 — cross-tenant isolation at the HTTP boundary (PLAN.md §2.1).
 *
 * The harness itself is the deliverable; these tests prove it can tell a leak
 * from a refusal. A fuzz test that passes because it never actually reached the
 * handler is the worst possible outcome — it reports coverage it does not have,
 * which is exactly the failure that killed three ESLint guardrails in this repo
 * earlier.
 */

const ORG_A = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-00000000000a');
const ORG_B = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-00000000000b');

const attacker: FuzzOrg = {
  orgId: ORG_A,
  userId: unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000a1'),
  role: 'owner',
  resourceIds: { cardId: 'card-a' },
};

const victim: FuzzOrg = {
  orgId: ORG_B,
  userId: unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000b1'),
  role: 'owner',
  resourceIds: { cardId: 'card-b' },
};

/** Stands in for the database: which org each card belongs to. */
const CARD_OWNER: Readonly<Record<string, typeof ORG_A>> = {
  'card-a': ORG_A,
  'card-b': ORG_B,
};

const { router: appRouter } = testAppRouter();

const cardRef = (cardId: string): ResourceRef => ({ type: 'card', id: cardId });

function callerFor(
  context: RequestContext,
  appliedRouter: Parameters<typeof createCallerFactory>[0],
) {
  return createCallerFactory(appliedRouter)(context) as unknown as Record<string, unknown>;
}

/* A correctly written router: loads the row, then authorizes against the row's
   OWN org — never against an org id taken from the request. */
const safeRouter = router({
  cards: router({
    get: route({ permission: 'card:read' })
      .input(z.object({ cardId: z.string() }))
      .query(({ ctx, input }) => {
        const ownerOrg = CARD_OWNER[input.cardId];
        if (!ownerOrg) throw new Error('not found');

        enforce(subjectOf(ctx.principal), 'card:read', {
          orgId: ownerOrg,
          resource: cardRef(input.cardId),
        });
        return { cardId: input.cardId };
      }),
  }),
});

/* The bug this guardrail exists to catch: the handler takes an id from the
   request and returns the row without checking whose it is. Three lines,
   passes review, works perfectly for whoever reported the bug it was fixing. */
const leakyRouter = router({
  cards: router({
    get: route({ permission: 'card:read' })
      .input(z.object({ cardId: z.string() }))
      .query(({ input }) => ({ cardId: input.cardId })),
  }),
});

describe('runTenancyFuzz', () => {
  it('reports a refusal when the handler authorizes against the row', async () => {
    const results = await runTenancyFuzz({
      router: safeRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, safeRouter),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe('denied');
    // The handler was actually reached. Without this the whole suite could pass
    // on a harness that never resolved a single route.
    expect(results[0]?.detail).toBe('NOT_FOUND');
    expect(() => {
      assertNoTenancyLeaks(results);
    }).not.toThrow();
  });

  it("catches a handler that returns another tenant's row", async () => {
    const results = await runTenancyFuzz({
      router: leakyRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, leakyRouter),
    });

    expect(results[0]?.outcome).toBe('leaked');
    expect(() => {
      assertNoTenancyLeaks(results);
    }).toThrow(/LEAKED/);
  });

  it('enrolls new routes without anyone updating a list', async () => {
    // The property that makes the guardrail hold over time. A hand-maintained
    // list of endpoints to check goes stale silently, always toward less
    // coverage.
    const grown = router({
      cards: router({
        get: route({ permission: 'card:read' })
          .input(z.object({ cardId: z.string() }))
          .query(({ input }) => ({ cardId: input.cardId })),
        archive: route({ permission: 'card:delete' })
          .input(z.object({ cardId: z.string() }))
          .mutation(({ input }) => ({ cardId: input.cardId })),
      }),
    });

    const results = await runTenancyFuzz({
      router: grown,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, grown),
    });

    expect(results.map((result) => result.path).sort()).toEqual(['cards.archive', 'cards.get']);
    expect(results.every((result) => result.outcome === 'leaked')).toBe(true);
  });

  it('treats an unexpected error as a failure, not a pass', async () => {
    // A 500 means the handler did not refuse on purpose — it fell over. The next
    // change to it could just as easily fall over into success.
    const brokenRouter = router({
      cards: router({
        get: route({ permission: 'card:read' })
          .input(z.object({ cardId: z.string() }))
          .query(() => {
            throw new Error('null pointer somewhere');
          }),
      }),
    });

    const results = await runTenancyFuzz({
      router: brokenRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, brokenRouter),
    });

    expect(results[0]?.outcome).toBe('errored');
    // Specifically because the HANDLER threw — not because the harness failed to
    // resolve the route, which reports the same outcome and would let this test
    // pass without ever calling anything.
    expect(results[0]?.detail).not.toMatch(/not callable/);
    expect(() => {
      assertNoTenancyLeaks(results);
    }).toThrow(/ERRORED/);
  });

  it('records an exclusion with its justification', async () => {
    const results = await runTenancyFuzz({
      router: leakyRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, leakyRouter),
      exclude: { 'cards.get': 'covered by a dedicated test in the cards slice' },
    });

    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.detail).toMatch(/dedicated test/);
  });

  it('enrols no public or self-scoped route, which have no tenant to cross', async () => {
    /* `health.live` takes no ids and belongs to nobody; `auth.login` is how a
       session is obtained; `tenancy.orgs.create` deliberately runs without a
       membership. Enrolling any of them would produce a permanent false
       positive, and a guardrail that always reports something is one people
       learn to scroll past. */
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    const enrolled = new Set(results.map((result) => result.path));
    for (const path of ['health.live', 'auth.login', 'auth.register', 'tenancy.orgs.create']) {
      expect(enrolled.has(path)).toBe(false);
    }
  });
});

/**
 * The real thing, against real Postgres (`docker compose up -d`).
 *
 * The tests above prove the HARNESS can tell a leak from a refusal, using
 * hand-written routers and no database. This one runs every permission-bearing
 * route in the application as org A's owner, holding org B's ids, through the
 * same RLS the production path uses.
 *
 * It needs a database for a reason worth stating: before Phase 2 no registered
 * route touched storage, so this suite passed with no database at all. Every
 * tenancy route opens `withOrgScope`, and against an uninitialized pool they
 * all throw — reported as ERRORED, which is a failure and not a pass, but which
 * would have proved nothing about isolation either way.
 */
describe('the application router', () => {
  let seeded: SeededTenants;

  beforeAll(async () => {
    seeded = await seedFuzzTenants();
    initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-fuzz' });
  });

  afterAll(async () => {
    await closeDatabase();
    await seeded.cleanup();
  });

  it('has no cross-tenant leaks', async () => {
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker: seeded.attacker,
      victim: seeded.victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    /* A run that reached nothing would pass `assertNoTenancyLeaks` trivially.
       Asserting coverage first is what stops this becoming a green test over an
       empty list — the failure mode that killed three ESLint guardrails in this
       repo earlier. */
    const attempted = results.filter((result) => result.outcome !== 'not-applicable');
    expect(attempted.length).toBeGreaterThan(10);
    expect(attempted.every((result) => result.outcome === 'denied')).toBe(true);

    assertNoTenancyLeaks(results);
  });

  /**
   * Coverage of the WRITE paths specifically.
   *
   * The test above would stay green if every Work route had quietly become
   * `not-applicable` — a route whose input schema stopped matching the seeded
   * id bag drops out of `attempted` and takes its own coverage with it, in
   * silence. These are the routes where a cross-tenant call would WRITE rather
   * than read, so naming them is worth the maintenance: `cards.move` is the one
   * that could relocate another tenant's card onto this tenant's board.
   */
  it('enrols the Work mutations and denies every one of them', async () => {
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker: seeded.attacker,
      victim: seeded.victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    const byPath = new Map(results.map((result) => [result.path, result.outcome]));

    for (const path of [
      'work.projects.update',
      'work.projects.archive',
      'work.boards.create',
      'work.boards.update',
      'work.boards.archive',
      'work.lists.create',
      'work.lists.update',
      'work.lists.reorder',
      'work.lists.archive',
      'work.cards.create',
      'work.cards.update',
      'work.cards.move',
      'work.cards.assign',
      'work.cards.archive',
      'work.labels.create',
      'work.labels.update',
      'work.labels.delete',
      'work.labels.setOnCard',
      'work.checklists.create',
      'work.checklists.delete',
      'work.checklists.addItem',
      'work.checklists.updateItem',
      'work.checklists.deleteItem',
      'work.fields.create',
      'work.fields.update',
      'work.fields.archive',
      'work.fields.setOnCard',
      'work.comments.create',
      'work.comments.update',
      'work.comments.delete',
      /* Attachments (§8.4). `download` is the one that matters most here: a
         leak would hand org A a signed URL to org B's file, and the fetch that
         follows never touches this server, so nothing downstream could catch
         it. */
      'work.attachments.presign',
      'work.attachments.confirm',
      'work.attachments.download',
      'work.attachments.delete',
    ]) {
      expect(byPath.get(path), `${path} was not enrolled by the fuzz harness`).toBe('denied');
    }
  });

  it('marks input-less routes not-applicable rather than silently passing them', async () => {
    /* These four read their org from the principal and accept no identifier, so
       there is nothing for this technique to substitute. Naming them here keeps
       the exemption visible: if one gains an input it is enrolled automatically
       and drops out of this list, which fails this test and says so. */
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker: seeded.attacker,
      victim: seeded.victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    const exempt = results
      .filter((result) => result.outcome === 'not-applicable')
      .map((result) => result.path)
      .sort();

    expect(exempt).toEqual([
      'tenancy.audit.verify',
      'tenancy.members.list',
      'tenancy.orgs.get',
      'tenancy.teams.list',
    ]);
  });
});
