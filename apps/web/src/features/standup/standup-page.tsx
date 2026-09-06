import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
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
  type StandupCard,
  type StandupMember,
  type StandupNarrationLine,
} from './api.js';
import { CardQuickView } from './card-quick-view.js';

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
 * identical three-bucket layout the first version always showed.
 */
export function StandupPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/standup' });
  const orgId = useSession((state) => state.orgId) ?? '';
  const [openCardId, setOpenCardId] = useState<CardId | null>(null);
  const [lines, setLines] = useState<readonly StandupNarrationLine[] | null>(null);

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
      setLines(result.lines);
    },
  });

  const project = (projects.data ?? []).find((entry) => entry.projectId === projectId);
  const nameOf = (userId: string): string =>
    standup.data?.members.find((member) => member.userId === userId)?.name ?? userId;

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
              {narrate.isPending ? 'Summarizing…' : 'Narrate'}
            </Button>
          )
        }
      />

      {narrate.isError && (
        <ErrorView error={narrate.error} title="Could not summarize the standup" />
      )}

      {lines !== null && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-accent">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Summary
          </p>
          {lines.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-faint">Nothing to report.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {lines.map((entry) => (
                <li key={entry.userId} className="text-sm leading-relaxed text-ink">
                  <span className="font-medium">{nameOf(entry.userId)}</span>
                  <span className="text-ink-muted"> — {entry.line}</span>
                </li>
              ))}
            </ul>
          )}
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
          onClose={() => {
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
    member.recentlyDone.length === 0 &&
    member.stillOpen.length === 0 &&
    member.overdue.length === 0;

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
            count={member.recentlyDone.length}
            tone="success"
            label="done recently"
          />
          <CountBadge
            icon={<Circle aria-hidden="true" className="size-3.5" />}
            count={member.stillOpen.length}
            tone="neutral"
            label="still open"
          />
          <CountBadge
            icon={<AlertTriangle aria-hidden="true" className="size-3.5" />}
            count={member.overdue.length}
            tone="danger"
            label="overdue"
          />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-line/60 bg-surface-sunken/30 px-4 py-3">
          {nothing ? (
            <p className="text-xs text-ink-faint">Nothing to report for this window.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <Bucket
                label="Done recently"
                icon={<CheckCircle2 aria-hidden="true" className="size-3.5 text-success" />}
                cards={member.recentlyDone}
                onManage={onManage}
              />
              <Bucket
                label="Still open"
                icon={<Circle aria-hidden="true" className="size-3.5 text-ink-faint" />}
                cards={member.stillOpen}
                onManage={onManage}
              />
              <Bucket
                label="Overdue"
                icon={<AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />}
                cards={member.overdue}
                onManage={onManage}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const COUNT_BADGE_TONE: Readonly<Record<'success' | 'neutral' | 'danger', string>> = {
  success: 'text-success',
  neutral: 'text-ink-faint',
  danger: 'text-danger',
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
  readonly tone: 'success' | 'neutral' | 'danger';
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
        className="flex w-full items-start gap-1.5 rounded-lg border border-line/60 bg-surface-sunken px-2 py-1.5 text-left text-xs hover:border-accent"
      >
        {priority !== null && (
          <span
            aria-hidden="true"
            title={PRIORITY_LABEL[priority]}
            className={cn(
              'mt-1 size-2 shrink-0 rounded-full ring-1 ring-ink/10',
              PRIORITY_SWATCH[priority],
            )}
          />
        )}
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{card.reference}</span>
        <span className="min-w-0 flex-1 break-words text-ink">{card.title}</span>
        {card.dueDate !== null && (
          <span className="shrink-0 text-[10px] whitespace-nowrap text-ink-faint">
            {formatDate(card.dueDate)}
          </span>
        )}
      </button>
    </li>
  );
}

function isPriority(value: string | null): value is Priority {
  return value === 'urgent' || value === 'high' || value === 'normal' || value === 'low';
}
