import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import { parseNullableInstant } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { RichTextView } from './rich-text-view.js';
import { flattenText, sanitizeRichText } from './rich-text.js';
import { liveFormatParser } from './rich-text-compose.js';
import { DatePickerField } from './date-picker-field.js';
import { dateToIsoInstant } from './date-picker.js';
import { type CardDetail } from './work.js';
import { Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * Mirrors web's `TitleAndDescription` (minus the description half — no
 * native rich text EDITOR exists yet, only `rich-text-view.tsx`'s read-only
 * renderer, so a description here would need somewhere to write back to
 * that does not exist): local state seeded once from the card, an explicit
 * "Save" rather than save-on-blur, disabled until the trimmed value
 * actually differs and is non-empty. `key={cardId}` on the caller's side is
 * what makes "seeded once" true if this screen is ever reached card-to-card
 * without an unmount between — today every visit comes fresh from "My
 * Tasks", so the key is a guard against a future navigation path, not a
 * fix for an observed bug.
 */
export function TitleField({
  card,
  onSave,
}: {
  readonly card: CardDetail;
  readonly onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState(card.title);
  const dirty = title.trim() !== card.title && title.trim().length > 0;

  return (
    <View style={styles.titleRow}>
      <TextInput value={title} onChangeText={setTitle} style={styles.titleInput} multiline />
      {dirty && (
        <Pressable
          style={styles.saveButton}
          onPress={() => {
            onSave(title.trim());
          }}
        >
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * A card's own start/due dates — `apps/web`'s `DatesSection`, now a real
 * native calendar picker (`date-picker-field.tsx`) rather than the
 * `YYYY-MM-DD` text box this section shipped with — see that component's
 * own header for the platform split, and `FieldInput` below for the
 * identical swap on a `date`-type custom field.
 *
 * Rides `cards.update`'s full replace via `useUpdateCard`, exactly like
 * priority — `dueDate`/`startDate` were already carried on `CardPatch`
 * (`card-patch.ts`'s own header: "kept... so a future date-editing screen
 * is 'add a UI control'"), so this is that UI control, not new plumbing.
 * Clearing the picker clears the date (`null`), matching web's identical
 * `day === '' ? null : ...` branch.
 */
export function DateSection({
  startDate,
  dueDate,
  onChangeStartDate,
  onChangeDueDate,
}: {
  readonly startDate: string | null;
  readonly dueDate: string | null;
  readonly onChangeStartDate: (iso: string | null) => void;
  readonly onChangeDueDate: (iso: string | null) => void;
}) {
  return (
    <Section label="Dates">
      <View style={styles.dateRow}>
        <DateField label="Start" value={startDate} onChange={onChangeStartDate} />
        <DateField label="Due" value={dueDate} onChange={onChangeDueDate} />
      </View>
    </Section>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly onChange: (iso: string | null) => void;
}) {
  return (
    <View style={styles.dateField}>
      <Text style={styles.dateLabel}>{label}</Text>
      <DatePickerField
        value={parseNullableInstant(value)}
        onChange={(picked) => {
          onChange(picked === null ? null : dateToIsoInstant(picked));
        }}
      />
    </View>
  );
}

/**
 * A card's description — `apps/web`'s own title+description editor, split
 * in two here to match this screen's already-established one-field-one-
 * control shape (`TitleField` above is title-only for the same reason).
 * Renders `RichTextView` when not editing — preserving whatever formatting
 * a WEB user gave it — and switches to a `MarkdownTextInput` (`rich-text-
 * compose.ts`'s `liveFormatParser`/`parseFormattedText` — the same native,
 * no-WebView composing Chat's message composer uses) only on an explicit
 * "Edit" tap, the same toggle `CommentRow`'s own edit mode already uses.
 * `flattenText(sanitizeRichText(...))` (`rich-text.ts`) is what SEEDS that
 * box — the server's flattened plain-text projection, not markdown source
 * — so opening Edit on a description a WEB user formatted still flattens
 * whatever was already there into plain text, same as before this file's
 * composer grew real bold/link/list support; what changed is that NEW
 * `**`/`[]()`/list syntax typed during that edit now composes correctly on
 * save, rather than being sent as literal asterisks and brackets forever.
 * Cancelling never touches the card, so a description a mobile viewer
 * merely opened and closed keeps its web formatting exactly as it was.
 */
export function DescriptionField({
  description,
  onSave,
}: {
  readonly description: unknown;
  readonly onSave: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <Section label="Description">
        <RichTextView document={description} />
        <Pressable
          onPress={() => {
            setDraft(flattenText(sanitizeRichText(description)));
            setEditing(true);
          }}
        >
          <Text style={styles.checklistAddItemText}>
            {sanitizeRichText(description) === null ? '+ Add a description' : 'Edit description'}
          </Text>
        </Pressable>
      </Section>
    );
  }

  return (
    <Section label="Description">
      <View style={styles.editRow}>
        <MarkdownTextInput
          value={draft}
          onChangeText={setDraft}
          style={[styles.editInput, styles.descriptionInput]}
          placeholder="Add a description…"
          placeholderTextColor={colors.inkFaint.hex}
          multiline
          autoFocus
          parser={liveFormatParser}
          markdownStyle={{
            syntax: { color: colors.inkFaint.hex },
            link: { color: colors.accent.hex },
          }}
        />
        <View style={styles.editActions}>
          <Pressable
            onPress={() => {
              setEditing(false);
            }}
          >
            <Text style={styles.editCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={styles.editSaveButton}
            onPress={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            <Text style={styles.editSaveText}>Save</Text>
          </Pressable>
        </View>
      </View>
    </Section>
  );
}
