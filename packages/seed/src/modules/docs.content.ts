import * as Y from 'yjs';
import { createEvent } from '@taskflow/events';
import { pageVersionSaved } from '@taskflow/api/events/docs';
import { pageBody, type PageBlock } from '../corpus.js';
import type { Rng } from '../rng.js';
import type { PageMix } from '../profiles.js';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { spacesModule, type SeededPage } from './docs.spaces.js';

/**
 * Page bodies — the CRDT write-ahead log and its snapshots (Phase 6, Wave 2).
 *
 * ## This module writes real Yjs bytes, not a plausible-looking blob
 *
 * `docs.yjs_updates.data` and `docs.page_versions.state` are `bytea`, and the
 * only consumer that ever reads them is `apps/collab`'s `replayPage`, which
 * hands them straight to `Y.applyUpdate`. So a fixture of random bytes is not a
 * smaller version of this module — it is a page that throws on open. Every row
 * here comes from a real `Y.Doc`: the WAL rows are the incremental updates its
 * own `update` event emitted, and a snapshot is `Y.encodeStateAsUpdate` of the
 * same document at the moment the snapshot was taken.
 *
 * ## clientID is drawn from the seed, and that is not a detail
 *
 * `Y.Doc`'s constructor assigns `this.clientID = generateNewClientId()` — a
 * random 32-bit number — and the client id is encoded into every operation.
 * Left alone, the same `--seed` would produce byte-for-byte different `data`
 * columns on every run, and nothing would fail: the documents converge to the
 * same text, so only the bytes differ. That is precisely the kind of "true but
 * not reproducible" a seeder cannot afford, since the whole promise of `--seed`
 * is that a bug found in a seeded database can be found again tomorrow. It is
 * drawn per (page, author) so co-edited pages still carry distinct client ids,
 * which is what a real two-person session produces.
 *
 * ## Four snapshot/WAL shapes, on purpose
 *
 * `PageMix`'s own header lists them. The short version: `replayPage` loads the
 * newest snapshot and replays only the WAL rows after it, so the interesting
 * failures live at that boundary — a page whose tail is dropped reads back as
 * of its snapshot, silently, with no error anywhere. A fixture carrying only
 * "snapshot, no tail" would never show it.
 *
 * ## Content is whitelisted BY CONSTRUCTION
 *
 * Every node this module builds comes from `@taskflow/api/richtext`'s node
 * list — the same list `apps/collab`'s content guard validates against — so a
 * seeded document is one the guard leaves untouched. `docs.test.ts` proves that
 * by running the guard itself over the result, rather than by trusting this
 * comment. `--chaos` is the exception, and deliberately so: it plants one
 * document containing a node type nobody implemented, which is the only way to
 * exercise the strip path on demand rather than waiting for a real client to
 * misbehave.
 */

export interface ContentOutput {
  readonly pagesWithBody: number;
  readonly updateRows: number;
  readonly versionRows: number;
}

/**
 * Sets a node attribute whose value is not a string.
 *
 * Yjs types `XmlElement`'s attribute map as `{ [key: string]: string }`, but
 * ProseMirror attributes are arbitrary JSON and y-prosemirror stores them
 * verbatim (`sync-plugin.js`: `type.setAttribute(key, node.attrs[key])`) — so a
 * heading really does carry `level: 2` as a NUMBER in a document produced by a
 * live editor. The content guard's Zod schema expects exactly that
 * (`heading: z.object({ level: z.number()... })`), so writing `'2'` here would
 * produce a heading whose attributes the guard strips: a valid-looking fixture
 * that the real pipeline quietly demotes to a plain heading. The cast is to the
 * function's true runtime signature, not away from a type that was correct.
 */
function setNodeAttribute(element: Y.XmlElement, key: string, value: string | number): void {
  (element.setAttribute as unknown as (k: string, v: string | number) => void)(key, value);
}

function textElement(nodeName: string, text: string): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  element.insert(0, [new Y.XmlText(text)]);
  return element;
}

