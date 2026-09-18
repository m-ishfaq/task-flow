import { useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SkeletonList } from '../../../src/lib/skeleton.js';
import { shadows } from '../../../src/lib/premium.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProjectIdSchema } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
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
 * **"Insights" shows only for an org owner/admin.** Unlike Sprints and
 * Settings, the insights screen is ORG-WIDE analytics gated `analytics:read`
 * (owner + admin only), so — matching `account.tsx`'s own entry point to the
 * same screen — this hides the link for everyone else rather than letting
 * them tap into a guaranteed FORBIDDEN. The server is still the sole
 * enforcer; hiding a dead control is only the UX convenience account.tsx's
 * own comment already documents.
 *
 * **Rename and Archive live on each board's own row**, gated on that
 * board's own `capabilities.update`/`.delete` — per-board, not inherited
 * from the project, since a board can carry its own share grant
 * independent of project-level access (mirrors web's
 * `project-settings-page.tsx`'s `BoardSection`). No confirm on archive: it
 * is reversible and the board's cards are untouched, the same call web
 * makes for the identical control.
 *
 * **Header layout — three rows.** The back button shares the same 36 px
 * horizontal band as `TopBar`'s icon cluster (both starting at
 * `insets.top + 4`), occupying only the left side so there is no collision.
 * The title sits on its own row below that band, and the secondary actions
 * (Sprints, Insights, Settings, New board) get a third, wrapping row of
 * their own: four buttons cannot share one line with the title on a phone,
 * so they flow onto a second line rather than clipping off the right edge.
 * "New board" is a bottom-sheet modal rather than an inline toggle — same
 * reasoning as `(tabs)/boards.tsx`'s own redesign of its create form.
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

  // Insights is org-wide analytics, gated `analytics:read` (owner + admin
  // only). The server enforces it; this hides the link for non-admins as the
  // same UX convenience account.tsx makes for the identical entry point —
  // otherwise a member sees a button that only ever answers FORBIDDEN. Reuses
  // account.tsx's own `tenancy.orgs.list` query (same key = a cache hit when
  // that screen has already loaded), reading the role for the selected org.
  const orgId = useSession((state) => state.orgId);
  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
  });
  const currentOrg = orgs.data?.find((org) => org.orgId === orgId);
  const isOrgAdmin = currentOrg?.role === 'owner' || currentOrg?.role === 'admin';

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
  const paddingTop = useTopInset(4);

  const closeSheet = () => {
    setCreating(false);
    setName('');
    create.reset();
  };

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
      {/* Row 1: back button — 36 px, left only — shares horizontal band with
          TopBar icons. Keeps the right side clear so no collision occurs. */}
      <View style={styles.backRow}>
        <BackButton />
      </View>

      {/* Row 2: title — below the TopBar zone. */}
      <View style={styles.titleRow}>
        <Text style={styles.title}>Boards</Text>
      </View>

      {/* Row 3: secondary actions, on their own wrapping row. Given the full
          width rather than sharing a line with the title, a fourth button
          wraps to the next line instead of pushing the others off the right
          edge — the old single row could not fit Sprints + Insights +
          Settings + New board on a phone. */}
      <View style={styles.titleActions}>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            router.push(`/sprints/${projectId}`);
          }}
        >
          <Text style={styles.secondaryButtonText}>Sprints</Text>
        </TouchableOpacity>
        {isOrgAdmin && (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              router.push('/insights');
            }}
          >
            <Text style={styles.secondaryButtonText}>Insights</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            router.push(`/project-settings/${projectId}`);
          }}
        >
          <Text style={styles.secondaryButtonText}>Settings</Text>
        </TouchableOpacity>
        {/* Hidden rather than disabled: a caller without `project:update`
            could not submit this form regardless, so showing it as
            unusable is clutter, not information. */}
        {canCreateBoard && (
          <TouchableOpacity
            style={styles.newButton}
            onPress={() => {
              setCreating(true);
            }}
          >
            <Text style={styles.newButtonText}>+ New board</Text>
          </TouchableOpacity>
        )}
      </View>

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
              <TouchableOpacity
                style={styles.rowMain}
                onPress={() => {
                  router.push(`/board/${item.boardId}`);
                }}
              >
                <Text style={styles.rowTitle}>{item.name}</Text>
              </TouchableOpacity>
              {item.capabilities.update && (
                <TouchableOpacity
                  onPress={() => {
                    setEditingBoard(item.boardId);
                    setEditBoardName(item.name);
                  }}
                >
                  <Text style={styles.rowAction}>Rename</Text>
                </TouchableOpacity>
              )}
              {item.capabilities.delete && (
                <TouchableOpacity
                  disabled={archive.isPending}
                  onPress={() => {
                    archive.mutate(item.boardId);
                  }}
                >
                  <Text style={styles.rowAction}>Archive</Text>
                </TouchableOpacity>
              )}
            </View>
          )
        }
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          boards.isPending ? (
            <SkeletonList count={3} />
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

      {/* Bottom-sheet modal for creating a board — same pattern as boards.tsx. */}
      <Modal
        visible={creating && canCreateBoard}
        transparent
        animationType="slide"
        onRequestClose={closeSheet}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.sheetBackdrop}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>New board</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Board name"
              placeholderTextColor={colors.inkFaint.hex}
              style={styles.sheetInput}
              autoFocus
            />
            <Pressable
              style={[
                styles.createSubmit,
                (create.isPending || name.trim().length === 0) && styles.createSubmitDisabled,
              ]}
              disabled={create.isPending || name.trim().length === 0}
              onPress={() => {
                create.mutate(name.trim());
              }}
            >
              {create.isPending ? (
                <ActivityIndicator color={colors.accentInk.hex} />
              ) : (
                <Text style={styles.createSubmitText}>Create board</Text>
              )}
            </Pressable>
            {create.isError && (
              <Text style={styles.createError} accessibilityRole="alert">
                {apiErrorOf(create.error)?.error.message ?? 'The board could not be created.'}
              </Text>
            )}
            <Pressable style={styles.createCancel} onPress={closeSheet}>
              <Text style={styles.createCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function BackButton() {
  return (
    <TouchableOpacity
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    gap: 8,
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
  /* 36 px height puts the back button text on the same vertical centre as
     TopBar's icon row. Occupies only the left side — no collision on right. */
  backRow: {
    height: 36,
    justifyContent: 'center',
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
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  titleActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.surfaceRaised.hex,
  },
  secondaryButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  newButton: {
    borderWidth: 1,
    borderColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  newButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  createInput: {
    flex: 1,
    minWidth: 160,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  /* Sheet context: vertical flex column — `flex: 1` collapses a TextInput
     to its minimum when there is no measured height in the parent. This
     style gives the input a fixed height that looks right in a bottom
     sheet while the inline-edit `createInput` keeps its flex behaviour. */
  sheetInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
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
  createSubmitDisabled: {
    opacity: 0.5,
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
  createCancel: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  createCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
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
    gap: 12,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    ...shadows.sm,
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
    borderColor: colors.accent.hex + '40',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    ...shadows.sm,
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
  /* Bottom-sheet modal */
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
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
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink.hex,
    marginBottom: 4,
  },
});
