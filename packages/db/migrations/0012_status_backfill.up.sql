-- 0012 — status backfill (ai/phase-3.5-work-ux.md §5.3)
--
-- 0011 added `status_id` NULLABLE and seeded no data — an existing project has
-- a status vocabulary of zero, and every existing card has no status. This
-- migration is the "migrate" step: it gives each existing project a usable
-- vocabulary and gives each existing card an answer, so "group by status"
-- is not a blank column for every board that existed before this phase.
--
-- THE MAPPING RULE, for the next reader wondering why a card is in a status
-- nobody set: each project is seeded with three statuses — To Do
-- (not_started, and the project's default), In Progress (active), Done
-- (done). Each card is then mapped by a CASE-INSENSITIVE match between its
-- LIST's name and a status name in the same project — a card in a list
-- called "Done" or "done" gets the Done status. A card whose list matches
-- none of the three (a "Backlog" or "Blocked" column, say) falls back to the
-- project's To Do status, on the theory that not-yet-classified work reads
-- closer to "not started" than to any other category.
--
-- This is a best-effort, one-time guess. Nothing about it is a bug if a
-- project's actual workflow disagrees — it hands every board a real
-- vocabulary instead of an empty one, and it is exactly as authoritative as
-- the list names it was built from. A project's admin edits status names and
-- moves cards afterward the same way they would after any migration that
-- infers rather than asks.
--
-- `gen_random_uuid()`, not the app's UUIDv7 minting: these rows are seeded by
-- SQL, not by a service, and ordering statuses by creation time has no
-- product meaning here — `position` is what display order reads.

DO $$
DECLARE
  proj RECORD;
  todo_id uuid;
  doing_id uuid;
  done_id uuid;
BEGIN
  FOR proj IN SELECT id, org_id FROM work.projects LOOP
    todo_id  := gen_random_uuid();
    doing_id := gen_random_uuid();
    done_id  := gen_random_uuid();

    INSERT INTO work.statuses (id, org_id, project_id, name, category, color, position, is_default)
    VALUES
      (todo_id,  proj.org_id, proj.id, 'To Do',       'not_started', '#94a3b8', 1, true),
      (doing_id, proj.org_id, proj.id, 'In Progress', 'active',      '#3b82f6', 2, false),
      (done_id,  proj.org_id, proj.id, 'Done',        'done',        '#22c55e', 3, false);

    UPDATE work.cards c
    SET status_id = COALESCE(
      (
        SELECT s.id
        FROM work.lists l
        JOIN work.statuses s ON s.project_id = c.project_id AND lower(s.name) = lower(l.name)
        WHERE l.id = c.list_id
        LIMIT 1
      ),
      todo_id
    )
    WHERE c.project_id = proj.id;
  END LOOP;
END $$;
