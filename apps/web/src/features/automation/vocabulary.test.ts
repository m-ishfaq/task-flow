import { describe, expect, it } from 'vitest';
import {
  ACTION_LABELS,
  ARGUMENTS,
  INTEGRATION_PROVIDER_OF,
  TELEPHONY_ACTIONS,
  TRIGGER_OPTIONS,
  blankAction,
  describeAction,
  needsProject,
  offeredActions,
} from './vocabulary.js';

/**
 * The rule builder's closed vocabulary (ai/phase-10-automation.md §1.3), with
 * Wave 4's cost-bearing actions (ai/phase-10-automation.md §5.5) pinned.
 *
 * The properties under test are the ones the builder's OTHER consumers lean
 * on without checking: `describeAction` renders a stored rule for a person,
 * `blankAction` seeds an editable draft, `actionsComplete` (in the page)
 * requires every ARGUMENTS field to be non-empty, and `offeredActions` decides
 * whether the telephony actions exist in the picker at all. A rule that
 * validates at the server boundary (action-schema.test.ts) but cannot be
 * built here is a feature that exists in neither place.
 */

describe('the telephony action vocabulary (Wave 4 §5.5)', () => {
  it('labels both cost-bearing actions', () => {
    expect(ACTION_LABELS['call.place']).toBe('Place a call');
    expect(ACTION_LABELS['sms.send']).toBe('Send an SMS');
  });

  it('declares every argument of every action', () => {
    /* `actionsComplete` requires a value for every ARGUMENTS field before the
       Save button enables, so a field missing here is a rule that can never
       be saved. Both actions share the destination + from-number shape; the
       SMS adds the body. */
    /* `?? []`: `ARGUMENTS` is an indexable record, so a missing entry reads as
       undefined — the invariant test at the bottom proves it is present; the
       map just needs a type-level stand-in. */
    expect((ARGUMENTS['call.place'] ?? []).map((spec) => spec.field)).toEqual([
      'to',
      'fromPhoneNumberId',
    ]);
    expect((ARGUMENTS['sms.send'] ?? []).map((spec) => spec.field)).toEqual([
      'to',
      'fromPhoneNumberId',
      'body',
    ]);
  });

  it('offers the destination as a contact-or-custom picker and the from-number as an owned-number picker', () => {
    expect(ARGUMENTS['call.place']?.[0]?.kind).toBe('phoneTarget');
    expect(ARGUMENTS['call.place']?.[1]?.kind).toBe('phoneNumber');
    expect(ARGUMENTS['sms.send']?.[0]?.kind).toBe('phoneTarget');
    expect(ARGUMENTS['sms.send']?.[1]?.kind).toBe('phoneNumber');
    expect(ARGUMENTS['sms.send']?.[2]?.kind).toBe('text');
  });

  it('seeds a blank draft with every field empty', () => {
    /* The server refuses a rule whose action lacks a required argument, and
       `actionsComplete` only checks non-emptiness — so a draft seeded with
       anything pre-filled would be silently savable with a value nobody chose. */
    expect(blankAction('call.place').value).toEqual({
      type: 'call.place',
      to: '',
      fromPhoneNumberId: '',
    });
    expect(blankAction('sms.send').value).toEqual({
      type: 'sms.send',
      to: '',
      fromPhoneNumberId: '',
      body: '',
    });
  });

  it('describes an SMS by its message and a call by its destination', () => {
    /* The rule row shows WHAT the rule does. A message-carrying action reads
       best by its words; the call has none, so its destination stands in. */
    expect(
      describeAction({
        type: 'sms.send',
        to: '+14155550100',
        fromPhoneNumberId: 'x',
        body: 'Ship it',
      }),
    ).toBe('Send an SMS: “Ship it”');
    expect(describeAction({ type: 'call.place', to: '+14155550100', fromPhoneNumberId: 'x' })).toBe(
      'Place a call: +14155550100',
    );
  });

  it('keeps both actions out of the project-scoped set', () => {
    /* A phone number is org-wide vocabulary; the picker must never demand a
       project be chosen first to reach it. */
    expect(needsProject('call.place')).toBe(false);
    expect(needsProject('sms.send')).toBe(false);
  });
});

describe('offeredActions — the product-surface flag', () => {
  it('hides the telephony actions while the flag is off, keeping every other action', () => {
    const offered = offeredActions(false).map(([type]) => type);

    for (const type of TELEPHONY_ACTIONS) expect(offered).not.toContain(type);
    /* The base actions are unconditional — a flag that gated card moves too
       would be a feature flag wearing the wrong hat. */
    expect(offered).toContain('card.move');
    expect(offered).toContain('call_webhook');
  });

  it('offers the telephony actions when the flag is on', () => {
    const offered = offeredActions(true).map(([type]) => type);

    expect(offered).toContain('call.place');
    expect(offered).toContain('sms.send');
  });

  it('names every action in the picker with the same words a stored rule is described by', () => {
    /* One label, two readers: the builder's select and the list's rows. A
       second copy in either place is how the picker says "Place a call" and
       the history says "call.place". */
    for (const [type, label] of offeredActions(true)) {
      expect(ACTION_LABELS[type]).toBe(label);
    }
  });
});

