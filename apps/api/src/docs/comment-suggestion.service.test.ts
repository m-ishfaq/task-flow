import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  unsafeAsId,
  type OrgId,
  type PageId,
  type SpaceId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import * as grants from '../tenancy/grant.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as spaces from './space.service.js';
import * as pages from './page.service.js';
import * as comments from './comment.service.js';
import * as suggestions from './suggestion.service.js';
import { encodeAnchor } from './anchor.js';
import type { DocsActor } from './shared.js';

/**
 * Comments and suggestions (ai/phase-6-docs.md §3.6, Wave 3) against real
 * Postgres — the ordinary-API-path half. What `anchor-survival.test.ts`
 * already covers is out of scope here: this file treats anchors as opaque
 * wire strings, exactly as `comment.service.ts`/`suggestion.service.ts`
 * themselves do.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000102');
const GUEST = unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000103');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@comments.test'],
  [MEMBER, 'member@comments.test'],
  [GUEST, 'guest@comments.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee20-0000-7000-8000-0000000001ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<DocsActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.comments WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.suggestions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: DocsActor;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');
  const space = await spaces.createSpace(owner, { name: 'Handbook' });
  const page = await pages.createPage(owner, {
    spaceId: space.spaceId,
    parentPageId: null,
    title: 'Runbook',
  });
  return { orgId, owner, spaceId: space.spaceId, pageId: page.pageId };
}

/** A structurally valid, opaque anchor — see anchor.ts's own header on why content-independence is fine here. */
function anchor(at = 0): string {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  text.insert(0, 'placeholder text');
  return encodeAnchor(
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at))),
  );
}

