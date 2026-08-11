import { createEvent } from '@taskflow/events';
import { automationCreated } from '@taskflow/api/events/automation';
import { defineSeedModule } from '../registry.js';
import { envelopeFor } from '../support.js';
import { projectsModule } from './work.projects.js';
import { channelsModule } from './chat.channels.js';
import type { FilterNode } from '@taskflow/filter';

/**
 * Automation rules (Phase 10 Wave 1) — a few REAL rules per project.
 *
 * ## The ids are real, so the rules are live
 *
 * Every rule below names ids that actually exist in the seeded database — a
 * status from `SeededProject.statuses`, a label from `SeededProject.labels`,
 * a member from the org, a channel from `chat.channels`. That is the whole
 * point of the Wave 1 UI rebuild: nothing in the builder is paste-an-id any
 * more, so a seeded rule that held a made-up id would open in the editor as a
 * picker showing nothing, and a rule that fires on `card.status_changed`
 * would fail its action at execution. A seeded rule must be a rule a demo
 * user can open, read and trust.
 *
 * ## The shapes are what the server validates
 *
 * The three-place contract (vocabulary.ts, the route's Zod schema, the
 * executor's switch) means a rule this seeder writes is exercised by the SAME
 * validation the UI's save path uses — a seeded row that no longer parses is
 * a test failure waiting in a demo, not a fixture that drifted in private.
 *
 *   - `condition` is a `FilterNode` with the CARD field names (title, status,
 *     priority, label, ...) — the same closed catalog `packages/filter`
 *     compiles, so `label in [...]` and `status eq <id>` are valid trees.
 *   - `actions` is the discriminated union the route accepts: `card.move`,
 *     `card.set_status`, `card.set_priority`, `card.assign`, `card.add_label`,
 *     `card.remove_label`, `card.unassign`, `card.add_comment`,
 *     `chat.post_message`.
 *
 * Names are unique per org (the migration's `automations_org_name_key`), so
 * they are prefixed with the project key — two projects in one org would
 * otherwise collide.
 */

export interface AutomationsOutput {
  readonly ruleCount: number;
}

export const automationsModule = defineSeedModule({
  name: 'platform.automations',
  requires: [projectsModule, channelsModule],
  tables: ['platform.automations'],

  async seed(ctx): Promise<AutomationsOutput> {
    const { projects } = ctx.use(projectsModule);
    const { channels } = ctx.use(channelsModule);
    let ruleCount = 0;

    for (const project of projects) {
      const { orgId } = project;
      const owner = project.org.owner;
      const channel = channels[0];
      const statuses = project.statuses;
      const done = statuses.find((status) => status.category === 'done');
      const notStarted = statuses.find((status) => status.category === 'not_started');
      const firstLabel = project.labels[0];

      /* The rules every project gets — see the file header. The first is
         unconditional (an empty condition is a valid, useful rule); the
         triage one is the demo of a CONDITION; the announce one is the demo
         of the two-argument `chat.post_message` action — the exact action
         the single-input editor could never save. */
      const templates: {
        readonly name: string;
        readonly triggerEvent: string;
        readonly description: string;
        readonly condition: FilterNode | null;
        readonly actions: readonly unknown[];
      }[] = [
        {
          name: `${project.key} — ship it urgent`,
          triggerEvent: 'card.created',
          description: 'Anything new lands at high priority.',
          condition: null,
          actions: [{ type: 'card.set_priority', priority: 'high' }],
        },
      ];

      if (done !== undefined && firstLabel !== undefined) {
        templates.push({
          name: `${project.key} — triage labelled cards`,
          triggerEvent: 'card.labeled',
          description: 'A card with the first label moves to the first status.',
          condition: { kind: 'comparison', field: 'label', operator: 'in', value: [firstLabel.id] },
          actions: [{ type: 'card.set_status', statusId: done.id }],
        });
      }

      if (notStarted !== undefined && channel !== undefined) {
        templates.push({
          name: `${project.key} — announce on created`,
          triggerEvent: 'card.created',
          description: 'Say something when a card is created.',
          condition: { kind: 'comparison', field: 'status', operator: 'eq', value: notStarted.id },
          actions: [
            {
              type: 'chat.post_message',
              channelId: channel.id,
              body: 'A new card just landed — worth a look.',
            },
          ],
        });
      }

      for (const template of templates) {
        const automationId = ctx.rng.uuid(ctx.now);
        await ctx.orgScope(orgId, () =>
          ctx.db.insert(
            'platform.automations',
            [
              'id',
              'org_id',
              'name',
              'description',
              'trigger_event',
              'condition::jsonb',
              'actions::jsonb',
              'enabled',
              'created_by',
              'created_at',
              'updated_at',
            ],
            [
              [
                automationId,
                orgId,
                template.name,
                template.description,
                template.triggerEvent,
                template.condition,
                template.actions,
                true,
                owner.id,
                project.org.createdAt.toISOString(),
                project.org.createdAt.toISOString(),
              ],
            ],
          ),
        );

        ctx.emit(
          createEvent(
            automationCreated,
            {
              automationId,
              name: template.name,
              triggerEvent: template.triggerEvent,
              enabled: true,
              actionCount: template.actions.length,
            },
            envelopeFor(orgId, owner.id, project.org.createdAt),
          ),
        );

        ruleCount += 1;
      }
    }

    ctx.log(`platform.automations: ${String(ruleCount)} rule(s)`);
    return { ruleCount };
  },
});
