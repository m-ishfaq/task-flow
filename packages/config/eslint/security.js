/**
 * Architectural guardrails from PLAN.md §2.1, encoded as lint rules.
 *
 * These are not style preferences. Each rule exists because a specific class of
 * security defect is easy to introduce and hard to spot in review — especially
 * in AI-generated code, which is the primary authoring mode for this project
 * (§2). A violation is a build failure, never a warning.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — why this file is structured the way it is
 *
 * In ESLint flat config, a later config block that sets `no-restricted-syntax`
 * REPLACES the option array from earlier blocks; it does not merge them. Naively
 * writing one block per guardrail means only the last block's selectors are ever
 * enforced — silently, with no error.
 *
 * So: every ban is registered in BANS, and each config block emits the COMPLETE
 * list minus whatever that path is exempt from. Exemption blocks must come last.
 * Verified by packages/guardrail-selftest.
 * ---------------------------------------------------------------------------
 *
 * If a rule blocks legitimate work, the fix is to change the architecture or add
 * a narrowly-scoped exemption HERE, with a comment. Never add an inline
 * eslint-disable for these rules.
 */

const ref = (section) => `See PLAN.md ${section}.`;

/* ------------------------------------------------------------------------- *
 * Every ban, keyed so paths can opt out of specific ones.
 * ------------------------------------------------------------------------- */
const BANS = {
  /* --- Always on, everywhere -------------------------------------------- */
  jsxHtml: {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: `XSS: rich text is stored as TipTap JSON and rendered through TipTap, never as raw HTML. ${ref('§8.7')}`,
  },
  innerHtmlAssign: {
    selector: "AssignmentExpression > MemberExpression[property.name='innerHTML']",
    message: `XSS: assigning innerHTML bypasses sanitization. ${ref('§8.7')}`,
  },
  outerHtmlAssign: {
    selector: "AssignmentExpression > MemberExpression[property.name='outerHTML']",
    message: `XSS: assigning outerHTML bypasses sanitization. ${ref('§8.7')}`,
  },
  functionCtor: {
    selector: "NewExpression[callee.name='Function']",
    message: 'Dynamic code construction is banned.',
  },
  evalCall: {
    selector: "CallExpression[callee.name='eval']",
    message: 'Dynamic code construction is banned.',
  },
  mathRandom: {
    // Not cryptographically secure. Tokens, IDs, nonces and secrets must come
    // from @taskflow/security.
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: `Math.random() is not cryptographically secure. Use @taskflow/security for anything security-relevant. ${ref('§8.4')}`,
  },

  /* --- Exempt: config schemas, scripts, build tooling -------------------- */
  bareEnv: {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: `Read env through the Zod-validated schema (config/env.ts) so a missing variable fails at boot, not in a request handler. ${ref('§2.1 guardrail 7, §8.7')}`,
  },

  /* --- Exempt: packages/policy ------------------------------------------ */
  roleMember: {
    selector: "BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name='role']",
    message: `Authorization must go through can() from @taskflow/policy. Inline role comparisons drift from the tested matrix. ${ref('§2.1 guardrail 7, §8.2')}`,
  },
  roleIdentifier: {
    selector: "BinaryExpression[operator=/^[!=]==?$/] > Identifier[name='role']",
    message: `Authorization must go through can() from @taskflow/policy. ${ref('§8.2')}`,
  },
  roleMembership: {
    selector:
      "CallExpression[callee.property.name=/^(includes|indexOf)$/][callee.object.property.name='role']",
    message: `Authorization must go through can() from @taskflow/policy. ${ref('§8.2')}`,
  },

  /* --- Exempt: packages/db ---------------------------------------------- */
  rawSqlTag: {
    selector: "TaggedTemplateExpression[tag.name='sql']",
    message: `Raw SQL belongs in packages/db. Elsewhere it bypasses tenant scoping and is an injection surface. ${ref('§8.3, §8.7')}`,
  },
  rawSqlMember: {
    selector: "TaggedTemplateExpression[tag.object.name='sql']",
    message: `Raw SQL belongs in packages/db. ${ref('§8.3')}`,
  },
};

/** Complete ban list, minus the named exemptions. */
const restrictedSyntax = (...exempt) => [
  'error',
  ...Object.entries(BANS)
    .filter(([key]) => !exempt.includes(key))
    .map(([, ban]) => ban),
];

const ROLE_BANS = ['roleMember', 'roleIdentifier', 'roleMembership'];
const SQL_BANS = ['rawSqlTag', 'rawSqlMember'];

/* ------------------------------------------------------------------------- *
 * Guardrail 2 — no raw database access outside packages/db
 * ------------------------------------------------------------------------- */
