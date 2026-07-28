import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { unsafeAsId } from '@taskflow/contracts';
import { enforce, type ResourceRef } from '@taskflow/policy';
import { createCallerFactory, route, router } from '../trpc/builder.js';
import { subjectOf, type RequestContext } from '../trpc/context.js';
import { assertNoTenancyLeaks, runTenancyFuzz, type FuzzOrg } from './tenancy-fuzz.js';
import { testAppRouter } from './fixtures.js';

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

  it('skips public routes, which have no tenant to cross', async () => {
    // health.live takes no ids and belongs to nobody. Enrolling it would produce
    // a permanent false positive that people learn to ignore.
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    expect(results).toEqual([]);
  });
});

describe('the application router', () => {
  it('has no cross-tenant leaks', async () => {
    // Phase 0B ships no product routes, so this passes trivially today. It is
    // here so that the first route added is covered by it automatically — which
    // is the entire design.
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker,
      victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    assertNoTenancyLeaks(results);
  });
});
