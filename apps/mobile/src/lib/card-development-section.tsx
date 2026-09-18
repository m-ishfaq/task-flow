import { useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import {
  cardBranchesQueryKey,
  cardPullRequestsQueryKey,
  githubReposQueryKey,
} from './work.js';
import { Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * PRs and branches linked to this card (ai/phase-15-ai-copilot-and-
 * permissions.md §7.2). The manual counterpart to the assistant's own
 * `list_card_prs`/`card_link_pr`/`create_branch_from_card` tools.
 *
 * On mobile this is a READ-ONLY display section with link/unlink
 * actions — no diff viewer, no checkout command copy (the original
 * web section's full surface is deferred to a later pass).
 *
 * `card:read`/`card:update` gate the PR half server-side; `canEdit`
 * (`cards.get`'s `capabilities.update`) hides the Link/Unlink controls.
 */
export function DevelopmentSection({
  cardId,
  canEdit,
}: {
  readonly cardId: string;
  readonly canEdit: boolean;
}) {
  const repos = useQuery({
    queryKey: githubReposQueryKey(),
    queryFn: async () => wire(await apiClient.work.githubRepos.list.query({})),
    enabled: canEdit,
  });

  const hasRepo = (repos.data?.length ?? 0) > 0;

  return (
    <Section label="Development">
      <View style={styles.devSubsection}>
        <Text style={styles.devSubsectionTitle}>Pull requests</Text>
        <PrSubsection cardId={cardId} canEdit={canEdit} hasRepo={hasRepo} />
      </View>

      <View style={styles.devSubsection}>
        <Text style={styles.devSubsectionTitle}>Branches</Text>
        <BranchSubsection cardId={cardId} canEdit={canEdit} hasRepo={hasRepo} />
      </View>

      {canEdit && !hasRepo && repos.isSuccess && (
        <Text style={styles.emptyHint}>
          Connect a GitHub repository (Settings → Automation) to link pull requests or create
          branches.
        </Text>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Pull requests
 * -------------------------------------------------------------------------- */

function PrSubsection({
  cardId,
  canEdit,
  hasRepo,
}: {
  readonly cardId: string;
  readonly canEdit: boolean;
  readonly hasRepo: boolean;
}) {
  const queryClient = useQueryClient();
  const [prNumber, setPrNumber] = useState('');

  const linked = useQuery({
    queryKey: cardPullRequestsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.pullRequests.list.query({ cardId })),
  });

  const link = useMutation({
    mutationFn: async (input: { providerScope: string; prNumber: number }) => {
      return wire(await apiClient.work.pullRequests.link.mutate({ ...input, cardId }));
    },
    onSuccess: async () => {
      setPrNumber('');
      await queryClient.invalidateQueries({ queryKey: cardPullRequestsQueryKey(cardId) });
    },
  });

  const unlink = useMutation({
    mutationFn: async (input: { providerScope: string; prNumber: number }) => {
      return wire(await apiClient.work.pullRequests.unlink.mutate({ ...input, cardId }));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardPullRequestsQueryKey(cardId) });
    },
  });

  if (linked.isPending) {
    return <Text style={styles.emptyHint}>Loading…</Text>;
  }

  if (linked.isError) {
    return <Text style={styles.error}>Could not load linked pull requests.</Text>;
  }

  return (
    <>
      {linked.data.length === 0 ? (
        !canEdit && <Text style={styles.emptyHint}>No pull requests linked.</Text>
      ) : (
        <View style={styles.devList}>
          {linked.data.map((pr) => (
            <View key={`${pr.providerScope}#${String(pr.prNumber)}`} style={styles.devRow}>
              <Pressable
                style={styles.devRowPressable}
                onPress={() => {
                  void Linking.openURL(
                    `https://github.com/${pr.providerScope}/pull/${String(pr.prNumber)}`,
                  );
                }}
              >
                <Text style={styles.devRowIcon}>PR</Text>
                <Text style={styles.devRowLabel} numberOfLines={1}>
                  {pr.providerScope}#{pr.prNumber}
                </Text>
              </Pressable>
              {canEdit && (
                <Pressable
                  disabled={unlink.isPending}
                  onPress={() => {
                    unlink.mutate({ providerScope: pr.providerScope, prNumber: pr.prNumber });
                  }}
                >
                  <Text style={styles.devUnlink}>Unlink</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {unlink.isError && (
        <Text style={styles.error}>
          {apiErrorOf(unlink.error)?.error.message ?? 'The pull request was not unlinked.'}
        </Text>
      )}

      {canEdit && hasRepo && (
        <>
          <TextInput
            style={styles.devInput}
            value={prNumber}
            onChangeText={setPrNumber}
            placeholder="PR number"
            placeholderTextColor={colors.inkFaint.hex}
            keyboardType="numeric"
            editable={!link.isPending}
          />
          <Pressable
            style={[
              styles.devButton,
              (link.isPending || prNumber === '') && styles.devButtonDisabled,
            ]}
            disabled={link.isPending || prNumber === ''}
            onPress={() => {
              const parsed = Number(prNumber);
              if (!Number.isInteger(parsed) || parsed <= 0) return;
              link.mutate({ providerScope: '', prNumber: parsed });
            }}
          >
            <Text style={styles.devButtonText}>{link.isPending ? 'Linking…' : 'Link'}</Text>
          </Pressable>
          {link.isError && (
            <Text style={styles.error}>
              {apiErrorOf(link.error)?.error.message ?? 'The pull request was not linked.'}
            </Text>
          )}
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- *
 * Branches
 * -------------------------------------------------------------------------- */

function BranchSubsection({
  cardId,
  canEdit,
  hasRepo,
}: {
  readonly cardId: string;
  readonly canEdit: boolean;
  readonly hasRepo: boolean;
}) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [branchName, setBranchName] = useState('');

  const linked = useQuery({
    queryKey: cardBranchesQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.branches.list.query({ cardId })),
  });

  const create = useMutation({
    mutationFn: async (input: { cardId: string; branchName?: string; repoScope?: string }) => {
      return wire(await apiClient.work.branches.create.mutate(input));
    },
    onSuccess: async () => {
      setFormOpen(false);
      setBranchName('');
      await queryClient.invalidateQueries({ queryKey: cardBranchesQueryKey(cardId) });
    },
  });

  const unlink = useMutation({
    mutationFn: async (input: { providerScope: string; branchName: string; cardId: string }) => {
      return wire(await apiClient.work.branches.unlink.mutate(input));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardBranchesQueryKey(cardId) });
    },
  });

  if (linked.isPending) {
    return <Text style={styles.emptyHint}>Loading…</Text>;
  }

  if (linked.isError) {
    return <Text style={styles.error}>Could not load linked branches.</Text>;
  }

  return (
    <>
      {linked.data.length === 0 ? (
        !canEdit && <Text style={styles.emptyHint}>No branches linked.</Text>
      ) : (
        <View style={styles.devList}>
          {linked.data.map((branch) => (
            <View key={`${branch.providerScope}-${branch.branchName}`} style={styles.devRow}>
              <Pressable
                style={styles.devRowPressable}
                onPress={() => {
                  void Linking.openURL(
                    `https://github.com/${branch.providerScope}/tree/${branch.branchName}`,
                  );
                }}
              >
                <Text style={styles.devRowIcon}>BR</Text>
                <Text style={[styles.devRowLabel, styles.devBranchName]} numberOfLines={1}>
                  {branch.branchName}
                </Text>
              </Pressable>
              {canEdit && (
                <Pressable
                  disabled={unlink.isPending}
                  onPress={() => {
                    unlink.mutate({
                      providerScope: branch.providerScope,
                      branchName: branch.branchName,
                      cardId,
                    });
                  }}
                >
                  <Text style={styles.devUnlink}>Unlink</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {unlink.isError && (
        <Text style={styles.error}>
          {apiErrorOf(unlink.error)?.error.message ?? 'The branch was not unlinked.'}
        </Text>
      )}

      {canEdit && hasRepo && !formOpen && (
        <Pressable style={styles.devButton} onPress={() => { setFormOpen(true); }}>
          <Text style={styles.devButtonText}>Create branch</Text>
        </Pressable>
      )}

      {formOpen && (
        <View style={styles.devForm}>
          <TextInput
            style={styles.devInput}
            value={branchName}
            onChangeText={setBranchName}
            placeholder="Branch name"
            placeholderTextColor={colors.inkFaint.hex}
            autoFocus
            editable={!create.isPending}
          />
          <View style={styles.devFormActions}>
            <Pressable
              style={[styles.devButton, create.isPending && styles.devButtonDisabled]}
              disabled={create.isPending}
              onPress={() => {
                const trimmed = branchName.trim();
                create.mutate(trimmed === '' ? { cardId } : { cardId, branchName: trimmed });
              }}
            >
              <Text style={styles.devButtonText}>{create.isPending ? 'Creating…' : 'Create'}</Text>
            </Pressable>
            <Pressable style={styles.devButtonCancel} onPress={() => { setFormOpen(false); }}>
              <Text style={styles.devButtonText}>Cancel</Text>
            </Pressable>
          </View>
          {create.isError && (
            <Text style={styles.error}>
              {apiErrorOf(create.error)?.error.message ?? 'The branch was not created.'}
            </Text>
          )}
        </View>
      )}
    </>
  );
}
