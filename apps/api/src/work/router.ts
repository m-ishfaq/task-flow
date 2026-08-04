import { z } from 'zod';
import {
  BoardIdSchema,
  CardIdSchema,
  ListIdSchema,
  Priority,
  ProjectIdSchema,
  StatusIdSchema,
  UserIdSchema,
} from '@taskflow/contracts';
import { FilterTree } from '@taskflow/filter';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { WorkActor } from './shared.js';
import { RichTextDocument } from './richtext.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import { createCardDetailRouter } from './detail.router.js';
import { createAttachmentRouter } from './attachment.router.js';
import type { AttachmentDeps } from './attachment.service.js';

/**
 * Work routes (PLAN.md §13 phase 3).
 *
 * Every route here is permission-bearing — there is no `selfRoute` and no
 * `publicRoute` in this module, and there should never be one. Unlike identity
 * and tenancy, which have genuine pre-membership states, nothing in Work can be
 * done by someone who is not already acting inside an organization.
 *
 * The permission on each route is the ORG-LEVEL gate (layer 1). It is not the
 * whole check: each service re-asks `enforce()` once it has loaded the row and
 * its ancestors, because a restrictive tuple on a board can take back a
 * capability the role granted (§8.2). Reading a permission here and concluding
 * that a member may edit every card would be reading layer 1 as though it were
 * layer 2.
 */

const Name = z.string().trim().min(1).max(120);
const Title = z.string().trim().min(1).max(500);

/**
 * A project key — the `WEB` in `WEB-142`.
 *
 * Uppercased before validation rather than rejected for case, because it is the
 * kind of thing people type in lowercase and a form that refuses is annoying
 * where a form that normalizes is not. The CHECK constraint in migration 0008
 * is the second copy of this rule and the one that cannot be bypassed.
 */
const ProjectKey = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2-10 letters or digits, starting a letter.'));

/** Optional rich text. Null clears it; omitting it is not the same as clearing. */
const Description = RichTextDocument.nullable();

/**
 * A timestamp from a client.
 *
 * Accepted as an ISO string and converted here, so the service and the database
 * both receive a `Date` and no layer has to guess at a format. `z.coerce.date()`
 * would also accept a number, which silently reinterprets a millisecond epoch
 * sent by a buggy client as a date in 1970.
 */
const Timestamp = z
  .string()
  .datetime()
  .transform((value) => new Date(value))
  .nullable();

/**
 * Dependencies the Work module cannot construct for itself.
 *
 * Only attachments need any: everything else in Work reaches the tenant-scoped
 * database and the policy engine, both module-level and stateless. Object
 * storage and the virus scanner are external services with configuration and a
 * lifecycle, so they are injected — which is also what lets a test supply a
 * scanner that always answers 'infected' without a container.
 */
export interface WorkRouterDeps {
  readonly attachments: AttachmentDeps;
}

