import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CardId } from '@taskflow/contracts';
import { parseNullableInstant, wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { DatePickerField } from './date-picker-field.js';
import { dateToIsoInstant } from './date-picker.js';
import {
  CUSTOM_FIELD_TYPES,
  cardFieldsQueryKey,
  fieldsQueryKey,
  type CustomFieldType,
} from './work.js';
import { ChipScroll, Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * Custom field values on a card — `apps/web`'s `CustomFieldSection`, the
 * last card-detail vocabulary section this pass closes (following status,
 * assignees and labels). The DEFINITIONS are project vocabulary
 * (`project:update`); filling one in is `card:update` — the same split
 * `LabelSelector` above already draws, and both controls render for
 * everyone with the server as the only adjudicator (CLAUDE.md §8.2).
 *
 * **Field TYPES are immutable on the server, deliberately** — there is no
 * honest migration from `select` to `number`; every stored value would
 * have to become something, and drop/coerce/keep all silently rewrite
 * data a person entered. `AddFieldForm` below only ever CREATES, never
 * edits a type.
 *
 * **`value` is `unknown` at the boundary on both ends, matching the
 * server exactly** — `setOnCard` takes `z.unknown()` because the legal
 * shape depends on the field's declared TYPE, which only the database
 * knows; a Zod union here would have to guess before knowing. `FieldInput`
 * below sends the natural JS value for each control and lets the service
 * refuse a mismatch rather than pre-empting it.
 */
export function CustomFieldSection({
  cardId,
  projectId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
}) {
  const queryClient = useQueryClient();

  const definitions = useQuery({
    queryKey: fieldsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.fields.list.query({ projectId })),
  });
  const values = useQuery({
    queryKey: cardFieldsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.fields.onCard.query({ cardId })),
  });

  const set = useMutation({
    mutationFn: (input: { fieldId: string; value: unknown }) =>
      apiClient.work.fields.setOnCard.mutate({ cardId, ...input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardFieldsQueryKey(cardId) });
    },
  });

  const live = (definitions.data ?? []).filter((field) => field.archivedAt === null);
  const byField = new Map((values.data ?? []).map((entry) => [entry.fieldId, entry.value]));

  return (
    <Section label="Fields">
      {live.length === 0 && (
        <Text style={styles.emptyHint}>
          This project has no custom fields yet. Adding one here defines it for every card in the
          project.
        </Text>
      )}

      {live.map((field) => (
        <View key={field.fieldId} style={styles.fieldRow}>
          <Text style={styles.fieldName} numberOfLines={1}>
            {field.name}
          </Text>
          <View style={styles.fieldInputWrap}>
            <FieldInput
              type={field.type}
              options={field.options}
              value={byField.get(field.fieldId) ?? null}
              onCommit={(value) => {
                set.mutate({ fieldId: field.fieldId, value });
              }}
            />
          </View>
        </View>
      ))}

      <AddFieldForm projectId={projectId} />

      {set.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(set.error)?.error.message ?? 'The field was not saved.'}
        </Text>
      )}
    </Section>
  );
}

/**
 * Defining a new custom field — `project:update`, changing every card in
 * the project, the same "vocabulary vs. one card" split this file's
 * header already names. The TYPE picker is a chip row, not web's
 * `<select>`, matching every other enum control on this screen.
 */
function AddFieldForm({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');

  const needsOptions = type === 'select' || type === 'multi_select';

  const create = useMutation({
    mutationFn: () =>
      apiClient.work.fields.create.mutate({
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
      await queryClient.invalidateQueries({ queryKey: fieldsQueryKey(projectId) });
    },
  });

  if (!open) {
    return (
      <Pressable
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={styles.checklistAddItemText}>+ Add field</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.addFieldForm}>
      <TextInput
        style={styles.modalInput}
        placeholder="Field name"
        placeholderTextColor={colors.inkFaint.hex}
        value={name}
        onChangeText={setName}
      />
      <ChipScroll>
        {CUSTOM_FIELD_TYPES.map((entry) => (
          <Pressable
            key={entry}
            style={[styles.priorityChip, type === entry && styles.priorityChipActive]}
            onPress={() => {
              setType(entry);
            }}
          >
            <Text style={styles.priorityChipText}>{entry}</Text>
          </Pressable>
        ))}
      </ChipScroll>
      {needsOptions && (
        <TextInput
          style={styles.modalInput}
          placeholder="Low, Medium, High"
          placeholderTextColor={colors.inkFaint.hex}
          value={options}
          onChangeText={setOptions}
        />
      )}
      <View style={styles.modalActions}>
        <Pressable
          style={styles.modalPrimaryButton}
          disabled={create.isPending || name.trim().length === 0}
          onPress={() => {
            create.mutate();
          }}
        >
          <Text style={styles.modalPrimaryButtonText}>Add</Text>
        </Pressable>
        <Pressable
          style={styles.modalSecondaryButton}
          onPress={() => {
            setOpen(false);
          }}
        >
          <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
        </Pressable>
      </View>
      {create.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(create.error)?.error.message ?? 'The field was not created.'}
        </Text>
      )}
    </View>
  );
}

