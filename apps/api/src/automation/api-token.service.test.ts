import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { hashToken } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import {
  heldApiTokenScopes,
  listApiTokens,
  mintApiToken,
  revokeApiToken,
} from './api-token.service.js';
import type { AutomationActor } from './automation.service.js';

/**
 * API token lifecycle (ai/phase-10-automation.md §6.3, Wave 3 slice 2).
 *
 * What is under test here is the MINT CONTRACT, because that is where the
 * security model lives: a token's scopes are a subset of the holder's
 * permissions, checked at the only moment the holder is present. The three
 * refusals — unknown scope, unheld scope, and the fact that the token is
 * never readable again — are the assertions that would break if someone
 * "simplified" the mint.
 *
 * The AUTH path (does a presented token resolve, does a demotion weaken it
 * immediately) is slice 3's suite against real Postgres.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000001');
const ADMIN = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@api-token-service.test'],
  [ADMIN, 'admin@api-token-service.test'],
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

async function scaffold(slug: string): Promise<{
  orgId: OrgId;
  owner: AutomationActor;
  adminActor: AutomationActor;
}> {
  fixtureCounter += 1;
  const uniqueSlug = `tk-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Token ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  await members.addMember(
    result.orgId,
    { email: 'admin@api-token-service.test', role: 'admin' },
    { userId: OWNER, requestId },
  );

  return {
    orgId: result.orgId,
    owner: await actorFor(result.orgId, OWNER, 'owner'),
    adminActor: await actorFor(result.orgId, ADMIN, 'admin'),
  };
}

async function outboxFor(
  orgId: OrgId,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  /* The migrator is not RLS-exempt, so the read must run under the org the
     rows belong to — the same discipline `removeOrg` already follows. */
  await admin.setOrg(orgId);
  const rows = await admin.query(
    `SELECT name, payload FROM platform.outbox WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return rows.rows.map((row) => ({
    name: String(row['name']),
    payload: (row['payload'] ?? {}) as Record<string, unknown>,
  }));
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-api-token-svc' });
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

describe('minting — the scope subset contract', () => {
  it('mints a token whose stored hash is sha256 of the presented token, and shows a 10-char prefix', async () => {
    const { orgId, owner } = await scaffold('mint');

    const issued = await mintApiToken(owner, { name: 'CI', scopes: ['card:read'] });

    expect(issued.token.startsWith('tf_pat_')).toBe(true);
    /* The token body after `tf_pat_` is long; the prefix is its first ten
       characters, matching the migration's CHECK (length = 10). */
    const prefix = issued.token.slice('tf_pat_'.length, 'tf_pat_'.length + 10);
    expect(prefix.length).toBe(10);

    await admin.setOrg(orgId);
    const rows = await admin.query(
      `SELECT token_hash, token_prefix, scopes, revoked_at FROM platform.api_tokens WHERE id = $1`,
      [issued.tokenId],
    );
    await admin.setOrg(null);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.['token_hash']).toBe(hashToken(issued.token));
    expect(rows.rows[0]?.['token_prefix']).toBe(prefix);
    expect(rows.rows[0]?.['scopes']).toEqual(['card:read']);
    expect(rows.rows[0]?.['revoked_at']).toBeNull();
  });

  it('refuses a scope that is not a real permission', async () => {
    const { owner } = await scaffold('bogus');
    await expect(
      mintApiToken(owner, { name: 'CI', scopes: ['member:teleport'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a scope the minting user does not currently hold', async () => {
    const { adminActor } = await scaffold('unheld');

    /* `member:manage` is Owner-only — ADMIN has `member:invite` and not
       `member:manage` (an admin who could edit roles could promote
       themselves to Owner). The mint must refuse it, and the refusal must be
       about the SCOPE, not the route floor: the floor (`apiToken:create`) is
       one ADMIN does hold. */
    await expect(
      mintApiToken(adminActor, { name: 'CI', scopes: ['member:manage'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('heldApiTokenScopes offers exactly what mint accepts — the role-alone holdings', async () => {
    const { adminActor } = await scaffold('held');

    const held = heldApiTokenScopes(adminActor);

    /* The route floor itself is held, so the form exists for this caller. */
    expect(held).toContain('apiToken:create');
    /* `member:manage` is Owner-only — the same scope the mint-refusal test
       above refuses. The checklist must not offer what the server will
       refuse: the two use the same `can()` call, so they cannot disagree. */
    expect(held).not.toContain('member:manage');
  });

  it('dedupes repeated scopes so a token cannot claim the same capability twice', async () => {
    const { orgId, owner } = await scaffold('dedupe');

    const issued = await mintApiToken(owner, {
      name: 'CI',
      scopes: ['card:read', 'card:read', 'card:update'],
    });

    /* RLS-scoped read, like the others — the migrator is not RLS-exempt. */
    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT scopes FROM platform.api_tokens WHERE id = $1`, [
      issued.tokenId,
    ]);
    await admin.setOrg(null);
    expect(rows.rows[0]?.['scopes']).toEqual(['card:read', 'card:update']);
  });

  it('emits apiToken.created with scopes but never the token or its prefix', async () => {
    const { orgId, owner } = await scaffold('event');

    const issued = await mintApiToken(owner, { name: 'CI', scopes: ['card:read'] });

    const events = await outboxFor(orgId);
    const created = events.find((event) => event.name === 'api_token.created');
    expect(created).toBeDefined();
    expect(created?.payload).toMatchObject({
      tokenId: issued.tokenId,
      name: 'CI',
      scopes: ['card:read'],
    });

    /* The audit log must not carry a fragment of the credential. The webhook
       events' rule applied to tokens: no token, no prefix. */
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain(issued.token.slice('tf_pat_'.length, 'tf_pat_'.length + 10));
  });
});

