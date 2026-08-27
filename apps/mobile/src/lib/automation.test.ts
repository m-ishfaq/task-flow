import { describe, expect, it } from 'vitest';
import {
  actionOutcomeOf,
  actionsComplete,
  blankAction,
  canEditOnMobile,
  describeAction,
  draftsFrom,
  explainReason,
  explainStatus,
  needsProject,
  offeredActions,
  statusColor,
  triggerLabel,
} from './automation.js';

describe('triggerLabel', () => {
  it('translates a known event to its label', () => {
    expect(triggerLabel('card.moved')).toBe('A card is moved to another list');
  });

  it('falls back to the raw event name for one it does not recognize', () => {
    expect(triggerLabel('some.future_event')).toBe('some.future_event');
  });
});

describe('describeAction', () => {
  it('describes a plain action by its label alone', () => {
    expect(describeAction({ type: 'card.set_priority', priority: 'high' })).toBe(
      "Set the card's priority",
    );
  });

  it('quotes a chat message body rather than showing an id', () => {
    expect(describeAction({ type: 'chat.post_message', channelId: 'abc', body: 'Ship it' })).toBe(
      'Post a chat message: "Ship it"',
    );
  });

  it('truncates a long body to 40 characters', () => {
    const body = 'x'.repeat(80);
    const result = describeAction({ type: 'card.add_comment', body });
    expect(result).toBe(`Add a comment to the card: "${'x'.repeat(39)}…"`);
  });

  it('includes the channel for a Slack action when present', () => {
    expect(
      describeAction({
        type: 'slack.post_message',
        integrationId: 'x',
        channel: '#general',
        text: 'hi',
      }),
    ).toBe('Post a Slack message to #general: "hi"');
  });

  it('falls back to the raw type for an unrecognized action', () => {
    expect(describeAction({ type: 'future.action' })).toBe('future.action');
  });

  it('returns a generic message for a non-object action', () => {
    expect(describeAction(null)).toBe('unrecognized action');
    expect(describeAction('nope')).toBe('unrecognized action');
  });
});

describe('explainReason', () => {
  it('translates a known machine code', () => {
    expect(explainReason('condition_not_met')).toBe('the condition did not match, so nothing ran');
  });

  it('falls back to the raw code for one it does not recognize', () => {
    expect(explainReason('some_future_code')).toBe('some_future_code');
  });
});

describe('explainStatus', () => {
  it('translates a known status', () => {
    expect(explainStatus('succeeded')).toBe('ran successfully');
  });

  it('falls back to the raw status for one it does not recognize', () => {
    expect(explainStatus('unknown_status')).toBe('unknown_status');
  });
});

describe('statusColor', () => {
  it('returns a distinct color per known status', () => {
    const colors = new Set(
      ['succeeded', 'failed', 'refused', 'skipped'].map((status) => statusColor(status)),
    );
    expect(colors.size).toBe(4);
  });
});

describe('offeredActions', () => {
  it('excludes call_webhook, slack.post_message and github.create_issue always', () => {
    const types = offeredActions(true).map(([type]) => type);
    expect(types).not.toContain('call_webhook');
    expect(types).not.toContain('slack.post_message');
    expect(types).not.toContain('github.create_issue');
  });

  it('excludes the telephony actions when the flag is off', () => {
    const types = offeredActions(false).map(([type]) => type);
    expect(types).not.toContain('call.place');
    expect(types).not.toContain('sms.send');
  });

  it('includes the telephony actions when the flag is on', () => {
    const types = offeredActions(true).map(([type]) => type);
    expect(types).toContain('call.place');
    expect(types).toContain('sms.send');
  });

  it('includes every card and chat action regardless of the flag', () => {
    const types = offeredActions(false).map(([type]) => type);
    expect(types).toEqual(
      expect.arrayContaining([
        'card.move',
        'card.set_status',
        'card.set_priority',
        'card.assign',
        'card.add_label',
        'card.remove_label',
        'card.unassign',
        'card.add_comment',
        'chat.post_message',
      ]),
    );
  });
});

