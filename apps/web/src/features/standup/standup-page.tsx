import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, Circle, Sparkles } from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { useFeatureGranted } from '../../lib/entitlements.js';
import { formatDate } from '../../lib/format.js';
import { Button, Empty, PageHeader, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { orgDetailQuery } from '../org/api.js';
import { projectsQuery } from '../work/api.js';
import type { Priority } from '../work/api.js';
import { PRIORITY_LABEL, PRIORITY_SWATCH } from '../work/priority-colors.js';
import { cn } from '../../lib/cn.js';
import { standupQuery, narrateStandup, type StandupCard, type StandupMember } from './api.js';
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
 */
export function StandupPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/standup' });
  const orgId = useSession((state) => state.orgId) ?? '';
  const [openCardId, setOpenCardId] = useState<CardId | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

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
      setSummary(result.summary);
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
              {narrate.isPending ? 'Summarizing…' : 'Narrate'}
            </Button>
          )
        }
      />

      {narrate.isError && (
        <ErrorView error={narrate.error} title="Could not summarize the standup" />
      )}

      {summary !== null && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-accent">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Summary
          </p>
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-ink">{summary}</p>
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
            <div className="space-y-5">
              {standup.data.members.map((member) => (
                <MemberSection
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

function MemberSection({
  member,
  onManage,
}: {
  readonly member: StandupMember;
  readonly onManage: (cardId: string) => void;
}) {
  const nothing =
    member.recentlyDone.length === 0 &&
    member.stillOpen.length === 0 &&
    member.overdue.length === 0;
  if (nothing) return null;

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">{member.name ?? 'Unknown'}</h3>

      <div className="mt-3 grid gap-4 sm:grid-cols-3">
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
    </section>
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
        className="flex w-full items-center gap-1.5 rounded-lg border border-line/60 bg-surface-sunken px-2 py-1.5 text-left text-xs hover:border-accent"
      >
        {priority !== null && (
          <span
            aria-hidden="true"
            title={PRIORITY_LABEL[priority]}
            className={cn('size-1.5 shrink-0 rounded-full', PRIORITY_SWATCH[priority])}
          />
        )}
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{card.reference}</span>
        <span className="min-w-0 flex-1 truncate text-ink">{card.title}</span>
        {card.dueDate !== null && (
          <span className="shrink-0 text-[10px] text-ink-faint">{formatDate(card.dueDate)}</span>
        )}
      </button>
    </li>
  );
}

function isPriority(value: string | null): value is Priority {
  return value === 'urgent' || value === 'high' || value === 'normal' || value === 'low';
}
