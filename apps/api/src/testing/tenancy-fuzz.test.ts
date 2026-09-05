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
      'work.cards.setStatus',
      'work.cards.archive',
      'work.labels.create',
      'work.labels.update',
      'work.labels.delete',
      'work.labels.setOnCard',
      'work.statuses.create',
      'work.statuses.update',
      'work.statuses.delete',
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

  /**
   * The Chat routes (Phase 5, ai/phase-5-chat.md §6.4).
   *
   * Named explicitly for the same reason Work's are: a route whose input schema
   * stops matching the seeded bag silently drops to `not-applicable` and takes
   * its coverage with it.
   *
   * Two of these are worth more than the rest. `channels.addMember` writes a
   * relationship TUPLE, so a cross-tenant leak there is not a data read — it is
   * granting somebody access, in another organization, permanently, through a
   * table the policy engine consults on every request. And `channels.openDirect`
   * takes a user id rather than a channel id, so it is the one route here that
   * could name a person in another tenant rather than a resource; a leak would
   * write a membership row about someone who has never heard of this org.
   */
  it('enrols the Chat routes and denies every one of them', async () => {
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker: seeded.attacker,
      victim: seeded.victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    const byPath = new Map(results.map((result) => [result.path, result.outcome]));

    for (const path of [
      'chat.channels.get',
      'chat.channels.create',
      'chat.channels.openDirect',
      'chat.channels.update',
      'chat.channels.archive',
      'chat.channels.addMember',
      'chat.channels.removeMember',
      'chat.messages.list',
      'chat.messages.thread',
      'chat.messages.send',
      'chat.messages.edit',
      'chat.messages.delete',

      /* Wave 3. `attachments.download` is the one that matters most here, for
         the same reason Work's does: a leak hands org A a signed URL to org B's
         file, and the fetch that follows never touches this server, so nothing
         downstream could catch it. */
      'chat.attachments.presign',
      'chat.attachments.confirm',
      'chat.attachments.download',
      'chat.attachments.list',
      'chat.attachments.delete',
      'chat.unfurls.list',

      /* Wave 4. Two of these are worse than a read leak if they cross a tenant.
         `setGuest` writes a relationship TUPLE — granting somebody access, in
         another organization, through the table the policy engine consults on
         every request. `export` returns the entire contents of a channel, which
         is the single largest disclosure this API can produce in one call. */
      'chat.compliance.setRetention',
      'chat.compliance.holdChannel',
      'chat.compliance.holdMessage',
      'chat.compliance.listGuests',
      'chat.compliance.setGuest',
      'chat.compliance.export',

      /* Saved messages. `saved.save` is the interesting one: it writes a row
         naming a message, so a cross-tenant leak would bookmark another
         organization's conversation into this one's sidebar. */
      'chat.saved.save',
      'chat.saved.unsave',
    ]) {
      expect(byPath.get(path), `${path} was not enrolled by the fuzz harness`).toBe('denied');
    }
  });

  it('enrols notifications.markRead and denies it (Phase 9)', async () => {
    /* No longer under `chat.*` — Work and Docs produce notifications too
       (migration 0027), so this moved to its own top-level router
       (`platform/router.ts`). Still a `memberRoute`, not a `selfRoute`, so it
       is still enrolled: it reads `platform.notifications`, which is
       genuinely per-org, through `withOrgScope` — see `memberRoute`'s own
       comment in `trpc/builder.ts` for why no single `Permission` gates it.
       Takes a `notificationId`, unlike listMine/markAllRead/unreadCount
       below — `markRead` names a specific row, so a cross-tenant
       substitution would let one org silence (mark read) another org's
       notification. */
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker: seeded.attacker,
      victim: seeded.victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    const byPath = new Map(results.map((result) => [result.path, result.outcome]));
    expect(byPath.get('notifications.markRead')).toBe('denied');
  });

  it('enrols the Docs mutations and denies every one of them', async () => {
    const results = await runTenancyFuzz({
      router: appRouter,
      attacker: seeded.attacker,
      victim: seeded.victim,
      callerFor: (context) => callerFor(context, appRouter),
    });

    const byPath = new Map(results.map((result) => [result.path, result.outcome]));

    for (const path of [
      // Waves 1-2. `pages.move` reparents/reorders — a cross-tenant hit would
      // relocate another org's page. `pageVersions.restore` overwrites live
      // content from a snapshot, the single most destructive Docs mutation.
      'docs.spaces.create',
      'docs.spaces.archive',
      'docs.pages.create',
      'docs.pages.update',
      'docs.pages.move',
      'docs.pages.archive',
      'docs.pageVersions.save',
      'docs.pageVersions.restore',

      // Wave 3. `comments.create`/`suggestions.create` are the two that
      // matter most here: each takes a `pageId` naming WHOSE page to attach
      // to, so a cross-tenant hit would write this attacker's words, or a
      // proposed edit, into another organization's document.
      'docs.comments.create',
      'docs.comments.update',
      'docs.comments.resolve',
      'docs.comments.delete',
      'docs.suggestions.create',
      'docs.suggestions.decide',

      // Wave 4 (§3.9, §5). `pages.publish` writes a new page_versions row
      // AND repoints another org's page at it — one of the more consequential
      // possible cross-tenant writes in this whole router. `templates.delete`
      // and `templates.createPage` both take a `templateId` naming whose
      // template to act on.
      'docs.pages.publish',
      'docs.pages.unpublish',
      'docs.pages.exportPdf',
      'docs.templates.list',
      'docs.templates.create',
      'docs.templates.delete',
      'docs.templates.createPage',
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
      /* `analytics.status` and `analytics.backfill` (Phase 11) read/act on the
         CALLER's own org via `ctx.principal.org.orgId` and take no id — the
         other analytics routes (velocity, burndown, cfd, cycleTime, workload,
         volume, spend) all take a date range or a board/project id this
         technique substitutes, so they are enrolled and denied like any other.
         `analytics:read` is answered from ROLE ALONE, so there is no
         per-resource target for the fuzzer to cross anyway. */
      'analytics.backfill',
      'analytics.status',
      /* All seven read/act on the CALLER's own org (`ctx.principal.org.orgId`,
         Phase 12 Wave 3 §3.1) and take no id — `createCheckoutSession` and
         `changePlan` are NOT here because they take a `planId` this
         technique can substitute.

         `billing.listPlans` (Phase 12 Wave 4) is input-less for a stronger
         reason than the others: the catalog it reads carries no `org_id`
         AT ALL. A plan belongs to no tenant, so there is no cross-tenant read
         to attempt here — the only thing org-relative about the route is that
         `org:billing` decides who may see the price list.

         `cancelPlan`, `overview`, `reconcile` and `resumePlan` (Phase 12
         Wave 4) are the rest of the billing surface added alongside
         `changePlan`: each mutates or reads the caller's own subscription by
         `ctx.principal.org.orgId` alone, with nothing in the request this
         technique could substitute another org's id into. */
      'billing.cancelPlan',
      'billing.createPortalSession',
      'billing.listPlans',
      'billing.overview',
      'billing.reconcile',
      'billing.resumePlan',
      'billing.status',
      /* `chat.channels.list` reads the caller's own tuples and their org's
         public channels. There is no id to substitute, so calling it with the
         victim's bag returns the ATTACKER's own channels and succeeds — which
         the harness would otherwise report as a leak, permanently. RLS's own
         tests and `chat-rooms.test.ts` cover it instead. */
      'chat.channels.list',
      /* Same shape as `chat.saved.list` below — every pin the caller can
         still see, across every channel, re-checked per channel inside the
         service rather than by an id this technique could substitute. */
      'chat.messages.allPins',
      'chat.saved.list',
      /* Same shape as `chat.channels.list` above — every space in the
         CALLER's org, filtered by RLS alone. There is no id to substitute;
         calling it with the victim's bag returns the attacker's own org's
         spaces and succeeds, which this technique cannot distinguish from a
         leak. The RLS tests cover cross-tenant isolation instead. */
      'docs.spaces.list',
      /* Three that read the CALLER's own rows and take no id — the scope is
         entirely the principal's, so there is nothing for this technique to
         substitute. Covered by the RLS tests and by their own suites. No
         longer under `chat.*` (Phase 9, migration 0027) — see the
         `notifications.markRead` test above for why the move happened.
         Sorted alongside `tenancy.*` below rather than where `chat.*` used
         to put them: this array is asserted against `.sort()`ed output. */
      'notifications.listMine',
      'notifications.markAllRead',
      'notifications.unreadCount',
      'tenancy.audit.verify',
      /* Same shape as `tenancy.members.list` directly below — every active
         individual permission grant in the CALLER's org
         (ai/phase-15-ai-copilot-and-permissions.md §1), read via
         `ctx.principal.org.orgId` alone with no id this technique could
         substitute. */
      'tenancy.memberGrants.list',
      'tenancy.members.list',
      'tenancy.orgs.get',
      'tenancy.teams.list',
    ]);
  });
});
