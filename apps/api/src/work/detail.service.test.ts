import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type BoardId,
  type CardId,
  type ListId,
  type OrgId,
  type ProjectId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, eq, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import * as grants from '../tenancy/grant.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import * as labels from './label.service.js';
import * as statuses from './status.service.js';
import * as checklists from './checklist.service.js';
import * as fields from './custom-field.service.js';
import * as comments from './comment.service.js';
import type { RichTextNode } from './richtext.js';
import type { WorkActor } from './shared.js';

/**
 * Card detail against real Postgres — labels, checklists, custom fields,
 * comments (PLAN.md §3.1).
 *
 * The properties worth a real database here are the ones that are decided by a
 * constraint rather than by code: a label from another project refused by a
 * composite foreign key, a checklist counter that stays exact across a delete,
 * a custom field value refused because its shape disagrees with a `type` column
 * only the database knows, and a comment a moderator may remove but not edit.
 */

const OWNER = unsafeAsId<'UserId'>('0195ef00-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ef00-0000-7000-8000-000000000002');
const VIEWER = unsafeAsId<'UserId'>('0195ef00-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@detail.test'],
  [MEMBER, 'member@detail.test'],
  [VIEWER, 'viewer@detail.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ef00-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'work.card_comments',
    'work.custom_field_values',
    'work.custom_field_defs',
    'work.checklist_items',
    'work.checklists',
    'work.card_labels',
    'work.labels',
    'work.cards',
    'work.statuses',
    'work.lists',
    'work.boards',
    'work.projects',
    'authz.relationship_tuples',
    'identity.team_members',
    'identity.teams',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
  readonly listId: ListId;
  readonly cardId: CardId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);

  const owner = await actorFor(result.orgId, OWNER, 'owner');
  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(owner, {
    projectId: project.projectId,
    name: 'Delivery',
  });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const card = await cards.createCard(owner, {
    listId: list.listId,
    title: 'Subject card',
    description: null,
  });

  return {
    orgId: result.orgId,
    owner,
    projectId: project.projectId,
    boardId: board.boardId,
    listId: list.listId,
    cardId: card.cardId,
  };
}