describe('§8 — onboarding/offboarding automation vocabulary', () => {
  it('offers both membership triggers, card-less like the connector events', () => {
    const events = TRIGGER_OPTIONS.map((option) => option.event);
    expect(events).toContain('member.added');
    expect(events).toContain('member.offboarding_started');
  });

  it('labels all six actions', () => {
    expect(ACTION_LABELS['channel.add_member']).toBe('Add them to a channel');
    expect(ACTION_LABELS['channel.remove_member']).toBe('Remove them from a channel');
    expect(ACTION_LABELS['docs.grant_space_access']).toBe(
      'Give them viewer access to a Docs space',
    );
    expect(ACTION_LABELS['identity.revoke_sessions']).toBe('Sign them out everywhere');
    expect(ACTION_LABELS['member_grant.revoke_all']).toBe(
      'Revoke every individual permission they hold',
    );
    expect(ACTION_LABELS['cards.bulk_reassign']).toBe('Reassign their cards to someone else');
  });

  it('declares the one argument each action that takes one needs, and none for the two that take none', () => {
    /* None of these six carries a `userId` — every one acts on the member the
       TRIGGER named, the same discipline `apps/worker`'s own executor
       enforces server-side. A `userId` field here would be a picker offering
       to reach past the person the rule fired for. */
    expect((ARGUMENTS['channel.add_member'] ?? []).map((spec) => spec.field)).toEqual([
      'channelId',
    ]);
    expect((ARGUMENTS['channel.remove_member'] ?? []).map((spec) => spec.field)).toEqual([
      'channelId',
    ]);
    expect((ARGUMENTS['docs.grant_space_access'] ?? []).map((spec) => spec.field)).toEqual([
      'spaceId',
    ]);
    expect(ARGUMENTS['identity.revoke_sessions']).toEqual([]);
    expect(ARGUMENTS['member_grant.revoke_all']).toEqual([]);
    /* The one exception: `toUserId` names the REPLACEMENT assignee, not who
       the rule acts on — there is no other way to say who a departing
       member's cards go to. */
    expect((ARGUMENTS['cards.bulk_reassign'] ?? []).map((spec) => spec.field)).toEqual([
      'toUserId',
    ]);
  });

  it('picks the channel/space/member kinds, never a bare text id', () => {
    expect(ARGUMENTS['channel.add_member']?.[0]?.kind).toBe('channel');
    expect(ARGUMENTS['channel.remove_member']?.[0]?.kind).toBe('channel');
    expect(ARGUMENTS['docs.grant_space_access']?.[0]?.kind).toBe('space');
    expect(ARGUMENTS['cards.bulk_reassign']?.[0]?.kind).toBe('member');
  });

  it('seeds a blank draft for every one of the six, with no field pre-filled', () => {
    expect(blankAction('channel.add_member').value).toEqual({
      type: 'channel.add_member',
      channelId: '',
    });
    expect(blankAction('channel.remove_member').value).toEqual({
      type: 'channel.remove_member',
      channelId: '',
    });
    expect(blankAction('docs.grant_space_access').value).toEqual({
      type: 'docs.grant_space_access',
      spaceId: '',
    });
    expect(blankAction('identity.revoke_sessions').value).toEqual({
      type: 'identity.revoke_sessions',
    });
    expect(blankAction('member_grant.revoke_all').value).toEqual({
      type: 'member_grant.revoke_all',
    });
    expect(blankAction('cards.bulk_reassign').value).toEqual({
      type: 'cards.bulk_reassign',
      toUserId: '',
    });
  });

  it('offers all six unconditionally — no deployment flag, unlike telephony', () => {
    const offered = offeredActions(false).map(([type]) => type);
    expect(offered).toContain('channel.add_member');
    expect(offered).toContain('channel.remove_member');
    expect(offered).toContain('docs.grant_space_access');
    expect(offered).toContain('identity.revoke_sessions');
    expect(offered).toContain('member_grant.revoke_all');
    expect(offered).toContain('cards.bulk_reassign');
  });

  it('keeps the space picker org-scoped, never demanding a project first', () => {
    /* A Docs space belongs to the org directly, not to a project — unlike
       list/status/label, `docs.grant_space_access` must never need a
       project chosen before its own picker can offer anything. */
    expect(needsProject('docs.grant_space_access')).toBe(false);
  });
});

describe('vocabulary invariants', () => {
  it('has an ARGUMENTS entry for every label, and a label for every argument entry', () => {
    /* Every entry in one table missing from the other is an action that is
       either unbuildable (no argument spec) or undisplayable (no label). */
    for (const type of Object.keys(ACTION_LABELS)) expect(ARGUMENTS[type]).toBeDefined();
    for (const type of Object.keys(ARGUMENTS)) expect(ACTION_LABELS[type]).toBeDefined();
  });

  it('lists exactly the two telephony actions as cost-bearing', () => {
    expect([...TELEPHONY_ACTIONS].sort()).toEqual(['call.place', 'sms.send']);
  });

  /* Wave 4 slice 4 (§7.6) — the outbound connector actions. */

  it('gives every `integration` argument a provider to filter its picker by', () => {
    /* The picker offers connectors of ONE provider, because the service refuses
       a Slack action pointed at a GitHub row. An action with an `integration`
       argument and no entry here would offer every connector the org has, and
       picking the wrong one builds a rule that saves and fails on every run. */
    for (const [type, specs] of Object.entries(ARGUMENTS)) {
      if (specs.some((spec) => spec.kind === 'integration')) {
        expect(INTEGRATION_PROVIDER_OF[type]).toBeDefined();
      }
    }
  });

  it('offers the connector actions unconditionally — they are not flag-gated', () => {
    /* Unlike telephony: these cost nothing and reach only a provider the org
       authorized itself, so the flag must not hide them. */
    const offered = offeredActions(false).map(([type]) => type);
    expect(offered).toContain('slack.post_message');
    expect(offered).toContain('github.create_issue');
  });

  it('names no repository on the GitHub action', () => {
    /* The repo is the connector row's own scope, resolved server-side. An
       argument for it would let one connector open issues on any repository
       its token happens to reach. */
    const fields = (ARGUMENTS['github.create_issue'] ?? []).map((spec) => spec.field);
    expect(fields).toEqual(['integrationId', 'title', 'body']);
  });
});
