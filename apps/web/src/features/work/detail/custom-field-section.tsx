import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import type { BoardId, CardId, CustomFieldId, ProjectId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { Button, Input } from '../../../components/primitives.js';
import { ErrorText } from '../../../components/error-view.js';
import { cardFieldsQuery, fieldsQuery, invalidateCard } from '../api.js';

/**
 * Custom field values on a card.
 *
 * The DEFINITIONS are project vocabulary (`project:update`); filling one in is
 * `card:update`. Both live here, and the split stays visible in which route each
 * control calls — collapsing them would either stop members filling in their own
 * cards or let them rewrite the project's schema from a card panel.
 *
 * Defining a field from a card panel is a compromise: it belongs on a project
 * settings surface, which does not exist yet. Without it the section is
 * unreachable — a project with no fields rendered nothing at all, so the whole
 * feature was invisible.
 *
 * Field TYPES are immutable on the server, and the reason is worth knowing
 * before anyone tries to add an edit control: there is no honest migration from
 * `select` to `number`. Every stored value would have to become something, and
 * every choice — drop, coerce, keep — silently rewrites data a person entered.
 *
 * `canEdit` (`card:update`, from `getCard`) gates SETTING a value here;
 * `canManageVocabulary` (`project:update`, checked against the project
 * directly) gates `AddFieldForm` below. Kept as two booleans, not one — a
 * plain Member holds the first by role and not the second, so folding them
 * together would either hide a fill-in a Member can genuinely do or offer a
 * define-a-field form whose submit the server would refuse. See
 * `label-section.tsx`'s header for the identical split and why.
 */

export interface CustomFieldSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly projectId: ProjectId;
  readonly canEdit: boolean;
  readonly canManageVocabulary: boolean;
}

export function CustomFieldSection({
  orgId,
  boardId,
  cardId,
  projectId,
  canEdit,
  canManageVocabulary,
}: CustomFieldSectionProps) {
  const queryClient = useQueryClient();
  const definitions = useQuery(fieldsQuery(orgId, projectId));
  const values = useQuery(cardFieldsQuery(orgId, cardId));

  const set = useMutation({
    mutationFn: (input: { fieldId: CustomFieldId; value: unknown }) =>
      api.work.fields.setOnCard.mutate({ cardId, ...input }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.cardFields(orgId, cardId) }),
        invalidateCard(queryClient, orgId, cardId, boardId),
      ]);
    },
  });

  const live = (definitions.data ?? []).filter((field) => field.archivedAt === null);
  const byField = new Map((values.data ?? []).map((entry) => [entry.fieldId, entry.value]));

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <SlidersHorizontal aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Fields
      </h3>

      {live.length === 0 && (
        <p className="text-xs text-ink-faint">
          This project has no custom fields yet. Adding one here defines it for every card in the
          project.
        </p>
      )}

      <dl className="space-y-2">
        {live.map((field) => (
          <div key={field.fieldId} className="grid grid-cols-[8rem_1fr] items-center gap-2">
            <dt className="truncate text-xs text-ink-muted" title={field.name}>
              {field.name}
            </dt>
            <dd>
              <FieldInput
                type={field.type}
                options={field.options}
                value={byField.get(field.fieldId) ?? null}
                disabled={!canEdit}
                onCommit={(value) => {
                  set.mutate({ fieldId: field.fieldId as CustomFieldId, value });
                }}
              />
            </dd>
          </div>
        ))}
      </dl>

      {canManageVocabulary && <AddFieldForm orgId={orgId} projectId={projectId} />}

      {set.isError && <ErrorText error={set.error} />}
    </section>
  );
}

/**
 * Defining a new custom field.
 *
 * This is `project:update`, not `card:update` — it changes the project's
 * vocabulary and therefore every card in it, which is exactly the split the
 * service encodes. Filling a field in above is the card-level permission. Both
 * controls are rendered for everyone and the server decides.
 *
 * The TYPE is chosen once and is immutable afterwards, deliberately: there is no
 * honest migration from `select` to `number`. Every stored value would have to
 * become something, and drop / coerce / keep all silently rewrite data a person
 * entered.
 */
