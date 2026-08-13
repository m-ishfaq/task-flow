-- Reverses 0065.
--
-- DROP TABLE takes the policies, indexes and grants with it, so there is
-- nothing to unwind separately — unlike 0064, which granted schema-level
-- USAGE that outlives any one table.

DROP TABLE IF EXISTS billing.invoices;
