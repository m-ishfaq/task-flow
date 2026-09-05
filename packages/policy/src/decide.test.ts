import { describe, expect, it } from 'vitest';
import { isAppError, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { can, couldGrant, formatTrace, allowed, type Subject, type Target } from './decide.js';
import { enforce } from './enforce.js';
import type { RelationshipTuple } from './tuples.js';
import type { Role } from './roles.js';

const ORG_A = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-00000000000a');
const ORG_B = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-00000000000b');
const USER = unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001');

const BOARD = { type: 'board', id: 'board_71c' } as const;
const PROJECT = { type: 'project', id: 'proj_01' } as const;
const CARD = { type: 'card', id: 'card_9f3a' } as const;

function subject(
  role: Role,
  tuples: readonly RelationshipTuple[] = [],
  orgId: OrgId = ORG_A,
  userId: UserId = USER,
): Subject {
  return { orgId, userId, role, tuples };
}

function cardTarget(orgId: OrgId = ORG_A): Target {
  return { orgId, resource: CARD, ancestors: [BOARD, PROJECT] };
}

const tuple = (relation: RelationshipTuple['relation'], object: RelationshipTuple['object']) => ({
  subject: USER,
  relation,
  object,
});

describe('org-level capabilities', () => {
  it('grants what the role grants', () => {
    expect(can(subject('owner'), 'org:delete').allowed).toBe(true);
    expect(can(subject('admin'), 'org:delete').allowed).toBe(false);
  });

  it('does not consult tuples when there is no resource', () => {
    // A tuple grants a relation on an OBJECT. Letting one leak into an
    // org-level check would mean owning a board could delete the organization.
    const withOwnership = subject('member', [tuple('owner', BOARD)]);
    expect(can(withOwnership, 'org:delete').allowed).toBe(false);
  });
});

describe('couldGrant — the route-level pre-check', () => {
  /* apps/api/src/trpc/builder.ts's `route()` runs this, with no resource
     loaded yet, before every handler behind `permission`. The regression this
     guards: it used to call `can(subject, permission)` with no target, which
     answers from ROLE ALONE (see the no-target branch in `can` above) — right
     for every role except `guest`, which grants nothing by itself. That
     refused a guest on every chat route before the handler ever loaded the
     one channel their TUPLE would have granted them — layer 2 never ran. */

  it('grants what the role grants, same as before', () => {
    expect(couldGrant(subject('owner'), 'org:delete')).toBe(true);
    expect(couldGrant(subject('admin'), 'org:delete')).toBe(false);
  });

  it('a guest with a channel tuple passes the pre-check for channel:read', () => {
    const channel = { type: 'channel', id: 'chan_1' } as const;
    const guest = subject('guest', [tuple('member', channel)]);

    // The role alone still grants nothing — this is not a role change.
    expect(couldGrant(subject('guest'), 'channel:read')).toBe(false);
    // But a guest who holds ANY tuple whose relation covers the permission
    // must pass the coarse pre-check, or the handler that would consult
    // their tuple on the SPECIFIC channel never runs at all.
    expect(couldGrant(guest, 'channel:read')).toBe(true);
  });

  it('a guest with no tuples at all still fails the pre-check', () => {
    // Not a regression to relax: someone who holds nothing, by role or by
    // tuple, cannot pass this on any object, and layer 2 would only confirm
    // that at the cost of a wasted round trip.
    expect(couldGrant(subject('guest'), 'channel:read')).toBe(false);
  });

  it('an unrecognized role denies, the same as can() does', () => {
    expect(couldGrant(subject('temp-worker' as Role), 'channel:read')).toBe(false);
  });

  it('a channel tuple grants the OTHER permissions a channel member actually needs', () => {
    // `message:create` and `attachment:download` do not have "channel" in
    // their own name, but `enforceOnChannel` checks them against the CHANNEL
    // as its target regardless — so a channel tuple must widen these too, or
    // the very case `couldGrant` exists for (a guest posting in the one
    // channel they were invited to) breaks again. `guest`, so the role
    // contributes nothing to either assertion.
    const channel = { type: 'channel', id: 'chan_1' } as const;
    const guestInChannel = subject('guest', [tuple('member', channel)]);

    expect(couldGrant(guestInChannel, 'message:create')).toBe(true);
    expect(couldGrant(guestInChannel, 'attachment:download')).toBe(true);
  });

  it('a channel tuple does not widen a permission with no layer 2 at all', () => {
    /* The vulnerability an adversarial review caught before merge: `member`'s
       grant set is derived from an ACTION SUFFIX (`read`/`download`), matched
       against every permission ending in `:read` — including `audit:read`,
       `member:read`, `team:read`, `org:read`, none of which have anything to
       do with a channel. `tenancy.audit.list`, `tenancy.members.list` and
       `tenancy.teams.list` have NO layer 2 anywhere — an org-level capability
       has no per-resource grant to consult, so `route()`'s pre-check IS their
       entire authorization decision, for every tuple a subject could ever
       hold. `isOrgLevel` is what closes it. `guest`, so the role itself
       contributes nothing to any assertion below — any `true` could only have
       come from the tuple. */
    const channel = { type: 'channel', id: 'chan_1' } as const;
    const guestInChannel = subject('guest', [tuple('member', channel)]);

    expect(couldGrant(guestInChannel, 'audit:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'member:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'team:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'org:read')).toBe(false);

    // The channel tuple still does its actual job.
    expect(couldGrant(guestInChannel, 'channel:read')).toBe(true);
  });

  it('no tuple at any relation reaches an org-level permission, not even the broadest one', () => {
    // `owner` is the widest relation there is — every action, on any object.
    // If anything could smuggle a tuple past `isOrgLevel`, this would be it.
    const anyObject = { type: 'card', id: 'card_1' } as const;
    const withOwnerTuple = subject('guest', [tuple('owner', anyObject)]);

    expect(couldGrant(withOwnerTuple, 'audit:read')).toBe(false);
    expect(couldGrant(withOwnerTuple, 'org:update')).toBe(false);
    expect(couldGrant(withOwnerTuple, 'member:manage')).toBe(false);
    expect(couldGrant(withOwnerTuple, 'team:manage')).toBe(false);
    expect(couldGrant(withOwnerTuple, 'apiToken:create')).toBe(false);

    // The same tuple still does its actual, resource-scoped job.
    expect(couldGrant(withOwnerTuple, 'card:update')).toBe(true);
  });

  it('a channel tuple does not reach the telephony catalog', () => {
    /* The same defect as the `audit:read` case above, found again in Phase 7:
       `ORG_LEVEL_PERMISSIONS` excluded the telephony permissions on the note
       that "those phases have not shipped", and the note outlived the phase.
       Every route below hands its service an `orgId` and no subject
       (`calls.listCalls(orgId, …)`, `messages.listThreads(orgId, …)`,
       `spendReport(orgId, …)`), so there is no layer 2 anywhere and this
       pre-check is the whole decision. A `guest` holds nothing by role, so
       every `true` here could only have come from the channel tuple. */
    const channel = { type: 'channel', id: 'chan_1' } as const;
    const guestInChannel = subject('guest', [tuple('member', channel)]);

    expect(couldGrant(guestInChannel, 'call:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'sms:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'phoneNumber:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'recording:read')).toBe(false);

    // A `member` relation grants by action suffix, so the write halves were
    // never reachable this way — asserted anyway, because the reason they are
    // safe is the suffix table, which is free to change.
    expect(couldGrant(guestInChannel, 'sms:send')).toBe(false);
    expect(couldGrant(guestInChannel, 'call:place')).toBe(false);
    expect(couldGrant(guestInChannel, 'recording:export')).toBe(false);
    expect(couldGrant(guestInChannel, 'phoneNumber:purchase')).toBe(false);

    // The roles that genuinely hold these still do. This is the assertion that
    // fails if someone "fixes" the above by removing them from the catalog.
    // `member` no longer holds these by role at all (Phase 15 §1's
    // "contract" step, migration 0098) — `admin` is the role that still
    // does, alongside `owner`.
    expect(couldGrant(subject('admin'), 'call:read')).toBe(true);
    expect(couldGrant(subject('admin'), 'recording:read')).toBe(true);
  });

  it('space:read is NOT org-level — a Docs guest reaches their space by tuple', () => {
    /* The deliberate asymmetry with the telephony block above, and the reason
       `docs.spaces.list`'s leak is fixed in its service rather than here. A
       space is genuinely tuple-shareable: `spaceTarget()` exists and a guest
       holding `viewer` on one space is a supported product state, so making
       `space:read` org-level would refuse that guest at layer 1 and no layer 2
       would ever run. The listing route filters per space instead. */
    const space = { type: 'space', id: 'space_1' } as const;
    const guestInSpace = subject('guest', [tuple('viewer', space)]);

    expect(couldGrant(guestInSpace, 'space:read')).toBe(true);

    // But a tuple on something else entirely still must not reach it — that
    // is what the service-side filter is for, not this check.
    expect(couldGrant(subject('guest'), 'space:read')).toBe(false);
  });
});

describe('tenancy', () => {
  it('denies a resource belonging to another organization', () => {
    // RLS makes this unreachable in practice; reaching it means something
    // upstream loaded a row it should not have. Denying turns that into an
    // audited refusal rather than trusting the database to be the only guard.
    const decision = can(subject('owner'), 'card:read', cardTarget(ORG_B));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/another organization/);
  });

  it('denies cross-tenant access even to an owner with a matching tuple', () => {
    // The worst version of this bug: a tuple row that survived a tenant move.
    const withTuple = subject('owner', [tuple('owner', CARD)]);
    expect(can(withTuple, 'card:update', cardTarget(ORG_B)).allowed).toBe(false);
  });
});

describe('relationship tuples', () => {
  it('grants a guest access to the one channel they were invited to', () => {
    const channel = { type: 'channel', id: 'chan_1' } as const;
    const guest = subject('guest', [tuple('member', channel)]);

    expect(allowed(guest, 'message:create', { orgId: ORG_A, resource: channel })).toBe(true);
  });

  it('does not leak that grant to a different channel', () => {
    const invited = { type: 'channel', id: 'chan_1' } as const;
    const other = { type: 'channel', id: 'chan_2' } as const;
    const guest = subject('guest', [tuple('member', invited)]);

    expect(allowed(guest, 'message:create', { orgId: ORG_A, resource: other })).toBe(false);
    expect(allowed(guest, 'message:read', { orgId: ORG_A, resource: other })).toBe(false);
  });

  it('inherits a grant from an ancestor', () => {
    // An editor on the board may edit the cards in it, without the engine
    // knowing that cards live in boards.
    const editor = subject('guest', [tuple('editor', BOARD)]);
    expect(allowed(editor, 'card:update', cardTarget())).toBe(true);
  });

  it('lets the nearest grant narrow an inherited one', () => {
    // viewer on the card must beat editor on the board, or narrowing an
    // inherited grant would be impossible to express.
    const mixed = subject('member', [tuple('editor', PROJECT), tuple('viewer', CARD)]);
    expect(allowed(mixed, 'card:update', cardTarget())).toBe(false);
    expect(allowed(mixed, 'card:read', cardTarget())).toBe(true);
  });

  it('takes the most permissive of equally near grants', () => {
    // Being both viewer and editor on the same board means editor: the narrower
    // grant was not intended to revoke the wider one.
    const both = subject('guest', [tuple('viewer', BOARD), tuple('editor', BOARD)]);
    expect(allowed(both, 'card:update', cardTarget())).toBe(true);
  });
});

describe('restrictive grants', () => {
  it('caps a member to read-only on a board shared as viewer', () => {
    // The scenario from §8.2. Without capping, sharing a board read-only would
    // silently grant write access — the opposite of what the sharer believes
    // they did.
    const member = subject('member', [tuple('viewer', BOARD)]);
    const decision = can(member, 'card:update', cardTarget());

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/read-only/);
  });

  it('still allows reading', () => {
    const member = subject('member', [tuple('viewer', BOARD)]);
    expect(allowed(member, 'card:read', cardTarget())).toBe(true);
  });

  it('lets a commenter comment but not edit', () => {
    const commenter = subject('member', [tuple('commenter', BOARD)]);
    expect(allowed(commenter, 'comment:create', cardTarget())).toBe(true);
    expect(allowed(commenter, 'card:update', cardTarget())).toBe(false);
  });

  it('does not cap an org admin, and records why', () => {
    // An admin can delete the tuple anyway, so enforcing the cap would make the
    // system confusing rather than safer. The bypass has to be visible.
    const admin = subject('admin', [tuple('viewer', BOARD)]);
    const decision = can(admin, 'card:update', cardTarget());

    expect(decision.allowed).toBe(true);
    expect(decision.trace.some((step) => step.rule.includes('bypasses restrictive'))).toBe(true);
  });

  it('does not turn a bypass into a grant the role never had', () => {
    // The bypass lifts the cap; it does not add permissions. An admin still
    // cannot export a recording.
    const admin = subject('admin', [tuple('viewer', { type: 'recording', id: 'rec_1' })]);
    const target = { orgId: ORG_A, resource: { type: 'recording', id: 'rec_1' } } as const;

    expect(allowed(admin, 'recording:export', target)).toBe(false);
  });
});

describe('decision trace', () => {
  it('records every step that led to the outcome', () => {
    const member = subject('member', [tuple('viewer', BOARD)]);
    const decision = can(member, 'card:update', cardTarget());

    expect(decision.trace.length).toBeGreaterThanOrEqual(3);
    expect(decision.trace[0]?.rule).toContain('card:update');
    expect(decision.trace.some((step) => step.outcome === 'grant')).toBe(true);
    expect(decision.trace.some((step) => step.outcome === 'deny')).toBe(true);
  });

  it('renders in the documented shape', () => {
    const member = subject('member', [tuple('viewer', BOARD)]);
    const rendered = formatTrace(can(member, 'card:update', cardTarget()));

    expect(rendered.startsWith('deny  card:update  card:card_9f3a')).toBe(true);
    expect(rendered).toContain('layer 2');
    expect(rendered).toContain('read-only');
  });

  it('explains an allow as well as a denial', () => {
    // The audit log carries the trace on denials, but the debug page needs to
    // answer "why CAN this user do that?" too, which is the harder question.
    const rendered = formatTrace(can(subject('owner'), 'org:delete'));
    expect(rendered.startsWith('allow  org:delete  (no resource)')).toBe(true);
  });
});

describe('fail-closed behaviour', () => {
  it('denies a permission that is not in the catalog', () => {
    // Unreachable from TypeScript, but the engine also sees strings that crossed
    // a trust boundary: an API token's scope, a stored automation's action.
    const decision = can(subject('owner'), 'card:teleport' as never);

    expect(decision.allowed).toBe(false);
    expect(decision.trace[0]?.outcome).toBe('deny');
  });

  it('denies an unknown role rather than treating it as a member', () => {
    const decision = can(subject('superuser' as never), 'card:read', cardTarget());
    expect(decision.allowed).toBe(false);
  });
});

/**
 * Closed resources — a private channel or a DM (ai/phase-5-chat.md §3.3).
 *
 * Every assertion here is about the same failure, approached from a different
 * angle: `member` holds `channel:read` from the role matrix, so a channel target
 * built WITHOUT `closed` is allowed for everyone in the organization. Nothing
 * throws and the decision trace reads as correct — the role really does grant
 * the permission and there really is no tuple to weigh against it — so the only
 * thing standing between a private conversation and every colleague is the flag
 * these tests pin down.
 */
describe('closed resources', () => {
  const CHANNEL = { type: 'channel', id: 'chan_5a1' } as const;

  const openChannel: Target = { orgId: ORG_A, resource: CHANNEL, ancestors: [] };
  const closedChannel: Target = { ...openChannel, closed: true };

  it('lets the role reach an OPEN channel — the public case', () => {
    expect(can(subject('member'), 'channel:read', openChannel).allowed).toBe(true);
  });

  it('denies a closed channel to a member holding no relation on it', () => {
    // The whole point. Without `closed`, this is `true`.
    expect(can(subject('member'), 'channel:read', closedChannel).allowed).toBe(false);
  });

  it('allows a closed channel to someone holding a member tuple on it', () => {
    const insider = subject('member', [tuple('member', CHANNEL)]);
    expect(can(insider, 'channel:read', closedChannel).allowed).toBe(true);
    expect(can(insider, 'message:create', closedChannel).allowed).toBe(true);
  });

  it('does NOT let an owner or admin bypass it', () => {
    /* `bypassesRestrictions` lets an administrator through a restrictive CAP,
       because they could delete the tuple anyway. That reasoning does not extend
       to a resource they hold nothing on, and the difference is visibility:
       adding yourself to a private channel is an act its members can see, and
       for a DM there is no membership to grant yourself at all. The audited path
       to someone else's conversation is compliance export. */
    expect(can(subject('owner'), 'channel:read', closedChannel).allowed).toBe(false);
    expect(can(subject('admin'), 'channel:read', closedChannel).allowed).toBe(false);
  });

  it('still honours a grant on the resource for an admin', () => {
    const admin = subject('admin', [tuple('member', CHANNEL)]);
    expect(can(admin, 'channel:read', closedChannel).allowed).toBe(true);
  });

  it('says why, rather than denying silently', () => {
    const decision = can(subject('member'), 'channel:read', closedChannel);
    const denial = decision.trace.find((step) => step.outcome === 'deny');

    expect(denial?.rule).toContain('closed');
    expect(decision.reason).toContain('not a member');
  });

  it('answers 404 through enforce, not 403', () => {
    /* A non-member must not learn that a private channel exists. `enforce`
       derives this from `channel:read` also failing, so it falls out of the
       closed check rather than needing its own branch. */
    expect(thrownCode(() => enforce(subject('member'), 'message:create', closedChannel))).toBe(
      'NOT_FOUND',
    );
  });

  it('leaves every open resource unaffected', () => {
    // The flag is opt-in. Work has no closed resources and must not acquire one
    // by accident, so the default is checked explicitly.
    expect(can(subject('member'), 'card:read', cardTarget()).allowed).toBe(true);
  });
});

/** The error code `fn` throws, or a description of why it did not. */
function thrownCode(fn: () => unknown): string {
  try {
    fn();
    return 'no error thrown';
  } catch (error) {
    return isAppError(error) ? error.code : `not an AppError: ${String(error)}`;
  }
}

describe('enforce', () => {
  it('returns the decision when allowed', () => {
    expect(enforce(subject('owner'), 'card:read', cardTarget()).allowed).toBe(true);
  });

  it('throws 404 when the subject cannot even see the resource', () => {
    // Answering 403 would confirm the resource exists, which across tenants
    // leaks the existence of another organization's data (§8.7).
    expect(thrownCode(() => enforce(subject('guest'), 'card:update', cardTarget()))).toBe(
      'NOT_FOUND',
    );
  });

  it('throws 403 when the subject can see it but not act', () => {
    const member = subject('member', [tuple('viewer', BOARD)]);
    expect(thrownCode(() => enforce(member, 'card:update', cardTarget()))).toBe('FORBIDDEN');
  });

  it('hides another tenant behind a 404', () => {
    expect(thrownCode(() => enforce(subject('owner'), 'card:read', cardTarget(ORG_B)))).toBe(
      'NOT_FOUND',
    );
  });
});
