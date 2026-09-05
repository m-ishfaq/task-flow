-- Down for 0101. Restores the narrower constraint 0099 shipped with.
--
-- Assumes no 'openai'/'gemini' row exists when this runs — true for
-- `migrate:verify`'s up->down->up cycle against a fresh fixture, the only
-- place a `.down.sql` actually executes; if an operator ever ran this
-- against a catalog already holding a non-anthropic row, the ADD CONSTRAINT
-- below fails loudly rather than silently orphaning that row, which is the
-- correct failure mode for a destructive downgrade.

ALTER TABLE platform.ai_provider_config
  DROP CONSTRAINT ai_provider_config_provider_valid;

ALTER TABLE platform.ai_provider_config
  ADD CONSTRAINT ai_provider_config_provider_valid
  CHECK (provider IN ('anthropic'));