export function createWorkRouter(deps: WorkRouterDeps) {
  const actorOf = (ctx: {
    principal: Parameters<typeof subjectOf>[0];
    requestId: WorkActor['requestId'];
  }): WorkActor => ({ subject: subjectOf(ctx.principal), requestId: ctx.requestId });

  return router({
    projects: router({
      list: route({ permission: 'project:read' })
        .input(z.object({ includeArchived: z.boolean().default(false) }).strict())
        .output(
          z
            .array(
              z.object({
                projectId: z.string(),
                name: z.string(),
                key: z.string(),
                description: z.string().nullable(),
                archivedAt: z.date().nullable(),
                boardCount: z.number().int().nonnegative(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => projects.listProjects(actorOf(ctx), input)),

      create: route({ permission: 'project:create' })
        .input(
          z
            .object({
              name: Name,
              key: ProjectKey,
              description: z.string().trim().max(2000).nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ projectId: z.string(), key: z.string() }))
        .mutation(({ input, ctx }) => projects.createProject(actorOf(ctx), input)),

      update: route({ permission: 'project:update' })
        .input(
          z
            .object({
              projectId: ProjectIdSchema,
              name: Name,
              description: z.string().trim().max(2000).nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => projects.updateProject(actorOf(ctx), input)),

      /**
       * Archive, not delete (§7.1). `project:delete` is the permission because
       * that is what the user is doing as far as they are concerned — the row
       * surviving is an implementation detail of being able to undo it.
       */
      archive: route({ permission: 'project:delete' })
        .input(z.object({ projectId: ProjectIdSchema, archived: z.boolean() }).strict())
        .output(z.object({ archived: z.boolean() }))
        .mutation(({ input, ctx }) => projects.archiveProject(actorOf(ctx), input)),
    }),

    boards: router({
      list: route({ permission: 'board:read' })
        .input(
          z
            .object({ projectId: ProjectIdSchema, includeArchived: z.boolean().default(false) })
            .strict(),
        )
        .output(
          z
            .array(
              z.object({
                boardId: z.string(),
                projectId: z.string(),
                name: z.string(),
                rank: z.string(),
                archivedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => boards.listBoards(actorOf(ctx), input)),

      create: route({ permission: 'board:create' })
        .input(z.object({ projectId: ProjectIdSchema, name: Name }).strict())
        .output(z.object({ boardId: z.string() }))
        .mutation(({ input, ctx }) => boards.createBoard(actorOf(ctx), input)),

      update: route({ permission: 'board:update' })
        .input(z.object({ boardId: BoardIdSchema, name: Name }).strict())
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => boards.updateBoard(actorOf(ctx), input)),

      archive: route({ permission: 'board:delete' })
        .input(z.object({ boardId: BoardIdSchema, archived: z.boolean() }).strict())
        .output(z.object({ archived: z.boolean() }))
        .mutation(({ input, ctx }) => boards.archiveBoard(actorOf(ctx), input)),
    }),

    lists: router({
      list: route({ permission: 'board:read' })
        .input(z.object({ boardId: BoardIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                listId: z.string(),
                boardId: z.string(),
                name: z.string(),
                rank: z.string(),
                wipLimit: z.number().int().nullable(),
                cardCount: z.number().int().nonnegative(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => lists.listLists(actorOf(ctx), input)),

      /**
       * `board:update`, not a `list:*` permission.
       *
       * Adding, renaming and reordering columns is editing the board's shape.
       * A separate permission would be one nobody grants separately and one
       * more row in the matrix to keep correct.
       */
      create: route({ permission: 'board:update' })
        .input(
          z
            .object({
              boardId: BoardIdSchema,
              name: Name,
              wipLimit: z.number().int().positive().max(999).nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ listId: z.string() }))
        .mutation(({ input, ctx }) => lists.createList(actorOf(ctx), input)),

      update: route({ permission: 'board:update' })
        .input(
          z
            .object({
              listId: ListIdSchema,
              name: Name,
              wipLimit: z.number().int().positive().max(999).nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => lists.updateList(actorOf(ctx), input)),

      /**
       * Reorder by NEIGHBOURS (§10.1). There is deliberately no way to send a
       * rank or an index — the server derives the value, so two people
       * reordering at once converge instead of overwriting each other.
       */
      reorder: route({ permission: 'board:update' })
        .input(
          z
            .object({
              listId: ListIdSchema,
              beforeListId: ListIdSchema.nullable().default(null),
              afterListId: ListIdSchema.nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ rank: z.string() }))
        .mutation(({ input, ctx }) => lists.reorderList(actorOf(ctx), input)),

      archive: route({ permission: 'board:update' })
        .input(z.object({ listId: ListIdSchema }).strict())
        .output(z.object({ archived: z.literal(true) }))
        .mutation(({ input, ctx }) => lists.archiveList(actorOf(ctx), input)),
    }),

    cards: router({
      /**
       * The board render — every live card, grouped by list on the client.
       *
       * `filter` is the AST from §10.2, parsed here against `FilterTree` and
       * validated against the field whitelist inside the service. The visual
       * builder edits this tree directly, and Phase 8's TQL parser will produce
       * the same shape — which is the whole reason filtering is built once.
       *
       * Note what the schema does NOT accept: a SQL string, a field name the
       * whitelist has not heard of, or an operator outside the closed list.
       */
      list: route({ permission: 'card:read' })
        .input(
          z
            .object({
              boardId: BoardIdSchema,
              filter: FilterTree.nullable().default(null),
              /* Defaults false so every existing caller — the board render
                 above all — keeps seeing exactly the live cards it always has.
                 Set true to reach the archived ones for a restore view; see
                 `listCards` for why this REPLACES the hardcoded exclusion
                 rather than composing with the `archived` filter field. */
              includeArchived: z.boolean().default(false),
            })
            .strict(),
        )
        .output(
          z
            .array(
              z.object({
                cardId: z.string(),
                listId: z.string(),
                boardId: z.string(),
                reference: z.string(),
                title: z.string(),
                rank: z.string(),
                assigneeIds: z.array(z.string()).readonly(),
                statusId: z.string().nullable(),
                priority: Priority.nullable(),
                dueDate: z.date().nullable(),
                commentCount: z.number().int().nonnegative(),
                checklistDone: z.number().int().nonnegative(),
                checklistTotal: z.number().int().nonnegative(),
                version: z.number().int().positive(),
                archivedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => cards.listCards(actorOf(ctx), input)),

      get: route({ permission: 'card:read' })
        .input(z.object({ cardId: CardIdSchema }).strict())
        .output(
          z.object({
            cardId: z.string(),
            listId: z.string(),
            boardId: z.string(),
            reference: z.string(),
            title: z.string(),
            description: z.unknown(),
            rank: z.string(),
            assigneeIds: z.array(z.string()).readonly(),
            statusId: z.string().nullable(),
            priority: Priority.nullable(),
            dueDate: z.date().nullable(),
            startDate: z.date().nullable(),
            commentCount: z.number().int().nonnegative(),
            checklistDone: z.number().int().nonnegative(),
            checklistTotal: z.number().int().nonnegative(),
            version: z.number().int().positive(),
            createdAt: z.date(),
            updatedAt: z.date(),
          }),
        )
        .query(({ input, ctx }) => cards.getCard(actorOf(ctx), input)),

      create: route({ permission: 'card:create' })
        .input(
          z
            .object({
              listId: ListIdSchema,
              title: Title,
              description: Description.default(null),
            })
            .strict(),
        )
        .output(z.object({ cardId: z.string(), reference: z.string() }))
        .mutation(({ input, ctx }) => cards.createCard(actorOf(ctx), input)),

      /**
       * `version` is required and is not optional by omission.
       *
       * It is the optimistic concurrency check (§7.1): the client returns the
       * version it rendered, and a mismatch is a CONFLICT rather than a silent
       * overwrite of whatever the other editor just wrote. Defaulting it would
       * turn the control off for every caller that forgot it.
       */
      update: route({ permission: 'card:update' })
        .input(
          z
            .object({
              cardId: CardIdSchema,
              version: z.number().int().positive(),
              title: Title,
              description: Description.default(null),
              dueDate: Timestamp.default(null),
              startDate: Timestamp.default(null),
              priority: Priority.nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ version: z.number().int().positive() }))
        .mutation(({ input, ctx }) => cards.updateCard(actorOf(ctx), input)),

      /**
       * A dedicated route, not folded into `update` — see `setCardStatus` for
       * why. Not a full replace: dragging a card between status columns has
       * never read its description or dates and should not need to.
       */
      setStatus: route({ permission: 'card:update' })
        .input(
          z.object({ cardId: CardIdSchema, statusId: StatusIdSchema.nullable() }).strict(),
        )
        .output(z.object({ statusId: z.string().nullable() }))
        .mutation(({ input, ctx }) => cards.setCardStatus(actorOf(ctx), input)),

      /**
       * The move API from §10.1 — neighbours in, rank derived on the server.
       *
       * Both neighbours null means "the only card in the list". One null means
       * an end. There is no `position` and no `rank` field, and adding one
       * would reintroduce exactly the race this shape exists to remove.
       */
      move: route({ permission: 'card:move' })
        .input(
          z
            .object({
              cardId: CardIdSchema,
              targetListId: ListIdSchema,
              beforeCardId: CardIdSchema.nullable().default(null),
              afterCardId: CardIdSchema.nullable().default(null),
            })
            .strict(),
        )
        .output(
          z.object({
            rank: z.string(),
            listId: z.string(),
            wipExceeded: z.boolean(),
            rebalanced: z.boolean(),
          }),
        )
        .mutation(({ input, ctx }) => cards.moveCard(actorOf(ctx), input)),

      assign: route({ permission: 'card:update' })
        .input(
          z
            .object({
              cardId: CardIdSchema,
              assigneeIds: z.array(UserIdSchema).max(20),
            })
            .strict(),
        )
        .output(z.object({ assigneeIds: z.array(z.string()).readonly() }))
        .mutation(({ input, ctx }) => cards.assignCard(actorOf(ctx), input)),

      archive: route({ permission: 'card:delete' })
        .input(z.object({ cardId: CardIdSchema, archived: z.boolean() }).strict())
        .output(z.object({ archived: z.boolean() }))
        .mutation(({ input, ctx }) => cards.archiveCard(actorOf(ctx), input)),
    }),

    /**
     * Card detail — labels, checklists, custom fields, comments.
     *
     * A separate module because the permission split it encodes is different:
     * these routes divide along "project vocabulary" versus "one card", where
     * the routes above divide along the container hierarchy. Merging them here
     * keeps `work.labels.*` reachable at one dot-path while letting that
     * reasoning live next to the services it constrains.
     */
    ...createCardDetailRouter()._def.record,

    /**
     * Attachments (§8.4).
     *
     * ⚠ HUMAN REVIEW SURFACE (§2.2). Kept in its own module because the upload
     * pipeline is the one part of Work whose correctness depends on three
     * external systems agreeing — storage, the magic-byte table, and the
     * scanner.
     */
    attachments: createAttachmentRouter(deps.attachments),
  });
}
