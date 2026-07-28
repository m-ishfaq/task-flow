/**
 * GUARDRAIL SELF-TEST — every line below is a deliberate violation.
 *
 * This file exists to prove the guardrails in
 * packages/config/eslint/security.js actually fire. Running `pnpm lint` here
 * MUST report one error per numbered case. If a case stops reporting, a
 * guardrail has silently broken.
 *
 * Phase 0B replaces this with an assertion harness that runs ESLint
 * programmatically and asserts the exact rule/line set, so a broken guardrail
 * fails CI instead of merely producing fewer errors.
 */

/* 10 — reaching for node:crypto outside packages/security (guardrail 5 / §8.4).
   Placed here because import declarations must lead the module; the assertion
   for it lives with the others in verify.js. */
import { randomBytes } from 'node:crypto';

interface Membership {
  role: string;
  orgId: string;
}

declare const membership: Membership;
// Structural type rather than HTMLElement — this package targets Node (no DOM lib),
// and the selector fires on the syntax, not the type.
declare const el: { innerHTML: string };
declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;

/* 1 — bare process.env (guardrail 7) */
export const dbUrl = process.env['DATABASE_URL'];

/* 2 — inline role comparison via member access (guardrail 7 / §8.2) */
export const isAdminA = membership.role === 'admin';

/* 3 — inline role comparison via bare identifier (guardrail 7 / §8.2) */
export function checkRole(role: string): boolean {
  return role === 'owner';
}

/* 4 — raw SQL outside packages/db (guardrail 7 / §8.3) */
export const rows = sql`SELECT * FROM work.cards WHERE org_id = ${membership.orgId}`;

/* 5 — innerHTML assignment (XSS / §8.7) */
export function render(): void {
  el.innerHTML = '<b>unsafe</b>';
}

/* 6 — Math.random() for anything security-adjacent (§8.4) */
export const token = Math.random().toString(36);

/* 7 — dynamic code construction */
export const evil = new Function('return 1');

/* 8 — explicit any (guardrail 7) */
export function loose(input: any): unknown {
  return input;
}

/* 9 — ts-ignore (guardrail 7) */
// @ts-ignore
export const bad: number = 'not a number';

/* 10 — hand-rolled crypto: an 8-byte session token is 64 bits, and the ban is
   what stops this being written at all (see the import above). */
export const weakSessionId = randomBytes(8).toString('hex');

/* 11 — withGlobalScope outside the identity module (§8.3).
   Runs with no tenant context, so a query against a tenant table inside it
   returns zero rows — which reads as "no data", not "wrong scope". */
declare const withGlobalScope: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;

export const unscoped = withGlobalScope(async () => Promise.resolve([]));
