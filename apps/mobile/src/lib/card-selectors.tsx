import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { Avatar } from './avatar.js';
import { useMembers, type Member } from './use-members.js';
import { isOpenSprint, sprintsQueryKey } from './sprints.js';
import {
  MY_TASKS_QUERY_KEY,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  cardLabelsQueryKey,
  cardQueryKey,
  labelsQueryKey,
  nextLabelColor,
  statusesQueryKey,
  type Priority,
} from './work.js';
import { ChipScroll, Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * Which status a card carries — `apps/web`'s `StatusSection`, as a chip row
 * matching `PrioritySelector`'s own shape rather than web's `<select>` (this
 * app has no native picker component, the same call `SprintSelector` below
 * already makes). `work.statuses.list` is PROJECT-scoped vocabulary, the
 * same tier labels live at — a status set is shared by every board in the
 * project, not owned by this one card. `cards.setStatus` is a DEDICATED
 * route, not part of `cards.update`'s full replace, matching web's own
 * split in `card.service.ts`: status changes emit `card.status_changed`,
 * priority rides `cards.update` alongside title and dates.
 */
export function StatusSelector({
  cardId,
  projectId,
  statusId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
  readonly statusId: string | null;
}) {
  const queryClient = useQueryClient();
  const statuses = useQuery({
    queryKey: statusesQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.statuses.list.query({ projectId })),
  });

  const setStatus = useMutation({
    mutationFn: (next: string | null) =>
      apiClient.work.cards.setStatus.mutate({ cardId, statusId: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) });
    },
  });

  return (
    <Section label="Status">
      <ChipScroll>
        <Pressable
          style={[styles.priorityChip, statusId === null && styles.priorityChipActive]}
          disabled={setStatus.isPending}
          onPress={() => {
            if (statusId !== null) setStatus.mutate(null);
          }}
        >
          <Text style={styles.priorityChipText}>No status</Text>
        </Pressable>
        {(statuses.data ?? []).map((status) => (
          <Pressable
            key={status.statusId}
            style={[styles.priorityChip, statusId === status.statusId && styles.priorityChipActive]}
            disabled={setStatus.isPending}
            onPress={() => {
              if (statusId !== status.statusId) setStatus.mutate(status.statusId);
            }}
          >
            <View style={[styles.swatch, { backgroundColor: status.color }]} />
            <Text style={styles.priorityChipText}>{status.name}</Text>
          </Pressable>
        ))}
      </ChipScroll>
      {setStatus.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(setStatus.error)?.error.message ?? 'The status was not saved.'}
        </Text>
      )}
    </Section>
  );
}

/**
 * Mirrors web's `PrioritySection`: a discrete choice fires immediately,
 * with no separate "Save" — unlike the title, tapping a chip already IS a
 * complete edit. Five options, not four: "None" clears the field, the same
 * choice web's `<select>` offers as its first `<option>`.
 *
 * Was the one selector on this screen with no `Section` wrapper at all —
 * every sibling (`StatusSelector`, `SprintSelector`, ...) already labelled
 * itself; this one rendered a bare chip row between "Status" and the dates,
 * which is exactly the "can't tell what's what" bug the 2026-08-22 device
 * screenshot caught. Fixed by giving it the same wrapper as everyone else,
 * not a one-off label.
 */
export function PrioritySelector({
  value,
  onChange,
}: {
  readonly value: Priority | null;
  readonly onChange: (priority: Priority | null) => void;
}) {
  return (
    <Section label="Priority">
      <ChipScroll>
        <Pressable
          style={[styles.priorityChip, value === null && styles.priorityChipActive]}
          onPress={() => {
            onChange(null);
          }}
        >
          <Text style={styles.priorityChipText}>None</Text>
        </Pressable>
        {PRIORITIES.map((priority) => (
          <Pressable
            key={priority}
            style={[styles.priorityChip, value === priority && styles.priorityChipActive]}
            onPress={() => {
              onChange(priority);
            }}
          >
            <View style={[styles.swatch, { backgroundColor: PRIORITY_COLOR[priority] }]} />
            <Text style={styles.priorityChipText}>{PRIORITY_LABEL[priority]}</Text>
          </Pressable>
        ))}
      </ChipScroll>
    </Section>
  );
}

/**
 * Which sprint a card is in — `apps/web`'s `SprintSection`, as a chip row
 * matching `PrioritySelector`'s own shape rather than web's `<select>`
 * (this app has no native picker component). `assignSprint`/`releaseSprint`
 * are dedicated `card:update` routes, not part of `cards.update`'s full
 * replace (`use-update-card.ts`'s own header explains why sprint is not in
 * `CardPatch`), so this calls them directly rather than going through
 * `useUpdateCard`.
 *
 * A CLOSED sprint (`completed`/`cancelled`) still renders when the card is
 * currently in one — a card shows where it shipped — but only as the
 * current selection, never offered as a destination: `isOpenSprint` is the
 * same closed-list check `sprints/[projectId].tsx`'s own Move sheet uses,
 * kept here rather than trusting the server to refuse a bad tap silently.
 */
