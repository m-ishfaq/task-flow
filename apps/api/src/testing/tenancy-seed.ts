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

  /* Work resources (Phase 3). Every Work route takes at least one of these, so
     without them the harness would feed each route a bag of ids none of its
     fields matched, every call would answer BAD_REQUEST, and a refusal caused
     by a schema rejection would be indistinguishable from one caused by the
     tenant boundary. Real rows make the refusal mean what it says. */
  readonly projectId: string;
  readonly boardId: string;
  readonly listId: string;
  readonly cardId: string;
  readonly labelId: string;
  readonly checklistId: string;
  readonly checklistItemId: string;
  readonly fieldId: string;
  readonly commentId: string;
  readonly attachmentId: string;
}

/* Fixed ids in a distinct range from the other suites', so a failing run is
   reproducible and teardown cannot touch another test's rows. */
const ATTACKER: Tenant = {
  orgId: '0195cc00-0000-7000-8000-00000000000a',
  userId: '0195cc00-0000-7000-8000-000000000a01',
  teamId: '0195cc00-0000-7000-8000-000000000a02',
  tupleId: '0195cc00-0000-7000-8000-000000000a03',
  projectId: '0195cc00-0000-7000-8000-000000000a04',
  boardId: '0195cc00-0000-7000-8000-000000000a05',
  listId: '0195cc00-0000-7000-8000-000000000a06',
  cardId: '0195cc00-0000-7000-8000-000000000a07',
  labelId: '0195cc00-0000-7000-8000-000000000a08',
  checklistId: '0195cc00-0000-7000-8000-000000000a09',
  checklistItemId: '0195cc00-0000-7000-8000-000000000a0a',
  fieldId: '0195cc00-0000-7000-8000-000000000a0b',
  commentId: '0195cc00-0000-7000-8000-000000000a0c',
  attachmentId: '0195cc00-0000-7000-8000-000000000a0d',
};

