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

/* -------------------------------------------------------------------------- *
 * apps/web — asserted on the COMPUTED CONFIG rather than on a fixture
 *
 * The fixtures above prove the rules fire where they are linted. They cannot
 * prove anything about apps/web, because a fixture there would have to live
 * inside the app's own source tree, be type-checked by the app's tsconfig, and
 * be skipped by the app's own `eslint src` — three ways for the test to quietly
 * stop being run.
 *
 * The computed config answers the question directly, and it is the RIGHT
 * question: the failure this file exists to catch is a flat-config block that
 * REPLACES `no-restricted-syntax` instead of merging into it, which is exactly
 * what happens if the React block in eslint.config.js ever grows a
 * `no-restricted-syntax` of its own. That would silently disarm every guardrail
 * for the only app that renders HTML — including the XSS ban, which is the one
 * that matters most there.
 * -------------------------------------------------------------------------- */

const WEB_FILE = resolve(repoRoot, 'apps', 'web', 'src', 'main.tsx');
const webConfig = await eslint.calculateConfigForFile(WEB_FILE);

/** Substrings that must appear in the effective ban list for apps/web. */
const WEB_SYNTAX_BANS = [
  ['XSS: rich text is stored as TipTap JSON', 'dangerouslySetInnerHTML'],
  ['assigning innerHTML', 'innerHTML assignment'],
  ['not cryptographically secure', 'Math.random()'],
  ['Zod-validated schema', 'bare process.env'],
  ['can() from @taskflow/policy', 'inline role comparison'],
];

const WEB_IMPORT_BANS = [
  ['The browser never talks to the database', '@taskflow/db import'],
  ['Cryptographic primitives belong in @taskflow/security', 'node:crypto import'],
];

const webFailures = [];

const syntaxRule = webConfig.rules?.['no-restricted-syntax'] ?? [];
const syntaxText = JSON.stringify(syntaxRule);

for (const [needle, label] of WEB_SYNTAX_BANS) {
  if (syntaxText.includes(needle)) {
    console.log(`  ok    apps/web keeps the ${label} ban`);
  } else {
    console.error(`  FAIL  apps/web LOST the ${label} ban`);
    webFailures.push(label);
  }
}

const importRule = webConfig.rules?.['no-restricted-imports'] ?? [];
const importText = JSON.stringify(importRule);

for (const [needle, label] of WEB_IMPORT_BANS) {
  if (importText.includes(needle)) {
    console.log(`  ok    apps/web keeps the ${label} ban`);
  } else {
    console.error(`  FAIL  apps/web LOST the ${label} ban`);
    webFailures.push(label);
  }
}

/* And that the React rules are actually attached — a `files` glob that stops
   matching would disable the accessibility rules with no error anywhere, and
   the keyboard path through the kanban board is the thing they protect. */
if (webConfig.rules?.['react-hooks/rules-of-hooks'] !== undefined) {
  console.log('  ok    apps/web has the React rules attached');
} else {
  console.error(
    '  FAIL  apps/web is missing the React rules — check the files glob in eslint.config.js',
  );
  webFailures.push('react rules');
}

if (webFailures.length > 0) {
  console.error(
    `\nFAIL: apps/web lost ${webFailures.length} guardrail(s).\n` +
      `Most likely cause: a config block scoped to apps/web set 'no-restricted-syntax'\n` +
      `or 'no-restricted-imports' without re-emitting the full list. Flat config\n` +
      `REPLACES these options rather than merging them.\n`,
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- *
 * The people module's withGlobalScope exemption — asserted on the computed
 * config, the same way apps/web's bans are.
 *
 * Phase 11.5 added apps/api/src/people/** to the globalScope exemption for the
 * identical structural reason the identity module holds it: people.profiles is
 * a non-tenant table reached by routes that must answer with no org selected
 * (security.js's own comment). The fixture above cannot test this — a fixture
 * outside those paths proves nothing about the exemption's BREADTH. The
 * computed config answers the question that matters: the exemption must strip
 * withGlobalScope AND NOTHING ELSE. If a later edit copied the whole
 * restrictedSyntax list into the exemption block, role comparisons and raw SQL
 * would silently stop being banned in the people module — the exact shape of
 * guardrail drift this harness exists to catch.
 * -------------------------------------------------------------------------- */

const PEOPLE_FILE = resolve(repoRoot, 'apps', 'api', 'src', 'people', 'profile.service.ts');
const peopleConfig = await eslint.calculateConfigForFile(PEOPLE_FILE);
const peopleSyntaxText = JSON.stringify(peopleConfig.rules?.['no-restricted-syntax'] ?? []);

const PEOPLE_SYNTAX_BANS = [
  ['can() from @taskflow/policy', 'inline role comparison'],
  ['Raw SQL belongs in packages/db', 'raw SQL'],
  ['not cryptographically secure', 'Math.random()'],
  ['Zod-validated schema', 'bare process.env'],
];

const peopleFailures = [];
for (const [needle, label] of PEOPLE_SYNTAX_BANS) {
  if (peopleSyntaxText.includes(needle)) {
    console.log(`  ok    people module keeps the ${label} ban`);
  } else {
    console.error(`  FAIL  people module LOST the ${label} ban`);
    peopleFailures.push(label);
  }
}

if (peopleFailures.length > 0) {
  console.error(
    `\nFAIL: the people module's globalScope exemption is wider than intended — ` +
      `${peopleFailures.length} guardrail(s) stopped firing there.\n` +
      `Most likely cause: the exemption block in packages/config/eslint/security.js\n` +
      `re-emitted restrictedSyntax() with fewer exemptions instead of listing the\n` +
      `full ban set.\n`,
  );
  process.exit(1);
}

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