function body(text: string) {
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-docs-comment-test' });
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

describe('comments', () => {
  it('creates and lists a comment, newest last (id order)', async () => {
    const fixture = await scaffold('comment-create');
    const first = await comments.createComment(fixture.owner, {
      pageId: fixture.pageId,
      anchorFrom: anchor(0),
      anchorTo: anchor(3),
      body: body('First'),
    });
    const second = await comments.createComment(fixture.owner, {
      pageId: fixture.pageId,
      anchorFrom: anchor(4),
      anchorTo: anchor(7),
      body: body('Second'),
    });

    const list = await comments.listComments(fixture.owner, { pageId: fixture.pageId });
    expect(list.map((c) => c.commentId)).toEqual([first.commentId, second.commentId]);
    expect(list[0]?.bodyText).toBe('First');
    expect(list[0]?.authorId).toBe(OWNER);
    expect(list[0]?.resolvedAt).toBeNull();
  });

  it('refuses an empty comment', async () => {
    const fixture = await scaffold('comment-empty');
    await expect(
      comments.createComment(fixture.owner, {
        pageId: fixture.pageId,
        anchorFrom: anchor(),
        anchorTo: anchor(),
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lets a commenter tuple grant a voice without edit rights', async () => {
    const fixture = await scaffold('comment-commenter-tuple');
    await members.addMember(
      fixture.orgId,
      { email: 'guest@comments.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: GUEST,
        relation: 'commenter',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, GUEST, 'guest');

    await expect(
      comments.createComment(guest, {
        pageId: fixture.pageId,
        anchorFrom: anchor(),
        anchorTo: anchor(),
        body: body('An outside view'),
      }),
    ).resolves.toMatchObject({ commentId: expect.any(String) as unknown as string });
  });

  it('a guest with no tuple gets NOT_FOUND — comment:create has no :read counterpart, so denial is always 404', async () => {
    const fixture = await scaffold('comment-no-tuple');
    await members.addMember(
      fixture.orgId,
      { email: 'guest@comments.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, GUEST, 'guest');

    await expect(
      comments.createComment(guest, {
        pageId: fixture.pageId,
        anchorFrom: anchor(),
        anchorTo: anchor(),
        body: body('Nope'),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets only the author edit, with no permission override', async () => {
    const fixture = await scaffold('comment-edit-author-only');
    await members.addMember(
      fixture.orgId,
      { email: 'member@comments.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const author = await actorFor(fixture.orgId, MEMBER, 'member');

    const comment = await comments.createComment(author, {
      pageId: fixture.pageId,
      anchorFrom: anchor(),
      anchorTo: anchor(),
      body: body('Mine'),
    });

    await expect(
      comments.updateComment(author, { commentId: comment.commentId, body: body('Mine, edited') }),
    ).resolves.toEqual({ edited: true });

    // The owner holds every permission in the matrix, including comment:create
    // — and is STILL refused, because editing is an identity check, not a
    // permission one.
    await expect(
      comments.updateComment(fixture.owner, {
        commentId: comment.commentId,
        body: body('Hijacked'),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deletes as a tombstone: the author, or a moderator holding comment:delete', async () => {
    const fixture = await scaffold('comment-delete');
    await members.addMember(
      fixture.orgId,
      { email: 'member@comments.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const author = await actorFor(fixture.orgId, MEMBER, 'member');

    const comment = await comments.createComment(author, {
      pageId: fixture.pageId,
      anchorFrom: anchor(),
      anchorTo: anchor(),
      body: body('Mine'),
    });

    // A member (not the author, and MEMBER lacks comment:delete) cannot moderate.
    await members.addMember(
      fixture.orgId,
      { email: 'guest@comments.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const other = await actorFor(fixture.orgId, GUEST, 'member');
    await expect(
      comments.deleteComment(other, { commentId: comment.commentId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The owner (comment:delete, from the matrix) can.
    await expect(
      comments.deleteComment(fixture.owner, { commentId: comment.commentId }),
    ).resolves.toEqual({ deleted: true });

    const list = await comments.listComments(fixture.owner, { pageId: fixture.pageId });
    expect(list[0]?.deletedAt).not.toBeNull();
    expect(list[0]?.body).toBeNull();
    expect(list[0]?.bodyText).toBe('');
  });

  it('resolves and reopens — any collaborator, not just the author', async () => {
    const fixture = await scaffold('comment-resolve');
    await members.addMember(
      fixture.orgId,
      { email: 'member@comments.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const author = await actorFor(fixture.orgId, MEMBER, 'member');
    const comment = await comments.createComment(author, {
      pageId: fixture.pageId,
      anchorFrom: anchor(),
      anchorTo: anchor(),
      body: body('Handled?'),
    });

    // The OWNER, not the author, resolves it.
    await expect(
      comments.resolveComment(fixture.owner, { commentId: comment.commentId, resolved: true }),
    ).resolves.toEqual({ resolved: true });

    let list = await comments.listComments(fixture.owner, { pageId: fixture.pageId });
    expect(list[0]?.resolvedAt).not.toBeNull();
    expect(list[0]?.resolvedBy).toBe(OWNER);

    await comments.resolveComment(fixture.owner, { commentId: comment.commentId, resolved: false });
    list = await comments.listComments(fixture.owner, { pageId: fixture.pageId });
    expect(list[0]?.resolvedAt).toBeNull();
    expect(list[0]?.resolvedBy).toBeNull();
  });
});

describe('suggestions', () => {
  it('creates and lists a suggestion as pending', async () => {
    const fixture = await scaffold('suggestion-create');
    const created_ = await suggestions.createSuggestion(fixture.owner, {
      pageId: fixture.pageId,
      anchorFrom: anchor(0),
      anchorTo: anchor(5),
      kind: 'replace',
      proposedContent: body('Better wording'),
    });

    const list = await suggestions.listSuggestions(fixture.owner, { pageId: fixture.pageId });
    expect(list).toHaveLength(1);
    expect(list[0]?.suggestionId).toBe(created_.suggestionId);
    expect(list[0]?.status).toBe('pending');
    expect(list[0]?.kind).toBe('replace');
  });

  it('refuses proposedContent on a delete suggestion, and requires it otherwise', async () => {
    const fixture = await scaffold('suggestion-shape');

    await expect(
      suggestions.createSuggestion(fixture.owner, {
        pageId: fixture.pageId,
        anchorFrom: anchor(),
        anchorTo: anchor(),
        kind: 'delete',
        proposedContent: body('Should not be here'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      suggestions.createSuggestion(fixture.owner, {
        pageId: fixture.pageId,
        anchorFrom: anchor(),
        anchorTo: anchor(),
        kind: 'insert',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a comment-tier member can PROPOSE a change without edit rights', async () => {
    const fixture = await scaffold('suggestion-propose-floor');
    await members.addMember(
      fixture.orgId,
      { email: 'member@comments.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'commenter',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const commenter = await actorFor(fixture.orgId, MEMBER, 'guest');

    await expect(
      suggestions.createSuggestion(commenter, {
        pageId: fixture.pageId,
        anchorFrom: anchor(),
        anchorTo: anchor(),
        kind: 'insert',
        proposedContent: body('A suggestion'),
      }),
    ).resolves.toMatchObject({ suggestionId: expect.any(String) as unknown as string });
  });

  it('accepting requires page:update — a commenter-tier author cannot accept their own', async () => {
    const fixture = await scaffold('suggestion-accept-needs-edit');
    await members.addMember(
      fixture.orgId,
      { email: 'member@comments.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'commenter',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const commenter = await actorFor(fixture.orgId, MEMBER, 'guest');

    const created_ = await suggestions.createSuggestion(commenter, {
      pageId: fixture.pageId,
      anchorFrom: anchor(),
      anchorTo: anchor(),
      kind: 'insert',
      proposedContent: body('A suggestion'),
    });

    // The author cannot ACCEPT their own suggestion at the commenter tier —
    // accepting is functionally an edit, and that would be an escape hatch
    // around edit rights. FORBIDDEN, not NOT_FOUND: unlike comment:create,
    // page:update has a page:read counterpart, and the commenter tuple
    // grants that — the page is visible, just not writable.
    await expect(
      suggestions.decideSuggestion(commenter, {
        suggestionId: created_.suggestionId,
        status: 'accepted',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The owner (page:update, from the matrix) can.
    await expect(
      suggestions.decideSuggestion(fixture.owner, {
        suggestionId: created_.suggestionId,
        status: 'accepted',
      }),
    ).resolves.toEqual({ status: 'accepted' });
  });

  it('withdrawing (rejecting) your own pending suggestion needs no edit right', async () => {
    const fixture = await scaffold('suggestion-withdraw');
    await members.addMember(
      fixture.orgId,
      { email: 'member@comments.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: MEMBER,
        relation: 'commenter',
        objectType: 'page',
        objectId: fixture.pageId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );
    const commenter = await actorFor(fixture.orgId, MEMBER, 'guest');

    const created_ = await suggestions.createSuggestion(commenter, {
      pageId: fixture.pageId,
      anchorFrom: anchor(),
      anchorTo: anchor(),
      kind: 'insert',
      proposedContent: body('A suggestion'),
    });

    await expect(
      suggestions.decideSuggestion(commenter, {
        suggestionId: created_.suggestionId,
        status: 'rejected',
      }),
    ).resolves.toEqual({ status: 'rejected' });
  });

  it('refuses deciding an already-decided suggestion', async () => {
    const fixture = await scaffold('suggestion-already-decided');
    const created_ = await suggestions.createSuggestion(fixture.owner, {
      pageId: fixture.pageId,
      anchorFrom: anchor(),
      anchorTo: anchor(),
      kind: 'insert',
      proposedContent: body('A suggestion'),
    });

    await suggestions.decideSuggestion(fixture.owner, {
      suggestionId: created_.suggestionId,
      status: 'accepted',
    });

    await expect(
      suggestions.decideSuggestion(fixture.owner, {
        suggestionId: created_.suggestionId,
        status: 'rejected',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
