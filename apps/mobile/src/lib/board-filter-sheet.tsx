import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { useMembers } from './use-members.js';
import {
  isBoardFilterEmpty,
  toggleAssignee,
  toggleLabel,
  type BoardFilterSelection,
} from './board-filter.js';
import { PRIORITY_LABEL, labelsQueryKey, statusesQueryKey, type Priority } from './work.js';

/**
 * The trigger + sheet for `board-filter.ts`'s selection — the UI half of
 * the same simplified-filter scope that file's own header explains.
 * `projectId` is optional because it is only known once the board has at
 * least one card (`board/[boardId].tsx`'s own comment on why); with none,
 * the status/label chip rows show nothing rather than erroring, and
 * priority/assignee (which need no project) still work.
 */
export function BoardFilterButton({
  projectId,
  selection,
  onChange,
}: {
  readonly projectId: string | null;
  readonly selection: BoardFilterSelection;
  readonly onChange: (next: BoardFilterSelection) => void;
}) {
  const empty = isBoardFilterEmpty(selection);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        style={[styles.trigger, !empty && styles.triggerActive]}
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={[styles.triggerText, !empty && styles.triggerTextActive]}>
          Filter{!empty ? ` · ${String(activeCount(selection))}` : ''}
        </Text>
      </Pressable>

      <FilterSheet
        open={open}
        projectId={projectId}
        selection={selection}
        onChange={onChange}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

function activeCount(selection: BoardFilterSelection): number {
  return (
    (selection.statusId !== null ? 1 : 0) +
    (selection.priority !== null ? 1 : 0) +
    (selection.assigneeIds.length > 0 ? 1 : 0) +
    (selection.labelIds.length > 0 ? 1 : 0)
  );
}

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

function FilterSheet({
  open,
  projectId,
  selection,
  onChange,
  onClose,
}: {
  readonly open: boolean;
  readonly projectId: string | null;
  readonly selection: BoardFilterSelection;
  readonly onChange: (next: BoardFilterSelection) => void;
  readonly onClose: () => void;
}) {
  const { people, personOf } = useMembers();

  const statuses = useQuery({
    queryKey: statusesQueryKey(projectId ?? ''),
    queryFn: async () =>
      wire(await apiClient.work.statuses.list.query({ projectId: projectId ?? '' })),
    enabled: open && projectId !== null,
  });

  const labels = useQuery({
    queryKey: labelsQueryKey(projectId ?? ''),
    queryFn: async () =>
      wire(await apiClient.work.labels.list.query({ projectId: projectId ?? '' })),
    enabled: open && projectId !== null,
  });

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>Filter</Text>

          <ScrollView style={styles.body}>
            <Text style={styles.groupLabel}>Status</Text>
            {projectId === null ? (
              <Text style={styles.sectionEmptyHint}>Add a card to this board first.</Text>
            ) : statuses.isPending ? (
              <ActivityIndicator color={colors.accent.hex} />
            ) : (
              <View style={styles.chipRow}>
                <Chip
                  label="Any"
                  active={selection.statusId === null}
                  onPress={() => {
                    onChange({ ...selection, statusId: null });
                  }}
                />
                {(statuses.data ?? []).map((status) => (
                  <Chip
                    key={status.statusId}
                    label={status.name}
                    active={selection.statusId === status.statusId}
                    onPress={() => {
                      onChange({
                        ...selection,
                        statusId: selection.statusId === status.statusId ? null : status.statusId,
                      });
                    }}
                  />
                ))}
              </View>
            )}

            <Text style={styles.groupLabel}>Priority</Text>
            <View style={styles.chipRow}>
              <Chip
                label="Any"
                active={selection.priority === null}
                onPress={() => {
                  onChange({ ...selection, priority: null });
                }}
              />
              {PRIORITIES.map((priority) => (
                <Chip
                  key={priority}
                  label={PRIORITY_LABEL[priority]}
                  active={selection.priority === priority}
                  onPress={() => {
                    onChange({
                      ...selection,
                      priority: selection.priority === priority ? null : priority,
                    });
                  }}
                />
              ))}
            </View>

            <Text style={styles.groupLabel}>Assignee</Text>
            <View style={styles.chipRow}>
              {people.length === 0 && <Text style={styles.sectionEmptyHint}>No members yet.</Text>}
              {people.map((member) => (
                <Chip
                  key={member.userId}
                  label={personOf(member.userId).label}
                  active={selection.assigneeIds.includes(member.userId)}
                  onPress={() => {
                    onChange(toggleAssignee(selection, member.userId));
                  }}
                />
              ))}
            </View>

            <Text style={styles.groupLabel}>Label</Text>
            {projectId === null ? (
              <Text style={styles.sectionEmptyHint}>Add a card to this board first.</Text>
            ) : labels.isPending ? (
              <ActivityIndicator color={colors.accent.hex} />
            ) : (labels.data ?? []).length === 0 ? (
              <Text style={styles.sectionEmptyHint}>No labels yet.</Text>
            ) : (
              <View style={styles.chipRow}>
                {(labels.data ?? []).map((label) => (
                  <Chip
                    key={label.labelId}
                    label={label.name}
                    active={selection.labelIds.includes(label.labelId)}
                    onPress={() => {
                      onChange(toggleLabel(selection, label.labelId));
                    }}
                  />
                ))}
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              style={styles.footerButton}
              disabled={isBoardFilterEmpty(selection)}
              onPress={() => {
                onChange({ statusId: null, priority: null, assigneeIds: [], labelIds: [] });
              }}
            >
              <Text style={styles.footerButtonText}>Clear all</Text>
            </Pressable>
            <Pressable style={styles.doneButton} onPress={onClose}>
              <Text style={styles.doneButtonText}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  triggerActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  triggerText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  triggerTextActive: {
    color: colors.accentInk.hex,
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
    paddingBottom: 20,
    paddingTop: 10,
    height: '80%',
  },
  modalHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line.hex,
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 4,
  },
  body: {
    flex: 1,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 6,
  },
  sectionEmptyHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    backgroundColor: colors.surfaceSunken.hex,
    maxWidth: 200,
  },
  chipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  chipTextActive: {
    color: colors.accentInk.hex,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
  },
  footerButton: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  footerButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  doneButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  doneButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
