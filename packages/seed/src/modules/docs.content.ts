import * as Y from 'yjs';
import { createEvent } from '@taskflow/events';
import { pageVersionSaved, pageVersionRestored } from '@taskflow/api/events/docs';
import { extractInternalLinks } from '@taskflow/api/docs/backlinks';
import { unsafeAsId } from '@taskflow/contracts';
import { pageBody, type PageBlock } from '../corpus.js';
import type { Rng } from '../rng.js';
import type { PageMix } from '../profiles.js';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { spacesModule, type SeededPage } from './docs.spaces.js';

/**
 * Page bodies — the CRDT write-ahead log and its snapshots (Phase 6, Wave 2),
 * internal links and backlinks, and the restore scenario (Wave 3).
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
 *
 * ## Backlinks are computed here, eagerly — not left for the real relay
 *
 * ai/phase-6-docs.md's Wave 3 status header: backlinks are computed by
 * `apps/api`'s `taskflow_backlinks` relay in production, reading
 * `docs.page_versions` asynchronously, deliberately kept OFF `apps/collab`'s
 * write path. Nothing runs that relay during a seed — there is no live process
 * to leave the edges for it to discover a few seconds later — so this module
 * calls `extractInternalLinks` (`apps/api/src/docs/backlinks.ts`) directly on
 * the same live `Y.XmlFragment` it just built, the IDENTICAL function the real
 * relay calls after materializing a page, and writes `docs.backlinks` itself.
 * `docs.backlink_dispatch` is deliberately left EMPTY: those rows mean "the
 * relay has processed this page_version", and none has, which is the honest,
 * unprocessed-backlog state a relay started against this database would find —
 * recomputing the same edges this module already wrote is safe, since
 * `docs.backlinks` is fully recomputed per source page on every pass (the
 * migration's own note on why), never patched incrementally.
 *
 * ## Restore is a NEW snapshot with the OLD bytes, never a WAL append
 *
 * ai/phase-6-docs.md's Wave 2 status header records the bug this mirrors: an
 * earlier `restorePageVersion` appended the restored state as a WAL row, which
 * MERGES old operations back in rather than undoing newer ones, since Yjs
 * updates are additive. The fix — and what this module's restore scenario
 * reproduces — is a fresh `page_versions` row carrying the EARLIER snapshot's
 * exact `state` bytes, never a `docs.yjs_updates` row.
 */

export interface ContentOutput {
  readonly pagesWithBody: number;
  readonly updateRows: number;
  readonly versionRows: number;
  readonly backlinkRows: number;
  readonly restoredPages: number;
  /**
   * Per-page live state, keyed by page id — only pages that received a body.
   * `docs.comments` and `docs.suggestions` anchor against these rather than
   * rebuilding a document of their own, for the identical reason this module
   * does not fabricate WAL bytes: an anchor is only a real fixture if
   * `Y.createRelativePositionFromTypeIndex` built it against a `Y.AbstractType`
   * that genuinely holds the text it claims to point into.
   */
  readonly pages: ReadonlyMap<string, SeededPageContent>;
}

/** What a downstream module needs to anchor a comment or suggestion for real. */
export interface SeededPageContent {
  readonly pageId: string;
  /**
   * Every text-bearing node the built document contains, in document order.
   * `Y.XmlText` IS an `AbstractType`, so each is a valid, directly usable
   * anchor target — no unwrapping, no separate "anchor points" concept to keep
   * in sync with what `nodeFor` actually built.
   */
  readonly textNodes: readonly Y.XmlText[];
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

/**
 * A paragraph carrying an atomic `pageLink` node — the same "structured
 * reference, not a `link` mark's `href`" shape `work/richtext.ts`'s own header
 * describes, and what `apps/api/src/docs/backlinks.ts`'s `extractInternalLinks`
 * walks the document looking for.
 */
function pageLinkParagraph(leadingText: string, targetPageId: string, label: string): Y.XmlElement {
  const paragraph = new Y.XmlElement('paragraph');
  const link = new Y.XmlElement('pageLink');
  link.setAttribute('pageId', targetPageId);
  link.setAttribute('label', label);
  paragraph.insert(0, [new Y.XmlText(`${leadingText} `), link]);
  return paragraph;
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

/** Every `Y.XmlText` reachable from `fragment`, in document order. */
function collectTextNodes(fragment: Y.XmlFragment): readonly Y.XmlText[] {
  const found: Y.XmlText[] = [];

  const walk = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) {
        found.push(child);
      } else if (child instanceof Y.XmlElement) {
        walk(child);
      }
    }
  };

  walk(fragment);
  return found;
}

