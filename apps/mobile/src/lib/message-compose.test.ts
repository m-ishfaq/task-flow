import { describe, expect, it } from 'vitest';
import { activeMentionQuery, buildMessageBody, insertMention } from './message-compose.js';

describe('buildMessageBody', () => {
  it('with no mentions, produces a single plain text run', () => {
    expect(buildMessageBody('hello world', [])).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    });
  });

  it('replaces a marker in the middle with a mention node, keeping text on both sides', () => {
    const body = buildMessageBody('hey @Jane Doe can you look at this', [
      { userId: 'u1', label: 'Jane Doe' },
    ]);
    expect(body.content[0].content).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
      { type: 'text', text: ' can you look at this' },
    ]);
  });

  it('a message that is ONLY a mention has no leading/trailing empty text node', () => {
    const body = buildMessageBody('@Jane Doe', [{ userId: 'u1', label: 'Jane Doe' }]);
    expect(body.content[0].content).toEqual([
      { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
    ]);
  });

  it('replaces every occurrence of the same mention marker', () => {
    const body = buildMessageBody('@Jane Doe and @Jane Doe again', [
      { userId: 'u1', label: 'Jane Doe' },
    ]);
    expect(body.content[0].content).toEqual([
      { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
      { type: 'text', text: ' and ' },
      { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
      { type: 'text', text: ' again' },
    ]);
  });

  it('resolves markers left-to-right regardless of the mentions array order', () => {
    const body = buildMessageBody('@Bob then @Alice', [
      { userId: 'u-alice', label: 'Alice' },
      { userId: 'u-bob', label: 'Bob' },
    ]);
    expect(body.content[0].content).toEqual([
      { type: 'mention', attrs: { userId: 'u-bob', label: 'Bob' } },
      { type: 'text', text: ' then ' },
      { type: 'mention', attrs: { userId: 'u-alice', label: 'Alice' } },
    ]);
  });

  it('a pending mention whose marker text no longer appears verbatim degrades to plain text', () => {
    // The user edited "@Jane Doe" down to "@Jane" after picking her.
    const body = buildMessageBody('hey @Jane', [{ userId: 'u1', label: 'Jane Doe' }]);
    expect(body.content[0].content).toEqual([{ type: 'text', text: 'hey @Jane' }]);
  });

  it('an empty draft with no mentions still produces one (empty) text segment, never zero segments', () => {
    expect(buildMessageBody('', [])).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
    });
  });
});

describe('activeMentionQuery', () => {
  it('returns null when there is no @ at all', () => {
    expect(activeMentionQuery('hello world')).toBeNull();
  });

  it('returns the text after a trailing @', () => {
    expect(activeMentionQuery('hey @ja')).toBe('ja');
  });

  it('returns an empty string right after typing a bare @', () => {
    expect(activeMentionQuery('hey @')).toBe('');
  });

  it('returns null once whitespace follows the @ — the query already ended', () => {
    expect(activeMentionQuery('hey @jane doe, could you')).toBeNull();
  });

  it('uses the LAST @, not the first, when the draft already contains one', () => {
    expect(activeMentionQuery('cc @jane about @bo')).toBe('bo');
  });
});

describe('insertMention', () => {
  it('replaces the trailing @query with the picked label plus a trailing space', () => {
    expect(insertMention('hey @ja', { userId: 'u1', label: 'Jane Doe' })).toEqual({
      draft: 'hey @Jane Doe ',
      mention: { userId: 'u1', label: 'Jane Doe' },
    });
  });

  it('preserves text before an earlier, already-finished @mention', () => {
    expect(insertMention('cc @jane about @bo', { userId: 'u2', label: 'Bob' })).toEqual({
      draft: 'cc @jane about @Bob ',
      mention: { userId: 'u2', label: 'Bob' },
    });
  });
});
