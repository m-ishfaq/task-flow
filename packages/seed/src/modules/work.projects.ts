import { createEvent } from '@taskflow/events';
import { rankSequence } from '@taskflow/contracts';
import {
  customFieldCreated,
  labelCreated,
  projectArchived,
  projectCreated,
  statusCreated,
} from '@taskflow/api/events/work';
import {
  customFields,
  LABEL_PALETTE,
  STATUS_SET,
  type CustomFieldSpec,
} from '../corpus.js';
import { defineSeedModule } from '../registry.js';
import { daysBefore, envelopeFor, latest } from '../support.js';
import { orgsModule, type SeededOrg } from './tenancy.orgs.js';
import type { ProjectPlan } from '../profiles.js';

/**
 * Projects, and the project-scoped vocabulary that hangs off them (statuses,
 * labels, custom field definitions) — the parts of the Work hierarchy that
 * exist before a single board or card does.
 *
 * `nextCardNumber` is deliberately left at the schema default here. The real
 * value depends on how many cards `work.cards` ends up writing for this
 * project — including the archived and soft-deleted extras the card mix adds
 * on top of the live count — so guessing it here would be the "leave the
 * counter at 1" trap CLAUDE.md warns about. `work.cards` advances it once it
 * knows the true count.
 */

export interface SeededStatus {
  readonly id: string;
  readonly name: string;
  readonly category: 'not_started' | 'active' | 'done';
  readonly isDefault: boolean;
}

export interface SeededLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface SeededCustomFieldDef {
  readonly id: string;
  readonly name: string;
  readonly type: CustomFieldSpec['type'];
  readonly options: readonly string[] | null;
}

export interface SeededProject {
  readonly id: string;
  readonly orgId: string;
  /** The org this project belongs to — carried by reference so `work.cards`
   * and `work.boards` never have to re-require `tenancy.orgs` just to reach
   * the member pool. */
  readonly org: SeededOrg;
  readonly name: string;
  readonly key: string;
  readonly plan: ProjectPlan;
  readonly statuses: readonly SeededStatus[];
  readonly defaultStatusId: string;
  readonly labels: readonly SeededLabel[];
  readonly customFieldDefs: readonly SeededCustomFieldDef[];
  readonly archived: boolean;
  readonly createdAt: Date;
}

export interface ProjectsOutput {
  readonly projects: readonly SeededProject[];
}

export const projectsModule = defineSeedModule({
  name: 'work.projects',
  requires: [orgsModule],
  tables: ['work.projects', 'work.statuses', 'work.labels', 'work.custom_field_defs'],

  async seed(ctx): Promise<ProjectsOutput> {
    const rng = ctx.rng.fork('work.projects');
    const { orgs } = ctx.use(orgsModule);
    const projects: SeededProject[] = [];

    for (const org of orgs) {
      for (const plan of org.plan.projects) {
        const projectId = rng.uuid(ctx.now);
        const createdAt = latest(org.createdAt, daysBefore(ctx.now, rng.int(30, 250)));
        const archived = plan.archived ?? false;
        const envelope = envelopeFor(org.id, org.owner.id, createdAt);

        const statuses: SeededStatus[] = STATUS_SET.map((spec) => ({
          id: rng.uuid(ctx.now),
          name: spec.name,
          category: spec.category,
          isDefault: spec.isDefault,
        }));
        const defaultStatus = statuses.find((status) => status.isDefault);
        if (!defaultStatus) {
          throw new Error('STATUS_SET has no default status — every project needs exactly one.');
        }

        const palette = rng.sample(LABEL_PALETTE, Math.min(plan.labels, LABEL_PALETTE.length));
        const labels: SeededLabel[] = palette.map((entry) => ({
          id: rng.uuid(ctx.now),
          name: entry.name,
          color: entry.color,
        }));

        const fieldSpecs = customFields(plan.customFields);
        const fieldRanks = rankSequence(fieldSpecs.length);
        const customFieldDefs: SeededCustomFieldDef[] = fieldSpecs.map((spec) => ({
          id: rng.uuid(ctx.now),
          name: spec.name,
          type: spec.type,
          options: spec.options,
        }));

        await ctx.orgScope(org.id, async () => {
          await ctx.db.insert(
            'work.projects',
            [
              'id',
              'org_id',
              'name',
              'key',
              'description',
              'next_card_number',
              'archived_at',
              'deleted_at',
              'created_by',
              'created_at',
              'updated_at',
            ],
            [
              [
                projectId,
                org.id,
                plan.name,
                plan.key,
                null,
                1,
                archived ? createdAt : null,
                null,
                org.owner.id,
                createdAt,
                createdAt,
              ],
            ],
          );

          await ctx.db.insert(
            'work.statuses',
            ['id', 'org_id', 'project_id', 'name', 'category', 'color', 'position', 'is_default', 'created_at'],
            statuses.map((status, index) => {
              const spec = STATUS_SET[index];
              if (!spec) throw new Error('STATUS_SET and statuses[] must stay the same length.');
              return [
                status.id,
                org.id,
                projectId,
                status.name,
                status.category,
                spec.color,
                index,
                status.isDefault,
                createdAt,
              ];
            }),
          );

          if (labels.length > 0) {
            await ctx.db.insert(
              'work.labels',
              ['id', 'org_id', 'project_id', 'name', 'color', 'created_at', 'updated_at'],
              labels.map((label) => [
                label.id,
                org.id,
                projectId,
                label.name,
                label.color,
                createdAt,
                createdAt,
              ]),
            );
          }

          if (customFieldDefs.length > 0) {
            await ctx.db.insert(
              'work.custom_field_defs',
              [
                'id',
                'org_id',
                'project_id',
                'name',
                'type',
                'options::jsonb',
                'rank',
                'archived_at',
                'created_at',
                'updated_at',
              ],
              customFieldDefs.map((field, index) => {
                const rank = fieldRanks[index];
                if (rank === undefined) {
                  throw new Error('rankSequence produced fewer ranks than custom field defs.');
                }
                return [
                  field.id,
                  org.id,
                  projectId,
                  field.name,
                  field.type,
                  field.options,
                  rank,
                  null,
                  createdAt,
                  createdAt,
                ];
              }),
            );
          }
        });

        ctx.emit(
          createEvent(projectCreated, { projectId, name: plan.name, key: plan.key }, envelope),
        );
        for (const status of statuses) {
          ctx.emit(
            createEvent(
              statusCreated,
              { statusId: status.id, projectId, name: status.name, category: status.category },
              envelope,
            ),
          );
        }
        for (const label of labels) {
          ctx.emit(
            createEvent(
              labelCreated,
              { labelId: label.id, projectId, name: label.name, color: label.color },
              envelope,
            ),
          );
        }
        for (const field of customFieldDefs) {
          ctx.emit(
            createEvent(
              customFieldCreated,
              { fieldId: field.id, projectId, name: field.name, type: field.type },
              envelope,
            ),
          );
        }
        if (archived) {
          ctx.emit(
            createEvent(
              projectArchived,
              { projectId, name: plan.name, restored: false },
              envelopeFor(org.id, org.owner.id, ctx.now),
            ),
          );
        }

        projects.push({
          id: projectId,
          orgId: org.id,
          org,
          name: plan.name,
          key: plan.key,
          plan,
          statuses,
          defaultStatusId: defaultStatus.id,
          labels,
          customFieldDefs,
          archived,
          createdAt,
        });
      }

      ctx.log(`work.projects: ${org.slug} — ${String(org.plan.projects.length)} projects`);
    }

    return { projects };
  },
});
