#!/usr/bin/env node
/**
 * Pre-push preflight — validates everything CI will check, locally, in one run.
 *
 * Written after four consecutive CI runs each failed on a DIFFERENT unvalidated
 * assumption (a guessed action version, a container without Node, an arbitrary
 * Node pin below a dependency's engine floor, and a BOM written by PowerShell).
 * Each was individually cheap to fix and collectively expensive, because each
 * needed its own push to discover.
 *
 * The lesson is not "be more careful" — it is that anything CI checks should be
 * checkable locally in one command. Add a check here whenever CI grows one.
 *
 * Usage: node scripts/preflight.mjs
 * Requires: Docker running (Postgres for db tests, images for scanners).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const results = [];
let failed = 0;

/** Runs a command, records pass/fail, never throws. */
function check(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: options.shell ?? false,
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
  });

  const ok = result.status === 0;
  results.push({ label, ok, detail: ok ? '' : summarize(result) });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  return ok;
}

/** Records a check evaluated in-process. */
function assert(label, ok, detail = '') {
  results.push({ label, ok, detail });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  return ok;
}

function summarize(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error) return result.error.message;
  return text.split('\n').slice(-12).join('\n');
}

console.log('\n── Static file integrity ' + '─'.repeat(30));

check('encoding (no BOM, no CRLF)', 'node', ['scripts/check-encoding.mjs']);

// Every JSON file must parse. A BOM in package.json already broke CI once, and
// the resulting error pointed at JSON syntax rather than at the byte prefix.
const jsonFiles = [
  'package.json',
  'tsconfig.json',
  'turbo.json',
  '.github/dependabot.yml',
  'packages/config/package.json',
  'packages/db/package.json',
  'packages/db/tsconfig.json',
  'packages/observability/package.json',
  'packages/feature-flags/package.json',
  'packages/guardrail-selftest/package.json',
].filter((f) => f.endsWith('.json'));

let jsonOk = true;
const jsonErrors = [];
for (const file of jsonFiles) {
  if (!existsSync(file)) {
    jsonOk = false;
    jsonErrors.push(`${file}: missing`);
    continue;
  }
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    jsonOk = false;
    jsonErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
assert(`JSON parses (${String(jsonFiles.length)} files)`, jsonOk, jsonErrors.join('\n'));

// Every YAML file must parse, and the workflow must have the structure GitHub
// expects. A malformed workflow does not fail loudly — GitHub may simply not run
// it, which looks identical to "CI passed" on a quiet branch.
const yamlFiles = [
  '.github/workflows/ci.yml',
  '.github/dependabot.yml',
  'compose.yaml',
  'pnpm-workspace.yaml',
  ...readdirSync('.semgrep')
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join('.semgrep', f)),
];

let yamlOk = true;
const yamlErrors = [];
/** @type {Record<string, unknown>} */
let ciWorkflow = {};

for (const file of yamlFiles) {
  if (!existsSync(file)) {
    yamlOk = false;
    yamlErrors.push(`${file}: missing`);
    continue;
  }
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8'));
    if (file.endsWith('ci.yml')) ciWorkflow = parsed;
  } catch (error) {
    yamlOk = false;
    yamlErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
assert(`YAML parses (${String(yamlFiles.length)} files)`, yamlOk, yamlErrors.join('\n'));

// Structural sanity on the workflow: jobs exist, each declares a runner, and
// every `if:` gate references a variable name that actually exists in the
// documented set (a typo'd `vars.CI_DISABLE` would silently never match, which
// reads as "the toggle does not work" long after it was added).
const jobs = /** @type {Record<string, { 'runs-on'?: string, if?: string }>} */ (
  ciWorkflow.jobs ?? {}
);
const jobNames = Object.keys(jobs);
const KNOWN_VARS = new Set(['CI_DISABLED', 'CI_SECURITY_ALWAYS']);
const varRefs = [...JSON.stringify(jobs).matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]);
const unknownVars = [...new Set(varRefs)].filter((v) => !KNOWN_VARS.has(v));
const missingRunner = jobNames.filter((n) => !jobs[n]?.['runs-on']);

