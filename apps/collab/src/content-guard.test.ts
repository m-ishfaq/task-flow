import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { enforceContentWhitelist } from './content-guard.js';

/**
 * The save-boundary content whitelist pass (ai/phase-6-docs.md §3.8, §7.3).
 *
 * Every fixture here is built with Yjs's own mutation API — `insert`,
 * `setAttribute`, text `insert(index, text, attributes)` — the same
 * primitives y-prosemirror's `updateYFragment` uses, not a hand-rolled
 * shortcut. That is what makes a passing test here mean something about a
 * document a real editor would actually produce.
 */

function docWithFragment(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  return { doc, fragment: doc.getXmlFragment('content') };
}

describe('enforceContentWhitelist', () => {
  it('leaves a valid document untouched', () => {
    const { fragment } = docWithFragment();

    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Hello, world.', { bold: {} });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const result = enforceContentWhitelist(fragment);

    expect(result.changed).toBe(false);
    expect(fragment.toArray()).toHaveLength(1);
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe('paragraph');
    expect(text.toDelta()).toEqual([{ insert: 'Hello, world.', attributes: { bold: {} } }]);
  });

  it('deletes an element of an unknown node type entirely', () => {
    const { fragment } = docWithFragment();

    fragment.insert(0, [new Y.XmlElement('paragraph'), new Y.XmlElement('image')]);

    const result = enforceContentWhitelist(fragment);

    expect(result.strippedNodes).toBe(1);
    expect(result.changed).toBe(true);
    expect(fragment.toArray()).toHaveLength(1);
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe('paragraph');
  });

  it('strips every attribute from a known node whose attributes are invalid, without deleting the node', () => {
    const { fragment } = docWithFragment();

    const heading = new Y.XmlElement('heading');
    // level must be an integer 1-6; 99 is out of range. `setAttribute`'s
    // default generic types values as `string`, but Yjs stores whatever is
    // handed to it — the cast reflects that this module reads real
    // (numeric) TipTap attrs, not Y.XmlElement's overly-narrow default type.
    heading.setAttribute('level', 99 as unknown as string);
    fragment.insert(0, [heading]);

    const result = enforceContentWhitelist(fragment);

    expect(result.strippedNodes).toBe(1);
    expect(fragment.toArray()).toHaveLength(1);
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe('heading');
    expect((fragment.get(0) as Y.XmlElement).getAttributes()).toEqual({});
  });

  it('replaces a text run carrying a javascript: link mark with an unformatted equivalent, preserving the text', () => {
    const { fragment } = docWithFragment();

    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'click me', { link: { href: 'javascript:alert(1)' } });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const result = enforceContentWhitelist(fragment);

    expect(result.strippedTextRuns).toBe(1);
    expect(result.changed).toBe(true);

    const survivingText = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(survivingText.toDelta()).toEqual([{ insert: 'click me' }]);
  });

  it('keeps a text run whose link uses a safe scheme', () => {
    const { fragment } = docWithFragment();

    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'click me', { link: { href: 'https://example.com' } });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const result = enforceContentWhitelist(fragment);

    expect(result.changed).toBe(false);
    const survivingText = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(survivingText.toDelta()).toEqual([
      { insert: 'click me', attributes: { link: { href: 'https://example.com' } } },
    ]);
  });

  it('strips an unknown mark type, matching y-prosemirror\'s overlapping-mark hash-suffix convention', () => {
    const { fragment } = docWithFragment();

    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    // A mark name with the --<8char> suffix y-prosemirror appends for
    // overlapping instances of the same mark type — the base name
    // ("scriptInjection") is still not on the whitelist regardless of the
    // suffix, and this proves the suffix-stripping regex is exercised.
    text.insert(0, 'hi', { 'scriptInjection--abcd1234': { onload: 'alert(1)' } });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const result = enforceContentWhitelist(fragment);

    expect(result.strippedTextRuns).toBe(1);
    const survivingText = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(survivingText.toDelta()).toEqual([{ insert: 'hi' }]);
  });

  it('recurses into nested structure (list > listItem > paragraph)', () => {
    const { fragment } = docWithFragment();

    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const paragraph = new Y.XmlElement('paragraph');
    const badChild = new Y.XmlElement('script');
    paragraph.insert(0, [badChild]);
    item.insert(0, [paragraph]);
    list.insert(0, [item]);
    fragment.insert(0, [list]);

    const result = enforceContentWhitelist(fragment);

    expect(result.strippedNodes).toBe(1);
    const survivingParagraph = (
      (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement
    ).get(0) as Y.XmlElement;
    expect(survivingParagraph.toArray()).toHaveLength(0);
  });

  it('is a no-op on an empty fragment', () => {
    const { fragment } = docWithFragment();
    const result = enforceContentWhitelist(fragment);
    expect(result).toEqual({ strippedNodes: 0, strippedTextRuns: 0, changed: false });
  });
});
