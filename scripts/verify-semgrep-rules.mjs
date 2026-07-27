#!/usr/bin/env node
/**
 * Proves the custom Semgrep rules in .semgrep/ actually fire.
 *
 * Same reasoning as packages/guardrail-selftest: a security rule that silently
 * matches nothing is worse than no rule, because the protection is assumed but
 * absent (PLAN.md 2.3). Three separate rules in this project have already been
 * caught doing exactly that during Phase 0A.
 *
 * Runs the rules against .semgrep/fixtures/, which is deliberately wrong, and
 * asserts every expected rule id appears. Also asserts the REAL migrations
 * produce no findings, so the rules are not merely matching everything.
 *
 * Usage: node scripts/verify-semgrep-rules.mjs
 * Requires Docker (CI runs semgrep directly in a container instead).
 */

import { spawnSync } from 'node:child_process';

/** Rules that must fire on the bad fixture. */
const EXPECTED_ON_FIXTURE = [
  'tenant-table-without-force-rls',
  'rls-policy-without-nullif',
  'rls-policy-without-with-check',
];

const useDocker = process.env.SEMGREP_IN_CONTAINER !== '1';

const command = useDocker ? 'docker' : 'semgrep';
const args = useDocker
  ? [
      'run',
      '--rm',
      '-v',
      `${process.cwd()}:/src`,
      '-w',
      '/src',
      'semgrep/semgrep',
      'semgrep',
      'scan',
      '--config',
      '.semgrep/taskflow.yml',
      '--metrics=off',
      '--no-git-ignore',
      '--json',
    ]
  : ['scan', '--config', '.semgrep/taskflow.yml', '--metrics=off', '--no-git-ignore', '--json'];

const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

if (result.error) {
  console.error(`Failed to run semgrep: ${result.error.message}`);
  process.exit(1);
}

// Strip a UTF-8 BOM and any leading non-JSON noise before the first '{'.
const raw = (result.stdout ?? '').replace(/^﻿/, '');
const start = raw.indexOf('{');
if (start === -1) {
  console.error('No JSON in semgrep output.\n' + (result.stderr ?? '').slice(0, 2000));
  process.exit(1);
}

/** @type {{ results: Array<{ check_id: string, path: string }> }} */
const report = JSON.parse(raw.slice(start));

const ruleId = (checkId) => checkId.split('.').pop();

const onFixture = new Set(
  report.results.filter((r) => r.path.includes('fixtures')).map((r) => ruleId(r.check_id)),
);

const onRealMigrations = report.results.filter((r) => r.path.includes('packages/db/migrations'));

let failed = false;

for (const rule of EXPECTED_ON_FIXTURE) {
  if (onFixture.has(rule)) {
    console.log(`  ok    ${rule}`);
  } else {
    console.error(`  MISS  ${rule} — did not fire on the deliberately-bad fixture`);
    failed = true;
  }
}

// A rule that flags correct code is just as broken as one that flags nothing:
// it trains people to ignore the scanner.
if (onRealMigrations.length > 0) {
  console.error(`\n  FALSE POSITIVE — ${onRealMigrations.length} finding(s) on real migrations:`);
  for (const r of onRealMigrations) {
    console.error(`    ${r.path}: ${ruleId(r.check_id)}`);
  }
  failed = true;
} else {
  console.log('  ok    no false positives on real migrations');
}

console.log(
  `\n${EXPECTED_ON_FIXTURE.length - (failed ? 1 : 0)}/${EXPECTED_ON_FIXTURE.length} rules verified.`,
);

if (failed) {
  console.error('\nFAIL: custom Semgrep rules are not behaving as specified.');
  console.error('All findings reported:');
  for (const r of report.results) {
    console.error(`  ${r.path}: ${ruleId(r.check_id)}`);
  }
  process.exit(1);
}

console.log('PASS: all custom Semgrep rules fire correctly.\n');
