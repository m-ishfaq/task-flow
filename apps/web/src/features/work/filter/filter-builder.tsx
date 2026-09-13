import { useState } from 'react';
import { PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
import {
  LIST_OPERATORS,
  NULLARY_OPERATORS,
  fieldsOf,
  findField,
  operatorsFor,
  validate,
  type ComparisonNode,
  type FieldDefinition,
  type FilterNode,
  type FilterValue,
  type GroupNode,
  type Operator,
  type Resource,
} from '@taskflow/filter';
import type { ProjectId } from '@taskflow/contracts';
import { Button } from '../../../components/primitives.js';
import { cn } from '../../../lib/cn.js';
import { ValueEditor } from './value-editor.js';
import {
  defaultOperatorFor,
  defaultScalarFor,
  defaultValueFor,
  describe,
} from './builder-model.js';
import { EMPTY_GROUP, asGroup, countComparisons, draftToTql, interpretTql } from './tql-draft.js';

/**
 * The visual filter builder (§10.2).
 *
 * It edits the AST DIRECTLY. There is no intermediate representation, no query
 * string, and no serialization step of its own — what this component holds is
 * the same `FilterNode` the SQL compiler consumes, the same one the Phase 10
 * evaluator will run, and the same one Phase 8's TQL parser will produce. That
 * is the entire reason the AST shipped before any of them: the builder needed
 * something to edit rather than a language to invent.
 *
 * ## What keeps the builder from producing something the server rejects
 *
 * Every choice is drawn from the same closed sets the server validates against:
 * fields from `fieldsOf(resource)`, operators from `operatorsFor(field)`.
 * There is no free-text field name and no free-text operator anywhere in this
 * file, which is what makes "no user string reaches the database as a field
 * name" true of the UI as well as the compiler.
 *
 * The tree is nonetheless run through `validate()` — the SAME validator the API
 * calls — before it is emitted. Not because the builder is untrusted, but
 * because an invalid tree must never reach the URL: the board would then fail to
 * load from a link, which is a much worse failure than a disabled Apply button.
 */

export interface FilterBuilderProps {
  readonly orgId: string;
  readonly projectId: ProjectId | null;
  readonly value: FilterNode | null;
  readonly onChange: (filter: FilterNode | null) => void;
  /**
   * Which field set to offer. Defaults to `card` — every caller before Phase
   * 10 Wave 4 filters cards, and defaulting keeps them unchanged.
   *
   * `connector` is the automation builder's answer for a rule keyed on a
   * Slack/GitHub event (ai/phase-10-automation.md §7.8b). The sets are closed
   * and do NOT overlap, so this is not a display preference: offering the card
   * fields on a connector rule would build a condition the server refuses on
   * save, and offering them and validating as `connector` would light up every
   * chip the moment it was created.
   */
  readonly resource?: Resource;
}

/* `EMPTY`, `asGroup` and `countComparisons` moved to `tql-draft.ts` when the
   TQL tab needed them too — one definition, so the two editors cannot disagree
   about what "no filter" is. */
const EMPTY = EMPTY_GROUP;

export function FilterBuilder({
  orgId,
  projectId,
  value,
  onChange,
  resource = 'card',
}: FilterBuilderProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GroupNode>(() => asGroup(value));
  const [mode, setMode] = useState<'builder' | 'tql'>('builder');

  const result = validate(resource, draft);
  const count = countComparisons(draft);

  /* TQL is a CARD/SEARCH language: its bare terms desugar to `text contains …`
     and `tql-draft.ts` validates against the card set by name. Offering the tab
     on a connector rule would offer an editor that cannot produce a single
     valid tree, so the toggle is hidden rather than shown-and-refusing. */
  const tqlAvailable = resource === 'card';

  const apply = () => {
    if (!result.ok) return;
    onChange(count === 0 ? null : draft);
    setOpen(false);
  };

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        /* The draft is re-seeded from the applied filter every time the panel
           opens. Without this, closing without applying leaves the abandoned
           edits in place, and the chips shown next time describe a filter that
           is not the one the board is using. */
        if (next) setDraft(asGroup(value));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant={value === null ? 'secondary' : 'primary'}>
          Filter
          {value !== null && (
            <span className="rounded bg-black/20 px-1 text-[10px]">{countComparisons(value)}</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-[34rem] max-w-[95vw] p-3">
        <div
          className={cn(
            'mb-2 inline-flex overflow-hidden rounded border border-line text-[11px]',
            !tqlAvailable && 'hidden',
          )}
        >
          {(['builder', 'tql'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
              }}
              className={cn(
                'px-2 py-0.5',
                mode === value ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {value === 'builder' ? 'Builder' : 'TQL'}
            </button>
          ))}
        </div>

        {mode === 'builder' || !tqlAvailable ? (
          <GroupEditor
            orgId={orgId}
            projectId={projectId}
            resource={resource}
            group={draft}
            depth={0}
            onChange={setDraft}
          />
        ) : (
          <TqlEditor draft={draft} onChange={setDraft} />
        )}

        {!result.ok && (
          <ul className="mt-2 space-y-0.5" role="alert">
            {result.errors.map((error) => (
              <li key={`${error.path.join('.')}-${error.message}`} className="text-xs text-danger">
                {error.message}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(EMPTY);
              onChange(null);
              setOpen(false);
            }}
          >
            Clear
          </Button>

          <Button size="sm" variant="primary" onClick={apply} disabled={!result.ok}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The TQL half of the round trip (§3.1, PLAN.md §10.2's own promise:
 * "dragging a filter chip regenerates the TQL text; editing the text reparses
 * into chips").
 *
 * ## One tree, two editors — never two sources of truth
 *
 * The text is LOCAL state and the tree is the shared one. `format(draft)`
 * seeds the box when the tab opens; every keystroke tries to parse, and a
 * successful parse writes the TREE back. Switching to the Builder tab shows
 * chips for exactly what was typed, because there was never a second
 * representation to reconcile.
 *
 * The text is deliberately NOT re-seeded from `draft` on every render. `format`
 * is canonical — it normalizes spacing, parenthesizes groups, quotes reserved
 * words — so echoing it back into the box mid-typing would rewrite the user's
 * characters under their cursor after each valid keystroke.
 *
 * ## Three refusals worth understanding
 *
 * `ORDER BY` parses (the grammar has it, for the search page) and is refused
 * here: a board's sort is a toolbar control with its own persisted value, and
 * silently accepting a sort inside the filter would give one board two
 * disagreeing orderings.
 *
 * A BARE TERM desugars to `text contains …`, and `text` is a field on the
 * SEARCH resource, not on cards (fields.ts) — so free text validates cleanly
 * on the search page and cannot validate here. The generic "Unknown field
 * text" is technically right and useless, so it is translated.
 *
 * Everything else is refused by `validate('card', …)` in the parent, which is
 * the same validator the API runs. Nothing typed here reaches the server
 * except as a tree the server re-validates anyway.
 */
function TqlEditor({
  draft,
  onChange,
}: {
  readonly draft: GroupNode;
  readonly onChange: (group: GroupNode) => void;
}) {
  /* Seeded ONCE per mount — the tab remounts this component each time it is
     selected, which is exactly the "re-seed on open" behaviour wanted, with
     none of the mid-typing rewriting a `useEffect` on `draft` would cause. */
  const [text, setText] = useState(() => draftToTql(draft));
  const [error, setError] = useState<string | null>(null);

  const commit = (next: string) => {
    setText(next);

    const result = interpretTql(next);
    setError(result.ok ? null : result.message);
    if (result.ok) onChange(result.group);
  };

  return (
    <div className="space-y-1.5">
      <textarea
        value={text}
        onChange={(event) => {
          commit(event.target.value);
        }}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        aria-label="Filter query (TQL)"
        /* A placeholder that does not validate teaches the wrong syntax on
           first contact — `status` holds ids and `assignee` is an array, so
           the obvious-looking `status = todo AND assignee = me` is refused by
           the very validator this box runs. */
        placeholder="priority = high AND creator = me"
        className="block w-full resize-y rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 placeholder:font-sans placeholder:text-ink-faint"
      />
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <p className="text-[11px] text-ink-faint">
        The same language the Search page speaks. Switch back to Builder to see it as chips.
      </p>
    </div>
  );
}

/**
 * One group: a combinator and its children, recursively.
 *
 * `depth` exists only to stop the UI offering "add a group" past the AST's own
 * `MAX_DEPTH`. Offering a control that produces a tree the validator will reject
 * is how a builder ends up with a permanently disabled Apply button and no
 * explanation of which chip caused it.
 */
function GroupEditor({
  orgId,
  projectId,
  resource,
  group,
  depth,
  onChange,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId | null;
  readonly resource: Resource;
  readonly group: GroupNode;
  readonly depth: number;
  readonly onChange: (group: GroupNode) => void;
}) {
  const replaceChild = (index: number, child: FilterNode) => {
    onChange({ ...group, children: group.children.map((c, i) => (i === index ? child : c)) });
  };

  const removeChild = (index: number) => {
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) });
  };

  return (
    <div className={cn('space-y-2', depth > 0 && 'rounded border border-line p-2')}>
      <div className="flex items-center gap-2">
        <div className="inline-flex overflow-hidden rounded border border-line text-[11px]">
          {(['and', 'or'] as const).map((combinator) => (
            <button
              key={combinator}
              type="button"
              aria-pressed={group.combinator === combinator}
              onClick={() => {
                onChange({ ...group, combinator });
              }}
              className={cn(
                'px-2 py-0.5 uppercase',
                group.combinator === combinator
                  ? 'bg-accent text-accent-ink'
                  : 'text-ink-muted hover:bg-surface-hover',
              )}
            >
              {combinator}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-ink-faint">
          {group.combinator === 'and' ? 'all of these match' : 'any of these match'}
        </span>
      </div>

      <ul className="space-y-1.5">
        {group.children.map((child, index) => (
          /* The AST carries no node ids — it is a value, and Phase 8's parser
             produces the same shape from text — so position is the only
             identity a child has here. Rows are added and removed at the end far
             more often than reordered, and a remount of one row costs nothing:
             every editor below is controlled and holds no state of its own. */
          <li key={`${String(index)}-${child.kind}`}>
            {child.kind === 'group' ? (
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <GroupEditor
                    orgId={orgId}
                    projectId={projectId}
                    resource={resource}
                    group={child}
                    depth={depth + 1}
                    onChange={(next) => {
                      replaceChild(index, next);
                    }}
                  />
                </div>
                <RemoveButton
                  onClick={() => {
                    removeChild(index);
                  }}
                />
              </div>
            ) : child.kind === 'comparison' ? (
              <ComparisonEditor
                orgId={orgId}
                projectId={projectId}
                resource={resource}
                node={child}
                onChange={(next) => {
                  replaceChild(index, next);
                }}
                onRemove={() => {
                  removeChild(index);
                }}
              />
            ) : (
              /* `not` nodes are part of the AST and are produced by Phase 8's
                 parser, but this builder does not create them — "is not" is
                 expressed by the negated operators (`neq`, `not_in`), which is
                 what people reach for. Rendering one read-only means a filter
                 written in TQL and opened here is described rather than silently
                 dropped. */
              <div className="rounded border border-line px-2 py-1 text-xs text-ink-muted">
                NOT ({describe(child.child)})
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            onChange({ ...group, children: [...group.children, newComparison(resource)] });
          }}
        >
          + Condition
        </Button>

        {depth < 2 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange({
                ...group,
                children: [
                  ...group.children,
                  { kind: 'group', combinator: 'or', children: [newComparison(resource)] },
                ],
              });
            }}
          >
            + Group
          </Button>
        )}
      </div>
    </div>
  );
}

function ComparisonEditor({
  orgId,
  projectId,
  resource,
  node,
  onChange,
  onRemove,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId | null;
  readonly resource: Resource;
  readonly node: ComparisonNode;
  readonly onChange: (node: ComparisonNode) => void;
  readonly onRemove: () => void;
}) {
  const field = findField(resource, node.field);
  /* `operatorsFor`, never `OPERATORS_BY_TYPE[field.type]` — a field may carry
     its own list, and a menu built from the type table would offer an operator
     `validate()` refuses. */
  const operators = field === undefined ? [] : operatorsFor(field);
  const takesValue = !NULLARY_OPERATORS.includes(node.operator);

  /**
   * Changing the field rewrites the operator and the value too.
   *
   * Keeping them would produce `due contains "x"` — a field/operator pairing the
   * validator rejects — or `assignee > 5`, where the value is legal for the old
   * type and meaningless for the new one. Both are states a user can reach in
   * two clicks, and neither is recoverable except by deleting the row.
   */
  const changeField = (name: string) => {
    const next = findField(resource, name);
    if (next === undefined) return;

    const operator = defaultOperatorFor(next);
    onChange(buildComparison(name, operator, defaultValueFor(next, operator)));
  };

  const changeOperator = (operator: Operator) => {
    if (field === undefined) return;

    /* Scalar and list operators do not share a value shape: switching `eq` to
       `in` has to turn the value into an array, and back again. The schema
       rejects the mismatch, so this is the difference between a working switch
       and a chip that cannot be applied. */
    onChange(buildComparison(node.field, operator, coerceValue(field, operator, node.value)));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-line bg-surface px-2 py-1.5">
      <select
        aria-label="Field"
        value={node.field}
        onChange={(event) => {
          changeField(event.target.value);
        }}
        className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
      >
        {fieldsOf(resource).map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Operator"
        value={node.operator}
        onChange={(event) => {
          changeOperator(event.target.value as Operator);
        }}
        className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_LABELS[operator]}
          </option>
        ))}
      </select>

      {takesValue && field !== undefined && (
        <ValueEditor
          orgId={orgId}
          projectId={projectId}
          field={field}
          operator={node.operator}
          value={node.value}
          onChange={(value) => {
            onChange(buildComparison(node.field, node.operator, value));
          }}
        />
      )}

      <RemoveButton onClick={onRemove} />
    </div>
  );
}

function RemoveButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove condition"
      className="ml-auto rounded px-1.5 text-xs text-ink-faint hover:bg-surface-hover hover:text-danger"
    >
      ✕
    </button>
  );
}

const OPERATOR_LABELS: Readonly<Record<Operator, string>> = {
  eq: 'is',
  neq: 'is not',
  lt: 'before / <',
  lte: '≤',
  gt: 'after / >',
  gte: '≥',
  in: 'is one of',
  not_in: 'is none of',
  contains: 'contains',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

/* -------------------------------------------------------------------------- *
 * Tree helpers
 * -------------------------------------------------------------------------- */

/**
 * Builds a comparison with the value present only when the operator takes one.
 *
 * The schema rejects `is_empty` carrying a value AND an `eq` missing one, and
 * `exactOptionalPropertyTypes` means `{ value: undefined }` is not the same as
 * omitting the key. Constructing it in one place is what stops half the call
 * sites getting that right.
 */
function buildComparison(
  field: string,
  operator: Operator,
  value: ComparisonNode['value'],
): ComparisonNode {
  return NULLARY_OPERATORS.includes(operator)
    ? { kind: 'comparison', field, operator }
    : { kind: 'comparison', field, operator, value: value ?? null };
}

function newComparison(resource: Resource): ComparisonNode {
  const first = fieldsOf(resource)[0];
  if (first === undefined) throw new Error(`The ${resource} field set is empty.`);

  const operator = defaultOperatorFor(first);
  return buildComparison(first.name, operator, defaultValueFor(first, operator));
}

/**
 * Reshapes a value when the operator switches between scalar and list form.
 *
 * `eq` and `in` do not share a value shape, and the schema rejects the mismatch
 * — so without this, changing the operator on an existing chip produces one that
 * cannot be applied and gives no hint which control caused it.
 */
function coerceValue(
  field: FieldDefinition,
  operator: Operator,
  value: ComparisonNode['value'],
): ComparisonNode['value'] {
  if (NULLARY_OPERATORS.includes(operator)) return undefined;

  const wantsList = LIST_OPERATORS.includes(operator);

  if (isValueList(value)) {
    // Narrowing a list to a scalar keeps the first choice rather than
    // discarding the edit entirely.
    return wantsList ? value : (value[0] ?? defaultScalarFor(field));
  }

  const scalar = value ?? defaultScalarFor(field);
  return wantsList ? [scalar] : scalar;
}

/**
 * A type guard rather than a bare `Array.isArray`.
 *
 * `Array.isArray` narrows to the MUTABLE `any[]`, so on a union containing
 * `readonly FilterValue[]` it fails to remove the array from the false branch —
 * and the scalar path below then refuses to compile for a reason that has
 * nothing to do with the logic.
 */
function isValueList(value: ComparisonNode['value']): value is readonly FilterValue[] {
  return Array.isArray(value);
}

/** Wraps a bare comparison so the builder always edits a group. */
