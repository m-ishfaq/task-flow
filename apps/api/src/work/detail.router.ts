import { z } from 'zod';
import {
  CardIdSchema,
  ChecklistIdSchema,
  ChecklistItemIdSchema,
  CommentIdSchema,
  CustomFieldIdSchema,
  LabelIdSchema,
  ProjectIdSchema,
  StatusCategory,
  StatusIdSchema,
} from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import { RichTextDocument } from './richtext.js';
import { CUSTOM_FIELD_TYPES, CustomFieldOptions } from './custom-field-value.js';
import type { WorkActor } from './shared.js';
import * as labels from './label.service.js';
import * as statuses from './status.service.js';
import * as checklists from './checklist.service.js';
import * as fields from './custom-field.service.js';
import * as comments from './comment.service.js';

/**
 * Card detail routes — labels, statuses, checklists, custom fields, comments
 * (§3.1, and statuses per `ai/phase-3.5-work-ux.md` §5).
 *
 * The permission on each route is worth reading as a pair with its service.
 * Two distinct authorization questions run through this file:
 *
 *   `project:update`  changing the project's VOCABULARY — the label set, the
 *                     status set, the custom field definitions. Affects
 *                     every card.
 *   `card:update`     changing ONE card — which labels it carries, what its
 *                     fields say, its checklists.
 *
 * Setting a card's STATUS is `card:update` too, but it is not in this file —
 * `cards.setStatus` lives in `router.ts` next to `cards.assign`, since it is a
 * card-hierarchy route rather than a vocabulary one. Only status MANAGEMENT
 * (`statuses.list/create/update/delete`) belongs here.
 *
 * and comments use neither: `comment:create` exists precisely so someone can be
 * given a voice on a board without being given edit rights (§8.2).
 */

const Name = z.string().trim().min(1).max(120);

