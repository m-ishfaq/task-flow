import { describe, expect, it } from 'vitest';
import { RichTextDocument } from '@taskflow/api/richtext';
import { createRng } from './rng.js';
import {
  cardTitle,
  checklistItemText,
  checklistName,
  commentDocument,
  customFields,
  descriptionDocument,
  emailLocalPart,
  flatten,
  LABEL_PALETTE,
  people,
  STATUS_SET,
} from './corpus.js';

/**
 * The one rule that is not cosmetic (corpus.ts's own header): rich text is
 * validated against a CLOSED, `.strict()` schema, and TipTap emits attributes
 * the server refuses on purpose. A generator that produces a document the API
 * would reject is not a smaller bug than one that produces bad names — it is
 * a seeded database nothing can subsequently save.
 *
 * So every document builder here is checked against the real
 * `RichTextDocument` from `apps/api/src/work/richtext.ts`, not a shape this
 * package invented to resemble it.
 */

const SAMPLE_SIZE = 300;

describe('descriptionDocument', () => {
  it('always parses as a valid RichTextDocument', () => {
    const rng = createRng('description-corpus');
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const document = descriptionDocument(rng);
      expect(() => RichTextDocument.parse(document)).not.toThrow();
    }
  });

  it('varies its shape rather than always producing a single paragraph', () => {
    const rng = createRng('description-variety');
    const shapes = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const document = descriptionDocument(rng);
      shapes.add(document.content?.map((node) => node.type).join(',') ?? '');
    }
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('emits a link mark with no rel or class attribute', () => {
    // `richtext.ts` excludes `rel` and `class` deliberately — a document that
    // could set `rel` could opt itself out of `noopener` (corpus.ts's own
    // header). Checked on the serialized form rather than by narrowing
    // `RichTextNode.marks`, which is typed `unknown[]` on purpose (it is not
    // the validation; `RichTextDocument` is).
    const rng = createRng('description-link-hunt');
    let sawLink = false;

    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const raw = JSON.stringify(descriptionDocument(rng));
      if (!raw.includes('"link"')) continue;
      sawLink = true;
      expect(raw).not.toMatch(/"rel"|"class"/);
    }

    expect(sawLink).toBe(true);
  });
});

describe('commentDocument', () => {
  it('always parses as a valid RichTextDocument', () => {
    const rng = createRng('comment-corpus');
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const document = commentDocument(rng);
      expect(() => RichTextDocument.parse(document)).not.toThrow();
    }
  });
});

describe('flatten', () => {
  it('produces non-empty, tag-free text for every generated document', () => {
    const rng = createRng('flatten-corpus');
    for (let i = 0; i < 50; i += 1) {
      const text = flatten(descriptionDocument(rng));
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[<>]/);
    }
  });
});

describe('people', () => {
  it('produces the requested count, all distinct', () => {
    const rng = createRng('people-count');
    const names = people(rng, 60);
    expect(names).toHaveLength(60);
    expect(new Set(names.map((n) => n.full)).size).toBe(60);
  });

  it('throws rather than looping forever when the pool cannot cover the count', () => {
    // 60 first names x 60 last names caps distinct full names well under
    // 4,000 — comfortably past the pool's capacity without the 40-attempts-
    // per-name bound (corpus.ts) taking long enough to matter.
    const rng = createRng('people-exhaust');
    expect(() => people(rng, 4_000)).toThrow();
  });
});

describe('emailLocalPart', () => {
  it('strips diacritics and non-ASCII characters, keeping the base letters', () => {
    const local = emailLocalPart({ first: 'Zoë', last: 'Björk', full: 'Zoë Björk' });
    expect(local).toBe('zoe.bjork');
    expect(local).toMatch(/^[a-z0-9.]+$/);
  });
});

describe('STATUS_SET', () => {
  it('has exactly one default status', () => {
    expect(STATUS_SET.filter((status) => status.isDefault)).toHaveLength(1);
  });

  it('every color is a lowercase hex triplet', () => {
    for (const status of STATUS_SET) {
      expect(status.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('LABEL_PALETTE', () => {
  it('every color is a lowercase hex triplet, matching labels_color_format', () => {
    for (const label of LABEL_PALETTE) {
      expect(label.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has no duplicate names', () => {
    const names = LABEL_PALETTE.map((label) => label.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('customFields', () => {
  it('"all-types" is a superset of "standard", covering every CUSTOM_FIELD_TYPES entry', () => {
    const standard = customFields('standard');
    const allTypes = customFields('all-types');

    const standardNames = new Set(standard.map((field) => field.name));
    const allTypeNames = new Set(allTypes.map((field) => field.name));
    for (const name of standardNames) expect(allTypeNames.has(name)).toBe(true);
    expect(allTypes.length).toBeGreaterThan(standard.length);

    const types = new Set(allTypes.map((field) => field.type));
    expect(types).toEqual(
      new Set(['text', 'number', 'date', 'checkbox', 'select', 'multi_select', 'user']),
    );
  });

  it('every select/multi_select field carries options, and no other type does', () => {
    for (const field of customFields('all-types')) {
      if (field.type === 'select' || field.type === 'multi_select') {
        expect(field.options).not.toBeNull();
        expect(field.options?.length).toBeGreaterThan(0);
      } else {
        expect(field.options).toBeNull();
      }
    }
  });
});

describe('cardTitle / checklistName / checklistItemText', () => {
  it('never produce empty strings', () => {
    const rng = createRng('non-empty-text');
    for (let i = 0; i < 100; i += 1) {
      expect(cardTitle(rng).length).toBeGreaterThan(0);
      expect(checklistName(rng).length).toBeGreaterThan(0);
      expect(checklistItemText(rng).length).toBeGreaterThan(0);
    }
  });
});
