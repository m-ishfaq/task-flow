import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { Sparkles } from 'lucide-react';
import { Button, Field, Input } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { api } from '../../lib/trpc.js';
import { useAssistantSeedStore } from '../../lib/assistant-seed.js';
import { useFeatureGranted } from '../../lib/entitlements.js';
import { orgDetailQuery } from '../org/api.js';
import { spacesQuery, invalidateSpaces } from '../docs/api.js';

/**
 * The new-org Docs bootstrap offer (ai/phase-15-ai-copilot-and-permissions.md
 * §6) — "when a new org is created, offer to have the assistant ask a few
 * questions... and then create a starter Docs space... using the
 * `docs.create_page` tool." §6's own spec calls this "safe by construction":
 * the org's owner already has full rights over their own new org's Docs
 * space, and a created page is trivially reversible.
 *
 * ## REDESIGNED: gated on real Docs state, not a one-shot flag
 *
 * The original trigger was a `sessionStorage` flag set the moment `orgs.create`
 * succeeded and consumed (read-and-cleared) the very next render — an offer
 * seen exactly once, in the tab that created the org, whether or not anyone
 * acted on it. Closing the dialog, missing it behind another modal, or simply
 * not being ready to decide meant it was gone for good, with no route back
 * except finding Docs' own manual space-creation flow — a real loss for
 * exactly the org that most needs a starter space. Asked for directly: keep
 * offering until the org actually HAS one.
 *
 * The fix needs no flag at all, stored or otherwise — `docs.spaces.list` is
 * already the authoritative answer to "does this org have Docs content yet",
 * so the dialog now renders whenever that list is empty and stops the moment
 * it isn't, checked fresh on every mount rather than remembered from a past
 * visit. This is a STRICTLY simpler mechanism than the flag it replaces: no
 * `sessionStorage`, no per-org key, no "read is a consume" contract to get
 * right — one query this page needs to make anyway to know whether to render.
 *
 * `dismissed` stays local, un-persisted component state, on purpose: closing
 * the dialog quiets it for the rest of THIS browsing session (so it does not
 * re-open on every route change within the app), but a fresh page load re-
 * evaluates from scratch — if the org still has no space, the offer is back.
 * That is the literal shape asked for: shown until a space exists, not shown
 * forever once dismissed once.
 */
export function NewOrgSetupDialog({ orgId }: { readonly orgId: string }) {
  /* `dismissed` resets per DISTINCT org via the render-time "reset derived
     state when a prop changes" pattern (react.dev/learn/you-might-not-need-
     an-effect#adjusting-some-state-when-a-prop-changes — the same one
     `use-board-room.ts` already uses for its own per-key reset) rather than
     an effect: Shell mounts this component once and keeps it mounted across
     an org switch, so `orgId` changing while everything else stays put is
     exactly the case that pattern exists for. Closing the offer for org A
     must not also suppress it for org B the moment someone switches. */
  const [lastOrgId, setLastOrgId] = useState(orgId);
  const [dismissed, setDismissed] = useState(false);

  if (orgId !== lastOrgId) {
    setLastOrgId(orgId);
    setDismissed(false);
  }

  const enabled = orgId !== '';
  const detail = useQuery({ ...orgDetailQuery(orgId), enabled });
  const spaces = useQuery({ ...spacesQuery(orgId), enabled });
  const aiAssistantGranted = useFeatureGranted('aiAssistant');

  if (dismissed) return null;
  if (detail.data === undefined || spaces.data === undefined || aiAssistantGranted === undefined) {
    return null;
  }
  // The whole point: once the org has ANY Docs space, the offer is done —
  // whether that space came from this dialog, from Docs' own "+ Space"
  // control, or existed before this redesign shipped.
  if (spaces.data.length > 0) return null;
  // Hide, don't disable (Phase 15 §1's own rule): offering this to someone
  // who cannot create a space or does not hold the assistant would only
  // produce a confirmed dialog that fails on submit.
  if (!detail.data.capabilities.useAi || !detail.data.capabilities.createSpace) return null;
  if (!aiAssistantGranted) return null;

  return (
    <SetupForm
      orgId={orgId}
      orgName={detail.data.name}
      onClose={() => {
        setDismissed(true);
      }}
    />
  );
}

