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

import { requireDomainEvent } from './rules/require-domain-event.js';

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

  /* --- Exempt: packages/db, apps/api/src/identity ----------------------- */

  /**
   * `withGlobalScope` runs with NO tenant context, so every RLS policy filters
   * to zero rows. That makes it safe for the genuinely pre-tenant operations —
   * looking a user up by email at login, resolving an invitation — and a trap
   * everywhere else: a query written against a tenant table inside it silently
   * returns nothing, which reads as "no data" rather than "wrong scope".
   *
   * The comment on `withGlobalScope` has claimed this was lint-restricted since
   * it was written. It was not, until the identity slice needed it and the claim
   * was checked. Documented intent is not a guardrail.
   */
  globalScope: {
    selector: "CallExpression[callee.name='withGlobalScope']",
    message: `withGlobalScope has NO tenant context — every RLS policy filters to zero rows. It exists for pre-tenant operations only (login by email, invitation resolution) and is restricted to the identity module. Use withOrgScope. ${ref('§8.3')}`,
  },

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
const TEST_BANS = ['mathRandom', 'bareEnv'];

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

/* ------------------------------------------------------------------------- *
 * Guardrail 7 — cryptography lives in packages/security
 *
 * The `Math.random()` ban above is only half of this one. The other half
 * is the code that reaches for `node:crypto` directly and gets it subtly wrong:
 * an IV that is a counter, a `===` on a token, `createHash('md5')`, a
 * `randomBytes(8)` session id. Every one of those produces working software, so
 * none of them fails a test or looks wrong in a diff.
 *
 * Concentrating the primitives means there is exactly one file to audit per
 * concern, and that file is on the human-review list (§2.2).
 * ------------------------------------------------------------------------- */
const cryptoImportBan = {
  group: ['crypto', 'node:crypto'],
  message: `Cryptographic primitives belong in @taskflow/security, which is reviewed as a security surface. Import what you need from there; if it is missing, add it there. ${ref('§2.1 guardrail 7, §8.4')}`,
};

/* ------------------------------------------------------------------------- *
 * Guardrail 11 — mandatory domain events.
 *
 * Scoped to service files. Repositories, migrations, and seeds mutate without
 * emitting by design, and a rule that fired there would be noise people learn to
 * ignore. See the rule module for what it deliberately cannot check.
 * ------------------------------------------------------------------------- */
const domainEvents = {
  name: 'taskflow/guardrails/domain-events',
  files: ['**/services/**/*.ts', '**/*.service.ts'],
  // A service test constructs mutations to assert on them and emits nothing.
  ignores: ['**/*.test.ts', '**/*.spec.ts'],
  plugins: { taskflow: { rules: { 'require-domain-event': requireDomainEvent } } },
  rules: { 'taskflow/require-domain-event': 'error' },
};

export const security = [
  /* ---------------------------------------------------------------------- *
   * 1. Baseline — all guardrails, all files.
   * ---------------------------------------------------------------------- */
  {
    name: 'taskflow/guardrails/all',
    rules: {
      'no-restricted-syntax': restrictedSyntax(),
      'no-restricted-imports': ['error', { patterns: [...dbImportBans, cryptoImportBan] }],
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
            cryptoImportBan,
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
   * 3. Guardrail 11. Its own rule id, so the exemption blocks below — which
   *    only replace `no-restricted-syntax` — cannot switch it off by accident.
   * ---------------------------------------------------------------------- */
  domainEvents,

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
     protected, not a violator of it. Role comparisons remain banned here.

     Turning the import rule off also permits node:crypto, which the migration
     runner uses to checksum migration files — an integrity check on our own
     source tree, not a security primitive, and nothing @taskflow/security should
     grow an API for. */
  {
    name: 'taskflow/guardrails/exempt-db',
    files: ['packages/db/**'],
    rules: {
      'no-restricted-syntax': restrictedSyntax(...SQL_BANS, 'globalScope'),
      'no-restricted-imports': 'off',
    },
  },

  /* packages/security IS the crypto boundary. Banning node:crypto here would ban
     the module from doing the one job it exists for. Every other guardrail still
     applies — in particular Math.random() stays banned, because "we are the
     crypto package" is not a reason to use a non-cryptographic PRNG. */
  {
    name: 'taskflow/guardrails/exempt-security',
    files: ['packages/security/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: dbImportBans }],
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
      'no-restricted-syntax': restrictedSyntax(...TEST_BANS),
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
      'no-restricted-syntax': restrictedSyntax(...SQL_BANS, 'globalScope', ...TEST_BANS),
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  /* The consumers of withGlobalScope outside the data layer, and why each is
     exempt:

       - apps/api/src/identity/** is the reason it exists: registration, login,
         verification links and refresh exchange all happen before any
         organization is known.
       - apps/api/src/people/** (Phase 11.5) for the identical structural
         reason: `people.profiles` is a non-tenant table (no org_id, no RLS —
         migration 0030's header) whose routes must answer with no org
         selected, the account page.
       - apps/api/src/platform-admin/** (Phase 12 Wave 1) because
         `operator.ts`'s `isPlatformOperator` must run before any org is
         known — the whole point of the operator flag is that it is relative
         to NO org. (The consumer lives in the API layer, not packages/policy,
         for the identical reason people does: `packages/policy` has no
         database dependency.)

     Everything else here — raw SQL, role comparisons, Math.random — stays
     banned for all three paths. This exemption is what the guardrail-selftest's
     computed-config checks on apps/api/src/people/profile.service.ts and
     apps/api/src/platform-admin/org-directory.service.ts prove stays NARROW —
     every other ban still fires there. */
  {
    name: 'taskflow/guardrails/exempt-global-scope-consumers',
    files: ['apps/api/src/identity/**', 'apps/api/src/people/**', 'apps/api/src/platform-admin/**'],
    rules: { 'no-restricted-syntax': restrictedSyntax('globalScope') },
  },
  {
    name: 'taskflow/guardrails/exempt-identity-tests',
    files: ['apps/api/src/identity/**/*.test.ts', 'apps/api/src/identity/**/*.spec.ts'],
    rules: {
      // Integration tests here read the database directly to assert on stored
      // state — that a token column holds a hash and not the token.
      'no-restricted-syntax': restrictedSyntax('globalScope', ...SQL_BANS, ...TEST_BANS),
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  /* Combined exemption for the platform-admin module's OWN test files, for
     exactly the reason the identity one above exists: `exempt-tests` lifts
     `bareEnv` (connection strings) from every test, but the LATER
     `exempt-global-scope-consumers` block — which matches
     `apps/api/src/platform-admin/**`, tests included — re-emits the full ban
     list minus only `globalScope`, REPLACING the tests block's narrower list
     for these files. Without this combined block, the module's own suites
     fail lint on the very `process.env['TEST_DATABASE_*']` fallbacks every
     other integration suite in the repo uses. Same shape as
     `exempt-identity-tests`: globalScope (the suites call withGlobalScope),
     the test bans, and nothing else — raw SQL stays banned here because
     these suites read the database through the AdminConnection, not the `sql`
     tagged template. */
  {
    name: 'taskflow/guardrails/exempt-platform-admin-tests',
    files: ['apps/api/src/platform-admin/**/*.test.ts', 'apps/api/src/platform-admin/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': restrictedSyntax('globalScope', ...TEST_BANS),
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    name: 'taskflow/guardrails/exempt-policy-tests',
    files: ['packages/policy/**/*.test.ts', 'packages/policy/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': restrictedSyntax(...ROLE_BANS, ...TEST_BANS),
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];

export default security;
