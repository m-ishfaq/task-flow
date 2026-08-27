#!/usr/bin/env node
/**
 * Fails if apps/mobile's build-time config surface carries a key that is not
 * on an explicit public allowlist.
 *
 * ai/phase-14-mobile.md §10: "A mobile bundle is fully extractable — treat it
 * like published output... anything shipped in the app binary is readable by
 * anyone who downloads it." Two places turn a value into something the app
 * binary carries: `app.config.ts`'s `extra` object (baked into
 * `Constants.expoConfig.extra` at build time) and an `eas.json` build
 * profile's `env` block (set on the EAS builder, and read by `app.config.ts`
 * when it runs there). Everything else in either file stays out of scope —
 * this is not a general secret scanner.
 *
 * This is an ALLOWLIST, not a secret-shape scanner, and that distinction is
 * the point. gitleaks (the `secrets` CI job) already does shape-based
 * detection — AWS keys, PEM blocks, common API-key prefixes — across the
 * WHOLE repo, so a second regex hunting for the same shapes here would add
 * nothing. What shape-based scanning cannot catch is an opaque, unpatterned
 * value with no recognizable shape (a plain UUID-style key, say) sailing
 * through untouched. Asking "is this key allowed to exist here at all"
 * catches that case regardless of what the value looks like — the same
 * closed-list discipline `fields.ts`'s literal map and the rich-text node
 * whitelist already use elsewhere in this codebase.
 *
 * Runs in the FAST, always-on job (alongside check-encoding.mjs), not the
 * tiered `secrets`/`sast` jobs. gitleaks only runs with CI_SECURITY_ALWAYS
 * set, on the weekly schedule, or on manual dispatch (see this workflow's own
 * tiering note) — a check gated the same way would not run on the default
 * path at all, and this one is pure Node with nothing worth saving minutes on.
 *
 * Known scope limit: `extractTopLevelKeys` only distinguishes depth, not
 * string literals — a `{` or `}` inside a quoted value would miscount. Every
 * value in `extra` today is a plain identifier reference (`apiBaseUrl:
 * API_BASE_URL`), never a string containing braces, so this has not been
 * needed. If that ever changes, extend the scanner rather than trust it
 * silently.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

/**
 * Every key `app.config.ts`'s `extra` object may hold. Closed on purpose:
 * adding one is a one-line, reviewed change here, never a silent pass because
 * a new value's shape happened to look innocent.
 */
const ALLOWED_EXTRA_KEYS = new Set([
  'apiBaseUrl',
  // Origin the app's Socket.IO connections dial (config.ts's own header) —
  // same public/private status as apiBaseUrl: an origin, never a credential.
  'realtimeBaseUrl',
  // Origin the app's Hocuspocus (Docs) connection dials — same public/private
  // status as the two above: an origin, never a credential. Added to the
  // allowlist when `collabBaseUrl` entered `extra`; it had been slipping past
  // unlisted because it is written inside a `...(cond ? {} : { ... })` spread,
  // which the extractor now reads (see extractTopLevelKeys).
  'collabBaseUrl',
  // The EAS project linkage (app.config.ts's own comment) — a public project
  // id, not a credential; `eas.projectId` is a NAMED nested object, so only
  // the `eas` key itself is in scope here (extractTopLevelKeys treats a named
  // object's interior as opaque).
  'eas',
]);

/** Every env key any `eas.json` build profile may set. Same discipline. */
const ALLOWED_EAS_ENV_KEYS = new Set(['MOBILE_API_BASE_URL', 'MOBILE_REALTIME_BASE_URL']);

/** @type {string[]} */
const failures = [];

/**
 * Is the `{` at `braceIdx` a NAMED nested object (`key: { ... }`, whose
 * interior keys are that object's own business) or a TRANSPARENT one (an
 * empty `{}` or a `{ ... }` appearing inside a `...(cond ? {} : { ... })`
 * spread, whose keys land in the PARENT object and therefore count)?
 *
 * The distinction is the whole reason a spread-nested key was slipping
 * through: `...(X ? {} : { collabBaseUrl: X })` puts `collabBaseUrl` into
 * `extra`, but that key lives one brace deep, so a plain depth===1 test never
 * saw it. The rule: a `{` is named ONLY when a bare identifier immediately
 * precedes its colon (`eas:`). A `{` preceded by `?`, `:` after a `}`/`)`, or
 * anything that is not `identifier:` is transparent.
 *
 * @param {string} text
 * @param {number} braceIdx
 * @returns {boolean} true when keys inside this brace count as the parent's.
 */
function isTransparentBrace(text, braceIdx) {
  let j = braceIdx - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  // Not `... : {` at all (e.g. `? {`, `=> {`, `({`) → transparent.
  if (j < 0 || text[j] !== ':') return true;
  // It is `... : {`. Named only if a bare identifier precedes the colon;
  // a ternary colon is preceded by `}`/`)`/an identifier that is not a key.
  j -= 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  return !(j >= 0 && /[A-Za-z0-9_$]/.test(text[j]));
}