/** One corpus block as the nodes a TipTap-backed `Y.XmlFragment` would hold. */
function nodeFor(block: PageBlock): Y.XmlElement {
  switch (block.kind) {
    case 'heading': {
      const heading = textElement('heading', block.text);
      setNodeAttribute(heading, 'level', block.level);
      return heading;
    }
    case 'bullets': {
      const list = new Y.XmlElement('bulletList');
      list.insert(
        0,
        block.items.map((item) => {
          const listItem = new Y.XmlElement('listItem');
          listItem.insert(0, [textElement('paragraph', item)]);
          return listItem;
        }),
      );
      return list;
    }
    case 'quote': {
      const quote = new Y.XmlElement('blockquote');
      quote.insert(0, [textElement('paragraph', block.text)]);
      return quote;
    }
    case 'code': {
      const code = textElement('codeBlock', block.text);
      setNodeAttribute(code, 'language', block.language);
      return code;
    }
    case 'paragraph':
    default:
      return textElement('paragraph', block.text);
  }
}

interface EditedDocument {
  /** One entry per transaction, in order — what the WAL would have recorded. */
  readonly updates: readonly Uint8Array[];
  /**
   * Full state after the transaction at this index, or null when no snapshot
   * was taken. The index is the boundary `replayPage` would replay from.
   */
  readonly snapshot: { readonly after: number; readonly state: Uint8Array } | null;
}

/**
 * Types a page's body into a fresh document, one transaction at a time.
 *
 * The updates are collected from the document's own `update` event rather than
 * diffed afterwards, because that is literally what `beforeHandleMessage`
 * persists on a live connection: the incremental update a client sent, not a
 * recomputed delta.
 */
function editDocument(rng: Rng, mix: PageMix, chaos: boolean): EditedDocument {
  const doc = new Y.Doc();
  // See the file header — the one line standing between `--seed` and a database
  // that differs on every run.
  doc.clientID = rng.int(1, 2_147_483_647);

  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => {
    updates.push(update);
  });

  const fragment = doc.getXmlFragment('content');
  const blocks = pageBody(rng, rng.int(mix.blocks[0], mix.blocks[1]));
  const transactions = Math.max(
    1,
    Math.min(rng.int(mix.updates[0], mix.updates[1]), blocks.length),
  );
  const perTransaction = Math.ceil(blocks.length / transactions);

  let snapshot: { after: number; state: Uint8Array } | null = null;
  const wantsSnapshot = rng.chance(mix.snapshotRate);
  /* Never after the LAST transaction when a tail is wanted: a snapshot taken
     once editing stopped has nothing after it, which is a different shape from
     the one this page was drawn to be. */
  const wantsTail = rng.chance(mix.tailRate);
  const snapshotAfter = wantsSnapshot
    ? wantsTail && transactions > 1
      ? rng.int(0, transactions - 2)
      : transactions - 1
    : -1;

  for (let index = 0; index < transactions; index += 1) {
    const slice = blocks.slice(index * perTransaction, (index + 1) * perTransaction);
    if (slice.length === 0) continue;

    doc.transact(() => {
      fragment.push(slice.map(nodeFor));
    });

    if (index === snapshotAfter) {
      snapshot = { after: index, state: Y.encodeStateAsUpdate(doc) };
    }
  }

  if (chaos) {
    /* A node type nobody implemented, in live CRDT state — §3.8's own scenario.
       The guard deletes it outright on the next save boundary (an unknown node
       is rejected, never sanitized into something else), and this is the only
       way to have a document that needs it. */
    doc.transact(() => {
      fragment.push([textElement('iframe', 'https://example.invalid/embedded')]);
    });
  }

  return { updates, snapshot };
}

