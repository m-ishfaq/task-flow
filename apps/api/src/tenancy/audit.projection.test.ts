import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registeredEvents, type AnyEventDefinition } from '@taskflow/events';
import { RESOURCE_TYPES } from '@taskflow/policy';
import { NEVER_AUDITED, RESOURCE_OF } from './audit.projection.js';

/* Registration is a side effect of importing the slice that OWNS the events —
   `packages/events`' registry is deliberately not a central list (its own
   header explains why), so the only way to ask "what does this system emit"
   is to load every owner. A slice added in a later phase and not imported
   here is invisible to every assertion below, which is the one way this file
   can rot; the import list is therefore the thing to update when a new slice
   grows its own `events.ts`. */
import './events.js';
import '../identity/events.js';
/* Added in Phase 12 Wave 2. Its absence was a real coverage hole, not a
   deliberate omission: none of the platform-admin events had ever been
   checked by the accounting test below, despite the module having existed
   since Wave 1 — the test can only account for events that something has
   imported, so a missing line here reads as "all accounted for". */
import '../platform-admin/events.js';
import '../work/events.js';
import '../chat/events.js';
import '../docs/events.js';

/**
 * The audit projection's mapping table, checked against what is actually
 * registered.
 *
 * ## Why this test exists
 *
 * `RESOURCE_OF` is a hand-maintained table keyed by event name, and an event
 * missing from it is not an error: `resourceOf` returns `{ type: null, id:
 * null }` and the entry is written anyway, with no subject. The compliance
 * record then holds a row saying something happened, in this org, by this
 * actor — to nothing. Nothing fails, no test goes red, and the gap is
 * discovered by whoever first tries to answer "what has happened to this
 * page", which is during an incident.
 *
 * That is exactly what happened here: all nine Docs events (Phase 6, Waves 1
 * and 2) shipped with no mapping, and so did twenty-five others going back to
 * Phase 1. The mappings are fixed; this file is what stops the twenty-sixth.
 */

/**
 * Registered events with no mapping, recorded rather than tolerated silently.
 *
 * This is a LEDGER OF A KNOWN GAP, not a list of decisions. Every name here
 * writes an audit entry with a null `resource_type` and `resource_id` today.
 * Each needs a call about what it should name — several are not obvious, which
 * is why they are listed rather than guessed at in the same change that fixed
 * Docs':
 *
 *   - The identity events are the genuinely arguable ones. `user.logged_in`
 *     already carries the account in `actor_id`, so `resource_id` would repeat
 *     it — but `profile.updated` (Phase 11.5, the successor to the retired
 *     `user.display_name_changed`) IS mapped (to `member`/`userId`), so the
 *     two conventions currently disagree with each other.
 *   - `attachment.*` (Work) are almost certainly an oversight: chat's
 *     `message_attachment.*` are all mapped to `attachment`, and these are the
 *     same events one phase earlier.
 *   - `view.*`, `status.*` and `card.status_changed` have obvious containers
 *     (board, project, card) and no resource type of their own.
 *
 * Shrinking this list is the point. Adding to it needs a reason in the commit.
 */
const UNMAPPED: ReadonlySet<string> = new Set([
  // Identity (Phase 1)
  'user.registered',
  'user.email_verified',
  'user.logged_in',
  'user.login_failed',
  'user.password_changed',
  'user.password_reset_requested',
  'user.account_locked',
  'user.passkey_registered',
  'user.passkey_removed',
  'user.passkey_login_failed',
  // Phase 12 Wave 2 §3.2 — same shape as the passkey pair above: a new/removed
  // way into the account, `resource_id` would repeat `actor_id`.
  'user.totp_enrolled',
  'user.totp_disabled',
  // Phase 12 Wave 2 §3.3 — same shape again.
  'user.oauth_linked',
  'user.oauth_unlinked',
  'session.revoked',
  'session.token_reuse_detected',
  // Work (Phase 3 / 3.5)
  'attachment.presigned',
  'attachment.uploaded',
  'attachment.rejected',
  'attachment.downloaded',
  'attachment.deleted',
  'card.status_changed',
  'status.created',
  'status.updated',
  'status.deleted',
  'view.created',
  'view.updated',
  'view.deleted',
  // Chat (Phase 5)
  'message.saved',
]);

