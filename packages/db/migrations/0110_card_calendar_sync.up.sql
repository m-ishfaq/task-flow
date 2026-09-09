-- Per-card calendar sync (product brainstorm: "no external calendar sync" —
-- fixed as opt-in PER EVENT, per the project owner's own explicit choice
-- ("we can show a simple icon on card to let watcher's sync it with their
-- calendar"), never a default "assigned to me" scope. Two tables:
--
--   platform.card_calendar_subscriptions — an ordinary tenant table, "this
--   member wants THIS card on their own calendar", the identical shape
--   migration 0108's platform.standup_subscriptions already gives an
--   opt-in per (resource, person) pair. Composite FK back to
--   work.cards(org_id, id), mirroring 0105/0106's card_pull_requests/
--   card_branches — a subscription can never point at another tenant's
--   card even if application code got it wrong.
--
--   identity.calendar_feed_tokens — a personal, cross-org bearer token, the
--   same shape identity.sessions already is: no org_id column at all, so
--   no RLS to apply (the checker only examines tables that declare one).
--   Deliberately a NEW, long-lived token kind — TOKEN_PREFIX.shareLink,
--   reserved since packages/security/tokens.ts was written and never used
--   until now. One ACTIVE token per user; minting again rotates rather
--   than accumulating, enforced by a partial unique index on
--   (user_id) WHERE revoked_at IS NULL.

CREATE TABLE platform.card_calendar_subscriptions (
  id         uuid        PRIMARY KEY,
  org_id     uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  card_id    uuid        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (org_id, card_id)
    REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

-- Toggling is idempotent per (card, person) — one row, not a growing log.
CREATE UNIQUE INDEX card_calendar_subscriptions_unique
  ON platform.card_calendar_subscriptions (org_id, card_id, user_id);

-- The feed route's own query: "every card this user opted into, in this
-- org" — the reverse of the primary key's own card-first order.
CREATE INDEX card_calendar_subscriptions_user_idx
  ON platform.card_calendar_subscriptions (org_id, user_id);

ALTER TABLE platform.card_calendar_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.card_calendar_subscriptions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_calendar_subscriptions_tenant_isolation
  ON platform.card_calendar_subscriptions;
CREATE POLICY card_calendar_subscriptions_tenant_isolation
  ON platform.card_calendar_subscriptions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------

CREATE TABLE identity.calendar_feed_tokens (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set the moment a rotate mints a replacement, or the person revokes their
  -- own feed from Settings. NULL means active.
  revoked_at   timestamptz,
  last_used_at timestamptz
);

-- The feed route's lookup: hash the presented token, find its owner.
CREATE UNIQUE INDEX calendar_feed_tokens_hash_idx
  ON identity.calendar_feed_tokens (token_hash);

-- At most one ACTIVE row per user — `mintFeedUrl` revokes the old row in the
-- same transaction as inserting the new one (mint and rotate are the same
-- operation: the raw token is never stored, so there is nothing else an
-- "existing token" request could honestly return), so this is a genuine
-- invariant rather than an application-only promise.
CREATE UNIQUE INDEX calendar_feed_tokens_active_user_key
  ON identity.calendar_feed_tokens (user_id) WHERE revoked_at IS NULL;
