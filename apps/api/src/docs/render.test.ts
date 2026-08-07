import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { renderFragmentToHtml, renderPagePdf, renderPublicPage } from './render.js';

/**
 * The public/PDF renderer's whitelist behavior (ai/phase-6-docs.md §3.9,
 * Wave 4).
 *
 * Fixtures are built with Yjs's own mutation API, matching
 * `apps/collab/src/content-guard.test.ts`'s own convention — the same
 * primitives y-prosemirror's `updateYFragment` uses, so a passing test here
 * means something about a document a real editor would actually produce.
 * These fixtures deliberately do NOT run `enforceContentWhitelist` first —
 * the whole point (this file's own header) is that this renderer must not
 * assume it already ran.
 */

function docWithFragment(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  return { doc, fragment: doc.getXmlFragment('content') };
}

describe('renderFragmentToHtml', () => {
  it('renders a paragraph with whitelisted marks', () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Hello, world.', { bold: {}, italic: {} });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const html = renderFragmentToHtml(fragment);

    expect(html).toBe('<p><em><strong>Hello, world.</strong></em></p>');
  });

  it('escapes text content — no raw HTML from a document ever reaches the page', () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '<script>alert(1)</script>');
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const html = renderFragmentToHtml(fragment);

    expect(html).not.toContain('<script>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('renders a safe link with a fixed rel, never one the document supplied', () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'click me', { link: { href: 'https://example.com/path' } });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const html = renderFragmentToHtml(fragment);

    expect(html).toBe(
      '<p><a href="https://example.com/path" rel="noopener noreferrer nofollow">click me</a></p>',
    );
  });

  it('drops a javascript: link mark entirely rather than rendering an <a>', () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'click me', { link: { href: 'javascript:alert(1)' } });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const html = renderFragmentToHtml(fragment);

    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
    expect(html).toBe('<p>click me</p>');
  });

  it('degrades a text run with an unknown mark to plain, unformatted text', () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    // 'strikethrough' is not on the whitelist — only 'strike' is.
    text.insert(0, 'plain please', { strikethrough: {} });
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const html = renderFragmentToHtml(fragment);

    expect(html).toBe('<p>plain please</p>');
  });

  it('skips a node of an unknown type entirely, including its children', () => {
    const { fragment } = docWithFragment();
    const evil = new Y.XmlElement('iframe');
    const text = new Y.XmlText();
    text.insert(0, 'hidden');
    evil.insert(0, [text]);
    fragment.insert(0, [evil]);

    const html = renderFragmentToHtml(fragment);

    expect(html).toBe('');
  });

  it('renders headings, lists, and code blocks with their attributes', () => {
    const { fragment } = docWithFragment();

    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 2 as unknown as string);
    const headingText = new Y.XmlText();
    headingText.insert(0, 'Title');
    heading.insert(0, [headingText]);

    const list = new Y.XmlElement('orderedList');
    list.setAttribute('start', 3 as unknown as string);
    const item = new Y.XmlElement('listItem');
    const itemText = new Y.XmlText();
    itemText.insert(0, 'third item');
    item.insert(0, [itemText]);
    list.insert(0, [item]);

    const code = new Y.XmlElement('codeBlock');
    code.setAttribute('language', 'typescript');
    const codeText = new Y.XmlText();
    codeText.insert(0, 'const x = 1;');
    code.insert(0, [codeText]);

    fragment.insert(0, [heading, list, code]);

    const html = renderFragmentToHtml(fragment);

    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<ol start="3"><li>third item</li></ol>');
    expect(html).toContain('<pre><code class="language-typescript">const x = 1;</code></pre>');
  });

  it('renders mention and pageLink as plain, non-navigable spans', () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const mention = new Y.XmlElement('mention');
    mention.setAttribute('userId', '018f4d1e-7c3a-7b2e-8f1a-000000000009');
    mention.setAttribute('label', 'Jane Doe');
    const pageLink = new Y.XmlElement('pageLink');
    pageLink.setAttribute('pageId', '018f4d1e-7c3a-7b2e-8f1a-000000000010');
    pageLink.setAttribute('label', 'Other Page');
    paragraph.insert(0, [mention, pageLink]);
    fragment.insert(0, [paragraph]);

    const html = renderFragmentToHtml(fragment);

    expect(html).toBe(
      '<p><span class="mention">@Jane Doe</span><span class="page-link">Other Page</span></p>',
    );
    expect(html).not.toContain('<a');
  });

  it('rejects an invalid heading level rather than emitting a malformed tag', () => {
    const { fragment } = docWithFragment();
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 99 as unknown as string);
    const text = new Y.XmlText();
    text.insert(0, 'oops');
    heading.insert(0, [text]);
    fragment.insert(0, [heading]);

    // NODE_ATTRIBUTES.heading rejects level > 6, so `attrs` falls back to {}
    // and `.level` is undefined — Math.min/Math.max on NaN would produce an
    // invalid tag name, which is exactly the case this test pins down.
    const html = renderFragmentToHtml(fragment);
    expect(html).toMatch(/^<h[1-6]>oops<\/h[1-6]>$/);
  });
});

describe('renderPublicPage', () => {
  it('escapes the title and embeds no external resources', () => {
    const { fragment } = docWithFragment();
    const html = renderPublicPage({ title: '<b>Untitled</b> & Co', fragment });

    expect(html).toContain('&lt;b&gt;Untitled&lt;/b&gt; &amp; Co');
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});

describe('renderPagePdf', () => {
  it('produces a buffer with the PDF magic signature', async () => {
    const { fragment } = docWithFragment();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Hello, PDF.');
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);

    const pdf = await renderPagePdf({ title: 'A Document', fragment });

    // The same signature packages/security/magic-bytes.ts checks for
    // application/pdf uploads — '%PDF-' at offset 0.
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(100);
  });

  it('does not throw on an unknown node type mixed into the fragment', async () => {
    const { fragment } = docWithFragment();
    const evil = new Y.XmlElement('script');
    const text = new Y.XmlText();
    text.insert(0, 'ignored');
    evil.insert(0, [text]);
    fragment.insert(0, [evil]);

    await expect(renderPagePdf({ title: 'Safe', fragment })).resolves.toBeInstanceOf(Buffer);
  });
});