const VICTIM: Tenant = {
  orgId: '0195cc00-0000-7000-8000-00000000000b',
  userId: '0195cc00-0000-7000-8000-000000000b01',
  teamId: '0195cc00-0000-7000-8000-000000000b02',
  tupleId: '0195cc00-0000-7000-8000-000000000b03',
  projectId: '0195cc00-0000-7000-8000-000000000b04',
  boardId: '0195cc00-0000-7000-8000-000000000b05',
  listId: '0195cc00-0000-7000-8000-000000000b06',
  cardId: '0195cc00-0000-7000-8000-000000000b07',
  labelId: '0195cc00-0000-7000-8000-000000000b08',
  checklistId: '0195cc00-0000-7000-8000-000000000b09',
  checklistItemId: '0195cc00-0000-7000-8000-000000000b0a',
  fieldId: '0195cc00-0000-7000-8000-000000000b0b',
  commentId: '0195cc00-0000-7000-8000-000000000b0c',
  attachmentId: '0195cc00-0000-7000-8000-000000000b0d',
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

  /* A complete Work hierarchy (Phase 3).
     Both tenants use the SAME project key, which is the point: it is unique per
     org, so a run that accidentally seeded both into one tenant would fail here
     rather than silently testing one org against itself. */
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'Fuzz Project', 'FUZZ')`,
    [tenant.projectId, tenant.orgId],
  );

  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank)
     VALUES ($1, $2, $3, 'Fuzz Board', 'a0')`,
    [tenant.boardId, tenant.orgId, tenant.projectId],
  );

  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank)
     VALUES ($1, $2, $3, $4, 'Fuzz List', 'a0')`,
    [tenant.listId, tenant.orgId, tenant.projectId, tenant.boardId],
  );

  await admin.query(
    `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, rank)
     VALUES ($1, $2, $3, $4, $5, 1, 'Fuzz Card', 'a0')`,
    [tenant.cardId, tenant.orgId, tenant.projectId, tenant.boardId, tenant.listId],
  );

  /* Card detail (0009). Each of these is the target of at least one route that
     MUTATES another tenant's data if the boundary fails — a label renamed, a
     checklist item ticked, a comment edited. */
  await admin.query(
    `INSERT INTO work.labels (id, org_id, project_id, name, color)
     VALUES ($1, $2, $3, 'Fuzz Label', '#4f46e5')`,
    [tenant.labelId, tenant.orgId, tenant.projectId],
  );

  await admin.query(
    `INSERT INTO work.checklists (id, org_id, card_id, name, rank)
     VALUES ($1, $2, $3, 'Fuzz Checklist', 'a0')`,
    [tenant.checklistId, tenant.orgId, tenant.cardId],
  );

  await admin.query(
    `INSERT INTO work.checklist_items (id, org_id, card_id, checklist_id, text, rank)
     VALUES ($1, $2, $3, $4, 'Fuzz Item', 'a0')`,
    [tenant.checklistItemId, tenant.orgId, tenant.cardId, tenant.checklistId],
  );

  await admin.query(
    `INSERT INTO work.custom_field_defs (id, org_id, project_id, name, type, rank)
     VALUES ($1, $2, $3, 'Fuzz Field', 'text', 'a0')`,
    [tenant.fieldId, tenant.orgId, tenant.projectId],
  );

  await admin.query(
    `INSERT INTO work.card_comments (id, org_id, card_id, author_id, body, body_text)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'Fuzz comment')`,
    [
      tenant.commentId,
      tenant.orgId,
      tenant.cardId,
      tenant.userId,
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fuzz comment' }] }],
      }),
    ],
  );

  /* Seeded as 'clean' on purpose. A pending attachment would be refused by the
     download route's status check before the tenant boundary was ever
     consulted, so the refusal would prove nothing about isolation. */
  await admin.query(
    `INSERT INTO platform.attachments
       (id, org_id, parent_type, parent_id, storage_key, filename, content_type,
        declared_bytes, size_bytes, status, scanned_at)
     VALUES ($1, $2, 'card', $3, $4, 'fuzz.png', 'image/png', 64, 64, 'clean', now())`,
    [
      tenant.attachmentId,
      tenant.orgId,
      tenant.cardId,
      `org/${tenant.orgId}/2026/07/${tenant.attachmentId}`,
    ],
  );
}

async function clearTenant(admin: AdminConnection, tenant: Tenant): Promise<void> {
  await admin.setOrg(tenant.orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [tenant.orgId]);
  // Children first — the composite foreign keys make the order mandatory.
  await admin.query(`DELETE FROM platform.attachments WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.card_comments WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.custom_field_values WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.custom_field_defs WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.checklist_items WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.checklists WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.card_labels WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.labels WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [tenant.orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [tenant.orgId]);
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

      /* Work (Phase 3). Every one of these belongs to the OTHER tenant, and the
         `target`/`before`/`after` aliases matter as much as the plain ones:
         `cards.move` takes a destination list and two neighbour cards, and a
         harness that only substituted `cardId` would test the card being moved
         while letting the DESTINATION default to null — which is the half of
         that route where a cross-tenant write would actually land. */
      projectId: other.projectId,
      boardId: other.boardId,
      listId: other.listId,
      cardId: other.cardId,
      targetListId: other.listId,
      beforeCardId: other.cardId,
      afterListId: other.listId,
      beforeListId: other.listId,
      assigneeIds: [other.userId],
      version: 1,

      /* Card detail (0009). `body` is a valid TipTap document because the
         comment routes parse it before reaching the service — a malformed one
         would be refused on shape, and a BAD_REQUEST counts as a refusal, so
         the tenant boundary would never be reached. */
      labelId: other.labelId,
      labelIds: [other.labelId],
      checklistId: other.checklistId,
      itemId: other.checklistItemId,
      fieldId: other.fieldId,
      commentId: other.commentId,
      attachmentId: other.attachmentId,
      text: 'fuzz',
      name: 'fuzz',
      color: '#4f46e5',
      done: false,
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fuzz' }] }],
      },
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
