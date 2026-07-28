import { createHash } from 'node:crypto';

/**
 * The audit log's hash chain, recomputed (PLAN.md §8.6).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * Entries are hashed by a Postgres trigger — `audit.chain_entry()` in migration
 * 0007 — so that a writer cannot choose its own digest, and so that per-org
 * ordering is decided under a row lock rather than by application timing. This
 * module is the VERIFIER: it recomputes the same digest from a row read back
 * and reports where a chain stops agreeing with itself.
 *
 * Two implementations of one formula is a drift hazard, and an unusually
 * unpleasant one — drift makes verification report tampering on an untouched
 * table, which gets responded to as an incident rather than as a bug.
 * `packages/db/src/audit.test.ts` asserts the two agree against real Postgres
 * on every run. Change one and that test fails; change both without it and the
 * control is quietly gone.
 *
 * ## The fields arrive as text, already rendered by Postgres
 *
 * Every field below is the string Postgres produced, not a JavaScript value
 * converted here. That is deliberate and is the whole reason this interface
 * looks tedious:
 *
 *   - `jsonb` has its own text rendering — keys ordered by length then
 *     bytewise, a space after each colon, its own escaping. Reproducing it from
 *     a parsed object would be a second implementation of Postgres.
 *   - A `timestamptz` renders differently depending on the session's TimeZone
 *     and DateStyle, so the trigger hashes milliseconds since the epoch and the
 *     query hands that number back as text.
 *
 * The consequence: the SELECT list in the verification query is part of this
 * contract. It is written out in `apps/api/src/tenancy/audit.service.ts` with a
 * comment saying so.
 *
 * ## What this detects, and what it does not
 *
 * It detects an entry altered or removed after the fact, because every later
 * hash commits to it. It does not PREVENT anyone with database write access
 * from rewriting the chain wholesale from a chosen point — nothing stored in
 * the same database could. Detection is the honest goal; §8.6's daily export to
 * immutable storage is what bounds how far back a rewrite could reach unseen.
 */

/**
 * One entry's hashed fields, in the order the trigger concatenates them.
 *
 * All strings, all exactly as Postgres rendered them. `null` is distinct from
 * the empty string in the encoding, so a missing user agent and a blank one
 * produce different digests.
 */
export interface AuditChainEntry {
  readonly id: string;
  readonly orgId: string;
  readonly seq: string;
  /** Milliseconds since the epoch, as text. See the note above on timestamps. */
  readonly occurredAtMs: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  /** `changes::text` — Postgres's jsonb rendering, or null. */
  readonly changes: string | null;
  /** `decision::text` — Postgres's jsonb rendering, or null. */
  readonly decision: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly sessionId: string | null;
  readonly requestId: string | null;
}

/**
 * Encodes one field so its boundaries are unambiguous — `audit.chain_field`.
 *
 * Length-prefixed rather than delimiter-joined because `userAgent` is
 * attacker-controlled: with any separator byte, a caller able to place that
 * byte inside one field could make two different entries hash the same bytes.
 * The length is in BYTES, not characters, matching `octet_length` — a
 * multi-byte character would otherwise make the two implementations disagree on
 * every entry containing one.
 */
function field(value: string | null): string {
  if (value === null) return '-';
  return `${String(Buffer.byteLength(value, 'utf8'))}:${value}`;
}

/** The exact bytes the trigger hashes, in the trigger's field order. */
function canonicalBytes(entry: AuditChainEntry): Buffer {
  const encoded = [
    entry.id,
    entry.orgId,
    entry.seq,
    entry.occurredAtMs,
    entry.actorId,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    entry.changes,
    entry.decision,
    entry.ip,
    entry.userAgent,
    entry.sessionId,
    entry.requestId,
  ]
    .map(field)
    .join('');

  return Buffer.from(encoded, 'utf8');
}

/**
 * Recomputes one entry's digest.
 *
 * `previousHash` is the chain head before this entry — a zero-length buffer for
 * the first entry in an org, matching the trigger's seed.
 */
export function auditEntryHash(entry: AuditChainEntry, previousHash: Buffer): Buffer {
  return createHash('sha256').update(previousHash).update(canonicalBytes(entry)).digest();
}

export interface ChainBreak {
  readonly seq: string;
  readonly id: string;
  readonly reason: 'hash_mismatch' | 'broken_link' | 'sequence_gap';
}

export interface ChainVerification {
  readonly verified: number;
  readonly intact: boolean;
  readonly breaks: readonly ChainBreak[];
}

/** An entry as read back, with the two chain columns the trigger wrote. */
export type StoredAuditEntry = AuditChainEntry & {
  readonly prevHash: Buffer | null;
  readonly hash: Buffer;
};

/**
 * Walks an org's entries in `seq` order and reports every disagreement.
 *
 * Reports ALL breaks rather than stopping at the first, because the shape of
 * the damage is the diagnosis: one isolated mismatch is a corrupted row, while
 * a mismatch followed by an unbroken tail means an entry was edited and the
 * chain recomputed from there — a different, worse kind of news.
 */
export function verifyAuditChain(entries: readonly StoredAuditEntry[]): ChainVerification {
  const breaks: ChainBreak[] = [];
  let previousHash: Buffer = Buffer.alloc(0);
  let expectedSeq: bigint | null = null;

  for (const entry of entries) {
    const seq = BigInt(entry.seq);

    if (expectedSeq !== null && seq !== expectedSeq) {
      breaks.push({ seq: entry.seq, id: entry.id, reason: 'sequence_gap' });
    }
    expectedSeq = seq + 1n;

    /* The stored link is checked as well as the digest. Checking only the
       digest would miss an entry deleted from the middle: the survivors each
       hash correctly on their own, and only `prev_hash` records that something
       used to sit between them. */
    const storedPrev = entry.prevHash ?? Buffer.alloc(0);
    if (!storedPrev.equals(previousHash)) {
      breaks.push({ seq: entry.seq, id: entry.id, reason: 'broken_link' });
    }

    if (!auditEntryHash(entry, previousHash).equals(entry.hash)) {
      breaks.push({ seq: entry.seq, id: entry.id, reason: 'hash_mismatch' });
    }

    previousHash = entry.hash;
  }

  return { verified: entries.length, intact: breaks.length === 0, breaks };
}
