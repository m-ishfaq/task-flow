import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
import { SPACES_QUERY_KEY, type Space } from '../../../src/lib/docs.js';
import { Fab } from '../../../src/lib/fab.js';

const TOPBAR_ICON_CLEARANCE = 120;

/**
 * Docs — the 6th... really the 5th bottom tab again: this closes the gap
 * `(tabs)/_layout.tsx`'s own header has named since the Account move
 * ("Docs and Automations join this bar as their own waves ship a real
 * screen"). Automations got its own screen and, per that pass's own
 * argument, a link off Account rather than a tab — it is an occasional,
 * config-shaped destination. Docs is the opposite: something people
 * actually browse and drill into, the same "browsed often" test that kept
 * My Tasks, Boards, Chat, Calls, and People as tabs in the first place. It
 * takes the slot People just gave up — see `(tabs)/_layout.tsx`'s own
 * header for the full reasoning on why People moved instead of Docs.
 *
 * `docs.ts`'s own header has the full account of what ships here: spaces
 * and the page TREE — create, rename, move, archive/restore — and nothing
 * about a page's actual content. That needs a live Yjs client this app
 * does not have yet, which is why there is no "open a page" screen in this
 * pass; the tree lives one screen over, `docs-space/[spaceId].tsx`, reached
 * by tapping a space below.
 */
export default function DocsScreen() {
  const paddingTop = useTopInset(4);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const spaces = useQuery({
    queryKey: SPACES_QUERY_KEY,
    queryFn: async () => wire(await apiClient.docs.spaces.list.query()),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY });
  };

  const create = useMutation({
    mutationFn: (value: string) => apiClient.docs.spaces.create.mutate({ name: value }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setName('');
    },
    onError: (error: unknown) => {
      Alert.alert('This space could not be created', apiErrorOf(error)?.error.message);
    },
  });

  const archive = useMutation({
    mutationFn: (input: { spaceId: string; restore: boolean }) =>
      apiClient.docs.spaces.archive.mutate(input),
    onSuccess: invalidate,
    onError: (error: unknown) => {
      Alert.alert('That could not be updated', apiErrorOf(error)?.error.message);
    },
  });

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.titleRow}>
        <View style={styles.titleColumn}>
          <Text style={styles.title}>Docs</Text>
          <Text style={styles.subtitle}>Spaces and pages, organized from here.</Text>
        </View>
      </View>

      {spaces.isPending && <ActivityIndicator style={styles.loading} color={colors.accent.hex} />}
      {spaces.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(spaces.error)?.error.message ?? 'Could not load Docs spaces.'}
        </Text>
      )}
      {spaces.isSuccess && spaces.data.length === 0 && (
        <Text style={styles.emptyHint}>
          No spaces yet. Tap the + button to create the first one.
        </Text>
      )}

      <FlatList<Space>
        data={spaces.data ?? []}
        keyExtractor={(space) => space.spaceId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, item.archivedAt !== null && styles.rowArchived]}
            onPress={() => {
              router.push(`/docs-space/${item.spaceId}`);
            }}
          >
            <Text style={styles.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            {item.archivedAt !== null ? (
              <Pressable
                style={styles.restoreButton}
                onPress={() => {
                  archive.mutate({ spaceId: item.spaceId, restore: true });
                }}
              >
                <Text style={styles.restoreButtonText}>Restore</Text>
              </Pressable>
            ) : (
              <Text style={styles.rowChevron}>›</Text>
            )}
          </Pressable>
        )}
      />

      <Modal
        visible={creating}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setCreating(false);
        }}
      >
        <KeyboardAvoidingView
          style={styles.avoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              setCreating(false);
            }}
          >
            <Pressable style={styles.modalCard} onPress={() => undefined}>
              <Text style={styles.modalTitle}>New space</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="e.g. Engineering"
                placeholderTextColor={colors.inkFaint.hex}
                value={name}
                onChangeText={setName}
                maxLength={120}
                autoFocus
              />
              {create.isError && (
                <Text style={styles.errorText} accessibilityRole="alert">
                  {apiErrorOf(create.error)?.error.message ?? 'The space was not created.'}
                </Text>
              )}
              <View style={styles.modalActions}>
                <Pressable
                  style={[
                    styles.modalPrimaryButton,
                    (create.isPending || name.trim() === '') && styles.buttonDisabled,
                  ]}
                  disabled={create.isPending || name.trim() === ''}
                  onPress={() => {
                    create.mutate(name.trim());
                  }}
                >
                  <Text style={styles.modalPrimaryButtonText}>Create</Text>
                </Pressable>
                <Pressable
                  style={styles.modalSecondaryButton}
                  onPress={() => {
                    setCreating(false);
                  }}
                >
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Fab
        label="New space"
        bottom={24}
        onPress={() => {
          setCreating(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 24,
    paddingRight: 24 + TOPBAR_ICON_CLEARANCE,
    marginBottom: 10,
  },
  titleColumn: {
    flex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  loading: {
    marginTop: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
    paddingHorizontal: 24,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingHorizontal: 24,
  },
  list: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowArchived: {
    opacity: 0.6,
  },
  rowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowChevron: {
    fontSize: 18,
    color: colors.inkFaint.hex,
  },
  restoreButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  restoreButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  avoider: {
    flex: 1,
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
    gap: 10,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
  },
  modalPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  modalSecondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  modalSecondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