assert(
  `workflow structure (${String(jobNames.length)} jobs, toggles valid)`,
  jobNames.length > 0 && missingRunner.length === 0 && unknownVars.length === 0,
  [
    missingRunner.length ? `jobs without runs-on: ${missingRunner.join(', ')}` : '',
    unknownVars.length ? `unknown repo variables referenced: ${unknownVars.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
);

// Node version pins must agree with each other AND with the running runtime.
// A mismatch here is what silently dropped rolldown's native binding in CI.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const nodeVersionFile = readFileSync('.node-version', 'utf8').trim();
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const ciNode = /NODE_VERSION:\s*'([^']+)'/.exec(workflow)?.[1] ?? '';
const enginesFloor = pkg.engines?.node ?? '';

const major = (v) => Number(v.split('.')[0]);
const minor = (v) => Number(v.split('.')[1] ?? '0');
const floorParts = /(\d+)\.(\d+)/.exec(enginesFloor);
const meetsFloor = (v) => {
  if (!floorParts) return false;
  const fMaj = Number(floorParts[1]);
  const fMin = Number(floorParts[2]);
  return major(v) > fMaj || (major(v) === fMaj && minor(v) >= fMin);
};

assert(
  `Node pins agree (.node-version=${nodeVersionFile}, ci=${ciNode}, engines=${enginesFloor})`,
  nodeVersionFile === ciNode && meetsFloor(ciNode) && meetsFloor(process.version.slice(1)),
  `.node-version=${nodeVersionFile} ci=${ciNode} engines=${enginesFloor} running=${process.version}`,
);

// Marketplace actions are the one thing that cannot be validated offline, so
// keep the surface to first-party actions on major tags. Two third-party pins
// (osv-scanner-action@v1, trivy-action@0.28.0) failed to resolve on first run;
// those scanners now run as pinned Docker images instead.
const actions = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
const allowedOwners = ['actions/', 'pnpm/'];
const unvetted = actions.filter((a) => !allowedOwners.some((o) => a.startsWith(o)));
assert(
  `workflow uses only first-party actions (${String(actions.length)} refs)`,
  unvetted.length === 0,
  unvetted.length ? `third-party actions cannot be verified locally: ${unvetted.join(', ')}` : '',
);

console.log('\n── Correctness ' + '─'.repeat(40));

check('prettier format', 'pnpm', ['format:check'], { shell: true });
check('lint + typecheck + test', 'pnpm', ['verify'], { shell: true });

console.log('\n── Security gates ' + '─'.repeat(37));

check('guardrail self-test (ESLint rules fire)', 'node', ['packages/guardrail-selftest/verify.js']);
check('semgrep custom rules fire', 'node', ['scripts/verify-semgrep-rules.mjs']);
check('dependency audit', 'pnpm', ['audit', '--audit-level', 'high'], { shell: true });

console.log('\n── Database ' + '─'.repeat(43));

check(
  'migrations reversible (up->down->up)',
  'pnpm',
  ['--filter', '@taskflow/db', 'migrate:verify'],
  { shell: true },
);

// Container-based scanners are slow (Trivy pulls a vulnerability DB, gitleaks
// walks history), so they are opt-in rather than part of the normal loop. Run
// `--full` before a push that changes dependencies, workflows, or anything a
// scanner reads. These use the exact commands and pinned image tags CI uses.
if (process.argv.includes('--full')) {
  console.log('\n── Container scanners (--full) ' + '─'.repeat(24));

  const workspace = process.cwd();

  check('gitleaks (secret scan over history)', 'docker', [
    'run',
    '--rm',
    '-v',
    `${workspace}:/repo`,
    'zricethezav/gitleaks:v8.21.2',
    'detect',
    '--source=/repo',
    '--redact',
  ]);

  check('trivy (vuln + secret scan)', 'docker', [
    'run',
    '--rm',
    '-v',
    `${workspace}:/repo`,
    'aquasec/trivy:0.58.1',
    'fs',
    '/repo',
    '--scanners',
    'vuln,secret',
    '--severity',
    'HIGH,CRITICAL',
    '--exit-code',
    '1',
    '--ignore-unfixed',
    '--no-progress',
    '--quiet',
  ]);

  check('semgrep (full ruleset)', 'docker', [
    'run',
    '--rm',
    '-v',
    `${workspace}:/src`,
    '-w',
    '/src',
    'semgrep/semgrep',
    'semgrep',
    'scan',
    '--config',
    'p/typescript',
    '--config',
    'p/security-audit',
    '--config',
    'p/secrets',
    '--config',
    '.semgrep/taskflow.yml',
    '--exclude',
    '.semgrep/fixtures',
    '--error',
    '--skip-unknown-extensions',
    '--metrics=off',
  ]);
} else {
  console.log('\n(skipping container scanners — rerun with --full to include them)');
}

console.log('\n' + '─'.repeat(64));

if (failed > 0) {
  console.log(`\n${String(results.length - failed)}/${String(results.length)} checks passed.\n`);
  console.log('Failures:\n');
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`── ${r.label}`);
    console.log(r.detail ? `${r.detail}\n` : '(no output)\n');
  }
  process.exit(1);
}

console.log(`\nAll ${String(results.length)} checks passed. Safe to push.\n`);
