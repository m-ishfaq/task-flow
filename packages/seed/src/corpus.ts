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
  'Amara',
  'Bo',
  'Camille',
  'Devendra',
  'Elif',
  'Farid',
  'Greta',
  'Hollis',
  'Ines',
  'Jonas',
  'Kiran',
  'Lucia',
  'Mateo',
  'Nadia',
  'Oskar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sami',
  'Tomas',
  'Ulla',
  'Vikram',
  'Wren',
  'Xiulan',
  'Yusuf',
  'Zoë',
  'Anders',
  'Bea',
  'Cyrus',
  'Delphine',
  'Emeka',
  'Fiona',
  'Gustav',
  'Hana',
  'Idris',
  'Juno',
  'Kwame',
  'Leena',
  'Milo',
  'Noor',
  'Otto',
  'Pilar',
  'Rafael',
  'Suvi',
  'Theo',
  'Umi',
  'Vera',
  'Wanjiru',
  'Yara',
  'Zane',
  'Aoife',
  'Bruno',
  'Clara',
  'Dmitri',
  'Esme',
  'Felipe',
  'Gita',
  'Henrik',
  'Ivy',
  'Jae',
] as const;

const LAST_NAMES = [
  'Okonkwo',
  'Lindqvist',
  'Ferreira',
  'Nakamura',
  'Duarte',
  'Havili',
  'Novak',
  'Sørensen',
  'Bhattacharya',
  'Costa',
  'Voss',
  'Marchetti',
  'Alvarez',
  'Petrov',
  'Kowalski',
  'Rahman',
  'Björk',
  'Tanaka',
  'Mensah',
  'Castellanos',
  'Weiss',
  'Iversen',
  'Delacroix',
  'Ashworth',
  'Moreau',
  'Vidal',
  'Halvorsen',
  'Onyeka',
  'Bergström',
  'Pereira',
  'Falk',
  'Nakashima',
  'Aguilar',
  'Sandoval',
  'Rúnarsson',
  'Kaur',
  'Lindgren',
  'Basri',
  'Toledo',
  'Ekwueme',
  'Sacco',
  'Nyberg',
  'Chandra',
  'Villanueva',
  'Oyelaran',
  'Kristensen',
  'Barros',
  'Sirko',
  'Amankwah',
  'Terzi',
  'Roux',
  'Palladino',
  'Njoroge',
  'Vasquez',
  'Holm',
  'Danielsen',
  'Rustamova',
  'Beaulieu',
  'Mwangi',
  'Karlsson',
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
  'Fix',
  'Add',
  'Remove',
  'Refactor',
  'Investigate',
  'Document',
  'Migrate',
  'Harden',
  'Instrument',
  'Simplify',
  'Benchmark',
  'Audit',
  'Deprecate',
  'Backfill',
  'Rewrite',
  'Split',
  'Cache',
  'Throttle',
  'Retry',
  'Validate',
] as const;

const SUBJECTS = [
  'the invite flow',
  'session expiry',
  'the board sidebar',
  'label filtering',
  'the audit projection',
  'refresh rotation',
  'the rank rebalancer',
  'attachment scanning',
  'the permission trace',
  'card numbering',
  'the outbox relay',
  'org switching',
  'the filter compiler',
  'WIP limits',
  'checklist counters',
  'comment threading',
  'the table view',
  'due reminders',
  'custom field types',
  'the empty state',
  'keyboard navigation',
  'the search index',
  'drag and drop',
  'the mobile layout',
  'export tooling',
] as const;

