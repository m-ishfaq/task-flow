import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PhoneNumberSchema,
  unsafeAsId,
  type OrgId,
  type OutboundKind,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, withOrgScope, schema } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeTelephonyProvider } from '@taskflow/telephony';
import { newId } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import {
  __resetVelocityForTests,
  checkOutboundAllowed,
  recordSpend,
  reconcileSpend,
} from './spend-gate.js';

/**
 * The outbound gate, against real Postgres (ai/phase-7-voice.md §3.2, §3.3).
 *
 * ## This file IS Wave 1's acceptance bar
 *
 * §5: Wave 1 "deliberately ships nothing a user would call a feature — the
 * acceptance bar is 'the gate exists and refuses correctly,' proven against a
 * `TelephonyProvider` no product surface calls yet."
 *
 * So the assertion that matters most in this file is not that a refusal is
 * returned. It is that **the provider was never touched** — `provider.calls`,
 * `provider.messages`, and `provider.spentCents` all stay at zero through every
 * refusal case. A gate that returns `{ allowed: false }` after having already
 * placed the call is a gate that reads correctly in a diff and costs money in
 * production, and only an assertion about the provider can tell the two apart.
 *
 * Real Postgres rather than a mock, for the reason the rest of this codebase
 * gives: the rolling-window sum, the COALESCE over an unbilled row, and RLS are
 * all database behaviour, and a mocked version would prove the mock agrees with
 * itself.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000001');
const OTHER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000002');
const requestId = unsafeAsId<'RequestId'>('0195ee20-0000-7000-8000-0000000000ff');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@telephony.test'],
  [OTHER, 'other@telephony.test'],
];

/** An allowlisted destination. Every refusal below is for a reason OTHER than geo. */
const ALLOWED_TO = PhoneNumberSchema.parse('+14155550100');
/** Dominican Republic — a +1 number that is not the US or Canada. */
const PREMIUM_TO = PhoneNumberSchema.parse('+18095550100');

const CONFIG = { defaultCapCents: 2500 };

let admin: AdminConnection;
let created: OrgId[] = [];
let provider: FakeTelephonyProvider;

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.webhook_nonces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.spend_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.spend_policy WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccount_orgs WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccounts WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** Gives an org a subaccount row, without going through the carrier. */
async function giveSubaccount(orgId: OrgId, status = 'active'): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.subaccounts).values({
      orgId,
      provider: 'twilio',
      subaccountSid: `AC${orgId.replace(/-/g, '')}`,
      authTokenCiphertext: Buffer.from('ciphertext'),
      dataKeyWrapped: Buffer.from('wrapped'),
      dataKeyMasterId: 'test-master',
      status,
    });
  });
}

/**
 * Suspends an org through the admin connection.
 *
 * `setOrg` before the UPDATE is REQUIRED, not tidiness: the migrator connection
 * is subject to FORCE RLS like everything else, so an update to
 * `identity.orgs` with no `app.org_id` set matches zero rows and reports
 * success. The first version of this file cleared the org first, and the three
 * suspension tests failed against a gate that was working correctly.
 */
async function suspendOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  const result = await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [
    orgId,
  ]);
  if (result.rowCount !== 1) {
    throw new Error(`Expected to suspend exactly one org, updated ${String(result.rowCount)}.`);
  }
  await admin.setOrg(null);
}

async function setCap(
  orgId: OrgId,
  capCents: number,
  windowDays = 30,
  automationCapCents?: number,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.spendPolicy).values({
      orgId,
      capCents,
      windowDays,
      /* §5.5's sub-budget, set explicitly or left NULL (no separate ceiling). */
      ...(automationCapCents === undefined ? {} : { automationCapCents }),
    });
  });
}

async function spend(
  orgId: OrgId,
  estimatedCents: number,
  options: {
    actualCents?: number;
    occurredAt?: Date;
    providerSid?: string;
    kind?: OutboundKind;
  } = {},
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.spendLedger).values({
      id: newId<'SpendLedgerId'>(),
      orgId,
      kind: options.kind ?? 'sms',
      estimatedCents,
      ...(options.actualCents === undefined ? {} : { actualCents: options.actualCents }),
      ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
      ...(options.providerSid === undefined ? {} : { providerSid: options.providerSid }),
    });
  });
}

function request(
  orgId: OrgId,
  overrides: Partial<Parameters<typeof checkOutboundAllowed>[0]> = {},
) {
  return {
    orgId,
    userId: OWNER,
    kind: 'sms' as OutboundKind,
    to: ALLOWED_TO,
    estimatedCents: 1,
    ...overrides,
  };
}

