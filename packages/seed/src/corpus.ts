import { flattenToText, type RichTextNode } from '@taskflow/api/richtext';
import type { Rng } from './rng.js';

/**
 * The words the seeder builds rows out of.
 *
 * Kept in one file so the shape of the data and the vocabulary describing it are
 * separable: a module decides that a card has a description, this decides what
 * the description says. Adding a product in a later phase means adding a corpus
 * section here and a module beside it, and neither has to know about the other.
 *
 * ## The one rule that is not cosmetic
 *
 * Rich text is TipTap JSON validated against `.strict()` node schemas, and the
 * API rejects attributes it does not whitelist — including ones TipTap itself
 * emits by default (CLAUDE.md, `detail/rich-text.ts`). So the builders below
 * emit only whitelisted nodes and attributes, and `corpus.test.ts` parses their
 * output with the API's REAL `RichTextDocument` schema. A document that would be
 * refused on a live request must fail the test rather than land in a row that
 * nothing can subsequently save.
 */

/* -------------------------------------------------------------------------- *
 * People
 * -------------------------------------------------------------------------- */

const FIRST_NAMES = [
  'Amara', 'Bo', 'Camille', 'Devendra', 'Elif', 'Farid', 'Greta', 'Hollis',
  'Ines', 'Jonas', 'Kiran', 'Lucia', 'Mateo', 'Nadia', 'Oskar', 'Priya',
  'Quinn', 'Rosa', 'Sami', 'Tomas', 'Ulla', 'Vikram', 'Wren', 'Xiulan',
  'Yusuf', 'Zoë', 'Anders', 'Bea', 'Cyrus', 'Delphine', 'Emeka', 'Fiona',
  'Gustav', 'Hana', 'Idris', 'Juno', 'Kwame', 'Leena', 'Milo', 'Noor',
  'Otto', 'Pilar', 'Rafael', 'Suvi', 'Theo', 'Umi', 'Vera', 'Wanjiru',
  'Yara', 'Zane', 'Aoife', 'Bruno', 'Clara', 'Dmitri', 'Esme', 'Felipe',
  'Gita', 'Henrik', 'Ivy', 'Jae',
] as const;

const LAST_NAMES = [
  'Okonkwo', 'Lindqvist', 'Ferreira', 'Nakamura', 'Duarte', 'Havili', 'Novak',
  'Sørensen', 'Bhattacharya', 'Costa', 'Voss', 'Marchetti', 'Alvarez', 'Petrov',
  'Kowalski', 'Rahman', 'Björk', 'Tanaka', 'Mensah', 'Castellanos', 'Weiss',
  'Iversen', 'Delacroix', 'Ashworth', 'Moreau', 'Vidal', 'Halvorsen', 'Onyeka',
  'Bergström', 'Pereira', 'Falk', 'Nakashima', 'Aguilar', 'Sandoval', 'Rúnarsson',
  'Kaur', 'Lindgren', 'Basri', 'Toledo', 'Ekwueme', 'Sacco', 'Nyberg',
  'Chandra', 'Villanueva', 'Oyelaran', 'Kristensen', 'Barros', 'Sirko',
  'Amankwah', 'Terzi', 'Roux', 'Palladino', 'Njoroge', 'Vasquez', 'Holm',
  'Danielsen', 'Rustamova', 'Beaulieu', 'Mwangi', 'Karlsson',
] as const;

export interface PersonName {
  readonly first: string;
  readonly last: string;
  readonly full: string;
}

/**
 * `count` distinct people, deterministic for a given RNG.
 *
 * Distinct matters more than it looks: emails are derived from names, and
 * `users_email_normalized_key` is a unique index — two collisions in the pool
 * would fail the run rather than produce a duplicate.
 */
export function people(rng: Rng, count: number): readonly PersonName[] {
  const seen = new Set<string>();
  const names: PersonName[] = [];

  // Bounded rather than `while (names.length < count)`: a corpus too small for
  // the requested pool must fail with a message, not spin forever.
  const attempts = count * 40;
  for (let attempt = 0; attempt < attempts && names.length < count; attempt += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const full = `${first} ${last}`;
    if (seen.has(full)) continue;
    seen.add(full);
    names.push({ first, last, full });
  }

  if (names.length < count) {
    throw new Error(
      `Corpus can produce ${String(names.length)} distinct names, not ${String(count)}. ` +
        'Add entries to FIRST_NAMES or LAST_NAMES.',
    );
  }

  return names;
}

/**
 * The email local part, ASCII-folded.
 *
 * `Zoë Björk` must not become an address with combining marks in it: the column
 * is unique on the normalized form, and an address nobody can type into the
 * sign-in box makes the account it belongs to undemonstrable.
 */
