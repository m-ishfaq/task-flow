import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { MailQueue, MemoryMailer } from '@taskflow/mail';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from './org.service.js';
import * as members from './member.service.js';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from './invitation.service.js';
import { invitationAccepted, invitationRevoked, invitationSent, memberAdded } from './events.js';
import type { Actor } from './org.service.js';
import type { Role } from '@taskflow/policy';

/**
 * Email invitations (migration 0107). Everything past role validation needs
 * a real database — the partial unique index that makes a resend rotate
 * rather than duplicate, the RLS-exempt `invitation_lookup` table an accept
 * call resolves through before it has a scope, and the actual membership
 * insert — so this suite follows `card-pull-request.service.test.ts`'s own
 * shape: real Postgres, real `withOrgScope` calls through the real service
 * functions, no mocked RLS.
 */

const OWNER = unsafeAsId<'UserId'>('0195f200-0000-7000-8000-000000000201');
const INVITEE = unsafeAsId<'UserId'>('0195f200-0000-7000-8000-000000000202');
const STRANGER = unsafeAsId<'UserId'>('0195f200-0000-7000-8000-000000000203');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@invite.test'],
  [INVITEE, 'invitee@invite.test'],
  [STRANGER, 'stranger@invite.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195f200-0000-7000-8000-0000000002ff');

let admin: AdminConnection;
let created: OrgId[] = [];