function AddFieldForm({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');

  const needsOptions = type === 'select' || type === 'multi_select';

  const create = useMutation({
    mutationFn: () =>
      api.work.fields.create.mutate({
        projectId,
        name: name.trim(),
        type,
        options: needsOptions
          ? options
              .split(',')
              .map((option) => option.trim())
              .filter((option) => option !== '')
          : null,
      }),
    onSuccess: async () => {
      setName('');
      setOptions('');
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.fields(orgId, projectId) });
    },
  });

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1 text-[11px]"
        onClick={() => {
          setOpen(true);
        }}
      >
        + Add field
      </Button>
    );
  }

  return (
    <form
      className="space-y-2 rounded border border-line p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== '') create.mutate();
      }}
    >
      <Input
        aria-label="Field name"
        placeholder="Field name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        className="h-7 text-xs"
      />

      <select
        aria-label="Field type"
        value={type}
        onChange={(event) => {
          setType(event.target.value as FieldType);
        }}
        className="h-7 w-full rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
      >
        {FIELD_TYPES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>

      {needsOptions && (
        <Input
          aria-label="Options, comma separated"
          placeholder="Low, Medium, High"
          value={options}
          onChange={(event) => {
            setOptions(event.target.value);
          }}
          className="h-7 text-xs"
        />
      )}

      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>

      {create.isError && <ErrorText error={create.error} />}
    </form>
  );
}

/**
 * Mirrors CUSTOM_FIELD_TYPES on the server, which is the authority — the route's
 * `z.enum` rejects anything else, so a drift here is a rejected create rather
 * than a bad row.
 */
const FIELD_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'user',
] as const;

type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The control for one field type.
 *
 * The VALUE's legal shape is decided by the server against the definition it
 * reads — `setOnCard` takes `z.unknown()` at the boundary on purpose, because a
 * union there would have to guess the type before knowing it. So this component
 * sends the natural JavaScript value for the control and lets the service refuse
 * a mismatch rather than trying to pre-empt it.
 */
function FieldInput({
  type,
  options,
  value,
  disabled,
  onCommit,
}: {
  readonly type: string;
  readonly options: unknown;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly onCommit: (value: unknown) => void;
}) {
  const control =
    'h-7 w-full rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink disabled:opacity-50';

  if (type === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(event) => {
          onCommit(event.target.checked);
        }}
        className="size-4 accent-[var(--color-accent)] disabled:opacity-60"
      />
    );
  }

  if (type === 'select') {
    const choices = Array.isArray(options) ? options.filter(isChoice) : [];

    return (
      <select
        className={control}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(event) => {
          onCommit(event.target.value === '' ? null : event.target.value);
        }}
      >
        <option value="">—</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }

  if (type === 'multi_select') {
    /* An ARRAY, not a string. `validateFieldValue` rejects a bare string for
       this type, and it deduplicates what it receives — so a card cannot hold
       the same option twice and make a Phase 11 group-by count it twice. */
    const choices = Array.isArray(options) ? options.filter(isChoice) : [];
    const selected = Array.isArray(value) ? value.filter(isChoice) : [];

    return (
      <div className="flex flex-wrap gap-1">
        {choices.map((choice) => {
          const on = selected.includes(choice);
          return (
            <button
              key={choice}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => {
                onCommit(on ? selected.filter((entry) => entry !== choice) : [...selected, choice]);
              }}
              className={`rounded px-1.5 py-0.5 text-[11px] disabled:opacity-60 ${
                on ? 'bg-accent text-accent-ink' : 'bg-surface-hover text-ink-muted'
              }`}
            >
              {choice}
            </button>
          );
        })}
      </div>
    );
  }

  if (type === 'number') {
    return (
      <Input
        type="number"
        className="h-7 text-xs"
        defaultValue={typeof value === 'number' ? String(value) : ''}
        disabled={disabled}
        onBlur={(event) => {
          const raw = event.target.value;
          if (raw === '') {
            onCommit(null);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
      />
    );
  }

  if (type === 'date') {
    return (
      <input
        type="date"
        className={control}
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        disabled={disabled}
        onChange={(event) => {
          const day = event.target.value;
          onCommit(day === '' ? null : new Date(`${day}T00:00:00`).toISOString());
        }}
      />
    );
  }

  return (
    <Input
      className="h-7 text-xs"
      defaultValue={typeof value === 'string' ? value : ''}
      disabled={disabled}
      /* On blur, not on every keystroke. Each commit is a mutation that emits a
         domain event and an audit entry — one per character would make the audit
         log unreadable and the outbox the busiest table in the system. */
      onBlur={(event) => {
        onCommit(event.target.value === '' ? null : event.target.value);
      }}
    />
  );
}

function isChoice(value: unknown): value is string {
  return typeof value === 'string';
}