const QUALIFIERS = [
  'on slow connections',
  'for guest accounts',
  'after a tenant switch',
  'under concurrent edits',
  'in the archived view',
  'on first paint',
  'when the list is empty',
  'for very large boards',
  'behind the feature flag',
  'in Safari',
  'without a status set',
  'during reconnect',
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

/* -------------------------------------------------------------------------- *
 * Chat vocabulary (Phase 5)
 *
 * Kept apart from the Work sections above rather than sharing their pools. A
 * chat message does not read like a card comment — it is shorter, it addresses
 * someone, and it is often a fragment — and pooling the two would make both
 * surfaces look subtly wrong in a way nobody could point at.
 * -------------------------------------------------------------------------- */

const CHANNEL_TOPICS = [
  'Anything and everything. Keep it kind.',
  'Deploys, incidents, and the postmortems that follow them.',
  'Design critique — drop a screenshot and say what you are unsure about.',
  'Whatever is on fire right now. Paged? Start the thread here.',
  'Release coordination for the current milestone.',
  'Questions about the API. No question is too small.',
  'Read-only announcements. Discussion happens in the linked thread.',
  'Vendor and contractor coordination.',
  'Weekly planning and anything that needs a decision.',
  'Security review requests and their outcomes.',
] as const;

export function channelTopic(rng: Rng): string {
  return rng.pick(CHANNEL_TOPICS);
}

const MESSAGE_LINES = [
  'Morning — anyone looked at the overnight run yet?',
  'That one is mine, I broke it yesterday. Fix is up.',
  'Can we get a second pair of eyes on this before it goes out?',
  'Deploy is green.',
  'Rolled back. Same failure as last week, so it is not a fluke.',
  'I think this is the same root cause as the ticket from Tuesday.',
  'Do we have a runbook for this, or is it folklore?',
  'Ha, I had exactly the same thought about ten minutes ago.',
  'Slow day on staging — is someone running a load test?',
  'Pushed a branch, nothing controversial in it.',
  'Confirmed on my machine too.',
  'Not urgent, but it has been bugging me for a while.',
  'Where did we land on the naming for this?',
  'Numbers are in the doc, they are not great.',
  'Taking a look now.',
  'Sorry, missed this — catching up on the thread.',
  'Agreed. Let us not overthink it.',
  'That would explain a lot, actually.',
  'Anyone around who knows how the old importer worked?',
  'Merged. Thanks for the quick review.',
  'This has been flaky for two days and I finally have a reproduction.',
  'I will write it up properly tomorrow, short version is that it works.',
  'Heads up: I am touching shared config, shout if that is a problem.',
  'Confirming we are still on for the review this afternoon.',
  'Nice, that is much cleaner than what I had.',
  'Parking this one, it is not blocking anything.',
  'Can someone sanity-check my reading of the spec here?',
  'Done and verified against a second tenant.',
] as const;

/**
 * Reaction emoji.
 *
 * Every entry is one to 32 characters, matching `message_reactions_emoji_length`
 * — the constraint counts CHARACTERS, and a multi-codepoint emoji (a skin-tone
 * modifier, a ZWJ sequence) costs several. Kept to single-codepoint symbols so
 * the length is obvious by inspection rather than something a reader has to
 * count.
 */
export const EMOJI_PALETTE = ['👍', '🎉', '👀', '🚀', '❤️', '😄', '🙏', '🔥', '✅', '🤔'] as const;

/**
 * Link previews, as the unfurl job would have recorded them.
 *
 * `status` is the attempt, not just its success (migration 0020), and all three
 * outcomes are represented on purpose:
 *
 *   `ok`      — fetched and parsed, carries metadata.
 *   `refused` — the SSRF control said no. The URL here is the cloud metadata
 *               endpoint, which is precisely what `packages/security/outbound-url.ts`
 *               exists to reject; a seeded database where nobody ever pasted one
 *               leaves the "operator can notice this" argument untested.
 *   `failed`  — timeout, DNS, 5xx.
 *
 * Only `ok` carries title/description/image/site: `message_unfurls_metadata_matches_status`
 * refuses anything else, so the shape of this table is what keeps a caller from
 * expressing the state where a refused fetch somehow produced a title.
 */
export interface UnfurlFixture {
  readonly url: string;
  readonly status: 'ok' | 'refused' | 'failed';
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly siteName: string | null;
}

export const UNFURL_FIXTURES: readonly UnfurlFixture[] = [
  {
    url: 'https://example.com/blog/rank-strings-that-do-not-grow',
    status: 'ok',
    title: 'Rank strings that do not grow',
    description:
      'Why bisecting a fraction is correct and unusable, and what to do instead when cards are appended ten thousand times.',
    imageUrl: 'https://example.com/images/ranks.png',
    siteName: 'Example Engineering',
  },
  {
    url: 'https://example.com/docs/row-level-security',
    status: 'ok',
    title: 'Row-Level Security — the parts that fail silently',
    description:
      'A locking select needs an UPDATE policy, and Postgres excludes the row rather than erroring.',
    imageUrl: null,
    siteName: 'Example Docs',
  },
  {
    url: 'https://status.example.com/incidents/2026-07-11',
    status: 'ok',
    title: 'Elevated error rates — resolved',
    description: 'Between 09:12 and 10:40 UTC a subset of requests returned 503.',
    imageUrl: 'https://status.example.com/og/incident.png',
    siteName: 'Example Status',
  },
  {
    url: 'https://example.org/papers/uuidv7',
    status: 'ok',
    title: 'UUIDv7 and why the cursor is an id',
    description: 'Creation-ordered and unique, which is what makes the paging order total.',
    imageUrl: null,
    siteName: null,
  },
  {
    /* The link-local metadata address. A preview fetched from here would be the
       SSRF the unfurl fetcher exists to refuse, so the row records the refusal
       and nothing else — no title, by constraint. */
    url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    status: 'refused',
    title: null,
    description: null,
    imageUrl: null,
    siteName: null,
  },
  {
    url: 'https://unreachable.example.net/dashboards/throughput',
    status: 'failed',
    title: null,
    description: null,
    imageUrl: null,
    siteName: null,
  },
];

/** Someone who can be `@`-mentioned. Ids are real seeded user ids. */
export interface Mentionable {
  readonly id: string;
  readonly name: string;
}

/**
 * A generated message, with the two things the caller would otherwise have to
 * re-derive by walking the document it just handed them.
 *
 * `mentionedUserIds` is reported rather than re-parsed on purpose. The API
 * extracts mentions at write time (`message.service.ts`) precisely so the rules
 * live in one place; a seeder that walked its own output would be a SECOND
 * parser with no test on it, which is the thing that comment warns against.
 * Here the information is not parsed at all — it is what the generator chose,
 * which cannot disagree with what it wrote.
 */
export interface MessageContent {
  readonly document: RichTextNode;
  readonly mentionedUserIds: readonly string[];
  /** URLs that literally appear in the body — the only ones an unfurl may name. */
  readonly urls: readonly string[];
}

export interface MessageOptions {
  /** People to `@`. Empty means no mention; the caller decides the rate. */
  readonly mentions: readonly Mentionable[];
  /** URLs to embed as link marks. Empty means no link. */
  readonly links: readonly string[];
}

/**
 * A chat message.
 *
 * Shorter and flatter than a card description: no headings, no blockquotes,
 * occasionally a code span or a bullet list, and — unlike anything else in this
 * corpus — `mention` nodes.
 *
 * The one rule that is not stylistic: **a message always carries words**, even
 * when it carries a mention. `sendMessage` refuses a document that flattens to
 * nothing, and while a mention-only message does flatten to `@Name` (the
 * flattener contributes `attrs.label`), a seeded row that only just clears a
 * check the live service applies is a fixture inviting the next person to make
 * it not clear it at all.
 */
export function messageDocument(rng: Rng, options: MessageOptions): MessageContent {
  const content: RichTextNode[] = [];
  const mentionedUserIds: string[] = [];
  const urls: string[] = [];

  const opening: RichTextNode[] = [];

  for (const person of options.mentions) {
    opening.push({ type: 'mention', attrs: { userId: person.id, label: person.name } });
    opening.push({ type: 'text', text: ' ' });
    mentionedUserIds.push(person.id);
  }

  const line = rng.pick(MESSAGE_LINES);

  if (rng.chance(0.18)) {
    // An inline mark — the message list renders `bold` and `code` and would
    // otherwise never be handed either.
    const mark = rng.chance(0.5) ? 'bold' : 'code';
    const [head, ...rest] = line.split(' ');
    opening.push(
      { type: 'text', text: `${head ?? line} ` },
      { type: 'text', text: rest.join(' '), marks: [{ type: mark }] },
    );
  } else {
    opening.push({ type: 'text', text: line });
  }

  content.push({ type: 'paragraph', content: opening });

  for (const url of options.links) {
    urls.push(url);
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: rng.chance(0.5) ? 'Context: ' : 'This one — ' },
        {
          type: 'text',
          text: url,
          /* `href` only, exactly as `descriptionDocument` does. `rel` and
             `class` are refused by the mark schema so a document cannot opt
             itself out of noopener. */
          marks: [{ type: 'link', attrs: { href: url } }],
        },
      ],
    });
  }

  if (rng.chance(0.15)) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: rng.pick(MESSAGE_LINES) }] });
  }

  if (rng.chance(0.08)) {
    const items = rng.int(2, 3);
    content.push({
      type: 'bulletList',
      content: Array.from({ length: items }, () => ({
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: rng.pick(MESSAGE_LINES) }] },
        ],
      })),
    });
  }

  return { document: { type: 'doc', content }, mentionedUserIds, urls };
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

