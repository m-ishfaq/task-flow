import { describe, expect, it } from 'vitest';
import {
  actionOutcomeOf,
  describeAction,
  explainReason,
  explainStatus,
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
