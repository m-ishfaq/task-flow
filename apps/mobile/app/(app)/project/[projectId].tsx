import { useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProjectIdSchema } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { PROJECTS_QUERY_KEY, boardsQueryKey, type Board } from '../../../src/lib/work.js';

/**
 * A project's boards — the drill-down step between `(tabs)/boards.tsx`
 * (projects) and `board/[boardId].tsx` (one board). Not skipped even when a
 * project has exactly one board: this app does not special-case that count,
 * the same call `(tabs)/boards.tsx`'s own header explains.
 *
 * `projectId` parsed through `ProjectIdSchema` before it reaches a query —
 * the URL is a trust boundary here exactly as it is for `card/[cardId].tsx`
 * (CLAUDE.md's Phase 3 section); a malformed id falls back to a safe "not
 * found" screen.
 *
 * **"+ New board" is gated on `project.capabilities.update`, never a role
 * check.** CLAUDE.md's own rule for this app ("the UI never re-derives
 * authorization... every control is shown and the server answers") and
 * `apps/web/src/features/work/projects-page.tsx`'s own header make the same
 * call for the identical reason: creating a board is `board:create` floored
 * on `project:update` server-side (`board.service.ts`'s `createBoard`
 * enforces it on the PARENT project, not a separate per-board tuple), so
 * `update` is genuinely what decides whether this control can do anything —
 * there is no `capabilities.createBoard` to read instead. This screen has
 * no dedicated "get one project" route to read that flag from, so it reuses
 * `(tabs)/boards.tsx`'s own `work.projects.list` query — same key, same
 * `includeArchived: false` args, so it is a cache hit (not a second
 * request) whenever this screen is reached the normal way, by tapping a row
 * that query already rendered.
 *
 * **"Sprints" and "Settings" always show, unlike "+ New board".** Viewing
 * sprints is `project:read` — the same floor this whole screen is already
 * gated on — so there is no capability to hide the entry point behind;
 * `sprints/[projectId].tsx` itself hides its own create/manage actions the
 * identical way this screen hides board creation. Settings
 * (`project-settings/[projectId].tsx`) is the same: reachable by anyone who
 * can see this screen, with each control on it individually gated.
 *
 * **Rename and Archive live on each board's own row**, gated on that
 * board's own `capabilities.update`/`.delete` — per-board, not inherited
 * from the project, since a board can carry its own share grant
 * independent of project-level access (mirrors web's
 * `project-settings-page.tsx`'s `BoardSection`). No confirm on archive: it
 * is reversible and the board's cards are untouched, the same call web
 * makes for the identical control.
 */
export default function ProjectBoards() {
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

  return <ProjectBoardsContent projectId={parsedProjectId.data} />;
}

