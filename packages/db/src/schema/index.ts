/**
 * Table definitions, re-exported as one namespace so call sites read
 * `schema.users` rather than importing from a dozen files.
 *
 * Added per phase:
 *   Phase 1  identity  — users, sessions, refresh tokens, one-time links  ✅
 *   Phase 1  identity  — passkeys: WebAuthn credentials and challenges     ✅
 *   Phase 2  identity  — orgs, memberships, teams;  authz — relationship tuples ✅
 *   Phase 2  platform  — transactional outbox;  audit — hash-chained log      ✅
 *   Phase 3  work      — projects, boards, lists, cards                       ✅
 *   Phase 5  chat      — channels, channel members, messages                  ✅
 *   Phase 6  docs      — spaces, pages (Wave 1: tree only, no body yet)       ✅
 */

export * from './identity.js';
export * from './webauthn.js';
export * from './tenancy.js';
export * from './authz.js';
export * from './platform.js';
export * from './audit.js';
export * from './work.js';
export * from './chat.js';
export * from './docs.js';
