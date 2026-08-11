-- 0048 — carry the automation causation depth through the outbox.
--
-- 0047 added `causationDepth` to the event ENVELOPE and this column is what
-- makes it survive the queue. Found by writing the relay: the engine read the
-- depth off a claimed row, `OutboxRow` had nowhere for it to come from, and
-- every chain would therefore have restarted at 0 on the far side of the
-- outbox — which is a loop protection that silently protects nothing.
--
-- A separate migration rather than an edit to 0047, which was already applied:
-- "migrations are never edited once applied" (CLAUDE.md), and the fact that
-- 0047 has only reached one developer's machine is not a reason to start
-- making exceptions to that.
--
-- ==========================================================================
-- WHY A COLUMN AND NOT A FIELD INSIDE `payload`
-- ==========================================================================
--
-- `platform.outbox` already stores every OTHER envelope field in its own
-- column — version, actor_id, occurred_at, request_id — and depth is envelope
-- metadata by exactly the same argument: it describes the event's provenance,
-- not what happened. Folding it into `payload` would also mean writing a field
-- into objects validated by per-event `.strict()` schemas owned by their own
-- slices, so every one of them would have to learn about automation.
--
-- Expand-only and safe by construction: NOT NULL with a DEFAULT of 0, so every
-- row already in the table takes the value that is already correct for it. A
-- human-initiated mutation IS depth 0 — the root of any chain it starts — and
-- so is every event written before this column existed.

ALTER TABLE platform.outbox
  ADD COLUMN causation_depth integer NOT NULL DEFAULT 0;

-- The engine refuses above MAX_DEPTH in application code; this is the second
-- copy of that ceiling, and it is here for the reason every CHECK in this
-- codebase is: an impossible value should be unrepresentable rather than
-- merely unwritten. The bound is deliberately far above the engine's own cap
-- (5) — this is a sanity floor against a corrupted or hostile value, not a
-- restatement of the policy, which is free to change without a migration.
ALTER TABLE platform.outbox
  ADD CONSTRAINT outbox_causation_depth_sane
    CHECK (causation_depth >= 0 AND causation_depth <= 100);
