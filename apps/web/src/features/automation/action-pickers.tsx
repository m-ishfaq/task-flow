import { useQuery } from '@tanstack/react-query';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { unsafeAsId } from '@taskflow/contracts';
import {
  boardsQuery,
  labelsQuery,
  listsQuery,
  projectsQuery,
  statusesQuery,
} from '../work/api.js';
import { channelsQuery } from '../chat/api.js';
import { membersQuery } from '../org/api.js';
import { webhooksQuery } from './api.js';
import type { ArgumentKind } from './vocabulary.js';

/**
 * Pickers for a rule's action arguments.
 *
 * ## Why these exist
 *
 * The first builder rendered a text input per argument and expected a UUID to
 * be typed into it. Nobody knows a channel's UUID, so in practice the feature
 * required opening a second tab, finding the thing, and copying an id out of a
 * URL — for every action, on every rule. The ids were also unvalidated until
 * save, so a typo surfaced as a server error naming a constraint.
 *
 * Every option below comes from a query the app already had; none of this is
 * new API surface. The picker also narrows what CAN be chosen to what actually
 * exists, which is a correctness gain and not only an ergonomic one: a rule can
 * no longer name a list that was never in this org.
 *
 * ## The project-scope problem, made visible rather than introduced
 *
 * Lists, statuses and labels are PROJECT vocabulary. A rule is ORG-wide. So an
 * action that moves a card to "In review" names one project's list, and a card
 * from a different project cannot be moved there — the action fails and the run
 * records it.
 *
 * That mismatch predates these pickers; pasting an id had exactly the same
 * consequence, just later and less visibly. What the picker adds is that you
 * choose the project explicitly and can see which one you are binding the rule
 * to. The chosen project is a UI aid only — it is NOT stored on the rule, since
 * the action carries the id it resolved to, and the engine needs nothing else.
 */

export interface PickerProps {
  readonly orgId: string;
  readonly kind: ArgumentKind;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The project whose vocabulary to offer, for the project-scoped kinds. */
  readonly projectId: ProjectId | null;
  readonly label: string;
}

const SELECT_CLASS =
  'min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent';

export function ArgumentPicker(props: PickerProps) {
  switch (props.kind) {
    case 'priority':
      return <PriorityPicker {...props} />;
    case 'member':
      return <MemberPicker {...props} />;
    case 'channel':
      return <ChannelPicker {...props} />;
    case 'webhook':
      return <WebhookPicker {...props} />;
    case 'list':
      return <ListPicker {...props} />;
    case 'status':
      return <StatusPicker {...props} />;
    case 'label':
      return <LabelPicker {...props} />;
    case 'text':
      return (
        <input
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
          aria-label={props.label}
          placeholder={props.label}
          maxLength={2_000}
          className={SELECT_CLASS}
        />
      );
  }
}

/** A closed enum, so no query at all — the four values the card schema allows. */
function PriorityPicker({ value, onChange, label }: PickerProps) {
  return (
    <select
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      aria-label={label}
      className={SELECT_CLASS}
    >
      {['urgent', 'high', 'normal', 'low'].map((priority) => (
        <option key={priority} value={priority}>
          {priority}
        </option>
      ))}
    </select>
  );
}

function MemberPicker({ orgId, value, onChange, label }: PickerProps) {
  const members = useQuery({ ...membersQuery(orgId), enabled: orgId !== '' });

  return (
    <Choose
      value={value}
      onChange={onChange}
      label={label}
      pending={members.isPending}
      options={(members.data ?? []).map((member) => ({
        id: member.userId,
        /* Email as the fallback: a member with no display name set is
           common, and a blank option is unpickable. */
        name: member.displayName ?? member.email,
      }))}
      emptyText="No members"
    />
  );
}

function ChannelPicker({ orgId, value, onChange, label }: PickerProps) {
  const channels = useQuery({ ...channelsQuery(orgId), enabled: orgId !== '' });

  return (
    <Choose
      value={value}
      onChange={onChange}
      label={label}
      pending={channels.isPending}
      /* DMs are excluded: a rule posting into someone's direct message is
         either a mistake or a thing that should be a notification, and the
         channel a rule posts to should be one other people can see. */
      options={(channels.data ?? [])
        .filter((channel) => channel.type !== 'dm' && channel.type !== 'group_dm')
        .map((channel) => ({ id: channel.channelId, name: `#${channel.name ?? 'channel'}` }))}
      emptyText="No channels"
    />
  );
}

/**
 * Wave 2 — the registry, offered as options. Only ENABLED endpoints appear:
 * a rule naming a disabled webhook would record a failed run at every
 * execution, which is the outcome the picker exists to prevent. The URL is
 * shown next to the name so two endpoints called "Ship it" are tellable
 * apart — the one list in this builder where the stored id is not the only
 * thing worth seeing.
 */
function WebhookPicker({ orgId, value, onChange, label }: PickerProps) {
  const webhooks = useQuery({ ...webhooksQuery(orgId), enabled: orgId !== '' });

  return (
    <Choose
      value={value}
      onChange={onChange}
      label={label}
      pending={webhooks.isPending}
      options={(webhooks.data ?? [])
        .filter((webhook) => webhook.enabled)
        .map((webhook) => ({ id: webhook.webhookId, name: webhook.name }))}
      emptyText="No webhooks — create one on the Webhooks tab"
    />
  );
}