/** A TipTap document with the given text — what the comment routes accept. */
function body(text: string): RichTextNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-detail-svc-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('labels', () => {
  it('treats names case-insensitively within a project', async () => {
    const fixture = await scaffold('detail-labels');

    await labels.createLabel(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Bug',
      color: '#ff0000',
    });

    // "Bug" and "bug" are one label. Two of them make every filter silently
    // incomplete, which is why the index is on lower(name).
    await expect(
      labels.createLabel(fixture.owner, {
        projectId: fixture.projectId,
        name: 'bug',
        color: '#00ff00',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('attaches and replaces a card label set', async () => {
    const fixture = await scaffold('detail-label-set');

    const bug = await labels.createLabel(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Bug',
      color: '#ff0000',
    });
    const urgent = await labels.createLabel(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Urgent',
      color: '#00ff00',
    });

    await labels.setCardLabels(fixture.owner, {
      cardId: fixture.cardId,
      labelIds: [bug.labelId, urgent.labelId],
    });
    expect(await labels.listCardLabels(fixture.owner, { cardId: fixture.cardId })).toHaveLength(2);

    // Replacing with a subset removes the rest — the set is the input, not a delta.
    await labels.setCardLabels(fixture.owner, {
      cardId: fixture.cardId,
      labelIds: [bug.labelId],
    });
    const remaining = await labels.listCardLabels(fixture.owner, { cardId: fixture.cardId });
    expect(remaining.map((label) => label.name)).toEqual(['Bug']);
  });

  it('refuses a label from another project — enforced by the database', async () => {
    const fixture = await scaffold('detail-label-cross');

    const other = await projects.createProject(fixture.owner, {
      name: 'Other',
      key: 'OTH',
      description: null,
    });
    const foreign = await labels.createLabel(fixture.owner, {
      projectId: other.projectId,
      name: 'Foreign',
      color: '#0000ff',
    });

    /* Same tenant, different project. RLS has nothing to say about this — it is
       the composite foreign key on card_labels that refuses it, which is why
       the service does no lookup of its own. */
    await expect(
      labels.setCardLabels(fixture.owner, {
        cardId: fixture.cardId,
        labelIds: [foreign.labelId],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deletes a label and detaches it from every card', async () => {
    const fixture = await scaffold('detail-label-delete');

    const bug = await labels.createLabel(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Bug',
      color: '#ff0000',
    });
    await labels.setCardLabels(fixture.owner, {
      cardId: fixture.cardId,
      labelIds: [bug.labelId],
    });

    const result = await labels.deleteLabel(fixture.owner, { labelId: bug.labelId });
    expect(result.cardCount).toBe(1);

    expect(await labels.listCardLabels(fixture.owner, { cardId: fixture.cardId })).toHaveLength(0);
  });

  it('lets a member tag a card but not manage the project label set', async () => {
    const fixture = await scaffold('detail-label-authz');
    await members.addMember(
      fixture.orgId,
      { email: 'member@detail.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const bug = await labels.createLabel(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Bug',
      color: '#ff0000',
    });
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    // Tagging is editing the card — a member may.
    await expect(
      labels.setCardLabels(member, { cardId: fixture.cardId, labelIds: [bug.labelId] }),
    ).resolves.toMatchObject({ labelIds: [bug.labelId] });

    // Managing the vocabulary is editing the project — a member may not.
    await expect(
      labels.createLabel(member, {
        projectId: fixture.projectId,
        name: 'Sneaky',
        color: '#123456',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('statuses', () => {
  it('treats names case-insensitively within a project', async () => {
    const fixture = await scaffold('detail-status-names');

    await statuses.createStatus(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Done',
      category: 'done',
      color: '#22c55e',
      isDefault: false,
    });

    // "Done" and "done" are one status. Two of them would give a board two
    // columns for the same concept.
    await expect(
      statuses.createStatus(fixture.owner, {
        projectId: fixture.projectId,
        name: 'done',
        category: 'done',
        color: '#16a34a',
        isDefault: false,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lists statuses in position order and renames one', async () => {
    const fixture = await scaffold('detail-status-order');

    const first = await statuses.createStatus(fixture.owner, {
      projectId: fixture.projectId,
      name: 'To Do',
      category: 'not_started',
      color: '#94a3b8',
      isDefault: false,
    });
    const second = await statuses.createStatus(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Done',
      category: 'done',
      color: '#22c55e',
      isDefault: false,
    });

    const listed = await statuses.listStatuses(fixture.owner, { projectId: fixture.projectId });
    expect(listed.map((row) => row.statusId)).toEqual([first.statusId, second.statusId]);

    await statuses.updateStatus(fixture.owner, {
      statusId: first.statusId,
      name: 'Backlog',
      category: 'not_started',
      color: '#94a3b8',
      isDefault: false,
    });
    const renamed = await statuses.listStatuses(fixture.owner, { projectId: fixture.projectId });
    expect(renamed[0]?.name).toBe('Backlog');
  });

  it('counts the cards carrying each status', async () => {
    const fixture = await scaffold('detail-status-count');

    const status = await statuses.createStatus(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Active',
      category: 'active',
      color: '#3b82f6',
      isDefault: false,
    });
    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Counted',
      description: null,
    });
    await cards.setCardStatus(fixture.owner, { cardId: card.cardId, statusId: status.statusId });

    const listed = await statuses.listStatuses(fixture.owner, { projectId: fixture.projectId });
    expect(listed.find((row) => row.statusId === status.statusId)?.cardCount).toBe(1);
  });
});

describe('checklists', () => {
  it('keeps the card counters exact across every operation', async () => {
    const fixture = await scaffold('detail-checklist-counts');

    const countersOf = async (): Promise<{ done: number; total: number }> => {
      const rows = await withOrgScope(fixture.orgId, async (tx) =>
        tx
          .select({
            done: schema.cards.checklistDone,
            total: schema.cards.checklistTotal,
          })
          .from(schema.cards)
          .where(eq(schema.cards.id, fixture.cardId)),
      );
      return rows[0] ?? { done: -1, total: -1 };
    };

    const checklist = await checklists.createChecklist(fixture.owner, {
      cardId: fixture.cardId,
      name: 'Steps',
    });

    const first = await checklists.addItem(fixture.owner, {
      checklistId: checklist.checklistId,
      text: 'One',
    });
    const second = await checklists.addItem(fixture.owner, {
      checklistId: checklist.checklistId,
      text: 'Two',
    });
    expect(await countersOf()).toEqual({ done: 0, total: 2 });

    await checklists.updateItem(fixture.owner, {
      itemId: first.itemId,
      text: 'One',
      done: true,
    });
    expect(await countersOf()).toEqual({ done: 1, total: 2 });

    /* The case an increment-based implementation gets wrong: deleting an item
       that was DONE has to reduce both counters, and only one of them if it was
       not. Recomputing has no branch to get wrong. */
    await checklists.deleteItem(fixture.owner, { itemId: first.itemId });
    expect(await countersOf()).toEqual({ done: 0, total: 1 });

    await checklists.updateItem(fixture.owner, {
      itemId: second.itemId,
      text: 'Two',
      done: true,
    });
    expect(await countersOf()).toEqual({ done: 1, total: 1 });

    // Deleting the whole checklist takes its items with it, through the cascade.
    await checklists.deleteChecklist(fixture.owner, { checklistId: checklist.checklistId });
    expect(await countersOf()).toEqual({ done: 0, total: 0 });
  });

  it('does not move doneAt when an already-done item is saved again', async () => {
    const fixture = await scaffold('detail-checklist-doneat');

    const checklist = await checklists.createChecklist(fixture.owner, {
      cardId: fixture.cardId,
      name: 'Steps',
    });
    const item = await checklists.addItem(fixture.owner, {
      checklistId: checklist.checklistId,
      text: 'One',
    });

    await checklists.updateItem(fixture.owner, { itemId: item.itemId, text: 'One', done: true });

    const doneAtOf = async (): Promise<Date | null> => {
      const [first] = await checklists.listChecklists(fixture.owner, { cardId: fixture.cardId });
      return first?.items[0]?.doneAt ?? null;
    };

    const firstStamp = await doneAtOf();
    expect(firstStamp).not.toBeNull();

    // A save-on-blur UI resends the same state constantly. "Who finished this
    // and when" must survive that.
    await checklists.updateItem(fixture.owner, {
      itemId: item.itemId,
      text: 'One edited',
      done: true,
    });
    expect(await doneAtOf()).toEqual(firstStamp);
  });

  it('clears doneAt and doneBy when an item is unticked', async () => {
    const fixture = await scaffold('detail-checklist-untick');

    const checklist = await checklists.createChecklist(fixture.owner, {
      cardId: fixture.cardId,
      name: 'Steps',
    });
    const item = await checklists.addItem(fixture.owner, {
      checklistId: checklist.checklistId,
      text: 'One',
    });

    await checklists.updateItem(fixture.owner, { itemId: item.itemId, text: 'One', done: true });
    await checklists.updateItem(fixture.owner, { itemId: item.itemId, text: 'One', done: false });

    // The migration's CHECK requires all three to agree; a stale doneAt would
    // have failed the write rather than produced this row.
    const [first] = await checklists.listChecklists(fixture.owner, { cardId: fixture.cardId });
    expect(first?.items[0]).toMatchObject({ done: false, doneAt: null, doneBy: null });
  });
});

describe('custom fields', () => {
  it('validates a value against the definition type rather than coercing it', async () => {
    const fixture = await scaffold('detail-fields-types');

    const points = await fields.createField(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Points',
      type: 'number',
      options: null,
    });

    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: points.fieldId,
        value: 5,
      }),
    ).resolves.toMatchObject({ value: 5 });

    /* "5" is not coerced to 5. Coercing would mean the value that comes back
       differs from the one sent, which breaks optimistic UI and leaves the
       Phase 8 filter compiler unable to assume a stored shape. */
    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: points.fieldId,
        value: '5',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // NaN and Infinity are numbers to JavaScript and nonsense to a SUM.
    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: points.fieldId,
        value: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('restricts a select field to its declared options', async () => {
    const fixture = await scaffold('detail-fields-select');

    const priority = await fields.createField(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Priority',
      type: 'select',
      options: ['low', 'high'],
    });

    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: priority.fieldId,
        value: 'high',
      }),
    ).resolves.toMatchObject({ value: 'high' });

    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: priority.fieldId,
        value: 'catastrophic',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('clears a value by removing the row, not by storing a JSON null', async () => {
    const fixture = await scaffold('detail-fields-clear');

    const notes = await fields.createField(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Notes',
      type: 'text',
      options: null,
    });

    await fields.setCardValue(fixture.owner, {
      cardId: fixture.cardId,
      fieldId: notes.fieldId,
      value: 'something',
    });
    expect(await fields.listCardValues(fixture.owner, { cardId: fixture.cardId })).toHaveLength(1);

    await fields.setCardValue(fixture.owner, {
      cardId: fixture.cardId,
      fieldId: notes.fieldId,
      value: null,
    });

    // "Is this field set?" stays a row-existence question with one answer.
    expect(await fields.listCardValues(fixture.owner, { cardId: fixture.cardId })).toHaveLength(0);
  });

  it('refuses to set an archived field, and keeps existing values through the archive', async () => {
    const fixture = await scaffold('detail-fields-archive');

    const notes = await fields.createField(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Notes',
      type: 'text',
      options: null,
    });
    await fields.setCardValue(fixture.owner, {
      cardId: fixture.cardId,
      fieldId: notes.fieldId,
      value: 'kept',
    });

    await fields.archiveField(fixture.owner, { fieldId: notes.fieldId, archived: true });

    // Archiving hides the field; it does not destroy what people typed.
    expect(await fields.listCardValues(fixture.owner, { cardId: fixture.cardId })).toHaveLength(1);

    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: notes.fieldId,
        value: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a field defined in another project', async () => {
    const fixture = await scaffold('detail-fields-cross');

    const other = await projects.createProject(fixture.owner, {
      name: 'Other',
      key: 'OTH',
      description: null,
    });
    const foreign = await fields.createField(fixture.owner, {
      projectId: other.projectId,
      name: 'Foreign',
      type: 'text',
      options: null,
    });

    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: foreign.fieldId,
        value: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a user field naming someone outside the org', async () => {
    const fixture = await scaffold('detail-fields-user');

    const reviewer = await fields.createField(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Reviewer',
      type: 'user',
      options: null,
    });

    // MEMBER is a real user, and not a member of THIS org.
    await expect(
      fields.setCardValue(fixture.owner, {
        cardId: fixture.cardId,
        fieldId: reviewer.fieldId,
        value: MEMBER,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('comments', () => {
  it('stores a comment and counts it on the card', async () => {
    const fixture = await scaffold('detail-comments');

    await comments.createComment(fixture.owner, {
      cardId: fixture.cardId,
      body: body('First thought'),
    });

    const thread = await comments.listComments(fixture.owner, { cardId: fixture.cardId });
    expect(thread).toHaveLength(1);
    expect(thread[0]?.bodyText).toBe('First thought');

    const card = await cards.getCard(fixture.owner, { cardId: fixture.cardId });
    expect(card.commentCount).toBe(1);
  });

  it('refuses a comment that renders to nothing', async () => {
    const fixture = await scaffold('detail-comments-empty');

    // Structurally valid, semantically empty — a thread entry nobody can see
    // and a notification about nothing.
    await expect(
      comments.createComment(fixture.owner, {
        cardId: fixture.cardId,
        body: { type: 'doc', content: [] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lets the author edit, and refuses everyone else', async () => {
    const fixture = await scaffold('detail-comments-edit');
    await members.addMember(
      fixture.orgId,
      { email: 'member@detail.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const member = await actorFor(fixture.orgId, MEMBER, 'member');
    const comment = await comments.createComment(member, {
      cardId: fixture.cardId,
      body: body('Mine'),
    });

    await expect(
      comments.updateComment(member, { commentId: comment.commentId, body: body('Mine, edited') }),
    ).resolves.toMatchObject({ edited: true });

    /* The OWNER holds every permission in the catalog and still cannot rewrite
       someone else's words. A discussion where an administrator can put words
       in your mouth is not a record of anything. */
    await expect(
      comments.updateComment(fixture.owner, {
        commentId: comment.commentId,
        body: body('Rewritten by the boss'),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets a moderator delete another person’s comment', async () => {
    const fixture = await scaffold('detail-comments-moderate');
    await members.addMember(
      fixture.orgId,
      { email: 'member@detail.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const member = await actorFor(fixture.orgId, MEMBER, 'member');
    const comment = await comments.createComment(member, {
      cardId: fixture.cardId,
      body: body('Regrettable'),
    });

    // `comment:delete` is Owner/Admin in the matrix — the moderation right.
    await expect(
      comments.deleteComment(fixture.owner, { commentId: comment.commentId }),
    ).resolves.toMatchObject({ deleted: true });

    const thread = await comments.listComments(fixture.owner, { cardId: fixture.cardId });
    expect(thread).toHaveLength(1);
    // A tombstone: the thread keeps its shape and loses the content.
    expect(thread[0]?.deletedAt).not.toBeNull();
    expect(thread[0]?.bodyText).toBe('');

    const card = await cards.getCard(fixture.owner, { cardId: fixture.cardId });
    expect(card.commentCount).toBe(0);
  });

  it('exposes moderateComments to a moderator and hides it from a plain member (Phase 15 §1)', async () => {
    /* `getCard`'s `capabilities.moderateComments` is what `comment-
       section.tsx` reads to decide whether to show "Delete" on a comment
       that is not the viewer's own — a Member without `comment:delete`
       used to see that button on every comment and get a real FORBIDDEN
       on click. */
    const fixture = await scaffold('detail-comments-capabilities');
    await members.addMember(
      fixture.orgId,
      { email: 'member@detail.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    const asOwner = await cards.getCard(fixture.owner, { cardId: fixture.cardId });
    expect(asOwner.capabilities.moderateComments).toBe(true);

    const asMember = await cards.getCard(member, { cardId: fixture.cardId });
    expect(asMember.capabilities.moderateComments).toBe(false);
  });

  it('refuses a member deleting another member’s comment', async () => {
    const fixture = await scaffold('detail-comments-nomod');
    for (const email of ['member@detail.test', 'viewer@detail.test']) {
      await members.addMember(
        fixture.orgId,
        { email, role: 'member' },
        { userId: OWNER, requestId },
      );
    }

    const author = await actorFor(fixture.orgId, MEMBER, 'member');
    const other = await actorFor(fixture.orgId, VIEWER, 'member');

    const comment = await comments.createComment(author, {
      cardId: fixture.cardId,
      body: body('Mine'),
    });

    /* A member holds `comment:create` and not `comment:delete`, so this is
       denied — and the denial is a 404 rather than a 403.

       That is `enforce`'s documented fallback, not an accident: it decides
       between the two by asking whether the subject may READ the resource, and
       there is no `comment:read` in the catalog to ask about. With nothing to
       compare against it returns the answer that reveals less. Asserting the
       code here rather than just "rejects" is what would catch someone later
       adding `comment:read` and silently turning every one of these into a 403. */
    await expect(
      comments.deleteComment(other, { commentId: comment.commentId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets a commenter tuple grant a voice without edit rights', async () => {
    const fixture = await scaffold('detail-comments-commenter');
    await members.addMember(
      fixture.orgId,
      { email: 'viewer@detail.test', role: 'guest' },
      { userId: OWNER, requestId },
    );

    /* The whole reason `comment:create` is separate from `card:update`: a guest
       given `commenter` on one board can join the discussion there and change
       nothing. A guest's role grants nothing at all, so everything below comes
       from the tuple. */
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: VIEWER,
        relation: 'commenter',
        objectType: 'board',
        objectId: fixture.boardId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );

    const guest = await actorFor(fixture.orgId, VIEWER, 'guest');

    await expect(
      comments.createComment(guest, { cardId: fixture.cardId, body: body('An outside view') }),
    ).resolves.toMatchObject({ commentId: expect.any(String) as unknown as string });

    // Commenting, yes. Editing the card, no.
    await expect(
      cards.updateCard(guest, {
        cardId: fixture.cardId,
        version: 1,
        title: 'Renamed by a guest',
        description: null,
        dueDate: null,
        startDate: null,
        priority: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('replies to a comment, and the thread reports which is which', async () => {
    const fixture = await scaffold('detail-comments-reply');

    const top = await comments.createComment(fixture.owner, {
      cardId: fixture.cardId,
      body: body('Top-level'),
    });
    const reply = await comments.createComment(fixture.owner, {
      cardId: fixture.cardId,
      body: body('A reply'),
      parentCommentId: top.commentId,
    });

    const thread = await comments.listComments(fixture.owner, { cardId: fixture.cardId });
    const topRow = thread.find((entry) => entry.commentId === top.commentId);
    const replyRow = thread.find((entry) => entry.commentId === reply.commentId);

    expect(topRow?.parentCommentId).toBeNull();
    expect(replyRow?.parentCommentId).toBe(top.commentId);

    // A reply is still a comment on the card, so it counts the same way.
    const card = await cards.getCard(fixture.owner, { cardId: fixture.cardId });
    expect(card.commentCount).toBe(2);
  });

  it('refuses a reply to a reply — one level of nesting only', async () => {
    const fixture = await scaffold('detail-comments-reply-depth');

    const top = await comments.createComment(fixture.owner, {
      cardId: fixture.cardId,
      body: body('Top-level'),
    });
    const reply = await comments.createComment(fixture.owner, {
      cardId: fixture.cardId,
      body: body('A reply'),
      parentCommentId: top.commentId,
    });

    await expect(
      comments.createComment(fixture.owner, {
        cardId: fixture.cardId,
        body: body('A reply to a reply'),
        parentCommentId: reply.commentId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a reply naming a comment from a different card', async () => {
    const fixture = await scaffold('detail-comments-reply-cross-card');

    const otherCard = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'A different card',
      description: null,
    });
    const elsewhere = await comments.createComment(fixture.owner, {
      cardId: otherCard.cardId,
      body: body('Posted on the other card'),
    });

    await expect(
      comments.createComment(fixture.owner, {
        cardId: fixture.cardId,
        body: body('Replying across cards'),
        parentCommentId: elsewhere.commentId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a reply to a deleted comment', async () => {
    const fixture = await scaffold('detail-comments-reply-deleted');

    const top = await comments.createComment(fixture.owner, {
      cardId: fixture.cardId,
      body: body('Withdrawn shortly'),
    });
    await comments.deleteComment(fixture.owner, { commentId: top.commentId });

    await expect(
      comments.createComment(fixture.owner, {
        cardId: fixture.cardId,
        body: body('Too late'),
        parentCommentId: top.commentId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
