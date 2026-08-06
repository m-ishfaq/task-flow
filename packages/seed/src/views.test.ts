import { describe, expect, it } from 'vitest';
import { ME, validate } from '@taskflow/filter';
import { VIEW_TEMPLATES, templateFilters, type FilterContext } from './modules/work.views.js';

/**
 * Saved-view templates, held to the same rule the corpus documents are: a
 * generator that produces something the API would REJECT is not a smaller bug
 * than one producing bad names.
 *
 * The check that matters is `validate('card', node)` — the exact function
 * `view.service.ts` calls on write AND on read. A stored tree that fails it is
 * not cosmetic: the service flags the view `filterBroken`, the board falls back
 * to unfiltered, and the tab looks like it works while showing the wrong rows.
 *
 * The rest are the CHECK constraints from migration 0014, asked of the templates
 * so a bad edit fails here rather than halfway through a seed run with an error
 * naming an index.
 */

const CONTEXT: FilterContext = {
  labelIds: ['019fd599-61a4-75b4-80ce-3885f779703e', '019fd599-61a4-7f6d-ab2e-4e2c37bb8028'],
  listIds: ['019fd599-628f-70d1-b323-ee7d88ce49cf'],
  overdueBefore: '2026-08-06T00:00:00.000Z',
  quarterEnd: '2026-11-04T00:00:00.000Z',
};

describe('view templates', () => {
  it('every filter validates against the real card field set', () => {
    for (const [index, filter] of templateFilters(CONTEXT).entries()) {
      if (filter === null) continue;
      const result = validate('card', filter);
      expect(result.errors, VIEW_TEMPLATES[index]?.name).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('keeps @me symbolic rather than resolving it to a user id', () => {
    /* The whole reason §10.2 defers `@me` to compile time: a shared "assigned
       to me" view whose filter carries a real id means "assigned to whoever
       saved it" — silently, and only for everybody else. */
    const raw = JSON.stringify(templateFilters(CONTEXT));
    expect(raw).toContain(ME);

    const meTemplate = VIEW_TEMPLATES.find((template) => template.name === 'My open tasks');
    expect(meTemplate?.shared).toBe(true);
  });

  it('covers the filter shapes that have historically been wrong', () => {
    // `label` was declared `uuid` and broke in BOTH backends at once, with no
    // test (CLAUDE.md). These are the shapes that exercise the fixed version.
    const raw = JSON.stringify(templateFilters(CONTEXT));

    expect(raw).toContain('"not"'); // negated label filter — the COALESCE case
    expect(raw).toContain('is_empty'); // array_agg NULL, and a null due date
    expect(raw).toContain('"or"'); // a disjunction, so the tree walk has depth
    expect(raw).toContain('"label"');
    expect(raw).toContain('"archived"'); // the computed boolean, not a timestamp
  });

  it('degrades the label filter to null when a project has no labels', () => {
    // A filter naming a label id that does not exist renders an empty board and
    // reads as a bug. Returning null makes it an unfiltered view instead.
    const withoutLabels = templateFilters({ ...CONTEXT, labelIds: [] });
    const index = VIEW_TEMPLATES.findIndex((template) => template.name.startsWith('Excluding'));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(withoutLabels[index]).toBeNull();
  });
});

describe('view templates against migration 0014 constraints', () => {
  it('every name is present and within 60 characters', () => {
    for (const template of VIEW_TEMPLATES) {
      expect(template.name.trim().length).toBeGreaterThan(0);
      expect(template.name.length).toBeLessThanOrEqual(60);
    }
  });

  it('every type, groupBy and sortBy is a value the CHECK accepts', () => {
    for (const template of VIEW_TEMPLATES) {
      expect(['board', 'table', 'list']).toContain(template.type);
      if (template.groupBy !== null) {
        expect(['list', 'status', 'assignee', 'priority', 'due']).toContain(template.groupBy);
      }
      if (template.sortBy !== null) {
        // `manual` is the board's own rank order and the toolbar's default —
        // not a synonym for "unsorted", and not spelled `rank`.
        expect(['manual', 'title', 'due', 'priority']).toContain(template.sortBy);
      }
    }
  });

  it('shared names are distinct, and private names are distinct', () => {
    /* Two partial unique indexes: shared names unique per board, private names
       unique per board PER AUTHOR. A board takes the first N templates, so a
       duplicate within either group is a run that fails on an index. */
    const shared = VIEW_TEMPLATES.filter((t) => t.shared).map((t) => t.name.toLowerCase());
    const priv = VIEW_TEMPLATES.filter((t) => !t.shared).map((t) => t.name.toLowerCase());

    expect(new Set(shared).size).toBe(shared.length);
    expect(new Set(priv).size).toBe(priv.length);
  });

  it('deliberately reuses one name across the shared/private boundary', () => {
    // Legal, because the two indexes are separate — and the only way to see
    // that the tab strip keeps a personal bookmark apart from a board tab of
    // the same name.
    const shared = new Set(VIEW_TEMPLATES.filter((t) => t.shared).map((t) => t.name));
    const collisions = VIEW_TEMPLATES.filter((t) => !t.shared && shared.has(t.name));
    expect(collisions.length).toBeGreaterThan(0);
  });

  it('has at least one private template and one unfiltered one', () => {
    expect(VIEW_TEMPLATES.some((template) => !template.shared)).toBe(true);
    // The migration is explicit that a saved ARRANGEMENT with no filter is a
    // real thing, and must not look accidentally configured.
    expect(VIEW_TEMPLATES.some((template) => template.filter === null)).toBe(true);
  });
});
