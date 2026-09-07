import { Fragment } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * A real diff viewer for `get_pr_diff`'s result — found necessary from a
 * direct report that the previous rendering (the raw unified-diff TEXT in
 * one `<pre>` block, no color, no per-file structure) was "very tricky to
 * read... not presentable." GitHub's own diff view is the reference point:
 * a header per file, additions and deletions colored distinctly, hunk
 * boundaries marked, everything monospace and left-aligned so column
 * position still means something.
 *
 * `parseUnifiedDiff` is exported and pure specifically so it can be tested
 * directly against real diff text, the same "test the pure half" split
 * `markdown-lite.tsx`'s own header already establishes for this feature —
 * a unified diff has enough edge cases (renames, binary files, a file with
 * no trailing newline) that eyeballing the component's output is not
 * enough to trust the parser.
 *
 * This is NOT a syntax highlighter — no per-language tokenizing, just the
 * diff's own +/-/context structure. `get_pr_diff`'s own `MAX_DIFF_CHARS`
 * truncation can cut a diff off mid-hunk; a trailing partial line is
 * rendered as plain context rather than dropped, since showing a truncated
 * line is more honest than silently losing it.
 */

export interface DiffLine {
  readonly kind: 'add' | 'del' | 'context';
  readonly text: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly oldPath: string;
  readonly newPath: string;
  /** Derived from the `--- `/`+++ ` lines: `/dev/null` on either side means
      the file was added or deleted; a differing old/new path (with neither
      `/dev/null`) means a rename. `'modified'` is the default when neither
      applies. */
  readonly status: 'added' | 'deleted' | 'renamed' | 'modified';
  readonly hunks: readonly DiffHunk[];
}

function stripPrefix(path: string): string {
  // `a/foo.ts` / `b/foo.ts` -> `foo.ts`; git's own prefixes, always present
  // on a real GitHub diff, but stripped defensively rather than assumed.
  return path.replace(/^[ab]\//, '');
}

function statusOf(oldPath: string, newPath: string): DiffFile['status'] {
  if (oldPath === '/dev/null') return 'added';
  if (newPath === '/dev/null') return 'deleted';
  if (oldPath !== newPath) return 'renamed';
  return 'modified';
}

/**
 * Parses unified diff text (as `get_pr_diff` returns it — GitHub's own
 * `.diff` media type) into structured files/hunks/lines. Never throws: an
 * unrecognized line inside a hunk is treated as context rather than
 * aborting the whole parse, since a diff cut off mid-hunk by
 * `MAX_DIFF_CHARS` truncation is a real, expected input, not malformed one.
 */
export function parseUnifiedDiff(text: string): readonly DiffFile[] {
  const files: DiffFile[] = [];
  let currentFile: { oldPath: string; newPath: string; hunks: DiffHunk[] } | null = null;
  let currentHunk: { header: string; lines: DiffLine[] } | null = null;

  const pushFile = () => {
    if (currentFile === null) return;
    if (currentHunk !== null) {
      currentFile.hunks.push(currentHunk);
      currentHunk = null;
    }
    files.push({ ...currentFile, status: statusOf(currentFile.oldPath, currentFile.newPath) });
    currentFile = null;
  };

  // `text.split('\n')` puts one spurious trailing '' at the end whenever
  // `text` itself ends with a newline (the common case for real diff text) —
  // dropped once, up front, so it never reaches the loop as a fake blank
  // context line. A genuine blank line elsewhere in the diff has no such
  // artifact and is preserved untouched.
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushFile();
      currentFile = { oldPath: '', newPath: '', hunks: [] };
      continue;
    }
    if (currentFile === null) continue; // text before the first `diff --git` (there is none in practice)

    if (line.startsWith('--- ')) {
      currentFile.oldPath = stripPrefix(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('+++ ')) {
      currentFile.newPath = stripPrefix(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@')) {
      if (currentHunk !== null) currentFile.hunks.push(currentHunk);
      currentHunk = { header: line, lines: [] };
      continue;
    }
    if (currentHunk === null) continue; // file metadata lines (index, mode, etc.) — nothing to show

    if (line.startsWith('+')) {
      currentHunk.lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ kind: 'del', text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — a real diff annotation, not a content line.
      continue;
    } else {
      currentHunk.lines.push({
        kind: 'context',
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  }
  pushFile();

  return files;
}

const STATUS_LABEL: Readonly<Record<DiffFile['status'], string>> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'modified',
};

function DiffFileView({ file }: { readonly file: DiffFile }) {
  const title =
    file.status === 'renamed'
      ? `${file.oldPath} → ${file.newPath}`
      : file.status === 'deleted'
        ? file.oldPath
        : file.newPath;

  return (
    <div className="overflow-hidden rounded-md border border-line/60">
      <div className="flex items-center gap-2 border-b border-line/60 bg-surface-sunken/60 px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{title}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
          {STATUS_LABEL[file.status]}
        </span>
      </div>
      <div className="max-h-72 overflow-auto">
        {file.hunks.map((hunk, hunkIndex) => (
          <Fragment key={hunkIndex}>
            <div className="bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent">
              {hunk.header}
            </div>
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={cn(
                  'whitespace-pre-wrap px-2 font-mono text-[11px] leading-relaxed',
                  line.kind === 'add' && 'bg-success/10 text-success',
                  line.kind === 'del' && 'bg-danger/10 text-danger',
                  line.kind === 'context' && 'text-ink-muted',
                )}
              >
                <span className="select-none opacity-60">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                </span>
                {line.text}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function DiffView({
  diff,
  truncated,
}: {
  readonly diff: string;
  readonly truncated: boolean;
}) {
  const files = parseUnifiedDiff(diff);

  // A diff `get_pr_diff` could not parse at all (a shape this parser does
  // not recognize) still shows SOMETHING rather than nothing — the raw
  // text, exactly what the old renderer always showed, as a fallback.
  if (files.length === 0) {
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink">
        {diff}
      </pre>
    );
  }

  return (
    <div className="space-y-2">
      {files.map((file, index) => (
        <DiffFileView key={`${file.oldPath}->${file.newPath}-${String(index)}`} file={file} />
      ))}
      {truncated && <p className="text-[11px] text-warning">Diff truncated.</p>}
    </div>
  );
}