/* -------------------------------------------------------------------------- *
 * Docs (Phase 6)
 * -------------------------------------------------------------------------- */

const PAGE_TOPICS = [
  'Local development setup',
  'Release checklist',
  'Incident response',
  'Code review expectations',
  'Deploying to staging',
  'Rotating credentials',
  'On-call handover',
  'Database migrations',
  'Feature flag lifecycle',
  'Support escalation paths',
  'Accessibility standards',
  'Naming conventions',
  'Third-party integrations',
  'Data retention policy',
  'Interview loop',
  'Quarterly planning',
  'Postmortem template',
  'Style guide',
  'Backup and restore',
  'Monitoring and alerts',
] as const;

const PAGE_QUALIFIERS = [
  'overview',
  'FAQ',
  'draft',
  'archive',
  'for new joiners',
  'v2',
  'notes',
  'checklist',
] as const;

/**
 * A page title.
 *
 * Titles repeat across a tree ON PURPOSE — "Overview" under three different
 * parents is the ordinary shape of a documentation space, and nothing in
 * migration 0023 makes a title unique. A corpus that quietly guaranteed
 * uniqueness would hide the one place it matters: a breadcrumb or a search
 * result that shows only the title is ambiguous, and that is a real product
 * problem to be able to see rather than one to seed around.
 *
 * The repeat that ISN'T wanted — four identical SIBLINGS under one parent,
 * which a 20-topic pool drawn 70% bare over a 46-page space produces by
 * arithmetic — is the tree's job to avoid, not this function's: `docs.spaces`
 * retries until a sibling group has unique titles, keeping the cross-parent
 * ambiguity this comment defends while dropping the soup.
 */
