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

  it('a channel tuple does not widen an unrelated, non-tuple-bearing permission', () => {
    /* The vulnerability an adversarial review caught before merge: `member`'s
       grant set is derived from an ACTION SUFFIX (`read`/`download`), matched
       against every permission ending in `:read` — including `audit:read`,
       `member:read`, `team:read`, `org:read`, none of which have anything to
       do with a channel. `tenancy.audit.list` and `tenancy.authz.explain`
       have no layer 2 — an org-level capability has no per-resource grant to
       consult, so `route()`'s pre-check IS their entire authorization
       decision. Matching a tuple's relation with no check on the tuple's
       OBJECT TYPE meant any member of any channel — not just a guest — could
       read the whole org audit log and any other user's permission trace.
       `resourceOf(permission)` is what closes it: `audit:read`'s resource is
       `'audit'`, and no tuple is ever written with that object type. */
    // `guest`, not `member`: MEMBER's role already grants `member:read` and
    // `team:read` directly (roles.ts), which would let those two pass on the
    // role alone and defeat the point of this test — it has to isolate what
    // the TUPLE contributes. `guest` grants nothing from the role, so any
    // `true` below can only have come from the tuple.
    const channel = { type: 'channel', id: 'chan_1' } as const;
    const guestInChannel = subject('guest', [tuple('member', channel)]);

    expect(couldGrant(guestInChannel, 'audit:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'member:read')).toBe(false);
    expect(couldGrant(guestInChannel, 'team:read')).toBe(false);

    // The channel tuple still does its actual job.
    expect(couldGrant(guestInChannel, 'channel:read')).toBe(true);
  });

  it('a tuple only widens permissions on its own resource type', () => {
    // A `card` tuple must not satisfy a `channel:*` permission either, even
    // though both are ordinary, tuple-bearing resources — the fix is a type
    // match, not a carve-out for org-level capabilities specifically. `guest`
    // again, so the role itself contributes nothing to either assertion.
    const withCardTuple = subject('guest', [tuple('editor', CARD)]);
    expect(couldGrant(withCardTuple, 'channel:read')).toBe(false);
    expect(couldGrant(withCardTuple, 'card:update')).toBe(true);
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
