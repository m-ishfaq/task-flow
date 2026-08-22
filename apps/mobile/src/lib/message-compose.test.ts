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
  it('returns null when there is no @ before the cursor at all', () => {
    expect(activeMentionQuery('hello world', 11)).toBeNull();
  });

  it('returns the query for a trailing @, cursor at the end of the draft', () => {
    expect(activeMentionQuery('hey @ja', 7)).toEqual({ query: 'ja', start: 4, end: 7 });
  });

  it('returns an empty query right after typing a bare @', () => {
    expect(activeMentionQuery('hey @', 5)).toEqual({ query: '', start: 4, end: 5 });
  });

  it('returns null once whitespace follows the @ before the cursor — the query already ended', () => {
    expect(activeMentionQuery('hey @jane doe, could you', 24)).toBeNull();
  });

  it('uses the @ NEAREST the cursor, not the first one in the draft', () => {
    expect(activeMentionQuery('cc @jane about @bo', 19)).toEqual({
      query: 'bo',
      start: 15,
      end: 19,
    });
  });

  it('triggers mid-string: cursor right after an @ typed in the MIDDLE of existing text', () => {
    // "hey @ja| world" — the cursor (|) sits right after "ja", with " world"
    // still ahead of it. This is the whole point of the cursor-based
    // rewrite: a trailing-only implementation could never see this at all,
    // since `draft` here has no @ anywhere near its end.
    const draft = 'hey @ja world';
    const cursor = 'hey @ja'.length;
    expect(activeMentionQuery(draft, cursor)).toEqual({ query: 'ja', start: 4, end: 7 });
  });

  it('returns null when the cursor sits BEFORE an @ that appears later in the draft', () => {
    // "he|y @jane" — the cursor (|) is on the left of the @ entirely, so
    // nothing has been typed toward a mention from the cursor's own
    // point of view yet.
    expect(activeMentionQuery('hey @jane', 2)).toBeNull();
  });

  it('returns null when the cursor has moved past the query onto later text', () => {
    // "hey @jane |doe" — the cursor sits after the space that ended the
    // "jane" query, having moved on to typing "doe" next.
    const draft = 'hey @jane doe';
    const cursor = 'hey @jane '.length;
    expect(activeMentionQuery(draft, cursor)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces a trailing @query with the picked label plus a trailing space, cursor at the new end', () => {
    const active = activeMentionQuery('hey @ja', 7);
    expect(active).not.toBeNull();
    expect(insertMention('hey @ja', active!, { userId: 'u1', label: 'Jane Doe' })).toEqual({
      draft: 'hey @Jane Doe ',
      mention: { userId: 'u1', label: 'Jane Doe' },
      cursor: 'hey @Jane Doe '.length,
    });
  });

  it('preserves text before an earlier, already-finished @mention', () => {
    const active = activeMentionQuery('cc @jane about @bo', 19);
    expect(active).not.toBeNull();
    expect(insertMention('cc @jane about @bo', active!, { userId: 'u2', label: 'Bob' })).toEqual({
      draft: 'cc @jane about @Bob ',
      mention: { userId: 'u2', label: 'Bob' },
      cursor: 'cc @jane about @Bob '.length,
    });
  });

  it('replaces a MID-STRING @query, keeping the text after the cursor untouched and reporting a mid-string cursor', () => {
    const draft = 'hey @ja world';
    const cursor = 'hey @ja'.length;
    const active = activeMentionQuery(draft, cursor);
    expect(active).not.toBeNull();
    const result = insertMention(draft, active!, { userId: 'u1', label: 'Jane Doe' });
    expect(result.draft).toBe('hey @Jane Doe  world');
    expect(result.mention).toEqual({ userId: 'u1', label: 'Jane Doe' });
    // The cursor belongs right after the inserted "@Jane Doe ", not at the
    // end of the whole string — "world" is still ahead of it.
    expect(result.cursor).toBe('hey @Jane Doe '.length);
    expect(result.draft.slice(0, result.cursor)).toBe('hey @Jane Doe ');
  });
});