export function emailLocalPart(name: PersonName): string {
  return (
    `${name.first}.${name.last}`
      // NFD splits an accented letter into a base letter plus a combining mark,
      // and the filter below then drops the mark — so `Zoe` survives with its
      // vowel intact rather than losing the whole character.
      .normalize('NFD')
      .replace(/[^A-Za-z0-9.]/g, '')
      .toLowerCase()
  );
}

/* -------------------------------------------------------------------------- *
 * Work vocabulary
 * -------------------------------------------------------------------------- */

const ACTIONS = [
  'Fix', 'Add', 'Remove', 'Refactor', 'Investigate', 'Document', 'Migrate',
  'Harden', 'Instrument', 'Simplify', 'Benchmark', 'Audit', 'Deprecate',
  'Backfill', 'Rewrite', 'Split', 'Cache', 'Throttle', 'Retry', 'Validate',
] as const;

const SUBJECTS = [
  'the invite flow', 'session expiry', 'the board sidebar', 'label filtering',
  'the audit projection', 'refresh rotation', 'the rank rebalancer',
  'attachment scanning', 'the permission trace', 'card numbering',
  'the outbox relay', 'org switching', 'the filter compiler', 'WIP limits',
  'checklist counters', 'comment threading', 'the table view', 'due reminders',
  'custom field types', 'the empty state', 'keyboard navigation',
  'the search index', 'drag and drop', 'the mobile layout', 'export tooling',
] as const;

const QUALIFIERS = [
  'on slow connections', 'for guest accounts', 'after a tenant switch',
  'under concurrent edits', 'in the archived view', 'on first paint',
  'when the list is empty', 'for very large boards', 'behind the feature flag',
  'in Safari', 'without a status set', 'during reconnect',
] as const;

export function cardTitle(rng: Rng): string {
  const base = `${rng.pick(ACTIONS)} ${rng.pick(SUBJECTS)}`;
  return rng.chance(0.35) ? `${base} ${rng.pick(QUALIFIERS)}` : base;
}

const SENTENCES = [
  'Reproduced on staging with two tabs open against the same board.',
  'The failure only shows once the cache is cold, which is why CI missed it.',
  'Worth checking whether the same assumption exists in the table view.',
  'Blocked until the migration lands — no point starting before then.',
  'The fix is small; the test proving it is the actual work here.',
  'Numbers below are from a single run, so treat them as a direction.',
  'This has been wrong since the original slice and nobody noticed.',
  'Confirmed with the customer that the current behaviour is not what they expect.',
  'Splitting this out so the parent card can close.',
  'The error message is accurate but points at the wrong layer.',
  'Adding an index here would help, but the query itself is the problem.',
  'Needs a decision before it needs an implementation.',
  'Rolled back once already; the second attempt should include the regression test.',
  'Low priority until someone actually hits it, but easy to fix now.',
  'The trace shows the check running twice, which is not obviously harmless.',
] as const;

const COMMENTS = [
  'Picking this up.',
  'Left a couple of notes on the branch.',
  'Is this still relevant after the rework?',
  'I think this duplicates the card in Backlog — worth merging.',
  'Confirmed fixed on my side.',
  'This needs a second pair of eyes on the authorization path.',
  'Moving to Review, tests are green.',
  'Reverted for now — it broke the nightly.',
  'Do we have a reproduction for this yet?',
  'The customer followed up asking about timing.',
  'Nice catch, the same bug is in two other places.',
  'Parking this until after the release.',
  'Updated the description with what we found.',
  'Can you take a look when you get a chance?',
  'Agreed, the current behaviour is surprising.',
] as const;

const CHECKLIST_ITEMS = [
  'Write the failing test first',
  'Update the migration',
  'Check the guest role still works',
  'Add a decision-trace assertion',
  'Verify against a second tenant',
  'Update the changelog',
  'Measure before and after',
  'Confirm the event is emitted',
  'Review the error copy',
  'Check the empty state',
  'Backfill existing rows',
  'Remove the temporary flag',
  'Ask design about the spacing',
  'Test on a cold cache',
  'Document the failure mode',
] as const;

export function checklistItemText(rng: Rng): string {
  return rng.pick(CHECKLIST_ITEMS);
}

const CHECKLIST_NAMES = ['Acceptance', 'Before merge', 'Follow-ups', 'QA pass'] as const;

export function checklistName(rng: Rng): string {
  return rng.pick(CHECKLIST_NAMES);
}

/* -------------------------------------------------------------------------- *
 * Labels, statuses, custom fields
 * -------------------------------------------------------------------------- */

/** Lowercase hex — `labels_color_format` is `^#[0-9a-f]{6}$` and is case-sensitive. */
export const LABEL_PALETTE = [
  { name: 'bug', color: '#dc2626' },
  { name: 'feature', color: '#2563eb' },
  { name: 'chore', color: '#6b7280' },
  { name: 'security', color: '#b91c1c' },
  { name: 'performance', color: '#c2410c' },
  { name: 'design', color: '#7c3aed' },
  { name: 'docs', color: '#0891b2' },
  { name: 'blocked', color: '#a16207' },
  { name: 'good first issue', color: '#16a34a' },
  { name: 'needs decision', color: '#db2777' },
  { name: 'customer', color: '#0d9488' },
  { name: 'tech debt', color: '#78716c' },
] as const;