/**
 * Finds `label:` followed by a `{`, then returns every key that lands in that
 * object — its own direct keys AND keys contributed by a conditional spread
 * (`...(cond ? {} : { key: val })`), but never a key belonging to a NAMED
 * nested object (`eas: { projectId }`), whose interior is that object's
 * business, not `extra`'s.
 *
 * A naive `/extra:\s*\{([^}]*)\}/` stops at the first `}`; a plain depth===1
 * test descends correctly but misses the spread case above — a key added as
 * `...(X ? {} : { newKey: X })` sits one brace deep and sailed past the
 * allowlist unchecked. `isTransparentBrace` is what tells the two shapes of
 * `{` apart so a spread-contributed key is treated as top-level and a truly
 * nested object's keys are not.
 *
 * Scope limit unchanged: this counts braces, not string literals — a `{`,
 * `}`, or `:` inside a quoted value would still miscount. Every value in
 * `extra` today is a plain identifier reference or a `...(ternary)`, never a
 * string containing braces; extend this rather than trust it silently if that
 * changes.
 *
 * @param {string} text
 * @param {string} label
 * @returns {string[] | null} null when `label:` was not found at all.
 */
function extractTopLevelKeys(text, label) {
  const labelIndex = text.indexOf(`${label}:`);
  if (labelIndex === -1) return null;

  const braceIndex = text.indexOf('{', labelIndex);
  if (braceIndex === -1) return null;

  /** @type {string[]} */
  const keys = [];
  /* One boolean per open brace: does a key at this level count as `extra`'s?
     The root brace (`extra`'s own) does; a named nested object's does not; a
     spread's transparent `{}` does. */
  /** @type {boolean[]} */
  const transparent = [];
  let i = braceIndex;

  for (; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') {
      transparent.push(transparent.length === 0 ? true : isTransparentBrace(text, i));
      continue;
    }
    if (char === '}') {
      transparent.pop();
      if (transparent.length === 0) break;
      continue;
    }
    // A key counts only when the innermost enclosing brace is transparent.
    if (transparent[transparent.length - 1] === true) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
      if (match !== null) {
        const rest = text.slice(i + match[0].length);
        if (/^\s*:/.test(rest)) keys.push(match[0]);
        i += match[0].length - 1;
      }
    }
  }

  return transparent.length === 0 ? keys : null;
}

function checkAppConfig() {
  const relPath = 'apps/mobile/app.config.ts';
  const text = readFileSync(resolve(root, relPath), 'utf8');
  const keys = extractTopLevelKeys(text, 'extra');

  if (keys === null) {
    failures.push(
      `${relPath}: could not find a complete "extra: { ... }" block. If the ` +
        `config's shape changed, update scripts/check-mobile-bundle-secrets.mjs ` +
        `rather than letting this pass unchecked.`,
    );
    return;
  }

  for (const key of keys) {
    if (!ALLOWED_EXTRA_KEYS.has(key)) {
      failures.push(
        `${relPath}: "extra.${key}" is not on the allowed list ` +
          `(${[...ALLOWED_EXTRA_KEYS].join(', ')}). Everything under "extra" ships ` +
          `inside the app binary and is readable by anyone who downloads it (§10) — add ` +
          `it to ALLOWED_EXTRA_KEYS in this script only if it is genuinely public.`,
      );
    }
  }
}

function checkEasJson() {
  const relPath = 'apps/mobile/eas.json';
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(root, relPath), 'utf8'));
  } catch {
    failures.push(`${relPath}: not valid JSON.`);
    return;
  }

  const build =
    typeof parsed === 'object' && parsed !== null && 'build' in parsed
      ? /** @type {Record<string, unknown>} */ (parsed)['build']
      : undefined;
  if (typeof build !== 'object' || build === null) return;

  for (const [profile, config] of Object.entries(build)) {
    if (typeof config !== 'object' || config === null) continue;
    const env = /** @type {Record<string, unknown>} */ (config)['env'];
    if (typeof env !== 'object' || env === null) continue;

    for (const key of Object.keys(env)) {
      if (!ALLOWED_EAS_ENV_KEYS.has(key)) {
        failures.push(
          `${relPath}: build.${profile}.env.${key} is not on the allowed list ` +
            `(${[...ALLOWED_EAS_ENV_KEYS].join(', ')}). Every profile's "env" is set on ` +
            `the EAS builder and baked into the built app (§10) — add it to ` +
            `ALLOWED_EAS_ENV_KEYS in this script only if it is genuinely public.`,
        );
      }
    }
  }
}

checkAppConfig();
checkEasJson();

if (failures.length === 0) {
  console.log('mobile bundle config: clean — every embedded key is on the public allowlist.');
  process.exit(0);
}

console.error(
  `FAIL: ${String(failures.length)} disallowed key(s) in apps/mobile's build config:\n`,
);
for (const failure of failures) {
  console.error(`  - ${failure}`);
}
console.error(
  `\nEverything in apps/mobile/app.config.ts's "extra" object and every eas.json build ` +
    `profile's "env" block ships inside the app binary and is readable by anyone who ` +
    `downloads it (ai/phase-14-mobile.md §10). A secret belongs server-side, never here.`,
);
process.exit(1);