/**
 * The field names a payload schema declares, or null if it is not an object.
 *
 * The cast is to `ZodRawShape`, not away from it: `instanceof z.ZodObject`
 * narrows to `ZodObject<any>`, so reading `.shape` off the narrowed value hands
 * back `any` and the unsafe-assignment rule fires — correctly, since nothing
 * has said what those keys are.
 */
function payloadKeys(schema: unknown): readonly string[] | null {
  if (!(schema instanceof z.ZodObject)) return null;
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
}

function definitionsByName(): ReadonlyMap<string, AnyEventDefinition> {
  return new Map(registeredEvents().map((definition) => [definition.name, definition]));
}

describe('audit projection — resource mapping', () => {
  it('accounts for every registered event', () => {
    const unaccounted = [...definitionsByName().keys()].filter(
      (name) => !(name in RESOURCE_OF) && !NEVER_AUDITED.has(name) && !UNMAPPED.has(name),
    );

    expect(
      unaccounted,
      'Registered but not accounted for. Add the event to RESOURCE_OF (preferred — an audit ' +
        'entry with no subject is a row nobody can query), to NEVER_AUDITED if it must not ' +
        'reach the log at all, or to UNMAPPED if the call has to wait.',
    ).toEqual([]);
  });

  /* Without this, the ledger above becomes a place names go to die: an event
     that later gets a mapping would sit in both lists, and a renamed one would
     sit here forever claiming a gap that no longer exists. */
  it('keeps the unmapped ledger honest', () => {
    const registered = definitionsByName();

    const alreadyMapped = [...UNMAPPED].filter((name) => name in RESOURCE_OF);
    expect(alreadyMapped, 'Now mapped — remove from UNMAPPED.').toEqual([]);

    const unknown = [...UNMAPPED].filter((name) => !registered.has(name));
    expect(unknown, 'Not a registered event — renamed or deleted; remove from UNMAPPED.').toEqual(
      [],
    );
  });

  /* A resource type the policy engine has never heard of is unusable by the
     permission debug endpoint, which reads the same vocabulary back — the
     reason the table's own header gives for resolving lists to their board. */
  it('names only real resource types', () => {
    const valid = new Set<string>(RESOURCE_TYPES);
    const invalid = Object.entries(RESOURCE_OF)
      .filter(([, mapping]) => !valid.has(mapping.type))
      .map(([name, mapping]) => `${name} -> ${mapping.type}`);

    expect(invalid, 'Not in RESOURCE_TYPES (packages/policy).').toEqual([]);
  });

  /**
   * The failure this one catches is silent in exactly the same way a missing
   * mapping is: `resourceOf` reads `payload[key]`, finds `undefined`, and
   * returns a null id under a perfectly correct-looking type. A typo in the
   * key — `pageID` for `pageId` — produces subject-less entries for one event
   * while every other event in the same phase works.
   */
  it('keys each mapping on a field the payload actually carries', () => {
    const registered = definitionsByName();

    const missing = Object.entries(RESOURCE_OF)
      .map(([name, mapping]) => {
        const keys = payloadKeys(registered.get(name)?.schema);
        // Only object schemas can be introspected; a non-object payload has no
        // named field to check, and asserting on one would be inventing a rule.
        if (keys === null) return null;
        return keys.includes(mapping.key) ? null : `${name} -> ${mapping.key}`;
      })
      .filter((entry): entry is string => entry !== null);

    expect(missing, 'Mapping keys a payload field that does not exist.').toEqual([]);
  });

  /* Spot-checks on the two Docs mappings that do NOT follow "name the thing
     that changed", so a later simplification toward `pageId` has to argue with
     a test rather than with a comment. */
  it('resolves a sibling rebalance to the space, not to a page', () => {
    expect(RESOURCE_OF['page.siblings_rebalanced']).toEqual({ type: 'space', key: 'spaceId' });
  });

  it('resolves version save and restore to the page, not to the version', () => {
    expect(RESOURCE_OF['page.version_saved']).toEqual({ type: 'page', key: 'pageId' });
    expect(RESOURCE_OF['page.version_restored']).toEqual({ type: 'page', key: 'pageId' });
  });
});
