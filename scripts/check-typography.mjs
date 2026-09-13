#!/usr/bin/env node
/**
 * Fails if a file under `apps/web/src` introduces MORE arbitrary Tailwind
 * font-size literals (`text-[11px]`, `text-[10.5px]`, ...) than a checked-in
 * baseline already records for it.
 *
 * This is the "Fill all design inconsistencies" ledger's single biggest
 * finding, found independently twice (a codebase audit and the Design
 * Bible's own review agreed to the instance: 356/84 occurrences of
 * `text-[11px]`/`text-[10px]`, ~495 total across every arbitrary size).
 * `primitives.tsx` and most of the app use the ordinary Tailwind scale
 * (`text-xs`, `text-sm`, `text-base`, ...); a `text-[Npx]` literal is
 * always someone reaching PAST that scale for a size that was never given
 * a name — a "micro" size that got invented ad hoc, file by file, rather
 * than added to the scale once. The fix for the *existing* 495 is a real,
 * multi-file cleanup pass; the fix for it never coming back is this file.
 *
 * ## Why a per-file COUNT baseline, not a per-line one
 *
 * A per-line baseline (`file:line`) goes stale the instant someone edits
 * unrelated code above an existing violation — the line number shifts, the
 * baseline no longer matches, and the check reports a "new" violation that
 * is actually the same one it already knew about. That trains people to
 * ignore this check's own output, which is worse than not having it.
 *
 * A per-file violation COUNT is stable against that: editing code elsewhere
 * in a flagged file doesn't change how many `text-[Npx]` literals it
 * contains. The check fails only when a file's count goes UP from what the
 * baseline recorded — a genuinely new arbitrary size, either in a file that
 * had none before or one more in a file that already had some. A file
 * fixed down to fewer violations (or zero) passes trivially; the baseline
 * is not required to shrink to match, so partial cleanup of a large file
 * never has to happen in one sitting to stay green.
 *
 * ## Updating the baseline
 *
 * `node scripts/check-typography.mjs --update-baseline` regenerates
 * `scripts/typography-baseline.json` from the CURRENT count in every file —
 * run this after a cleanup pass that reduces (or, for a genuinely new,
 * deliberate exception, increases) a file's count, so the ratchet only
 * ever tightens on purpose, never by someone editing the baseline by hand.
 *
 * Usage:
 *   node scripts/check-typography.mjs                  # report and fail
 *   node scripts/check-typography.mjs --update-baseline # regenerate the baseline
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const SCAN_ROOT = join(root, 'apps/web/src');
const BASELINE_PATH = join(root, 'scripts/typography-baseline.json');

const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', 'coverage']);
const SCAN_EXT = /\.(tsx?|jsx?)$/;

/**
 * `text-[11px]`, `text-[10.5px]`, `text-[11rem]` (unlikely but caught the
 * same way), and the `hover:`/`sm:`/etc.-prefixed forms Tailwind's variant
 * syntax produces (`hover:text-[11px]`) — the prefix is optional in the
 * pattern so both match. Deliberately NOT matching `text-[var(--...)]` or
 * `text-[length:...]` — an arbitrary value that names a real CSS variable
 * or an explicit unit keyword is a different, less common shape this
 * codebase's own audit did not find any instances of; scoping tightly to
 * the actual epidemic (a bare pixel/rem/em number) avoids false positives
 * on a shape nobody has actually written.
 */
const ARBITRARY_FONT_SIZE = /(?:^|[\s"'`{])(?:[\w-]+:)*text-\[[0-9]+(?:\.[0-9]+)?(?:px|rem|em)\]/g;

const updateBaseline = process.argv.includes('--update-baseline');

/** @type {Record<string, number>} */
const counts = {};

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!SCAN_EXT.test(entry.name)) continue;

    const text = readFileSync(full, 'utf8');
    const matches = text.match(ARBITRARY_FONT_SIZE);
    if (matches === null || matches.length === 0) continue;

    const relPath = relative(root, full).split('\\').join('/');
    counts[relPath] = matches.length;
  }
}

if (!existsSync(SCAN_ROOT)) {
  console.error(`FAIL: expected ${relative(root, SCAN_ROOT)} to exist.`);
  process.exit(1);
}

walk(SCAN_ROOT);

if (updateBaseline) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(
    `Wrote ${relative(root, BASELINE_PATH)}: ${String(Object.keys(sorted).length)} file(s), ${String(total)} arbitrary font-size literal(s) total.`,
  );
  process.exit(0);
}

/** @type {Record<string, number>} */
let baseline = {};
if (existsSync(BASELINE_PATH)) {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} else {
  console.error(
    `FAIL: ${relative(root, BASELINE_PATH)} does not exist.\n` +
      `Run: node scripts/check-typography.mjs --update-baseline`,
  );
  process.exit(1);
}

/** @type {{ file: string, was: number, now: number }[]} */
const regressions = [];

for (const [file, now] of Object.entries(counts)) {
  const was = baseline[file] ?? 0;
  if (now > was) regressions.push({ file, was, now });
}

if (regressions.length === 0) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(
    `typography: clean — no new arbitrary text-[Npx] literals (${String(total)} pre-existing, tracked in the baseline).`,
  );
  process.exit(0);
}

console.error(
  `FAIL: ${String(regressions.length)} file(s) gained a new arbitrary text-[Npx] size not in the baseline:\n`,
);
for (const { file, was, now } of regressions) {
  console.error(`  ${file}  (was ${String(was)}, now ${String(now)})`);
}
console.error(
  `\nUse the standard scale instead (text-xs/sm/base, or a named token) — see\n` +
    `styles.css's own type-scale comment and primitives.tsx for the sizes this\n` +
    `app already has names for. If this is a deliberate, reviewed exception,\n` +
    `run: node scripts/check-typography.mjs --update-baseline\n`,
);
process.exit(1);
