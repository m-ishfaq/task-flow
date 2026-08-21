import { useLocalSearchParams, router } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { ProjectIdSchema } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { boardsQueryKey, type Board } from '../../../src/lib/work.js';

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
  const boards = useQuery({
    queryKey: boardsQueryKey(projectId),
    queryFn: async () =>
      wire(await apiClient.work.boards.list.query({ projectId, includeArchived: false })),
  });

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
    <View style={styles.container}>
      <BackButton />
      <Text style={styles.title}>Boards</Text>

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
    paddingTop: 24,
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
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
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
