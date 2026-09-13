import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { colors, radiusCard } from '@taskflow/tokens';

/**
 * A bottom-sheet single-select picker, with a search box once the option
 * list is long enough to need one — Design Bible §20's "long lists, one
 * pattern, everywhere": search above any list expected to exceed ~15 rows,
 * rather than an unbounded scroll.
 *
 * ## Extracted from `automation-editor.tsx`'s own local `SelectModal`
 *
 * That file's rule builder has SEVEN pickers built on this exact shape
 * (member, channel, phone number, project, list, status, label) and every
 * one of them rendered its full option list with no way to narrow it — an
 * org with a couple hundred members made the "assign to" picker a scroll
 * nobody could use to find one specific person. This is the same component,
 * given a search box, so every existing caller gets the fix for free and any
 * future picker built the same way starts with it already.
 *
 * `share-board-modal.tsx`'s own member picker is deliberately NOT built on
 * this — its header already explains why it swaps this ONE modal's body
 * between the grant form and the member list rather than nesting a second
 * `<Modal>`, and this component IS its own `<Modal>`. That screen keeps its
 * inline search box instead, matching this file's own filtering logic by
 * hand rather than by sharing the component.
 */

const SEARCH_THRESHOLD = 8;

export interface PickerOption {
  readonly id: string;
  readonly name: string;
}

export function SearchablePickerModal({
  open,
  title,
  pending,
  options,
  emptyText,
  onSelect,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly pending: boolean;
  readonly options: readonly PickerOption[];
  readonly emptyText: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ''
      ? options
      : options.filter((option) => option.name.toLowerCase().includes(needle));

  const close = (): void => {
    setQuery('');
    onClose();
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.modalBackdrop} onPress={close}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>{title}</Text>
          {!pending && options.length > SEARCH_THRESHOLD && (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${title.toLowerCase()}…`}
              placeholderTextColor={colors.inkFaint.hex}
              style={styles.searchInput}
              autoCapitalize="none"
              autoFocus
            />
          )}
          {pending ? (
            <ActivityIndicator color={colors.accent.hex} style={styles.modalLoading} />
          ) : options.length === 0 ? (
            <Text style={styles.modalEmpty}>{emptyText}</Text>
          ) : visible.length === 0 ? (
            <Text style={styles.modalEmpty}>No match.</Text>
          ) : (
            <ScrollView style={styles.modalList} nestedScrollEnabled>
              {visible.map((option) => (
                <Pressable
                  key={option.id}
                  style={styles.modalRow}
                  onPress={() => {
                    setQuery('');
                    onSelect(option.id);
                  }}
                >
                  <Text style={styles.modalRowText} numberOfLines={1}>
                    {option.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <Pressable style={styles.modalCancel} onPress={close}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    gap: 8,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  modalLoading: {
    marginVertical: 12,
  },
  modalEmpty: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingVertical: 8,
  },
  modalList: {
    maxHeight: 360,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
