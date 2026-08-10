-- 0043 down — the two §3.4 columns are additive and nothing else references
-- them, so reversing is a plain drop. (If a deployment rolls back PAST this
-- migration, any sessions rows carrying a stored `country`/flag simply lose
-- those facts — the travel check degrades to "unknown country, no flag",
-- which is exactly how it behaves for a deployment with no geolocation at
-- all.)

ALTER TABLE identity.sessions
  DROP COLUMN country,
  DROP COLUMN impossible_travel_at;
