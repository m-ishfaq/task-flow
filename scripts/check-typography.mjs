#!/usr/bin/env node
/**
 * The type-scale guard (UI/UX redesign — Phase 0).
 *
 * The redesign's single biggest lever is one enforced type scale. Past passes
 * migrated some call sites and then drifted straight back: arbitrary
 * `text-[11px]` re-appeared because nothing failed when someone wrote it. This
 * script is that missing failure.
 *
 * Two rules, one per platform:
 *
 *   - apps/web    — no arbitrary `text-[Npx]` in any .ts/.tsx. Use the stock
 *                   Tailwind rung (see primitives.tsx's own scale contract).
 *                   The ONE documented exception, `.data-table`'s 13px, lives
 *                   in styles.css, which this script does not scan.
 *   - apps/mobile — every numeric `fontSize:` literal must be one of the scale
 *                   sizes below. A `fontSize` that reads from a token
 *                   (`typography.body`) carries no literal and is never flagged.
 *
 * Wiring: created in Phase 0 so it exists and can be run (`pnpm check:typography`)
 * while the migration (Phase 2) drives the count to zero. It is added to the
 * `verify` gate only once that migration lands, so a half-migrated tree does not
 * turn every CI run red. Until then it fails loudly on its own so the count is
 * visible.
 *
 * Usage:
 *   node scripts/check-typography.mjs           # report and fail on any violation
 *   node scripts/check-typography.mjs --summary # print only the totals
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const summaryOnly = process.argv.includes('--summary');

const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', 'coverage', '.expo']);

/** The mobile type scale (`packages/tokens/src/typography.ts`'s `typeScale`). */
const MOBILE_SCALE = new Set([12, 13, 14, 15, 16, 18, 20, 24, 28]);

/** `text-[16px]`, `text-[11.5px]` — an arbitrary pixel font size on the web. */
const WEB_ARBITRARY = /text-\[\d+(?:\.\d+)?px\]/g;
/** A numeric `fontSize:` literal in a React Native style. */
const MOBILE_FONT_SIZE = /fontSize:\s*(\d+(?:\.\d+)?)/g;

const CODE_EXT = /\.(?:ts|tsx)$/;

/** @type {{ file: string, hits: string[] }[]} */
const offenders = [];

function walk(dir, kind) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, kind);
      continue;
    }
    if (!CODE_EXT.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;

    const text = readFileSync(full, 'utf8');
    const hits = [];

    if (kind === 'web') {
      for (const match of text.matchAll(WEB_ARBITRARY)) hits.push(match[0]);
    } else {
      for (const match of text.matchAll(MOBILE_FONT_SIZE)) {
        const value = Number(match[1]);
        if (!MOBILE_SCALE.has(value)) hits.push(`fontSize: ${match[1]}`);
      }
    }

    if (hits.length > 0) {
      offenders.push({ file: relative(root, full).split('\\').join('/'), hits });
    }
  }
}

function safeWalk(dir, kind) {
  try {
    walk(dir, kind);
  } catch {
    // A directory that does not exist in this checkout (e.g. running from a
    // partial tree) is not a failure — there is simply nothing to check there.
  }
}

safeWalk(join(root, 'apps', 'web', 'src'), 'web');
safeWalk(join(root, 'apps', 'mobile', 'app'), 'mobile');
safeWalk(join(root, 'apps', 'mobile', 'src'), 'mobile');

const total = offenders.reduce((sum, o) => sum + o.hits.length, 0);

if (total === 0) {
  console.log('typography: clean — every size is on the scale.');
  process.exit(0);
}

if (!summaryOnly) {
  for (const { file, hits } of offenders) {
    console.error(`  ${file}  (${hits.length})`);
    const shown = [...new Set(hits)].slice(0, 8).join(', ');
    console.error(`      ${shown}${hits.length > 8 ? ' …' : ''}`);
  }
  console.error('');
}

console.error(
  `FAIL: ${String(total)} off-scale type size(s) across ${String(offenders.length)} file(s).\n` +
    `Web: replace text-[Npx] with a stock rung (text-xs/sm/base/xl/2xl) — see\n` +
    `apps/web/src/components/primitives.tsx's scale contract.\n` +
    `Mobile: use a size from {12,13,14,15,16,18,20,24,28}, ideally via a\n` +
    `typography token.`,
);
process.exit(1);
