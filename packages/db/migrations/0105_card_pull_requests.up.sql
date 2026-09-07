-- Phase 15 §7's card<->PR link table (ai/phase-15-ai-copilot-and-permissions.md
-- §7.2: "a new small table linking a card to a PR... and a new action,
-- 'create a feature branch from this card'"). Modeled directly on
-- comms.recording_cards (migration 0034): a composite FK back to
-- work.cards(org_id, id) so a link can never point at another tenant's card
-- even if application code got it wrong, and MANY on both sides for the
-- identical reason recording_cards is — one card can span several PRs (a
-- large feature), and in principle one PR could reference more than one
-- card.
--
-- The "PR" side is plain columns, not a foreign key: there is no local
-- table for a GitHub pull request to reference. `provider_scope` +
-- `pr_number` is the same identity `pr-read.service.ts`/`pr-write.service.ts`
-- already use to name a PR — resolved server-side from the org's own
-- connected repo, never a repo string the caller supplies.

CREATE TABLE work.card_pull_requests (
  org_id         uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  card_id        uuid        NOT NULL,
  provider_scope text        NOT NULL,
  pr_number      integer     NOT NULL,

  linked_by      uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  linked_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, card_id, provider_scope, pr_number),

  FOREIGN KEY (org_id, card_id)
    REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

-- The reverse lookup a future "PR merged -> move its linked cards" trigger
-- will need: given an org + repo + PR number, which cards does it name. The
-- primary key above is ordered card-first and does not serve that query.
CREATE INDEX card_pull_requests_pr_idx
  ON work.card_pull_requests (org_id, provider_scope, pr_number);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE work.card_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.card_pull_requests FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_pull_requests_tenant_isolation ON work.card_pull_requests;
CREATE POLICY card_pull_requests_tenant_isolation ON work.card_pull_requests
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
