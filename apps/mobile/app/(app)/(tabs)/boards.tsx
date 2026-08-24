import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
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
 *
 * **"+ New project" is gated on `tenancy.orgs.get`'s `capabilities.
 * createProject`, not a role check** — the identical `orgDetailQuery` +
 * `canCreateProject` pattern `projects-page.tsx`'s own header documents:
 * creating a project has no existing resource to hold a tuple, so `can()`
 * with no target resolves from role alone, and that boolean is the server's
 * own answer rather than this screen re-deriving it from `role`.
 */
export default function Boards() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');

  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.projects.list.query({ includeArchived: false })),
  });
  const org = useQuery({
    queryKey: ['tenancy.orgs.get'],
    queryFn: () => apiClient.tenancy.orgs.get.query(),
  });
  const canCreateProject = org.data?.capabilities.createProject ?? false;

  const create = useMutation({
    mutationFn: () =>
      apiClient.work.projects.create.mutate({
        name: name.trim(),
        key: key.trim().toUpperCase(),
        description: description.trim() === '' ? null : description.trim(),
      }),
    onSuccess: async () => {
      setName('');
      setKey('');
      setDescription('');
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    },
  });
  const paddingTop = useTopInset();

  // Same shape as `packages/api/src/work/router.ts`'s `ProjectKey`, restated
  // as a client-side hint (not the check — the server still re-validates):
  // 2-10 letters/digits, starting with a letter.
  const keyValid = /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(key.trim());
  const canSubmit = name.trim().length > 0 && keyValid && !create.isPending;

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Boards</Text>
        {/* Hidden rather than disabled: a caller without `project:create`
            could not submit this form regardless, so showing it as
            unusable is clutter, not information. */}
        {canCreateProject && (
          <Pressable
            style={styles.newButton}
            onPress={() => {
              setCreating((open) => !open);
            }}
          >
            <Text style={styles.newButtonText}>{creating ? 'Cancel' : '+ New project'}</Text>
          </Pressable>
        )}
      </View>

      {creating && canCreateProject && (
        <View style={styles.createForm}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Project name"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.createInput}
            autoFocus
          />
          <TextInput
            value={key}
            onChangeText={setKey}
            placeholder="Key (e.g. WEB)"
            placeholderTextColor={colors.inkFaint.hex}
            style={[styles.createInput, styles.createKeyInput]}
            autoCapitalize="characters"
            maxLength={10}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Description (optional)"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.createInput}
          />
          <Pressable
            style={[styles.createSubmit, !canSubmit && styles.createSubmitDisabled]}
            disabled={!canSubmit}
            onPress={() => {
              create.mutate();
            }}
          >
            {create.isPending ? (
              <ActivityIndicator color={colors.accentInk.hex} />
            ) : (
              <Text style={styles.createSubmitText}>Create project</Text>
            )}
          </Pressable>
          {create.isError && (
            <Text style={styles.createError} accessibilityRole="alert">
              {apiErrorOf(create.error)?.error.message ?? 'The project could not be created.'}
            </Text>
          )}
        </View>
      )}

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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
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
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceSunken.hex,
    padding: 12,
  },
  createInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  createKeyInput: {
    width: 140,
    fontVariant: ['tabular-nums'],
  },
  createSubmit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  createSubmitDisabled: {
    opacity: 0.5,
  },
  createSubmitText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  createError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 10,
    paddingBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
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