export function pageTitle(rng: Rng): string {
  const topic = rng.pick(PAGE_TOPICS);
  return rng.chance(0.3) ? `${topic} — ${rng.pick(PAGE_QUALIFIERS)}` : topic;
}

/**
 * One block of a page body, described in terms of the EDITOR's vocabulary
 * rather than Yjs's.
 *
 * A page body is a `Y.XmlFragment`, not TipTap JSON like a card description
 * (§3.1: only the body is a CRDT), so this returns a neutral description that
 * `modules/docs.content.ts` turns into `Y.XmlElement`s. Keeping Yjs out of the
 * corpus is the same separation the file header describes — this decides what a
 * page says, the module decides how a page is stored.
 *
 * Every `kind` here maps to a node type on `@taskflow/api/richtext`'s
 * whitelist, which is what makes a seeded document one the collab gateway's
 * content guard leaves untouched. `docs.test.ts` asserts exactly that, against
 * the guard's own code rather than against this list.
 */
export type PageBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string };

const CODE_SAMPLES: readonly (readonly [string, string])[] = [
  ['bash', 'pnpm verify'],
  ['bash', 'docker compose up -d'],
  ['sql', 'SELECT count(*) FROM docs.pages WHERE archived_at IS NULL;'],
  ['typescript', 'await withOrgScope(orgId, async (tx) => tx.select().from(pages));'],
];

/**
 * A page body, as an ordered list of blocks.
 *
 * Always opens with a paragraph rather than a heading: a document whose first
 * node is a heading hides the case where a body's first line is plain text,
 * which is what most real pages start with.
 */
export function pageBody(rng: Rng, blocks: number): readonly PageBlock[] {
  const body: PageBlock[] = [{ kind: 'paragraph', text: rng.pick(SENTENCES) }];

  for (let i = 1; i < blocks; i += 1) {
    const kind = rng.weighted([
      ['paragraph', 6],
      ['heading', 3],
      ['bullets', 3],
      ['quote', 1],
      ['code', 1],
    ] as const);

    switch (kind) {
      case 'heading':
        body.push({ kind: 'heading', level: rng.int(2, 4), text: rng.pick(PAGE_TOPICS) });
        break;
      case 'bullets':
        body.push({
          kind: 'bullets',
          items: rng.sample(CHECKLIST_ITEMS, rng.int(2, 4)),
        });
        break;
      case 'quote':
        body.push({ kind: 'quote', text: rng.pick(COMMENTS) });
        break;
      case 'code': {
        const [language, text] = rng.pick(CODE_SAMPLES);
        body.push({ kind: 'code', language, text });
        break;
      }
      case 'paragraph':
      default:
        body.push({ kind: 'paragraph', text: rng.pick(SENTENCES) });
    }
  }

  return body;
}

/**
 * Names for a space's reusable page templates (Phase 6, Wave 4).
 *
 * Genuinely different names from `PAGE_TOPICS`, on purpose: a page is a real
 * document about something, a template is a reusable SHAPE ("Meeting notes",
 * "1:1"), and reusing the page-topic pool would produce a template that
 * reads like a specific already-written page rather than a starting point
 * for a new one.
 */
const TEMPLATE_NAMES = [
  'Meeting notes',
  'Project brief',
  'Weekly 1:1',
  'Runbook',
  'Post-mortem',
  'Design doc',
  'Onboarding checklist',
  'Decision record',
] as const;

export function pageTemplateName(rng: Rng): string {
  return rng.pick(TEMPLATE_NAMES);
}
