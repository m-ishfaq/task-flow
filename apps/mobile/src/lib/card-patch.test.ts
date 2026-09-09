import { describe, expect, it } from 'vitest';
import { asRichText, mergePatch, type RichText } from './card-patch.js';
import type { CardDetail } from './work.js';

const doc: RichText = { type: 'doc', content: [{ type: 'paragraph', text: 'hello' }] };

const card: CardDetail = {
  cardId: 'card_1',
  listId: 'list_1',
  boardId: 'board_1',
  projectId: 'project_1',
  reference: 'WEB-1',
  title: 'Original title',
  description: doc,
  rank: '0|hzzzzz:',
  assigneeIds: [],
  statusId: null,
  priority: 'normal',
  dueDate: '2026-09-01T00:00:00.000Z',
  startDate: null,
  sprintId: null,
  commentCount: 0,
  checklistDone: 0,
  checklistTotal: 0,
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  capabilities: {
    moderateComments: false,
    comment: true,
    update: true,
    archive: true,
    manageProjectVocabulary: true,
  },
};

describe('asRichText', () => {
  it('accepts a document-shaped value', () => {
    expect(asRichText(doc)).toEqual(doc);
  });

  it('rejects null, non-objects, and objects with no string type', () => {
    expect(asRichText(null)).toBeNull();
    expect(asRichText('a string')).toBeNull();
    expect(asRichText({})).toBeNull();
    expect(asRichText({ type: 42 })).toBeNull();
  });
});

describe('mergePatch', () => {
  it('forwards every untouched field from the current card unchanged', () => {
    expect(mergePatch(card, {})).toEqual({
      title: 'Original title',
      description: doc,
      dueDate: '2026-09-01T00:00:00.000Z',
      startDate: null,
      priority: 'normal',
    });
  });

  it('applies only the fields named in the patch', () => {
    const result = mergePatch(card, { title: 'New title' });
    expect(result.title).toBe('New title');
    expect(result.priority).toBe('normal');
    expect(result.dueDate).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a key present with value null CLEARS that field, distinct from the key being absent', () => {
    expect(mergePatch(card, { priority: null }).priority).toBeNull();
    // Confirms the two are genuinely distinguishable, not just both falsy —
    // the omitted-key case above already asserted `'normal'` survives.
    expect(mergePatch(card, {}).priority).toBe('normal');
  });

  it('clears dueDate and startDate the same way', () => {
    expect(mergePatch(card, { dueDate: null }).dueDate).toBeNull();
    expect(
      mergePatch({ ...card, startDate: '2026-01-01T00:00:00.000Z' }, { startDate: null }).startDate,
    ).toBeNull();
  });

  it('an untouched description round-trips via asRichText rather than forwarding raw unknown', () => {
    const malformed = { ...card, description: 'not a document' };
    expect(mergePatch(malformed, {}).description).toBeNull();
  });

  it('a patched description is used as given, including explicit null to clear it', () => {
    const newDoc: RichText = { type: 'doc', content: [] };
    expect(mergePatch(card, { description: newDoc }).description).toEqual(newDoc);
    expect(mergePatch(card, { description: null }).description).toBeNull();
  });
});
