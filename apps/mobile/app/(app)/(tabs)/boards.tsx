import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
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
import { Fab } from '../../../src/lib/fab.js';
import { SkeletonList } from '../../../src/lib/skeleton.js';
import { toast, ToastHost } from '../../../src/lib/toast.js';

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
 *
 * **Title row height matches `TopBar`'s 36 px icon row**, both starting at
 * `insets.top + 4`, so "Boards" and the account/search/bell icons share the
 * same vertical centre. `useTopInset(4)` instead of the default 24 is what
 * makes the content start there; `TOPBAR_ICON_CLEARANCE` keeps the title
 * text out of the icon cluster on the right.
 *
 * **"New project" form is a bottom-sheet Modal, not an inline push-down
 * panel.** The inline form displaced the project list downward, making
 * the visible list shorter each time a user tapped "+", and gave no natural
 * way to dismiss without a cancel button scroll. A sheet slides up from the
 * bottom the same way the OS keyboard does — the list stays untouched, the
 * form gets full focus, and a tap on the backdrop or the "Cancel" link
 * dismisses it.
 */

/** Right-side clearance so the title text never runs under the TopBar icon cluster. */
const TOPBAR_ICON_CLEARANCE = 120;

export default function Boards() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    } finally {
      setRefreshing(false);
    }
  };

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
      toast.success('Project created');
      await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    },
  });
  const paddingTop = useTopInset(4);

  // Same shape as `packages/api/src/work/router.ts`'s `ProjectKey`, restated
  // as a client-side hint (not the check — the server still re-validates):
  // 2-10 letters/digits, starting with a letter.
  const keyValid = /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(key.trim());
  const canSubmit = name.trim().length > 0 && keyValid && !create.isPending;

  const closeSheet = () => {
    setCreating(false);
    setName('');
    setKey('');
    setDescription('');
    create.reset();
  };

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Boards</Text>
      </View>

      <FlatList<Project>
        data={projects.data}
        keyExtractor={(project) => project.projectId}
        renderItem={({ item }) => <ProjectRow project={item} />}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void doRefresh();
            }}
            tintColor={colors.accent.hex}
          />
        }
        ListEmptyComponent={
          projects.isPending ? (
            <SkeletonList count={4} />
          ) : (
            <Text style={styles.label}>No projects yet.</Text>
          )
        }
      />

      {canCreateProject && (
        <Fab
          label="New project"
          bottom={24}
          onPress={() => {
            setCreating(true);
          }}
        />
      )}

      {/* Bottom-sheet modal — slides up from the bottom, list stays visible
          behind a dimmed backdrop. Tap outside or Cancel to dismiss. */}
      <Modal
        visible={creating && canCreateProject}
        transparent
        animationType="slide"
        onRequestClose={closeSheet}
      >
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.sheetKAV}
          >
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>New project</Text>
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
              <Pressable style={styles.createCancel} onPress={closeSheet}>
                <Text style={styles.createCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
      <ToastHost />
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
  /* 36 px height + center-align puts the title text on exactly the same
     vertical axis as the TopBar's icon row, which also sits 4 px below the
     safe-area top and spans 36 px. paddingRight reserves the right side for
     those icons so the text never runs under them. */
  titleRow: {
    height: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingRight: TOPBAR_ICON_CLEARANCE,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 10,
    paddingBottom: 80,
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
  /* Bottom-sheet modal */
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheetKAV: {
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
    paddingBottom: 32,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line.hex,
    alignSelf: 'center',
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink.hex,
    marginBottom: 4,
  },
  createInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  createKeyInput: {
    width: 140,
    fontVariant: ['tabular-nums'],
  },
  createSubmit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  createSubmitDisabled: {
    opacity: 0.5,
  },
  createSubmitText: {
    color: colors.accentInk.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  createError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  createCancel: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  createCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
});
