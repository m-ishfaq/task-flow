import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RELATIONS,
  isRelation,
  isRestrictive,
  permissionsForRelation,
  type Relation,
} from '@taskflow/policy';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { useMembers } from './use-members.js';
import { useStepUp } from './use-step-up.js';
import { StepUpSheet } from './step-up-sheet.js';

/**
 * Sharing a board with a person — relationship tuples (§8.2), ported from
 * `apps/web/src/features/work/share-board.tsx`. This is the Zanzibar-lite
 * half of the permission model, and the half that has no other way in: a
 * role says what a member may do ACROSS the org, a tuple says what one
 * subject may do to ONE resource. Without this, a board could only ever be
 * as private as the org itself — the same gap web's own header names.
 *
 * ## A single modal that swaps its body, not two stacked ones
 *
 * Web picks the person from a real `<select>`; this app has none. Rather
 * than nesting a second `<Modal>` (this codebase has no precedent for
 * stacking two), the one modal here swaps its own body between the grant
 * form and a plain member list via a local `mode` — the identical
 * "swap this sheet's content by a local enum" shape `search-button.tsx`'s
 * facet row and `board/[boardId].tsx`'s own `bulkPicker` already use.
 *
 * ## Restrictive relations are labelled, from the policy package itself
 *
 * `isRestrictive` is `@taskflow/policy`'s own answer, not a list retyped
 * here — a `viewer` tuple on a board CAPS what an admin may do to it, the
 * opposite of what "share" usually implies, and a picker presenting every
 * relation identically would let someone hand out a restriction believing
 * they were granting access. `permissionsForRelation` is shown for the
 * SAME reason: a relation name alone is not self-explanatory, and guessing
 * wrong here hands out real access.
 *
 * ## Step-up, the same gate web's own tuple write already requires
 *
 * `tenancy.grants.grant`/`.revoke` are `stepUp: true` server-side — writing
 * a tuple changes who can reach data, exactly what a stolen session would
 * be used for. `use-step-up.ts`'s own header is the one to read on why a
 * silent token refresh cannot satisfy this; `StepUpSheet` is this app's
 * `connected-accounts-section.tsx`-established re-authentication UI, reused
 * verbatim rather than building a second one.
 */

interface GrantTuple {
  readonly tupleId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly relation: string;
  readonly expiresAt: string | null;
}