export function SprintSelector({
  cardId,
  projectId,
  sprintId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
  readonly sprintId: string | null;
}) {
  const queryClient = useQueryClient();

  const sprints = useQuery({
    queryKey: sprintsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.sprints.list.query({ projectId })),
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: sprintsQueryKey(projectId) }),
    ]);
  };

  const assign = useMutation({
    mutationFn: (targetSprintId: string) =>
      apiClient.work.cards.assignSprint.mutate({ cardId, sprintId: targetSprintId }),
    onSuccess: refresh,
  });
  const release = useMutation({
    mutationFn: () => apiClient.work.cards.releaseSprint.mutate({ cardId }),
    onSuccess: refresh,
  });

  const openSprints = (sprints.data ?? []).filter(isOpenSprint);
  const closedCurrent =
    sprintId !== null && !openSprints.some((sprint) => sprint.sprintId === sprintId)
      ? sprints.data?.find((sprint) => sprint.sprintId === sprintId)
      : undefined;

  return (
    <Section label="Sprint">
      <ChipScroll>
        <Pressable
          style={[styles.priorityChip, sprintId === null && styles.priorityChipActive]}
          disabled={release.isPending}
          onPress={() => {
            if (sprintId !== null) release.mutate();
          }}
        >
          <Text style={styles.priorityChipText}>Backlog</Text>
        </Pressable>
        {openSprints.map((sprint) => (
          <Pressable
            key={sprint.sprintId}
            style={[styles.priorityChip, sprintId === sprint.sprintId && styles.priorityChipActive]}
            disabled={assign.isPending}
            onPress={() => {
              if (sprintId !== sprint.sprintId) assign.mutate(sprint.sprintId);
            }}
          >
            <Text style={styles.priorityChipText}>{sprint.name}</Text>
          </Pressable>
        ))}
        {closedCurrent !== undefined && (
          <View
            style={[styles.priorityChip, styles.priorityChipActive, styles.priorityChipDisabled]}
          >
            <Text style={styles.priorityChipText}>{closedCurrent.name}</Text>
          </View>
        )}
      </ChipScroll>
      {(assign.isError || release.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(assign.error ?? release.error)?.error.message ?? 'The sprint was not saved.'}
        </Text>
      )}
    </Section>
  );
}

/**
 * Who a card is assigned to — `apps/web`'s `AssigneeSection`. Sends the
 * WHOLE SET rather than an add/remove delta, matching `cards.assign` on
 * the server: two people editing assignees concurrently with deltas
 * converge on a set neither of them chose, whereas the intended set means
 * the last writer wins something a human actually asked for.
 *
 * **A modal picker, not a wall of chips** — the same call web's own header
 * makes and for the identical reason: an org's member list can run to
 * dozens of people, and scrolling past fifty names inline to find one
 * checkbox is the bug this avoids. Every tap inside the picker sends the
 * full set immediately (not disabled while pending) — assigning two or
 * three people in a row is the normal gesture, and a control that goes
 * dead between each tap turns one action into three waits.
 */