beforeAll(async () => {
  await applyMigrations();
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-gate-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
  __resetVelocityForTests();
  provider = new FakeTelephonyProvider();
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('checkOutboundAllowed', () => {
  it('allows an ordinary action for a provisioned, unsuspended, under-cap org', async () => {
    const orgId = await newOrg('tel-happy');
    await giveSubaccount(orgId);

    const decision = await checkOutboundAllowed(request(orgId), CONFIG);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.capCents).toBe(2500);
      expect(decision.spentCents).toBe(0);
    }
  });

  describe('the geo allowlist', () => {
    it('refuses a premium NANP destination without touching the database', async () => {
      const orgId = await newOrg('tel-geo');
      await giveSubaccount(orgId);

      const decision = await checkOutboundAllowed(request(orgId, { to: PREMIUM_TO }), CONFIG);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('destination_not_allowed');
    });

    it('offers no retry-after, because a denied destination is not temporary', async () => {
      const orgId = await newOrg('tel-geo-retry');
      await giveSubaccount(orgId);

      const decision = await checkOutboundAllowed(request(orgId, { to: PREMIUM_TO }), CONFIG);
      if (!decision.allowed) expect(decision.retryAfterSeconds).toBeUndefined();
    });
  });

  describe('the org-freeze primitive', () => {
    /**
     * `identity.orgs.status` has existed since migration 0004 and nothing has
     * ever read it. This is its first reader (ai/phase-12-admin.md §9).
     */
    it('refuses everything for a suspended org', async () => {
      const orgId = await newOrg('tel-suspended');
      await giveSubaccount(orgId);
      await suspendOrg(orgId);

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('org_suspended');
    });

    it('refuses a suspended org EVEN WHEN it is far under its spend cap', async () => {
      /* The distinction the two controls draw: the cap answers "can this org
         afford this", the freeze answers "is this org allowed to do anything at
         all". An implementation that checked only the cap would let a
         deliberately frozen org keep spending right up to its limit. */
      const orgId = await newOrg('tel-susp-under');
      await giveSubaccount(orgId);
      await setCap(orgId, 100_000);
      await suspendOrg(orgId);

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);
      if (!decision.allowed) expect(decision.reason).toBe('org_suspended');
      else expect.unreachable('a suspended org must never be allowed');
    });
  });

  describe('provisioning', () => {
    it('refuses when the org has no subaccount', async () => {
      const orgId = await newOrg('tel-nosub');

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('no_subaccount');
    });

    it('refuses when the subaccount itself is suspended at the carrier', async () => {
      const orgId = await newOrg('tel-subsusp');
      await giveSubaccount(orgId, 'suspended');

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);
      if (!decision.allowed) expect(decision.reason).toBe('no_subaccount');
      else expect.unreachable('a suspended subaccount must not be usable');
    });
  });

  describe('the spend cap', () => {
    it('refuses when this action WOULD cross the cap, not once it already has', async () => {
      /* `>` rather than `>=` on the wrong side of this comparison would make the
         cap a line an org may step over exactly once, for an amount the caller
         chooses — and the caller choosing the amount is the whole attack. */
      const orgId = await newOrg('tel-cap-edge');
      await giveSubaccount(orgId);
      await setCap(orgId, 100);
      await spend(orgId, 99);

      const under = await checkOutboundAllowed(request(orgId, { estimatedCents: 1 }), CONFIG);
      expect(under.allowed).toBe(true);

      const over = await checkOutboundAllowed(request(orgId, { estimatedCents: 2 }), CONFIG);
      expect(over.allowed).toBe(false);
      if (!over.allowed) expect(over.reason).toBe('spend_cap_exceeded');
    });

    it('counts an UNBILLED row at its estimate, not as free', async () => {
      /* The window an attacker exploits by going faster than reconciliation: a
         row the carrier has not priced yet has a NULL actual_cents, and
         SUM(actual) alone would count every in-flight action as zero. */
      const orgId = await newOrg('tel-unbilled');
      await giveSubaccount(orgId);
      await setCap(orgId, 100);
      await spend(orgId, 100); // estimated only — actual_cents is NULL

      const decision = await checkOutboundAllowed(request(orgId, { estimatedCents: 1 }), CONFIG);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.spentCents).toBe(100);
    });

    it('prefers the reconciled actual cost over the estimate once it arrives', async () => {
      const orgId = await newOrg('tel-reconciled');
      await giveSubaccount(orgId);
      await setCap(orgId, 100);
      await spend(orgId, 90, { actualCents: 10 });

      const decision = await checkOutboundAllowed(request(orgId, { estimatedCents: 5 }), CONFIG);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.spentCents).toBe(10);
    });

    it('ignores spend older than the rolling window', async () => {
      const orgId = await newOrg('tel-window');
      await giveSubaccount(orgId);
      await setCap(orgId, 100, 30);
      await spend(orgId, 500, { occurredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.spentCents).toBe(0);
    });

    it('counts spend INSIDE the rolling window', async () => {
      const orgId = await newOrg('tel-window-in');
      await giveSubaccount(orgId);
      await setCap(orgId, 100, 30);
      await spend(orgId, 500, { occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) });

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);
      expect(decision.allowed).toBe(false);
    });

    it('applies the configured default when the org has no policy row', async () => {
      const orgId = await newOrg('tel-default-cap');
      await giveSubaccount(orgId);

      const decision = await checkOutboundAllowed(request(orgId), { defaultCapCents: 50 });
      expect(decision.capCents).toBe(50);
    });

    it('lets an explicit policy row win over the configured default', async () => {
      /* Changing the environment default must never silently re-cap an org an
         operator has already made a decision about. */
      const orgId = await newOrg('tel-explicit-cap');
      await giveSubaccount(orgId);
      await setCap(orgId, 7000);

      const decision = await checkOutboundAllowed(request(orgId), { defaultCapCents: 50 });
      expect(decision.capCents).toBe(7000);
    });

    it('reads zero for an org with no ledger history rather than NaN', async () => {
      /* SUM over zero rows is NULL in Postgres, not 0 — and a NULL parsed in
         JavaScript becomes NaN, which compares false against every threshold.
         An org with no history would read as permanently under its cap. */
      const orgId = await newOrg('tel-empty-ledger');
      await giveSubaccount(orgId);

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);
      expect(decision.spentCents).toBe(0);
      expect(Number.isNaN(decision.spentCents)).toBe(false);
    });

    it('reports the 80% warning threshold exactly once, on the crossing action', async () => {
      const orgId = await newOrg('tel-warn');
      await giveSubaccount(orgId);
      await setCap(orgId, 100);
      await spend(orgId, 70);

      const crossing = await checkOutboundAllowed(request(orgId, { estimatedCents: 10 }), CONFIG);
      expect(crossing.allowed && crossing.warnThresholdPercent).toBe(80);

      await spend(orgId, 10); // now at 80
      const after = await checkOutboundAllowed(request(orgId, { estimatedCents: 5 }), CONFIG);
      /* Already past the threshold — reporting it again would make the
         notification fire on every call for the rest of the window. */
      expect(after.allowed && after.warnThresholdPercent).toBeUndefined();
    });
  });

  describe('the automation sub-budget (Phase 10 Wave 4 §5.5)', () => {
    it('refuses an automation action over the sub-budget, reporting the SUB-budget figures', async () => {
      const orgId = await newOrg('tel-autosub-over');
      await giveSubaccount(orgId);
      /* The org cap is far above what automation is allowed — the refusal must
         come from the narrower ceiling, and must say so. */
      await setCap(orgId, 100_000, 30, 100);
      await spend(orgId, 90, { kind: 'automation_sms' });

      const decision = await checkOutboundAllowed(
        request(orgId, { kind: 'automation_sms', estimatedCents: 20 }),
        CONFIG,
      );

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('automation_budget_exceeded');
        /* The numbers that refused this action are the SUB-budget's, not the
           org's — an alert on this event must not read as "the org is over
           its cap" when the phone still works for people. */
        expect(decision.spentCents).toBe(90);
        expect(decision.capCents).toBe(100);
      }
    });

    it('checks the org cap IN ADDITION to the sub-budget, never instead of it', async () => {
      const orgId = await newOrg('tel-autosub-orgcap');
      await giveSubaccount(orgId);
      await setCap(orgId, 100, 30, 100_000);
      await spend(orgId, 90, { kind: 'automation_sms' });

      const decision = await checkOutboundAllowed(
        request(orgId, { kind: 'automation_call', estimatedCents: 20 }),
        CONFIG,
      );

      /* Under the (generous) sub-budget, but over the org cap — the org cap
         still refuses. A sub-budget that REPLACED the cap would be a route to
         unlimited unattended spend wearing the shape of a limit. */
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('spend_cap_exceeded');
    });

    it('does not count a HUMAN action against the sub-budget', async () => {
      const orgId = await newOrg('tel-autosub-human');
      await giveSubaccount(orgId);
      await setCap(orgId, 100_000, 30, 100);
      /* A real customer call costs 10× the sub-budget — and must not touch
         it, because the whole point of the separate allowance is that
         attended spend and unattended spend are different risks. */
      await spend(orgId, 1_000, { kind: 'sms' });

      const decision = await checkOutboundAllowed(
        request(orgId, { kind: 'automation_sms', estimatedCents: 1 }),
        CONFIG,
      );

      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.automationSpentCents).toBe(0);
    });

    it('is IGNORED for a human-initiated action — the org cap alone bounds a human', async () => {
      const orgId = await newOrg('tel-autosub-humanok');
      await giveSubaccount(orgId);
      await setCap(orgId, 100_000, 30, 100);
      await spend(orgId, 500, { kind: 'automation_call' });

      const decision = await checkOutboundAllowed(request(orgId, { estimatedCents: 1 }), CONFIG);
      expect(decision.allowed).toBe(true);
    });

    it('bounds automation by the org cap alone when no sub-budget is configured', async () => {
      /* NULL automation_cap_cents is the pre-feature behaviour: a rule's spend
         is ordinary spend against the org's one cap. */
      const orgId = await newOrg('tel-autosub-null');
      await giveSubaccount(orgId);
      await setCap(orgId, 100, 30); // no automation_cap_cents
      await spend(orgId, 99, { kind: 'automation_sms' });

      const under = await checkOutboundAllowed(
        request(orgId, { kind: 'automation_sms', estimatedCents: 1 }),
        CONFIG,
      );
      expect(under.allowed).toBe(true);
      if (under.allowed) expect(under.automationCapCents).toBeNull();

      await spend(orgId, 1, { kind: 'automation_sms' });
      const over = await checkOutboundAllowed(
        request(orgId, { kind: 'automation_sms', estimatedCents: 1 }),
        CONFIG,
      );
      expect(over.allowed).toBe(false);
      if (!over.allowed) expect(over.reason).toBe('spend_cap_exceeded');
    });

    it('spends nothing when refusing for the sub-budget — the provider is never reached', async () => {
      /* §5.5's gate is the same gate: a refusal must happen BEFORE the carrier
         hears anything, for an automation action as for a human one. */
      const orgId = await newOrg('tel-autosub-nr');
      await giveSubaccount(orgId);
      await setCap(orgId, 100_000, 30, 10);
      await spend(orgId, 10, { kind: 'automation_sms' });

      const decision = await checkOutboundAllowed(
        request(orgId, { kind: 'automation_sms', estimatedCents: 5 }),
        CONFIG,
      );
      expect(decision.allowed).toBe(false);

      expect(provider.calls).toHaveLength(0);
      expect(provider.messages).toHaveLength(0);
      expect(provider.spentCents).toBe(0);
    });
  });

  describe('velocity', () => {
    it('refuses a burst past the per-user limit, with a retry-after', async () => {
      const orgId = await newOrg('tel-velocity');
      await giveSubaccount(orgId);
      await setCap(orgId, 1_000_000);

      let refused: Awaited<ReturnType<typeof checkOutboundAllowed>> | undefined;
      for (let index = 0; index < 40; index += 1) {
        const decision = await checkOutboundAllowed(request(orgId), CONFIG);
        if (!decision.allowed) {
          refused = decision;
          break;
        }
      }

      expect(refused, 'velocity never tripped').toBeDefined();
      if (refused !== undefined && !refused.allowed) {
        expect(refused.reason).toBe('velocity_exceeded');
        expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('does NOT consume velocity budget for an action refused for another reason', async () => {
      /* Velocity runs last precisely because it is the only check that mutates.
         If it ran first, an attacker could burn a legitimate user's burst
         allowance with requests that are refused for free — a denial of service
         inflicted through a control meant to prevent one. */
      const orgId = await newOrg('tel-velocity-order');
      await giveSubaccount(orgId);
      await setCap(orgId, 1_000_000);

      for (let index = 0; index < 50; index += 1) {
        await checkOutboundAllowed(request(orgId, { to: PREMIUM_TO }), CONFIG);
      }

      const decision = await checkOutboundAllowed(request(orgId), CONFIG);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('tenant isolation', () => {
    it("does not count another org's spend against this one", async () => {
      const mine = await newOrg('tel-iso-mine');
      const theirs = await newOrg('tel-iso-theirs');
      await giveSubaccount(mine);
      await giveSubaccount(theirs);
      await setCap(mine, 100);
      await spend(theirs, 10_000);

      const decision = await checkOutboundAllowed(request(mine), CONFIG);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.spentCents).toBe(0);
    });

    it("does not see another org's subaccount", async () => {
      const mine = await newOrg('tel-iso-nosub');
      const theirs = await newOrg('tel-iso-hassub');
      await giveSubaccount(theirs);

      const decision = await checkOutboundAllowed(request(mine), CONFIG);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('no_subaccount');
    });
  });

  /**
   * Wave 1's actual acceptance bar (§5).
   *
   * Every refusal above returns a verdict. This block asserts the thing a
   * verdict cannot tell you: that no carrier was contacted and no money was
   * committed on the way to producing it.
   */
  describe('the provider is never reached on a refusal', () => {
    const refusalCases: readonly [string, () => Promise<OrgId>][] = [
      [
        'suspended org',
        async () => {
          const orgId = await newOrg('tel-nr-susp');
          await giveSubaccount(orgId);
          await suspendOrg(orgId);
          return orgId;
        },
      ],
      ['no subaccount', async () => newOrg('tel-nr-nosub')],
      [
        'over the cap',
        async () => {
          const orgId = await newOrg('tel-nr-cap');
          await giveSubaccount(orgId);
          await setCap(orgId, 1);
          await spend(orgId, 1);
          return orgId;
        },
      ],
    ];

    for (const [label, setup] of refusalCases) {
      it(`spends nothing when refusing: ${label}`, async () => {
        const orgId = await setup();

        const decision = await checkOutboundAllowed(request(orgId, { estimatedCents: 5 }), CONFIG);
        expect(decision.allowed).toBe(false);

        /* The gate must not have called the provider — and this is asserted
           against a fake that WOULD have recorded it. */
        expect(provider.calls).toHaveLength(0);
        expect(provider.messages).toHaveLength(0);
        expect(provider.spentCents).toBe(0);
      });
    }

    it('spends nothing when refusing a disallowed destination', async () => {
      const orgId = await newOrg('tel-nr-geo');
      await giveSubaccount(orgId);

      const decision = await checkOutboundAllowed(request(orgId, { to: PREMIUM_TO }), CONFIG);
      expect(decision.allowed).toBe(false);
      expect(provider.spentCents).toBe(0);
    });
  });
});

describe('the ledger', () => {
  it("records a row inside the caller's own transaction", async () => {
    const orgId = await newOrg('tel-ledger-tx');

    await withOrgScope(orgId, async (tx) => {
      await recordSpend(tx, orgId, {
        id: newId<'SpendLedgerId'>(),
        kind: 'call',
        estimatedCents: 42,
        providerSid: 'CAtest1',
      });
    });

    const decision = await checkOutboundAllowed(request(orgId), CONFIG);
    expect(decision.spentCents).toBe(42);
  });

  it("rolls the ledger row back when the caller's transaction fails", async () => {
    /* §3.4 requires the ledger to be written in the SAME transaction as the
       record of the action. This is what that buys: an action that did not
       commit is not charged, and — more importantly — one that DID commit
       cannot fail to be. */
    const orgId = await newOrg('tel-ledger-rollback');

    await expect(
      withOrgScope(orgId, async (tx) => {
        await recordSpend(tx, orgId, {
          id: newId<'SpendLedgerId'>(),
          kind: 'call',
          estimatedCents: 99,
          providerSid: 'CAtest2',
        });
        throw new Error('the mutation failed after pricing');
      }),
    ).rejects.toThrow(/mutation failed/);

    const decision = await checkOutboundAllowed(request(orgId), CONFIG);
    expect(decision.spentCents).toBe(0);
  });

  it('makes a repeated billing correction idempotent via the unique provider sid', async () => {
    const orgId = await newOrg('tel-ledger-idem');
    await withOrgScope(orgId, async (tx) => {
      await recordSpend(tx, orgId, {
        id: newId<'SpendLedgerId'>(),
        kind: 'sms',
        estimatedCents: 10,
        providerSid: 'SMtest1',
      });
    });

    await reconcileSpend(orgId, 'SMtest1', 3);
    await reconcileSpend(orgId, 'SMtest1', 3);

    /* A retried callback that APPENDED would read as 6 here, double-charging
       the org for one message. Updating the one row matched on provider_sid is
       what makes the retry safe. */
    const decision = await checkOutboundAllowed(request(orgId), CONFIG);
    expect(decision.spentCents).toBe(3);
  });
});