const dbImportBans = [
  {
    group: ['@taskflow/db/client', '@taskflow/db/internal', '@taskflow/db/internal/**'],
    message: `Feature code must use the tenant-scoped client: db.forOrg(ctx). The unscoped client bypasses org filtering. ${ref('§2.1 guardrail 2, §8.3')}`,
  },
  {
    group: ['pg', 'postgres', 'drizzle-orm/node-postgres', 'drizzle-orm/postgres-js'],
    message: `Direct driver access bypasses RLS session setup. Import from @taskflow/db instead. ${ref('§8.3')}`,
  },
];

export const security = [
  /* ---------------------------------------------------------------------- *
   * 1. Baseline — all guardrails, all files.
   * ---------------------------------------------------------------------- */
  {
    name: 'taskflow/guardrails/all',
    rules: {
      'no-restricted-syntax': restrictedSyntax(),
      'no-restricted-imports': ['error', { patterns: dbImportBans }],
    },
  },

  /* ---------------------------------------------------------------------- *
   * 2. The browser never talks to the database, and never re-derives
   *    authorization — it consumes can() and the decision trace. Divergence
   *    between UI affordances and server enforcement is a bug factory.
   * ---------------------------------------------------------------------- */
  {
    name: 'taskflow/guardrails/web',
    files: ['apps/web/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...dbImportBans,
            {
              group: ['@taskflow/db', '@taskflow/db/**'],
              message: 'The browser never talks to the database. Use the tRPC client.',
            },
            {
              group: ['@taskflow/policy/internal', '@taskflow/policy/internal/**'],
              message: `The UI consumes can() and the decision trace — never the rule internals. ${ref('§8.2')}`,
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- *
   * EXEMPTIONS — must come last (later config wins).
   * Each re-emits the full ban list minus what that path legitimately needs.
   * ---------------------------------------------------------------------- */

  /* packages/policy is the one place authorization logic may inspect roles. */
  {
    name: 'taskflow/guardrails/exempt-policy',
    files: ['packages/policy/**'],
    rules: { 'no-restricted-syntax': restrictedSyntax(...ROLE_BANS) },
  },

  /* packages/db owns raw SQL (RLS policies, migrations, hand-tuned aggregates)
     AND the driver itself. The import ban exists to stop everyone ELSE from
     reaching past the tenant-scoped client; the data layer is the thing being
     protected, not a violator of it. Role comparisons remain banned here. */
  {
    name: 'taskflow/guardrails/exempt-db',
    files: ['packages/db/**'],
    rules: {
      'no-restricted-syntax': restrictedSyntax(...SQL_BANS),
      'no-restricted-imports': 'off',
    },
  },

  /* The env schema must read process.env — it is what validates it. */
  {
    name: 'taskflow/guardrails/exempt-env',
    files: [
      '**/src/config/env.ts',
      '**/src/config/**',
      '**/*.config.{js,ts,mjs}',
      '**/scripts/**',
      // CLI entry points are process boundaries — reading argv and env is their
      // job, and they run before any validated config exists.
      '**/cli.ts',
      '**/*.cli.ts',
      'packages/config/**',
    ],
    rules: { 'no-restricted-syntax': restrictedSyntax('bareEnv') },
  },

  /* Tests may construct violations deliberately and assert on them, and read
     connection strings for integration fixtures. They must still not compare
     roles or hand-write SQL against tenant tables. */
  {
    name: 'taskflow/guardrails/exempt-tests',
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/__fixtures__/**'],
    rules: {
      'no-restricted-syntax': restrictedSyntax('mathRandom', 'bareEnv'),
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /* ---------------------------------------------------------------------- *
   * COMBINED exemptions — required, not redundant.
   *
   * A file under packages/db that is also a test matches both the db block and
   * the tests block. Because a later block REPLACES `no-restricted-syntax`
   * rather than merging, the tests block would silently re-impose the SQL ban
   * that the db block had just lifted. Overlapping scopes must therefore be
   * spelled out explicitly, with the union of both exemptions.
   *
   * Any new path-scoped exemption needs a matching combined block here for every
   * scope it can overlap with.
   * ---------------------------------------------------------------------- */
  {
    name: 'taskflow/guardrails/exempt-db-tests',
    files: ['packages/db/**/*.test.ts', 'packages/db/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': restrictedSyntax(...SQL_BANS, 'mathRandom', 'bareEnv'),
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    name: 'taskflow/guardrails/exempt-policy-tests',
    files: ['packages/policy/**/*.test.ts', 'packages/policy/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': restrictedSyntax(...ROLE_BANS, 'mathRandom', 'bareEnv'),
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];

/* ------------------------------------------------------------------------- *
 * TODO(0B) — Guardrail 11: mandatory domain events.
 *
 * "A service method that mutates state without emitting a typed event from
 * @taskflow/events fails lint." This needs a custom rule with type information
 * (detect a write through db.forOrg(...) in a function whose body never calls
 * events.emit). Stock selectors cannot express it.
 *
 * Lands in Phase 0B alongside packages/events, as a local plugin at
 * packages/config/eslint/rules/require-domain-event.js.
 * ------------------------------------------------------------------------- */

export default security;
