#!/usr/bin/env node
/**
 * Proves every tenant table in a migration is actually protected by RLS.
 *
 * Enforces three invariants over packages/db/migrations (PLAN.md 8.3):
 *
 *   1. force-rls        a table with an org_id column has ENABLE *and* FORCE
 *                       ROW LEVEL SECURITY. ENABLE alone does not constrain the
 *                       table OWNER, which is taskflow_migrator.
 *   2. policy-nullif    an RLS predicate casts through NULLIF. A bare
 *                       current_setting('app.x', true)::uuid raises 22P02 on an
 *                       empty context — a 500 — instead of matching zero rows.
 *   3. policy-with-check a policy that can WRITE defines WITH CHECK, not just
 *                       USING. USING alone lets a caller insert rows stamped
 *                       with another org's id: invisible to them, present in the
 *                       victim's data.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SEMGREP RULE
 *
 * It was, and it was broken for four phases without anyone noticing.
 *
 * All three invariants are CORRELATIONS between statements that sit far apart in
 * a file: a CREATE TABLE here, its ALTER ... FORCE eighty lines below. Semgrep's
 * generic mode expresses that as `pattern-not-inside: ... FORCE ROW LEVEL
 * SECURITY ...`, whose ellipsis has a bounded line span — so the suppression
 * silently stops applying once a CREATE TABLE block grows past it. The rules
 * were written and verified during Phase 1, when the only migrations that
 * existed were identity tables with no org_id column at all. Every tenant
 * migration since (0004 onward) reported a false positive, and the security jobs
 * are tiered off by default, so nothing ran to say so.
 *
 * A rule that flags correct code is not a weaker control but a negative one: it
 * trains people to mute the scanner. Parsing the statements and pairing them by
 * table name is exact, has no span limit, and can express the one legitimate
 * exemption below that Semgrep could only ever report as noise.
 *
 * ---------------------------------------------------------------------------
 * THE EXEMPTION THAT MATTERS
 *
 * A FOR SELECT or FOR DELETE policy has no WITH CHECK, and cannot: Postgres
 * rejects the syntax outright, because neither command writes a row to check.
 * memberships_self_read and orgs_self_read (0004) are exactly this, and their
 * being read-only IS the safety argument documented in CLAUDE.md — a permissive
 * WITH CHECK on user_id would let any caller insert a membership naming
 * themselves as owner of any org. Flagging them asks for the vulnerability.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND EXEMPTION, AND WHY IT IS NARROW BY CONSTRUCTION
 *
 * Phase 7 added one table that genuinely has an org_id and genuinely must not
 * have RLS: comms.subaccount_orgs, the carrier-SID -> org lookup an inbound
 * webhook needs BEFORE it can open a scope (ai/phase-7-voice.md 3.11). RLS on
 * it would make the pre-tenant read it exists for return zero rows, which is
 * the whole chicken-and-egg the table resolves.
 *
 * An exemption that is just a name on a list rots: the table gets a column, the
 * column holds something sensitive, and the entry that was safe when written is
 * now a hole nobody rechecks. So RLS_EXEMPT does not name tables, it names
 * tables AND their complete permitted column set. Adding any column not on that
 * list makes this checker fire again — which is exactly what should happen if
 * somebody decides the auth token would be handy to keep alongside the mapping.
 *
 * Usage: node scripts/check-migration-rls.mjs
 *
 * Runs both directions, like packages/guardrail-selftest: the real migrations
 * must be clean, AND the deliberately-wrong fixture must trip all three rules.
 * A checker that has stopped firing looks exactly like a codebase with no
 * defects (PLAN.md 2.3).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'packages/db/migrations';
const FIXTURE = '.semgrep/fixtures/bad_migration.up.sql';

/**
 * Tables with an org_id that deliberately have no RLS, and the COMPLETE set of
 * columns each is allowed to carry.
 *
 * See "THE SECOND EXEMPTION" above. The column list is the control: a table on
 * this list that grows a column outside its set is reported as
 * `rls-exempt-table-grew-a-column`, because the argument for exempting it was
 * always "it holds nothing worth protecting", and that argument expires the
 * moment it holds something.
 */
const RLS_EXEMPT = new Map([
  [
    'comms.subaccount_orgs',
    {
      columns: new Set(['subaccount_sid', 'org_id']),
      why: 'Pre-tenant webhook lookup (ai/phase-7-voice.md §3.11). RLS here would make the read it exists for return zero rows. Holds no secrets — see migration 0032.',
    },
  ],
]);

