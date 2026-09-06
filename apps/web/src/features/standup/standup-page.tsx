import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Flame,
  PlayCircle,
  Sparkles,
} from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { useFeatureGranted } from '../../lib/entitlements.js';
import { formatDate } from '../../lib/format.js';
import { Avatar, Button, Empty, PageHeader, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { orgDetailQuery } from '../org/api.js';
import { projectsQuery } from '../work/api.js';
import type { Priority } from '../work/api.js';
import { PRIORITY_LABEL, PRIORITY_SWATCH } from '../work/priority-colors.js';
import { cn } from '../../lib/cn.js';
import {
  standupQuery,
  narrateStandup,
  type StandupCallout,
  type StandupCard,
  type StandupMember,
} from './api.js';
import { CardQuickView } from '../work/card-quick-view.js';

/**
 * The standup view (ai/phase-15-ai-copilot-and-permissions.md §5).
 *
 * "A new screen, not a new subsystem" — every read here is
 * `standup.query`, already assembled server-side from cards Work already
 * tracks; every write a card row offers is `CardQuickView`, the real board
 * detail panel opened without a board in hand (see that file's own header).
 * Nothing here re-derives `can()` — `query`'s floor is `project:read`, so a
 * guest who cannot read the project gets a server FORBIDDEN like any other
 * route, and this page renders whatever comes back.
 *
 * ## Every member gets their own row, collapsed by default
 *
 * The first version rendered every person's full card lists, always
 * expanded, in a fixed 2/3-empty 3-column grid per person — for ~15 people
 * that is an enormous page where "Still open" (often 8-13 cards) is the
 * only column with anything in it, squeezed into a third of the width, so
 * every title truncated into an unreadable fragment. Collapsing each
 * person to a name-plus-counts row fixes the space problem without hiding
 * anyone: every project member still gets their own row regardless of
 * whether they have anything noteworthy — nobody is merged into a shared
 * "quiet" bucket or reordered by urgency, on purpose (a real product
 * decision, not an oversight: a standup is a roll call, and skipping
 * someone because their day looked ordinary is exactly the kind of "quiet
 * default" this file's own reviewer rejected). Expanding a row shows the
 * real Yesterday/Today/Overdue/Urgent breakdown described below.
 *
 * ## REDESIGNED: real Yesterday/Today/Overdue/Urgent, and AI is now optional
 *
 * The second version still asked a model to write one prose sentence per
 * person, blending "still open" (the whole non-done backlog, not just
 * active work) into a line like "still working on X and Y" — which read as
 * arbitrary because it effectively was: the model was picking two cards out
 * of a person's entire backlog with no signal for which ones actually
 * represented "today". `standup.service.ts` now buckets deterministically
 * into what a real standup actually asks — done recently (yesterday), an
 * `active`-status card (today), overdue, and urgent/high priority — and
 * this page renders those real lists directly. No AI call is needed to see
 * a complete, meaningful standup: `headline` and every member's four
 * buckets come from `query` alone. "Narrate" now adds exactly one optional
 * thing on top — a short team-wide callout for a cross-person pattern (a
 * shared blocker, one person carrying an unusual load) — never a per-person
 * line, since a person's own status is already shown next to their name.
 */
export function StandupPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/standup' });
  const orgId = useSession((state) => state.orgId) ?? '';
  const queryClient = useQueryClient();
  const [openCardId, setOpenCardId] = useState<CardId | null>(null);
  const [callout, setCallout] = useState<StandupCallout | null>(null);

  const sinceHours = 24;
  const projects = useQuery({ ...projectsQuery(orgId), enabled: orgId !== '' });
  const standup = useQuery(standupQuery(orgId, projectId, sinceHours));

  /* Narration is inline-gated, not route-gated: `query`'s floor is
     `project:read` (every project member), but `narrate` additionally needs
     `ai:use` + the `aiAssistant` plan flag — the identical two-gate shape
     `/assistant` wraps its whole route in. A member without either simply
     does not see the button, per Phase 15 §1's "hide entirely" rule; the
     server re-checks both regardless. */
  const canUseAi = useQuery(orgDetailQuery(orgId)).data?.capabilities.useAi === true;
  const aiAssistantFlag = useFeatureGranted('aiAssistant');

  const narrate = useMutation({
    mutationFn: () => narrateStandup(projectId, sinceHours),
    onSuccess: (result) => {
      setCallout(result);
    },
  });

  const project = (projects.data ?? []).find((entry) => entry.projectId === projectId);

  if (standup.isError)
    return <ErrorView error={standup.error} title="Could not load the standup" />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Standup"
        description={`${project?.name ?? 'This project'} — the last ${String(sinceHours)} hours, plus this sprint's urgent work.`}
        actions={
          canUseAi &&
          aiAssistantFlag === true && (
            <Button
              size="sm"
              variant="primary"
              disabled={narrate.isPending || standup.isPending}
              onClick={() => {
                narrate.mutate();
              }}
            >
              <Sparkles aria-hidden="true" className="size-3.5" />
              {narrate.isPending ? 'Looking for patterns…' : 'Narrate'}
            </Button>
          )
        }
      />

      {/* A plain count over real data, needing no AI call — `query`'s own
          `headline` field, shown as soon as the standup loads. */}
      {standup.data !== undefined && (
        <p className="text-sm text-ink-muted">{standup.data.headline}</p>
      )}

      {narrate.isError && (
        <ErrorView error={narrate.error} title="Could not summarize the standup" />
      )}

      {callout !== null && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-accent">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Team callout
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink">{callout.callout}</p>
        </div>
      )}

      {standup.isPending ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          {standup.data.sprint !== null && standup.data.urgentSprintCards.length > 0 && (
            <section className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
                <AlertTriangle aria-hidden="true" className="size-3.5 text-priority-urgent" />
                {standup.data.sprint.name} — urgent &amp; high priority
              </h2>
              <ul className="space-y-1">
                {standup.data.urgentSprintCards.map((card) => (
                  <StandupCardRow
                    key={card.cardId}
                    card={card}
                    onManage={() => {
                      setOpenCardId(card.cardId as CardId);
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          {standup.data.members.length === 0 ? (
            <Empty
              title="Nothing to report"
              description="No cards have moved, are open, or are overdue for anyone on this project in the selected window."
            />
          ) : (
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {standup.data.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  onManage={(cardId) => {
                    setOpenCardId(cardId as CardId);
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {openCardId !== null && (
        <CardQuickView
          orgId={orgId}
          cardId={openCardId}
          onClose={(card) => {
            /* The standup buckets are computed from assignee/priority/status,
               all of which this panel can change — so closing it is the
               point at which the standup view needs to be told it may be
               stale. Scoped to this project's standup entries specifically
               (no `sinceHours` in the key prefix), not the whole `projects`
               branch — a card edit has no bearing on the project list,
               boards, or label vocabulary also living under that prefix. */
            if (card !== undefined) {
              void queryClient.invalidateQueries({
                queryKey: ['org', orgId, 'projects', card.projectId, 'standup'],
              });
            }
            setOpenCardId(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * One member, collapsed to a single row by default. `CountBadge`s answer
 * "does this person need a look" without opening anything; opening shows
 * the exact three-bucket breakdown the always-expanded version showed, now
 * with the full page width to itself instead of a third of it shared with
 * fourteen other people's sections.
 */
function MemberRow({
  member,
  onManage,
}: {
  readonly member: StandupMember;
  readonly onManage: (cardId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const nothing =
    member.yesterday.length === 0 &&
    member.today.length === 0 &&
    member.overdue.length === 0 &&
    member.urgent.length === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setExpanded((current) => !current);
        }}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover/40"
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
        )}
        <Avatar userId={member.userId} label={member.name ?? member.userId} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {member.name ?? 'Unknown'}
        </span>

        <span className="flex shrink-0 items-center gap-3 text-xs">
          <CountBadge
            icon={<CheckCircle2 aria-hidden="true" className="size-3.5" />}
            count={member.yesterday.length}
            tone="success"
            label="done yesterday"
          />
          <CountBadge
            icon={<PlayCircle aria-hidden="true" className="size-3.5" />}
            count={member.today.length}
            tone="active"
            label="in progress today"
          />
          <CountBadge
            icon={<AlertTriangle aria-hidden="true" className="size-3.5" />}
            count={member.overdue.length}
            tone="danger"
            label="overdue"
          />
          <CountBadge
            icon={<Flame aria-hidden="true" className="size-3.5" />}
            count={member.urgent.length}
            tone="urgent"
            label="urgent"
          />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-line/60 bg-surface-sunken/30 px-4 py-3">
          {nothing ? (
            <p className="text-xs text-ink-faint">Nothing to report for this window.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Bucket
                label="Yesterday"
                icon={<CheckCircle2 aria-hidden="true" className="size-3.5 text-success" />}
                cards={member.yesterday}
                onManage={onManage}
              />
              <Bucket
                label="Today"
                icon={<PlayCircle aria-hidden="true" className="size-3.5 text-accent" />}
                cards={member.today}
                onManage={onManage}
              />
              <Bucket
                label="Overdue"
                icon={<AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />}
                cards={member.overdue}
                onManage={onManage}
              />
              <Bucket
                label="Urgent"
                icon={<Flame aria-hidden="true" className="size-3.5 text-priority-urgent" />}
                cards={member.urgent}
                onManage={onManage}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const COUNT_BADGE_TONE: Readonly<Record<'success' | 'active' | 'danger' | 'urgent', string>> = {
  success: 'text-success',
  active: 'text-accent',
  danger: 'text-danger',
  urgent: 'text-priority-urgent',
};

/** A count with its icon, dimmed to near-invisible at zero — a badge that answers
    "is there anything here" at a glance is more useful than one that always shouts. */
function CountBadge({
  icon,
  count,
  tone,
  label,
}: {
  readonly icon: React.ReactNode;
  readonly count: number;
  readonly tone: 'success' | 'active' | 'danger' | 'urgent';
  readonly label: string;
}) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 tabular-nums',
        count > 0 ? COUNT_BADGE_TONE[tone] : 'text-ink-faint/40',
      )}
      title={`${String(count)} ${label}`}
    >
      {icon}
      {count}
    </span>
  );
}

function Bucket({
  label,
  icon,
  cards,
  onManage,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly cards: readonly StandupCard[];
  readonly onManage: (cardId: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint">
        {icon}
        {label}
        <span className="ml-auto tabular-nums">{cards.length}</span>
      </p>
      {cards.length === 0 ? (
        <p className="text-[11px] text-ink-faint">Nothing</p>
      ) : (
        <ul className="space-y-1">
          {cards.map((card) => (
            <StandupCardRow
              key={card.cardId}
              card={card}
              onManage={() => {
                onManage(card.cardId);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A card's title on its OWN line, metadata (priority dot, reference, due
 * date) on a compact line above it. The previous single-row flex layout
 * packed reference + title + due date into one horizontal line and gave the
 * title whatever width was left over — fine at the top-level urgent-sprint
 * list (the full page width), and unreadable inside a four-column bucket
 * grid, where "left over" was often under 100px: a real title wrapped to
 * one or two words per line for a dozen lines, found from a real screenshot
 * rather than a layout review. Stacking metadata above the title instead
 * means the title always gets the FULL row width to wrap into, regardless
 * of how narrow the surrounding column is.
 */
function StandupCardRow({
  card,
  onManage,
}: {
  readonly card: StandupCard;
  readonly onManage: () => void;
}) {
  const priority = isPriority(card.priority) ? card.priority : null;

  return (
    <li>
      <button
        type="button"
        onClick={onManage}
        className="flex w-full flex-col gap-1 rounded-lg border border-line/60 bg-surface-sunken px-2 py-1.5 text-left text-xs hover:border-accent"
      >
        <span className="flex items-center gap-1.5">
          {priority !== null && (
            <span
              aria-hidden="true"
              title={PRIORITY_LABEL[priority]}
              className={cn(
                'size-2 shrink-0 rounded-full ring-1 ring-ink/10',
                PRIORITY_SWATCH[priority],
              )}
            />
          )}
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{card.reference}</span>
          {card.dueDate !== null && (
            <span className="ml-auto shrink-0 text-[10px] whitespace-nowrap text-ink-faint">
              {formatDate(card.dueDate)}
            </span>
          )}
        </span>
        <span className="break-words text-ink">{card.title}</span>
      </button>
    </li>
  );
}

function isPriority(value: string | null): value is Priority {
  return value === 'urgent' || value === 'high' || value === 'normal' || value === 'low';
}