/** Hex triplet, lowercased. The migration's CHECK is the second copy. */
const Color = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(/^#[0-9a-f]{6}$/, 'Use a hex colour like #4f46e5.'));

export function createCardDetailRouter() {
  /* The same construction as the Work router's. Built here rather than passed
     in, because threading it through would need a parameter type naming the
     tRPC context, and that is exactly the coupling `subjectOf` exists to
     absorb. */
  const actor = (ctx: {
    principal: Parameters<typeof subjectOf>[0];
    requestId: WorkActor['requestId'];
  }): WorkActor => ({ subject: subjectOf(ctx.principal), requestId: ctx.requestId });

  return router({
    labels: router({
      list: route({ permission: 'project:read' })
        .input(z.object({ projectId: ProjectIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                labelId: z.string(),
                projectId: z.string(),
                name: z.string(),
                color: z.string(),
                cardCount: z.number().int().nonnegative(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => labels.listLabels(actor(ctx), input)),

      /**
       * `project:update` — a label is part of the project's vocabulary, and
       * adding one changes what every board in it offers.
       */
      create: route({ permission: 'project:update' })
        .input(z.object({ projectId: ProjectIdSchema, name: Name, color: Color }).strict())
        .output(z.object({ labelId: z.string() }))
        .mutation(({ input, ctx }) => labels.createLabel(actor(ctx), input)),

      update: route({ permission: 'project:update' })
        .input(z.object({ labelId: LabelIdSchema, name: Name, color: Color }).strict())
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => labels.updateLabel(actor(ctx), input)),

      /** A real delete, not an archive — see the service for why. */
      delete: route({ permission: 'project:update' })
        .input(z.object({ labelId: LabelIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true), cardCount: z.number().int().nonnegative() }))
        .mutation(({ input, ctx }) => labels.deleteLabel(actor(ctx), input)),

      /**
       * `card:update`, not `project:update`. Tagging a card is editing that
       * card; a member who can move their own work can label it.
       */
      setOnCard: route({ permission: 'card:update' })
        .input(
          z.object({ cardId: CardIdSchema, labelIds: z.array(LabelIdSchema).max(50) }).strict(),
        )
        .output(z.object({ labelIds: z.array(z.string()).readonly() }))
        .mutation(({ input, ctx }) => labels.setCardLabels(actor(ctx), input)),

      onCard: route({ permission: 'card:read' })
        .input(z.object({ cardId: CardIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                labelId: z.string(),
                projectId: z.string(),
                name: z.string(),
                color: z.string(),
                cardCount: z.number().int().nonnegative(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => labels.listCardLabels(actor(ctx), input)),
    }),

    statuses: router({
      list: route({ permission: 'project:read' })
        .input(z.object({ projectId: ProjectIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                statusId: z.string(),
                projectId: z.string(),
                name: z.string(),
                category: StatusCategory,
                color: z.string(),
                position: z.number().int(),
                isDefault: z.boolean(),
                cardCount: z.number().int().nonnegative(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => statuses.listStatuses(actor(ctx), input)),

      /** `project:update` — a status is project vocabulary, same as a label. */
      create: route({ permission: 'project:update' })
        .input(
          z
            .object({
              projectId: ProjectIdSchema,
              name: Name,
              category: StatusCategory,
              color: Color,
              isDefault: z.boolean().default(false),
            })
            .strict(),
        )
        .output(z.object({ statusId: z.string() }))
        .mutation(({ input, ctx }) => statuses.createStatus(actor(ctx), input)),

      update: route({ permission: 'project:update' })
        .input(
          z
            .object({
              statusId: StatusIdSchema,
              name: Name,
              category: StatusCategory,
              color: Color,
              isDefault: z.boolean().default(false),
            })
            .strict(),
        )
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => statuses.updateStatus(actor(ctx), input)),

      /** A real delete, not an archive — see the service for why. */
      delete: route({ permission: 'project:update' })
        .input(z.object({ statusId: StatusIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true), cardCount: z.number().int().nonnegative() }))
        .mutation(({ input, ctx }) => statuses.deleteStatus(actor(ctx), input)),
    }),

    checklists: router({
      list: route({ permission: 'card:read' })
        .input(z.object({ cardId: CardIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                checklistId: z.string(),
                cardId: z.string(),
                name: z.string(),
                rank: z.string(),
                items: z
                  .array(
                    z.object({
                      itemId: z.string(),
                      text: z.string(),
                      rank: z.string(),
                      done: z.boolean(),
                      doneBy: z.string().nullable(),
                      doneAt: z.date().nullable(),
                    }),
                  )
                  .readonly(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => checklists.listChecklists(actor(ctx), input)),

      create: route({ permission: 'card:update' })
        .input(z.object({ cardId: CardIdSchema, name: Name }).strict())
        .output(z.object({ checklistId: z.string() }))
        .mutation(({ input, ctx }) => checklists.createChecklist(actor(ctx), input)),

      delete: route({ permission: 'card:update' })
        .input(z.object({ checklistId: ChecklistIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => checklists.deleteChecklist(actor(ctx), input)),

      addItem: route({ permission: 'card:update' })
        .input(
          z
            .object({ checklistId: ChecklistIdSchema, text: z.string().trim().min(1).max(500) })
            .strict(),
        )
        .output(z.object({ itemId: z.string() }))
        .mutation(({ input, ctx }) => checklists.addItem(actor(ctx), input)),

      /**
       * One route for renaming and for ticking.
       *
       * Both are "edit this item", and splitting them would mean a client that
       * renames a done item has to send two requests and get the order right.
       */
      updateItem: route({ permission: 'card:update' })
        .input(
          z
            .object({
              itemId: ChecklistItemIdSchema,
              text: z.string().trim().min(1).max(500),
              done: z.boolean(),
            })
            .strict(),
        )
        .output(z.object({ done: z.boolean() }))
        .mutation(({ input, ctx }) => checklists.updateItem(actor(ctx), input)),

      deleteItem: route({ permission: 'card:update' })
        .input(z.object({ itemId: ChecklistItemIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => checklists.deleteItem(actor(ctx), input)),
    }),

    fields: router({
      list: route({ permission: 'project:read' })
        .input(
          z
            .object({ projectId: ProjectIdSchema, includeArchived: z.boolean().default(false) })
            .strict(),
        )
        .output(
          z
            .array(
              z.object({
                fieldId: z.string(),
                projectId: z.string(),
                name: z.string(),
                type: z.string(),
                options: z.unknown(),
                rank: z.string(),
                archivedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => fields.listFields(actor(ctx), input)),

      create: route({ permission: 'project:update' })
        .input(
          z
            .object({
              projectId: ProjectIdSchema,
              name: Name,
              type: z.enum(CUSTOM_FIELD_TYPES),
              options: CustomFieldOptions.nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ fieldId: z.string() }))
        .mutation(({ input, ctx }) => fields.createField(actor(ctx), input)),

      /** Rename only. The TYPE is immutable — see the service for why. */
      update: route({ permission: 'project:update' })
        .input(z.object({ fieldId: CustomFieldIdSchema, name: Name }).strict())
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => fields.updateField(actor(ctx), input)),

      /** Archived, not deleted: the VALUES are data users entered. */
      archive: route({ permission: 'project:update' })
        .input(z.object({ fieldId: CustomFieldIdSchema, archived: z.boolean() }).strict())
        .output(z.object({ archived: z.boolean() }))
        .mutation(({ input, ctx }) => fields.archiveField(actor(ctx), input)),

      onCard: route({ permission: 'card:read' })
        .input(z.object({ cardId: CardIdSchema }).strict())
        .output(z.array(z.object({ fieldId: z.string(), value: z.unknown() })).readonly())
        .query(({ input, ctx }) => fields.listCardValues(actor(ctx), input)),

      /**
       * `value` is `unknown` at the boundary on purpose.
       *
       * Its legal shape depends on the field's declared type, which only the
       * database knows — so the check happens in the service, against the
       * definition it just read. A Zod union here would have to guess which
       * member applies before knowing the type, and would accept a date string
       * for a number field on the grounds that some field somewhere takes
       * strings.
       */
      setOnCard: route({ permission: 'card:update' })
        .input(
          z
            .object({
              cardId: CardIdSchema,
              fieldId: CustomFieldIdSchema,
              value: z.unknown(),
            })
            .strict()
            /* `z.unknown()` infers as OPTIONAL, so an omitted key and an
               explicit null arrive as the same absent property. Normalizing to
               null here makes "clear this field" one shape by the time the
               service sees it, rather than two the service has to treat alike
               and might not. */
            .transform((parsed) => ({ ...parsed, value: parsed.value ?? null })),
        )
        .output(z.object({ value: z.unknown() }))
        .mutation(({ input, ctx }) => fields.setCardValue(actor(ctx), input)),
    }),

    comments: router({
      list: route({ permission: 'card:read' })
        .input(z.object({ cardId: CardIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                commentId: z.string(),
                cardId: z.string(),
                authorId: z.string().nullable(),
                body: z.unknown(),
                bodyText: z.string(),
                editedAt: z.date().nullable(),
                deletedAt: z.date().nullable(),
                createdAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => comments.listComments(actor(ctx), input)),

      /**
       * `comment:create` — the permission a `commenter` tuple grants (§8.2).
       *
       * Using `card:update` here would make read-only-plus-comment access
       * impossible to express, which is the entire point of that relation.
       */
      create: route({ permission: 'comment:create' })
        .input(z.object({ cardId: CardIdSchema, body: RichTextDocument }).strict())
        .output(z.object({ commentId: z.string() }))
        .mutation(({ input, ctx }) => comments.createComment(actor(ctx), input)),

      /** Author only, enforced in the service — no permission overrides it. */
      update: route({ permission: 'comment:create' })
        .input(z.object({ commentId: CommentIdSchema, body: RichTextDocument }).strict())
        .output(z.object({ edited: z.literal(true) }))
        .mutation(({ input, ctx }) => comments.updateComment(actor(ctx), input)),

      /**
       * Declared `comment:create` because that is the floor: an author
       * withdrawing their own comment needs no moderation right. The service
       * escalates to `comment:delete` when the caller is not the author, which
       * is a check the route builder cannot make — it does not know who wrote
       * the comment until the row is loaded.
       */
      delete: route({ permission: 'comment:create' })
        .input(z.object({ commentId: CommentIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => comments.deleteComment(actor(ctx), input)),
    }),
  });
}
