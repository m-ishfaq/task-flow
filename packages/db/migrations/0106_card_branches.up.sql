-- The card<->branch link table, the persisted half of "create a branch from
-- this card" (ai/phase-15-ai-copilot-and-permissions.md §7.2's last item,
-- `automation/branch.service.ts`). Before this migration, `createBranchFromCard`
-- created a real GitHub ref and emitted `integration.branch_created`, but
-- nothing recorded WHICH card a branch belongs to for later display — a
-- direct, real gap once a person (not just the assistant) needed to open a
-- card and see its branch again. Modeled directly on migration 0105's
-- work.card_pull_requests: a composite FK back to work.cards(org_id, id) so a
-- link can never point at another tenant's card even if application code got
-- it wrong, and MANY on both sides for the identical reason — a card can
-- reasonably span more than one branch over its life (a redo, a second pass),
-- and in principle a branch name could be reused across cards after one is
-- deleted and recreated.
--
-- The "branch" side is plain columns, not a foreign key: there is no local
-- table for a GitHub branch to reference, the same reasoning
-- card_pull_requests' `pr_number` column already gives.

CREATE TABLE work.card_branches (
  org_id         uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  card_id        uuid        NOT NULL,
  provider_scope text        NOT NULL,
  branch_name    text        NOT NULL,

  linked_by      uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  linked_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, card_id, provider_scope, branch_name),

  FOREIGN KEY (org_id, card_id)
    REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

-- The reverse lookup a future "branch merged/pushed -> notify its card"
-- feature would need: given an org + repo + branch name, which cards name
-- it. The primary key above is ordered card-first and does not serve that
-- query, the identical reasoning card_pull_requests_pr_idx already gives.
CREATE INDEX card_branches_branch_idx
  ON work.card_branches (org_id, provider_scope, branch_name);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE work.card_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.card_branches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_branches_tenant_isolation ON work.card_branches;
CREATE POLICY card_branches_tenant_isolation ON work.card_branches
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