/**
 * The five statuses every seeded project gets.
 *
 * Deliberately not one per list. A card's status and its LIST are independent
 * (migration 0011) — a board can group by either — and seeding them one-to-one
 * would make every view agree by construction and hide exactly the disagreement
 * the two-column design exists to allow.
 */
export const STATUS_SET = [
  { name: 'Backlog', category: 'not_started', color: '#6b7280', isDefault: true },
  { name: 'Planned', category: 'not_started', color: '#4f46e5', isDefault: false },
  { name: 'In Progress', category: 'active', color: '#0891b2', isDefault: false },
  { name: 'In Review', category: 'active', color: '#c2410c', isDefault: false },
  { name: 'Done', category: 'done', color: '#16a34a', isDefault: false },
] as const;

export interface CustomFieldSpec {
  readonly name: string;
  readonly type: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'multi_select' | 'user';
  readonly options: readonly string[] | null;
}

const STANDARD_FIELDS: readonly CustomFieldSpec[] = [
  { name: 'Story Points', type: 'number', options: null },
  { name: 'Component', type: 'select', options: ['API', 'Web', 'Worker', 'Infra'] },
  { name: 'Target Release', type: 'date', options: null },
  { name: 'Notes', type: 'text', options: null },
];

/** All seven types, so every renderer in the card panel has something to draw. */
const ALL_TYPE_FIELDS: readonly CustomFieldSpec[] = [
  ...STANDARD_FIELDS,
  { name: 'Needs Design', type: 'checkbox', options: null },
  { name: 'Platforms', type: 'multi_select', options: ['iOS', 'Android', 'Web', 'Desktop'] },
  { name: 'Reviewer', type: 'user', options: null },
];

export function customFields(kind: 'standard' | 'all-types'): readonly CustomFieldSpec[] {
  return kind === 'all-types' ? ALL_TYPE_FIELDS : STANDARD_FIELDS;
}

/* -------------------------------------------------------------------------- *
 * Rich text
 * -------------------------------------------------------------------------- */

function paragraph(text: string): RichTextNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

/**
 * A card description.
 *
 * Mixes the node types the editor actually produces — headings, bullet lists,
 * code blocks, links — because a corpus of bare paragraphs would leave every
 * renderer except one untested, and the link mark in particular is the one whose
 * attributes the API is strictest about.
 */
export function descriptionDocument(rng: Rng): RichTextNode {
  const content: RichTextNode[] = [paragraph(rng.pick(SENTENCES))];

  if (rng.chance(0.4)) {
    content.push(
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Context' }] },
      paragraph(rng.pick(SENTENCES)),
    );
  }

  if (rng.chance(0.35)) {
    const items = rng.int(2, 4);
    content.push({
      type: 'bulletList',
      content: Array.from({ length: items }, () => ({
        type: 'listItem',
        content: [paragraph(rng.pick(SENTENCES))],
      })),
    });
  }

  if (rng.chance(0.2)) {
    content.push({
      type: 'codeBlock',
      attrs: { language: 'bash' },
      content: [{ type: 'text', text: 'pnpm verify' }],
    });
  }

  if (rng.chance(0.25)) {
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        {
          type: 'text',
          text: 'the runbook',
          /* `href` only. `target` is optional and `rel`/`class` are refused —
             a document that could set `rel` could opt itself out of noopener,
             which is why the mark schema excludes it. */
          marks: [{ type: 'link', attrs: { href: 'https://example.com/runbook' } }],
        },
        { type: 'text', text: ' for the current procedure.' },
      ],
    });
  }

  if (rng.chance(0.15)) {
    content.push({
      type: 'blockquote',
      content: [paragraph(rng.pick(SENTENCES))],
    });
  }

  return { type: 'doc', content };
}

/** A comment body — shorter, and occasionally carrying an inline mark. */
export function commentDocument(rng: Rng): RichTextNode {
  const text = rng.pick(COMMENTS);

  if (rng.chance(0.2)) {
    return {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `${text} ` },
            { type: 'text', text: 'Worth a look', marks: [{ type: 'bold' }] },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };
  }

  const content: RichTextNode[] = [paragraph(text)];
  if (rng.chance(0.25)) content.push(paragraph(rng.pick(SENTENCES)));
  return { type: 'doc', content };
}

/**
 * The flattened copy stored alongside every document.
 *
 * Uses the API's own flattener rather than a local one. `description_text` and
 * `body_text` back search, and a seeder that flattened differently would produce
 * rows whose search text does not match what the service would have written for
 * the same document — a discrepancy that only shows up as a card the search
 * cannot find.
 */
export function flatten(document: RichTextNode): string {
  return flattenToText(document);
}
