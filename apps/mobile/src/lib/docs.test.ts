import { describe, expect, it } from 'vitest';
import { buildPageTree, descendantIdsOf, type Page } from './docs.js';

function page(overrides: Partial<Page> & Pick<Page, 'pageId' | 'parentPageId' | 'rank'>): Page {
  return {
    title: 'Untitled',
    archivedAt: null,
    publishedAt: null,
    capabilities: { archive: true },
    ...overrides,
  };
}

describe('buildPageTree', () => {
  it('orders top-level pages by rank', () => {
    const pages = [
      page({ pageId: 'b', parentPageId: null, rank: '1B' }),
      page({ pageId: 'a', parentPageId: null, rank: '1A' }),
    ];
    const rows = buildPageTree(pages);
    expect(rows.map((row) => row.page.pageId)).toEqual(['a', 'b']);
  });

  it('nests children directly under their parent, depth-first', () => {
    const pages = [
      page({ pageId: 'parent', parentPageId: null, rank: '1A' }),
      page({ pageId: 'child', parentPageId: 'parent', rank: '1A' }),
      page({ pageId: 'sibling', parentPageId: null, rank: '1B' }),
    ];
    const rows = buildPageTree(pages);
    expect(rows.map((row) => [row.page.pageId, row.depth])).toEqual([
      ['parent', 0],
      ['child', 1],
      ['sibling', 0],
    ]);
  });

  it('nests grandchildren at depth 2', () => {
    const pages = [
      page({ pageId: 'a', parentPageId: null, rank: '1A' }),
      page({ pageId: 'b', parentPageId: 'a', rank: '1A' }),
      page({ pageId: 'c', parentPageId: 'b', rank: '1A' }),
    ];
    const rows = buildPageTree(pages);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
  });

  it('returns an empty list for no pages', () => {
    expect(buildPageTree([])).toEqual([]);
  });
});

describe('descendantIdsOf', () => {
  it('includes direct children', () => {
    const pages = [
      page({ pageId: 'a', parentPageId: null, rank: '1A' }),
      page({ pageId: 'b', parentPageId: 'a', rank: '1A' }),
    ];
    expect(descendantIdsOf(pages, 'a')).toEqual(new Set(['b']));
  });

  it('includes grandchildren, not just direct children', () => {
    const pages = [
      page({ pageId: 'a', parentPageId: null, rank: '1A' }),
      page({ pageId: 'b', parentPageId: 'a', rank: '1A' }),
      page({ pageId: 'c', parentPageId: 'b', rank: '1A' }),
    ];
    expect(descendantIdsOf(pages, 'a')).toEqual(new Set(['b', 'c']));
  });

  it('excludes the page itself and unrelated pages', () => {
    const pages = [
      page({ pageId: 'a', parentPageId: null, rank: '1A' }),
      page({ pageId: 'b', parentPageId: null, rank: '1B' }),
    ];
    expect(descendantIdsOf(pages, 'a')).toEqual(new Set());
  });

  it('is empty for a leaf page', () => {
    const pages = [
      page({ pageId: 'a', parentPageId: null, rank: '1A' }),
      page({ pageId: 'b', parentPageId: 'a', rank: '1A' }),
    ];
    expect(descendantIdsOf(pages, 'b')).toEqual(new Set());
  });
});
