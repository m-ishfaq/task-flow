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
 *
 * Runs semgrep via Docker locally. Set SEMGREP_ON_PATH=1 when semgrep is already
 * installed (as CI does) to invoke it directly instead.
 */

import { spawnSync } from 'node:child_process';

/**
 * Rules that must fire on the bad fixtures.
 *
 * `global-scope-outside-identity` was added here after it was found to have been
 * mis-scoped since the day it was written: its exclusion list named two paths
 * that never existed, so it reported every legitimate call in the identity
 * module and caught nothing.
 *
 * It is the only entry now. The three SQL RLS rules moved to
 * scripts/check-migration-rls.mjs — generic mode could not correlate a
 * CREATE TABLE with an ALTER ... FORCE far below it, and they had been reporting
 * every real tenant migration as a violation since Phase 2. That script runs the
 * same two directions this one does.
 *
 * The lesson generalizes: every custom rule belongs in a list like this,
 * including the ones that look too simple to break.
 */
const EXPECTED_ON_FIXTURE = ['global-scope-outside-identity'];

const useDocker = process.env.SEMGREP_ON_PATH !== '1';

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

/**
 * Real code that must produce NO findings.
 *
 * The identity module is here because it is the legitimate home of
 * withGlobalScope, and a scope rule pointed at the wrong directory reports every
 * call in it. That is not a harmless false positive: a rule that flags correct
 * code is one that gets muted, and a muted rule protects nothing.
 */
const CLEAN_PATHS = ['packages/db/migrations', 'apps/api/src/identity'];

const falsePositives = report.results.filter((r) => {
  const normalized = r.path.split('\\').join('/');
  return CLEAN_PATHS.some((clean) => normalized.includes(clean));
});

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
if (falsePositives.length > 0) {
  console.error(`\n  FALSE POSITIVE — ${falsePositives.length} finding(s) on correct code:`);
  for (const r of falsePositives) {
    console.error(`    ${r.path}: ${ruleId(r.check_id)}`);
  }
  failed = true;
} else {
  console.log('  ok    no false positives on real migrations or the identity module');
}

const verified = EXPECTED_ON_FIXTURE.filter((rule) => onFixture.has(rule)).length;
console.log(`\n${verified}/${EXPECTED_ON_FIXTURE.length} rules verified.`);

if (failed) {
  console.error('\nFAIL: custom Semgrep rules are not behaving as specified.');
  console.error('All findings reported:');
  for (const r of report.results) {
    console.error(`  ${r.path}: ${ruleId(r.check_id)}`);
  }
  process.exit(1);
}

console.log('PASS: all custom Semgrep rules fire correctly.\n');
