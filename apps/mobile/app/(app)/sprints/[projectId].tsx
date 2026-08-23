import { useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProjectIdSchema, type ProjectId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { CardRow } from '../../../src/lib/card-row.js';
import {
  MY_TASKS_QUERY_KEY,
  PROJECTS_QUERY_KEY,
  boardCardsQueryKey,
  boardsQueryKey,
  cardQueryKey,
  type CardSummary,
} from '../../../src/lib/work.js';
import {
  SPRINT_STATUS_LABEL,
  isOpenSprint,
  sprintsQueryKey,
  type SprintSummary,
} from '../../../src/lib/sprints.js';

/** Which cards the list below shows — a sprint id, or the `'backlog'` sentinel for `sprintId === null`. */
type Selection = string;

/**
 * A project's sprints — view, plan (assign/release cards), and manage
 * (create/start/complete/cancel/edit). `ai/phase-14-mobile.md`'s Sprints
 * roadmap row, entirely absent from mobile before this screen.
 *
 * **Same tab-strip-over-a-list shape `board/[boardId].tsx`'s own redesign
 * already established** — "Backlog" plus one chip per sprint (name, status
 * color, card count), switching which cards the list below shows. Not a
 * coincidence: this is the identical problem (many small groups, one at a
 * time is what a phone screen can hold) with a different grouping key.
 * Moving a card between the backlog and a sprint reuses `board/
 * [boardId].tsx`'s own bottom-sheet Move pattern too — the "Move" button
 * `CardRow` already renders opens a sheet naming the OTHER destinations,
 * exactly the same shape, just backlog+sprints instead of lists.
 *
 * **A board picker appears only when the project has more than one
 * board.** `work.cards.list` is board-scoped — there is no project-wide
 * card read — so this screen picks one board's cards to show, the same
 * constraint `apps/web`'s own `SprintPlanning` names via its own board
 * `<select>` ("shown when more than one option exists"). For the common
 * one-board-per-project case this renders nothing extra at all.
 *
 * **No CSV import here** — `sprints.ts`'s own header has the reasoning
 * (a file picker is a new native dependency, plus a dry-run preview and a
 * per-row error list; real, separate work). Export ships: `work.cards.
 * export`'s output is a plain string, so "Export CSV" is one more
 * `Share.share` call, the same pattern `export-data-section.tsx`'s DSAR
 * export already established for this app.
 */
export default function SprintsScreen() {
  const params = useLocalSearchParams<{ projectId: string }>();
  const parsedProjectId = ProjectIdSchema.safeParse(params.projectId);

  if (!parsedProjectId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This project link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <SprintsContent projectId={parsedProjectId.data} />;
}

function SprintsContent({ projectId }: { projectId: ReturnType<typeof ProjectIdSchema.parse> }) {
  const queryClient = useQueryClient();
  const paddingTop = useTopInset();

  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SprintSummary | null>(null);
  const [moving, setMoving] = useState<CardSummary | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [completing, setCompleting] = useState<SprintSummary | null>(null);

  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.projects.list.query({ includeArchived: false })),
  });
  const project = projects.data?.find((entry) => entry.projectId === projectId);
  const canManage = project?.capabilities.update === true;

  const sprints = useQuery({
    queryKey: sprintsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.sprints.list.query({ projectId })),
  });

  const boards = useQuery({
    queryKey: boardsQueryKey(projectId),
    queryFn: async () =>
      wire(await apiClient.work.boards.list.query({ projectId, includeArchived: false })),
  });
  const activeBoardId = selectedBoardId ?? boards.data?.[0]?.boardId ?? null;

  const cards = useQuery({
    // `'' as never` isn't needed here — `boardCardsQueryKey` takes a plain
    // `string` — but the placeholder-key-plus-`enabled` shape mirrors
    // `apps/web`'s own `statusesQuery(orgId, projectId ?? ('' as ProjectId))`
    // (`board-page.tsx`): a query with no board yet still needs a stable,
    // distinct key, and the real fetch never runs to see the placeholder.
    queryKey: boardCardsQueryKey(activeBoardId ?? ''),
    queryFn: async () =>
      activeBoardId === null
        ? []
        : wire(await apiClient.work.cards.list.query({ boardId: activeBoardId })),
    enabled: activeBoardId !== null,
  });

  const activeSelection: Selection =
    selection !== null &&
    (selection === 'backlog' || sprints.data?.some((s) => s.sprintId === selection))
      ? selection
      : (sprints.data?.find((s) => s.status === 'active')?.sprintId ?? 'backlog');

  const filteredCards = (cards.data ?? []).filter((card) =>
    activeSelection === 'backlog' ? card.sprintId === null : card.sprintId === activeSelection,
  );

  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: sprintsQueryKey(projectId) }),
      activeBoardId === null
        ? Promise.resolve()
        : queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(activeBoardId) }),
      queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
    ]);
  };

  const assign = useMutation({
    mutationFn: (input: { cardId: string; sprintId: string }) =>
      apiClient.work.cards.assignSprint.mutate(input),
    onSuccess: async () => {
      setMoving(null);
      await refreshAll();
      if (moving) await queryClient.invalidateQueries({ queryKey: cardQueryKey(moving.cardId) });
    },
    onError: setMoveError,
  });
  const release = useMutation({
    mutationFn: (cardId: string) => apiClient.work.cards.releaseSprint.mutate({ cardId }),
    onSuccess: async () => {
      setMoving(null);
      await refreshAll();
      if (moving) await queryClient.invalidateQueries({ queryKey: cardQueryKey(moving.cardId) });
    },
    onError: setMoveError,
  });

  const start = useMutation({
    mutationFn: (sprintId: string) => apiClient.work.sprints.start.mutate({ sprintId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sprintsQueryKey(projectId) });
    },
  });
  const complete = useMutation({
    mutationFn: (input: { sprintId: string; moveUnfinishedTo: string | null }) =>
      apiClient.work.sprints.complete.mutate(input),
    onSuccess: async () => {
      setCompleting(null);
      setSelection('backlog');
      await refreshAll();
    },
  });
  const cancel = useMutation({
    mutationFn: (sprintId: string) => apiClient.work.sprints.cancel.mutate({ sprintId }),
    onSuccess: async () => {
      setSelection('backlog');
      await refreshAll();
    },
  });

  const exportCsv = useMutation({
    mutationFn: async () =>
      wire(
        await apiClient.work.cards.export.query({
          projectId,
          format: 'csv',
          boardId: null,
          listId: null,
        }),
      ),
    onSuccess: (result) => {
      void Share.share({
        title: `${project?.key ?? 'project'}-cards.csv`,
        message: result.content,
      });
    },
  });

  const selectedSprint = sprints.data?.find((s) => s.sprintId === activeSelection) ?? null;

  if (sprints.isError || boards.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(sprints.error ?? boards.error)?.error.message ??
            "Couldn't load this project's sprints."}
        </Text>
        <BackButton />
      </View>
    );
  }

  if (sprints.isPending || boards.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.header}>
        <BackButton />
        <View style={styles.titleRow}>
          <Text style={styles.screenTitle}>Sprints</Text>
          <View style={styles.headerActions}>
            <Pressable
              disabled={exportCsv.isPending}
              onPress={() => {
                exportCsv.mutate();
              }}
            >
              {exportCsv.isPending ? (
                <ActivityIndicator color={colors.ink.hex} />
              ) : (
                <Text style={styles.exportText}>Export CSV</Text>
              )}
            </Pressable>
            {canManage && (
              <Pressable
                onPress={() => {
                  setCreating((open) => !open);
                }}
              >
                <Text style={styles.newText}>{creating ? 'Cancel' : '+ New sprint'}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {creating && canManage && (
        <SprintForm
          projectId={projectId}
          onDone={() => {
            setCreating(false);
          }}
        />
      )}
      {editing !== null && (
        <SprintForm
          projectId={projectId}
          sprint={editing}
          onDone={() => {
            setEditing(null);
          }}
        />
      )}

      {boards.data.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.boardStripFrame}
        >
          <View style={styles.boardStrip}>
            {boards.data.map((board) => (
              <Pressable
                key={board.boardId}
                style={[
                  styles.boardChip,
                  board.boardId === activeBoardId && styles.boardChipActive,
                ]}
                onPress={() => {
                  setSelectedBoardId(board.boardId);
                }}
              >
                <Text
                  style={[
                    styles.boardChipText,
                    board.boardId === activeBoardId && styles.boardChipTextActive,
                  ]}
                >
                  {board.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabStripFrame}>
        <View style={styles.tabStrip}>
          <Pressable
            style={[styles.tab, activeSelection === 'backlog' && styles.tabActive]}
            onPress={() => {
              setSelection('backlog');
            }}
          >
            <Text style={[styles.tabText, activeSelection === 'backlog' && styles.tabTextActive]}>
              Backlog
            </Text>
          </Pressable>
          {sprints.data.map((sprint) => (
            <Pressable
              key={sprint.sprintId}
              style={[styles.tab, activeSelection === sprint.sprintId && styles.tabActive]}
              onPress={() => {
                setSelection(sprint.sprintId);
              }}
            >
              <View
                style={[
                  styles.statusDot,
                  sprint.status === 'active' && styles.statusDotActive,
                  sprint.status === 'completed' && styles.statusDotCompleted,
                  sprint.status === 'cancelled' && styles.statusDotCancelled,
                ]}
              />
              <Text
                style={[
                  styles.tabText,
                  activeSelection === sprint.sprintId && styles.tabTextActive,
                ]}
                numberOfLines={1}
              >
                {sprint.name}
              </Text>
              <Text
                style={[
                  styles.tabCount,
                  activeSelection === sprint.sprintId && styles.tabCountActive,
                ]}
              >
                {sprint.cardCount}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {selectedSprint !== null && (
        <View style={styles.sprintInfo}>
          <View style={styles.sprintInfoRow}>
            <Text style={styles.sprintInfoTitle}>
              {SPRINT_STATUS_LABEL[selectedSprint.status]} · {selectedSprint.startsOn} –{' '}
              {selectedSprint.endsOn}
            </Text>
            {canManage && isOpenSprint(selectedSprint) && (
              <Pressable
                onPress={() => {
                  setEditing(selectedSprint);
                }}
              >
                <Text style={styles.sprintInfoAction}>Edit</Text>
              </Pressable>
            )}
          </View>
          {selectedSprint.goal !== null && (
            <Text style={styles.sprintInfoGoal}>{selectedSprint.goal}</Text>
          )}
          {canManage && (
            <View style={styles.sprintActions}>
              {selectedSprint.status === 'planned' && (
                <Pressable
                  style={styles.sprintActionButton}
                  disabled={start.isPending}
                  onPress={() => {
                    start.mutate(selectedSprint.sprintId);
                  }}
                >
                  <Text style={styles.sprintActionText}>Start</Text>
                </Pressable>
              )}
              {selectedSprint.status === 'active' && (
                <Pressable
                  style={styles.sprintActionButton}
                  onPress={() => {
                    setCompleting(selectedSprint);
                  }}
                >
                  <Text style={styles.sprintActionText}>Complete</Text>
                </Pressable>
              )}
              {isOpenSprint(selectedSprint) && (
                <Pressable
                  style={styles.sprintActionButton}
                  disabled={cancel.isPending}
                  onPress={() => {
                    cancel.mutate(selectedSprint.sprintId);
                  }}
                >
                  <Text style={styles.sprintActionTextDanger}>Cancel</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}

      <FlatList<CardSummary>
        data={filteredCards}
        keyExtractor={(card) => card.cardId}
        renderItem={({ item }) => (
          <CardRow
            card={item}
            onMove={() => {
              setMoveError(null);
              setMoving(item);
            }}
          />
        )}
        contentContainerStyle={styles.cardList}
        style={styles.cardListContainer}
        ListEmptyComponent={
          cards.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>
              {activeSelection === 'backlog' ? 'The backlog is empty.' : 'No cards in this sprint.'}
            </Text>
          )
        }
      />

      <Modal
        visible={moving !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setMoving(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setMoving(null);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Move "{moving?.title}" to…</Text>
            {moveError !== null && (
              <Text style={styles.modalError} accessibilityRole="alert">
                {apiErrorOf(moveError)?.error.message ?? 'The card could not be moved.'}
              </Text>
            )}
            {activeSelection !== 'backlog' && (
              <Pressable
                style={styles.modalRow}
                disabled={release.isPending}
                onPress={() => {
                  if (moving) release.mutate(moving.cardId);
                }}
              >
                <Text style={styles.modalRowText}>Backlog</Text>
              </Pressable>
            )}
            {sprints.data
              .filter((s) => isOpenSprint(s) && s.sprintId !== activeSelection)
              .map((s) => (
                <Pressable
                  key={s.sprintId}
                  style={styles.modalRow}
                  disabled={assign.isPending}
                  onPress={() => {
                    if (moving) assign.mutate({ cardId: moving.cardId, sprintId: s.sprintId });
                  }}
                >
                  <Text style={styles.modalRowText}>{s.name}</Text>
                </Pressable>
              ))}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setMoving(null);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={completing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setCompleting(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setCompleting(null);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Move unfinished cards to…</Text>
            <Text style={styles.sprintInfoGoal}>
              Cards already done stay in "{completing?.name}" as the shipped record.
            </Text>
            {complete.isError && (
              <Text style={styles.modalError} accessibilityRole="alert">
                {apiErrorOf(complete.error)?.error.message ?? 'The sprint could not be completed.'}
              </Text>
            )}
            <Pressable
              style={styles.modalRow}
              disabled={complete.isPending}
              onPress={() => {
                if (completing)
                  complete.mutate({ sprintId: completing.sprintId, moveUnfinishedTo: null });
              }}
            >
              <Text style={styles.modalRowText}>Backlog</Text>
            </Pressable>
            {sprints.data
              .filter((s) => isOpenSprint(s) && s.sprintId !== completing?.sprintId)
              .map((s) => (
                <Pressable
                  key={s.sprintId}
                  style={styles.modalRow}
                  disabled={complete.isPending}
                  onPress={() => {
                    if (completing)
                      complete.mutate({
                        sprintId: completing.sprintId,
                        moveUnfinishedTo: s.sprintId,
                      });
                  }}
                >
                  <Text style={styles.modalRowText}>{s.name}</Text>
                </Pressable>
              ))}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setCompleting(null);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function SprintForm({
  projectId,
  sprint,
  onDone,
}: {
  readonly projectId: ProjectId;
  readonly sprint?: SprintSummary;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(sprint?.name ?? '');
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [startsOn, setStartsOn] = useState(sprint?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(sprint?.endsOn ?? '');
  const locked = sprint?.status === 'active';

  const save = useMutation({
    // Create and update answer different shapes (`{ sprintId }` vs.
    // `{ name }`) that neither caller reads — only `onSuccess` (close the
    // form, refetch the list) matters, so the two branches are unified to
    // `Promise<void>` rather than forcing one `MutationFunction` type to
    // cover both outputs.
    mutationFn: async (): Promise<void> => {
      const input = {
        name: name.trim(),
        goal: goal.trim() === '' ? null : goal.trim(),
        startsOn,
        endsOn,
      };
      if (sprint === undefined) {
        await apiClient.work.sprints.create.mutate({ projectId, ...input });
      } else {
        await apiClient.work.sprints.update.mutate({ sprintId: sprint.sprintId, ...input });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sprintsQueryKey(projectId) });
      onDone();
    },
  });

  return (
    <View style={styles.formCard}>
      <Text style={styles.modalTitle}>{sprint === undefined ? 'New sprint' : 'Edit sprint'}</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Sprint name"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
        editable={!locked}
      />
      <TextInput
        value={goal}
        onChangeText={setGoal}
        placeholder="Goal (optional)"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
      />
      <View style={styles.formDatesRow}>
        <TextInput
          value={startsOn}
          onChangeText={setStartsOn}
          placeholder="Starts YYYY-MM-DD"
          placeholderTextColor={colors.inkFaint.hex}
          style={[styles.formInput, styles.formDateInput]}
          editable={!locked}
        />
        <TextInput
          value={endsOn}
          onChangeText={setEndsOn}
          placeholder="Ends YYYY-MM-DD"
          placeholderTextColor={colors.inkFaint.hex}
          style={[styles.formInput, styles.formDateInput]}
          editable={!locked}
        />
      </View>
      {save.isError && (
        <Text style={styles.modalError} accessibilityRole="alert">
          {apiErrorOf(save.error)?.error.message ?? 'The sprint could not be saved.'}
        </Text>
      )}
      <View style={styles.formActions}>
        <Pressable
          style={[
            styles.formSubmit,
            (save.isPending || name.trim() === '' || startsOn === '' || endsOn === '') &&
              styles.formSubmitDisabled,
          ]}
          disabled={save.isPending || name.trim() === '' || startsOn === '' || endsOn === ''}
          onPress={() => {
            save.mutate();
          }}
        >
          {save.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.formSubmitText}>{sprint === undefined ? 'Create' : 'Save'}</Text>
          )}
        </Pressable>
        <Pressable style={styles.modalCancel} onPress={onDone}>
          <Text style={styles.modalCancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 8,
    gap: 8,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  exportText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  newText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  formCard: {
    marginHorizontal: 24,
    marginBottom: 12,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceSunken.hex,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  formDatesRow: {
    flexDirection: 'row',
    gap: 8,
  },
  formDateInput: {
    flex: 1,
  },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  formSubmit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  formSubmitDisabled: {
    opacity: 0.5,
  },
  formSubmitText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  boardStripFrame: {
    flexGrow: 0,
    flexShrink: 0,
  },
  boardStrip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingBottom: 8,
    gap: 8,
  },
  boardChip: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  boardChipActive: {
    backgroundColor: colors.surfaceHover.hex,
    borderColor: colors.inkMuted.hex,
  },
  boardChipText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  boardChipTextActive: {
    color: colors.ink.hex,
    fontWeight: '600',
  },
  tabStripFrame: {
    flexGrow: 0,
    flexShrink: 0,
  },
  tabStrip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 8,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.surfaceRaised.hex,
    maxWidth: 200,
  },
  tabActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  tabTextActive: {
    color: colors.accentInk.hex,
  },
  tabCount: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  tabCountActive: {
    color: colors.accentInk.hex,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.inkFaint.hex,
  },
  statusDotActive: {
    backgroundColor: colors.success.hex,
  },
  statusDotCompleted: {
    backgroundColor: colors.inkMuted.hex,
  },
  statusDotCancelled: {
    backgroundColor: colors.danger.hex,
  },
  sprintInfo: {
    marginHorizontal: 24,
    marginBottom: 12,
    padding: 14,
    gap: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
  },
  sprintInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sprintInfoTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  sprintInfoAction: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  sprintInfoGoal: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  sprintActions: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 2,
  },
  sprintActionButton: {},
  sprintActionText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  sprintActionTextDanger: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  cardListContainer: {
    flex: 1,
  },
  cardList: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 10,
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
    padding: 20,
    gap: 4,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 12,
  },
  modalError: {
    fontSize: 13,
    color: colors.danger.hex,
    marginBottom: 8,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