/**
 * Lists live under a BOARD, which lives under a project — so this is the one
 * picker that needs two levels. The board choice is local state rather than
 * part of the action, because the stored value is the list id alone.
 */
function ListPicker({ orgId, projectId, value, onChange, label }: PickerProps) {
  const boards = useQuery({
    ...boardsQuery(orgId, projectId ?? unsafeAsId<'ProjectId'>('')),
    enabled: orgId !== '' && projectId !== null,
  });

  const live = (boards.data ?? []).filter((board) => board.archivedAt === null);

  if (projectId === null) return <NeedsProject label={label} />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {live.map((board) => (
        <BoardLists
          key={board.boardId}
          orgId={orgId}
          boardId={unsafeAsId<'BoardId'>(board.boardId)}
          boardName={board.name}
          value={value}
          onChange={onChange}
          label={label}
        />
      ))}
      {!boards.isPending && live.length === 0 && (
        <span className="text-[11px] text-ink-faint">That project has no boards.</span>
      )}
    </div>
  );
}

/** One board's lists, as a labelled group. */
function BoardLists({
  orgId,
  boardId,
  boardName,
  value,
  onChange,
  label,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly boardName: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
}) {
  const lists = useQuery({ ...listsQuery(orgId, boardId), enabled: orgId !== '' });
  const options = (lists.data ?? []).map((list) => ({
    id: list.listId,
    name: `${boardName} › ${list.name}`,
  }));

  if (options.length === 0) return null;

  return (
    <Choose
      value={value}
      onChange={onChange}
      label={label}
      pending={lists.isPending}
      options={options}
      emptyText="No lists"
      /* Only the group holding the CURRENT value shows it as selected; the
         others show their placeholder, so two boards' selects cannot both
         look chosen at once. */
      unselected={!options.some((option) => option.id === value)}
    />
  );
}

function StatusPicker({ orgId, projectId, value, onChange, label }: PickerProps) {
  const statuses = useQuery({
    ...statusesQuery(orgId, projectId ?? unsafeAsId<'ProjectId'>('')),
    enabled: orgId !== '' && projectId !== null,
  });

  if (projectId === null) return <NeedsProject label={label} />;

  return (
    <Choose
      value={value}
      onChange={onChange}
      label={label}
      pending={statuses.isPending}
      options={(statuses.data ?? []).map((status) => ({
        id: status.statusId,
        name: `${status.name} (${status.category})`,
      }))}
      emptyText="No statuses"
    />
  );
}

function LabelPicker({ orgId, projectId, value, onChange, label }: PickerProps) {
  const labels = useQuery({
    ...labelsQuery(orgId, projectId ?? unsafeAsId<'ProjectId'>('')),
    enabled: orgId !== '' && projectId !== null,
  });

  if (projectId === null) return <NeedsProject label={label} />;

  return (
    <Choose
      value={value}
      onChange={onChange}
      label={label}
      pending={labels.isPending}
      options={(labels.data ?? []).map((entry) => ({ id: entry.labelId, name: entry.name }))}
      emptyText="No labels"
    />
  );
}

/** Shown where a project-scoped picker cannot offer anything yet. */
function NeedsProject({ label }: { readonly label: string }) {
  return (
    <span className="min-w-0 flex-1 text-[11px] text-ink-faint">
      Choose a project above to pick a {label.toLowerCase()}.
    </span>
  );
}

/** The one select every picker renders, so they cannot drift in behaviour. */
function Choose({
  value,
  onChange,
  label,
  pending,
  options,
  emptyText,
  unselected = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly pending: boolean;
  readonly options: readonly { id: string; name: string }[];
  readonly emptyText: string;
  readonly unselected?: boolean;
}) {
  return (
    <select
      value={unselected ? '' : value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      aria-label={label}
      disabled={pending}
      className={SELECT_CLASS}
    >
      {/* An explicit empty option, so a new action starts unchosen rather than
          silently defaulting to whatever happens to be first — a rule that
          quietly picked the top of a list is how someone ends up assigning
          every card to whoever sorts first alphabetically. */}
      <option value="">{pending ? 'Loading…' : `Choose a ${label.toLowerCase()}…`}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
      {!pending && options.length === 0 && <option disabled>{emptyText}</option>}
    </select>
  );
}

/** The project selector that scopes the list/status/label pickers. */
export function ProjectScopePicker({
  orgId,
  value,
  onChange,
}: {
  readonly orgId: string;
  readonly value: ProjectId | null;
  readonly onChange: (value: ProjectId | null) => void;
}) {
  const projects = useQuery({ ...projectsQuery(orgId), enabled: orgId !== '' });
  const live = (projects.data ?? []).filter((project) => project.archivedAt === null);

  return (
    <select
      value={value ?? ''}
      onChange={(event) => {
        onChange(event.target.value === '' ? null : unsafeAsId<'ProjectId'>(event.target.value));
      }}
      aria-label="Project for board, status and label choices"
      className={SELECT_CLASS}
    >
      <option value="">Choose a project…</option>
      {live.map((project) => (
        <option key={project.projectId} value={project.projectId}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
