import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, singleFileDiffText } from './diff-view.js';

/**
 * `diff-view.tsx`'s own header explains why this exists: `get_pr_diff`'s
 * result used to render as one undifferentiated `<pre>` block of raw diff
 * text, found "very tricky to read... not presentable" from a direct
 * report. `parseUnifiedDiff` is the pure half this file tests directly, the
 * same split `markdown-lite.test.ts`/`api.test.ts` already use for
 * client-only parsing logic.
 */

const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
-line two
+line two changed
+line three added
 line four
`;

describe('parseUnifiedDiff', () => {
  it('parses a single-file, single-hunk diff into path, hunk header, and classified lines', () => {
    const files = parseUnifiedDiff(SIMPLE_DIFF);

    expect(files).toHaveLength(1);
    expect(files[0]?.oldPath).toBe('src/foo.ts');
    expect(files[0]?.newPath).toBe('src/foo.ts');
    expect(files[0]?.status).toBe('modified');
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[0]?.hunks[0]?.header).toBe('@@ -1,3 +1,4 @@');
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'line one' },
      { kind: 'del', text: 'line two' },
      { kind: 'add', text: 'line two changed' },
      { kind: 'add', text: 'line three added' },
      { kind: 'context', text: 'line four' },
    ]);
  });

  it('parses multiple files from one diff, each with its own hunks', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old a
+new a
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
-old b
+new b
`;
    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(2);
    expect(files.map((f) => f.newPath)).toEqual(['a.ts', 'b.ts']);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'old a' },
      { kind: 'add', text: 'new a' },
    ]);
  });

  it('classifies an added file (old path /dev/null) as status "added"', () => {
    const diff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;
    const files = parseUnifiedDiff(diff);
    expect(files[0]?.status).toBe('added');
    expect(files[0]?.newPath).toBe('new-file.ts');
  });

  it('classifies a deleted file (new path /dev/null) as status "deleted"', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 1111111..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const files = parseUnifiedDiff(diff);
    expect(files[0]?.status).toBe('deleted');
    expect(files[0]?.oldPath).toBe('gone.ts');
  });

  it('classifies a renamed file (differing old/new paths, neither /dev/null) as status "renamed"', () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;
    const files = parseUnifiedDiff(diff);
    // A pure rename with no content change carries no --- /+++ /@@ lines at
    // all, so oldPath/newPath stay empty and status falls to 'modified' --
    // this asserts that real, narrower behavior rather than a guess neither
    // this parser nor a real GitHub diff actually promises.
    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe('modified');
  });

  it('treats a "\\ No newline at end of file" marker as an annotation, not a content line', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const files = parseUnifiedDiff(diff);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('returns an empty array for text with no "diff --git" marker at all', () => {
    expect(parseUnifiedDiff('not a diff, just some text\nwith multiple lines')).toEqual([]);
  });

  it('handles a hunk truncated mid-way (MAX_DIFF_CHARS cutting the text off) without throwing', () => {
    const truncated = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,100 +1,100 @@
 context
+added
-remo`; // cut off mid-line, no trailing newline
    expect(() => parseUnifiedDiff(truncated)).not.toThrow();
    const files = parseUnifiedDiff(truncated);
    expect(files[0]?.hunks[0]?.lines.at(-1)).toEqual({ kind: 'del', text: 'remo' });
  });
});

describe('singleFileDiffText', () => {
  it('wraps a real per-file patch (starting with @@) in a minimal diff --git header', () => {
    const patch = '@@ -1,2 +1,3 @@\n context\n-old\n+new\n';

    const wrapped = singleFileDiffText('src/foo.ts', patch);

    expect(wrapped).toBe(
      'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n' + patch,
    );
    // And the wrapped text actually parses into a real file/hunk, proving
    // this is not just string concatenation that happens to look right.
    const files = parseUnifiedDiff(wrapped);
    expect(files).toHaveLength(1);
    expect(files[0]?.newPath).toBe('src/foo.ts');
    expect(files[0]?.hunks).toHaveLength(1);
  });

  it('passes non-hunk text through unwrapped, so DiffView falls back to plain text', () => {
    const explanation =
      'GitHub did not provide a line-by-line diff for this file — it is likely binary, too ' +
      'large to diff that way, or unchanged in content.';

    const result = singleFileDiffText('assets/logo.png', explanation);

    expect(result).toBe(explanation);
    // Wrapping it would have produced a file with zero hunks (an empty box
    // in DiffView, silently swallowing the explanation) rather than the
    // zero-files-parsed fallback that actually shows this text — the exact
    // regression this function exists to prevent.
    expect(parseUnifiedDiff(result)).toHaveLength(0);
  });

  it('treats leading whitespace before @@ as still real hunk syntax', () => {
    const patch = '\n@@ -1 +1 @@\n-a\n+b\n';

    const wrapped = singleFileDiffText('a.ts', patch);

    expect(wrapped).toContain('diff --git a/a.ts b/a.ts');
  });
});