function ProjectBoardsContent({
  projectId,
}: {
  projectId: ReturnType<typeof ProjectIdSchema.parse>;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editingBoard, setEditingBoard] = useState<string | null>(null);
  const [editBoardName, setEditBoardName] = useState('');

  const boards = useQuery({
    queryKey: boardsQueryKey(projectId),
    queryFn: async () =>
      wire(await apiClient.work.boards.list.query({ projectId, includeArchived: false })),
  });
  // Same key + args as (tabs)/boards.tsx's own query — a cache hit, not a
  // second request, whenever this screen is reached normally (see this
  // file's own header).
  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.projects.list.query({ includeArchived: false })),
  });
  const canCreateBoard =
    projects.data?.find((project) => project.projectId === projectId)?.capabilities.update ?? false;

  const create = useMutation({
    mutationFn: (boardName: string) =>
      apiClient.work.boards.create.mutate({ projectId, name: boardName }),
    onSuccess: async () => {
      setName('');
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: boardsQueryKey(projectId) });
    },
  });

  const rename = useMutation({
    mutationFn: (input: { boardId: string; name: string }) =>
      apiClient.work.boards.update.mutate(input),
    onSuccess: async () => {
      setEditingBoard(null);
      await queryClient.invalidateQueries({ queryKey: boardsQueryKey(projectId) });
    },
  });

  const archive = useMutation({
    mutationFn: (boardId: string) =>
      apiClient.work.boards.archive.mutate({ boardId, archived: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: boardsQueryKey(projectId) });
    },
  });
  const paddingTop = useTopInset();

  if (boards.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(boards.error)?.error.message ?? "Couldn't load this project."}
        </Text>
        <BackButton />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop }]}>
      <BackButton />
      <View style={styles.titleRow}>
        <Text style={styles.title}>Boards</Text>
        <View style={styles.titleActions}>
          <Pressable
            style={styles.sprintsButton}
            onPress={() => {
              router.push(`/sprints/${projectId}`);
            }}
          >
            <Text style={styles.sprintsButtonText}>Sprints</Text>
          </Pressable>
          <Pressable
            style={styles.sprintsButton}
            onPress={() => {
              router.push(`/project-settings/${projectId}`);
            }}
          >
            <Text style={styles.sprintsButtonText}>Settings</Text>
          </Pressable>
          {/* Hidden rather than disabled: a caller without `project:update`
              could not submit this form regardless, so showing it as
              unusable is clutter, not information. */}
          {canCreateBoard && (
            <Pressable
              style={styles.newButton}
              onPress={() => {
                setCreating((open) => !open);
              }}
            >
              <Text style={styles.newButtonText}>{creating ? 'Cancel' : '+ New board'}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {creating && canCreateBoard && (
        <View style={styles.createForm}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Board name"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.createInput}
            autoFocus
          />
          <Pressable
            style={styles.createSubmit}
            disabled={create.isPending || name.trim().length === 0}
            onPress={() => {
              create.mutate(name.trim());
            }}
          >
            {create.isPending ? (
              <ActivityIndicator color={colors.accentInk.hex} />
            ) : (
              <Text style={styles.createSubmitText}>Add</Text>
            )}
          </Pressable>
          {create.isError && (
            <Text style={styles.createError} accessibilityRole="alert">
              {apiErrorOf(create.error)?.error.message ?? 'The board could not be created.'}
            </Text>
          )}
        </View>
      )}

      <FlatList<Board>
        data={boards.data}
        keyExtractor={(board) => board.boardId}
        renderItem={({ item }) =>
          editingBoard === item.boardId ? (
            <View style={styles.editRow}>
              <TextInput
                value={editBoardName}
                onChangeText={setEditBoardName}
                style={styles.createInput}
                autoFocus
              />
              <Pressable
                style={styles.createSubmit}
                disabled={rename.isPending || editBoardName.trim().length === 0}
                onPress={() => {
                  rename.mutate({ boardId: item.boardId, name: editBoardName.trim() });
                }}
              >
                {rename.isPending ? (
                  <ActivityIndicator color={colors.accentInk.hex} />
                ) : (
                  <Text style={styles.createSubmitText}>Save</Text>
                )}
              </Pressable>
              <Pressable
                style={styles.cancelButton}
                onPress={() => {
                  setEditingBoard(null);
                }}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.row}>
              <Pressable
                style={styles.rowMain}
                onPress={() => {
                  router.push(`/board/${item.boardId}`);
                }}
              >
                <Text style={styles.rowTitle}>{item.name}</Text>
              </Pressable>
              {item.capabilities.update && (
                <Pressable
                  onPress={() => {
                    setEditingBoard(item.boardId);
                    setEditBoardName(item.name);
                  }}
                >
                  <Text style={styles.rowAction}>Rename</Text>
                </Pressable>
              )}
              {item.capabilities.delete && (
                <Pressable
                  disabled={archive.isPending}
                  onPress={() => {
                    archive.mutate(item.boardId);
                  }}
                >
                  <Text style={styles.rowAction}>Archive</Text>
                </Pressable>
              )}
            </View>
          )
        }
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          boards.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>This project has no boards yet.</Text>
          )
        }
      />
      {rename.isError && (
        <Text style={styles.createError} accessibilityRole="alert">
          {apiErrorOf(rename.error)?.error.message ?? 'Could not rename this board.'}
        </Text>
      )}
      {archive.isError && (
        <Text style={styles.createError} accessibilityRole="alert">
          {apiErrorOf(archive.error)?.error.message ?? 'Could not archive this board.'}
        </Text>
      )}
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
    paddingHorizontal: 24,
    gap: 12,
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
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sprintsButton: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sprintsButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  newButton: {
    borderWidth: 1,
    borderColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  newButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  createForm: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  createInput: {
    flex: 1,
    minWidth: 160,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  createSubmit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 56,
    alignItems: 'center',
  },
  createSubmitText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  createError: {
    width: '100%',
    fontSize: 12,
    color: colors.danger.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 8,
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  rowAction: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  editRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
  },
  cancelButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  cancelButtonText: {
    color: colors.inkMuted.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
});
