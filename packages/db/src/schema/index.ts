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
 *   Phase 11.5 people  — profiles, membership_profiles                        ✅
 *   Phase 7  comms     — subaccounts, spend policy + ledger, webhook nonces   ✅
 *   Phase 13 rtc       — in-app voice sessions, participants, TURN issuance    ✅
 *   Phase 8  search    — the cross-product documents projection               ✅
 *   Phase 12 billing   — Wave 3: customer_orgs, webhook_events                ✅
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
export * from './people.js';
export * from './comms.js';
export * from './rtc.js';
export * from './search.js';
export * from './billing.js';
export * from './analytics.js';
