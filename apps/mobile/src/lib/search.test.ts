import { describe, expect, it } from 'vitest';
import { hitTitle, withFacet, type SearchHit } from './search.js';

function hit(overrides: Partial<SearchHit> & Pick<SearchHit, 'type' | 'entityId'>): SearchHit {
  return {
    title: null,
    snippet: null,
    authorId: null,
    updatedAt: '2026-08-24T00:00:00.000Z',
    archived: false,
    metadata: { channel_id: 'chan_1' },
    contextLabel: null,
    score: 1,
    ...overrides,
  };
}

describe('withFacet', () => {
  it('leaves the query untouched for "all"', () => {
    expect(withFacet('deploy outage', 'all')).toBe('deploy outage');
  });

  it('appends the type clause to a non-empty query', () => {
    expect(withFacet('deploy outage', 'card')).toBe('deploy outage AND type = card');
  });

  it('appends only the type clause to an empty query', () => {
    expect(withFacet('', 'message')).toBe('type = message');
  });

  it('trims surrounding whitespace before deciding whether the query is empty', () => {
    expect(withFacet('   ', 'page')).toBe('type = page');
  });
});

describe('hitTitle', () => {
  it('returns the real title when present', () => {
    expect(hitTitle(hit({ type: 'card', entityId: 'card_1', title: 'Fix the outage' }))).toBe(
      'Fix the outage',
    );
  });

  it('falls back to "<Kind> · <id>" when title is null', () => {
    expect(hitTitle(hit({ type: 'card', entityId: 'card_1', title: null }))).toBe('Card · card_1');
  });

  it('uses the right label per hit kind', () => {
    expect(hitTitle(hit({ type: 'transcript', entityId: 'rec_1', title: null }))).toBe(
      'Transcript · rec_1',
    );
  });
});
