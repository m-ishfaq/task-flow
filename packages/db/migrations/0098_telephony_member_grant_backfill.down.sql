-- Revert 0098 — remove exactly the rows this migration inserted.
--
-- Safe to identify precisely: `member-grant.service.ts`'s `grant()` always
-- sets `granted_by` to a real actor id, so `granted_by IS NULL` uniquely
-- marks a row this migration (and only this migration) could have written.

DELETE FROM authz.member_grants
WHERE granted_by IS NULL
  AND permission IN ('phoneNumber:read', 'call:place', 'call:read', 'sms:send', 'sms:read');
