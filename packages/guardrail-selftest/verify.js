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

/**
 * Fixtures. Guardrail 11 needs its own because the rule is scoped to service
 * files, and a fixture in the wrong path would report nothing while looking
 * exactly like a passing test.
 */
const FIXTURES = {
  general: resolve(here, 'src', 'violations.ts'),
  service: resolve(here, 'src', 'violations.service.ts'),
};

/**
 * Every guardrail that must fire, and how many times.
 *
 * `fixture` defaults to `general`. Counts are exact, not minimums: guardrail 11's
 * fixture contains three CLEAN cases alongside its one violation, so a rule that
 * became over-eager would push the count above 1 and fail here — which matters
 * as much as it firing at all, because a guardrail that reports correct code is
 * one that gets switched off.
 */
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
    label: 'node:crypto imported outside packages/security',
    rule: 'no-restricted-imports',
    match: 'Cryptographic primitives belong in @taskflow/security',
    count: 1,
  },
  {
    label: 'withGlobalScope outside the identity module',
    rule: 'no-restricted-syntax',
    match: 'withGlobalScope has NO tenant context',
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
  {
    label: 'state mutation with no domain event (guardrail 11)',
    rule: 'taskflow/require-domain-event',
    match: 'emits no domain event',
    count: 1,
    fixture: 'service',
  },
];

const eslint = new ESLint({ cwd: repoRoot });

/** Messages per fixture, so one fixture's reports cannot satisfy another's. */
const reported = {};

for (const [name, file] of Object.entries(FIXTURES)) {
  const [result] = await eslint.lintFiles([file]);

  if (!result) {
    console.error(`FAIL: ESLint returned no result for ${name} — is the fixture being ignored?`);
    process.exit(1);
  }
  reported[name] = result.messages;
}

const failures = [];

for (const expected of EXPECTED) {
  const messages = reported[expected.fixture ?? 'general'] ?? [];
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
  for (const [name, messages] of Object.entries(reported)) {
    console.error(`  ${name}:`);
    for (const m of messages) {
      console.error(`    line ${String(m.line).padEnd(3)} ${m.ruleId}: ${m.message}`);
    }
  }
  process.exit(1);
}

console.log('PASS: all guardrails firing.\n');