export const contentModule = defineSeedModule({
  name: 'docs.content',
  requires: [spacesModule],
  tables: ['docs.yjs_updates', 'docs.page_versions'],

  async seed(ctx): Promise<ContentOutput> {
    const rng = ctx.rng.fork('docs.content');
    const { pages } = ctx.use(spacesModule);
    const mix = ctx.profile.page;

    const byOrg = new Map<string, SeededPage[]>();
    for (const page of pages) {
      if (page.space.plan.content !== true) continue;
      const list = byOrg.get(page.orgId) ?? [];
      list.push(page);
      byOrg.set(page.orgId, list);
    }

    let pagesWithBody = 0;
    let updateRows = 0;
    let versionRows = 0;
    /* Chaos plants ONE bad document per run, not one per page: the strip path
       needs a fixture, and a database where every page trips it would make the
       guard's own counters useless for telling whether it ran. */
    let chaosRemaining = ctx.chaos ? 1 : 0;

    for (const [orgId, orgPages] of byOrg) {
      const updateRowValues: unknown[][] = [];
      const versionRowValues: unknown[][] = [];

      for (const page of orgPages) {
        if (!rng.chance(mix.bodyRate)) continue;

        const chaos = chaosRemaining > 0;
        if (chaos) chaosRemaining -= 1;

        const edited = editDocument(rng, mix, chaos);
        if (edited.updates.length === 0) continue;
        pagesWithBody += 1;

        /* Editing starts after the page exists and each transaction lands a few
           minutes after the last. The gaps are what make the snapshot boundary
           meaningful: `replayPage` compares `created_at` against the snapshot's
           own timestamp, so updates sharing one instant with it would be a
           coin flip between "replayed" and "already folded in" — which is
           exactly the ambiguity `readUpdatesSince`'s truncation note is careful
           about, and not one a fixture should reproduce by accident. */
        const start = minutesAfter(page.createdAt, rng.int(5, 600));
        const gapMinutes = rng.int(3, 90);
        const at = (index: number): Date => minutesAfter(start, index * gapMinutes);

        const snapshot = edited.snapshot;
        /* Pruned pages keep only the tail — compaction deletes exactly the rows
           it folded into the snapshot (`pruneUpdates`), so the WAL of a
           compacted page starts AFTER its newest snapshot. Keeping them is the
           equally real state where compaction has not run yet. */
        const pruned = snapshot !== null && rng.chance(mix.prunedShare);

        edited.updates.forEach((update, index) => {
          // `pruned` is only ever true when there IS a snapshot, and the
          // compiler knows it — narrowing follows the aliased condition above.
          if (pruned && index <= snapshot.after) return;
          updateRowValues.push([
            rng.uuid(at(index)),
            orgId,
            page.id,
            Buffer.from(update),
            at(index),
          ]);
        });

        if (snapshot !== null) {
          /* Halfway between the transaction it captured and the next one — a
             snapshot sharing an instant with either would sit exactly on the
             `>` boundary `readUpdatesSince` uses. */
          const snapshotAt = minutesAfter(at(snapshot.after), Math.max(1, gapMinutes / 2));
          const manual = rng.chance(mix.manualShare);
          const versionId = rng.uuid(snapshotAt);

          versionRowValues.push([
            versionId,
            orgId,
            page.id,
            manual ? 'manual' : 'autosave',
            Buffer.from(snapshot.state),
            /* Null for an autosave: the compaction pass is not an act any user
               performed, and naming one would claim an event that did not
               happen (0024's own note on the column). */
            manual ? page.author.user.id : null,
            snapshotAt,
          ]);

          /* Only the manual save emits. Compaction is exempt from guardrail 11
             for the same reason `work/rebalance.ts` is, and `apps/api`'s
             `docs/events.ts` says so explicitly — an autosave that emitted
             would put a periodic background write in the compliance record
             once per document per interval, forever. */
          if (manual) {
            ctx.emit(
              createEvent(
                pageVersionSaved,
                { pageId: page.id, versionId },
                envelopeFor(orgId, page.author.user.id, snapshotAt),
              ),
            );
          }
        }
      }

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'docs.yjs_updates',
          ['id', 'org_id', 'page_id', 'data', 'created_at'],
          updateRowValues,
        );
        await ctx.db.insert(
          'docs.page_versions',
          ['id', 'org_id', 'page_id', 'kind', 'state', 'created_by', 'created_at'],
          versionRowValues,
        );
      });

      updateRows += updateRowValues.length;
      versionRows += versionRowValues.length;
    }

    if (pagesWithBody > 0) {
      ctx.log(
        `docs.content: ${String(pagesWithBody)} pages with a body — ` +
          `${String(updateRows)} WAL rows, ${String(versionRows)} snapshots`,
      );
    }

    return { pagesWithBody, updateRows, versionRows };
  },
});

/** Exported so `docs.test.ts` can drive the generator without a database. */
export { editDocument };
