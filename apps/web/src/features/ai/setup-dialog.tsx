import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { Sparkles } from 'lucide-react';
import { Button, Field, Input } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { api } from '../../lib/trpc.js';
import { useAssistantSeedStore } from '../../lib/assistant-seed.js';
import { useFeatureGranted } from '../../lib/entitlements.js';
import { orgDetailQuery } from '../org/api.js';
import { consumeBootstrapFlag } from '../../lib/bootstrap-flag.js';

/**
 * The new-org Docs bootstrap offer (ai/phase-15-ai-copilot-and-permissions.md
 * §6) — "when a new org is created, offer to have the assistant ask a few
 * questions... and then create a starter Docs space... using the
 * `docs.create_page` tool." §6's own spec calls this "safe by construction":
 * the org's owner already has full rights over their own new org's Docs
 * space, and a created page is trivially reversible.
 *
 * ## The two questions are a FORM, not a model-led conversation
 *
 * §6's text says the assistant "asks a few questions". Letting the MODEL
 * phrase and interpret free-form answers to "how big is your team" would make
 * this feature's behaviour depend on how well the model listens, which is not
 * a property this dialog can test or guarantee. So the two questions are
 * ordinary form fields, and what reaches the assistant is one fully-formed
 * instruction naming exact page titles — the model's job is reduced to
 * calling `docs.create_page` the requested number of times, which is exactly
 * what §6 asks for ("using the `docs.create_page` tool") without depending on
 * it having asked the right follow-up questions.
 *
 * ## Space creation is a plain mutation; page creation goes through the assistant
 *
 * Creating the SPACE decides nothing — every new org gets one "Wiki" space
 * the same way regardless of the answers, so there is no reason to spend a
 * model call deciding to do it. WHICH PAGES to seed depends on the answers,
 * and routing that through `ai.chat.send` is what makes this §6 rather than
 * an ordinary settings form: it exercises the real confirm-before-execute
 * path (§4.2) `docs.create_page` requires, on the assistant page itself.
 */
export function NewOrgSetupDialog({ orgId }: { readonly orgId: string }) {
  /* `everConsumed` is read (and the flag cleared) exactly once per DISTINCT
     org, via the render-time "reset derived state when a prop changes"
     pattern (react.dev/learn/you-might-not-need-an-effect#adjusting-some-
     state-when-a-prop-changes — the same one `use-board-room.ts` already
     uses for its own per-key reset) rather than an effect: Shell mounts this
     component once and keeps it mounted across an org switch, so `orgId`
     changing while everything else stays put is exactly the case that
     pattern exists for. `consumeBootstrapFlag` reads AND clears
     `sessionStorage` in one call, which is why this must run at most once
     per org — reading it again on every unrelated re-render would find it
     already cleared and never be the problem, but calling it were it NOT
     idempotent would be, so being deliberate here costs nothing and is the
     safer habit. */
  const [lastOrgId, setLastOrgId] = useState(orgId);
  const [everConsumed, setEverConsumed] = useState(() => consumeBootstrapFlag(orgId));
  const [dismissed, setDismissed] = useState(false);

  if (orgId !== lastOrgId) {
    setLastOrgId(orgId);
    setEverConsumed(consumeBootstrapFlag(orgId));
    setDismissed(false);
  }

  const detail = useQuery({ ...orgDetailQuery(orgId), enabled: orgId !== '' && everConsumed });
  const aiAssistantGranted = useFeatureGranted('aiAssistant');

  if (!everConsumed || dismissed) return null;
  // Both settle almost immediately for a freshly created org (its owner
  // holds every capability by role, per §2.4) — this just keeps the dialog
  // from flashing open before `capabilities.useAi` is known.
  if (detail.data === undefined || aiAssistantGranted === undefined) return null;
  if (!detail.data.capabilities.useAi || !aiAssistantGranted) return null;

  return (
    <SetupForm
      orgName={detail.data.name}
      onClose={() => {
        setDismissed(true);
      }}
    />
  );
}

function SetupForm({
  orgName,
  onClose,
}: {
  readonly orgName: string;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
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
        content:
          `I just created this organization.${sizeNote} Please set up our Docs space (id ` +
          `${space.spaceId}) by creating one page for each of these titles, in that space, ` +
          `using your docs.create_page tool: ${pageTitles.map((title) => `"${title}"`).join(', ')}.`,
      };
    },
    onSuccess: (result) => {
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
              value={teamSize}
              onChange={(event) => {
                setTeamSize(event.target.value);
              }}
            />
          </Field>

          <div className="space-y-1">
            <p className="text-xs font-medium text-ink-muted">What do you want to start with?</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={includeWiki ? 'secondary' : 'primary'}
                onClick={() => {
                  setIncludeWiki(false);
                }}
              >
                Just a handbook
              </Button>
              <Button
                type="button"
                variant={includeWiki ? 'primary' : 'secondary'}
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
