#!/usr/bin/env node
/**
 * Fails if any tracked text file has a UTF-8 BOM or CRLF line endings.
 *
 * This is not cosmetic. A BOM in package.json breaks `JSON.parse` in tools that
 * read it directly — pnpm/action-setup crashed the entire CI run with
 * `SyntaxError: Unexpected token '﻿'`, and the message points at JSON
 * syntax rather than at an invisible three-byte prefix, so it costs real time to
 * diagnose.
 *
 * The BOM is easy to introduce on Windows without noticing: PowerShell 5.1's
 * `Set-Content -Encoding utf8` and `Out-File -Encoding utf8` both write UTF-8
 * WITH a BOM. Anything writing files in this repo from PowerShell should use
 * `-Encoding ascii`, redirect through Node, or use an editor — but the reliable
 * fix is this check, not remembering.
 *
 * CRLF matters for the same reason: a `run: |` block in a workflow, or any .sh
 * file, fails in bash with `$'\r': command not found`. `.gitattributes` forces
 * LF in the repository, and this check catches anything that slips past it.
 *
 * MOJIBAKE is the third case, and the sneakiest, because the result is still
 * *valid* — just wrong. `Set-Content -Encoding ascii` silently replaces every
 * non-ASCII character with `?` (so `§8.3` becomes `??8.3`), and reading UTF-8 as
 * latin1 produces the classic `â€"` sequences. Neither has a BOM, neither has
 * CRLF, and both pass every other check while quietly destroying documentation
 * that references spec sections. Detected here, NOT auto-fixed: repairing it
 * requires knowing what the original character was.
 *
 * Usage:
 *   node scripts/check-encoding.mjs          # report and fail
 *   node scripts/check-encoding.mjs --fix    # strip BOMs + normalize CRLF
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', 'coverage']);

/**
 * Files exempt from the MOJIBAKE check only (BOM and CRLF still apply).
 *
 * This file documents what mojibake looks like, so it necessarily contains the
 * very byte sequences it searches for. Without this exemption the checker
 * reports itself, forever.
 */
const MOJIBAKE_EXEMPT = new Set(['scripts/check-encoding.mjs']);

/** Binary formats where a leading 0xEF 0xBB 0xBF is not a BOM. */
const BINARY_EXT =
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|node|wasm|tsbuildinfo)$/i;

const fix = process.argv.includes('--fix');
const root = process.cwd();

/** @type {{ file: string, issues: string[] }[]} */
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (BINARY_EXT.test(entry.name)) continue;

    let buffer = readFileSync(full);
    const issues = [];

    const hasBom =
      buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    if (hasBom) {
      issues.push('BOM');
      buffer = buffer.subarray(3);
    }

    const hasCrlf = buffer.includes('\r\n');
    if (hasCrlf) {
      issues.push('CRLF');
      buffer = Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    }

    // Mojibake — detected but never auto-fixed, since recovering the original
    // character requires knowing what it was.
    const relPath = relative(root, full).split('\\').join('/');
    const text = buffer.toString('utf8');
    let mojibake = false;

    if (MOJIBAKE_EXEMPT.has(relPath)) {
      if (issues.length > 0) {
        offenders.push({ file: relPath, issues, mojibake: false });
        if (fix) writeFileSync(full, buffer);
      }
      continue;
    }

    // U+FFFD is unambiguous: a decoder already gave up on these bytes.
    if (text.includes('\uFFFD')) mojibake = true;

    // UTF-16 BOMs (FF FE / FE FF). A UTF-16 file read as UTF-8 is unusable, and
    // the UTF-8 BOM check above does not see these — different byte sequence.
    if (
      buffer.length >= 2 &&
      ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
    ) {
      mojibake = true;
    }

    // UTF-8 bytes decoded as latin1/cp1252 — the classic "â€"" family.
    if (/â€[™]|Ã[©¨¼]|Â[§°±]/.test(text)) {
      mojibake = true;
    }

    // Lossy ASCII conversion: `§8.3` -> `??8.3`, `—` -> `???`.
    // Restricted to prose-bearing files: `??` is the nullish-coalescing operator
    // in TypeScript, so flagging it there would be pure false positives.
    if (/\.(ya?ml|md|sql|json)$/i.test(entry.name)) {
      if (/\?{3,}/.test(text) || /\?\?\d/.test(text)) mojibake = true;
    }

    if (mojibake) issues.push('MOJIBAKE');

    if (issues.length > 0) {
      offenders.push({ file: relative(root, full), issues, mojibake });
      // Never rewrite a mojibake file: stripping a BOM from corrupted content
      // would report success while leaving the real damage in place.
      if (fix && !mojibake) writeFileSync(full, buffer);
    }
  }
}

walk(root);

if (offenders.length === 0) {
  console.log('encoding: clean — no BOMs, no CRLF, no mojibake.');
  process.exit(0);
}

const corrupted = offenders.filter((o) => o.mojibake);

for (const { file, issues, mojibake } of offenders) {
  const status = mojibake ? 'CORRUPT' : fix ? 'fixed  ' : 'BAD    ';
  console.error(`  ${status}  ${file}  (${issues.join(', ')})`);
}

if (fix && corrupted.length === 0) {
  console.log(`\nNormalized ${String(offenders.length)} file(s).`);
  process.exit(0);
}

if (corrupted.length > 0) {
  console.error(
    `\nFAIL: ${String(corrupted.length)} file(s) contain mojibake — corrupted characters.\n` +
      `NOT auto-fixable: the original characters cannot be recovered mechanically.\n` +
      `Inspect each file and restore the intended characters by hand.\n\n` +
      `Cause: the file was written with a lossy encoding. On Windows PowerShell,\n` +
      `\`Set-Content -Encoding ascii\` replaces every non-ASCII character with '?'\n` +
      `(so '§8.3' becomes '??8.3'), and reading UTF-8 as latin1 yields 'â€"'.\n\n` +
      `Do not write repository files from PowerShell. Use an editor, or Node:\n` +
      `  node -e "require('fs').writeFileSync('path', content, 'utf8')"\n`,
  );
  process.exit(1);
}

console.error(
  `\nFAIL: ${String(offenders.length)} file(s) have encoding problems.\n` +
    `Run: node scripts/check-encoding.mjs --fix\n\n` +
    `Most likely cause: the file was written by PowerShell using\n` +
    `\`Set-Content -Encoding utf8\` or \`Out-File -Encoding utf8\`, which emit a BOM\n` +
    `on Windows PowerShell 5.1, and CRLF line endings by default.\n`,
);
process.exit(1);
