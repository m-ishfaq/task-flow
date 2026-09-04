-- Reverse of 0095.up.sql. Restores the pre-launch values this migration
-- corrected — not because they were right, but because a down.sql restores
-- what applying up.sql changed, per this codebase's own migration
-- convention (CLAUDE.md: paired, never edited once applied).
UPDATE billing.plans
   SET features   = array_append(features, 'analytics'),
       updated_at = now()
 WHERE id = 'pro'
   AND NOT ('analytics' = ANY (features));

UPDATE billing.plans
   SET telephony_cap_cents = 5000,
       updated_at          = now()
 WHERE id = 'starter';

UPDATE billing.plans
   SET telephony_cap_cents = 25000,
       updated_at          = now()
 WHERE id = 'pro';

UPDATE billing.plans
   SET telephony_cap_cents = NULL,
       description         = 'Everything, with no ceiling on spend and priority support.',
       updated_at          = now()
 WHERE id = 'business';
