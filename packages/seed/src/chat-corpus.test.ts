import { describe, expect, it } from 'vitest';
import { RichTextDocument } from '@taskflow/api/richtext';
import { createRng } from './rng.js';
import {
  EMOJI_PALETTE,
  UNFURL_FIXTURES,
  channelTopic,
  flatten,
  messageDocument,
  type Mentionable,
} from './corpus.js';

/**
 * The chat half of the corpus, held to the same rule as the Work half
 * (`corpus.test.ts`'s header): a generator that produces a document the API
 * would REJECT is not a smaller bug than one that produces bad names — it is a
 * seeded row nothing can subsequently save. So every builder here is parsed with
 * the real `RichTextDocument` from `apps/api/src/work/richtext.ts`.
 *
 * Chat adds two things Work's corpus never produced, and both are checked
 * rather than assumed: `mention` nodes, whose `userId` is validated by
 * `isValidId` and whose `attrs` are `.strict()`, and the unfurl fixtures, which
 * have to satisfy a CHECK constraint about which statuses may carry metadata.
 */

const SAMPLE_SIZE = 300;

function mentionables(seed: string, count: number): readonly Mentionable[] {
  // Real UUIDv7s from the same generator the modules use — `mention.userId` is
  // shape-validated by `isValidId`, so an arbitrary string would be refused.
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, index) => ({
    id: rng.uuid(new Date(1_760_000_000_000 + index)),
    name: `Person ${String(index)}`,
  }));
}

describe('messageDocument', () => {
  it('always parses as a valid RichTextDocument', () => {
    const rng = createRng('message-corpus');
    const people = mentionables('message-corpus-people', 4);

    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      // `slice` rather than indexing: it is already typed without `undefined`,
      // so neither a cast nor a non-null assertion is needed to satisfy
      // `noUncheckedIndexedAccess`.
      const mentions = i % 3 === 0 ? people.slice(0, 1) : [];
      const links = i % 5 === 0 ? UNFURL_FIXTURES.slice(0, 1).map((fixture) => fixture.url) : [];
      const content = messageDocument(rng, { mentions, links });
      expect(() => RichTextDocument.parse(content.document)).not.toThrow();
    }
  });

  it('flattens to non-empty, tag-free text — the property sendMessage enforces', () => {
    // `sendMessage` refuses a document that flattens to nothing. A seeded row
    // the live service would have rejected is a fixture lying about what the
    // product accepts, so this is the same check from the other side.
    const rng = createRng('message-flatten');
    const people = mentionables('message-flatten-people', 3);

    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const at = i % people.length;
      const content = messageDocument(rng, {
        mentions: i % 2 === 0 ? people.slice(at, at + 1) : [],
        links: [],
      });
      const text = flatten(content.document);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[<>]/);
    }
  });

  it('reports exactly the mentions it wrote', () => {
    /* The generator REPORTS its mentions rather than re-parsing its own output
       (corpus.ts's note on `MessageContent`), which is only honest if the two
       agree. This walks the document independently and compares. */
    const rng = createRng('message-mentions');
    const people = mentionables('message-mentions-people', 5);

    for (let i = 0; i < 120; i += 1) {
      const chosen = people.slice(0, (i % 3) + 1);
      const content = messageDocument(rng, { mentions: chosen, links: [] });

      const raw = JSON.stringify(content.document);
      for (const person of chosen) expect(raw).toContain(person.id);
      expect([...content.mentionedUserIds].sort()).toEqual(chosen.map((p) => p.id).sort());
    }
  });

  it('emits mention attrs of exactly userId and label', () => {
    // `NODE_ATTRIBUTES.mention` is `.strict()`, so a stray attribute is a
    // rejected document rather than an ignored field.
    const rng = createRng('message-mention-attrs');
    const people = mentionables('message-mention-attrs-people', 2);
    const content = messageDocument(rng, { mentions: people.slice(0, 1), links: [] });

    const found: unknown[] = [];
    const walk = (node: { type: string; attrs?: unknown; content?: readonly unknown[] }): void => {
      if (node.type === 'mention') found.push(node.attrs);
      for (const child of node.content ?? []) {
        walk(child as { type: string; attrs?: unknown; content?: readonly unknown[] });
      }
    };
    walk(content.document as { type: string; attrs?: unknown; content?: readonly unknown[] });

    expect(found).toHaveLength(1);
    expect(Object.keys(found[0] as object).sort()).toEqual(['label', 'userId']);
  });

  it('embeds every requested link and reports it, with no rel or class', () => {
    /* An unfurl row may only name a URL that literally appears in the body —
       a preview for a link nobody pasted is a row the fetcher could not have
       produced. And `rel`/`class` are refused by the mark schema, because a
       document that could set `rel` could opt itself out of noopener. */
    const rng = createRng('message-links');
    const urls = UNFURL_FIXTURES.slice(0, 2).map((fixture) => fixture.url);

    for (let i = 0; i < 60; i += 1) {
      const content = messageDocument(rng, { mentions: [], links: urls });
      const raw = JSON.stringify(content.document);

      expect([...content.urls].sort()).toEqual([...urls].sort());
      for (const url of urls) expect(raw).toContain(url);
      expect(raw).not.toMatch(/"rel"|"class"/);
    }
  });

  it('varies its shape rather than always producing one paragraph', () => {
    const rng = createRng('message-variety');
    const shapes = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const content = messageDocument(rng, { mentions: [], links: [] });
      shapes.add(content.document.content?.map((node) => node.type).join(',') ?? '');
    }
    expect(shapes.size).toBeGreaterThan(1);
  });
});

