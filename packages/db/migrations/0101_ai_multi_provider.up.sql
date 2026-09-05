-- 0101 — Phase 15 §2 follow-up: OpenAI and Gemini as a second and third
-- AiProvider implementation, alongside Anthropic.
--
-- `ai_provider_config_provider_valid` (migration 0099) started deliberately
-- narrow — "'anthropic' today" per that migration's own comment — because
-- this column selects WHICH `AiProvider` implementation `provider-
-- resolver.ts` constructs, and a closed CHECK is what turns a typo into a
-- write-time rejection instead of a resolve-time "no provider registered"
-- surprise. Widening it is the expand half of expand-migrate-contract: no
-- existing row's `provider` value changes, and every row already committed
-- stays valid under the wider list.

ALTER TABLE platform.ai_provider_config
  DROP CONSTRAINT ai_provider_config_provider_valid;

ALTER TABLE platform.ai_provider_config
  ADD CONSTRAINT ai_provider_config_provider_valid
  CHECK (provider IN ('anthropic', 'openai', 'gemini'));
