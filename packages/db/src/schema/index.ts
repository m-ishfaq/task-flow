/**
 * Table definitions, re-exported as one namespace so call sites read
 * `schema.users` rather than importing from a dozen files.
 *
 * Added per phase:
 *   Phase 1  identity  — users, sessions, refresh tokens, one-time links  ✅
 *   Phase 1  identity  — passkeys: WebAuthn credentials and challenges     ✅
 *   Phase 2  identity  — orgs, memberships, teams;  authz — relationship tuples
 *   Phase 3  work      — projects, boards, lists, cards
 */

export * from './identity.js';
export * from './webauthn.js';