export function AssigneeSelector({
  cardId,
  assigneeIds,
}: {
  readonly cardId: CardId;
  readonly assigneeIds: readonly string[];
}) {
  const queryClient = useQueryClient();
  const { people, peopleOf } = useMembers();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const assign = useMutation({
    mutationFn: (ids: readonly string[]) =>
      apiClient.work.cards.assign.mutate({ cardId, assigneeIds: [...ids] }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
        // Assigning/unassigning changes whether this card appears in "My
        // Tasks" at all — unlike status/labels, which that screen does not
        // show or filter by.
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      ]);
    },
  });

  const selected = new Set(assigneeIds);
  const assigned = peopleOf(assigneeIds);

  const toggle = (userId: string) => {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    assign.mutate([...next]);
  };

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ''
      ? people
      : people.filter((member: Member) => member.email.toLowerCase().includes(needle));

  return (
    <Section label="Assignees">
      <ChipScroll>
        {assigned.length === 0 && <Text style={styles.emptyHint}>Unassigned</Text>}
        {assigned.map((person) => (
          <Pressable
            key={person.userId}
            style={styles.assigneeChip}
            onPress={() => {
              toggle(person.userId);
            }}
          >
            <Avatar label={person.label} size={20} seed={person.userId} />
            <Text style={styles.assigneeChipText} numberOfLines={1}>
              {person.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={styles.addChipButton}
          onPress={() => {
            setQuery('');
            setPickerOpen(true);
          }}
        >
          <Text style={styles.addChipButtonText}>+</Text>
        </Pressable>
      </ChipScroll>
      {assign.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(assign.error)?.error.message ?? 'Assignees were not saved.'}
        </Text>
      )}

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setPickerOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setPickerOpen(false);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Assign to…</Text>
            {people.length > 8 && (
              <TextInput
                style={styles.modalInput}
                placeholder="Search members…"
                placeholderTextColor={colors.inkFaint.hex}
                value={query}
                onChangeText={setQuery}
              />
            )}
            <ScrollView style={styles.pickerList}>
              {filtered.length === 0 ? (
                <Text style={styles.emptyHint}>No matches.</Text>
              ) : (
                filtered.map((member: Member) => {
                  const on = selected.has(member.userId);
                  return (
                    <Pressable
                      key={member.userId}
                      style={styles.pickerRow}
                      onPress={() => {
                        toggle(member.userId);
                      }}
                    >
                      <Avatar
                        label={member.displayName ?? member.email}
                        size={24}
                        seed={member.userId}
                      />
                      <Text style={styles.pickerRowText} numberOfLines={1}>
                        {member.displayName ?? member.email}
                      </Text>
                      {on && <Text style={styles.pickerCheck}>✓</Text>}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setPickerOpen(false);
              }}
            >
              <Text style={styles.modalCancelText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Section>
  );
}

/**
 * Labels on a card, and the project's label set — `apps/web`'s
 * `LabelSection`, as an inline chip row (not the assignee picker's modal):
 * a project's label set is typically five to eight entries, the same
 * distinction web's own header draws between "tolerable as a wall of
 * chips" and "not" at member-list scale.
 *
 * Two authorization questions, deliberately not merged
 * (`apps/api/src/work/label.service.ts`): TAGGING a card is `card:update`
 * — it changes one card; MANAGING the label set is `project:update` — it
 * changes every card in the project. The UI shows both controls to
 * everyone and lets the server answer, never a client-side role check
 * (CLAUDE.md §8.2).
 */
export function LabelSelector({
  cardId,
  projectId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState('');

  const all = useQuery({
    queryKey: labelsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.labels.list.query({ projectId })),
  });
  const onCard = useQuery({
    queryKey: cardLabelsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.labels.onCard.query({ cardId })),
  });

  const selected = new Set((onCard.data ?? []).map((label) => label.labelId));

  const setLabels = useMutation({
    mutationFn: (labelIds: readonly string[]) =>
      apiClient.work.labels.setOnCard.mutate({ cardId, labelIds: [...labelIds] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardLabelsQueryKey(cardId) });
    },
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      apiClient.work.labels.create.mutate({
        projectId,
        name,
        color: nextLabelColor(all.data?.length ?? 0),
      }),
    onSuccess: () => {
      setCreating('');
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: labelsQueryKey(projectId) });
    },
  });

  const toggle = (labelId: string) => {
    const next = new Set(selected);
    if (next.has(labelId)) next.delete(labelId);
    else next.add(labelId);
    setLabels.mutate([...next]);
  };

  return (
    <Section label="Labels">
      {all.data?.length === 0 ? (
        <Text style={styles.emptyHint}>This project has no labels yet.</Text>
      ) : (
        <ChipScroll>
          {(all.data ?? []).map((label) => {
            const on = selected.has(label.labelId);
            return (
              <Pressable
                key={label.labelId}
                style={[
                  styles.labelChip,
                  on ? { backgroundColor: label.color } : styles.labelChipOff,
                ]}
                onPress={() => {
                  toggle(label.labelId);
                }}
              >
                <Text style={[styles.labelChipText, on && styles.labelChipTextOn]}>
                  {label.name}
                </Text>
              </Pressable>
            );
          })}
        </ChipScroll>
      )}

      <View style={styles.addCardRow}>
        <TextInput
          style={styles.addCardInput}
          placeholder="New label"
          placeholderTextColor={colors.inkFaint.hex}
          value={creating}
          onChangeText={setCreating}
          onSubmitEditing={() => {
            const value = creating.trim();
            if (value !== '') create.mutate(value);
          }}
        />
        <Pressable
          style={styles.addCardButton}
          disabled={create.isPending || creating.trim().length === 0}
          onPress={() => {
            const value = creating.trim();
            if (value !== '') create.mutate(value);
          }}
        >
          <Text style={styles.addCardButtonText}>Add</Text>
        </Pressable>
      </View>
      {(setLabels.isError || create.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(setLabels.error ?? create.error)?.error.message ?? 'Labels were not saved.'}
        </Text>
      )}
    </Section>
  );
}
