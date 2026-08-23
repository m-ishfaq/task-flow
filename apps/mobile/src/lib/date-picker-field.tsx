import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { colors, radiusCard } from '@taskflow/tokens';
import { formatPickedDate } from './date-picker.js';

/**
 * A native calendar-day picker, replacing the hand-typed `YYYY-MM-DD` text
 * box `card/[cardId].tsx`'s `DateField`/`FieldInput` and `sprints/
 * [projectId].tsx`'s sprint form each had — three separate copies of the
 * identical "type digits and hope they parse" control, closing the gap
 * this app's own README named: "no date-picker dependency added,
 * deliberately, and the alternative to typing one by hand was leaving
 * these fields uneditable entirely."
 *
 * Works in `Date | null` only — never a wire string. `date-picker.ts`'s
 * `dateToIsoInstant`/`dateToPlainDay` are what each CALLER uses to turn the
 * picked `Date` into the wire shape ITS OWN field needs (a card's dates are
 * a full ISO instant; a sprint's are a plain `YYYY-MM-DD` — see that file's
 * own header for why there are two). Keeping this component wire-format
 * agnostic is what lets one implementation serve both without knowing which
 * caller it is.
 *
 * ## Two genuinely different platform UIs, not one component pretending
 * otherwise
 *
 * Android has no inline picker at all in this library — `DateTimePickerAndroid
 * .open()` is an IMPERATIVE call that shows the OS's own native dialog and
 * returns through a callback, nothing rendered by this component's own tree.
 * iOS has no equivalent imperative API — a `<DateTimePicker>` has to be
 * mounted to show anything, so it renders inside a bottom-sheet `Modal`
 * matching this app's own established pattern (`board/[boardId].tsx`'s
 * `modalBackdrop`/`modalCard`/`modalPrimaryButton` shapes, restated here
 * since this is a standalone shared component with no caller's `styles` to
 * borrow). Picking a day on iOS is therefore a DRAFT, committed only on
 * "Done" — the wheel fires `onChange` continuously while spinning, and
 * calling the real `onChange` prop on every tick would write a mutation,
 * and the audit trail that comes with it, once per frame of scrolling.
 * Android has no such draft state: `DateTimePickerAndroid`'s own `onChange`
 * only fires once, when the dialog is dismissed with a value chosen.
 */
export function DatePickerField({
  value,
  onChange,
  placeholder = 'Set date',
  disabled = false,
}: {
  readonly value: Date | null;
  readonly onChange: (date: Date | null) => void;
  readonly placeholder?: string;
  /** `sprints/[projectId].tsx`'s own reason: an ACTIVE sprint's start date is
   *  locked (its end date is not) — the same rule the `TextInput` this
   *  replaced enforced via `editable={!locked}`. */
  readonly disabled?: boolean;
}): React.JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState<Date>(value ?? new Date());

  const open = (): void => {
    if (disabled) return;
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: value ?? new Date(),
        mode: 'date',
        // `onValueChange`, not the deprecated `onChange`: it fires only when
        // a value was actually picked, with a guaranteed `Date` — dismissing
        // the dialog without choosing one simply never calls it, so there is
        // no `event.type` left to branch on here.
        onValueChange: (_event, picked) => {
          onChange(picked);
        },
      });
      return;
    }

    setDraft(value ?? new Date());
    setSheetOpen(true);
  };

  return (
    <View style={styles.row}>
      <Pressable style={[styles.trigger, disabled && styles.triggerDisabled]} onPress={open}>
        <Text style={[styles.triggerText, value === null && styles.triggerPlaceholder]}>
          {value === null ? placeholder : formatPickedDate(value)}
        </Text>
      </Pressable>
      {value !== null && !disabled && (
        <Pressable
          style={styles.clearButton}
          hitSlop={8}
          onPress={() => {
            onChange(null);
          }}
        >
          <Text style={styles.clearButtonText}>✕</Text>
        </Pressable>
      )}

      {Platform.OS === 'ios' && (
        <Modal
          visible={sheetOpen}
          transparent
          animationType="fade"
          onRequestClose={() => {
            setSheetOpen(false);
          }}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              setSheetOpen(false);
            }}
          >
            <Pressable style={styles.modalCard} onPress={() => undefined}>
              <DateTimePicker
                value={draft}
                mode="date"
                display="spinner"
                onValueChange={(_event, picked) => {
                  setDraft(picked);
                }}
              />
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.modalSecondaryButton}
                  onPress={() => {
                    onChange(null);
                    setSheetOpen(false);
                  }}
                >
                  <Text style={styles.modalSecondaryButtonText}>Clear</Text>
                </Pressable>
                <Pressable
                  style={styles.modalPrimaryButton}
                  onPress={() => {
                    onChange(draft);
                    setSheetOpen(false);
                  }}
                >
                  <Text style={styles.modalPrimaryButtonText}>Done</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  trigger: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surfaceSunken.hex,
  },
  triggerText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  triggerPlaceholder: {
    color: colors.inkFaint.hex,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  clearButton: {
    height: 28,
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearButtonText: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
    alignItems: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
    alignSelf: 'stretch',
    marginTop: 8,
  },
  modalPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalSecondaryButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  modalSecondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
});
