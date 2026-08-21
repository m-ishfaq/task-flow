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
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => {
              router.push(`/board/${item.boardId}`);
            }}
          >
            <Text style={styles.rowTitle}>{item.name}</Text>
          </Pressable>
        )}
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
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
  },
  rowTitle: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
});