describe('listing', () => {
  it('returns name, prefix, scopes and revocation state — never the hash', async () => {
    const { owner } = await scaffold('list');

    await mintApiToken(owner, { name: 'CI', scopes: ['card:read', 'card:update'] });

    const listed = await listApiTokens(owner);
    expect(listed).toHaveLength(1);

    const token = listed[0]!;
    expect(token.name).toBe('CI');
    expect(token.scopes).toEqual(['card:read', 'card:update']);
    expect(token.tokenPrefix.length).toBe(10);
    expect(token.revokedAt).toBeNull();
    expect(token.lastUsedAt).toBeNull();

    const keys = Object.keys(token);
    expect(keys).not.toContain('tokenHash');
    expect(keys).not.toContain('token');
  });
});

describe('revoking', () => {
  it('soft-deletes the token and emits apiToken.revoked once', async () => {
    const { orgId, owner } = await scaffold('revoke');

    const issued = await mintApiToken(owner, { name: 'CI', scopes: ['card:read'] });

    await expect(revokeApiToken(owner, { tokenId: issued.tokenId })).resolves.toEqual({
      revoked: true,
    });

    const events = await outboxFor(orgId);
    const revoked = events.filter((event) => event.name === 'api_token.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload).toMatchObject({ tokenId: issued.tokenId, name: 'CI' });

    const listed = await listApiTokens(owner);
    expect(listed[0]!.revokedAt).not.toBeNull();
  });

  it('is idempotent — a second revoke succeeds and does not emit a second event', async () => {
    const { orgId, owner } = await scaffold('twice');

    const issued = await mintApiToken(owner, { name: 'CI', scopes: ['card:read'] });

    await revokeApiToken(owner, { tokenId: issued.tokenId });
    await expect(revokeApiToken(owner, { tokenId: issued.tokenId })).resolves.toEqual({
      revoked: true,
    });

    const events = await outboxFor(orgId);
    expect(events.filter((event) => event.name === 'api_token.revoked')).toHaveLength(1);
  });

  it('two concurrent revokes emit exactly one event — the transition check lives in the UPDATE, not between a SELECT and it', async () => {
    const { orgId, owner } = await scaffold('race');

    const issued = await mintApiToken(owner, { name: 'CI', scopes: ['card:read'] });

    /* The claim pattern: both racers' UPDATEs carry `revoked_at IS NULL`, so
       only one can transition the row. A SELECT-then-UPDATE version would
       have both pass the pre-check and emit twice. */
    await Promise.all([
      revokeApiToken(owner, { tokenId: issued.tokenId }),
      revokeApiToken(owner, { tokenId: issued.tokenId }),
    ]);

    const events = await outboxFor(orgId);
    expect(events.filter((event) => event.name === 'api_token.revoked')).toHaveLength(1);
  });

  it('refuses an unknown token id', async () => {
    const { owner } = await scaffold('missing');
    await expect(revokeApiToken(owner, { tokenId: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