function actorFor(userId: UserId): Actor {
  return { userId, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorFor(OWNER));
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  // Children before parents: the lookup and invitation rows before the org.
  await admin.query(`DELETE FROM identity.invitation_lookup WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.invitations WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function outboxFor(
  orgId: OrgId,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
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

/** A real MailQueue over an in-memory mailer, so a test can read what would have been sent. */
function fakeMail(): { mailer: MemoryMailer; queue: MailQueue } {
  const mailer = new MemoryMailer();
  const queue = new MailQueue({ mailer, sleep: () => Promise.resolve() });
  return { mailer, queue };
}

/** Pulls the raw token back out of the accept link — the ONE place it exists outside storage. */
function tokenFromMail(mailer: MemoryMailer): string {
  const message = mailer.sent.at(-1);
  if (!message) throw new Error('no mail was sent');
  const match = /token=([^&\s"]+)/.exec(message.text);
  if (!match?.[1]) throw new Error('no token found in the sent mail');
  return decodeURIComponent(match[1]);
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

  initializeDatabase({
    url: TEST_ENV.DATABASE_URL,
    applicationName: 'taskflow-invitation-svc-test',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
});

describe('createInvitation — validates before touching the database', () => {
  const anyOrg = unsafeAsId<'OrgId'>('0195f200-0000-7000-8000-000000000000');

  it('refuses a role that is not one of ROLES', async () => {
    await expect(
      createInvitation(
        anyOrg,
        { email: 'a@b.test', role: 'superadmin' as Role },
        actorFor(OWNER),
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses owner — reached by transferring ownership, not by invitation', async () => {
    await expect(
      createInvitation(anyOrg, { email: 'a@b.test', role: 'owner' }, actorFor(OWNER), {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('createInvitation', () => {
  it('creates a pending invitation, sends mail, and emits invitation.sent', async () => {
    const orgId = await newOrg('invite-create');
    const { mailer, queue } = fakeMail();

    const result = await createInvitation(
      orgId,
      { email: 'New.Person@Invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    expect(result).toEqual({ status: 'invited' });

    await queue.drain();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('new.person@invite.test');

    const pending = await listInvitations(orgId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      email: 'new.person@invite.test',
      role: 'member',
      invitedBy: OWNER,
    });

    const events = await outboxFor(orgId);
    const sent = events.filter((event) => event.name === invitationSent.name);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ email: 'new.person@invite.test', role: 'member' });
  });

  it('refuses when the address is already a member', async () => {
    const orgId = await newOrg('invite-conflict');
    await members.addMember(
      orgId,
      { email: 'invitee@invite.test', role: 'member' },
      actorFor(OWNER),
    );

    await expect(
      createInvitation(orgId, { email: 'invitee@invite.test', role: 'admin' }, actorFor(OWNER), {}),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('resending rotates the token, and the old one stops resolving an org', async () => {
    const orgId = await newOrg('invite-resend');

    const first = fakeMail();
    await createInvitation(
      orgId,
      { email: 'resend@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue: first.queue, webOrigin: 'https://app.test' } },
    );
    await first.queue.drain();
    const firstToken = tokenFromMail(first.mailer);

    const second = fakeMail();
    await createInvitation(orgId, { email: 'resend@invite.test', role: 'admin' }, actorFor(OWNER), {
      mail: { queue: second.queue, webOrigin: 'https://app.test' },
    });
    await second.queue.drain();
    const secondToken = tokenFromMail(second.mailer);

    expect(secondToken).not.toBe(firstToken);

    // One row, rotated — not two.
    const pending = await listInvitations(orgId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.role).toBe('admin');

    await expect(acceptInvitation(actorFor(STRANGER), { token: firstToken })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});

describe('revokeInvitation', () => {
  it('revokes a pending invitation, deletes the lookup row, and emits invitation.revoked', async () => {
    const orgId = await newOrg('invite-revoke');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'revoke-me@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    const pending = await listInvitations(orgId);
    const invitationId = unsafeAsId<'InvitationId'>(pending[0]?.invitationId ?? '');

    const result = await revokeInvitation(orgId, { invitationId }, actorFor(OWNER));
    expect(result).toEqual({ revoked: true });

    expect(await listInvitations(orgId)).toHaveLength(0);

    const events = await outboxFor(orgId);
    expect(events.filter((event) => event.name === invitationRevoked.name)).toHaveLength(1);

    await expect(acceptInvitation(actorFor(STRANGER), { token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses an unknown or already-revoked invitation id', async () => {
    const orgId = await newOrg('invite-revoke-404');
    await expect(
      revokeInvitation(
        orgId,
        { invitationId: unsafeAsId<'InvitationId'>('0195f200-0000-7000-8000-0000000009ff') },
        actorFor(OWNER),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('previewInvitation', () => {
  it('returns the org, invited email, and role — no session needed', async () => {
    const orgId = await newOrg('invite-preview');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'admin' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    const preview = await previewInvitation({ token });
    expect(preview).toMatchObject({ email: 'invitee@invite.test', role: 'admin' });
    expect(preview.orgName.length).toBeGreaterThan(0);
  });

  it('refuses an unknown token, the same NOT_FOUND acceptInvitation uses', async () => {
    await expect(previewInvitation({ token: 'tf_inv_doesnotexist' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a revoked invitation without mutating anything', async () => {
    const orgId = await newOrg('invite-preview-revoked');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    const pending = await listInvitations(orgId);
    const invitationId = unsafeAsId<'InvitationId'>(pending[0]?.invitationId ?? '');
    await revokeInvitation(orgId, { invitationId }, actorFor(OWNER));

    await expect(previewInvitation({ token })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an expired invitation WITHOUT flipping its status — a preview is read-only', async () => {
    const orgId = await newOrg('invite-preview-expired');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE identity.invitations SET expires_at = now() - interval '1 day' WHERE org_id = $1`,
      [orgId],
    );
    await admin.setOrg(null);

    await expect(previewInvitation({ token })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Still 'pending' — previewInvitation must not mutate status the way
    // acceptInvitation does on discovering the same expiry.
    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT status FROM identity.invitations WHERE org_id = $1`, [
      orgId,
    ]);
    await admin.setOrg(null);
    expect(rows.rows[0]?.['status']).toBe('pending');
  });
});

describe('acceptInvitation', () => {
  it('creates a membership and emits member.added + invitation.accepted', async () => {
    const orgId = await newOrg('invite-accept');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'admin' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    const result = await acceptInvitation(actorFor(INVITEE), { token });
    expect(result).toMatchObject({ orgId, role: 'admin', alreadyMember: false });

    expect(await listInvitations(orgId)).toHaveLength(0);

    const events = await outboxFor(orgId);
    expect(events.filter((event) => event.name === memberAdded.name)).toHaveLength(1);
    expect(events.filter((event) => event.name === invitationAccepted.name)).toHaveLength(1);

    // The token is single-use — accepted state, and the lookup row is gone.
    await expect(acceptInvitation(actorFor(INVITEE), { token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses when the authenticated caller is not the invited address', async () => {
    const orgId = await newOrg('invite-wrong-email');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    await expect(acceptInvitation(actorFor(STRANGER), { token })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses an expired invitation and marks it expired', async () => {
    const orgId = await newOrg('invite-expired');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE identity.invitations SET expires_at = now() - interval '1 day' WHERE org_id = $1`,
      [orgId],
    );
    await admin.setOrg(null);

    await expect(acceptInvitation(actorFor(INVITEE), { token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await listInvitations(orgId)).toHaveLength(0);
  });

  it('refuses an unknown token with no database write', async () => {
    await expect(
      acceptInvitation(actorFor(INVITEE), { token: 'tf_inv_doesnotexist' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is idempotent for someone already a member — no duplicate membership or member.added', async () => {
    const orgId = await newOrg('invite-already-member');
    const { mailer, queue } = fakeMail();
    await createInvitation(
      orgId,
      { email: 'invitee@invite.test', role: 'member' },
      actorFor(OWNER),
      { mail: { queue, webOrigin: 'https://app.test' } },
    );
    await queue.drain();
    const token = tokenFromMail(mailer);

    // Race: the invited person is added some other way before they accept.
    await members.addMember(
      orgId,
      { email: 'invitee@invite.test', role: 'admin' },
      actorFor(OWNER),
    );

    const result = await acceptInvitation(actorFor(INVITEE), { token });
    expect(result.alreadyMember).toBe(true);

    const events = await outboxFor(orgId);
    // Exactly one member.added — from addMember, not from acceptInvitation.
    expect(events.filter((event) => event.name === memberAdded.name)).toHaveLength(1);
    expect(events.filter((event) => event.name === invitationAccepted.name)).toHaveLength(1);
  });
});