/**
 * Removes comments and string literals, replacing each with equal-length
 * whitespace so byte offsets — and therefore reported line numbers — still line
 * up with the original file.
 *
 * Not cosmetic. These migrations discuss "FORCE ROW LEVEL SECURITY" and
 * "WITH CHECK" at length in their comment blocks, including in prose explaining
 * what would happen WITHOUT them. Matching on raw text lets a comment satisfy
 * the check that the SQL below it fails — the exact inversion of the control.
 */
function blankNonCode(sql) {
  const out = Array.from(sql);
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      let end = i;
      while (end < sql.length && sql[end] !== '\n') end += 1;
      blank(i, end);
      i = end;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      let end = i + 2;
      while (end < sql.length && !(sql[end] === '*' && sql[end + 1] === '/')) end += 1;
      blank(i, end + 2);
      i = end + 1;
    } else if (sql[i] === "'") {
      let end = i + 1;
      // '' is an escaped quote inside a literal, not the end of one.
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") end += 2;
        else if (sql[end] === "'") break;
        else end += 1;
      }
      // The literal's CONTENT is blanked; the quotes stay, so patterns that
      // match a specific literal (NULLIF's empty string) can still be written
      // against the structure around it.
      blank(i + 1, end);
      i = end;
    }
  }

  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Scans from an opening parenthesis to its match, ignoring blanked content. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

const qualify = (schema, table) => `${(schema ?? 'public').toLowerCase()}.${table.toLowerCase()}`;

/**
 * Analyzes one SET of files together.
 *
 * Correlation is across the set rather than per file so a migration may add a
 * table and a later one harden it — the expand-migrate-contract pattern this
 * project uses. Per-file was what Semgrep did and would reject a legitimate
 * two-step change.
 */
function analyze(files) {
  const findings = [];
  const tables = [];
  const forced = new Set();
  const enabled = new Set();

  for (const { path, raw } of files) {
    const sql = blankNonCode(raw);

    const createTable =
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:([a-z_][a-z0-9_$]*)\s*\.\s*)?([a-z_][a-z0-9_$]*)\s*\(/gi;
    for (const m of sql.matchAll(createTable)) {
      const open = m.index + m[0].length - 1;
      const columns = sql.slice(open, matchParen(sql, open));
      if (!/\borg_id\b/i.test(columns)) continue;
      tables.push({ name: qualify(m[1], m[2]), path, line: lineOf(sql, m.index), columns });
    }

    const alter =
      /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:([a-z_][a-z0-9_$]*)\s*\.\s*)?([a-z_][a-z0-9_$]*)\s+(FORCE|ENABLE)\s+ROW\s+LEVEL\s+SECURITY/gi;
    for (const m of sql.matchAll(alter)) {
      const name = qualify(m[1], m[2]);
      (m[3].toUpperCase() === 'FORCE' ? forced : enabled).add(name);
    }

    // A correct predicate reads NULLIF(current_setting('app.x', true), '')::uuid,
    // where ::uuid applies to NULLIF's closing paren. This matches only the form
    // where the cast hangs directly off current_setting — i.e. no NULLIF at all.
    const bareCast = /current_setting\s*\(\s*'[^']*'\s*(?:,\s*[a-z]+\s*)?\)\s*::\s*uuid/gi;
    for (const m of sql.matchAll(bareCast)) {
      findings.push({
        rule: 'rls-policy-without-nullif',
        path,
        line: lineOf(sql, m.index),
        message:
          "RLS predicate casts current_setting directly to uuid. An empty setting raises 22P02 (a 500) instead of matching zero rows. Use NULLIF(current_setting('app.org_id', true), '')::uuid.",
      });
    }

    if (!path.endsWith('.up.sql')) continue;

    const createPolicy =
      /\bCREATE\s+POLICY\s+([a-z_][a-z0-9_$]*)\s+ON\s+(?:([a-z_][a-z0-9_$]*)\s*\.\s*)?([a-z_][a-z0-9_$]*)/gi;
    for (const m of sql.matchAll(createPolicy)) {
      const end = sql.indexOf(';', m.index);
      const body = sql.slice(m.index, end === -1 ? sql.length : end);
      const command = (
        /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(body)?.[1] ?? 'ALL'
      ).toUpperCase();

      // See "THE EXEMPTION THAT MATTERS" above — Postgres rejects WITH CHECK on
      // these, so requiring it would demand code that does not compile.
      if (command === 'SELECT' || command === 'DELETE') continue;
      if (!/\bUSING\s*\(/i.test(body)) continue;
      if (/\bWITH\s+CHECK\s*\(/i.test(body)) continue;

      findings.push({
        rule: 'rls-policy-without-with-check',
        path,
        line: lineOf(sql, m.index),
        message: `Policy ${m[1]} (FOR ${command}) defines USING but not WITH CHECK, so cross-tenant WRITES are still possible.`,
      });
    }
  }

  for (const table of tables) {
    const exemption = RLS_EXEMPT.get(table.name);

    if (exemption !== undefined) {
      /* The exemption is bounded by its column set, not by its name. An exempt
         table that grows a column was exempted on an argument — "it holds
         nothing worth protecting" — that no longer holds. */
      const declared = columnNames(table.columns);
      const extra = declared.filter((name) => !exemption.columns.has(name));

      if (extra.length > 0) {
        findings.push({
          rule: 'rls-exempt-table-grew-a-column',
          path: table.path,
          line: table.line,
          message: `${table.name} is RLS-exempt (${exemption.why}) but now declares ${extra.join(', ')}, which is outside its permitted column set. Either drop the column, or remove the exemption and give the table real RLS.`,
        });
      }
      continue;
    }

    const missing = [
      enabled.has(table.name) ? '' : 'ENABLE',
      forced.has(table.name) ? '' : 'FORCE',
    ].filter(Boolean);
    if (missing.length === 0) continue;

    findings.push({
      rule: 'tenant-table-without-force-rls',
      path: table.path,
      line: table.line,
      message: `${table.name} has an org_id column but never applies ${missing.join(' or ')} ROW LEVEL SECURITY. ENABLE alone does not constrain the table owner (taskflow_migrator). Use tenantRlsPolicy() from @taskflow/db.`,
    });
  }

  return findings;
}

/**
 * Column names from a CREATE TABLE body.
 *
 * Only the leading identifier of each top-level, comma-separated clause counts,
 * and table CONSTRAINT clauses are skipped — otherwise `CONSTRAINT foo CHECK
 * (...)` would read as a column named "constraint" and every exempt table would
 * appear to have grown one.
 */
function columnNames(body) {
  const names = [];
  let depth = 0;
  let current = '';

  for (const char of body.slice(1)) {
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }

    if (char === ',' && depth === 0) {
      pushColumn(names, current);
      current = '';
    } else {
      current += char;
    }
  }
  pushColumn(names, current);
  return names;
}