describe('channelTopic', () => {
  it('never produces an empty topic, and stays inside channels_topic_length', () => {
    const rng = createRng('channel-topics');
    for (let i = 0; i < 100; i += 1) {
      const topic = channelTopic(rng);
      expect(topic.length).toBeGreaterThan(0);
      expect(topic.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('EMOJI_PALETTE', () => {
  it('every entry satisfies message_reactions_emoji_length', () => {
    for (const emoji of EMOJI_PALETTE) {
      expect(emoji.length).toBeGreaterThanOrEqual(1);
      expect(emoji.length).toBeLessThanOrEqual(32);
    }
  });

  it('has no duplicates', () => {
    // The reaction primary key is (message_id, user_id, emoji) and the module
    // samples distinct emoji to stay inside it — which only works if the
    // palette itself holds no repeats.
    expect(new Set(EMOJI_PALETTE).size).toBe(EMOJI_PALETTE.length);
  });
});

describe('UNFURL_FIXTURES', () => {
  it('only "ok" carries metadata — message_unfurls_metadata_matches_status', () => {
    for (const fixture of UNFURL_FIXTURES) {
      if (fixture.status === 'ok') continue;
      expect(fixture.title).toBeNull();
      expect(fixture.description).toBeNull();
      expect(fixture.imageUrl).toBeNull();
      expect(fixture.siteName).toBeNull();
    }
  });

  it('covers all three outcomes, including a refused one', () => {
    /* A seeded database where every preview succeeded leaves the SSRF refusal
       untested and the "an operator can notice someone pasting a link to
       169.254.169.254" argument (migration 0020) with nothing behind it. */
    const statuses = new Set(UNFURL_FIXTURES.map((fixture) => fixture.status));
    expect(statuses).toEqual(new Set(['ok', 'refused', 'failed']));
  });

  it('respects every length constraint in migration 0020', () => {
    for (const fixture of UNFURL_FIXTURES) {
      expect(fixture.url.length).toBeLessThanOrEqual(2048);
      expect(fixture.title?.length ?? 0).toBeLessThanOrEqual(300);
      expect(fixture.description?.length ?? 0).toBeLessThanOrEqual(300);
      expect(fixture.imageUrl?.length ?? 0).toBeLessThanOrEqual(2048);
      expect(fixture.siteName?.length ?? 0).toBeLessThanOrEqual(300);
    }
  });

  it('has distinct urls', () => {
    // The unfurl primary key is (org_id, message_id, url); the module samples
    // distinct fixtures per message, which is only distinct if these are.
    const urls = UNFURL_FIXTURES.map((fixture) => fixture.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
