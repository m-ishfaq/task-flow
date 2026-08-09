import { and, asc, eq, lt, schema, withRecordingIngestScope } from '@taskflow/db';
import type { StorageProvider } from '@taskflow/contracts';
import { newStorageKey } from '@taskflow/storage';

/**
 * The recording-ingest sweep (ai/phase-7-voice.md §3.6; §7.1's re-asked
 * decision, resolved at Wave 2 as a timer rather than a new deployable).
 *
 * PLAN.md §8.5: "Recordings stored in your own object storage, never left on
 * Twilio." This is the thing that moves them.
 *
 * ## Why a sweep and not the webhook handler
 *
 * The carrier's recording callback expects a fast answer — it retries on
 * timeout, and a retried callback while the first is still downloading is two
 * processes fetching the same multi-megabyte file. So the webhook writes a
 * `pending` row and returns, and this drains it. The recording sits on the
 * carrier until then, which is a window rather than a leak: it is behind the
 * carrier's own auth, and the alternative is a webhook that times out under
 * exactly the conditions that make it slow.
 *
 * ## Why no FOR UPDATE SKIP LOCKED
 *
 * The obvious claim query — `SELECT ... FOR UPDATE SKIP LOCKED` — is what
 * `claimPending` uses for the outbox, and it CANNOT be used here.
 * `taskflow_recording_ingest`'s grant is column-level, and Postgres requires
 * SELECT on EVERY column of a table to take a row lock, not just the projected
 * ones. It fails with "permission denied for table recordings", and a migration
 * review plus a type checker both read the query as fine — this is the exact
 * trap `packages/db/src/docs-backlinks.ts` documents after hitting it for real.
 *
 * The claim is therefore a conditional UPDATE that moves the row's `attempts`
 * forward and returns it. Two racing sweeps can both try, one wins the row
 * version, and the loser sees zero rows returned. Redundant work is possible;
 * incorrect work is not.
 */

/** Rows per tick. Bounded so one slow carrier cannot stall the loop forever. */
const BATCH = 5;

/**
 * Give up after this many attempts.
 *
 * A recording that cannot be fetched — deleted at the carrier, a permanently
 * bad URL — must stop being retried, or the sweep spends every tick on the same
 * dead row and never reaches the live ones behind it. `failed` is a terminal
 * state a human can query for, not a silent drop.
 */
const MAX_ATTEMPTS = 5;

export interface IngestDeps {
  readonly storage: StorageProvider;
  /**
   * Fetches the audio from the carrier.
   *
   * Injected rather than called directly so the suite can drive the sweep
   * without a carrier — and so the ONE place this process reads from an
   * arbitrary provider-supplied URL is visible in a signature.
   */
  readonly fetchRecording: (url: string) => Promise<Uint8Array>;
}

export interface IngestResult {
  readonly stored: number;
  readonly failed: number;
}

interface PendingRow {
  readonly id: string;
  readonly orgId: string;
  readonly providerUrl: string | null;
  readonly attempts: number;
}

/**
 * Runs one pass. Returns what it did, so the caller can log a number rather
 * than a promise.
 */
export async function ingestPendingRecordings(deps: IngestDeps): Promise<IngestResult> {
  const pending = await claimPending();

  let stored = 0;
  let failed = 0;

  for (const row of pending) {
    if (row.providerUrl === null) {
      await markFailed(row.id, 'No provider URL on the recording row.');
      failed += 1;
      continue;
    }

    try {
      const bytes = await deps.fetchRecording(row.providerUrl);

      /* The key is server-generated from the org id and a fresh UUIDv7
         (packages/storage/keys.ts). Nothing from the carrier reaches it — a
         provider-supplied filename in a key is the path traversal that module
         removes rather than mitigates. */
      const key = newStorageKey(row.orgId);
      await deps.storage.putObject(key, bytes, 'audio/mpeg');

      await markStored(row.id, key, bytes.byteLength);
      stored += 1;
    } catch (error) {
      /* The message, never the provider URL. That URL is a link to a third
         party's copy of a private conversation, and `last_error` is a column a
         support view will happily render. */
      await markFailed(row.id, error instanceof Error ? error.message : 'Ingest failed.');
      failed += 1;
    }
  }

  return { stored, failed };
}

/**
 * Claims up to `BATCH` pending rows by incrementing `attempts`.
 *
 * The conditional UPDATE is the claim: `attempts` is both the retry budget and
 * the optimistic-concurrency token, so a row returned here has already been
 * marked as attempted and a second sweep reading the same row a moment later
 * sees the incremented value.
 */
async function claimPending(): Promise<readonly PendingRow[]> {
  return withRecordingIngestScope(async (tx) => {
    const candidates = await tx
      .select({
        id: schema.recordings.id,
        orgId: schema.recordings.orgId,
        providerUrl: schema.recordings.providerUrl,
        attempts: schema.recordings.attempts,
      })
      .from(schema.recordings)
      .where(
        and(eq(schema.recordings.status, 'pending'), lt(schema.recordings.attempts, MAX_ATTEMPTS)),
      )
      .orderBy(asc(schema.recordings.createdAt))
      .limit(BATCH);

    const claimed: PendingRow[] = [];
    for (const row of candidates) {
      const won = await tx
        .update(schema.recordings)
        .set({ attempts: row.attempts + 1 })
        .where(
          and(
            eq(schema.recordings.id, row.id),
            /* The version check. Without it two sweeps both "claim" the row and
               both download it — twice the bandwidth, twice the object writes,
               and one of them overwrites the other's storage key. */
            eq(schema.recordings.attempts, row.attempts),
            eq(schema.recordings.status, 'pending'),
          ),
        )
        .returning({ id: schema.recordings.id });

      if (won.length > 0) claimed.push(row);
    }

    return claimed;
  });
}

async function markStored(recordingId: string, key: string, bytes: number): Promise<void> {
  await withRecordingIngestScope(async (tx) => {
    await tx
      .update(schema.recordings)
      .set({ status: 'stored', storageKey: key, bytes, storedAt: new Date(), lastError: null })
      .where(eq(schema.recordings.id, recordingId));
  });
}

async function markFailed(recordingId: string, message: string): Promise<void> {
  await withRecordingIngestScope(async (tx) => {
    /* Stays `pending` until the attempt budget is spent, so a transient carrier
       error retries on the next tick. Only the last attempt makes it terminal. */
    const rows = await tx
      .select({ attempts: schema.recordings.attempts })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, recordingId))
      .limit(1);

    const attempts = rows[0]?.attempts ?? MAX_ATTEMPTS;

    await tx
      .update(schema.recordings)
      .set({
        lastError: message.slice(0, 500),
        ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' as const } : {}),
      })
      .where(eq(schema.recordings.id, recordingId));
  });
}