describe('needsProject', () => {
  it('is true for the list/status/label actions', () => {
    expect(needsProject('card.move')).toBe(true);
    expect(needsProject('card.set_status')).toBe(true);
    expect(needsProject('card.add_label')).toBe(true);
  });

  it('is false for actions with no project-scoped argument', () => {
    expect(needsProject('card.assign')).toBe(false);
    expect(needsProject('card.add_comment')).toBe(false);
  });
});

describe('blankAction', () => {
  it('builds an empty draft matching the requested type', () => {
    expect(blankAction('card.assign', 'k1')).toEqual({
      key: 'k1',
      value: { type: 'card.assign', userId: '' },
    });
  });

  it('builds a multi-field draft for chat.post_message', () => {
    expect(blankAction('chat.post_message', 'k2')).toEqual({
      key: 'k2',
      value: { type: 'chat.post_message', channelId: '', body: '' },
    });
  });

  it('falls back to card.set_priority for an unrecognized type', () => {
    expect(blankAction('future.action', 'k3')).toEqual({
      key: 'k3',
      value: { type: 'card.set_priority', priority: 'high' },
    });
  });
});

describe('actionsComplete', () => {
  it('is true once every required field is filled in', () => {
    expect(actionsComplete([{ key: 'a', value: { type: 'card.assign', userId: 'u1' } }])).toBe(
      true,
    );
  });

  it('is false while a required field is empty', () => {
    expect(actionsComplete([{ key: 'a', value: { type: 'card.assign', userId: '' } }])).toBe(false);
  });

  it('is true for an empty list of actions', () => {
    expect(actionsComplete([])).toBe(true);
  });
});

describe('draftsFrom', () => {
  it('rebuilds a draft per stored action, narrowing each field from unknown', () => {
    const drafts = draftsFrom([
      { type: 'card.assign', userId: 'u1' },
      { type: 'chat.post_message', channelId: 'c1', body: 'hi' },
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.value).toEqual({ type: 'card.assign', userId: 'u1' });
    expect(drafts[1]?.value).toEqual({ type: 'chat.post_message', channelId: 'c1', body: 'hi' });
  });

  it('degrades a malformed row to an empty field rather than throwing', () => {
    const drafts = draftsFrom([{ type: 'card.assign', userId: 42 }]);
    expect(drafts[0]?.value).toEqual({ type: 'card.assign', userId: '' });
  });

  it('assigns stable, distinct keys by position', () => {
    const drafts = draftsFrom([
      { type: 'card.add_comment', body: 'one' },
      { type: 'card.add_comment', body: 'two' },
    ]);
    expect(drafts[0]?.key).not.toBe(drafts[1]?.key);
  });
});

describe('canEditOnMobile', () => {
  it('is true for a condition-less rule using only editable action types', () => {
    expect(
      canEditOnMobile({
        condition: null,
        actions: [{ type: 'card.assign', userId: 'u1' }],
      }),
    ).toBe(true);
  });

  it('is false when the rule has a condition', () => {
    expect(
      canEditOnMobile({
        condition: { op: 'and', clauses: [] },
        actions: [{ type: 'card.assign', userId: 'u1' }],
      }),
    ).toBe(false);
  });

  it('is false when any action has no picker on this platform', () => {
    expect(
      canEditOnMobile({
        condition: null,
        actions: [
          { type: 'card.assign', userId: 'u1' },
          { type: 'call_webhook', webhookId: 'w1' },
        ],
      }),
    ).toBe(false);
  });
});

describe('actionOutcomeOf', () => {
  it('reads a succeeded outcome', () => {
    expect(actionOutcomeOf({ type: 'card.move', status: 'succeeded' })).toEqual({
      label: 'Move the card to a list',
      failed: false,
      error: null,
    });
  });

  it('reads a failed outcome with its error', () => {
    expect(
      actionOutcomeOf({ type: 'card.move', status: 'failed', error: 'list not found' }),
    ).toEqual({
      label: 'Move the card to a list',
      failed: true,
      error: 'list not found',
    });
  });

  it('returns null for a non-object result', () => {
    expect(actionOutcomeOf(null)).toBeNull();
  });
});