interface EditedDocument {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
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
 *
 * `linkTarget`, when given, is another page in the same org to reference with
 * a `pageLink` — see the file header on why backlinks are computed from this
 * same document rather than guessed at separately.
 */
function editDocument(
  rng: Rng,
  mix: PageMix,
  chaos: boolean,
  linkTarget: { readonly id: string; readonly title: string } | null,
): EditedDocument {
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

  if (linkTarget !== null) {
    /* Its own transaction, after the main body — an internal link added once
       a page already has substance, which is the ordinary way one gets
       written. Always lands in the WAL tail past any snapshot taken above
       (its transaction index is `transactions`, never <= `snapshotAfter`),
       so a pruned page still carries it — see the header on why that does
       not affect backlink correctness either way. */
    doc.transact(() => {
      fragment.push([pageLinkParagraph('See also:', linkTarget.id, linkTarget.title)]);
    });
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

  return { doc, fragment, updates, snapshot };
}

export const contentModule = defineSeedModule({
  name: 'docs.content',
  requires: [spacesModule],
  tables: ['docs.yjs_updates', 'docs.page_versions', 'docs.backlinks'],

  async seed(ctx): Promise<ContentOutput> {
    const rng = ctx.rng.fork('docs.content');
    const { pages } = ctx.use(spacesModule);
    const mix = ctx.profile.page;

    const byOrg = new Map<string, SeededPage[]>();
    /** Every page in the org, content-eligible or not — a link target can be
     * any real page, the same way a real editor lets you link to an empty one. */
    const allPagesByOrg = new Map<string, SeededPage[]>();
    for (const page of pages) {
      const all = allPagesByOrg.get(page.orgId) ?? [];
      all.push(page);
      allPagesByOrg.set(page.orgId, all);

      if (page.space.plan.content !== true) continue;
      const list = byOrg.get(page.orgId) ?? [];
      list.push(page);
      byOrg.set(page.orgId, list);
    }

    let pagesWithBody = 0;
    let updateRows = 0;
    let versionRows = 0;
    let backlinkRows = 0;
    let restoredPages = 0;
    const pageDocuments = new Map<string, SeededPageContent>();
    /* Chaos plants ONE bad document per run, not one per page: the strip path
       needs a fixture, and a database where every page trips it would make the
       guard's own counters useless for telling whether it ran. */
    let chaosRemaining = ctx.chaos ? 1 : 0;

    for (const [orgId, orgPages] of byOrg) {
      const updateRowValues: unknown[][] = [];
      const versionRowValues: unknown[][] = [];
      const backlinkRowValues: unknown[][] = [];
      const allOrgPages = allPagesByOrg.get(orgId) ?? [];

      for (const page of orgPages) {
        if (!rng.chance(mix.bodyRate)) continue;

        const chaos = chaosRemaining > 0;
        if (chaos) chaosRemaining -= 1;

        const others = allOrgPages.filter((candidate) => candidate.id !== page.id);
        const linkTarget =
          others.length > 0 && rng.chance(mix.pageLinkRate)
            ? { id: rng.pick(others).id, title: rng.pick(others).title }
            : null;

        const edited = editDocument(rng, mix, chaos, linkTarget);
        if (edited.updates.length === 0) continue;
        pagesWithBody += 1;

        pageDocuments.set(page.id, {
          pageId: page.id,
          textNodes: collectTextNodes(edited.fragment),
        });

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

          /* The restore scenario — see the file header on why this is a
             SECOND snapshot with the FIRST one's exact bytes, never a WAL
             row. Only when there is a real tail past the snapshot: restoring
             a page nobody edited afterward would be a save that undoes
             nothing, which is not the scenario Wave 2's bug lived in. */
          const hasTail = edited.updates.length - 1 > snapshot.after;
          if (hasTail && rng.chance(mix.restoreShare)) {
            const restoredAt = minutesAfter(at(edited.updates.length - 1), rng.int(5, 120));
            const restoredVersionId = rng.uuid(restoredAt);

            versionRowValues.push([
              restoredVersionId,
              orgId,
              page.id,
              'manual',
              // The ORIGINAL snapshot's bytes, verbatim — a restore is "make
              // this the latest again", not a re-derivation of it.
              Buffer.from(snapshot.state),
              page.author.user.id,
              restoredAt,
            ]);

            ctx.emit(
              createEvent(
                pageVersionRestored,
                // The RESTORED-FROM version's id, matching
                // `restorePageVersion`'s own event payload exactly —
                // `input.versionId`, never the fresh row's own id.
                { pageId: page.id, versionId },
                envelopeFor(orgId, page.author.user.id, restoredAt),
              ),
            );
            restoredPages += 1;
          }
        }

        const links = extractInternalLinks(edited.fragment, unsafeAsId<'PageId'>(page.id));
        const linkedAt = minutesAfter(at(edited.updates.length - 1), 1);
        for (const targetPageId of links) {
          backlinkRowValues.push([orgId, page.id, targetPageId, linkedAt]);
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
        await ctx.db.insert(
          'docs.backlinks',
          ['org_id', 'source_page_id', 'target_page_id', 'created_at'],
          backlinkRowValues,
        );
      });

      updateRows += updateRowValues.length;
      versionRows += versionRowValues.length;
      backlinkRows += backlinkRowValues.length;
    }

    if (pagesWithBody > 0) {
      ctx.log(
        `docs.content: ${String(pagesWithBody)} pages with a body — ` +
          `${String(updateRows)} WAL rows, ${String(versionRows)} snapshots, ` +
          `${String(backlinkRows)} backlinks, ${String(restoredPages)} restored`,
      );
    }

    return {
      pagesWithBody,
      updateRows,
      versionRows,
      backlinkRows,
      restoredPages,
      pages: pageDocuments,
    };
  },
});

/** Exported so `docs.test.ts` can drive the generator without a database. */
export { editDocument, collectTextNodes, pageLinkParagraph };
