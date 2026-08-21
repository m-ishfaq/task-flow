import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { PROJECTS_QUERY_KEY, type Project } from '../../../src/lib/work.js';

/**
 * Boards' entry point — the third tab, alongside My Tasks and Account (see
 * `_layout.tsx` in this folder). Completes Wave 2's roadmap row: "Work —
 * boards, lists, cards, My Tasks, card detail..." — My Tasks and card
 * detail shipped first because they need no drag-and-drop and no second
 * navigation level; a board genuinely does.
 *
 * A flat list of projects, mirroring `apps/web/src/features/work/
 * projects-page.tsx`'s own top level. Tapping a project drills into its
 * boards (`project/[projectId].tsx`) rather than jumping straight to a
 * board, because a project can hold more than one — this app does not
 * assume "one board per project" the way a shortcut would.
 */
export default function Boards() {
  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.projects.list.query({ includeArchived: false })),
  });
  const paddingTop = useTopInset();

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Text style={styles.title}>Boards</Text>

      <FlatList<Project>
        data={projects.data}
        keyExtractor={(project) => project.projectId}
        renderItem={({ item }) => <ProjectRow project={item} />}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          projects.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>No projects yet.</Text>
          )
        }
      />
    </View>
  );
}

function ProjectRow({ project }: { readonly project: Project }) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        router.push(`/project/${project.projectId}`);
      }}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{project.name}</Text>
        <Text style={styles.rowKey}>{project.key}</Text>
      </View>
      <Text style={styles.rowMeta}>
        {project.boardCount} {project.boardCount === 1 ? 'board' : 'boards'}
      </Text>
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  rowKey: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  rowMeta: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  label: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginTop: 8,
  },
});