function pushColumn(names, clause) {
  const first = clause.trim().split(/\s+/)[0]?.toLowerCase();
  if (first === undefined || first.length === 0) return;
  // Table-level constraints are not columns.
  if (['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like'].includes(first)) {
    return;
  }
  names.push(first.replace(/["']/g, ''));
}

const read = (path) => ({ path, raw: readFileSync(path, 'utf8') });

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => read(join(MIGRATIONS_DIR, f)));

const EXPECTED_ON_FIXTURE = [
  'tenant-table-without-force-rls',
  'rls-policy-without-nullif',
  'rls-policy-without-with-check',
  'rls-exempt-table-grew-a-column',
];

let failed = false;

// Direction 1: the checker still fires. A guardrail that has quietly stopped
// matching is indistinguishable from clean code, which is how the Semgrep
// version of this went four phases without protecting anything.
const onFixture = new Set(analyze([read(FIXTURE)]).map((f) => f.rule));
for (const rule of EXPECTED_ON_FIXTURE) {
  if (onFixture.has(rule)) {
    console.log(`  ok    ${rule}`);
  } else {
    console.error(`  MISS  ${rule} — did not fire on ${FIXTURE}`);
    failed = true;
  }
}

// Direction 2: it fires only on real defects.
const real = analyze(migrations);
if (real.length === 0) {
  console.log(`  ok    no findings across ${String(migrations.length)} migration files`);
} else {
  console.error(`\n  ${String(real.length)} finding(s) in ${MIGRATIONS_DIR}:\n`);
  for (const f of real) {
    console.error(`    ${f.path}:${String(f.line)}  ${f.rule}`);
    console.error(`      ${f.message}\n`);
  }
  failed = true;
}

console.log(`\n${String(EXPECTED_ON_FIXTURE.length)} RLS invariants checked.`);

if (failed) {
  console.error('\nFAIL: migration RLS invariants are not satisfied.');
  process.exit(1);
}

console.log('PASS: every tenant table forces RLS, with NULLIF and WITH CHECK.\n');
