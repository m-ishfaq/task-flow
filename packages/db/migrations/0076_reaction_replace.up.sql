-- 0076 — one reaction per person per message.
--
-- 0018's primary key was (message_id, user_id, emoji), which lets a person
-- hold several reactions on one message. The product decided reacting with a
-- second emoji REPLACES the first (WhatsApp's model, ai/phase-5-chat.md §5),
-- so the invariant the table exists for is "one current reaction per person
-- per message" — and that is a PRIMARY KEY, not a service convention. The
-- service is allowed to upsert without deleting first; the constraint is what
-- makes a second reaction resolve to the SAME slot, and what makes the
-- delete-then-insert race of two near-simultaneous reactions impossible
-- rather than merely unlikely.
--
-- The data step comes first: any user who already reacted twice on one
-- message keeps the NEWEST reaction (the one the client would have rendered
-- last), and the older rows go. Ties in `created_at` are broken by ctid so
-- the dedupe cannot fail on two rows that share a timestamp.
--
-- One trap this migration hit against a real database, worth recording the
-- same way 0015 records its own: `chat.message_reactions` is FORCE ROW LEVEL
-- SECURITY (0018), which applies row security to the table OWNER too, and the
-- migrator is NOBYPASSRLS with no app.org_id set during a migration — so a
-- bare DELETE matches ZERO rows. The dedupe silently does nothing, and then
-- the new primary key's unique-index build — which reads PHYSICAL rows, not
-- policy-filtered ones — fails on the very duplicates the DELETE was supposed
-- to remove ("could not create unique index ... Duplicate keys exist"), a
-- fail-OPEN failure that reads as a data problem. Lifted for this one
-- statement and restored immediately after, exactly as 0015 does for
-- platform.outbox; nothing about the table's security posture outside this
-- transaction changes.
ALTER TABLE chat.message_reactions NO FORCE ROW LEVEL SECURITY;

-- One reaction per (message, user): every row but the newest in each group
-- goes. `created_at DESC, ctid` is the tie-break — two reactions written in
-- the same transaction share a timestamp, and ctid guarantees the ranking
-- still picks exactly one survivor.
DELETE FROM chat.message_reactions mr
WHERE mr.ctid IN (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY message_id, user_id
        ORDER BY created_at DESC, ctid
      ) AS rn
    FROM chat.message_reactions
  ) ranked
  WHERE rn > 1
);

ALTER TABLE chat.message_reactions FORCE ROW LEVEL SECURITY;

ALTER TABLE chat.message_reactions DROP CONSTRAINT message_reactions_pkey;
ALTER TABLE chat.message_reactions ADD PRIMARY KEY (message_id, user_id);
