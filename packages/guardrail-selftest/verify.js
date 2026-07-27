/**
 * Guardrail self-test harness.
 *
 * Runs ESLint programmatically over src/violations.ts and asserts that EVERY
 * expected guardrail fired. Exits non-zero if any is missing.
 *
 * Why this exists: the guardrails in packages/config/eslint/security.js are the
 * enforcement mechanism for PLAN.md §2. A guardrail that silently stops firing
 * is worse than no guardrail, because the protection is assumed but absent.
 * That is not hypothetical — the first version of security.js lost three
 * guardrails to a flat-config override bug (a later block REPLACES
 * `no-restricted-syntax` rather than merging into it), and this harness is what
 * catches that class of regression.
 *
 * Assertions match on rule id + message substring, deliberately NOT on line
 * numbers: line-anchored assertions break every time someone adds a comment,
 * which trains people to "fix" the harness rather than read it.
 *
 * Run: pnpm --filter @taskflow/guardrail-selftest lint
 */

import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const target = resolve(here, 'src', 'violations.ts');

/** Every guardrail that must fire, and how many times. */
const EXPECTED = [
  {
    label: 'bare process.env',
    rule: 'no-restricted-syntax',
    match: 'Zod-validated schema',
    count: 1,
  },
  {
    label: 'inline role comparison (member + identifier)',
    rule: 'no-restricted-syntax',
    match: 'can() from @taskflow/policy',
    count: 2,
  },
  {
    label: 'raw SQL outside packages/db',
    rule: 'no-restricted-syntax',
    match: 'Raw SQL belongs in packages/db',
    count: 1,
  },
  {
    label: 'innerHTML assignment',
    rule: 'no-restricted-syntax',
    match: 'assigning innerHTML',
    count: 1,
  },
  {
    label: 'Math.random() for security use',
    rule: 'no-restricted-syntax',
    match: 'not cryptographically secure',
    count: 1,
  },
  {
    label: 'dynamic code construction',
    rule: 'no-restricted-syntax',
    match: 'Dynamic code construction',
    count: 1,
  },
  {
    label: 'explicit any',
    rule: '@typescript-eslint/no-explicit-any',
    count: 1,
  },
  {
    label: '@ts-ignore',
    rule: '@typescript-eslint/ban-ts-comment',
    count: 1,
  },
];

const eslint = new ESLint({ cwd: repoRoot });
const [result] = await eslint.lintFiles([target]);

if (!result) {
  console.error(
    'FAIL: ESLint returned no result — is violations.ts being ignored by the root config?',
  );
  process.exit(1);
}

const messages = result.messages;
const failures = [];

for (const expected of EXPECTED) {
  const hits = messages.filter(
    (m) =>
      m.ruleId === expected.rule && (!expected.match || (m.message ?? '').includes(expected.match)),
  );

  if (hits.length === expected.count) {
    console.log(`  ok    ${expected.label}`);
  } else {
    console.error(
      `  FAIL  ${expected.label} — expected ${expected.count} report(s) of ${expected.rule}, got ${hits.length}`,
    );
    failures.push(expected);
  }
}

console.log(`\n${EXPECTED.length - failures.length}/${EXPECTED.length} guardrails firing.`);

if (failures.length > 0) {
  console.error(
    `\nFAIL: ${failures.length} guardrail(s) not firing as specified.\n` +
      `A protection assumed by PLAN.md §2 is absent or has changed shape.\n\n` +
      `Most likely cause: a later flat-config block in\n` +
      `packages/config/eslint/security.js set 'no-restricted-syntax' without\n` +
      `re-emitting the full ban list via restrictedSyntax().\n`,
  );
  console.error('Everything ESLint actually reported:');
  for (const m of messages) {
    console.error(`  line ${String(m.line).padEnd(3)} ${m.ruleId}: ${m.message}`);
  }
  process.exit(1);
}

console.log('PASS: all guardrails firing.\n');
