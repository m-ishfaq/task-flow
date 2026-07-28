import { unsafeAsId } from '@taskflow/contracts';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { FuzzOrg } from './tenancy-fuzz.js';

/**
 * Two real tenants, for the tenancy isolation fuzz test (guardrail 8).
 *
 * ## Why this needs a real database
 *
 * Until Phase 2 the fuzz harness had no routes that touched storage, so it ran
 * with no database at all and still proved something: a handler that returned a
 * row without checking whose it was. That stops being true the moment routes
 * actually read. Every tenancy route opens `withOrgScope`, and against an
 * uninitialized pool they all throw — which the harness correctly reports as
 * ERRORED, and which would otherwise have been mistaken for coverage.
 *
 * So the fuzz test seeds two organizations with real rows and real ids, and org
 * A's owner then calls every registered endpoint holding org B's ids, through
 * the same RLS the production path uses. A leak now means a leak, and a refusal
 * means the row was genuinely unreachable rather than merely absent.
 *
 * Seeding goes through `@taskflow/db/testing` rather than `pg` directly,
 * because guardrail 2 bans importing the driver outside the data layer — and
 * the connection it hands back is the migrator, which is NOBYPASSRLS, so every
 * insert below still has to declare its org.
 */

interface Tenant {
  readonly orgId: string;
  readonly userId: string;
  readonly teamId: string;
  readonly tupleId: string;
}

/* Fixed ids in a distinct range from the other suites', so a failing run is
   reproducible and teardown cannot touch another test's rows. */
const ATTACKER: Tenant = {
  orgId: '0195cc00-0000-7000-8000-00000000000a',
  userId: '0195cc00-0000-7000-8000-000000000a01',
  teamId: '0195cc00-0000-7000-8000-000000000a02',
  tupleId: '0195cc00-0000-7000-8000-000000000a03',
};

const VICTIM: Tenant = {
  orgId: '0195cc00-0000-7000-8000-00000000000b',
  userId: '0195cc00-0000-7000-8000-000000000b01',
  teamId: '0195cc00-0000-7000-8000-000000000b02',
  tupleId: '0195cc00-0000-7000-8000-000000000b03',
};

const BOARD = '0195cc00-0000-7000-8000-0000000000cc';

async function seedTenant(admin: AdminConnection, tenant: Tenant, label: string): Promise<void> {
  await admin.setOrg(tenant.orgId);

  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    tenant.orgId,
    `Fuzz ${label}`,
    `fuzz-${label.toLowerCase()}`,
  ]);

  /* Owner, so a denial can never be explained away as "that role lacked the
     permission anyway". The only thing between this session and the other
     tenant's rows is the org boundary, which is the property under test. */
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [tenant.orgId, tenant.userId],
  );

  await admin.query(
    `INSERT INTO identity.teams (id, org_id, name, slug) VALUES ($1, $2, 'Fuzz Team', 'fuzz-team')`,
    [tenant.teamId, tenant.orgId],
  );

  await admin.query(
    `INSERT INTO identity.team_members (org_id, team_id, user_id) VALUES ($1, $2, $3)`,
    [tenant.orgId, tenant.teamId, tenant.userId],
  );

  await admin.query(
    `INSERT INTO authz.relationship_tuples
       (id, org_id, subject_type, subject_id, relation, object_type, object_id)
     VALUES ($1, $2, 'user', $3, 'editor', 'board', $4)`,
    [tenant.tupleId, tenant.orgId, tenant.userId, BOARD],
  );
}

async function clearTenant(admin: AdminConnection, tenant: Tenant): Promise<void> {
  await admin.setOrg(tenant.orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [tenant.orgId]);
}

function fuzzOrgFor(tenant: Tenant, other: Tenant): FuzzOrg {
  return {
    orgId: unsafeAsId<'OrgId'>(tenant.orgId),
    userId: unsafeAsId<'UserId'>(tenant.userId),
    role: 'owner',
    /* Keyed by input field name. The harness feeds this whole bag to every
       route and lets each route's own Zod schema reject what it does not want —
       a BAD_REQUEST is a refusal, and typing it more precisely would mean the
       harness knew each route's shape, which is the coupling it exists to
       avoid. Every id here belongs to the OTHER tenant. */
    resourceIds: {
      orgId: other.orgId,
      userId: other.userId,
      teamId: other.teamId,
      tupleId: other.tupleId,
      objectType: 'board',
      objectId: BOARD,
      permission: 'card:read',
    },
  };
}

export interface SeededTenants {
  readonly attacker: FuzzOrg;
  readonly victim: FuzzOrg;
  readonly cleanup: () => Promise<void>;
}

/** Applies migrations and seeds both tenants. Call from `beforeAll`. */
export async function seedFuzzTenants(): Promise<SeededTenants> {
  await applyMigrations();

  const admin = await connectAsMigrator();
  const userIds = [ATTACKER.userId, VICTIM.userId];

  const removeAll = async (): Promise<void> => {
    await clearTenant(admin, ATTACKER);
    await clearTenant(admin, VICTIM);
    await admin.setOrg(null);
    await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [userIds]);
  };

  await removeAll();

  for (const [index, userId] of userIds.entries()) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [userId, `fuzz-${String(index)}@example.test`],
    );
  }

  await seedTenant(admin, ATTACKER, 'A');
  await seedTenant(admin, VICTIM, 'B');
  await admin.setOrg(null);

  return {
    attacker: fuzzOrgFor(ATTACKER, VICTIM),
    victim: fuzzOrgFor(VICTIM, ATTACKER),
    cleanup: async () => {
      await removeAll();
      await admin.end();
    },
  };
}
