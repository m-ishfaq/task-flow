import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCallerFactory, publicRoute, route, router, selfRoute } from '../trpc/builder.js';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import {
  API_TOKEN_DAILY_QUOTA,
  API_TOKEN_EXPENSIVE_DAILY_QUOTA,
  closeDatabase,
  initializeApiTokenAuthDatabase,
  initializeDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { issueToken, masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import { createAutomationRouter } from '../automation/router.js';
import { TEST_ENV, testContext } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import { mintApiToken, revokeApiToken } from '../automation/api-token.service.js';
import type { AutomationActor } from '../automation/automation.service.js';
import { authenticateWithApiToken } from './api-token-auth.js';

/**
 * The API-token authentication path (ai/phase-10-automation.md §6.4, Wave 3
 * slice 3). ⚠ The auth path is a human-review surface (§2.2) — this suite is
 * what pins its behaviour so the review has something to disagree with.
 *
 * The function itself (authenticateWithApiToken) is unit-tested against real
 * Postgres. The BUILDER GATE (scope ∩ permission, self/step-up refusal) is
 * tested through the real `route()`/`selfRoute()` builders with a token
 * principal — the same shape guardrails.test.ts uses for its own gates.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000001');
const ADMIN = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@api-token-auth.test'],
  [ADMIN, 'admin@api-token-auth.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee30-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: AutomationActor['subject']['role'],
): Promise<AutomationActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

/** An org with an owner, and a minted token owned by that owner. */
async function scaffold(
  slug: string,
  scopes: readonly string[] = ['card:read'],
): Promise<{
  orgId: OrgId;
  owner: AutomationActor;
  token: string;
  tokenId: string;
}> {
  fixtureCounter += 1;
  const uniqueSlug = `au-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Auth ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  const owner = await actorFor(result.orgId, OWNER, 'owner');
  const issued = await mintApiToken(owner, { name: 'CI', scopes });
  return { orgId: result.orgId, owner, token: issued.token, tokenId: issued.tokenId };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'platform.api_tokens',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-api-token-auth' });
  initializeApiTokenAuthDatabase({
    url: 'postgresql://taskflow_api_token_auth:api-token-auth-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-api-token-auth-test',
  });
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('authenticateWithApiToken — the resolution path', () => {
  it('resolves a valid token to a principal whose org comes from the token', async () => {
    const { orgId, token } = await scaffold('valid');

    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);

    expect(principal).not.toBeNull();
    /* The token always resolves an org (§6.4 step 3), but the principal type
       leaves it nullable — chain, as the other assertions here do. */
    expect(principal?.org?.orgId).toBe(orgId);
    expect(principal?.userId).toBe(OWNER);
    expect(principal?.tokenScopes).toEqual(['card:read']);
    expect(principal?.sessionId).not.toBe('');
    expect(principal?.authenticatedAt).toBeInstanceOf(Date);
  });

  it('refuses anything that is not a tf_pat token', async () => {
    const { token } = await scaffold('wrongkind');

    /* A JWT-shaped bearer is not this path's business — it belongs to
       `authenticate`, and feeding it here must not authenticate. */
    await expect(authenticateWithApiToken(`Bearer not-a-jwt`, undefined)).resolves.toBeNull();
    await expect(
      authenticateWithApiToken(`Bearer ${token.replace('tf_pat_', 'tf_rt_')}`, undefined),
    ).resolves.toBeNull();
  });

  it('refuses a revoked token', async () => {
    const { orgId, owner, token } = await scaffold('revoked');

    const revoked = await mintApiToken(owner, { name: 'Revoked', scopes: ['card:read'] });
    await revokeApiToken(owner, { tokenId: revoked.tokenId });

    await expect(
      authenticateWithApiToken(`Bearer ${revoked.token}`, undefined),
    ).resolves.toBeNull();
    /* The still-live token from the scaffold keeps working. */
    await expect(authenticateWithApiToken(`Bearer ${token}`, undefined)).resolves.not.toBeNull();
    expect(orgId.length).toBeGreaterThan(0);
  });

  it('refuses an unknown token', async () => {
    const issued = issueToken('apiToken');
    await expect(authenticateWithApiToken(`Bearer ${issued.token}`, undefined)).resolves.toBeNull();
  });

  it('refuses a token whose holder no longer has a membership', async () => {
    const { orgId, token } = await scaffold('gone');

    /* The membership is the token's life support: delete it (as an admin,
       because the last-owner protection would rightly refuse removing the
       org's only owner through the service), and the next request with the
       same token resolves to nothing — no cached role, no window. This is
       the "a token does not outlive its holder's membership" claim. */
    /* RLS-scoped write: identity.memberships forces RLS keyed on
       app.org_id, so the delete must run under the org it targets. */
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1 AND user_id = $2`, [
      orgId,
      OWNER,
    ]);
    await admin.setOrg(null);

    await expect(authenticateWithApiToken(`Bearer ${token}`, undefined)).resolves.toBeNull();
  });

  /* NOTE on the demotion test: it lives in the BUILDER GATE section, not
     here. A demoted holder is still a member, so `authenticateWithApiToken`
     still resolves them — the refusal happens at the route, where the scope
     set is intersected with the live `can()` (see below). */

  it('refuses a token for an org that was suspended', async () => {
    const { orgId, token } = await scaffold('suspended');

    /* The refusal is a NULL principal, deliberately not a thrown
       ORG_SUSPENDED. `resolveOrgMembership` does throw for a suspended org
       (pinned in the platform-admin suite), but propagated out of
       `createContext` that AppError would be converted by the tRPC adapter
       into a 500 — the mapErrors middleware that maps AppErrors to their
       proper codes only wraps procedures, never the context builder — while
       the JWT path swallows the same throw inside `withOrgContext` and lets
       the route answer. Null → UNAUTHENTICATED → fail-closed routes refuse:
       the same refusal every other invalid credential gets. RLS-scoped write,
       as the tenancy suspension suite does it: the org row IS the tenant, so
       it is admitted under its own org scope. */
    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [orgId]);
    await admin.setOrg(null);

    await expect(authenticateWithApiToken(`Bearer ${token}`, undefined)).resolves.toBeNull();
  });

  it('accepts a header that agrees with the token org, and refuses one that does not', async () => {
    const { orgId, token } = await scaffold('header');

    /* Absent header: fine — the token names its org. */
    await expect(authenticateWithApiToken(`Bearer ${token}`, undefined)).resolves.not.toBeNull();

    /* Agreeing header: fine. */
    await expect(authenticateWithApiToken(`Bearer ${token}`, orgId)).resolves.not.toBeNull();

    /* Disagreeing header: REFUSED, not ignored (decision 11). A token minted
       for org A must not be steerable at org B by sending a header — and the
       refusal must be a refusal, not a silent no-op. */
    const otherOrg = unsafeAsId<'OrgId'>('0195ee30-0000-7000-8000-00000000000f');
    await expect(authenticateWithApiToken(`Bearer ${token}`, otherOrg)).resolves.toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * The builder gate — the same `route()` and `selfRoute()` builders the real
 * router uses, fed a token principal. A minimal router keeps the assertion
 * on the GATE rather than on some unrelated route's service.
 * ------------------------------------------------------------------------- */

function tokenContext(
  principal: NonNullable<Awaited<ReturnType<typeof authenticateWithApiToken>>>,
) {
  return testContext({ principal });
}

/* Module scope so the quota suite (below) can drive the same routes. */
const gateRouter = router({
  cards: router({
    read: route({ permission: 'card:read' }).query(() => 'read'),
    update: route({ permission: 'card:update' }).query(() => 'update'),
  }),
  /* `stepUp: true` — the marker slice 2's mint/revoke routes carry. */
  admin: route({ permission: 'apiToken:create', stepUp: true }).query(() => 'mint'),
  me: selfRoute({ selfReason: 'Reading your own profile.' }).query(() => 'me'),
  public: publicRoute({ publicReason: 'Test fixture route.' }).query(() => 'public'),
  /* The expensive class (§6.5): the search permission is what a real
     expensive route declares, and the token minted below holds it. */
  search: route({ permission: 'search:query', quotaClass: 'expensive' }).query(() => 'search'),
});

describe('the builder gate for token principals', () => {
  it('lets a card:read-scoped token through a card:read route', async () => {
    const { token } = await scaffold('gate-ok');
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();

    const caller = createCallerFactory(gateRouter)(tokenContext(principal!));
    await expect(caller.cards.read()).resolves.toBe('read');
  });

  it('refuses a card:read-scoped token on a card:update route — the scope intersection', async () => {
    const { token } = await scaffold('gate-scope');
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();

    const caller = createCallerFactory(gateRouter)(tokenContext(principal!));
    /* The owner holds card:update by role — couldGrant passes — but the
       TOKEN claims only card:read, and the intersection is what refuses. */
    await expect(caller.cards.update()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a token principal on a step-up route', async () => {
    const { token } = await scaffold('gate-stepup');
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();

    const caller = createCallerFactory(gateRouter)(tokenContext(principal!));
    await expect(caller.admin()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a token principal on a self route', async () => {
    const { token } = await scaffold('gate-self');
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();

    const caller = createCallerFactory(gateRouter)(tokenContext(principal!));
    await expect(caller.me()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('neither unlocks nor blocks a public route — its floor is anonymous', async () => {
    const { token } = await scaffold('gate-public');
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();

    const caller = createCallerFactory(gateRouter)(tokenContext(principal!));
    /* A public route never calls `requireAuth`, so a presented token is
       simply ignored: the caller gets exactly what an anonymous one would.
       The refusal list is self, step-up and (by never authenticating)
       public — the token must not be able to SATISFY any of them, and it
       cannot, because this route grants nothing a token could widen. */
    await expect(caller.public()).resolves.toBe('public');
  });

  it('a demotion weakens an existing token IMMEDIATELY', async () => {
    /* §6.6's named property: mint with `audit:read` as admin, demote to
       member, the token now fails. `audit:read` is Admin-and-above in the
       matrix, so a member does not hold it — and the route floor's
       `couldGrant` answers from the LIVE role read on this request, so there
       is no window where the token keeps the old capability. */
    const result = await orgs.createOrg(
      {
        name: 'Auth demoted',
        slug: `au-demoted-${crypto.randomUUID().slice(0, 8)}`,
      },
      { userId: OWNER, requestId },
    );
    created.push(result.orgId);
    await members.addMember(
      result.orgId,
      { email: 'admin@api-token-auth.test', role: 'admin' },
      { userId: OWNER, requestId },
    );

    const adminActor = await actorFor(result.orgId, ADMIN, 'admin');
    const issued = await mintApiToken(adminActor, { name: 'CI', scopes: ['audit:read'] });

    const auditRouter = router({
      audit: route({ permission: 'audit:read' }).query(() => 'entries'),
    });

    /* Before: admin holds audit:read, so the token works. */
    const before = await authenticateWithApiToken(`Bearer ${issued.token}`, undefined);
    expect(before).not.toBeNull();
    const beforeCaller = createCallerFactory(auditRouter)(tokenContext(before!));
    await expect(beforeCaller.audit()).resolves.toBe('entries');

    /* After: the same token, next request, one demotion later. */
    await members.changeRole(
      result.orgId,
      { userId: ADMIN, role: 'member' },
      { userId: OWNER, requestId },
    );

    const after = await authenticateWithApiToken(`Bearer ${issued.token}`, undefined);
    expect(after).not.toBeNull();
    const afterCaller = createCallerFactory(auditRouter)(tokenContext(after!));
    await expect(afterCaller.audit()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/* ---------------------------------------------------------------------------
 * The REAL automation router with a token principal (§6.6) — the synthetic
 * gateRouter above proves the GATE; this proves the routes a token will
 * actually drive. `webhook:manage` is Admin-and-above and org-level (§9
 * decision 4), so a token scoped for it is the whole authorization story at
 * this layer — and a token scoped for something else must be refused here.
 * ------------------------------------------------------------------------- */

const automationKeys = new SoftwareKeyProvider({
  currentMasterKeyId: 'test-master',
  masterKeys: masterKeysFromBase64({
    'test-master': Buffer.alloc(32, 7).toString('base64'),
  }),
});

const automationRouter = createAutomationRouter({
  keys: automationKeys,
  /* The flag is off in tests (its default): this suite drives webhook routes,
     which the flag does not touch, and a rule containing a telephony action
     cannot be saved through a default-shaped router — the honest fixture. */
  telephonyActionsEnabled: false,
  /* No connector is configured in this suite — the honest fixture for a
     suite that never drives the connect flow: begin/complete would answer
     NOT_FOUND rather than the router failing to build. */
  integration: {
    providers: {},
    redirectUri: (provider) => `https://app.test/integrations/callback/${provider}`,
    webhookOrigin: undefined,
    jwtSecret: Buffer.alloc(32, 9),
    keys: automationKeys,
  },
});

describe('a token principal on the real automation router', () => {
  async function principalOf(token: string) {
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();
    return principal!;
  }

  it('a webhook:manage-scoped token lists and creates webhooks through the real routes', async () => {
    const { token } = await scaffold('real-ok', ['webhook:manage']);
    const caller = createCallerFactory(automationRouter)(tokenContext(await principalOf(token)));

    /* The real routes carry an explicit `z.object({}).strict()` input, so
       they take `{}` where the synthetic gateRouter's input-less routes take
       nothing. */
    await expect(caller.webhooks.list({})).resolves.toEqual([]);

    const created = await caller.webhooks.create({
      name: 'CI',
      url: 'https://hooks.example.test/ci',
    });
    expect(created.webhookId.length).toBeGreaterThan(0);
    /* The shown-once contract: the signing secret rides this one response. */
    expect(created.signingSecret.length).toBeGreaterThan(0);

    const listed = await caller.webhooks.list({});
    expect(listed.some((webhook) => webhook.webhookId === created.webhookId)).toBe(true);
  });

  it('does not bleed into sibling surfaces — a webhook token cannot manage RULES', async () => {
    const { token } = await scaffold('real-bleed', ['webhook:manage']);
    const caller = createCallerFactory(automationRouter)(tokenContext(await principalOf(token)));

    /* `automation:manage` is a different permission with the same floor
       shape; the token scoped only for webhooks is refused here. */
    await expect(caller.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a card:read token on webhook routes', async () => {
    const { token } = await scaffold('real-refused');
    const caller = createCallerFactory(automationRouter)(tokenContext(await principalOf(token)));

    await expect(caller.webhooks.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a webhook created by a token lands in the TOKEN org, invisible to another org', async () => {
    const a = await scaffold('real-org-a', ['webhook:manage']);
    const b = await scaffold('real-org-b', ['webhook:manage']);
    const callerA = createCallerFactory(automationRouter)(tokenContext(await principalOf(a.token)));
    const callerB = createCallerFactory(automationRouter)(tokenContext(await principalOf(b.token)));

    const created = await callerA.webhooks.create({
      name: 'A only',
      url: 'https://hooks.example.test/a',
    });
    const listA = await callerA.webhooks.list({});
    expect(listA.some((webhook) => webhook.webhookId === created.webhookId)).toBe(true);

    /* RLS confines org B's token to org B's rows — the token's org came from
       the token itself, not from anything the client said. */
    const listB = await callerB.webhooks.list({});
    expect(listB.some((webhook) => webhook.webhookId === created.webhookId)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * The per-token daily quota (§6.5). The counter is a Postgres row, so the
 * durable state is seeded directly (as the migrator, under the org's own RLS
 * scope) rather than consumed 100 000 times — and a fresh authentication on
 * every call is what proves the refusal comes from the DATABASE, not from
 * some in-process window a restart would forgive.
 * ------------------------------------------------------------------------- */

/** Upserts a quota row at the given counters — `daysAgo` 0 is today. */
async function seedQuota(
  orgId: OrgId,
  tokenId: string,
  used: number,
  expensive: number,
  daysAgo = 0,
): Promise<void> {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO platform.api_token_quota (token_id, org_id, quota_date, used_count, expensive_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token_id) DO UPDATE
       SET quota_date = $3, used_count = $4, expensive_count = $5`,
    [tokenId, orgId, date.toISOString().slice(0, 10), used, expensive],
  );
  await admin.setOrg(null);
}

async function readQuota(orgId: OrgId, tokenId: string): Promise<Record<string, unknown>> {
  await admin.setOrg(orgId);
  /* `quota_date::text` — the driver would otherwise hand back a Date parsed
     as LOCAL midnight, and `toISOString()` on that shifts the day back by
     the UTC offset. Text is the column's own representation and immune. */
  const result = await admin.query(
    `SELECT used_count, expensive_count, quota_date::text AS quota_date
     FROM platform.api_token_quota WHERE token_id = $1`,
    [tokenId],
  );
  await admin.setOrg(null);
  return result.rows[0] ?? {};
}

/** The list view's "last used" — on api_tokens, not the quota row (0053). */
async function readLastUsedAt(orgId: OrgId, tokenId: string): Promise<unknown> {
  await admin.setOrg(orgId);
  const result = await admin.query(`SELECT last_used_at FROM platform.api_tokens WHERE id = $1`, [
    tokenId,
  ]);
  await admin.setOrg(null);
  return result.rows[0]?.['last_used_at'] ?? null;
}

describe('the per-token daily quota (§6.5)', () => {
  async function principalOf(token: string) {
    const principal = await authenticateWithApiToken(`Bearer ${token}`, undefined);
    expect(principal).not.toBeNull();
    return principal!;
  }

  it('counts every request, and refuses once the daily total is exhausted', async () => {
    const { orgId, tokenId, token } = await scaffold('quota-exhaust');
    const caller = createCallerFactory(gateRouter)(tokenContext(await principalOf(token)));

    /* The first call consumes the row into existence. */
    await expect(caller.cards.read()).resolves.toBe('read');
    let row = await readQuota(orgId, tokenId);
    expect(Number(row['used_count'])).toBe(1);

    /* Push the counter to the ceiling — the durable state a day of real
       usage would produce — and a FRESH authentication is refused, with a
       retry hint pointing at midnight UTC when the allowance resets. */
    await seedQuota(orgId, tokenId, API_TOKEN_DAILY_QUOTA, 0);
    const fresh = await principalOf(token);
    const error = await createCallerFactory(gateRouter)(tokenContext(fresh))
      .cards.read()
      .catch((cause: unknown) => cause);
    const err = error as { code?: string; cause?: { code?: string; retryAfterSeconds?: number } };
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(err.cause?.code).toBe('QUOTA_EXCEEDED');
    expect(err.cause?.retryAfterSeconds).toBeGreaterThan(0);

    /* The refusal consumed nothing — the counter stays at the ceiling. */
    row = await readQuota(orgId, tokenId);
    expect(Number(row['used_count'])).toBe(API_TOKEN_DAILY_QUOTA);
  });

  it('is per token — an exhausted token does not exhaust its sibling', async () => {
    const { orgId, tokenId, token, owner } = await scaffold('quota-sibling');
    const exhausted = await mintApiToken(owner, { name: 'CI 2', scopes: ['card:read'] });
    await seedQuota(orgId, exhausted.tokenId, API_TOKEN_DAILY_QUOTA, 0);

    const first = await principalOf(token);
    await expect(createCallerFactory(gateRouter)(tokenContext(first)).cards.read()).resolves.toBe(
      'read',
    );

    const second = await principalOf(exhausted.token);
    const error = await createCallerFactory(gateRouter)(tokenContext(second))
      .cards.read()
      .catch((cause: unknown) => cause);
    expect((error as { code?: string }).code).toBe('TOO_MANY_REQUESTS');
    expect(tokenId.length).toBeGreaterThan(0);
  });

  it('rolls the row over at the day boundary instead of refusing', async () => {
    const { orgId, tokenId, token } = await scaffold('quota-rollover');
    /* Yesterday's row, at the ceiling. */
    await seedQuota(orgId, tokenId, API_TOKEN_DAILY_QUOTA, 0, 1);

    const principal = await principalOf(token);
    await expect(
      createCallerFactory(gateRouter)(tokenContext(principal)).cards.read(),
    ).resolves.toBe('read');

    const row = await readQuota(orgId, tokenId);
    expect(Number(row['used_count'])).toBe(1);
    expect(String(row['quota_date'])).toBe(new Date().toISOString().slice(0, 10));
  });

  it('the expensive class is refused independently of the daily total', async () => {
    const { orgId, tokenId, owner } = await scaffold('quota-expensive');
    /* A token holding the search permission, so the scope gate passes and the
       expensive CLASS is what refuses. */
    const searchToken = await mintApiToken(owner, {
      name: 'Search',
      scopes: ['card:read', 'search:query'],
    });
    await seedQuota(orgId, searchToken.tokenId, 0, API_TOKEN_EXPENSIVE_DAILY_QUOTA);

    const principal = await principalOf(searchToken.token);
    const caller = createCallerFactory(gateRouter)(tokenContext(principal));

    /* The expensive ceiling is reached — the search route is refused... */
    const error = await caller.search().catch((cause: unknown) => cause);
    expect((error as { code?: string }).code).toBe('TOO_MANY_REQUESTS');

    /* ...while the daily total is untouched, so a normal route still passes. */
    await expect(caller.cards.read()).resolves.toBe('read');
    const row = await readQuota(orgId, searchToken.tokenId);
    expect(Number(row['used_count'])).toBe(1);
    expect(tokenId.length).toBeGreaterThan(0);
  });

  it('writes last_used_at on the token row, at most once per minute', async () => {
    const { orgId, tokenId, token } = await scaffold('quota-throttle');
    const caller = createCallerFactory(gateRouter)(tokenContext(await principalOf(token)));

    await caller.cards.read();
    const first = await readLastUsedAt(orgId, tokenId);
    expect(first).not.toBeNull();

    /* An immediate second request — the same minute by construction — keeps
       the earlier timestamp rather than churning it. */
    await caller.cards.read();
    const second = await readLastUsedAt(orgId, tokenId);
    expect(String(second)).toBe(String(first));
  });
});
