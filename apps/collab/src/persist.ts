import { IncomingMessage } from '@hocuspocus/server';
import * as decoding from 'lib0/decoding';
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync';
import { and, asc, eq, gt, inArray, schema, withCollabScope } from '@taskflow/db';
import { uuidv7 } from '@taskflow/security';
import type { OrgId, PageId } from '@taskflow/contracts';

/**
 * `@hocuspocus/server`'s own `MessageType.Sync` — restated as a plain number
 * rather than imported, because comparing a decoded `number` against that
 * TS enum member trips `no-unsafe-enum-comparison` no matter how the
 * comparison is cast (confirmed: every cast the compiler accepts, the rule
 * still flags, and every form that quiets the rule the compiler calls
 * unnecessary). The value is stable — Hocuspocus's own wire protocol, not an
 * implementation detail free to renumber.
 */
const SYNC_MESSAGE_TYPE = 0;

/**
 * The write-ahead log — append and read (ai/phase-6-docs.md §3.7).
 *
 * ## Why `beforeHandleMessage`, and what it means to peek a raw message
 *
 * Confirmed against `@hocuspocus/server@4.5.0`'s own `ClientConnection.
 * processMessages()`: `beforeHandleMessage` is `await`ed BEFORE the message
 * is applied to the document and BEFORE the sync-status ack is sent back to
 * the client. `onChange` — the hook that hands back an already-decoded
 * update, which looked like the natural fit — is fired-and-forgotten by the
 * same code path; nothing awaits it before the ack goes out. So this is the
 * one hook that can make "written durably before acknowledgment" (§3.7's own
 * words) literally true rather than a best-effort approximation.
 *
 * The cost is that `beforeHandleMessage` hands over the RAW, not-yet-decoded
 * WebSocket message — every message type (sync, awareness, ping, auth), not
 * only the ones worth persisting. `extractUpdateBytes` peeks it with a
 * SECOND, independent `IncomingMessage` built from the same immutable bytes
 * — this does not touch or consume the real receiver's own decoder, which
 * `processMessages()` constructs afterward from the identical `rawUpdate`.
 * Peeking past the document name and the top-level message type, then the
 * y-protocol sync sub-type, using nothing but `@hocuspocus/server`'s own
 * exported `IncomingMessage` and `y-protocols/sync`'s exported type
 * constants — no hand-rolled wire-format parsing (`SYNC_MESSAGE_TYPE` above
 * is the one exception, and only because of a lint-rule/compiler standoff,
 * not because the value itself was reverse-engineered).
 *
 * `messageYjsSyncStep1` (a bare request for the other side's state) carries
 * no delta and is skipped. `messageYjsSyncStep2` and `messageYjsUpdate` both
 * wrap the actual update as a `decoding.readVarUint8Array` payload — reading
 * exactly that (via `lib0/decoding`, the same primitive y-protocols' own
 * `readSyncStep2`/`readUpdate` use internally) is what `docs.yjs_updates.data`
 * stores: a bare Yjs update, replayable with a plain `Y.applyUpdate`, with no
 * protocol envelope to reconstruct at replay time.
 */
export function extractUpdateBytes(rawMessage: Uint8Array): Uint8Array | null {
  const peek = new IncomingMessage(rawMessage);

  peek.readVarString(); // document name — discarded; the caller already knows which page this is
  const topLevelType = peek.readVarUint();
  if (topLevelType !== SYNC_MESSAGE_TYPE) return null;

  const subtype = peek.readVarUint();
  if (subtype === messageYjsSyncStep1) return null;
  if (subtype !== messageYjsSyncStep2 && subtype !== messageYjsUpdate) return null;

  return decoding.readVarUint8Array(peek.decoder);
}

/**
 * Appends one update to the WAL, durably, as `taskflow_collab`.
 *
 * Called from `beforeHandleMessage` and therefore awaited before Hocuspocus
 * applies the update or acknowledges it — see the file header. `id` is
 * app-generated UUIDv7 (`packages/security`), the same convention every
 * other table in this codebase uses for a row that needs no database
 * sequence to order correctly.
 */
export async function appendUpdate(orgId: OrgId, pageId: PageId, data: Uint8Array): Promise<void> {
  await withCollabScope(orgId, async (tx) => {
    await tx.insert(schema.yjsUpdates).values({
      // A plain UUIDv7, not a branded id via newId<B>() — this row's own
      // primary key never crosses a trust boundary or gets compared against
      // anything (guardrail 1's reason for branding), it only needs to sort
      // close to insertion order the way every other UUIDv7 PK in this
      // codebase does.
      id: uuidv7(),
      orgId,
      pageId,
      data: Buffer.from(data),
    });
  });
}

export interface StoredUpdate {
  readonly id: string;
  readonly data: Buffer;
  readonly createdAt: Date;
}

/**
 * Every WAL row for a page, oldest first — replay order for
 * `onLoadDocument` and compaction alike.
 *
 * `after`, when given, is the timestamp of the snapshot already loaded
 * (§3.7: the WAL replays only the tail past the last snapshot boundary,
 * never the whole history from scratch).
 *
 * The boundary is APPROXIMATE, in the safe direction only: `after` is a
 * `StoredUpdate.createdAt` or `page_versions.createdAt` read back as a JS
 * `Date`, which truncates Postgres's microsecond `timestamptz` to
 * milliseconds — confirmed directly (a real query returning `.005849`
 * rounds/truncates to `.005` through the driver's own Date conversion).
 * That can cause a row genuinely at-or-before the boundary to be returned
 * AGAIN (its true timestamp compares greater than the truncated cutoff),
 * but never the reverse: truncating the cutoff DOWN only widens what `>`
 * matches, so a row strictly after the boundary can never be excluded by
 * it. Re-applying an update the target `Y.Doc` already reflects is a no-op
 * — Yjs's CRDT algorithm deduplicates by client id and clock — so the
 * direction this imprecision can err in is harmless; the direction that
 * would matter (silently dropping an update) is the one it cannot produce.
 */
export async function readUpdatesSince(
  orgId: OrgId,
  pageId: PageId,
  after: Date | null,
): Promise<readonly StoredUpdate[]> {
  return withCollabScope(orgId, async (tx) => {
    return tx
      .select({ id: schema.yjsUpdates.id, data: schema.yjsUpdates.data, createdAt: schema.yjsUpdates.createdAt })
      .from(schema.yjsUpdates)
      .where(
        and(
          eq(schema.yjsUpdates.pageId, pageId),
          after === null ? undefined : gt(schema.yjsUpdates.createdAt, after),
        ),
      )
      .orderBy(asc(schema.yjsUpdates.createdAt), asc(schema.yjsUpdates.id));
  });
}

/**
 * Deletes exactly the WAL rows named by `ids` — compaction's pruning step,
 * once their combined effect is captured in a new `page_versions` snapshot.
 *
 * Takes an explicit id list rather than a `createdAt` cutoff deliberately:
 * `readUpdatesSince`'s own doc comment explains why a JS `Date` boundary is
 * imprecise for a READ (safe there, since re-reading a row is harmless).
 * Pruning is a DELETE, where the unsafe direction is removing a row that
 * was never actually folded into the snapshot — data loss, not redundant
 * work — so this deletes precisely the rows the caller already read and
 * incorporated, never a timestamp range that could include one it didn't.
 */
export async function pruneUpdates(orgId: OrgId, pageId: PageId, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  await withCollabScope(orgId, async (tx) => {
    await tx
      .delete(schema.yjsUpdates)
      .where(and(eq(schema.yjsUpdates.pageId, pageId), inArray(schema.yjsUpdates.id, ids)));
  });
}
