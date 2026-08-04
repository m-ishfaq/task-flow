import { useQuery } from '@tanstack/react-query';
import {
  LIST_OPERATORS,
  ME,
  type ComparisonNode,
  type FieldDefinition,
  type FilterValue,
  type Operator,
} from '@taskflow/filter';
import type { ProjectId } from '@taskflow/contracts';
import { Input } from '../../../components/primitives.js';
import { cn } from '../../../lib/cn.js';
import { membersQuery } from '../../org/api.js';
import { labelsQuery } from '../api.js';

/**
 * The value half of a filter chip.
 *
 * ## `@me` is a value, not a substitution
 *
 * Choosing "me" puts the literal string `@me` into the tree and leaves it there.
 * The client resolving it to its own user id is the obvious implementation and
 * it breaks the moment a filter is SHARED: a saved view meaning "assigned to me"
 * would silently become "assigned to whoever saved it". The compiler substitutes
 * the viewer at query time, so one saved filter means the right thing to
 * everyone who opens it.
 *
 * The option is offered only where `field.acceptsMe` is true. Validation rejects
 * `@me` on any other field — and rejects it at VALIDATION time rather than at
 * compile time specifically so a builder cannot render a chip that looks valid
 * and explodes on apply.
 */

export interface ValueEditorProps {
  readonly orgId: string;
  readonly projectId: ProjectId | null;
  readonly field: FieldDefinition;
  readonly operator: Operator;
  /* Typed as the AST's own value slot rather than `unknown`, so a control that
     emitted the wrong SHAPE — a string where the operator needs a list — would
     not compile. That mismatch is otherwise only caught by the schema, at which
     point the user is looking at a chip they cannot apply. */
  readonly value: ComparisonNode['value'];
  readonly onChange: (value: FilterValue | readonly FilterValue[]) => void;
}

const CONTROL = 'h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink';

export function ValueEditor(props: ValueEditorProps) {
  const { field, operator } = props;
  const isList = LIST_OPERATORS.includes(operator);

  if (field.type === 'uuid' || field.type === 'uuid_array') {
    return <IdEditor {...props} multiple={isList || field.type === 'uuid_array'} />;
  }

  if (field.type === 'boolean') {
    return (
      <select
        aria-label="Value"
        className={CONTROL}
        value={props.value === true ? 'true' : 'false'}
        onChange={(event) => {
          props.onChange(event.target.value === 'true');
        }}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (field.type === 'date') {
    return (
      <input
        type="date"
        aria-label="Value"
        className={CONTROL}
        value={typeof props.value === 'string' ? props.value.slice(0, 10) : ''}
        onChange={(event) => {
          const day = event.target.value;
          /* Sent as a full instant, not a bare `YYYY-MM-DD`. Postgres would
             read the bare form as midnight in the SERVER's timezone, so a due
             date set from a browser an hour ahead lands on the previous day —
             a filter that quietly omits the cards it was built to find. */
          props.onChange(day === '' ? null : new Date(`${day}T00:00:00`).toISOString());
        }}
      />
    );
  }

  if (field.type === 'number') {
    return (
      <Input
        type="number"
        aria-label="Value"
        className="h-7 w-24 text-xs"
        value={typeof props.value === 'number' ? String(props.value) : ''}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          props.onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
      />
    );
  }

  if (field.type === 'enum') {
    return (
      <select
        aria-label="Value"
        className={CONTROL}
        value={typeof props.value === 'string' ? props.value : ''}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      aria-label="Value"
      placeholder="value"
      className="h-7 w-40 text-xs"
      value={typeof props.value === 'string' ? props.value : ''}
      onChange={(event) => {
        props.onChange(event.target.value);
      }}
    />
  );
}

/**
 * A picker for id-valued fields: assignee, creator, label, list.
 *
 * Falls back to a plain text input when the relevant collection is unavailable —
 * `label` needs a project, and the board route only carries one when it was
 * reached from the project list. A disabled control there would make a filter
 * unbuildable from a deep link; a text box lets someone paste an id.
 */
function IdEditor({
  orgId,
  projectId,
  field,
  value,
  onChange,
  multiple,
}: ValueEditorProps & { readonly multiple: boolean }) {
  const wantsUser = field.name === 'assignee' || field.name === 'creator';
  const wantsLabel = field.name === 'label';

  const members = useQuery({ ...membersQuery(orgId), enabled: wantsUser });
  const labels = useQuery({
    ...labelsQuery(orgId, projectId ?? ('' as ProjectId)),
    enabled: wantsLabel && projectId !== null,
  });

  const options: readonly { id: string; label: string }[] = wantsUser
    ? (members.data ?? []).map((member) => ({ id: member.userId, label: member.email }))
    : wantsLabel
      ? (labels.data ?? []).map((label) => ({ id: label.labelId, label: label.name }))
      : [];

  const selected = multiple
    ? Array.isArray(value)
      ? value.map(String)
      : []
    : typeof value === 'string'
      ? [value]
      : [];

  const emit = (next: readonly string[]) => {
    onChange(multiple ? next : (next[0] ?? null));
  };

  if (options.length === 0) {
    return (
      <Input
        aria-label="Value"
        placeholder="id"
        className="h-7 w-56 font-mono text-xs"
        value={selected.join(',')}
        onChange={(event) => {
          const parts = event.target.value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '');
          emit(parts);
        }}
      />
    );
  }

  const toggle = (id: string) => {
    if (!multiple) {
      emit([id]);
      return;
    }
    emit(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {field.acceptsMe === true && (
        <button
          type="button"
          aria-pressed={selected.includes(ME)}
          onClick={() => {
            toggle(ME);
          }}
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px]',
            selected.includes(ME)
              ? 'bg-accent text-accent-ink'
              : 'bg-surface-hover text-ink-muted hover:text-ink',
          )}
          title="Resolved to whoever runs the query, so a shared filter means the same thing to everyone"
        >
          @me
        </button>
      )}

      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={selected.includes(option.id)}
          onClick={() => {
            toggle(option.id);
          }}
          className={cn(
            'max-w-40 truncate rounded px-1.5 py-0.5 text-[11px]',
            selected.includes(option.id)
              ? 'bg-accent text-accent-ink'
              : 'bg-surface-hover text-ink-muted hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