function SetupForm({
  orgId,
  orgName,
  onClose,
}: {
  readonly orgId: string;
  readonly orgName: string;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSeed = useAssistantSeedStore((state) => state.setSeed);

  const [teamSize, setTeamSize] = useState('');
  const [includeWiki, setIncludeWiki] = useState(false);

  const setUp = useMutation({
    mutationFn: async () => {
      const space = await api.docs.spaces.create.mutate({ name: `${orgName} Wiki` });

      const pageTitles = includeWiki
        ? ['Handbook', 'Onboarding Checklist', 'Engineering Wiki']
        : ['Handbook', 'Onboarding Checklist'];

      const sizeNote = teamSize.trim() === '' ? '' : ` We have about ${teamSize.trim()} people.`;

      return {
        spaceId: space.spaceId,
        content:
          `I just created this organization.${sizeNote} Please set up our Docs space (id ` +
          `${space.spaceId}) by creating one page for each of these titles, in that space, ` +
          `using your docs_create_page tool: ${pageTitles.map((title) => `"${title}"`).join(', ')}.`,
      };
    },
    onSuccess: (result) => {
      // The gating query above (`spaces.data.length > 0`) needs to see this
      // space on the very next mount, not whenever its own staleTime next
      // elapses — without this, closing the dialog and reopening the app
      // could show the offer one more time despite the space already
      // existing, the exact "stale, not wrong" gap `invalidateSpaces` exists
      // to close everywhere else Docs writes a space.
      invalidateSpaces(queryClient, orgId);
      setSeed([{ role: 'user', content: result.content }]);
      onClose();
      void navigate({ to: '/assistant' });
    },
  });

  return (
    <ModalRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent size="sm" className="p-4">
        <ModalTitle className="flex items-center gap-1.5">
          <Sparkles aria-hidden="true" className="size-4 text-accent" />
          Set up your workspace
        </ModalTitle>
        <ModalDescription>
          Let the assistant create a starter Docs space — a handbook and an onboarding checklist,
          plus an engineering wiki if you want one. You can edit or delete anything it makes.
        </ModalDescription>

        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setUp.mutate();
          }}
        >
          <Field
            label="How many people are on your team?"
            htmlFor="setup-team-size"
            hint="Optional — just gives the assistant context."
          >
            <Input
              id="setup-team-size"
              type="number"
              min={1}
              inputMode="numeric"
              /* Browser-drawn spin buttons are the one native control this
                 app's dark theme never restyled — they render as a jarring
                 light-grey box against `surface-sunken`. Hidden here rather
                 than in the shared `Input` primitive, since `inputMode:
                 numeric` already gives every other numeric field a clean
                 mobile keypad with no visual side effect; this is the first
                 place a raw `type="number"` spinner was ever visible. */
              className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              value={teamSize}
              onChange={(event) => {
                setTeamSize(event.target.value);
              }}
            />
          </Field>

          <div className="space-y-1">
            <p className="text-xs font-medium text-ink-muted">What do you want to start with?</p>
            <div className="flex items-stretch gap-2">
              {/* `h-auto` overrides `Button`'s own fixed `h-9` (md size) —
                  correct everywhere else a label is one line, but "Handbook +
                  engineering wiki" wraps to two, so the fixed height let it
                  overflow past its sibling instead of the row growing to fit
                  both evenly. `flex-1` keeps the two options equal width
                  regardless of label length. */}
              <Button
                type="button"
                variant={includeWiki ? 'secondary' : 'primary'}
                className="h-auto flex-1 whitespace-normal py-2 text-center leading-snug"
                onClick={() => {
                  setIncludeWiki(false);
                }}
              >
                Just a handbook
              </Button>
              <Button
                type="button"
                variant={includeWiki ? 'primary' : 'secondary'}
                className="h-auto flex-1 whitespace-normal py-2 text-center leading-snug"
                onClick={() => {
                  setIncludeWiki(true);
                }}
              >
                Handbook + engineering wiki
              </Button>
            </div>
          </div>

          {setUp.isError && <ErrorView error={setUp.error} />}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={setUp.isPending}>
              {setUp.isPending ? 'Setting up…' : 'Set up my workspace'}
            </Button>
            <Button type="button" onClick={onClose} disabled={setUp.isPending}>
              No thanks
            </Button>
          </div>
        </form>
      </ModalContent>
    </ModalRoot>
  );
}