/**
 * The control for one field type. `type: 'user'` falls through to the
 * plain-text default, matching `apps/web`'s own `FieldInput` exactly —
 * web has no specialized picker for it either (a real gap in its own
 * implementation, per that file's own field-type list), and this mirrors
 * web's ACTUAL behavior rather than quietly building a nicer one that
 * would leave the two platforms disagreeing on what a `user` field looks
 * like. `date` gets the same native `DatePickerField` `DateSection` above
 * uses, in place of the `YYYY-MM-DD` text entry this used to be.
 */
function FieldInput({
  type,
  options,
  value,
  onCommit,
}: {
  readonly type: string;
  readonly options: unknown;
  readonly value: unknown;
  readonly onCommit: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(() => textValueOf(type, value));

  if (type === 'checkbox') {
    return (
      <Pressable
        style={[styles.checklistBox, value === true && styles.checklistBoxDone]}
        onPress={() => {
          onCommit(value !== true);
        }}
      >
        {value === true && <Text style={styles.checklistBoxCheck}>✓</Text>}
      </Pressable>
    );
  }

  if (type === 'select') {
    const choices = Array.isArray(options) ? options.filter(isChoiceString) : [];
    return (
      <ChipScroll>
        {choices.map((choice) => {
          const on = value === choice;
          return (
            <Pressable
              key={choice}
              style={[styles.priorityChip, on && styles.priorityChipActive]}
              onPress={() => {
                onCommit(on ? null : choice);
              }}
            >
              <Text style={styles.priorityChipText}>{choice}</Text>
            </Pressable>
          );
        })}
      </ChipScroll>
    );
  }

  if (type === 'multi_select') {
    // An ARRAY, not a string — `validateFieldValue` rejects a bare string
    // for this type, and deduplicates what it receives.
    const choices = Array.isArray(options) ? options.filter(isChoiceString) : [];
    const selected = Array.isArray(value) ? value.filter(isChoiceString) : [];
    return (
      <ChipScroll>
        {choices.map((choice) => {
          const on = selected.includes(choice);
          return (
            <Pressable
              key={choice}
              style={[styles.priorityChip, on && styles.priorityChipActive]}
              onPress={() => {
                onCommit(on ? selected.filter((entry) => entry !== choice) : [...selected, choice]);
              }}
            >
              <Text style={styles.priorityChipText}>{choice}</Text>
            </Pressable>
          );
        })}
      </ChipScroll>
    );
  }

  if (type === 'date') {
    return (
      <DatePickerField
        value={typeof value === 'string' ? parseNullableInstant(value) : null}
        onChange={(picked) => {
          onCommit(picked === null ? null : dateToIsoInstant(picked));
        }}
      />
    );
  }

  // text, number, and user (see this function's own header) all commit on
  // blur, not on every keystroke — each commit is a mutation that emits a
  // domain event and an audit entry, so one per character would make the
  // audit log unreadable.
  return (
    <TextInput
      style={styles.addCardInput}
      value={draft}
      placeholderTextColor={colors.inkFaint.hex}
      keyboardType={type === 'number' ? 'numeric' : 'default'}
      onChangeText={setDraft}
      onEndEditing={() => {
        commitTextValue(type, draft, onCommit);
      }}
    />
  );
}

function isChoiceString(value: unknown): value is string {
  return typeof value === 'string';
}

function textValueOf(type: string, value: unknown): string {
  if (type === 'number') return typeof value === 'number' ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

function commitTextValue(type: string, raw: string, onCommit: (value: unknown) => void): void {
  const trimmed = raw.trim();

  if (type === 'number') {
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) onCommit(parsed);
    return;
  }

  onCommit(trimmed === '' ? null : trimmed);
}