export function ShareBoardButton({ boardId }: { readonly boardId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        style={styles.trigger}
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={styles.triggerText}>Share</Text>
      </Pressable>

      <ShareModal
        boardId={boardId}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

function ShareModal({
  boardId,
  open,
  onClose,
}: {
  readonly boardId: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { people, personOf } = useMembers();
  const { guard, pending, confirm, cancel } = useStepUp();

  const [mode, setMode] = useState<'form' | 'pickPerson'>('form');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [relation, setRelation] = useState<Relation>(RELATIONS[0]);

  const grantsQueryKey = ['tenancy.grants.list', 'board', boardId] as const;

  const grants = useQuery({
    queryKey: grantsQueryKey,
    queryFn: () => apiClient.tenancy.grants.list.query({ objectType: 'board', objectId: boardId }),
    enabled: open,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: grantsQueryKey });

  const grant = useMutation({
    mutationFn: (input: { readonly subjectId: string; readonly relation: Relation }) =>
      apiClient.tenancy.grants.grant.mutate({
        subjectType: 'user',
        subjectId: input.subjectId,
        relation: input.relation,
        objectType: 'board',
        objectId: boardId,
        expiresAt: null,
      }),
    onSuccess: async () => {
      setSubjectId(null);
      await refresh();
    },
    onError: (error, input) => {
      guard(error, () => {
        grant.mutate(input);
      });
    },
  });

  const revoke = useMutation({
    mutationFn: (tupleId: string) => apiClient.tenancy.grants.revoke.mutate({ tupleId }),
    onSuccess: refresh,
    onError: (error, tupleId) => {
      guard(error, () => {
        revoke.mutate(tupleId);
      });
    },
  });

  const close = (): void => {
    setMode('form');
    setSubjectId(null);
    onClose();
  };

  const rows = grants.data ?? [];
  const selectedLabel = subjectId === null ? 'Choose someone…' : personOf(subjectId).label;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.modalBackdrop} onPress={close}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <View style={styles.modalHandle} />

          {mode === 'pickPerson' ? (
            <>
              <Text style={styles.modalTitle}>Choose someone</Text>
              <ScrollView style={styles.pickerList}>
                {people.map((member) => (
                  <Pressable
                    key={member.userId}
                    style={styles.modalRow}
                    onPress={() => {
                      setSubjectId(member.userId);
                      setMode('form');
                    }}
                  >
                    <Text style={styles.modalRowText}>{personOf(member.userId).label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable
                style={styles.modalCancel}
                onPress={() => {
                  setMode('form');
                }}
              >
                <Text style={styles.modalCancelText}>Back</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.modalTitle}>Share this board</Text>
              <Text style={styles.shareHint}>
                Grants apply to this board alone, on top of whatever the person's org role already
                allows.
              </Text>

              <ScrollView style={styles.grantsScroll}>
                {grants.isPending && <ActivityIndicator color={colors.accent.hex} />}
                {grants.isError && (
                  <Text style={styles.modalError} accessibilityRole="alert">
                    {apiErrorOf(grants.error)?.error.message ??
                      'Could not load this board’s grants.'}
                  </Text>
                )}
                {rows.length === 0 && !grants.isPending && (
                  <Text style={styles.sectionEmptyHint}>Not shared with anyone yet.</Text>
                )}
                {rows.map((tuple: GrantTuple) => (
                  <View key={tuple.tupleId} style={styles.grantRow}>
                    <View style={styles.grantInfo}>
                      <Text style={styles.grantSubject} numberOfLines={1}>
                        {tuple.subjectType === 'user'
                          ? personOf(tuple.subjectId).label
                          : tuple.subjectId}
                      </Text>
                      <Text style={styles.grantMeta}>
                        {tuple.subjectType} · {tuple.relation}
                        {isRelation(tuple.relation) &&
                          isRestrictive(tuple.relation) &&
                          ' · caps access'}
                      </Text>
                    </View>
                    <Pressable
                      disabled={revoke.isPending && revoke.variables === tuple.tupleId}
                      onPress={() => {
                        revoke.mutate(tuple.tupleId);
                      }}
                    >
                      <Text style={styles.revokeText}>Revoke</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>

              <Pressable
                style={styles.personRow}
                onPress={() => {
                  setMode('pickPerson');
                }}
              >
                <Text style={styles.personRowLabel}>Person</Text>
                <Text style={styles.personRowValue} numberOfLines={1}>
                  {selectedLabel}
                </Text>
              </Pressable>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.facetRow}>
                {RELATIONS.map((option) => (
                  <Pressable
                    key={option}
                    style={[styles.facetChip, relation === option && styles.facetChipActive]}
                    onPress={() => {
                      setRelation(option);
                    }}
                  >
                    <Text
                      style={[
                        styles.facetChipText,
                        relation === option && styles.facetChipTextActive,
                      ]}
                    >
                      {option}
                      {isRestrictive(option) ? ' (restrictive)' : ''}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Text style={styles.confersHint}>
                <Text style={styles.confersHintBold}>{relation}</Text> confers:{' '}
                {permissionsForRelation(relation).join(', ') || 'nothing on its own'}
              </Text>

              {grant.isError && (
                <Text style={styles.modalError} accessibilityRole="alert">
                  {apiErrorOf(grant.error)?.error.message ?? 'That grant could not be saved.'}
                </Text>
              )}

              <Pressable
                style={[styles.grantButton, subjectId === null && styles.grantButtonDisabled]}
                disabled={subjectId === null || grant.isPending}
                onPress={() => {
                  if (subjectId !== null) grant.mutate({ subjectId, relation });
                }}
              >
                {grant.isPending ? (
                  <ActivityIndicator color={colors.accentInk.hex} />
                ) : (
                  <Text style={styles.grantButtonText}>Grant</Text>
                )}
              </Pressable>

              <Pressable style={styles.modalCancel} onPress={close}>
                <Text style={styles.modalCancelText}>Done</Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>

      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  trigger: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  triggerText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay.hex + '99',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    paddingHorizontal: 20,
    paddingBottom: 20,
    paddingTop: 10,
    height: '85%',
  },
  modalHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line.hex,
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 4,
  },
  shareHint: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginBottom: 10,
  },
  modalError: {
    fontSize: 13,
    color: colors.danger.hex,
    marginBottom: 8,
  },
  sectionEmptyHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    paddingVertical: 4,
  },
  grantsScroll: {
    flexGrow: 0,
    maxHeight: 220,
    marginBottom: 10,
  },
  grantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  grantInfo: {
    flex: 1,
  },
  grantSubject: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  grantMeta: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  revokeText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radiusCard,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    backgroundColor: colors.surfaceSunken.hex,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  personRowLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  personRowValue: {
    fontSize: 13,
    color: colors.ink.hex,
    flexShrink: 1,
    marginLeft: 8,
  },
  facetRow: {
    flexDirection: 'row',
    maxHeight: 36,
    marginBottom: 8,
  },
  facetChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  facetChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  facetChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  facetChipTextActive: {
    color: colors.accentInk.hex,
  },
  confersHint: {
    fontSize: 11,
    color: colors.inkFaint.hex,
    marginBottom: 10,
  },
  confersHintBold: {
    fontWeight: '700',
    color: colors.inkMuted.hex,
  },
  grantButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  grantButtonDisabled: {
    opacity: 0.5,
  },
  grantButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  pickerList: {
    flex: 1,
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
});
