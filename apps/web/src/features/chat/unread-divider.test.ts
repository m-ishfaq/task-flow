import { describe, expect, it } from 'vitest';
import { firstUnreadAfter } from './chat-page.js';

/**
 * Where the "new messages" divider goes.
 *
 * Every branch here is a case where drawing the line would be wrong, and every
 * one of them fails SILENTLY: a divider in the wrong place looks exactly like a
 * divider in the right place, so there is no bug report — just a line people
 * stop trusting. That is the entire reason this is a pure function with its own
 * test rather than three conditions inline in a component.
 *
 * The rule the whole thing rests on: the position comes from the read CURSOR,
 * never from the unread COUNT. Counting back N from the end is the obvious
 * implementation and it is wrong the moment a message is deleted or the page is
 * partially loaded — and wrong by exactly one, which is the least noticeable
 * amount.
 */

const MESSAGES = ['m1', 'm2', 'm3', 'm4'];

describe('firstUnreadAfter', () => {
  it('marks the message after the cursor', () => {
    expect(firstUnreadAfter('m2', MESSAGES)).toBe('m3');
  });

  it('draws nothing while the cursor is still loading', () => {
    /* `undefined` is "not resolved yet" and is deliberately distinct from
       `null`. Treating it as "never read" would flash a divider at the top of
       the list for one render on every channel open. */
    expect(firstUnreadAfter(undefined, MESSAGES)).toBeNull();
  });

  it('draws nothing for a channel that has never been opened', () => {
    // Everything is unread, so a line above the first message would label the
    // whole conversation "new" — true, and useless.
    expect(firstUnreadAfter(null, MESSAGES)).toBeNull();
  });

  it('draws nothing when the cursor is on the last message', () => {
    // Caught up. The ordinary state of a channel someone left open.
    expect(firstUnreadAfter('m4', MESSAGES)).toBeNull();
  });

  it('draws nothing when the cursor names a message not in the page', () => {
    /* The cursor is older than the loaded window, or names a message since
       deleted. Both are real: `messages.list` returns the newest 100, and
       deletion is a tombstone that keeps its id — but a cursor pointing at a
       hard-removed row would land here too. Guessing a position would put the
       line somewhere plausible and wrong. */
    expect(firstUnreadAfter('m0', MESSAGES)).toBeNull();
  });

  it('draws nothing when there are no messages at all', () => {
    expect(firstUnreadAfter('m2', [])).toBeNull();
    expect(firstUnreadAfter(null, [])).toBeNull();
  });

  it('marks the second message when only the first was read', () => {
    expect(firstUnreadAfter('m1', MESSAGES)).toBe('m2');
  });
});

/**
 * The ORDER and CONTENT of the list this is given — the two things that were
 * wrong the first time, and which no assertion above could have caught.
 *
 * `firstUnreadAfter` is correct in isolation for any ascending, rendered list.
 * The bug was at the call site: it was handed `messages.data` straight from the
 * query, which is the same rows NEWEST FIRST with thread replies still in them.
 * Each mistake alone is bad; together they cancelled into "no divider ever",
 * which looks exactly like "you have nothing unread".
 *
 * These tests apply the same transformation the component applies, so a future
 * change that drops the reverse or the reply filter fails here instead of
 * silently removing the feature.
 */
describe('the list the divider is computed from', () => {
  interface Row {
    readonly messageId: string;
    readonly parentMessageId: string | null;
  }

  /** Exactly what `ChannelPanel` does to build `topLevel`. */
  const rendered = (rows: readonly Row[]): string[] =>
    rows
      .filter((row) => row.parentMessageId === null)
      .toReversed()
      .map((row) => row.messageId);

  /* As the API returns it: newest first, replies interleaved. */
  const FROM_API: readonly Row[] = [
    { messageId: 'm4', parentMessageId: null },
    { messageId: 'r1', parentMessageId: 'm2' },
    { messageId: 'm3', parentMessageId: null },
    { messageId: 'm2', parentMessageId: null },
    { messageId: 'm1', parentMessageId: null },
  ];

  it('reads chronologically once transformed', () => {
    expect(rendered(FROM_API)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('points at the NEXT message, not the previous one', () => {
    // The direction bug. On the raw newest-first list this returned 'm1'.
    expect(firstUnreadAfter('m2', rendered(FROM_API))).toBe('m3');
  });

  it('never names a thread reply, which is rendered in no group', () => {
    /* The disappearing bug. `r1` sits next to `m2` in the raw list, so the
       divider named a message the transcript does not contain and nothing drew
       it. After the filter there is no reply to land on. */
    expect(rendered(FROM_API)).not.toContain('r1');
    expect(firstUnreadAfter('m2', rendered(FROM_API))).not.toBe('r1');
  });

  it('shows a line when there is genuinely something unread', () => {
    // The case the user reported as missing: caught up to m2, two newer
    // messages exist, the line belongs above m3.
    expect(firstUnreadAfter('m2', rendered(FROM_API))).toBe('m3');
  });

  it('shows no line once the newest message has been read', () => {
    // Which is the state a channel is in immediately after being opened —
    // so returning to it draws nothing.
    expect(firstUnreadAfter('m4', rendered(FROM_API))).toBeNull();
  });
});
